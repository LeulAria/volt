# Run groups: results and benchmark (2026-10-05)

Plan: `VOLT-RUN-GROUPS-PLAN.md`. Research: `.aInsp/research/run-groups-references.md`, `.aInsp/research/cursor-parallel-agents.md`.

## Live test (test window: VOLT Dev, profile `/tmp/vrg`, CDP 9787)

The repository is Agent-Git-Test. The test ran in a linked worktree of it, `/tmp/vrg-base`, on branch `volt-rg-test-base` at `e93310e`. Another session was switching branches in `~/Desktop/Agent-Git-Test` at the same time, and this kept the merge away from its checkout.

| Check | Result |
|---|---|
| Multi-select picker (toggle and ⇧-click, 2–4 models, count footer, stacked icons on the trigger) | ✅ |
| One send → three worktrees and three branches `volt/add-excerpt-text-maxchars-80-<model>`, base saved as `branch.<b>.volt-base` | ✅ (`git worktree list`) |
| All three stream at once | ✅ All three transcripts grew in the same 2 s samples. The setup `npm test` finished in all three worktrees within 30 ms of each other. |
| Setup from `.volt/worktrees.json`, shown inline with a step per command | ✅ 0.7–1.4 s per run |
| Approvals and follow-ups per run (follow-up to the selected run only) | ✅ |
| Compare view: status, time, tokens, cost, files, ± lines, last message | ✅ Cost is shown when the agent reports it (Claude only). |
| Diff a run against the base, and run ↔ run | ✅ |
| Pick winner → merge | ✅ Commit `3d74eb5` on the winner branch, then a `--no-ff` merge `3031cc0` into the base. `npm test` passes on the base (17). |
| Cleanup | ✅ The two losing runs were archived and their worktrees and branches deleted; the winner's worktree was kept. |
| Stop all | ✅ All three runs stopped within 4 s. |
| Model set remembered for the next comparison | ✅ |
| Groups restored after a window reload | ✅ |

Bugs found during the live test and fixed:
- Checkboxes were hidden in multi mode.
- The compare selection leaked into chats that had already started. The editor is shared between chats.
- The clock counted time spent waiting for approval.
- Recycled sidebar rows showed the wrong row actions. This happened in both directions.
- Follow-ups were still aimed at a run that had been archived.

## Benchmark: the same task, three models in parallel

The task was to add `excerpt(text, maxChars)` and its tests, then run `npm test`. Each run started from commit `e93310e`.

| Tool · model | Ready / first event | Wall time | Result | `excerpt` edge cases |
|---|---|---|---|---|
| Volt · Codex GPT-6-Astra Low | 5.4 s / 11.7 s | **133 s** | 17 tests pass, 2 files, +34, 25K tokens | ✅ |
| Volt · Cursor Grok 4.7 High Fast | 6.5 s / 7.8 s | n/a (blocked on approval) | 17 pass, +32 | ✅ |
| Volt · Claude Haiku 4.5 | 5.0 s / 6.5 s | n/a (blocked on approval) | 18 pass, +47, 232K tokens, $0.14 | ❌ cuts mid-word (`"hello world th…"`) |
| Cursor CLI `-w` · grok-4.7-high-fast | – / 10.6 s | 215 s | 17 pass, +9 | ✅ |
| Cursor CLI `-w` · composer-2.5 | – / 13.3 s | 51 s | 17 pass, +13 | ✅ |
| Cursor CLI `-w` · gpt-5.6-sol-low | – | failed in 7 s | Cursor plan usage limit | – |

- **Volt overhead per run:** creating the worktree and running the setup took 0.7–1.4 s. The setup includes an `npm test` of about 1 s. Each prompt was dispatched 0.8–1.5 s after the send.
- **Like for like:** the only model run in both tools is Grok 4.7 High Fast. Its first event came at 7.8 s in Volt and 10.6 s in the Cursor CLI.
- **Why wall times are missing:** the fresh test profile asks for approval on each tool, and those prompts waited while the session was paused. For the same reason, the Claude and Cursor rows in Volt have no comparable wall time.
- **What Cursor offers:** Cursor 3.x has no local multi-model UI any more; it has `/best-of-n` and cloud agents. Cursor 2.x had multi-select and Apply, which merges file by file into the checkout. Neither version has a compare view across runs, a diff between two runs, or a cost warning.

## Not verified live
- OpenCode and DeepSeek were not configured in the fresh profile. They go through the same code path, which is covered by unit tests.
- The cost and limit warning dialog did not trigger with these models. It is unit-tested.
- Winner by checkout is unit-tested only.
- Winner by pull request is unit-tested only. Running it would push to GitHub.

## Known issues
- Codex's "last message" shows tool output. Codex puts commands in its reply text.
- The sidebar painted black in a CDP screenshot while the multi-diff editor was active. This is not from the run group CSS, and I didn't see it on the real screen.
- Context menus are native on macOS, which CDP cannot see. The test profile uses `window.menuStyle: custom` for that reason.

## Left in place
- The test window is open.
- In Agent-Git-Test: branch `volt-rg-test-base` with the merge, the linked worktree `/tmp/vrg-base`, the winner's worktree, and three worktrees from the stopped group under `~/.volt/worktrees/-k1oy66/`.
- Nothing was committed to Volt.
