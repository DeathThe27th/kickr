"""Drains notification_outbox to Telegram (build.md Part 2).

The engine and ledger write to the outbox inside their own transactions and
never block on delivery, so a Telegram outage can't stall settlement. This
drains it out-of-band and marks rows sent.

Broadcast semantics: a market_open row has no user_id (there is no follow
concept), so it goes to every linked chat. That is a lot of messages —
Telegram allows roughly 30/sec overall and 1/sec to a given chat, and exceeding
it earns a 429 with a retry_after, so sends are paced and 429s are obeyed
rather than hammered.
"""
from __future__ import annotations

import asyncio
import logging

from aiogram import Bot
from aiogram.exceptions import TelegramForbiddenError, TelegramRetryAfter
from sqlalchemy import select

from ..db import session_scope
from ..ledger import balance
from ..models import Bet, Fixture, Market, NotificationOutbox, Settlement, User, utcnow
from .bot import market_keyboard

log = logging.getLogger("kickr.telegram")

BATCH = 20
IDLE_S = 2.0
# ~20/sec, under Telegram's ~30/sec ceiling with headroom for the bot's own
# replies, which share the same budget.
SEND_GAP_S = 0.05


async def _send(bot: Bot, chat_id: str, text: str, markup=None) -> bool:
    """One message. Returns False if the chat is gone and should be unlinked."""
    try:
        await bot.send_message(chat_id, text, parse_mode="HTML", reply_markup=markup)
        return True
    except TelegramRetryAfter as exc:
        # Telegram is explicit about how long to wait; obey it rather than retry
        # blind, which just extends the penalty.
        log.warning("telegram rate limited — sleeping %ss", exc.retry_after)
        await asyncio.sleep(exc.retry_after)
        try:
            await bot.send_message(chat_id, text, parse_mode="HTML", reply_markup=markup)
            return True
        except Exception:
            log.exception("send failed after retry_after")
            return True
    except TelegramForbiddenError:
        # The user blocked the bot. Without unlinking, every future broadcast
        # retries this chat forever.
        log.info("chat %s blocked the bot — unlinking", chat_id)
        return False
    except Exception:
        log.exception("telegram send failed for chat %s", chat_id)
        return True


def _linked_chats() -> list[str]:
    with session_scope() as session:
        return [
            c
            for (c,) in session.execute(
                select(User.telegram_chat_id).where(User.telegram_chat_id.isnot(None))
            ).all()
        ]


def _unlink(chat_id: str) -> None:
    with session_scope() as session:
        for user in session.execute(
            select(User).where(User.telegram_chat_id == chat_id)
        ).scalars():
            user.telegram_chat_id = None


def _market_open_message(market_id: str) -> tuple[str, object] | None:
    with session_scope() as session:
        market = session.get(Market, market_id)
        if market is None or market.status != "open":
            return None  # already locked or settled; a dead button helps nobody
        fixture = session.get(Fixture, market.fixture_id)
        where = ""
        if fixture:
            score = f"{fixture.score_home}–{fixture.score_away}" if fixture.status == "live" else "v"
            minute = f" · {fixture.minute}'" if fixture.status == "live" else ""
            where = f"\n{fixture.home} {score} {fixture.away}{minute}"
        return f"⚽ <b>{market.question}</b>{where}", market_keyboard(market)


def _bet_settled_message(payload: dict) -> tuple[str, str] | None:
    """(chat_id, text), or None if the user isn't linked."""
    with session_scope() as session:
        bet = session.get(Bet, payload.get("bet_id", ""))
        if bet is None:
            return None
        user = session.get(User, bet.user_id)
        if user is None or not user.telegram_chat_id:
            return None
        market = session.get(Market, bet.market_id)
        settlement = session.execute(
            select(Settlement).where(Settlement.market_id == bet.market_id)
        ).scalar_one_or_none()

        question = market.question if market else "Market"
        won = bet.status == "won"
        if bet.status == "voided":
            head = f"↩️ Voided — {bet.stake} refunded"
        elif won:
            head = f"✅ Won +{bet.potential_payout:,}"
        else:
            head = f"❌ Lost {bet.stake}"
        result = settlement.winning_outcome if settlement else "—"
        return (
            user.telegram_chat_id,
            f"<b>{question}</b>\n{head}\nResult: {result} · your pick: {bet.outcome}\n"
            f"Balance {balance(session, user.id):,}",
        )


async def drain_loop(bot: Bot) -> None:
    while True:
        try:
            with session_scope() as session:
                rows = (
                    session.execute(
                        select(NotificationOutbox)
                        .where(NotificationOutbox.sent_at.is_(None))
                        .order_by(NotificationOutbox.created_at)
                        .limit(BATCH)
                    )
                    .scalars()
                    .all()
                )
                jobs = [(r.id, r.event_type, dict(r.payload or {})) for r in rows]

            if not jobs:
                await asyncio.sleep(IDLE_S)
                continue

            for row_id, event_type, payload in jobs:
                if event_type == "market_open":
                    built = _market_open_message(payload.get("market_id", ""))
                    if built:
                        text, markup = built
                        for chat_id in _linked_chats():
                            if not await _send(bot, chat_id, text, markup):
                                _unlink(chat_id)
                            await asyncio.sleep(SEND_GAP_S)
                elif event_type == "bet_settled":
                    built = _bet_settled_message(payload)
                    if built:
                        chat_id, text = built
                        if not await _send(bot, chat_id, text):
                            _unlink(chat_id)
                        await asyncio.sleep(SEND_GAP_S)

                # Mark sent regardless: a row we couldn't build a message for is
                # done, not pending. Leaving it null would replay it forever.
                with session_scope() as session:
                    row = session.get(NotificationOutbox, row_id)
                    if row:
                        row.sent_at = utcnow()
        except Exception:
            log.exception("outbox drain failed — continuing")
            await asyncio.sleep(IDLE_S)
