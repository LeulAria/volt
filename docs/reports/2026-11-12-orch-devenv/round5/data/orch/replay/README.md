Replays of captured model requests (rows.jsonl: label, ms, output tokens, thinking tokens, answer chars).
Bodies are not kept here (they carry the account's email in Claude Code's own system reminders).
- cc-final: Claude Code's lead, last t1 turn (diag cc-t1-1). volt-final / a0: Volt's lead, last t1 turn (diag volt-r5-t1-2).
- a1: Q4's report made decisive; a2: no [Volt] parts in the first user message; a3: tool results without task headers.
- b1-b5: one [Volt] line (or the workspace block) dropped; b6: only the "Project files, read just now" primer dropped.
- q0-q3: Volt's Q4 subagent request; q1 no parent digest, q2 no harness lines, q3 neither.
- c1/c2: b6 plus the decisive Q4 report (a1) / plus tool results without task headers (a3). e1/e2: b6 without the
  "# Working in Volt" system append / without the "## volt" MCP server instructions. All within b6's noise
  (median think 390-551 vs b6 479, n=5 each), so after the primer cut nothing else in the lead's prompt matters.
