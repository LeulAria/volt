// File contents the scripted model ("brain") writes for ADEMark's C tasks. Own solutions, written from the task
// texts in TASKS.md (ADEMark's reference solutions are private). Graded by grade.mjs with own tests.

export const PAGINATE_FIXED = `export interface Page<T> {
  items: T[];
  /** 1-based page number. */
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

export function paginate<T>(all: readonly T[], page: number, pageSize: number): Page<T> {
  if (!Number.isInteger(page) || page < 1) {
    throw new RangeError(\`page must be an integer >= 1, got \${page}\`);
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError(\`pageSize must be an integer >= 1, got \${pageSize}\`);
  }

  const totalItems = all.length;
  const totalPages = Math.ceil(totalItems / pageSize);
  const start = (page - 1) * pageSize;
  const end = start + pageSize;

  return {
    items: all.slice(start, end),
    page,
    pageSize,
    totalItems,
    totalPages,
    hasPrevious: page > 1,
    hasNext: page < totalPages,
  };
}
`;

export const RATE_LIMITER = `export interface RateLimiterOptions {
  capacity: number;
  refillPerSecond: number;
  now?: () => number;
}

export interface TakeResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export function createRateLimiter(options: RateLimiterOptions) {
  const now = options.now ?? Date.now;
  const buckets = new Map<string, { tokens: number; at: number }>();

  function take(key: string, cost = 1): TakeResult {
    const t = now();
    const bucket = buckets.get(key) ?? { tokens: options.capacity, at: t };
    bucket.tokens = Math.min(options.capacity, bucket.tokens + ((t - bucket.at) / 1000) * options.refillPerSecond);
    bucket.at = t;
    buckets.set(key, bucket);
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
    }
    return {
      allowed: false,
      remaining: Math.floor(bucket.tokens),
      retryAfterMs: Math.ceil(((cost - bucket.tokens) / options.refillPerSecond) * 1000),
    };
  }

  return { take };
}
`;

/** src/api.ts. cursor: W3 (C4-C6). limit / reqId / dueOn: C2 and its follow-ups 2 and 3. */
export function apiTs({ cursor = false, limit = false, reqId = false, dueOn = false } = {}) {
	return `${reqId ? 'import { randomUUID } from "node:crypto";\n' : ''}import { dueDate } from "./dates.ts";
import { sampleInvoices, totalCents } from "./invoices.ts";
import type { Invoice } from "./invoices.ts";
${cursor ? '' : 'import { paginate } from "./paginate.ts";\n'}${limit ? 'import { createRateLimiter } from "./rate-limiter.ts";\n' : ''}
export interface Request {
  method: string;
  /** Path with an optional query string, for example \`/invoices?${cursor ? 'limit=20' : 'page=2'}\`. */
  path: string;
  /** Header names are lowercase. */
  headers?: Record<string, string>;
}

export interface Response {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface AppOptions {
  invoices?: Invoice[];
${limit ? '  rateLimit?: { capacity: number; refillPerSecond: number; now?: () => number };\n' : ''}}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return { status, headers: { "content-type": "application/json", ...headers }, body };
}

function toSummary(invoice: Invoice) {
  return {
    id: invoice.id,
    client: invoice.client,
    status: invoice.status,
    currency: invoice.currency,
    totalCents: totalCents(invoice),
${dueOn ? '    dueOn: dueDate(invoice),\n    /** @deprecated use dueOn */\n' : ''}    due: dueDate(invoice),
  };
}
${cursor ? `
function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ after: id }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { after?: unknown };
    return typeof value?.after === "string" && encodeCursor(value.after) === cursor ? value.after : null;
  } catch {
    return null;
  }
}
` : ''}
export function createApp(options: AppOptions = {}) {
  const invoices = options.invoices ?? sampleInvoices(57);
  const byId = new Map(invoices.map((invoice) => [invoice.id, invoice]));
${limit ? '  const limiter = options.rateLimit ? createRateLimiter(options.rateLimit) : undefined;\n' : ''}
  function ${reqId ? 'route' : 'handle'}(request: Request): Response {
    const url = new URL(request.path, "http://ledger.local");
${limit ? `
    if (limiter && !(request.method === "GET" && url.pathname === "/health")) {
      const taken = limiter.take(request.headers?.["x-api-key"] ?? "anonymous");
      if (!taken.allowed) {
        const seconds = Math.max(1, Math.ceil(taken.retryAfterMs / 1000));
        return json(429, { error: "rate_limited" }, { "retry-after": String(seconds) });
      }
    }
` : ''}
    if (request.method !== "GET") {
      return json(405, { error: "method_not_allowed" });
    }
    if (url.pathname === "/health") {
      return json(200, { ok: true });
    }
    if (url.pathname === "/invoices") {
${cursor ? `      if (url.searchParams.has("page") || url.searchParams.has("pageSize")) {
        return json(400, { error: "use_cursor" });
      }
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit === null ? 20 : /^\\d+$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return json(400, { error: "bad_request" });
      }
      const sorted = [...invoices].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      let start = 0;
      const rawCursor = url.searchParams.get("cursor");
      if (rawCursor !== null) {
        const after = decodeCursor(rawCursor);
        if (after === null) {
          return json(400, { error: "bad_cursor" });
        }
        const index = sorted.findIndex((invoice) => invoice.id > after);
        start = index < 0 ? sorted.length : index;
      }
      const items = sorted.slice(start, start + limit);
      const nextCursor = start + limit < sorted.length ? encodeCursor(items[items.length - 1]!.id) : null;
      return json(200, { items: items.map(toSummary), nextCursor, limit });
` : `      const page = Number(url.searchParams.get("page") ?? "1");
      const pageSize = Number(url.searchParams.get("pageSize") ?? "20");
      try {
        const result = paginate(invoices, page, pageSize);
        return json(200, { ...result, items: result.items.map(toSummary) });
      } catch (error) {
        if (error instanceof RangeError) {
          return json(400, { error: "bad_request", message: error.message });
        }
        throw error;
      }
`}    }

    const match = /^\\/invoices\\/([\\w-]+)$/.exec(url.pathname);
    if (match) {
      const invoice = byId.get(match[1]!);
      return invoice ? json(200, invoice) : json(404, { error: "not_found" });
    }
    return json(404, { error: "not_found" });
  }
${reqId ? `
  function handle(request: Request): Response {
    const response = route(request);
    const given = request.headers?.["x-request-id"];
    response.headers["x-request-id"] = given !== undefined && given.length > 0 ? given : randomUUID();
    return response;
  }
` : ''}
  return { handle };
}
`;
}

/** src/server.ts for C2. rps: follow-up 1 (RATE_LIMIT_RPS). */
export function serverTs({ rps = false } = {}) {
	return `import { createServer } from "node:http";
import { createApp } from "./api.ts";

${rps ? `const rawRps = process.env.RATE_LIMIT_RPS ?? "";
const rps = /^\\d+$/.test(rawRps) ? Number(rawRps) : 0;
const rateLimit = rps > 0 ? { capacity: rps, refillPerSecond: rps } : { capacity: 60, refillPerSecond: 1 };
const app = createApp({ rateLimit });` : 'const app = createApp({ rateLimit: { capacity: 60, refillPerSecond: 1 } });'}
const port = Number(process.env.PORT ?? 3000);

createServer((incoming, outgoing) => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === "string") headers[name.toLowerCase()] = value;
  }
  const response = app.handle({ method: incoming.method ?? "GET", path: incoming.url ?? "/", headers });
  outgoing.writeHead(response.status, response.headers);
  outgoing.end(JSON.stringify(response.body));
}).listen(port, () => {
  console.log(\`ledger listening on http://localhost:\${port}\`);
});
`;
}

export const CURSOR_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/api.ts";
import { sampleInvoices } from "../src/invoices.ts";

test("cursor pagination walks every invoice once", () => {
  const app = createApp({ invoices: sampleInvoices(45) });
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const query: string = cursor === null ? "limit=10" : \`limit=10&cursor=\${encodeURIComponent(cursor)}\`;
    const response = app.handle({ method: "GET", path: \`/invoices?\${query}\` });
    assert.equal(response.status, 200);
    const body = response.body as { items: { id: string }[]; nextCursor: string | null };
    seen.push(...body.items.map((item) => item.id));
    cursor = body.nextCursor;
  } while (cursor !== null);
  assert.equal(seen.length, 45);
  assert.equal(new Set(seen).size, 45);
});
`;
