// C2-F1, own test (ADEMark's hidden tests are private): src/server.ts started with RATE_LIMIT_RPS=2 allows 2 fast
// requests and refuses the 3rd; without the variable it allows 60.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

async function startServer(env: Record<string, string>): Promise<{ url: string; stop: () => void }> {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/server.ts", import.meta.url))], { env: { ...process.env, PORT: String(port), ...env }, stdio: ["ignore", "pipe", "pipe"] });
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

test("C2-F1: RATE_LIMIT_RPS=2 allows 2 fast requests and refuses the 3rd", async () => {
  const server = await startServer({ RATE_LIMIT_RPS: "2" });
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await fetch(`${server.url}/invoices`, { headers: { "x-api-key": "f1" } })).status);
    }
    assert.deepEqual(statuses.slice(0, 2), [200, 200], statuses.join(","));
    assert.equal(statuses[2], 429, statuses.join(","));
  } finally {
    server.stop();
  }
});

test("C2-F1: without RATE_LIMIT_RPS the server allows 60 and refuses the 61st", async () => {
  const env: Record<string, string> = {};
  const server = await startServer(env);
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) {
      statuses.push((await fetch(`${server.url}/invoices`, { headers: { "x-api-key": "f1b" } })).status);
    }
    assert.ok(statuses.slice(0, 59).every((status) => status !== 429), statuses.join(","));
    assert.equal(statuses[60], 429, statuses.join(","));
  } finally {
    server.stop();
  }
});
