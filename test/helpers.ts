import { openDatabase, type Db } from "../src/core/db.js";
import type { Config } from "../src/config.js";

export function testDb(): Db {
  return openDatabase(":memory:");
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    databasePath: ":memory:",
    publicUrl: "http://localhost",
    meta: {
      appSecret: "app-secret",
      verifyToken: "verify-token",
      graphVersion: "v21.0",
      graphBaseUrl: "https://graph.test",
    },
    instagram: {
      accountId: "17841400000000000",
      accessToken: "ig-token",
      dailyPublishLimit: 50,
    },
    whatsapp: {
      phoneNumberId: "1234567890",
      accessToken: "wa-token",
      reengagementTemplate: "lead_follow_up",
      templateLanguage: "en",
    },
    apiKey: "test-key",
    ...overrides,
  };
}

/**
 * A fetch double that answers from a script of responses keyed by a substring of the URL,
 * and records every call so a test can assert on what was actually sent to Meta.
 */
export type Call = { url: string; method: string; body: any };

export function fakeFetch(script: { match: string; status?: number; body: unknown; once?: boolean }[]) {
  const calls: Call[] = [];
  const remaining = script.map((entry) => ({ ...entry, used: false }));

  const impl = (async (input: any, init: any = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method: init.method ?? "GET", body });

    const entry = remaining.find((candidate) => url.includes(candidate.match) && !(candidate.once && candidate.used));
    if (!entry) throw new Error(`fakeFetch: no scripted response for ${url}`);
    entry.used = true;

    return new Response(JSON.stringify(entry.body), {
      status: entry.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return { impl, calls };
}

export const noSleep = async (): Promise<void> => {};
