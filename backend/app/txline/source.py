"""DataSource interface (build.md §11.2): the market Brain consumes this and
does not know whether it's talking to live TxLINE, the scripted replay, or a
demo simulation."""
from __future__ import annotations

from typing import Protocol

from ..config import settings
from .simulator import SimRegistry, is_demo_id
from .types import NormFixture, NormMatchState, NormOdds


class DataSource(Protocol):
    cycle: int  # demo replay cycle; always 0 for the real source

    def list_fixtures(self) -> list[NormFixture]: ...

    def odds_snapshot(self, txline_fixture_id: int, in_play: bool) -> list[NormOdds]: ...

    def match_state(self, txline_fixture_id: int) -> NormMatchState | None: ...


# Process-wide registry of running simulations. The API starts/stops sims here;
# the Brain reads them through RoutedSource on each tick.
REGISTRY = SimRegistry()


class RoutedSource:
    """Routes per fixture instead of per process.

    Demo fixture ids go to the simulator, everything else to the base source.
    This is what lets a simulated match run *alongside* real ones: the old
    make_source() returned live-or-replay for the whole process, so demoing
    anything meant hiding every real fixture.
    """

    def __init__(self, base: DataSource, registry: SimRegistry) -> None:
        self.base = base
        self.registry = registry

    @property
    def cycle(self) -> int:
        return getattr(self.base, "cycle", 0)

    def list_fixtures(self) -> list[NormFixture]:
        fixtures = list(self.base.list_fixtures())
        fixtures.extend(s.fixture(settings.txline_competition_id) for s in self.registry.active())
        return fixtures

    def odds_snapshot(self, txline_fixture_id: int, in_play: bool) -> list[NormOdds]:
        if is_demo_id(txline_fixture_id):
            sim = self.registry.get(txline_fixture_id)
            return sim.odds(in_play) if sim else []
        return self.base.odds_snapshot(txline_fixture_id, in_play)

    def match_state(self, txline_fixture_id: int) -> NormMatchState | None:
        if is_demo_id(txline_fixture_id):
            sim = self.registry.get(txline_fixture_id)
            return sim.match_state() if sim else None
        return self.base.match_state(txline_fixture_id)

    def restart(self) -> None:
        """Forwarded for POST /api/admin/demo/restart (scripted replay only)."""
        restart = getattr(self.base, "restart", None)
        if restart:
            restart()


def make_source() -> "DataSource":
    if settings.demo_mode:
        from .demo import DemoSource

        base: DataSource = DemoSource()
    else:
        from .client import TxLineClient

        client = TxLineClient()
        client.cycle = 0  # type: ignore[attr-defined]
        base = client
    return RoutedSource(base, REGISTRY)
