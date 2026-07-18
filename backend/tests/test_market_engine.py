"""Trigger/settlement engine integration test: a synthetic match walks through
pre-match -> kickoff -> goal -> window expiry -> HT -> FT and every market
lifecycle rule from build.md §4 is asserted along the way."""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.ledger import balance, ensure_user, place_bet
from app.markets.engine import MarketEngine, TickEvents
from app.models import Base, Bet, Fixture, Market, Settlement
from app.pricing.engine import PricedState
from app.txline.types import NormMatchState


@pytest.fixture()
def session():
    eng = create_engine("sqlite://")
    Base.metadata.create_all(eng)
    s = sessionmaker(bind=eng, expire_on_commit=False)()
    yield s
    s.close()


def priced(lam=2.5, ph=0.45, pd=0.28, pa=0.27, line=2.5, p_over=0.55):
    return PricedState(
        lam_rem=lam, lam_home=lam * 0.55, lam_away=lam * 0.45,
        probs_1x2={"home": ph, "draw": pd, "away": pa},
        ou_line=line, p_over=p_over,
        probs_ah={"home": 0.48, "away": 0.52}, ah_line=-0.5, fresh=True,
    )


def state(minute, h, a, status="live"):
    return NormMatchState(
        txline_fixture_id=1, status=status, score_home=h, score_away=a,
        minute=minute, ts=datetime.now(timezone.utc),
    )


def markets_by_template(session):
    rows = session.execute(select(Market)).scalars().all()
    return {m.template_id: m for m in rows}


def test_full_match_lifecycle(session):
    fixture = Fixture(txline_fixture_id=1, home="France", away="Spain",
                      kickoff_at=datetime.now(timezone.utc), stage="sf")
    session.add(fixture)
    session.flush()
    engine = MarketEngine()

    # Pre-match: PM1-PM4 open with quoted prices
    engine.tick(session, fixture, state(0, 0, 0, "upcoming"), priced(), cycle=0)
    ms = markets_by_template(session)
    assert {"PM1", "PM2", "PM3", "PM4"} <= set(ms)
    assert all(m.status == "open" for m in ms.values())
    assert ms["PM1"].prices["Home"] > 1.0

    # A user backs Over pre-match
    user = ensure_user(session, "did:test", "tester")
    session.flush()
    bet = place_bet(session, user, ms["PM2"], "Over", 100, ms["PM2"].prices["Over"])

    # Kickoff: PMs lock, M1 opens
    engine.tick(session, fixture, state(0, 0, 0), priced(), cycle=0)
    ms = markets_by_template(session)
    assert ms["PM1"].status == "locked"
    assert ms["M1"].status == "open" and ms["M1"].question == "Goal before 25:00?"

    # Goal at minute 12: M1 settles Yes instantly, M2 window opens on re-tick
    engine.tick(session, fixture, state(12, 1, 0), priced(lam=2.0), cycle=0)
    ms = markets_by_template(session)
    assert ms["M1"].status == "settled"
    settlement = session.execute(
        select(Settlement).where(Settlement.market_id == ms["M1"].id)
    ).scalar_one()
    assert settlement.winning_outcome == "Yes"
    assert ms["M2"].question == "Another goal before 32:00?"

    # Minute 32, no second goal: M2 locks on expiry and settles No
    engine.tick(session, fixture, state(32, 1, 0), priced(lam=1.6), cycle=0)
    ms = markets_by_template(session)
    assert ms["M2"].status == "settled"
    s2 = session.execute(select(Settlement).where(Settlement.market_id == ms["M2"].id)).scalar_one()
    assert s2.winning_outcome == "No"

    # HT at 1-0, then minute 50: M3 opens knowing h1 goals
    engine.tick(session, fixture, state(45, 1, 0, "ht"), priced(lam=1.3), cycle=0)
    engine.tick(session, fixture, state(50, 1, 0), priced(lam=1.2), cycle=0)
    ms = markets_by_template(session)
    assert ms["M3"].settle_rule["h1_goals"] == 1

    # Minute 62 (1-goal lead after 60): M7 equalizer market opens; M4 opened at 55+
    engine.tick(session, fixture, state(56, 1, 0), priced(lam=1.1), cycle=0)
    engine.tick(session, fixture, state(62, 1, 0), priced(lam=1.0), cycle=0)
    ms = markets_by_template(session)
    assert "M4" in ms
    assert ms["M7"].question == "Spain equalizes?"

    # Spain equalizes at 84: M7 settles Yes immediately
    engine.tick(session, fixture, state(84, 1, 1), priced(lam=0.5), cycle=0)
    ms = markets_by_template(session)
    s7 = session.execute(select(Settlement).where(Settlement.market_id == ms["M7"].id)).scalar_one()
    assert s7.winning_outcome == "Yes"

    # FT 1-1: everything remaining settles; PM2 Under wins (Over bet loses),
    # M3 settles No (h1=1, h2=1)
    engine.tick(session, fixture, state(90, 1, 1, "finished"), priced(lam=0.1), cycle=0)
    session.flush()
    ms = markets_by_template(session)
    open_left = [m for m in ms.values() if m.status in ("open", "locked", "suspended")]
    assert open_left == []
    s_pm2 = session.execute(select(Settlement).where(Settlement.market_id == ms["PM2"].id)).scalar_one()
    assert s_pm2.winning_outcome == "Under"
    assert session.get(Bet, bet.id).status == "lost"
    s_pm1 = session.execute(select(Settlement).where(Settlement.market_id == ms["PM1"].id)).scalar_one()
    assert s_pm1.winning_outcome == "Draw"
    s3 = session.execute(select(Settlement).where(Settlement.market_id == ms["M3"].id)).scalar_one()
    assert s3.winning_outcome == "No"
    assert balance(session, user.id) == 900  # stake lost, nothing else touched


def test_stale_odds_suspend_and_recover(session):
    fixture = Fixture(txline_fixture_id=1, home="A", away="B",
                      kickoff_at=datetime.now(timezone.utc), stage="group")
    session.add(fixture)
    session.flush()
    engine = MarketEngine()
    engine.tick(session, fixture, state(0, 0, 0, "upcoming"), priced(), cycle=0)
    engine.tick(session, fixture, state(5, 0, 0), priced(), cycle=0)
    m1 = markets_by_template(session)["M1"]
    assert m1.status == "open"

    stale = priced()
    stale.fresh = False
    engine.tick(session, fixture, state(6, 0, 0), stale, cycle=0)
    assert m1.status == "suspended"

    engine.tick(session, fixture, state(7, 0, 0), priced(), cycle=0)
    assert m1.status == "open"


def test_reap_stranded_voids_and_refunds(session):
    """A match the feed abandoned leaves markets open and bets 'open' forever;
    reap_stranded() voids those markets and refunds every stake."""
    old_kickoff = datetime.now(timezone.utc) - timedelta(hours=6)
    fixture = Fixture(txline_fixture_id=1, home="A", away="B",
                      kickoff_at=old_kickoff, stage="group")
    session.add(fixture)
    session.flush()
    engine = MarketEngine()
    engine.tick(session, fixture, state(0, 0, 0, "upcoming"), priced(), cycle=0)
    engine.tick(session, fixture, state(5, 0, 0), priced(), cycle=0)
    ms = markets_by_template(session)

    user = ensure_user(session, "did:test", "tester")
    session.flush()
    start_balance = balance(session, user.id)
    bet = place_bet(session, user, ms["M1"], "Yes", 100, ms["M1"].prices["Yes"])
    session.flush()
    assert balance(session, user.id) == start_balance - 100

    # Feed goes quiet: the fixture is stuck 'live' hours past kickoff.
    reaped = engine.reap_stranded(session, TickEvents())
    session.flush()

    assert reaped == [fixture.id]
    assert fixture.status == "finished"
    assert all(m.status == "voided" for m in markets_by_template(session).values())
    assert session.get(Bet, bet.id).status == "voided"
    assert balance(session, user.id) == start_balance  # stake refunded

    # Idempotent: a second pass finds nothing and touches no balance.
    assert engine.reap_stranded(session, TickEvents()) == []
    assert balance(session, user.id) == start_balance


def test_reap_stranded_demo_when_sim_gone(session):
    """A demo left mid-replay with no active sim strands its bets; reap voids it
    when its id isn't in the active set, and protects it when it is."""
    fixture = Fixture(txline_fixture_id=900001, home="A", away="B",
                      kickoff_at=datetime.now(timezone.utc), stage="group", source="demo")
    session.add(fixture)
    session.flush()
    engine = MarketEngine()
    engine.tick(session, fixture, state(0, 0, 0, "upcoming"), priced(), cycle=0)
    engine.tick(session, fixture, state(5, 0, 0), priced(), cycle=0)
    ms = markets_by_template(session)
    user = ensure_user(session, "did:test", "tester")
    session.flush()
    start_balance = balance(session, user.id)
    bet = place_bet(session, user, ms["M1"], "Yes", 100, ms["M1"].prices["Yes"])
    session.flush()

    # Sim still replaying -> protected, nothing reaped.
    assert engine.reap_stranded(session, TickEvents(), active_demo_ids={900001}) == []
    assert session.get(Bet, bet.id).status == "open"
    # Default (active_demo_ids=None) protects all demos too.
    assert engine.reap_stranded(session, TickEvents()) == []
    assert session.get(Bet, bet.id).status == "open"

    # Sim gone -> stranded demo reaped and refunded.
    reaped = engine.reap_stranded(session, TickEvents(), active_demo_ids=set())
    session.flush()
    assert reaped == [fixture.id]
    assert session.get(Bet, bet.id).status == "voided"
    assert balance(session, user.id) == start_balance


def test_reap_ignores_live_match_within_window(session):
    """A genuinely in-play match (kickoff recent) must not be reaped."""
    fixture = Fixture(txline_fixture_id=1, home="A", away="B",
                      kickoff_at=datetime.now(timezone.utc), stage="group")
    session.add(fixture)
    session.flush()
    engine = MarketEngine()
    engine.tick(session, fixture, state(0, 0, 0, "upcoming"), priced(), cycle=0)
    engine.tick(session, fixture, state(5, 0, 0), priced(), cycle=0)

    assert engine.reap_stranded(session, TickEvents()) == []
    assert fixture.status == "live"
    assert any(m.status == "open" for m in markets_by_template(session).values())


def test_max_four_micro_markets(session):
    fixture = Fixture(txline_fixture_id=1, home="A", away="B",
                      kickoff_at=datetime.now(timezone.utc), stage="sf")
    session.add(fixture)
    session.flush()
    engine = MarketEngine()
    # minute 70, score level in a knockout, after goals: M2/M3/M4/M5 candidates + M1 gone
    engine.tick(session, fixture, state(0, 0, 0, "upcoming"), priced(), cycle=0)
    engine.tick(session, fixture, state(1, 0, 0), priced(), cycle=0)
    engine.tick(session, fixture, state(45, 1, 1, "ht"), priced(), cycle=0)
    engine.tick(session, fixture, state(56, 1, 1), priced(), cycle=0)
    engine.tick(session, fixture, state(71, 1, 1), priced(), cycle=0)
    open_micro = [
        m for m in session.execute(select(Market)).scalars().all()
        if m.template_id.startswith("M") and m.status == "open"
    ]
    assert len(open_micro) <= 4
