In the Ledger repository, add rate limiting. Work alone in this thread and do not start other agents. Read AGENTS.md first.

Create src/rate-limiter.ts. It exports createRateLimiter(options: { capacity: number; refillPerSecond: number; now?: () => number }). The result has take(key: string, cost = 1): { allowed: boolean; remaining: number; retryAfterMs: number }. It is a token bucket per key: a new key starts with capacity tokens, tokens refill continuously at refillPerSecond up to capacity, take() removes cost tokens when enough are available and otherwise removes nothing. retryAfterMs is the milliseconds until cost tokens are available, or 0 when allowed. now defaults to Date.now.

Wire it into createApp with a new option AppOptions.rateLimit?: { capacity: number; refillPerSecond: number; now?: () => number }. The key is the x-api-key header, or "anonymous" when it is missing. Every request except GET /health takes 1 token. A limited request returns 429 with the body { "error": "rate_limited" } and a retry-after header in whole seconds, rounded up, minimum 1. src/server.ts turns rate limiting on with capacity 60 and refillPerSecond 1.

Do not change or delete existing files in test/. Run npm test before you finish.
