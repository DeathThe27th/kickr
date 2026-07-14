"use client";

/** /leaderboard (build.md §8.2): weekly + all-time; profit, ROI%, hit-rate.
 *  Mono numbers with tabular figures. */

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
    <div className="min-h-screen bg-white">
      <AppNav me={me} />
      <main className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-6 flex items-baseline justify-between">
          <h1 className="font-display text-2xl">Leaderboard</h1>
          <Link href="/app" className="text-sm text-kickr-ink/60 underline-offset-2 hover:underline">
            ← back to bracket
          </Link>
        </div>

        <div className="mb-4 flex gap-2">
          {(["all_time", "weekly"] as const).map((w) => (
            <button
              key={w}
              onClick={() => setWindow(w)}
              className={`rounded-full px-4 py-1.5 text-sm font-semibold capitalize transition-colors ${
                window === w ? "bg-kickr-ink text-white" : "border border-kickr-line text-kickr-ink/70 hover:border-kickr-yellow-deep"
              }`}
            >
              {w === "all_time" ? "All-time" : "This week"}
            </button>
          ))}
        </div>

        {rows.length ? (
          <div className="overflow-x-auto rounded-xl border border-kickr-line">
            <table className="w-full text-sm">
              <thead className="border-b border-kickr-line text-left text-xs uppercase tracking-wide text-kickr-ink/50">
                <tr>
                  <th className="px-3 py-2 font-semibold">#</th>
                  <th className="px-3 py-2 font-semibold">Player</th>
                  <th className="num px-3 py-2 text-right font-semibold">Profit</th>
                  <th className="num px-3 py-2 text-right font-semibold">ROI</th>
                  <th className="num px-3 py-2 text-right font-semibold">Hit</th>
                  <th className="num px-3 py-2 text-right font-semibold">Bets</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const isMe = me?.handle && r.handle === me.handle;
                  return (
                    <tr
                      key={r.handle}
                      className={`border-b border-kickr-line/60 last:border-0 ${isMe ? "bg-kickr-yellow/20" : ""}`}
                    >
                      <td className="num px-3 py-2 text-kickr-ink/50">{i + 1}</td>
                      <td className="px-3 py-2 font-semibold">
                        {r.handle}
                        {isMe && <span className="ml-2 rounded bg-kickr-yellow px-1.5 py-0.5 text-[10px] font-body">you</span>}
                      </td>
                      <td
                        className={`num px-3 py-2 text-right font-semibold ${
                          r.profit > 0 ? "text-kickr-win" : r.profit < 0 ? "text-kickr-loss" : ""
                        }`}
                      >
                        {r.profit > 0 ? "+" : ""}
                        {r.profit.toLocaleString()}
                      </td>
                      <td className="num px-3 py-2 text-right">{r.roi_pct}%</td>
                      <td className="num px-3 py-2 text-right">{r.hit_rate_pct}%</td>
                      <td className="num px-3 py-2 text-right text-kickr-ink/60">{r.settled}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-kickr-line p-10 text-center text-sm text-kickr-ink/50">
            No settled bets yet — the board fills up as markets settle.
          </p>
        )}
      </main>
    </div>
  );
}
