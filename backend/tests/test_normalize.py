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
    # Lines are literal. The live mainnet OU ladder settles it: line=2 prices
    # P(over)=0.489, between line=1.75 (0.571) and line=2.25 (0.408).
    #
    # NOTE: this devnet sample carries "line=5" at P(over)=0.669, which only
    # makes sense as 2.5 goals — i.e. the devnet capture is on a half-goal
    # scale that mainnet does not use. We price against mainnet, so literal
    # wins; revisit if kickr is ever pointed back at devnet.
    assert odds.line == 5.0
    assert odds.prices == {"over": 1.495, "under": 3.020}
    assert abs(odds.probs["over"] - 0.6689) < 1e-3  # feed's own de-vigged Pct
    assert odds.in_running is True


def test_normalize_odds_survives_na_pct():
    """The live feed sends Pct="NA" per-leg once in-running. It must not raise,
    and the record must fall back to de-vigging its own prices."""
    odds = normalize_odds(
        {
            "FixtureId": 1,
            "SuperOddsType": "OVERUNDER_PARTICIPANT_GOALS",
            "MarketParameters": "line=2.25",
            "MarketPeriod": None,
            "PriceNames": ["over", "under"],
            "Prices": [2450, 1690],
            "Pct": ["NA", "NA"],
            "InRunning": True,
            "Ts": 1784142464342,
        },
        participant1_is_home=True,
    )
    assert odds is not None
    assert odds.line == 2.25
    assert abs(odds.probs["over"] - 0.408) < 1e-2  # self-de-vigged, not from Pct


def test_normalize_odds_rejects_partial_na_pct():
    """A half-parsed Pct would silently misprice, so one NA discards them all."""
    odds = normalize_odds(
        {
            "FixtureId": 1,
            "SuperOddsType": "1X2_PARTICIPANT_RESULT",
            "MarketPeriod": None,
            "PriceNames": ["part1", "draw", "part2"],
            "Prices": [2735, 2890, 3468],
            "Pct": ["36.563", "NA", "28.835"],
            "Ts": 1784142464342,
        },
        participant1_is_home=True,
    )
    assert abs(sum(odds.probs.values()) - 1.0) < 1e-6  # de-vigged, sums to 1


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
        {"FixtureId": 1, "Action": "game_finalised", "StatusId": 100,
         "Clock": {"Running": False, "Seconds": 5400},
         "Score": {"Participant1": {"Total": {"Goals": 2}},
                   "Participant2": {"Total": {"Goals": 1}}},
         "Ts": 1781730642351}
    )
    assert state.status == "finished"
    assert (state.score_home, state.score_away) == (2, 1)


def test_normalize_score_status_ids_from_live_feed():
    """StatusId 1 is standby (pre-kickoff), 2 is in-play. Treating any non-zero
    id as live locks the pre-match markets before the match starts."""
    base = {"FixtureId": 1, "Ts": 1784142464342}
    standby = normalize_score({**base, "Action": "standby", "StatusId": 1,
                               "Clock": {"Running": False, "Seconds": 0}})
    assert standby.status == "upcoming"
    live = normalize_score({**base, "Action": "kickoff", "StatusId": 2,
                            "Clock": {"Running": True, "Seconds": 619}})
    assert live.status == "live"
    assert live.minute == 10  # clock lives in Clock.Seconds, not a Minute field


def test_normalize_score_takes_goals_across_the_snapshot():
    """A scores snapshot is one record per action type; only the record that
    carries a stat carries its Score, so goals are read across all of them."""
    newest = {"FixtureId": 1, "Action": "possession", "StatusId": 2,
              "Clock": {"Running": True, "Seconds": 3000}, "Ts": 3}
    records = [
        {"FixtureId": 1, "Action": "corner", "StatusId": 2, "Ts": 1,
         "Score": {"Participant1": {"Total": {"Corners": 4}}}},
        {"FixtureId": 1, "Action": "goal", "StatusId": 2, "Ts": 2,
         "Score": {"Participant1": {"Total": {"Goals": 1}},
                   "Participant2": {"Total": {"Goals": 2}}}},
        newest,
    ]
    state = normalize_score(newest, True, records)
    assert (state.score_home, state.score_away) == (1, 2)
    assert state.minute == 50  # status/clock still come from the newest record


def test_normalize_score_flips_when_participant1_is_away():
    records = [{"FixtureId": 1, "Action": "goal", "StatusId": 2, "Ts": 1,
                "Score": {"Participant1": {"Total": {"Goals": 1}},
                          "Participant2": {"Total": {"Goals": 2}}}}]
    state = normalize_score(records[0], False, records)
    assert (state.score_home, state.score_away) == (2, 1)
