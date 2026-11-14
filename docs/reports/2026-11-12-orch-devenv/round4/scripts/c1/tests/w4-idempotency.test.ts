// C1-style, own tests (not ADEMark's hidden tests): W4 idempotency keys.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/api.ts";
import { sampleInvoices } from "../src/invoices.ts";

const VALID = {
  client: "Initech",
  issued: "2026-03-01",
  netDays: 30,
  currency: "USD",
  items: [{ description: "Audit", quantity: 1, unitPriceCents: 1000, taxRate: 0 }],
};
const DAY = 24 * 3600 * 1000;
const post = (body: unknown, key?: string) => ({ method: "POST", path: "/invoices", headers: key ? { "idempotency-key": key } : {}, body });

function app() {
  let now = Date.UTC(2026, 2, 1);
  const instance = createApp({ invoices: sampleInvoices(3), now: () => now } as never);
  return { handle: (request: unknown) => instance.handle(request as never), advance: (ms: number) => { now += ms; } };
}

test("W4-idempotency: the same key and body replays the first response and creates nothing", () => {
  const a = app();
  const first = a.handle(post(VALID, "k1"));
  assert.equal(first.status, 201);
  const again = a.handle(post(VALID, "k1"));
  assert.equal(again.status, 201);
  assert.deepEqual(again.body, first.body);
  assert.equal(again.headers["idempotent-replay"], "true");
  assert.equal(again.headers.location, first.headers.location);
  assert.equal(first.headers["idempotent-replay"], undefined);
  assert.equal((a.handle(post(VALID)).body as { id: string }).id, "INV-01005", "the replay created nothing");
});

test("W4-idempotency: key order in the body does not matter", () => {
  const a = app();
  a.handle(post(VALID, "k2"));
  const reordered = { items: VALID.items.map((item) => ({ taxRate: item.taxRate, unitPriceCents: item.unitPriceCents, quantity: item.quantity, description: item.description })), currency: "USD", netDays: 30, issued: "2026-03-01", client: "Initech" };
  const replay = a.handle(post(reordered, "k2"));
  assert.equal(replay.status, 201);
  assert.equal(replay.headers["idempotent-replay"], "true");
});

test("W4-idempotency: the same key with another body is 422 idempotency_key_reused", () => {
  const a = app();
  a.handle(post(VALID, "k3"));
  const reused = a.handle(post({ ...VALID, netDays: 45 }, "k3"));
  assert.equal(reused.status, 422);
  assert.deepEqual(reused.body, { error: "idempotency_key_reused" });
});

test("W4-idempotency: a key expires 24 hours after its first use", () => {
  const a = app();
  const first = a.handle(post(VALID, "k4"));
  a.advance(DAY - 1);
  assert.equal(a.handle(post(VALID, "k4")).headers["idempotent-replay"], "true");
  a.advance(2);
  const fresh = a.handle(post({ ...VALID, netDays: 10 }, "k4"));
  assert.equal(fresh.status, 201);
  assert.notEqual((fresh.body as { id: string }).id, (first.body as { id: string }).id);
});

test("W4-idempotency: a 400 is not stored, so the client can fix the body and retry with the key", () => {
  const a = app();
  assert.equal(a.handle(post({ ...VALID, currency: "GBP" }, "k5")).status, 400);
  const fixed = a.handle(post(VALID, "k5"));
  assert.equal(fixed.status, 201);
  assert.equal(fixed.headers["idempotent-replay"], undefined);
});

test("W4-idempotency: the store lives in src/idempotency.ts", () => {
  assert.ok(existsSync(fileURLToPath(new URL("../src/idempotency.ts", import.meta.url))));
});
