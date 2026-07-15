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

  return (
    <div
      className={`bg-kickr-navy-surface ${
        variant === "flat" ? "p-4" : "rounded-xl border border-kickr-navy-line p-3.5"
      } ${justSettled ? "settle-sweep" : ""} ${suspended ? "opacity-60" : ""}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-kickr-cream">{market.question}</p>
        <span
          className={`shrink-0 text-[10px] font-semibold uppercase tracking-wide ${
            suspended ? "text-kickr-loss" : "text-kickr-cream-dim"
          }`}
        >
          {market.status === "open" ? market.template_id : market.status}
        </span>
      </div>

      {!settled ? (
        <div className="mt-2.5 grid grid-flow-col gap-2">
          {market.outcomes.map((o) => (
            <button
              key={o}
              disabled={readOnly || market.status !== "open"}
              onClick={() => onPick?.(o)}
              className="flex items-center justify-between gap-2 rounded-lg border border-kickr-navy-line bg-kickr-navy px-3 py-2.5 text-sm text-kickr-cream/90 transition-all enabled:hover:-translate-y-px enabled:hover:border-kickr-yellow/60 enabled:hover:text-kickr-cream disabled:cursor-default disabled:opacity-80"
            >
              <span>{o}</span>
              <span className="text-kickr-yellow">
                <OddsNum value={market.prices?.[o]} />
              </span>
            </button>
          ))}
        </div>
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
