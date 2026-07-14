"""Solana devnet receipts (build.md §6): fire-and-forget queue. A Solana
outage must never block settlement — 3 failed attempts leave the signature
null and the show goes on."""
from __future__ import annotations

import hashlib
import json
import logging
import queue
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select

from .config import settings
from .models import Market

log = logging.getLogger("kickr.receipts")

CHAIN_DIR = Path(__file__).resolve().parents[2] / "chain"
MAX_ATTEMPTS = 3


class ReceiptQueue:
    def __init__(self, session_factory) -> None:
        self._q: queue.Queue[tuple[str, str, dict]] = queue.Queue()
        self._session_factory = session_factory
        self._worker = threading.Thread(target=self._run, daemon=True, name="receipts")
        self._worker.start()

    def enqueue_for_market(self, session, market: Market, phase: str) -> None:
        """Build the §6 receipt JSON from the market row and queue it."""
        receipt = {
            "market_id": market.id,
            "fixture": market.fixture_id,
            "question": market.question,
            "outcomes": market.outcomes,
            "prices_or_evidence": market.prices if phase == "open" else market.settle_rule,
            "ts": datetime.now(timezone.utc).isoformat(),
        }
        self._q.put((market.id, phase, receipt))

    # --- worker ---
    def _run(self) -> None:
        while True:
            market_id, phase, receipt = self._q.get()
            sig: str | None = None
            payload = json.dumps(receipt, sort_keys=True)
            for attempt in range(1, MAX_ATTEMPTS + 1):
                try:
                    proc = subprocess.run(
                        ["npx", "tsx", "scripts/commit-receipt.ts", phase],
                        cwd=CHAIN_DIR,
                        input=payload.encode(),
                        capture_output=True,
                        timeout=90,
                    )
                    if proc.returncode == 0 and proc.stdout.strip():
                        sig = proc.stdout.decode().strip()
                        break
                    log.warning(
                        "receipt commit attempt %d/%d failed for %s: %s",
                        attempt, MAX_ATTEMPTS, market_id, proc.stderr.decode()[-200:],
                    )
                except Exception as exc:
                    log.warning("receipt commit attempt %d/%d errored: %s", attempt, MAX_ATTEMPTS, exc)
            if sig is None:
                log.error(
                    "receipt for market %s (%s) failed %dx — storing null (hash %s)",
                    market_id, phase, MAX_ATTEMPTS, hashlib.sha256(payload.encode()).hexdigest()[:16],
                )
            try:
                with self._session_factory() as session:
                    market = session.execute(select(Market).where(Market.id == market_id)).scalar_one_or_none()
                    if market is not None:
                        if phase == "open":
                            market.receipt_open_sig = sig
                        else:
                            market.receipt_settle_sig = sig
                        session.commit()
            except Exception as exc:
                log.error("failed to store receipt sig for %s: %s", market_id, exc)


def explorer_url(sig: str) -> str:
    return f"https://explorer.solana.com/tx/{sig}?cluster=devnet"
