/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindow } from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { localize } from '../../../../../nls.js';

/** A still from a video, sent to the model as an image. `time` is in seconds from the clip's start. */
export interface IAgentVideoFrame {
	readonly time: number;
	readonly mime: string;
	readonly bytes: Uint8Array;
}

/** What a look at a video finds: its length, a poster for previews and the stills sent with the prompt. */
export interface IAgentVideoProbe {
	readonly duration: number;
	readonly width: number;
	readonly height: number;
	readonly poster: Uint8Array | undefined;
	readonly frames: readonly IAgentVideoFrame[];
}

/** Videos are held in memory while attached; bigger files would strain the window. */
export const MAX_VIDEO_BYTES = 256 * 1024 * 1024;

/** Stills sent per video: one per {@link SECONDS_PER_FRAME} of footage, between 1 and this many. */
export const MAX_VIDEO_FRAMES = 8;
const SECONDS_PER_FRAME = 1.5;
/** Long edge of a sent still. Larger frames cost tokens without helping the model read the screen. */
const FRAME_EDGE = 1280;
const POSTER_EDGE = 480;
const SEEK_TIMEOUT_MS = 5000;
const LOAD_TIMEOUT_MS = 15000;

const VIDEO_TYPES: Record<string, string> = {
	mp4: 'video/mp4',
	m4v: 'video/x-m4v',
	mov: 'video/quicktime',
	webm: 'video/webm',
	ogv: 'video/ogg',
};

export const VIDEO_EXTENSIONS: readonly string[] = Object.keys(VIDEO_TYPES);

export function videoMimeForExtension(ext: string): string | undefined {
	return VIDEO_TYPES[ext.toLowerCase()];
}

/** `mov` for `video/quicktime`; `mp4` when the type is unknown. */
export function videoExtensionForMime(mime: string): string {
	const type = normalizeVideoMime(mime);
	return Object.keys(VIDEO_TYPES).find(ext => VIDEO_TYPES[ext] === type) ?? 'mp4';
}

/** `video/webm;codecs=vp9` → `video/webm`. */
export function normalizeVideoMime(mime: string): string {
	return mime.split(';')[0].trim().toLowerCase() || 'video/mp4';
}

/** `0:09`, `1:02:03`; `precise` adds tenths (`0:09.4`). */
export function formatDuration(seconds: number, precise = false): string {
	const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
	const tenths = Math.round(safe * 10);
	const whole = precise ? Math.floor(tenths / 10) : Math.round(safe);
	const h = Math.floor(whole / 3600);
	const m = Math.floor((whole % 3600) / 60);
	const s = whole % 60;
	const clock = h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
	return precise ? `${clock}.${tenths % 10}` : clock;
}

/** How many stills a clip of this length sends. */
export function videoFrameCount(duration: number): number {
	if (!Number.isFinite(duration) || duration <= 0) {
		return 1;
	}
	return Math.max(1, Math.min(MAX_VIDEO_FRAMES, Math.ceil(duration / SECONDS_PER_FRAME)));
}

/** Evenly spread times from `start` to just before `end`, both ends included, so the first and last states show. */
export function videoFrameTimes(start: number, end: number, count: number): number[] {
	const last = Math.max(start, end - 0.05);
	if (count <= 1 || last - start < 0.05) {
		return [start + (last - start) / 2];
	}
	return Array.from({ length: count }, (_, i) => start + (last - start) * (i / (count - 1)));
}

/** A stretch of a video, in seconds. */
export interface ITimeRange {
	readonly start: number;
	readonly end: number;
}

const RANGE_EPSILON = 0.01;

export function rangesDuration(ranges: readonly ITimeRange[]): number {
	return ranges.reduce((sum, range) => sum + Math.max(0, range.end - range.start), 0);
}

/** `ranges` in order, with overlapping or touching ones joined and empty ones dropped. */
export function mergeRanges(ranges: readonly ITimeRange[]): ITimeRange[] {
	const merged: ITimeRange[] = [];
	for (const range of ranges.filter(r => r.end - r.start > RANGE_EPSILON).sort((a, b) => a.start - b.start)) {
		const last = merged[merged.length - 1];
		if (last && range.start <= last.end + RANGE_EPSILON) {
			merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
		} else {
			merged.push({ start: range.start, end: range.end });
		}
	}
	return merged;
}

/** The parts of `window` no removed range covers, in order; slivers under `minLength` are dropped. */
export function keptRanges(window: ITimeRange, removed: readonly ITimeRange[], minLength = 0.05): ITimeRange[] {
	const kept: ITimeRange[] = [];
	let cursor = window.start;
	for (const range of mergeRanges(removed)) {
		if (range.end <= cursor) {
			continue;
		}
		if (range.start >= window.end) {
			break;
		}
		if (range.start > cursor) {
			kept.push({ start: cursor, end: range.start });
		}
		cursor = range.end;
	}
	if (cursor < window.end) {
		kept.push({ start: cursor, end: window.end });
	}
	return kept.filter(range => range.end - range.start >= minLength);
}

/**
 * Maps ranges on a clip's own timeline onto the file it was cut from, given the parts of that
 * file the clip is made of (in order). A cut of a cut still names times in the original.
 */
export function mapRangesToSource(ranges: readonly ITimeRange[], source: readonly ITimeRange[]): ITimeRange[] {
	const mapped: ITimeRange[] = [];
	for (const range of ranges) {
		let offset = 0;
		for (const part of source) {
			const length = part.end - part.start;
			const start = Math.max(range.start, offset);
			const end = Math.min(range.end, offset + length);
			if (end - start > RANGE_EPSILON) {
				mapped.push({ start: part.start + start - offset, end: part.start + end - offset });
			}
			offset += length;
		}
	}
	return mergeRanges(mapped);
}

export interface IVideoHandle {
	readonly video: HTMLVideoElement;
	readonly duration: number;
	dispose(): void;
}

/**
 * A muted, off-screen video element for the clip, loaded far enough to seek and draw. Recorded
 * WebM has no duration in its header; seeking past the end makes the decoder find it.
 */
export async function loadVideo(targetWindow: Window, source: Uint8Array | Blob, mime: string): Promise<IVideoHandle> {
	const blob = source instanceof Blob ? source : new Blob([source as Uint8Array<ArrayBuffer>], { type: mime });
	const url = URL.createObjectURL(blob);
	const video = targetWindow.document.createElement('video');
	video.muted = true;
	video.preload = 'auto';
	video.playsInline = true;
	const dispose = () => {
		video.removeAttribute('src');
		video.load();
		URL.revokeObjectURL(url);
	};
	try {
		video.src = url;
		await waitFor(video, 'loadeddata', LOAD_TIMEOUT_MS);
		const duration = await resolveDuration(video);
		return { video, duration, dispose };
	} catch (err) {
		dispose();
		throw err;
	}
}

export function whenVideoLoaded(video: HTMLVideoElement): Promise<void> {
	return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ? Promise.resolve() : waitFor(video, 'loadeddata', LOAD_TIMEOUT_MS);
}

export async function resolveDuration(video: HTMLVideoElement): Promise<number> {
	if (Number.isFinite(video.duration)) {
		return video.duration;
	}
	const found = waitFor(video, 'durationchange', SEEK_TIMEOUT_MS).then(() => video.duration, () => NaN);
	video.currentTime = Number.MAX_SAFE_INTEGER;
	const duration = await found;
	await seekVideo(video, 0);
	return Number.isFinite(duration) ? duration : 0;
}

export async function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
	const target = Math.max(0, time);
	if (Math.abs(video.currentTime - target) < 0.001 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
		return;
	}
	const seeked = waitFor(video, 'seeked', SEEK_TIMEOUT_MS);
	video.currentTime = target;
	await seeked;
}

/** The frame showing at `time`, scaled down to `maxEdge` when given. */
export async function grabVideoFrame(video: HTMLVideoElement, time: number | undefined, options: { maxEdge?: number; mime?: string; quality?: number } = {}): Promise<Uint8Array | undefined> {
	if (time !== undefined) {
		await seekVideo(video, time);
	}
	const width = video.videoWidth;
	const height = video.videoHeight;
	if (!width || !height) {
		return undefined;
	}
	const scale = options.maxEdge ? Math.min(1, options.maxEdge / Math.max(width, height)) : 1;
	const canvas = video.ownerDocument.createElement('canvas');
	canvas.width = Math.max(1, Math.round(width * scale));
	canvas.height = Math.max(1, Math.round(height * scale));
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		return undefined;
	}
	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
	const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, options.mime ?? 'image/jpeg', options.quality ?? 0.82));
	return blob ? new Uint8Array(await blob.arrayBuffer()) : undefined;
}

/** Length, poster and the stills to send. Throws when the window can't decode the video. */
export async function probeVideo(targetWindow: Window, bytes: Uint8Array, mime: string): Promise<IAgentVideoProbe> {
	const handle = await loadVideo(targetWindow, bytes, mime);
	try {
		const { video, duration } = handle;
		const frames: IAgentVideoFrame[] = [];
		for (const time of videoFrameTimes(0, duration, videoFrameCount(duration))) {
			const frame = await grabVideoFrame(video, time, { maxEdge: FRAME_EDGE });
			if (frame) {
				frames.push({ time, mime: 'image/jpeg', bytes: frame });
			}
		}
		// The first still doubles as the poster; a separate small one keeps thumbnails cheap.
		const poster = await grabVideoFrame(video, frames[0]?.time ?? 0, { maxEdge: POSTER_EDGE, quality: 0.78 });
		return { duration, width: video.videoWidth, height: video.videoHeight, poster, frames };
	} finally {
		handle.dispose();
	}
}

const RECORDER_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

type CapturableVideo = HTMLVideoElement & { captureStream?(): MediaStream };

/**
 * Records the given parts of a video, back to back, into one new WebM clip. The browser can't cut
 * a file without re-encoding, so this plays each part once (muted) while a MediaRecorder captures
 * it, pausing the recorder while it seeks to the next part. Returns undefined when cancelled.
 */
export async function recordVideoSegments(
	video: HTMLVideoElement,
	segments: readonly ITimeRange[],
	onProgress: (fraction: number) => void,
	token: CancellationToken,
): Promise<{ bytes: Uint8Array; mime: string } | undefined> {
	const capturable = video as CapturableVideo;
	const mimeType = RECORDER_TYPES.find(type => MediaRecorder.isTypeSupported(type));
	if (!capturable.captureStream || !mimeType) {
		throw new Error(localize('voltAgent.videoCantRecord', "This window can't record video."));
	}
	if (!segments.length) {
		return undefined;
	}
	const total = Math.max(rangesDuration(segments), 0.001);
	video.pause();
	await seekVideo(video, segments[0].start);
	const tracks = capturable.captureStream().getVideoTracks();
	if (!tracks.length) {
		throw new Error(localize('voltAgent.videoNoTrack', "The video has no picture to record."));
	}
	const recorder = new MediaRecorder(new MediaStream(tracks), { mimeType, videoBitsPerSecond: 8_000_000 });
	const chunks: Blob[] = [];
	recorder.ondataavailable = e => {
		if (e.data.size) {
			chunks.push(e.data);
		}
	};
	const stopped = new Promise<void>(resolve => recorder.onstop = () => resolve());
	const wasMuted = video.muted;
	const wasRate = video.playbackRate;
	video.muted = true;
	video.playbackRate = 1;
	try {
		let recorded = 0;
		for (const segment of segments) {
			if (token.isCancellationRequested) {
				break;
			}
			await seekVideo(video, segment.start);
			// Start (or resume) once frames flow, so the clip doesn't hold a still while playback spins up.
			await video.play();
			if (recorder.state === 'inactive') {
				recorder.start(250);
			} else {
				recorder.resume();
			}
			await playUntil(video, segment.end, time => onProgress(Math.min(1, (recorded + time - segment.start) / total)), token);
			if (recorder.state === 'recording') {
				recorder.pause();
			}
			video.pause();
			recorded += segment.end - segment.start;
		}
	} finally {
		video.pause();
		if (recorder.state !== 'inactive') {
			recorder.stop();
		}
		await stopped;
		tracks.forEach(track => track.stop());
		video.muted = wasMuted;
		video.playbackRate = wasRate;
	}
	if (token.isCancellationRequested) {
		return undefined;
	}
	onProgress(1);
	const blob = new Blob(chunks, { type: normalizeVideoMime(recorder.mimeType || mimeType) });
	return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: normalizeVideoMime(blob.type) };
}

/** Resolves when playback reaches `end`, stops, or is cancelled. */
function playUntil(video: HTMLVideoElement, end: number, onTime: (time: number) => void, token: CancellationToken): Promise<void> {
	return new Promise<void>(resolve => {
		const win = getWindow(video);
		let frame = 0;
		const check = () => {
			if (token.isCancellationRequested || video.ended || video.paused || video.currentTime >= end) {
				win.cancelAnimationFrame(frame);
				video.removeEventListener('timeupdate', check);
				resolve();
				return;
			}
			onTime(video.currentTime);
		};
		const loop = () => {
			check();
			frame = win.requestAnimationFrame(loop);
		};
		// Animation frames stop in a hidden window; timeupdate still ends the part there.
		video.addEventListener('timeupdate', check);
		frame = win.requestAnimationFrame(loop);
	});
}

function waitFor(video: HTMLVideoElement, event: 'loadeddata' | 'seeked' | 'durationchange', timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const win = getWindow(video);
		const done = (error?: Error) => {
			video.removeEventListener(event, onEvent);
			video.removeEventListener('error', onError);
			win.clearTimeout(timer);
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		};
		const onEvent = () => done();
		const onError = () => done(new Error(video.error?.message || localize('voltAgent.videoUnreadable', "This video can't be played here.")));
		const timer = win.setTimeout(() => done(new Error(localize('voltAgent.videoTimeout', "The video took too long to load."))), timeoutMs);
		video.addEventListener(event, onEvent);
		video.addEventListener('error', onError);
	});
}
