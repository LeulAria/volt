/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { EvidenceStore } from '../../../common/harness/evidence.js';
import { classifyIntent } from '../../../common/harness/intent.js';
import { buildPlan, withStepStatus } from '../../../common/harness/plan.js';
import { analyzeTask } from '../../../common/harness/taskIntel.js';
import {
	checkCompletion, commandClassifier, detectProjectChecks, evaluateGates,
	hasAnyCheck, IProjectChecks, planGates,
} from '../../../common/harness/verification.js';
import { IToolCall, IToolResult } from '../../../common/tools/tool.js';

suite('Volt verification engine', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('project detection', () => {
		test('reads the npm scripts a project declares', () => {
			const checks = detectProjectChecks({
				packageJson: { scripts: { test: 'jest', lint: 'eslint .', build: 'tsup' } },
			});
			assert.deepStrictEqual(checks, { test: 'npm test', lint: 'npm run lint', build: 'npm run build' });
		});

		test('uses the declared package manager', () => {
			const checks = detectProjectChecks({
				packageJson: { scripts: { test: 'vitest', 'type-check': 'tsc --noEmit' }, packageManager: 'pnpm@9.0.0' },
			});
			assert.strictEqual(checks.test, 'pnpm test');
			assert.strictEqual(checks.typecheck, 'pnpm run type-check');
		});

		test('falls back to the lockfile when no package manager is declared', () => {
			assert.strictEqual(detectProjectChecks({ packageJson: { scripts: { lint: 'eslint .' } }, lock: 'yarn' }).lint, 'yarn run lint');
		});

		test('offers tsc --noEmit for a TypeScript project with no typecheck script', () => {
			assert.strictEqual(detectProjectChecks({ tsconfig: true }).typecheck, 'npx tsc --noEmit');
			assert.strictEqual(detectProjectChecks({ tsconfig: true, lock: 'pnpm' }).typecheck, 'pnpm exec tsc --noEmit');
		});

		test('does not invent a test command for a project without one', () => {
			const checks = detectProjectChecks({ packageJson: { scripts: { build: 'vite build' } } });
			assert.strictEqual(checks.test, undefined);
			assert.strictEqual(checks.lint, undefined);
		});

		test('knows the cargo, go, and python conventions', () => {
			assert.strictEqual(detectProjectChecks({ cargoToml: true }).test, 'cargo test');
			assert.strictEqual(detectProjectChecks({ goMod: true }).lint, 'go vet ./...');
			assert.strictEqual(detectProjectChecks({ pyproject: true }).test, 'pytest');
		});

		test('reports whether the project can check itself at all', () => {
			assert.strictEqual(hasAnyCheck({}), false);
			assert.strictEqual(hasAnyCheck({ test: 'npm test' }), true);
		});
	});

	suite('command classification', () => {
		const classify = commandClassifier({ test: 'npm test', typecheck: 'npx tsc --noEmit' });

		test('matches the configured command exactly and with extra arguments', () => {
			assert.strictEqual(classify('npm test'), 'test');
			assert.strictEqual(classify('npm test -- --watch=false'), 'test');
		});

		test('recognises a check the model ran a different way', () => {
			assert.strictEqual(classify('npx vitest run src/'), 'test');
			assert.strictEqual(classify('npx eslint src --fix'), 'lint');
			assert.strictEqual(classify('cargo build --release'), 'build');
		});

		test('ignores an ordinary command', () => {
			assert.strictEqual(classify('git status'), undefined);
			assert.strictEqual(classify('ls -la src'), undefined);
		});
	});

	suite('gates', () => {
		test('creates one gate per machine-checkable criterion kind', () => {
			const gates = planGates(analyze('fix the login bug so the tests pass and it type-checks'), { test: 'npm test', typecheck: 'npx tsc --noEmit' });
			assert.deepStrictEqual(gates.map(gate => gate.kind).sort(), ['test', 'typecheck']);
			assert.strictEqual(gates.every(gate => gate.status === 'pending'), true);
		});

		test('marks a gate unavailable when the project has no such command', () => {
			const [gate] = planGates(analyze('fix the login bug so the tests pass'), {});
			assert.strictEqual(gate.status, 'unavailable');
			assert.ok(/declares no test command/.test(gate.detail ?? ''));
		});

		test('creates no gates for a request with only a diff criterion', () => {
			assert.deepStrictEqual(planGates(analyze('rename foo to bar in utils.ts'), { test: 'npm test' }), []);
		});

		test('resolves a gate to passed, failed, and back to pending after an edit', () => {
			const checks: IProjectChecks = { test: 'npm test' };
			const store = new EvidenceStore(commandClassifier(checks));
			const gates = planGates(analyze('fix the login bug so the tests pass'), checks);

			assert.strictEqual(evaluateGates(gates, store)[0].status, 'pending');

			record(store, 1, 'shell', { command: 'npm test' }, 'execute', '2 failing');
			const failedGate = evaluateGates(gates, store)[0];
			assert.strictEqual(failedGate.status, 'failed');
			assert.strictEqual(failedGate.detail, '2 failing');

			record(store, 2, 'shell', { command: 'npm test' }, 'execute');
			assert.strictEqual(evaluateGates(gates, store)[0].status, 'passed');

			record(store, 3, 'edit_file', { path: 'src/a.ts' }, 'edit');
			assert.strictEqual(evaluateGates(gates, store)[0].status, 'pending', 'the edit invalidates the pass');
		});
	});

	suite('completion', () => {
		const checks: IProjectChecks = { test: 'npm test', typecheck: 'npx tsc --noEmit' };

		test('refuses to finish while a gate has never run', () => {
			const intel = analyze('fix the login bug so the tests pass');
			const store = new EvidenceStore(commandClassifier(checks));
			record(store, 1, 'edit_file', { path: 'src/a.ts' }, 'edit');

			const result = checkCompletion({ intel, gates: planGates(intel, checks), store, checks });
			assert.strictEqual(result.complete, false);
			assert.deepStrictEqual(result.pending, ['test']);
			assert.ok(/have not run test \(`npm test`\)/.test(result.reason), result.reason);
		});

		test('refuses to finish while a gate is failing', () => {
			const intel = analyze('fix the login bug so the tests pass');
			const store = new EvidenceStore(commandClassifier(checks));
			record(store, 1, 'edit_file', { path: 'src/a.ts' }, 'edit');
			record(store, 2, 'shell', { command: 'npm test' }, 'execute', '2 failing');

			const result = checkCompletion({ intel, gates: planGates(intel, checks), store, checks });
			assert.strictEqual(result.complete, false);
			assert.deepStrictEqual(result.failed, ['test']);
			assert.ok(/still failing/.test(result.reason));
		});

		test('finishes once the change is made and the gate passes', () => {
			const intel = analyze('fix the login bug so the tests pass');
			const store = new EvidenceStore(commandClassifier(checks));
			record(store, 1, 'edit_file', { path: 'src/a.ts' }, 'edit');
			record(store, 2, 'shell', { command: 'npm test' }, 'execute');

			const result = checkCompletion({ intel, gates: planGates(intel, checks), store, checks });
			assert.strictEqual(result.complete, true, result.reason);
			assert.strictEqual(result.reason, '1 file changed; test passing.');
		});

		test('blocks the quiet failure: files changed, nothing ever run', () => {
			const intel = analyze('rename foo to bar in utils.ts');
			const store = new EvidenceStore(commandClassifier(checks));
			record(store, 1, 'edit_file', { path: 'src/utils.ts' }, 'edit');

			const result = checkCompletion({ intel, gates: planGates(intel, checks), store, checks });
			assert.strictEqual(result.complete, false);
			assert.ok(/nothing was run to check them/.test(result.reason), result.reason);
			assert.ok(result.reason.includes('npx tsc --noEmit'));
		});

		test('allows the same run to finish once a check has been run', () => {
			const intel = analyze('rename foo to bar in utils.ts');
			const store = new EvidenceStore(commandClassifier(checks));
			record(store, 1, 'edit_file', { path: 'src/utils.ts' }, 'edit');
			record(store, 2, 'shell', { command: 'npx tsc --noEmit' }, 'execute');

			assert.strictEqual(checkCompletion({ intel, gates: planGates(intel, checks), store, checks }).complete, true);
		});

		test('does not demand a check from a project that has none', () => {
			const intel = analyze('rename foo to bar in utils.ts');
			const store = new EvidenceStore();
			record(store, 1, 'edit_file', { path: 'src/utils.ts' }, 'edit');

			assert.strictEqual(checkCompletion({ intel, gates: [], store, checks: {} }).complete, true);
		});

		test('refuses to finish a change request that changed nothing', () => {
			const intel = analyze('rename foo to bar in utils.ts');
			const result = checkCompletion({ intel, gates: [], store: new EvidenceStore(), checks: {} });
			assert.strictEqual(result.complete, false);
			assert.ok(/nothing in the workspace changed/.test(result.reason));
		});

		test('does not demand a table in the assistant text after a coding change', () => {
			const intel = analyze('add a table of all routes to the README');
			const store = new EvidenceStore();
			record(store, 1, 'edit_file', { path: 'README.md' }, 'edit');
			const result = checkCompletion({ intel, gates: [], store, checks: {}, assistantText: 'I added the table to README.' });
			assert.strictEqual(result.complete, true, result.reason);
		});

		test('lets a read-only lane finish without changing anything', () => {
			const intel = analyze('explain how auth works here');
			const result = checkCompletion({ intel, gates: [], store: new EvidenceStore(), checks, readOnly: true });
			assert.strictEqual(result.complete, true);
		});

		test('refuses a lookup question that never searched', () => {
			const intel = analyzeAsk('tell me each model and their price give me in a table');
			const result = checkCompletion({ intel, gates: [], store: new EvidenceStore(), checks: {}, readOnly: true, assistantText: 'Prices vary by dealer.' });
			assert.strictEqual(result.complete, false);
			assert.ok(/web_search/.test(result.reason), result.reason);
		});

		test('refuses a lookup that searched but did not produce the asked table', () => {
			const intel = analyzeAsk('tell me each model and their price give me in a table');
			const store = new EvidenceStore();
			record(store, 1, 'web_search', { query: 'models' }, 'fetch');
			const result = checkCompletion({ intel, gates: [], store, checks: {}, readOnly: true, assistantText: 'They start around sixty thousand.' });
			assert.strictEqual(result.complete, false);
			assert.ok(/table/.test(result.reason), result.reason);
		});

		test('refuses to finish while a plan step is open', () => {
			const intel = analyze('rename foo to bar in utils.ts');
			const store = new EvidenceStore();
			record(store, 1, 'edit_file', { path: 'src/utils.ts' }, 'edit');
			const plan = buildPlan(intel, 'fast')!;

			const result = checkCompletion({ intel, gates: [], store, checks: {}, plan });
			assert.strictEqual(result.complete, false);
			assert.ok(/1 plan step still open/.test(result.reason), result.reason);

			const done = checkCompletion({ intel, gates: [], store, checks: {}, plan: withStepStatus(plan, 's1', 'done') });
			assert.strictEqual(done.complete, true);
		});

		test('reports an unavailable gate without blocking on it', () => {
			const intel = analyze('fix the login bug so the tests pass');
			const store = new EvidenceStore();
			record(store, 1, 'edit_file', { path: 'src/a.ts' }, 'edit');

			const result = checkCompletion({ intel, gates: planGates(intel, {}), store, checks: {} });
			assert.strictEqual(result.complete, true, result.reason);
			assert.deepStrictEqual(result.unavailable, ['test']);
		});
	});
});

function analyze(text: string) {
	return analyzeTask(text, classifyIntent(text, 'agent', { hasWorkspace: true }));
}

function analyzeAsk(text: string) {
	return analyzeTask(text, classifyIntent(text, 'ask', { hasWorkspace: true }));
}

function record(store: EvidenceStore, step: number, name: string, args: unknown, kind: IToolResult['kind'], error?: string): void {
	const call: IToolCall = { id: `c${step}`, name, args };
	const result: IToolResult = { callId: call.id, name, kind, text: error ?? 'ok', ...(error ? { isError: true } : {}) };
	store.record(step, [call], [result]);
}
