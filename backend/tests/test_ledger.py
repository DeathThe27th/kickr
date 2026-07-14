import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.ledger import (
    LedgerError,
    balance,
    bust_reset,
    claim_faucet,
    ensure_user,
    place_bet,
    settle_market,
)
from app.models import Base, Fixture, Market


@pytest.fixture()
def session():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    s = Session()
    yield s
    s.close()


def make_market(session, prices=None):
    fixture = Fixture(txline_fixture_id=1, home="A", away="B", kickoff_at=__import__("datetime").datetime.now())
    session.add(fixture)
    session.flush()
    market = Market(
        template_id="M1",
        fixture_id=fixture.id,
        question="Goal before 25:00?",
        outcomes=["Yes", "No"],
        prices=prices or {"Yes": 2.5, "No": 1.5},
        settle_rule={"type": "goal_before", "minute": 25},
    )
    session.add(market)
    session.flush()
    return market


def test_signup_bonus_credited_exactly_once(session):
    u1 = ensure_user(session, "did:privy:x", "sam")
    session.flush()
    u2 = ensure_user(session, "did:privy:x", "sam")
    assert u1.id == u2.id
    assert balance(session, u1.id) == 1000


def test_faucet_once_per_utc_day(session):
    u = ensure_user(session, "did:privy:x", "sam")
    session.flush()
    claim_faucet(session, u.id)
    assert balance(session, u.id) == 1200
    with pytest.raises(LedgerError):
        claim_faucet(session, u.id)


def test_bust_reset_rules(session):
    u = ensure_user(session, "did:privy:x", "sam")
    session.flush()
    with pytest.raises(LedgerError):  # not bust
        bust_reset(session, u.id)
    m = make_market(session)
    # burn balance down to 0 via stakes of 500 twice
    place_bet(session, u, m, "Yes", 500, 2.5)
    place_bet(session, u, m, "Yes", 500, 2.5)
    assert balance(session, u.id) == 0
    bust_reset(session, u.id)
    assert balance(session, u.id) == 100
    with pytest.raises(LedgerError):  # once per day
        bust_reset(session, u.id)


def test_place_bet_validations(session):
    u = ensure_user(session, "did:privy:x", "sam")
    session.flush()
    m = make_market(session)
    with pytest.raises(LedgerError, match="stake_out_of_range"):
        place_bet(session, u, m, "Yes", 501, 2.5)
    with pytest.raises(LedgerError, match="quote_moved"):
        place_bet(session, u, m, "Yes", 100, 3.0)  # >2% drift
    with pytest.raises(LedgerError, match="unknown_outcome"):
        place_bet(session, u, m, "Maybe", 100, 2.5)
    bet = place_bet(session, u, m, "Yes", 100, 2.5)
    assert bet.potential_payout == 250
    assert balance(session, u.id) == 900
    m.status = "locked"
    with pytest.raises(LedgerError, match="market_not_open"):
        place_bet(session, u, m, "Yes", 100, 2.5)


def test_quote_tolerance_accepts_small_drift(session):
    u = ensure_user(session, "did:privy:x", "sam")
    session.flush()
    m = make_market(session, prices={"Yes": 2.0, "No": 1.8})
    bet = place_bet(session, u, m, "Yes", 100, 1.97)  # 1.5% drift ok, locks CURRENT quote
    assert bet.odds_locked == 2.0


def test_settlement_balance_math_and_idempotency(session):
    winner = ensure_user(session, "did:privy:w", "winner")
    loser = ensure_user(session, "did:privy:l", "loser")
    session.flush()
    m = make_market(session)
    place_bet(session, winner, m, "Yes", 200, 2.5)  # potential 500
    place_bet(session, loser, m, "No", 100, 1.5)
    assert balance(session, winner.id) == 800
    assert balance(session, loser.id) == 900

    first = settle_market(session, m, "Yes", {"score": "1-0", "minute": 12})
    assert first is not None
    session.flush()
    assert balance(session, winner.id) == 1300  # 800 + 500 payout
    assert balance(session, loser.id) == 900  # stake stays lost
    assert m.status == "settled"

    # Double settlement is a no-op — pays nothing twice.
    second = settle_market(session, m, "Yes", {"score": "1-0", "minute": 12})
    assert second is None
    session.flush()
    assert balance(session, winner.id) == 1300


def test_void_refunds_stakes(session):
    u = ensure_user(session, "did:privy:x", "sam")
    session.flush()
    m = make_market(session)
    bet = place_bet(session, u, m, "Yes", 300, 2.5)
    assert balance(session, u.id) == 700
    settle_market(session, m, None, {"reason": "abandoned"})
    session.flush()
    assert balance(session, u.id) == 1000
    assert bet.status == "voided"
    assert m.status == "voided"


def test_exposure_cap(session):
    # 20,000 potential payout cap per outcome
    users = [ensure_user(session, f"did:{i}", f"u{i}") for i in range(50)]
    session.flush()
    m = make_market(session, prices={"Yes": 14.0, "No": 1.1})
    placed = 0
    capped = False
    for u in users:
        try:
            place_bet(session, u, m, "Yes", 500, 14.0)  # potential 7000 each
            placed += 1
        except LedgerError as e:
            assert "exposure" in str(e)
            capped = True
            break
    assert capped and placed == 2  # 3rd bet would breach 20,000
