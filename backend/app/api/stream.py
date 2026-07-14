"""SSE broker (build.md §7: prefer SSE for Render friendliness). The frontend
subscribes once to /api/stream and filters client-side."""
from __future__ import annotations

import asyncio
import json


class Broker:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue] = set()

    def publish(self, event: dict) -> None:
        for q in list(self._subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                self._subscribers.discard(q)  # drop slow consumers

    async def subscribe(self):
        q: asyncio.Queue = asyncio.Queue(maxsize=500)
        self._subscribers.add(q)
        try:
            while True:
                try:
                    event = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"data: {json.dumps(event)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            self._subscribers.discard(q)


broker = Broker()
