// Own tests (not ADEMark's hidden tests), one per C2 follow-up, from the follow-up texts in TASKS.md.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/api.ts";
import { sampleInvoices } from "../src/invoices.ts";

async function startServer(env: Record<string, string>): Promise<{ url: string; stop: () => void }> {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/server.ts", import.meta.url))], { env: { ...process.env, ...env, PORT: String(port) }, stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${url}/health`);
      return { url, stop: () => child.kill() };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  child.kill();
  throw new Error("server did not start");
}

async function burst(env: Record<string, string>, count: number): Promise<number[]> {
  const server = await startServer(env);
  try {
    const statuses: number[] = [];
    for (let i = 0; i < count; i++) statuses.push((await fetch(`${server.url}/invoices/INV-01001`, { headers: { "x-api-key": "f1" } })).status);
    return statuses;
  } finally {
    server.stop();
  }
}

test("C2-F1: RATE_LIMIT_RPS sets capacity and refill; unset keeps 60 and 1", async () => {
  const limited = await burst({ RATE_LIMIT_RPS: "2" }, 12);
  assert.deepEqual(limited.slice(0, 2), [200, 200]);
  assert.ok(limited.includes(429), limited.join(","));
  const env = { ...process.env };
  delete env.RATE_LIMIT_RPS;
  const standard = await burst({}, 62);
  assert.ok(standard.slice(0, 59).every((status) => status === 200), standard.join(","));
  assert.ok(standard.slice(60).includes(429), standard.join(","));
});

test("C2-F2: every response carries x-request-id: the request's, or a random UUID", () => {
  const app = createApp({ invoices: sampleInvoices(3), rateLimit: { capacity: 2, refillPerSecond: 1, now: () => 1 } } as never);
  const echoed = app.handle({ method: "GET", path: "/invoices", headers: { "x-request-id": "req-42" } });
  assert.equal(echoed.headers["x-request-id"], "req-42");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const a = app.handle({ method: "GET", path: "/nope", headers: {} });
  const b = app.handle({ method: "GET", path: "/invoices", headers: {} });
  assert.equal(b.status, 429);
  assert.match(a.headers["x-request-id"] ?? "", uuid);
  assert.match(b.headers["x-request-id"] ?? "", uuid);
  assert.notEqual(a.headers["x-request-id"], b.headers["x-request-id"]);
  assert.match(app.handle({ method: "GET", path: "/health" }).headers["x-request-id"] ?? "", uuid);
});

test("C2-F3: invoice summaries have dueOn, and due as an alias with the same value", () => {
  const app = createApp({ invoices: sampleInvoices(4) });
  const body = app.handle({ method: "GET", path: "/invoices", headers: {} }).body as { items: { due: string; dueOn: string }[] };
  assert.equal(body.items.length, 4);
  for (const item of body.items) {
    assert.equal(typeof item.dueOn, "string");
    assert.equal(item.due, item.dueOn);
  }
});
