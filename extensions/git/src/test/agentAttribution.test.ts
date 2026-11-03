/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { detectCodingAgents } from '../agentAttribution';

suite('agentAttribution', () => {
	function ids(message: string): string[] {
		return detectCodingAgents(message).map(agent => agent.id);
	}

	test('no trailers', () => {
		assert.deepStrictEqual(detectCodingAgents(''), []);
		assert.deepStrictEqual(detectCodingAgents('fix: claude said so\n\nWritten with Cursor'), []);
	});

	test('claude', () => {
		const agents = detectCodingAgents('feat: x\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>');
		assert.deepStrictEqual(agents, [{ id: 'claude', name: 'Claude', email: 'noreply@anthropic.com' }]);
	});

	test('people who share an agent name stay people', () => {
		assert.deepStrictEqual(ids('x\n\nCo-authored-by: Claude Monet <claude@monet.fr>'), []);
		assert.deepStrictEqual(ids('x\n\nCo-authored-by: Devin Smith <devin@example.com>'), []);
		assert.deepStrictEqual(ids('x\n\nCo-authored-by: Jules Verne <jules@example.com>'), []);
	});

	test('trailer is case-insensitive and the email is optional', () => {
		assert.deepStrictEqual(ids('x\n\nco-authored-by: claude'), ['claude']);
		assert.deepStrictEqual(ids('x\n\nCO-AUTHORED-BY:Someone <bot@anthropic.com>'), ['claude']);
	});

	test('cursor', () => {
		assert.deepStrictEqual(ids('x\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>'), ['cursor']);
		assert.deepStrictEqual(ids('x\n\nCo-authored-by: Cursor <noreply@example.com>'), ['cursor']);
	});

	test('codex, copilot, gemini', () => {
		assert.deepStrictEqual(ids('x\n\nCo-authored-by: Codex <codex@openai.com>'), ['codex']);
		assert.deepStrictEqual(ids('x\n\nCo-authored-by: ChatGPT <bot@openai.com>'), ['codex']);
		assert.deepStrictEqual(ids('x\n\nCo-authored-by: Copilot <198982749+Copilot@users.noreply.github.com>'), ['copilot']);
		assert.deepStrictEqual(ids('x\n\nCo-authored-by: someone <175728472+Copilot@users.noreply.github.com>'), ['copilot']);
		assert.deepStrictEqual(ids('x\n\nCo-authored-by: Gemini Code Assist <gemini-code-assist@google.com>'), ['gemini']);
	});

	test('other agents', () => {
		assert.deepStrictEqual(ids('x\n\nCo-authored-by: devin-ai-integration[bot] <158243242+devin-ai-integration[bot]@users.noreply.github.com>'), ['devin']);
		assert.deepStrictEqual(ids('x\n\nCo-authored-by: aider (gpt-4o) <noreply@aider.chat>'), ['aider']);
		assert.deepStrictEqual(ids('x\n\nCo-authored-by: Someone <grok@x.ai>'), ['grok']);
		assert.deepStrictEqual(ids('x\n\nCo-authored-by: opencode <noreply@opencode.ai>'), ['opencode']);
		assert.deepStrictEqual(ids('x\n\nCo-authored-by: Amp <amp@ampcode.com>'), ['amp']);
		assert.deepStrictEqual(ids('x\n\nCo-authored-by: google-labs-jules[bot] <161369871+google-labs-jules[bot]@users.noreply.github.com>'), ['jules']);
		assert.deepStrictEqual(ids('x\n\nCo-authored-by: Windsurf Cascade <cascade@windsurf.com>'), ['windsurf']);
		assert.deepStrictEqual(ids('x\n\nCo-authored-by: Volt <volt@volt.dev>'), ['volt']);
	});

	test('humans are not agents', () => {
		assert.deepStrictEqual(ids('x\n\nCo-authored-by: Jane Doe <jane@example.com>'), []);
		assert.deepStrictEqual(ids('x\n\nCo-authored-by: Ampersand Smith <amp@example.com>'), []);
		assert.deepStrictEqual(ids('x\n\nCo-authored-by: Voltaire <v@example.com>'), []);
		assert.deepStrictEqual(ids('x\n\nCo-authored-by: Jane <jane@google.com>'), []);
	});

	test('deduplicated, in trailer order', () => {
		const message = [
			'feat: x',
			'',
			'Co-authored-by: Cursor Agent <cursoragent@cursor.com>',
			'Co-authored-by: Jane Doe <jane@example.com>',
			'Co-authored-by: Claude <noreply@anthropic.com>',
			'Co-authored-by: Claude Sonnet <noreply@anthropic.com>',
		].join('\r\n');

		assert.deepStrictEqual(ids(message), ['cursor', 'claude']);
	});

	test('only trailers at the start of a line count', () => {
		assert.deepStrictEqual(ids('x\n\nSee Co-authored-by: Claude <noreply@anthropic.com> in the docs'), []);
	});
});
