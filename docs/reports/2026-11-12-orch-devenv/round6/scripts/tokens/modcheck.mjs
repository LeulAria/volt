// Checks Volt's Claude Code hooks module against the real Claude Code binary, without Volt: writes
// claudeLazyToolsPlugin() from this tree's out/ to a temp folder, runs `claude -p hi` (CLAUDE_BIN, Haiku 5.5)
// with it and a stub "volt" MCP server (mcpstub.mjs) through a capture proxy, and prints what the request
// carried: tools[], and the deferred-tools / agent-types / skills reminders. Claude Code drops a module it
// does not accept silently, so "lazy tools still in tools[]" is the failure to look for.
//   node modcheck.mjs <proxy url> <capture.jsonl> <config dir> [prompt]
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../../../../..');
const [proxy, capture, cfg, prompt = 'hi'] = process.argv.slice(2);
const { claudeLazyToolsPlugin } = await import(join(root, 'out/vs/workbench/services/voltRuntime/common/harness/claudeWorkRules.js'));
const plugin = claudeLazyToolsPlugin();
const dir = join(mkdtempSync(join(tmpdir(), 'volt-modcheck-')), plugin.name);
for (const [path, text] of plugin.files) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); }
const mcp = join(dirname(dir), 'mcp.json');
writeFileSync(mcp, JSON.stringify({ mcpServers: { volt: { type: 'stdio', command: process.execPath, args: [join(here, 'mcpstub.mjs')] } } }));
const bodies = `${capture}.bodies`;
const before = new Set(readdirSync(bodies));
const env = { HOME: process.env.HOME, USER: process.env.USER, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: process.env.TMPDIR, LANG: 'en_US.UTF-8', TERM: 'xterm-256color', CLAUDE_CONFIG_DIR: cfg, ANTHROPIC_BASE_URL: proxy };
execFileSync(process.env.CLAUDE_BIN || 'claude', ['-p', prompt, '--model', 'claude-haiku-5-5', '--output-format', 'json', '--plugin-dir', dir, '--mcp-config', mcp, '--permission-mode', 'bypassPermissions'], { env, cwd: process.env.TOK_FOLDER ?? process.cwd(), input: '', encoding: 'utf8', timeout: 180_000 });
const added = readdirSync(bodies).filter(f => !before.has(f)).sort((a, b) => statSync(join(bodies, a)).mtimeMs - statSync(join(bodies, b)).mtimeMs);
const body = JSON.parse(readFileSync(join(bodies, added.find(f => JSON.parse(readFileSync(join(bodies, f), 'utf8')).model?.includes('haiku')) ?? added.at(-1)), 'utf8'));
const text = (body.messages ?? []).map(m => typeof m.content === 'string' ? m.content : m.content.map(p => p.text ?? '').join('\n')).join('\n');
const section = (start, end) => { const i = text.indexOf(start); if (i < 0) { return '(none)'; } const j = end ? text.indexOf(end, i + start.length) : -1; return text.slice(i, j > i ? j : i + 1500).trim(); };
console.log(JSON.stringify({ plugin: plugin.name, dir, tools: body.tools.map(t => t.name) }));
console.log('--- deferred\n' + section('The following deferred tools', '\n\n'));
console.log('--- agents\n' + section('Available agent types', '\n\n'));
console.log('--- skills\n' + section('The following skills are available', '\n\n'));
console.log('--- rest\n' + section('While bypass', '\n\n'));
