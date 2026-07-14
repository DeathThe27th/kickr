"""Normalizer tests against the REAL devnet payloads captured in backend/samples/."""
import json
from pathlib import Path

from app.txline.normalize import normalize_fixture, normalize_odds, normalize_score

SAMPLES = Path(__file__).resolve().parents[1] / "samples"


def test_normalize_real_fixture_payloads():
    raws = json.loads((SAMPLES / "fixtures_snapshot_day20618.json").read_text())
    fixtures = [normalize_fixture(r) for r in raws]
    assert len(fixtures) == 97
    mexico = next(f for f in fixtures if f.txline_fixture_id == 17588223)
    assert mexico.home == "Mexico" and mexico.away == "South Korea"
    assert mexico.kickoff_at.year == 2026 and mexico.competition_id == 72


def test_normalize_real_ou_odds():
    raws = json.loads((SAMPLES / "odds_snapshot_17588228.json").read_text())
    odds = normalize_odds(raws[0], participant1_is_home=True)
    assert odds.market == "OU"
    assert odds.line == 2.5  # feed sends "line=5" in half-goal units
    assert odds.prices == {"over": 1.495, "under": 3.020}
    assert abs(odds.probs["over"] - 0.6689) < 1e-3  # feed's own de-vigged Pct
    assert odds.in_running is True


def test_normalize_real_ah_odds():
    raws = json.loads((SAMPLES / "odds_snapshot_17588230.json").read_text())
    odds = normalize_odds(raws[0], participant1_is_home=True)
    assert odds.market == "AH"
    assert odds.line == -1.5  # decimal lines are literal
    assert odds.prices == {"home": 4.852, "away": 1.260}


def test_normalize_odds_flips_outcomes_when_participant1_is_away():
    raws = json.loads((SAMPLES / "odds_snapshot_17588230.json").read_text())
    odds = normalize_odds(raws[0], participant1_is_home=False)
    assert odds.prices == {"away": 4.852, "home": 1.260}


def test_normalize_score_final_record():
    state = normalize_score(
        {"fixtureId": 1, "seq": 991, "action": "game_finalised", "statusId": 100,
         "period": 100, "Score1": 2, "Score2": 1, "Ts": 1781730642351}
    )
    assert state.status == "finished"
    assert (state.score_home, state.score_away) == (2, 1)
