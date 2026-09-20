/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { classifyIntent } from '../../../common/harness/intent.js';
import { analyzeTask, formatTaskBrief, ITaskIntelContext, shouldClarify } from '../../../common/harness/taskIntel.js';
import { VoltMode } from '../../../common/modes.js';

suite('Volt task intelligence', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const analyze = (text: string, mode: VoltMode = 'agent', context: ITaskIntelContext = {}) =>
		analyzeTask(text, classifyIntent(text, mode, { hasWorkspace: true }), context);

	test('strips the social wrapper off the goal', () => {
		assert.strictEqual(analyze('hey, can you please rename foo to bar in utils.ts').goal, 'rename foo to bar in utils.ts');
		assert.strictEqual(analyze('i want you to add a retry to the fetch helper').goal, 'add a retry to the fetch helper');
	});

	test('splits a multi-part request into deliverables', () => {
		const intel = analyze('add a logout button to the header and then update the tests');
		assert.deepStrictEqual(intel.deliverables, ['add a logout button to the header', 'update the tests']);
	});

	test('keeps a single clause when only one carries an imperative', () => {
		const intel = analyze('add a logout button and it is pretty urgent');
		assert.strictEqual(intel.deliverables.length, 1);
	});

	test('orders deliverables the user sequenced', () => {
		const intel = analyze('migrate the schema then update the queries');
		assert.deepStrictEqual(intel.dependencies.map(d => [d.from, d.to]), [[0, 1]]);
	});

	test('inverts a "before" dependency', () => {
		const intel = analyze('update the queries before you migrate the schema');
		assert.deepStrictEqual(intel.dependencies.map(d => [d.from, d.to]), [[1, 0]]);
	});

	test('captures forbid, require, scope, and style constraints', () => {
		const intel = analyze('refactor the parser but do not add any new dependencies, make sure the public API stays, only touch src/parser, and match the existing style');
		const kinds = new Set(intel.constraints.map(constraint => constraint.kind));
		assert.ok(kinds.has('forbid'), 'expected a forbid constraint');
		assert.ok(kinds.has('require'), 'expected a require constraint');
		assert.ok(kinds.has('scope'), 'expected a scope constraint');
		assert.ok(kinds.has('style'), 'expected a style constraint');
	});

	test('reads the project checks named in the request as success criteria', () => {
		const intel = analyze('fix the login bug so that the tests pass and it type-checks');
		const evidence = intel.successCriteria.map(criterion => criterion.evidence);
		assert.ok(evidence.includes('test'), `expected a test criterion, got ${evidence.join(',')}`);
		assert.ok(evidence.includes('typecheck'), `expected a typecheck criterion, got ${evidence.join(',')}`);
		assert.ok(intel.successCriteria.every(criterion => criterion.explicit));
	});

	test('falls back to one implicit criterion when the user states none', () => {
		const intel = analyze('rename foo to bar in utils.ts');
		assert.strictEqual(intel.successCriteria.length, 1);
		assert.strictEqual(intel.successCriteria[0].explicit, false);
		assert.strictEqual(intel.successCriteria[0].evidence, 'diff');
	});

	test('adds no criteria for a closed question', () => {
		const intel = analyze('what is 2+2');
		assert.strictEqual(intel.successCriteria.length, 0);
		assert.strictEqual(intel.shape.lookup, false);
	});

	test('a current-fact question requires a lookup', () => {
		const intel = analyze('how much does this cost right now', 'ask');
		assert.ok(intel.successCriteria.some(criterion => criterion.evidence === 'lookup'));
		assert.strictEqual(intel.shape.lookup, true);
	});

	test('a coding lookup still requires evidence, not a guess', () => {
		const intel = analyze('implement login using the official docs');
		assert.strictEqual(intel.shape.lookup, true);
		assert.strictEqual(intel.shape.cite, true);
		assert.ok(intel.successCriteria.some(criterion => criterion.evidence === 'lookup'));
		assert.ok(intel.successCriteria.some(criterion => criterion.evidence === 'diff'));
	});

	test('a coding table request is a deliverable, not only a chat answer', () => {
		const intel = analyze('add a table of all routes to the README');
		assert.strictEqual(intel.shape.form, 'table');
		assert.ok(intel.successCriteria.some(criterion => criterion.text.startsWith('Deliver a table')));
		assert.ok(intel.successCriteria.some(criterion => criterion.evidence === 'diff'));
	});

	test('an enumeration in a table is a researched answer', () => {
		const intel = analyze('tell me each model and their price give me in a table', 'ask');
		assert.strictEqual(intel.shape.form, 'table');
		assert.strictEqual(intel.shape.enumerate, true);
		assert.ok(intel.successCriteria.some(criterion => criterion.evidence === 'lookup'));
		assert.ok(intel.successCriteria.some(criterion => criterion.explicit && criterion.text.startsWith('The answer is a table')));
		const brief = formatTaskBrief(intel);
		assert.ok(brief && /Answer as a table/i.test(brief));
		assert.ok(brief && /every item|Look up/i.test(brief));
		assert.ok(brief && /Done means:/.test(brief));
	});

	test('scores complexity from trivial through epic', () => {
		const small = analyze('fix the typo in README.md');
		const epic = analyze([
			'migrate the entire backend from express to fastify end-to-end,',
			'- rewrite every route handler',
			'- port the middleware',
			'- update all the tests',
			'- regenerate the openapi schema',
			'and make it production-ready with no regressions',
		].join('\n'));
		assert.ok(small.complexityScore < epic.complexityScore, `${small.complexityScore} < ${epic.complexityScore}`);
		assert.ok(['trivial', 'small'].includes(small.complexity), `unexpected ${small.complexity}`);
		assert.ok(['large', 'epic'].includes(epic.complexity), `unexpected ${epic.complexity}`);
	});

	test('does not ask a question for a well-specified request', () => {
		const intel = analyze('add a loading spinner to src/components/Table.tsx while rows fetch');
		assert.strictEqual(shouldClarify(intel.ambiguity), false);
		assert.strictEqual(intel.ambiguity.question, undefined);
	});

	test('asks which file when the first turn only says "fix it"', () => {
		const intel = analyze('fix it');
		assert.strictEqual(shouldClarify(intel.ambiguity), true);
		assert.ok(/which file/i.test(intel.ambiguity.question ?? ''));
	});

	test('does not ask when an earlier turn can resolve the reference', () => {
		const intel = analyze('fix it', 'agent', { hasPriorTurns: true });
		assert.strictEqual(shouldClarify(intel.ambiguity), false);
	});

	test('does not ask when an attachment names the target', () => {
		const intel = analyze('fix it', 'agent', { attachments: ['src/app.ts'] });
		assert.strictEqual(shouldClarify(intel.ambiguity), false);
	});

	test('flags a self-contradicting request', () => {
		const intel = analyze('add a date picker library but do not add any new dependencies');
		assert.strictEqual(shouldClarify(intel.ambiguity), true);
		assert.ok(/conflict/i.test(intel.ambiguity.question ?? ''));
	});

	test('never blocks a chat turn on a question', () => {
		const intel = analyze('make it better', 'ask');
		assert.strictEqual(shouldClarify(intel.ambiguity), false);
	});

	test('briefs the model on constraints and stated criteria only', () => {
		const brief = formatTaskBrief(analyze('refactor the parser, do not add new dependencies, so that the tests pass'));
		assert.ok(brief);
		assert.ok(brief.includes('Constraints the user set:'));
		assert.ok(/do not add new dependencies/i.test(brief));
		assert.ok(brief.includes('Done means:'));
	});

	test('briefs nothing when the request carries neither', () => {
		assert.strictEqual(formatTaskBrief(analyze('rename foo to bar in utils.ts')), undefined);
	});
});
