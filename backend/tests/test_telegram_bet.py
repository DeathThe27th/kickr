"""Inline betting: the tap-a-price-in-chat loop the bot exists for.

The handlers reach for a session via session_scope(), so the module-level one is
swapped for an in-memory database. aiogram's CallbackQuery is a pydantic model
and awkward to build by hand; these fakes carry only what the handlers touch.
"""
from __future__ import annotations

import datetime
from contextlib import contextmanager

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.ledger import balance, ensure_user
from app.models import Base, Bet, Fixture, Market, Transaction
from app.telegram import bot as tgbot


@pytest.fixture()
def db(monkeypatch):
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)

    @contextmanager
    def fake_scope():
        session = Session()
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    monkeypatch.setattr(tgbot, "session_scope", fake_scope)
    return Session


class FakeMessage:
    def __init__(self, chat_id="555"):
        self.chat = type("Chat", (), {"id": chat_id})()
        self.edits: list[str] = []

    async def edit_text(self, text, **kwargs):
        self.edits.append(text)


class FakeCallback:
    def __init__(self, data, chat_id="555"):
        self.data = data
        self.message = FakeMessage(chat_id)
        self.answers: list[tuple[str, bool]] = []

    async def answer(self, text="", show_alert=False):
        self.answers.append((text, show_alert))


def seed(Session, *, chat_id="555", status="open", chips=None):
    """chips: desired ending balance. ensure_user already credits the 1,000
    signup bonus, so this tops up or debits to land exactly on the target."""
    with Session() as s:
        fixture = Fixture(
            txline_fixture_id=1,
            home="England",
            away="Argentina",
            kickoff_at=datetime.datetime.now(),
            status="live",
        )
        s.add(fixture)
        s.flush()
        market = Market(
            template_id="M1",
            fixture_id=fixture.id,
            question="Goal before 25:00?",
            outcomes=["Yes", "No"],
            prices={"Yes": 2.5, "No": 1.5},
            # NOT NULL — omitting it is what broke the first attempt at this test.
            settle_rule={"type": "goal_before", "minute": 25},
            status=status,
        )
        s.add(market)
        user = ensure_user(s, "dev:tester", "tester")
        user.telegram_chat_id = chat_id
        if chips is not None:
            delta = chips - balance(s, user.id)
            if delta:
                s.add(Transaction(user_id=user.id, amount=delta, kind="faucet"))
        s.commit()
        return market.id, user.id


@pytest.mark.asyncio
async def test_tap_price_then_stake_places_bet(db):
    market_id, user_id = seed(db)

    cb = FakeCallback(f"o:{market_id}:0")
    await tgbot.choose_outcome(cb)
    assert "Yes @ 2.50" in cb.message.edits[0]
    assert "Stake?" in cb.message.edits[0]

    cb = FakeCallback(f"s:{market_id}:0:25")
    await tgbot.place(cb)
    assert "25 on Yes @ 2.50" in cb.message.edits[0]
    # round() is half-to-even, so 62.5 books as 62 rather than 63.
    assert "Returns 62" in cb.message.edits[0]
    assert cb.answers[-1][0] == "Bet placed"

    with db() as s:
        assert balance(s, user_id) == 975


@pytest.mark.asyncio
async def test_locked_market_rejects_the_tap(db):
    market_id, _ = seed(db, status="locked")

    cb = FakeCallback(f"o:{market_id}:0")
    await tgbot.choose_outcome(cb)
    assert cb.answers[-1] == ("That market has closed.", True)
    assert cb.message.edits == []


@pytest.mark.asyncio
async def test_unlinked_chat_cannot_bet(db):
    market_id, _ = seed(db, chat_id="999")

    cb = FakeCallback(f"s:{market_id}:0:25", chat_id="555")
    await tgbot.place(cb)
    assert "Not linked" in cb.answers[-1][0]

    with db() as s:
        assert s.query(Bet).count() == 0


@pytest.mark.asyncio
async def test_insufficient_balance_surfaces_as_alert(db):
    market_id, _ = seed(db, chips=10)

    cb = FakeCallback(f"s:{market_id}:0:100")
    await tgbot.place(cb)
    assert "insufficient balance" in cb.answers[-1][0]
    assert cb.answers[-1][1] is True


@pytest.mark.asyncio
async def test_price_moved_since_send_bets_the_live_price(db):
    """The button carries no price, so a bet always books the current quote —
    the stale one on the message must never be honoured."""
    market_id, user_id = seed(db)
    with db() as s:
        m = s.get(Market, market_id)
        m.prices = {"Yes": 1.8, "No": 2.0}
        s.commit()

    cb = FakeCallback(f"s:{market_id}:0:100")
    await tgbot.place(cb)
    assert "100 on Yes @ 1.80" in cb.message.edits[0]
