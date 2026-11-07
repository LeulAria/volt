/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildSnippet, IChatSnippet } from '../../common/agentChatSearch.js';

function marked(snippet: IChatSnippet | undefined): string[] {
	return snippet ? snippet.highlights.map(match => snippet.text.slice(match.start, match.end)) : [];
}

suite('buildSnippet', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('marks only the matching part of a camelCase word', () => {
		const snippet = buildSnippet([{ role: 'agent', text: 'Edited voltAgent and voltCodeIntelligence, then volt itself.' }], new Set(['volt']), 'volt');
		assert.deepStrictEqual(marked(snippet), ['volt', 'volt', 'volt']);
	});

	test('a whole-word match still marks the whole word', () => {
		const snippet = buildSnippet([{ role: 'user', text: 'Please rename agentHomePane to something shorter.' }], new Set(['agenthomepane']), 'agenthomepane');
		assert.deepStrictEqual(marked(snippet), ['agentHomePane']);
	});

	test('a cut-in snippet does not open on table or quote markup', () => {
		const text = `${'x'.repeat(200)} | > the sidebar toggle moved`;
		const snippet = buildSnippet([{ role: 'agent', text }], new Set(['sidebar']), 'sidebar');
		assert.ok(snippet);
		assert.ok(snippet.text.startsWith('…'), snippet.text);
		assert.ok(!/^…[\s|>]/.test(snippet.text), snippet.text);
		assert.deepStrictEqual(marked(snippet), ['sidebar']);
	});
});
