"use client";

import React, { useState } from "react";
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
}: {
  market: MarketT;
  onPick?: (outcome: string) => void;
  justSettled?: boolean;
  readOnly?: boolean;
}) {
  const settled = market.status === "settled" || market.status === "voided";
  const receipt = market.receipt_settle_sig ?? market.receipt_open_sig;
  return (
    <div
      className={`rounded-xl border border-kickr-line bg-white p-3 ${justSettled ? "settle-sweep" : ""} ${
        market.status === "suspended" ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold">{market.question}</p>
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-kickr-ink/50">
          {market.status === "open" ? market.template_id : market.status}
        </span>
      </div>
      {!settled ? (
        <div className="mt-2 grid grid-flow-col gap-2">
          {market.outcomes.map((o) => (
            <button
              key={o}
              disabled={readOnly || market.status !== "open"}
              onClick={() => onPick?.(o)}
              className="flex items-center justify-between gap-2 rounded-lg border border-kickr-line px-3 py-2 text-sm transition-colors enabled:hover:border-kickr-yellow-deep enabled:hover:bg-kickr-yellow/20 disabled:cursor-default"
            >
              <span>{o}</span>
              <OddsNum value={market.prices?.[o]} />
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-2 text-sm">
          {market.status === "voided" ? (
            <span className="text-kickr-ink/60">Voided — stakes refunded</span>
          ) : (
            <span>
              Settled: <b>{market.settlement?.winning_outcome}</b>
              {market.settlement?.evidence?.score && (
                <span className="num text-kickr-ink/60">
                  {" "}
                  ({market.settlement.evidence.score.join("-")}
                  {market.settlement.evidence.minute != null && ` @ ${market.settlement.evidence.minute}'`})
                </span>
              )}
            </span>
          )}
          {receipt && (
            <a
              className="ml-2 text-xs underline decoration-kickr-yellow-deep underline-offset-2 hover:text-kickr-yellow-deep"
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
