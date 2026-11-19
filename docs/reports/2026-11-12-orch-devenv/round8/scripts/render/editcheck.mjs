// The first edit of a cold window still gets its check, and a read starts no TypeScript helper.
// Needs replay-edit.sh's replay server (request dumps + the `edit-1` session: a Read of src/paginate.ts, then an Edit
// that types a number as string, then the last words) and a running test instance (launch.mjs) with the arena picked.
//   node editcheck.mjs <arm> [session=edit-1]   (row appended to data/render/editcheck.jsonl; the arena file is restored)
// Reports: language helpers (tsserver) alive after the Read and after the Edit, the time from the model's Edit
// call to its next request (the edit's two hooks and the edit), and whether that request carried the edit's errors.
import { execFileSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DATA, FOLDER, cdp, focusComposer, load, newChat, paste, profileProcesses, sleep } from './lib.mjs';

const arm = process.argv[2] ?? 'after';
const session = process.argv[3] ?? 'edit-1';
const DUMP = `${process.env.HOME}/.volt-r8/render/dump.jsonl`;
mkdirSync(DATA, { recursive: true });
writeFileSync(DUMP, '');
const helpers = () => profileProcesses().filter(p => /tsserver|typingsInstaller/.test(p.cmd)).length;
const requests = () => existsSync(DUMP) ? readFileSync(DUMP, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.path === '/v1/messages' && JSON.stringify(r.last).includes('toolu_edit_1_') || JSON.stringify(r.last ?? '').includes(`replay:${session}`)) : [];
const c = await cdp();
await newChat(c);
await sleep(1500);
const pt = await c.evaluate(`(() => { const t = [...document.querySelectorAll('.volt-agent-input-box')].filter(e => e.offsetParent).at(-1); const r = t.getBoundingClientRect(); return [r.x + 60, r.y + r.height / 2]; })()`);
await c.click(pt[0], pt[1]);
await focusComposer(c);
const helpersAtStart = helpers();
await paste(c, `replay:${session}`);
await sleep(500);
const sentAt = Date.now();
await c.key('Enter', 'Enter', 13, 0, '\r');
// The requests of the turn: [0] the prompt, [1] carries the Read's result, [2] the Edit's result (and its hook's context).
const seen = { afterRead: undefined, afterEdit: undefined };
let helpersAfterRead, approvals = 0;
for (const until = Date.now() + 90_000; Date.now() < until;) {
	const turn = requests().filter(r => JSON.stringify(r.last).includes('tool_result'));
	seen.afterRead ??= turn.find(r => JSON.stringify(r.last).includes('toolu_edit_1_0001') && !JSON.stringify(r.last).includes('toolu_edit_1_0002'));
	seen.afterEdit ??= turn.find(r => JSON.stringify(r.last).includes('"tool_use_id":"toolu_edit_1_0002"'));
	if (seen.afterRead && helpersAfterRead === undefined) { helpersAfterRead = helpers(); }
	if (seen.afterEdit) { break; }
	// A permission card for the edit, if the chat's mode asks: allow it once.
	if (await c.evaluate(`(() => { const b = [...document.querySelectorAll('.volt-agent-editor button, .volt-agent-editor [role=button]')].find(e => e.offsetParent && /^(Allow|Approve|Yes|Accept)\\b/i.test((e.textContent || '').trim())); if (!b) { return false; } b.click(); return true; })()`)) { approvals++; }
	await sleep(100);
}
await sleep(3000);
const helpersAfterEdit = helpers();
c.close();
const texts = [];
(function walk(v) { if (typeof v === 'string') { texts.push(v); } else if (v && typeof v === 'object') { Object.values(v).forEach(walk); } })(seen.afterEdit?.last);
const context = texts.map(t => /\[Volt\] (This|An earlier) edit added[\s\S]*/.exec(t)?.[0].split('\n\n')[0]).find(Boolean);
const edited = readFileSync(join(FOLDER, 'src/paginate.ts'), 'utf8').includes('totalItems: string');
execFileSync('git', ['-C', FOLDER, 'checkout', '--', 'src/paginate.ts']);
const row = {
	arm, test: 'first-edit check', at: new Date().toISOString(), load: load(), session, edited, approvals,
	helpersAtStart, helpersAfterRead, helpersAfterEdit,
	readToEditResultMs: seen.afterRead && seen.afterEdit ? seen.afterEdit.t - seen.afterRead.t : null,
	sendToEditResultMs: seen.afterEdit ? seen.afterEdit.t - sentAt : null,
	told: !!context, context: context ?? null,
};
appendFileSync(join(DATA, 'editcheck.jsonl'), JSON.stringify(row) + '\n');
console.log(JSON.stringify(row, null, 1));
