"use client";

/** Authed home = the bracket (build.md §8.2).
 *  - Live Now card pinned when any fixture is in-play (or next-kickoff countdown).
 *  - The 2026 knockout tree (bracket) + a group-stage tab.
 *  - Tap a node -> drawer with Markets / Live / History tabs and the stake flow.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmtClock, subscribeStream } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { AppNav } from "@/components/Nav";
import { Bracket, GroupList, FixtureT } from "@/components/Bracket";
import { MarketCard, MarketT } from "@/components/MarketCard";
import { StakeSheet } from "@/components/StakeSheet";
import { LivePill, Toast, Wordmark } from "@/components/shared";

export default function AppHome() {
  const { authed, ready, getToken, login } = useAuth();
  const [me, setMe] = useState<any>(null);
  const [fixtures, setFixtures] = useState<FixtureT[]>([]);
  const [tab, setTab] = useState<"bracket" | "group">("bracket");
  const [open, setOpen] = useState<FixtureT | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // ---- gate: redirect to landing if not signed in
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
      if (ev.event === "market_settled") loadMe(); // payouts may have landed
    });
    const t = setInterval(loadBracket, 10000);
    return () => {
      unsub();
      clearInterval(t);
    };
  }, [ready, authed, loadMe, loadBracket]);

  // keep the open drawer's fixture object fresh as the bracket updates
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
    <div className="min-h-screen bg-white">
      <AppNav me={me} onFaucet={faucet} />

      <main className="mx-auto max-w-6xl px-4 py-6">
        <LiveNow
          live={liveFixtures}
          next={nextFixture}
          onOpen={setOpen}
          onPick={() => {}}
        />

        {/* tabs */}
        <div className="mb-4 mt-8 flex items-center gap-2">
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
            <p className="py-12 text-center text-sm text-kickr-ink/50">
              Knockout fixtures appear here once the draw is set.
            </p>
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

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
        active ? "bg-kickr-ink text-white" : "border border-kickr-line text-kickr-ink/70 hover:border-kickr-yellow-deep"
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
  onPick: () => void;
}) {
  if (live.length > 0) {
    return (
      <div className="grid gap-4">
        {live.map((f) => (
          <LiveFixtureCard key={f.id} f={f} onOpen={onOpen} />
        ))}
      </div>
    );
  }
  if (next) return <NextKickoff f={next} onOpen={onOpen} />;
  return (
    <div className="rounded-2xl border border-kickr-line p-6 text-center text-sm text-kickr-ink/50">
      No fixtures scheduled right now.
    </div>
  );
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
    <div className="rounded-2xl border border-kickr-yellow-deep bg-kickr-yellow/20 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <LivePill minute={f.minute} />
          <button onClick={() => onOpen(f)} className="font-display text-xl hover:underline">
            {f.home} <span className="num">{f.score.join("–")}</span> {f.away}
          </button>
        </div>
        <button
          onClick={() => onOpen(f)}
          className="rounded-full bg-kickr-ink px-3 py-1 text-sm font-semibold text-kickr-yellow"
        >
          Open all markets →
        </button>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {hot.length ? (
          hot.map((m) => <MarketCard key={m.id} market={m} onPick={() => onOpen(f)} />)
        ) : (
          <p className="text-sm text-kickr-ink/60">New micro markets open on the next goal…</p>
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
      className="block w-full rounded-2xl border border-kickr-line p-6 text-left hover:border-kickr-yellow-deep"
    >
      <p className="text-xs font-semibold uppercase tracking-widest text-kickr-ink/50">Next kickoff</p>
      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-3">
        <span className="font-display text-xl">
          {f.home} <span className="text-kickr-ink/40">vs</span> {f.away}
        </span>
        <span className="num text-3xl font-bold">{fmtClock(secs)}</span>
      </div>
      <p className="mt-1 text-sm text-kickr-ink/60">Tap for pre-match markets →</p>
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
      // detect fresh settlements for the yellow sweep
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
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-kickr-ink/40 sm:items-stretch sm:justify-end" onClick={onClose}>
      <div
        className="flex max-h-[92vh] w-full flex-col rounded-t-2xl border border-kickr-line bg-white sm:max-h-full sm:w-[28rem] sm:rounded-none sm:border-l"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-start justify-between border-b border-kickr-line p-4">
          <div>
            <div className="flex items-center gap-2">
              {fixture.status === "live" && <LivePill minute={fixture.minute} />}
              <h2 className="font-display text-lg">
                {fixture.home} {(fixture.status === "live" || fixture.status === "finished") && (
                  <span className="num">{fixture.score.join("–")}</span>
                )}{" "}
                {fixture.away}
              </h2>
            </div>
            <p className="mt-0.5 text-xs uppercase tracking-wide text-kickr-ink/50">
              {fixture.stage} · {fixture.status}
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-kickr-ink/60 hover:bg-kickr-line/50" aria-label="close">
            ✕
          </button>
        </div>

        {/* tabs */}
        <div className="flex border-b border-kickr-line px-2">
          {(["markets", "live", "history"] as DrawerTab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-2 text-sm font-semibold capitalize ${
                tab === t ? "border-b-2 border-kickr-ink text-kickr-ink" : "text-kickr-ink/50"
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
                <p className="py-8 text-center text-sm text-kickr-ink/50">
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
                <p className="py-8 text-center text-sm text-kickr-ink/50">No settled markets yet.</p>
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
      <div className="rounded-xl border border-kickr-line p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-kickr-ink/50">Score</p>
        <div className="mt-1 flex items-center justify-between font-display text-2xl">
          <span>{fixture.home}</span>
          <span className="num">
            {fixture.status === "upcoming" ? "–" : fixture.score[0]}
            {" : "}
            {fixture.status === "upcoming" ? "–" : fixture.score[1]}
          </span>
          <span>{fixture.away}</span>
        </div>
        {fixture.status === "live" && (
          <p className="num mt-2 text-center text-sm text-kickr-ink/60">{fixture.minute}&prime;</p>
        )}
      </div>

      {probs ? (
        <div className="rounded-xl border border-kickr-line p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-kickr-ink/50">
            Win probability (de-vigged 1X2)
          </p>
          <div className="mt-3 space-y-2">
            {[
              { label: fixture.home, key: "home" },
              { label: "Draw", key: "draw" },
              { label: fixture.away, key: "away" },
            ].map((row) => {
              const p = (probs as any)[row.key] ?? 0;
              return (
                <div key={row.key}>
                  <div className="flex justify-between text-sm">
                    <span>{row.label}</span>
                    <span className="num">{Math.round(p * 100)}%</span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-kickr-line">
                    <div className="h-full rounded-full bg-kickr-yellow-deep" style={{ width: `${Math.round(p * 100)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="py-6 text-center text-sm text-kickr-ink/50">Win probabilities appear once odds are flowing.</p>
      )}
    </div>
  );
}
