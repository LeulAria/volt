/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { createStrokeIcon } from '../chrome/agentModeIcons.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { closeMediaDialog, trackMediaDialog } from './agentImageAttachments.js';
import { formatDuration, grabVideoFrame, ITimeRange, keptRanges, loadVideo, mergeRanges, rangesDuration, recordVideoSegments, resolveDuration, videoExtensionForMime, whenVideoLoaded } from './agentVideoAttachments.js';

export interface IAgentVideoViewerOptions {
	/** Any element in the window the dialog opens in. */
	readonly anchor: HTMLElement;
	/** The dialog title (`Attached video 1`). */
	readonly title: string;
	/** The file name (`screen.mov`). */
	readonly name: string;
	readonly mime: string;
	/** The clip in memory; else it is read from `path`. */
	readonly bytes?: Uint8Array;
	readonly path?: string;
	/** Present when the clip can be trimmed and have parts deleted. */
	readonly onTrim?: (clip: IAgentVideoClip) => void;
	/** Present when a still can be added to the prompt. */
	readonly onCaptureFrame?: (frame: { readonly bytes: Uint8Array; readonly mime: string; readonly time: number }) => void;
	readonly onDidClose?: () => void;
}

/** An edit made in the viewer: the new clip and the parts of the open one it is made of, in order. */
export interface IAgentVideoClip {
	readonly bytes: Uint8Array;
	readonly mime: string;
	readonly segments: readonly ITimeRange[];
}

/** One undo step: the selection and the deleted parts. */
interface IEditState {
	readonly start: number;
	readonly end: number;
	readonly removed: readonly ITimeRange[];
}

type DragMode = 'start' | 'end' | 'move' | 'body' | 'seek';

/** The shortest part a cut keeps, in seconds. */
const MIN_SELECTION = 0.3;
const FRAME_STEP = 1 / 30;

/** Opens the video dialog; one image or video dialog at a time per app. */
export function showAgentVideoViewer(createViewer: (options: IAgentVideoViewerOptions) => AgentVideoViewer, options: IAgentVideoViewerOptions): IDisposable {
	closeMediaDialog();
	const viewer = createViewer(options);
	trackMediaDialog(viewer);
	return viewer;
}

/**
 * A large player for a prompt's video. Composer videos get a trim timeline, as in a video editor:
 * drag the yellow handles (or the whole selection) to keep only a part, scrub to any frame and add
 * it to the prompt as an image. Done records the kept part as a new clip.
 */
export class AgentVideoViewer extends Disposable {

	private readonly overlay: HTMLElement;
	private readonly dialog: HTMLElement;
	private readonly stage: HTMLElement;
	private readonly video: HTMLVideoElement;
	private readonly message: HTMLElement;
	private readonly busy: HTMLElement;
	private readonly busyLabel: HTMLElement;
	private readonly busyBar: HTMLElement;
	private readonly playButton: HTMLButtonElement;
	private readonly muteButton: HTMLButtonElement;
	private readonly timeLabel: HTMLElement;
	private readonly rangeLabel: HTMLElement;
	private readonly timeline: HTMLElement;
	private readonly filmstrip: HTMLElement;
	private readonly shadeStart: HTMLElement;
	private readonly shadeEnd: HTMLElement;
	private readonly selection: HTMLElement;
	private readonly playhead: HTMLElement;
	private readonly doneButton: HTMLButtonElement | undefined;
	private readonly resetButton: HTMLButtonElement | undefined;
	private readonly deleteButton: HTMLButtonElement | undefined;
	private readonly removedLayer: HTMLElement;
	private readonly captureButton: HTMLButtonElement | undefined;

	private readonly editable: boolean;
	private source: Uint8Array | undefined;
	private sourceUrl: string | undefined;
	private readonly frameUrls: string[] = [];
	private duration = 0;
	private start = 0;
	private end = 0;
	private loaded = false;
	/** Parts cut out of the clip; playback skips them and Done leaves them out. */
	private removed: readonly ITimeRange[] = [];
	private removedKey = '';
	private readonly undoStack: IEditState[] = [];
	private readonly redoStack: IEditState[] = [];
	private drag: { mode: DragMode; readonly pointerId: number; readonly x: number; readonly time: number; readonly start: number; readonly end: number } | undefined;
	private trimming: CancellationTokenSource | undefined;
	private animationFrame = 0;
	private closed = false;
	private readonly closeListeners: (() => void)[] = [];

	constructor(
		private readonly options: IAgentVideoViewerOptions,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IFileService private readonly fileService: IFileService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this.editable = !!options.onTrim;
		const win = getWindow(options.anchor);

		this.overlay = append(win.document.body, $('.volt-agent-image-viewer-overlay'));
		this.overlay.tabIndex = -1;
		this.overlay.setAttribute('role', 'dialog');
		this.overlay.setAttribute('aria-modal', 'true');
		this.dialog = append(this.overlay, $('.volt-agent-image-viewer.volt-agent-video-viewer'));
		this.dialog.classList.toggle('editable', this.editable);

		const head = append(this.dialog, $('.volt-agent-image-viewer-head'));
		const titleRow = append(head, $('.volt-agent-image-viewer-title-row'));
		const title = append(titleRow, $('span.volt-agent-image-viewer-title'));
		title.textContent = options.title;
		setAgentTooltip(title, options.name);

		const actions = append(head, $('.volt-agent-image-viewer-actions'));
		if (options.onCaptureFrame) {
			this.captureButton = this.iconButton(actions, createStrokeIcon('video-capture', [
				'M4 8.5A2.5 2.5 0 0 1 6.5 6h1.6l1.2-2h5.4l1.2 2h1.6A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5v-8Z',
				'M12 15.8a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z',
			]), localize('voltAgent.videoCapture', "Add this frame to the prompt"), () => void this.captureFrame(), 'F');
		}
		this.iconButton(actions, Codicon.desktopDownload, localize('voltAgent.videoDownload', "Save video as…"), () => void this.download());
		if (this.editable) {
			this.doneButton = append(actions, $('button.volt-agent-image-viewer-done')) as HTMLButtonElement;
			this.doneButton.type = 'button';
			this._register(addDisposableListener(this.doneButton, EventType.CLICK, () => void this.done()));
		} else {
			this.iconButton(actions, Codicon.close, localize('voltAgent.imageClose', "Close"), () => this.dispose(), 'Esc');
		}

		this.stage = append(this.dialog, $('.volt-agent-image-viewer-stage.volt-agent-video-stage'));
		this.video = append(this.stage, $('video.volt-agent-video-player')) as HTMLVideoElement;
		this.video.playsInline = true;
		this.video.preload = 'auto';
		this.message = append(this.stage, $('.volt-agent-image-viewer-error.hidden'));
		this.busy = append(this.stage, $('.volt-agent-video-busy.hidden'));
		this.busyLabel = append(this.busy, $('span.volt-agent-video-busy-label'));
		this.busyBar = append(append(this.busy, $('.volt-agent-video-busy-track')), $('span.volt-agent-video-busy-bar'));
		const cancel = append(this.busy, $('button.volt-agent-image-cropbar-btn')) as HTMLButtonElement;
		cancel.type = 'button';
		cancel.textContent = localize('voltAgent.videoTrimCancel', "Cancel");
		this._register(addDisposableListener(cancel, EventType.CLICK, () => this.trimming?.cancel()));

		const controls = append(this.dialog, $('.volt-agent-video-controls'));
		const row = append(controls, $('.volt-agent-video-controls-row'));
		this.playButton = this.iconButton(row, Codicon.play, localize('voltAgent.videoPlay', "Play"), () => this.togglePlay(), 'Space');
		this.timeLabel = append(row, $('span.volt-agent-video-time'));
		this.muteButton = this.iconButton(row, Codicon.unmute, localize('voltAgent.videoMute', "Mute"), () => this.toggleMute());
		append(row, $('span.volt-agent-video-spacer'));
		this.rangeLabel = append(row, $('span.volt-agent-video-range'));
		if (this.editable) {
			this.deleteButton = append(row, $('button.volt-agent-image-cropbar-btn.volt-agent-video-delete')) as HTMLButtonElement;
			this.deleteButton.type = 'button';
			this.deleteButton.appendChild(createStrokeIcon('video-cut', [
				'M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM6.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
				'M8.6 7.6L20 17M8.6 16.4L20 7',
			]));
			append(this.deleteButton, $('span')).textContent = localize('voltAgent.videoDelete', "Delete");
			setAgentTooltip(this.deleteButton, localize('voltAgent.videoDeleteHint', "Cut the selected part out of the video"), '\u232b');
			this._register(addDisposableListener(this.deleteButton, EventType.CLICK, () => this.deleteSelection()));
			this.resetButton = append(row, $('button.volt-agent-image-cropbar-btn.volt-agent-video-reset')) as HTMLButtonElement;
			this.resetButton.type = 'button';
			this.resetButton.textContent = localize('voltAgent.videoReset', "Reset");
			setAgentTooltip(this.resetButton, localize('voltAgent.videoResetHint', "Keep the whole video"));
			this._register(addDisposableListener(this.resetButton, EventType.CLICK, () => this.edit(0, this.duration, [])));
		}

		this.timeline = append(controls, $('.volt-agent-video-timeline'));
		this.timeline.setAttribute('role', 'slider');
		this.timeline.setAttribute('aria-label', localize('voltAgent.videoTimeline', "Timeline"));
		this.filmstrip = append(this.timeline, $('.volt-agent-video-filmstrip'));
		this.shadeStart = append(this.timeline, $('.volt-agent-video-shade.start'));
		this.shadeEnd = append(this.timeline, $('.volt-agent-video-shade.end'));
		this.removedLayer = append(this.timeline, $('.volt-agent-video-removed-layer'));
		this.selection = append(this.timeline, $('.volt-agent-video-selection'));
		const startHandle = append(this.selection, $('.volt-agent-video-handle.start'));
		const endHandle = append(this.selection, $('.volt-agent-video-handle.end'));
		setAgentTooltip(startHandle, localize('voltAgent.videoStartHandle', "Drag to set where the selection starts"), 'I');
		setAgentTooltip(endHandle, localize('voltAgent.videoEndHandle', "Drag to set where the selection ends"), 'O');
		this.playhead = append(this.timeline, $('.volt-agent-video-playhead'));

		this.registerListeners(win);
		this.syncChrome();
		this.overlay.focus();
		void this.load();
	}

	onClose(listener: () => void): void {
		this.closeListeners.push(listener);
	}

	private iconButton(parent: HTMLElement, icon: ThemeIcon | HTMLElement, label: string, run: () => void, shortcut?: string): HTMLButtonElement {
		const button = append(parent, $('button.volt-agent-image-viewer-btn')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('aria-label', label);
		button.appendChild(ThemeIcon.isThemeIcon(icon) ? renderIcon(icon) : icon);
		setAgentTooltip(button, label, shortcut);
		this._register(addDisposableListener(button, EventType.CLICK, e => {
			e.preventDefault();
			run();
		}));
		return button;
	}

	private setIcon(button: HTMLButtonElement, icon: ThemeIcon, label: string, shortcut?: string): void {
		button.replaceChildren(renderIcon(icon));
		button.setAttribute('aria-label', label);
		setAgentTooltip(button, label, shortcut);
	}

	//#region Loading

	private async load(): Promise<void> {
		let bytes = this.options.bytes;
		if (!bytes && this.options.path) {
			try {
				bytes = (await this.fileService.readFile(URI.file(this.options.path))).value.buffer;
			} catch {
				// Shown below.
			}
		}
		if (this.closed) {
			return;
		}
		if (!bytes) {
			this.showMessage(localize('voltAgent.videoMissing', "The video file is no longer on disk."));
			return;
		}
		this.source = bytes;
		this.sourceUrl = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: this.options.mime }));
		this.video.src = this.sourceUrl;
		try {
			await whenVideoLoaded(this.video);
			this.duration = await resolveDuration(this.video);
		} catch (err) {
			if (!this.closed) {
				this.showMessage(err instanceof Error ? err.message : localize('voltAgent.videoUnreadable', "This video can't be played here."));
			}
			return;
		}
		if (this.closed) {
			return;
		}
		this.loaded = true;
		this.start = 0;
		this.end = this.duration;
		this.syncChrome();
		void this.renderFilmstrip(bytes);
	}

	private showMessage(text: string): void {
		this.video.classList.add('hidden');
		this.message.classList.remove('hidden');
		this.message.textContent = text;
		this.dialog.classList.add('failed');
	}

	/** Small stills across the timeline, decoded off screen so the player keeps its place. */
	private async renderFilmstrip(bytes: Uint8Array): Promise<void> {
		const count = Math.max(6, Math.min(16, Math.round(this.timeline.clientWidth / 72)));
		const tiles = Array.from({ length: count }, () => {
			const img = append(this.filmstrip, $('img.volt-agent-video-film-frame')) as HTMLImageElement;
			img.alt = '';
			img.draggable = false;
			return img;
		});
		let handle;
		try {
			handle = await loadVideo(getWindow(this.overlay), bytes, this.options.mime);
		} catch {
			return;
		}
		try {
			for (let i = 0; i < count && !this.closed; i++) {
				const frame = await grabVideoFrame(handle.video, ((i + 0.5) / count) * this.duration, { maxEdge: 180, quality: 0.7 });
				if (frame && !this.closed) {
					const url = URL.createObjectURL(new Blob([frame as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }));
					this.frameUrls.push(url);
					tiles[i].src = url;
				}
			}
		} catch {
			// The stills are decoration; the player works without them.
		} finally {
			handle.dispose();
		}
	}

	//#endregion

	//#region Chrome

	/** The selection spans the whole video. */
	private get selectsAll(): boolean {
		return this.start <= 0.05 && this.end >= this.duration - 0.05;
	}

	/** What Done keeps: the selection, less the deleted parts. */
	private get kept(): ITimeRange[] {
		return keptRanges({ start: this.start, end: this.end }, this.removed);
	}

	private get unchanged(): boolean {
		return this.selectsAll && !this.removed.length;
	}

	/** Cutting the selection out still leaves something to keep. */
	private get canDelete(): boolean {
		return this.loaded && !this.selectsAll && rangesDuration(keptRanges({ start: 0, end: this.duration }, [...this.removed, { start: this.start, end: this.end }])) >= MIN_SELECTION;
	}

	private syncChrome(): void {
		const duration = this.duration || 1;
		const pct = (t: number) => `${Math.max(0, Math.min(100, (t / duration) * 100))}%`;
		this.selection.style.left = pct(this.start);
		this.selection.style.width = pct(this.end - this.start);
		this.shadeStart.style.width = pct(this.start);
		this.shadeEnd.style.left = pct(this.end);
		this.playhead.style.left = pct(this.video.currentTime);
		this.timeLabel.textContent = `${formatDuration(this.video.currentTime, true)} / ${formatDuration(this.duration, true)}`;
		this.timeline.setAttribute('aria-valuemin', '0');
		this.timeline.setAttribute('aria-valuemax', String(Math.round(this.duration * 10) / 10));
		this.timeline.setAttribute('aria-valuenow', String(Math.round(this.video.currentTime * 10) / 10));
		this.dialog.classList.toggle('trimmed', this.editable && !this.selectsAll);
		this.syncRemoved(pct);
		const keptSeconds = rangesDuration(this.kept);
		if (this.editable) {
			this.rangeLabel.textContent = !this.loaded ? ''
				: this.removed.length
					? localize('voltAgent.videoKeeps', "Selected {0} \u2013 {1} · keeps {2}s", formatDuration(this.start, true), formatDuration(this.end, true), keptSeconds.toFixed(1))
					: localize('voltAgent.videoRange', "{0} \u2013 {1} · {2}s", formatDuration(this.start, true), formatDuration(this.end, true), (this.end - this.start).toFixed(1));
		}
		if (this.deleteButton) {
			this.deleteButton.disabled = !this.canDelete;
		}
		if (this.resetButton) {
			this.resetButton.disabled = !this.loaded || this.unchanged;
		}
		if (this.doneButton) {
			this.doneButton.disabled = this.loaded && keptSeconds < MIN_SELECTION;
			this.doneButton.textContent = this.loaded && !this.unchanged
				? localize('voltAgent.videoTrim', "Trim to {0}s", keptSeconds.toFixed(1))
				: localize('voltAgent.imageDone', "Done");
		}
		if (this.captureButton) {
			this.captureButton.disabled = !this.loaded;
		}
		this.playButton.disabled = !this.loaded;
	}

	/** Hatched blocks over the deleted parts; clicking one brings it back. */
	private syncRemoved(pct: (t: number) => string): void {
		const key = this.removed.map(range => `${range.start}-${range.end}`).join('|') + `@${this.duration}`;
		if (key === this.removedKey) {
			return;
		}
		this.removedKey = key;
		clearNode(this.removedLayer);
		this.removed.forEach((range, index) => {
			const block = append(this.removedLayer, $('.volt-agent-video-removed'));
			block.dataset.index = String(index);
			block.style.left = pct(range.start);
			block.style.width = pct(range.end - range.start);
			setAgentTooltip(block, localize('voltAgent.videoRemoved', "Deleted {0} \u2013 {1}. Click to bring it back", formatDuration(range.start, true), formatDuration(range.end, true)));
		});
	}

	private setSelection(start: number, end: number): void {
		this.start = Math.max(0, Math.min(start, this.duration));
		this.end = Math.max(this.start, Math.min(end, this.duration));
		this.syncChrome();
	}

	/** An undoable change to the selection and the deleted parts. */
	private edit(start: number, end: number, removed: readonly ITimeRange[]): void {
		this.undoStack.push({ start: this.start, end: this.end, removed: this.removed });
		this.redoStack.length = 0;
		this.removed = mergeRanges(removed);
		this.setSelection(start, end);
	}

	/** Cuts the selected part out; the selection goes back to the whole video. */
	private deleteSelection(): void {
		if (!this.canDelete || this.trimming) {
			return;
		}
		const cut = { start: this.start, end: this.end };
		this.edit(0, this.duration, [...this.removed, cut]);
		this.seek(cut.start);
	}

	private restoreRemoved(index: number): void {
		const range = this.removed[index];
		if (range) {
			this.edit(this.start, this.end, this.removed.filter(item => item !== range));
		}
	}

	private undo(): void {
		const previous = this.undoStack.pop();
		if (previous) {
			this.redoStack.push({ start: this.start, end: this.end, removed: this.removed });
			this.removed = previous.removed;
			this.setSelection(previous.start, previous.end);
		}
	}

	private redo(): void {
		const next = this.redoStack.pop();
		if (next) {
			this.undoStack.push({ start: this.start, end: this.end, removed: this.removed });
			this.removed = next.removed;
			this.setSelection(next.start, next.end);
		}
	}

	/** The end of the deleted part `time` falls in, if any. */
	private skipRemoved(time: number): number | undefined {
		return this.removed.find(range => time >= range.start && time < range.end - 0.02)?.end;
	}

	//#endregion

	//#region Playback

	private togglePlay(): void {
		if (!this.loaded || this.trimming) {
			return;
		}
		if (!this.video.paused) {
			this.video.pause();
			return;
		}
		// Play the kept part: from its start when the playhead is outside it or at its end.
		if (this.editable && (this.video.currentTime < this.start - 0.01 || this.video.currentTime >= this.end - 0.05)) {
			this.video.currentTime = this.start;
		}
		const skipTo = this.editable ? this.skipRemoved(this.video.currentTime) : undefined;
		if (skipTo !== undefined) {
			this.video.currentTime = skipTo;
		}
		void this.video.play().catch(() => undefined);
	}

	private toggleMute(): void {
		this.video.muted = !this.video.muted;
		this.setIcon(this.muteButton, this.video.muted ? Codicon.mute : Codicon.unmute, this.video.muted ? localize('voltAgent.videoUnmute', "Unmute") : localize('voltAgent.videoMute', "Mute"));
	}

	private seek(time: number): void {
		this.video.currentTime = Math.max(0, Math.min(time, this.duration));
		this.syncChrome();
	}

	private step(delta: number): void {
		if (!this.loaded) {
			return;
		}
		this.video.pause();
		this.seek(this.video.currentTime + delta);
	}

	private tick = (): void => {
		this.animationFrame = 0;
		if (this.editable && !this.trimming && !this.video.paused) {
			// Preview the result: jump over deleted parts, stop at the end of the selection.
			const skipTo = this.skipRemoved(this.video.currentTime);
			if (skipTo !== undefined) {
				this.video.currentTime = skipTo;
			}
			if (this.video.currentTime >= this.end) {
				this.video.pause();
				this.video.currentTime = this.end;
			}
		}
		this.syncChrome();
		if (!this.video.paused && !this.closed) {
			this.animationFrame = getWindow(this.overlay).requestAnimationFrame(this.tick);
		}
	};

	//#endregion

	//#region Timeline

	private timeAt(clientX: number): number {
		const rect = this.timeline.getBoundingClientRect();
		const fraction = rect.width ? (clientX - rect.left) / rect.width : 0;
		return Math.max(0, Math.min(1, fraction)) * this.duration;
	}

	private onPointerDown(e: PointerEvent): void {
		if (e.button !== 0 || !this.loaded || this.trimming) {
			return;
		}
		e.preventDefault();
		const target = e.target as HTMLElement;
		const removedBlock = this.editable ? target.closest<HTMLElement>('.volt-agent-video-removed') : null;
		if (removedBlock) {
			this.restoreRemoved(Number(removedBlock.dataset.index));
			return;
		}
		const time = this.timeAt(e.clientX);
		let mode: DragMode = 'seek';
		if (this.editable && target.closest('.volt-agent-video-handle.start')) {
			mode = 'start';
		} else if (this.editable && target.closest('.volt-agent-video-handle.end')) {
			mode = 'end';
		} else if (this.editable && !target.closest('.volt-agent-video-playhead') && time > this.start && time < this.end && !this.selectsAll) {
			// Inside the kept part: a drag moves the whole part, a click seeks.
			mode = 'body';
		}
		this.video.pause();
		this.drag = { mode, pointerId: e.pointerId, x: e.clientX, time, start: this.start, end: this.end };
		this.timeline.setPointerCapture(e.pointerId);
		this.timeline.classList.add('dragging', mode);
		if (mode === 'seek') {
			this.seek(time);
		}
	}

	private onPointerMove(e: PointerEvent): void {
		const drag = this.drag;
		if (!drag || e.pointerId !== drag.pointerId) {
			return;
		}
		const time = this.timeAt(e.clientX);
		const shortest = Math.min(MIN_SELECTION, this.duration);
		switch (drag.mode) {
			case 'start':
				this.setSelection(Math.min(time, this.end - shortest), this.end);
				this.seek(this.start);
				break;
			case 'end':
				this.setSelection(this.start, Math.max(time, this.start + shortest));
				this.seek(this.end);
				break;
			case 'body':
				if (Math.abs(e.clientX - drag.x) < 3) {
					return;
				}
				drag.mode = 'move';
				this.timeline.classList.replace('body', 'move');
			// falls through
			case 'move': {
				const length = drag.end - drag.start;
				const start = Math.max(0, Math.min(drag.start + time - drag.time, this.duration - length));
				this.setSelection(start, start + length);
				this.seek(start);
				break;
			}
			case 'seek':
				this.seek(time);
				break;
		}
	}

	private onPointerUp(e: PointerEvent): void {
		const drag = this.drag;
		if (!drag || e.pointerId !== drag.pointerId) {
			return;
		}
		this.drag = undefined;
		if (this.timeline.hasPointerCapture(e.pointerId)) {
			this.timeline.releasePointerCapture(e.pointerId);
		}
		this.timeline.classList.remove('dragging', 'start', 'end', 'move', 'body', 'seek');
		if (drag.mode === 'body') {
			this.seek(drag.time);
		}
	}

	//#endregion

	//#region Actions

	private async captureFrame(): Promise<void> {
		if (!this.loaded || !this.options.onCaptureFrame) {
			return;
		}
		this.video.pause();
		const time = this.video.currentTime;
		try {
			const bytes = await grabVideoFrame(this.video, undefined, { mime: 'image/png' });
			if (!bytes || this.closed) {
				return;
			}
			this.options.onCaptureFrame({ bytes, mime: 'image/png', time });
			// Adding the image focuses the composer; keep the keys here.
			this.overlay.focus();
			this.captureButton?.classList.add('flash');
			getWindow(this.overlay).setTimeout(() => this.captureButton?.classList.remove('flash'), 600);
		} catch (err) {
			this.notificationService.warn(localize('voltAgent.videoCaptureFailed', "Couldn't capture the frame: {0}", String(err)));
		}
	}

	private async download(): Promise<void> {
		const bytes = this.source;
		if (!bytes) {
			return;
		}
		const ext = videoExtensionForMime(this.options.mime);
		const stem = this.options.name.replace(/\.[^.]+$/, '') || 'video';
		const target = await this.fileDialogService.showSaveDialog({
			title: localize('voltAgent.videoSaveTitle', "Save Video"),
			defaultUri: joinPath(await this.fileDialogService.defaultFilePath(), `${stem}.${ext}`),
			filters: [{ name: localize('voltAgent.videoFilter', "Videos"), extensions: [ext] }],
		});
		if (!target) {
			return;
		}
		try {
			await this.fileService.writeFile(target, VSBuffer.wrap(bytes));
		} catch (err) {
			this.notificationService.error(localize('voltAgent.videoSaveFailed', "Couldn't save the video: {0}", String(err)));
		}
	}

	/** Done: close, after recording the kept part when the selection leaves some out. */
	private async done(): Promise<void> {
		if (this.trimming) {
			return;
		}
		if (!this.loaded || this.unchanged || !this.options.onTrim) {
			this.dispose();
			return;
		}
		const segments = this.kept;
		if (rangesDuration(segments) < MIN_SELECTION) {
			return;
		}
		const cts = new CancellationTokenSource();
		this.trimming = cts;
		this.dialog.classList.add('trimming');
		this.busy.classList.remove('hidden');
		this.setProgress(0);
		try {
			const clip = await recordVideoSegments(this.video, segments, fraction => this.setProgress(fraction), cts.token);
			if (clip && !this.closed) {
				this.options.onTrim({ ...clip, segments });
				this.dispose();
			}
		} catch (err) {
			if (!this.closed) {
				this.notificationService.error(localize('voltAgent.videoTrimFailed', "Couldn't trim the video: {0}", err instanceof Error ? err.message : String(err)));
			}
		} finally {
			cts.dispose();
			this.trimming = undefined;
			if (!this.closed) {
				this.dialog.classList.remove('trimming');
				this.busy.classList.add('hidden');
				this.syncChrome();
			}
		}
	}

	private setProgress(fraction: number): void {
		this.busyLabel.textContent = localize('voltAgent.videoTrimming', "Trimming… {0}%", Math.round(fraction * 100));
		this.busyBar.style.width = `${Math.round(fraction * 100)}%`;
		this.syncChrome();
	}

	//#endregion

	private registerListeners(win: Window & typeof globalThis): void {
		this._register(addDisposableListener(this.overlay, EventType.MOUSE_DOWN, e => {
			if (e.target === this.overlay && !this.trimming) {
				this.dispose();
			}
		}));
		this._register(addDisposableListener(this.video, EventType.CLICK, () => this.togglePlay()));
		this._register(addDisposableListener(this.video, 'play', () => {
			this.setIcon(this.playButton, Codicon.debugPause, localize('voltAgent.videoPause', "Pause"), 'Space');
			if (!this.animationFrame) {
				this.animationFrame = win.requestAnimationFrame(this.tick);
			}
		}));
		this._register(addDisposableListener(this.video, 'pause', () => {
			this.setIcon(this.playButton, Codicon.play, localize('voltAgent.videoPlay', "Play"), 'Space');
			this.syncChrome();
		}));
		this._register(addDisposableListener(this.video, 'seeked', () => this.syncChrome()));
		this._register(addDisposableListener(this.timeline, EventType.POINTER_DOWN, e => this.onPointerDown(e)));
		this._register(addDisposableListener(this.timeline, EventType.POINTER_MOVE, e => this.onPointerMove(e)));
		this._register(addDisposableListener(this.timeline, EventType.POINTER_UP, e => this.onPointerUp(e)));
		this._register(addDisposableListener(this.timeline, 'pointercancel', e => this.onPointerUp(e)));
		this._register(addDisposableListener(this.overlay, EventType.KEY_DOWN, e => this.onKeyDown(e)));
		this._register(toDisposable(() => {
			if (this.animationFrame) {
				win.cancelAnimationFrame(this.animationFrame);
			}
		}));
	}

	private onKeyDown(e: KeyboardEvent): void {
		const handled = () => {
			e.preventDefault();
			e.stopPropagation();
		};
		if (e.key === 'Escape') {
			handled();
			if (this.trimming) {
				this.trimming.cancel();
			} else {
				this.dispose();
			}
			return;
		}
		const mod = isMacintosh ? e.metaKey : e.ctrlKey;
		if (this.editable && !this.trimming && mod && !e.altKey && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
			handled();
			if (e.key.toLowerCase() === 'y' || e.shiftKey) {
				this.redo();
			} else {
				this.undo();
			}
			return;
		}
		if (this.trimming || e.metaKey || e.ctrlKey || e.altKey) {
			return;
		}
		const key = e.key.toLowerCase();
		if (this.editable && (e.key === 'Backspace' || e.key === 'Delete')) {
			handled();
			this.deleteSelection();
			return;
		}
		if (key === ' ' || key === 'k') {
			handled();
			this.togglePlay();
		} else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			handled();
			this.step((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : FRAME_STEP));
		} else if (e.key === 'Home') {
			handled();
			this.seek(this.editable ? this.start : 0);
		} else if (e.key === 'End') {
			handled();
			this.seek(this.editable ? this.end : this.duration);
		} else if (this.editable && key === 'i' && this.loaded) {
			handled();
			this.setSelection(Math.min(this.video.currentTime, this.end - Math.min(MIN_SELECTION, this.duration)), this.end);
		} else if (this.editable && key === 'o' && this.loaded) {
			handled();
			this.setSelection(this.start, Math.max(this.video.currentTime, this.start + Math.min(MIN_SELECTION, this.duration)));
		} else if (key === 'f' && this.options.onCaptureFrame) {
			handled();
			void this.captureFrame();
		} else if (e.key === 'Enter' && this.editable) {
			handled();
			void this.done();
		}
	}

	override dispose(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.trimming?.cancel();
		this.video.pause();
		this.video.removeAttribute('src');
		this.video.load();
		if (this.sourceUrl) {
			URL.revokeObjectURL(this.sourceUrl);
		}
		this.frameUrls.forEach(url => URL.revokeObjectURL(url));
		this.overlay.remove();
		super.dispose();
		for (const listener of this.closeListeners) {
			listener();
		}
		this.options.onDidClose?.();
	}
}
