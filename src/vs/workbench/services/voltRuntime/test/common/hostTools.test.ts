/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ASK_QUESTION_TOOL_NAME, BROWSER_COMPARE_IMAGE_TOOL_NAME, BROWSER_NETWORK_TOOL_NAME, BROWSER_SCREENSHOT_TOOL_NAME, browserToolVerdict, IMAGE_INSPECT_TOOL_NAME, isBrowserAutomationTool, isBrowserToolName, isLocalBrowserUrl, isVoltHostTool, voltHostToolName, VOLT_HOST_TOOLS } from '../../common/hostTools.js';

suite('Volt host tools', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('exposes the browser screenshot and question tools', () => {
		for (const name of [BROWSER_SCREENSHOT_TOOL_NAME, ASK_QUESTION_TOOL_NAME, 'browser_click']) {
			const tool = VOLT_HOST_TOOLS.find(item => item.name === name);
			assert.ok(tool, name);
			assert.ok(tool.description.length > 0);
		}
		assert.strictEqual(isVoltHostTool('Read'), false);
		assert.strictEqual(isBrowserToolName('browser_click'), true);
		assert.strictEqual(isBrowserToolName(ASK_QUESTION_TOOL_NAME), false);
	});

	test('recognizes each agent\'s name for a host tool', () => {
		assert.strictEqual(voltHostToolName('browser_click'), 'browser_click');
		assert.strictEqual(voltHostToolName('mcp__volt__browser_navigate'), 'browser_navigate');
		assert.strictEqual(voltHostToolName('MCP: tool', 'volt: browser_click'), 'browser_click');
		assert.strictEqual(voltHostToolName('volt-ask_question: ask_question'), 'ask_question');
		assert.strictEqual(voltHostToolName('MCP: tool'), undefined);
		assert.strictEqual(voltHostToolName('Read File', 'Read foo.ts'), undefined);
		assert.strictEqual(voltHostToolName('mcp__volt__browser_compare_image'), BROWSER_COMPARE_IMAGE_TOOL_NAME);
		assert.strictEqual(voltHostToolName('volt: image_inspect'), IMAGE_INSPECT_TOOL_NAME);
	});

	test('design tools are host tools; every tool has a group', () => {
		for (const name of [BROWSER_COMPARE_IMAGE_TOOL_NAME, BROWSER_NETWORK_TOOL_NAME, IMAGE_INSPECT_TOOL_NAME]) {
			assert.ok(VOLT_HOST_TOOLS.some(tool => tool.name === name), name);
		}
		assert.ok(VOLT_HOST_TOOLS.every(tool => tool.group), 'groups');
		assert.strictEqual(new Set(VOLT_HOST_TOOLS.map(tool => tool.name)).size, VOLT_HOST_TOOLS.length, 'unique names');
		assert.strictEqual(isBrowserAutomationTool(BROWSER_COMPARE_IMAGE_TOOL_NAME), true);
		assert.strictEqual(isBrowserAutomationTool('browser_click'), true);
		assert.strictEqual(isBrowserAutomationTool(IMAGE_INSPECT_TOOL_NAME), false);
		// The original list keeps its own type guard (the activity trail switches over it).
		assert.strictEqual(isBrowserToolName(BROWSER_COMPARE_IMAGE_TOOL_NAME), false);
	});

	test('local pages: loopback and local documents only', () => {
		for (const url of ['http://localhost:3000', 'localhost:5173/x', '127.0.0.1:8765', 'https://app.localhost/', 'http://[::1]:8080/', 'http://0.0.0.0:3000', 'file:///tmp/index.html', 'about:blank']) {
			assert.strictEqual(isLocalBrowserUrl(url), true, url);
		}
		for (const url of ['https://github.com', 'example.com', 'http://192.168.1.10:3000', 'http://10.0.0.2', 'http://localhost.evil.com', 'javascript:alert(1)', '', undefined]) {
			assert.strictEqual(isLocalBrowserUrl(url), false, String(url));
		}
	});

	test('mode gate: Ask and Plan need approval to run script, open other sites, or act on non-local pages', () => {
		const kind = (name: string, args: Record<string, unknown>, mode: 'agent' | 'ask' | 'plan' | undefined, page?: string) => browserToolVerdict(name, args, mode, page).kind;
		for (const mode of ['ask', 'plan'] as const) {
			assert.strictEqual(kind('browser_evaluate', { expression: '1' }, mode), 'ask');
			assert.strictEqual(kind('browser_navigate', { url: 'https://github.com' }, mode), 'ask');
			assert.strictEqual(kind('browser_navigate', { url: 'http://localhost:3000' }, mode), 'allow');
			assert.strictEqual(kind(BROWSER_COMPARE_IMAGE_TOOL_NAME, { reference_path: 'a.png' }, mode), 'allow');
			assert.strictEqual(kind(BROWSER_COMPARE_IMAGE_TOOL_NAME, { reference_path: 'a.png', url: 'https://x.com' }, mode), 'ask');
			assert.strictEqual(kind('browser_click', { ref: 'e1' }, mode, 'http://localhost:3000/'), 'allow');
			assert.strictEqual(kind('browser_type', { ref: 'e1', text: 'x' }, mode, 'https://mail.example.com/'), 'ask');
			assert.strictEqual(kind('browser_press_key', { key: 'Enter' }, mode, 'https://mail.example.com/'), 'ask');
			assert.strictEqual(kind('browser_snapshot', {}, mode, 'https://mail.example.com/'), 'allow');
			assert.strictEqual(kind(BROWSER_SCREENSHOT_TOOL_NAME, {}, mode, 'https://mail.example.com/'), 'allow');
		}
		assert.strictEqual(kind('browser_evaluate', { expression: '1' }, 'agent'), 'allow');
		assert.strictEqual(kind('browser_navigate', { url: 'https://github.com' }, undefined), 'allow');
		const verdict = browserToolVerdict('browser_navigate', { url: 'https://github.com/x' }, 'ask');
		assert.ok(verdict.kind === 'ask' && verdict.reason.includes('github.com'));
	});
});
