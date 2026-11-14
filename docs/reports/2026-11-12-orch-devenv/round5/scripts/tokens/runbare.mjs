// The Bare CLI arm of the token tests: `claude -p <prompt>` in the arena copy, through proxy.mjs, on the
// same throwaway config dir as the Volt arm and a clean environment, then 30 s for side calls. Appends a
// window to windows.jsonl like runtok.mjs. (ADEMark drives the interactive TUI in Ghostty; -p is the
// closest scriptable form and is labelled that way.)
//   node runbare.mjs <label> <model> <effort|-> <prompt> [rep]
import { execFileSync, execSync } from 'child_process';
import { appendFileSync } from 'fs';
import { join } from 'path';

const DIR = process.env.TOK_DIR ?? '/tmp/v3-tokens';
// Round 5: CLAUDE_BIN picks the Claude Code build (default: `claude` on PATH). EXTRA_ARGS: JSON array of more CLI args.
const BIN = process.env.CLAUDE_BIN || 'claude';
const EXTRA = process.env.EXTRA_ARGS ? JSON.parse(process.env.EXTRA_ARGS) : [];
const PROXY = process.env.TOK_PROXY ?? 'http://127.0.0.1:19955';
const CFG = process.env.TOK_CFG ?? join(DIR, 'cfg');
const [label, model, effort, prompt, rep = '1'] = process.argv.slice(2);
execSync(`${join(DIR, 'mkcfg.sh')} ${CFG}`);
const env = {
	HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.USER, SHELL: process.env.SHELL ?? '/bin/zsh', LANG: 'en_US.UTF-8', TMPDIR: process.env.TMPDIR,
	PATH: process.env.PATH, TERM: 'xterm-256color', CLAUDE_CONFIG_DIR: CFG, ANTHROPIC_BASE_URL: PROXY,
};
const load = execSync('uptime').toString().replace(/.*averages?:\s*/, '').trim();
const start = Date.now();
const args = ['-p', prompt, '--model', model, '--output-format', 'json', ...(effort && effort !== '-' ? ['--effort', effort] : []), ...EXTRA];
let out = '';
try {
	out = execFileSync(BIN, args, { cwd: join(DIR, 'arena'), env, encoding: 'utf8', timeout: 300_000 });
} catch (err) {
	out = String(err.stdout ?? '');
}
const answeredAt = Date.now();
await new Promise(r => setTimeout(r, 30_000));
let result = {};
try { result = JSON.parse(out); } catch { }
const version = execFileSync(BIN, ['--version'], { encoding: 'utf8' }).trim();
const row = { label, version, rep: Number(rep), model, effort, prompt, start, sent: start, answeredAt, end: Date.now(), ended: true, load, answer: String(result.result ?? '').slice(0, 4000), tools: [], numTurns: result.num_turns, usage: result.usage, costUsd: result.total_cost_usd };
appendFileSync(join(DIR, 'windows.jsonl'), JSON.stringify(row) + '\n');
console.log(JSON.stringify({ label, rep, ms: answeredAt - start, load, answer: row.answer.slice(-120), turns: result.num_turns }));
