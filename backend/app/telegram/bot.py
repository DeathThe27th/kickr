"""Telegram bot (build.md Part 2): account linking + inline betting.

aiogram v3, long-polling, in-process. Polling rather than webhooks because the
instance sleeps: a dropped webhook is a lost message, whereas polling just
resumes on wake.

The bot never sees a Privy token. Linking goes through a one-time code minted
by the authed web app, so a chat can only ever bind to an account someone
deliberately handed it.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from aiogram import Bot, Dispatcher, F
from aiogram.filters import CommandObject, CommandStart
from aiogram.types import CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, Message
from sqlalchemy import select

from ..config import settings
from ..db import session_scope
from ..ledger import LedgerError, balance, place_bet
from ..models import Market, TelegramLinkCode, User

log = logging.getLogger("kickr.telegram")

LINK_CODE_TTL = timedelta(minutes=10)
STAKES = (10, 25, 50, 100)

dp = Dispatcher()


def _fmt_odds(x: float | None) -> str:
    return f"{x:.2f}" if x else "—"


# --------------------------------------------------------------------- linking
@dp.message(CommandStart(deep_link=True))
async def start_with_code(message: Message, command: CommandObject) -> None:
    code = (command.args or "").strip()
    chat_id = str(message.chat.id)

    with session_scope() as session:
        row = session.get(TelegramLinkCode, code)
        if row is None or row.used_at is not None:
            await message.answer("That link has already been used. Generate a fresh one in the app.")
            return
        if datetime.now(timezone.utc) - row.created_at.replace(tzinfo=timezone.utc) > LINK_CODE_TTL:
            await message.answer("That link expired. Generate a fresh one in the app.")
            return

        user = session.get(User, row.user_id)
        if user is None:
            await message.answer("That account no longer exists.")
            return

        # One chat per account: re-linking moves the account to this chat rather
        # than leaving two chats believing they own it.
        for other in session.execute(
            select(User).where(User.telegram_chat_id == chat_id, User.id != user.id)
        ).scalars():
            other.telegram_chat_id = None

        user.telegram_chat_id = chat_id
        row.used_at = datetime.now(timezone.utc)
        handle = user.handle
        bal = balance(session, user.id)

    await message.answer(
        f"Linked to <b>{handle}</b> — balance {bal:,} chips.\n\n"
        "New markets land here as they open. Tap a price to bet.",
        parse_mode="HTML",
    )


@dp.message(CommandStart())
async def start_plain(message: Message) -> None:
    await message.answer(
        "This is <b>kickr</b> — micro prediction markets that settle inside the match.\n\n"
        "Open the app and hit <b>Link Telegram</b> to connect your account.",
        parse_mode="HTML",
    )


@dp.message(F.text == "/balance")
async def balance_cmd(message: Message) -> None:
    with session_scope() as session:
        user = session.execute(
            select(User).where(User.telegram_chat_id == str(message.chat.id))
        ).scalar_one_or_none()
        if user is None:
            await message.answer("Not linked yet — hit Link Telegram in the app.")
            return
        await message.answer(f"{balance(session, user.id):,} chips")


# --------------------------------------------------------------- inline betting
def market_keyboard(market: Market) -> InlineKeyboardMarkup:
    """Outcome buttons. callback_data is capped at 64 bytes by Telegram, so it
    carries an outcome *index* rather than the label."""
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text=f"{o} {_fmt_odds((market.prices or {}).get(o))}",
                    callback_data=f"o:{market.id}:{i}",
                )
                for i, o in enumerate(market.outcomes)
            ]
        ]
    )


@dp.callback_query(F.data.startswith("o:"))
async def choose_outcome(cb: CallbackQuery) -> None:
    _, market_id, idx = cb.data.split(":", 2)
    with session_scope() as session:
        market = session.get(Market, market_id)
        if market is None or market.status != "open":
            await cb.answer("That market has closed.", show_alert=True)
            return
        outcome = market.outcomes[int(idx)]
        odds = _fmt_odds((market.prices or {}).get(outcome))
        question = market.question

    await cb.message.edit_text(
        f"<b>{question}</b>\n{outcome} @ {odds}\n\nStake?",
        parse_mode="HTML",
        reply_markup=InlineKeyboardMarkup(
            inline_keyboard=[
                [
                    InlineKeyboardButton(text=str(s), callback_data=f"s:{market_id}:{idx}:{s}")
                    for s in STAKES
                ],
                [InlineKeyboardButton(text="Cancel", callback_data=f"x:{market_id}")],
            ]
        ),
    )
    await cb.answer()


@dp.callback_query(F.data.startswith("s:"))
async def place(cb: CallbackQuery) -> None:
    _, market_id, idx, stake = cb.data.split(":", 3)
    chat_id = str(cb.message.chat.id)

    with session_scope() as session:
        user = session.execute(
            select(User).where(User.telegram_chat_id == chat_id)
        ).scalar_one_or_none()
        if user is None:
            await cb.answer("Not linked — open the app and link Telegram.", show_alert=True)
            return
        market = session.get(Market, market_id)
        if market is None or market.status != "open":
            await cb.answer("That market has closed.", show_alert=True)
            return

        outcome = market.outcomes[int(idx)]
        # The price may have moved since the message was sent. Quote the live
        # one so place_bet's freshness check passes, then say what was actually
        # locked — never imply the stale price was honoured.
        current = (market.prices or {}).get(outcome)
        if current is None:
            await cb.answer("No price on that outcome right now.", show_alert=True)
            return
        try:
            bet = place_bet(session, user, market, outcome, int(stake), current)
        except LedgerError as exc:
            await cb.answer(str(exc).replace("_", " "), show_alert=True)
            return
        text = (
            f"<b>{market.question}</b>\n"
            f"✅ {bet.stake} on {bet.outcome} @ {bet.odds_locked:.2f}\n"
            f"Returns {bet.potential_payout:,} if it lands.\n"
            f"Balance {balance(session, user.id):,}"
        )

    await cb.message.edit_text(text, parse_mode="HTML")
    await cb.answer("Bet placed")


@dp.callback_query(F.data.startswith("x:"))
async def cancel(cb: CallbackQuery) -> None:
    _, market_id = cb.data.split(":", 1)
    with session_scope() as session:
        market = session.get(Market, market_id)
        if market is None:
            await cb.message.edit_text("That market has closed.")
            await cb.answer()
            return
        await cb.message.edit_text(
            f"⚽ <b>{market.question}</b>", parse_mode="HTML", reply_markup=market_keyboard(market)
        )
    await cb.answer()


# ----------------------------------------------------------------------- setup
def make_bot() -> Bot | None:
    if not settings.telegram_bot_token:
        return None
    return Bot(token=settings.telegram_bot_token)
