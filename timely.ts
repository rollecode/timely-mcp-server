import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DIR = import.meta.dirname;
const ENV_PATH = resolve(DIR, ".env");
const TOKENS_PATH = process.env.TIMELY_TOKENS_PATH || resolve(DIR, ".tokens.json");
const TIMELY_BASE = "https://api.timelyapp.com/1.1";
const HTTP_UNAUTHORIZED = 401;

interface Tokens {
  access_token: string;
  refresh_token: string;
  created_at: number;
}

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (!existsSync(ENV_PATH)) {
    return env;
  }

  for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq > 0 && !env[trimmed.slice(0, eq)]) {
      env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
  }
  return env;
}

function loadTokens(): Tokens {
  if (!existsSync(TOKENS_PATH)) {
    throw new Error("No .tokens.json found. Run: bun auth.ts");
  }
  return JSON.parse(readFileSync(TOKENS_PATH, "utf-8"));
}

const env = loadEnv();
const ACCOUNT_ID = env.TIMELY_ACCOUNT_ID;
let accessToken = loadTokens().access_token;

if (!ACCOUNT_ID) {
  throw new Error("Missing TIMELY_ACCOUNT_ID in .env. Run: bun auth.ts");
}

async function refreshToken(): Promise<string> {
  const tokens = loadTokens();
  const res = await fetch(`${TIMELY_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: env.TIMELY_CLIENT_ID,
      client_secret: env.TIMELY_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
    }),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${await res.text()}`);
  }

  const fresh = await res.json();
  writeFileSync(TOKENS_PATH, JSON.stringify(fresh, null, 2), { mode: 0o600 });
  accessToken = fresh.access_token;
  return fresh.access_token;
}

function buildUrl(path: string, query?: Record<string, unknown>): string {
  const url = new URL(`${TIMELY_BASE}/${ACCOUNT_ID}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, unknown>;
}

/** Call the Timely API, refreshing the access token once if it has expired. */
export async function api(path: string, options: ApiOptions = {}): Promise<unknown> {
  const url = buildUrl(path, options.query);

  const send = (token: string) =>
    fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

  let res = await send(accessToken);
  if (res.status === HTTP_UNAUTHORIZED) {
    res = await send(await refreshToken());
  }

  if (!res.ok) {
    throw new Error(`Timely API ${res.status}: ${await res.text()}`);
  }

  return res.status === 204 ? { ok: true } : res.json();
}

export const accountId = ACCOUNT_ID;
