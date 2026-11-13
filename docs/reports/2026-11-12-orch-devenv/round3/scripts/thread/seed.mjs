#!/usr/bin/env node
// Seeds a Volt test profile with long chats written in Volt's own history format
// (<ud>/User/agentSessions/index.json + sessions/<id>.jsonl), the format the agent server and the
// window read. Re-runnable: replaces the chats it made before, keeps nothing else.
//
//   node seed.mjs <user-data-dir> <repo-folder> [--chats long41k,long45k,long75k,short,a11]
//
// An "item" is one row a reader sees: a user prompt, a reply text, or a tool call. A turn here is
// 1 prompt + 20 texts + 20 file reads = 41 items (one text in five holds a code block, like
// ADEMark's long-2000). The last text of every chat ends with `LONGTHREAD-END <chat>` so a probe
// can tell the end is on screen.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [ud, repo, ...rest] = process.argv.slice(2);
if (!ud || !repo) {
	console.error('usage: seed.mjs <user-data-dir> <repo-folder> [--chats a,b]');
	process.exit(2);
}
const chatsArg = rest.includes('--chats') ? rest[rest.indexOf('--chats') + 1] : 'long41k,long45k,long75k,short,a11';
const wanted = new Set(chatsArg.split(','));

const ITEMS_PER_TURN = 41;
const base = path.join(ud, 'User', 'agentSessions');
const sessions = path.join(base, 'sessions');
fs.mkdirSync(sessions, { recursive: true });
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
for (let i = 0; i < 20; i++) {
	const file = path.join(repo, 'src', `mod${i}.ts`);
	if (!fs.existsSync(file)) {
		fs.writeFileSync(file, `export const value${i} = ${i};\n`);
	}
}

const now = Date.now();
const workspace = { id: repo, label: path.basename(repo), folders: [repo] };
const model = { ref: 'agent:seed-grok:grok-4.7', label: 'Grok 4.7' };

function text(n, total, chat) {
	const body = `Step ${n} of ${total}. Reading the next module to check its exports.`;
	if (n === total) {
		return `${body}\n\nLONGTHREAD-END ${chat}`;
	}
	return n % 5 === 0 ? `${body}\n\n\`\`\`ts\nexport const value${n} = ${n};\n\`\`\`\n` : `${body}\n`;
}

function read(n) {
	const file = path.join(repo, 'src', `mod${n % 20}.ts`);
	return { kind: 'activity', item: { kind: 'read', label: 'Read', detail: `mod${n % 20}.ts`, path: file, files: [file], callId: `call-${n}`, toolName: 'Read' } };
}

/** One reply of `steps` text + read pairs, numbered from `first`. */
function reply(turn, first, steps, total, chat, at) {
	const segments = [];
	let plain = '';
	for (let i = 0; i < steps; i++) {
		const n = first + i;
		const t = text(n, total, chat);
		segments.push({ kind: 'text', text: t });
		plain += t;
		if (n !== total) {
			segments.push(read(n));
		}
	}
	return {
		plain,
		message: { kind: 'agent', id: turn, title: '', steps: [], segments, blockState: {}, startedAt: at, endedAt: at + 9000, durationMs: 9000, model, outcome: 'done' },
	};
}

/** `turns` exchanges; `stepsPerTurn` text + read pairs each (one turn = 1 + 2 * steps items). */
/** `rank`: hours since the chat's last turn, which orders the sidebar (newest first). */
function writeChat(chat, title, turns, stepsPerTurn, firstPrompt, rank = 1) {
	const id = `agent-bench-${chat}`;
	const createdAt = now - turns * 60_000 - (rank + 1) * 3_600_000;
	const total = turns * stepsPerTurn;
	const lines = [JSON.stringify({ type: 'header', version: 1, id, createdAt, workspace })];
	let at = createdAt;
	for (let t = 0; t < turns; t++) {
		const turn = crypto.randomUUID();
		const prompt = t === 0 && firstPrompt ? firstPrompt : `Turn ${t + 1}: keep reading the modules (${chat}).`;
		lines.push(JSON.stringify({ type: 'user', turn, at, text: prompt, message: { kind: 'user', id: turn, text: prompt, mode: 'agent' } }));
		const { plain, message } = reply(turn, t * stepsPerTurn + 1, stepsPerTurn, total, chat, at + 1000);
		lines.push(JSON.stringify({ type: 'agent', turn, at: at + 10_000, final: true, status: 'done', text: plain, summary: 'Read modules', message }));
		at += 60_000;
	}
	const file = path.join(sessions, `${id}.jsonl`);
	fs.writeFileSync(file, lines.join('\n') + '\n');
	const items = turns * (1 + stepsPerTurn * 2) - 1;
	const meta = {
		id, title, customTitle: true, createdAt, updatedAt: at, workspaceId: workspace.id, workspaceLabel: workspace.label, workspaceFolder: repo,
		turnCount: turns, preview: firstPrompt ?? title, summary: 'Read modules', status: 'done', lastPromptAt: at - 60_000, lastUserPromptAt: at - 60_000, mode: 'agent', model: model.label,
	};
	console.log(`${id}\t${items} items\t${turns} turns\t${(fs.statSync(file).size / 1e6).toFixed(1)} MB`);
	return meta;
}

const specs = {
	long41k: () => writeChat('long41k', 'Long thread 41k', 1000, 20, undefined, 10),
	long45k: () => writeChat('long45k', 'Long thread 45k', 1098, 20, undefined, 11),
	long75k: () => writeChat('long75k', 'Long thread 75k', 1830, 20, undefined, 12),
	short: () => writeChat('short', 'Short thread', 1, 2, undefined, 0),
	// ADEMark A11's shape, written directly (the app-made one comes from the replay server): one reply, 1,000 steps.
	a11: () => writeChat('a11', 'Long thread A11 (seeded)', 1, 1000, 'replay:long-2000', 9),
};
// `--cold N`: N copies of the 41k chat, each opened once by a cold-open run (nothing has loaded them).
const coldCopies = rest.includes('--cold') ? Number(rest[rest.indexOf('--cold') + 1]) : 0;
for (let i = 1; i <= coldCopies; i++) {
	specs[`long41k-c${i}`] = () => writeChat(`long41k-c${i}`, `Cold 41k ${i}`, 1000, 20, undefined, i);
	wanted.add(`long41k-c${i}`);
}

const indexFile = path.join(base, 'index.json');
let index = { version: 1, sessions: [] };
try {
	index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
} catch { }
const made = [];
for (const [name, make] of Object.entries(specs)) {
	if (wanted.has(name)) {
		made.push(make());
	}
}
const ids = new Set(made.map(m => m.id));
index.sessions = [...index.sessions.filter(s => !ids.has(s.id)), ...made];
fs.writeFileSync(indexFile, JSON.stringify(index));
console.log(`index: ${index.sessions.length} chats (items per turn ${ITEMS_PER_TURN})`);
