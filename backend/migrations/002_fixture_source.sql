-- Kickr: per-fixture data source.
-- `live` = the real TxLINE feed; `demo` = a simulated match (app/txline/simulator.py).
-- Demo and live fixtures coexist, so this is per-row rather than a server-wide mode.
--
-- app/db.py applies the same change idempotently at startup for both SQLite and
-- Postgres; this file keeps the canonical Postgres schema in sync.

alter table fixtures add column if not exists source text not null default 'live';
