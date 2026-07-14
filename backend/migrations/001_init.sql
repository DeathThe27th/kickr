-- Kickr schema (build.md §5) — canonical Postgres/Supabase migration.
-- The SQLite demo database is created from the ORM metadata; keep in sync.

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  privy_did text unique not null,
  handle text not null,
  created_at timestamptz not null default now(),
  telegram_chat_id text -- Part 2 hook
);

-- Append-only ledger. Balance = SUM(amount).
create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  amount integer not null,
  kind text not null check (kind in ('signup_bonus','faucet','bet_stake','bet_payout','refund','reset')),
  ref_id text,
  created_at timestamptz not null default now()
);
create index if not exists ix_transactions_user on transactions(user_id);

create or replace view balances as
  select user_id, coalesce(sum(amount), 0) as balance
  from transactions group by user_id;

create table if not exists fixtures (
  id uuid primary key default gen_random_uuid(),
  txline_fixture_id bigint unique not null,
  stage text not null default 'group' check (stage in ('group','r32','r16','qf','sf','f')),
  bracket_slot text,
  home text not null,
  away text not null,
  kickoff_at timestamptz not null,
  status text not null default 'upcoming' check (status in ('upcoming','live','finished')),
  score_home integer not null default 0,
  score_away integer not null default 0,
  minute integer not null default 0
);

create table if not exists odds_snapshots (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references fixtures(id),
  market_type text not null,
  line double precision,
  payload jsonb not null,
  ts timestamptz not null default now()
);
create index if not exists ix_snapshots_fixture_ts on odds_snapshots(fixture_id, ts);

create table if not exists markets (
  id uuid primary key default gen_random_uuid(),
  template_id text not null,
  fixture_id uuid not null references fixtures(id),
  question text not null,
  outcomes jsonb not null,
  prices jsonb not null default '{}',
  opens_at timestamptz not null default now(),
  locks_at timestamptz,
  settle_rule jsonb not null,
  status text not null default 'open' check (status in ('open','suspended','locked','settled','voided')),
  receipt_open_sig text,
  receipt_settle_sig text,
  cycle integer not null default 0, -- demo replay cycle (§9); always 0 in real mode
  created_at timestamptz not null default now(),
  constraint uq_market_instance unique (fixture_id, template_id, question, cycle)
);
create index if not exists ix_markets_fixture_status on markets(fixture_id, status);

create table if not exists bets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  market_id uuid not null references markets(id),
  outcome text not null,
  stake integer not null,
  odds_locked double precision not null,
  potential_payout integer not null,
  status text not null default 'open' check (status in ('open','won','lost','voided')),
  created_at timestamptz not null default now()
);
create index if not exists ix_bets_user on bets(user_id);
create index if not exists ix_bets_market on bets(market_id);

-- unique market_id => double settlement is impossible (build.md §4)
create table if not exists settlements (
  id uuid primary key default gen_random_uuid(),
  market_id uuid unique not null references markets(id),
  winning_outcome text, -- null = voided
  settled_at timestamptz not null default now(),
  evidence jsonb not null default '{}'
);

-- Part 2 hook: written on market_open / bet_settled, consumed by nothing yet.
create table if not exists notification_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  event_type text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
