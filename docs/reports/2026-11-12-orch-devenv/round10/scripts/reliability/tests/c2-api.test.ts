// Own tests (not ADEMark's hidden tests), from the C2 task text in TASKS.md: rate limiting wired into createApp.
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/api.ts";
import { sampleInvoices } from "../src/invoices.ts";

function app(capacity: number, refillPerSecond: number) {
  let now = 5_000_000;
  const instance = createApp({ invoices: sampleInvoices(5), rateLimit: { capacity, refillPerSecond, now: () => now } } as never);
  return { instance, advance: (ms: number) => { now += ms; } };
}
const get = (path: string, key?: string) => ({ method: "GET", path, headers: key ? { "x-api-key": key } : {} });

test("W1-api: a limited request is 429 rate_limited with retry-after in whole seconds, at least 1", () => {
  const { instance, advance } = app(1, 1);
  assert.equal(instance.handle(get("/invoices", "k")).status, 200);
  advance(300);
  const limited = instance.handle(get("/invoices", "k"));
  assert.equal(limited.status, 429);
  assert.deepEqual(limited.body, { error: "rate_limited" });
  assert.equal(limited.headers["retry-after"], "1");
  const slow = app(1, 0.25);
  slow.instance.handle(get("/invoices", "s"));
  assert.equal(slow.instance.handle(get("/invoices", "s")).headers["retry-after"], "4");
});

test("W1-api: GET /health takes no token", () => {
  const { instance } = app(1, 1);
  for (let i = 0; i < 3; i++) assert.equal(instance.handle(get("/health", "k")).status, 200);
  assert.equal(instance.handle(get("/invoices", "k")).status, 200);
});

test("W1-api: the key is x-api-key, or anonymous without it", () => {
  const { instance } = app(1, 1);
  assert.equal(instance.handle(get("/invoices")).status, 200);
  assert.equal(instance.handle(get("/invoices")).status, 429);
  assert.equal(instance.handle(get("/invoices", "other")).status, 200);
  assert.equal(instance.handle(get("/invoices", "anonymous")).status, 429);
});

test("W1-api: other methods take a token too, and no rateLimit option means no limit", () => {
  const { instance } = app(1, 1);
  instance.handle({ method: "DELETE", path: "/invoices/INV-01001", headers: { "x-api-key": "m" } });
  assert.equal(instance.handle(get("/invoices", "m")).status, 429);
  const open = createApp({ invoices: sampleInvoices(5) });
  for (let i = 0; i < 200; i++) assert.equal(open.handle(get("/invoices", "k")).status, 200);
});
