"""Play-money ledger (build.md §5). Every mutation happens inside the caller's
session transaction; balance is always SUM(transactions.amount)."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .config import settings
from .models import Bet, Market, NotificationOutbox, Settlement, Transaction, User


class LedgerError(Exception):
    """Domain error surfaced as HTTP 400/409 by the API layer."""


def balance(session: Session, user_id: str) -> int:
    total = session.execute(
        select(func.coalesce(func.sum(Transaction.amount), 0)).where(Transaction.user_id == user_id)
    ).scalar_one()
    return int(total)


def _utc_day_bounds(now: datetime) -> tuple[datetime, datetime]:
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return start, now


def _claimed_today(session: Session, user_id: str, kind: str) -> bool:
    start, now = _utc_day_bounds(datetime.now(timezone.utc))
    row = session.execute(
        select(Transaction.id)
        .where(
            Transaction.user_id == user_id,
            Transaction.kind == kind,
            Transaction.created_at >= start,
        )
        .limit(1)
    ).first()
    return row is not None


def ensure_user(session: Session, privy_did: str, handle: str) -> User:
    """Upsert on first verified request; credit signup bonus exactly once."""
    user = session.execute(select(User).where(User.privy_did == privy_did)).scalar_one_or_none()
    if user is None:
        user = User(privy_did=privy_did, handle=handle)
        session.add(user)
        session.flush()
    has_bonus = session.execute(
        select(Transaction.id)
        .where(Transaction.user_id == user.id, Transaction.kind == "signup_bonus")
        .limit(1)
    ).first()
    if has_bonus is None:
        session.add(Transaction(user_id=user.id, amount=settings.signup_bonus, kind="signup_bonus"))
    return user


def claim_faucet(session: Session, user_id: str) -> int:
    if _claimed_today(session, user_id, "faucet"):
        raise LedgerError("Faucet already claimed today (one claim per UTC day).")
    session.add(Transaction(user_id=user_id, amount=settings.faucet_amount, kind="faucet"))
    return settings.faucet_amount


def bust_reset(session: Session, user_id: str) -> int:
    bal = balance(session, user_id)
    if bal >= settings.bust_reset_threshold:
        raise LedgerError(f"Reset only available below {settings.bust_reset_threshold} chips.")
    if _claimed_today(session, user_id, "reset"):
        raise LedgerError("Reset already used today (once per UTC day).")
    top_up = settings.bust_reset_to - bal
    session.add(Transaction(user_id=user_id, amount=top_up, kind="reset"))
    return top_up


def place_bet(
    session: Session,
    user: User,
    market: Market,
    outcome: str,
    stake: int,
    odds_seen: float,
) -> Bet:
    """Validates quote freshness, balance and limits; stakes and books the bet
    in one transaction. Raises LedgerError with a machine-readable message."""
    if market.status != "open":
        raise LedgerError(f"market_not_open:{market.status}")
    if outcome not in market.outcomes:
        raise LedgerError("unknown_outcome")
    if stake <= 0 or stake > settings.max_stake:
        raise LedgerError(f"stake_out_of_range:1..{settings.max_stake}")

    current = float(market.prices.get(outcome, 0))
    if current <= 1.0:
        raise LedgerError("outcome_suspended")
    # Quote validity: accept only if the client's odds match current within 2%.
    if abs(current - odds_seen) / current > settings.quote_tolerance:
        raise LedgerError(f"quote_moved:{current}")

    if balance(session, user.id) < stake:
        raise LedgerError("insufficient_balance")

    potential = round(stake * current)
    # House exposure cap per market: sum of potential payouts on this outcome.
    exposure = session.execute(
        select(func.coalesce(func.sum(Bet.potential_payout), 0)).where(
            Bet.market_id == market.id, Bet.outcome == outcome, Bet.status == "open"
        )
    ).scalar_one()
    if exposure + potential > settings.max_market_exposure:
        raise LedgerError("outcome_exposure_capped")

    bet = Bet(
        user_id=user.id,
        market_id=market.id,
        outcome=outcome,
        stake=stake,
        odds_locked=current,
        potential_payout=potential,
    )
    session.add(bet)
    session.flush()
    session.add(Transaction(user_id=user.id, amount=-stake, kind="bet_stake", ref_id=bet.id))
    return bet


def settle_market(
    session: Session,
    market: Market,
    winning_outcome: str | None,
    evidence: dict,
) -> Settlement | None:
    """Idempotent settlement: unique constraint on settlements.market_id makes a
    second call a no-op. winning_outcome=None voids the market and refunds.
    Insert settlement -> update bets -> insert payout rows, one transaction."""
    existing = session.execute(
        select(Settlement).where(Settlement.market_id == market.id)
    ).scalar_one_or_none()
    if existing is not None:
        return None

    settlement = Settlement(market_id=market.id, winning_outcome=winning_outcome, evidence=evidence)
    session.add(settlement)

    bets = session.execute(select(Bet).where(Bet.market_id == market.id, Bet.status == "open")).scalars().all()
    for bet in bets:
        if winning_outcome is None:
            bet.status = "voided"
            session.add(Transaction(user_id=bet.user_id, amount=bet.stake, kind="refund", ref_id=bet.id))
        elif bet.outcome == winning_outcome:
            bet.status = "won"
            session.add(
                Transaction(user_id=bet.user_id, amount=bet.potential_payout, kind="bet_payout", ref_id=bet.id)
            )
        else:
            bet.status = "lost"
        session.add(
            NotificationOutbox(
                user_id=bet.user_id,
                event_type="bet_settled",
                payload={"bet_id": bet.id, "market_id": market.id, "status": bet.status},
            )
        )

    market.status = "voided" if winning_outcome is None else "settled"
    return settlement
