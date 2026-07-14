"use client";

/** Landing (build.md §8.2): calm white/ink; a live preview strip with real
 * data and read-only ticking quotes — the product moves before sign-in. */

import Link from "next/link";
import React, { useEffect, useMemo, useState } from "react";
import { api, subscribeStream } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { MarketCard, MarketT } from "@/components/MarketCard";
import { LivePill, Wordmark } from "@/components/shared";

export default function Landing() {
  const { authed, login, ready } = useAuth();
  const [fixtures, setFixtures] = useState<any[]>([]);
  const [markets, setMarkets] = useState<MarketT[]>([]);
  const [stats, setStats] = useState<any>(null);

  const featured = useMemo(() => {
    const live = fixtures.find((f) => f.status === "live");
    if (live) return live;
    return fixtures
      .filter((f) => f.status === "upcoming")
      .sort((a, b) => a.kickoff_at.localeCompare(b.kickoff_at))[0];
  }, [fixtures]);

  async function refresh() {
    try {
      const br = await api("/bracket");
      setFixtures(br.fixtures);
      setStats(await api("/stats"));
    } catch {}
  }
  useEffect(() => {
    refresh();
    const unsub = subscribeStream((ev) => {
      if (["market_open", "market_settled", "score_update", "demo_restarted"].includes(ev.event)) refresh();
    });
    const t = setInterval(refresh, 10000);
    return () => {
      unsub();
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    if (!featured) return;
    let alive = true;
    const load = () =>
      api(`/fixtures/${featured.id}/markets`).then((r) => alive && setMarkets(r.markets)).catch(() => {});
    load();
    const unsub = subscribeStream((ev) => {
      if (ev.fixture_id === featured.id || ev.event === "price_update") load();
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [featured?.id]);

  useEffect(() => {
    if (authed && ready) location.href = "/app";
  }, [authed, ready]);

  return (
    <main>
      <nav className="border-b border-kickr-line">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Wordmark className="text-2xl" />
          <button
            onClick={login}
            className="rounded-full bg-kickr-yellow px-4 py-1.5 text-sm font-semibold hover:bg-kickr-yellow-deep"
          >
            Sign in
          </button>
        </div>
      </nav>

      <section className="mx-auto max-w-6xl px-4 pb-16 pt-20 text-center">
        <h1 className="font-display mx-auto max-w-3xl text-4xl leading-tight sm:text-6xl">
          Markets that live inside the match.
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-lg text-kickr-ink/70">
          Micro prediction markets on every World Cup fixture — priced live, settled in seconds,
          receipts on-chain.
        </p>
        <button
          onClick={login}
          className="mt-8 rounded-xl bg-kickr-yellow px-8 py-4 text-lg font-bold shadow-sm hover:bg-kickr-yellow-deep"
        >
          Start with 1,000 free chips
        </button>
      </section>

      {featured && (
        <section className="mx-auto max-w-6xl px-4 pb-20">
          <div
            className={`rounded-2xl border p-5 ${
              featured.status === "live" ? "border-kickr-yellow bg-kickr-yellow/20" : "border-kickr-line"
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                {featured.status === "live" && <LivePill minute={featured.minute} />}
                <span className="font-display text-lg">
                  {featured.home} <span className="num">{featured.status === "live" ? featured.score.join("–") : "vs"}</span>{" "}
                  {featured.away}
                </span>
              </div>
              <span className="text-sm text-kickr-ink/60">
                {featured.status === "live" ? "LIVE — quotes tick in real time" : `kicks off ${new Date(featured.kickoff_at).toLocaleString()}`}
              </span>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {markets
                .filter((m) => m.status === "open" || m.status === "suspended")
                .slice(0, 2)
                .map((m) => (
                  <MarketCard key={m.id} market={m} readOnly />
                ))}
              {markets.filter((m) => m.status === "open").length === 0 && (
                <p className="text-sm text-kickr-ink/50">Markets open around kickoff…</p>
              )}
            </div>
          </div>
        </section>
      )}

      <footer className="border-t border-kickr-line">
        <div className="num mx-auto flex max-w-6xl flex-wrap items-center gap-x-8 gap-y-2 px-4 py-6 text-sm text-kickr-ink/60">
          <span>
            <b className="text-kickr-ink">{stats?.markets_settled ?? "–"}</b> markets settled
          </span>
          <span>
            <b className="text-kickr-ink">{stats?.markets_active ?? "–"}</b> active now
          </span>
          {stats?.sample_receipt && (
            <a href={stats.sample_receipt} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-kickr-yellow-deep">
              sample on-chain receipt ↗
            </a>
          )}
          <span className="ml-auto">
            <Wordmark /> · play-money · 2026
          </span>
        </div>
      </footer>
    </main>
  );
}
