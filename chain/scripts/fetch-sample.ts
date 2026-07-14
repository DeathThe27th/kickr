/**
 * Fetch sample World Cup fixtures + odds from TxLINE devnet and save the raw
 * responses to backend/fixtures/samples/.
 *
 * Uses the credentials produced by activate-txline.ts
 * (chain/.txline-credentials.json), overridable via TXLINE_JWT /
 * TXLINE_API_TOKEN env vars. On a 401 it renews the guest JWT from
 * /auth/guest/start (same host), persists it, and retries — same pattern as
 * the official examples' apiClient interceptor.
 *
 * Endpoints (per github.com/txodds/tx-on-chain examples/devnet):
 *   GET /api/fixtures/snapshot?competitionId=72&startEpochDay=<days since epoch>
 *   GET /api/odds/snapshot/{fixtureId}[?asOf=<ms>]
 *
 * Run:  npm run fetch-sample   (from chain/)
 */

import axios, { AxiosInstance } from "axios";
import * as fs from "fs";
import * as path from "path";

const API_ORIGIN = process.env.TXLINE_API_ORIGIN ?? "https://txline-dev.txodds.com";
const API_BASE_URL = `${API_ORIGIN}/api`;
const JWT_URL = `${API_ORIGIN}/auth/guest/start`;

const WORLD_CUP_COMPETITION_ID = 72; // competition used by the official free-tier example
const MAX_ODDS_FIXTURES = 6; // how many fixtures to pull odds snapshots for

const CHAIN_DIR = path.resolve(__dirname, "..");
const CREDENTIALS_PATH = path.join(CHAIN_DIR, ".txline-credentials.json");
const SAMPLES_DIR = path.resolve(CHAIN_DIR, "..", "backend", "fixtures", "samples");

type Credentials = { jwt: string; apiToken: string; [k: string]: unknown };

function loadCredentials(): Credentials {
  let creds: Credentials = { jwt: "", apiToken: "" };
  if (fs.existsSync(CREDENTIALS_PATH)) {
    creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
  }
  creds.jwt = process.env.TXLINE_JWT ?? creds.jwt;
  creds.apiToken = process.env.TXLINE_API_TOKEN ?? creds.apiToken;
  if (!creds.jwt || !creds.apiToken) {
    throw new Error(
      `Missing credentials. Run activate-txline.ts first (expected ${CREDENTIALS_PATH}) ` +
        `or set TXLINE_JWT and TXLINE_API_TOKEN.`
    );
  }
  return creds;
}

function makeClient(creds: Credentials): AxiosInstance {
  const client = axios.create({ baseURL: API_BASE_URL });
  client.interceptors.request.use((cfg) => {
    cfg.headers["Authorization"] = `Bearer ${creds.jwt}`;
    cfg.headers["X-Api-Token"] = creds.apiToken;
    return cfg;
  });
  client.interceptors.response.use(
    (res) => res,
    async (error) => {
      const original = error.config;
      if (error.response?.status === 401 && !original._retry) {
        original._retry = true;
        console.log("[auth] 401 — renewing guest JWT and retrying...");
        const res = await axios.post(JWT_URL);
        creds.jwt = res.data.token;
        if (fs.existsSync(CREDENTIALS_PATH)) {
          const onDisk = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
          onDisk.jwt = creds.jwt;
          onDisk.renewedAt = new Date().toISOString();
          fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(onDisk, null, 2), { mode: 0o600 });
        }
        return client(original);
      }
      return Promise.reject(error);
    }
  );
  return client;
}

function save(name: string, data: unknown): string {
  const file = path.join(SAMPLES_DIR, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`  saved ${path.relative(process.cwd(), file)}`);
  return file;
}

// Best-effort field extraction for the human-readable summary; the raw
// payloads on disk are the source of truth.
function pick(obj: any, ...keys: string[]): any {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

function summarizeFixture(f: any): string {
  const id = pick(f, "fixtureId", "FixtureId", "id", "Id");
  const home = pick(f, "homeTeam", "HomeTeam", "home", "Home", "homeTeamName", "hteam");
  const away = pick(f, "awayTeam", "AwayTeam", "away", "Away", "awayTeamName", "ateam");
  const rawKo = pick(f, "kickoff", "Kickoff", "startTime", "StartTime", "ko", "date", "Date", "startTs", "ts", "Ts");
  let ko = String(rawKo ?? "?");
  const n = Number(rawKo);
  if (Number.isFinite(n) && n > 1e9) {
    ko = new Date(n > 1e12 ? n : n * 1000).toISOString();
  }
  return `#${id ?? "?"}  ${home ?? "?"} vs ${away ?? "?"}  @ ${ko}`;
}

async function main() {
  const creds = loadCredentials();
  const client = makeClient(creds);
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });

  const todayEpochDay = Math.floor(Date.now() / 86_400_000);

  // The tournament spans several weeks; sweep a few 10-day windows around now
  // (fixture roots are grouped in ten-day ranges per the docs).
  const offsets = [-30, -20, -10, 0];
  const allFixtures: any[] = [];
  const seen = new Set<string>();

  for (const off of offsets) {
    const day = todayEpochDay + off;
    const url = `/fixtures/snapshot?competitionId=${WORLD_CUP_COMPETITION_ID}&startEpochDay=${day}`;
    console.log(`GET ${url}`);
    try {
      const res = await client.get(url);
      save(`fixtures_snapshot_day${day}.json`, res.data);
      const list = Array.isArray(res.data) ? res.data : res.data?.fixtures ?? [];
      for (const f of list) {
        const key = JSON.stringify(pick(f, "fixtureId", "FixtureId", "id", "Id") ?? f);
        if (!seen.has(key)) {
          seen.add(key);
          allFixtures.push(f);
        }
      }
      console.log(`  ${list.length} fixture record(s)`);
    } catch (err) {
      if (axios.isAxiosError(err)) {
        console.error(`  failed: ${err.response?.status} ${JSON.stringify(err.response?.data ?? err.message)}`);
      } else throw err;
    }
  }

  console.log(`\nTotal distinct fixtures: ${allFixtures.length}`);
  for (const f of allFixtures) console.log(`  ${summarizeFixture(f)}`);

  // Odds snapshots for the first few fixtures.
  const fixtureIds = allFixtures
    .map((f) => pick(f, "fixtureId", "FixtureId", "id", "Id"))
    .filter((id) => id !== undefined)
    .slice(0, MAX_ODDS_FIXTURES);

  console.log(`\nFetching odds snapshots for ${fixtureIds.length} fixture(s)...`);
  for (const id of fixtureIds) {
    const url = `/odds/snapshot/${id}?asOf=${Date.now()}`;
    console.log(`GET ${url}`);
    try {
      const res = await client.get(url);
      save(`odds_snapshot_${id}.json`, res.data);
      const count = Array.isArray(res.data) ? res.data.length : 1;
      console.log(`  ${count} odds record(s)`);
    } catch (err) {
      if (axios.isAxiosError(err)) {
        console.error(`  failed: ${err.response?.status} ${JSON.stringify(err.response?.data ?? err.message)}`);
      } else throw err;
    }
  }

  console.log(`\nDone. Raw responses are in ${SAMPLES_DIR}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    if (axios.isAxiosError(err)) {
      console.error("Request failed:", err.response?.status, err.response?.data ?? err.message);
    } else {
      console.error(err);
    }
    process.exit(1);
  }
);
