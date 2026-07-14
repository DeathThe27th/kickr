"""DataSource interface (build.md §11.2): the market Brain consumes this and
does not know whether it's talking to live TxLINE or the demo replay."""
from __future__ import annotations

from typing import Protocol

from ..config import settings
from .types import NormFixture, NormMatchState, NormOdds


class DataSource(Protocol):
    cycle: int  # demo replay cycle; always 0 for the real source

    def list_fixtures(self) -> list[NormFixture]: ...

    def odds_snapshot(self, txline_fixture_id: int, in_play: bool) -> list[NormOdds]: ...

    def match_state(self, txline_fixture_id: int) -> NormMatchState | None: ...


def make_source() -> "DataSource":
    if settings.demo_mode:
        from .demo import DemoSource

        return DemoSource()
    from .client import TxLineClient

    client = TxLineClient()
    client.cycle = 0  # type: ignore[attr-defined]
    return client
