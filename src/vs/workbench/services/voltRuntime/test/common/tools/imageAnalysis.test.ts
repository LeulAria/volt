/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { compareImages, compareLayout, createImage, cropImage, describeComparison, describeLayout, diffHeatmap, fitWithin, flattenAlpha, IImageRect, inspectImage, IRgbaImage, parseRect, resizeRgba, sideBySide, toHex } from '../../../common/tools/imageAnalysis.js';

type Rgb = readonly [number, number, number];

function fillRect(image: IRgbaImage, rect: IImageRect, color: Rgb): IRgbaImage {
	for (let y = rect.y; y < rect.y + rect.h; y++) {
		for (let x = rect.x; x < rect.x + rect.w; x++) {
			const p = (y * image.width + x) * 4;
			image.data[p] = color[0];
			image.data[p + 1] = color[1];
			image.data[p + 2] = color[2];
			image.data[p + 3] = 255;
		}
	}
	return image;
}

/** A 400x300 "page": grey background, a white card with a dark title bar and striped "text". */
function design(cardX = 40, cardY = 60): IRgbaImage {
	const image = createImage(400, 300, [243, 244, 246]);
	fillRect(image, { x: cardX, y: cardY, w: 160, h: 120 }, [255, 255, 255]);
	fillRect(image, { x: cardX + 16, y: cardY + 16, w: 100, h: 14 }, [17, 24, 39]);
	for (let i = 0; i < 12; i++) {
		// glyph-like strokes on one text line
		fillRect(image, { x: cardX + 16 + i * 8, y: cardY + 50, w: 3, h: 10 }, [75, 85, 99]);
	}
	return image;
}

const pixel = (image: IRgbaImage, x: number, y: number) => {
	const p = (y * image.width + x) * 4;
	return toHex(image.data[p], image.data[p + 1], image.data[p + 2]);
};

suite('Volt image analysis', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('identical images: 0% mismatch, no regions', () => {
		const diff = compareImages(design(), design());
		assert.strictEqual(diff.mismatched, 0);
		assert.strictEqual(diff.mismatchRatio, 0);
		assert.strictEqual(diff.meanAbsError, 0);
		assert.deepStrictEqual(diff.regions, []);
		assert.strictEqual(diff.offset, undefined);
		assert.ok(describeComparison(diff).some(line => line.includes('matches closely')));
	});

	test('a moved card yields one localized region explained as a shift', () => {
		const diff = compareImages(design(40, 60), design(40, 72));
		assert.ok(diff.mismatchRatio > 0 && diff.mismatchRatio < 0.2, `ratio ${diff.mismatchRatio}`);
		assert.ok(diff.regions.length >= 1);
		const top = diff.regions[0];
		// The difference sits around the card (x 40-200, y 60-192), not across the page.
		assert.ok(top.rect.x >= 36 && top.rect.x + top.rect.w <= 204, JSON.stringify(top.rect));
		assert.ok(top.rect.y >= 56 && top.rect.y + top.rect.h <= 196, JSON.stringify(top.rect));
		assert.strictEqual(top.kind, 'shifted');
		assert.deepStrictEqual(top.offset, { dx: 0, dy: 12 });
		assert.ok(describeComparison(diff).some(line => line.includes('12px lower')), describeComparison(diff).join('\n'));
	});

	test('missing content and colour changes are named as such', () => {
		const reference = design();
		const blank = fillRect(design(), { x: 56, y: 76, w: 100, h: 14 }, [255, 255, 255]);
		const missing = compareImages(reference, blank).regions[0];
		assert.strictEqual(missing.kind, 'missing');
		assert.deepStrictEqual(missing.rect, { x: 56, y: 76, w: 100, h: 14 });
		assert.strictEqual(missing.referenceColor, '#111827');
		assert.strictEqual(missing.pageColor, '#ffffff');

		const recolored = fillRect(createImage(200, 100, [255, 255, 255]), { x: 20, y: 20, w: 60, h: 40 }, [37, 99, 235]);
		const ref = fillRect(createImage(200, 100, [255, 255, 255]), { x: 20, y: 20, w: 60, h: 40 }, [29, 78, 216]);
		const color = compareImages(ref, recolored).regions[0];
		assert.strictEqual(color.kind, 'color');
		assert.strictEqual(color.referenceColor, '#1d4ed8');
		assert.strictEqual(color.pageColor, '#2563eb');
	});

	test('threshold ignores anti-aliasing level noise and the mean abs error is per channel', () => {
		const a = createImage(10, 10, [100, 100, 100]);
		const b = createImage(10, 10, [110, 100, 100]);
		const diff = compareImages(a, b);
		assert.strictEqual(diff.mismatched, 0);
		assert.ok(Math.abs(diff.meanAbsError - 10 / 3) < 1e-9);
		assert.strictEqual(compareImages(a, b, { threshold: 5 }).mismatched, 100);
		assert.throws(() => compareImages(a, createImage(10, 11)));
	});

	test('heatmap and side-by-side fit their size limits', () => {
		const diff = compareImages(design(40, 60), design(40, 72));
		const heat = diffHeatmap(design(40, 72), diff, 200);
		assert.deepStrictEqual([heat.image.width, heat.image.height], [200, 150]);
		assert.strictEqual(heat.labels.length, diff.regions.length);
		const strip = sideBySide([design(), design(), heat.image], 600);
		assert.ok(strip.width <= 600, String(strip.width));
		assert.ok(strip.height > 0);
	});

	test('downscaling: fitWithin keeps the aspect ratio and box resize averages exactly', () => {
		assert.deepStrictEqual(fitWithin(2560, 1600, 1280), { width: 1280, height: 800 });
		assert.deepStrictEqual(fitWithin(800, 3000, 1280), { width: 341, height: 1280 });
		assert.deepStrictEqual(fitWithin(640, 480, 1280), { width: 640, height: 480 }, 'never scales up');

		// 4x2 -> 2x1: each output pixel is the mean of a 2x2 block.
		const src = createImage(4, 2);
		fillRect(src, { x: 0, y: 0, w: 1, h: 2 }, [0, 0, 0]);
		fillRect(src, { x: 1, y: 0, w: 1, h: 2 }, [200, 100, 50]);
		fillRect(src, { x: 2, y: 0, w: 2, h: 2 }, [255, 255, 255]);
		const out = resizeRgba(src, 2, 1);
		assert.deepStrictEqual([...out.data], [100, 50, 25, 255, 255, 255, 255, 255]);

		// A crisp Retina capture (every CSS pixel drawn as 2x2) scaled to CSS size is exact again.
		const css = design();
		const retina = createImage(800, 600);
		for (let y = 0; y < 600; y++) {
			for (let x = 0; x < 800; x++) {
				const from = ((y >> 1) * 400 + (x >> 1)) * 4;
				retina.data.set(css.data.subarray(from, from + 4), (y * 800 + x) * 4);
			}
		}
		const back = resizeRgba(retina, 400, 300);
		assert.strictEqual(pixel(back, 100, 150), pixel(design(), 100, 150));
		assert.strictEqual(compareImages(design(), back).mismatched, 0);
	});

	test('inspect reads background, palette, blocks with exact bounds, text bands and samples', () => {
		const result = inspectImage(design(), { points: [{ x: 60, y: 80 }, { x: 5, y: 5 }], regions: [{ x: 40, y: 60, w: 160, h: 120 }] });
		assert.strictEqual(result.width, 400);
		assert.strictEqual(result.background, '#f3f4f6');
		assert.strictEqual(result.palette[0].color, '#f3f4f6');
		assert.ok(result.palette.some(color => color.color === '#ffffff'));
		assert.deepStrictEqual(result.samples.map(sample => sample.color), ['#111827', '#f3f4f6']);
		const card = result.blocks.find(block => block.fill === '#ffffff');
		assert.deepStrictEqual(card?.rect, { x: 40, y: 60, w: 160, h: 120 });
		const title = result.blocks.find(block => block.fill === '#111827');
		assert.deepStrictEqual(title?.rect, { x: 56, y: 76, w: 100, h: 14 });
		const line = result.bands.find(band => band.rect.y >= 108 && band.rect.y <= 112);
		assert.ok(line, JSON.stringify(result.bands));
		assert.strictEqual(line.rect.h, 10);
		assert.strictEqual(line.ink, '#4b5563');
		assert.strictEqual(result.regions[0].average.length, 7);
		assert.deepStrictEqual(result.regions[0].content, { x: 56, y: 76, w: 100, h: 44 });
	});

	test('layout diff reports moved and resized blocks and text with exact numbers', () => {
		assert.deepStrictEqual(compareLayout(design(), design()), []);
		const page = design(40, 66);
		const deltas = compareLayout(design(40, 60), page);
		const card = deltas.find(delta => delta.kind === 'block' && delta.referenceColor === '#ffffff');
		assert.deepStrictEqual(card?.page, { x: 40, y: 66, w: 160, h: 120 });
		assert.ok(deltas.some(delta => delta.kind === 'text' && delta.page && delta.page.y - delta.reference.y === 6), JSON.stringify(deltas));
		const lines = describeLayout(deltas);
		assert.ok(lines.some(line => line.includes('Block #ffffff at x 40, y 60, 160×120: moved dx 0, dy +6')), lines.join('\n'));

		const noButton = fillRect(design(), { x: 56, y: 76, w: 100, h: 14 }, [255, 255, 255]);
		assert.ok(describeLayout(compareLayout(design(), noButton)).some(line => line.includes('Block #111827 at x 56, y 76, 100×14: not found on the page')));
	});

	test('helpers: alpha flattening, crop, rect parsing', () => {
		const clear = createImage(2, 1, [0, 0, 0]);
		clear.data[3] = 0;
		const flat = flattenAlpha(clear);
		assert.deepStrictEqual([...flat.data.slice(0, 4)], [255, 255, 255, 255]);
		const opaque = design();
		assert.strictEqual(flattenAlpha(opaque), opaque, 'opaque images are not copied');
		assert.deepStrictEqual([cropImage(design(), { x: 390, y: 290, w: 50, h: 50 }).width, cropImage(design(), { x: 390, y: 290, w: 50, h: 50 }).height], [10, 10]);
		assert.throws(() => cropImage(design(), { x: 500, y: 0, w: 10, h: 10 }));
		assert.deepStrictEqual(parseRect({ x: 1, y: 2, width: 3, height: 4 }), { x: 1, y: 2, w: 3, h: 4 });
		assert.strictEqual(parseRect({ x: 1, y: 2, w: 0, h: 4 }), undefined);
	});
});
