"""Normalizers for raw TxLINE payloads -> internal types.

Written against real devnet responses captured in backend/samples/:

Fixture record (fixtures_snapshot_day*.json):
    {"Ts": 1781920800000, "StartTime": 1781830800000, "Competition": "World Cup",
     "CompetitionId": 72, "FixtureGroupId": 10115674, "Participant1Id": 2545,
     "Participant1": "Mexico", "Participant2Id": 3013, "Participant2": "South Korea",
     "FixtureId": 17588223, "Participant1IsHome": true}

Odds record (odds_snapshot_*.json):
    {"FixtureId": 17588228, "MessageId": "...", "Ts": 1781730642351,
     "Bookmaker": "TXLineStablePriceDemargined", "BookmakerId": 10021,
     "SuperOddsType": "OVERUNDER_PARTICIPANT_GOALS", "GameState": null,
     "InRunning": true, "MarketParameters": "line=5", "MarketPeriod": null,
     "PriceNames": ["over", "under"], "Prices": [1495, 3020],
     "Pct": ["66.890", "33.113"]}

Prices are integers x1000 (1495 = 1.495). Pct is the feed's own de-vigged
probability. OU integer lines are half-goal units (line=5 -> 2.5 goals);
lines containing a decimal point (AH "line=-1.5") are literal.
"""
from __future__ import annotations

from datetime import datetime, timezone

from .types import NormFixture, NormMatchState, NormOdds


def _ms_to_dt(ms: int | float) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


def normalize_fixture(raw: dict) -> NormFixture:
    p1_home = raw.get("Participant1IsHome", True)
    home = raw["Participant1"] if p1_home else raw["Participant2"]
    away = raw["Participant2"] if p1_home else raw["Participant1"]
    return NormFixture(
        txline_fixture_id=int(raw["FixtureId"]),
        home=home,
        away=away,
        kickoff_at=_ms_to_dt(raw["StartTime"]),
        competition_id=int(raw.get("CompetitionId", 0)),
        raw=raw,
    )


def _parse_line(params: str | None, market: str) -> float | None:
    if not params:
        return None
    for part in params.split(";"):
        if part.startswith("line="):
            value = part[len("line=") :]
            if "." in value:
                return float(value)
            # integer OU lines are half-goal units in the observed payloads
            n = float(value)
            return n / 2 if market == "OU" else n
    return None


def _market_kind(super_odds_type: str) -> str | None:
    t = (super_odds_type or "").upper()
    if "OVERUNDER" in t:
        return "OU"
    if "ASIANHANDICAP" in t:
        return "AH"
    if "WINDRAWWIN" in t or "MATCHODDS" in t or "1X2" in t or t.startswith("THREEWAY"):
        return "1X2"
    return None


# canonical outcome names keyed by (market, feed price name)
_NAME_MAP = {
    ("OU", "over"): "over",
    ("OU", "under"): "under",
    ("AH", "part1"): "p1",
    ("AH", "part2"): "p2",
    ("1X2", "part1"): "p1",
    ("1X2", "draw"): "draw",
    ("1X2", "part2"): "p2",
    ("1X2", "home"): "p1",
    ("1X2", "away"): "p2",
}


def normalize_odds(raw: dict, participant1_is_home: bool = True) -> NormOdds | None:
    """Returns None for market types we don't track. p1/p2 outcomes are mapped
    to home/away using the fixture's Participant1IsHome flag."""
    market = _market_kind(raw.get("SuperOddsType", ""))
    if market is None:
        return None

    names = [str(n).lower() for n in raw.get("PriceNames", [])]
    price_ints = raw.get("Prices", [])
    pcts = raw.get("Pct") or []
    prices: dict[str, float] = {}
    probs: dict[str, float] = {}

    for i, name in enumerate(names):
        canonical = _NAME_MAP.get((market, name), name)
        if canonical in ("p1", "p2"):
            is_p1 = canonical == "p1"
            canonical = ("home" if is_p1 else "away") if participant1_is_home else ("away" if is_p1 else "home")
        if i < len(price_ints):
            prices[canonical] = price_ints[i] / 1000.0
        if i < len(pcts):
            probs[canonical] = float(pcts[i]) / 100.0

    if not probs and prices:  # de-vig ourselves if the feed didn't
        raw_probs = {k: 1.0 / v for k, v in prices.items() if v > 0}
        total = sum(raw_probs.values())
        probs = {k: v / total for k, v in raw_probs.items()} if total else {}

    period = "HT" if "HALF" in str(raw.get("MarketPeriod") or "").upper() else "FT"
    return NormOdds(
        txline_fixture_id=int(raw["FixtureId"]),
        market=market,
        line=_parse_line(raw.get("MarketParameters"), market),
        prices=prices,
        probs=probs,
        period=period,
        in_running=bool(raw.get("InRunning")),
        ts=_ms_to_dt(raw["Ts"]),
        raw=raw,
    )


def normalize_score(raw: dict) -> NormMatchState:
    """Score records (per docs: action=game_finalised with statusId=100 and
    period=100 marks the final result). Field access is defensive because we
    have no captured sample; demo mode supplies pre-normalized events."""

    def g(*keys, default=None):
        for k in keys:
            if k in raw and raw[k] is not None:
                return raw[k]
        return default

    status_id = int(g("StatusId", "statusId", default=0))
    action = str(g("Action", "action", default="")).lower()
    period = int(g("Period", "period", default=0))
    if status_id == 100 or action == "game_finalised" or period == 100:
        status = "finished"
    elif period == 2 or status_id > 0:
        status = "live"
    else:
        status = "upcoming"

    ts_ms = g("Ts", "ts", "Timestamp", "timestamp", default=0)
    return NormMatchState(
        txline_fixture_id=int(g("FixtureId", "fixtureId", default=0)),
        status=status,
        score_home=int(g("Score1", "score1", "HomeScore", default=0)),
        score_away=int(g("Score2", "score2", "AwayScore", default=0)),
        minute=int(g("Minute", "minute", "MatchMinute", default=0)),
        ts=_ms_to_dt(ts_ms) if ts_ms else datetime.now(timezone.utc),
        raw=raw,
    )
