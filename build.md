# KICKR — build.md (Part 1: Web App)

> In-play micro prediction markets for the 2026 World Cup. Markets spawn and settle inside the 90 minutes, priced live from the TxLINE odds feed, settled from Tx Scores, with settlement receipts committed to Solana devnet.
>
> **Part 1 scope (this document):** backend brain + Supabase ledger + Privy-authed web app with bracket UI. Play-money economy.
> **Part 2 (later, do NOT build now, but leave hooks):** Telegram bot + Telegram Mini App wrapper.

---

## 0. Ground rules for the build

- Monorepo, one fresh GitHub repo:
  ```
  kickr/
  ├── backend/        # FastAPI (Python 3.11+)
  ├── frontend/       # Next.js 14 (App Router) + Tailwind
  ├── chain/          # small Solana devnet receipt committer (TypeScript, called by backend via HTTP or CLI)
  └── README.md
  ```
- Backend deploys to **Render** (web service). Frontend deploys to **Vercel**. Database is **Supabase** (Postgres). Use environment variables for every secret; ship a `.env.example` in each package.
- Everything must run in **demo mode** without live TxLINE credentials (see §9). Never hard-crash if TxLINE is unreachable — degrade to demo/replay data and log loudly.
- Write idempotent, defensive code around money: ledger inserts and settlements run inside DB transactions.
- Part 2 hooks: keep a `notification_outbox` table and a `notify(user_id, event)` no-op service so the Telegram bot can be bolted on without schema changes.

---

## 1. The system in one paragraph

A FastAPI service ("the Brain") maintains a live model of every World Cup fixture using two TxLINE streams: **StablePrice odds snapshots** (1X2, over/unders, Asian handicap for FT/HT) and **Tx Scores** (live score + match clock). A deterministic **template + trigger engine** opens markets (pre-match classics before kickoff; micro markets in-play), prices them by extracting the market-implied goal rate (λ) from TxLINE's live totals odds, locks bets at quoted prices, settles instantly from Tx Scores, pays winners from a play-money ledger in Supabase, and commits a hash receipt of every market open/settle to Solana devnet. A Next.js frontend (Privy auth) renders a landing page, a live tournament bracket, per-fixture market drawers, positions, and a leaderboard.

---

## 2. TxLINE integration (backend/app/txline/)

Docs: https://txline-docs.txodds.com/documentation/quickstart (fetch `https://txline-docs.txodds.com/llms.txt` for the full docs index; also read the World Cup Free Tier page and the Runnable Devnet Examples page before writing this module).

Use the **devnet** environment end to end:

| Item | Value |
|---|---|
| Program ID (devnet) | `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` |
| TxL mint (devnet) | `4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG` |
| Guest auth | `POST https://txline-dev.txodds.com/auth/guest/start` |
| API base | `https://txline-dev.txodds.com/api/` |
| Solana RPC | `https://api.devnet.solana.com` |

Access flow (one-time setup script `chain/scripts/activate-txline.ts`, using their runnable devnet examples as reference):
1. Create/load a devnet keypair; airdrop SOL.
2. `POST /auth/guest/start` → guest JWT.
3. Call the on-chain `subscribe` instruction with a **free World Cup service level (1 or 12)**, `SELECTED_LEAGUES = []`.
4. Sign `${txSig}::${jwt}` (detached, base64) with the same wallet; `POST /api/token/activate` → API token.
5. Store both credentials; the backend sends `Authorization: Bearer <jwt>` + `X-Api-Token: <token>` on data requests. On any 401, renew the guest JWT from the same host and retry with the same API token.

Backend polling loop (APScheduler):
- `fixtures` refresh: every 10 min.
- Odds snapshots: every 20–30 s per tracked fixture pre-match; every 10–15 s in-play.
- Scores: every 5–10 s in-play only.
- Cache aggressively; never hammer the API (remember the API-Football suspension). One shared HTTP client, backoff on errors.
- Normalize everything into internal types: `Fixture`, `OddsSnapshot {market, line, prices, ts}`, `MatchState {status, score_home, score_away, minute, ts}`.
- Persist raw snapshots to an `odds_snapshots` table (needed for replay mode and the divergence history).

---

## 3. Pricing engine (backend/app/pricing/)

All prices derive from TxLINE. No proprietary model as source of truth.

**3.1 Implied probabilities.** From decimal odds: `p_raw = 1/odds`; de-vig a market by normalizing `p_i = p_raw_i / Σ p_raw`.

**3.2 Market-implied goal rate.** From the live/pre-match Over/Under (main total line L, de-vigged P(over)):
- Solve for total remaining expected goals `λ_rem` such that `P(Poisson(λ_rem) > L − goals_so_far) = P_over`. Solve numerically (bisection over λ ∈ [0.01, 8]).
- Pre-match: `λ_rem = λ_match`. In-play: this automatically bakes in time decay because the live total line/prices move with the clock.
- Split λ between teams using the de-vigged 1X2 or Asian handicap skew: `λ_home = λ_rem · s`, `λ_away = λ_rem · (1−s)` where `s` is derived from the win-prob skew (simple monotone mapping; document the function; clamp s ∈ [0.2, 0.8]).

**3.3 Interval probability (the micro-market core).** P(≥1 goal in the next `m` minutes) = `1 − exp(−λ_rem · m / minutes_remaining_effective)`. Use `minutes_remaining_effective = max(90 − minute, 1)` plus a flat +4 stoppage allowance after minute 80.

**3.4 Quoting.** Fair prob → quoted decimal odds with margin: `odds_quoted = 1 / (p_fair · (1 + MARGIN))`, `MARGIN = 0.05` total overround split across outcomes. Floor odds at 1.05, cap at 15.0. Round to 2 dp.

**3.5 Staleness rule.** If the newest odds snapshot for a fixture is older than 90 s in-play, suspend all its open markets (`status = suspended`, no bets accepted) until fresh data arrives.

---

## 4. Market templates + triggers (backend/app/markets/)

Deterministic rules engine. No LLM anywhere in the market path.

Every market row carries: `template_id`, `fixture_id`, `question`, `outcomes` (2–3), `opens_at`, `locks_at`, `settle_rule` (machine-readable), `status` (open | suspended | locked | settled | voided), quoted prices per outcome (refreshed on each pricing tick until lock).

**Pre-match templates (open when fixture appears with odds; lock at kickoff; settle at FT):**
| ID | Question | Outcomes | Pricing |
|---|---|---|---|
| PM1 | Match result | Home / Draw / Away | de-vigged TxLINE 1X2 + margin |
| PM2 | Over/Under {main line} goals | Over / Under | TxLINE totals + margin |
| PM3 | {Favorite} covers {AH line} | Yes / No | TxLINE Asian handicap + margin |
| PM4 | Both halves see a goal | Yes / No | from λ split across halves (0.45/0.55 weighting) |

**In-play micro templates:**
| ID | Trigger | Question | Locks | Settles |
|---|---|---|---|---|
| M1 | kickoff | Goal before 25:00? | min 25 or on goal | first goal ts or clock |
| M2 | any goal scored | Another goal before {minute+20}? | window end or on goal | scores feed |
| M3 | HT | More goals in 2nd half than 1st? | FT approach (min 85) → settle FT | FT score |
| M4 | min 55, any score | Goal in the next 15:00? | window end or on goal | scores feed |
| M5 | min 70, score level | Winner decided in regulation? (knockouts) | min 90 | FT score |
| M6 | min 70, 0-0 | Does this finish 0-0? | min 88 | FT score |
| M7 | goal makes it a 1-goal lead after min 60 | {Trailing team} equalizes? | min 90 | FT score |
| M8 | red card event (if derivable from odds shock: >15% 1X2 swing in one snapshot) | Score changes from here? | min 90 | scores feed |

Rules: max 4 micro markets open per fixture simultaneously; a goal instantly locks+settles all goal-window markets it decides, then the trigger table runs again on the new state. Every settlement is idempotent (unique constraint on `market_id` in `settlements`). If a fixture is abandoned or data is unresolvable, void the market and refund stakes.

---

## 5. Economy + ledger (Supabase)

Play-money chips. Users bet against the house at firm quoted odds.

Tables (SQL migration file in `backend/migrations/`):
- `users` — id (uuid), privy_did (unique), handle, created_at, telegram_chat_id (nullable — Part 2 hook)
- `transactions` — append-only ledger: id, user_id, amount (+/-), kind (signup_bonus | faucet | bet_stake | bet_payout | refund | reset), ref_id, created_at. **Balance = SUM(amount); expose as a view `balances`.**
- `fixtures` — mirror of TxLINE fixtures + bracket metadata: id, txline_fixture_id, stage (group|r32|r16|qf|sf|f), bracket_slot, home, away, kickoff_at, status, score_home, score_away, minute
- `odds_snapshots` — fixture_id, market_type, line, payload (jsonb), ts
- `markets` — as in §4, plus `receipt_open_sig`, `receipt_settle_sig` (Solana tx signatures)
- `bets` — id, user_id, market_id, outcome, stake, odds_locked, potential_payout, status (open | won | lost | voided), created_at
- `settlements` — market_id (unique), winning_outcome, settled_at, evidence (jsonb: score/minute snapshot)
- `notification_outbox` — Part 2 hook: user_id, event_type, payload, created_at, sent_at (nullable). Write to it on: market_open (for followed fixtures), bet_settled. Nothing consumes it yet.

Economy rules (constants in one config file):
- Signup bonus 1,000 chips; daily faucet +200 (one claim per UTC day); bust-reset to 100 once per UTC day if balance < 10.
- Max stake per bet: 500. Max house exposure per market: 20,000 potential payout — beyond that, suspend the outcome.
- Odds locked at placement (stored on the bet). Quote validity: a placed bet is accepted only if the odds the client sent match the current quote within 2%; otherwise reject with a re-quote payload.
- Settlement pays winners in one transaction: insert settlement → update bets → insert payout ledger rows.

---

## 6. Solana devnet receipts (chain/)

Minimal TypeScript service (or script invoked by backend) using `@solana/web3.js`:
- On market open and market settle, build a JSON receipt `{market_id, fixture, question, outcomes/result, prices_or_evidence, ts}`, hash it (sha256), and send a devnet transaction with the hash in a Memo instruction from the Kickr keypair.
- Store the tx signature on the market row; frontend links to `https://explorer.solana.com/tx/<sig>?cluster=devnet`.
- Fire-and-forget with retry queue; a Solana outage must never block settlement. If it fails 3×, store `receipt_*_sig = null` and continue.

---

## 7. Backend API (FastAPI)

Auth: verify Privy access token (JWT via Privy JWKS; `PRIVY_APP_ID` env) on all `/me` and `/bets` routes; upsert user on first verified request (credit signup bonus once).

Routes:
- `GET /api/bracket` — all fixtures with stage/slot, live state, headline win probs (de-vigged 1X2), counts of open markets
- `GET /api/fixtures/{id}/markets` — open/suspended/locked markets with live quotes; `?include=settled` for history tab
- `POST /api/bets` — {market_id, outcome, stake, odds_seen} → validates quote freshness, balance, limits; returns ticket
- `GET /api/me` — profile, balance, open positions, recent results
- `POST /api/me/faucet`, `POST /api/me/reset`
- `GET /api/leaderboard` — profit, ROI%, hit-rate; weekly window + all-time
- `GET /api/markets/{id}/receipt` — receipt JSON + explorer links
- `WS /ws` (or SSE `/api/stream`) — pushes: market_open, price_update, market_locked, market_settled, score_update. Frontend subscribes once, filters client-side. Prefer SSE for Render friendliness.

---

## 8. Frontend (Next.js 14 + Tailwind + Privy)

### 8.1 Design system — read carefully

Light mode. **Palette (locked):**
- `--kickr-yellow: #FFDE00` (primary — vivid matchday/highlighter yellow)
- `--kickr-yellow-deep: #EAB700` (hover/pressed, borders on yellow)
- `--white: #FFFFFF` (base background)
- `--pitch-ink: #101314` (near-black text)
- `--line-grey: #E7E5DC` (hairlines, card borders)
- `--live-red: #E5484D` (live pulse dot + settling states only)
- Win/loss ticks: green `#1F9D55` / red `#E5484D`, used only on numbers.

Yellow is the *signature*, not the wallpaper: white pages, ink text, yellow reserved for the live-now surfaces, primary buttons, the live ticker strip, and bracket nodes that are currently in-play. A page should read calm white/ink until something is LIVE — then yellow screams exactly where the action is. That is the design thesis: **yellow = live money moment.**

Typography: display face **Archivo Black** (or Archivo Expanded 800) for headlines and the wordmark "kickr" (lowercase); body **Inter**; all odds, clocks, balances and ledger numbers in **JetBrains Mono** with tabular figures. Numbers never use the display face.

Motion: odds changes flick green/red for 400 ms; live bracket nodes carry a 2 s pulsing dot; market settle plays a single yellow sweep across the card. Respect `prefers-reduced-motion`. No other animation.

### 8.2 Pages

**/ (Landing, logged out):**
- Thin nav: wordmark left, "Sign in" button (yellow) right → opens Privy modal.
- Hero: headline "Markets that live inside the match." Sub: "Micro prediction markets on every World Cup fixture — priced live, settled in seconds, receipts on-chain." One primary CTA "Start with 1,000 free chips" (opens Privy).
- Below the fold: a **live preview strip** — real data, no auth needed: the current/next fixture with 2 live market cards (read-only quotes ticking via the stream). Judges should see the product move before signing in.
- Footer strip: markets settled count · active markets now · link to a sample Solana receipt.

**/app (Authed home = the bracket):**
- Top bar: wordmark, balance (mono, chip icon), faucet button when claimable, avatar menu (positions, leaderboard, sign out).
- **Live Now card** pinned on top when any fixture is in-play: score, clock, and up to 3 hottest open micro markets with tappable Yes/No quote buttons. If nothing is live: "Next kickoff in HH:MM:SS" countdown + that fixture's pre-match markets.
- **The bracket**: the 2026 knockout tree (R32 → R16 → QF → SF → F), horizontally scrollable on mobile, full-width on desktop. Node states: upcoming (kickoff time + favorite's win % drifting), live (yellow fill, pulse dot, score+minute), finished (dimmed, final score). Group stage lives in a secondary tab as a simple fixture list — the tree is the star.
- Tap node → **bottom-sheet drawer** (mobile) / side panel (desktop), tabs: **Markets** (open + locked, live quotes; tap outcome → stake sheet with 25/50/100/250/custom quick amounts → confirm → ticket toast) · **Live** (score timeline + win-prob spark line from snapshots) · **History** (settled markets with result, evidence, and receipt link → Solana explorer).
- Bet placement handles the two race cases explicitly: quote moved (>2%) → inline re-quote; market locked between render and tap → friendly "Settled — {evidence}" state, never a raw error.

**/positions** — open bets (with live quote vs locked odds), settled bets ledger.
**/leaderboard** — weekly + all-time; profit, ROI%, hit-rate columns, mono numbers.

Seed the bracket structure from a static JSON of the 2026 knockout slots mapped to TxLINE fixture IDs (script to generate it from the fixtures endpoint).

---

## 9. Demo / replay mode (required)

`DEMO_MODE=true` env flag: instead of TxLINE, the Brain replays a recorded fixture from `backend/fixtures/demo_match.jsonl` (a scripted sequence of odds snapshots + score events over a compressed 6-minute clock). All engines (triggers, pricing, settlement, receipts, stream) run identically. Ship one hand-authored demo match (0-0 → 1-0 68' → 1-1 84' with plausible odds paths) so the full product can be demonstrated at any hour and used for the submission video. A `POST /api/admin/demo/restart` (guarded by `ADMIN_KEY`) restarts the replay.

---

## 10. Env vars

Backend: `DATABASE_URL`, `TXLINE_API_ORIGIN=https://txline-dev.txodds.com`, `TXLINE_JWT`, `TXLINE_API_TOKEN`, `PRIVY_APP_ID`, `SOLANA_RPC=https://api.devnet.solana.com`, `SOLANA_KEYPAIR` (base58), `DEMO_MODE`, `ADMIN_KEY`, `MARGIN=0.05`.
Frontend: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_PRIVY_APP_ID`.

---

## 11. Build order (for this one-shot)

1. Migrations + models + ledger service (with tests for double-settlement and balance math).
2. TxLINE client + normalizers + snapshot persistence + demo replay source behind one interface.
3. Pricing engine (λ extraction, interval probs, quoting) — unit tests against hand-computed cases.
4. Template/trigger engine + settlement + receipts queue.
5. API + SSE stream + Privy verification.
6. Frontend: design tokens → landing → bracket/app → drawer/bet flow → positions/leaderboard.
7. Wire demo mode end-to-end; seed demo match; README with run instructions (local + Render/Vercel deploy notes).

**Definition of done:** with `DEMO_MODE=true` and zero external credentials, `docker compose up` (or two `npm run dev`/`uvicorn` processes) shows the landing page with a moving live preview; a Privy-authed user receives 1,000 chips, opens the demo fixture from the bracket, places a bet on a micro market, watches it settle inside two minutes, sees the payout in their balance and the receipt link on the settled market.

---

## Part 2 (do not build now)

Telegram bot (aiogram): consumes `notification_outbox`, deep-link account linking via one-time codes bound to Privy DID, inline Yes/No + stake buttons, and the Next.js app re-served as a Telegram Mini App. The schema and outbox above already support all of it.
