# Volt Sandbox: Performance

Measured, not estimated. Every number is the median of the stated number of runs, on the machine stated.

**Hardware:** Apple M4 Max (14 cores, 36 GB).
- **macOS:** 26.6, Node 25.1, Seatbelt.
- **Linux:** Docker Desktop's VM on the same machine (14 vCPUs, 8 GB, kernel 6.10.14-linuxkit, arm64), Ubuntu 24.04, bubblewrap 0.9.0, Node 22.

**Method:**
- **macOS:** `node scripts/volt-sandbox-bench.mjs --runs 30` drives the real `SandboxManager` from `out/`.
- **Linux:** `scripts/volt-sandbox-linux-test.sh bench` runs 20 iterations of each case.

## Startup (what a sandboxed command costs before it does anything)

| | macOS | Linux |
|---|---|---|
| plain `/usr/bin/true` | 1.6 ms | 0.7 ms |
| backend alone (launch → confirmed → exit) | 26 ms to confirmation | 6.4 ms |
| backend with one bridged port (network `proxy`) | — | 9.3 ms |
| `SandboxManager.run` end to end, `workspace` profile | **65 ms** (p90 75) | **20.4 ms** |
| `SandboxManager.run`, agent profile | 88 ms | — |
| of which: policy compile (resolve + profile text) | 5.1 ms | — |
| of which: prepare (probe cached, resolve, run folder) | 6 ms | — |

On macOS, the end-to-end time breaks down roughly as:
- prepare, about 6 ms;
- `sandbox-exec` compiling the profile, about 10 ms;
- the prologue and confirmation, about 10 ms;
- the workload;
- the post-exit tree sweep: one `ps` scan with environments, about 24 ms;
- removing the run folder.

**After H7 (external attestation, go byte, disclaimed spawn), 2026-11-08,** same machine but busy (load average about 9, 615 processes): `workspace` end to end **41 ms** (p90 52), agent profile 58 ms (p90 69), prepare 7 ms, spawn to attested 27 ms, of which the attestation itself (four `sandbox_check` queries to the running helper) about 0.2 ms. The tree sweep now asks the running `volt-sandbox-helper` (`proc_listallpids` + `KERN_PROCARGS2`, about 6 ms) instead of spawning `ps -E`, which took 60 to 80 ms with that many processes; `ps` stays as the fallback when the helper is gone.

**After H7 merged with narrow reads (H3/H4), 2026-11-08,** Apple M4 Max: `workspace` end to end **59 ms** (p90 67), prepare 10 ms, start 42 ms. The agent profile now costs **704 ms** (p90 740): narrow reads made it a deny-by-default profile with 217 deny patterns (regexes), and `sandbox-exec` spends about 830 ms of CPU compiling that 91 KB profile (`/usr/bin/true` under it alone). Not from H7: its profile text is unchanged by the merge. Future: fold the patterns into fewer regexes, or compile once per chat in the helper.

**After PERF-SB (merged path regexes), 2026-11-08,** Apple M4 Max, busy (load average 8 to 45 from other work). `node scripts/volt-sandbox-bench.mjs --runs 30` with the old and the new generator back to back, so both saw the same load. The agent profile now starts in **40 ms** end to end (p90 47, p95 60). In the same round the old generator took 510 ms (p90 564, p95 589). The budget for agent CLI start (spec L.1) is 120 / 200 ms (p50 / p95).

| agent profile, this machine | before | after |
|---|---|---|
| profile text | 92 KB | 17.6 KB |
| `(regex …)` filters | 441 | 19 |
| `sandbox-exec -f profile /usr/bin/true` (p50 / p90 / p95) | 557 / 871 / 960 ms | 11.9 / 13.9 / 14.0 ms |
| `SandboxManager.run` end to end (p50 / p90 / p95) | 510 / 564 / 589 ms | **40 / 47 / 60 ms** |
| of which start, spawn to attested (p50) | 490 ms | 18 ms |
| profile text generation alone (p50) | 3.8 ms | 5.1 ms |

Under heavier load the new profile measured 63 / 132, 71 / 97 and 149 / 244 ms (p50 / p95), and the old one 2.9 s and 2.0 s p50. The `workspace` profile shrinks too, from 24.6 KB and 75 regexes to 8.0 KB and 13. Its end-to-end time went from 45 to 27 ms in the same round.

**Where the time went.** `sandbox-exec` was timed on synthetic profiles: 200 filters in one deny rule, over `(allow default)`, which alone takes 7 ms.

| 200 filters of this kind | added time |
|---|---|
| plain path regexes | +1.5 ms |
| `literal` | +6 ms |
| `subpath` | +11 ms |
| the same regexes with case-folded letters (`[uU][sS]…`) | +35 ms |
| one alternation of all 200 | +8 ms |

Every deny uses case-folded letters, because APFS is case-insensitive. The cost is per regex filter, not per byte, and it grows with how many sit in one rule. The agent profile had 441 of them in a few rules:
- 217 narrow-read deny patterns (31 roots × 7 `.env`-style names);
- 36 protect patterns;
- the git allow list.

13 of the regex lines were exact duplicates. The macOS profile has no per-file rules from the deny-pattern walk; that walk feeds bubblewrap on Linux and MXC on Windows.

**What changed** (`seatbelt.ts`; no rule's meaning changed):
1. Patterns with the same root share one filter: `<root>/(.*/)?(\.env|\.env\.local|…)(/.*)?`.
2. Within a rule, path regexes with the same suffix become one alternation of their prefixes. The alternation is written as a prefix tree (`/a/b(c|d)`) and split so no literal passes `sandbox-exec`'s 1023-byte limit.
3. Duplicates drop. A prefix below another one in the same group drops only where the suffix already matches everything below the parent (`(/.*)?` and `/(.*/)?…`).
4. Statements and their order are untouched, so last-match-wins evaluation is unchanged.

**Proof.** SB-EQ-1 (`test/node/seatbeltEquivalence.test.ts`) checks three policies: the agent profile, the `workspace` profile, and a synthetic policy with every rule kind. Each is built by the new generator and by a frozen copy of the old one (`test/common/seatbeltReference.ts`). Both profiles are applied to live processes under the real `sandbox-exec`, and two sets of answers must match:
- `sandbox_check` for five file operations over generated probe paths: every walked `.env`-style match, siblings, parents, children, case variants, and every rule's own paths;
- real reads, stats and appends inside the sandbox on matches, on symlinks to them and to their folders, and on case variants.

The merge law test (`test/common/seatbeltMerge.test.ts`) checks the same rule by rule on 300 random policies with nested roots. It fails if the nested-prefix fold is applied to every suffix.

**Not done:** caching the profile text per policy digest. Every run's policy names its own run folder, so a cache would never hit, and generating the text takes about 5 ms.

Agent CLIs pay this once per process, which lives for a whole chat. Workload commands pay it per command.

**Long-lived hosts (C5 supervisor), 2026-11-08,** Apple M4 Max, `workspace` profile: a Node host (Volt's runtime as Node) from `SandboxSupervisor.start` through attestation, the go byte and its `NODE_CHANNEL_FD` channel to the first RPC answered: **p50 114 ms, max 139 ms** over 8 runs (`PERF-HOST-1` in `sandboxSupervisor.test.ts`), inside the spec's T2 budget of 150 / 300 ms. With the machine at load average 29 the same test gave p50 332 ms, max 435 ms.

## Inside a sandbox

| | direct | sandboxed |
|---|---|---|
| per extra command (200 × `true` in one sandboxed shell), macOS | 1.63 ms | 1.92 ms |
| 1000 × 1 KB files written and read back, macOS | 1.92 s | 1.97 s |
| 8 sandboxes started concurrently, macOS | — | 94 ms for all 8 |

Inside a sandbox, Seatbelt's per-operation checks cost about 18% on process creation and less than 3% on small-file I/O, which is within run-to-run noise.

## Host-side memory

| | macOS | Linux |
|---|---|---|
| processes Volt adds per run, outside the sandbox | 1 watchdog `/bin/sh` (about 2 MB RSS) | bubblewrap's monitor, plus one socat per bridged port in the holder namespace |

## What changed because of these numbers

The first macOS measurement was 92 ms end to end and 391 ms for 8 concurrent runs. Two changes, neither of which weakens anything:

1. **Profiles shrink under deny-by-default.** Credential denies and protections that lie outside every readable or writable root were dropped from the profile, because the default already refuses them. The `workspace` profile went from 17.5 KB to 11.6 KB (40 credential denies down to the 2 that touch a readable root), saving about 20 ms of Seatbelt compile time. Allow-default (agent) profiles keep every rule.
2. **The kill sweep scans once.** One `ps -E` pass now gives parents, groups and the run tag; there were two passes before.

The result is 65 ms end to end and 94 ms for 8 concurrent runs.

## Not measured

- **The sandboxed network proxy's throughput.** It is a plain `CONNECT` relay, and requests leave the machine.
- **Long-running agent memory.** The agent CLI itself dominates; the sandbox adds the watchdog or bubblewrap's monitor.
