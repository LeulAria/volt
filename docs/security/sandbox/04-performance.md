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

Agent CLIs pay this once per process, which lives for a whole chat. Workload commands pay it per command.

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
