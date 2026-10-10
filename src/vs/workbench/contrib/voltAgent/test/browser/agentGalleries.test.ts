/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MOCKUPS_TOOL_NAME, SCREENS_TOOL_NAME, voltHostToolName } from '../../../../services/voltRuntime/common/hostTools.js';
import { describeHostToolActivity } from '../../browser/blocks/agentHostToolActivity.js';
import { parseMockupsArgs } from '../../browser/visuals/agentGalleryTools.js';
import { buildMockupsPage, buildScreensPage, IMockupsPageData, IMockupStrings, IScreensPageData, IScreensStrings, mockupDocument } from '../../browser/visuals/galleryPages.js';
import { absolutePageUrl } from '../../browser/visuals/headlessActDriver.js';
import { formatScreensReport, IScreensPlan, MAX_SHOTS, parseScreensArgs, pickNavLinks, resolveScreenUrl, shotFileName, shotVariants } from '../../browser/visuals/screensPlan.js';

const MOCKUP_STRINGS: IMockupStrings = {
	light: 'Light', dark: 'Dark', both: 'Both', open: 'Open', openOption: 'Open option {0}: {1}', choose: 'Choose', chooseOption: 'Choose {0}', chosen: 'Chosen', refine: 'Refine',
	select: 'Select', recommended: 'Recommended', allOptions: 'All options', previous: 'Previous', next: 'Next', fullscreen: 'Full screen', notesPlaceholder: 'Notes',
	selectedCount: '{0} selected', combineCount: 'Combine {0}', clear: 'Clear', chooseMessage: 'I choose option {0} "{1}" from "{2}".',
	combineMessage: 'Combine options {0} from "{1}" into one design.', refinePrompt: 'Refine option {0} "{1}" from "{2}": ', selectedContext: 'Mockups selected in "{0}": {1}',
};

const SCREEN_STRINGS: IScreensStrings = {
	all: 'All', smaller: 'Smaller', larger: 'Larger', allScreens: 'All screens', previous: 'Previous screen', next: 'Next screen', sideBySide: 'Side by side', fullscreen: 'Full screen',
	ask: 'Ask about this', askPrompt: 'About the "{0}" screen ({1}): ', openFile: 'Open image file', notCaptured: 'Not captured', lookingAt: 'Looking at screen {0} "{1}" ({2}): {3}',
};

/** A 2×2 PNG, so the screens page has real images to lay out. */
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8Dwn4GBgYGJgYGBAQAh7AQBKhG5uQAAAABJRU5ErkJggg==';

interface IGalleryWindow {
	readonly __sent: string[];
	readonly __prompts: string[];
}

/** Loads a gallery page in a frame, with a `window.volt` that records what the page asks of the chat. */
async function load(html: string): Promise<{ readonly frame: HTMLIFrameElement; readonly doc: Document; readonly win: IGalleryWindow }> {
	const stub = '<script>window.__sent=[];window.__prompts=[];window.volt={theme:"dark",send:function(t){window.__sent.push(t)},prompt:function(t){window.__prompts.push(t)},setContext:function(){},fullscreen:function(){},open:function(){}};</script>';
	const frame = mainWindow.document.createElement('iframe');
	frame.style.width = '728px';
	frame.style.height = '900px';
	mainWindow.document.body.appendChild(frame);
	const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
	frame.srcdoc = html.replace('<head>', `<head>${stub}`);
	await loaded;
	return { frame, doc: frame.contentDocument!, win: frame.contentWindow as unknown as IGalleryWindow };
}

suite('Agent galleries', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('mockups_render', () => {

		test('options get letters, the frames and look they asked for, and the recommendation by label', () => {
			const parsed = parseMockupsArgs({
				title: 'Sidebar alternatives',
				frame: 'desktop+phone',
				options: [{ label: 'Icon rail', html: '<aside>A</aside>', note: 'Slim' }, { label: 'Floating panel', html: '<aside>B</aside>' }],
				recommended: 'floating panel',
				theme: 'light',
			});
			assert.ok(!('error' in parsed));
			if ('error' in parsed) {
				return;
			}
			assert.deepStrictEqual(parsed.options.map(option => `${option.id} ${option.label}`), ['A Icon rail', 'B Floating panel']);
			assert.deepStrictEqual(parsed.viewports, [{ kind: 'desktop', width: 1280, height: 800 }, { kind: 'phone', width: 390, height: 844 }]);
			assert.strictEqual(parsed.recommended, 'B');
			assert.strictEqual(parsed.theme, 'light');
			const custom = parseMockupsArgs({ title: 'Card', width: 360, height: 0, options: [{ label: 'One', html: '<div></div>' }] });
			assert.ok(!('error' in custom) && custom.viewports[0].kind === 'component' && custom.viewports[0].width === 360 && custom.viewports[0].height === 0);
			const defaults = parseMockupsArgs({ title: 'x', options: JSON.stringify([{ label: 'One', html: '<p>1</p>' }]) });
			assert.ok(!('error' in defaults) && defaults.viewports[0].kind === 'desktop' && defaults.theme === 'both');
		});

		test('says what to fix', () => {
			const error = (args: Record<string, unknown>) => {
				const parsed = parseMockupsArgs(args);
				return 'error' in parsed ? parsed.error : '';
			};
			assert.match(error({ title: 'x' }), /Pass "options"/);
			assert.match(error({ title: 'x', options: [{ label: 'One' }] }), /Option A needs "html"/);
			assert.match(error({ title: 'x', frame: 'watch', options: [{ label: 'One', html: '<p/>' }] }), /Unknown frame "watch"/);
			assert.match(error({ title: 'x', options: Array.from({ length: 9 }, (_, i) => ({ label: `O${i}`, html: '<p/>' })) }), /up to 8/);
			assert.match(error({ title: 'x', width: 50, options: [{ label: 'One', html: '<p/>' }] }), /width/);
		});

		test('an option document carries its look: class, media queries and matchMedia answer for it', () => {
			const shared = { css: '.card{color:#000}@media (prefers-color-scheme: dark){.card{color:#fff}}', template: '<main>{{option}}</main>', head: '<script src="https://cdn.tailwindcss.com"></script>' };
			const option = { id: 'B', label: 'Dark first', html: '<div class="card">B</div>' };
			const dark = mockupDocument(shared, option, 'dark');
			assert.ok(dark.includes('<html class="dark" data-theme="dark">'));
			assert.ok(dark.includes('@media (min-width: 0px)'), 'the dark query always applies in the dark look');
			assert.ok(dark.includes('<main><div class="card">B</div></main>'), 'the option goes into the template');
			assert.ok(dark.includes('darkMode:"class"'), 'Tailwind dark: follows the class');
			assert.ok(dark.includes('[option B]'), 'errors are tagged with the option');
			assert.ok(dark.indexOf('cdn.tailwindcss.com') < dark.indexOf('darkMode'), 'the Tailwind config comes after its script');
			const light = mockupDocument(shared, option, 'light');
			assert.ok(light.includes('<html class="light" data-theme="light">'));
			assert.ok(light.includes('@media (max-width: 0.001px)'), 'the dark query never applies in the light look');
			// No template: the option is the body.
			assert.ok(mockupDocument({}, option, 'light').includes('<body><div class="card">B</div></body>'));
		});

		test('a whole document is themed where it stands', () => {
			const page = mockupDocument({ css: 'p{margin:0}' }, { id: 'C', label: 'Doc', html: '<!doctype html><html lang="en" class="app"><head><title>x</title></head><body><p>hi</p></body></html>' }, 'dark');
			assert.ok(page.includes('<html lang="en" class="app dark" data-theme="dark">'));
			assert.ok(/<head><script>[\s\S]*\[option C\][\s\S]*<title>x<\/title><style>p\{margin:0\}<\/style>/.test(page));
			const bare = mockupDocument({}, { id: 'D', label: 'Bare', html: '<!doctype html><body><p>hi</p></body>' }, 'light');
			assert.ok(bare.includes('<head><script>'), 'a document without head still gets the shim');
		});

		test('the page renders a card per option, keeps its data intact, and sends the choice', async () => {
			const parsed = parseMockupsArgs({ title: 'Empty states', options: [{ label: 'Calm', html: '<p>Nothing here</p>' }, { label: 'Playful', html: '<p>All clear</p></script><b>x</b>' }] });
			assert.ok(!('error' in parsed));
			if ('error' in parsed) {
				return;
			}
			const data: IMockupsPageData = { ...parsed, viewports: parsed.viewports.map(viewport => ({ ...viewport, label: 'Desktop' })), strings: MOCKUP_STRINGS };
			const html = buildMockupsPage(data);
			assert.ok(!html.includes('</script><b>x</b>'), 'option markup cannot end the data script');
			const { frame, doc, win } = await load(html);
			try {
				assert.deepStrictEqual(Array.from(doc.querySelectorAll('.mk-letter')).map(node => node.textContent), ['A', 'B']);
				assert.strictEqual(doc.querySelectorAll('.mk-card iframe').length, 2, 'one frame per option in the starting look');
				assert.ok(doc.querySelector<HTMLIFrameElement>('.mk-card iframe')!.srcdoc.includes('class="dark"'), 'it starts in the chat\'s look');
				doc.querySelectorAll<HTMLButtonElement>('.mk-actions .vg-btn.primary')[1].click();
				assert.deepStrictEqual([...win.__sent], ['I choose option B "Playful" from "Empty states".']);
				assert.ok(doc.querySelectorAll('.mk-card')[1].classList.contains('chosen'));
				doc.querySelectorAll<HTMLButtonElement>('.mk-actions .vg-btn:not(.primary)')[0].click();
				assert.deepStrictEqual([...win.__prompts], ['Refine option A "Calm" from "Empty states": ']);
				doc.querySelector<HTMLButtonElement>('.mk-open')!.click();
				assert.ok(doc.querySelector('.mk-detail'), 'Open shows the option full size');
				assert.ok(doc.querySelector<HTMLElement>('.vg-grid')!.hidden);
			} finally {
				frame.remove();
			}
		});
	});

	suite('screens_capture', () => {

		function plan(args: Record<string, unknown>): IScreensPlan {
			const parsed = parseScreensArgs(args);
			if ('error' in parsed) {
				throw new Error(parsed.error);
			}
			return parsed;
		}

		test('works out the source and fills sensible defaults', () => {
			const web = plan({ title: 'Web', url: 'localhost:3000', screens: [{ name: 'Settings', url: '/settings' }] });
			assert.strictEqual(web.source, 'web');
			assert.strictEqual(web.base, 'http://localhost:3000');
			assert.deepStrictEqual(web.themes, ['light', 'dark']);
			assert.deepStrictEqual(web.viewports.map(viewport => viewport.id), ['desktop']);
			const phone = plan({ url: 'http://localhost:5173', viewports: ['phone', '1024x768', { width: 600, height: 900, name: 'Narrow' }], themes: 'dark' });
			assert.deepStrictEqual(phone.viewports.map(viewport => `${viewport.label} ${viewport.width}×${viewport.height}`), ['Phone 390×844', '1024×768 1024×768', 'Narrow 600×900']);
			assert.deepStrictEqual(phone.themes, ['dark']);
			assert.strictEqual(phone.screens.length, 1, 'the base page alone');
			const device = plan({ device: 'iPhone 16', screens: [{ name: 'Home', open: 'myapp://home' }, { name: 'Profile', act: 'tap "Profile"' }] });
			assert.strictEqual(device.source, 'device');
			assert.deepStrictEqual(device.devices, ['iPhone 16']);
			assert.strictEqual(device.screens[0].url, undefined);
			const two = plan({ devices: ['iPhone 16', 'Pixel 9'] });
			assert.deepStrictEqual(two.devices, ['iPhone 16', 'Pixel 9']);
			assert.strictEqual(two.screens[0].name, 'Current screen');
			const files = plan({ screens: [{ path: '/tmp/a.png' }, { name: 'B', path: '/tmp/b.png' }] });
			assert.strictEqual(files.source, 'files');
			assert.strictEqual(files.themes, undefined, 'images are shown as they are');
			assert.deepStrictEqual(files.screens.map(screen => screen.name), ['a.png', 'B']);
			const windowPlan = plan({ window: 'Notes', screens: [{ name: 'New note', act: 'click button "New Note"' }] });
			assert.strictEqual(windowPlan.source, 'window');
			assert.strictEqual(windowPlan.themes, undefined);
			assert.strictEqual(plan({ url: 'http://localhost:3000', discover: true }).discover, 12);
		});

		test('says what is missing or too much', () => {
			const error = (args: Record<string, unknown>) => {
				const parsed = parseScreensArgs(args);
				return 'error' in parsed ? parsed.error : '';
			};
			assert.match(error({ title: 'x' }), /Say where the screens are/);
			assert.match(error({ source: 'web', screens: [{ name: 'S', url: '/settings' }] }), /Web screens need "url"/);
			assert.match(error({ url: 'http://localhost:3000', viewports: ['watch'] }), /Unknown viewport "watch"/);
			assert.match(error({ source: 'files', screens: [{ name: 'x' }] }), /"path"/);
			assert.match(error({ url: 'http://localhost:3000', viewports: ['phone', 'tablet', 'laptop', 'desktop'], screens: Array.from({ length: 9 }, (_, i) => ({ name: `S${i}`, url: `/s${i}` })) }), new RegExp(`up to ${MAX_SHOTS}`));
		});

		test('resolves screen URLs on the app\'s URL', () => {
			assert.strictEqual(resolveScreenUrl('http://localhost:3000', '/settings'), 'http://localhost:3000/settings');
			assert.strictEqual(resolveScreenUrl('http://localhost:3000/app', 'billing'), 'http://localhost:3000/app/billing');
			assert.strictEqual(resolveScreenUrl('http://localhost:3000', 'https://example.com/x'), 'https://example.com/x');
			assert.strictEqual(resolveScreenUrl(undefined, 'localhost:4000/a'), 'http://localhost:4000/a');
			assert.strictEqual(resolveScreenUrl(undefined, '/settings'), undefined);
			assert.strictEqual(resolveScreenUrl('http://localhost:3000', undefined), 'http://localhost:3000');
			assert.strictEqual(absolutePageUrl('/billing', 'http://localhost:3000/settings'), 'http://localhost:3000/billing');
			assert.strictEqual(absolutePageUrl('localhost:3000/x', 'about:blank'), 'http://localhost:3000/x');
		});

		test('discovers the app\'s pages, never one that signs out or deletes', () => {
			const links = [
				{ href: 'http://localhost:3000/', text: 'Home' },
				{ href: 'http://localhost:3000/projects', text: 'Projects' },
				{ href: 'http://localhost:3000/projects#top', text: 'Projects again' },
				{ href: 'http://localhost:3000/logout', text: 'Log out' },
				{ href: 'http://localhost:3000/account', text: 'Sign out' },
				{ href: 'http://localhost:3000/export.csv', text: 'Export' },
				{ href: 'https://github.com/volt', text: 'GitHub' },
				{ href: 'http://localhost:3000/settings?tab=billing', text: 'Billing settings with a label that is far too long to be a name' },
				{ href: 'http://localhost:3000/team', text: 'Team' },
			];
			const picked = pickNavLinks(links, 'http://localhost:3000/', 3, ['http://localhost:3000/']);
			assert.deepStrictEqual(picked.map(screen => `${screen.name} ${screen.url}`), [
				'Projects http://localhost:3000/projects',
				'/settings http://localhost:3000/settings?tab=billing',
				'Team http://localhost:3000/team',
			]);
		});

		test('variants are named for the gallery and files sort like it', () => {
			const web = plan({ url: 'http://localhost:3000', viewports: ['desktop', 'phone'] });
			const variants = shotVariants(web);
			assert.deepStrictEqual(variants.map(variant => variant.label), ['Desktop · Light', 'Desktop · Dark', 'Phone · Light', 'Phone · Dark']);
			assert.strictEqual(shotFileName(2, 'Billing & Plans', variants[3]), '03-billing-plans-phone-dark.jpg');
			const single = shotVariants(plan({ url: 'http://localhost:3000' }));
			assert.deepStrictEqual(single.map(variant => variant.label), ['Light', 'Dark']);
			assert.strictEqual(shotFileName(0, 'Home', single[1]), '01-home-dark.jpg');
			const devices = shotVariants(plan({ devices: ['iPhone 16', 'Pixel 9'] }), ['iPhone 16 Pro', 'Pixel 9']);
			assert.deepStrictEqual(devices.map(variant => `${variant.id} ${variant.label}`), ['d0-light iPhone 16 Pro · Light', 'd0-dark iPhone 16 Pro · Dark', 'd1-light Pixel 9 · Light', 'd1-dark Pixel 9 · Dark']);
		});

		test('the report is one compact block: what, where, and only what needs attention', () => {
			const web = plan({ url: 'http://localhost:3000', screens: [{ name: 'Home', url: '/' }, { name: 'Billing', url: '/billing' }, { name: 'Profile', url: '/me', act: 'click "Edit"' }] });
			const variants = shotVariants(web);
			const text = formatScreensReport({
				plan: web,
				screens: [
					{ name: 'Home', detail: '/', notes: [] },
					{ name: 'Billing', detail: '/billing', notes: ['HTTP 404'] },
					{ name: 'Profile', detail: '/me', notes: [], failure: 'step 1 failed (NOT_FOUND): no visible element matches "Edit"' },
				],
				shots: [{ screen: 0, variant: variants[0].id, file: '01-home-light.jpg' }, { screen: 0, variant: variants[1].id, file: '01-home-dark.jpg' }, { screen: 1, variant: variants[0].id, file: '02-billing-light.jpg' }, { screen: 1, variant: variants[1].id, file: '02-billing-dark.jpg' }],
				variants,
				folder: '/tmp/volt-screens/2026-10-10-web',
				ms: 4200,
				notes: [],
			});
			assert.strictEqual(text, [
				'Captured 2 screens × Light / Dark (4 shots) of http://localhost:3000 in 4.2s. They are shown to the user above your reply as a gallery they can browse; do not describe or list them unless asked.',
				'Saved in /tmp/volt-screens/2026-10-10-web/:',
				'1. Home (/): 01-home-light.jpg, 01-home-dark.jpg',
				'2. Billing (/billing): 02-billing-light.jpg, 02-billing-dark.jpg — ⚠ HTTP 404',
				'Not captured:',
				'- Profile: step 1 failed (NOT_FOUND): no visible element matches "Edit"',
			].join('\n'));
		});

		test('the page shows each screen\'s shots, filters to one look, and asks about a screen', async () => {
			const data: IScreensPageData = {
				title: 'App screens',
				kind: 'phone',
				variants: [{ id: 'light', label: 'Light', theme: 'light' }, { id: 'dark', label: 'Dark', theme: 'dark' }],
				screens: [
					{ name: 'Home', detail: '/home', shots: [{ variant: 'light', src: PIXEL, width: 2, height: 2 }, { variant: 'dark', src: PIXEL, width: 2, height: 2 }] },
					{ name: 'Inbox', note: 'HTTP 404', shots: [{ variant: 'light', src: PIXEL, width: 2, height: 2 }, { variant: 'dark', src: PIXEL, width: 2, height: 2, path: '/tmp/02-inbox-dark.jpg' }] },
				],
				failures: [{ name: 'Profile', reason: 'not captured' }],
				strings: SCREEN_STRINGS,
			};
			const { frame, doc, win } = await load(buildScreensPage(data));
			try {
				assert.strictEqual(doc.querySelectorAll('.sc-card').length, 2);
				assert.strictEqual(doc.querySelectorAll('.sc-card img').length, 4);
				assert.ok(doc.querySelector('.sc-failures')!.textContent!.includes('Profile'));
				assert.ok(doc.querySelectorAll('.sc-card')[1].textContent!.includes('HTTP 404'));
				Array.from(doc.querySelectorAll<HTMLButtonElement>('.vg-seg button')).find(button => button.textContent === 'Dark')!.click();
				assert.strictEqual(doc.querySelectorAll('.sc-card img').length, 2, 'one look at a time');
				doc.querySelectorAll<HTMLButtonElement>('.sc-card .sc-shot')[1].click();
				assert.ok(doc.querySelector('.sc-detail-view')!.textContent!.includes('Inbox'));
				Array.from(doc.querySelectorAll<HTMLButtonElement>('.sc-detail-view .vg-btn')).find(button => button.textContent === 'Ask about this')!.click();
				assert.deepStrictEqual([...win.__prompts], ['About the "Inbox" screen (Dark): ']);
			} finally {
				frame.remove();
			}
		});
	});

	test('both tools are Volt tools with rows that say what happened', () => {
		assert.strictEqual(voltHostToolName('mcp__volt__mockups_render'), MOCKUPS_TOOL_NAME);
		assert.strictEqual(voltHostToolName('mcp__volt__screens_capture'), SCREENS_TOOL_NAME);
		assert.deepStrictEqual(describeHostToolActivity('mcp__volt__mockups_render', undefined, JSON.stringify({ title: 'Sidebars', options: [{}, {}, {}] })), { tool: MOCKUPS_TOOL_NAME, label: 'Showed 3 mockups', detail: 'Sidebars' });
		assert.deepStrictEqual(describeHostToolActivity('mcp__volt__screens_capture', undefined, JSON.stringify({ title: 'All screens', screens: [{}, {}] })), { tool: SCREENS_TOOL_NAME, label: 'Captured 2 screens', detail: 'All screens' });
		assert.deepStrictEqual(describeHostToolActivity('mcp__volt__screens_capture', undefined, JSON.stringify({ job: 'ab12cd34' })), { tool: SCREENS_TOOL_NAME, label: 'Capturing screens' });
	});
});
