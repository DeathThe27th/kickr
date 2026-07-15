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
            # Lines are literal on the live feed, integers included. The OU
            # ladder proves it: line=2 prices P(over)=0.489, sitting exactly
            # between line=1.75 (0.571) and line=2.25 (0.408). Halving it to
            # 1.0 would hand the lambda solver the wrong line.
            try:
                return float(part[len("line=") :])
            except ValueError:
                return None
    return None


def _parse_pcts(values: object) -> list[float] | None:
    """The feed sends Pct="NA" per-leg once a fixture is in-running and it has no
    de-vigged view to publish. One unusable leg makes the whole record's Pct
    unusable (a partial prob dict would silently misprice), so return None and
    let the caller de-vig the prices itself."""
    if not isinstance(values, list) or not values:
        return None
    out: list[float] = []
    for v in values:
        try:
            out.append(float(v) / 100.0)
        except (TypeError, ValueError):
            return None
    return out


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
    pcts = _parse_pcts(raw.get("Pct"))
    prices: dict[str, float] = {}
    probs: dict[str, float] = {}

    for i, name in enumerate(names):
        canonical = _NAME_MAP.get((market, name), name)
        if canonical in ("p1", "p2"):
            is_p1 = canonical == "p1"
            canonical = ("home" if is_p1 else "away") if participant1_is_home else ("away" if is_p1 else "home")
        if i < len(price_ints):
            prices[canonical] = price_ints[i] / 1000.0
        if pcts is not None and i < len(pcts):
            probs[canonical] = pcts[i]

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


def _participant_goals(record: dict, participant_key: str) -> int:
    """Score is a per-participant stat container, not a scalar:
        {"Participant1": {"H1": {...}, "HT": {...}, "Total": {"Goals": 1}}}
    Absent keys mean the stat has not happened yet, which reads as zero."""
    score = record.get("Score")
    if not isinstance(score, dict):
        return 0
    side = score.get(participant_key)
    if not isinstance(side, dict):
        return 0
    total = side.get("Total")
    if not isinstance(total, dict):
        return 0
    try:
        return int(total.get("Goals") or 0)
    except (TypeError, ValueError):
        return 0


def normalize_score(
    raw: dict, participant1_is_home: bool = True, records: list[dict] | None = None
) -> NormMatchState:
    """`raw` is the newest record in the snapshot; `records` is the whole
    snapshot when available.

    Observed on the live mainnet feed: a scores snapshot is one record *per
    action type* (weather, corner, kickoff, status, possession...), not a time
    series, and only the record that carries a stat carries the Score for it.
    So status and clock come from the newest record, while goals are taken as
    the maximum seen across the snapshot.

    StatusId observed live: 1 on `standby` before kickoff, 2 once the clock is
    running. `GameState` reads "scheduled" even in-play, so it is ignored.
    """

    def g(*keys, default=None):
        for k in keys:
            if k in raw and raw[k] is not None:
                return raw[k]
        return default

    status_id = int(g("StatusId", "statusId", default=0))
    action = str(g("Action", "action", default="")).lower()
    if status_id >= 100 or action == "game_finalised":
        status = "finished"
    elif status_id >= 2:
        status = "live"
    else:
        status = "upcoming"

    clock = g("Clock", "clock", default={}) or {}
    seconds = 0
    try:
        seconds = int(clock.get("Seconds") or 0)
    except (TypeError, ValueError, AttributeError):
        seconds = 0

    pool = records or [raw]
    g1 = max((_participant_goals(r, "Participant1") for r in pool), default=0)
    g2 = max((_participant_goals(r, "Participant2") for r in pool), default=0)
    score_home, score_away = (g1, g2) if participant1_is_home else (g2, g1)

    ts_ms = g("Ts", "ts", "Timestamp", "timestamp", default=0)
    return NormMatchState(
        txline_fixture_id=int(g("FixtureId", "fixtureId", default=0)),
        status=status,
        score_home=score_home,
        score_away=score_away,
        minute=seconds // 60,
        ts=_ms_to_dt(ts_ms) if ts_ms else datetime.now(timezone.utc),
        raw=raw,
    )
