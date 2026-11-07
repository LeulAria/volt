/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentChatBackground.css';
import { mainWindow } from '../../../../../base/browser/window.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
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
	IAgentChatBackgroundPreset,
	resolveAgentChatBackground,
} from '../../common/agentChatBackground.js';

/** On the workbench root while a picture shows; agentChatBackground.css reads them. */
const BACKDROP_CLASS = 'volt-chat-backdrop';
const PIXELS_CLASS = 'volt-chat-backdrop-pixels';
const IN_CHATS_CLASS = 'volt-chat-backdrop-in-chats';
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
			if (next) {
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
		container.classList.toggle(PIXELS_CLASS, !!shown && this.configurationService.getValue<boolean>(AGENT_CHAT_BACKGROUND_PIXELS_SETTING) !== false);
		container.classList.toggle(IN_CHATS_CLASS, !!shown && this.configurationService.getValue<boolean>(AGENT_CHAT_BACKGROUND_IN_CHATS_SETTING) === true);
		if (!shown) {
			container.style.removeProperty(IMAGE_VARIABLE);
			container.style.removeProperty(POSITION_VARIABLE);
			container.style.removeProperty(DIM_VARIABLE);
			return;
		}
		container.style.setProperty(IMAGE_VARIABLE, `url('${CSS.escape(shown.url)}')`);
		container.style.setProperty(POSITION_VARIABLE, shown.background.kind === 'preset' ? shown.background.preset.position : '50% 50%');
		container.style.setProperty(DIM_VARIABLE, String(agentChatBackgroundDim(this.configurationService.getValue(AGENT_CHAT_BACKGROUND_DIM_SETTING), shown.background)));
	}
}
