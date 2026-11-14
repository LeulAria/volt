// Grades bench.mjs answers against the ground truth (ground-truth.md): 1 right, 0.5 partly, 0 wrong.
// Read tasks: by the file paths, names and facts the answer must contain; edit tasks: by the saved diff.
//   node grade.mjs <label regex>   (prints one JSON line per run: label, rep, score, why)
import { existsSync, readFileSync } from 'fs';
const H = process.env.HOME + '/.volt-r5/codeintel/run';
const windows = readFileSync(H + '/windows.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(w => new RegExp(process.argv[2] ?? '.').test(w.label));
const has = (text, items) => items.filter(item => item instanceof RegExp ? item.test(text) : text.includes(item));
const T2 = readFileSync(H + '/gt-t2.txt', 'utf8').trim().split('\n').filter(p => !/\.test\./.test(p));
const graders = {
	't1-impact': a => {
		const files = ['discord/monitor/message-handler.process.ts', 'infra/outbound/outbound-session.ts', 'slack/monitor/message-handler/prepare.ts', 'telegram/bot-handlers.ts', 'telegram/bot-message-context.ts', 'telegram/bot-native-commands.ts', 'prepare.test.ts'];
		const found = has(a, files).length;
		// The mattermost extension has its own resolveThreadSessionKeys: listing it as needing a change is wrong, naming it as separate is fine.
		// Judged by the text around the file's own mention (an earlier "Mattermost" may name src/'s Mattermost resolver).
		const at = a.search(/mattermost\/monitor\.ts/);
		const mattermostWrong = at >= 0 && !/(own|separate|different|local|not (affected|the same)|unrelated|its own|no change)/i.test(a.slice(Math.max(0, at - 300), at + 400));
		return { score: found === 7 && !mattermostWrong ? 1 : found >= 5 ? 0.5 : 0, why: `${found}/7 files${mattermostWrong ? ', mattermost listed as affected' : ''}` };
	},
	't2-importers': a => {
		const found = has(a, T2).length;
		const count = /\b25\b/.test(a);
		return { score: found >= 24 && count ? 1 : found >= 20 ? 0.5 : 0, why: `${found}/${T2.length} files, count 25 ${count}` };
	},
	't3-callers': a => {
		const callers = has(a, ['pickFirstExistingAgentId', 'normalizeCronJobInput', /registerCronAddCommand|register\.cron-add\.ts/, /registerCronEditCommand|register\.cron-edit\.ts/]).length;
		const chain = /resolveAgentRoute/.test(a);
		return { score: callers === 4 && chain ? 1 : (callers >= 3 && chain) || callers === 4 ? 0.5 : 0, why: `${callers}/4 callers, chain ${chain}` };
	},
	't4-body': a => {
		const order = /overrideEvery[\s\S]*heartbeat\??\.every[\s\S]*defaults[\s\S]*DEFAULT_HEARTBEAT_EVERY/.test(a);
		const cases = has(a, [/empty|whitespace|trim/i, /throw|pars(e|ing) fail|invalid|catch/i, /<=\s*0|zero|not positive|non-positive|negative/i, /no (value|setting|interval)|nothing (is )?(set|configured)|falsy|missing|none of|!raw|undefined/i]).length;
		return { score: order && cases === 4 ? 1 : (order && cases >= 3) || cases === 4 ? 0.5 : 0, why: `order ${order}, ${cases}/4 null cases` };
	},
	't5-structural': a => {
		// [file, first line, last line] of each call (gt-t5.txt). A call is found when its file is named with one of
		// its lines within the next 200 characters. Test helpers (test-helpers.*.ts) and .html are neither required nor wrong.
		const gt = readFileSync(H + '/gt-t5.txt', 'utf8').trim().split('\n').map(l => /^src\/(\S+):(\d+)-(\d+) /.exec(l)).filter(Boolean).map(m => [m[1], +m[2], +m[3]]);
		const found = gt.filter(([file, from, to]) => {
			for (let i = a.indexOf(file); i >= 0; i = a.indexOf(file, i + 1)) {
				if ((a.slice(i + file.length, i + file.length + 200).match(/\d+/g) ?? []).some(n => +n >= from && +n <= to)) { return true; }
			}
			return false;
		}).length;
		return { score: found >= gt.length - 1 ? 1 : found >= Math.ceil(gt.length * 0.6) ? 0.5 : 0, why: `${found}/${gt.length} calls` };
	},
	't6-implementations': a => {
		const found = has(a, ['MemoryIndexManager', 'QmdMemoryManager', 'FallbackMemoryManager']).length;
		return { score: found === 3 ? 1 : found === 2 ? 0.5 : 0, why: `${found}/3 classes` };
	},
	't7-rename': (_a, diff) => {
		const added = (diff.match(/^\+[^+].*buildGroupHistoryStoreKey/gm) ?? []).length;
		const left = (diff.match(/^\+[^+].*\bbuildGroupHistoryKey\b/gm) ?? []).length;
		const files = (diff.match(/^diff --git/gm) ?? []).length;
		return { score: added >= 2 && left === 0 && files === 2 ? 1 : added >= 1 ? 0.5 : 0, why: `${added} new-name lines, ${files} files` };
	},
	't8-signature': (_a, diff) => {
		// The signature on one line or wrapped one parameter per line (prettier style).
		const def = /^\+.*sanitizeAgentId\(value: string \| undefined \| null, fallback: string\)|^\+\s*fallback: string,?\s*$/m.test(diff) && (diff.match(/^\+.*\bfallback\b/gm) ?? []).length >= 3;
		const sites = (diff.match(/^\+.*sanitizeAgentId\([^)]*(\([^)]*\))?[^)]*,\s*DEFAULT_AGENT_ID\)/gm) ?? []).length;
		const files = (diff.match(/^diff --git/gm) ?? []).length;
		return { score: def && sites >= 7 && files === 5 ? 1 : def && sites >= 5 ? 0.5 : 0, why: `def ${def}, ${sites}/7 sites, ${files} files` };
	},
};
for (const w of windows) {
	const task = Object.keys(graders).find(id => w.label.endsWith(id));
	if (!task) { continue; }
	const diffFile = `${H}/diffs/${w.label}-r${w.rep}.diff`;
	const diff = existsSync(diffFile) ? readFileSync(diffFile, 'utf8') : '';
	console.log(JSON.stringify({ label: w.label, rep: w.rep, ...graders[task](w.answer ?? '', diff) }));
}
