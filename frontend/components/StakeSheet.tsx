"use client";

/** Bet placement sheet with the §8.2 race cases handled explicitly:
 *  quote moved >2% -> inline re-quote; market locked between render and tap
 *  -> friendly "Settled — {evidence}" state, never a raw error. Dark system. */

import React, { useState } from "react";
import { api, ApiError, fmtOdds } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { MarketT } from "./MarketCard";

const QUICK = [25, 50, 100, 250];

export function StakeSheet({
  market,
  outcome,
  onClose,
  onPlaced,
}: {
  market: MarketT;
  outcome: string;
  onClose: () => void;
  onPlaced: (ticket: any) => void;
}) {
  const { getToken } = useAuth();
  const [stake, setStake] = useState(50);
  const [odds, setOdds] = useState<number>(market.prices[outcome]);
  const [requoted, setRequoted] = useState(false);
  const [settledInfo, setSettledInfo] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await api(
        "/bets",
        { method: "POST", body: JSON.stringify({ market_id: market.id, outcome, stake, odds_seen: odds }) },
        token
      );
      onPlaced(res);
    } catch (e) {
      if (e instanceof ApiError && e.detail?.error === "quote_moved") {
        setOdds(e.detail.current_prices[outcome]);
        setRequoted(true);
      } else if (e instanceof ApiError && e.detail?.error === "market_not_open") {
        setSettledInfo(e.detail);
      } else if (e instanceof ApiError) {
        setError(String(e.detail?.error ?? e.message));
      } else {
        setError("network error");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-t-3xl border border-kickr-navy-line bg-kickr-navy-surface p-5 sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        {settledInfo ? (
          <div>
            <h3 className="font-display text-lg text-kickr-cream">Settled</h3>
            <p className="mt-2 text-sm text-kickr-cream-dim">
              This market {settledInfo.status === "locked" ? "locked" : "settled"} while you were deciding
              {settledInfo.winning_outcome && (
                <>
                  {" "}
                  — winner <b className="text-kickr-yellow">{settledInfo.winning_outcome}</b>
                </>
              )}
              {settledInfo.evidence?.score && <span className="num"> ({settledInfo.evidence.score.join("-")})</span>}.
            </p>
            <button
              onClick={onClose}
              className="mt-4 w-full rounded-xl bg-kickr-navy px-4 py-2.5 text-sm font-semibold text-kickr-cream"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            <p className="text-sm text-kickr-cream-dim">{market.question}</p>
            <div className="mt-1 flex items-baseline justify-between">
              <h3 className="font-display text-lg text-kickr-cream">{outcome}</h3>
              <span className="num text-lg font-bold text-kickr-yellow">
                @ {fmtOdds(odds)}
                {requoted && (
                  <span className="ml-2 rounded bg-kickr-yellow px-1.5 py-0.5 font-body text-xs text-kickr-navy">
                    re-quoted
                  </span>
                )}
              </span>
            </div>

            <div className="mt-4 flex gap-2">
              {QUICK.map((q) => (
                <button
                  key={q}
                  onClick={() => setStake(q)}
                  className={`num flex-1 rounded-lg border px-2 py-2.5 text-sm transition-colors ${
                    stake === q
                      ? "border-kickr-yellow bg-kickr-yellow/15 text-kickr-cream"
                      : "border-kickr-navy-line text-kickr-cream/80 hover:border-kickr-yellow/50"
                  }`}
                >
                  {q}
                </button>
              ))}
              <input
                type="number"
                min={1}
                max={500}
                value={stake}
                onChange={(e) => setStake(Math.max(1, Math.min(500, Number(e.target.value))))}
                className="num w-20 rounded-lg border border-kickr-navy-line bg-kickr-navy px-2 py-2.5 text-sm text-kickr-cream outline-none focus:border-kickr-yellow/60"
                aria-label="custom stake"
              />
            </div>

            <div className="num mt-4 flex justify-between text-sm text-kickr-cream-dim">
              <span>potential payout</span>
              <span className="font-semibold text-kickr-cream">{Math.round(stake * odds)}</span>
            </div>

            {error && <p className="mt-2 text-sm text-kickr-loss">{error}</p>}

            <button
              onClick={confirm}
              disabled={busy}
              className="mt-4 w-full rounded-xl bg-kickr-yellow px-4 py-3.5 font-bold text-kickr-navy transition-transform hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-50"
            >
              {busy ? "Placing…" : requoted ? `Accept new quote @ ${fmtOdds(odds)}` : `Confirm ${stake} chips`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
