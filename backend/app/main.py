"""Kickr Brain — FastAPI app + the polling/market loop (build.md §1, §2, §7)."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select

from .api.routes import router, runtime
from .api.stream import broker
from .config import settings
from .db import SessionLocal, init_db, session_scope
from .markets.engine import MarketEngine
from .models import Fixture, Market, OddsSnapshot
from .pricing.engine import price_fixture
from .receipts import ReceiptQueue
from .txline.simulator import is_demo_id
from .txline.source import REGISTRY, make_source

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("kickr.main")

BACKEND_DIR = Path(__file__).resolve().parents[1]

# Generous upper bound on a real match: 90' + stoppage + extra time + penalties
# runs to roughly 3h. Past this, a fixture still marked 'live' is stale data.
STALE_LIVE_AFTER = timedelta(hours=4)


def _seed_fixtures(source) -> None:
    """Upsert fixtures from the source; stage/slot from the static bracket JSON
    (build.md §8.2). New fixtures (e.g. the final appearing) default sensibly."""
    bracket = json.loads((BACKEND_DIR / "fixtures" / "bracket_2026.json").read_text())
    meta = {f["txline_fixture_id"]: f for f in bracket["fixtures"]}
    now = datetime.now(timezone.utc)
    with session_scope() as session:
        existing = {
            f.txline_fixture_id: f for f in session.execute(select(Fixture)).scalars()
        }
        for nf in source.list_fixtures():
            row = existing.get(nf.txline_fixture_id)
            m = meta.get(nf.txline_fixture_id, {})
            if row is None:
                row = Fixture(
                    txline_fixture_id=nf.txline_fixture_id,
                    home=nf.home,
                    away=nf.away,
                    kickoff_at=nf.kickoff_at,
                    stage=m.get("stage", "group"),
                    bracket_slot=m.get("bracket_slot"),
                )
                session.add(row)
            else:
                row.home, row.away, row.kickoff_at = nf.home, nf.away, nf.kickoff_at
            # A simulated match runs on its own clock, not the calendar, so none
            # of the wall-clock rules below may touch it.
            is_scripted_demo = settings.demo_mode and nf.txline_fixture_id == _demo_id()
            if is_scripted_demo or is_demo_id(nf.txline_fixture_id):
                continue

            kickoff = row.kickoff_at.replace(tzinfo=timezone.utc)
            if row.status == "upcoming" and kickoff < now:
                # past fixtures without live coverage render as finished
                row.status = "finished"
            elif row.status == "live" and kickoff < now - STALE_LIVE_AFTER:
                # Nothing else can rescue a stranded 'live' row: the rule above
                # only catches fixtures that never started, and a fixture stays
                # tracked while live, so if the feed goes quiet about it —
                # outage, or a match that ended before we were watching — it
                # sits at 0-0 in-play forever. Hours past kickoff it is stale,
                # not in-play.
                log.warning("fixture %s stale in 'live' since %s — finishing", nf.txline_fixture_id, kickoff)
                row.status = "finished"


def _demo_id() -> int:
    from .txline.demo import DEMO_FIXTURE_ID

    return DEMO_FIXTURE_ID


class Brain:
    def __init__(self) -> None:
        self.source = make_source()
        self.engine = MarketEngine()
        self.receipts = ReceiptQueue(SessionLocal)
        self._last_odds_key: dict[int, str] = {}
        self._last_poll: dict[tuple[int, str], float] = {}
        self._last_fixture_refresh = 0.0

    # --- cadence rules (build.md §2) ---
    def _due(self, txid: int, kind: str, interval: float) -> bool:
        now = time.monotonic()
        if now - self._last_poll.get((txid, kind), 0) >= interval:
            self._last_poll[(txid, kind)] = now
            return True
        return False

    def tick(self) -> list[dict]:
        events: list[dict] = []
        now = time.monotonic()
        REGISTRY.sweep()  # drop long-finished sims so they stop being re-seeded
        # A sim that was just started needs its fixture row promptly, so refresh
        # fast whenever one is running rather than waiting out the live interval.
        refresh_every = 5 if (settings.demo_mode or REGISTRY.active()) else 600
        if now - self._last_fixture_refresh >= refresh_every:
            _seed_fixtures(self.source)
            self._last_fixture_refresh = now

        with session_scope() as session:
            fixtures = session.execute(select(Fixture)).scalars().all()
            wall_now = datetime.now(timezone.utc)
            for fixture in fixtures:
                kickoff = fixture.kickoff_at.replace(tzinfo=timezone.utc)
                near_kickoff = abs((kickoff - wall_now).total_seconds()) < 2 * 3600
                # The demo fixture is always tracked in demo mode: its replay clock
                # cycles upcoming->live->finished->(restart)->upcoming, so the engine
                # must keep re-syncing its status even after it has finished, or a
                # restart would leave it stuck 'finished' and never track again.
                is_demo_fixture = (
                    settings.demo_mode and fixture.txline_fixture_id == _demo_id()
                ) or is_demo_id(fixture.txline_fixture_id)
                tracked = (
                    is_demo_fixture
                    or fixture.status == "live"
                    or (fixture.status == "upcoming" and near_kickoff)
                )
                if not tracked:
                    continue

                in_play = fixture.status == "live"
                # Simulated matches run a compressed clock (4s per match minute),
                # so they need the demo cadence even when the server is live.
                fast = settings.demo_mode or is_demo_id(fixture.txline_fixture_id)
                state = None
                if self._due(fixture.txline_fixture_id, "scores", 2 if fast else (7 if in_play else 60)):
                    state = self.source.match_state(fixture.txline_fixture_id)

                odds = []
                if self._due(fixture.txline_fixture_id, "odds", 2 if fast else (12 if in_play else 25)):
                    odds = self.source.odds_snapshot(fixture.txline_fixture_id, in_play)

                priced = None
                if odds:
                    self._persist_snapshots(session, fixture, odds)
                    goals = (state.score_home + state.score_away) if state else (
                        fixture.score_home + fixture.score_away
                    )
                    minute = state.minute if state else fixture.minute
                    newest_age = min(
                        (datetime.now(timezone.utc) - o.ts).total_seconds() for o in odds
                    )
                    priced = price_fixture(odds, goals, minute, newest_age, in_play)

                cycle = getattr(self.source, "cycle", 0)
                tick_events = self.engine.tick(session, fixture, state, priced, cycle)
                for ev in tick_events:
                    if ev["event"] == "receipt":
                        market = session.get(Market, ev["market_id"])
                        if market is not None:
                            self.receipts.enqueue_for_market(session, market, ev["phase"])
                    else:
                        events.append(ev)
        return events

    def _persist_snapshots(self, session, fixture: Fixture, odds) -> None:
        """§2: persist raw snapshots (needed for replay + divergence history).
        Dedupe on price changes so the demo loop doesn't flood the table."""
        key = json.dumps([(o.market, o.line, o.prices) for o in odds], sort_keys=True)
        if self._last_odds_key.get(fixture.txline_fixture_id) == key:
            return
        self._last_odds_key[fixture.txline_fixture_id] = key
        for o in odds:
            session.add(
                OddsSnapshot(
                    fixture_id=fixture.id,
                    market_type=o.market,
                    line=o.line,
                    payload={"prices": o.prices, "probs": o.probs, "in_running": o.in_running},
                    ts=o.ts,
                )
            )


async def brain_loop(brain: Brain) -> None:
    while True:
        # Re-read each pass: a sim started at runtime needs the fast cadence to
        # keep up with its compressed clock, even on a live server.
        interval = 2.0 if (settings.demo_mode or REGISTRY.active()) else 5.0
        try:
            events = await asyncio.to_thread(brain.tick)
            for ev in events:
                broker.publish(ev)
        except Exception:
            log.exception("brain tick failed — degrading, next tick continues")
        await asyncio.sleep(interval)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    brain = Brain()
    runtime["source"] = brain.source
    runtime["engine"] = brain.engine
    runtime["receipts"] = brain.receipts
    _seed_fixtures(brain.source)
    task = asyncio.create_task(brain_loop(brain))
    log.info("Kickr Brain started (demo_mode=%s)", settings.demo_mode)
    yield
    task.cancel()


app = FastAPI(title="Kickr Brain", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router)


@app.get("/healthz")
def healthz():
    return {"ok": True, "demo_mode": settings.demo_mode}
