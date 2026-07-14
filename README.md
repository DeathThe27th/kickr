# kickr

**In-play micro prediction markets for the 2026 World Cup.** Markets spawn and settle
inside the 90 minutes, priced live from the TxLINE odds feed, settled from Tx Scores,
with settlement receipts committed to Solana devnet. Play-money economy.

> This is Part 1: backend brain + Supabase-shaped ledger + Privy-authed web app with a
> bracket UI. See [`build.md`](./build.md) for the full spec. Part 2 (Telegram bot / Mini
> App) is not built — the `notification_outbox` table and `notify()` no-op are the hooks.

```
kickr/
├── backend/    # FastAPI (Python 3.11+) — the Brain: TxLINE client, pricing, markets, ledger, API/SSE
├── frontend/   # Next.js 14 (App Router) + Tailwind + Privy — landing, bracket, drawer/bet flow, positions, leaderboard
├── chain/      # Solana devnet receipt committer (TypeScript) + TxLINE devnet activation scripts
└── build.md    # the build spec
```

## Quick start (demo mode, zero external credentials)

`DEMO_MODE=true` replays a hand-authored match (`backend/fixtures/demo_match.jsonl`:
0-0 → 1-0 68' → 1-1 84') on a compressed ~6-minute clock. Every engine — triggers,
pricing, settlement, receipts, stream — runs identically to live.

**Terminal 1 — backend**
```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # defaults already run in demo mode
uvicorn app.main:app --reload --port 8000
```

**Terminal 2 — frontend**
```bash
cd frontend
npm install
cp .env.example .env.local      # NEXT_PUBLIC_API_URL=http://localhost:8000
npm run dev                     # http://localhost:3000
```

Open http://localhost:3000. The landing page shows a live preview strip moving with real
demo data before you sign in. Click **Sign in**, pick a handle (dev auth — no Privy needed),
and you're credited 1,000 chips. Open the live fixture from the bracket, place a bet on a
micro market, and watch it settle inside two minutes with the payout in your balance and a
Solana explorer link on the settled market.

Restart the replay any time:
```bash
curl -X POST http://localhost:8000/api/admin/demo/restart -H "X-Admin-Key: kickr-dev-admin"
```

## What runs where

| Package | Key pieces |
|---|---|
| `backend/app/txline/` | Shared source interface: real TxLINE client vs. demo replay behind one seam (§2, §9) |
| `backend/app/pricing/` | λ extraction from live totals, interval probs, de-vig, quoting with margin (§3) |
| `backend/app/markets/` | Deterministic template + trigger engine, settlement, receipt queue (§4) |
| `backend/app/ledger.py` | Append-only play-money ledger; balance = SUM(amount); idempotent settlement (§5) |
| `backend/app/api/` | REST routes + SSE `/api/stream`; Privy JWT verification (§7) |
| `frontend/app/` | `/` landing · `/app` bracket home + drawer/bet flow · `/positions` · `/leaderboard` |
| `chain/` | sha256 receipt → Memo instruction on devnet; TxLINE devnet activation scripts |

## Auth

- **No `PRIVY_APP_ID` / `NEXT_PUBLIC_PRIVY_APP_ID`:** dev sign-in. Pick a handle; the client
  sends `Authorization: Bearer dev:<handle>` and the backend upserts the user and credits
  the signup bonus once.
- **With Privy set:** the frontend uses the Privy SDK; the backend verifies the access token
  against Privy's JWKS.

## Tests

```bash
cd backend && python -m pytest -q      # ledger math, double-settlement, pricing, normalizers, market engine
cd frontend && npx tsc --noEmit && npm run build
```

## Deploy

- **Backend → Render** (web service): set `DATABASE_URL` to the Supabase Postgres URL, run
  `backend/migrations/001_init.sql`, provide TxLINE + Solana + Privy env vars, set
  `DEMO_MODE=false`. Start command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`.
- **Frontend → Vercel**: set `NEXT_PUBLIC_API_URL` to the Render URL and
  `NEXT_PUBLIC_PRIVY_APP_ID`.

See [`build.md §10`](./build.md) for the full env var list.
