"""Per-fixture demo simulator (build.md §9, generalised).

`DemoSource` replays one hand-authored match from a .jsonl. This runs *any*
fixture on demand: roll a Poisson goal schedule at start, then derive
self-consistent 1X2/OU/AH odds from the remaining goal expectation — the same
construction scripts/gen_demo_match.py uses. The pricing engine therefore
extracts λ from a simulated match exactly as it would from live TxLINE; nothing
downstream (triggers, settlement, receipts, stream) knows the difference.

Simulated matches are separate fixture rows with ids in the DEMO_ID_BASE range,
so a demo can run alongside the real fixture it was cloned from rather than
replacing the whole feed.
"""
from __future__ import annotations

import math
import random
import threading
import time
from datetime import datetime, timedelta, timezone

from .types import NormFixture, NormMatchState, NormOdds

# Demo fixture ids sit above this line; real TxLINE ids are ~1.8e7, and the
# bracket's unresolved-slot placeholders are 999999xx, which stay below it.
DEMO_ID_BASE = 900_000_000

# Wall-clock shape, mirroring DemoSource: 4s per match minute (~6 min for 90').
PRE_S = 20
SEC_PER_MIN = 4
H1_S = 45 * SEC_PER_MIN
HT_S = 12
H2_MIN = 49  # minutes 46..94 (90 + 4 stoppage)
H2_S = H2_MIN * SEC_PER_MIN
FT_AT = PRE_S + H1_S + HT_S + H2_S
LINGER_S = 180  # a finished demo stays visible this long before it's swept


def demo_id_for(real_txline_id: int) -> int:
    """Deterministic: restarting the same fixture reuses its demo row."""
    return DEMO_ID_BASE + real_txline_id % 100_000_000


def is_demo_id(txline_fixture_id: int) -> bool:
    return txline_fixture_id >= DEMO_ID_BASE


# --- Poisson helpers (shared construction with scripts/gen_demo_match.py) ---
def _pois_cdf(k: int, lam: float) -> float:
    return sum(math.exp(-lam) * lam**i / math.factorial(i) for i in range(k + 1))


def _p_over(line: float, lam_rem: float, goals_so_far: int) -> float:
    need = math.floor(line) - goals_so_far
    if need < 0:
        return 1.0
    return 1 - _pois_cdf(need, lam_rem)


def _win_probs(lam_h: float, lam_a: float, lead_h: int) -> tuple[float, float, float]:
    ph = pd = pa = 0.0
    for h in range(11):
        for a in range(11):
            p = (math.exp(-lam_h) * lam_h**h / math.factorial(h)) * (
                math.exp(-lam_a) * lam_a**a / math.factorial(a)
            )
            diff = lead_h + h - a
            if diff > 0:
                ph += p
            elif diff == 0:
                pd += p
            else:
                pa += p
    return ph, pd, pa


def _to_odds(p: float) -> float:
    return round(max(1.01, min(50.0, 1 / max(p, 0.02))), 3)


def _pois_draw(rng: random.Random, lam: float) -> int:
    """Knuth's algorithm — λ here is small (~1.5), so the loop is cheap."""
    limit, k, p = math.exp(-lam), 0, 1.0
    while True:
        p *= rng.random()
        if p <= limit:
            return k
        k += 1


class MatchSim:
    """One simulated match on a compressed clock."""

    def __init__(
        self,
        *,
        demo_id: int,
        home: str,
        away: str,
        lam: float | None = None,
        home_share: float | None = None,
        seed: int | None = None,
    ) -> None:
        rng = random.Random(seed)
        self.demo_id = demo_id
        self.home = home
        self.away = away
        # Randomised per run so two demos of the same fixture don't play out
        # identically; the engine re-derives λ from the odds either way.
        self.lam = lam if lam is not None else rng.uniform(2.2, 3.2)
        self.home_share = home_share if home_share is not None else rng.uniform(0.45, 0.62)
        self.started = time.monotonic()
        self.kickoff_at = datetime.now(timezone.utc) + timedelta(seconds=PRE_S)
        self.goals = self._roll_goals(rng)

    def _roll_goals(self, rng: random.Random) -> list[tuple[int, str]]:
        goals: list[tuple[int, str]] = []
        for team, lam_team in (
            ("home", self.lam * self.home_share),
            ("away", self.lam * (1 - self.home_share)),
        ):
            for _ in range(_pois_draw(rng, lam_team)):
                goals.append((rng.randint(1, 90), team))
        return sorted(goals)

    # --- clock ---
    @property
    def elapsed(self) -> float:
        return time.monotonic() - self.started

    def status(self) -> str:
        e = self.elapsed
        if e < PRE_S:
            return "upcoming"
        if e < PRE_S + H1_S:
            return "live"
        if e < PRE_S + H1_S + HT_S:
            return "ht"
        if e < FT_AT:
            return "live"
        return "finished"

    def minute(self) -> int:
        e = self.elapsed
        if e < PRE_S:
            return 0
        if e < PRE_S + H1_S:
            return int((e - PRE_S) / SEC_PER_MIN)
        if e < PRE_S + H1_S + HT_S:
            return 45
        if e < FT_AT:
            return 46 + int((e - PRE_S - H1_S - HT_S) / SEC_PER_MIN)
        return 94

    def score(self, minute: int | None = None) -> tuple[int, int]:
        m = self.minute() if minute is None else minute
        h = sum(1 for gm, t in self.goals if t == "home" and gm <= m)
        a = sum(1 for gm, t in self.goals if t == "away" and gm <= m)
        return h, a

    def expired(self) -> bool:
        return self.elapsed > FT_AT + LINGER_S

    # --- DataSource surface ---
    def fixture(self, competition_id: int) -> NormFixture:
        return NormFixture(
            txline_fixture_id=self.demo_id,
            home=self.home,
            away=self.away,
            kickoff_at=self.kickoff_at,
            competition_id=competition_id,
            raw={"demo": True},
        )

    def match_state(self) -> NormMatchState:
        m = self.minute()
        h, a = self.score(m)
        return NormMatchState(
            txline_fixture_id=self.demo_id,
            status=self.status(),
            score_home=h,
            score_away=a,
            minute=m,
            ts=datetime.now(timezone.utc),
            raw={"demo": True},
        )

    def odds(self, in_play: bool) -> list[NormOdds]:
        now = datetime.now(timezone.utc)
        m = self.minute()
        h, a = self.score(m)
        total = h + a
        lam_rem = max(self.lam * (max(90 - m, 0) / 90), 0.02)

        out: list[NormOdds] = []
        line = math.floor(total + lam_rem) + 0.5
        po = _p_over(line, lam_rem, total)
        out.append(self._norm("OU", line, {"over": po, "under": 1 - po}, now, in_play))

        lam_h, lam_a = lam_rem * self.home_share, lam_rem * (1 - self.home_share)
        ph, pd, pa = _win_probs(lam_h, lam_a, h - a)
        out.append(self._norm("1X2", None, {"home": ph, "draw": pd, "away": pa}, now, in_play))

        # PM3 needs an Asian handicap pre-match: -0.5 on the favourite, where
        # covering is exactly winning.
        if not in_play:
            if ph >= pa:
                ah = {"home": ph, "away": pd + pa}
            else:
                ah = {"home": ph + pd, "away": pa}
            out.append(self._norm("AH", -0.5, ah, now, in_play))
        return out

    def _norm(
        self, market: str, line: float | None, probs: dict[str, float], ts: datetime, in_play: bool
    ) -> NormOdds:
        # The feed is de-margined; the pricing engine adds its own margin.
        return NormOdds(
            txline_fixture_id=self.demo_id,
            market=market,
            line=line,
            prices={k: _to_odds(v) for k, v in probs.items()},
            probs=dict(probs),
            period="FT",
            in_running=in_play,
            ts=ts,
            raw={"demo": True},
        )


class SimRegistry:
    """Running simulations, keyed by demo fixture id.

    The Brain ticks on its own thread while the API starts/stops sims from
    request threads, so every mutation takes the lock.
    """

    def __init__(self) -> None:
        self._sims: dict[int, MatchSim] = {}
        self._lock = threading.Lock()

    def start(self, *, real_txline_id: int, home: str, away: str) -> MatchSim:
        demo_id = demo_id_for(real_txline_id)
        sim = MatchSim(demo_id=demo_id, home=home, away=away)
        with self._lock:
            self._sims[demo_id] = sim  # restart replaces any previous run
        return sim

    def stop(self, demo_id: int) -> bool:
        with self._lock:
            return self._sims.pop(demo_id, None) is not None

    def get(self, demo_id: int) -> MatchSim | None:
        with self._lock:
            return self._sims.get(demo_id)

    def active(self) -> list[MatchSim]:
        with self._lock:
            return list(self._sims.values())

    def sweep(self) -> list[int]:
        """Drop long-finished sims so they stop being re-seeded."""
        with self._lock:
            dead = [k for k, v in self._sims.items() if v.expired()]
            for k in dead:
                self._sims.pop(k, None)
        return dead
