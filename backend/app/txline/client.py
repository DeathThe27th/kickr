"""Real TxLINE HTTP client (build.md §2). One shared client, aggressive
caching, JWT renewal on 401 (same API token), backoff on errors — never
hammer the API."""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone

import httpx

from ..config import settings
from .normalize import normalize_fixture, normalize_odds, normalize_score
from .types import NormFixture, NormMatchState, NormOdds

log = logging.getLogger("kickr.txline")


class TxLineClient:
    def __init__(self) -> None:
        self._jwt = settings.txline_jwt
        self._api_token = settings.txline_api_token
        self._http = httpx.Client(base_url=f"{settings.txline_api_origin}/api", timeout=15)
        self._lock = threading.Lock()
        self._backoff_until = 0.0
        # cache: url -> (expires_at_monotonic, data)
        self._cache: dict[str, tuple[float, object]] = {}
        # Participant1IsHome per fixture, needed to orient odds outcomes
        self._p1_home: dict[int, bool] = {}

    # --- auth ---
    def _renew_jwt(self) -> None:
        res = httpx.post(f"{settings.txline_api_origin}/auth/guest/start", timeout=15)
        res.raise_for_status()
        self._jwt = res.json()["token"]
        log.info("TxLINE guest JWT renewed")

    def _get(self, url: str, cache_ttl: float) -> object | None:
        now = time.monotonic()
        cached = self._cache.get(url)
        if cached and cached[0] > now:
            return cached[1]
        if now < self._backoff_until:
            return cached[1] if cached else None
        with self._lock:
            try:
                res = self._http.get(
                    url,
                    headers={"Authorization": f"Bearer {self._jwt}", "X-Api-Token": self._api_token},
                )
                if res.status_code == 401:
                    self._renew_jwt()
                    res = self._http.get(
                        url,
                        headers={"Authorization": f"Bearer {self._jwt}", "X-Api-Token": self._api_token},
                    )
                res.raise_for_status()
                data = res.json()
                self._cache[url] = (now + cache_ttl, data)
                self._backoff_until = 0.0
                return data
            except Exception as exc:  # degrade loudly, never crash (build.md §0)
                log.error("TxLINE request failed (%s): %s — backing off 30s", url, exc)
                self._backoff_until = time.monotonic() + 30
                return cached[1] if cached else None

    # --- data ---
    def list_fixtures(self) -> list[NormFixture]:
        today = int(datetime.now(timezone.utc).timestamp() // 86_400)
        fixtures: dict[int, NormFixture] = {}
        for offset in (-30, -20, -10, 0):  # 10-day windows covering the tournament
            data = self._get(
                f"/fixtures/snapshot?competitionId={settings.txline_competition_id}"
                f"&startEpochDay={today + offset}",
                cache_ttl=600,  # fixtures refresh every 10 min (§2)
            )
            for raw in data or []:
                fx = normalize_fixture(raw)
                fixtures[fx.txline_fixture_id] = fx
                self._p1_home[fx.txline_fixture_id] = bool(raw.get("Participant1IsHome", True))
        return list(fixtures.values())

    def odds_snapshot(self, txline_fixture_id: int, in_play: bool) -> list[NormOdds]:
        ttl = 12 if in_play else 25  # §2 cadences
        data = self._get(f"/odds/snapshot/{txline_fixture_id}", cache_ttl=ttl)
        result = []
        p1_home = self._p1_home.get(txline_fixture_id, True)
        for raw in data or []:
            odds = normalize_odds(raw, p1_home)
            if odds:
                result.append(odds)
        return result

    def match_state(self, txline_fixture_id: int) -> NormMatchState | None:
        data = self._get(f"/scores/snapshot/{txline_fixture_id}", cache_ttl=7)  # 5-10s in-play
        if not data:
            return None
        records = data if isinstance(data, list) else [data]
        return normalize_score(records[-1]) if records else None
