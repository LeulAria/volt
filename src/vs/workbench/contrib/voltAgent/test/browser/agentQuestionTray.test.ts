/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IAgentQuestionRequest, IAgentQuestionResponse } from '../../../../services/voltRuntime/common/questions.js';
import type { IAgentPreparedAttachment } from '../../browser/composer/agentAttachmentStore.js';
import { AgentQuestionTray, IAgentQuestionTrayOptions } from '../../browser/composer/agentQuestionTray.js';

suite('Agent question tray', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const request: IAgentQuestionRequest = {
		id: 'r1',
		sessionId: 's',
		runId: 'run',
		questions: [
			{ id: 'layout', prompt: 'Which layout?', options: [{ id: 'grid', label: 'Grid' }, { id: 'list', label: 'List' }], multiple: false, allowOther: true },
			{ id: 'theme', prompt: 'Theme?', options: [{ id: 'dark', label: 'Dark' }], multiple: false, allowOther: false },
		],
	};

	interface ISubmitted { requestId: string; response: IAgentQuestionResponse; media: readonly IAgentPreparedAttachment[] }

	function createTray(overrides: Partial<IAgentQuestionTrayOptions> = {}): { tray: AgentQuestionTray; submitted: ISubmitted[] } {
		const submitted: ISubmitted[] = [];
		const tray = store.add(new AgentQuestionTray({
			onSubmit: (requestId, response, media) => submitted.push({ requestId, response, media }),
			onLayout: () => { },
			...overrides,
		}));
		mainWindow.document.body.appendChild(tray.element);
		store.add({ dispose: () => tray.element.remove() });
		tray.setRequest(request);
		return { tray, submitted };
	}

	function click(tray: AgentQuestionTray, selector: string): void {
		const element = tray.element.querySelector<HTMLElement>(selector);
		assert.ok(element, `missing ${selector}`);
		element.click();
	}

	const image: IAgentPreparedAttachment = { id: 'a1', kind: 'image', name: 'mock.png', mime: 'image/png', size: 4, path: '/att/1.png', bytes: new Uint8Array([1, 2, 3, 4]) };
	const pdf: IAgentPreparedAttachment = { id: 'a2', kind: 'file', name: 'spec.pdf', mime: 'application/pdf', size: 10, path: '/att/2.pdf' };

	test('the x button dismisses without answering', () => {
		const { tray, submitted } = createTray();
		click(tray, '.volt-question-tray-icon-btn.dismiss');
		assert.deepStrictEqual(submitted.map(item => [item.requestId, item.response]), [['r1', { outcome: 'cancelled', dismissed: true, answers: [] }]]);
	});

	test('Escape inside the tray dismisses', () => {
		const { tray, submitted } = createTray();
		const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
		tray.element.querySelector('.volt-question-option')!.dispatchEvent(event);
		assert.strictEqual(submitted[0]?.response.dismissed, true);
		assert.ok(event.defaultPrevented);
	});

	test('only questions with a custom answer offer Attach files', () => {
		const { tray } = createTray({ attachments: { pickFiles: async () => [], prepare: async () => undefined } });
		assert.ok(tray.element.querySelector('.volt-question-tray-icon-btn.attach'));
		click(tray, '.volt-question-tray-footer .volt-question-stepper .volt-question-tray-icon-btn:last-child');
		assert.strictEqual(tray.element.querySelector('.volt-question-tray-icon-btn.attach'), null);
	});

	test('a file alone answers a question; each question keeps its attachments; images ride along as media', async () => {
		let release!: () => void;
		const saved = new Promise<void>(resolve => release = resolve);
		const picked = URI.file('/Users/me/mock.png');
		const { tray, submitted } = createTray({
			attachments: {
				pickFiles: async () => [picked],
				prepare: async source => {
					await saved;
					return URI.isUri(source) ? image : pdf;
				},
			},
		});
		click(tray, '.volt-question-tray-icon-btn.attach');
		await Promise.resolve();
		await Promise.resolve();
		assert.ok(tray.element.querySelector('.volt-question-attachment.pending'), 'shows the save in progress');
		release();
		await saved;
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepStrictEqual([...tray.element.querySelectorAll('.volt-question-attachment-name')].map(el => el.textContent), ['mock.png']);
		assert.ok(!tray.element.querySelector('.volt-question-pill.primary')!.classList.contains('dimmed'), 'the file alone answers');

		// Next question and back: the attachment is still there.
		click(tray, '.volt-question-tray-footer .volt-question-stepper .volt-question-tray-icon-btn:last-child');
		assert.strictEqual(tray.element.querySelector('.volt-question-attachment'), null);
		click(tray, '.volt-question-tray-footer .volt-question-stepper .volt-question-tray-icon-btn:first-child');
		assert.ok(tray.element.querySelector('.volt-question-attachment'));

		tray.advance();
		click(tray, '.volt-question-option');
		tray.advance();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(submitted.length, 1);
		assert.deepStrictEqual(submitted[0].response, {
			outcome: 'answered',
			answers: [
				{ questionId: 'layout', optionIds: [], attachments: [{ kind: 'image', name: 'mock.png', mime: 'image/png', size: 4, path: '/att/1.png' }] },
				{ questionId: 'theme', optionIds: ['dark'] },
			],
		});
		assert.deepStrictEqual(submitted[0].media.map(item => item.name), ['mock.png']);
	});

	test('Continue waits for attachments still being saved', async () => {
		let release!: () => void;
		const saved = new Promise<void>(resolve => release = resolve);
		const { tray, submitted } = createTray({
			attachments: { pickFiles: async () => [URI.file('/x/spec.pdf')], prepare: async () => { await saved; return pdf; } },
		});
		click(tray, '.volt-question-option');
		click(tray, '.volt-question-tray-icon-btn.attach');
		await new Promise(resolve => setTimeout(resolve, 0));
		// Last question answered while the PDF is still saving.
		click(tray, '.volt-question-tray-footer .volt-question-stepper .volt-question-tray-icon-btn:last-child');
		click(tray, '.volt-question-option');
		tray.advance();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(submitted.length, 0);
		release();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(submitted.length, 1);
		assert.deepStrictEqual(submitted[0].response.answers[0].attachments?.map(file => file.name), ['spec.pdf']);
		assert.deepStrictEqual(submitted[0].media, []);
	});
});
