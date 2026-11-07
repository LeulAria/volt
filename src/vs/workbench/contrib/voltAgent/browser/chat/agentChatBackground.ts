/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentChatBackground.css';
import { $, append, getWindow } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { AppResourcePath, FileAccess, Schemas } from '../../../../../base/common/network.js';
import { isWeb } from '../../../../../base/common/platform.js';
import { basename, joinPath, toLocalResource } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import {
	AGENT_CHAT_BACKGROUND_DIM_SETTING,
	AGENT_CHAT_BACKGROUND_EXTENSIONS,
	AGENT_CHAT_BACKGROUND_IN_CHATS_SETTING,
	AGENT_CHAT_BACKGROUND_PIXELS_SETTING,
	AGENT_CHAT_BACKGROUND_SECTION,
	AGENT_CHAT_BACKGROUND_SETTING,
	AgentChatBackground,
	agentChatBackgroundDim,
	AgentChatDrawing,
	agentChatDrawing,
	IAgentChatBackgroundPreset,
	resolveAgentChatBackground,
} from '../../common/agentChatBackground.js';
import { createAgentChatDrawing, IAgentChatDrawing } from './agentChatDrawings.js';

/** On the workbench root while a picture shows; agentChatBackground.css reads them. */
const BACKDROP_CLASS = 'volt-chat-backdrop';
const PIXELS_CLASS = 'volt-chat-backdrop-pixels';
const IN_CHATS_CLASS = 'volt-chat-backdrop-in-chats';
/** On the workbench root while the background is drawn (Orbit, Volt, Halftone), not a picture: nothing to frost the composer with. */
const LIVE_CLASS = 'volt-chat-backdrop-live';
/** On the workbench root while a chat's backdrop shows under the title bar, and while that chat has messages. */
const TITLEBAR_CLASS = 'volt-chat-backdrop-titlebar';
const TITLEBAR_TURNS_CLASS = 'volt-chat-backdrop-titlebar-turns';
const IMAGE_VARIABLE = '--volt-chat-backdrop-image';
const POSITION_VARIABLE = '--volt-chat-backdrop-position';
const DIM_VARIABLE = '--volt-chat-backdrop-dim';

const MEDIA = 'vs/workbench/contrib/voltAgent/browser/media/chatBackgrounds';

/** The longest side of a picture chosen in Settings: a full-width chat on a 5K display. */
const IMPORT_MAX_SIZE = 3840;
const IMPORT_PREFIX = 'custom-';

/** A built-in picture, or its 320x180 thumbnail. */
export function agentChatBackgroundPresetUrl(preset: IAgentChatBackgroundPreset, thumbnail?: boolean): string {
	return FileAccess.asBrowserUri(`${MEDIA}/${preset.id}${thumbnail ? '-thumb' : ''}.webp` as AppResourcePath).toString(true);
}

/**
 * A custom background as a resource this window can read: a URI as written, otherwise a path on
 * the machine Volt runs on (`~` is the home folder).
 */
export async function agentChatBackgroundResource(location: string, pathService: IPathService, environmentService: IWorkbenchEnvironmentService): Promise<URI> {
	if (/^[a-z][a-z0-9+.-]+:/i.test(location) && !/^[a-z]:[\\/]/i.test(location)) {
		return URI.parse(location);
	}
	if (location === '~' || /^~[\\/]/.test(location)) {
		return joinPath(await pathService.userHome(), location.slice(1).replace(/\\/g, '/'));
	}
	return toLocalResource(URI.file(location), environmentService.remoteAuthority, pathService.defaultUriScheme);
}

/** Reads a picture into a `blob:` URL; the caller revokes it. */
export async function loadAgentChatBackground(resource: URI, fileService: IFileService): Promise<string> {
	const content = await fileService.readFile(resource);
	return URL.createObjectURL(new Blob([content.value.buffer as Uint8Array<ArrayBuffer>], { type: imageMime(resource.path) }));
}

/** The imported picture Settings can switch back to: the newest copy kept by Choose Image. */
export async function importedAgentChatBackground(fileService: IFileService, environmentService: IWorkbenchEnvironmentService): Promise<string | undefined> {
	try {
		const folder = await fileService.resolve(importFolder(environmentService));
		const newest = (folder.children ?? [])
			.filter(child => child.isFile && child.name.startsWith(IMPORT_PREFIX))
			.sort((a, b) => b.name.localeCompare(a.name))[0];
		return newest ? storedLocation(newest.resource) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Settings > Appearance > Choose Image: asks for a picture, keeps a WebP copy of it (at most
 * 3840px on its longest side) beside Volt's settings and makes it the chat background, so the
 * original can move and macOS does not ask for folder access again. Earlier copies are deleted.
 * Resolves to whether a picture was set.
 */
export async function chooseAgentChatBackground(accessor: ServicesAccessor, targetWindow: Window): Promise<boolean> {
	const fileDialogService = accessor.get(IFileDialogService);
	const fileService = accessor.get(IFileService);
	const environmentService = accessor.get(IWorkbenchEnvironmentService);
	const configurationService = accessor.get(IConfigurationService);
	const notificationService = accessor.get(INotificationService);
	const logService = accessor.get(ILogService);
	const picked = await fileDialogService.showOpenDialog({
		title: localize('voltChatBackground.chooseTitle', "Choose a Chat Background"),
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		filters: [{ name: localize('voltChatBackground.images', "Images"), extensions: [...AGENT_CHAT_BACKGROUND_EXTENSIONS] }],
	});
	const source = picked?.[0];
	if (!source) {
		return false;
	}
	try {
		const content = await fileService.readFile(source);
		const bytes = await scaledWebp(content.value.buffer, source.path, targetWindow);
		const folder = importFolder(environmentService);
		const target = joinPath(folder, `${IMPORT_PREFIX}${Date.now().toString(36)}.webp`);
		await fileService.writeFile(target, VSBuffer.wrap(bytes));
		await configurationService.updateValue(AGENT_CHAT_BACKGROUND_SETTING, storedLocation(target));
		const children = (await fileService.resolve(folder)).children ?? [];
		await Promise.all(children
			.filter(child => child.isFile && child.name.startsWith(IMPORT_PREFIX) && child.name !== basename(target))
			.map(child => fileService.del(child.resource).catch(() => undefined)));
		return true;
	} catch (error) {
		logService.warn('[volt] chat background could not be imported', error);
		notificationService.error(localize('voltChatBackground.importFailed', "That file could not be used as a chat background: {0}", toErrorMessage(error)));
		return false;
	}
}

/** Pictures chosen in Settings are copied here, beside the settings that name them. */
function importFolder(environmentService: IWorkbenchEnvironmentService): URI {
	return joinPath(environmentService.userRoamingDataHome, 'chatBackgrounds');
}

/** The setting's value for a copy: its path on disk, or its URI where settings live in the browser. */
function storedLocation(resource: URI): string {
	return !isWeb && resource.scheme === Schemas.vscodeUserData ? resource.with({ scheme: Schemas.file }).fsPath : resource.toString();
}

function imageMime(path: string): string {
	const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
	return extension === 'jpg' ? 'image/jpeg' : `image/${extension}`;
}

/** Resolves once the picture is decoded, so it never shows half drawn. */
async function decodeImage(url: string, targetWindow: Window = mainWindow): Promise<HTMLImageElement> {
	const image = targetWindow.document.createElement('img');
	image.src = url;
	await image.decode();
	return image;
}

/** The picture scaled to at most IMPORT_MAX_SIZE on its longest side, as WebP. */
async function scaledWebp(bytes: Uint8Array, path: string, targetWindow: Window): Promise<Uint8Array> {
	const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: imageMime(path) }));
	try {
		const image = await decodeImage(url, targetWindow);
		const scale = Math.min(1, IMPORT_MAX_SIZE / Math.max(image.naturalWidth, image.naturalHeight, 1));
		const canvas = targetWindow.document.createElement('canvas');
		canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
		canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
		const context = canvas.getContext('2d');
		if (!context) {
			throw new Error('no 2d context');
		}
		context.imageSmoothingQuality = 'high';
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.86));
		if (!blob) {
			throw new Error('the picture could not be encoded');
		}
		return new Uint8Array(await blob.arrayBuffer());
	} finally {
		URL.revokeObjectURL(url);
	}
}

interface IShownBackground {
	readonly background: AgentChatBackground;
	readonly url: string;
	/** A `blob:` URL this contribution made, revoked when the picture changes. */
	readonly owned: boolean;
}

/**
 * `volt.chat.background.*`: the picture behind the agent chat. It resolves the setting (a built-in
 * picture, or an image file read into a `blob:` URL), waits for it to decode, then sets the root
 * classes and variables agentChatBackground.css draws the backdrop from. A picture that cannot be
 * read leaves the chat as it was.
 */
export class AgentChatBackgroundContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentChatBackground';

	private shown: IShownBackground | undefined;
	private generation = 0;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		void this.load();
		this._register(this.layoutService.onDidAddContainer(({ container }) => this.applyTo(container)));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AGENT_CHAT_BACKGROUND_SETTING)) {
				void this.load();
			} else if (e.affectsConfiguration(AGENT_CHAT_BACKGROUND_SECTION)) {
				this.applyAll();
			}
		}));
		this._register(toDisposable(() => this.release(this.shown)));
	}

	private async load(): Promise<void> {
		const generation = ++this.generation;
		const background = resolveAgentChatBackground(this.configurationService.getValue(AGENT_CHAT_BACKGROUND_SETTING));
		let next: IShownBackground | undefined;
		try {
			next = await this.open(background);
			// A drawn background has nothing to decode: its picture is only Settings' still of it.
			if (next && !agentChatDrawing(next.background)) {
				await decodeImage(next.url);
			}
		} catch (error) {
			this.logService.warn(`[volt] chat background ${background.kind === 'file' ? background.location : background.kind} could not be shown`, error);
			this.release(next);
			next = undefined;
		}
		if (generation !== this.generation || this._store.isDisposed) {
			this.release(next);
			return;
		}
		const previous = this.shown;
		this.shown = next;
		this.applyAll();
		this.release(previous);
	}

	private async open(background: AgentChatBackground): Promise<IShownBackground | undefined> {
		switch (background.kind) {
			case 'none':
				return undefined;
			case 'preset':
				return { background, url: agentChatBackgroundPresetUrl(background.preset), owned: false };
			case 'file': {
				if (/^https?:\/\//i.test(background.location)) {
					return { background, url: background.location, owned: false };
				}
				const resource = await agentChatBackgroundResource(background.location, this.pathService, this.environmentService);
				return { background, url: await loadAgentChatBackground(resource, this.fileService), owned: true };
			}
		}
	}

	private release(shown: IShownBackground | undefined): void {
		if (shown?.owned) {
			URL.revokeObjectURL(shown.url);
		}
	}

	private applyAll(): void {
		for (const container of this.layoutService.containers) {
			this.applyTo(container);
		}
	}

	private applyTo(container: HTMLElement): void {
		const shown = this.shown;
		container.classList.toggle(BACKDROP_CLASS, !!shown);
		const live = !!shown && !!agentChatDrawing(shown.background);
		container.classList.toggle(LIVE_CLASS, live);
		// A drawn background is not a photo: no pixel grid over it.
		container.classList.toggle(PIXELS_CLASS, !!shown && !live && this.configurationService.getValue<boolean>(AGENT_CHAT_BACKGROUND_PIXELS_SETTING) !== false);
		container.classList.toggle(IN_CHATS_CLASS, !!shown && this.configurationService.getValue<boolean>(AGENT_CHAT_BACKGROUND_IN_CHATS_SETTING) === true);
		if (!shown) {
			container.style.removeProperty(IMAGE_VARIABLE);
			container.style.removeProperty(POSITION_VARIABLE);
			container.style.removeProperty(DIM_VARIABLE);
			return;
		}
		container.style.setProperty(IMAGE_VARIABLE, live ? 'none' : `url('${CSS.escape(shown.url)}')`);
		container.style.setProperty(POSITION_VARIABLE, shown.background.kind === 'preset' ? shown.background.preset.position : '50% 50%');
		container.style.setProperty(DIM_VARIABLE, String(agentChatBackgroundDim(this.configurationService.getValue(AGENT_CHAT_BACKGROUND_DIM_SETTING), shown.background)));
	}
}

/** On a panel laid over a chat's picture while it holds a frosted copy of it (frostOverChatBackdrop). */
const FROSTED_CLASS = 'volt-chat-frosted';

/**
 * Frosted glass for a panel laid over a chat's picture, such as a Volt modal: a blurred copy of the
 * picture inside `panel`, exactly where the picture lies on screen, under the panel's tint
 * (agentChatBackground.css). Every pixel stays opaque, so the see-through window never smears behind
 * the panel (volt-transparent-window). Nothing changes when no picture shows behind it: none is set,
 * the chat has messages, or the background is drawn.
 */
export function frostOverChatBackdrop(panel: HTMLElement): IDisposable {
	const root = panel.closest<HTMLElement>('.monaco-workbench');
	const backdrop = root?.classList.contains(BACKDROP_CLASS) && !root.classList.contains(LIVE_CLASS) ? shownBackdrop(root) : undefined;
	if (!backdrop) {
		return Disposable.None;
	}
	const frost = $('.volt-agent-chat-frost', { 'aria-hidden': 'true' });
	panel.prepend(frost);
	panel.classList.add(FROSTED_CLASS);
	const place = () => {
		const picture = backdrop.getBoundingClientRect();
		const box = panel.getBoundingClientRect();
		const style = frost.style;
		style.left = `${picture.left - box.left - panel.clientLeft}px`;
		style.top = `${picture.top - box.top - panel.clientTop}px`;
		style.width = `${picture.width}px`;
		style.height = `${picture.height}px`;
	};
	place();
	const sizes = new ResizeObserver(place);
	sizes.observe(panel);
	sizes.observe(backdrop);
	return toDisposable(() => {
		sizes.disconnect();
		frost.remove();
		panel.classList.remove(FROSTED_CLASS);
	});
}

/** The backdrop a chat in `root` shows now; the largest when there are several. */
function shownBackdrop(root: HTMLElement): HTMLElement | undefined {
	let shown: HTMLElement | undefined;
	let shownArea = 0;
	for (const element of root.querySelectorAll<HTMLElement>('.volt-agent-chat-backdrop')) {
		const style = getWindow(element).getComputedStyle(element);
		const box = element.getBoundingClientRect();
		const area = box.width * box.height;
		if (style.display !== 'none' && Number(style.opacity) > 0 && area > shownArea) {
			shown = element;
			shownArea = area;
		}
	}
	return shown;
}

/** The chat whose backdrop runs up under each window's title bar (the root's TITLEBAR classes are its). */
const titlebarChats = new WeakMap<HTMLElement, AgentChatBackdrop>();

/**
 * A chat's backdrop: the first child of its `.volt-agent-editor-main` column, under everything in it,
 * showing the picture (agentChatBackground.css says when) or a background drawn live (Orbit, Volt,
 * Halftone). When the window's title bar sits right on top of the column, edge to edge, the backdrop
 * is laid fixed over both and the root gets TITLEBAR_CLASS while it shows, so the title bar lets the
 * picture through to the window's top. Orbit moves only while the backdrop shows.
 */
export class AgentChatBackdrop extends Disposable {

	private readonly element: HTMLElement;
	private drawing: { readonly kind: AgentChatDrawing; readonly view: IAgentChatDrawing } | undefined;
	/** The blurred copy of the backdrop inside the composer, while it is frosted glass. */
	private frost: HTMLElement | undefined;
	private readonly sizes: ResizeObserver;
	/** The backdrop is drawn: a picture is set and this chat shows it (agentChatBackground.css). */
	private shown = false;
	private underTitlebar = false;
	private width = 0;
	private height = 0;
	/** The workbench root this chat gave the TITLEBAR classes to. */
	private titlebarRoot: HTMLElement | undefined;

	constructor(
		private readonly column: HTMLElement,
		private readonly chat: HTMLElement,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.element = append(column, $('.volt-agent-chat-backdrop', { 'aria-hidden': 'true' }));
		// The column, and the composer once it is frosted.
		const columnSize = this.sizes = new ResizeObserver(() => this.layout());
		columnSize.observe(column);
		const ownSize = new ResizeObserver(entries => {
			const box = entries[entries.length - 1]?.contentRect;
			if (box) {
				this.width = box.width;
				this.height = box.height;
				this.drawing?.view.resize(box.width, box.height);
			}
		});
		ownSize.observe(this.element);
		// Shown or not follows the chat's classes and the root's through the stylesheet: a hidden backdrop has no box.
		const visibility = new IntersectionObserver(entries => {
			const last = entries[entries.length - 1];
			if (last) {
				this.shown = last.isIntersecting;
				this.sync();
			}
		});
		visibility.observe(this.element);
		// `has-turns` turns the title bar back to its own color as the picture fades out.
		const chatClasses = new MutationObserver(() => this.syncTitlebar());
		chatClasses.observe(chat, { attributes: true, attributeFilter: ['class'] });
		this._register(toDisposable(() => {
			columnSize.disconnect();
			ownSize.disconnect();
			visibility.disconnect();
			chatClasses.disconnect();
			this.drawing?.view.dispose();
			this.frost?.remove();
			this.releaseTitlebar();
		}));
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AGENT_CHAT_BACKGROUND_SETTING)) {
				this.sync();
			}
		}));
		this.sync();
	}

	/** Lays the backdrop fixed over the column and the title bar when the title bar sits right on top of it. */
	private layout(): void {
		const column = this.column.getBoundingClientRect();
		const titlebar = this.layoutService.getContainer(getWindow(this.column), Parts.TITLEBAR_PART)?.getBoundingClientRect();
		const under = !!titlebar && titlebar.height > 0 && column.width > 0
			&& Math.abs(titlebar.left - column.left) <= 2 && Math.abs(titlebar.right - column.right) <= 2
			&& Math.abs(titlebar.bottom - column.top) <= 2;
		this.underTitlebar = under;
		this.element.classList.toggle('under-titlebar', under);
		const style = this.element.style;
		if (under && titlebar) {
			style.position = 'fixed';
			style.left = `${column.left}px`;
			style.top = `${titlebar.top}px`;
			style.width = `${column.width}px`;
			style.height = `${column.bottom - titlebar.top}px`;
			style.right = 'auto';
			style.bottom = 'auto';
		} else {
			for (const property of ['position', 'left', 'top', 'width', 'height', 'right', 'bottom']) {
				style.removeProperty(property);
			}
		}
		this.syncTitlebar();
		this.syncFrost();
	}

	/**
	 * The new chat's composer is frosted glass over the picture: a copy of the backdrop laid inside it
	 * exactly where the backdrop is, blurred with a plain filter (agentChatBackground.css), because a
	 * backdrop-filter breaks the see-through window (volt-transparent-window).
	 */
	private syncFrost(): void {
		const composer = this.chat.querySelector<HTMLElement>('.volt-agent-input-box:not(.editing)');
		if (!composer || !this.shown) {
			return;
		}
		if (this.frost?.parentElement !== composer) {
			this.frost?.remove();
			this.frost = append(composer, $('.volt-agent-chat-frost', { 'aria-hidden': 'true' }));
			this.sizes.observe(composer);
		}
		const backdrop = this.element.getBoundingClientRect();
		const inside = composer.getBoundingClientRect();
		const style = this.frost.style;
		style.left = `${backdrop.left - inside.left - composer.clientLeft}px`;
		style.top = `${backdrop.top - inside.top - composer.clientTop}px`;
		style.width = `${backdrop.width}px`;
		style.height = `${backdrop.height}px`;
	}

	private sync(): void {
		const kind = agentChatDrawing(resolveAgentChatBackground(this.configurationService.getValue(AGENT_CHAT_BACKGROUND_SETTING)));
		if (this.drawing?.kind !== kind) {
			this.drawing?.view.dispose();
			this.drawing = kind ? { kind, view: createAgentChatDrawing(kind, this.element, () => !!this.element.closest('.monaco-workbench.reduce-motion') || getWindow(this.element).matchMedia('(prefers-reduced-motion: reduce)').matches) } : undefined;
			this.drawing?.view.resize(this.width, this.height);
		}
		if (this.shown) {
			this.drawing?.view.play();
		} else {
			this.drawing?.view.pause();
		}
		this.syncTitlebar();
		this.syncFrost();
	}

	private syncTitlebar(): void {
		const root = this.shown && this.underTitlebar ? this.chat.closest<HTMLElement>('.monaco-workbench') ?? undefined : undefined;
		if (this.titlebarRoot !== root) {
			this.releaseTitlebar();
		}
		if (!root) {
			return;
		}
		this.titlebarRoot = root;
		titlebarChats.set(root, this);
		root.classList.add(TITLEBAR_CLASS);
		root.classList.toggle(TITLEBAR_TURNS_CLASS, this.chat.classList.contains('has-turns'));
	}

	private releaseTitlebar(): void {
		const root = this.titlebarRoot;
		this.titlebarRoot = undefined;
		if (root && titlebarChats.get(root) === this) {
			titlebarChats.delete(root);
			root.classList.remove(TITLEBAR_CLASS, TITLEBAR_TURNS_CLASS);
		}
	}
}
