"use client";

import React from "react";
import { OddsNum } from "./shared";

export type MarketT = {
  id: string;
  template_id: string;
  question: string;
  outcomes: string[];
  prices: Record<string, number>;
  status: string;
  settlement?: { winning_outcome: string | null; evidence: any; settled_at: string };
  receipt_settle_sig?: string | null;
  receipt_open_sig?: string | null;
};

export function MarketCard({
  market,
  onPick,
  justSettled,
  readOnly,
  variant = "card",
}: {
  market: MarketT;
  onPick?: (outcome: string) => void;
  justSettled?: boolean;
  readOnly?: boolean;
  /** "flat" drops the card chrome for surfaces that already supply it (the app
   *  hero band), so outcome buttons never sit inside a card inside a card. */
  variant?: "card" | "flat";
}) {
  const settled = market.status === "settled" || market.status === "voided";
  const receipt = market.receipt_settle_sig ?? market.receipt_open_sig;
  const suspended = market.status === "suspended";
  const open = market.status === "open";

  return (
    <div
      className={`bg-kickr-navy-surface ${
        variant === "flat" ? "p-4" : "rounded-xl border border-kickr-navy-line p-3.5"
      } ${justSettled ? "settle-sweep" : ""}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-kickr-cream">{market.question}</p>
        {/* Only real state reaches the user — template_id is an internal code
            (PM1..PM4, M1..M8). Settled markets say so in the body already. */}
        {!open && !settled && (
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              suspended ? "bg-kickr-loss/15 text-kickr-loss" : "bg-kickr-navy text-kickr-cream-dim"
            }`}
          >
            {suspended ? "Suspended" : "Locked"}
          </span>
        )}
      </div>

      {!settled ? (
        <>
          {/* One row only when it fits: 1X2 and other 3-way markets stack, or the
              label and the price collide in the 30rem drawer. */}
          <div className={`mt-2.5 grid gap-2 ${market.outcomes.length === 2 ? "grid-cols-2" : "grid-cols-1"}`}>
            {market.outcomes.map((o) => (
              <button
                key={o}
                disabled={readOnly || !open}
                onClick={() => onPick?.(o)}
                className="flex items-center justify-between gap-2 rounded-lg border border-kickr-navy-line bg-kickr-navy px-3 py-2.5 text-sm text-kickr-cream/90 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kickr-yellow focus-visible:ring-offset-2 focus-visible:ring-offset-kickr-navy-surface enabled:hover:-translate-y-px enabled:hover:border-kickr-yellow/60 enabled:hover:text-kickr-cream disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="truncate">{o}</span>
                <span className="shrink-0 text-kickr-yellow">
                  <OddsNum value={market.prices?.[o]} />
                </span>
              </button>
            ))}
          </div>
          {suspended && (
            <p className="mt-2 text-xs text-kickr-cream-dim">
              Prices went stale — betting reopens when the feed catches up.
            </p>
          )}
        </>
      ) : (
        <div className="mt-2 text-sm">
          {market.status === "voided" ? (
            <span className="text-kickr-cream-dim">Voided — stakes refunded</span>
          ) : (
            <span className="text-kickr-cream/90">
              Settled:{" "}
              <b className="text-kickr-yellow">{market.settlement?.winning_outcome}</b>
              {market.settlement?.evidence?.score && (
                <span className="num text-kickr-cream-dim">
                  {" "}
                  ({market.settlement.evidence.score.join("-")}
                  {market.settlement.evidence.minute != null && ` @ ${market.settlement.evidence.minute}'`})
                </span>
              )}
            </span>
          )}
          {receipt && (
            <a
              className="ml-2 text-xs text-kickr-cream-dim underline decoration-kickr-yellow/50 underline-offset-2 hover:text-kickr-yellow"
              href={`https://explorer.solana.com/tx/${receipt}?cluster=devnet`}
              target="_blank"
              rel="noreferrer"
            >
              receipt ↗
            </a>
          )}
        </div>
      )}
    </div>
  );
}
