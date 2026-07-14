"""Pricing engine unit tests against hand-computed cases (build.md §11.3)."""
import math

import pytest

from app.pricing.engine import (
    devig,
    minutes_remaining_effective,
    p_goal_in_window,
    quote,
    quote_outcomes,
    solve_lambda_remaining,
    split_lambda,
)


def test_devig_normalizes_overround():
    # 1.495 / 3.020: raw probs 0.66890 + 0.33113 = 1.00002 (real sample values)
    probs = devig({"over": 1.495, "under": 3.020})
    assert abs(sum(probs.values()) - 1.0) < 1e-9
    assert abs(probs["over"] - 0.66890) < 1e-4


def test_lambda_solver_recovers_known_lambda():
    # Hand-computed: λ=2.7 → P(Pois(2.7) > 2) = 1 - e^-2.7(1 + 2.7 + 3.645) = 0.50639
    p_over = 1 - math.exp(-2.7) * (1 + 2.7 + 2.7**2 / 2)
    lam = solve_lambda_remaining(line=2.5, p_over=p_over, goals_so_far=0)
    assert abs(lam - 2.7) < 1e-3


def test_lambda_solver_inplay_accounts_for_goals_scored():
    # In-play: 1 goal scored, line 2.5 → over needs >1.5 more goals, i.e. ≥2.
    # λ=1.0 → P(Pois(1) ≥ 2) = 1 - e^-1·(1+1) = 0.26424
    p_over = 1 - math.exp(-1) * 2
    lam = solve_lambda_remaining(line=2.5, p_over=p_over, goals_so_far=1)
    assert abs(lam - 1.0) < 1e-3


def test_lambda_solver_line_already_beaten():
    assert solve_lambda_remaining(line=2.5, p_over=0.99, goals_so_far=3) == pytest.approx(0.01)


def test_split_lambda_mapping_and_clamp():
    # s = 0.2 + 0.6·q with q = ph/(ph+pa): hand case q=0.98/0.99
    lh, la = split_lambda(2.0, {"home": 0.98, "away": 0.01})
    assert lh == pytest.approx(2.0 * (0.2 + 0.6 * (0.98 / 0.99)))
    assert lh + la == pytest.approx(2.0)
    lh, la = split_lambda(2.0, {"home": 1.0, "away": 0.0})
    assert lh == pytest.approx(1.6)  # clamp ceiling s=0.8 at q=1
    lh, la = split_lambda(2.0, {"home": 0.4, "away": 0.4})
    assert lh == pytest.approx(1.0) and la == pytest.approx(1.0)  # even → 50/50


def test_minutes_remaining_effective():
    assert minutes_remaining_effective(30) == 60
    assert minutes_remaining_effective(80) == 14  # 10 left + 4 stoppage
    assert minutes_remaining_effective(90) == 5  # max(0,1)... 1 + 4 stoppage
    assert minutes_remaining_effective(89) == 5


def test_interval_probability_hand_case():
    # λ_rem=1.2, minute 60 → eff=30; next 15 min: 1 - e^(-1.2·15/30) = 1 - e^-0.6
    p = p_goal_in_window(1.2, 15, 60)
    assert abs(p - (1 - math.exp(-0.6))) < 1e-9


def test_interval_window_capped_at_time_left():
    # 20-minute window at minute 85 (eff = 5+4=9): m capped to 9 → 1 - e^-λ
    p = p_goal_in_window(1.0, 20, 85)
    assert abs(p - (1 - math.exp(-1.0))) < 1e-9


def test_quote_margin_floor_cap_rounding():
    # p=0.5 → 1/(0.5·1.05) = 1.9048 → 1.90
    assert quote(0.5) == 1.90
    assert quote(0.99) == 1.05  # floor
    assert quote(0.02) == 15.0  # cap
    assert quote(0.9999) is None  # unquotable
    assert quote_outcomes({"yes": 0.5, "no": 0.9999}) is None
    q = quote_outcomes({"yes": 0.6, "no": 0.4})
    assert q == {"yes": 1.59, "no": 2.38}
