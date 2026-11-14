// Skill-listing capability check: does a task that one of Claude Code's bundled skills is for still load
// that skill when the listing's descriptions are capped (skillListingMaxDescChars)? One `claude -p` per
// (prompt, cap, rep) in the arena copy, through a capture proxy, on the clean config dir; "used" = a Skill
// tool_use naming the expected skill. Read-only: Bash/Edit/Write are disallowed and the turn is capped.
//   node skillcap.mjs <out.jsonl> <caps comma-separated, "default" = no setting> [reps] [model]
import { execFileSync } from 'child_process';
import { appendFileSync } from 'fs';
import { join } from 'path';

const DIR = process.env.TOK_DIR ?? `${process.env.HOME}/.volt-r4/tokens/run`;
const PROXY = process.env.TOK_PROXY ?? 'http://127.0.0.1:19953';
const CLI = process.env.TOK_CLI ?? `${process.env.HOME}/.npm/_npx/21a32ccb11becb3a/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`;
const [out, capsArg, repsArg = '2', model = 'claude-haiku-5-5'] = process.argv.slice(2);
const CASES = [
	['dataviz', 'Make a bar chart of total invoice amount per customer from the sample data in this repo, as a single HTML file. Plan it first.'],
	['claude-api', 'Write a small Node script that sends each invoice note to Claude and asks for a one-line summary. Which model id and SDK call should it use?'],
	['code-review', 'Review my uncommitted change for correctness bugs.'],
	['update-config', 'From now on, whenever you finish editing a file, run npm test automatically. Set that up.'],
];
// Only these four descriptions are longer than 400 characters (the cap tried); the others are listed whole.
const env = { HOME: process.env.HOME, USER: process.env.USER, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: 'en_US.UTF-8', CLAUDE_CONFIG_DIR: join(DIR, 'cfg-clean'), ANTHROPIC_BASE_URL: PROXY };
for (let rep = 1; rep <= Number(repsArg); rep++) {
	for (const [skill, prompt] of CASES) {
		for (const cap of capsArg.split(',')) {
			const args = ['-p', prompt, '--model', model, '--output-format', 'stream-json', '--verbose', '--max-turns', '3', '--disallowedTools', 'Bash,Edit,Write,NotebookEdit',
				...(cap === 'default' ? [] : ['--settings', JSON.stringify({ skillListingMaxDescChars: Number(cap) })])];
			let text = '';
			try { text = execFileSync(CLI, args, { cwd: join(DIR, process.env.TOK_SKILL_FOLDER ?? 'skillfx'), env, encoding: 'utf8', timeout: 240_000, input: '' }); } catch (err) { text = String(err.stdout ?? ''); }
			const uses = [];
			for (const line of text.split('\n')) {
				let m; try { m = JSON.parse(line); } catch { continue; }
				for (const c of m.message?.content ?? []) { if (c.type === 'tool_use') { uses.push(c.name === 'Skill' ? `Skill(${c.input?.skill ?? c.input?.command ?? '?'})` : c.name); } }
			}
			const used = uses.some(u => u.startsWith('Skill(') && u.includes(skill));
			const row = { skill, cap, rep, used, uses, t: Date.now() };
			appendFileSync(out, JSON.stringify(row) + '\n');
			console.log(JSON.stringify(row));
		}
	}
}
