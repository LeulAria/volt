// C2-F2, own test: every response, including 404, 405 and 429, has x-request-id; an incoming x-request-id is
// echoed; a generated id is a UUID and differs between requests.
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/api.ts";
import { sampleInvoices } from "../src/invoices.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const app = () => createApp({ invoices: sampleInvoices(5), rateLimit: { capacity: 1, refillPerSecond: 1, now: () => 1_000_000 } } as never);

test("C2-F2: a generated x-request-id is a UUID and differs between requests", () => {
  const instance = app();
  const a = instance.handle({ method: "GET", path: "/health", headers: {} });
  const b = instance.handle({ method: "GET", path: "/health", headers: {} });
  assert.match(String(a.headers["x-request-id"]), UUID);
  assert.match(String(b.headers["x-request-id"]), UUID);
  assert.notEqual(a.headers["x-request-id"], b.headers["x-request-id"]);
});

test("C2-F2: an incoming x-request-id is echoed", () => {
  const instance = app();
  const r = instance.handle({ method: "GET", path: "/invoices", headers: { "x-request-id": "req-abc-123" } });
  assert.equal(r.headers["x-request-id"], "req-abc-123");
});

test("C2-F2: 404, 405 and 429 responses carry x-request-id too", () => {
  const instance = app();
  const notFound = instance.handle({ method: "GET", path: "/nothing", headers: {} });
  assert.equal(notFound.status, 404);
  assert.match(String(notFound.headers["x-request-id"]), UUID);
  const method = instance.handle({ method: "PATCH", path: "/invoices", headers: {} });
  assert.equal(method.status, 405);
  assert.match(String(method.headers["x-request-id"]), UUID);
  instance.handle({ method: "GET", path: "/invoices", headers: { "x-api-key": "k" } });
  const limited = instance.handle({ method: "GET", path: "/invoices", headers: { "x-api-key": "k" } });
  assert.equal(limited.status, 429);
  assert.match(String(limited.headers["x-request-id"]), UUID);
});
