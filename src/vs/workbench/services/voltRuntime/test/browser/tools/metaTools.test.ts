/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { createMetaTools, IMetaToolHost } from '../../../browser/tools/metaTools.js';
import { AgentQuestionDraft } from '../../../common/questions.js';
import { IToolContext, IVoltTool } from '../../../common/tools/tool.js';

suite('Volt meta tools', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const base: IMetaToolHost = { grantGroups: groups => groups };

	function find(tools: readonly IVoltTool[], name: string): IVoltTool {
		const tool = tools.find(item => item.name === name);
		assert.ok(tool, `${name} is registered`);
		return tool;
	}

	function context(signal = new AbortController().signal): IToolContext {
		return { signal };
	}

	test('create_plan returns a review hand-off and rejects an empty plan', async () => {
		const tool = find(createMetaTools(base), 'create_plan');
		assert.strictEqual(tool.group, 'meta');
		const result = await tool.execute({ name: 'Dark mode', plan: '## Steps\n1. Add a toggle', todos: ['Add toggle', 'Persist choice'] }, context());
		assert.ok(!result.isError);
		assert.ok(/Plan "Dark mode" is ready for review \(2 steps\)\. Stop here/.test(result.text), result.text);
		assert.strictEqual((await tool.execute({ name: 'Empty' }, context())).isError, true);
	});

	test('ask_question exists only when the host can show questions, and returns the answers', async () => {
		assert.ok(!createMetaTools(base).some(tool => tool.name === 'ask_question'));
		let asked: AgentQuestionDraft | undefined;
		const tool = find(createMetaTools({
			...base,
			askQuestion: async draft => {
				asked = draft;
				return { outcome: 'answered', answers: [{ questionId: 'db', optionIds: ['pg'] }] };
			},
		}), 'ask_question');
		assert.ok((tool.timeoutMs ?? 0) >= 60 * 60_000, 'a person gets more than the default 10 minutes');
		const result = await tool.execute({ questions: [{ id: 'db', prompt: 'Which database?', options: [{ id: 'pg', label: 'Postgres' }, { id: 'sqlite', label: 'SQLite' }] }] }, context());
		assert.strictEqual(asked?.questions[0].prompt, 'Which database?');
		assert.ok(result.text.includes('Which database? → Postgres'), result.text);
		assert.strictEqual((await tool.execute({ questions: [] }, context())).isError, true);
	});

	test('ask_question stops waiting when the run is cancelled', async () => {
		const controller = new AbortController();
		const tool = find(createMetaTools({ ...base, askQuestion: () => new Promise(() => { /* never answered */ }) }), 'ask_question');
		const pending = tool.execute({ questions: [{ id: 'q', prompt: 'Pick', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] }, context(controller.signal));
		controller.abort();
		const result = await pending;
		assert.ok(/dismissed the questions/.test(result.text), result.text);
	});
});
