/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { EvidenceStore } from '../../../common/harness/evidence.js';
import { classifyIntent } from '../../../common/harness/intent.js';
import { buildPlan, withStepStatus } from '../../../common/harness/plan.js';
import { ISynthesisInput, parseFinishPayload, renderOutcome, synthesize } from '../../../common/harness/synthesis.js';
import { analyzeTask } from '../../../common/harness/taskIntel.js';
import { checkCompletion, commandClassifier, IProjectChecks, planGates } from '../../../common/harness/verification.js';
import { countWork, EMPTY_WORK } from '../../../common/harness/workLog.js';
import { IToolCall, IToolResult } from '../../../common/tools/tool.js';

suite('Volt result synthesis', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const checks: IProjectChecks = { test: 'npm test', typecheck: 'npx tsc --noEmit' };

	test('reports a verified run as done and names the gate that passed', () => {
		const outcome = synthesize(scenario('fix the login bug so the tests pass', store => {
			record(store, 1, 'edit_file', { path: 'src/login.ts' }, 'edit');
			record(store, 2, 'shell', { command: 'npm test' }, 'execute');
		}));
		assert.strictEqual(outcome.status, 'completed');
		assert.ok(/^Done: fix the login bug/.test(outcome.headline), outcome.headline);
		assert.ok(/test.? passing/.test(outcome.headline), outcome.headline);
		assert.deepStrictEqual(outcome.verification, [{ label: 'test', passed: true, detail: 'npm test' }]);
		assert.deepStrictEqual(outcome.next, []);
	});

	test('never claims a check passed when nothing ran', () => {
		const outcome = synthesize(scenario('fix the login bug so the tests pass', store => {
			record(store, 1, 'edit_file', { path: 'src/login.ts' }, 'edit');
		}, { assistantSummary: 'All done, everything works now!' }));
		assert.strictEqual(outcome.status, 'partial');
		assert.strictEqual(outcome.verification[0].passed, false);
		assert.strictEqual(outcome.verification[0].detail, 'never run');
		assert.ok(outcome.next.some(item => /Run the test check/.test(item)), outcome.next.join(' | '));
		assert.strictEqual(outcome.narrative, 'All done, everything works now!', 'the model still gets to explain itself');
	});

	test('a failing gate makes the run partial, not failed, when files changed', () => {
		const outcome = synthesize(scenario('fix the login bug so the tests pass', store => {
			record(store, 1, 'edit_file', { path: 'src/login.ts' }, 'edit');
			record(store, 2, 'shell', { command: 'npm test' }, 'execute', '2 failing');
		}));
		assert.strictEqual(outcome.status, 'partial');
		assert.ok(/still failing/.test(outcome.headline), outcome.headline);
		assert.ok(outcome.next.some(item => /Fix the failing test check/.test(item)));
	});

	test('a run that did nothing at all is a failure', () => {
		const outcome = synthesize(scenario('fix the login bug so the tests pass', () => undefined));
		assert.strictEqual(outcome.status, 'failed');
		assert.ok(/Could not complete/.test(outcome.headline));
	});

	test('cancelling mid-run says the edits are still on disk', () => {
		const outcome = synthesize(scenario('rename foo to bar in utils.ts', store => {
			record(store, 1, 'edit_file', { path: 'src/utils.ts' }, 'edit');
		}, { cancelled: true }));
		assert.strictEqual(outcome.status, 'cancelled');
		assert.ok(/still on disk/.test(outcome.headline), outcome.headline);
		assert.strictEqual(outcome.statusLine, 'Cancelled');
	});

	test('distinguishes a created file from an edited one', () => {
		const outcome = synthesize(scenario('add a logout button to the header', store => {
			store.recordFileChange(1, 'src/Logout.tsx', 'create');
			record(store, 2, 'edit_file', { path: 'src/Header.tsx' }, 'edit');
			store.recordFileChange(3, 'src/old.tsx', 'delete');
		}));
		assert.deepStrictEqual(outcome.changes, [
			{ path: 'src/Logout.tsx', kind: 'create' },
			{ path: 'src/Header.tsx', kind: 'edit' },
			{ path: 'src/old.tsx', kind: 'delete' },
		]);
	});

	test('keeps a file as created even after it is edited again', () => {
		const outcome = synthesize(scenario('add a logout button to the header', store => {
			store.recordFileChange(1, 'src/Logout.tsx', 'create');
			record(store, 2, 'edit_file', { path: 'src/Logout.tsx' }, 'edit');
		}));
		assert.deepStrictEqual(outcome.changes, [{ path: 'src/Logout.tsx', kind: 'create' }]);
	});

	test('surfaces a URL a command printed', () => {
		const outcome = synthesize(scenario('run the app', store => {
			record(store, 1, 'shell', { command: 'npm run dev' }, 'execute', undefined, 'VITE ready\n  ➜  Local: http://localhost:5173/');
		}));
		assert.deepStrictEqual(outcome.artifacts, [{ kind: 'url', value: 'http://localhost:5173/', label: 'started by a command' }]);
	});

	test('reports a check the project cannot run rather than pretending it passed', () => {
		const outcome = synthesize(scenario('fix the login bug so the tests pass', store => {
			record(store, 1, 'edit_file', { path: 'src/login.ts' }, 'edit');
		}, { checks: {} }));
		assert.strictEqual(outcome.status, 'completed', 'an unavailable gate does not block');
		assert.deepStrictEqual(outcome.verification, [{ label: 'test', passed: false, detail: 'This project declares no test command.' }]);
		assert.ok(outcome.next.some(item => /no test command/.test(item)));
	});

	test('lists failed and skipped plan steps as next actions', () => {
		const input = scenario('add a logout button to the header and update the tests', store => {
			record(store, 1, 'edit_file', { path: 'src/Header.tsx' }, 'edit');
		});
		let plan = buildPlan(input.intel, 'agent')!;
		plan = withStepStatus(plan, 's1', 'done');
		plan = withStepStatus(plan, 's2', 'failed', 'could not find the header');
		plan = withStepStatus(plan, 's3', 'skipped', 'no tests exist');

		const outcome = synthesize({ ...input, plan });
		assert.ok(outcome.next.some(item => /^Retry: .*\(could not find the header\)/.test(item)), outcome.next.join(' | '));
		assert.ok(outcome.next.some(item => /^Skipped: .*\(no tests exist\)/.test(item)));
	});

	test('parses remaining items out of a finish payload', () => {
		const parsed = parseFinishPayload('{"summary":"Edited a.ts","remaining":["Document the flag"]}');
		assert.deepStrictEqual(parsed, { summary: 'Edited a.ts', remaining: ['Document the flag'] });
		assert.strictEqual(parseFinishPayload('not json'), undefined);
	});

	test('folds the model\'s own remaining items in after the evidence-backed ones', () => {
		const outcome = synthesize(scenario('fix the login bug so the tests pass', store => {
			record(store, 1, 'edit_file', { path: 'src/login.ts' }, 'edit');
		}, { modelRemaining: ['Document the new flag in the README'] }));
		assert.ok(/Run the test check/.test(outcome.next[0]), outcome.next.join(' | '));
		assert.ok(outcome.next.includes('Document the new flag in the README'));
	});

	test('does not repeat an item the completion check already named', () => {
		const outcome = synthesize(scenario('fix the login bug so the tests pass', store => {
			record(store, 1, 'edit_file', { path: 'src/login.ts' }, 'edit');
			record(store, 2, 'shell', { command: 'npm test' }, 'execute', '2 failing');
		}, { modelRemaining: ['Fix the failing test check.'] }));
		assert.strictEqual(outcome.next.filter(item => /Fix the failing test check/i.test(item)).length, 1);
	});

	test('summarises the work in a status line', () => {
		const outcome = synthesize(scenario('rename foo to bar in utils.ts', store => {
			record(store, 1, 'edit_file', { path: 'src/utils.ts' }, 'edit');
			record(store, 2, 'shell', { command: 'npx tsc --noEmit' }, 'execute');
		}, { work: countWork(['edit', 'execute'], 1), durationMs: 27_000 }));
		assert.strictEqual(outcome.statusLine, 'Worked for 27s · Edited 1 file · ran 1 command');
	});

	suite('rendering', () => {
		test('omits sections with nothing in them', () => {
			const markdown = renderOutcome(synthesize(scenario('what does this do', () => undefined, { readOnly: true })));
			assert.strictEqual(markdown.includes('**Changed**'), false);
			assert.strictEqual(markdown.includes('**Next**'), false);
		});

		test('renders every populated section', () => {
			const markdown = renderOutcome(synthesize(scenario('fix the login bug so the tests pass', store => {
				record(store, 1, 'edit_file', { path: 'src/login.ts' }, 'edit');
				record(store, 2, 'shell', { command: 'npm test' }, 'execute', '2 failing');
			}, { assistantSummary: 'Swapped the token check.' })));
			assert.ok(markdown.includes('Swapped the token check.'));
			assert.ok(markdown.includes('**Changed**\n- edited `src/login.ts`'));
			assert.ok(markdown.includes('**Verified**'));
			assert.ok(markdown.includes('**Next**'));
		});
	});
});

function scenario(
	text: string,
	fill: (store: EvidenceStore) => void,
	overrides: Partial<ISynthesisInput> & { checks?: IProjectChecks } = {},
): ISynthesisInput {
	const checks = overrides.checks ?? { test: 'npm test', typecheck: 'npx tsc --noEmit' };
	const intel = analyzeTask(text, classifyIntent(text, 'agent', { hasWorkspace: true }));
	const store = new EvidenceStore(commandClassifier(checks));
	fill(store);
	const gates = planGates(intel, checks);
	const completion = checkCompletion({ intel, gates, store, checks, readOnly: overrides.readOnly });
	return {
		intel,
		store,
		gates,
		completion,
		work: EMPTY_WORK,
		durationMs: 5_000,
		...overrides,
	};
}

function record(store: EvidenceStore, step: number, name: string, args: unknown, kind: IToolResult['kind'], error?: string, output?: string): void {
	const call: IToolCall = { id: `c${step}`, name, args };
	const result: IToolResult = { callId: call.id, name, kind, text: error ?? output ?? 'ok', ...(error ? { isError: true } : {}) };
	store.record(step, [call], [result]);
}
