"""Internal normalized types (build.md §2). Everything downstream (pricing,
markets, API) consumes only these — never raw TxLINE payloads."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class NormFixture:
    txline_fixture_id: int
    home: str
    away: str
    kickoff_at: datetime
    competition_id: int
    raw: dict = field(default_factory=dict)


@dataclass
class NormOdds:
    """One odds snapshot record for one market type."""

    txline_fixture_id: int
    market: str  # "1X2" | "OU" | "AH"
    line: float | None  # OU/AH line in goals; None for 1X2
    prices: dict[str, float]  # canonical outcome -> decimal odds
    probs: dict[str, float]  # de-vigged probabilities (from feed Pct or computed)
    period: str  # "FT" | "HT"
    in_running: bool
    ts: datetime
    raw: dict = field(default_factory=dict)


@dataclass
class NormMatchState:
    txline_fixture_id: int
    status: str  # upcoming | live | ht | finished
    score_home: int
    score_away: int
    minute: int
    ts: datetime
    raw: dict = field(default_factory=dict)
