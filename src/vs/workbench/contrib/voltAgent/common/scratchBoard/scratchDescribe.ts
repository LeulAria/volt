/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { boardDiagram, nodeLabel, readingOrder } from './scratchDiagram.js';
import { htmlToMarkdown, htmlToPlainText } from './scratchHtml.js';
import { graphToMermaid } from './scratchMermaid.js';
import type { IScratchFrameElement, ScratchElement, ScratchShapeKind } from './scratchTypes.js';

/**
 * The text an agent reads next to the render of a selection: what the board says (text, notes,
 * cards), how its diagram connects (Mermaid), and what else is on it.
 */

export interface IDescribeOptions {
	readonly boardTitle: string;
	/** The attached render of the selection (or board), when there is one. */
	readonly renderName?: string;
	/** Attached copies of image elements, by element id; images not attached are described without one. */
	readonly imageNames?: ReadonlyMap<string, string>;
	/** The whole board rather than a selection. */
	readonly whole: boolean;
}

const SHAPE_NAMES: Readonly<Record<ScratchShapeKind, string>> = {
	rectangle: 'Rectangle', diamond: 'Diamond', ellipse: 'Ellipse', triangle: 'Triangle', hexagon: 'Hexagon',
	parallelogram: 'Parallelogram', cylinder: 'Cylinder', pill: 'Pill', document: 'Document', cloud: 'Cloud', star: 'Star',
};

function quoted(text: string): string {
	// allow-any-unicode-next-line
	return `“${text.replace(/\s*\n\s*/g, ' / ')}”`;
}

interface ISection {
	readonly title: string;
	readonly body: string;
}

export function describeForAgent(elements: readonly ScratchElement[], options: IDescribeOptions): string {
	const count = elements.length;
	const lines: string[] = [];
	const scope = options.whole ? 'the whole board' : 'a selection';
	lines.push(`Scratch board ${quoted(options.boardTitle || 'Untitled')}: ${scope}, ${count} element${count === 1 ? '' : 's'}.`);

	const images = readingOrder(elements.filter(el => el.type === 'image'));
	const imageName = new Map<string, string>();
	images.forEach((el, i) => imageName.set(el.id, options.imageNames?.get(el.id) ?? `image ${i + 1}, not attached`));
	if (options.renderName) {
		lines.push(`Attached: ${options.renderName} is a render of ${options.whole ? 'the board' : 'the selection'}.`);
	}

	const diagram = boardDiagram(elements, htmlToPlainText);
	const covered = new Set<string>([...(diagram?.nodeElementIds ?? []), ...(diagram?.edgeElementIds ?? [])]);

	const frames = readingOrder(elements.filter((el): el is IScratchFrameElement => el.type === 'frame'));
	const frameIds = new Set(frames.map(f => f.id));
	const loose = elements.filter(el => el.type !== 'frame' && !(el.frameId && frameIds.has(el.frameId)));

	const top = sectionsFor(loose, covered, imageName);
	if (diagram) {
		// Right after the text, which always comes first.
		top.splice(top[0]?.title === 'Text' ? 1 : 0, 0, { title: 'Diagram', body: '```mermaid\n' + graphToMermaid(diagram.graph) + '\n```' });
	}
	const blocks: string[] = [lines.join('\n')];
	for (const section of top) {
		blocks.push(`## ${section.title}\n\n${section.body}`);
	}
	for (const frame of frames) {
		const members = elements.filter(el => el.frameId === frame.id && el.type !== 'frame');
		const sections = sectionsFor(members, covered, imageName);
		// The id lets an agent redraw the frame in place (scratch_draw `replace`).
		const heading = `## Frame ${quoted(frame.name || 'Frame')} (frameId ${frame.id})`;
		if (!sections.length) {
			blocks.push(`${heading}\n\n${members.length ? 'Only diagram parts (see above).' : 'Empty frame.'}`);
			continue;
		}
		blocks.push([heading, ...sections.map(s => `### ${s.title}\n\n${s.body}`)].join('\n\n'));
	}
	return blocks.join('\n\n');
}

function sectionsFor(elements: readonly ScratchElement[], covered: ReadonlySet<string>, imageName: ReadonlyMap<string, string>): ISection[] {
	const ordered = readingOrder(elements);
	const sections: ISection[] = [];

	const text: string[] = [];
	for (const el of ordered) {
		if (el.type !== 'text' && el.type !== 'note' && el.type !== 'card') {
			continue;
		}
		const md = htmlToMarkdown(el.html).trim();
		if (!md) {
			continue;
		}
		if (el.type === 'note') {
			text.push(md.includes('\n') ? `Sticky note:\n${md}` : `Sticky note: ${md}`);
		} else {
			text.push(md);
		}
	}
	if (text.length) {
		sections.push({ title: 'Text', body: text.join('\n\n') });
	}

	const shapes: string[] = [];
	const unlabelled: string[] = [];
	for (const el of ordered) {
		if (el.type !== 'shape' || covered.has(el.id)) {
			continue;
		}
		const label = nodeLabel(el, htmlToPlainText);
		if (label) {
			shapes.push(`- ${SHAPE_NAMES[el.shape]} ${quoted(label)}`);
		} else {
			unlabelled.push(SHAPE_NAMES[el.shape].toLowerCase());
		}
	}
	if (unlabelled.length) {
		shapes.push(`- ${unlabelled.length} unlabelled shape${unlabelled.length === 1 ? '' : 's'}: ${summarize(unlabelled)}`);
	}
	if (shapes.length) {
		sections.push({ title: 'Shapes', body: shapes.join('\n') });
	}

	const connectors: string[] = [];
	for (const el of ordered) {
		if ((el.type === 'arrow' || el.type === 'line') && !covered.has(el.id) && el.label) {
			const label = htmlToPlainText(el.label.html).trim();
			if (label) {
				connectors.push(`- ${el.type === 'arrow' ? 'Arrow' : 'Line'} ${quoted(label)}`);
			}
		}
	}
	if (connectors.length) {
		sections.push({ title: 'Connectors', body: connectors.join('\n') });
	}

	const icons: string[] = [];
	for (const el of ordered) {
		if (el.type === 'icon' && !covered.has(el.id)) {
			const label = el.label ? htmlToPlainText(el.label.html).trim() : '';
			icons.push(`- ${el.iconId}${label ? ` ${quoted(label)}` : ''}`);
		}
	}
	if (icons.length) {
		sections.push({ title: 'Icons', body: icons.join('\n') });
	}

	const images: string[] = [];
	for (const el of ordered) {
		if (el.type === 'image') {
			images.push(`- ${imageName.get(el.id) ?? 'image'}`);
		}
	}
	if (images.length) {
		sections.push({ title: 'Images', body: images.join('\n') });
	}

	const strokes = ordered.filter(el => el.type === 'draw').length;
	if (strokes) {
		sections.push({ title: 'Drawing', body: `- ${strokes} freehand stroke${strokes === 1 ? '' : 's'}; see the render.` });
	}
	return sections;
}

/** `rectangle ×2, ellipse` */
function summarize(names: readonly string[]): string {
	const counts = new Map<string, number>();
	for (const name of names) {
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return [...counts].map(([name, n]) => n > 1 ? `${name} ×${n}` : name).join(', ');
}

/** A comment as the agent reads it: its words and what it is pinned to (nothing: a spot on the board). */
export interface IDescribedComment {
	readonly text: string;
	readonly elements: readonly ScratchElement[];
}

const KIND_NAMES: Readonly<Record<string, string>> = {
	text: 'text', note: 'sticky note', card: 'card', frame: 'frame', arrow: 'arrow', line: 'line',
	draw: 'drawing', image: 'image', icon: 'icon',
};

/** `"Queue" (pill)`, `a sticky note "Ship it"`, `an unlabelled rectangle` (labels in curly quotes). */
function elementName(el: ScratchElement): string {
	const kind = el.type === 'shape' ? SHAPE_NAMES[el.shape].toLowerCase() : KIND_NAMES[el.type] ?? el.type;
	const raw = el.type === 'arrow' || el.type === 'line' ? (el.label ? htmlToPlainText(el.label.html).trim() : '') : el.type === 'image' || el.type === 'draw' ? '' : nodeLabel(el, htmlToPlainText);
	const label = raw.replace(/\s+/g, ' ');
	if (label) {
		return `${quoted(label.length > 60 ? `${label.slice(0, 59)}…` : label)} (${kind})`;
	}
	return el.type === 'image' || el.type === 'draw' ? `the ${kind}` : `an unlabelled ${kind}`;
}

/** What a comment is on: one element by name, a few listed, or a spot on the board. */
export function commentTarget(elements: readonly ScratchElement[]): string {
	if (!elements.length) {
		return 'a spot on the board';
	}
	if (elements.length === 1) {
		return elementName(elements[0]);
	}
	const named = readingOrder(elements).slice(0, 3).map(elementName);
	return `${elements.length} elements: ${named.join(', ')}${elements.length > 3 ? ', …' : ''}`;
}

/** The comments as a numbered list; the numbers match the pins on the attached render. */
export function describeComments(comments: readonly IDescribedComment[]): string {
	return comments.map((comment, i) => `${i + 1}. On ${commentTarget(comment.elements)}: ${comment.text.trim().replace(/\n+/g, ' / ')}`).join('\n');
}
