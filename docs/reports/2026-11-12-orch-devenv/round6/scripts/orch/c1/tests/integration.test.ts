// C1-style, own tests (not ADEMark's hidden tests): the four items together on main.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/api.ts";
import { sampleInvoices } from "../src/invoices.ts";

const VALID = {
  client: "Hooli",
  issued: "2026-03-01",
  netDays: 30,
  currency: "MXN",
  items: [{ description: "Licenses", quantity: 3, unitPriceCents: 4_900, taxRate: 0.16 }],
};

test("Integration: one app with rate limiting, creation, idempotency and cursor pages", () => {
  let now = Date.UTC(2026, 2, 1);
  const app = createApp({ invoices: sampleInvoices(12), now: () => now, rateLimit: { capacity: 50, refillPerSecond: 1, now: () => now } } as never);
  const handle = (request: unknown) => app.handle(request as never) as { status: number; headers: Record<string, string>; body: unknown };
  const created = handle({ method: "POST", path: "/invoices", headers: { "x-api-key": "i", "idempotency-key": "x" }, body: VALID });
  assert.equal(created.status, 201);
  assert.equal(created.headers["x-ratelimit-remaining"], "49");
  const replay = handle({ method: "POST", path: "/invoices", headers: { "x-api-key": "i", "idempotency-key": "x" }, body: VALID });
  assert.equal(replay.headers["idempotent-replay"], "true");
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const page = handle({ method: "GET", path: `/invoices?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, headers: { "x-api-key": "i" } });
    assert.equal(page.status, 200);
    assert.ok("x-ratelimit-remaining" in page.headers);
    const body = page.body as { items: { id: string; due: string }[]; nextCursor: string | null };
    ids.push(...body.items.map((item) => item.id));
    cursor = body.nextCursor;
  } while (cursor);
  assert.deepEqual(ids, [...sampleInvoices(12).map((invoice) => invoice.id), "INV-01013"]);
  // A limited POST creates nothing.
  for (let i = 0; i < 60; i++) {
    handle({ method: "GET", path: "/invoices?limit=1", headers: { "x-api-key": "i" } });
  }
  const limited = handle({ method: "POST", path: "/invoices", headers: { "x-api-key": "i" }, body: VALID });
  assert.equal(limited.status, 429);
  now += 10_000;
  assert.equal((handle({ method: "POST", path: "/invoices", headers: { "x-api-key": "i" }, body: VALID }).body as { id: string }).id, "INV-01014");
});

test("Integration: due dates through the API are the same west of UTC", () => {
  const api = fileURLToPath(new URL("../src/api.ts", import.meta.url));
  const script = `const { createApp } = await import(${JSON.stringify(api)});
const { sampleInvoices } = await import(${JSON.stringify(api.replace("api.ts", "invoices.ts"))});
const app = createApp({ invoices: sampleInvoices(1) });
const created = app.handle({ method: "POST", path: "/invoices", headers: {}, body: { client: "A", issued: "2026-03-01", netDays: 30, currency: "USD", items: [{ description: "x", quantity: 1, unitPriceCents: 100, taxRate: 0 }] } });
const page = app.handle({ method: "GET", path: "/invoices", headers: {} });
console.log(JSON.stringify({ status: created.status, due: page.body.items.at(-1).due }));`;
  for (const zone of ["America/Los_Angeles", "Asia/Tokyo"]) {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TZ: zone }, encoding: "utf8" });
    assert.deepEqual(JSON.parse(out.trim().split("\n").at(-1)!), { status: 201, due: "2026-03-31" }, zone);
  }
});

test("Integration: the HTTP server reads a JSON body, creates, and pages with cursors", async () => {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/server.ts", import.meta.url))], { env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(`${url}/health`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const created = await fetch(`${url}/invoices`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "srv" }, body: JSON.stringify(VALID) });
    assert.equal(created.status, 201);
    const invoice = await created.json() as { id: string };
    assert.equal(created.headers.get("location"), `/invoices/${invoice.id}`);
    const replay = await fetch(`${url}/invoices`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "srv" }, body: JSON.stringify(VALID) });
    assert.equal(replay.headers.get("idempotent-replay"), "true");
    const invalid = await fetch(`${url}/invoices`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client: "" }) });
    assert.equal(invalid.status, 400);
    const page = await fetch(`${url}/invoices?limit=5`);
    assert.equal(page.status, 200);
    const body = await page.json() as { items: unknown[]; nextCursor: string | null; limit: number };
    assert.equal(body.items.length, 5);
    assert.equal(body.limit, 5);
    assert.equal(typeof body.nextCursor, "string");
    assert.ok(page.headers.get("x-ratelimit-remaining") !== null);
  } finally {
    child.kill();
  }
});
