"""Demo / replay mode (build.md §9).

Replays backend/fixtures/demo_match.jsonl — a scripted sequence of odds
snapshots and score events over a compressed clock (~6.5 wall minutes for the
90). The demo fixture is the real 2026 semifinal France vs Spain (TxLINE id
18237038) overlaid with the scripted 0-0 -> 1-0 (68') -> 1-1 (84') match.

Wall-clock cycle:
    30s pre-match -> 180s first half (4s per match minute) -> 12s half-time
    -> 196s second half incl. +4 stoppage -> 45s cooldown -> auto restart.

All engines (pricing, triggers, settlement, receipts, stream) run identically
against this source; POST /api/admin/demo/restart calls restart().
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ..config import settings
from .types import NormFixture, NormMatchState, NormOdds

PRE_S = 30
H1_S = 45 * 4
HT_S = 12
H2_MIN = 49  # minutes 46..94 (90 + 4 stoppage)
H2_S = H2_MIN * 4
FT_AT = PRE_S + H1_S + HT_S + H2_S
COOLDOWN_S = 45
CYCLE_S = FT_AT + COOLDOWN_S

DEMO_FIXTURE_ID = 18237038  # France vs Spain, 2026 WC semifinal


class DemoSource:
    def __init__(self) -> None:
        base = Path(__file__).resolve().parents[2]
        self._events = [json.loads(line) for line in (base / settings.demo_file).read_text().splitlines() if line.strip()]
        self._bracket = json.loads((base / "fixtures" / "bracket_2026.json").read_text())
        self.epoch = time.monotonic()
        self.cycle = 0

    def restart(self) -> None:
        self.epoch = time.monotonic()
        self.cycle += 1

    # --- clock ---
    def _offset(self) -> float:
        t = time.monotonic() - self.epoch
        if t >= CYCLE_S:  # auto-restart so the demo runs at any hour
            self.restart()
            t = 0.0
        return t

    def _clock(self) -> tuple[str, int]:
        """-> (status, match_minute)"""
        t = self._offset() - PRE_S
        if t < 0:
            return "upcoming", 0
        if t < H1_S:
            return "live", int(t // 4)
        if t < H1_S + HT_S:
            return "ht", 45
        t2 = t - H1_S - HT_S
        if t2 < H2_S:
            return "live", min(46 + int(t2 // 4), 94)
        return "finished", 94

    # --- DataSource ---
    def list_fixtures(self) -> list[NormFixture]:
        now = datetime.now(timezone.utc)
        status, _ = self._clock()
        kickoff_wall = now + timedelta(seconds=PRE_S - self._offset())
        fixtures = []
        for fx in self._bracket["fixtures"]:
            if fx["txline_fixture_id"] == DEMO_FIXTURE_ID:
                kickoff = kickoff_wall  # demo fixture kicks off inside the cycle
            else:
                kickoff = datetime.fromisoformat(fx["kickoff_at"])
            fixtures.append(
                NormFixture(
                    txline_fixture_id=fx["txline_fixture_id"],
                    home=fx["home"],
                    away=fx["away"],
                    kickoff_at=kickoff,
                    competition_id=settings.txline_competition_id,
                    raw=fx,
                )
            )
        return fixtures

    def _goals_until(self, minute: int, status: str) -> tuple[int, int]:
        home = away = 0
        if status == "upcoming":
            return 0, 0
        for ev in self._events:
            if ev["type"] == "goal" and ev["minute"] <= minute:
                if ev["team"] == "home":
                    home += 1
                else:
                    away += 1
        return home, away

    def match_state(self, txline_fixture_id: int) -> NormMatchState | None:
        if txline_fixture_id != DEMO_FIXTURE_ID:
            return None
        status, minute = self._clock()
        home, away = self._goals_until(minute, status)
        return NormMatchState(
            txline_fixture_id=DEMO_FIXTURE_ID,
            status=status,
            score_home=home,
            score_away=away,
            minute=min(minute, 90),
            ts=datetime.now(timezone.utc),
            raw={"demo_cycle": self.cycle},
        )

    def odds_snapshot(self, txline_fixture_id: int, in_play: bool) -> list[NormOdds]:
        if txline_fixture_id != DEMO_FIXTURE_ID:
            return []
        status, minute = self._clock()
        if status == "finished":
            return []
        # latest scripted record per market type at the current match minute;
        # pre-match records are scripted at minute -1
        cutoff = -1 if status == "upcoming" else minute
        latest: dict[str, dict] = {}
        for ev in self._events:
            if ev["type"] == "odds" and ev["minute"] <= cutoff:
                latest[ev["market"]] = ev
        now = datetime.now(timezone.utc)
        result = []
        for market, ev in latest.items():
            prices = {k: float(v) for k, v in ev["prices"].items()}
            raw_probs = {k: 1 / v for k, v in prices.items() if v > 0}
            total = sum(raw_probs.values())
            result.append(
                NormOdds(
                    txline_fixture_id=DEMO_FIXTURE_ID,
                    market=market,
                    line=ev.get("line"),
                    prices=prices,
                    probs={k: v / total for k, v in raw_probs.items()},
                    period="FT",
                    in_running=status != "upcoming",
                    ts=now,  # replay emits fresh snapshots — staleness rule stays green
                    raw=ev,
                )
            )
        return result
