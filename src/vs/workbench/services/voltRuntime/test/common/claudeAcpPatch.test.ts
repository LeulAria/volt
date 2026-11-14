/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { decodeBase64 } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { acpAdapterPreload, CLAUDE_ACP_AGENT_MODULE, CLAUDE_ACP_AUTH_PROBE_FALLBACK_MS, claudeAcpTransformSource } from '../../common/claudeAcpPatch.js';

type Transform = (source: string) => { text?: string; failed?: string };

/** The transform exactly as the adapter's node runs it (the preload embeds this source). */
function transform(): Transform {
	return new Function(`return ${claudeAcpTransformSource()}`)() as Transform;
}

/**
 * The adapter's own lines the patches edit (claude-agent-acp 0.106.0, `dist/v1/acp-agent.js`), in a
 * small program: `prompt` is `startTurn`, `init` and `message` the turn's message loop.
 */
const ADAPTER = `
const calls = [];
const timers = [];
const setTimeout = (run, ms) => { timers.push({ run, ms }); return {}; };
const sessions = { s1: {} };
const agent = {
	sessions,
	authStatus: { probe: () => calls.push('auth probe') },
	refreshSkillFiles: id => calls.push('skill files ' + id),
	respawnSignedOutSession: () => undefined,
	prompt(params) {
		let session = this.sessions[params.sessionId];
		this.authStatus.useSettings?.();
		void this.authStatus.probe();
		const signOutRespawn = this.respawnSignedOutSession(params.sessionId, session);
		calls.push('prompt sent');
	},
	init(params) {
		const session = this.sessions[params.sessionId];
								if (!session.skillFilesRequested) {
									session.skillFilesRequested = true;
									void this.refreshSkillFiles(params.sessionId);
								}
	},
	message(params, message) {
		const session = this.sessions[params.sessionId];
				switch (message.type) {
					case "result": {
						session.modelRequestSinceResult = false;
						calls.push('result');
					}
				}
	},
};
return { agent, calls, timers };
`;

interface IAdapterFixture {
	readonly agent: { prompt(p: object): void; init(p: object): void; message(p: object, m: object): void };
	readonly calls: string[];
	readonly timers: { run(): void; ms: number }[];
}

function load(source: string): IAdapterFixture {
	return new Function(source)();
}

/** Runs the timers set for `ms` or less, in order; the others stay. */
function elapse(fixture: IAdapterFixture, ms: number): void {
	const due = fixture.timers.filter(t => t.ms <= ms);
	fixture.timers.splice(0, fixture.timers.length, ...fixture.timers.filter(t => t.ms > ms));
	for (const timer of due) {
		timer.run();
	}
}

suite('Claude ACP adapter patch', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the unpatched adapter reads the skill files on the first init, before the model request', () => {
		const { agent, calls } = load(ADAPTER);
		agent.init({ sessionId: 's1' });
		assert.deepStrictEqual(calls, ['skill files s1']);
	});

	test('the skill files are read once the turn has its result', () => {
		const out = transform()(ADAPTER);
		assert.strictEqual(out.failed, undefined);
		const fixture = load(out.text!);
		const { agent, calls } = fixture;
		agent.init({ sessionId: 's1' });
		agent.init({ sessionId: 's1' });
		assert.deepStrictEqual(calls, []);
		agent.message({ sessionId: 's1' }, { type: 'result' });
		// After the result has been handled, never inside it.
		assert.deepStrictEqual(calls, ['result']);
		elapse(fixture, 0);
		assert.deepStrictEqual(calls, ['result', 'skill files s1']);
		// Once: a later result has nothing queued.
		agent.message({ sessionId: 's1' }, { type: 'result' });
		elapse(fixture, 0);
		assert.deepStrictEqual(calls, ['result', 'skill files s1', 'result']);
	});

	test('the per-prompt sign-in check runs after the prompt is sent: at the result, or 3 s into a turn with none', () => {
		const unpatched = load(ADAPTER);
		unpatched.agent.prompt({ sessionId: 's1' });
		assert.deepStrictEqual(unpatched.calls, ['auth probe', 'prompt sent']);

		const fixture = load(transform()(ADAPTER).text!);
		fixture.agent.prompt({ sessionId: 's1' });
		assert.deepStrictEqual(fixture.calls, ['prompt sent']);
		fixture.agent.message({ sessionId: 's1' }, { type: 'result' });
		elapse(fixture, 0);
		assert.deepStrictEqual(fixture.calls, ['prompt sent', 'result', 'auth probe']);
		// The fallback timer of the same check does not run it again.
		elapse(fixture, CLAUDE_ACP_AUTH_PROBE_FALLBACK_MS);
		assert.deepStrictEqual(fixture.calls, ['prompt sent', 'result', 'auth probe']);

		// A turn that never gets a result (refused, or the CLI died) still checks.
		const refused = load(transform()(ADAPTER).text!);
		refused.agent.prompt({ sessionId: 's1' });
		elapse(refused, 0);
		assert.deepStrictEqual(refused.calls, ['prompt sent']);
		elapse(refused, CLAUDE_ACP_AUTH_PROBE_FALLBACK_MS);
		assert.deepStrictEqual(refused.calls, ['prompt sent', 'auth probe']);
	});

	test('another adapter version loads untouched: one edit that does not match exactly once applies none', () => {
		const missing = ADAPTER.replace('void this.refreshSkillFiles(params.sessionId);', 'this.refreshSkillFiles(params.sessionId);');
		assert.deepStrictEqual(transform()(missing), { failed: 'skill-files-after-turn' });
		const twice = ADAPTER.replace('calls.push(\'result\');', 'calls.push(\'result\'); } case "result": { session.modelRequestSinceResult = false;');
		assert.deepStrictEqual(transform()(twice), { failed: 'turn-end' });
	});

	test('whitespace may differ, the code may not', () => {
		const reindented = ADAPTER.replace(/\n\t+/g, match => '\n' + '    '.repeat(match.length - 1));
		assert.ok(transform()(reindented).text?.includes('voltAfterTurn(session, () => void this.refreshSkillFiles(params.sessionId))'));
	});

	test('only Claude\'s adapter gets the preload, and it hooks the adapter module only', () => {
		assert.strictEqual(acpAdapterPreload('@agentclientprotocol/codex-acp@1.13.1'), undefined);
		const preload = acpAdapterPreload('@agentclientprotocol/claude-agent-acp@0.106.0') ?? '';
		assert.ok(preload.startsWith('data:text/javascript;base64,'));
		const source = decodeBase64(preload.slice('data:text/javascript;base64,'.length)).toString();
		assert.ok(source.includes('registerHooks'));
		assert.ok(source.includes(JSON.stringify(CLAUDE_ACP_AGENT_MODULE)));
		// Plain base64: safe as one argv entry, through any shell quoting.
		assert.match(preload, /^[A-Za-z0-9:;,/+=.-]+$/);
	});
});
