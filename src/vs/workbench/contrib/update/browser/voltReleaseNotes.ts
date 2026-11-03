/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { safeIntl } from '../../../../base/common/date.js';
import { htmlAttributeEncodeValue as escape } from '../../../../base/common/strings.js';

/** What the release notes page shows above the notes: the version, when it was published and where. */
export interface IVoltReleaseInfo {
	readonly version: string;
	/** ISO date the GitHub Release was published; missing for a draft. */
	readonly publishedAt?: string;
	readonly url?: string;
}

/** U+2726, the four-pointed star that leads a link line in the summary. */
const SPARKLE = String.fromCodePoint(0x2726);
const MIDDLE_DOT = String.fromCodePoint(0xb7);

/**
 * A release body split the way `docs/release-notes/<version>.md` is written: a short summary (a headline,
 * `<star> <link>` lines and `+ item` lines), a `---` line, then every detail.
 */
export interface IVoltReleaseNotesParts {
	readonly commit?: string;
	/** The summary before its first link line: the headline. */
	readonly lead: string;
	readonly links: readonly string[];
	/** The rest of the summary: the `+ item` list. */
	readonly summary: string;
	readonly details: string;
}

/** The line `build/volt/release/publish.mjs` puts first: `Volt 0.0.5 (\`58a45b6a\`)` or `Volt 0.0.6 | Nov 4, 2026 | \`58a45b6a\``. */
const PUBLISH_HEADER = new RegExp(`^(?:\\*\\*)?Volt(?: Beta| Nightly)? \\d[^\\s|(*]*(?:\\*\\*)?(?:\\s*\\|[^\`(\\n|]*?)?\\s*(?:\\(\\s*\`?([0-9a-f]{7,40})\`?\\s*\\)|[|${MIDDLE_DOT}]\\s*\`?([0-9a-f]{7,40})\`?)?\\s*$`);
const THEMATIC_BREAK = /^ {0,3}(?:-[ \t]*){3,}$|^ {0,3}(?:\*[ \t]*){3,}$|^ {0,3}(?:_[ \t]*){3,}$/;
const LINK_LINE = new RegExp(`^${SPARKLE}\\s+(\\S+)\\s*$`);
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function parseVoltReleaseNotes(markdown: string): IVoltReleaseNotesParts {
	const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
	const dropBlank = () => {
		while (lines.length && !lines[0].trim()) {
			lines.shift();
		}
	};

	dropBlank();
	if (/^#\s/.test(lines[0] ?? '')) {
		lines.shift();
		dropBlank();
	}
	let commit: string | undefined;
	const header = PUBLISH_HEADER.exec(lines[0] ?? '');
	if (header) {
		commit = header[1] ?? header[2];
		lines.shift();
	}

	// The first `---` with a blank line before it (right under text it would make a heading), outside code.
	let split = -1;
	let fence: string | undefined;
	for (let i = 0; i < lines.length; i++) {
		const open = FENCE.exec(lines[i]);
		if (open) {
			fence = fence === undefined ? open[1][0] : (lines[i].trim().startsWith(fence) ? undefined : fence);
			continue;
		}
		if (fence === undefined && THEMATIC_BREAK.test(lines[i]) && (i === 0 || !lines[i - 1].trim())) {
			split = i;
			break;
		}
	}
	if (split < 0) {
		return { commit, lead: '', links: [], summary: '', details: lines.join('\n').trim() };
	}

	const links: string[] = [];
	const lead: string[] = [];
	const rest: string[] = [];
	for (const line of lines.slice(0, split)) {
		const link = LINK_LINE.exec(line.trim());
		if (link) {
			links.push(link[1]);
		} else {
			(links.length ? rest : lead).push(line);
		}
	}
	return { commit, lead: lead.join('\n').trim(), links, summary: rest.join('\n').trim(), details: lines.slice(split + 1).join('\n').trim() };
}

/** `0.0.5` from `docs/release-notes/0.0.5.md`. */
export function voltReleaseNotesFileVersion(path: string | undefined): string | undefined {
	return path ? /(?:^|[\\/])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.md$/.exec(path)?.[1] : undefined;
}

/** "Oct 31, 2026" (in the display language). */
export function formatVoltReleaseDate(iso: string | undefined, locale: string): string | undefined {
	const date = iso ? new Date(iso) : undefined;
	if (!date || isNaN(date.getTime())) {
		return undefined;
	}
	return safeIntl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric' }).value.format(date);
}

export interface IVoltReleaseNotesLabels {
	readonly draft: string;
	readonly details: string;
	readonly viewOnGitHub: string;
}

/** The page: the blueprint version drawing, the title row, the summary, a divider and the details. */
export function renderVoltReleaseNotesBody(info: IVoltReleaseInfo, parts: IVoltReleaseNotesParts, html: { readonly lead: string; readonly summary: string; readonly details: string }, date: string | undefined, labels: IVoltReleaseNotesLabels): string {
	const glyphs = info.version.replace(/[-+].*$/, '');
	const channel = /-(beta|nightly)/i.exec(info.version)?.[1]?.toUpperCase();
	const caption = [channel, parts.commit?.slice(0, 8), '1000 UPM'].filter(Boolean).join(` ${MIDDLE_DOT} `);
	const links = parts.links.map(href => {
		const text = href.replace(/^https?:\/\//, '').replace(/\/$/, '');
		return `<p class="volt-release-link"><span class="mark" aria-hidden="true">${SPARKLE}</span><a href="${escape(href)}">${escape(text)}</a></p>`;
	}).join('');
	const hasSummary = !!parts.lead || !!parts.summary || !!links;
	return `<div class="volt-release">
		<section class="volt-hero" role="img" aria-label="Volt ${escape(info.version)}" data-glyphs="${escape(glyphs)}" data-caption="${escape(caption)}">
			<svg aria-hidden="true"></svg>
		</section>
		<div class="volt-release-title">
			<span class="name">Volt ${escape(info.version)}</span>
			<span class="sep" aria-hidden="true">|</span>
			<span class="date">${escape(date ?? labels.draft)}</span>
			<span class="options" id="volt-release-options"></span>
		</div>
		${hasSummary ? `<div class="volt-summary">${html.lead}${links}${html.summary}</div>
		<div class="volt-divider" role="separator"><span>${escape(labels.details)}</span></div>` : ''}
		<div class="volt-details">${html.details}</div>
		${info.url ? `<p class="volt-release-github"><a href="${escape(info.url)}">${escape(labels.viewOnGitHub)}</a></p>` : ''}
	</div>`;
}

export const VOLT_RELEASE_NOTES_STYLES = `
	.volt-release {
		--volt-blueprint: #2434ee;
		--volt-accent: #9aa2ff;
		--volt-mono: var(--vscode-editor-font-family, ui-monospace, "SF Mono", Menlo, monospace);
		padding-bottom: 48px;
	}
	body.vscode-light .volt-release { --volt-accent: #2434ee; }
	body.vscode-high-contrast .volt-release { --volt-accent: var(--vscode-textLink-foreground); }

	.volt-hero {
		position: relative;
		margin: 14px 0 0;
		background-color: var(--volt-blueprint);
		overflow: hidden;
	}
	.volt-hero svg { display: block; width: 100%; }
	.volt-hero text { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", system-ui, sans-serif; }
	.volt-hero .label, .volt-hero .caption { font-family: var(--volt-mono); font-size: 10px; fill: rgba(255, 255, 255, 0.72); letter-spacing: 0.02em; }
	.volt-hero .caption { font-size: 9.5px; fill: rgba(255, 255, 255, 0.55); letter-spacing: 0.08em; }
	.volt-hero .guide { stroke: rgba(255, 255, 255, 0.32); stroke-width: 1; fill: none; }
	.volt-hero .guide.faint { stroke: rgba(255, 255, 255, 0.14); }
	.volt-hero .dim { stroke: rgba(255, 255, 255, 0.72); stroke-width: 1; fill: none; }
	.volt-hero .ghost { fill: none; stroke: rgba(255, 255, 255, 0.26); stroke-width: 1; }
	.volt-hero .glyph { fill: url(#volt-hatch); stroke: #fff; stroke-width: 1.6; stroke-linejoin: round; }
	.volt-hero .node { fill: var(--volt-blueprint); stroke: rgba(255, 255, 255, 0.9); stroke-width: 1.1; }

	.volt-hero.animate .draw { stroke-dasharray: var(--len); stroke-dashoffset: var(--len); animation: volt-draw 0.9s cubic-bezier(0.2, 0.7, 0.2, 1) var(--delay, 0ms) forwards; }
	.volt-hero.animate .glyph { fill-opacity: 0; animation: volt-draw 1.3s cubic-bezier(0.3, 0.6, 0.2, 1) 0.15s forwards, volt-fill 0.6s ease-out 0.9s forwards; }
	.volt-hero.animate .fade { opacity: 0; animation: volt-fade 0.5s ease-out var(--delay, 700ms) forwards; }
	@keyframes volt-draw { to { stroke-dashoffset: 0; } }
	@keyframes volt-fill { to { fill-opacity: 1; } }
	@keyframes volt-fade { to { opacity: 1; } }
	@media (prefers-reduced-motion: reduce) {
		.volt-hero.animate .draw, .volt-hero.animate .glyph, .volt-hero.animate .fade { animation: none; stroke-dashoffset: 0; fill-opacity: 1; opacity: 1; }
	}

	.volt-release-title {
		display: flex;
		align-items: center;
		gap: 10px;
		margin: 22px 0 0;
		font-size: 13px;
		line-height: 20px;
	}
	.volt-release-title .name { font-weight: 600; color: var(--vscode-foreground); }
	.volt-release-title .sep { color: var(--vscode-descriptionForeground); opacity: 0.6; }
	.volt-release-title .date { color: var(--vscode-descriptionForeground); }
	.volt-release-title .options { margin-left: auto; font-size: 12px; color: var(--vscode-descriptionForeground); }
	.volt-release-title .options p { margin: 0; gap: 6px; }

	.volt-summary { margin-top: 10px; }
	.volt-summary > p:first-child { margin: 0 0 14px; font-size: 19px; line-height: 1.45; font-weight: 500; color: var(--vscode-foreground); }
	.volt-summary p { font-size: 14px; }
	.volt-summary ul { list-style: none; margin: 14px 0 0; padding: 0; }
	.volt-summary li { position: relative; margin: 2px 0; padding-left: 22px; font-size: 14px; line-height: 23px; }
	.volt-summary li::before { content: "+"; position: absolute; left: 3px; top: 0; font-family: var(--volt-mono); font-weight: 600; color: var(--volt-accent); }
	.volt-release-link { display: flex; align-items: center; gap: 8px; margin: 0 0 4px; font-family: var(--volt-mono); font-size: 12.5px; }
	.volt-release-link .mark { color: var(--volt-accent); font-family: var(--vscode-font-family); }

	.volt-divider {
		display: flex;
		align-items: center;
		gap: 12px;
		margin: 34px 0 6px;
		font-family: var(--volt-mono);
		font-size: 10.5px;
		line-height: 1;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--vscode-descriptionForeground);
	}
	.volt-divider::before, .volt-divider::after {
		content: "";
		flex: 1;
		height: 9px;
		opacity: 0.45;
		background: linear-gradient(currentColor, currentColor) center / 100% 1px no-repeat;
	}
	.volt-divider::before { background: linear-gradient(currentColor, currentColor) left center / 1px 9px no-repeat, linear-gradient(currentColor, currentColor) center / 100% 1px no-repeat; }
	.volt-divider::after { background: linear-gradient(currentColor, currentColor) right center / 1px 9px no-repeat, linear-gradient(currentColor, currentColor) center / 100% 1px no-repeat; }

	.volt-details { font-size: 13.5px; }
	.volt-details h2 { margin: 1.6em 0 0.5em; font-size: 1.55em; }
	.volt-details h2:first-child { margin-top: 0.9em; }
	.volt-details h3 { margin: 1.5em 0 0.4em; font-size: 1.2em; }
	.volt-details h2 + h3 { margin-top: 0.6em; }
	.volt-details li { margin: 3px 0; }
	.volt-details pre { overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
	.volt-release-github { margin-top: 28px; font-size: 13px; }
`;

/**
 * Draws the version into the hero like a type designer's construction sheet: hatched outline digits over a
 * lighter draft weight, guide lines, on-curve nodes and dimensions in font units. Runs inside the webview.
 */
export const VOLT_RELEASE_HERO_SCRIPT = `
(() => {
	const hero = document.querySelector('.volt-hero');
	const svg = hero && hero.querySelector('svg');
	if (!svg) { return; }
	const NS = 'http://www.w3.org/2000/svg';
	const FAMILY = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", system-ui, sans-serif';
	const glyphs = Array.from(hero.dataset.glyphs || '');
	const caption = hero.dataset.caption || '';
	let width = 0;
	let first = true;

	const el = (name, attrs, parent) => {
		const node = document.createElementNS(NS, name);
		for (const key in attrs) { node.setAttribute(key, String(attrs[key])); }
		(parent || svg).appendChild(node);
		return node;
	};
	const drawn = (node, length, delay) => {
		node.classList.add('draw');
		node.style.setProperty('--len', String(Math.ceil(length)));
		node.style.setProperty('--delay', delay + 'ms');
		return node;
	};
	const faded = (node, delay) => {
		node.classList.add('fade');
		node.style.setProperty('--delay', delay + 'ms');
		return node;
	};

	// Where one glyph's ink is: its box, the four points its outline touches the box at, its first stem and
	// which box corners are real corners of the outline. Read from the glyph rendered on a canvas.
	const inkOf = (ch, font, size) => {
		const pad = Math.ceil(size * 0.25);
		const canvas = document.createElement('canvas');
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		ctx.font = font;
		const advance = ctx.measureText(ch).width;
		const w = Math.ceil(advance + pad * 2);
		const h = Math.ceil(size * 1.5);
		const base = Math.round(size * 1.15);
		canvas.width = w;
		canvas.height = h;
		ctx.font = font;
		ctx.fillText(ch, pad, base);
		const data = ctx.getImageData(0, 0, w, h).data;
		const on = (x, y) => data[(y * w + x) * 4 + 3] > 140;
		let top = h, bottom = -1, left = w, right = -1;
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				if (on(x, y)) {
					if (y < top) { top = y; }
					if (y > bottom) { bottom = y; }
					if (x < left) { left = x; }
					if (x > right) { right = x; }
				}
			}
		}
		if (bottom < 0) { return { advance, empty: true }; }
		const mid = (from, to, test) => {
			let sum = 0, n = 0;
			for (let i = from; i <= to; i++) { if (test(i)) { sum += i; n++; } }
			return n ? sum / n : (from + to) / 2;
		};
		const midY = Math.round((top + bottom) / 2);
		let stemEnd = left;
		while (stemEnd < right && on(stemEnd + 1, midY)) { stemEnd++; }
		const corner = (x, y, dx, dy) => on(x, y) || on(x + dx, y) || on(x, y + dy) || on(x + dx, y + dy);
		const X = x => x - pad;
		const Y = y => y - base;
		return {
			advance,
			box: { left: X(left), right: X(right + 1), top: Y(top), bottom: Y(bottom + 1) },
			points: [
				{ x: X(mid(left, right, x => on(x, top)) + 0.5), y: Y(top) },
				{ x: X(right + 1), y: Y(mid(top, bottom, y => on(right, y)) + 0.5) },
				{ x: X(mid(left, right, x => on(x, bottom)) + 0.5), y: Y(bottom + 1) },
				{ x: X(left), y: Y(mid(top, bottom, y => on(left, y)) + 0.5) },
			],
			stem: { from: X(left), to: X(stemEnd + 1) },
			corners: [
				corner(left, top, 1, 1) && { x: X(left), y: Y(top) },
				corner(right, top, -1, 1) && { x: X(right + 1), y: Y(top) },
				corner(right, bottom, -1, -1) && { x: X(right + 1), y: Y(bottom + 1) },
				corner(left, bottom, 1, -1) && { x: X(left), y: Y(bottom + 1) },
			].filter(Boolean),
		};
	};

	const draw = () => {
		const W = Math.round(hero.clientWidth);
		if (!W || Math.abs(W - width) < 2) { return; }
		width = W;
		svg.replaceChildren();
		const H = Math.round(Math.min(340, Math.max(220, W * 0.46)));
		svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
		svg.setAttribute('height', String(H));

		const defs = el('defs', {});
		const hatch = el('pattern', { id: 'volt-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
		el('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: 'rgba(255,255,255,0.5)', 'stroke-width': 1.1 }, hatch);

		// Size the digits from their metrics at 100px: cap height about half the sheet, the row at most 62% of it.
		const probe = inkOf('H', '650 100px ' + FAMILY, 100);
		const capRatio = probe.empty ? 0.7 : -probe.box.top / 100;
		const tracking = 0.035;
		const advances100 = glyphs.map(ch => inkOf(ch, '650 100px ' + FAMILY, 100).advance / 100 + tracking);
		const rowRatio = advances100.reduce((a, b) => a + b, 0) - tracking;
		const size = Math.max(40, Math.min((H * 0.5) / capRatio, (W * 0.62) / rowRatio));
		const font = '650 ' + size + 'px ' + FAMILY;
		const unit = 1000 / size;
		const capH = capRatio * size;
		const units = px => Math.round(px * unit);

		const inks = glyphs.map(ch => inkOf(ch, font, size));
		const row = inks.reduce((sum, ink) => sum + ink.advance, 0) + tracking * size * (glyphs.length - 1);
		const x0 = Math.round(Math.max(64, (W - row) / 2 + 8));
		const baseline = Math.round(H / 2 + capH / 2 + 4);
		let pen = x0;
		const placed = inks.map((ink, i) => {
			const at = pen;
			pen += ink.advance + tracking * size;
			return { ch: glyphs[i], ink, x: at };
		});
		const real = placed.filter(p => !p.ink.empty);
		const firstGlyph = real[0];
		const lastGlyph = real[real.length - 1];
		const topInk = Math.min(...real.map(p => p.ink.box.top));
		const bottomInk = Math.max(...real.map(p => p.ink.box.bottom));

		// Guide lines across the sheet: overshoot, cap height, half height, baseline; and the first stem.
		const hLine = (y, cls, delay) => drawn(el('line', { x1: 0, y1: y + 0.5, x2: W, y2: y + 0.5, class: cls }), W, delay);
		const vLine = (x, cls, delay) => drawn(el('line', { x1: x + 0.5, y1: 0, x2: x + 0.5, y2: H, class: cls }), H, delay);
		const overshoot = Math.round(baseline + topInk);
		const capY = Math.round(baseline - capH);
		// Round digits overshoot the cap height; only worth a line and a dimension when it is visible.
		const showOvershoot = capY - overshoot >= 4;
		if (showOvershoot) { hLine(overshoot, 'guide', 0); }
		hLine(capY, 'guide', 60);
		hLine(Math.round(baseline - capH / 2), 'guide faint', 120);
		hLine(baseline, 'guide', 180);
		if (bottomInk > 1) { hLine(Math.round(baseline + bottomInk), 'guide faint', 220); }
		if (firstGlyph) {
			vLine(Math.round(firstGlyph.x + firstGlyph.ink.stem.from), 'guide', 90);
			vLine(Math.round(firstGlyph.x + firstGlyph.ink.stem.to), 'guide faint', 150);
		}
		if (lastGlyph) { vLine(Math.round(lastGlyph.x + lastGlyph.ink.box.right), 'guide faint', 210); }

		// The digits: a light draft weight underneath, the hatched outline on top.
		for (const p of placed) {
			el('text', { x: p.x, y: baseline, class: 'ghost', 'font-size': size, 'font-weight': 250 }).textContent = p.ch;
			drawn(el('text', { x: p.x, y: baseline, class: 'glyph', 'font-size': size, 'font-weight': 650 }), 1400, 150).textContent = p.ch;
		}

		const label = (x, y, text, anchor, delay) => faded(el('text', { x, y, class: 'label', 'text-anchor': anchor || 'start' }), delay).textContent = text;
		const coord = (p, point) => 'x' + units(point.x) + ' y' + units(-point.y);
		const tick = (x1, y1, x2, y2, delay) => drawn(el('line', { x1, y1, x2, y2, class: 'dim' }), Math.hypot(x2 - x1, y2 - y1), delay);
		const vDim = (x, yTop, yBottom, text, side, delay) => {
			tick(x, yTop, x, yBottom, delay);
			tick(x - 4, yTop, x + 4, yTop, delay);
			tick(x - 4, yBottom, x + 4, yBottom, delay);
			label(side === 'right' ? x + 9 : x - 9, (yTop + yBottom) / 2 + 3.5, text, side === 'right' ? 'start' : 'end', delay + 250);
		};
		const hDim = (y, xLeft, xRight, text, delay) => {
			tick(xLeft, y, xRight, y, delay);
			tick(xLeft, y - 4, xLeft, y + 4, delay);
			tick(xRight, y - 4, xRight, y + 4, delay);
			label((xLeft + xRight) / 2, y + 15, text, 'middle', delay + 250);
		};

		if (firstGlyph) {
			const left = firstGlyph.x + firstGlyph.ink.box.left;
			vDim(Math.round(left - 30) + 0.5, capY, baseline, String(units(capH)), 'left', 300);
			if (showOvershoot) { vDim(Math.round(left - 58) + 0.5, overshoot, capY, String(units(capY - overshoot)), 'left', 360); }
			const stem = firstGlyph.ink.stem;
			if (stem.to - stem.from > 4) { hDim(Math.round(baseline + Math.max(18, bottomInk + 18)) + 0.5, firstGlyph.x + stem.from, firstGlyph.x + stem.to, String(units(stem.to - stem.from)), 420); }
		}
		const rightDimX = lastGlyph ? Math.round(lastGlyph.x + lastGlyph.ink.box.right + 26) + 0.5 : 0;
		if (lastGlyph && lastGlyph !== firstGlyph) {
			const box = lastGlyph.ink.box;
			vDim(rightDimX, Math.round(baseline + box.top), Math.round(baseline + box.bottom), String(units(box.bottom - box.top)), 'right', 480);
		}

		// Off-curve handles at the extremes of the first and last glyph: tangents flat at the top and bottom,
		// upright at the sides, about as long as a circle's (0.55 of the radius).
		const handles = (p, delay) => {
			const box = p.ink.box;
			const rx = (box.right - box.left) / 2 * 0.55;
			const ry = (box.bottom - box.top) / 2 * 0.55;
			p.ink.points.forEach((point, side) => {
				const flat = side % 2 === 0;
				const cx = p.x + point.x;
				const cy = baseline + point.y;
				const [dx, dy] = flat ? [rx, 0] : [0, ry];
				faded(el('line', { x1: cx - dx, y1: cy - dy, x2: cx + dx, y2: cy + dy, class: 'dim' }), delay);
				faded(el('circle', { cx: cx - dx, cy: cy - dy, r: 2, class: 'node' }), delay);
				faded(el('circle', { cx: cx + dx, cy: cy + dy, r: 2, class: 'node' }), delay);
			});
		};
		if (firstGlyph) { handles(firstGlyph, 760); }
		if (lastGlyph && lastGlyph !== firstGlyph && W > 420) { handles(lastGlyph, 820); }

		// On-curve nodes: circles where an outline touches its box, squares on its corners; a few coordinates.
		real.forEach((p, i) => {
			for (const point of p.ink.points) {
				faded(el('circle', { cx: p.x + point.x, cy: baseline + point.y, r: 3, class: 'node' }), 650 + i * 60);
			}
			for (const c of p.ink.corners) {
				faded(el('rect', { x: p.x + c.x - 3, y: baseline + c.y - 3, width: 6, height: 6, class: 'node' }), 700 + i * 60);
			}
		});
		if (firstGlyph) {
			const [topPoint, , bottomPoint] = firstGlyph.ink.points;
			label(firstGlyph.x + topPoint.x, baseline + topPoint.y - 12, coord(firstGlyph, topPoint), 'middle', 900);
			// Under the stem dimension's number, which sits right below the baseline.
			label(firstGlyph.x + bottomPoint.x, baseline + Math.max(bottomInk, bottomPoint.y) + 56, coord(firstGlyph, bottomPoint), 'middle', 940);
		}
		if (lastGlyph && lastGlyph !== firstGlyph) {
			const rightPoint = lastGlyph.ink.points[1];
			const corner = lastGlyph.ink.corners[0];
			if (corner) { label(lastGlyph.x + corner.x + 10, baseline + corner.y - 8, coord(lastGlyph, corner), 'start', 980); }
			else { label(lastGlyph.x + lastGlyph.ink.points[0].x, baseline + lastGlyph.ink.points[0].y - 12, coord(lastGlyph, lastGlyph.ink.points[0]), 'middle', 980); }
			// Past the height dimension, low enough not to sit on its number.
			const middle = baseline + (lastGlyph.ink.box.top + lastGlyph.ink.box.bottom) / 2;
			const y = baseline + rightPoint.y;
			if (W > 420) { label(rightDimX + 9, Math.abs(y - middle) < 18 ? middle + 22 : y + 3.5, coord(lastGlyph, rightPoint), 'start', 1020); }
		}
		const dots = placed.filter(p => p.ch === '.' && !p.ink.empty);
		if (dots[0] && W > 380) {
			const dot = dots[0];
			label(dot.x + (dot.ink.box.left + dot.ink.box.right) / 2, baseline + dot.ink.box.bottom + 34, String(units(dot.ink.box.right - dot.ink.box.left)), 'middle', 1000);
		}

		if (caption) { faded(el('text', { x: W - 14, y: H - 14, class: 'caption', 'text-anchor': 'end' }), 1100).textContent = caption; }

		if (first) {
			first = false;
			hero.classList.add('animate');
			setTimeout(() => hero.classList.remove('animate'), 2600);
		}
	};

	draw();
	// Redraw in the next frame: drawing changes the sheet's height, which inside the callback is a resize loop.
	let frame = 0;
	new ResizeObserver(() => {
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(draw);
	}).observe(hero);
})();
`;
