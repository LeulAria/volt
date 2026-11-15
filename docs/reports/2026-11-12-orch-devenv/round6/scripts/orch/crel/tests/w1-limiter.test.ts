// C1-style, own tests (not ADEMark's hidden tests): W1 rate limiter, from TASKS.md's W1 text only.
import test from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../src/rate-limiter.ts";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

test("W1-limiter: a new key starts full and takes one token per call", () => {
  const c = clock();
  const limiter = createRateLimiter({ capacity: 3, refillPerSecond: 1, now: c.now });
  assert.deepEqual(limiter.take("a"), { allowed: true, remaining: 2, retryAfterMs: 0 });
  assert.deepEqual(limiter.take("a"), { allowed: true, remaining: 1, retryAfterMs: 0 });
  assert.deepEqual(limiter.take("a"), { allowed: true, remaining: 0, retryAfterMs: 0 });
  const denied = limiter.take("a");
  assert.equal(denied.allowed, false);
  assert.equal(denied.remaining, 0);
  assert.equal(denied.retryAfterMs, 1000);
});

test("W1-limiter: tokens refill continuously and a denied take removes nothing", () => {
  const c = clock();
  const limiter = createRateLimiter({ capacity: 2, refillPerSecond: 2, now: c.now });
  limiter.take("k", 2);
  c.advance(250); // 0.5 token
  const denied = limiter.take("k");
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterMs, 250);
  c.advance(250); // 1 token: the denied call removed nothing
  assert.deepEqual(limiter.take("k"), { allowed: true, remaining: 0, retryAfterMs: 0 });
});

test("W1-limiter: never above capacity, remaining is a whole number", () => {
  const c = clock();
  const limiter = createRateLimiter({ capacity: 5, refillPerSecond: 1, now: c.now });
  limiter.take("x", 5);
  c.advance(100_000);
  assert.equal(limiter.take("x").remaining, 4);
  limiter.take("x", 4);
  c.advance(1_500); // 1.5 tokens
  const r = limiter.take("x");
  assert.equal(r.allowed, true);
  assert.equal(r.remaining, 0);
});

test("W1-limiter: cost and retryAfterMs for a larger cost", () => {
  const c = clock();
  const limiter = createRateLimiter({ capacity: 4, refillPerSecond: 1, now: c.now });
  assert.deepEqual(limiter.take("b", 3), { allowed: true, remaining: 1, retryAfterMs: 0 });
  const denied = limiter.take("b", 3);
  assert.equal(denied.allowed, false);
  assert.equal(denied.remaining, 1);
  assert.equal(denied.retryAfterMs, 2000);
});

test("W1-limiter: keys are independent", () => {
  const c = clock();
  const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 1, now: c.now });
  assert.equal(limiter.take("one").allowed, true);
  assert.equal(limiter.take("one").allowed, false);
  assert.equal(limiter.take("two").allowed, true);
});

test("W1-limiter: cost must be an integer from 1 to capacity", () => {
  const limiter = createRateLimiter({ capacity: 3, refillPerSecond: 1, now: () => 0 });
  for (const cost of [0, -1, 4, 1.5, Number.NaN]) {
    assert.throws(() => limiter.take("c", cost), RangeError, `cost ${cost}`);
  }
  assert.equal(limiter.take("c", 3).allowed, true);
});

test("W1-limiter: now defaults to Date.now", () => {
  const limiter = createRateLimiter({ capacity: 2, refillPerSecond: 1 });
  assert.equal(limiter.take("d").allowed, true);
  assert.equal(limiter.take("d").remaining, 0);
});
