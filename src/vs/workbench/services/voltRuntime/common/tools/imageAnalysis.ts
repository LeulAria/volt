/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pixel math for the design tools (`browser_compare_image`, `image_inspect`): diffs, regions,
 * offsets, palettes, blocks and text bands on plain RGBA buffers. No DOM and no dependencies,
 * so it runs (and is tested) anywhere; the renderer only decodes and encodes the images.
 */

export interface IRgbaImage {
	readonly width: number;
	readonly height: number;
	/** Row-major RGBA, 4 bytes per pixel. */
	readonly data: Uint8ClampedArray | Uint8Array;
}

export interface IImageRect {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
}

export interface IImagePoint {
	readonly x: number;
	readonly y: number;
}

/** Biggest image the tools will analyse (about 4096 x 4096). */
export const MAX_ANALYSIS_PIXELS = 16_777_216;

export function toHex(r: number, g: number, b: number): string {
	const part = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
	return `#${part(r)}${part(g)}${part(b)}`;
}

/** The size that fits inside `maxSide` x `maxSide`, keeping the aspect ratio. Never scales up. */
export function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number } {
	const scale = Math.min(1, maxSide / Math.max(1, width), maxSide / Math.max(1, height));
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function createImage(width: number, height: number, fill?: readonly [number, number, number]): IRgbaImage {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < data.length; i += 4) {
		data[i] = fill?.[0] ?? 0;
		data[i + 1] = fill?.[1] ?? 0;
		data[i + 2] = fill?.[2] ?? 0;
		data[i + 3] = 255;
	}
	return { width, height, data };
}

/** Composites transparent pixels over `background` (white), so designs exported with alpha compare like the page. */
export function flattenAlpha(image: IRgbaImage, background: readonly [number, number, number] = [255, 255, 255]): IRgbaImage {
	const src = image.data;
	let opaque = true;
	for (let i = 3; i < src.length; i += 4) {
		if (src[i] !== 255) {
			opaque = false;
			break;
		}
	}
	if (opaque) {
		return image;
	}
	const data = new Uint8ClampedArray(src.length);
	for (let i = 0; i < src.length; i += 4) {
		const a = src[i + 3] / 255;
		data[i] = src[i] * a + background[0] * (1 - a);
		data[i + 1] = src[i + 1] * a + background[1] * (1 - a);
		data[i + 2] = src[i + 2] * a + background[2] * (1 - a);
		data[i + 3] = 255;
	}
	return { width: image.width, height: image.height, data };
}

/** A `{ x, y, w, h }` (or width/height) rectangle from tool arguments. */
export function parseRect(value: unknown): IImageRect | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const rect = value as Record<string, unknown>;
	const x = finite(rect.x), y = finite(rect.y), w = finite(rect.w ?? rect.width), h = finite(rect.h ?? rect.height);
	return x !== undefined && y !== undefined && w !== undefined && h !== undefined && w > 0 && h > 0 ? { x, y, w, h } : undefined;
}

function finite(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function clampRect(rect: IImageRect, width: number, height: number): IImageRect | undefined {
	const x = Math.max(0, Math.min(width, Math.round(rect.x)));
	const y = Math.max(0, Math.min(height, Math.round(rect.y)));
	const x1 = Math.max(x, Math.min(width, Math.round(rect.x + rect.w)));
	const y1 = Math.max(y, Math.min(height, Math.round(rect.y + rect.h)));
	return x1 > x && y1 > y ? { x, y, w: x1 - x, h: y1 - y } : undefined;
}

export function cropImage(image: IRgbaImage, rect: IImageRect): IRgbaImage {
	const r = clampRect(rect, image.width, image.height);
	if (!r) {
		throw new Error(`The rectangle ${rect.x},${rect.y} ${rect.w}x${rect.h} is outside the ${image.width}x${image.height} image.`);
	}
	const data = new Uint8ClampedArray(r.w * r.h * 4);
	for (let y = 0; y < r.h; y++) {
		const from = ((r.y + y) * image.width + r.x) * 4;
		data.set(image.data.subarray(from, from + r.w * 4), y * r.w * 4);
	}
	return { width: r.w, height: r.h, data };
}

/** Source taps and weights for each output sample along one axis: area average when shrinking, linear when growing. */
function axisWeights(srcLen: number, dstLen: number): { index: Int32Array; weight: Float32Array; start: Int32Array } {
	const index: number[] = [];
	const weight: number[] = [];
	const start = new Int32Array(dstLen + 1);
	const scale = srcLen / dstLen;
	for (let i = 0; i < dstLen; i++) {
		start[i] = index.length;
		if (scale >= 1) {
			const from = i * scale;
			const to = from + scale;
			for (let s = Math.floor(from); s < Math.min(srcLen, Math.ceil(to)); s++) {
				const overlap = Math.min(to, s + 1) - Math.max(from, s);
				if (overlap > 0) {
					index.push(s);
					weight.push(overlap / scale);
				}
			}
		} else {
			const center = Math.max(0, Math.min(srcLen - 1, (i + 0.5) * scale - 0.5));
			const s0 = Math.floor(center);
			const frac = center - s0;
			index.push(s0);
			weight.push(1 - frac);
			if (frac > 0 && s0 + 1 < srcLen) {
				index.push(s0 + 1);
				weight.push(frac);
			}
		}
	}
	start[dstLen] = index.length;
	return { index: Int32Array.from(index), weight: Float32Array.from(weight), start };
}

/** Resamples to `width` x `height`: a box (area) filter when shrinking, bilinear when growing. */
export function resizeRgba(image: IRgbaImage, width: number, height: number): IRgbaImage {
	width = Math.max(1, Math.round(width));
	height = Math.max(1, Math.round(height));
	if (width === image.width && height === image.height) {
		return image;
	}
	const sw = image.width;
	const sh = image.height;
	const src = image.data;
	const h = axisWeights(sw, width);
	const v = axisWeights(sh, height);
	const mid = new Float32Array(width * sh * 4);
	for (let y = 0; y < sh; y++) {
		const row = y * sw * 4;
		for (let x = 0; x < width; x++) {
			let r = 0, g = 0, b = 0, a = 0;
			for (let k = h.start[x]; k < h.start[x + 1]; k++) {
				const p = row + h.index[k] * 4;
				const w = h.weight[k];
				r += src[p] * w;
				g += src[p + 1] * w;
				b += src[p + 2] * w;
				a += src[p + 3] * w;
			}
			const o = (y * width + x) * 4;
			mid[o] = r;
			mid[o + 1] = g;
			mid[o + 2] = b;
			mid[o + 3] = a;
		}
	}
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let r = 0, g = 0, b = 0, a = 0;
			for (let k = v.start[y]; k < v.start[y + 1]; k++) {
				const p = (v.index[k] * width + x) * 4;
				const w = v.weight[k];
				r += mid[p] * w;
				g += mid[p + 1] * w;
				b += mid[p + 2] * w;
				a += mid[p + 3] * w;
			}
			const o = (y * width + x) * 4;
			data[o] = Math.round(r);
			data[o + 1] = Math.round(g);
			data[o + 2] = Math.round(b);
			data[o + 3] = Math.round(a);
		}
	}
	return { width, height, data };
}

function luminance(image: IRgbaImage): Uint8Array {
	const src = image.data;
	const out = new Uint8Array(image.width * image.height);
	for (let i = 0, p = 0; i < out.length; i++, p += 4) {
		out[i] = (src[p] * 77 + src[p + 1] * 150 + src[p + 2] * 29) >> 8;
	}
	return out;
}

//#region Compare

export interface IImageDiffOptions {
	/** A pixel differs when one channel is off by more than this (0-255). Default 16. */
	readonly threshold?: number;
	readonly maxRegions?: number;
}

export type DiffRegionKind = 'shifted' | 'missing' | 'extra' | 'color' | 'different';

export interface IDiffRegion {
	/** Tight box around the differing pixels, in image pixels. */
	readonly rect: IImageRect;
	readonly differing: number;
	/** Share of the box that differs (0-1). */
	readonly ratio: number;
	/** Average colour of the differing pixels in the reference and on the page. */
	readonly referenceColor: string;
	readonly pageColor: string;
	readonly kind: DiffRegionKind;
	/** Where the reference content sits on the page, when shifting explains the difference. */
	readonly offset?: { readonly dx: number; readonly dy: number };
}

export interface IImageDiff {
	readonly width: number;
	readonly height: number;
	readonly threshold: number;
	readonly mismatched: number;
	readonly mismatchRatio: number;
	/** Mean absolute error over all channels (0-255), the bench's fidelity metric. */
	readonly meanAbsError: number;
	readonly regions: readonly IDiffRegion[];
	/** How many regions were found before the `maxRegions` cut. */
	readonly totalRegions: number;
	/** A whole-image shift that explains much of the difference (page relative to reference). */
	readonly offset?: { readonly dx: number; readonly dy: number };
	/** Per-pixel difference (largest channel delta, 0-255), for the heatmap. */
	readonly mask: Uint8Array;
}

interface IOffsetEstimate {
	readonly dx: number;
	readonly dy: number;
	readonly error: number;
	readonly base: number;
}

/**
 * The shift (dx, dy) of `b` relative to `a` that best matches the luminance inside `rect`: b(x+dx, y+dy)
 * against a(x, y). Coarse-to-fine search on a subsample, so it costs about the same for any rect size.
 */
function estimateOffset(a: Uint8Array, b: Uint8Array, width: number, height: number, rect: IImageRect, maxShift: number): IOffsetEstimate {
	const stride = Math.max(1, Math.ceil(Math.sqrt(rect.w * rect.h / 8000)));
	const samples: number[] = [];
	for (let y = rect.y; y < rect.y + rect.h; y += stride) {
		for (let x = rect.x; x < rect.x + rect.w; x += stride) {
			samples.push(x, y);
		}
	}
	const total = samples.length / 2;
	const error = (dx: number, dy: number): number => {
		let sum = 0;
		let count = 0;
		for (let i = 0; i < samples.length; i += 2) {
			const x = samples[i];
			const y = samples[i + 1];
			const bx = x + dx;
			const by = y + dy;
			if (bx < 0 || by < 0 || bx >= width || by >= height) {
				continue;
			}
			sum += Math.abs(a[y * width + x] - b[by * width + bx]);
			count++;
		}
		return count >= total * 0.5 && count > 0 ? sum / count : Number.POSITIVE_INFINITY;
	};
	const base = error(0, 0);
	let best = { dx: 0, dy: 0, error: base };
	const coarse = Math.max(1, Math.round(maxShift / 6));
	for (let dy = -maxShift; dy <= maxShift; dy += coarse) {
		for (let dx = -maxShift; dx <= maxShift; dx += coarse) {
			const e = error(dx, dy);
			if (e < best.error) {
				best = { dx, dy, error: e };
			}
		}
	}
	const center = best;
	for (let dy = center.dy - coarse; dy <= center.dy + coarse; dy++) {
		for (let dx = center.dx - coarse; dx <= center.dx + coarse; dx++) {
			if (Math.abs(dx) > maxShift || Math.abs(dy) > maxShift) {
				continue;
			}
			const e = error(dx, dy);
			if (e < best.error || (e === best.error && Math.abs(dx) + Math.abs(dy) < Math.abs(best.dx) + Math.abs(best.dy))) {
				best = { dx, dy, error: e };
			}
		}
	}
	return { ...best, base };
}

function distance3(a: readonly [number, number, number], b: readonly [number, number, number]): number {
	return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

/** Average colour of a 1px ring just outside `rect`, or undefined when the rect touches every edge. */
function ringColor(image: IRgbaImage, rect: IImageRect, gap = 3): [number, number, number] | undefined {
	const { width, height, data } = image;
	const x0 = rect.x - gap, y0 = rect.y - gap, x1 = rect.x + rect.w - 1 + gap, y1 = rect.y + rect.h - 1 + gap;
	let r = 0, g = 0, b = 0, n = 0;
	const add = (x: number, y: number) => {
		if (x < 0 || y < 0 || x >= width || y >= height) {
			return;
		}
		const p = (y * width + x) * 4;
		r += data[p]; g += data[p + 1]; b += data[p + 2];
		n++;
	};
	for (let x = x0; x <= x1; x++) {
		add(x, y0);
		add(x, y1);
	}
	for (let y = y0 + 1; y < y1; y++) {
		add(x0, y);
		add(x1, y);
	}
	return n ? [r / n, g / n, b / n] : undefined;
}

function meaningfulOffset(estimate: IOffsetEstimate): { dx: number; dy: number } | undefined {
	return (estimate.dx || estimate.dy) && estimate.base > 1.5 && estimate.error < estimate.base * 0.6 ? { dx: estimate.dx, dy: estimate.dy } : undefined;
}

function lumSpread(lum: Uint8Array, width: number, rect: IImageRect): number {
	const stride = Math.max(1, Math.ceil(Math.sqrt(rect.w * rect.h / 6000)));
	let sum = 0, sq = 0, n = 0;
	for (let y = rect.y; y < rect.y + rect.h; y += stride) {
		for (let x = rect.x; x < rect.x + rect.w; x += stride) {
			const v = lum[y * width + x];
			sum += v;
			sq += v * v;
			n++;
		}
	}
	if (!n) {
		return 0;
	}
	const mean = sum / n;
	return Math.sqrt(Math.max(0, sq / n - mean * mean));
}

/** Pixel diff of two same-size images, grouped into regions with a likely cause for each. */
export function compareImages(reference: IRgbaImage, page: IRgbaImage, options: IImageDiffOptions = {}): IImageDiff {
	if (reference.width !== page.width || reference.height !== page.height) {
		throw new Error(`Images differ in size: ${reference.width}x${reference.height} vs ${page.width}x${page.height}.`);
	}
	const { width, height } = reference;
	const threshold = Math.max(0, Math.min(254, options.threshold ?? 16));
	const maxRegions = Math.max(1, options.maxRegions ?? 6);
	const a = reference.data;
	const b = page.data;
	const mask = new Uint8Array(width * height);
	let mismatched = 0;
	let absSum = 0;
	for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
		const dr = Math.abs(a[p] - b[p]);
		const dg = Math.abs(a[p + 1] - b[p + 1]);
		const db = Math.abs(a[p + 2] - b[p + 2]);
		absSum += dr + dg + db;
		const d = Math.max(dr, dg, db);
		mask[i] = d;
		if (d > threshold) {
			mismatched++;
		}
	}
	const pixels = width * height;
	const lumA = luminance(reference);
	const lumB = luminance(page);

	// Mark coarse cells that hold enough differing pixels, then join cells within one cell of each other.
	const cell = Math.max(8, Math.min(32, Math.round(Math.min(width, height) / 48)));
	const gw = Math.ceil(width / cell);
	const gh = Math.ceil(height / cell);
	const counts = new Uint32Array(gw * gh);
	if (mismatched) {
		for (let y = 0; y < height; y++) {
			const row = Math.floor(y / cell) * gw;
			for (let x = 0; x < width; x++) {
				if (mask[y * width + x] > threshold) {
					counts[row + Math.floor(x / cell)]++;
				}
			}
		}
	}
	const minCount = Math.max(2, Math.round(cell * cell * 0.02));
	const label = new Int32Array(gw * gh).fill(-1);
	const components: number[][] = [];
	for (let c = 0; c < counts.length; c++) {
		if (counts[c] < minCount || label[c] !== -1) {
			continue;
		}
		const id = components.length;
		const cells: number[] = [c];
		label[c] = id;
		for (let k = 0; k < cells.length; k++) {
			const cx = cells[k] % gw;
			const cy = Math.floor(cells[k] / gw);
			for (let ny = Math.max(0, cy - 2); ny <= Math.min(gh - 1, cy + 2); ny++) {
				for (let nx = Math.max(0, cx - 2); nx <= Math.min(gw - 1, cx + 2); nx++) {
					const n = ny * gw + nx;
					if (label[n] === -1 && counts[n] >= minCount) {
						label[n] = id;
						cells.push(n);
					}
				}
			}
		}
		components.push(cells);
	}

	const found: IDiffRegion[] = [];
	for (const cells of components) {
		let x0 = width, y0 = height, x1 = -1, y1 = -1, n = 0;
		let ar = 0, ag = 0, ab = 0, br = 0, bg = 0, bb = 0;
		for (const c of cells) {
			const cx = (c % gw) * cell;
			const cy = Math.floor(c / gw) * cell;
			for (let y = cy; y < Math.min(height, cy + cell); y++) {
				for (let x = cx; x < Math.min(width, cx + cell); x++) {
					const i = y * width + x;
					if (mask[i] <= threshold) {
						continue;
					}
					n++;
					x0 = Math.min(x0, x);
					y0 = Math.min(y0, y);
					x1 = Math.max(x1, x);
					y1 = Math.max(y1, y);
					const p = i * 4;
					ar += a[p]; ag += a[p + 1]; ab += a[p + 2];
					br += b[p]; bg += b[p + 1]; bb += b[p + 2];
				}
			}
		}
		if (!n) {
			continue;
		}
		const rect = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
		const maxShift = Math.max(2, Math.min(24, Math.round(Math.max(rect.w, rect.h) / 2)));
		const offset = meaningfulOffset(estimateOffset(lumA, lumB, width, height, rect, maxShift));
		const spreadA = lumSpread(lumA, width, rect);
		const spreadB = lumSpread(lumB, width, rect);
		let kind: DiffRegionKind = offset ? 'shifted'
			: spreadA > 8 && spreadB < 3 ? 'missing'
				: spreadB > 8 && spreadA < 3 ? 'extra'
					: spreadA < 3 && spreadB < 3 ? 'color'
						: 'different';
		if (kind === 'color' || kind === 'different') {
			// Flat on the page and the same as what surrounds it: the reference's content is not there (or vice versa).
			const insideA: [number, number, number] = [ar / n, ag / n, ab / n];
			const insideB: [number, number, number] = [br / n, bg / n, bb / n];
			const ringA = ringColor(reference, rect);
			const ringB = ringColor(page, rect);
			if (ringA && ringB) {
				if (spreadB < 3 && distance3(insideB, ringB) < 10 && distance3(insideA, ringA) > 24) {
					kind = 'missing';
				} else if (spreadA < 3 && distance3(insideA, ringA) < 10 && distance3(insideB, ringB) > 24) {
					kind = 'extra';
				}
			}
		}
		found.push({
			rect,
			differing: n,
			ratio: n / (rect.w * rect.h),
			referenceColor: toHex(ar / n, ag / n, ab / n),
			pageColor: toHex(br / n, bg / n, bb / n),
			kind,
			...(offset ? { offset } : {}),
		});
	}
	found.sort((x, y) => y.differing - x.differing);

	const globalShift = Math.max(2, Math.min(48, Math.round(Math.min(width, height) / 8)));
	const offset = mismatched / pixels > 0.002 ? meaningfulOffset(estimateOffset(lumA, lumB, width, height, { x: 0, y: 0, w: width, h: height }, globalShift)) : undefined;
	return {
		width,
		height,
		threshold,
		mismatched,
		mismatchRatio: pixels ? mismatched / pixels : 0,
		meanAbsError: pixels ? absSum / (pixels * 3) : 0,
		regions: found.slice(0, maxRegions),
		totalRegions: found.length,
		...(offset ? { offset } : {}),
		mask,
	};
}

function percent(ratio: number): string {
	const value = ratio * 100;
	return value === 0 ? '0%' : value < 0.01 ? '<0.01%' : `${value < 10 ? value.toFixed(2) : value.toFixed(1)}%`;
}

function describeOffset(offset: { dx: number; dy: number }): string {
	const parts: string[] = [];
	if (offset.dy) {
		parts.push(`${Math.abs(offset.dy)}px ${offset.dy > 0 ? 'lower' : 'higher'}`);
	}
	if (offset.dx) {
		parts.push(`${Math.abs(offset.dx)}px ${offset.dx > 0 ? 'right' : 'left'}`);
	}
	return `${parts.join(' and ')} than the reference (dx ${offset.dx > 0 ? '+' : ''}${offset.dx}, dy ${offset.dy > 0 ? '+' : ''}${offset.dy})`;
}

function describeRegion(region: IDiffRegion): string {
	const { rect } = region;
	const where = `x ${rect.x}, y ${rect.y}, ${rect.w}×${rect.h}`;
	const share = `${percent(region.ratio)} of it differs`;
	switch (region.kind) {
		case 'shifted':
			return `${where}: page content is ${describeOffset(region.offset!)}`;
		case 'missing':
			return `${where}: content missing on the page (${share}; reference ${region.referenceColor}, page ${region.pageColor})`;
		case 'extra':
			return `${where}: extra content on the page (${share}; reference ${region.referenceColor}, page ${region.pageColor})`;
		case 'color':
			return `${where}: colour differs: reference ${region.referenceColor}, page ${region.pageColor}`;
		default:
			return `${where}: ${share} (reference avg ${region.referenceColor}, page avg ${region.pageColor}); likely size, font or spacing`;
	}
}

/** The comparison as short markdown lines for the model. Region coordinates are reference pixels, shifted by `origin` (a compared sub-rectangle). */
export function describeComparison(diff: IImageDiff, origin: IImagePoint = { x: 0, y: 0 }): string[] {
	const lines = [`- Mismatch: ${percent(diff.mismatchRatio)} of pixels differ by more than ${diff.threshold}/255 (mean abs error ${diff.meanAbsError.toFixed(2)})`];
	if (diff.offset) {
		lines.push(`- Whole image: page content is ${describeOffset(diff.offset)}`);
	}
	if (diff.regions.length) {
		lines.push('- Differing regions (reference px), largest first:');
		diff.regions.forEach((region, i) => {
			const moved = origin.x || origin.y ? { ...region, rect: { ...region.rect, x: region.rect.x + origin.x, y: region.rect.y + origin.y } } : region;
			lines.push(`  ${i + 1}. ${describeRegion(moved)}`);
		});
		if (diff.totalRegions > diff.regions.length) {
			lines.push(`  (${diff.totalRegions - diff.regions.length} smaller regions not listed)`);
		}
	}
	const verdict = diff.mismatchRatio < 0.005 ? 'matches closely; only anti-aliasing level differences remain'
		: diff.mismatchRatio < 0.03 ? 'close; fix the regions above, largest first'
			: 'needs work; fix layout and spacing (the largest regions) before colours and type';
	lines.push(`- Verdict: ${verdict}`);
	return lines;
}

export interface IHeatmap {
	readonly image: IRgbaImage;
	/** Number labels for the regions, in heatmap pixels. */
	readonly labels: readonly { readonly x: number; readonly y: number; readonly text: string }[];
}

/** The page dimmed to light grey with differing pixels in red and the listed regions boxed, fit inside `maxSide`. */
export function diffHeatmap(page: IRgbaImage, diff: IImageDiff, maxSide = 800): IHeatmap {
	const src = page.data;
	const full = new Uint8ClampedArray(src.length);
	for (let i = 0, p = 0; i < diff.mask.length; i++, p += 4) {
		const lum = (src[p] * 77 + src[p + 1] * 150 + src[p + 2] * 29) >> 8;
		const grey = 150 + lum * 0.4;
		const d = diff.mask[i];
		const alpha = d > diff.threshold ? 0.45 + 0.55 * Math.min(1, d / 96) : 0;
		full[p] = grey * (1 - alpha) + 235 * alpha;
		full[p + 1] = grey * (1 - alpha) + 20 * alpha;
		full[p + 2] = grey * (1 - alpha) + 20 * alpha;
		full[p + 3] = 255;
	}
	const size = fitWithin(diff.width, diff.height, maxSide);
	const image = resizeRgba({ width: diff.width, height: diff.height, data: full }, size.width, size.height);
	const scale = size.width / diff.width;
	const labels: { x: number; y: number; text: string }[] = [];
	diff.regions.forEach((region, i) => {
		const r = {
			x: Math.floor(region.rect.x * scale) - 2,
			y: Math.floor(region.rect.y * scale) - 2,
			w: Math.ceil(region.rect.w * scale) + 4,
			h: Math.ceil(region.rect.h * scale) + 4,
		};
		strokeRect(image, r, [255, 160, 0], 2);
		labels.push({ x: Math.max(0, r.x), y: Math.max(0, r.y), text: String(i + 1) });
	});
	return { image, labels };
}

function strokeRect(image: IRgbaImage, rect: IImageRect, color: readonly [number, number, number], thickness: number): void {
	const put = (x: number, y: number) => {
		if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
			return;
		}
		const p = (y * image.width + x) * 4;
		image.data[p] = color[0];
		image.data[p + 1] = color[1];
		image.data[p + 2] = color[2];
		image.data[p + 3] = 255;
	};
	for (let t = 0; t < thickness; t++) {
		for (let x = rect.x; x < rect.x + rect.w; x++) {
			put(x, rect.y + t);
			put(x, rect.y + rect.h - 1 - t);
		}
		for (let y = rect.y; y < rect.y + rect.h; y++) {
			put(rect.x + t, y);
			put(rect.x + rect.w - 1 - t, y);
		}
	}
}

/** Images next to each other at one height, the whole strip at most `maxWidth` wide. */
export function sideBySide(images: readonly IRgbaImage[], maxWidth = 1280, gap = 8): IRgbaImage {
	const tallest = Math.max(...images.map(image => image.height));
	const widthAt = (height: number) => images.reduce((sum, image) => sum + image.width * height / image.height, 0) + gap * (images.length - 1);
	const height = Math.max(1, Math.floor(Math.min(tallest, tallest * (maxWidth - gap * (images.length - 1)) / Math.max(1, widthAt(tallest) - gap * (images.length - 1)))));
	const scaled = images.map(image => resizeRgba(image, Math.max(1, Math.floor(image.width * height / image.height)), height));
	const width = scaled.reduce((sum, image) => sum + image.width, 0) + gap * (scaled.length - 1);
	const out = createImage(width, height, [255, 255, 255]);
	let left = 0;
	for (const image of scaled) {
		for (let y = 0; y < height; y++) {
			out.data.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), (y * width + left) * 4);
		}
		left += image.width + gap;
	}
	return out;
}

//#endregion

//#region Inspect

export interface IImageInspectOptions {
	readonly points?: readonly IImagePoint[];
	readonly regions?: readonly IImageRect[];
	readonly maxColors?: number;
}

export interface IPaletteColor {
	readonly color: string;
	readonly ratio: number;
}

export interface IImageInspection {
	readonly width: number;
	readonly height: number;
	readonly hasAlpha: boolean;
	readonly background: string;
	readonly palette: readonly IPaletteColor[];
	readonly samples: readonly { readonly x: number; readonly y: number; readonly color: string; readonly alpha: number }[];
	/** Solid rectangles that differ from the background: cards, bars, buttons. */
	readonly blocks: readonly { readonly rect: IImageRect; readonly fill: string }[];
	/** Rows of dense detail (text lines and icons), split where there is a wide horizontal gap. */
	readonly bands: readonly { readonly rect: IImageRect; readonly ink: string; readonly background: string }[];
	readonly regions: readonly { readonly rect: IImageRect; readonly average: string; readonly palette: readonly IPaletteColor[]; readonly content?: IImageRect }[];
}

function colorDistance(data: Uint8ClampedArray | Uint8Array, p: number, color: readonly [number, number, number]): number {
	return Math.max(Math.abs(data[p] - color[0]), Math.abs(data[p + 1] - color[1]), Math.abs(data[p + 2] - color[2]));
}

function hexToRgb(hex: string): [number, number, number] {
	const value = parseInt(hex.slice(1), 16);
	return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbDistance(a: number, b: number): number {
	return Math.max(Math.abs(((a >> 16) & 255) - ((b >> 16) & 255)), Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)), Math.abs((a & 255) - (b & 255)));
}

const keyHex = (key: number) => toHex((key >> 16) & 255, (key >> 8) & 255, key & 255);

/**
 * The most common exact colours among `pixels` (as `r << 16 | g << 8 | b` keys). Near duplicates
 * (anti-aliasing, gradients, off by 3 or less) count towards the more common colour, so flat
 * fills report their exact value.
 */
function rankColors(counts: Map<number, number>, total: number, max: number): IPaletteColor[] {
	const ranked = [...counts.entries()].sort((x, y) => y[1] - x[1]);
	const kept: [number, number][] = [];
	for (const [key, count] of ranked) {
		const near = kept.find(([other]) => rgbDistance(key, other) <= 3);
		if (near) {
			near[1] += count;
		} else if (kept.length < max * 4) {
			kept.push([key, count]);
		}
	}
	return kept.sort((x, y) => y[1] - x[1]).slice(0, max).map(([key, count]) => ({ color: keyHex(key), ratio: count / Math.max(1, total) }));
}

/** Most common colours inside `rect`. */
function paletteOf(image: IRgbaImage, rect: IImageRect, max: number): IPaletteColor[] {
	const stride = Math.max(1, Math.ceil(Math.sqrt(rect.w * rect.h / 250_000)));
	const counts = new Map<number, number>();
	let total = 0;
	const data = image.data;
	for (let y = rect.y; y < rect.y + rect.h; y += stride) {
		for (let x = rect.x; x < rect.x + rect.w; x += stride) {
			const p = (y * image.width + x) * 4;
			const key = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
			counts.set(key, (counts.get(key) ?? 0) + 1);
			total++;
		}
	}
	return rankColors(counts, total, max);
}

function borderColor(image: IRgbaImage): string {
	const { width, height, data } = image;
	const counts = new Map<number, number>();
	let total = 0;
	const add = (x: number, y: number) => {
		const p = (y * width + x) * 4;
		const key = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
		counts.set(key, (counts.get(key) ?? 0) + 1);
		total++;
	};
	for (let x = 0; x < width; x++) {
		add(x, 0);
		add(x, height - 1);
	}
	for (let y = 0; y < height; y++) {
		add(0, y);
		add(width - 1, y);
	}
	return rankColors(counts, total, 1)[0]?.color ?? '#ffffff';
}

function findBlocks(image: IRgbaImage, background: [number, number, number]): { rect: IImageRect; fill: string }[] {
	const { width, height, data } = image;
	const cell = 8;
	const gw = Math.floor(width / cell);
	const gh = Math.floor(height / cell);
	if (gw < 2 || gh < 2) {
		return [];
	}
	const colors = new Int32Array(gw * gh).fill(-1);
	for (let cy = 0; cy < gh; cy++) {
		for (let cx = 0; cx < gw; cx++) {
			let minR = 255, minG = 255, minB = 255, maxR = 0, maxG = 0, maxB = 0, sr = 0, sg = 0, sb = 0;
			for (let y = cy * cell; y < cy * cell + cell; y++) {
				for (let x = cx * cell; x < cx * cell + cell; x++) {
					const p = (y * width + x) * 4;
					const r = data[p], g = data[p + 1], b = data[p + 2];
					minR = Math.min(minR, r); maxR = Math.max(maxR, r);
					minG = Math.min(minG, g); maxG = Math.max(maxG, g);
					minB = Math.min(minB, b); maxB = Math.max(maxB, b);
					sr += r; sg += g; sb += b;
				}
			}
			if (maxR - minR > 12 || maxG - minG > 12 || maxB - minB > 12) {
				continue;
			}
			const n = cell * cell;
			const r = Math.round(sr / n), g = Math.round(sg / n), b = Math.round(sb / n);
			if (Math.max(Math.abs(r - background[0]), Math.abs(g - background[1]), Math.abs(b - background[2])) > 10) {
				colors[cy * gw + cx] = (r << 16) | (g << 8) | b;
			}
		}
	}
	const seen = new Uint8Array(gw * gh);
	const blocks: { rect: IImageRect; fill: string; area: number }[] = [];
	for (let c = 0; c < colors.length; c++) {
		if (colors[c] < 0 || seen[c]) {
			continue;
		}
		const seed: [number, number, number] = [(colors[c] >> 16) & 255, (colors[c] >> 8) & 255, colors[c] & 255];
		const cells = [c];
		seen[c] = 1;
		let cx0 = gw, cy0 = gh, cx1 = 0, cy1 = 0;
		for (let k = 0; k < cells.length; k++) {
			const cx = cells[k] % gw;
			const cy = Math.floor(cells[k] / gw);
			cx0 = Math.min(cx0, cx); cy0 = Math.min(cy0, cy);
			cx1 = Math.max(cx1, cx); cy1 = Math.max(cy1, cy);
			for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
				if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) {
					continue;
				}
				const n = ny * gw + nx;
				const color = colors[n];
				if (color < 0 || seen[n]) {
					continue;
				}
				if (Math.max(Math.abs(((color >> 16) & 255) - seed[0]), Math.abs(((color >> 8) & 255) - seed[1]), Math.abs((color & 255) - seed[2])) <= 10) {
					seen[n] = 1;
					cells.push(n);
				}
			}
		}
		if (cells.length < 4) {
			continue;
		}
		const tolerance = Math.max(2, Math.min(8, Math.floor(distance3(seed, background) / 2)));
		const rect = refineBlock(image, { x: cx0 * cell, y: cy0 * cell, w: (cx1 - cx0 + 1) * cell, h: (cy1 - cy0 + 1) * cell }, seed, tolerance);
		if (rect.w * rect.h >= width * height * 0.9) {
			continue;
		}
		blocks.push({ rect, fill: toHex(seed[0], seed[1], seed[2]), area: rect.w * rect.h });
	}
	return blocks.sort((x, y) => y.area - x.area).slice(0, 16).map(({ rect, fill }) => ({ rect, fill }));
}

/** Moves each edge of a cell-aligned box to the exact pixel line where the fill colour starts. */
function refineBlock(image: IRgbaImage, rect: IImageRect, fill: [number, number, number], tolerance: number): IImageRect {
	const { width, height, data } = image;
	const reach = 8;
	const filled = (x0: number, y0: number, x1: number, y1: number, vertical: boolean, at: number): boolean => {
		let hits = 0, n = 0;
		const from = vertical ? y0 : x0;
		const to = vertical ? y1 : x1;
		const step = Math.max(1, Math.floor((to - from) / 24));
		for (let t = from; t < to; t += step) {
			const x = vertical ? at : t;
			const y = vertical ? t : at;
			if (x < 0 || y < 0 || x >= width || y >= height) {
				continue;
			}
			n++;
			if (colorDistance(data, (y * width + x) * 4, fill) <= tolerance) {
				hits++;
			}
		}
		return n > 0 && hits >= n * 0.5;
	};
	const innerY0 = rect.y + Math.round(Math.min(reach, rect.h / 3)), innerY1 = rect.y + rect.h - Math.round(Math.min(reach, rect.h / 3));
	const innerX0 = rect.x + Math.round(Math.min(reach, rect.w / 3)), innerX1 = rect.x + rect.w - Math.round(Math.min(reach, rect.w / 3));
	let left = rect.x, right = rect.x + rect.w - 1, top = rect.y, bottom = rect.y + rect.h - 1;
	for (let x = Math.max(0, rect.x - reach); x <= rect.x + reach; x++) {
		if (filled(0, innerY0, 0, innerY1, true, x)) { left = x; break; }
	}
	for (let x = Math.min(width - 1, rect.x + rect.w - 1 + reach); x >= rect.x + rect.w - 1 - reach; x--) {
		if (filled(0, innerY0, 0, innerY1, true, x)) { right = x; break; }
	}
	for (let y = Math.max(0, rect.y - reach); y <= rect.y + reach; y++) {
		if (filled(innerX0, 0, innerX1, 0, false, y)) { top = y; break; }
	}
	for (let y = Math.min(height - 1, rect.y + rect.h - 1 + reach); y >= rect.y + rect.h - 1 - reach; y--) {
		if (filled(innerX0, 0, innerX1, 0, false, y)) { bottom = y; break; }
	}
	return { x: left, y: top, w: Math.max(1, right - left + 1), h: Math.max(1, bottom - top + 1) };
}

/**
 * Text-ish bands: rows with several sharp horizontal colour changes. Long vertical edges (card
 * borders) are ignored, so a column of cards does not read as one tall band.
 */
function findBands(image: IRgbaImage): { rect: IImageRect; ink: string; background: string }[] {
	const { width, height, data } = image;
	const edge = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) {
		for (let x = 1; x < width; x++) {
			const p = (y * width + x) * 4;
			if (Math.max(Math.abs(data[p] - data[p - 4]), Math.abs(data[p + 1] - data[p - 3]), Math.abs(data[p + 2] - data[p - 2])) > 40) {
				edge[y * width + x] = 1;
			}
		}
	}
	// Vertical runs of 32px or more are borders (cards, panels, dividers), not glyph strokes.
	const STRUCTURAL_RUN = 32;
	for (let x = 1; x < width; x++) {
		let y = 0;
		while (y < height) {
			if (!edge[y * width + x]) {
				y++;
				continue;
			}
			let end = y;
			while (end < height && edge[end * width + x]) {
				end++;
			}
			if (end - y >= STRUCTURAL_RUN) {
				for (let k = y; k < end; k++) {
					edge[k * width + x] = 2;
				}
			}
			y = end;
		}
	}
	const counted = (x: number, y: number) => edge[y * width + x] === 1;
	const rowCount = new Uint32Array(height);
	for (let y = 0; y < height; y++) {
		for (let x = 1; x < width; x++) {
			if (counted(x, y)) {
				rowCount[y]++;
			}
		}
	}
	const rows: [number, number][] = [];
	let start = -1, last = -1;
	for (let y = 0; y < height; y++) {
		if (rowCount[y] >= 3) {
			if (start < 0 || y - last > 3) {
				if (start >= 0) {
					rows.push([start, last]);
				}
				start = y;
			}
			last = y;
		}
	}
	if (start >= 0) {
		rows.push([start, last]);
	}
	const bands: { rect: IImageRect; ink: string; background: string }[] = [];
	const columns = new Uint32Array(width);
	for (const [y0, y1] of rows) {
		const h = y1 - y0 + 1;
		if (h < 3) {
			continue;
		}
		columns.fill(0);
		for (let y = y0; y <= y1; y++) {
			for (let x = 1; x < width; x++) {
				if (counted(x, y)) {
					columns[x]++;
				}
			}
		}
		const gapLimit = Math.max(12, Math.round(h * 1.5));
		let sx = -1, ex = -1;
		const flush = () => {
			if (sx >= 0 && ex - sx + 1 >= 4) {
				const rect = { x: Math.max(0, sx - 1), y: y0, w: ex - sx + 2, h };
				const colors = paletteOf(image, rect, 6);
				const background = colors[0]?.color ?? '#ffffff';
				const bg = hexToRgb(background);
				const ink = colors.find(color => {
					const rgb = hexToRgb(color.color);
					return Math.max(Math.abs(rgb[0] - bg[0]), Math.abs(rgb[1] - bg[1]), Math.abs(rgb[2] - bg[2])) > 48;
				})?.color ?? colors[1]?.color ?? background;
				bands.push({ rect, ink, background });
			}
		};
		for (let x = 0; x < width; x++) {
			if (!columns[x]) {
				continue;
			}
			if (sx < 0 || x - ex > gapLimit) {
				flush();
				sx = x;
			}
			ex = x;
		}
		flush();
	}
	return bands.slice(0, 60);
}

export function inspectImage(source: IRgbaImage, options: IImageInspectOptions = {}): IImageInspection {
	let hasAlpha = false;
	for (let i = 3; i < source.data.length; i += 4) {
		if (source.data[i] !== 255) {
			hasAlpha = true;
			break;
		}
	}
	const image = flattenAlpha(source);
	const { width, height } = image;
	const background = borderColor(image);
	const samples = (options.points ?? []).map(point => {
		const x = Math.max(0, Math.min(width - 1, Math.round(point.x)));
		const y = Math.max(0, Math.min(height - 1, Math.round(point.y)));
		const p = (y * width + x) * 4;
		return { x, y, color: toHex(source.data[p], source.data[p + 1], source.data[p + 2]), alpha: source.data[p + 3] };
	});
	const regions = (options.regions ?? []).map(raw => clampRect(raw, width, height)).filter((rect): rect is IImageRect => !!rect).map(rect => {
		let r = 0, g = 0, b = 0;
		for (let y = rect.y; y < rect.y + rect.h; y++) {
			for (let x = rect.x; x < rect.x + rect.w; x++) {
				const p = (y * width + x) * 4;
				r += image.data[p]; g += image.data[p + 1]; b += image.data[p + 2];
			}
		}
		const n = rect.w * rect.h;
		const palette = paletteOf(image, rect, 4);
		const dominant = hexToRgb(palette[0].color);
		let x0 = width, y0 = height, x1 = -1, y1 = -1;
		for (let y = rect.y; y < rect.y + rect.h; y++) {
			for (let x = rect.x; x < rect.x + rect.w; x++) {
				if (colorDistance(image.data, (y * width + x) * 4, dominant) > 32) {
					x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
				}
			}
		}
		return { rect, average: toHex(r / n, g / n, b / n), palette, ...(x1 >= 0 ? { content: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } } : {}) };
	});
	return {
		width,
		height,
		hasAlpha,
		background,
		palette: paletteOf(image, { x: 0, y: 0, w: width, h: height }, Math.max(1, Math.min(16, options.maxColors ?? 8))),
		samples,
		blocks: findBlocks(image, hexToRgb(background)),
		bands: findBands(image),
		regions,
	};
}

const rectText = (rect: IImageRect) => `x ${rect.x}, y ${rect.y}, ${rect.w}×${rect.h}`;

export interface ILayoutDelta {
	readonly kind: 'block' | 'text';
	readonly reference: IImageRect;
	/** Undefined when nothing like it is on the page. */
	readonly page?: IImageRect;
	/** Fill (blocks) or ink (text) colour in the reference and on the page. */
	readonly referenceColor: string;
	readonly pageColor?: string;
}

interface ILayoutItem {
	readonly kind: 'block' | 'text';
	readonly rect: IImageRect;
	readonly color: string;
}

function layoutItems(image: IRgbaImage): ILayoutItem[] {
	const flat = flattenAlpha(image);
	return [
		...findBlocks(flat, hexToRgb(borderColor(flat))).map(block => ({ kind: 'block' as const, rect: block.rect, color: block.fill })),
		...findBands(flat).map(band => ({ kind: 'text' as const, rect: band.rect, color: band.ink })),
	];
}

/**
 * Geometry diff: the reference's solid blocks and text bands matched to the page's, reporting the
 * ones that moved, changed size or colour, or are missing. This is the "card is 4px lower and 8px
 * taller" a person reads off two images, and what agents otherwise measure with scripts.
 */
export function compareLayout(reference: IRgbaImage, page: IRgbaImage, max = 8): ILayoutDelta[] {
	const want = layoutItems(reference);
	const have = layoutItems(page);
	// Every plausible pair (same kind, near, similar size; blocks also similar fill), best first.
	const pairs: { want: ILayoutItem; have: ILayoutItem; score: number }[] = [];
	for (const item of want) {
		const r = item.rect;
		const reach = Math.max(24, Math.min(80, Math.max(r.w, r.h) / 2));
		for (const candidate of have) {
			const c = candidate.rect;
			if (candidate.kind !== item.kind || c.w > r.w * 2 || c.w * 2 < r.w || c.h > r.h * 2 || c.h * 2 < r.h) {
				continue;
			}
			const dx = (c.x + c.w / 2) - (r.x + r.w / 2);
			const dy = (c.y + c.h / 2) - (r.y + r.h / 2);
			if (Math.abs(dx) > reach || Math.abs(dy) > reach) {
				continue;
			}
			const colorGap = rgbDistance(parseInt(item.color.slice(1), 16), parseInt(candidate.color.slice(1), 16));
			if (item.kind === 'block' && colorGap > 16) {
				continue;
			}
			const score = Math.abs(dx) + Math.abs(dy) + Math.abs(c.w - r.w) / 2 + Math.abs(c.h - r.h) / 2 + (colorGap > 48 ? reach / 2 : 0);
			pairs.push({ want: item, have: candidate, score });
		}
	}
	pairs.sort((x, y) => x.score - y.score);
	const matched = new Map<ILayoutItem, ILayoutItem>();
	const taken = new Set<ILayoutItem>();
	for (const pair of pairs) {
		if (!matched.has(pair.want) && !taken.has(pair.have)) {
			matched.set(pair.want, pair.have);
			taken.add(pair.have);
		}
	}
	const deltas: { delta: ILayoutDelta; weight: number }[] = [];
	for (const item of want) {
		const r = item.rect;
		const best = matched.get(item);
		if (!best) {
			deltas.push({ delta: { kind: item.kind, reference: r, referenceColor: item.color }, weight: Math.sqrt(r.w * r.h) * 12 });
			continue;
		}
		const c = best.rect;
		const moved = Math.max(Math.abs(c.x - r.x), Math.abs(c.y - r.y), Math.abs(c.w - r.w), Math.abs(c.h - r.h));
		const recolored = rgbDistance(parseInt(item.color.slice(1), 16), parseInt(best.color.slice(1), 16)) > 6;
		if (moved >= 2 || (recolored && item.kind === 'block')) {
			deltas.push({ delta: { kind: item.kind, reference: r, page: c, referenceColor: item.color, pageColor: best.color }, weight: Math.sqrt(r.w * r.h) * (moved + (recolored ? 4 : 0)) });
		}
	}
	return deltas.sort((a, b) => b.weight - a.weight).slice(0, max).map(entry => entry.delta);
}

function signed(value: number): string {
	return value > 0 ? `+${value}` : String(value);
}

export function describeLayout(deltas: readonly ILayoutDelta[], origin: IImagePoint = { x: 0, y: 0 }): string[] {
	if (!deltas.length) {
		return [];
	}
	const at = (rect: IImageRect) => rectText({ ...rect, x: rect.x + origin.x, y: rect.y + origin.y });
	const lines = ['- Layout differences (reference → page):'];
	for (const delta of deltas) {
		const what = delta.kind === 'block' ? `Block ${delta.referenceColor}` : 'Text line';
		if (!delta.page) {
			lines.push(`  - ${what} at ${at(delta.reference)}: not found on the page`);
			continue;
		}
		const r = delta.reference;
		const c = delta.page;
		const changes: string[] = [];
		if (c.x !== r.x || c.y !== r.y) {
			changes.push(`moved dx ${signed(c.x - r.x)}, dy ${signed(c.y - r.y)}`);
		}
		if (c.w !== r.w || c.h !== r.h) {
			changes.push(`size ${r.w}×${r.h} → ${c.w}×${c.h}`);
		}
		if (delta.kind === 'block' && delta.pageColor && delta.pageColor !== delta.referenceColor) {
			changes.push(`fill ${delta.referenceColor} → ${delta.pageColor}`);
		}
		lines.push(`  - ${what} at ${at(r)}: ${changes.join('; ') || 'differs'}`);
	}
	return lines;
}

export function describeInspection(result: IImageInspection): string[] {
	const lines = [
		`- Size: ${result.width}×${result.height}${result.hasAlpha ? ' (has transparency; analysed over white)' : ''}`,
		`- Background (border colour): ${result.background}`,
		`- Palette: ${result.palette.map(color => `${color.color} ${percent(color.ratio)}`).join(', ')}`,
	];
	if (result.samples.length) {
		lines.push('- Samples:', ...result.samples.map(sample => `  - (${sample.x}, ${sample.y}) ${sample.color}${sample.alpha !== 255 ? ` alpha ${sample.alpha}` : ''}`));
	}
	if (result.blocks.length) {
		lines.push('- Solid blocks (cards, bars, buttons), largest first:', ...result.blocks.map(block => `  - ${rectText(block.rect)} fill ${block.fill}`));
	}
	if (result.bands.length) {
		lines.push('- Text-like bands, top to bottom (height \u2248 line box; cap height is about 0.7× of it):', ...result.bands.map(band => `  - ${rectText(band.rect)} ink ${band.ink} on ${band.background}`));
	}
	for (const region of result.regions) {
		lines.push(`- Region ${rectText(region.rect)}: average ${region.average}; colours ${region.palette.map(color => `${color.color} ${percent(color.ratio)}`).join(', ')}${region.content ? `; content box ${rectText(region.content)}` : '; uniform'}`);
	}
	return lines;
}

//#endregion
