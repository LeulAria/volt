/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MarkdownRenderer } from '../../../../../editor/browser/widget/markdownRenderer/browser/markdownRenderer.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IBlockRenderContext, LiveMarkdown } from '../../browser/blocks/agentBlockRenderers.js';
import { FRESH_TEXT_CLASS } from '../../browser/chrome/agentFreshText.js';

/** Replies as a model streams them: prose, lists, quotes and headings, with the markup a paragraph can hold. */
const REPLIES = [
	'The fix is in `src/paginate.ts`: the loop read one page too many. I changed the bound and added a test, so the last page is no longer fetched twice.\n\nThis also covers empty results, where the old code returned undefined instead of an empty list.',
	'## What changed\n\n- The cursor is now **opaque**, so callers cannot build one by hand\n- Page size defaults to 50, the max is 200\n- 1. is not a list here\n\nThat is all for the API side.',
	'Steps:\n\n1. Install the deps\n2. Run the tests with `npm test`\n3. Open https://example.com/docs or www.example.com and mail me at dev@example.com\n\n> Note: the old flag still works, but it logs a warning\n> on every call.\n\nDone -- see AT&T and 5 > 3 and a \\* star.',
	'A table:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nThen prose again, with a footnote[^1] and an emoji :) and a dash-separated list of words.\n\n[^1]: The note text.',
	'- a\n- b\n  - nested item text goes on\n  - and on\n\n- loose item\n\n- another loose item with more words\n\n--\n\nmore text after two dashes',
	'Open src/paginate.ts and lib/util/index.ts, see ftp://files.example.com/a and http: //spaced, www.example.org/x, a ratio 3:4, notes: done! Then https://example.com/path?q=1 again.\n\nNote: the end.',
	'Mixed *emphasis* and _underscores_ and snake_case_words and 2*3*4, then ~~struck~~ text, a [link](https://x.y) and `code` in a long line that keeps going for a while.',
];

function renderContext(store: DisposableStore): IBlockRenderContext {
	const markdownRenderer = new MarkdownRenderer({}, {} as ILanguageService, { open: async () => true } as unknown as IOpenerService);
	return { markdownRenderer, store, blockState: {}, onScroll: () => { } } as unknown as IBlockRenderContext;
}

/** The element's markup with fade spans unwrapped and adjacent text merged. */
function markup(element: HTMLElement): string {
	const copy = element.cloneNode(true) as HTMLElement;
	for (const span of [...copy.querySelectorAll(`.${FRESH_TEXT_CLASS}`)]) {
		span.replaceWith(...span.childNodes);
	}
	copy.normalize();
	return copy.innerHTML;
}

suite('Agent live markdown', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let store: DisposableStore;
	setup(() => store = disposables.add(new DisposableStore()));

	test('a reply streamed in chunks draws the same markup as each step drawn whole', () => {
		let seed = 11;
		const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
		for (const reply of REPLIES) {
			for (let pass = 0; pass < 4; pass++) {
				const live = store.add(new LiveMarkdown(renderContext(store)));
				let at = 0;
				while (at < reply.length) {
					at = Math.min(reply.length, at + 1 + Math.floor(random() * (pass === 0 ? 3 : 12)));
					const text = reply.slice(0, at);
					live.update(text, renderContext(store));
					const whole = store.add(new LiveMarkdown(renderContext(store)));
					whole.update(text, renderContext(store));
					assert.strictEqual(markup(live.element), markup(whole.element), `after ${JSON.stringify(text.slice(-30))}`);
					assert.strictEqual(live.parts().map(part => part.text).join(''), whole.parts().map(part => part.text).join(''));
				}
			}
		}
	});

	test('plain words added to the open paragraph keep its element; markup redraws it', () => {
		const ctx = renderContext(store);
		const live = store.add(new LiveMarkdown(ctx));
		live.update('The loop read one page', ctx);
		const paragraph = live.element.querySelector('p');
		live.update('The loop read one page too many, so', ctx);
		assert.strictEqual(live.element.querySelector('p'), paragraph, 'grew in place');
		assert.strictEqual(paragraph?.textContent, 'The loop read one page too many, so');
		assert.ok(live.parts().at(-1)?.roots?.includes(paragraph!), 'the grown block is fresh, for the fade');
		live.update('The loop read one page too many, so **the', ctx);
		assert.notStrictEqual(live.element.querySelector('p'), paragraph, 'emphasis goes through the renderer');
	});
});
