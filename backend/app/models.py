"""ORM models mirroring backend/migrations/001_init.sql (build.md §5)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def new_id() -> str:
    return str(uuid.uuid4())


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    privy_did: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    handle: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    telegram_chat_id: Mapped[str | None] = mapped_column(String(64), nullable=True)  # Part 2 hook


class Transaction(Base):
    """Append-only ledger. Balance = SUM(amount) (exposed as view `balances`)."""

    __tablename__ = "transactions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)
    amount: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    # signup_bonus | faucet | bet_stake | bet_payout | refund | reset
    ref_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    __table_args__ = (Index("ix_transactions_user", "user_id"),)


class Fixture(Base):
    __tablename__ = "fixtures"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    txline_fixture_id: Mapped[int] = mapped_column(BigInteger, unique=True, nullable=False)
    stage: Mapped[str] = mapped_column(String(8), default="group")  # group|r32|r16|qf|sf|f
    bracket_slot: Mapped[str | None] = mapped_column(String(16), nullable=True)
    home: Mapped[str] = mapped_column(String(64), nullable=False)
    away: Mapped[str] = mapped_column(String(64), nullable=False)
    kickoff_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="upcoming")  # upcoming|live|finished
    score_home: Mapped[int] = mapped_column(Integer, default=0)
    score_away: Mapped[int] = mapped_column(Integer, default=0)
    minute: Mapped[int] = mapped_column(Integer, default=0)


class OddsSnapshot(Base):
    __tablename__ = "odds_snapshots"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    fixture_id: Mapped[str] = mapped_column(String(36), ForeignKey("fixtures.id"), nullable=False)
    market_type: Mapped[str] = mapped_column(String(48), nullable=False)  # e.g. 1X2, OU, AH
    line: Mapped[float | None] = mapped_column(Float, nullable=True)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    __table_args__ = (Index("ix_snapshots_fixture_ts", "fixture_id", "ts"),)


class Market(Base):
    __tablename__ = "markets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    template_id: Mapped[str] = mapped_column(String(8), nullable=False)  # PM1..PM4, M1..M8
    fixture_id: Mapped[str] = mapped_column(String(36), ForeignKey("fixtures.id"), nullable=False)
    question: Mapped[str] = mapped_column(Text, nullable=False)
    outcomes: Mapped[list] = mapped_column(JSON, nullable=False)  # 2-3 outcome labels
    prices: Mapped[dict] = mapped_column(JSON, default=dict)  # outcome -> decimal odds
    opens_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    locks_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    settle_rule: Mapped[dict] = mapped_column(JSON, nullable=False)  # machine-readable
    status: Mapped[str] = mapped_column(String(16), default="open")
    # open | suspended | locked | settled | voided
    receipt_open_sig: Mapped[str | None] = mapped_column(String(128), nullable=True)
    receipt_settle_sig: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # Demo replay cycle (build.md §9): each restart bumps the cycle so the same
    # trigger windows can reopen; always 0 in real mode.
    cycle: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    __table_args__ = (
        Index("ix_markets_fixture_status", "fixture_id", "status"),
        # One instance of a template per fixture per trigger window (per demo cycle)
        UniqueConstraint("fixture_id", "template_id", "question", "cycle", name="uq_market_instance"),
    )


class Bet(Base):
    __tablename__ = "bets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)
    market_id: Mapped[str] = mapped_column(String(36), ForeignKey("markets.id"), nullable=False)
    outcome: Mapped[str] = mapped_column(String(64), nullable=False)
    stake: Mapped[int] = mapped_column(Integer, nullable=False)
    odds_locked: Mapped[float] = mapped_column(Float, nullable=False)
    potential_payout: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="open")  # open|won|lost|voided
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    __table_args__ = (Index("ix_bets_user", "user_id"), Index("ix_bets_market", "market_id"))


class Settlement(Base):
    __tablename__ = "settlements"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    market_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("markets.id"), unique=True, nullable=False
    )  # unique => idempotent settlement
    winning_outcome: Mapped[str | None] = mapped_column(String(64), nullable=True)  # null = voided
    settled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    evidence: Mapped[dict] = mapped_column(JSON, default=dict)  # score/minute snapshot


class NotificationOutbox(Base):
    """Part 2 hook — written, never consumed here."""

    __tablename__ = "notification_outbox"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    event_type: Mapped[str] = mapped_column(String(32), nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
