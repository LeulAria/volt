/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../../base/common/resources.js';
import { URI } from '../../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { localize } from '../../../../../../nls.js';
import { IClipboardService } from '../../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IEnvironmentService } from '../../../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { IPageChannelPort, registerPageChannel, setPageContext } from '../agentVisualBridge.js';
import { themeKind } from '../agentVisuals.js';
import { OPEN_CANVAS_COMMAND_ID } from './canvasCard.js';
import { applyCanvasLayout, applyCanvasUpdate, CANVAS_SIZE_PRESETS, canvasFromMockups, CanvasCommentStatus, formatCanvasChoice, formatCanvasFeedback, ICanvasAnchor, ICanvasCreate, ICanvasDoc, ICanvasLayout, ICanvasTweak, ICanvasUpdateResult, removeCanvasComment, upsertCanvasComment } from './canvasModel.js';
import { ICanvasPageData, ICanvasStrings } from './canvasPage.js';

export const IVoltCanvasService = createDecorator<IVoltCanvasService>('voltCanvasService');

export type CanvasChangeKind = 'doc' | 'layout' | 'comments';

export interface ICanvasChange {
	readonly id: string;
	readonly doc: ICanvasDoc;
	readonly kind: CanvasChangeKind;
	readonly origin: 'agent' | 'user';
	/** The frame the agent wants the views to show. */
	readonly focus?: string;
}

/**
 * The design canvases: their documents (frames, links, the user's layout and comments), kept on
 * disk next to the chat history, and every view of them (inline in a chat, a tab beside it) in
 * step. Views talk to it over the `canvas` page channel.
 */
export interface IVoltCanvasService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<ICanvasChange>;
	create(input: ICanvasCreate, chat: string | undefined): Promise<ICanvasDoc>;
	/** A canvas from memory or disk. */
	get(id: string): Promise<ICanvasDoc | undefined>;
	/** The canvas a chat made last (for calls that leave out the id). */
	latestFor(chat: string | undefined): Promise<ICanvasDoc | undefined>;
	/** canvas_update's arguments applied, or what is wrong with them. */
	update(id: string, args: Record<string, unknown>): Promise<ICanvasUpdateResult | { readonly error: string }>;
	/** The canvas as the agent left it at `version` (the chat's history shows each one); the current one when that is it. */
	getVersion(id: string, version: number): Promise<ICanvasDoc | undefined>;
	/** The canvases a chat made, newest first. */
	listFor(chat: string): Promise<readonly ICanvasDoc[]>;
	/** The canvas's own agent chat, made the first time it is asked for. */
	ensureAgentChat(id: string): Promise<string>;
	/** Whether `sessionId` is the agent chat of canvas `id` (from memory: a canvas in view is). */
	isAgentChat(id: string, sessionId: string): boolean;
	/**
	 * The canvas's agent, shown in its sidebar: every prompt about the canvas (comments, "Ask",
	 * "Design the next screen", a variant's Choose) goes to it instead of the chat the canvas is in.
	 */
	registerAgent(id: string, agent: ICanvasAgentPort): IDisposable;
	/** The page data for a view of `doc`. `pinned`: a view in the chat's history, kept at its version. */
	pageData(doc: ICanvasDoc, mode: 'inline' | 'panel', focus?: string, pinned?: boolean): ICanvasPageData;
	/** Handles a message a canvas view posted. */
	handle(port: IPageChannelPort, payload: unknown): void;
}

export interface ICanvasAgentPort {
	/** The agent's chat. */
	readonly sessionId: string;
	/** Sends `text` to the agent now (`send`), or puts it in its composer. */
	prompt(text: string, send: boolean): void;
}

interface ICanvasPayload {
	readonly pinned?: unknown;
	readonly op?: unknown;
	readonly id?: unknown;
	readonly version?: unknown;
	readonly updatedAt?: unknown;
	readonly frames?: unknown;
	readonly comment?: unknown;
	readonly comments?: unknown;
	readonly nonce?: unknown;
	readonly send?: unknown;
	readonly note?: unknown;
	readonly text?: unknown;
	readonly anchor?: unknown;
	readonly frame?: unknown;
	readonly mockups?: unknown;
}

const MAX_MEMORY = 24;

export function canvasStrings(): ICanvasStrings {
	return {
		move: localize('voltCanvas.move', "Move"),
		hand: localize('voltCanvas.hand', "Hand"),
		comment: localize('voltCanvas.comment', "Comment"),
		play: localize('voltCanvas.play', "Play prototype"),
		playShort: localize('voltCanvas.playShort', "Play"),
		zoomIn: localize('voltCanvas.zoomIn', "Zoom In"),
		zoomOut: localize('voltCanvas.zoomOut', "Zoom Out"),
		fit: localize('voltCanvas.fit', "Zoom to Fit"),
		zoom100: localize('voltCanvas.zoom100', "Zoom to 100%"),
		zoomSelection: localize('voltCanvas.zoomSelection', "Zoom to Selection"),
		light: localize('voltCanvas.light', "Light"),
		dark: localize('voltCanvas.dark', "Dark"),
		devices: localize('voltCanvas.devices', "Device Frames"),
		flows: localize('voltCanvas.flows', "Flow Arrows"),
		minimap: localize('voltCanvas.minimap', "Minimap"),
		layers: localize('voltCanvas.layers', "Frames"),
		comments: localize('voltCanvas.comments', "Comments"),
		openPanel: localize('voltCanvas.openPanel', "Open"),
		frameCount: localize('voltCanvas.frameCount', "{0} frames"),
		version: localize('voltCanvas.version', "v{0}"),
		updated: localize('voltCanvas.updated', "Updated {0}"),
		addComment: localize('voltCanvas.addComment', "Add a comment or ask a question\u2026"),
		commentHint: localize('voltCanvas.commentHint', "Enter adds it to the batch \u00b7 \u2318Enter sends it now"),
		add: localize('voltCanvas.add', "Add"),
		sendNow: localize('voltCanvas.sendNow', "Send"),
		sendAll: localize('voltCanvas.sendAll', "Send {0} to Agent"),
		cancel: localize('voltCanvas.cancel', "Cancel"),
		resolve: localize('voltCanvas.resolve', "Resolve"),
		reopen: localize('voltCanvas.reopen', "Reopen"),
		remove: localize('voltCanvas.remove', "Delete"),
		edit: localize('voltCanvas.edit', "Edit"),
		style: localize('voltCanvas.style', "Style"),
		reset: localize('voltCanvas.reset', "Reset"),
		text: localize('voltCanvas.text', "Text"),
		color: localize('voltCanvas.color', "Color"),
		background: localize('voltCanvas.background', "Fill"),
		fontSize: localize('voltCanvas.fontSize', "Size"),
		fontWeight: localize('voltCanvas.fontWeight', "Weight"),
		radius: localize('voltCanvas.radius', "Radius"),
		padding: localize('voltCanvas.padding', "Padding"),
		parent: localize('voltCanvas.parent', "Select Parent"),
		askInChat: localize('voltCanvas.askInChat', "Ask in Chat"),
		askPrompt: localize('voltCanvas.askPrompt', "About {0} on the canvas \"{1}\": "),
		nextScreen: localize('voltCanvas.nextScreen', "Design the Next Screen"),
		nextScreenPrompt: localize('voltCanvas.nextScreenPrompt', "On the canvas \"{0}\", design the screen that comes after {1}, add it next to it and link it: "),
		variations: localize('voltCanvas.variations', "Make Variations"),
		variationsPrompt: localize('voltCanvas.variationsPrompt', "Make 3 genuinely different variations of {0} on the canvas \"{1}\", side by side in a new section, and recommend one: "),
		copyHtml: localize('voltCanvas.copyHtml', "Copy HTML"),
		copied: localize('voltCanvas.copied', "Copied"),
		choose: localize('voltCanvas.choose', "Choose"),
		chosen: localize('voltCanvas.chosen', "Chosen"),
		recommended: localize('voltCanvas.recommended', "Recommended"),
		agent: localize('voltCanvas.agent', "Agent"),
		you: localize('voltCanvas.you', "You"),
		sent: localize('voltCanvas.sent', "Sent"),
		resolved: localize('voltCanvas.resolved', "Resolved"),
		outdated: localize('voltCanvas.outdated', "Moved or removed"),
		showResolved: localize('voltCanvas.showResolved', "Resolved"),
		noComments: localize('voltCanvas.noComments', "No comments yet. Press C, then click anything in a screen (or drag over a region) to comment on it."),
		ready: localize('voltCanvas.ready', "{0} ready"),
		clear: localize('voltCanvas.clear', "Clear"),
		notePlaceholder: localize('voltCanvas.notePlaceholder', "Add a note for the agent (optional)"),
		back: localize('voltCanvas.back', "Back"),
		playHint: localize('voltCanvas.playHint', "Click through the screens \u00b7 Esc to stop"),
		commentModeHint: localize('voltCanvas.commentModeHint', "Click an element, or drag over a region, to comment"),
		scrollHint: localize('voltCanvas.scrollHint', "Click the canvas to pan with scroll \u00b7 \u2318 scroll to zoom"),
		undo: localize('voltCanvas.undo', "Undo"),
		redo: localize('voltCanvas.redo', "Redo"),
		size: localize('voltCanvas.size', "Frame size"),
		live: localize('voltCanvas.live', "Live"),
		region: localize('voltCanvas.region', "Region {0}"),
		close: localize('voltCanvas.close', "Close"),
		frames: localize('voltCanvas.frames', "Frames"),
		custom: localize('voltCanvas.custom', "Custom"),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asText(value: unknown, max: number): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

export class VoltCanvasService extends Disposable implements IVoltCanvasService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<ICanvasChange>());
	readonly onDidChange = this._onDidChange.event;

	private readonly folder: URI;
	private readonly docs = new Map<string, ICanvasDoc>();
	private readonly loading = new Map<string, Promise<ICanvasDoc | undefined>>();
	private readonly latest = new Map<string, string>();
	/** Views of each canvas, by canvas id. */
	private readonly views = new Map<string, Map<string, IPageChannelPort>>();
	/** The chat view a canvas was last seen in: its prompts go there (the tab has no composer). */
	private readonly chatPorts = new Map<string, IPageChannelPort>();
	private readonly saves = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly agents = new Map<string, ICanvasAgentPort>();
	/** Prompts for a canvas whose agent is still opening (its tab was just asked for). */
	private readonly waiting = new Map<string, { text: string; send: boolean }[]>();
	/** Every stored canvas: id → the chat that made it, for the Designs list. */
	private index: Promise<Map<string, string | undefined>> | undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@IThemeService private readonly themeService: IThemeService,
		@ICommandService private readonly commandService: ICommandService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.folder = joinPath(environmentService.userRoamingDataHome, 'agentSessions', 'canvases');
		this._register(registerPageChannel('canvas', (port, payload) => this.handle(port, payload)));
		this._register(toDisposable(() => {
			for (const [id, timer] of this.saves) {
				clearTimeout(timer);
				const doc = this.docs.get(id);
				if (doc) {
					void this.write(doc);
				}
			}
			this.saves.clear();
		}));
	}

	//#region Documents

	async create(input: ICanvasCreate, chat: string | undefined): Promise<ICanvasDoc> {
		const now = Date.now();
		const doc: ICanvasDoc = {
			id: `cv-${generateUuid().replace(/-/g, '').slice(0, 8)}`,
			...input,
			version: 1,
			comments: [],
			...(chat ? { chat } : {}),
			createdAt: now,
			updatedAt: now,
		};
		this.remember(doc);
		if (chat) {
			this.latest.set(chat, doc.id);
		}
		await this.write(doc);
		void this.writeVersion(doc);
		void this.index?.then(index => index.set(doc.id, chat));
		this._onDidChange.fire({ id: doc.id, doc, kind: 'doc', origin: 'agent' });
		return doc;
	}

	async getVersion(id: string, version: number): Promise<ICanvasDoc | undefined> {
		const current = await this.get(id);
		if (!current || current.version === version) {
			return current;
		}
		try {
			const content = await this.fileService.readFile(this.versionOf(id, version));
			const doc = JSON.parse(content.value.toString()) as ICanvasDoc;
			return doc?.id === id && Array.isArray(doc.frames) ? { ...doc, comments: current.comments } : undefined;
		} catch {
			return undefined;
		}
	}

	async listFor(chat: string): Promise<readonly ICanvasDoc[]> {
		this.index ??= this.readIndex();
		const index = await this.index;
		const ids = [...index].filter(([, owner]) => owner === chat).map(([id]) => id);
		const docs = await Promise.all(ids.map(id => this.get(id)));
		return docs.filter((doc): doc is ICanvasDoc => !!doc).sort((a, b) => b.updatedAt - a.updatedAt);
	}

	private async readIndex(): Promise<Map<string, string | undefined>> {
		const index = new Map<string, string | undefined>();
		try {
			const folder = await this.fileService.resolve(this.folder);
			await Promise.all((folder.children ?? []).filter(child => !child.isDirectory && /^cv-[a-z0-9]+\.json$/i.test(child.name)).map(async child => {
				const id = child.name.slice(0, -5);
				const known = this.docs.get(id);
				if (known) {
					index.set(id, known.chat);
					return;
				}
				try {
					const content = await this.fileService.readFile(child.resource);
					const doc = JSON.parse(content.value.toString()) as ICanvasDoc;
					index.set(id, typeof doc?.chat === 'string' ? doc.chat : undefined);
				} catch {
					// unreadable: not listed
				}
			}));
		} catch {
			// no canvases yet
		}
		return index;
	}

	async ensureAgentChat(id: string): Promise<string> {
		const doc = await this.get(id);
		if (!doc) {
			throw new Error(`No canvas ${id}`);
		}
		if (doc.agentChat) {
			return doc.agentChat;
		}
		const agentChat = `agent-${generateUuid()}`;
		this.commit({ ...doc, agentChat }, 'comments', 'user');
		return agentChat;
	}

	isAgentChat(id: string, sessionId: string): boolean {
		return this.docs.get(id)?.agentChat === sessionId || this.agents.get(id)?.sessionId === sessionId;
	}

	registerAgent(id: string, agent: ICanvasAgentPort): IDisposable {
		this.agents.set(id, agent);
		// Its chat changes this canvas when a call leaves the id out.
		this.latest.set(agent.sessionId, id);
		for (const entry of this.waiting.get(id)?.splice(0) ?? []) {
			agent.prompt(entry.text, entry.send);
		}
		this.waiting.delete(id);
		return toDisposable(() => {
			if (this.agents.get(id) === agent) {
				this.agents.delete(id);
			}
		});
	}

	async get(id: string): Promise<ICanvasDoc | undefined> {
		const known = this.docs.get(id);
		if (known) {
			return known;
		}
		if (!/^cv-[a-z0-9]{4,16}$/i.test(id)) {
			return undefined;
		}
		let pending = this.loading.get(id);
		if (!pending) {
			pending = this.fileService.readFile(this.fileOf(id)).then(content => {
				const doc = JSON.parse(content.value.toString()) as ICanvasDoc;
				if (!doc || doc.id !== id || !Array.isArray(doc.frames)) {
					return undefined;
				}
				// A view may have remembered it while it loaded.
				const current = this.docs.get(id);
				if (current) {
					return current;
				}
				this.remember(doc);
				return doc;
			}, () => undefined).finally(() => this.loading.delete(id));
			this.loading.set(id, pending);
		}
		return pending;
	}

	async latestFor(chat: string | undefined): Promise<ICanvasDoc | undefined> {
		const id = chat ? this.latest.get(chat) : undefined;
		if (id) {
			return this.get(id);
		}
		// Not made in this window's lifetime: the newest one this chat made, from memory.
		let best: ICanvasDoc | undefined;
		for (const doc of this.docs.values()) {
			if (doc.chat === chat && (!best || doc.updatedAt > best.updatedAt)) {
				best = doc;
			}
		}
		return best;
	}

	async update(id: string, args: Record<string, unknown>): Promise<ICanvasUpdateResult | { readonly error: string }> {
		const doc = await this.get(id);
		if (!doc) {
			return { error: `No canvas ${id}. Make one with canvas_render.` };
		}
		const result = applyCanvasUpdate(doc, args);
		if ('error' in result) {
			return result;
		}
		const focus = typeof args.focus === 'string' ? args.focus : undefined;
		this.commit(result.doc, 'doc', 'agent', focus);
		void this.writeVersion(result.doc);
		if (result.doc.chat) {
			this.latest.set(result.doc.chat, result.doc.id);
		}
		return result;
	}

	private remember(doc: ICanvasDoc): void {
		this.docs.delete(doc.id);
		this.docs.set(doc.id, doc);
		while (this.docs.size > MAX_MEMORY) {
			const oldest = this.docs.keys().next().value!;
			if (this.views.get(oldest)?.size || this.saves.has(oldest)) {
				// In view or not saved yet: keep it, try the next oldest later.
				break;
			}
			this.docs.delete(oldest);
		}
	}

	/** Stores `doc`, tells every view and listener, and saves it shortly. */
	private commit(doc: ICanvasDoc, kind: CanvasChangeKind, origin: 'agent' | 'user', focus?: string, except?: string): void {
		this.remember(doc);
		this.scheduleSave(doc.id);
		this.broadcast(doc, kind, origin, focus, except);
		this._onDidChange.fire({ id: doc.id, doc, kind, origin, ...(focus ? { focus } : {}) });
	}

	private broadcast(doc: ICanvasDoc, kind: CanvasChangeKind, origin: 'agent' | 'user', focus?: string, except?: string): void {
		const message = kind === 'doc'
			? { type: 'volt-canvas', op: 'doc', id: doc.id, doc, origin, ...(focus ? { frame: focus } : {}) }
			: kind === 'layout'
				? { type: 'volt-canvas', op: 'layout', id: doc.id, frames: doc.frames.map(frame => ({ id: frame.id, x: frame.x ?? 0, y: frame.y ?? 0, width: frame.width, height: frame.height })) }
				: { type: 'volt-canvas', op: 'comments', id: doc.id, comments: doc.comments };
		for (const port of this.views.get(doc.id)?.values() ?? []) {
			if (port.id !== except) {
				port.post(message);
			}
		}
	}

	private fileOf(id: string): URI {
		return joinPath(this.folder, `${id}.json`);
	}

	private versionOf(id: string, version: number): URI {
		return joinPath(this.folder, 'versions', `${id}@${version}.json`);
	}

	/** Keeps the canvas as this agent change left it, for the chat's history (comments are not kept). */
	private async writeVersion(doc: ICanvasDoc): Promise<void> {
		try {
			await this.fileService.writeFile(this.versionOf(doc.id, doc.version), VSBuffer.fromString(JSON.stringify({ ...doc, comments: [] })));
		} catch (err) {
			this.logService.warn(`[volt canvas] could not keep ${doc.id} v${doc.version}`, err);
		}
	}

	private scheduleSave(id: string): void {
		const previous = this.saves.get(id);
		if (previous) {
			clearTimeout(previous);
		}
		this.saves.set(id, setTimeout(() => {
			this.saves.delete(id);
			const doc = this.docs.get(id);
			if (doc) {
				void this.write(doc);
			}
		}, 600));
	}

	private async write(doc: ICanvasDoc): Promise<void> {
		try {
			await this.fileService.writeFile(this.fileOf(doc.id), VSBuffer.fromString(JSON.stringify(doc)));
		} catch (err) {
			this.logService.warn(`[volt canvas] could not save ${doc.id}`, err);
		}
	}

	//#endregion

	//#region Views

	pageData(doc: ICanvasDoc, mode: 'inline' | 'panel', focus?: string, pinned?: boolean): ICanvasPageData {
		return {
			doc,
			mode,
			...(pinned ? { pinned: true } : {}),
			theme: themeKind(this.themeService.getColorTheme()),
			strings: canvasStrings(),
			presets: CANVAS_SIZE_PRESETS,
			...(focus ? { focus } : {}),
		};
	}

	handle(port: IPageChannelPort, raw: unknown): void {
		if (!isRecord(raw)) {
			return;
		}
		const payload = raw as ICanvasPayload;
		if (payload.op === 'import') {
			void this.importMockups(port, payload.mockups);
			return;
		}
		const id = asText(payload.id, 40);
		if (!id) {
			return;
		}
		this.track(port, id);
		void this.get(id).then(doc => {
			if (doc) {
				this.dispatch(port, doc, payload);
			}
		});
	}

	/** Remembers the view (and, for a chat view, where prompts go) until it goes away. */
	private track(port: IPageChannelPort, id: string): void {
		let views = this.views.get(id);
		if (!views) {
			views = new Map();
			this.views.set(id, views);
		}
		if (!views.has(port.id)) {
			views.set(port.id, port);
			port.onDispose(() => {
				views.delete(port.id);
				if (!views.size) {
					this.views.delete(id);
				}
				if (this.chatPorts.get(id) === port) {
					this.chatPorts.delete(id);
				}
			});
		}
		if (port.prompt && port.sessionId) {
			this.chatPorts.set(id, port);
		}
	}

	private dispatch(port: IPageChannelPort, doc: ICanvasDoc, payload: ICanvasPayload): void {
		switch (payload.op) {
			case 'hello':
				// A view in the chat's history keeps its version: it only gets the comments.
				if (payload.pinned === true) {
					if (doc.comments.length) {
						port.post({ type: 'volt-canvas', op: 'comments', id: doc.id, comments: doc.comments });
					}
					return;
				}
				// A view opened (or came back): bring it up to date if the canvas moved on since its copy.
				if (payload.version !== doc.version || doc.comments.length || doc.updatedAt !== doc.createdAt) {
					port.post({ type: 'volt-canvas', op: 'doc', id: doc.id, doc, origin: 'user' });
				}
				return;
			case 'layout': {
				const layout = Array.isArray(payload.frames) ? (payload.frames as ICanvasLayout[]).filter(entry => isRecord(entry) && typeof entry.id === 'string') : [];
				const next = applyCanvasLayout(doc, layout);
				if (next !== doc) {
					this.commit(next, 'layout', 'user', undefined, port.id);
				}
				return;
			}
			case 'select':
				this.shareSelection(port, doc, Array.isArray(payload.frames) ? payload.frames.filter((frame): frame is string => typeof frame === 'string') : []);
				return;
			case 'comment':
				this.saveComment(port, doc, payload);
				return;
			case 'comment-delete': {
				const commentId = isRecord(payload.comment) ? asText(payload.comment.id, 20) : asText(payload.comment, 20);
				if (commentId) {
					const next = removeCanvasComment(doc, commentId);
					if (next !== doc) {
						this.commit(next, 'comments', 'user');
					}
				}
				return;
			}
			case 'send': {
				const ids = Array.isArray(payload.comments) ? payload.comments.filter((comment): comment is string => typeof comment === 'string') : [];
				this.sendFeedback(port, doc, ids, asText(payload.note, 4000));
				return;
			}
			case 'prompt': {
				const text = asText(payload.text, 4000);
				if (text) {
					if (isRecord(payload.anchor)) {
						this.shareAnchor(port, doc, payload.anchor as unknown as ICanvasAnchor);
					}
					this.prompt(port, doc, `${text}${text.endsWith(' ') ? '' : ' '}`, false);
				}
				return;
			}
			case 'choose': {
				const frame = asText(payload.frame, 60);
				if (frame && doc.frames.some(other => other.id === frame)) {
					this.prompt(port, doc, formatCanvasChoice(doc, frame), port.focused());
				}
				return;
			}
			case 'open': {
				const frame = asText(payload.frame, 60);
				void this.commandService.executeCommand(OPEN_CANVAS_COMMAND_ID, doc.id, frame);
				return;
			}
			case 'copy': {
				const frame = doc.frames.find(other => other.id === payload.frame);
				if (frame?.html) {
					const css = [doc.css, frame.css].filter(Boolean).join('\n');
					void this.clipboardService.writeText(css ? `<style>\n${css}\n</style>\n${frame.html}` : frame.html);
				}
				return;
			}
		}
	}

	private saveComment(port: IPageChannelPort, doc: ICanvasDoc, payload: ICanvasPayload): void {
		if (!isRecord(payload.comment)) {
			return;
		}
		const raw = payload.comment;
		const status = raw.status === 'open' || raw.status === 'sent' || raw.status === 'resolved' ? raw.status as CanvasCommentStatus : undefined;
		const tweaks = Array.isArray(raw.tweaks) ? (raw.tweaks as ICanvasTweak[]).filter(tweak => isRecord(tweak) && typeof tweak.property === 'string' && typeof tweak.value === 'string') : undefined;
		const result = upsertCanvasComment(doc, {
			...(typeof raw.id === 'string' ? { id: raw.id } : {}),
			...(isRecord(raw.anchor) ? { anchor: raw.anchor as unknown as ICanvasAnchor } : {}),
			...(typeof raw.text === 'string' ? { text: raw.text } : {}),
			...(status ? { status } : {}),
			...(tweaks?.length ? { tweaks } : {}),
		});
		if (!result) {
			// Nothing to keep (an empty comment, a frame that is gone): put the view back in step.
			port.post({ type: 'volt-canvas', op: 'comments', id: doc.id, comments: doc.comments });
			return;
		}
		this.commit(result.doc, 'comments', 'user');
		if (payload.send === true && !raw.id) {
			this.sendFeedback(port, result.doc, [result.comment.id]);
		}
	}

	/**
	 * The user's comments as one message to the agent: sent at once when the user clicked in the
	 * canvas, otherwise put in the composer. Either way they are marked sent.
	 */
	private sendFeedback(port: IPageChannelPort, doc: ICanvasDoc, ids: readonly string[], note?: string): void {
		const comments = doc.comments.filter(comment => ids.includes(comment.id) && comment.status !== 'resolved');
		if (!comments.length) {
			return;
		}
		this.prompt(port, doc, formatCanvasFeedback(doc, comments, note), port.focused());
		const next: ICanvasDoc = { ...doc, comments: doc.comments.map(comment => comments.includes(comment) ? { ...comment, status: 'sent' as const } : comment), updatedAt: Date.now() };
		this.commit(next, 'comments', 'user');
	}

	/**
	 * Sends (or drafts) a message in the chat the canvas lives in. A chat view does it itself; the
	 * tab asks the chat view it was opened from. Without one, the text goes to the clipboard.
	 */
	private prompt(port: IPageChannelPort, doc: ICanvasDoc, text: string, send: boolean): void {
		// The canvas's own agent takes it, in the canvas's sidebar: the tab opens if it is not open yet.
		const agent = this.agents.get(doc.id);
		if (agent) {
			agent.prompt(text, send);
			return;
		}
		const waiting = this.waiting.get(doc.id) ?? [];
		waiting.push({ text, send });
		this.waiting.set(doc.id, waiting);
		if (waiting.length === 1) {
			void this.commandService.executeCommand(OPEN_CANVAS_COMMAND_ID, doc.id);
			setTimeout(() => {
				// No agent came up (no window for the tab): fall back to the chat the canvas is in.
				const left = this.waiting.get(doc.id);
				this.waiting.delete(doc.id);
				for (const entry of left ?? []) {
					this.promptChat(port, doc, entry.text, entry.send);
				}
			}, 8000);
		}
	}

	private promptChat(port: IPageChannelPort, doc: ICanvasDoc, text: string, send: boolean): void {
		const target = port.prompt ? port : this.chatPorts.get(doc.id);
		if (target?.prompt) {
			target.prompt(text, send);
			return;
		}
		void this.clipboardService.writeText(text);
		this.notificationService.info(localize('voltCanvas.copiedFeedback', "The canvas's chat is not open, so the message was copied. Paste it in the chat that made \"{0}\".", doc.title));
	}

	/** A mockups gallery's "Open on Canvas": its options as a variant board, beside the chat. */
	private async importMockups(port: IPageChannelPort, mockups: unknown): Promise<void> {
		const input = canvasFromMockups(mockups);
		if ('error' in input) {
			this.notificationService.warn(localize('voltCanvas.importFailed', "Could not open these mockups on a canvas: {0}", input.error));
			return;
		}
		const doc = await this.create(input, undefined);
		if (port.prompt && port.sessionId) {
			this.chatPorts.set(doc.id, port);
		}
		await this.commandService.executeCommand(OPEN_CANVAS_COMMAND_ID, doc.id);
	}

	/** What the user selected, for the agent's next turn ("make this one darker"). */
	private shareSelection(port: IPageChannelPort, doc: ICanvasDoc, frames: readonly string[]): void {
		const session = this.agents.get(doc.id)?.sessionId ?? port.sessionId ?? this.chatPorts.get(doc.id)?.sessionId;
		if (!session) {
			return;
		}
		const picked = doc.frames.filter(frame => frames.includes(frame.id)).map(frame => ({ id: frame.id, name: frame.name, kind: frame.kind, size: `${frame.width}x${frame.height || 'auto'}` }));
		setPageContext(session, `canvas:${doc.id}`, doc.title, JSON.stringify({ canvas: doc.id, version: doc.version, selectedFrames: picked, openComments: doc.comments.filter(comment => comment.status === 'open').length }));
	}

	private shareAnchor(port: IPageChannelPort, doc: ICanvasDoc, anchor: ICanvasAnchor): void {
		const session = this.agents.get(doc.id)?.sessionId ?? port.sessionId ?? this.chatPorts.get(doc.id)?.sessionId;
		if (!session) {
			return;
		}
		const frame = doc.frames.find(other => other.id === anchor.frame);
		setPageContext(session, `canvas:${doc.id}`, doc.title, JSON.stringify({
			canvas: doc.id,
			version: doc.version,
			userPointedAt: {
				frame: anchor.frame,
				frameName: frame?.name,
				...(anchor.selector ? { selector: anchor.selector } : {}),
				...(anchor.element ? { element: anchor.element } : {}),
				...(anchor.html ? { html: anchor.html } : {}),
				...(anchor.w && anchor.h ? { region: { x: anchor.x, y: anchor.y, w: anchor.w, h: anchor.h } } : { point: { x: anchor.x, y: anchor.y } }),
			},
		}));
	}

	//#endregion
}
