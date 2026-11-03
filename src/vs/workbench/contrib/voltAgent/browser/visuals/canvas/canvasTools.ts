/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encodeBase64 } from '../../../../../../base/common/buffer.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IVoltVisualPreviewService } from '../../../../../../platform/voltVisualPreview/common/voltVisualPreview.js';
import { CANVAS_READ_TOOL_NAME, CANVAS_RENDER_TOOL_NAME, CANVAS_UPDATE_TOOL_NAME, IVoltHostToolCall, IVoltHostToolInfo, IVoltHostToolProvider, IVoltHostToolResult, MOCKUPS_TOOL_NAME, RENDER_CHART_TOOL_NAME } from '../../../../../services/voltRuntime/common/hostTools.js';
import { IAgentRuntimeService } from '../../../../../services/voltRuntime/common/runtime.js';
import { imageMime, inlineLocalImages, localImagePaths } from '../agentVisualPage.js';
import { VisualPagePublisher } from '../visualPublisher.js';
import { CanvasTheme, describeCanvas, findFrame, ICanvasDoc, ICanvasFrame, parseCanvasArgs } from './canvasModel.js';
import { buildCanvasPage, canvasFrameDocument } from './canvasPage.js';
import { IVoltCanvasService } from './canvasService.js';
import { OPEN_CANVAS_COMMAND_ID } from './canvasCard.js';
import { CANVAS_OPEN_BESIDE_SETTING } from '../../../common/canvasScratchSettings.js';

const MIB = 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * MIB;
const MAX_PAGE_BYTES = 25 * MIB;
/** Frames an update checks for errors offscreen (the ones it touched, first). */
const MAX_CHECKED_FRAMES = 6;

const FRAME_SCHEMA = {
	type: 'object',
	properties: {
		id: { type: 'string', description: 'Stable id, e.g. "welcome"; comments, links and edits refer to it.' },
		name: { type: 'string', description: 'Shown above the frame.' },
		kind: { type: 'string', enum: ['iphone', 'android', 'tablet', 'browser', 'desktop', 'watch', 'component', 'frame'], description: 'Device and default size: iphone 393x852, android 412x915, tablet 820x1180, browser/desktop 1280x800 (with a URL bar / window title), watch 205x251, component 420 wide x content height, frame 800x600 bare.' },
		html: { type: 'string', description: 'The screen\'s body markup (or a whole document). Real UI and real copy.' },
		css: { type: 'string' },
		url: { type: 'string', description: 'A live page instead of html, e.g. http://localhost:3000/pricing.' },
		image: { type: 'string', description: 'A screenshot instead of html: an absolute image path or data URL.' },
		width: { type: 'number' },
		height: { type: 'number', description: '0: as tall as the content.' },
		section: { type: 'string', description: 'Frames in a section sit in one labeled row: a flow, "Option B", "Empty states".' },
		note: { type: 'string', description: 'One line under the frame: the idea or trade-off.' },
		recommended: { type: 'boolean' },
		theme: { type: 'string', enum: ['light', 'dark'] },
		fullbleed: { type: 'boolean', description: 'Phones: content runs under the status bar.' },
		x: { type: 'number' },
		y: { type: 'number' },
	},
};

const LINKS_SCHEMA = {
	type: 'array',
	items: {
		type: 'object',
		properties: { from: { type: 'string' }, to: { type: 'string' }, trigger: { type: 'string', description: 'CSS selector in "from" the arrow starts at.' }, label: { type: 'string' } },
		required: ['from', 'to'],
	},
};

export const CANVAS_TOOLS: readonly IVoltHostToolInfo[] = [
	{
		name: CANVAS_RENDER_TOOL_NAME,
		title: 'Designed canvas',
		group: 'visuals',
		description: `Show a design canvas in this chat: a Figma-like board of live screens the user pans and zooms, drags and resizes (screens reflow: responsive testing), clicks through as a prototype, flips light/dark, and comments on (click any element or drag over a region; their comments come back to you with ids, selectors and markup). It opens inline and the user can open it beside the chat. Use it for UI/UX work with more than one screen or size: app and onboarding flows, mobile screens (iPhone, Android, iPad), a website's pages at phone, tablet and desktop sizes, before/after, states (empty, loading, error), and variants to choose from (pick: true adds Choose to every frame; mark your pick recommended). It persists: change it later with ${CANVAS_UPDATE_TOOL_NAME} (small edits to single frames), never by calling this again. For a quick comparison of options of one component, ${MOCKUPS_TOOL_NAME} is lighter; for data, ${RENDER_CHART_TOOL_NAME}.
Frames: [{ id, name, kind, html, ... }]; positions are automatic (each section is a row, left to right). Flows: put data-next="<frame id>" on the element that leads to another screen (a button, a tab, a list row): Volt draws the arrow from it and Play follows it; or pass links.
Write each screen as finished, real UI at the frame's size with the product's real copy, fonts and colors (no lorem, no gray boxes). Phones show a 9:41 status bar and home indicator: the body is padded by var(--safe-top)/var(--safe-bottom) (fullbleed: true for edge-to-edge); put tab bars at the bottom with position:fixed. Frames are the product's own design, not Volt's theme: they open in the user's look (light or dark) unless you set theme, so style both (.dark selectors, Tailwind dark:, or prefers-color-scheme).
Say what frames share once: head (fonts; Tailwind via <script src="https://cdn.tailwindcss.com"></script>), css, and components { "tabbar": "<nav>...</nav>" } used in any frame as {{tabbar}}. Errors frames log come back in the result. Call it before your final text and do not describe the screens.`,
		inputSchema: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'What the canvas is, e.g. "Onboarding flow".' },
				subtitle: { type: 'string' },
				kind: { type: 'string', description: 'Default kind for frames that leave it out.' },
				frames: { type: 'array', minItems: 1, maxItems: 40, items: FRAME_SCHEMA },
				links: LINKS_SCHEMA,
				head: { type: 'string', description: 'Shared <head> markup: fonts, scripts.' },
				css: { type: 'string', description: 'Shared CSS.' },
				components: { type: 'object', additionalProperties: { type: 'string' }, description: 'Shared snippets, used in frames as {{name}}.' },
				theme: { type: 'string', enum: ['light', 'dark'], description: 'Fix the look; default the user\'s.' },
				pick: { type: 'boolean', description: 'A variant board: every frame gets Choose; the pick comes back as the user\'s next message.' },
				screenshot: { type: 'boolean', description: 'Also return an image of the canvas to check it.' },
			},
			required: ['title', 'frames'],
		},
	},
	{
		name: CANVAS_UPDATE_TOOL_NAME,
		title: 'Updated canvas',
		group: 'visuals',
		description: `Change a design canvas from ${CANVAS_RENDER_TOOL_NAME} in place: the user watches each changed frame cross-fade to its new version, and keeps their layout and comments. Prefer edits [{ frame, find, replace, all?, css?: true }] (exact text from the frame, unique unless all) to resending a frame. frames [{ id, ...fields }] adds a frame (new id) or changes fields of one (html replaces its markup). remove: [ids]. links replaces the arrows, addLinks adds some. head, css, components ({ name: null } deletes) change what frames share. resolve [{ comment: "c2", reply: "what you changed" }] closes comments you handled; comment [{ frame, text, selector? }] pins your own note (to explain a decision). focus: a frame id to bring into view; layout: "auto" lays every frame out again; pick turns Choose on or off. canvas is the id ${CANVAS_RENDER_TOOL_NAME} returned (default: this chat's latest). screenshot: a frame id returns its image. All or nothing: on an error nothing changes.`,
		inputSchema: {
			type: 'object',
			properties: {
				canvas: { type: 'string', description: 'Canvas id, e.g. "cv-1a2b3c4d".' },
				edits: {
					type: 'array',
					items: {
						type: 'object',
						properties: { frame: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' }, all: { type: 'boolean' }, css: { type: 'boolean', description: 'Edit the frame\'s css instead of its html.' } },
						required: ['frame', 'find', 'replace'],
					},
				},
				frames: { type: 'array', items: FRAME_SCHEMA },
				remove: { type: 'array', items: { type: 'string' } },
				links: LINKS_SCHEMA,
				addLinks: LINKS_SCHEMA,
				head: { type: 'string' },
				css: { type: 'string' },
				components: { type: 'object' },
				resolve: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { comment: { type: 'string' }, reply: { type: 'string' } }, required: ['comment'] }] } },
				comment: { type: 'array', items: { type: 'object', properties: { frame: { type: 'string' }, text: { type: 'string' }, selector: { type: 'string' } }, required: ['frame', 'text'] } },
				title: { type: 'string' },
				subtitle: { type: 'string' },
				theme: { type: 'string', enum: ['light', 'dark'] },
				pick: { type: 'boolean' },
				focus: { type: 'string' },
				layout: { type: 'string', enum: ['auto'] },
				screenshot: { type: 'string', description: 'A frame id: return its image after the change.' },
			},
		},
	},
	{
		name: CANVAS_READ_TOOL_NAME,
		title: 'Read canvas',
		group: 'visuals',
		description: `Read a design canvas: its frames (ids, kinds, sizes as the user left them, sections), links and open comments with their selectors. frames: [ids] or "all" adds their markup and the shared css (read a frame before editing it if you did not write it this turn). screenshot: a frame id returns its image. canvas defaults to this chat's latest.`,
		inputSchema: {
			type: 'object',
			properties: {
				canvas: { type: 'string' },
				frames: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string', enum: ['all'] }] },
				screenshot: { type: 'string' },
			},
		},
	},
];

function formatMib(bytes: number): string {
	return `${(bytes / MIB).toFixed(1)} MiB`;
}

/** Serves canvas_render, canvas_update and canvas_read on Volt's MCP server. */
export class AgentCanvasToolProvider extends Disposable implements IVoltHostToolProvider {

	readonly tools = CANVAS_TOOLS;
	private readonly publisher: VisualPagePublisher;

	constructor(
		@IVoltCanvasService private readonly canvas: IVoltCanvasService,
		@IVoltVisualPreviewService private readonly preview: IVoltVisualPreviewService,
		@IFileService private readonly fileService: IFileService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.publisher = this._register(instantiationService.createInstance(VisualPagePublisher));
	}

	async invoke(name: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		try {
			switch (name) {
				case CANVAS_RENDER_TOOL_NAME: return await this.render(args, call);
				case CANVAS_UPDATE_TOOL_NAME: return await this.update(args, call);
				case CANVAS_READ_TOOL_NAME: return await this.read(args, call);
			}
			return { error: `Unknown tool ${name}` };
		} catch (err) {
			this.logService.warn(`[volt] ${name} failed`, err);
			return { error: err instanceof Error ? err.message : String(err) };
		}
	}

	private chatOf(call: IVoltHostToolCall | undefined): string | undefined {
		return call?.sessionId ? this.runtime.chatFor(call.sessionId) : undefined;
	}

	private async resolve(args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<ICanvasDoc | { readonly error: string }> {
		const id = typeof args.canvas === 'string' && args.canvas.trim() ? args.canvas.trim() : typeof args.id === 'string' ? args.id.trim() : '';
		const doc = id ? await this.canvas.get(id) : await this.canvas.latestFor(this.chatOf(call));
		if (!doc) {
			return { error: id ? `No canvas "${id}". Pass the id ${CANVAS_RENDER_TOOL_NAME} returned (cv-...).` : `This chat has no canvas yet: make one with ${CANVAS_RENDER_TOOL_NAME}.` };
		}
		return doc;
	}

	private async render(args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const parsed = parseCanvasArgs(args);
		if ('error' in parsed) {
			return { error: parsed.error };
		}
		const frames: ICanvasFrame[] = [];
		const missing: string[] = [];
		for (const frame of parsed.frames) {
			const embedded = await this.embed(frame);
			if ('error' in embedded) {
				return { error: embedded.error };
			}
			missing.push(...embedded.missing);
			frames.push(embedded.frame);
		}
		if (missing.length) {
			return { error: `These local images could not be read: ${missing.join(', ')}. Use absolute paths to existing image files, or remove them.` };
		}
		const doc = await this.canvas.create({ ...parsed, frames }, this.chatOf(call));
		const page = buildCanvasPage(this.canvas.pageData(doc, 'inline'));
		if (page.length > MAX_PAGE_BYTES) {
			return { error: `With its images the canvas is ${formatMib(page.length)}; the limit is ${formatMib(MAX_PAGE_BYTES)}. Use smaller images.` };
		}
		const published = await this.publisher.publish(page, doc.title, { screenshot: args.screenshot === true });
		const errors = published.errors.filter(error => error.startsWith('[frame ') || !/^Uncaught /.test(error));
		if (this.configurationService.getValue(CANVAS_OPEN_BESIDE_SETTING) === true) {
			void this.commandService.executeCommand(OPEN_CANVAS_COMMAND_ID, doc.id).catch(err => this.logService.warn('[volt] could not open the canvas beside the chat', err));
		}
		const lines = [
			`Shown to the user above your reply: design canvas ${doc.id} "${doc.title}" v${doc.version} with ${doc.frames.length} frame${doc.frames.length === 1 ? '' : 's'} (${doc.frames.map(frame => `${frame.id} ${frame.kind} ${frame.width}x${frame.height || 'auto'}`).join(', ')}). The user can move, resize, play and comment on it, and open it beside the chat; their comments arrive as a message with comment ids. Change it with ${CANVAS_UPDATE_TOOL_NAME} {"canvas": "${doc.id}", ...}: edits for small changes, never a new canvas. Do not describe the screens; end your turn with at most one short line.`,
		];
		if (errors.length) {
			lines.push(`But ${errors.length === 1 ? 'an error was' : `${errors.length} errors were`} logged while the frames loaded, so some may look broken. Fix them with ${CANVAS_UPDATE_TOOL_NAME}:`, ...errors.slice(0, 8).map(error => `- ${error.slice(0, 500)}`));
		}
		return {
			text: lines.join('\n'),
			visual: { ...published.visual, canvas: doc.id },
			...(published.png ? { image: `data:image/png;base64,${published.png}` } : {}),
		};
	}

	private async update(args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const found = await this.resolve(args, call);
		if ('error' in found) {
			return { error: found.error };
		}
		// Local images in new or changed frames are embedded before the change is applied.
		let prepared = args;
		if (Array.isArray(args.frames)) {
			const frames: unknown[] = [];
			for (const raw of args.frames) {
				if (raw && typeof raw === 'object') {
					const embedded = await this.embed(raw as ICanvasFrame);
					if ('error' in embedded) {
						return { error: embedded.error };
					}
					if (embedded.missing.length) {
						return { error: `These local images could not be read: ${embedded.missing.join(', ')}.` };
					}
					frames.push(embedded.frame);
				} else {
					frames.push(raw);
				}
			}
			prepared = { ...args, frames };
		}
		const result = await this.canvas.update(found.id, prepared);
		if ('error' in result) {
			return { error: result.error };
		}
		const doc = result.doc;
		const errors = await this.check(doc, result.touched);
		const lines = [`Canvas ${doc.id} is now v${doc.version}: ${result.changes.join('; ') || 'no change'}. The user sees it live.`];
		const open = doc.comments.filter(comment => comment.status !== 'resolved' && comment.author === 'user');
		if (open.length) {
			lines.push(`Still open: ${open.map(comment => `${comment.id} (${comment.text.replace(/\s+/g, ' ').slice(0, 80)})`).join('; ')}.`);
		}
		if (errors.length) {
			lines.push('Errors the changed frames logged; fix them:', ...errors.slice(0, 8).map(error => `- ${error.slice(0, 500)}`));
		}
		const image = typeof args.screenshot === 'string' ? await this.shoot(doc, args.screenshot) : undefined;
		const framesChanged = result.touched.length > 0 || result.changes.some(change => /^(added|removed) /.test(change));
		return {
			text: lines.join('\n'),
			...(image ? { image } : {}),
			...(framesChanged ? { visual: { kind: 'canvas' as const, ref: `volt-canvas:${doc.id}@${doc.version}`, title: doc.title, canvas: doc.id, detail: result.changes.join(' \u00b7 ').slice(0, 200) } } : {}),
		};
	}

	private async read(args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const found = await this.resolve(args, call);
		if ('error' in found) {
			return { error: found.error };
		}
		const wanted = args.frames === 'all' ? undefined : Array.isArray(args.frames) ? args.frames.filter((frame): frame is string => typeof frame === 'string') : typeof args.frames === 'string' ? [args.frames] : [];
		const text = describeCanvas(found, args.frames === 'all' ? { all: true } : { frames: wanted });
		const image = typeof args.screenshot === 'string' ? await this.shoot(found, args.screenshot) : undefined;
		return { text, ...(image ? { image } : {}) };
	}

	/** The look a frame opens in when nothing sets it. */
	private lookOf(doc: ICanvasDoc, frame: ICanvasFrame): CanvasTheme {
		return frame.theme ?? doc.theme ?? this.canvas.defaultLook();
	}

	/** Loads each touched frame offscreen and returns the errors it logged. */
	private async check(doc: ICanvasDoc, touched: readonly string[]): Promise<string[]> {
		const frames = touched.map(id => doc.frames.find(frame => frame.id === id)).filter((frame): frame is ICanvasFrame => !!frame && !!frame.html).slice(0, MAX_CHECKED_FRAMES);
		const results = await Promise.all(frames.map(async frame => {
			try {
				const shot = await this.preview.capture({ html: canvasFrameDocument(doc, frame, this.lookOf(doc, frame)), width: frame.width, measureOnly: true });
				return shot.console.filter(message => message.level === 'error').map(message => message.text);
			} catch (err) {
				this.logService.trace('[volt canvas] could not check a frame', err);
				return [];
			}
		}));
		return results.flat();
	}

	private async shoot(doc: ICanvasDoc, ref: string): Promise<string | undefined> {
		const frame = findFrame(doc, ref);
		if (!frame?.html) {
			return frame?.image;
		}
		const look = this.lookOf(doc, frame);
		try {
			const shot = await this.preview.capture({ html: canvasFrameDocument(doc, frame, look), width: frame.width, background: look === 'dark' ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 } });
			return shot.png ? `data:image/png;base64,${shot.png}` : undefined;
		} catch (err) {
			this.logService.trace('[volt canvas] could not screenshot a frame', err);
			return undefined;
		}
	}

	/** A frame with its local images (an `image` path, `src="/abs/x.png"` in its markup) embedded. */
	private async embed(frame: ICanvasFrame): Promise<{ readonly frame: ICanvasFrame; readonly missing: readonly string[] } | { readonly error: string }> {
		const missing: string[] = [];
		let image = frame.image;
		if (image && !/^(data:|https?:)/i.test(image)) {
			const data = await this.readImage(image);
			if (typeof data === 'object') {
				return data;
			}
			if (data === undefined) {
				missing.push(image);
			} else {
				image = data;
			}
		}
		let html = frame.html;
		if (html) {
			const images = new Map<string, string>();
			for (const raw of localImagePaths(html).slice(0, 60)) {
				const data = await this.readImage(raw.replace(/^file:\/\//i, ''));
				if (typeof data === 'object') {
					return data;
				}
				if (data === undefined) {
					missing.push(raw);
				} else {
					images.set(raw, data);
				}
			}
			if (images.size) {
				html = inlineLocalImages(html, images);
			}
		}
		return { frame: { ...frame, ...(image !== undefined ? { image } : {}), ...(html !== undefined ? { html } : {}) }, missing };
	}

	private async readImage(path: string): Promise<string | undefined | { readonly error: string }> {
		const mime = imageMime(path);
		if (!mime || !path.startsWith('/')) {
			return undefined;
		}
		try {
			const resource = URI.file(decodeURIComponent(path));
			const stat = await this.fileService.stat(resource);
			if (stat.size !== undefined && stat.size > MAX_IMAGE_BYTES) {
				return { error: `${path} is ${formatMib(stat.size)}; each image must be at most ${formatMib(MAX_IMAGE_BYTES)}.` };
			}
			const content = await this.fileService.readFile(resource);
			return `data:${mime};base64,${encodeBase64(content.value)}`;
		} catch {
			return undefined;
		}
	}
}
