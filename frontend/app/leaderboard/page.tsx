"use client";

/** /leaderboard (build.md §8.2), dark system: weekly + all-time; profit, ROI%,
 *  hit-rate. Mono numbers with tabular figures. */

import Link from "next/link";
import React, { useCallback, useEffect, useState } from "react";
import { api, subscribeStream } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { AppNav } from "@/components/Nav";

type Row = {
  handle: string;
  profit: number;
  roi_pct: number;
  hit_rate_pct: number;
  settled: number;
};

export default function Leaderboard() {
  const { authed, ready, getToken } = useAuth();
  const [me, setMe] = useState<any>(null);
  const [data, setData] = useState<{ weekly: Row[]; all_time: Row[] } | null>(null);
  const [window, setWindow] = useState<"weekly" | "all_time">("all_time");

  const load = useCallback(async () => {
    try {
      setData(await api("/leaderboard"));
      if (authed) setMe(await api("/me", {}, await getToken()));
    } catch {}
  }, [authed, getToken]);

  useEffect(() => {
    if (!ready) return;
    load();
    const unsub = subscribeStream((ev) => {
      if (ev.event === "market_settled") load();
    });
    const t = setInterval(load, 15000);
    return () => {
      unsub();
      clearInterval(t);
    };
  }, [ready, load]);

  if (!ready) return null;

  const rows = data?.[window] ?? [];

  return (
    <div className="min-h-screen bg-kickr-navy text-kickr-cream">
      <AppNav me={me} />
      <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
        <div className="mb-6 flex items-baseline justify-between">
          <h1 className="font-display text-2xl text-kickr-cream">Leaderboard</h1>
          <Link href="/app" className="text-sm text-kickr-cream-dim underline-offset-4 hover:text-kickr-yellow">
            ← bracket
          </Link>
        </div>

        <div className="mb-5 flex gap-2">
          {(["all_time", "weekly"] as const).map((w) => (
            <button
              key={w}
              onClick={() => setWindow(w)}
              className={`rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
                window === w
                  ? "bg-kickr-yellow text-kickr-navy"
                  : "border border-kickr-navy-line text-kickr-cream-dim hover:border-kickr-yellow/40 hover:text-kickr-cream"
              }`}
            >
              {w === "all_time" ? "All-time" : "This week"}
            </button>
          ))}
        </div>

        {rows.length ? (
          <div className="overflow-x-auto rounded-2xl border border-kickr-navy-line">
            <table className="w-full text-sm">
              <thead className="border-b border-kickr-navy-line bg-kickr-navy-surface text-left text-xs uppercase tracking-wide text-kickr-cream-dim">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">#</th>
                  <th className="px-4 py-2.5 font-semibold">Player</th>
                  <th className="num px-4 py-2.5 text-right font-semibold">Profit</th>
                  <th className="num px-4 py-2.5 text-right font-semibold">ROI</th>
                  <th className="num px-4 py-2.5 text-right font-semibold">Hit</th>
                  <th className="num px-4 py-2.5 text-right font-semibold">Bets</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const isMe = me?.handle && r.handle === me.handle;
                  return (
                    <tr
                      key={r.handle}
                      className={`border-b border-kickr-navy-line/60 last:border-0 ${
                        isMe ? "bg-kickr-yellow/[0.08]" : ""
                      }`}
                    >
                      <td className="num px-4 py-2.5 text-kickr-cream-dim">{i + 1}</td>
                      <td className="px-4 py-2.5 font-semibold text-kickr-cream">
                        {r.handle}
                        {isMe && (
                          <span className="ml-2 rounded bg-kickr-yellow px-1.5 py-0.5 font-body text-[10px] text-kickr-navy">
                            you
                          </span>
                        )}
                      </td>
                      <td
                        className={`num px-4 py-2.5 text-right font-semibold ${
                          r.profit > 0 ? "text-kickr-win" : r.profit < 0 ? "text-kickr-loss" : "text-kickr-cream-dim"
                        }`}
                      >
                        {r.profit > 0 ? "+" : ""}
                        {r.profit.toLocaleString()}
                      </td>
                      <td className="num px-4 py-2.5 text-right text-kickr-cream/90">{r.roi_pct}%</td>
                      <td className="num px-4 py-2.5 text-right text-kickr-cream/90">{r.hit_rate_pct}%</td>
                      <td className="num px-4 py-2.5 text-right text-kickr-cream-dim">{r.settled}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="rounded-2xl border border-dashed border-kickr-navy-line p-12 text-center text-sm text-kickr-cream-dim">
            No settled bets yet — the board fills up as markets settle.
          </p>
        )}
      </main>
    </div>
  );
}
