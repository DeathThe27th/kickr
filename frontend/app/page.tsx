"use client";

/** Landing (redesign: navy/cream/yellow, logo-led).
 *  Cinematic hero (hero.jpg) with the value prop in the dark left third; a live
 *  preview strip below with REAL ticking data so the product moves before sign-in
 *  (build.md §8.2). Yellow is reserved for the live moment + primary action. */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, subscribeStream } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { MarketT } from "@/components/MarketCard";
import { OddsNum, Wordmark } from "@/components/shared";

/** One worked micro market, end to end. The figures are real and reconcile:
 *  λ=2.35 reproduces P(over 2.5)=0.42 under Poisson, and the quoted pair carries
 *  exactly the 5% overround the engine applies (build.md §3.2–3.4). Recheck them
 *  if MARGIN changes — a derivation that doesn't add up is worse than no figures. */
const DERIVATION: { k: string; d: string; rows: [string, string][] }[] = [
  {
    k: "TxLINE feed",
    d: "StablePrice arrives de-margined from the on-chain oracle — the real book, not a scrape.",
    rows: [
      ["Over 2.5", "2.40"],
      ["Under 2.5", "1.72"],
    ],
  },
  {
    k: "De-vig",
    d: "Invert to probabilities and normalise, so the pair sums to exactly one.",
    rows: [
      ["P(over)", "0.42"],
      ["P(under)", "0.58"],
    ],
  },
  {
    k: "Solve λ",
    d: "Bisect for the goal rate that reproduces that price under Poisson. This is the whole trick.",
    rows: [
      ["λ rem", "2.35"],
      ["search", "0.01–8"],
    ],
  },
  {
    k: "Quote",
    d: "Apply λ to the window left on the clock, add the overround, open the market.",
    rows: [
      ["Goal by 25′", "Yes 4.19"],
      ["overround", "1.05"],
    ],
  },
];

export default function Landing() {
  const { authed, login, ready } = useAuth();
  const [fixtures, setFixtures] = useState<any[]>([]);
  const [markets, setMarkets] = useState<MarketT[]>([]);
  const rootRef = useRef<HTMLElement>(null);

  const featured = useMemo(() => {
    const live = fixtures.find((f) => f.status === "live");
    if (live) return live;
    return fixtures
      .filter((f) => f.status === "upcoming" && f.kickoff_at)
      .sort((a, b) => a.kickoff_at.localeCompare(b.kickoff_at))[0];
  }, [fixtures]);

  async function refresh() {
    try {
      const br = await api("/bracket");
      setFixtures(br.fixtures);
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

  // scroll-reveal: enhance already-visible content (never gates visibility)
  useEffect(() => {
    const els = rootRef.current?.querySelectorAll(".reveal");
    if (!els?.length) return;
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && e.target.classList.add("in-view")),
      { threshold: 0.15 }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [featured?.id]);

  const isLive = featured?.status === "live";
  const openMarkets = markets.filter((m) => m.status === "open" || m.status === "suspended").slice(0, 2);

  return (
    <main ref={rootRef} className="min-h-screen bg-kickr-navy text-kickr-cream">
      {/* ---------------------------------------------------------------- hero */}
      <section className="relative min-h-[100svh] w-full overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/hero.jpg"
          alt="A number 10 walking into a shaft of stadium light"
          className="absolute inset-0 h-full w-full object-cover object-[70%_center]"
        />
        <div className="hero-scrim absolute inset-0" />

        {/* nav */}
        <nav className="relative z-20 mx-auto flex max-w-7xl items-center px-6 py-6">
          <Wordmark className="text-3xl text-kickr-cream" />
        </nav>

        {/* hero content — sits in the dark left third */}
        <div className="relative z-10 mx-auto flex min-h-[calc(100svh-88px)] max-w-7xl flex-col justify-end px-6 pb-16 sm:justify-center sm:pb-0">
          <div className="max-w-2xl reveal">
            <h1 className="font-display text-5xl leading-[0.95] text-kickr-cream sm:text-6xl lg:text-7xl" style={{ textWrap: "balance" as any }}>
              Markets that <span className="text-kickr-yellow">live</span> inside the match.
            </h1>

            <p className="mt-6 max-w-xl text-lg leading-relaxed text-kickr-cream/85">
              Live micro markets for every World Cup fixture that settle in seconds with onchain
              receipts.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-4">
              <button
                onClick={login}
                className="rounded-full bg-kickr-yellow px-7 py-4 text-lg font-bold text-kickr-navy shadow-live-glow transition-transform duration-150 hover:-translate-y-0.5 active:translate-y-0"
              >
                Sign in
              </button>
              <a
                href="#live"
                className="text-sm font-semibold text-kickr-cream/70 underline-offset-4 transition-colors hover:text-kickr-cream"
              >
                {isLive ? "Watch a market settle ↓" : "See it move ↓"}
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- live preview */}
      <section id="live" className="mx-auto max-w-7xl px-6 py-20 sm:py-28">
        <div className="reveal flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="font-display text-3xl text-kickr-cream sm:text-4xl">
              {isLive ? "Live right now" : "Up next"}
            </h2>
            <p className="mt-2 text-kickr-cream-dim">
              Real quotes, ticking in real time. No sign-in to look.
            </p>
          </div>
          {featured && (
            <div className="text-right font-mono text-sm text-kickr-cream-dim">
              {isLive ? (
                <span className="text-kickr-yellow">{featured.minute}&prime; · {featured.score.join("–")}</span>
              ) : featured.kickoff_at ? (
                new Date(featured.kickoff_at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })
              ) : null}
            </div>
          )}
        </div>

        {featured ? (
          <div className="reveal mt-8 overflow-hidden rounded-3xl border border-kickr-navy-line bg-kickr-navy-surface">
            <div className="flex items-center justify-between gap-4 border-b border-kickr-navy-line px-6 py-5">
              <div className="flex items-center gap-3">
                {isLive && <span className="pulse-dot" />}
                <span className="font-display text-xl text-kickr-cream">
                  {featured.home} <span className="font-mono text-kickr-cream-dim">{isLive ? featured.score.join("–") : "v"}</span> {featured.away}
                </span>
              </div>
              <span className="rounded-full bg-kickr-navy px-3 py-1 text-xs uppercase tracking-wide text-kickr-cream-dim">
                {featured.stage === "group" ? "Group stage" : featured.stage?.toUpperCase()}
              </span>
            </div>

            <div className="grid gap-px bg-kickr-navy-line sm:grid-cols-2">
              {openMarkets.length ? (
                openMarkets.map((m) => <PreviewQuote key={m.id} market={m} />)
              ) : (
                <div className="bg-kickr-navy-surface px-6 py-10 text-center text-sm text-kickr-cream-dim sm:col-span-2">
                  New micro markets open at kickoff and after every goal.
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="reveal mt-8 rounded-3xl border border-kickr-navy-line bg-kickr-navy-surface px-6 py-16 text-center text-kickr-cream-dim">
            Loading the fixture feed…
          </div>
        )}

      </section>

      {/* -------------------------------------------------------- how it works */}
      <section id="how" className="border-t border-kickr-navy-line">
        <div className="mx-auto max-w-7xl px-6 py-20 sm:py-28">
          <div className="reveal max-w-2xl">
            <h2 className="font-display text-3xl text-kickr-cream sm:text-4xl">How a goal becomes a price</h2>
            <p className="mt-3 leading-relaxed text-kickr-cream-dim">
              No proprietary model, no hand-set lines. Every quote is derived from TxLINE&apos;s live odds
              feed. This is the entire chain, for one real micro market.
            </p>
          </div>

          <div className="reveal mt-10 grid gap-px overflow-hidden rounded-2xl border border-kickr-navy-line bg-kickr-navy-line md:grid-cols-4">
            {DERIVATION.map((step, i) => (
              <div
                key={step.k}
                className="bg-kickr-navy-surface px-5 py-6"
                style={{ transitionDelay: `${i * 70}ms` }}
              >
                <p className="text-xs font-semibold uppercase tracking-[0.15em] text-kickr-yellow">{step.k}</p>
                <p className="mt-2 text-sm leading-relaxed text-kickr-cream/85">{step.d}</p>
                <dl className="num mt-4 space-y-1.5 text-sm">
                  {step.rows.map(([label, value]) => (
                    <div
                      key={label + value}
                      className="flex items-baseline justify-between gap-3 border-t border-kickr-navy-line pt-1.5"
                    >
                      <dt className="text-kickr-cream-dim">{label}</dt>
                      <dd className="text-kickr-cream">{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>

          {/* The line the whole product rests on. */}
          <div className="reveal mt-6 overflow-x-auto rounded-2xl border border-kickr-yellow/25 bg-kickr-yellow/[0.04] px-6 py-6">
            <p className="num whitespace-nowrap text-center text-sm text-kickr-cream sm:text-base">
              P(≥1 goal in next <span className="text-kickr-yellow">m</span>) = 1 − exp(−λ
              <span className="text-kickr-cream-dim">rem</span> · <span className="text-kickr-yellow">m</span> ÷ minutes
              remaining)
            </p>
          </div>
          <p className="reveal mx-auto mt-6 max-w-2xl text-center text-sm leading-relaxed text-kickr-cream-dim">
            λ comes out of the market, never out of us — so a kickr price can&apos;t drift from the book it
            was born in. When the goal lands, Tx Scores settles the markets it decides, winners are paid from
            the ledger, and both the open and the settle are hashed to Solana.
          </p>
        </div>
      </section>

      {/* ---------------------------------------------------------------- footer */}
      <footer className="border-t border-kickr-navy-line">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-6 py-8">
          <Wordmark className="text-2xl text-kickr-cream" />
          <span className="text-sm text-kickr-cream-dim">Priced live · settled in seconds · receipts on-chain</span>
        </div>
      </footer>
    </main>
  );
}

/** Read-only ticking quote for the landing preview (dark surface variant). */
function PreviewQuote({ market }: { market: MarketT }) {
  return (
    <div className="bg-kickr-navy-surface px-6 py-5">
      <p className="text-sm font-semibold text-kickr-cream">{market.question}</p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {market.outcomes.map((o) => (
          <div
            key={o}
            className="flex items-center justify-between rounded-lg border border-kickr-navy-line bg-kickr-navy px-3 py-2.5 text-sm"
          >
            <span className="text-kickr-cream/80">{o}</span>
            <span className="text-kickr-yellow">
              <OddsNum value={market.prices?.[o]} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
