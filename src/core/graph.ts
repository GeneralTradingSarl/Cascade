/**
 * Thin client over the Meta Graph API.
 *
 * The retry policy is the part that matters. Meta answers with HTTP 200 and an `error` body
 * about as often as it answers with a 4xx, and the codes mean very different things:
 *
 *   4     application request limit reached   -> back off, the app is throttled, not broken
 *   17    user request limit reached          -> same, per user
 *   32    page request limit reached          -> same, per page
 *   80007 IG business rate limit              -> the publishing quota, back off hard
 *   613   custom rate limit                   -> back off
 *   190   invalid or expired token            -> never retry, the operator must act
 *   100   invalid parameter                   -> never retry, the request is wrong
 *
 * Retrying a 190 forever is how an integration turns a two-minute fix into a silent outage.
 */
export type GraphError = {
  message: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  fbtrace_id?: string;
};

export class GraphApiError extends Error {
  readonly code: number | undefined;
  readonly subcode: number | undefined;
  readonly status: number;
  readonly retryable: boolean;

  constructor(status: number, error: GraphError) {
    super(`Graph API ${status}: ${error.message}${error.code ? ` (code ${error.code})` : ""}`);
    this.name = "GraphApiError";
    this.status = status;
    this.code = error.code;
    this.subcode = error.error_subcode;
    this.retryable = isRetryable(status, error.code);
  }
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80007]);
const FATAL_CODES = new Set([100, 190, 200, 803]);

export function isRetryable(status: number, code?: number): boolean {
  if (code !== undefined && FATAL_CODES.has(code)) return false;
  if (code !== undefined && RATE_LIMIT_CODES.has(code)) return true;
  if (status === 429) return true;
  return status >= 500;
}

export type Fetcher = typeof fetch;

export type GraphClientOptions = {
  baseUrl: string;
  version: string;
  accessToken: string;
  fetchImpl?: Fetcher;
  maxAttempts?: number;
  /** Injected so tests do not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
};

export class GraphClient {
  private readonly options: Required<GraphClientOptions>;

  constructor(options: GraphClientOptions) {
    this.options = {
      fetchImpl: fetch,
      maxAttempts: 4,
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      ...options,
    };
  }

  url(path: string): string {
    const clean = path.startsWith("/") ? path.slice(1) : path;
    return `${this.options.baseUrl}/${this.options.version}/${clean}`;
  }

  async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(this.url(path));
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set("access_token", this.options.accessToken);
    return this.request<T>(url.toString(), { method: "GET" });
  }

  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>(this.url(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, access_token: this.options.accessToken }),
    });
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await this.options.fetchImpl(url, init);
      } catch (cause) {
        // A dropped connection is worth one more try; a bad token is not.
        lastError = cause;
        if (attempt === this.options.maxAttempts) break;
        await this.options.sleep(backoffMs(attempt));
        continue;
      }

      const text = await response.text();
      const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};

      if (response.ok && !payload.error) return payload as T;

      const error = new GraphApiError(response.status, (payload.error as GraphError) ?? {
        message: text || response.statusText,
      });
      if (!error.retryable || attempt === this.options.maxAttempts) throw error;

      lastError = error;
      await this.options.sleep(backoffMs(attempt));
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

/** Exponential backoff with jitter, capped so a throttled worker still makes progress. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 30_000);
  return Math.round(base * (0.75 + random() * 0.5));
}
