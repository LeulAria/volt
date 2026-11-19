/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event as BaseEvent } from '../../../../../base/common/event.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IAgentOrchestratorService } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { canonicalHttpDocs, HttpDocsEditor, httpDocsPrompt, writeHttpDocs } from '../../browser/voltHttpDocsEditor.js';
import { readHttpDocsBlocks, renderHttpDocsBlocks } from '../../browser/voltHttpDocsDom.js';
import { parseHttpMarkdown, serializeHttpMarkdown } from '../../common/httpMarkdown.js';

const DOC = [
	'Creates an order for the signed-in customer.',
	'',
	'### Parameters',
	'',
	'| Name | In | Required |',
	'| --- | :---: | --- |',
	'| `id` | path | yes |',
	'| expand | query | no |',
	'',
	'- **Bold** and *italic* and ~~gone~~',
	'  - nested [link](https://example.com)',
	'- second',
	'',
	'1. one',
	'2. two',
	'',
	'> A quote',
	'',
	'```json',
	'{ "ok": true }',
	'```',
	'',
	'---',
	'',
	'![diagram](https://example.com/a.png)',
].join('\n');

function el(tag: string, ...children: (Node | string)[]): HTMLElement {
	const element = mainWindow.document.createElement(tag);
	for (const child of children) {
		element.append(child);
	}
	return element;
}

/** A model that streams its answer in pieces; an agent that answers in one. */
function fakeRuntime(kind: 'model' | 'agent', answer: string[] | undefined): IAgentRuntimeService {
	const item = { ref: 'm', kind, label: 'Fake', enabled: true };
	return {
		resolveCatalogItem: () => item,
		getActiveCatalogRef: () => 'm',
		listCatalog: () => [item],
		getModelOptions: () => undefined,
		generateText: async () => answer?.join(''),
		streamModel: async function* () {
			for (const delta of answer ?? []) {
				yield { type: 'text.delta', delta };
			}
			if (!answer) {
				yield { type: 'error', message: 'quota' };
			}
		},
	} as unknown as IAgentRuntimeService;
}

suite('Volt HTTP client: Docs editor', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let instantiationService: TestInstantiationService;
	let host: HTMLElement;

	setup(() => {
		instantiationService = workbenchInstantiationService(undefined, disposables);
		// No chat is in front, so the model is the runtime's own.
		instantiationService.stub(IAgentOrchestratorService, { getThread: () => undefined, onDidChange: BaseEvent.None } as unknown as IAgentOrchestratorService);
		instantiationService.stub(IAgentRuntimeService, fakeRuntime('model', ['Lists ', 'the **orders**.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |']));
		host = mainWindow.document.body.appendChild(el('div'));
		host.style.height = '400px';
	});

	teardown(() => {
		host.remove();
	});

	function create(value: string, changes: string[], aiContext?: () => string | undefined): HttpDocsEditor {
		return disposables.add(instantiationService.createInstance(HttpDocsEditor, host, { value, onChange: markdown => changes.push(markdown), aiContext }));
	}

	function surface(): HTMLElement {
		return host.querySelector<HTMLElement>('.volt-http-docs-surface')!;
	}

	/** Keys typed as a user types them: the text changes, then an input event (not one inside an execCommand). */
	function type(text: string): void {
		const doc = mainWindow.document;
		const selection = mainWindow.getSelection()!;
		for (const char of text) {
			let node = selection.anchorNode!;
			let offset = selection.anchorOffset;
			if (node.nodeType !== Node.TEXT_NODE) {
				const textNode = doc.createTextNode('');
				const at = node.childNodes[offset] ?? null;
				if (at?.nodeName === 'BR') {
					node.replaceChild(textNode, at);
				} else {
					node.insertBefore(textNode, at);
				}
				node = textNode;
				offset = 0;
			}
			(node as Text).insertData(offset, char);
			selection.collapse(node, offset + 1);
			surface().dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: char, bubbles: true }));
		}
	}

	test('the drawn document reads back as the same Markdown', () => {
		const canonical = canonicalHttpDocs(DOC);
		const page = el('div');
		renderHttpDocsBlocks(page, parseHttpMarkdown(DOC));
		assert.strictEqual(serializeHttpMarkdown(readHttpDocsBlocks(page)), canonical);
		assert.strictEqual(page.querySelector('th:nth-child(2)')?.getAttribute('data-align'), 'center');
		assert.strictEqual(page.querySelector('pre')?.dataset.language, 'json');
		assert.strictEqual(page.querySelector('a')?.getAttribute('href'), null, 'a link never navigates the window');
	});

	test('what Chromium leaves while typing is read as Markdown', () => {
		const page = el('div',
			'loose ',
			el('div', 'plain ', el('b', 'bold'), ' ', el('i', 'it'), ' ', el('strike', 'old')),
			el('div', el('br')),
			el('div', 'a', el('br'), 'b'),
			el('ul', el('li', 'x'), el('ul', el('li', 'y'))),
			el('p', el('br')),
		);
		const span = el('span', 'heavy');
		span.style.fontWeight = '700';
		page.querySelector('div')!.append(' ', span);
		assert.strictEqual(serializeHttpMarkdown(readHttpDocsBlocks(page)), 'loose\n\nplain **bold** *it* ~~old~~ **heavy**\n\na\\\nb\n\n- x\n  - y');
	});

	test('the editor draws its value and writes edits out as Markdown, and only edits', () => {
		const changes: string[] = [];
		const editor = create('# Title\n\nSome *text*', changes);
		editor.layout(800, 400);
		assert.strictEqual(surface().querySelector('h1')?.textContent, 'Title');
		assert.strictEqual(editor.getValue(), '# Title\n\nSome *text*', 'reading without an edit changes nothing');
		assert.deepStrictEqual(changes, []);

		const paragraph = surface().querySelector('p')!;
		paragraph.append(' more');
		surface().dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'e' }));
		assert.strictEqual(editor.getValue(), '# Title\n\nSome *text* more');
		assert.deepStrictEqual(changes, ['# Title\n\nSome *text* more']);

		editor.setValue('Other');
		assert.strictEqual(surface().textContent, 'Other');
		assert.strictEqual(changes.length, 1, 'setValue does not call onChange');
	});

	test('an empty document shows the placeholder and the Write with AI link; content shows the toolbar button', () => {
		create('', [], () => 'GET https://example.com');
		const empty = host.querySelector('.volt-http-docs-empty')!;
		assert.ok(!empty.classList.contains('hidden'));
		assert.strictEqual(empty.querySelector('.volt-http-docs-placeholder')?.textContent, 'Document this request');
		assert.ok(empty.querySelector('.volt-http-docs-empty-ai'));
		assert.ok(host.querySelector('.volt-http-docs-ai')?.classList.contains('hidden'));
		host.replaceChildren();

		create('Text', [], () => 'GET https://example.com');
		assert.ok(host.querySelector('.volt-http-docs-empty')!.classList.contains('hidden'));
		assert.ok(!host.querySelector('.volt-http-docs-ai')?.classList.contains('hidden'));
		host.replaceChildren();

		create('', []);
		assert.strictEqual(host.querySelector('.volt-http-docs-empty-ai'), null, 'no AI link without a request to describe');
		assert.strictEqual(host.querySelector('.volt-http-docs-ai'), null);
	});

	test('the toolbar shows the caret\'s marks and block style', () => {
		create('# Head\n\n**bold** and `code`\n\n- item', []);
		const selection = mainWindow.getSelection()!;
		const strong = surface().querySelector('strong')!;
		surface().focus();
		selection.collapse(strong.firstChild, 2);
		mainWindow.document.dispatchEvent(new Event('selectionchange'));
		const pressed = () => [...host.querySelectorAll<HTMLElement>('.volt-http-docs-button.checked')].map(button => button.getAttribute('aria-label'));
		assert.deepStrictEqual(pressed(), [`Bold (${isMacintosh ? 'Cmd' : 'Ctrl'}+B)`]);
		selection.collapse(surface().querySelector('h1')!.firstChild, 1);
		mainWindow.document.dispatchEvent(new Event('selectionchange'));
		assert.strictEqual(host.querySelector('.volt-http-docs-style .volt-dropdown-label')?.textContent, 'Heading 1');
		selection.collapse(surface().querySelector('li')!.firstChild, 1);
		mainWindow.document.dispatchEvent(new Event('selectionchange'));
		assert.deepStrictEqual(pressed(), ['Bulleted list']);
	});

	test('typing Markdown at the start of a line and the toolbar edit the text as Markdown', () => {
		const editor = create('', []);
		const doc = mainWindow.document;
		const selection = mainWindow.getSelection()!;
		surface().focus();
		selection.collapse(surface().querySelector('p')!, 0);
		type('## Orders');
		assert.strictEqual(editor.getValue(), '## Orders');
		surface().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		doc.execCommand('insertParagraph');
		type('- first');
		assert.strictEqual(editor.getValue(), '## Orders\n\n- first');
		host.querySelector<HTMLElement>('[aria-label="Bulleted list"]')!.click();
		assert.strictEqual(editor.getValue(), '## Orders\n\nfirst');
		const word = surface().querySelectorAll('p')[0] ?? surface().lastElementChild!;
		const range = doc.createRange();
		range.selectNodeContents(word);
		selection.removeAllRanges();
		selection.addRange(range);
		host.querySelector<HTMLElement>(`[aria-label="Bold (${isMacintosh ? 'Cmd' : 'Ctrl'}+B)"]`)!.click();
		assert.strictEqual(editor.getValue(), '## Orders\n\n**first**');
		host.querySelector<HTMLElement>('[aria-label="Table"]')!.click();
		assert.strictEqual(editor.getValue(), '## Orders\n\n**first**\n\n|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |');
		type('Name');
		surface().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
		type('Type');
		assert.ok(editor.getValue().includes('| Name | Type |  |'));
	});

	test('a code block takes Enter as a line end and leaves on an empty last line', () => {
		const editor = create('', []);
		const selection = mainWindow.getSelection()!;
		surface().focus();
		selection.collapse(surface().querySelector('p')!, 0);
		type('```sh');
		const enter = () => surface().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		enter();
		assert.strictEqual(surface().querySelector('pre')?.dataset.language, 'sh');
		type('ls');
		enter();
		type('pwd');
		enter();
		enter();
		type('after');
		assert.strictEqual(editor.getValue(), '```sh\nls\npwd\n```\n\nafter');
	});

	test('the mode is remembered and switching keeps the content', () => {
		const changes: string[] = [];
		const editor = create('Some **bold**', changes);
		editor.layout(800, 400);
		editor.setMode('markdown');
		assert.strictEqual(instantiationService.get(IStorageService).get('volt.http.docsEditorMode', StorageScope.PROFILE), 'markdown');
		assert.ok(host.querySelector('.volt-http-docs-editor')!.classList.contains('markdown'));
		assert.strictEqual(editor.getValue(), 'Some **bold**');
		editor.setMode('rich');
		assert.strictEqual(surface().querySelector('strong')?.textContent, 'bold');
		assert.deepStrictEqual(changes, []);
		instantiationService.get(IStorageService).store('volt.http.docsEditorMode', 'markdown', StorageScope.PROFILE, StorageTarget.USER);
		host.replaceChildren();
		assert.strictEqual(create('x', []).getMode(), 'markdown');
		instantiationService.get(IStorageService).remove('volt.http.docsEditorMode', StorageScope.PROFILE);
	});

	test('Write with AI streams the documentation in and saves it', async () => {
		const changes: string[] = [];
		const saved = new Promise<void>(resolve => {
			const editor = disposables.add(instantiationService.createInstance(HttpDocsEditor, host, {
				value: '',
				onChange: markdown => {
					changes.push(markdown);
					resolve();
				},
				aiContext: () => 'GET https://shop.test/orders',
			}));
			editor.layout(800, 400);
		});
		host.querySelector<HTMLElement>('.volt-http-docs-empty-ai')!.click();
		await saved;
		assert.deepStrictEqual(changes, ['Lists the **orders**.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |']);
		assert.strictEqual(surface().querySelector('td')?.textContent, '1');
		assert.strictEqual(surface().contentEditable, 'true');
	});

	test('the model call: streamed text, an agent\'s one answer, failures', async () => {
		const partials: string[] = [];
		const streamed = await writeHttpDocs(fakeRuntime('model', ['```markdown\nHi', ' there\n```']), 'm', 'p', CancellationToken.None, partial => partials.push(partial));
		assert.deepStrictEqual(streamed, { markdown: 'Hi there' });
		assert.deepStrictEqual(partials, ['Hi', 'Hi there']);
		assert.deepStrictEqual(await writeHttpDocs(fakeRuntime('agent', ['Doc']), 'm', 'p', CancellationToken.None), { markdown: 'Doc' });
		assert.strictEqual((await writeHttpDocs(fakeRuntime('model', undefined), 'm', 'p', CancellationToken.None)).failure, 'quota');
		assert.ok((await writeHttpDocs(fakeRuntime('agent', undefined), 'm', 'p', CancellationToken.None)).failure?.includes('did not answer'));
		assert.ok((await writeHttpDocs(fakeRuntime('model', ['  ']), 'm', 'p', CancellationToken.None)).failure);
		assert.ok(httpDocsPrompt('GET https://x.test').endsWith('The request:\nGET https://x.test'));
	});
});
