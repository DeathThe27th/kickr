"use client";

/** /positions (build.md §8.2), dark system: open bets (live quote vs locked odds)
 *  and the settled ledger. Numbers mono; win/loss ticks on numbers only. */

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
    <div className="min-h-screen bg-kickr-navy text-kickr-cream">
      <AppNav me={me} onFaucet={faucet} />
      <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        <div className="mb-6 flex items-baseline justify-between">
          <h1 className="font-display text-2xl text-kickr-cream">Positions</h1>
          <Link href="/app" className="text-sm text-kickr-cream-dim underline-offset-4 hover:text-kickr-yellow">
            ← bracket
          </Link>
        </div>

        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.15em] text-kickr-cream-dim">
            Open ({open.length})
          </h2>
          {open.length ? (
            <div className="grid gap-2.5">
              {open.map((b) => (
                <div key={b.id} className="rounded-2xl border border-kickr-navy-line bg-kickr-navy-surface p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-kickr-cream">{b.question}</p>
                      <p className="mt-0.5 text-xs text-kickr-cream-dim">
                        {b.outcome} · {b.market_status}
                      </p>
                    </div>
                    <div className="text-right text-sm">
                      <p className="num text-kickr-cream">
                        <span className="text-kickr-cream-dim">stake </span>
                        {b.stake}
                      </p>
                      <p className="num text-kickr-cream">
                        <span className="text-kickr-cream-dim">to win </span>
                        {b.potential_payout}
                      </p>
                    </div>
                  </div>
                  <div className="num mt-3 flex items-center gap-4 border-t border-kickr-navy-line pt-2.5 text-xs text-kickr-cream-dim">
                    <span>locked @ {fmtOdds(b.odds_locked)}</span>
                    {b.current_prices?.[b.outcome] != null && (
                      <span className="flex items-center gap-1 text-kickr-cream/80">
                        now <OddsNum value={b.current_prices[b.outcome]} />
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyRow>
              No open positions.{" "}
              <Link href="/app" className="text-kickr-yellow underline-offset-2 hover:underline">
                Find a market →
              </Link>
            </EmptyRow>
          )}
        </section>

        <section className="mt-10">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.15em] text-kickr-cream-dim">
            Settled ({settled.length})
          </h2>
          {settled.length ? (
            <div className="overflow-x-auto rounded-2xl border border-kickr-navy-line">
              <table className="w-full text-sm">
                <thead className="border-b border-kickr-navy-line bg-kickr-navy-surface text-left text-xs uppercase tracking-wide text-kickr-cream-dim">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">Market</th>
                    <th className="px-4 py-2.5 font-semibold">Pick</th>
                    <th className="num px-4 py-2.5 text-right font-semibold">Stake</th>
                    <th className="num px-4 py-2.5 text-right font-semibold">Odds</th>
                    <th className="num px-4 py-2.5 text-right font-semibold">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {settled.map((b) => {
                    const pnl = b.status === "won" ? b.potential_payout - b.stake : b.status === "voided" ? 0 : -b.stake;
                    return (
                      <tr key={b.id} className="border-b border-kickr-navy-line/60 last:border-0">
                        <td className="max-w-[16rem] truncate px-4 py-2.5 text-kickr-cream/90">{b.question}</td>
                        <td className="px-4 py-2.5 text-kickr-cream-dim">{b.outcome}</td>
                        <td className="num px-4 py-2.5 text-right text-kickr-cream">{b.stake}</td>
                        <td className="num px-4 py-2.5 text-right text-kickr-cream">{fmtOdds(b.odds_locked)}</td>
                        <td
                          className={`num px-4 py-2.5 text-right font-semibold ${
                            b.status === "won" ? "text-kickr-win" : b.status === "lost" ? "text-kickr-loss" : "text-kickr-cream-dim"
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
            <EmptyRow>No settled bets yet.</EmptyRow>
          )}
        </section>
      </main>
    </div>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-2xl border border-dashed border-kickr-navy-line p-8 text-center text-sm text-kickr-cream-dim">
      {children}
    </p>
  );
}
