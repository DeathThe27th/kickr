"use client";

/** The 2026 knockout rounds (§8.2), dark system. One grid section per round,
 * R32 → Final. Nodes are interactive cards: upcoming (kickoff + favourite
 * win-prob bar), live (yellow accent, pulse, score+minute, glow), finished
 * (dimmed, final score). */

import React from "react";

export type FixtureT = {
  id: string;
  txline_fixture_id: number;
  stage: string;
  bracket_slot: string | null;
  home: string;
  away: string;
  kickoff_at: string;
  status: string;
  score: [number, number];
  minute: number;
  win_probs: Record<string, number> | null;
  open_markets: number;
};

const STAGES: { key: string; label: string }[] = [
  { key: "r32", label: "Round of 32" },
  { key: "r16", label: "Round of 16" },
  { key: "qf", label: "Quarter-finals" },
  { key: "sf", label: "Semi-finals" },
  { key: "f", label: "Final" },
];

function favourite(f: FixtureT): { name: string; pct: number; side: "home" | "away" } | null {
  if (!f.win_probs) return null;
  const home = f.win_probs.home ?? 0;
  const away = f.win_probs.away ?? 0;
  const side = home >= away ? "home" : "away";
  return { name: side === "home" ? f.home : f.away, pct: Math.round(Math.max(home, away) * 100), side };
}

function TeamRow({ name, score, show, lead }: { name: string; score: number; show: boolean; lead: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className={`truncate text-sm ${lead ? "font-semibold text-kickr-cream" : "text-kickr-cream/85"}`}>
        {name}
      </span>
      {show && <span className="num text-sm font-semibold text-kickr-cream">{score}</span>}
    </div>
  );
}

function Node({ f, onOpen }: { f: FixtureT; onOpen: (f: FixtureT) => void }) {
  const live = f.status === "live";
  const finished = f.status === "finished";
  const showScore = live || finished;
  const fav = favourite(f);
  const homeLead = showScore && f.score[0] > f.score[1];
  const awayLead = showScore && f.score[1] > f.score[0];

  return (
    <button
      onClick={() => onOpen(f)}
      className={`group relative w-full overflow-hidden rounded-2xl border p-3.5 text-left transition-all duration-200 hover:-translate-y-0.5 ${
        live
          ? "border-kickr-yellow/60 bg-kickr-yellow/[0.06] shadow-live-glow"
          : finished
            ? "border-kickr-navy-line/60 bg-kickr-navy-surface/50 opacity-70 hover:opacity-100"
            : "border-kickr-navy-line bg-kickr-navy-surface hover:border-kickr-yellow/40"
      }`}
    >
      {/* status ribbon */}
      <div className="mb-2.5 flex items-center justify-between">
        {live ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-kickr-yellow">
            <span className="pulse-dot" />
            <span className="num">{f.minute}&prime;</span> live
          </span>
        ) : finished ? (
          <span className="text-xs font-semibold uppercase tracking-wide text-kickr-cream-dim">Full time</span>
        ) : (
          <span className="num text-xs text-kickr-cream-dim">
            {f.kickoff_at
              ? `${new Date(f.kickoff_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${new Date(
                  f.kickoff_at
                ).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
              : "TBD"}
          </span>
        )}
        {f.open_markets > 0 && (
          <span
            className={`num rounded-full px-1.5 py-0.5 text-[11px] font-bold ${
              live ? "bg-kickr-yellow text-kickr-navy" : "bg-kickr-navy text-kickr-yellow"
            }`}
          >
            {f.open_markets}
          </span>
        )}
      </div>

      <div className="space-y-1">
        <TeamRow name={f.home} score={f.score[0]} show={showScore} lead={homeLead} />
        <TeamRow name={f.away} score={f.score[1]} show={showScore} lead={awayLead} />
      </div>

      {/* favourite win-prob bar (pre-match only) */}
      {!showScore && fav && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-[11px] text-kickr-cream-dim">
            <span className="truncate">{fav.name}</span>
            <span className="num">{fav.pct}%</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-kickr-navy">
            <div className="h-full rounded-full bg-kickr-cream/40" style={{ width: `${fav.pct}%` }} />
          </div>
        </div>
      )}

      <span className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-kickr-yellow/40 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

export function Bracket({ fixtures, onOpen }: { fixtures: FixtureT[]; onOpen: (f: FixtureT) => void }) {
  return (
    <div className="space-y-10">
      {STAGES.map((stage) => {
        const nodes = fixtures
          .filter((f) => f.stage === stage.key)
          .sort((a, b) => (a.bracket_slot ?? "").localeCompare(b.bracket_slot ?? "", undefined, { numeric: true }));
        if (nodes.length === 0) return null;
        return (
          <section key={stage.key}>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.15em] text-kickr-cream-dim">
              {stage.label}
            </h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {nodes.map((f) => (
                <Node key={f.id} f={f} onOpen={onOpen} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
