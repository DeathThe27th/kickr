"use client";

/** Authed home = the picks board.
 *  Cards are market picks, not fixtures: each one carries its own match context
 *  so the page is only ever the things you can actually bet on right now. They
 *  exist only while a match is live, which is when micro markets exist.
 *
 *  Live mode shows the real TxLINE feed. Demo mode simulates any fixture on
 *  demand (backend: txline/simulator.py) and the two run side by side, so
 *  demoing never hides a real match.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api, subscribeStream } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { AppNav } from "@/components/Nav";
import { MarketCard, MarketT } from "@/components/MarketCard";
import { StakeSheet } from "@/components/StakeSheet";
import { LivePill, TeamFlag, Toast } from "@/components/shared";
import { FixtureT, demoIdFor } from "@/lib/types";

type Mode = "live" | "demo";

export default function AppHome() {
  const { authed, ready, getToken } = useAuth();
  const [me, setMe] = useState<any>(null);
  const [fixtures, setFixtures] = useState<FixtureT[]>([]);
  const [mode, setMode] = useState<Mode>("live");
  const [open, setOpen] = useState<FixtureT | null>(null);
  const [pick, setPick] = useState<{ market: MarketT; outcome: string } | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (ready && !authed) location.href = "/";
  }, [ready, authed]);

  const loadMe = useCallback(async () => {
    try {
      setMe(await api("/me", {}, await getToken()));
    } catch {}
  }, [getToken]);

  const loadFixtures = useCallback(async () => {
    try {
      const br = await api("/bracket");
      setFixtures(br.fixtures);
    } catch {}
  }, []);

  useEffect(() => {
    if (!ready || !authed) return;
    loadMe();
    loadFixtures();
    const unsub = subscribeStream((ev) => {
      if (
        ["market_open", "market_locked", "market_settled", "score_update", "demo_started", "demo_stopped", "demo_restarted"].includes(
          ev.event
        )
      ) {
        loadFixtures();
      }
      if (ev.event === "market_settled") loadMe();
    });
    const t = setInterval(loadFixtures, 5000);
    return () => {
      unsub();
      clearInterval(t);
    };
  }, [ready, authed, loadMe, loadFixtures]);

  useEffect(() => {
    if (!open) return;
    const fresh = fixtures.find((f) => f.id === open.id);
    if (fresh) setOpen(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixtures]);

  // "Live" for picks means bettable, not just in-play: the four pre-match
  // markets open before kickoff, and filtering on status==="live" alone would
  // make them unreachable. The engine only opens them near kickoff, so this
  // stays scoped — no group-stage history creeps back in.
  const liveFixtures = useMemo(
    () =>
      fixtures.filter(
        (f) =>
          f.source === mode &&
          (f.status === "live" || (f.status === "upcoming" && f.open_markets > 0))
      ),
    [fixtures, mode]
  );
  const marketsByFixture = useLiveMarkets(liveFixtures);

  // A pick is one market plus the match it belongs to — the card is the unit,
  // so the grid mixes markets across every live match without regrouping.
  const picks = useMemo(
    () =>
      liveFixtures.flatMap((f) =>
        (marketsByFixture[f.id] ?? [])
          .filter((m) => m.status === "open" || m.status === "suspended")
          .map((m) => ({ fixture: f, market: m }))
      ),
    [liveFixtures, marketsByFixture]
  );

  const runningDemoIds = useMemo(
    () => new Set(fixtures.filter((f) => f.source === "demo").map((f) => f.txline_fixture_id)),
    [fixtures]
  );
  const startable = useMemo(
    () =>
      fixtures
        .filter((f) => f.source === "live")
        .sort((a, b) => (b.kickoff_at ?? "").localeCompare(a.kickoff_at ?? "")),
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

  async function startDemo(f: FixtureT) {
    setStarting(f.id);
    try {
      await api(`/demo/fixtures/${f.id}/start`, { method: "POST" }, await getToken());
      setToast(`${f.home} v ${f.away} kicks off in a few seconds`);
      loadFixtures();
    } catch {
      setToast("Could not start that match");
    } finally {
      setStarting(null);
    }
  }

  if (!ready || !authed) return null;

  return (
    <div className="min-h-screen bg-kickr-navy text-kickr-cream">
      <AppNav me={me} onFaucet={faucet} mode={mode} onMode={setMode} />

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {picks.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {picks.map(({ fixture, market }) => (
              <PickCard
                key={market.id}
                fixture={fixture}
                market={market}
                onOpenFixture={() => setOpen(fixture)}
                onPick={(outcome) => setPick({ market, outcome })}
              />
            ))}
          </div>
        ) : (
          <NoPicks mode={mode} onDemo={() => setMode("demo")} live={liveFixtures.length > 0} />
        )}

        {mode === "demo" && (
          <DemoPicker
            fixtures={startable}
            running={runningDemoIds}
            starting={starting}
            onStart={startDemo}
            compact={picks.length > 0}
          />
        )}
      </main>

      {open && <FixtureDrawer fixture={open} onClose={() => setOpen(null)} />}

      {pick && (
        <StakeSheet
          market={pick.market}
          outcome={pick.outcome}
          onClose={() => setPick(null)}
          onPlaced={(t) => {
            setPick(null);
            setToast(`Ticket: ${t.ticket.stake} on ${t.ticket.outcome} @ ${t.ticket.odds_locked.toFixed(2)}`);
            loadMe();
          }}
        />
      )}

      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

/** Markets for every live fixture at once. Keyed by fixture so a pick can carry
 *  its match with it; re-fetches on any price or market event. */
function useLiveMarkets(fixtures: FixtureT[]): Record<string, MarketT[]> {
  const [byFixture, setByFixture] = useState<Record<string, MarketT[]>>({});
  const key = fixtures.map((f) => f.id).join(",");

  useEffect(() => {
    if (!fixtures.length) {
      setByFixture({});
      return;
    }
    let alive = true;
    const load = async () => {
      const entries = await Promise.all(
        fixtures.map(async (f) => {
          try {
            const r = await api(`/fixtures/${f.id}/markets`);
            return [f.id, r.markets as MarketT[]] as const;
          } catch {
            return [f.id, [] as MarketT[]] as const;
          }
        })
      );
      if (alive) setByFixture(Object.fromEntries(entries));
    };
    load();
    const unsub = subscribeStream((ev) => {
      if (ev.event === "price_update" || fixtures.some((f) => f.id === ev.fixture_id)) load();
    });
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      unsub();
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return byFixture;
}

/** One market, carrying the match it belongs to. The strip is the way into the
 *  fixture's depth (live tab, history, receipts); the outcomes bet directly. */
function PickCard({
  fixture,
  market,
  onPick,
  onOpenFixture,
}: {
  fixture: FixtureT;
  market: MarketT;
  onPick: (outcome: string) => void;
  onOpenFixture: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-kickr-navy-line bg-kickr-navy-surface transition-colors hover:border-kickr-yellow/40">
      <button
        onClick={onOpenFixture}
        className="flex w-full items-center justify-between gap-3 border-b border-kickr-navy-line px-4 py-2.5 text-left transition-colors hover:bg-kickr-navy-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kickr-yellow"
      >
        <span className="flex min-w-0 items-center gap-2 text-sm text-kickr-cream/90">
          <TeamFlag team={fixture.home} className="h-4 w-6" />
          <span className="truncate">{fixture.home}</span>
          {fixture.status === "live" ? (
            <span className="num shrink-0 font-semibold text-kickr-yellow">{fixture.score.join("–")}</span>
          ) : (
            <span className="shrink-0 text-kickr-cream-dim">v</span>
          )}
          <span className="truncate">{fixture.away}</span>
          <TeamFlag team={fixture.away} className="h-4 w-6" />
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {fixture.source === "demo" && (
            <span className="rounded-full bg-kickr-navy px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-kickr-cream-dim">
              Demo
            </span>
          )}
          {fixture.status === "live" ? (
            <LivePill minute={fixture.minute} />
          ) : (
            <span className="num text-xs text-kickr-cream-dim">
              {fixture.kickoff_at
                ? new Date(fixture.kickoff_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
                : "soon"}
            </span>
          )}
        </span>
      </button>
      <MarketCard market={market} variant="flat" onPick={onPick} />
    </div>
  );
}

function NoPicks({ mode, onDemo, live }: { mode: Mode; onDemo: () => void; live: boolean }) {
  return (
    <div className="rounded-2xl border border-dashed border-kickr-navy-line px-6 py-16 text-center">
      <p className="font-display text-xl text-kickr-cream">
        {live ? "No markets open yet" : mode === "live" ? "Nothing live right now" : "No demo running"}
      </p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-kickr-cream-dim">
        {live
          ? "Micro markets open at kickoff and after every goal — they'll appear here."
          : mode === "live"
            ? "Picks appear the moment a real fixture kicks off. Nothing on? Start any match yourself in demo mode."
            : "Pick any fixture below and it kicks off in a few seconds — priced and settled exactly like the real thing."}
      </p>
      {mode === "live" && !live && (
        <button
          onClick={onDemo}
          className="mt-6 rounded-full bg-kickr-yellow px-5 py-2.5 text-sm font-bold text-kickr-navy transition-transform hover:-translate-y-0.5 active:translate-y-0"
        >
          Try demo mode
        </button>
      )}
    </div>
  );
}

function DemoPicker({
  fixtures,
  running,
  starting,
  onStart,
  compact,
}: {
  fixtures: FixtureT[];
  running: Set<number>;
  starting: string | null;
  onStart: (f: FixtureT) => void;
  compact: boolean;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? fixtures : fixtures.slice(0, 12);

  return (
    <section className={compact ? "mt-12" : "mt-8"}>
      <h2 className="font-display text-xl text-kickr-cream">Start a match</h2>
      <p className="mt-1 text-sm text-kickr-cream-dim">
        Any fixture, past or upcoming. The simulator prices and settles it live — 90 minutes in about six.
      </p>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((f) => {
          const isRunning = running.has(demoIdFor(f.txline_fixture_id));
          return (
            <div
              key={f.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-kickr-navy-line bg-kickr-navy-surface px-3 py-2.5"
            >
              <span className="flex min-w-0 items-center gap-2 text-sm text-kickr-cream/90">
                <TeamFlag team={f.home} className="h-4 w-6" />
                <span className="truncate">{f.home}</span>
                <span className="shrink-0 text-kickr-cream-dim">v</span>
                <span className="truncate">{f.away}</span>
                <TeamFlag team={f.away} className="h-4 w-6" />
              </span>
              <button
                onClick={() => onStart(f)}
                disabled={starting === f.id}
                className="shrink-0 rounded-full border border-kickr-yellow/50 px-3 py-1 text-xs font-bold text-kickr-yellow transition-colors hover:bg-kickr-yellow hover:text-kickr-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kickr-yellow disabled:cursor-not-allowed disabled:opacity-50"
              >
                {starting === f.id ? "Starting…" : isRunning ? "Restart" : "Start"}
              </button>
            </div>
          );
        })}
      </div>

      {!all && fixtures.length > shown.length && (
        <button
          onClick={() => setAll(true)}
          className="mt-4 text-sm font-semibold text-kickr-cream-dim underline-offset-4 transition-colors hover:text-kickr-cream"
        >
          Show all {fixtures.length} fixtures
        </button>
      )}
    </section>
  );
}

// ------------------------------------------------------------- Fixture drawer
type DrawerTab = "live" | "history";

function FixtureDrawer({ fixture, onClose }: { fixture: FixtureT; onClose: () => void }) {
  const [tab, setTab] = useState<DrawerTab>("live");
  const [markets, setMarkets] = useState<MarketT[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await api(`/fixtures/${fixture.id}/markets?include=settled`);
      setMarkets(r.markets);
    } catch {}
  }, [fixture.id]);

  useEffect(() => {
    load();
    const unsub = subscribeStream((ev) => {
      if (ev.fixture_id === fixture.id || ev.event === "price_update") load();
    });
    return () => unsub();
  }, [fixture.id, load]);

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
        <div className="flex items-start justify-between border-b border-kickr-navy-line px-5 py-4">
          <div>
            <div className="flex items-center gap-2">
              {fixture.status === "live" && <LivePill minute={fixture.minute} />}
              <h2 className="flex items-center gap-2 font-display text-lg text-kickr-cream">
                <TeamFlag team={fixture.home} className="h-4 w-6" />
                {fixture.home}{" "}
                {(fixture.status === "live" || fixture.status === "finished") && (
                  <span className="num text-kickr-yellow">{fixture.score.join("–")}</span>
                )}{" "}
                {fixture.away}
                <TeamFlag team={fixture.away} className="h-4 w-6" />
              </h2>
            </div>
            <p className="mt-1 text-xs uppercase tracking-wide text-kickr-cream-dim">
              {fixture.stage} · {fixture.status}
              {fixture.source === "demo" && " · demo"}
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

        <div className="flex border-b border-kickr-navy-line px-2">
          {(["live", "history"] as DrawerTab[]).map((t) => (
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

        <div className="flex-1 overflow-y-auto p-4">
          {tab === "live" && <LiveTab fixture={fixture} />}
          {tab === "history" && (
            <div className="grid gap-3">
              {history.length ? (
                history.map((m) => <MarketCard key={m.id} market={m} />)
              ) : (
                <p className="py-10 text-center text-sm text-kickr-cream-dim">No settled markets yet.</p>
              )}
            </div>
          )}
        </div>
      </div>
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
