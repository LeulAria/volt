/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, DragAndDropObserver, getDomNodePagePosition, getWindow } from '../../../../../base/browser/dom.js';
import { IKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { compareFileNamesDefault } from '../../../../../base/common/comparers.js';
import { IMatch, matchesFuzzy } from '../../../../../base/common/filters.js';
import { compareItemsByFuzzyScore, FuzzyScorerCache, IItemAccessor, prepareQuery, scoreItemFuzzy } from '../../../../../base/common/fuzzyScorer.js';
import { IExpression, match as glob } from '../../../../../base/common/glob.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { basename } from '../../../../../base/common/path.js';
import { dirname, isEqualOrParent, relativePath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ICodeEditor, IEditorMouseEvent, MouseTargetType } from '../../../../../editor/browser/editorBrowser.js';
import { IRange, Range } from '../../../../../editor/common/core/range.js';
import { IPosition } from '../../../../../editor/common/core/position.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { IModelDeltaDecoration, TrackedRangeStickiness } from '../../../../../editor/common/model.js';
import { getIconClasses } from '../../../../../editor/common/services/getIconClasses.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { extractEditorsDropData } from '../../../../../platform/dnd/browser/dnd.js';
import { FileKind, IFileService } from '../../../../../platform/files/common/files.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { EditorResourceAccessor } from '../../../../common/editor.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IHistoryService } from '../../../../services/history/common/history.js';
import { ISearchService } from '../../../../services/search/common/search.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IAgentRuntimeService, IVoltMcpServerStatus } from '../../../../services/voltRuntime/common/runtime.js';
import { searchFilesAndFolders } from '../../../search/browser/searchChatContext.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { compactSessionAge } from '../home/agentHomeModel.js';
import { AgentMentionMenu, AgentMentionMenuContent, AgentMentionRow, IAgentMentionFileRow, IAgentMentionTreeEntry } from './agentMentionMenu.js';
import { MentionCodePreview } from './mentionCodePreview.js';
import { AgentImageStrip, formatImageSize, imageExtension, imageThumbClass } from './agentImageAttachments.js';
import { AgentImageViewer, showAgentImageViewer } from './agentImageViewer.js';
import { citationLabel, IAgentCitation, serializeChatSelection, withCitationComment } from './agentCitation.js';
import { showCitationCommentEditor } from './agentCitationComment.js';
import { formatDuration, IAgentVideoFrame, ITimeRange, mapRangesToSource, MAX_VIDEO_BYTES, normalizeVideoMime, probeVideo, rangesDuration, videoExtensionForMime, videoMimeForExtension } from './agentVideoAttachments.js';
import { AgentVideoViewer, IAgentVideoClip, showAgentVideoViewer } from './agentVideoViewer.js';

export type AgentMentionKind = 'file' | 'folder' | 'terminal' | 'chat' | 'branch' | 'browser' | 'image' | 'video' | 'mcp' | 'selection';

export interface IAgentImagePayload {
	id: string;
	mime: string;
	bytes: Uint8Array;
	/** The file name shown on the chip (`image.png`). */
	name?: string;
	/** Where a copy is saved on disk, so the agent's tools can open the file. */
	path?: string;
}

/**
 * A video in the prompt. Models take images, not video, so the agent gets stills spread over the
 * clip plus the clip's path for its tools.
 */
export interface IAgentVideoPayload {
	id: string;
	mime: string;
	name: string;
	/** Size of the clip in bytes. */
	size: number;
	/** The clip in memory. Left out after a reload, when the viewer reads `path`. */
	bytes?: Uint8Array;
	/** The clip on disk: the dropped file, or a saved copy of a pasted or trimmed one. */
	path?: string;
	duration?: number;
	/** A small still for the chip and the strip. */
	poster?: Uint8Array;
	/** Stills spread over the clip, sent to the model as images. */
	frames?: readonly IAgentVideoFrame[];
	/** For an edited clip: the parts of the original file it is made of, in order. */
	trim?: { segments: readonly ITimeRange[]; sourceName: string };
}

export interface IAgentMention {
	id: string;
	kind: AgentMentionKind;
	label: string;
	value?: string;
	accent?: number;
	decorationId?: string;
	resource?: URI;
	range?: { startLineNumber: number; endLineNumber: number };
	image?: IAgentImagePayload;
	video?: IAgentVideoPayload;
	/** `selection` only: where the quote came from and the user's comment on it. */
	citation?: IAgentCitation;
}

export const BROWSER_MENTION_COLORS = ['#89b4fa', '#a6e3a1', '#94e2d5', '#fab387', '#74c7ec', '#cba6f7', '#f9e2af', '#f5c2e7'] as const;
const BROWSER_MENTION_ACCENTS = BROWSER_MENTION_COLORS.length;

export function browserMentionColor(accent = 0): string {
	return BROWSER_MENTION_COLORS[((accent % BROWSER_MENTION_ACCENTS) + BROWSER_MENTION_ACCENTS) % BROWSER_MENTION_ACCENTS];
}

export interface IAgentDisplayMention {
	label: string;
	accent?: number;
	kind: AgentMentionKind;
	value?: string;
	resource?: URI;
	range?: { startLineNumber: number; endLineNumber: number };
	image?: IAgentImagePayload;
	video?: IAgentVideoPayload;
	citation?: IAgentCitation;
}

/** An image the model receives with the prompt: the runtime's `IVoltImageAttachment` shape. */
export interface IAgentImageAttachment {
	readonly mediaType: string;
	/** Base64 without a `data:` prefix. */
	readonly data: string;
	/** The name the prompt text refers to ("Image1" for `@Image1`, the file name for a dropped file). */
	readonly name?: string;
}

/** Image types every vision provider takes; others (SVG) stay a text mention only. */
const SENDABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * The pasted and dropped images among a prompt's mentions, and the stills of its videos, ready for
 * `IVoltSendRequest.images`. The text mention stays in the prompt; the name ties the two together.
 */
export function imageAttachmentsFromMentions(mentions: readonly IAgentDisplayMention[] | undefined): IAgentImageAttachment[] {
	const attachments: IAgentImageAttachment[] = [];
	const seen = new Set<Uint8Array>();
	for (const mention of mentions ?? []) {
		if (mention.kind === 'video') {
			for (const frame of mention.video?.frames ?? []) {
				attachments.push({ mediaType: frame.mime, data: encodeBase64(VSBuffer.wrap(frame.bytes)), name: videoFrameName(mention.label, frame.time) });
			}
			continue;
		}
		const image = mention.image;
		if (mention.kind !== 'image' || !image?.bytes.byteLength || seen.has(image.bytes)) {
			continue;
		}
		const mediaType = image.mime.toLowerCase() === 'image/jpg' ? 'image/jpeg' : image.mime.toLowerCase();
		if (!SENDABLE_IMAGE_TYPES.has(mediaType)) {
			continue;
		}
		seen.add(image.bytes);
		attachments.push({ mediaType, data: encodeBase64(VSBuffer.wrap(image.bytes)), name: mention.label });
	}
	return attachments;
}

/** `screen.mov @ 0:03.5`: the name a video still is sent under. */
export function videoFrameName(label: string, time: number): string {
	return `${label} @ ${formatDuration(time, true)}`;
}

/**
 * `[Image #1 "image.png" is saved at: /path]` for each image in a prompt, and a line per video
 * naming its stills. The model gets the pixels as image blocks; the paths let its tools open the
 * files (copy one into the repo, cut a video with ffmpeg, attach it to a PR).
 */
export function attachmentPathLines(mentions: readonly IAgentDisplayMention[]): string[] {
	const lines: string[] = [];
	let images = 0;
	let videos = 0;
	for (const mention of mentions) {
		const fsPath = mention.resource?.scheme === 'file' ? mention.resource.fsPath : undefined;
		if (mention.kind === 'image' && mention.image) {
			images += 1;
			const path = mention.image.path ?? fsPath;
			if (path) {
				lines.push(`[Image #${images} "${mention.label}" is saved at: ${path}]`);
			}
		} else if (mention.kind === 'video' && mention.video) {
			videos += 1;
			const video = mention.video;
			const path = video.path ?? fsPath;
			const facts: string[] = [];
			if (video.duration) {
				facts.push(`${video.duration.toFixed(1)}s`);
			}
			if (video.trim?.segments.length) {
				const parts = video.trim.segments.map(part => `${formatDuration(part.start, true)}–${formatDuration(part.end, true)}`);
				facts.push(parts.length === 1
					? `cut from ${parts[0]} of "${video.trim.sourceName}"`
					: `joined from ${parts.join(', ')} of "${video.trim.sourceName}"`);
			}
			const stills = video.frames?.length
				? `. Stills at ${video.frames.map(frame => formatDuration(frame.time, true)).join(', ')} are attached as images`
				: '';
			lines.push(`[Video #${videos} "${mention.label}"${facts.length ? ` (${facts.join(', ')})` : ''}${path ? ` is saved at: ${path}` : ''}${stills}]`);
		}
	}
	return lines;
}

/** Copies mention metadata and image bytes so another composer can own the payload. */
export function cloneDisplayMentions(mentions: readonly IAgentDisplayMention[]): IAgentDisplayMention[] {
	return mentions.map(mention => ({
		label: mention.label,
		accent: mention.accent,
		kind: mention.kind,
		value: mention.value,
		resource: mention.resource,
		range: mention.range ? { ...mention.range } : undefined,
		image: mention.image ? {
			id: mention.image.id,
			mime: mention.image.mime,
			bytes: mention.image.bytes.slice(),
			name: mention.image.name,
			path: mention.image.path,
		} : undefined,
		// Videos are large and never changed in place (an edit makes a new payload), so the bytes are shared.
		video: mention.video ? { ...mention.video } : undefined,
		citation: mention.citation ? { ...mention.citation } : undefined,
	}));
}

/** What the composer that owns a mention controller lends it. */
export interface IAgentMentionHost {
	/** The composer box; the @ panel spans its width. */
	readonly anchor?: HTMLElement;
	/** Project root: files are searched here and mention paths are relative to it. */
	root?(): URI | undefined;
	/** Opens a clicked file mention. Default: the active editor group. */
	openResource?(resource: URI, range?: { startLineNumber: number; endLineNumber: number }): void;
	/** The chat this composer belongs to; left out of the Chats list. */
	sessionId?(): string | undefined;
	/** Shows a cited quote in its reply. False when the reply or the words are gone. */
	openCitation?(citation: IAgentCitation, chip: HTMLElement | undefined): void;
}

type MentionMenuView = 'root' | 'files' | 'terminals' | 'chats';

interface IMentionFile {
	readonly resource: URI;
	readonly kind: FileKind;
}

const MAX_FILE_ITEMS = 30;
const MAX_RECENT_ITEMS = 5;
const MAX_CHAT_ITEMS = 50;
const MENU_SEARCH_DEBOUNCE_MS = 80;
/** A referenced chat is sent along, cut from the start past this size. */
const MAX_CHAT_CONTEXT_CHARS = 24_000;
/** A referenced terminal sends its last lines. */
const MAX_TERMINAL_LINES = 80;

/** Keeps the rows whose label contains the query, with the match highlighted. */
function filterRows(rows: readonly AgentMentionRow[], query: string): AgentMentionRow[] {
	return rows.flatMap(row => {
		if (row.kind !== 'item') {
			return [];
		}
		const labelMatches = matchesFuzzy(query, row.label);
		return labelMatches ? [{ ...row, labelMatches }] : [];
	});
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

function chipText(label: string): string {
	return label;
}

export function mentionIconClasses(
	mention: Pick<IAgentDisplayMention, 'kind' | 'resource'>,
	modelService: IModelService,
	languageService: ILanguageService,
): string[] {
	if (mention.kind === 'folder') {
		return getIconClasses(modelService, languageService, mention.resource, FileKind.FOLDER);
	}
	if (mention.kind === 'file' || (mention.kind === 'image' && mention.resource)) {
		return getIconClasses(modelService, languageService, mention.resource, FileKind.FILE);
	}
	if (mention.kind === 'selection') {
		// Drawn by CSS (a chat bubble).
		return [];
	}
	const icon = mention.kind === 'image' ? Codicon.fileMedia
		: mention.kind === 'video' ? Codicon.deviceCameraVideo
			: mention.kind === 'terminal' ? Codicon.terminal
				: mention.kind === 'chat' ? Codicon.comment
					: mention.kind === 'mcp' ? Codicon.server
						: mention.kind === 'branch' ? Codicon.gitBranch
							: mention.kind === 'browser' ? Codicon.inspect
								: Codicon.globe;
	return ['codicon', `codicon-${icon.id}`];
}

/** The whole quote, the comment, and what clicking does. */
function citationHover(citation: IAgentCitation): MarkdownString {
	const hover = new MarkdownString();
	for (const line of citation.quote.trim().split('\n')) {
		hover.appendMarkdown('> ');
		hover.appendText(line);
		hover.appendMarkdown('\n');
	}
	if (citation.comment) {
		hover.appendMarkdown('\n\n');
		hover.appendText(citation.comment);
	}
	hover.appendMarkdown('\n\n');
	hover.appendText(citation.messageId
		? localize('voltAgent.citationHoverHint', "Click to show it in the reply. Pencil to comment.")
		: localize('voltAgent.citationHoverHintNoSource', "Pencil to comment."));
	return hover;
}

/** `0:09 · 3.2 MB`, or just the size until the video is decoded. */
export function videoDetail(video: Pick<IAgentVideoPayload, 'duration' | 'size'>): string {
	return [video.duration ? formatDuration(video.duration) : undefined, formatImageSize(video.size)].filter(Boolean).join(' · ');
}

function truncateLabel(name: string, max = 22): string {
	return name.length <= max ? name : `${name.slice(0, Math.max(0, max - 3))}...`;
}

function isImageUri(resource: URI): boolean {
	const ext = basename(resource.path).split('.').pop()?.toLowerCase() ?? '';
	return IMAGE_EXTS.has(ext);
}

function isVideoUri(resource: URI): boolean {
	return !!videoMimeForExtension(basename(resource.path).split('.').pop() ?? '');
}

export class AgentMentionController extends Disposable {

	private readonly mentions: IAgentMention[] = [];
	private readonly mentionCatalog: IAgentMention[] = [];
	private readonly _onDidChangeMedia = this._register(new Emitter<void>());
	/** An image or video was added, removed or edited. */
	readonly onDidChangeMedia: Event<void> = this._onDidChangeMedia.event;
	private mediaKeys = '';
	private readonly imageStrips: AgentImageStrip[] = [];
	/** Videos still being decoded for their stills; a send waits for them. */
	private readonly videoPreparations = new Map<IAgentVideoPayload, Promise<void>>();
	private host: IAgentMentionHost = {};
	private readonly mentionMenu: AgentMentionMenu;
	private menuView: MentionMenuView = 'root';
	private pendingMenuView: MentionMenuView | undefined;
	/** `line:column` of the @ the panel is for. */
	private menuToken: string | undefined;
	/** Escape closed the panel for this @; typing more will not reopen it. */
	private dismissedToken: string | undefined;
	private menuRange: IRange | undefined;
	private menuQuery = '';
	private menuTyped = false;
	private menuRefreshQueued = false;
	private menuGeneration = 0;
	/** The panel used the current keystroke; later handlers of it (the Enter send keybinding) must skip it. */
	private menuKeyConsumed = false;
	private menuSearchTimer: ReturnType<typeof setTimeout> | undefined;
	private searchCts: CancellationTokenSource | undefined;
	/** MCP servers for the open panel; fetched when it opens on the root list. */
	private mcpServers: readonly IVoltMcpServerStatus[] | undefined;
	/** Transcripts of referenced chats, by session id. */
	private readonly chatContexts = new Map<string, string>();
	private lastDropAt = 0;
	private hoveredMentionId: string | undefined;
	private insertingMention = false;
	onDidHoverMention: ((mention: IAgentMention | undefined) => void) | undefined;
	onDidRemoveMention: ((mention: IAgentMention) => void) | undefined;
	private readonly codePreview: MentionCodePreview;

	constructor(
		private readonly editor: ICodeEditor,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ISearchService private readonly searchService: ISearchService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IHistoryService private readonly historyService: IHistoryService,
		@ILabelService private readonly labelService: ILabelService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IEditorService private readonly editorService: IEditorService,
		@ICommandService private readonly commandService: ICommandService,
		@IAgentHistoryService private readonly agentHistory: IAgentHistoryService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@INotificationService private readonly notificationService: INotificationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
	) {
		super();
		this.codePreview = this._register(instantiationService.createInstance(MentionCodePreview));
		this.mentionMenu = this._register(instantiationService.createInstance(AgentMentionMenu, {
			anchor: () => this.host.anchor,
			cursor: () => this.getCursorAnchor(),
			open: resource => this.openBeside(resource),
			onDidHide: () => this.closeMentionMenu(),
		}));
		this._register(toDisposable(() => {
			clearTimeout(this.menuSearchTimer);
			this.searchCts?.dispose(true);
		}));
		this.registerListeners();
	}

	setHost(host: IAgentMentionHost): void {
		this.host = host;
	}

	private get disposed(): boolean {
		return this._store.isDisposed;
	}

	bindDropTarget(target: HTMLElement): void {
		this._register(new DragAndDropObserver(target, {
			onDragEnter: e => this.onDragHover(e, target, true),
			onDragOver: e => this.onDragHover(e, target, true),
			onDragLeave: () => target.classList.remove('drop-target'),
			onDrop: e => {
				e.preventDefault();
				e.stopPropagation();
				target.classList.remove('drop-target');
				void this.handleExternalDrop(e);
			}
		}));
	}

	handleExternalDrop(e: DragEvent): Promise<void> {
		return this.handleDrop(e, this.editor.getTargetAtClientPoint(e.clientX, e.clientY)?.position ?? this.editor.getPosition() ?? undefined);
	}

	getImages(): IAgentImagePayload[] {
		return this.imageMentions().map(m => m.image!);
	}

	/** The image and video chips in the order they appear in the text. */
	private mediaMentions(): IAgentMention[] {
		const model = this.editor.getModel();
		if (!model) {
			return [];
		}
		return this.mentions
			.filter(mention => ((mention.kind === 'image' && mention.image) || (mention.kind === 'video' && mention.video)) && mention.decorationId)
			.map(mention => ({ mention, range: model.getDecorationRange(mention.decorationId!) }))
			.filter((item): item is { mention: IAgentMention; range: Range } => !!item.range)
			.sort((a, b) => Range.compareRangesUsingStarts(a.range, b.range))
			.map(item => item.mention);
	}

	private imageMentions(): IAgentMention[] {
		return this.mediaMentions().filter(mention => mention.kind === 'image');
	}

	private videoMentions(): IAgentMention[] {
		return this.mediaMentions().filter(mention => mention.kind === 'video');
	}

	/**
	 * Square previews of the prompt's images and videos, inserted into `parent` before `before`.
	 * Clicking an image opens it to mark up; clicking a video opens it to trim.
	 */
	bindImageStrip(parent: HTMLElement, before: HTMLElement | null): void {
		const strip = this._register(new AgentImageStrip({
			onOpen: index => this.openMedia(index),
			onRemove: index => {
				const mention = this.mediaMentions()[index];
				if (mention) {
					this.removeMention(mention);
				}
			},
		}));
		parent.insertBefore(strip.element, before);
		this.imageStrips.push(strip);
		this.syncImageStrip(strip);
	}

	get hasMedia(): boolean {
		return this.mediaMentions().length > 0;
	}

	/** Resolves once every attached video has its stills; undefined when none is pending. */
	whenMediaReady(): Promise<void> | undefined {
		return this.videoPreparations.size ? Promise.all([...this.videoPreparations.values()]).then(() => undefined) : undefined;
	}

	private syncImageStrip(strip: AgentImageStrip): void {
		strip.update(this.mediaMentions().map(mention => {
			const video = mention.video;
			if (mention.kind === 'video' && video) {
				return {
					key: `${mention.id}:${video.size}:${video.poster ? 1 : 0}:${video.duration ?? ''}`,
					name: mention.label,
					bytes: video.poster,
					mime: 'image/jpeg',
					size: video.size,
					video: { duration: video.duration },
				};
			}
			const image = mention.image!;
			return {
				key: `${mention.id}:${image.bytes.byteLength}:${image.path ?? ''}`,
				name: mention.label,
				bytes: image.bytes,
				mime: image.mime,
				size: image.bytes.byteLength,
			};
		}));
	}

	/** Re-renders the strips and tells the composer when the set of images and videos changed. */
	private notifyImages(): void {
		const mentions = this.mediaMentions();
		const keys = mentions.map(mention => `${mention.id}:${mention.image?.bytes.byteLength ?? mention.video?.size}`).join('|');
		for (const strip of this.imageStrips) {
			this.syncImageStrip(strip);
		}
		if (keys !== this.mediaKeys) {
			this.mediaKeys = keys;
			this._onDidChangeMedia.fire();
		}
	}

	/** Opens the `index`th image or video of the strip. */
	openMedia(index: number): void {
		const mention = this.mediaMentions()[index];
		if (mention?.kind === 'video') {
			this.openVideoViewer(mention);
		} else if (mention) {
			this.openImageViewer(this.imageMentions().indexOf(mention));
		}
	}

	private openVideoViewer(mention: IAgentMention): void {
		const video = mention.video;
		const anchor = this.host.anchor ?? this.editor.getDomNode();
		if (!video || !anchor) {
			return;
		}
		showAgentVideoViewer(options => this.instantiationService.createInstance(AgentVideoViewer, options), {
			anchor,
			title: localize('voltAgent.attachedVideoTitle', "Attached video {0}", Math.max(1, this.videoMentions().indexOf(mention) + 1)),
			name: mention.label,
			mime: video.mime,
			bytes: video.bytes,
			path: video.path,
			onTrim: clip => this.applyVideoTrim(mention, clip),
			onCaptureFrame: frame => this.addVideoFrame(mention, frame),
			onDidClose: () => this.editor.focus(),
		});
	}

	/** Swaps a video for the clip made in the viewer (trimmed, parts deleted); it is decoded and saved again. */
	private applyVideoTrim(mention: IAgentMention, clip: IAgentVideoClip): void {
		const previous = mention.video;
		if (!previous || !this.mentions.includes(mention)) {
			return;
		}
		// Name the parts in the original file, even when this clip was already an edit.
		const source = previous.trim?.segments ?? [{ start: 0, end: previous.duration ?? Number.MAX_SAFE_INTEGER }];
		const video: IAgentVideoPayload = {
			id: previous.id,
			name: previous.name,
			mime: clip.mime,
			size: clip.bytes.byteLength,
			bytes: clip.bytes,
			duration: rangesDuration(clip.segments),
			trim: { segments: mapRangesToSource(clip.segments, source), sourceName: previous.trim?.sourceName ?? previous.name },
		};
		mention.video = video;
		// The clip is no longer the dropped file.
		mention.resource = undefined;
		this.refreshMentionDecoration(mention);
		this.notifyImages();
		this.prepareVideo(video);
	}

	/** A still picked in the video viewer joins the prompt as an image. */
	private addVideoFrame(mention: IAgentMention, frame: { readonly bytes: Uint8Array; readonly mime: string; readonly time: number }): void {
		const range = this.cursorRangeAfterSpacer();
		if (range) {
			const stem = mention.label.replace(/\.[^.]+$/, '') || 'video';
			this.insertImage(frame.bytes, frame.mime, range, `${stem} @ ${formatDuration(frame.time, true)}.png`);
		}
	}

	/**
	 * Decodes a clip for its length, poster and the stills sent with the prompt, and saves a copy
	 * when it has no file of its own. A send waits for this (see {@link whenMediaReady}).
	 */
	private prepareVideo(video: IAgentVideoPayload): void {
		if (this.videoPreparations.has(video)) {
			return;
		}
		const node = this.editor.getDomNode();
		const targetWindow = node ? getWindow(node) : mainWindow;
		const work = (async () => {
			const bytes = video.bytes ?? (video.path ? await this.fileService.readFile(URI.file(video.path)).then(file => file.value.buffer, () => undefined) : undefined);
			if (!bytes) {
				return;
			}
			const save = video.path ? Promise.resolve() : this.agentHistory.putAttachment(bytes, video.mime).then(ref => {
				video.path = this.agentHistory.attachmentResource(ref)?.fsPath;
			}, () => undefined);
			const probe = video.frames ? Promise.resolve() : probeVideo(targetWindow, bytes, video.mime).then(result => {
				video.duration = result.duration || video.duration;
				video.poster = result.poster;
				video.frames = result.frames;
			}, () => {
				// Not decodable here (an unsupported codec): the agent still gets the path.
				video.frames = [];
			});
			await Promise.all([save, probe]);
		})();
		this.videoPreparations.set(video, work);
		void work.finally(() => {
			this.videoPreparations.delete(video);
			// Restoring a draft makes new mentions around the same payload; refresh whichever holds it now.
			const holders = this.mentions.filter(current => current.video === video);
			holders.forEach(current => this.refreshMentionDecoration(current));
			if (holders.length) {
				this.notifyImages();
			}
		});
	}

	private notifyVideoTooLarge(name: string, size: number): void {
		this.notificationService.info(localize('voltAgent.videoTooLarge', "{0} is {1}. Videos up to {2} can be previewed and trimmed; it is attached as a file instead.", name, formatImageSize(size), formatImageSize(MAX_VIDEO_BYTES)));
	}

	openImageViewer(index: number): void {
		const mentions = this.imageMentions();
		if (!mentions[index]) {
			return;
		}
		const anchor = this.host.anchor ?? this.editor.getDomNode();
		if (!anchor) {
			return;
		}
		showAgentImageViewer(options => this.instantiationService.createInstance(AgentImageViewer, options), {
			anchor,
			index,
			images: mentions.map((mention, i) => ({
				name: mention.label,
				title: localize('voltAgent.attachedImageTitle', "Attached image {0}", i + 1),
				bytes: mention.image!.bytes,
				mime: mention.image!.mime,
			})),
			onSave: (i, bytes, mime) => {
				const mention = mentions[i];
				if (mention?.image && this.mentions.includes(mention)) {
					// The edit replaces the pixels; a dropped file's own path no longer matches them.
					mention.image = { id: mention.image.id, name: mention.image.name, mime, bytes };
					mention.resource = undefined;
					this.persistImage(mention.image);
					this.refreshMentionDecoration(mention);
					this.notifyImages();
				}
			},
			onDidClose: () => this.editor.focus(),
		});
	}

	/** Adds image and video files picked from disk at the cursor. */
	async addMediaFiles(resources: readonly URI[]): Promise<void> {
		for (const resource of resources) {
			const range = this.cursorRangeAfterSpacer();
			if (!range) {
				return;
			}
			if (isVideoUri(resource)) {
				await this.insertVideoFromUri(resource, range);
			} else {
				await this.insertImageFromUri(resource, range);
			}
		}
	}

	/** Saves a copy under the agent history's attachments, for the path line sent with the prompt. */
	private persistImage(image: IAgentImagePayload): void {
		const bytes = image.bytes;
		void this.agentHistory.putAttachment(bytes, image.mime).then(ref => {
			// A later edit may have replaced the bytes.
			if (image.bytes === bytes) {
				image.path = this.agentHistory.attachmentResource(ref)?.fsPath;
				this.notifyImages();
			}
		}, () => undefined);
	}

	displayMentions(): IAgentDisplayMention[] {
		const model = this.editor.getModel();
		const items = this.mentions
			.map(mention => {
				const range = mention.decorationId && model ? model.getDecorationRange(mention.decorationId) : undefined;
				return range ? { mention, offset: model!.getOffsetAt(range.getStartPosition()) } : undefined;
			})
			.filter((item): item is { mention: IAgentMention; offset: number } => !!item)
			.sort((a, b) => a.offset - b.offset);
		return items.map(({ mention }) => ({
			label: mention.label,
			accent: mention.accent,
			kind: mention.kind,
			value: mention.value,
			resource: mention.resource,
			range: mention.range,
			image: mention.image,
			video: mention.video,
			citation: mention.citation,
		}));
	}

	restoreMentions(mentions: readonly IAgentDisplayMention[]): void {
		const model = this.editor.getModel();
		if (!model) {
			return;
		}
		this.clear();
		if (!mentions.length) {
			return;
		}
		let cursor = 0;
		const text = model.getValue();
		for (const item of mentions) {
			if (!item.label) {
				continue;
			}
			const index = text.indexOf(item.label, cursor);
			if (index < 0) {
				continue;
			}
			const start = model.getPositionAt(index);
			const end = model.getPositionAt(index + item.label.length);
			const mention: IAgentMention = {
				id: `${item.kind}:${generateUuid()}`,
				kind: item.kind,
				label: item.label,
				accent: item.accent,
				value: item.value,
				resource: item.resource ? URI.revive(item.resource) : undefined,
				range: item.range,
				image: item.image,
				video: item.video,
				citation: item.citation,
			};
			this.addDecoration(mention, {
				startLineNumber: start.lineNumber,
				startColumn: start.column,
				endLineNumber: end.lineNumber,
				endColumn: end.column,
			});
			this.mentions.push(mention);
			this.mentionCatalog.push(mention);
			if (mention.kind === 'chat' && mention.value) {
				void this.loadChatContext(mention.value);
			}
			if (mention.image && !mention.image.path) {
				this.persistImage(mention.image);
			}
			if (mention.video && (!mention.video.path || !mention.video.frames)) {
				this.prepareVideo(mention.video);
			}
			cursor = index + item.label.length;
		}
		this.notifyImages();
	}

	serialize(): string {
		const model = this.editor.getModel();
		if (!model) {
			return '';
		}
		let text = model.getValue();
		const replacements = this.mentions
			.map(mention => {
				const range = mention.decorationId ? model.getDecorationRange(mention.decorationId) : undefined;
				return range ? { mention, range } : undefined;
			})
			.filter((item): item is { mention: IAgentMention; range: Range } => !!item)
			.sort((a, b) => model.getOffsetAt(b.range.getStartPosition()) - model.getOffsetAt(a.range.getStartPosition()));
		for (const { mention, range } of replacements) {
			const start = model.getOffsetAt(range.getStartPosition());
			const end = model.getOffsetAt(range.getEndPosition());
			text = `${text.slice(0, start)}${this.tagValueFor(mention)}${text.slice(end)}`;
		}
		const blocks = this.contextBlocks(replacements.map(item => item.mention).reverse());
		const mediaLines = attachmentPathLines(this.displayMentions()).join('\n');
		return [text.trim(), ...blocks, mediaLines].filter(Boolean).join('\n\n');
	}

	clear(): void {
		const model = this.editor.getModel();
		const oldIds = this.mentions.map(mention => mention.decorationId).filter((id): id is string => !!id);
		const removed = this.mentions.slice();
		this.mentions.length = 0;
		this.mentionCatalog.length = 0;
		if (model && oldIds.length) {
			model.deltaDecorations(oldIds, []);
		}
		for (const mention of removed) {
			this.onDidRemoveMention?.(mention);
		}
		this.notifyImages();
	}

	addBrowserMention(label: string, value?: string): IAgentMention | undefined {
		this.insertingMention = true;
		try {
			const insertRange = this.cursorRangeAfterSpacer();
			if (!insertRange) {
				return undefined;
			}
			const accent = this.mentions.filter(mention => mention.kind === 'browser').length % BROWSER_MENTION_ACCENTS;
			const mention: IAgentMention = {
				id: `browser:${generateUuid()}`,
				kind: 'browser',
				label: truncateLabel(label, 28),
				value,
				accent,
			};
			this.insertMention(mention, insertRange);
			return mention;
		} finally {
			this.insertingMention = false;
		}
	}

	/**
	 * Text selected in a chat transcript, sent as a `chat_selection` block in place of the chip.
	 * With a source (one assistant reply), the chip leads back to the quoted words.
	 */
	addChatSelectionMention(text: string, agentId: string, source?: Omit<IAgentCitation, 'agentId' | 'comment'>): void {
		const insertRange = this.cursorRangeAfterSpacer();
		if (!insertRange) {
			return;
		}
		const citation: IAgentCitation = { ...source, agentId, quote: source?.quote ?? text.trim() };
		this.insertMention({
			id: `selection:${generateUuid()}`,
			kind: 'selection',
			label: citationLabel(citation),
			value: serializeChatSelection(citation),
			citation,
		}, insertRange);
	}

	/** Opens the comment editor on a quote chip (its pencil). */
	private editCitationComment(mention: IAgentMention, anchor: HTMLElement): void {
		const citation = mention.citation;
		if (!citation) {
			return;
		}
		showCitationCommentEditor(this.contextViewService, {
			anchor,
			quote: citation.quote,
			comment: citation.comment,
			onSave: comment => {
				this.setCitationComment(mention, comment);
				this.editor.focus();
			},
			onHide: () => this.editor.focus(),
		});
	}

	/** A new comment changes the chip's text (the comment shows in place of the quote). */
	private setCitationComment(mention: IAgentMention, comment: string): void {
		const model = this.editor.getModel();
		const range = mention.decorationId && model ? model.getDecorationRange(mention.decorationId) : undefined;
		if (!model || !range || !mention.citation) {
			return;
		}
		const citation = withCitationComment(mention.citation, comment);
		const label = citationLabel(citation);
		mention.citation = citation;
		mention.value = serializeChatSelection(citation);
		if (label === mention.label) {
			this.addDecoration(mention, range);
			return;
		}
		const wasInserting = this.insertingMention;
		this.insertingMention = true;
		try {
			this.editor.executeEdits('volt-agent-citation-comment', [{ range, text: label }]);
			mention.label = label;
			this.addDecoration(mention, {
				startLineNumber: range.startLineNumber,
				startColumn: range.startColumn,
				endLineNumber: range.startLineNumber,
				endColumn: range.startColumn + label.length,
			});
		} finally {
			this.insertingMention = wasInserting;
		}
	}

	addResourceMention(resource: URI, range?: { startLineNumber: number; endLineNumber: number }): void {
		const insertRange = this.cursorRangeAfterSpacer();
		if (!insertRange) {
			return;
		}
		const start = range?.startLineNumber;
		const end = range?.endLineNumber;
		const rangeLabel = start && end
			? (start === end ? `${start}` : `${start}-${end}`)
			: undefined;
		const name = basename(resource.path) || resource.path;
		this.insertMention({
			id: `${resource.toString()}:${rangeLabel ?? 'file'}:${generateUuid()}`,
			kind: 'file',
			label: rangeLabel ? `${truncateLabel(name)} (${rangeLabel})` : truncateLabel(name),
			resource,
			range: start && end ? { startLineNumber: start, endLineNumber: end } : undefined,
		}, insertRange);
	}

	async addResourceMentions(resources: readonly URI[]): Promise<void> {
		for (const resource of resources) {
			if (this.hasWholeResourceMention(resource)) {
				continue;
			}
			const insertRange = this.cursorRangeAfterSpacer();
			if (!insertRange) {
				return;
			}
			await this.insertResource(resource, insertRange);
		}
	}

	private hasWholeResourceMention(resource: URI): boolean {
		return this.mentions.some(mention => !mention.range && mention.resource?.toString() === resource.toString());
	}

	/**
	 * Chips must not be glued to preceding text, so pad the cursor with a space when needed.
	 */
	private cursorRangeAfterSpacer(): IRange | undefined {
		const model = this.editor.getModel();
		if (!model) {
			return undefined;
		}
		const position = this.editor.getPosition() ?? model.getFullModelRange().getEndPosition();
		let startColumn = position.column;
		if (startColumn > 1) {
			const before = model.getValueInRange({
				startLineNumber: position.lineNumber,
				startColumn: startColumn - 1,
				endLineNumber: position.lineNumber,
				endColumn: startColumn,
			});
			if (before && before !== ' ' && before !== '\t') {
				this.editor.executeEdits('volt-agent-mention-space', [{
					range: {
						startLineNumber: position.lineNumber,
						startColumn,
						endLineNumber: position.lineNumber,
						endColumn: startColumn,
					},
					text: ' ',
				}]);
				startColumn += 1;
			}
		}
		return {
			startLineNumber: position.lineNumber,
			startColumn,
			endLineNumber: position.lineNumber,
			endColumn: startColumn,
		};
	}

	/** True while the panel shows, and for the rest of a keystroke it consumed (Enter that picked a row closes it). */
	get isMenuOpen(): boolean {
		return this.mentionMenu.isVisible || this.menuKeyConsumed;
	}

	/** Types an @ at the cursor and opens the panel on Files & Folders. */
	openFilePicker(): void {
		this.editor.focus();
		if (this.getAtQuery()) {
			this.dismissedToken = undefined;
			this.menuToken = undefined;
			this.pendingMenuView = 'files';
			this.refreshMentionMenu(true);
			return;
		}
		const range = this.cursorRangeAfterSpacer();
		if (!range) {
			return;
		}
		this.pendingMenuView = 'files';
		const cursor = new Selection(range.startLineNumber, range.startColumn + 1, range.startLineNumber, range.startColumn + 1);
		this.editor.executeEdits('volt-agent-mention-at', [{ range: Range.lift(range), text: '@' }], [cursor]);
	}

	private registerListeners(): void {
		const domNode = this.editor.getDomNode();
		if (domNode) {
			domNode.classList.add('show-file-icons');
			// Capture: Monaco's own paste handler would type an image's file name before ours runs.
			this._register(addDisposableListener(domNode, 'paste', e => this.handlePaste(e), true));
			this._register(addDisposableListener(domNode, 'copy', e => this.handleCopy(e)));
			this._register(addDisposableListener(domNode, 'cut', e => this.handleCopy(e)));
		}

		this._register(this.editor.onDropIntoEditor(e => {
			e.event.preventDefault();
			e.event.stopPropagation();
			void this.handleDrop(e.event, e.position);
		}));

		this._register(this.editor.onMouseMove(e => {
			const mention = this.mentionFromMouse(e);
			this.setHoveredMention(mention);
			if (mention?.resource && mention.range) {
				this.codePreview.scheduleShow(mention, { x: e.event.posx, y: e.event.posy });
			} else {
				this.codePreview.scheduleHide();
			}
		}));
		this._register(this.editor.onMouseLeave(() => {
			this.setHoveredMention(undefined);
			this.codePreview.scheduleHide();
		}));

		this._register(this.editor.onMouseDown(e => {
			if (!e.event.leftButton) {
				return;
			}
			const mention = this.mentionFromMouse(e);
			if (mention && this.isMentionIconTarget(e)) {
				e.event.preventDefault();
				e.event.stopPropagation();
				this.removeMention(mention);
			} else if (mention?.citation && e.target.element?.classList.contains('volt-agent-mention-edit')) {
				e.event.preventDefault();
				e.event.stopPropagation();
				this.editCitationComment(mention, e.target.element);
			}
		}));

		this._register(this.editor.onMouseUp(e => {
			if (!e.event.leftButton || e.event.detail > 1) {
				return;
			}
			const mention = this.mentionFromMouse(e);
			if (!mention || this.isMentionIconTarget(e) || e.target.element?.classList.contains('volt-agent-mention-edit')) {
				return;
			}
			if (this.editor.getSelection() && !this.editor.getSelection()?.isEmpty()) {
				return;
			}
			if (mention.kind === 'image' && mention.image) {
				const index = this.imageMentions().indexOf(mention);
				if (index >= 0) {
					this.openImageViewer(index);
				}
			} else if (mention.kind === 'video' && mention.video) {
				this.openVideoViewer(mention);
			} else if (mention.kind === 'file' || mention.kind === 'folder') {
				void this.openMention(mention);
			} else if (mention.citation) {
				this.host.openCitation?.(mention.citation, e.target.element ?? undefined);
			}
		}));

		this._register(this.editor.onDidChangeModelContent(() => {
			this.syncMentionRanges();
			this.scheduleMenuRefresh(true);
		}));
		this._register(this.editor.onDidChangeCursorPosition(() => {
			if (this.mentionMenu.isVisible) {
				this.scheduleMenuRefresh(false);
			}
		}));
		this._register(this.editor.onDidBlurEditorText(() => {
			// Pressing a row focuses the panel's list: hand focus back and keep the panel for the click.
			// Anything else means the user left the composer.
			setTimeout(() => {
				if (this.disposed) {
					return;
				}
				if (this.mentionMenu.containsFocus) {
					this.editor.focus();
				} else if (!this.editor.hasTextFocus()) {
					this.closeMentionMenu();
				}
			}, 0);
		}));

		this._register(this.editor.onKeyDown(e => {
			if (this.mentionMenu.isVisible && this.handleMenuKey(e, () => {
				// Before the action runs: its edit flushes the editor's queued events, which delivers
				// this same keystroke to the composer's own handlers (Enter would send).
				e.preventDefault();
				e.stopPropagation();
				this.menuKeyConsumed = true;
				setTimeout(() => this.menuKeyConsumed = false, 0);
			})) {
				return;
			}
			if (e.keyCode === KeyCode.Backspace || e.keyCode === KeyCode.Delete) {
				this.tryDeleteMention(e, e.keyCode === KeyCode.Delete);
			}
		}));
	}

	private onDragHover(e: DragEvent, target: HTMLElement, hovering: boolean): void {
		e.preventDefault();
		e.stopPropagation();
		if (e.dataTransfer) {
			e.dataTransfer.dropEffect = 'copy';
		}
		target.classList.toggle('drop-target', hovering);
	}

	private findMentionAt(position: IPosition): IAgentMention | undefined {
		const model = this.editor.getModel();
		if (!model) {
			return undefined;
		}
		for (const mention of this.mentions) {
			if (!mention.decorationId) {
				continue;
			}
			const range = model.getDecorationRange(mention.decorationId);
			if (range && Range.containsPosition(range, position)) {
				return mention;
			}
		}
		return undefined;
	}

	private async openMention(mention: IAgentMention): Promise<void> {
		const resource = mention.resource;
		if (!resource) {
			return;
		}
		if (mention.kind === 'folder') {
			await this.commandService.executeCommand('revealInExplorer', resource);
			return;
		}
		if (this.host.openResource) {
			this.host.openResource(resource, mention.range);
			return;
		}
		await this.editorService.openEditor({
			resource,
			options: {
				pinned: true,
				revealIfOpened: true,
				selection: mention.range ? {
					startLineNumber: mention.range.startLineNumber,
					startColumn: 1,
					endLineNumber: mention.range.endLineNumber,
					endColumn: Number.MAX_SAFE_INTEGER,
				} : undefined,
			},
		});
	}

	private cursorRange(): IRange {
		const pos = this.editor.getPosition() ?? { lineNumber: 1, column: 1 };
		return { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column };
	}

	private getAtQuery(): { query: string; range: IRange } | undefined {
		const model = this.editor.getModel();
		const pos = this.editor.getPosition();
		if (!model || !pos) {
			return undefined;
		}
		const before = model.getLineContent(pos.lineNumber).slice(0, pos.column - 1);
		const match = before.match(/(^|[\s])(@[^\s]*)$/);
		if (!match) {
			return undefined;
		}
		const token = match[2];
		const startColumn = pos.column - token.length;
		return {
			query: token.slice(1),
			range: { startLineNumber: pos.lineNumber, startColumn, endLineNumber: pos.lineNumber, endColumn: pos.column }
		};
	}

	private scheduleMenuRefresh(typed: boolean): void {
		this.menuTyped ||= typed;
		if (this.menuRefreshQueued) {
			return;
		}
		this.menuRefreshQueued = true;
		// After the edit settles: the content event fires before the cursor lands after the typed character.
		queueMicrotask(() => {
			this.menuRefreshQueued = false;
			const allowOpen = this.menuTyped;
			this.menuTyped = false;
			if (!this.disposed) {
				this.refreshMentionMenu(allowOpen);
			}
		});
	}

	/**
	 * Opens, updates, or closes the @ panel from the `@query` token before the cursor.
	 * Only typing opens it; moving the cursor can only update or close it.
	 */
	private refreshMentionMenu(allowOpen: boolean): void {
		const at = this.insertingMention ? undefined : this.getAtQuery();
		if (!at) {
			this.menuToken = undefined;
			this.dismissedToken = undefined;
			this.closeMentionMenu();
			return;
		}
		if (!this.editor.hasTextFocus()) {
			this.closeMentionMenu();
			return;
		}
		const token = `${at.range.startLineNumber}:${at.range.startColumn}`;
		if (token !== this.menuToken) {
			if (!allowOpen) {
				this.closeMentionMenu();
				return;
			}
			this.menuToken = token;
			this.menuView = this.pendingMenuView ?? 'root';
		}
		this.pendingMenuView = undefined;
		if (this.dismissedToken === token || (!this.mentionMenu.isVisible && !allowOpen)) {
			this.closeMentionMenu();
			return;
		}
		this.menuRange = at.range;
		this.menuQuery = at.query;
		this.paintMentionMenu();
	}

	private closeMentionMenu(): void {
		this.menuGeneration++;
		clearTimeout(this.menuSearchTimer);
		this.searchCts?.dispose(true);
		this.searchCts = undefined;
		this.mcpServers = undefined;
		this.mentionMenu.hide();
	}

	private paintMentionMenu(): void {
		const generation = ++this.menuGeneration;
		const view = this.menuView;
		const query = this.menuQuery;
		clearTimeout(this.menuSearchTimer);
		this.searchCts?.dispose(true);
		this.searchCts = undefined;
		const searches = !!query && (view === 'root' || view === 'files');
		let found: readonly IMentionFile[] | undefined = searches ? undefined : [];
		const paint = () => this.mentionMenu.show(this.menuContent(view, query, found));
		paint();
		if (view === 'root' && !this.mcpServers) {
			this.mcpServers = [];
			void this.runtime.listMcpServers(this.searchRoot()).then(servers => {
				if (generation === this.menuGeneration && this.mentionMenu.isVisible) {
					this.mcpServers = servers;
					paint();
				}
			}, () => undefined);
		}
		if (!searches) {
			return;
		}
		this.menuSearchTimer = setTimeout(() => {
			const cts = this.searchCts = new CancellationTokenSource();
			void this.searchWorkspace(query, cts.token).then(files => {
				if (generation === this.menuGeneration && this.mentionMenu.isVisible) {
					found = files;
					paint();
				}
			});
		}, MENU_SEARCH_DEBOUNCE_MS);
	}

	/**
	 * Up / Down / Enter / Tab / Escape drive the panel while it is open (Left / Right open and close
	 * folders in the file tree); the editor keeps focus. Calls `consume` before acting on a key it takes.
	 */
	private handleMenuKey(e: IKeyboardEvent, consume: () => void): boolean {
		if (e.altKey || e.metaKey || e.ctrlKey) {
			return false;
		}
		switch (e.keyCode) {
			case KeyCode.DownArrow:
				consume();
				this.mentionMenu.move(1);
				return true;
			case KeyCode.UpArrow:
				consume();
				this.mentionMenu.move(-1);
				return true;
			case KeyCode.RightArrow:
			case KeyCode.LeftArrow:
				if (!this.mentionMenu.isTree) {
					return false;
				}
				consume();
				if (e.keyCode === KeyCode.RightArrow) {
					this.mentionMenu.expand();
				} else {
					this.mentionMenu.collapse();
				}
				return true;
			case KeyCode.Enter:
			case KeyCode.Tab:
				if (e.shiftKey) {
					return false;
				}
				if (!this.mentionMenu.hasSelection) {
					// Nothing to pick: let Enter send and Tab do its usual thing.
					this.dismissedToken = this.menuToken;
					this.closeMentionMenu();
					return false;
				}
				consume();
				this.mentionMenu.accept();
				return true;
			case KeyCode.Escape:
				consume();
				if (this.menuView !== 'root') {
					this.setMenuView('root');
				} else {
					this.dismissedToken = this.menuToken;
					this.closeMentionMenu();
				}
				return true;
			case KeyCode.Backspace:
				if (this.menuView !== 'root' && !this.menuQuery) {
					consume();
					this.setMenuView('root');
					return true;
				}
				return false;
		}
		return false;
	}

	private setMenuView(view: MentionMenuView): void {
		this.menuView = view;
		const range = this.menuRange;
		if (range && this.menuQuery) {
			// The typed text picked the category; the sub list starts unfiltered.
			const cursor = new Selection(range.startLineNumber, range.startColumn + 1, range.startLineNumber, range.startColumn + 1);
			this.editor.executeEdits('volt-agent-mention-view', [{ range: Range.lift(range), text: '@' }], [cursor]);
			return;
		}
		this.refreshMentionMenu(true);
	}

	private menuContent(view: MentionMenuView, query: string, searched: readonly IMentionFile[] | undefined): AgentMentionMenuContent {
		const back: AgentMentionRow = {
			kind: 'item',
			id: 'back',
			label: localize('voltAgent.mention.back', "Back"),
			icon: Codicon.arrowLeft,
			trailing: localize('voltAgent.mention.esc', "Esc"),
			run: () => this.setMenuView('root'),
		};
		const searching = searched === undefined;

		if (view === 'files') {
			const root = this.searchRoot();
			if (!query && root) {
				const recent = this.fileRows('', [], MAX_RECENT_ITEMS);
				return {
					kind: 'tree',
					tree: {
						root,
						top: [back],
						bottom: recent.length ? [
							{ kind: 'separator', id: 'recent:sep' },
							{ kind: 'header', id: 'recent', title: localize('voltAgent.mention.recent', "Recent") },
							...recent.map(row => ({ ...row, id: `recent:${row.id}` })),
						] : [],
						children: folder => this.treeChildren(folder),
						pick: entry => this.pickResource({ resource: entry.resource, kind: entry.isDirectory ? FileKind.FOLDER : FileKind.FILE }),
					},
				};
			}
			const files = this.fileRows(query, searched, MAX_FILE_ITEMS);
			return {
				kind: 'list',
				rows: [back, ...(files.length ? files : [this.message(searching
					? localize('voltAgent.mention.searching', "Searching...")
					: query ? localize('voltAgent.mention.noFiles', "No matching files") : localize('voltAgent.mention.noRecentFiles', "Type to search files"))])],
			};
		}

		if (view === 'terminals') {
			const terminals = this.terminalRows(query);
			return { kind: 'list', rows: [back, ...(terminals.length ? terminals : [this.message(localize('voltAgent.mention.noTerminals', "No open terminals"))])] };
		}

		if (view === 'chats') {
			const chats = this.chatRows(query);
			return { kind: 'list', rows: [back, ...(chats.length ? chats : [this.message(query ? localize('voltAgent.mention.noMatchingChats', "No matching chats") : localize('voltAgent.mention.noChats', "No other chats in this project"))])] };
		}

		const categories: AgentMentionRow[] = [
			{ kind: 'item', id: 'files', label: localize('voltAgent.mention.files', "Files & Folders"), icon: Codicon.folder, submenu: true, run: () => this.setMenuView('files') },
			{ kind: 'item', id: 'terminals', label: localize('voltAgent.mention.terminals', "Terminals"), icon: Codicon.terminal, submenu: true, run: () => this.setMenuView('terminals') },
			{ kind: 'item', id: 'chats', label: localize('voltAgent.mention.chats', "Chats"), icon: Codicon.commentDiscussion, submenu: true, run: () => this.setMenuView('chats') },
			{
				kind: 'item',
				id: 'branch',
				label: localize('voltAgent.mention.branch', "Branch"),
				description: localize('voltAgent.mention.branchDetail', "Reference the current branch diff"),
				icon: Codicon.gitBranch,
				run: () => this.pickMention({ id: generateUuid(), kind: 'branch', label: 'Branch' }),
			},
			{
				kind: 'item',
				id: 'browser',
				label: localize('voltAgent.mention.browser', "Browser"),
				description: localize('voltAgent.mention.browserDetail', "Enable browser tools"),
				icon: Codicon.globe,
				run: () => this.pickMention({ id: generateUuid(), kind: 'browser', label: 'Browser' }),
			},
		];
		const shown = query ? filterRows(categories, query) : categories;
		// Below the categories: the connected MCP servers, or recent files when there are none.
		const servers = this.mcpRows(query);
		const files = servers.length && !query ? [] : this.fileRows(query, searched, query ? MAX_FILE_ITEMS : MAX_RECENT_ITEMS);
		const rest = [...servers, ...files];
		const rows: AgentMentionRow[] = [...shown];
		if (rest.length) {
			if (rows.length) {
				rows.push({ kind: 'separator', id: 'sep' });
			}
			rows.push(...rest);
		}
		if (!rows.length) {
			rows.push(this.message(searching ? localize('voltAgent.mention.searching', "Searching...") : localize('voltAgent.mention.noResults', "No results")));
		}
		return { kind: 'list', rows };
	}

	private message(text: string): AgentMentionRow {
		return { kind: 'message', id: 'message', text };
	}

	private mcpRows(query: string): AgentMentionRow[] {
		const rows: AgentMentionRow[] = [];
		for (const server of this.mcpServers ?? []) {
			const labelMatches = query ? matchesFuzzy(query, server.name, true) : undefined;
			if (query && !labelMatches) {
				continue;
			}
			rows.push({
				kind: 'item',
				id: `mcp:${server.name}`,
				label: server.name,
				labelMatches: labelMatches ?? undefined,
				description: server.scope === 'project'
					? localize('voltAgent.mention.projectMcp', "Project MCP server")
					: localize('voltAgent.mention.userMcp', "User MCP server"),
				icon: Codicon.server,
				trailing: server.state === 'ready' ? localize('voltAgent.mention.mcpReady', "Ready")
					: server.state === 'error' ? localize('voltAgent.mention.mcpError', "Error")
						: server.state === 'connecting' ? localize('voltAgent.mention.mcpConnecting', "Connecting...")
							: undefined,
				trailingTone: server.state === 'error' ? 'error' : undefined,
				run: () => this.pickMention({ id: generateUuid(), kind: 'mcp', label: server.name }),
			});
		}
		return rows;
	}

	private terminalRows(query: string): AgentMentionRow[] {
		const rows: AgentMentionRow[] = [];
		for (const instance of this.terminalService.instances) {
			const labelMatches = query ? matchesFuzzy(query, instance.title, true) : undefined;
			if (query && !labelMatches) {
				continue;
			}
			rows.push({
				kind: 'item',
				id: `terminal:${instance.instanceId}`,
				label: instance.title,
				labelMatches: labelMatches ?? undefined,
				icon: Codicon.terminal,
				run: () => this.pickMention({ id: generateUuid(), kind: 'terminal', label: truncateLabel(instance.title, 40), resource: instance.resource }),
			});
		}
		return rows;
	}

	/** Other chats of this project, newest first, with their age like the sidebar. */
	private chatRows(query: string): AgentMentionRow[] {
		const root = this.searchRoot()?.fsPath;
		const current = this.host.sessionId?.();
		const now = Date.now();
		const rows: AgentMentionRow[] = [];
		const sessions = this.agentHistory.list()
			.filter(session => session.id !== current && session.turnCount > 0
				&& (!root || session.workspaceFolder === root || !!session.workspaceFolders?.includes(root)))
			.sort((a, b) => b.updatedAt - a.updatedAt);
		for (const session of sessions) {
			const title = session.title || session.preview || localize('voltAgent.mention.untitledChat', "Untitled chat");
			const labelMatches = query ? matchesFuzzy(query, title, true) : undefined;
			if (query && !labelMatches) {
				continue;
			}
			rows.push({
				kind: 'item',
				id: `chat:${session.id}`,
				label: title,
				labelMatches: labelMatches ?? undefined,
				icon: Codicon.comment,
				description: compactSessionAge(session.updatedAt, now),
				run: () => {
					void this.loadChatContext(session.id);
					this.pickMention({ id: generateUuid(), kind: 'chat', label: truncateLabel(title, 40), value: session.id });
				},
			});
			if (rows.length >= MAX_CHAT_ITEMS) {
				break;
			}
		}
		return rows;
	}

	/** Recently opened files first, then the workspace search, ranked like Quick Open. */
	private fileRows(query: string, searched: readonly IMentionFile[] | undefined, limit: number): IAgentMentionFileRow[] {
		const seen = new Set<string>();
		const candidates: IMentionFile[] = [];
		const add = (file: IMentionFile) => {
			const key = file.resource.toString();
			if (!seen.has(key)) {
				seen.add(key);
				candidates.push(file);
			}
		};
		for (const item of this.historyService.getHistory()) {
			const resource = EditorResourceAccessor.getOriginalUri(item);
			if (resource && this.fileService.hasProvider(resource)) {
				add({ resource, kind: FileKind.FILE });
			}
		}
		for (const file of searched ?? []) {
			add(file);
		}

		let ranked: { file: IMentionFile; labelMatch?: IMatch[] }[];
		if (query) {
			const prepared = prepareQuery(query);
			const cache: FuzzyScorerCache = Object.create(null);
			const accessor: IItemAccessor<IMentionFile> = {
				getItemLabel: file => basename(file.resource.path),
				getItemDescription: file => this.folderLabel(file.resource),
				getItemPath: file => file.resource.fsPath,
			};
			ranked = candidates
				.map(file => ({ file, score: scoreItemFuzzy(file, prepared, true, accessor, cache) }))
				.filter(item => item.score.score > 0)
				.sort((a, b) => compareItemsByFuzzyScore(a.file, b.file, prepared, true, accessor, cache))
				.map(item => ({ file: item.file, labelMatch: item.score.labelMatch }));
		} else {
			ranked = candidates.map(file => ({ file }));
		}

		return ranked.slice(0, limit).map(({ file, labelMatch }) => ({
			kind: 'file',
			id: file.resource.toString(),
			resource: file.resource,
			fileKind: file.kind,
			labelMatches: labelMatch,
			description: this.folderLabel(file.resource) || undefined,
			run: () => this.pickResource(file),
		}));
	}

	/** A folder's children like the explorer: folders first, natural name order, `files.exclude` hidden. */
	private async treeChildren(folder: URI): Promise<IAgentMentionTreeEntry[]> {
		const stat = await this.fileService.resolve(folder, { resolveMetadata: false });
		const root = this.searchRoot();
		const excludes = this.configurationService.getValue<IExpression>('files.exclude', { resource: folder }) ?? {};
		return (stat.children ?? [])
			.filter(child => !glob(excludes, (root && relativePath(root, child.resource)) || child.name))
			.sort((a, b) => a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : compareFileNamesDefault(a.name, b.name))
			.map(child => ({ resource: child.resource, isDirectory: child.isDirectory }));
	}

	/** Folder of a file, relative to the project when inside it (`src/app`), else a home-relative path. */
	private folderLabel(resource: URI): string {
		const folder = dirname(resource);
		const root = this.searchRoot();
		if (root && isEqualOrParent(folder, root)) {
			return relativePath(root, folder) ?? '';
		}
		return this.labelService.getUriLabel(folder, { relative: true });
	}

	private pickMention(mention: IAgentMention): void {
		const range = this.menuRange;
		this.menuToken = undefined;
		this.closeMentionMenu();
		if (range) {
			this.insertMention(mention, range);
		}
	}

	private pickResource(file: IMentionFile): void {
		const range = this.menuRange;
		this.menuToken = undefined;
		this.closeMentionMenu();
		if (range) {
			void this.insertResource(file.resource, range, file.kind);
		}
	}

	/** The hover button on a file row. */
	private openBeside(resource: URI): void {
		if (this.host.openResource) {
			this.host.openResource(resource);
		} else {
			void this.editorService.openEditor({ resource, options: { pinned: true, revealIfOpened: true } });
		}
	}

	private searchRoot(): URI | undefined {
		return this.host.root?.() ?? this.workspaceContextService.getWorkspace().folders[0]?.uri;
	}

	private async searchWorkspace(query: string, token: CancellationToken): Promise<IMentionFile[]> {
		const root = this.searchRoot();
		if (!root) {
			return [];
		}
		try {
			const result = await searchFilesAndFolders(root, query, true, token, undefined, this.configurationService, this.searchService);
			return [
				...result.folders.map(resource => ({ resource, kind: FileKind.FOLDER })),
				...result.files.map(resource => ({ resource, kind: FileKind.FILE })),
			];
		} catch {
			return []; // cancelled or failed search
		}
	}

	/** Loads a past chat's transcript once, so sending can attach it without waiting. */
	private async loadChatContext(sessionId: string): Promise<void> {
		if (this.chatContexts.has(sessionId)) {
			return;
		}
		try {
			const transcript = await this.agentHistory.open(sessionId).load();
			const parts: string[] = [];
			for (const turn of transcript.turns) {
				parts.push(`User: ${turn.user.text.trim()}`);
				if (turn.assistant?.text.trim()) {
					parts.push(`Assistant: ${turn.assistant.text.trim()}`);
				}
			}
			const text = parts.join('\n\n');
			// Keep the end: the latest turns say where the chat landed.
			this.chatContexts.set(sessionId, text.length > MAX_CHAT_CONTEXT_CHARS ? `...\n${text.slice(-MAX_CHAT_CONTEXT_CHARS)}` : text);
		} catch {
			// A missing log: the mention still names the chat.
		}
	}

	/** What a chat or terminal mention stands for, appended after the prompt. */
	private contextBlocks(mentions: readonly IAgentMention[]): string[] {
		const blocks: string[] = [];
		const seen = new Set<string>();
		for (const mention of mentions) {
			const key = `${mention.kind}:${mention.value ?? mention.resource?.toString() ?? mention.label}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			if (mention.kind === 'chat' && mention.value) {
				const transcript = this.chatContexts.get(mention.value);
				if (transcript) {
					blocks.push(`<attached_chat title="${mention.label}">\n${transcript}\n</attached_chat>`);
				}
			} else if (mention.kind === 'terminal' && mention.resource) {
				const output = this.terminalOutput(mention.resource);
				if (output) {
					blocks.push(`<attached_terminal name="${mention.label}">\n${output}\n</attached_terminal>`);
				}
			}
		}
		return blocks;
	}

	private terminalOutput(resource: URI): string | undefined {
		const lines: string[] = [];
		const iterator = this.terminalService.getInstanceFromResource(resource)?.xterm?.getBufferReverseIterator();
		if (!iterator) {
			return undefined;
		}
		for (const line of iterator) {
			lines.push(line);
			if (lines.length >= MAX_TERMINAL_LINES) {
				break;
			}
		}
		return lines.reverse().join('\n').trim() || undefined;
	}

	private getCursorAnchor(): { x: number; y: number; width: number; height: number } {
		const pos = this.editor.getPosition() ?? { lineNumber: 1, column: 1 };
		const visible = this.editor.getScrolledVisiblePosition(pos);
		const node = this.editor.getDomNode();
		if (!visible || !node) {
			return { x: 0, y: 0, width: 1, height: 1 };
		}
		const page = getDomNodePagePosition(node);
		return {
			x: page.left + visible.left,
			y: page.top + visible.top,
			width: 1,
			height: visible.height
		};
	}

	private async insertResource(resource: URI, replaceRange: IRange, fileKind?: FileKind): Promise<void> {
		if (fileKind !== FileKind.FOLDER && isImageUri(resource)) {
			await this.insertImageFromUri(resource, replaceRange);
			return;
		}
		if (fileKind !== FileKind.FOLDER && isVideoUri(resource)) {
			await this.insertVideoFromUri(resource, replaceRange);
			return;
		}
		let kind: AgentMentionKind = fileKind === FileKind.FOLDER ? 'folder' : 'file';
		if (fileKind === undefined) {
			try {
				const stat = await this.fileService.stat(resource);
				kind = stat.isDirectory ? 'folder' : 'file';
			} catch {
				kind = 'file';
			}
		}
		this.insertMention({
			id: resource.toString(),
			kind,
			label: truncateLabel(basename(resource.path) || resource.path),
			resource,
		}, replaceRange);
	}

	private async insertImageFromUri(resource: URI, replaceRange: IRange): Promise<void> {
		try {
			const file = await this.fileService.readFile(resource);
			this.insertImage(file.value.buffer, this.mimeFor(resource), replaceRange, basename(resource.path), resource);
		} catch {
			this.insertMention({
				id: resource.toString(),
				kind: 'file',
				label: truncateLabel(basename(resource.path)),
				resource,
			}, replaceRange);
		}
	}

	/** A video from disk keeps its path; one past {@link MAX_VIDEO_BYTES} becomes a plain file mention. */
	private async insertVideoFromUri(resource: URI, replaceRange: IRange): Promise<void> {
		const name = basename(resource.path);
		const asFile = () => this.insertMention({ id: resource.toString(), kind: 'file', label: truncateLabel(name), resource }, replaceRange);
		try {
			const stat = await this.fileService.stat(resource);
			if (stat.size !== undefined && stat.size > MAX_VIDEO_BYTES) {
				this.notifyVideoTooLarge(name, stat.size);
				asFile();
				return;
			}
			const file = await this.fileService.readFile(resource);
			this.insertVideo(file.value.buffer, videoMimeForExtension(name.split('.').pop() ?? '') ?? 'video/mp4', replaceRange, name, resource);
		} catch {
			asFile();
		}
	}

	private insertVideo(bytes: Uint8Array, mime: string, replaceRange: IRange, fileName: string | undefined, resource?: URI): void {
		const id = `video-${generateUuid()}`;
		const type = normalizeVideoMime(mime);
		const name = this.uniqueMediaName(fileName || `video.${videoExtensionForMime(type)}`);
		const video: IAgentVideoPayload = {
			id,
			mime: type,
			name,
			size: bytes.byteLength,
			bytes,
			path: resource?.scheme === 'file' ? resource.fsPath : undefined,
		};
		const mention: IAgentMention = { id, kind: 'video', label: name, resource, video };
		this.insertMention(mention, replaceRange);
		this.prepareVideo(video);
	}

	private insertImage(bytes: Uint8Array, mime: string, replaceRange: IRange, fileName: string | undefined, resource?: URI): void {
		const id = `image-${generateUuid()}`;
		const name = this.uniqueMediaName(fileName || `image.${imageExtension(mime)}`);
		const image: IAgentImagePayload = { id, mime, bytes, name };
		this.insertMention({
			id,
			kind: 'image',
			label: name,
			resource,
			image,
		}, replaceRange);
		this.persistImage(image);
	}

	/** Pasted screenshots are all `image.png`; number repeats so the text can tell them apart. */
	private uniqueMediaName(fileName: string): string {
		const name = truncateLabel(fileName, 40);
		const taken = new Set(this.mentions.filter(mention => mention.kind === 'image' || mention.kind === 'video').map(mention => mention.label));
		if (!taken.has(name)) {
			return name;
		}
		const dot = name.lastIndexOf('.');
		const stem = dot > 0 ? name.slice(0, dot) : name;
		const ext = dot > 0 ? name.slice(dot) : '';
		for (let n = 2; ; n++) {
			const candidate = `${stem} (${n})${ext}`;
			if (!taken.has(candidate)) {
				return candidate;
			}
		}
	}

	private mimeFor(resource: URI): string {
		const ext = basename(resource.path).split('.').pop()?.toLowerCase();
		if (ext === 'jpg' || ext === 'jpeg') {
			return 'image/jpeg';
		}
		if (ext === 'svg') {
			return 'image/svg+xml';
		}
		return ext ? `image/${ext}` : 'image/png';
	}

	private insertMention(mention: IAgentMention, replaceRange: IRange): void {
		const model = this.editor.getModel();
		if (!model) {
			return;
		}
		const text = `${chipText(mention.label)} `;
		const alreadyInserting = this.insertingMention;
		this.insertingMention = true;
		try {
			const start = { lineNumber: replaceRange.startLineNumber, column: replaceRange.startColumn };
			const endColumn = start.column + chipText(mention.label).length;
			const cursor = new Selection(start.lineNumber, endColumn + 1, start.lineNumber, endColumn + 1);
			this.editor.executeEdits('volt-agent-mention', [{
				range: Range.lift(replaceRange),
				text,
			}], [cursor]);
			this.addDecoration(mention, {
				startLineNumber: start.lineNumber,
				startColumn: start.column,
				endLineNumber: start.lineNumber,
				endColumn
			});
			this.mentions.push(mention);
			this.mentionCatalog.push(mention);
			this.editor.setSelections([cursor]);
			this.editor.focus();
		} finally {
			if (!alreadyInserting) {
				this.insertingMention = false;
			}
		}
		if (mention.kind === 'image' || mention.kind === 'video') {
			this.notifyImages();
		}
	}

	private addDecoration(mention: IAgentMention, range: IRange): void {
		const model = this.editor.getModel();
		if (!model) {
			return;
		}
		const oldIds = mention.decorationId ? [mention.decorationId] : [];
		const [pillId] = model.deltaDecorations(oldIds, this.decorationsFor(mention, range));
		mention.decorationId = pillId;
	}

	private decorationsFor(mention: IAgentMention, range: IRange): IModelDeltaDecoration[] {
		const hovered = this.hoveredMentionId === mention.id;
		const hoverClass = hovered ? ' hovered' : '';
		const accentClass = mention.kind === 'browser' ? ` c${mention.accent ?? 0}` : '';
		const detail = this.mediaDetail(mention);
		return [
			{
				range,
				options: {
					description: 'volt-agent-mention',
					inlineClassName: `volt-agent-mention-pill ${mention.kind}${accentClass}${hoverClass}`,
					inlineClassNameAffectsLetterSpacing: true,
					before: {
						content: '\u00a0',
						inlineClassName: `volt-agent-mention-icon ${mention.kind}${accentClass}${hoverClass} ${this.iconClassesFor(mention).join(' ')}`,
						inlineClassNameAffectsLetterSpacing: true,
						attachedData: { mentionId: mention.id },
					},
					after: detail ? {
						content: `\u00a0${detail}`,
						inlineClassName: `volt-agent-mention-size${hoverClass}`,
						inlineClassNameAffectsLetterSpacing: true,
						attachedData: { mentionId: mention.id },
					} : mention.citation ? {
						// The quote's pencil: add or change the comment.
						content: '\u00a0',
						inlineClassName: `volt-agent-mention-edit codicon codicon-edit${hoverClass}`,
						inlineClassNameAffectsLetterSpacing: true,
						attachedData: { mentionId: mention.id },
					} : undefined,
					stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
					hoverMessage: mention.resource && mention.range ? undefined : this.hoverFor(mention),
				}
			}
		];
	}

	private iconClassesFor(mention: IAgentMention): string[] {
		// The chip shows the picture itself, or a still of the video.
		if (mention.kind === 'image' && mention.image) {
			return ['volt-agent-mention-thumb', imageThumbClass(mention.image.bytes, mention.image.mime)];
		}
		if (mention.kind === 'video' && mention.video?.poster) {
			return ['volt-agent-mention-thumb', imageThumbClass(mention.video.poster, 'image/jpeg')];
		}
		return mentionIconClasses(mention, this.modelService, this.languageService);
	}

	/** `141 KB` after an image chip, `0:09 · 3.2 MB` after a video chip. */
	private mediaDetail(mention: IAgentMention): string | undefined {
		if (mention.kind === 'image' && mention.image) {
			return formatImageSize(mention.image.bytes.byteLength);
		}
		if (mention.kind === 'video' && mention.video) {
			return videoDetail(mention.video);
		}
		return undefined;
	}

	private mentionFromMouse(e: IEditorMouseEvent): IAgentMention | undefined {
		const attached = e.target.type === MouseTargetType.CONTENT_TEXT
			? (e.target.detail.injectedText?.options.attachedData as { mentionId?: string } | undefined)?.mentionId
			: undefined;
		if (attached) {
			const fromData = this.mentions.find(mention => mention.id === attached);
			if (fromData) {
				return fromData;
			}
		}
		if (e.target.element && this.elementHasMentionIcon(e.target.element)) {
			return this.mentions.find(mention => mention.id === this.hoveredMentionId)
				?? (e.target.position ? this.findMentionAt(e.target.position) : undefined);
		}
		if (e.target.position) {
			return this.findMentionAt(e.target.position);
		}
		return this.mentions.find(mention => mention.id === this.hoveredMentionId);
	}

	private isMentionIconTarget(e: IEditorMouseEvent): boolean {
		return !!e.target.element && this.elementHasMentionIcon(e.target.element);
	}

	private elementHasMentionIcon(element: HTMLElement): boolean {
		let current: HTMLElement | null = element;
		while (current) {
			if (current.classList.contains('volt-agent-mention-icon')) {
				return true;
			}
			current = current.parentElement;
		}
		return false;
	}

	private setHoveredMention(mention: IAgentMention | undefined): void {
		const next = mention?.id;
		if (this.hoveredMentionId === next) {
			return;
		}
		const previous = this.mentions.find(item => item.id === this.hoveredMentionId);
		this.hoveredMentionId = next;
		if (previous) {
			this.refreshMentionDecoration(previous);
		}
		if (mention) {
			this.refreshMentionDecoration(mention);
		}
		this.onDidHoverMention?.(mention);
	}

	private refreshMentionDecoration(mention: IAgentMention): void {
		const model = this.editor.getModel();
		if (!model || !mention.decorationId) {
			return;
		}
		const range = model.getDecorationRange(mention.decorationId);
		if (!range) {
			return;
		}
		this.addDecoration(mention, range);
	}

	private removeMention(mention: IAgentMention): void {
		const model = this.editor.getModel();
		if (!model || !mention.decorationId) {
			return;
		}
		const range = model.getDecorationRange(mention.decorationId);
		if (!range) {
			return;
		}
		let deleteRange: IRange = range;
		if (model.getValueInRange({
			startLineNumber: range.endLineNumber,
			startColumn: range.endColumn,
			endLineNumber: range.endLineNumber,
			endColumn: range.endColumn + 1
		}) === ' ') {
			deleteRange = new Range(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn + 1);
		}
		this.editor.executeEdits('volt-agent-mention-delete', [{ range: deleteRange, text: '' }]);
		model.deltaDecorations([mention.decorationId], []);
		mention.decorationId = undefined;
		const index = this.mentions.indexOf(mention);
		if (index >= 0) {
			this.mentions.splice(index, 1);
		}
		const catalogIndex = this.mentionCatalog.indexOf(mention);
		if (catalogIndex >= 0) {
			this.mentionCatalog.splice(catalogIndex, 1);
		}
		if (this.hoveredMentionId === mention.id) {
			this.hoveredMentionId = undefined;
			this.onDidHoverMention?.(undefined);
		}
		this.onDidRemoveMention?.(mention);
		if (mention.kind === 'image' || mention.kind === 'video') {
			this.notifyImages();
		}
	}

	private tagValueFor(mention: IAgentMention): string {
		if (mention.kind === 'image' && mention.image) {
			// The pixels and the saved path follow the prompt, numbered the same way.
			const number = this.imageMentions().indexOf(mention) + 1;
			return number > 0 ? `[Image #${number}: ${mention.label}]` : `[Image: ${mention.label}]`;
		}
		if (mention.kind === 'video' && mention.video) {
			const number = this.videoMentions().indexOf(mention) + 1;
			return number > 0 ? `[Video #${number}: ${mention.label}]` : `[Video: ${mention.label}]`;
		}
		// Named references; a chat's or terminal's content follows the prompt (see contextBlocks).
		if (mention.kind === 'chat' || mention.kind === 'terminal' || mention.kind === 'mcp') {
			return `@${mention.kind}/${mention.label}`;
		}
		if (mention.value) {
			return mention.value;
		}
		if (mention.resource) {
			const path = this.mentionPath(mention.resource);
			if (mention.range) {
				const { startLineNumber, endLineNumber } = mention.range;
				const lines = startLineNumber === endLineNumber ? `${startLineNumber}` : `${startLineNumber}-${endLineNumber}`;
				return `@${path}:${lines}`;
			}
			return `@${path}`;
		}
		return `@${mention.label}`;
	}

	/** `src/app/main.ts` for project files (what the agent resolves from its cwd), else the full path. */
	private mentionPath(resource: URI): string {
		const root = this.searchRoot();
		const relative = root && isEqualOrParent(resource, root) ? relativePath(root, resource) : undefined;
		return relative || this.labelService.getUriLabel(resource, { relative: true, noPrefix: true, separator: '/' });
	}

	private hoverFor(mention: IAgentMention): MarkdownString {
		if (mention.kind === 'image' && mention.image) {
			return new MarkdownString(localize('voltAgent.imageChipHover', "{0} · {1} — click to open", mention.label, formatImageSize(mention.image.bytes.byteLength)));
		}
		if (mention.kind === 'video' && mention.video) {
			return new MarkdownString(localize('voltAgent.videoChipHover', "{0} · {1} — click to trim, cut out parts or pick a frame", mention.label, videoDetail(mention.video)));
		}
		if (mention.citation) {
			return citationHover(mention.citation);
		}
		return new MarkdownString(this.tagValueFor(mention));
	}

	private handleCopy(e: ClipboardEvent): void {
		const model = this.editor.getModel();
		const selection = this.editor.getSelection();
		if (!model || !selection || selection.isEmpty() || !e.clipboardData) {
			return;
		}
		const selected = model.getValueInRange(selection);
		const selectionStart = model.getOffsetAt(selection.getStartPosition());
		const replacements = this.mentions
			.map(mention => {
				const range = mention.decorationId ? model.getDecorationRange(mention.decorationId) : undefined;
				return range && Range.areIntersecting(range, selection) ? { mention, range } : undefined;
			})
			.filter((item): item is { mention: IAgentMention; range: Range } => !!item)
			.sort((a, b) => model.getOffsetAt(b.range.getStartPosition()) - model.getOffsetAt(a.range.getStartPosition()));
		if (!replacements.length) {
			return;
		}
		let text = selected;
		for (const { mention, range } of replacements) {
			const start = Math.max(0, model.getOffsetAt(range.getStartPosition()) - selectionStart);
			const end = Math.min(selected.length, model.getOffsetAt(range.getEndPosition()) - selectionStart);
			if (end <= start) {
				continue;
			}
			text = `${text.slice(0, start)}${this.tagValueFor(mention)}${text.slice(end)}`;
		}
		e.preventDefault();
		e.stopPropagation();
		e.clipboardData.setData('text/plain', text);
	}

	private syncMentionRanges(): void {
		if (this.insertingMention) {
			return;
		}
		const model = this.editor.getModel();
		if (!model) {
			return;
		}
		const dropped: IAgentMention[] = [];
		for (let i = this.mentions.length - 1; i >= 0; i--) {
			const mention = this.mentions[i];
			if (!mention.decorationId) {
				this.mentions.splice(i, 1);
				dropped.push(mention);
				continue;
			}
			const range = model.getDecorationRange(mention.decorationId);
			if (!range || model.getValueInRange(range) !== chipText(mention.label)) {
				model.deltaDecorations([mention.decorationId], []);
				mention.decorationId = undefined;
				this.mentions.splice(i, 1);
				dropped.push(mention);
			}
		}
		this.reattachMentions();
		for (const mention of dropped) {
			if (!this.mentions.includes(mention)) {
				this.onDidRemoveMention?.(mention);
			}
		}
		this.notifyImages();
	}

	private reattachMentions(): void {
		const model = this.editor.getModel();
		if (!model) {
			return;
		}
		const used: IRange[] = [];
		for (const mention of this.mentions) {
			if (!mention.decorationId) {
				continue;
			}
			const range = model.getDecorationRange(mention.decorationId);
			if (range) {
				used.push(range);
			}
		}
		for (const mention of this.mentionCatalog) {
			if (this.mentions.includes(mention) && mention.decorationId) {
				continue;
			}
			const range = this.findUnusedLabelRange(chipText(mention.label), used);
			if (!range || used.some(existing => Range.areIntersecting(existing, range))) {
				continue;
			}
			this.addDecoration(mention, range);
			if (!this.mentions.includes(mention)) {
				this.mentions.push(mention);
			}
			used.push(range);
		}
	}

	private findUnusedLabelRange(label: string, used: IRange[]): IRange | undefined {
		const model = this.editor.getModel();
		if (!model || !label) {
			return undefined;
		}
		const lineCount = model.getLineCount();
		for (let lineNumber = 1; lineNumber <= lineCount; lineNumber++) {
			const line = model.getLineContent(lineNumber);
			let from = 0;
			while (from <= line.length - label.length) {
				const index = line.indexOf(label, from);
				if (index < 0) {
					break;
				}
				const range = new Range(lineNumber, index + 1, lineNumber, index + 1 + label.length);
				if (!used.some(existing => Range.areIntersecting(existing, range))) {
					return range;
				}
				from = index + label.length;
			}
		}
		return undefined;
	}

	private tryDeleteMention(e: { preventDefault(): void }, forward: boolean): void {
		const model = this.editor.getModel();
		const pos = this.editor.getPosition();
		const selection = this.editor.getSelection();
		if (!model || !pos) {
			return;
		}
		if (selection && !selection.isEmpty()) {
			const overlapping = this.mentions.find(mention => {
				if (!mention.decorationId) {
					return false;
				}
				const range = model.getDecorationRange(mention.decorationId);
				return !!range && Range.areIntersecting(range, selection);
			});
			if (overlapping) {
				e.preventDefault();
				this.removeMention(overlapping);
			}
			return;
		}
		for (const mention of this.mentions) {
			if (!mention.decorationId) {
				continue;
			}
			const range = model.getDecorationRange(mention.decorationId);
			if (!range || range.startLineNumber !== pos.lineNumber) {
				continue;
			}
			const hasTrailingSpace = model.getValueInRange({
				startLineNumber: range.endLineNumber,
				startColumn: range.endColumn,
				endLineNumber: range.endLineNumber,
				endColumn: range.endColumn + 1
			}) === ' ';
			const inside = pos.column > range.startColumn && pos.column < range.endColumn;
			const atStart = pos.column === range.startColumn;
			const atEnd = pos.column === range.endColumn;
			const afterSpace = hasTrailingSpace && pos.column === range.endColumn + 1;
			const shouldDelete = forward
				? atStart || inside
				: inside || atEnd || afterSpace;
			if (shouldDelete) {
				e.preventDefault();
				this.removeMention(mention);
				return;
			}
		}
	}

	private async handleDrop(e: DragEvent, position: IPosition | undefined): Promise<void> {
		const now = Date.now();
		if (now - this.lastDropAt < 80) {
			return;
		}
		this.lastDropAt = now;
		const insertAt = position ?? this.editor.getPosition() ?? { lineNumber: 1, column: 1 };
		const range: IRange = { startLineNumber: insertAt.lineNumber, startColumn: insertAt.column, endLineNumber: insertAt.lineNumber, endColumn: insertAt.column };
		const editors = extractEditorsDropData(e);
		if (editors.length) {
			for (const editor of editors) {
				if (editor.resource) {
					await this.insertResource(editor.resource, range);
				}
			}
			return;
		}
		const files = e.dataTransfer?.files;
		if (!files?.length) {
			return;
		}
		for (const file of Array.from(files)) {
			if (file.type.startsWith('video/')) {
				const path = (file as File & { path?: string }).path;
				if (path) {
					await this.insertResource(URI.file(path), range);
				} else if (file.size > MAX_VIDEO_BYTES) {
					this.notifyVideoTooLarge(file.name, file.size);
				} else {
					this.insertVideo(new Uint8Array(await file.arrayBuffer()), file.type, range, file.name);
				}
				continue;
			}
			if (file.type.startsWith('image/')) {
				const bytes = new Uint8Array(await file.arrayBuffer());
				this.insertImage(bytes, file.type || 'image/png', range, file.name);
				continue;
			}
			const path = (file as File & { path?: string }).path;
			if (path) {
				await this.insertResource(URI.file(path), range);
			}
		}
	}

	private handlePaste(e: ClipboardEvent): void {
		const files = Array.from(e.clipboardData?.items ?? [])
			.filter(item => item.type.startsWith('image/') || item.type.startsWith('video/'))
			.map(item => item.getAsFile())
			.filter((file): file is File => !!file);
		if (!files.length) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		for (const file of files) {
			if (file.type.startsWith('video/') && file.size > MAX_VIDEO_BYTES) {
				this.notifyVideoTooLarge(file.name, file.size);
				continue;
			}
			void file.arrayBuffer().then(buffer => {
				if (file.type.startsWith('video/')) {
					this.insertVideo(new Uint8Array(buffer), file.type, this.cursorRange(), file.name);
				} else {
					this.insertImage(new Uint8Array(buffer), file.type || 'image/png', this.cursorRange(), file.name);
				}
			});
		}
	}
}
