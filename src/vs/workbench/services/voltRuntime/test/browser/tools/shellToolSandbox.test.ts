/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A native model's shell tool in a sandboxed chat (05-limitations item 16): its commands carry the
 * chat's sandbox, what that sandbox stopped becomes the chat's Volt Guard card, and a refusal is
 * an error the model reads, never an exit status. The real sandbox run of the same request is in
 * voltStdioSandbox.test.ts (LIFE-PATH agent-shell, NATIVE-DENY-2).
 */

import assert from 'assert';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { ISandboxDenial } from '../../../../../../platform/voltSandbox/common/sandboxDenials.js';
import { IVoltExecRequest, IVoltExecResult, IVoltStdioService } from '../../../../../../platform/voltStdio/common/voltStdio.js';
import { createShellTools } from '../../../browser/tools/shellTool.js';
import { chatExec } from '../../../common/execContext.js';

suite('Volt native shell tool in a sandboxed chat (NATIVE-1, NATIVE-DENY-1, FAIL-NATIVE-1)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const settings = { level: 'workspace-write' as const, network: false, allowedDomains: ['registry.npmjs.org'], listenPorts: [5173] };

	function run(answer: Partial<IVoltExecResult>) {
		const seen: IVoltExecRequest[] = [];
		const events: { type: string;[key: string]: unknown }[] = [];
		const stdio = {
			exec: async (request: IVoltExecRequest): Promise<IVoltExecResult> => {
				seen.push(request);
				return { id: request.id, exitCode: 0, stdout: '', stderr: '', combined: '', durationMs: 5, truncated: false, timedOut: false, cancelled: false, running: false, ...answer };
			},
			cancelExec: async () => undefined,
		} as unknown as IVoltStdioService;
		const [shell] = createShellTools({ stdio, root: () => URI.file('/ws/a'), exec: () => chatExec('a', settings, ['/ws/a'], 'agent-shell') });
		const result = shell.execute({ command: 'npm test' }, { signal: new AbortController().signal, emit: event => events.push(event) });
		return { seen, events, result };
	}

	test('NATIVE-1: the command carries the chat\'s sandbox and context, with its granted hosts and ports', async () => {
		const { seen, result } = run({ combined: 'ok' });
		assert.strictEqual((await result).isError, false);
		assert.deepStrictEqual(seen[0].context, { principal: 'chat:a', reason: 'agent-shell', sandboxed: true });
		assert.deepStrictEqual(seen[0].sandbox, { level: 'workspace-write', network: false, providerId: '', workspaceRoots: ['/ws/a'], allowedDomains: ['registry.npmjs.org'], listenPorts: [5173] });
	});

	test('NATIVE-DENY-1: what the sandbox stopped becomes the chat\'s card, without the broker\'s record', async () => {
		const denials: ISandboxDenial[] = [
			{ kind: 'write', target: '/Users/u/.config/x', source: 'os', process: 'touch', denialId: 'd1', epoch: 3 },
			{ kind: 'network', target: 'evil.example', source: 'proxy' },
		];
		const { events, result } = run({ exitCode: 1, combined: 'touch: Operation not permitted', sandboxDenials: denials });
		assert.strictEqual((await result).isError, true);
		assert.deepStrictEqual(events, [
			{ type: 'sandbox.denial', denial: { kind: 'write', target: '/Users/u/.config/x', source: 'os', process: 'touch' } },
			{ type: 'sandbox.denial', denial: { kind: 'network', target: 'evil.example', source: 'proxy' } },
		]);
	});

	test('FAIL-NATIVE-1: a refused command is an error saying nothing ran, not an exit status', async () => {
		const { result } = run({ exitCode: null, refused: { kind: 'sandbox', reason: 'This machine\'s sandbox cannot enforce' } });
		const text = await result;
		assert.strictEqual(text.isError, true);
		assert.match(text.text, /not run: refused by Volt's sandbox \(sandbox\)/);
		assert.match(text.text, /cannot enforce/);
		assert.strictEqual(text.exitCode, undefined);
	});
});
