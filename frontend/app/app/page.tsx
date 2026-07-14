"use client";

/** Authed home = the bracket (build.md §8.2), dark system.
 *  - Live Now hero card pinned when a fixture is in-play (or next-kickoff countdown).
 *  - The 2026 knockout tree (interactive node cards) + a group-stage tab.
 *  - Tap a node -> drawer with Markets / Live / History tabs and the stake flow.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmtClock, subscribeStream } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { AppNav } from "@/components/Nav";
import { Bracket, GroupList, FixtureT } from "@/components/Bracket";
import { MarketCard, MarketT } from "@/components/MarketCard";
import { StakeSheet } from "@/components/StakeSheet";
import { LivePill, Toast } from "@/components/shared";

export default function AppHome() {
  const { authed, ready, getToken } = useAuth();
  const [me, setMe] = useState<any>(null);
  const [fixtures, setFixtures] = useState<FixtureT[]>([]);
  const [tab, setTab] = useState<"bracket" | "group">("bracket");
  const [open, setOpen] = useState<FixtureT | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (ready && !authed) location.href = "/";
  }, [ready, authed]);

  const loadMe = useCallback(async () => {
    try {
      setMe(await api("/me", {}, await getToken()));
    } catch {}
  }, [getToken]);

  const loadBracket = useCallback(async () => {
    try {
      const br = await api("/bracket");
      setFixtures(br.fixtures);
    } catch {}
  }, []);

  useEffect(() => {
    if (!ready || !authed) return;
    loadMe();
    loadBracket();
    const unsub = subscribeStream((ev) => {
      if (["market_open", "market_locked", "market_settled", "score_update", "demo_restarted"].includes(ev.event)) {
        loadBracket();
      }
      if (ev.event === "market_settled") loadMe();
    });
    const t = setInterval(loadBracket, 10000);
    return () => {
      unsub();
      clearInterval(t);
    };
  }, [ready, authed, loadMe, loadBracket]);

  useEffect(() => {
    if (!open) return;
    const fresh = fixtures.find((f) => f.id === open.id);
    if (fresh) setOpen(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixtures]);

  const liveFixtures = useMemo(() => fixtures.filter((f) => f.status === "live"), [fixtures]);
  const nextFixture = useMemo(
    () =>
      fixtures
        .filter((f) => f.status === "upcoming" && f.kickoff_at)
        .sort((a, b) => a.kickoff_at.localeCompare(b.kickoff_at))[0] ?? null,
    [fixtures]
  );

  async function faucet() {
    try {
      await api("/me/faucet", { method: "POST" }, await getToken());
      setToast("+200 chips claimed");
      loadMe();
    } catch {
      setToast("Faucet already claimed today");
    }
  }

  const bracketFixtures = fixtures.filter((f) => f.stage !== "group");
  const hasGroup = fixtures.some((f) => f.stage === "group");

  if (!ready || !authed) return null;

  return (
    <div className="min-h-screen bg-kickr-navy text-kickr-cream">
      <AppNav me={me} onFaucet={faucet} />

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <LiveNow live={liveFixtures} next={nextFixture} onOpen={setOpen} />

        {/* tabs */}
        <div className="mb-5 mt-10 flex items-center gap-2">
          <TabButton active={tab === "bracket"} onClick={() => setTab("bracket")}>
            Bracket
          </TabButton>
          {hasGroup && (
            <TabButton active={tab === "group"} onClick={() => setTab("group")}>
              Group stage
            </TabButton>
          )}
        </div>

        {tab === "bracket" ? (
          bracketFixtures.length ? (
            <Bracket fixtures={bracketFixtures} onOpen={setOpen} />
          ) : (
            <EmptyState>Knockout fixtures appear here once the draw is set.</EmptyState>
          )
        ) : (
          <GroupList fixtures={fixtures} onOpen={setOpen} />
        )}
      </main>

      {open && (
        <FixtureDrawer
          fixture={open}
          onClose={() => setOpen(null)}
          onBetPlaced={(t) => {
            setToast(`Ticket: ${t.ticket.stake} on ${t.ticket.outcome} @ ${t.ticket.odds_locked.toFixed(2)}`);
            loadMe();
          }}
        />
      )}

      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-kickr-navy-line py-16 text-center text-sm text-kickr-cream-dim">
      {children}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
        active
          ? "bg-kickr-yellow text-kickr-navy"
          : "border border-kickr-navy-line text-kickr-cream-dim hover:border-kickr-yellow/40 hover:text-kickr-cream"
      }`}
    >
      {children}
    </button>
  );
}

// --------------------------------------------------------------- Live Now card
function LiveNow({
  live,
  next,
  onOpen,
}: {
  live: FixtureT[];
  next: FixtureT | null;
  onOpen: (f: FixtureT) => void;
}) {
  if (live.length > 0) {
    return (
      <div className="grid gap-5">
        {live.map((f) => (
          <LiveFixtureCard key={f.id} f={f} onOpen={onOpen} />
        ))}
      </div>
    );
  }
  if (next) return <NextKickoff f={next} onOpen={onOpen} />;
  return <EmptyState>No fixtures scheduled right now.</EmptyState>;
}

function LiveFixtureCard({ f, onOpen }: { f: FixtureT; onOpen: (f: FixtureT) => void }) {
  const [markets, setMarkets] = useState<MarketT[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api(`/fixtures/${f.id}/markets`)
        .then((r) => alive && setMarkets(r.markets))
        .catch(() => {});
    load();
    const unsub = subscribeStream((ev) => {
      if (ev.fixture_id === f.id || ev.event === "price_update") load();
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [f.id]);

  const hot = markets.filter((m) => m.status === "open").slice(0, 3);

  return (
    <div className="relative overflow-hidden rounded-3xl border border-kickr-yellow/40 bg-kickr-navy-surface shadow-live-glow">
      {/* live glow wash */}
      <div className="pointer-events-none absolute -top-24 right-0 h-48 w-2/3 bg-kickr-yellow/10 blur-3xl" />

      <div className="relative flex flex-wrap items-center justify-between gap-4 border-b border-kickr-navy-line px-6 py-5">
        <div className="flex items-center gap-4">
          <LivePill minute={f.minute} />
          <button onClick={() => onOpen(f)} className="text-left">
            <span className="font-display text-2xl text-kickr-cream sm:text-3xl">
              {f.home} <span className="num text-kickr-yellow">{f.score.join("–")}</span> {f.away}
            </span>
          </button>
        </div>
        <button
          onClick={() => onOpen(f)}
          className="rounded-full bg-kickr-yellow px-4 py-2 text-sm font-bold text-kickr-navy transition-transform hover:-translate-y-0.5 active:translate-y-0"
        >
          Open all markets →
        </button>
      </div>

      <div className="relative grid gap-3 p-5 sm:grid-cols-3">
        {hot.length ? (
          hot.map((m) => <MarketCard key={m.id} market={m} onPick={() => onOpen(f)} />)
        ) : (
          <p className="py-6 text-center text-sm text-kickr-cream-dim sm:col-span-3">
            New micro markets open on the next goal…
          </p>
        )}
      </div>
    </div>
  );
}

function NextKickoff({ f, onOpen }: { f: FixtureT; onOpen: (f: FixtureT) => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.floor((new Date(f.kickoff_at).getTime() - now) / 1000));
  return (
    <button
      onClick={() => onOpen(f)}
      className="block w-full rounded-3xl border border-kickr-navy-line bg-kickr-navy-surface p-6 text-left transition-colors hover:border-kickr-yellow/40"
    >
      <p className="text-xs font-semibold uppercase tracking-[0.15em] text-kickr-cream-dim">Next kickoff</p>
      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-3">
        <span className="font-display text-2xl text-kickr-cream">
          {f.home} <span className="text-kickr-cream-dim">v</span> {f.away}
        </span>
        <span className="num text-4xl font-bold text-kickr-yellow">{fmtClock(secs)}</span>
      </div>
      <p className="mt-2 text-sm text-kickr-cream-dim">Tap for pre-match markets →</p>
    </button>
  );
}

// ------------------------------------------------------------- Fixture drawer
type DrawerTab = "markets" | "live" | "history";

function FixtureDrawer({
  fixture,
  onClose,
  onBetPlaced,
}: {
  fixture: FixtureT;
  onClose: () => void;
  onBetPlaced: (ticket: any) => void;
}) {
  const [tab, setTab] = useState<DrawerTab>("markets");
  const [markets, setMarkets] = useState<MarketT[]>([]);
  const [pick, setPick] = useState<{ market: MarketT; outcome: string } | null>(null);
  const [settledIds, setSettledIds] = useState<Set<string>>(new Set());
  const prevStatuses = useRef<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const r = await api(`/fixtures/${fixture.id}/markets?include=settled`);
      const next: MarketT[] = r.markets;
      const newlySettled = new Set<string>();
      for (const m of next) {
        const prev = prevStatuses.current[m.id];
        if (prev && prev !== "settled" && prev !== "voided" && (m.status === "settled" || m.status === "voided")) {
          newlySettled.add(m.id);
        }
        prevStatuses.current[m.id] = m.status;
      }
      if (newlySettled.size) {
        setSettledIds(newlySettled);
        setTimeout(() => setSettledIds(new Set()), 1000);
      }
      setMarkets(next);
    } catch {}
  }, [fixture.id]);

  useEffect(() => {
    load();
    const unsub = subscribeStream((ev) => {
      if (ev.fixture_id === fixture.id || ev.event === "price_update") load();
    });
    return () => unsub();
  }, [fixture.id, load]);

  const live = markets.filter((m) => ["open", "suspended", "locked"].includes(m.status));
  const history = markets.filter((m) => ["settled", "voided"].includes(m.status));

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-stretch sm:justify-end"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full flex-col rounded-t-3xl border border-kickr-navy-line bg-kickr-navy sm:max-h-full sm:w-[30rem] sm:rounded-none sm:border-l"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-start justify-between border-b border-kickr-navy-line px-5 py-4">
          <div>
            <div className="flex items-center gap-2">
              {fixture.status === "live" && <LivePill minute={fixture.minute} />}
              <h2 className="font-display text-lg text-kickr-cream">
                {fixture.home}{" "}
                {(fixture.status === "live" || fixture.status === "finished") && (
                  <span className="num text-kickr-yellow">{fixture.score.join("–")}</span>
                )}{" "}
                {fixture.away}
              </h2>
            </div>
            <p className="mt-1 text-xs uppercase tracking-wide text-kickr-cream-dim">
              {fixture.stage} · {fixture.status}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-kickr-cream-dim hover:bg-kickr-navy-surface hover:text-kickr-cream"
            aria-label="close"
          >
            ✕
          </button>
        </div>

        {/* tabs */}
        <div className="flex border-b border-kickr-navy-line px-2">
          {(["markets", "live", "history"] as DrawerTab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-2.5 text-sm font-semibold capitalize transition-colors ${
                tab === t ? "border-b-2 border-kickr-yellow text-kickr-cream" : "text-kickr-cream-dim hover:text-kickr-cream"
              }`}
            >
              {t}
              {t === "history" && history.length > 0 && <span className="num ml-1 text-xs">({history.length})</span>}
            </button>
          ))}
        </div>

        {/* body */}
        <div className="flex-1 overflow-y-auto p-4">
          {tab === "markets" && (
            <div className="grid gap-3">
              {live.length ? (
                live.map((m) => (
                  <MarketCard
                    key={m.id}
                    market={m}
                    justSettled={settledIds.has(m.id)}
                    onPick={(outcome) => setPick({ market: m, outcome })}
                  />
                ))
              ) : (
                <p className="py-10 text-center text-sm text-kickr-cream-dim">
                  No open markets. Micro markets spawn on kickoff and after each goal.
                </p>
              )}
            </div>
          )}

          {tab === "live" && <LiveTab fixture={fixture} />}

          {tab === "history" && (
            <div className="grid gap-3">
              {history.length ? (
                history.map((m) => <MarketCard key={m.id} market={m} justSettled={settledIds.has(m.id)} />)
              ) : (
                <p className="py-10 text-center text-sm text-kickr-cream-dim">No settled markets yet.</p>
              )}
            </div>
          )}
        </div>
      </div>

      {pick && (
        <StakeSheet
          market={pick.market}
          outcome={pick.outcome}
          onClose={() => setPick(null)}
          onPlaced={(t) => {
            setPick(null);
            onBetPlaced(t);
            load();
          }}
        />
      )}
    </div>
  );
}

function LiveTab({ fixture }: { fixture: FixtureT }) {
  const probs = fixture.win_probs;
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-kickr-navy-line bg-kickr-navy-surface p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-kickr-cream-dim">Score</p>
        <div className="mt-2 flex items-center justify-between font-display text-2xl text-kickr-cream">
          <span className="truncate">{fixture.home}</span>
          <span className="num shrink-0 px-3 text-kickr-yellow">
            {fixture.status === "upcoming" ? "–" : fixture.score[0]}
            {" : "}
            {fixture.status === "upcoming" ? "–" : fixture.score[1]}
          </span>
          <span className="truncate text-right">{fixture.away}</span>
        </div>
        {fixture.status === "live" && (
          <p className="num mt-2 text-center text-sm text-kickr-cream-dim">{fixture.minute}&prime;</p>
        )}
      </div>

      {probs ? (
        <div className="rounded-2xl border border-kickr-navy-line bg-kickr-navy-surface p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-kickr-cream-dim">
            Win probability (de-vigged 1X2)
          </p>
          <div className="mt-3 space-y-3">
            {[
              { label: fixture.home, key: "home" },
              { label: "Draw", key: "draw" },
              { label: fixture.away, key: "away" },
            ].map((row) => {
              const p = (probs as any)[row.key] ?? 0;
              return (
                <div key={row.key}>
                  <div className="flex justify-between text-sm text-kickr-cream/90">
                    <span>{row.label}</span>
                    <span className="num">{Math.round(p * 100)}%</span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-kickr-navy">
                    <div className="h-full rounded-full bg-kickr-yellow" style={{ width: `${Math.round(p * 100)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="py-6 text-center text-sm text-kickr-cream-dim">Win probabilities appear once odds are flowing.</p>
      )}
    </div>
  );
}
