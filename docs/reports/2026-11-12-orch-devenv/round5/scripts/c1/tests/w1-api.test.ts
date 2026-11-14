// C1-style, own tests (not ADEMark's hidden tests): W1 rate limiting wired into createApp.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/api.ts";
import { sampleInvoices } from "../src/invoices.ts";

function app(capacity: number, refillPerSecond: number) {
  let now = 5_000_000;
  const instance = createApp({ invoices: sampleInvoices(5), rateLimit: { capacity, refillPerSecond, now: () => now } } as never);
  return { instance, advance: (ms: number) => { now += ms; } };
}

const get = (path: string, key?: string) => ({ method: "GET", path, headers: key ? { "x-api-key": key } : {} });

test("W1-api: each request takes a token and reports what is left", () => {
  const { instance } = app(2, 1);
  const first = instance.handle(get("/invoices", "k"));
  assert.equal(first.status, 200);
  assert.equal(first.headers["x-ratelimit-remaining"], "1");
  assert.equal(instance.handle(get("/invoices", "k")).headers["x-ratelimit-remaining"], "0");
});

test("W1-api: a limited request is 429 rate_limited with retry-after in whole seconds, at least 1", () => {
  const { instance, advance } = app(1, 1);
  instance.handle(get("/invoices", "k"));
  advance(300);
  const limited = instance.handle(get("/invoices", "k"));
  assert.equal(limited.status, 429);
  assert.deepEqual(limited.body, { error: "rate_limited" });
  assert.equal(limited.headers["retry-after"], "1");
  assert.ok("x-ratelimit-remaining" in limited.headers);
  const slow = app(1, 0.25);
  slow.instance.handle(get("/invoices", "s"));
  assert.equal(slow.instance.handle(get("/invoices", "s")).headers["retry-after"], "4");
});

test("W1-api: GET /health takes no token and has no remaining header", () => {
  const { instance } = app(1, 1);
  for (let i = 0; i < 3; i++) {
    const health = instance.handle(get("/health", "k"));
    assert.equal(health.status, 200);
    assert.equal(health.headers["x-ratelimit-remaining"], undefined);
  }
  assert.equal(instance.handle(get("/invoices", "k")).status, 200);
});

test("W1-api: the key is x-api-key, or anonymous without it", () => {
  const { instance } = app(1, 1);
  assert.equal(instance.handle(get("/invoices")).status, 200);
  assert.equal(instance.handle(get("/invoices")).status, 429);
  assert.equal(instance.handle(get("/invoices", "other")).status, 200);
  assert.equal(instance.handle(get("/invoices", "anonymous")).status, 429, "no header is the key anonymous");
});

test("W1-api: other methods take a token too", () => {
  const { instance } = app(1, 1);
  const deleted = instance.handle({ method: "DELETE", path: "/invoices/INV-01001", headers: { "x-api-key": "m" } });
  assert.equal(deleted.headers["x-ratelimit-remaining"], "0");
  assert.equal(instance.handle(get("/invoices", "m")).status, 429);
});

test("W1-api: src/server.ts turns rate limiting on with capacity 60 and refillPerSecond 1", async () => {
  const server = await startServer();
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 62; i++) {
      statuses.push((await fetch(`${server.url}/invoices?limit=1`, { headers: { "x-api-key": "srv" } })).status);
    }
    assert.ok(statuses.slice(0, 59).every((status) => status !== 429), statuses.join(","));
    assert.ok(statuses.slice(60).includes(429), statuses.join(","));
    const health = await fetch(`${server.url}/health`);
    assert.equal(health.status, 200);
  } finally {
    server.stop();
  }
});

async function startServer(): Promise<{ url: string; stop: () => void }> {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/server.ts", import.meta.url))], { env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
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
  throw new Error(`server did not start: ${readFileSync(fileURLToPath(new URL("../src/server.ts", import.meta.url)), "utf8").slice(0, 200)}`);
}
