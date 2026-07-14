"""Pricing engine (build.md §3). All prices derive from TxLINE snapshots —
no proprietary model as source of truth.

λ split function (§3.2, documented): from the de-vigged 1X2 we take the
win-prob skew q = p_home / (p_home + p_away) (draw mass excluded) and map it
linearly onto the home share s = 0.2 + 0.6·q, clamped to [0.2, 0.8]. A team
that is an overwhelming favourite (q→1) is expected to score 80% of the
remaining goals; an even matchup (q=0.5) splits λ evenly.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from ..config import settings


def devig(prices: dict[str, float]) -> dict[str, float]:
    """§3.1: p_raw = 1/odds, normalized to sum 1."""
    raw = {k: 1.0 / v for k, v in prices.items() if v > 0}
    total = sum(raw.values())
    if total <= 0:
        return {}
    return {k: v / total for k, v in raw.items()}


def _pois_sf(k: int, lam: float) -> float:
    """P(Poisson(lam) > k)"""
    if k < 0:
        return 1.0
    cdf = 0.0
    term = math.exp(-lam)
    for i in range(k + 1):
        if i > 0:
            term *= lam / i
        cdf += term
    return max(0.0, 1.0 - cdf)


def solve_lambda_remaining(line: float, p_over: float, goals_so_far: int) -> float:
    """§3.2: bisection over λ ∈ [0.01, 8] for
    P(Poisson(λ_rem) > line - goals_so_far) = p_over."""
    k = math.floor(line - goals_so_far)  # over hits when remaining goals > k
    if k < 0:
        return 0.01  # line already beaten; no information about remaining rate
    p_over = min(max(p_over, 0.001), 0.999)
    lo, hi = 0.01, 8.0
    for _ in range(60):
        mid = (lo + hi) / 2
        if _pois_sf(k, mid) < p_over:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def split_lambda(lam_rem: float, probs_1x2: dict[str, float]) -> tuple[float, float]:
    """§3.2 skew mapping, clamped s ∈ [0.2, 0.8] (see module docstring)."""
    ph, pa = probs_1x2.get("home", 0.5), probs_1x2.get("away", 0.5)
    q = ph / (ph + pa) if (ph + pa) > 0 else 0.5
    s = min(0.8, max(0.2, 0.2 + 0.6 * q))
    return lam_rem * s, lam_rem * (1 - s)


def minutes_remaining_effective(minute: int) -> float:
    """§3.3: max(90 - minute, 1), plus flat +4 stoppage after minute 80."""
    base = max(90 - minute, 1)
    if minute >= 80:
        base += settings.stoppage_allowance_min
    return float(base)


def p_goal_in_window(lam_rem: float, window_min: float, minute: int) -> float:
    """§3.3: P(≥1 goal in the next m minutes) = 1 - exp(-λ_rem · m / mins_eff)."""
    eff = minutes_remaining_effective(minute)
    m = min(window_min, eff)
    return 1.0 - math.exp(-lam_rem * m / eff)


def quote(p_fair: float) -> float | None:
    """§3.4: odds = 1/(p·(1+MARGIN)), floored 1.05, capped 15.0, 2dp.
    Returns None when the fair probability is too extreme to quote."""
    if p_fair <= 0.001 or p_fair >= 0.999:
        return None
    odds = 1.0 / (p_fair * (1 + settings.margin))
    return round(min(max(odds, settings.odds_floor), settings.odds_cap), 2)


def quote_outcomes(fair: dict[str, float]) -> dict[str, float] | None:
    """Quote a whole market; returns None if any leg is unquotable."""
    out = {}
    for k, p in fair.items():
        q = quote(p)
        if q is None:
            return None
        out[k] = q
    return out


@dataclass
class PricedState:
    """Everything the market engine needs from one pricing tick."""

    lam_rem: float
    lam_home: float
    lam_away: float
    probs_1x2: dict[str, float]
    ou_line: float | None
    p_over: float | None
    probs_ah: dict[str, float] | None
    ah_line: float | None
    fresh: bool  # §3.5 staleness


def price_fixture(
    odds: list,  # list[NormOdds]
    goals_so_far: int,
    minute: int,
    newest_age_seconds: float,
    in_play: bool,
) -> PricedState | None:
    """Derive the full priced state from the latest normalized snapshots."""
    latest: dict[str, object] = {}
    for o in odds:
        if o.period != "FT":
            continue
        prev = latest.get(o.market)
        if prev is None or o.ts >= prev.ts:  # type: ignore[union-attr]
            latest[o.market] = o

    ou = latest.get("OU")
    x12 = latest.get("1X2")
    ah = latest.get("AH")
    if ou is None or ou.line is None:  # λ extraction needs a totals market
        return None

    probs_ou = ou.probs or devig(ou.prices)
    p_over = probs_ou.get("over")
    if p_over is None:
        return None
    lam_rem = solve_lambda_remaining(ou.line, p_over, goals_so_far)

    probs_1x2 = (x12.probs or devig(x12.prices)) if x12 else {"home": 0.5, "away": 0.5}
    lam_home, lam_away = split_lambda(lam_rem, probs_1x2)

    fresh = (not in_play) or newest_age_seconds <= settings.staleness_seconds
    return PricedState(
        lam_rem=lam_rem,
        lam_home=lam_home,
        lam_away=lam_away,
        probs_1x2=probs_1x2,
        ou_line=ou.line,
        p_over=p_over,
        probs_ah=(ah.probs or devig(ah.prices)) if ah else None,
        ah_line=ah.line if ah else None,
        fresh=fresh,
    )
