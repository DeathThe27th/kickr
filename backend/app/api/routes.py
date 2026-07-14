"""HTTP API (build.md §7)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import current_user
from ..config import settings
from ..db import get_session
from ..ledger import LedgerError, balance, bust_reset, claim_faucet, place_bet
from ..models import Bet, Fixture, Market, Settlement, Transaction, User
from ..receipts import explorer_url
from .stream import broker

router = APIRouter(prefix="/api")

# Populated by main.py at startup (shared runtime objects).
runtime: dict = {}


def _headline_probs(fixture_id: str) -> dict | None:
    """De-vigged 1X2 win probs from the market engine's last pricing tick."""
    engine = runtime.get("engine")
    return engine._last_1x2.get(fixture_id) if engine else None


def _market_json(m: Market) -> dict:
    return {
        "id": m.id,
        "template_id": m.template_id,
        "fixture_id": m.fixture_id,
        "question": m.question,
        "outcomes": m.outcomes,
        "prices": m.prices,
        "status": m.status,
        "opens_at": m.opens_at.isoformat() if m.opens_at else None,
        "locks_at_minute": m.settle_rule.get("locks_at_minute"),
        "receipt_open_sig": m.receipt_open_sig,
        "receipt_settle_sig": m.receipt_settle_sig,
    }


# ---------------------------------------------------------------- public data
@router.get("/bracket")
def bracket(session: Session = Depends(get_session)):
    fixtures = session.execute(select(Fixture)).scalars().all()
    open_counts = dict(
        session.execute(
            select(Market.fixture_id, func.count())
            .where(Market.status.in_(["open", "suspended"]))
            .group_by(Market.fixture_id)
        ).all()
    )
    return {
        "fixtures": [
            {
                "id": f.id,
                "txline_fixture_id": f.txline_fixture_id,
                "stage": f.stage,
                "bracket_slot": f.bracket_slot,
                "home": f.home,
                "away": f.away,
                "kickoff_at": f.kickoff_at.isoformat() if f.kickoff_at else None,
                "status": f.status,
                "score": [f.score_home, f.score_away],
                "minute": f.minute,
                "win_probs": _headline_probs(f.id),
                "open_markets": open_counts.get(f.id, 0),
            }
            for f in fixtures
        ]
    }


@router.get("/fixtures/{fixture_id}/markets")
def fixture_markets(
    fixture_id: str, include: str | None = None, session: Session = Depends(get_session)
):
    statuses = ["open", "suspended", "locked"]
    if include == "settled":
        statuses += ["settled", "voided"]
    rows = (
        session.execute(
            select(Market)
            .where(Market.fixture_id == fixture_id, Market.status.in_(statuses))
            .order_by(Market.created_at.desc())
        )
        .scalars()
        .all()
    )
    settlements = {
        s.market_id: s
        for s in session.execute(
            select(Settlement).where(Settlement.market_id.in_([m.id for m in rows]))
        ).scalars()
    }
    out = []
    for m in rows:
        d = _market_json(m)
        s = settlements.get(m.id)
        if s:
            d["settlement"] = {
                "winning_outcome": s.winning_outcome,
                "settled_at": s.settled_at.isoformat(),
                "evidence": s.evidence,
            }
        out.append(d)
    return {"markets": out}


@router.get("/markets/{market_id}/receipt")
def market_receipt(market_id: str, session: Session = Depends(get_session)):
    m = session.get(Market, market_id)
    if m is None:
        raise HTTPException(404, "market not found")
    s = session.execute(select(Settlement).where(Settlement.market_id == m.id)).scalar_one_or_none()
    return {
        "market_id": m.id,
        "question": m.question,
        "outcomes": m.outcomes,
        "prices": m.prices,
        "settlement": {
            "winning_outcome": s.winning_outcome,
            "evidence": s.evidence,
            "settled_at": s.settled_at.isoformat(),
        }
        if s
        else None,
        "receipts": {
            "open": {"sig": m.receipt_open_sig, "explorer": explorer_url(m.receipt_open_sig)}
            if m.receipt_open_sig
            else None,
            "settle": {"sig": m.receipt_settle_sig, "explorer": explorer_url(m.receipt_settle_sig)}
            if m.receipt_settle_sig
            else None,
        },
    }


@router.get("/leaderboard")
def leaderboard(session: Session = Depends(get_session)):
    def board(since: datetime | None) -> list[dict]:
        q = select(Bet, User.handle).join(User, User.id == Bet.user_id).where(
            Bet.status.in_(["won", "lost"])
        )
        if since is not None:
            q = q.where(Bet.created_at >= since)
        rows = session.execute(q).all()
        stats: dict[str, dict] = {}
        for bet, handle in rows:
            s = stats.setdefault(
                handle, {"handle": handle, "profit": 0, "staked": 0, "won": 0, "settled": 0}
            )
            s["staked"] += bet.stake
            s["settled"] += 1
            if bet.status == "won":
                s["won"] += 1
                s["profit"] += bet.potential_payout - bet.stake
            else:
                s["profit"] -= bet.stake
        out = []
        for s in stats.values():
            s["roi_pct"] = round(100 * s["profit"] / s["staked"], 1) if s["staked"] else 0.0
            s["hit_rate_pct"] = round(100 * s["won"] / s["settled"], 1) if s["settled"] else 0.0
            out.append(s)
        return sorted(out, key=lambda x: -x["profit"])[:50]

    week_ago = datetime.now(timezone.utc) - timedelta(days=7)
    return {"weekly": board(week_ago), "all_time": board(None)}


# --------------------------------------------------------------------- authed
@router.get("/me")
def me(user: User = Depends(current_user), session: Session = Depends(get_session)):
    bets = (
        session.execute(
            select(Bet, Market.question, Market.status, Market.prices, Market.fixture_id)
            .join(Market, Market.id == Bet.market_id)
            .where(Bet.user_id == user.id)
            .order_by(Bet.created_at.desc())
            .limit(100)
        )
    ).all()
    faucet_claimed = False
    start_of_day = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    faucet_claimed = (
        session.execute(
            select(Transaction.id)
            .where(
                Transaction.user_id == user.id,
                Transaction.kind == "faucet",
                Transaction.created_at >= start_of_day,
            )
            .limit(1)
        ).first()
        is not None
    )
    return {
        "id": user.id,
        "handle": user.handle,
        "balance": balance(session, user.id),
        "faucet_claimable": not faucet_claimed,
        "bets": [
            {
                "id": b.id,
                "market_id": b.market_id,
                "fixture_id": fixture_id,
                "question": question,
                "outcome": b.outcome,
                "stake": b.stake,
                "odds_locked": b.odds_locked,
                "potential_payout": b.potential_payout,
                "status": b.status,
                "market_status": market_status,
                "current_prices": prices,
                "created_at": b.created_at.isoformat(),
            }
            for b, question, market_status, prices, fixture_id in bets
        ],
    }


class BetRequest(BaseModel):
    market_id: str
    outcome: str
    stake: int
    odds_seen: float


@router.post("/bets")
def create_bet(
    body: BetRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    market = session.get(Market, body.market_id)
    if market is None:
        raise HTTPException(404, "market not found")
    try:
        bet = place_bet(session, user, market, body.outcome, body.stake, body.odds_seen)
    except LedgerError as exc:
        msg = str(exc)
        if msg.startswith("quote_moved"):
            # §8.2 race case: inline re-quote payload
            raise HTTPException(409, {"error": "quote_moved", "current_prices": market.prices})
        if msg.startswith("market_not_open"):
            s = session.execute(
                select(Settlement).where(Settlement.market_id == market.id)
            ).scalar_one_or_none()
            raise HTTPException(
                409,
                {
                    "error": "market_not_open",
                    "status": market.status,
                    "evidence": s.evidence if s else None,
                    "winning_outcome": s.winning_outcome if s else None,
                },
            )
        raise HTTPException(400, {"error": msg})
    session.flush()
    return {
        "ticket": {
            "bet_id": bet.id,
            "market_id": market.id,
            "question": market.question,
            "outcome": bet.outcome,
            "stake": bet.stake,
            "odds_locked": bet.odds_locked,
            "potential_payout": bet.potential_payout,
        },
        "balance": balance(session, user.id),
    }


@router.post("/me/faucet")
def faucet(user: User = Depends(current_user), session: Session = Depends(get_session)):
    try:
        amount = claim_faucet(session, user.id)
    except LedgerError as exc:
        raise HTTPException(400, {"error": str(exc)})
    session.flush()
    return {"credited": amount, "balance": balance(session, user.id)}


@router.post("/me/reset")
def reset(user: User = Depends(current_user), session: Session = Depends(get_session)):
    try:
        amount = bust_reset(session, user.id)
    except LedgerError as exc:
        raise HTTPException(400, {"error": str(exc)})
    session.flush()
    return {"credited": amount, "balance": balance(session, user.id)}


# --------------------------------------------------------------------- stream
@router.get("/stream")
async def stream():
    return StreamingResponse(
        broker.subscribe(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------- admin
@router.post("/admin/demo/restart")
def demo_restart(x_admin_key: str = Header(default="")):
    if x_admin_key != settings.admin_key:
        raise HTTPException(403, "bad admin key")
    source = runtime.get("source")
    if source is None or not hasattr(source, "restart"):
        raise HTTPException(400, "demo mode not active")
    source.restart()
    broker.publish({"event": "demo_restarted"})
    return {"ok": True, "cycle": source.cycle}


# ---------------------------------------------------------------------- misc
@router.get("/stats")
def stats(session: Session = Depends(get_session)):
    """Landing page footer strip: settled count, active markets, sample receipt."""
    settled = session.execute(select(func.count()).select_from(Settlement)).scalar_one()
    active = session.execute(
        select(func.count()).select_from(Market).where(Market.status.in_(["open", "suspended"]))
    ).scalar_one()
    sample_sig = session.execute(
        select(Market.receipt_settle_sig)
        .where(Market.receipt_settle_sig.is_not(None))
        .order_by(Market.created_at.desc())
        .limit(1)
    ).scalar_one_or_none() or session.execute(
        select(Market.receipt_open_sig)
        .where(Market.receipt_open_sig.is_not(None))
        .order_by(Market.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()
    return {
        "markets_settled": settled,
        "markets_active": active,
        "sample_receipt": explorer_url(sample_sig) if sample_sig else None,
        "demo_mode": settings.demo_mode,
    }
