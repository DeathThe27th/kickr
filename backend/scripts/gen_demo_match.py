"""Author backend/fixtures/demo_match.jsonl (build.md §9): a scripted demo
match — 0-0 -> 1-0 home (68') -> 1-1 (84') — with self-consistent odds paths
derived from a Poisson model, so the pricing engine extracts a sensible λ
exactly as it would from live TxLINE data.

Line format:
  {"minute": -1, "type": "odds", "market": "1X2", "line": null, "prices": {...}}
  {"minute": 12, "type": "odds", "market": "OU", "line": 2.5, "prices": {...}}
  {"minute": 68, "type": "goal", "team": "home"}
"""
from __future__ import annotations

import json
import math
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "fixtures" / "demo_match.jsonl"

LAMBDA_MATCH = 2.7
HOME_SHARE = 0.55
GOALS = [(68, "home"), (84, "away")]
MARGIN = 0.0  # feed is de-margined; the pricing engine adds its own margin


def pois_cdf(k: int, lam: float) -> float:
    return sum(math.exp(-lam) * lam**i / math.factorial(i) for i in range(k + 1))


def p_over(line: float, lam_rem: float, goals_so_far: int) -> float:
    """P(total goals > line) with `line` ending in .5"""
    need = math.floor(line) - goals_so_far  # more than `line` => at least floor(line)+1 - goals
    if need < 0:
        return 1.0
    return 1 - pois_cdf(need, lam_rem)


def win_probs(lam_h: float, lam_a: float, lead_h: int) -> tuple[float, float, float]:
    """P(home win / draw / away win) from independent Poisson remaining goals."""
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


def to_odds(p: float) -> float:
    return round(max(1.01, min(50.0, 1 / max(p, 0.02))), 3)


def goals_at(minute: int) -> tuple[int, int]:
    h = sum(1 for m, t in GOALS if t == "home" and m <= minute)
    a = sum(1 for m, t in GOALS if t == "away" and m <= minute)
    return h, a


def main() -> None:
    lines: list[dict] = []

    def emit(minute: int, market: str, line: float | None, prices: dict) -> None:
        lines.append({"minute": minute, "type": "odds", "market": market, "line": line, "prices": prices})

    def snapshot(minute: int) -> None:
        h, a = goals_at(minute)
        total = h + a
        frac_left = max(90 - minute, 0) / 90
        lam_rem = LAMBDA_MATCH * frac_left
        # main OU line: nearest x.5 around current total + remaining expectation
        line = math.floor(total + lam_rem) + 0.5
        po = p_over(line, lam_rem, total)
        emit(minute, "OU", line, {"over": to_odds(po), "under": to_odds(1 - po)})
        lam_h, lam_a = lam_rem * HOME_SHARE, lam_rem * (1 - HOME_SHARE)
        ph, pd, pa = win_probs(lam_h, lam_a, h - a)
        emit(minute, "1X2", None, {"home": to_odds(ph), "draw": to_odds(pd), "away": to_odds(pa)})

    # Pre-match (minute -1): 1X2, OU and the AH needed by template PM3
    snapshot_minute = -1
    h_pre, d_pre, a_pre = win_probs(LAMBDA_MATCH * HOME_SHARE, LAMBDA_MATCH * (1 - HOME_SHARE), 0)
    po_pre = p_over(2.5, LAMBDA_MATCH, 0)
    emit(-1, "1X2", None, {"home": to_odds(h_pre), "draw": to_odds(d_pre), "away": to_odds(a_pre)})
    emit(-1, "OU", 2.5, {"over": to_odds(po_pre), "under": to_odds(1 - po_pre)})
    # AH -0.5 for the favourite (home): cover = home win
    emit(-1, "AH", -0.5, {"home": to_odds(h_pre), "away": to_odds(d_pre + a_pre)})

    # In-play snapshots every 2 match minutes, plus immediately after each goal
    minutes = sorted({*range(0, 91, 2), *(m for m, _ in GOALS), *(m + 1 for m, _ in GOALS)})
    for m in minutes:
        for gm, team in GOALS:
            if gm == m:
                lines.append({"minute": m, "type": "goal", "team": team})
        snapshot(m)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(json.dumps(line) for line in lines) + "\n")
    print(f"Wrote {len(lines)} events to {OUT}")


if __name__ == "__main__":
    main()
