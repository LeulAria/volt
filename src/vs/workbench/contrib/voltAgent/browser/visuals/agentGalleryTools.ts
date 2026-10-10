/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout, timeout } from '../../../../../base/common/async.js';
import { encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isAbsolute } from '../../../../../base/common/path.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IVoltVisualPreviewService } from '../../../../../platform/voltVisualPreview/common/voltVisualPreview.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { dataUrlBytes, decodeDataUrl, scaleScreenshot } from '../../../../services/voltRuntime/browser/host/imageCodec.js';
import { IVoltHostToolCall, IVoltHostToolInfo, IVoltHostToolProvider, IVoltHostToolResult, IVoltHostToolService, MOCKUPS_TOOL_NAME, SCREENS_TOOL_NAME } from '../../../../services/voltRuntime/common/hostTools.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { fileFlowStore, IFlowStore, resolveActInput } from '../actFlows.js';
import { IAgentDevicesService, IDeviceTarget } from '../devices/agentDevicesService.js';
import { runActSteps } from '../preview/browserAct.js';
import { buildMockupsPage, buildScreensPage, GalleryTheme, IMockupOption, IMockupsPageData, IMockupStrings, IMockupViewport, IScreensPageData, IScreensStrings, MockupFrameKind } from './galleryPages.js';
import { HeadlessActDriver } from './headlessActDriver.js';
import { VISUAL_MAX_HTML_CHARS } from './agentVisualPage.js';
import { formatScreensReport, frameKindOf, INavLink, IScreenSpec, IScreensPlan, IScreenViewport, IShotVariant, NAV_LINKS_SCRIPT, parseScreensArgs, pickNavLinks, resolveScreenUrl, shotFileName, shotVariants, slug } from './screensPlan.js';
import { VisualPagePublisher } from './visualPublisher.js';

//#region Tool definitions

export const GALLERY_TOOLS: readonly IVoltHostToolInfo[] = [
	{
		name: MOCKUPS_TOOL_NAME,
		title: 'Showed mockups',
		group: 'visuals',
		description: 'Show design alternatives side by side in this chat so the user can compare them and pick one: small UI changes, layout or component variants, visual directions, experiments ("5 sidebar alternatives", "3 empty states", "onboarding options"). You send only each option\'s HTML; Volt frames every option in a phone, tablet, desktop or component viewport, scales it to fit, lets the user flip light/dark or see both, open one full size, and click Choose (or Combine several, or Refine one). Their pick and notes arrive as their next message, so after this call end your turn with one short line: do not describe the options or ask which they prefer. Put what all options share once: `head` (fonts; Tailwind via <script src="https://cdn.tailwindcss.com"></script>), `css`, and `template` with {{option}} where each option\'s `html` goes when only one region differs (a sidebar beside the same page). Dark mode: `.dark` selectors, Tailwind `dark:` or @media (prefers-color-scheme: dark); set `theme` "light" when the options have no dark look. Make options genuinely different (structure, density, hierarchy, interaction), not recolors, and use the project\'s real copy, colors and fonts. Errors an option logs come back in the result.',
		inputSchema: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'What is compared, e.g. "Sidebar alternatives".' },
				subtitle: { type: 'string', description: 'Optional: what to judge them on.' },
				frame: { type: 'string', description: 'phone (390×844), tablet (820×1180), desktop (1280×800, default) or component (420 wide, as tall as its content); join with + to let the user switch sizes, e.g. "desktop+phone".' },
				width: { type: 'number', description: 'Custom viewport width in CSS px, with height (0 fits the content).' },
				height: { type: 'number' },
				theme: { type: 'string', enum: ['both', 'light', 'dark'], description: 'Looks the options have. Default both.' },
				head: { type: 'string', description: 'Shared <head> markup: fonts, scripts.' },
				css: { type: 'string', description: 'Shared CSS.' },
				template: { type: 'string', description: 'Shared body markup with {{option}} where each option\'s html goes.' },
				options: {
					type: 'array',
					minItems: 1,
					maxItems: 8,
					items: {
						type: 'object',
						properties: {
							label: { type: 'string', description: '2-4 words.' },
							note: { type: 'string', description: 'One line: the idea and its trade-off.' },
							html: { type: 'string', description: 'Body markup, or a whole document.' },
							css: { type: 'string' },
						},
						required: ['label', 'html'],
					},
				},
				recommended: { type: 'string', description: 'Letter or label of the option you recommend (badged).' },
				screenshot: { type: 'boolean', description: 'Also return an image of the gallery to check it.' },
			},
			required: ['title', 'options'],
		},
	},
	{
		name: SCREENS_TOOL_NAME,
		title: 'Captured screens',
		group: 'visuals',
		approvalInReadOnlyModes: 'opens the app\'s screens and switches light and dark mode',
		description: `Capture an app's screens and show them in this chat as a gallery the user can browse (each screen's light and dark side by side, click to enlarge, filter, ask about one). One call does a whole sweep, far faster and cheaper than screenshot tools one by one, and you get text back, not images. Sources (inferred from what you pass):
- web: \`url\` (e.g. http://localhost:3000) and screens with \`url\` paths. Rendered offscreen, signed in like the in-app browser, at \`viewports\` (phone, tablet, laptop, desktop or {width, height}; default desktop), in light and dark via prefers-color-scheme. \`discover: true\` also captures the pages linked from the first page's navigation.
- device: a booted iOS simulator or Android emulator (\`device\`, see device_list). Each screen opens a deep link or app id (\`open\`) and/or runs device_act steps (\`act\`); Volt switches the system appearance for light and dark, and restores it.
- window: a desktop app window (\`window\`); screens run desktop_act steps (\`act\`).
- files: images you already have (screens with \`path\`).
Screens: [{ name, url | open | act | path, wait: "text to wait for" }]; \`setup\` runs steps once first (sign in). act takes browser_act / device_act / desktop_act lines. The result lists the saved files and only what needs attention (HTTP errors, failed steps, screens that ignore dark mode); \`look: true\` adds one contact-sheet image to check them. A long sweep returns STILL CAPTURING with a job id: call again with {"job": id} right away. Call it before your final text and do not describe the screens.`,
		inputSchema: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'e.g. "Settings flow" or "All screens".' },
				url: { type: 'string', description: 'Web: the app\'s base URL.' },
				screens: {
					type: 'array',
					maxItems: 30,
					items: {
						type: 'object',
						properties: {
							name: { type: 'string' },
							url: { type: 'string', description: 'Web: a path or URL.' },
							open: { type: 'string', description: 'Device: deep link or app id. Window: the app.' },
							act: { type: 'string', description: 'Steps that reach the screen, one per line.' },
							path: { type: 'string', description: 'Files: the image.' },
							wait: { type: 'string', description: 'Text to wait for before capturing.' },
						},
						required: ['name'],
					},
				},
				discover: { type: 'boolean', description: 'Web: also capture the pages linked from the first page\'s navigation (up to 12).' },
				viewports: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object' }] }, description: 'Web: "phone", "tablet", "laptop", "desktop", "1024x768" or {"width", "height"}.' },
				themes: { type: 'string', enum: ['both', 'light', 'dark', 'current'], description: 'Default both for web and devices, current for windows and files.' },
				device: { type: 'string', description: 'Device name or id; default the chat\'s device or the only booted one.' },
				devices: { type: 'array', items: { type: 'string' }, description: 'Several devices side by side, e.g. an iPhone and a Pixel.' },
				host: { type: 'string', description: 'Machine from device_list, for simulators over SSH.' },
				app: { type: 'string', description: 'Device: app id or deep link launched first. Window: the app the steps drive.' },
				window: { type: 'string', description: 'Window: title text or id from window_list.' },
				setup: { type: 'string', description: 'Steps run once before the screens, e.g. signing in.' },
				vars: { type: 'object', description: 'Values for ${name} placeholders in steps (passwords).' },
				full_page: { type: 'boolean', description: 'Web: the whole scroll height, not just the viewport.' },
				look: { type: 'boolean', description: 'Also return a contact-sheet image of every shot.' },
				job: { type: 'string', description: 'Keep waiting for a capture that returned STILL CAPTURING.' },
			},
		},
	},
];

//#endregion

//#region Mockups

const LETTERS = 'ABCDEFGHIJKL';
const MAX_MOCKUP_OPTIONS = 8;

const FRAME_SIZES: Readonly<Record<MockupFrameKind, { readonly width: number; readonly height: number }>> = {
	phone: { width: 390, height: 844 },
	tablet: { width: 820, height: 1180 },
	desktop: { width: 1280, height: 800 },
	component: { width: 420, height: 0 },
};

function text(value: unknown, max: number): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ').slice(0, max) : undefined;
}

function frameKind(value: string): MockupFrameKind | undefined {
	const key = value.trim().toLowerCase();
	if (key === 'phone' || key === 'mobile' || key === 'iphone' || key === 'android') {
		return 'phone';
	}
	if (key === 'tablet' || key === 'ipad') {
		return 'tablet';
	}
	if (key === 'desktop' || key === 'web' || key === 'laptop' || key === 'browser' || key === 'page') {
		return 'desktop';
	}
	if (key === 'component' || key === 'widget' || key === 'card' || key === 'element') {
		return 'component';
	}
	return undefined;
}

export type IParsedMockups = Omit<IMockupsPageData, 'strings' | 'viewports'> & { readonly viewports: readonly Omit<IMockupViewport, 'label'>[] };

/** The call's arguments as a gallery, or what is wrong with them. Pure, for tests. */
export function parseMockupsArgs(args: Record<string, unknown>): IParsedMockups | { readonly error: string } {
	let raw = args.options;
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw);
		} catch {
			return { error: '"options" is a string that is not valid JSON. Pass the array itself.' };
		}
	}
	if (!Array.isArray(raw) || !raw.length) {
		return { error: 'Pass "options": [{ "label": "Icon rail", "note": "...", "html": "<aside>...</aside>" }, ...].' };
	}
	if (raw.length > MAX_MOCKUP_OPTIONS) {
		return { error: `That is ${raw.length} options; show up to ${MAX_MOCKUP_OPTIONS} at once (the user compares them side by side). Keep the strongest.` };
	}
	const options: IMockupOption[] = [];
	for (let i = 0; i < raw.length; i++) {
		const item = raw[i] as Record<string, unknown> | undefined;
		const id = LETTERS[i];
		const html = typeof item?.html === 'string' ? item.html : '';
		if (!html.trim()) {
			return { error: `Option ${id} needs "html".` };
		}
		const label = text(item?.label ?? item?.name ?? item?.title, 60) ?? `Option ${id}`;
		const note = text(item?.note ?? item?.description ?? item?.rationale, 280);
		const css = typeof item?.css === 'string' && item.css.trim() ? item.css : undefined;
		options.push({ id, label, html, ...(note ? { note } : {}), ...(css ? { css } : {}) });
	}
	const kinds: MockupFrameKind[] = [];
	for (const part of (typeof args.frame === 'string' ? args.frame : Array.isArray(args.frame) ? args.frame.join('+') : '').split(/[+,/|]/)) {
		const kind = part.trim() ? frameKind(part) : undefined;
		if (part.trim() && !kind) {
			return { error: `Unknown frame "${part.trim()}": use phone, tablet, desktop or component (join with + to switch, e.g. "desktop+phone").` };
		}
		if (kind && !kinds.includes(kind)) {
			kinds.push(kind);
		}
	}
	const width = typeof args.width === 'number' && Number.isFinite(args.width) ? Math.round(args.width) : undefined;
	const height = typeof args.height === 'number' && Number.isFinite(args.height) ? Math.round(args.height) : undefined;
	if (width !== undefined && (width < 200 || width > 2560)) {
		return { error: 'width is CSS px between 200 and 2560.' };
	}
	if (height !== undefined && height !== 0 && (height < 120 || height > 2400)) {
		return { error: 'height is CSS px between 120 and 2400, or 0 to fit the content.' };
	}
	if (!kinds.length) {
		kinds.push(width === undefined ? 'desktop' : height === 0 ? 'component' : width < 600 ? 'phone' : width < 1000 ? 'tablet' : 'desktop');
	}
	const viewports = kinds.slice(0, 3).map((kind, index) => {
		const size = FRAME_SIZES[kind];
		// A custom size applies to the first frame.
		return index === 0 && width !== undefined ? { kind, width, height: height ?? (kind === 'component' ? 0 : Math.round(width * size.height / Math.max(1, size.width)) || 800) } : { kind, ...size };
	});
	const theme = args.theme === 'light' || args.theme === 'dark' ? args.theme : 'both';
	const head = typeof args.head === 'string' && args.head.trim() ? args.head : undefined;
	const css = typeof args.css === 'string' && args.css.trim() ? args.css : undefined;
	const template = typeof args.template === 'string' && args.template.trim() ? args.template : undefined;
	const total = (head?.length ?? 0) + (css?.length ?? 0) + (template?.length ?? 0) + options.reduce((sum, option) => sum + option.html.length + (option.css?.length ?? 0), 0);
	if (total > VISUAL_MAX_HTML_CHARS) {
		return { error: `The options add up to ${total.toLocaleString()} characters; the limit is ${VISUAL_MAX_HTML_CHARS.toLocaleString()}. Move shared markup into "template", "css" and "head".` };
	}
	const wanted = text(args.recommended, 60)?.toLowerCase();
	const recommended = wanted ? options.find(option => option.id.toLowerCase() === wanted || option.label.toLowerCase() === wanted || wanted === `option ${option.id.toLowerCase()}`)?.id : undefined;
	return {
		title: text(args.title, 120) ?? 'Mockups',
		...(text(args.subtitle, 240) ? { subtitle: text(args.subtitle, 240) } : {}),
		viewports,
		theme,
		...(head ? { head } : {}),
		...(css ? { css } : {}),
		...(template ? { template } : {}),
		options,
		...(recommended ? { recommended } : {}),
	};
}

function mockupStrings(): IMockupStrings {
	return {
		light: localize('voltMockups.light', "Light"),
		dark: localize('voltMockups.dark', "Dark"),
		both: localize('voltMockups.both', "Both"),
		open: localize('voltMockups.open', "Open"),
		openOption: localize('voltMockups.openOption', "Open option {0}: {1}"),
		choose: localize('voltMockups.choose', "Choose"),
		chooseOption: localize('voltMockups.chooseOption', "Choose {0}"),
		chosen: localize('voltMockups.chosen', "Chosen"),
		refine: localize('voltMockups.refine', "Refine"),
		select: localize('voltMockups.select', "Select"),
		recommended: localize('voltMockups.recommended', "Recommended"),
		allOptions: localize('voltMockups.allOptions', "All options"),
		previous: localize('voltMockups.previous', "Previous"),
		next: localize('voltMockups.next', "Next"),
		fullscreen: localize('voltMockups.fullscreen', "Full screen"),
		notesPlaceholder: localize('voltMockups.notes', "Notes for the agent (optional), then Enter"),
		selectedCount: localize('voltMockups.selectedCount', "{0} selected"),
		combineCount: localize('voltMockups.combineCount', "Combine {0}"),
		clear: localize('voltMockups.clear', "Clear"),
		chooseMessage: localize('voltMockups.chooseMessage', "I choose option {0} \"{1}\" from \"{2}\"."),
		combineMessage: localize('voltMockups.combineMessage', "Combine options {0} from \"{1}\" into one design."),
		refinePrompt: localize('voltMockups.refinePrompt', "Refine option {0} \"{1}\" from \"{2}\": "),
		selectedContext: localize('voltMockups.selectedContext', "Mockups selected in \"{0}\": {1}"),
	};
}

function frameLabel(kind: MockupFrameKind): string {
	switch (kind) {
		case 'phone': return localize('voltMockups.phone', "Phone");
		case 'tablet': return localize('voltMockups.tablet', "Tablet");
		case 'component': return localize('voltMockups.component', "Component");
		default: return localize('voltMockups.desktop', "Desktop");
	}
}

//#endregion

//#region Screens

/** A tool call waits this long for a capture, under the 60s agents give an MCP call; then it says STILL CAPTURING. */
const WAIT_MS = 45_000;
/** A whole capture stops here, with what it has. */
const JOB_LIMIT_MS = 6 * 60_000;
/** A finished capture nobody collected is dropped after this. */
const UNCOLLECTED_MS = 10 * 60_000;
const WEB_PAGES_AT_ONCE = 3;
const SHOT_MAX_SIDE = 1600;

interface ICapturedShot {
	readonly screen: number;
	readonly variant: IShotVariant;
	readonly dataUrl: string;
	readonly width: number;
	readonly height: number;
	file?: string;
	path?: string;
}

interface IScreenState {
	spec: IScreenSpec;
	name: string;
	detail?: string;
	readonly notes: string[];
	/** Why a variant could not be captured, per device or viewport. */
	readonly errors: string[];
	failure?: string;
}

class ScreensJob {
	readonly id = generateUuid().slice(0, 8);
	readonly cancel = new CancellationTokenSource();
	readonly screens: IScreenState[];
	readonly shots: ICapturedShot[] = [];
	readonly notes: string[] = [];
	variants: IShotVariant[] = [];
	expected = 0;
	current?: string;
	links?: INavLink[];
	subtitle?: string;
	done!: Promise<IVoltHostToolResult>;
	collected = false;

	constructor(readonly plan: IScreensPlan, readonly chat: string | undefined, readonly started = Date.now()) {
		this.screens = plan.screens.map(spec => ({ spec, name: spec.name, notes: [], errors: [] }));
	}

	get token(): CancellationToken {
		return this.cancel.token;
	}

	note(screen: IScreenState, note: string): void {
		if (!screen.notes.includes(note)) {
			screen.notes.push(note);
		}
	}
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** A `wait "text"` act line, quotes escaped. */
function waitLine(text: string): string {
	return `wait "${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Runs `work` over `items`, at most `limit` at a time, in order of start. */
async function pool<T>(items: readonly T[], limit: number, token: CancellationToken, work: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length && !token.isCancellationRequested) {
			await work(items[next++]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Two captures that are the same picture (a page or app that ignores light and dark). */
async function looksSame(a: string, b: string): Promise<boolean> {
	try {
		const [x, y] = await Promise.all([decodeDataUrl(a, { width: 32, height: 32 }), decodeDataUrl(b, { width: 32, height: 32 })]);
		let diff = 0;
		for (let i = 0; i < x.data.length; i += 4) {
			diff += Math.abs(x.data[i] - y.data[i]) + Math.abs(x.data[i + 1] - y.data[i + 1]) + Math.abs(x.data[i + 2] - y.data[i + 2]);
		}
		return diff / (x.data.length / 4) / 3 < 3;
	} catch {
		return false;
	}
}

/** The path shown under a web screen: `/settings` on the app's own origin, the whole URL elsewhere. */
function shownPath(url: string, base: string | undefined): string {
	try {
		const target = new URL(url);
		const home = base ? new URL(base) : undefined;
		return home && target.origin === home.origin ? `${target.pathname}${target.search}` : url;
	} catch {
		return url;
	}
}

function timestamp(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Every shot in one small picture for the agent (`look: true`): tiles in rows, each labeled with
 * its screen number, name and variant, at most 1400 px wide. One image instead of dozens.
 */
async function contactSheet(tiles: readonly { readonly label: string; readonly dataUrl: string; readonly width: number; readonly height: number }[]): Promise<string | undefined> {
	if (!tiles.length || typeof OffscreenCanvas !== 'function') {
		return undefined;
	}
	const MAX_WIDTH = 1400, GAP = 8, LABEL = 18, PAD = 8;
	const portrait = tiles.filter(tile => tile.height > tile.width).length > tiles.length / 2;
	const tileHeight = portrait ? 300 : 190;
	const sized = tiles.map(tile => ({ ...tile, w: Math.max(40, Math.round(tile.width * tileHeight / Math.max(1, tile.height))), h: tileHeight }));
	const rows: (typeof sized)[] = [[]];
	let x = PAD;
	for (const tile of sized) {
		const tileWidth = Math.min(tile.w, MAX_WIDTH - PAD * 2);
		if (rows[rows.length - 1].length && x + tileWidth > MAX_WIDTH - PAD) {
			rows.push([]);
			x = PAD;
		}
		rows[rows.length - 1].push({ ...tile, w: tileWidth });
		x += tileWidth + GAP;
	}
	const width = Math.min(MAX_WIDTH, Math.max(...rows.map(row => row.reduce((sum, tile) => sum + tile.w + GAP, PAD * 2 - GAP))));
	const height = PAD * 2 + rows.length * (tileHeight + LABEL) + (rows.length - 1) * GAP;
	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext('2d');
	if (!context) {
		return undefined;
	}
	context.fillStyle = '#e9e9ec';
	context.fillRect(0, 0, width, height);
	context.font = '600 12px -apple-system, "Segoe UI", sans-serif';
	context.textBaseline = 'middle';
	let y = PAD;
	for (const row of rows) {
		let left = PAD;
		for (const tile of row) {
			try {
				const image = await decodeDataUrl(tile.dataUrl, { width: tile.w, height: tile.h });
				const pixels = new Uint8ClampedArray(image.width * image.height * 4);
				pixels.set(image.data);
				context.putImageData(new ImageData(pixels, image.width, image.height), left, y);
			} catch {
				context.fillStyle = '#bbb';
				context.fillRect(left, y, tile.w, tile.h);
			}
			context.fillStyle = '#222';
			context.fillText(tile.label.length > Math.floor(tile.w / 7) ? `${tile.label.slice(0, Math.max(4, Math.floor(tile.w / 7) - 1))}…` : tile.label, left + 2, y + tileHeight + LABEL / 2);
			left += tile.w + GAP;
		}
		y += tileHeight + LABEL + GAP;
	}
	const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
	return `data:image/jpeg;base64,${encodeBase64(VSBuffer.wrap(new Uint8Array(await blob.arrayBuffer())))}`;
}

function screenStrings(): IScreensStrings {
	return {
		all: localize('voltScreens.all', "All"),
		smaller: localize('voltScreens.smaller', "Smaller"),
		larger: localize('voltScreens.larger', "Larger"),
		allScreens: localize('voltScreens.allScreens', "All screens"),
		previous: localize('voltScreens.previous', "Previous screen"),
		next: localize('voltScreens.next', "Next screen"),
		sideBySide: localize('voltScreens.sideBySide', "Side by side"),
		fullscreen: localize('voltScreens.fullscreen', "Full screen"),
		ask: localize('voltScreens.ask', "Ask about this"),
		askPrompt: localize('voltScreens.askPrompt', "About the \"{0}\" screen ({1}): "),
		openFile: localize('voltScreens.openFile', "Open image file"),
		notCaptured: localize('voltScreens.notCaptured', "Not captured"),
		lookingAt: localize('voltScreens.lookingAt', "The user is looking at screen {0} \"{1}\" ({2}): {3}"),
	};
}

//#endregion

/**
 * Serves mockups_render and screens_capture on Volt's MCP server. Mockups are a page built from the
 * agent's options; screens are captured by a job (offscreen pages for the web, the simulator or
 * emulator, a desktop window) that outlives one tool call, since a sweep can take longer than an
 * agent waits for a call: the call returns STILL CAPTURING and the agent calls again with the job.
 */
export class AgentGalleryToolProvider extends Disposable implements IVoltHostToolProvider {

	readonly tools = GALLERY_TOOLS;
	private readonly publisher: VisualPagePublisher;
	private readonly jobs = new Map<string, ScreensJob>();

	constructor(
		/** Where captured screens are saved (a folder per capture inside it). */
		private readonly screensFolder: URI,
		@IVoltVisualPreviewService private readonly preview: IVoltVisualPreviewService,
		@IAgentDevicesService private readonly devices: IAgentDevicesService,
		@IVoltHostToolService private readonly hostTools: IVoltHostToolService,
		@IFileService private readonly fileService: IFileService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.publisher = this._register(instantiationService.createInstance(VisualPagePublisher));
		// A run that ends takes its captures with it.
		this._register(runtime.onDidEmit(({ sessionId, event }) => {
			if (event.type === 'run.end') {
				for (const job of this.jobs.values()) {
					if (job.chat === sessionId) {
						job.cancel.cancel();
					}
				}
			}
		}));
		this._register(toDisposable(() => {
			for (const job of this.jobs.values()) {
				job.cancel.dispose(true);
			}
			this.jobs.clear();
		}));
	}

	async invoke(name: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		try {
			switch (name) {
				case MOCKUPS_TOOL_NAME: return await this.renderMockups(args);
				case SCREENS_TOOL_NAME: return await this.captureScreens(args, call);
			}
			return { error: `Unknown tool ${name}` };
		} catch (err) {
			this.logService.warn(`[volt] ${name} failed`, err);
			return { error: errorText(err) };
		}
	}

	//#region Mockups

	private async renderMockups(args: Record<string, unknown>): Promise<IVoltHostToolResult> {
		const parsed = parseMockupsArgs(args);
		if ('error' in parsed) {
			return { error: parsed.error };
		}
		const data: IMockupsPageData = { ...parsed, viewports: parsed.viewports.map(viewport => ({ ...viewport, label: frameLabel(viewport.kind) })), strings: mockupStrings() };
		const published = await this.publisher.publish(buildMockupsPage(data), data.title, { screenshot: args.screenshot === true });
		const frames = data.viewports.map(viewport => `${viewport.kind} ${viewport.width}×${viewport.height || 'auto'}`).join(' and ');
		const looks = data.theme === 'both' ? 'light and dark' : data.theme;
		const lines = [
			`Shown to the user above your reply: ${data.options.length} mockup${data.options.length === 1 ? '' : 's'} of "${data.title}" (${data.options.map(option => `${option.id} ${option.label}`).join(', ')}) in ${frames} frames, ${looks}. The user compares them and clicks Choose (or combines several, or refines one); their pick and any notes come back as their next message. End your turn now with at most one short sentence; do not describe the options or ask which they prefer.`,
		];
		// Errors inside the options carry their option's tag; an untagged "Uncaught" repeats a tagged one.
		const errors = published.errors.filter(error => error.startsWith('[option ') || !/^Uncaught /.test(error));
		if (errors.length) {
			lines.push(`But ${errors.length === 1 ? 'an error was' : `${errors.length} errors were`} logged while the options loaded, so some may look broken. Fix them and call ${MOCKUPS_TOOL_NAME} again with every option:`, ...errors.slice(0, 8).map(error => `- ${error.slice(0, 500)}`));
		}
		return { text: lines.join('\n'), visual: published.visual, ...(published.png ? { image: `data:image/png;base64,${published.png}` } : {}) };
	}

	//#endregion

	//#region Screens: the job

	private async captureScreens(args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const jobId = text(args.job, 40);
		if (jobId) {
			const job = this.jobs.get(jobId);
			return job ? this.collect(job) : { error: `No capture with job id ${jobId}: it was already collected, or the run that started it ended. Start a new one.` };
		}
		const plan = parseScreensArgs(args);
		if ('error' in plan) {
			return { error: plan.error };
		}
		const job = new ScreensJob(plan, call?.sessionId ? this.runtime.chatFor(call.sessionId) : undefined);
		this.jobs.set(job.id, job);
		const limit = setTimeout(() => {
			job.notes.push(`Stopped after ${JOB_LIMIT_MS / 60_000} minutes; capture the rest in another call.`);
			job.cancel.cancel();
		}, JOB_LIMIT_MS);
		job.done = this.runJob(job, call).catch((err): IVoltHostToolResult => ({ error: errorText(err) })).finally(() => {
			clearTimeout(limit);
			// Collected by a waiting call, or dropped if the agent never comes back for it.
			setTimeout(() => {
				if (this.jobs.get(job.id) === job) {
					this.jobs.delete(job.id);
					job.cancel.dispose();
				}
			}, UNCOLLECTED_MS);
		});
		return this.collect(job);
	}

	private async collect(job: ScreensJob): Promise<IVoltHostToolResult> {
		const result = await raceTimeout(job.done, WAIT_MS);
		if (result) {
			this.jobs.delete(job.id);
			return result;
		}
		const done = job.shots.length;
		return { text: `STILL CAPTURING: ${done} of about ${Math.max(done, job.expected)} shots done${job.current ? ` (now: ${job.current})` : ''}. Call ${SCREENS_TOOL_NAME} with {"job": "${job.id}"} now to keep waiting; do nothing else meanwhile and do not end your turn.` };
	}

	private async runJob(job: ScreensJob, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const { plan } = job;
		try {
			switch (plan.source) {
				case 'web': await this.captureWeb(job, call); break;
				case 'device': await this.captureDevices(job, call); break;
				case 'window': await this.captureWindow(job, call); break;
				case 'files': await this.captureFiles(job, call); break;
			}
		} catch (err) {
			if (!job.shots.length) {
				return { error: errorText(err) };
			}
			job.notes.push(`Stopped early: ${errorText(err)}`);
		}
		for (const screen of job.screens) {
			if (!screen.failure && !job.shots.some(shot => job.screens[shot.screen] === screen)) {
				screen.failure = screen.errors.join('; ') || (job.token.isCancellationRequested ? 'cancelled' : 'not captured');
			}
		}
		if (!job.shots.length) {
			const failures = job.screens.filter(screen => screen.failure).map(screen => `- ${screen.name || screen.spec.url || 'screen'}: ${screen.failure}`);
			return { error: ['Nothing was captured.', ...failures, ...job.notes].join('\n') };
		}
		job.shots.sort((a, b) => a.screen - b.screen || job.variants.indexOf(a.variant) - job.variants.indexOf(b.variant));
		const folder = await this.save(job);
		const published = await this.publisher.publish(buildScreensPage(this.galleryData(job)), plan.title);
		const captured = job.screens.filter(screen => !screen.failure);
		const report = formatScreensReport({
			plan,
			screens: [...captured, ...job.screens.filter(screen => screen.failure)].map(screen => ({ name: screen.name, detail: screen.detail, notes: screen.notes, failure: screen.failure })),
			shots: job.shots.map(shot => ({ screen: captured.indexOf(job.screens[shot.screen]), variant: shot.variant.id, file: shot.file })),
			variants: job.variants.filter(variant => job.shots.some(shot => shot.variant === variant)),
			folder: folder?.fsPath,
			ms: Date.now() - job.started,
			notes: job.notes,
		});
		let image: string | undefined;
		if (plan.look) {
			image = await contactSheet(job.shots.map(shot => ({
				label: `${captured.indexOf(job.screens[shot.screen]) + 1} ${job.screens[shot.screen].name}${job.variants.length > 1 ? ` · ${shot.variant.label}` : ''}`,
				dataUrl: shot.dataUrl,
				width: shot.width,
				height: shot.height,
			}))).catch(() => undefined);
		}
		return { text: report, visual: published.visual, ...(image ? { image } : {}) };
	}

	private galleryData(job: ScreensJob): IScreensPageData {
		const { plan } = job;
		const captured = job.screens.map((screen, index) => ({ screen, shots: job.shots.filter(shot => shot.screen === index) })).filter(entry => entry.shots.length);
		const variants = job.variants.filter(variant => job.shots.some(shot => shot.variant === variant));
		const first = job.shots[0];
		return {
			title: plan.title,
			...(job.subtitle ? { subtitle: job.subtitle } : {}),
			kind: frameKindOf(plan, first),
			variants: variants.map(variant => ({ id: variant.id, label: variant.label, ...(variant.theme ? { theme: variant.theme } : {}) })),
			screens: captured.map(({ screen, shots }) => ({
				name: screen.name || localize('voltScreens.page', "Page"),
				...(screen.detail ? { detail: screen.detail } : {}),
				...(screen.notes.length ? { note: screen.notes.join(' · ') } : {}),
				shots: shots.map(shot => ({ variant: shot.variant.id, src: shot.dataUrl, width: shot.width, height: shot.height, ...(shot.path ? { path: shot.path } : {}) })),
			})),
			failures: job.screens.filter(screen => screen.failure).map(screen => ({ name: screen.name || screen.spec.url || screen.spec.open || 'Screen', reason: screen.failure! })),
			strings: screenStrings(),
		};
	}

	/** Writes every shot as `<NN>-<screen>-<variant>.jpg` in a new folder; files from disk keep their path. */
	private async save(job: ScreensJob): Promise<URI | undefined> {
		if (job.plan.source === 'files') {
			return undefined;
		}
		const folder = joinPath(this.screensFolder, `${timestamp(new Date(job.started))}-${slug(job.plan.title, 32)}`);
		const captured = job.screens.filter(screen => !job.shots.every(shot => job.screens[shot.screen] !== screen));
		try {
			await Promise.all(job.shots.map(async shot => {
				const index = captured.indexOf(job.screens[shot.screen]);
				const name = shotFileName(index, job.screens[shot.screen].name || 'page', shot.variant);
				const target = joinPath(folder, name);
				await this.fileService.writeFile(target, VSBuffer.wrap(dataUrlBytes(shot.dataUrl).bytes));
				shot.file = name;
				shot.path = target.fsPath;
			}));
			return folder;
		} catch (err) {
			this.logService.warn('[volt] could not save captured screens', err);
			job.notes.push(`The shots could not be saved to disk (${errorText(err)}); they are only in the gallery.`);
			return undefined;
		}
	}

	private projectFolder(call: IVoltHostToolCall | undefined): string | undefined {
		return call?.cwd ?? (call?.sessionId ? this.runtime.getOrCreateSession(this.runtime.chatFor(call.sessionId)).worktreePath : undefined) ?? this.workspace.getWorkspace().folders[0]?.uri.fsPath;
	}

	private flowStore(call: IVoltHostToolCall | undefined): IFlowStore | undefined {
		const root = this.projectFolder(call);
		return root ? fileFlowStore(this.fileService, URI.file(root)) : undefined;
	}

	private push(job: ScreensJob, screen: number, variant: IShotVariant | undefined, image: { readonly dataUrl: string; readonly width: number; readonly height: number }): void {
		if (variant) {
			job.shots.push({ screen, variant, dataUrl: image.dataUrl, width: image.width, height: image.height });
		}
	}

	//#endregion

	//#region Screens: the web

	private async captureWeb(job: ScreensJob, call: IVoltHostToolCall | undefined): Promise<void> {
		const { plan } = job;
		job.variants = shotVariants(plan);
		const themes = plan.themes?.length ?? 1;
		const store = this.flowStore(call);
		for (const screen of job.screens) {
			const url = resolveScreenUrl(plan.base, screen.spec.url);
			screen.detail = url ? shownPath(url, plan.base) : undefined;
		}
		const host = (() => {
			try {
				return new URL(resolveScreenUrl(plan.base, job.screens[0]?.spec.url) ?? '').host;
			} catch {
				return '';
			}
		})();
		job.subtitle = [host, plan.viewports.map(viewport => `${viewport.label} ${viewport.width}×${viewport.height}`).join(', ')].filter(Boolean).join(' · ');
		if (plan.setup) {
			await this.webSetup(job, store);
		}
		type Task = { readonly screen: number; readonly viewport: IScreenViewport };
		const tasksFor = (from: number) => job.screens.slice(from).flatMap((_, offset) => plan.viewports.map(viewport => ({ screen: from + offset, viewport })));
		job.expected = (job.screens.length + plan.discover) * plan.viewports.length * themes;
		let tasks: Task[] = tasksFor(0);
		if (plan.discover) {
			// The first page goes first: its navigation names the pages to add.
			const first = tasks.filter(task => task.screen === 0);
			await pool(first, WEB_PAGES_AT_ONCE, job.token, task => this.webScreen(job, task.screen, task.viewport, store, task === first[0]));
			const start = resolveScreenUrl(plan.base, job.screens[0].spec.url) ?? plan.base ?? '';
			const known = job.screens.map(screen => resolveScreenUrl(plan.base, screen.spec.url) ?? '').filter(Boolean);
			const added = pickNavLinks(job.links ?? [], start, plan.discover, known);
			const from = job.screens.length;
			for (const spec of added) {
				job.screens.push({ spec, name: spec.name, detail: spec.url ? shownPath(spec.url, plan.base ?? start) : undefined, notes: [], errors: [] });
			}
			if (!added.length) {
				job.notes.push('discover found no other pages in the first page\'s navigation; list the screens to capture.');
			}
			job.expected = job.screens.length * plan.viewports.length * themes;
			tasks = [...tasks.filter(task => task.screen !== 0), ...tasksFor(from)];
		}
		await pool(tasks, WEB_PAGES_AT_ONCE, job.token, task => this.webScreen(job, task.screen, task.viewport, store, false));
	}

	/** Runs `setup` once (signing in): later pages share the in-app browser's session it signed into. */
	private async webSetup(job: ScreensJob, store: IFlowStore | undefined): Promise<void> {
		const { plan } = job;
		const viewport = plan.viewports[0];
		const url = resolveScreenUrl(plan.base, job.screens[0]?.spec.url) ?? plan.base!;
		job.current = 'setup';
		const page = await this.preview.openPage({ url, width: viewport.width, height: viewport.height, scale: 1, mobile: viewport.mobile });
		try {
			const failure = await this.webAct(job, page.id, page.url || url, plan.setup!, undefined, store);
			if (failure) {
				throw new Error(`setup failed: ${failure}`);
			}
		} finally {
			void this.preview.closePage(page.id).catch(() => undefined);
		}
	}

	/** Runs act lines (and a wait) in a headless page; the failure in a line, or undefined when all passed. */
	private async webAct(job: ScreensJob, pageId: string, url: string, act: string | undefined, wait: string | undefined, store: IFlowStore | undefined): Promise<string | undefined> {
		const script = [act, wait ? waitLine(wait) : undefined].filter(Boolean).join('\n');
		if (!script) {
			return undefined;
		}
		const input = await resolveActInput({ script, vars: job.plan.vars }, store, 'act');
		if ('error' in input) {
			return input.error;
		}
		const driver = new HeadlessActDriver(this.preview, pageId, url);
		for (const plan of input.plans) {
			const run = await runActSteps(driver, plan.steps, job.token);
			const failed = run.results.find(result => result.status === 'failed' && !result.step.optional);
			if (!run.ok && failed) {
				return `step ${failed.index + 1} failed (${failed.code}): ${failed.detail.slice(0, 300)}`;
			}
		}
		return undefined;
	}

	/** One page at one viewport, in each theme: loaded in the first, switched live to the next. */
	private async webScreen(job: ScreensJob, index: number, viewport: IScreenViewport, store: IFlowStore | undefined, collectLinks: boolean): Promise<void> {
		const { plan } = job;
		const screen = job.screens[index];
		const url = resolveScreenUrl(plan.base, screen.spec.url);
		if (!url || job.token.isCancellationRequested) {
			return;
		}
		const themes: (GalleryTheme | undefined)[] = plan.themes?.length ? [...plan.themes] : [undefined];
		const variantFor = (theme: GalleryTheme | undefined) => job.variants.find(variant => variant.viewport?.id === viewport.id && variant.theme === theme);
		const prefix = plan.viewports.length > 1 ? `${viewport.label}: ` : '';
		job.current = `${screen.name || screen.detail || url}${plan.viewports.length > 1 ? `, ${viewport.label}` : ''}`;
		let page;
		try {
			page = await this.preview.openPage({ url, width: viewport.width, height: viewport.height, scale: viewport.scale, mobile: viewport.mobile, scheme: themes[0] });
		} catch (err) {
			screen.errors.push(`${prefix}${errorText(err)}`);
			return;
		}
		try {
			if (!screen.name) {
				screen.name = page.title.trim().slice(0, 60) || shownPath(page.url || url, plan.base);
			}
			if (page.status && page.status >= 400) {
				job.note(screen, `HTTP ${page.status}`);
			}
			if (!page.loaded) {
				job.note(screen, 'still loading after 20s; captured as it was');
			}
			const failure = await this.webAct(job, page.id, page.url || url, screen.spec.act, screen.spec.wait, store);
			if (failure) {
				screen.errors.push(`${prefix}${failure}`);
				return;
			}
			if (collectLinks) {
				job.links = (await this.preview.evaluatePage<INavLink[]>(page.id, NAV_LINKS_SCRIPT, 5000).catch(() => undefined))?.value ?? [];
			}
			if (plan.settleMs) {
				await timeout(plan.settleMs);
			}
			const shots: { theme: GalleryTheme | undefined; dataUrl: string; width: number; height: number }[] = [];
			for (let i = 0; i < themes.length && !job.token.isCancellationRequested; i++) {
				if (i > 0) {
					await this.preview.setPageScheme(page.id, themes[i]);
					await this.preview.waitForPage(page.id, 3000);
				}
				const capture = await this.preview.capturePage(page.id, { fullPage: plan.fullPage, quality: 84 });
				shots.push({ theme: themes[i], dataUrl: `data:image/jpeg;base64,${capture.jpeg}`, width: capture.width, height: capture.height });
			}
			if (shots.length === 2 && await looksSame(shots[0].dataUrl, shots[1].dataUrl)) {
				// The page read the color scheme once, at load: load it again in the second one.
				const fresh = await this.webFresh(job, url, viewport, themes[1], screen.spec, store);
				if (fresh && !await looksSame(shots[0].dataUrl, fresh.dataUrl)) {
					shots[1] = { ...shots[1], ...fresh };
				} else {
					job.note(screen, 'looks the same in light and dark: the page ignores prefers-color-scheme (a fixed or stored theme)');
				}
			}
			for (const shot of shots) {
				this.push(job, index, variantFor(shot.theme), shot);
			}
			const errors = (await this.preview.takePageConsole(page.id).catch(() => [])).filter(message => message.level === 'error');
			if (errors.length) {
				job.note(screen, `${errors.length} console error${errors.length === 1 ? '' : 's'}, first: ${errors[0].text.replace(/\s+/g, ' ').slice(0, 160)}`);
			}
		} finally {
			void this.preview.closePage(page.id).catch(() => undefined);
		}
	}

	/** The page loaded anew in `theme` (for apps that read the scheme only when they start). */
	private async webFresh(job: ScreensJob, url: string, viewport: IScreenViewport, theme: GalleryTheme | undefined, spec: IScreenSpec, store: IFlowStore | undefined): Promise<{ dataUrl: string; width: number; height: number } | undefined> {
		try {
			const page = await this.preview.openPage({ url, width: viewport.width, height: viewport.height, scale: viewport.scale, mobile: viewport.mobile, scheme: theme });
			try {
				if (await this.webAct(job, page.id, page.url || url, spec.act, spec.wait, store)) {
					return undefined;
				}
				const capture = await this.preview.capturePage(page.id, { fullPage: job.plan.fullPage, quality: 84 });
				return { dataUrl: `data:image/jpeg;base64,${capture.jpeg}`, width: capture.width, height: capture.height };
			} finally {
				void this.preview.closePage(page.id).catch(() => undefined);
			}
		} catch {
			return undefined;
		}
	}

	//#endregion

	//#region Screens: simulators and emulators

	private async captureDevices(job: ScreensJob, call: IVoltHostToolCall | undefined): Promise<void> {
		const { plan } = job;
		const resolved = await Promise.all(plan.devices.map(device => this.devices.resolveTarget(device || undefined, plan.host, call).then(target => target, (err: unknown) => errorText(err))));
		const targets = resolved.filter((entry): entry is IDeviceTarget => typeof entry !== 'string');
		if (!targets.length) {
			throw new Error(resolved.join('\n'));
		}
		resolved.forEach((entry, index) => {
			if (typeof entry === 'string') {
				job.notes.push(`${plan.devices[index] || 'Device'}: ${entry}`);
			}
		});
		job.variants = shotVariants(plan, resolved.map(entry => typeof entry === 'string' ? '' : entry.device.name));
		job.expected = job.screens.length * job.variants.length;
		job.subtitle = targets.map(target => [target.device.name, target.device.runtime].filter(Boolean).join(' · ')).join(', ');
		await Promise.all(resolved.map((entry, index) => typeof entry === 'string' ? Promise.resolve() : this.captureDevice(job, entry, index, call)));
	}

	private async captureDevice(job: ScreensJob, target: IDeviceTarget, deviceIndex: number, call: IVoltHostToolCall | undefined): Promise<void> {
		const { plan } = job;
		const name = target.device.name;
		const prefix = plan.devices.length > 1 ? `${name}: ` : '';
		if (target.device.state !== 'booted') {
			job.notes.push(`${name} is ${target.device.state}; boot it with device_boot, then call again.`);
			return;
		}
		const themes = plan.themes?.length ? [...plan.themes] : undefined;
		const original = themes ? await this.devices.appearance(target).catch(() => undefined) : undefined;
		let current = original;
		// Android recreates the activity on a night mode change; iOS redraws in place.
		const switchMs = plan.settleMs ?? (target.device.platform === 'ios' ? 900 : 1800);
		const cwd = this.projectFolder(call);
		const act = (script: string) => this.devices.act(target, script, { vars: plan.vars, cwd, token: job.token });
		const variantFor = (theme: GalleryTheme | undefined) => job.variants.find(variant => variant.id === `d${deviceIndex}${theme ? `-${theme}` : ''}`);
		let flat = 0;
		try {
			if (plan.app) {
				await this.devices.launchApp(target, plan.app);
				await timeout(1500);
			}
			if (plan.setup) {
				const run = await act(plan.setup);
				if (!run.ok) {
					job.notes.push(`${prefix}setup failed: ${run.lines.filter(line => /FAILED|stopped/.test(line)).slice(0, 2).join(' ') || run.lines[0]}`);
					return;
				}
			}
			for (let index = 0; index < job.screens.length && !job.token.isCancellationRequested; index++) {
				const screen = job.screens[index];
				const spec = screen.spec;
				job.current = `${screen.name}${plan.devices.length > 1 ? ` on ${name}` : ''}`;
				if (spec.open) {
					screen.detail ??= spec.open;
					try {
						await this.devices.launchApp(target, spec.open);
					} catch (err) {
						screen.errors.push(`${prefix}could not open ${spec.open}: ${errorText(err)}`);
						continue;
					}
					await timeout(spec.act || spec.wait ? 700 : 1300);
				}
				const script = [spec.act, spec.wait ? waitLine(spec.wait) : undefined].filter(Boolean).join('\n');
				if (script) {
					const run = await act(script);
					if (!run.ok) {
						screen.errors.push(`${prefix}${run.lines.filter(line => /FAILED|stopped/.test(line)).slice(0, 2).join(' ') || run.lines[0] || 'the steps failed'}`);
						continue;
					}
				}
				if (plan.settleMs && !themes) {
					await timeout(plan.settleMs);
				}
				// Start in the look the device is in, and alternate, so each screen costs one switch.
				const order: (GalleryTheme | undefined)[] = !themes ? [undefined] : current && themes.includes(current) ? [current, ...themes.filter(theme => theme !== current)] : themes;
				const captured: string[] = [];
				for (const theme of order) {
					if (theme && theme !== current) {
						await this.devices.setAppearance(target, theme);
						current = theme;
						await timeout(switchMs);
					}
					const shot = await this.devices.capture(target, SHOT_MAX_SIDE);
					captured.push(shot.dataUrl);
					this.push(job, index, variantFor(theme), shot);
				}
				if (captured.length === 2 && await looksSame(captured[0], captured[1]) && flat++ === 0) {
					job.note(screen, `${prefix}looks the same in light and dark: the app may not follow the system appearance`);
				}
			}
		} finally {
			if (original && current && current !== original) {
				await this.devices.setAppearance(target, original).catch(() => undefined);
			} else if (!original && current && themes) {
				job.notes.push(`${name} was left in ${current} mode (its appearance could not be read to restore it).`);
			}
		}
	}

	//#endregion

	//#region Screens: desktop windows and files

	/** Desktop apps through the desktop_act and window_capture tools, so their approvals apply. */
	private async captureWindow(job: ScreensJob, call: IVoltHostToolCall | undefined): Promise<void> {
		const { plan } = job;
		const nested: IVoltHostToolCall = { ...call, source: 'native' };
		job.variants = shotVariants(plan);
		job.expected = job.screens.length;
		job.subtitle = plan.window ?? plan.app;
		for (let index = 0; index < job.screens.length && !job.token.isCancellationRequested; index++) {
			const screen = job.screens[index];
			const spec = screen.spec;
			job.current = screen.name;
			const app = spec.open ?? plan.app;
			if (spec.act || spec.open) {
				const result = await this.hostTools.invokeTool('desktop_act', { ...(app ? { app } : {}), script: spec.act ?? `open ${spec.open}`, observe: 'none', ...(plan.vars ? { vars: plan.vars } : {}) }, nested);
				const failed = result.error ?? (result.text ?? '').split('\n').find(line => /FAILED|stopped at step/.test(line));
				if (failed) {
					screen.errors.push(failed.slice(0, 300));
					continue;
				}
				await timeout(plan.settleMs ?? 500);
			}
			const result = await this.hostTools.invokeTool('window_capture', { ...(plan.window ? { window: plan.window } : {}), max_side: SHOT_MAX_SIDE }, nested);
			if (result.error || !result.image) {
				screen.errors.push(result.error ?? 'the window could not be captured');
				continue;
			}
			const size = /(\d+)\u00d7(\d+)/.exec(result.text ?? '');
			this.push(job, index, job.variants[0], { dataUrl: result.image, width: size ? Number(size[1]) : 1280, height: size ? Number(size[2]) : 800 });
		}
	}

	private async captureFiles(job: ScreensJob, call: IVoltHostToolCall | undefined): Promise<void> {
		job.variants = shotVariants(job.plan);
		job.expected = job.screens.length;
		const cwd = this.projectFolder(call);
		await pool(job.screens.map((screen, index) => ({ screen, index })), 4, job.token, async ({ screen, index }) => {
			const raw = screen.spec.path!;
			const uri = /^file:\/\//i.test(raw) ? URI.parse(raw) : isAbsolute(raw) ? URI.file(raw) : cwd ? joinPath(URI.file(cwd), raw) : undefined;
			if (!uri) {
				screen.errors.push(`${raw} is relative and no folder is open; pass an absolute path`);
				return;
			}
			try {
				const content = await this.fileService.readFile(uri, { limits: { size: 40 * 1024 * 1024 } });
				const ext = uri.path.slice(uri.path.lastIndexOf('.') + 1).toLowerCase();
				const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/png';
				// WebP keeps transparency and stays small.
				const shot = await scaleScreenshot(`data:${mime};base64,${encodeBase64(content.value)}`, { maxSide: SHOT_MAX_SIDE, format: 'webp', quality: 0.88 });
				this.push(job, index, job.variants[0], shot);
				job.shots[job.shots.length - 1].path = uri.fsPath;
				job.shots[job.shots.length - 1].file = uri.fsPath;
			} catch (err) {
				screen.errors.push(`could not read ${uri.fsPath}: ${errorText(err)}`);
			}
		});
	}

	//#endregion
}

