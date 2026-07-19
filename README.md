# kickr

**In-play micro prediction markets for the 2026 World Cup.** Markets spawn and settle
*inside* the 90 minutes — priced live from the TxLINE odds feed, settled from Tx Scores,
every open and settle committed as a hash receipt on Solana. Play-money economy, firm
house odds, instant settlement.

A calm white/ink product until something is **live** — then yellow marks exactly where the
money moment is.

---

## Table of contents

- [What it is](#what-it-is)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [The Brain: the tick loop](#the-brain-the-tick-loop)
- [Pricing engine](#pricing-engine)
- [Market templates & triggers](#market-templates--triggers)
- [Economy & ledger](#economy--ledger)
- [Data model](#data-model)
- [HTTP API](#http-api)
- [Real-time stream (SSE)](#real-time-stream-sse)
- [Data sources: live · replay · simulation](#data-sources-live--replay--simulation)
- [On-chain receipts](#on-chain-receipts)
- [Auth](#auth)
- [Telegram bot](#telegram-bot)
- [Frontend](#frontend)
- [Configuration](#configuration)
- [Running locally](#running-locally)
- [Tests](#tests)
- [Deployment](#deployment)
- [Operational notes](#operational-notes)

---

## What it is

A FastAPI service — **the Brain** — keeps a live model of every World Cup fixture from two
TxLINE streams:

- **StablePrice odds snapshots** — 1X2, Over/Under totals, Asian handicap (full-time & half-time).
- **Tx Scores** — live score and match clock.

A deterministic **template + trigger engine** opens markets (pre-match classics before
kickoff; micro markets in-play), prices them by extracting the market-implied goal rate
**λ** from TxLINE's live totals, locks bets at quoted prices, settles instantly from the
scores feed, pays winners from an append-only play-money ledger, and commits a sha256
receipt of every market open/settle to Solana. A Next.js frontend (Privy auth) renders a
landing page, the knockout bracket, per-fixture market drawers, positions and a leaderboard.
A Telegram bot mirrors market opens into chats with inline one-tap betting.

**No LLM sits anywhere in the market path.** Every price derives from TxLINE; every
settlement derives from a deterministic rule plus the scores feed.

---

## Architecture

```
                 TxLINE (odds + scores)          Solana (devnet/mainnet)
                        │                                  ▲
                        │ poll (APScheduler cadence)       │ commit-receipt.ts (subprocess)
                        ▼                                  │
   ┌──────────────────────────────────────────────────────┴───────────┐
   │                        Brain  (FastAPI, backend/)                 │
   │                                                                   │
   │   DataSource seam ── RoutedSource ─┬─ TxLineClient (live)         │
   │                                    ├─ DemoSource   (replay)       │
   │                                    └─ SimRegistry  (per-fixture)  │
   │                                                                   │
   │   tick() ──► pricing.engine ──► markets.engine ──► ledger         │
   │                                       │                           │
   │                                       ├─► ReceiptQueue (thread)   │
   │                                       └─► SSE Broker + outbox     │
   └───────────┬───────────────────────────────────────┬─────────────┘
               │ REST + /api/stream (SSE)               │ notification_outbox
               ▼                                        ▼
      Next.js frontend (Vercel)              Telegram bot (aiogram, in-process)
```

Everything is one process. The Brain runs the poll/market loop as an asyncio task, serves
the REST + SSE API, and — if a bot token is set — runs the Telegram long-poller and outbox
drain as sibling tasks. Telegram and Solana are strictly optional: **neither can block the
Brain from serving markets**; every failure there is logged and swallowed.

---

## Repository layout

```
kickr/
├── backend/                     # FastAPI (Python 3.11+) — the Brain
│   ├── app/
│   │   ├── main.py              # app + lifespan + the tick loop (Brain)
│   │   ├── config.py           # env vars + economy/pricing/market constants
│   │   ├── auth.py             # Privy JWT verification (+ dev fallback)
│   │   ├── ledger.py          # append-only play-money ledger; settlement
│   │   ├── models.py          # SQLAlchemy ORM (mirrors migrations/001_init.sql)
│   │   ├── receipts.py        # Solana receipt queue (fire-and-forget thread)
│   │   ├── db.py              # engine/session/session_scope
│   │   ├── pricing/engine.py  # λ extraction, interval probs, quoting
│   │   ├── markets/engine.py  # template + trigger engine, settlement, reaper
│   │   ├── api/routes.py      # REST routes
│   │   ├── api/stream.py      # SSE broker
│   │   ├── txline/            # DataSource seam: client / demo / simulator / normalize
│   │   └── telegram/          # aiogram bot + outbox drain
│   ├── migrations/            # 001_init.sql, 002_fixture_source.sql
│   ├── fixtures/              # demo_match.jsonl, bracket_2026.json
│   ├── scripts/              # gen_demo_match.py, gen_bracket.py
│   └── tests/                # ledger, pricing, market engine, normalize, telegram
├── frontend/                 # Next.js 14 (App Router) + Tailwind + Privy
│   ├── app/                  # / · /app · /positions · /leaderboard
│   ├── components/           # Nav, MarketCard, StakeSheet, shared
│   └── lib/                  # api client, auth, types, flags
├── chain/                    # Solana TS scripts: activate-txline, commit-receipt
│   ├── scripts/
│   ├── idl/txoracle.json
│   └── .keys/                # keypairs (gitignored)
├── render.yaml               # Render blueprint (backend)
├── Dockerfile
├── build.md                  # the original build spec (§ references throughout the code)
└── README.md
```

Code comments reference the build spec by section (e.g. `§3.2`, `§4`). `build.md` remains the
authoritative spec; this README documents the system as built.

---

## The Brain: the tick loop

`backend/app/main.py`. A single async loop (`brain_loop`) calls `Brain.tick()` on a cadence
and publishes the resulting events to the SSE broker.

- **Tick interval:** 2s when any demo/sim is active, 5s otherwise.
- **Fixture refresh (`_seed_fixtures`):** every ~5s when a sim is running, otherwise every
  10 min. Upserts fixtures from the source; stage/`bracket_slot` come from the static
  `fixtures/bracket_2026.json`. Also the **watchdog**: a fixture past kickoff that never went
  live is marked `finished`; one stuck `live` more than 4h past kickoff (`STALE_LIVE_AFTER`)
  is force-finished.
- **Per-fixture polling cadence** (build.md §2), only for *tracked* fixtures (demo fixtures,
  anything `live`, or `upcoming` within 2h of kickoff):
  | Data | Pre-match | In-play | Demo/sim |
  |---|---|---|---|
  | Scores | 60s | 7s | 2s |
  | Odds | 25s | 12s | 2s |
- **Snapshot persistence** dedupes on price change so the fast demo loop doesn't flood
  `odds_snapshots`.
- **Stranded-market reaper** runs on the refresh cadence — see [Economy & ledger](#economy--ledger).

Each tick: fetch state + odds → persist snapshots → `price_fixture(...)` → `engine.tick(...)`
→ drain events (receipts get queued, everything else is published to SSE).

---

## Pricing engine

`backend/app/pricing/engine.py`. All prices derive from TxLINE; there is no proprietary
model as source of truth.

1. **De-vig** (`devig`) — `p_raw = 1/odds`, normalized so `Σ p = 1`.
2. **Market-implied goal rate** (`solve_lambda_remaining`) — from the main totals line `L` and
   de-vigged `P(over)`, bisect over λ ∈ [0.01, 8] to solve
   `P(Poisson(λ_rem) > L − goals_so_far) = P_over`. In-play this bakes in time decay
   automatically, because the live total line/prices move with the clock.
3. **λ split** (`split_lambda`) — from the 1X2 win-prob skew `q = p_home/(p_home+p_away)`,
   map to the home share `s = clamp(0.2 + 0.6·q, 0.2, 0.8)`; `λ_home = λ_rem·s`,
   `λ_away = λ_rem·(1−s)`.
4. **Interval probability** (`p_goal_in_window`) — `P(≥1 goal in next m min)
   = 1 − exp(−λ_rem · m / mins_eff)`, with `mins_eff = max(90 − minute, 1)` plus a flat
   +4 stoppage allowance after minute 80.
5. **Quoting** (`quote`) — `odds = 1 / (p_fair · (1 + MARGIN))`, `MARGIN = 0.05`, floored at
   1.05, capped at 15.0, 2 dp. Returns `None` for un-quotable extremes.
6. **Staleness** (§3.5) — in-play, if the newest snapshot is older than 90s, the fixture is
   `fresh=False` and all its open markets are suspended until fresh data arrives.

`price_fixture(...)` returns a `PricedState` bundling λ (rem/home/away), the de-vigged 1X2,
the OU line + `p_over`, the AH probabilities + line, and the freshness flag — everything the
market engine needs from one tick.

---

## Market templates & triggers

`backend/app/markets/engine.py`. A deterministic rules engine driven by `tick(session,
fixture, state, priced, cycle)`. All writes happen in the caller's transaction; it returns
the SSE events to publish.

**Pre-match** (open when the fixture appears with odds; lock at kickoff; settle at FT):

| ID | Question | Outcomes | Priced from |
|---|---|---|---|
| PM1 | Match result | Home / Draw / Away | de-vigged 1X2 |
| PM2 | Over/Under {line} goals | Over / Under | TxLINE totals |
| PM3 | {Favorite} covers {AH line} | Yes / No | Asian handicap |
| PM4 | Both halves see a goal | Yes / No | λ split 0.45 / 0.55 across halves |

**In-play micro markets:**

| ID | Trigger | Question | Locks | Settles |
|---|---|---|---|---|
| M1 | kickoff | Goal before 25:00? | min 25 or on goal | goal / clock |
| M2 | any goal | Another goal before {min+20}? | window end or on goal | scores feed |
| M3 | HT captured | More goals in 2nd half than 1st? | min 85 → FT | FT score |
| M4 | min 55, any score | Goal before {min+15}? | window end or on goal | scores feed |
| M5 | min 70, level, knockout | Winner decided in regulation? | min 90 | FT score |
| M6 | min 70, 0-0 | Does this finish 0-0? | min 88 | FT score |
| M7 | 1-goal lead after min 60 | {Trailing team} equalizes? | min 90 | scores / FT |
| M8 | 1X2 odds shock (>15% swing) | Score changes from here? | min 90 | scores feed |

**Rules:**

- Max **4 micro markets open per fixture** at once (`max_micro_markets_open`).
- A goal instantly **locks + settles** every goal-window market it decides (`_on_goal`),
  then the trigger table runs again on the new state.
- Prices refresh on every tick until lock (`_reprice_open`).
- Settlement is **idempotent** — `settlements.market_id` is UNIQUE; a second settle is a no-op.
- Unresolvable / abandoned / AH-push → **void and refund** (`winning_outcome = None`).
- **Demo cycles:** each demo restart bumps `cycle` so the same trigger windows can reopen;
  markets from a prior cycle are voided/refunded. Always `0` in real mode.

---

## Economy & ledger

`backend/app/ledger.py`. Play-money chips; users bet the house at firm quoted odds.
**Balance is always `SUM(transactions.amount)`** — the ledger is append-only, never mutated.

Transaction kinds: `signup_bonus`, `faucet`, `bet_stake`, `bet_payout`, `refund`, `reset`.

| Rule | Value |
|---|---|
| Signup bonus | 1,000 chips (credited once, on first verified request) |
| Daily faucet | +200, one claim per UTC day |
| Bust reset | top up to 100 when balance < 10, once per UTC day |
| Max stake / bet | 500 |
| Max house exposure / outcome | 20,000 potential payout — beyond that the outcome is capped |
| Quote tolerance | client's `odds_seen` must match the live quote within 2%, else re-quote |

**Placing a bet** (`place_bet`) validates in order: market open → known outcome → stake in
range → outcome not suspended → quote fresh (±2%) → sufficient balance → exposure cap. Then
books the bet and posts a `−stake` `bet_stake` row, all in one transaction.

**Settlement** (`settle_market`) inserts the settlement row, marks each open bet won / lost /
voided, posts `bet_payout` (winners) or `refund` (voids), and writes a `bet_settled` row to
`notification_outbox`. Winners are paid `potential_payout`; the unique constraint guarantees
this runs at most once per market.

**Stranded-market reaper** (`reap_stranded`) — settlement only ever runs while a fixture is
*tracked*. A match the feed abandons (goes quiet mid-play) or a demo whose sim is gone would
otherwise strand open bets forever. The reaper voids + refunds those markets. It protects
genuinely in-play/upcoming real matches and demos still actively replaying. It runs
automatically on the refresh cadence and on demand via `POST /api/admin/reap-stranded`.

---

## Data model

`backend/migrations/001_init.sql` (+ `002_fixture_source.sql`), mirrored by
`backend/app/models.py`. Postgres in prod, SQLite locally.

| Table | Purpose | Notable columns |
|---|---|---|
| `users` | accounts | `privy_did` (unique), `handle`, `telegram_chat_id` |
| `transactions` | **append-only ledger** | `amount` (±), `kind`, `ref_id` |
| `fixtures` | TxLINE fixtures + bracket meta | `stage`, `bracket_slot`, `status`, `score_*`, `minute`, `source` (`live`/`demo`) |
| `odds_snapshots` | raw snapshots (replay + history) | `market_type`, `line`, `payload` jsonb, `ts` |
| `markets` | markets per §4 | `template_id`, `outcomes`, `prices`, `settle_rule`, `status`, `cycle`, `receipt_open_sig`, `receipt_settle_sig` |
| `bets` | placed bets | `outcome`, `stake`, `odds_locked`, `potential_payout`, `status` |
| `settlements` | one row per settled market | `market_id` **UNIQUE** → idempotency, `winning_outcome` (null = void), `evidence` jsonb |
| `telegram_link_codes` | one-time account-link codes | `code` (pk), single-use, 10-min TTL |
| `notification_outbox` | transport-agnostic event queue | `event_type`, `payload`, `sent_at` |

`markets` enforces `UNIQUE(fixture_id, template_id, question, cycle)` — one instance of a
template per fixture per trigger window per demo cycle.

---

## HTTP API

Prefix `/api`. Public routes need no auth; `/me` and `/bets` require a bearer token.

**Public**

| Route | Description |
|---|---|
| `GET /api/bracket` | all fixtures with stage/slot, live state, headline win probs, open-market counts |
| `GET /api/fixtures/{id}/markets` | open/suspended/locked markets with live quotes; `?include=settled` adds history |
| `GET /api/markets/{id}/receipt` | receipt JSON + Solana explorer links |
| `GET /api/leaderboard` | profit / ROI% / hit-rate, weekly + all-time |
| `GET /api/stats` | landing footer: settled count, active markets, sample receipt |
| `GET /api/stream` | SSE event stream (see below) |
| `GET /healthz` | liveness + demo flag |

**Authed** (`Authorization: Bearer <token>`)

| Route | Description |
|---|---|
| `GET /api/me` | profile, balance, faucet claimable, telegram_linked, recent bets |
| `POST /api/bets` | `{market_id, outcome, stake, odds_seen}` → ticket + new balance |
| `POST /api/me/faucet` | claim the daily faucet |
| `POST /api/me/reset` | bust reset |
| `POST /api/me/telegram/link-code` | mint a one-time `t.me/<bot>?start=<code>` deep link |
| `POST /api/me/telegram/unlink` | drop the linked chat |
| `POST /api/demo/fixtures/{id}/start` | spin any fixture into a live simulation (side-by-side with real data) |
| `POST /api/demo/fixtures/{id}/stop` | stop a simulation |

**Bet race cases** return `409` with a machine-readable body, never a raw error:
- `quote_moved` → `{ error, current_prices }` for an inline re-quote.
- `market_not_open` → `{ error, status, evidence, winning_outcome }` (settled between render and tap).

**Admin** (`X-Admin-Key: <ADMIN_KEY>`)

| Route | Description |
|---|---|
| `POST /api/admin/demo/restart` | restart the scripted replay (bumps `cycle`) |
| `POST /api/admin/reap-stranded` | void + refund markets on abandoned matches on demand |

---

## Real-time stream (SSE)

`backend/app/api/stream.py`. The frontend subscribes once to `GET /api/stream` and filters
client-side. SSE (not WebSocket) is deliberate — friendlier to Render, resumes cleanly.
A `: keepalive` comment is emitted every 15s; slow consumers (full queue) are dropped.

Event types published by the engine:

`market_open` · `price_update` · `market_locked` (status `locked`/`suspended`) ·
`market_settled` · `score_update` · `demo_started` · `demo_stopped` · `demo_restarted`.

(`receipt` events are internal — routed to the receipt queue, never sent over SSE.)

---

## Data sources: live · replay · simulation

`backend/app/txline/`. The Brain talks to a single `DataSource` protocol and does not know
which backend it is:

- **`TxLineClient`** — the real TxLINE feed. Auth flow (one-time, `chain/scripts/activate-txline.ts`):
  guest JWT → on-chain `subscribe` at a free World Cup service level → sign `${txSig}::${jwt}`
  → `POST /api/token/activate` → API token. The client sends
  `Authorization: Bearer <jwt>` + `X-Api-Token: <token>`; on 401 it renews the guest JWT and
  retries. `TXLINE_API_ORIGIN` **must match the network the credentials were activated on**
  (mainnet `https://txline.txodds.com` / devnet `https://txline-dev.txodds.com`).
- **`DemoSource`** — replays `fixtures/demo_match.jsonl` (a scripted 0-0 → 1-0 68' → 1-1 84'
  match) on a compressed ~6-minute clock. Enabled by `DEMO_MODE=true`, zero external creds.
- **`SimRegistry`** — per-fixture live simulations. `RoutedSource` routes demo fixture ids to
  the simulator and everything else to the base source, so a simulated match can run
  **alongside** real ones (a sim writes to a derived demo fixture row, never over live data).

All three normalize into the same internal types (`NormFixture`, `NormOdds`,
`NormMatchState`) via `txline/normalize.py`, so every downstream engine runs identically.

---

## On-chain receipts

`backend/app/receipts.py` + `chain/scripts/commit-receipt.ts`. On every market open and
settle, the Brain builds a receipt JSON `{market_id, fixture, question, outcomes,
prices_or_evidence, ts}`, and a background thread shells out to the TS committer which
sha256-hashes it and writes the hash into a Solana **Memo** instruction. The tx signature is
stored on the market row (`receipt_open_sig` / `receipt_settle_sig`); the frontend links to
`explorer.solana.com/tx/<sig>`.

**Fire-and-forget with 3 retries.** A Solana outage never blocks settlement — after 3 failed
attempts the signature is left `null`, the failure (and content hash) is logged, and the
match goes on.

---

## Auth

`backend/app/auth.py`.

- **With `PRIVY_APP_ID` set** — the frontend uses the Privy SDK; the backend verifies the
  access token (ES256) against Privy's JWKS. This path **wins outright**: if the env var is
  set, a dev token is rejected even in demo mode.
- **Without it (zero-credential demo)** — the client sends `Authorization: Bearer dev:<handle>`;
  the backend upserts the user and credits the signup bonus once.

Either way, the first verified request upserts the user (`ensure_user`) and credits 1,000
chips exactly once.

---

## Telegram bot

`backend/app/telegram/`. aiogram v3, long-polling, in-process. Polling (not webhooks)
because the free instance sleeps — a dropped webhook is a lost message; polling just resumes
on wake. Blank `TELEGRAM_BOT_TOKEN` disables the bot entirely; a rejected token disables it
gracefully; **the Brain never blocks on Telegram**.

- **Linking** — the web app mints a single-use, 10-minute `TelegramLinkCode`; the bot only
  ever sees the *code*, never a Privy token, so a chat can only bind an account it was
  deliberately handed. Re-linking moves the account to the new chat.
- **Inline betting** — `market_open` outbox rows are broadcast to every linked chat with
  outcome buttons → stake buttons (10/25/50/100) → confirm, all without leaving the chat.
  `callback_data` carries an outcome *index* (Telegram's 64-byte cap). At placement the bot
  quotes the **live** price through `place_bet` and reports what was actually locked.
- **Settlement DMs** — `bet_settled` rows notify the bettor of won/lost/void + new balance.
- **Outbox drain** (`outbox.py`) reads `notification_outbox` out-of-band and paces sends
  (~20/sec) under Telegram's ~30/sec ceiling; obeys `429 retry_after`; unlinks chats that
  blocked the bot. Broadcast-to-all-linked-chats is intentional (there is no follow concept).

---

## Frontend

`frontend/`. Next.js 14 (App Router) + Tailwind + Privy. Pages:

- **`/`** — landing. Live preview strip moving on real (demo) data before sign-in; single
  "Sign in" CTA.
- **`/app`** — the knockout bracket (R32 → F), a pinned **Live Now** card, per-fixture market
  drawer (Markets / Live / History tabs), stake sheet, ticket toasts.
- **`/positions`** — open bets (live quote vs locked odds) + settled ledger.
- **`/leaderboard`** — weekly + all-time; profit, ROI%, hit-rate.

**Design system:** light mode, white/ink base, **yellow = live money moment** (`#FFDE00`,
reserved for live surfaces, primary buttons, in-play bracket nodes). Display face Archivo
Black; body Inter; all numbers in a monospace face with tabular figures. Odds flick
green/red for 400ms; live nodes pulse; settle plays one yellow sweep. Respects
`prefers-reduced-motion`. `NEXT_PUBLIC_PRIVY_APP_ID` blank → dev sign-in.

---

## Configuration

Backend env (`backend/.env.example`) — defaults run fully in demo mode:

| Var | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `sqlite:///./kickr.db` | Supabase Postgres in prod |
| `DEMO_MODE` | `true` | replay `demo_match.jsonl`, no external creds |
| `TXLINE_API_ORIGIN` | `https://txline.txodds.com` | **must match** the credentials' network |
| `TXLINE_JWT` / `TXLINE_API_TOKEN` | — | from `chain/scripts/activate-txline.ts` |
| `PRIVY_APP_ID` | — | blank = dev sign-in; if set, wins over dev tokens |
| `TELEGRAM_BOT_TOKEN` | — | blank disables the bot |
| `SOLANA_RPC` | `https://api.devnet.solana.com` | receipts no-op if `SOLANA_KEYPAIR` blank |
| `SOLANA_KEYPAIR` | — | base58 secret key |
| `ADMIN_KEY` | `kickr-dev-admin` | guards `/api/admin/*` |
| `MARGIN` | `0.05` | pricing overround |

Economy/pricing/market constants (signup bonus, faucet, stake caps, exposure cap, odds
floor/cap, staleness window, max micro markets, demo speed) all live in
`backend/app/config.py`.

Frontend env (`frontend/.env.example`): `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_PRIVY_APP_ID`.

---

## Running locally

Zero external credentials — `DEMO_MODE=true` replays a scripted match; dev sign-in gives
you 1,000 chips.

**Backend**
```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # defaults already run in demo mode
uvicorn app.main:app --reload --port 8000
```

**Frontend**
```bash
cd frontend
npm install
cp .env.example .env.local      # NEXT_PUBLIC_API_URL=http://localhost:8000
npm run dev                     # http://localhost:3000
```

Open http://localhost:3000 → the landing preview is already ticking on demo data. Sign in
with a handle, open the live fixture from the bracket, place a bet on a micro market, and
watch it settle inside ~2 minutes — payout in your balance, receipt link on the settled card.

Restart the replay any time:
```bash
curl -X POST http://localhost:8000/api/admin/demo/restart -H "X-Admin-Key: kickr-dev-admin"
```

Optionally, spin any real fixture into a live simulation alongside real data via
`POST /api/demo/fixtures/{id}/start` (authed).

---

## Tests

```bash
cd backend && python -m pytest -q      # ledger math, double-settlement, pricing, normalizers, engine, telegram bet
cd frontend && npx tsc --noEmit && npm run build
```

`backend/tests/` covers: balance/double-settlement idempotency (`test_ledger.py`), λ
extraction and quoting against hand-computed cases (`test_pricing.py`), the trigger/settle
engine (`test_market_engine.py`), TxLINE normalization (`test_normalize.py`), and the
Telegram inline-bet callback (`test_telegram_bet.py`).

---

## Deployment

- **Backend → Render** (`render.yaml`). Set `DATABASE_URL` to the Supabase Postgres URL, run
  `backend/migrations/001_init.sql` (+ `002_fixture_source.sql`), provide TxLINE + Solana +
  Privy env, set `DEMO_MODE=false`. Start command:
  `uvicorn app.main:app --host 0.0.0.0 --port $PORT`.
- **Frontend → Vercel** (dashboard-linked). Set `NEXT_PUBLIC_API_URL` to the Render URL and
  `NEXT_PUBLIC_PRIVY_APP_ID`.
- **Chain** — run `chain/scripts/activate-txline.ts` once to mint TxLINE credentials on the
  chosen network; deploy the `SOLANA_KEYPAIR` for receipt writes.

A `Dockerfile` is provided for the backend.

---

## Operational notes

- **Telegram and Solana are optional and non-blocking.** No token → bot off; no keypair →
  receipts no-op; either can fail without stopping markets.
- **`TXLINE_API_ORIGIN` must match** the network the JWT/API token were activated on, or
  every data request 401s.
- **Free-tier sleeps.** On Render free the instance sleeps after ~15 min idle; a keepalive
  ping to `/healthz` keeps it warm. Because settlement only runs while a fixture is tracked,
  the stranded-market reaper is what refunds bets on matches the feed abandons during downtime.
- **Historical results read 0-0** for matches that finished before the Brain began polling
  them — the feed is only polled near kickoff, so past scores were never retrieved (a
  backfill would be needed for honest history).
