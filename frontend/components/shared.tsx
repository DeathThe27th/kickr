"use client";

import React, { useEffect, useRef, useState } from "react";
import { fmtOdds } from "@/lib/api";
import { flagUrl } from "@/lib/flags";

/** A nation's flag. Renders nothing for unresolved slots ("Winner SF1") rather
 *  than a broken box. Fixed dimensions — flags load late and must not shift the
 *  score line under them. */
export function TeamFlag({ team, className = "" }: { team: string; className?: string }) {
  const src = flagUrl(team, 80);
  if (!src) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      srcSet={`${src} 1x, ${flagUrl(team, 160)} 2x`}
      alt=""
      aria-hidden
      loading="lazy"
      width={36}
      height={24}
      className={`h-6 w-9 shrink-0 rounded-[3px] object-cover ring-1 ring-kickr-cream/20 ${className}`}
    />
  );
}

/** Odds figure that flicks green/red for 400ms on change (§8.1 motion). */
export function OddsNum({ value }: { value: number | undefined }) {
  const prev = useRef<number | undefined>(value);
  const [flick, setFlick] = useState<"" | "flick-up" | "flick-down">("");
  useEffect(() => {
    if (prev.current !== undefined && value !== undefined && value !== prev.current) {
      setFlick(value > prev.current ? "flick-up" : "flick-down");
      const t = setTimeout(() => setFlick(""), 450);
      return () => clearTimeout(t);
    }
    prev.current = value;
  }, [value]);
  useEffect(() => {
    prev.current = value;
  }, [value]);
  return <span className={`num font-semibold ${flick}`}>{fmtOdds(value)}</span>;
}

export function LivePill({ minute }: { minute: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-kickr-ink px-2 py-0.5 text-xs font-semibold text-kickr-yellow">
      <span className="pulse-dot" />
      <span className="num">{minute}&prime;</span>
    </span>
  );
}

export function Wordmark({ className = "", dot = true }: { className?: string; dot?: boolean }) {
  // Hand-lettered "kickr." mark. The period is part of the logo.
  return (
    <span className={`wordmark leading-none ${className}`}>
      kickr{dot && <span className="text-kickr-yellow">.</span>}
    </span>
  );
}

export function ChipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="inline-block" aria-hidden>
      <circle cx="7" cy="7" r="6" fill="#FFDE00" stroke="#101314" strokeWidth="1.2" />
      <circle cx="7" cy="7" r="3" fill="none" stroke="#101314" strokeWidth="1" strokeDasharray="1.5 1.5" />
    </svg>
  );
}

export function Toast({ text, onDone }: { text: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3500);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl bg-kickr-ink px-4 py-3 text-sm text-white shadow-lg">
      {text}
    </div>
  );
}
