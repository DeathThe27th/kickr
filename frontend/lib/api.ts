"use client";

/** API client + SSE subscription. */

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export class ApiError extends Error {
  constructor(public status: number, public detail: any) {
    super(typeof detail === "string" ? detail : detail?.error ?? "request failed");
  }
}

export async function api(path: string, opts: RequestInit = {}, token?: string | null) {
  const res = await fetch(`${API_URL}/api${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.detail ?? body);
  return body;
}

export type StreamEvent = { event: string; [k: string]: any };

/** Subscribe once to the SSE stream; callers filter client-side (§7). */
export function subscribeStream(onEvent: (ev: StreamEvent) => void): () => void {
  const es = new EventSource(`${API_URL}/api/stream`);
  es.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data));
    } catch {
      /* keepalive */
    }
  };
  return () => es.close();
}

export function fmtOdds(x: number | undefined): string {
  return x === undefined ? "–" : x.toFixed(2);
}

export function fmtClock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}
