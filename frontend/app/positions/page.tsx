"use client";

/** /positions (build.md §8.2): open bets (live quote vs locked odds) and the
 *  settled bets ledger. Numbers in mono; win/loss ticks green/red on numbers. */

import Link from "next/link";
import React, { useCallback, useEffect, useState } from "react";
import { api, fmtOdds, subscribeStream } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { AppNav } from "@/components/Nav";
import { OddsNum } from "@/components/shared";

type BetT = {
  id: string;
  market_id: string;
  fixture_id: string;
  question: string;
  outcome: string;
  stake: number;
  odds_locked: number;
  potential_payout: number;
  status: string;
  market_status: string;
  current_prices: Record<string, number> | null;
  created_at: string;
};

export default function Positions() {
  const { authed, ready, getToken } = useAuth();
  const [me, setMe] = useState<any>(null);

  useEffect(() => {
    if (ready && !authed) location.href = "/";
  }, [ready, authed]);

  const load = useCallback(async () => {
    try {
      setMe(await api("/me", {}, await getToken()));
    } catch {}
  }, [getToken]);

  useEffect(() => {
    if (!ready || !authed) return;
    load();
    const unsub = subscribeStream((ev) => {
      if (["market_settled", "price_update"].includes(ev.event)) load();
    });
    const t = setInterval(load, 10000);
    return () => {
      unsub();
      clearInterval(t);
    };
  }, [ready, authed, load]);

  async function faucet() {
    try {
      await api("/me/faucet", { method: "POST" }, await getToken());
      load();
    } catch {}
  }

  if (!ready || !authed) return null;

  const bets: BetT[] = me?.bets ?? [];
  const open = bets.filter((b) => b.status === "open");
  const settled = bets.filter((b) => b.status !== "open");

  return (
    <div className="min-h-screen bg-white">
      <AppNav me={me} onFaucet={faucet} />
      <main className="mx-auto max-w-4xl px-4 py-6">
        <div className="mb-6 flex items-baseline justify-between">
          <h1 className="font-display text-2xl">Positions</h1>
          <Link href="/app" className="text-sm text-kickr-ink/60 underline-offset-2 hover:underline">
            ← back to bracket
          </Link>
        </div>

        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-kickr-ink/50">
            Open ({open.length})
          </h2>
          {open.length ? (
            <div className="grid gap-2">
              {open.map((b) => (
                <div key={b.id} className="rounded-xl border border-kickr-line p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">{b.question}</p>
                      <p className="text-xs text-kickr-ink/60">
                        {b.outcome} · {b.market_status}
                      </p>
                    </div>
                    <div className="text-right text-sm">
                      <p className="num">
                        <span className="text-kickr-ink/50">stake</span> {b.stake}
                      </p>
                      <p className="num">
                        <span className="text-kickr-ink/50">to win</span> {b.potential_payout}
                      </p>
                    </div>
                  </div>
                  <div className="num mt-2 flex items-center gap-4 border-t border-kickr-line pt-2 text-xs text-kickr-ink/70">
                    <span>locked @ {fmtOdds(b.odds_locked)}</span>
                    {b.current_prices?.[b.outcome] != null && (
                      <span className="flex items-center gap-1">
                        now <OddsNum value={b.current_prices[b.outcome]} />
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="rounded-xl border border-dashed border-kickr-line p-6 text-center text-sm text-kickr-ink/50">
              No open positions.{" "}
              <Link href="/app" className="underline underline-offset-2">
                Find a market →
              </Link>
            </p>
          )}
        </section>

        <section className="mt-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-kickr-ink/50">
            Settled ({settled.length})
          </h2>
          {settled.length ? (
            <div className="overflow-x-auto rounded-xl border border-kickr-line">
              <table className="w-full text-sm">
                <thead className="border-b border-kickr-line text-left text-xs uppercase tracking-wide text-kickr-ink/50">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Market</th>
                    <th className="px-3 py-2 font-semibold">Pick</th>
                    <th className="num px-3 py-2 text-right font-semibold">Stake</th>
                    <th className="num px-3 py-2 text-right font-semibold">Odds</th>
                    <th className="num px-3 py-2 text-right font-semibold">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {settled.map((b) => {
                    const pnl = b.status === "won" ? b.potential_payout - b.stake : b.status === "voided" ? 0 : -b.stake;
                    return (
                      <tr key={b.id} className="border-b border-kickr-line/60 last:border-0">
                        <td className="max-w-[16rem] truncate px-3 py-2">{b.question}</td>
                        <td className="px-3 py-2 text-kickr-ink/70">{b.outcome}</td>
                        <td className="num px-3 py-2 text-right">{b.stake}</td>
                        <td className="num px-3 py-2 text-right">{fmtOdds(b.odds_locked)}</td>
                        <td
                          className={`num px-3 py-2 text-right font-semibold ${
                            b.status === "won" ? "text-kickr-win" : b.status === "lost" ? "text-kickr-loss" : "text-kickr-ink/50"
                          }`}
                        >
                          {b.status === "voided" ? "void" : `${pnl > 0 ? "+" : ""}${pnl}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="rounded-xl border border-dashed border-kickr-line p-6 text-center text-sm text-kickr-ink/50">
              No settled bets yet.
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
