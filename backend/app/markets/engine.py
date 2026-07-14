"""Deterministic market template + trigger engine (build.md §4).
No LLM anywhere in the market path.

The engine is driven by tick(): given the latest MatchState and PricedState
for one fixture it opens/locks/suspends/settles markets and returns the SSE
events to publish. All writes happen in the caller's session transaction.
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..ledger import settle_market
from ..models import Fixture, Market, NotificationOutbox
from ..pricing.engine import PricedState, p_goal_in_window, quote, quote_outcomes
from ..txline.types import NormMatchState

log = logging.getLogger("kickr.markets")


@dataclass
class TickEvents:
    events: list[dict] = field(default_factory=list)

    def add(self, kind: str, **payload) -> None:
        self.events.append({"event": kind, **payload})


class MarketEngine:
    def __init__(self) -> None:
        # per-fixture in-memory state (rebuilt harmlessly on restart)
        self._ht_score: dict[str, tuple[int, int]] = {}
        self._last_1x2: dict[str, dict[str, float]] = {}
        self._equalized_since_open: dict[str, bool] = {}

    # ------------------------------------------------------------------ tick
    def tick(
        self,
        session: Session,
        fixture: Fixture,
        state: NormMatchState | None,
        priced: PricedState | None,
        cycle: int,
    ) -> list[dict]:
        ev = TickEvents()
        # A demo restart (or any new cycle) abandons the previous cycle's match:
        # void its still-active markets and refund stakes (§4), so stale markets
        # never linger in the API or stay bettable.
        if cycle > 0:
            self._void_stale_cycles(session, fixture, cycle, ev)
        prev_score = (fixture.score_home, fixture.score_away)
        prev_status = fixture.status

        if state is not None:
            fixture.minute = state.minute
            fixture.score_home = state.score_home
            fixture.score_away = state.score_away
            fixture.status = {"upcoming": "upcoming", "live": "live", "ht": "live", "finished": "finished"}[
                state.status
            ]
            if state.status in ("ht",) and fixture.id not in self._ht_score:
                self._ht_score[fixture.id] = (state.score_home, state.score_away)
            # real feed may never report an explicit HT — capture first h2 observation
            if state.minute >= 46 and fixture.id not in self._ht_score:
                self._ht_score[fixture.id] = (state.score_home, state.score_away)
            if (state.score_home, state.score_away) != prev_score or prev_status != fixture.status:
                ev.add(
                    "score_update",
                    fixture_id=fixture.id,
                    txline_fixture_id=fixture.txline_fixture_id,
                    score=[state.score_home, state.score_away],
                    minute=state.minute,
                    status=fixture.status,
                )

        markets = (
            session.execute(
                select(Market).where(
                    Market.fixture_id == fixture.id,
                    Market.status.in_(["open", "suspended", "locked"]),
                    Market.cycle == cycle,
                )
            )
            .scalars()
            .all()
        )

        # §3.5 staleness: suspend/unsuspend all open markets
        if priced is not None and fixture.status == "live":
            self._apply_staleness(markets, priced.fresh, ev)
        goal_scored = state is not None and (state.score_home, state.score_away) != prev_score

        # goal instantly locks+settles the goal-window markets it decides (§4)
        if goal_scored:
            self._on_goal(session, fixture, markets, ev)

        # track "score became level" for M7
        if state is not None and state.score_home == state.score_away:
            self._equalized_since_open[fixture.id] = True

        # lock/settle by clock
        self._lock_and_settle_by_clock(session, fixture, markets, ev)

        if fixture.status == "finished" and prev_status != "finished":
            self._settle_full_time(session, fixture, cycle, ev)

        # open new markets from the trigger table (runs again after a goal, §4)
        if priced is not None and priced.fresh:
            if fixture.status == "upcoming":
                self._open_prematch(session, fixture, priced, cycle, ev)
            elif fixture.status == "live" and state is not None:
                self._run_triggers(session, fixture, state, priced, cycle, ev, goal_scored)
            # refresh quoted prices on every pricing tick until lock (§4)
            self._reprice_open(session, fixture, priced, cycle, ev)

        if priced is not None:
            self._last_1x2[fixture.id] = dict(priced.probs_1x2)
        return ev.events

    # ---------------------------------------------------------------- helpers
    def _apply_staleness(self, markets: list[Market], fresh: bool, ev: TickEvents) -> None:
        for m in markets:
            if not fresh and m.status == "open":
                m.status = "suspended"
                ev.add("market_locked", market_id=m.id, status="suspended")
            elif fresh and m.status == "suspended":
                m.status = "open"
                ev.add("market_open", market_id=m.id, reopened=True)

    def _open_market(
        self,
        session: Session,
        fixture: Fixture,
        cycle: int,
        template_id: str,
        question: str,
        outcomes: list[str],
        prices: dict[str, float] | None,
        settle_rule: dict,
        locks_at_minute: int | None,
        ev: TickEvents,
    ) -> Market | None:
        if prices is None:
            return None
        exists = session.execute(
            select(Market.id).where(
                Market.fixture_id == fixture.id,
                Market.template_id == template_id,
                Market.question == question,
                Market.cycle == cycle,
            )
        ).first()
        if exists:
            return None
        if template_id.startswith("M"):
            open_micro = session.execute(
                select(Market.id).where(
                    Market.fixture_id == fixture.id,
                    Market.status == "open",
                    Market.template_id.like("M%"),
                    Market.cycle == cycle,
                )
            ).all()
            if len(open_micro) >= settings.max_micro_markets_open:
                return None
        rule = dict(settle_rule)
        if locks_at_minute is not None:
            rule["locks_at_minute"] = locks_at_minute
        market = Market(
            template_id=template_id,
            fixture_id=fixture.id,
            question=question,
            outcomes=outcomes,
            prices=prices,
            settle_rule=rule,
            cycle=cycle,
            status="open",
        )
        session.add(market)
        session.flush()
        session.add(
            NotificationOutbox(event_type="market_open", payload={"market_id": market.id, "fixture_id": fixture.id})
        )
        ev.add(
            "market_open",
            market_id=market.id,
            fixture_id=fixture.id,
            template_id=template_id,
            question=question,
            outcomes=outcomes,
            prices=prices,
        )
        ev.add("receipt", market_id=market.id, phase="open")
        log.info("OPEN %s %s: %s %s", template_id, fixture.home, question, prices)
        return market

    # ------------------------------------------------------------- pre-match
    def _open_prematch(
        self, session: Session, fixture: Fixture, priced: PricedState, cycle: int, ev: TickEvents
    ) -> None:
        """PM1-PM4 open when a fixture appears with odds; lock at kickoff (§4)."""
        p = priced
        # PM1 — match result from de-vigged 1X2
        if {"home", "draw", "away"} <= set(p.probs_1x2):
            self._open_market(
                session, fixture, cycle, "PM1", "Match result",
                ["Home", "Draw", "Away"],
                quote_outcomes({"Home": p.probs_1x2["home"], "Draw": p.probs_1x2["draw"], "Away": p.probs_1x2["away"]}),
                {"type": "1x2"}, None, ev,
            )
        # PM2 — main total line
        if p.ou_line is not None and p.p_over is not None:
            self._open_market(
                session, fixture, cycle, "PM2", f"Over/Under {p.ou_line} goals",
                ["Over", "Under"],
                quote_outcomes({"Over": p.p_over, "Under": 1 - p.p_over}),
                {"type": "ou", "line": p.ou_line}, None, ev,
            )
        # PM3 — favourite covers the AH line
        if p.probs_ah and p.ah_line is not None:
            fav = "home" if p.probs_1x2.get("home", 0) >= p.probs_1x2.get("away", 0) else "away"
            fav_name = fixture.home if fav == "home" else fixture.away
            p_cover = p.probs_ah.get(fav)
            if p_cover:
                self._open_market(
                    session, fixture, cycle, "PM3", f"{fav_name} covers {p.ah_line}",
                    ["Yes", "No"],
                    quote_outcomes({"Yes": p_cover, "No": 1 - p_cover}),
                    {"type": "ah", "line": p.ah_line, "favorite": fav}, None, ev,
                )
        # PM4 — both halves see a goal, λ split 0.45/0.55 (§4)
        p_both = (1 - math.exp(-0.45 * p.lam_rem)) * (1 - math.exp(-0.55 * p.lam_rem))
        self._open_market(
            session, fixture, cycle, "PM4", "Both halves see a goal",
            ["Yes", "No"],
            quote_outcomes({"Yes": p_both, "No": 1 - p_both}),
            {"type": "both_halves_goal"}, None, ev,
        )

    # ---------------------------------------------------------------- in-play
    def _run_triggers(
        self,
        session: Session,
        fixture: Fixture,
        state: NormMatchState,
        priced: PricedState,
        cycle: int,
        ev: TickEvents,
        goal_scored: bool = False,
    ) -> None:
        minute, score_h, score_a = state.minute, state.score_home, state.score_away
        total = score_h + score_a
        level = score_h == score_a
        knockout = fixture.stage != "group"

        # M1 | kickoff | Goal before 25:00?
        if minute < 25:
            p_yes = p_goal_in_window(priced.lam_rem, 25 - minute, minute)
            self._open_market(
                session, fixture, cycle, "M1", "Goal before 25:00?", ["Yes", "No"],
                quote_outcomes({"Yes": p_yes, "No": 1 - p_yes}),
                {"type": "goal_before", "minute": 25, "base_total": 0}, 25, ev,
            )

        # M2 | any goal scored | Another goal before {minute+20}? — fires only
        # on the tick where the goal happened (§4: trigger table runs again on
        # the new state after a goal).
        if goal_scored and total > 0 and minute < 88:
            end = min(minute + 20, 90)
            p_yes = p_goal_in_window(priced.lam_rem, end - minute, minute)
            self._open_market(
                session, fixture, cycle, "M2", f"Another goal before {end}:00?", ["Yes", "No"],
                quote_outcomes({"Yes": p_yes, "No": 1 - p_yes}),
                {"type": "goal_before", "minute": end, "base_total": total}, end, ev,
            )

        # M3 | HT | More goals in 2nd half than 1st?
        ht = self._ht_score.get(fixture.id)
        if ht is not None and 45 <= minute < 85:
            h1_goals = ht[0] + ht[1]
            h2_so_far = total - h1_goals
            # P(N2 > h1) with N2 = h2_so_far + Pois(λ_rem)
            need = h1_goals - h2_so_far  # strictly more
            p_yes = 1.0 if need < 0 else 1 - _pois_cdf(need, priced.lam_rem)
            self._open_market(
                session, fixture, cycle, "M3", "More goals in 2nd half than 1st?", ["Yes", "No"],
                quote_outcomes({"Yes": p_yes, "No": 1 - p_yes}),
                {"type": "h2_vs_h1", "h1_goals": h1_goals}, 85, ev,
            )

        # M4 | min 55, any score | Goal in the next 15:00?
        if 55 <= minute < 70:
            end = min(minute + 15, 90)
            exists_window = session.execute(
                select(Market.id).where(
                    Market.fixture_id == fixture.id, Market.template_id == "M4", Market.cycle == cycle
                )
            ).first()
            if not exists_window:
                p_yes = p_goal_in_window(priced.lam_rem, 15, minute)
                self._open_market(
                    session, fixture, cycle, "M4", f"Goal before {end}:00?", ["Yes", "No"],
                    quote_outcomes({"Yes": p_yes, "No": 1 - p_yes}),
                    {"type": "goal_before", "minute": end, "base_total": total}, end, ev,
                )

        # M5 | min 70, score level, knockout | Winner decided in regulation?
        if knockout and level and 70 <= minute < 88:
            p_decided = 1 - priced.probs_1x2.get("draw", 0.5)
            self._open_market(
                session, fixture, cycle, "M5", "Winner decided in regulation?", ["Yes", "No"],
                quote_outcomes({"Yes": p_decided, "No": 1 - p_decided}),
                {"type": "winner_in_regulation"}, 90, ev,
            )

        # M6 | min 70, 0-0 | Does this finish 0-0?
        if total == 0 and 70 <= minute < 86:
            p_00 = math.exp(-priced.lam_rem)
            self._open_market(
                session, fixture, cycle, "M6", "Does this finish 0-0?", ["Yes", "No"],
                quote_outcomes({"Yes": p_00, "No": 1 - p_00}),
                {"type": "finish_00"}, 88, ev,
            )

        # M7 | goal makes it a 1-goal lead after min 60 | {Trailing team} equalizes?
        if minute >= 60 and abs(score_h - score_a) == 1:
            trailing = "away" if score_h > score_a else "home"
            trailing_name = fixture.away if trailing == "away" else fixture.home
            lam_trailing = priced.lam_away if trailing == "away" else priced.lam_home
            # Heuristic (documented): P(equalize) ≈ P(trailing scores ≥1) · 0.75
            # (the leader may extend the lead first and kill the market's premise).
            p_eq = (1 - math.exp(-lam_trailing)) * 0.75
            question = f"{trailing_name} equalizes?"
            exists_m7 = session.execute(
                select(Market.id).where(
                    Market.fixture_id == fixture.id, Market.template_id == "M7",
                    Market.cycle == cycle, Market.status.in_(["open", "suspended", "locked"]),
                )
            ).first()
            if not exists_m7:
                self._equalized_since_open[fixture.id] = False
                self._open_market(
                    session, fixture, cycle, "M7", question, ["Yes", "No"],
                    quote_outcomes({"Yes": p_eq, "No": 1 - p_eq}),
                    {"type": "equalizer", "trailing": trailing}, 90, ev,
                )

        # M8 | odds shock: >15% 1X2 swing in one snapshot | Score changes from here?
        last = self._last_1x2.get(fixture.id)
        if last and minute < 88:
            swing = max(
                abs(priced.probs_1x2.get(k, 0) - last.get(k, 0)) for k in ("home", "draw", "away")
            )
            if swing > 0.15:
                p_change = 1 - math.exp(-priced.lam_rem)
                self._open_market(
                    session, fixture, cycle, "M8", f"Score changes after {minute}:00?", ["Yes", "No"],
                    quote_outcomes({"Yes": p_change, "No": 1 - p_change}),
                    {"type": "score_change", "score": [score_h, score_a]}, 90, ev,
                )

    # -------------------------------------------------------------- repricing
    def _reprice_open(
        self, session: Session, fixture: Fixture, priced: PricedState, cycle: int, ev: TickEvents
    ) -> None:
        markets = (
            session.execute(
                select(Market).where(
                    Market.fixture_id == fixture.id, Market.status == "open", Market.cycle == cycle
                )
            )
            .scalars()
            .all()
        )
        minute = fixture.minute
        total = fixture.score_home + fixture.score_away
        for m in markets:
            fair: dict[str, float] | None = None
            rule = m.settle_rule
            t = rule.get("type")
            if t == "1x2" and {"home", "draw", "away"} <= set(priced.probs_1x2):
                fair = {"Home": priced.probs_1x2["home"], "Draw": priced.probs_1x2["draw"], "Away": priced.probs_1x2["away"]}
            elif t == "ou" and priced.p_over is not None and priced.ou_line == rule.get("line"):
                fair = {"Over": priced.p_over, "Under": 1 - priced.p_over}
            elif t == "goal_before":
                window = rule["minute"] - minute
                if window > 0 and fixture.status == "live":
                    p_yes = p_goal_in_window(priced.lam_rem, window, minute)
                    fair = {"Yes": p_yes, "No": 1 - p_yes}
            elif t == "finish_00" and total == 0:
                p_00 = math.exp(-priced.lam_rem)
                fair = {"Yes": p_00, "No": 1 - p_00}
            elif t == "winner_in_regulation":
                p_dec = 1 - priced.probs_1x2.get("draw", 0.5)
                fair = {"Yes": p_dec, "No": 1 - p_dec}
            if fair is None:
                continue
            quoted = quote_outcomes(fair)
            if quoted and quoted != m.prices:
                m.prices = quoted
                ev.add("price_update", market_id=m.id, fixture_id=fixture.id, prices=quoted)

    # ------------------------------------------------------------ goal + clock
    def _on_goal(self, session: Session, fixture: Fixture, markets: list[Market], ev: TickEvents) -> None:
        """A goal locks+settles every goal-window market it decides (§4)."""
        total = fixture.score_home + fixture.score_away
        evidence = {
            "score": [fixture.score_home, fixture.score_away],
            "minute": fixture.minute,
            "event": "goal",
        }
        for m in markets:
            rule = m.settle_rule
            if rule.get("type") == "goal_before" and m.status in ("open", "suspended", "locked"):
                if total > rule.get("base_total", 0) and fixture.minute <= rule["minute"]:
                    self._settle(session, m, "Yes", evidence, ev)
            if rule.get("type") == "score_change" and m.status in ("open", "suspended", "locked"):
                if [fixture.score_home, fixture.score_away] != rule["score"]:
                    self._settle(session, m, "Yes", evidence, ev)
            if rule.get("type") == "equalizer" and m.status in ("open", "suspended", "locked"):
                if fixture.score_home == fixture.score_away:
                    self._settle(session, m, "Yes", evidence, ev)

    def _lock_and_settle_by_clock(
        self, session: Session, fixture: Fixture, markets: list[Market], ev: TickEvents
    ) -> None:
        minute = fixture.minute
        total = fixture.score_home + fixture.score_away
        live = fixture.status == "live"
        for m in markets:
            rule = m.settle_rule
            # PM markets lock at kickoff
            if m.template_id.startswith("PM") and m.status in ("open", "suspended") and fixture.status != "upcoming":
                m.status = "locked"
                ev.add("market_locked", market_id=m.id, status="locked")
                continue
            lock_min = rule.get("locks_at_minute")
            if lock_min is None or not live:
                continue
            if minute >= lock_min and m.status in ("open", "suspended"):
                m.status = "locked"
                ev.add("market_locked", market_id=m.id, status="locked")
            # goal windows that expired undecided settle No straight away
            if rule.get("type") == "goal_before" and m.status == "locked" and minute >= rule["minute"]:
                if total <= rule.get("base_total", 0):
                    self._settle(
                        session, m, "No",
                        {"score": [fixture.score_home, fixture.score_away], "minute": minute, "event": "window_expired"},
                        ev,
                    )

    def _settle_full_time(self, session: Session, fixture: Fixture, cycle: int, ev: TickEvents) -> None:
        h, a = fixture.score_home, fixture.score_away
        ht = self._ht_score.get(fixture.id, (0, 0))
        evidence = {"score": [h, a], "ht_score": list(ht), "minute": fixture.minute, "event": "full_time"}
        markets = (
            session.execute(
                select(Market).where(
                    Market.fixture_id == fixture.id,
                    Market.status.in_(["open", "suspended", "locked"]),
                    Market.cycle == cycle,
                )
            )
            .scalars()
            .all()
        )
        for m in markets:
            rule, t = m.settle_rule, m.settle_rule.get("type")
            if t == "1x2":
                winner = "Home" if h > a else ("Away" if a > h else "Draw")
                self._settle(session, m, winner, evidence, ev)
            elif t == "ou":
                self._settle(session, m, "Over" if h + a > rule["line"] else "Under", evidence, ev)
            elif t == "ah":
                fav_diff = (h - a) if rule["favorite"] == "home" else (a - h)
                margin = fav_diff + rule["line"]
                if margin == 0:  # push → void, refund stakes
                    self._settle(session, m, None, {**evidence, "push": True}, ev)
                else:
                    self._settle(session, m, "Yes" if margin > 0 else "No", evidence, ev)
            elif t == "both_halves_goal":
                h1 = ht[0] + ht[1]
                h2 = (h + a) - h1
                self._settle(session, m, "Yes" if h1 > 0 and h2 > 0 else "No", evidence, ev)
            elif t == "goal_before":
                total = h + a
                self._settle(session, m, "Yes" if total > rule.get("base_total", 0) else "No", evidence, ev)
            elif t == "h2_vs_h1":
                h1 = rule["h1_goals"]
                h2 = (h + a) - h1
                self._settle(session, m, "Yes" if h2 > h1 else "No", evidence, ev)
            elif t == "winner_in_regulation":
                self._settle(session, m, "Yes" if h != a else "No", evidence, ev)
            elif t == "finish_00":
                self._settle(session, m, "Yes" if (h, a) == (0, 0) else "No", evidence, ev)
            elif t == "equalizer":
                equalized = self._equalized_since_open.get(fixture.id, False) or h == a
                self._settle(session, m, "Yes" if equalized else "No", evidence, ev)
            elif t == "score_change":
                self._settle(session, m, "Yes" if [h, a] != rule["score"] else "No", evidence, ev)
            else:  # unresolvable → void and refund (§4)
                self._settle(session, m, None, {**evidence, "reason": "unresolvable"}, ev)

    def _void_stale_cycles(self, session: Session, fixture: Fixture, cycle: int, ev: TickEvents) -> None:
        stale = (
            session.execute(
                select(Market).where(
                    Market.fixture_id == fixture.id,
                    Market.cycle < cycle,
                    Market.status.in_(["open", "suspended", "locked"]),
                )
            )
            .scalars()
            .all()
        )
        for m in stale:
            self._settle(session, m, None, {"reason": "demo_restart", "event": "abandoned"}, ev)

    def void_fixture(self, session: Session, fixture: Fixture, reason: str, ev: TickEvents | None = None) -> None:
        """Abandoned/unresolvable fixture: void all its markets, refund stakes."""
        markets = (
            session.execute(
                select(Market).where(
                    Market.fixture_id == fixture.id, Market.status.in_(["open", "suspended", "locked"])
                )
            )
            .scalars()
            .all()
        )
        for m in markets:
            self._settle(session, m, None, {"reason": reason}, ev or TickEvents())

    def _settle(
        self, session: Session, market: Market, winner: str | None, evidence: dict, ev: TickEvents
    ) -> None:
        result = settle_market(session, market, winner, evidence)
        if result is None:  # already settled — idempotent
            return
        ev.add(
            "market_settled",
            market_id=market.id,
            fixture_id=market.fixture_id,
            winning_outcome=winner,
            evidence=evidence,
        )
        ev.add("receipt", market_id=market.id, phase="settle")
        log.info("SETTLE %s %s -> %s", market.template_id, market.question, winner)


def _pois_cdf(k: int, lam: float) -> float:
    if k < 0:
        return 0.0
    term = math.exp(-lam)
    cdf = term
    for i in range(1, k + 1):
        term *= lam / i
        cdf += term
    return min(cdf, 1.0)
