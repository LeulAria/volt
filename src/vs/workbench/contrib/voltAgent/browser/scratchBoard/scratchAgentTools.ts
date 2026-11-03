/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../../base/browser/window.js';
import { raceTimeout } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { decodeBase64, encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltHostToolCall, IVoltHostToolInfo, IVoltHostToolProvider, IVoltHostToolResult, IVoltVisualRef } from '../../../../services/voltRuntime/common/hostTools.js';
import { architectureToElements, IArchitectureSpec, parseArchitectureSpec } from '../../common/scratchBoard/scratchArchitecture.js';
import { describePage, IPageSpec, pageToElements, parsePageSpec } from '../../common/scratchBoard/scratchPage.js';
import { sketchIconNames, sketchToElements } from '../../common/scratchBoard/scratchSketch.js';
import { rebindConnector, routeContext, withLegs } from '../../common/scratchBoard/scratchBinding.js';
import { describeForAgent } from '../../common/scratchBoard/scratchDescribe.js';
import { diagramOverlaps, mermaidToElements, readingOrder } from '../../common/scratchBoard/scratchDiagram.js';
import { createCard, createFrame, createNote } from '../../common/scratchBoard/scratchFactory.js';
import { elementBounds, geometricBounds, withFrameContents } from '../../common/scratchBoard/scratchGeometry.js';
import { htmlToPlainText } from '../../common/scratchBoard/scratchHtml.js';
import { boundsIntersect, unionBounds } from '../../common/scratchBoard/scratchMath.js';
import { extractMermaidSource, parseMermaidFlowchart } from '../../common/scratchBoard/scratchMermaid.js';
import { ScratchScene } from '../../common/scratchBoard/scratchScene.js';
import { AGENT_DIAGRAM_STYLE, AGENT_SCRATCH_STYLE, IScratchAgentRun, IScratchBounds, isLinear, ScratchElement } from '../../common/scratchBoard/scratchTypes.js';
import { boardDisplayTitle } from '../../common/scratchBoard/scratchIndex.js';
import { ScratchBoardEditor } from './scratchBoardEditor.js';
import { fetchDiagramIcons, handTextMeasure } from './scratchDiagramIcons.js';
import type { ScratchCanvas } from './scratchCanvas.js';
import { ScratchExporter } from './scratchExport.js';
import { IScratchBoardService } from './scratchBoardService.js';
import { IScratchSessionLinks } from './scratchSessionLinks.js';
import { markdownToRichHtml } from './scratchRichText.js';

export const SCRATCH_READ_TOOL_NAME = 'scratch_read';
export const SCRATCH_DRAW_TOOL_NAME = 'scratch_draw';

const MAX_NOTES = 24;
const MAX_CARDS = 8;
const MAX_TEXT = 20_000;
const GAP = 48;
const NOTE_SIZE = 220;
/** Notes in the system font at 15px: about 22 characters a line in a 220px note, 21px a line. */
const NOTE_FONT_SIZE = 15;
const NOTE_LINE_CHARS = 22;
const NOTE_LINE_HEIGHT = 21;
/** Short notes stay short: a note fits its text instead of filling a square. */
const NOTE_MIN_HEIGHT = 96;
const FRAME_PADDING = 48;
/** How long a draw waits for the user to finish a drag before giving up. */
const IDLE_WAIT_MS = 15_000;
/** How long the drawing's picture may take to reach the chat's attachment store. */
const PUBLISH_TIMEOUT_MS = 5_000;

export const SCRATCH_TOOLS: readonly IVoltHostToolInfo[] = [
	{
		name: SCRATCH_READ_TOOL_NAME,
		title: 'Read Scratch board',
		group: 'visuals',
		description: 'Read the user\'s Scratch board (Volt\'s whiteboard): its text in reading order, shapes and connectors as a Mermaid flowchart, frames, and every element with its id, kind and position. Without boardId it reads the board this chat was started from (else the one the user has open). Read before drawing when you need to know what is already there.',
		inputSchema: {
			type: 'object',
			properties: {
				boardId: { type: 'string', description: 'A board id from an earlier scratch_read or scratch_draw. Usually leave it out.' },
			},
		},
	},
	{
		name: SCRATCH_DRAW_TOOL_NAME,
		title: 'Drew on Scratch board',
		group: 'visuals',
		approvalInReadOnlyModes: 'draws on your Scratch board',
		description: [
			'Draw on the user\'s Scratch board (Volt\'s whiteboard; agents draw in clean lines and the system font, like a figure in a paper), beside what they sent you: a diagram from a Mermaid flowchart (laid out automatically into shapes joined by connectors that stay attached when the user moves them), a hand-lettered page (a heading, a comparison table, takeaways), free-form drawings you compose yourself from the board\'s shapes, arrows, text, strokes and icons, sticky notes, and markdown cards (headings, lists, checklists, tables, code). The drawing also shows in the chat as a picture the user can open on the board.',
			'Everything lands in one frame named `title`, placed next to the user\'s selection, as one step the user can undo. Use it whenever the user asks you to draw, sketch, diagram, map, plan or add something on the board (or the request came from the board and a picture answers it best); keep your chat reply short, the user sees the drawing on their board.',
			'To redraw, fix or restyle something already on the board (yours, another chat\'s, or a frame the user selected and asked you to redraw), pass its frameId as `replace`: the new drawing takes its place, so the board does not end up with two versions. Draw beside it only when the user asks to keep the original.',
			'Mermaid: `flowchart LR` or `flowchart TD` only. Node shapes: A[box] B(rounded) C([pill]) D{decision} E[(database)] F((circle)) G{{hexagon}} H[/input/] I[[subroutine]]. Edges: A --> B, A -.-> B (dotted), A ==> B (thick), A -->|label| B, A <--> B. Edges draw as right-angled elbows that keep apart and go round shapes; curve one only where a curve reads better: `linkStyle 4 interpolate basis`. `subgraph Name ... end` becomes a frame. Keep labels short (2-5 words, <br/> for a second line).',
			'Sequences (an OAuth or request flow, a user journey) are flowcharts too: one node per step in order, with numbered edge labels ("1. redirect"), and the actors as subgraphs if it helps.',
			// The house style, condensed from a production diagram brief: what makes a board read like an architecture review.
			'Draw like a production architecture review. Layout: LR for request flows and pipelines, TD for hierarchies and layers; subgraphs only for real boundaries (actors, client/server, trust zones, accounts), not decoration. One idea per frame (about 15 nodes at most): an overview first, then another scratch_draw per detail view.',
			'Labels: short nouns on nodes ("API Gateway", "Postgres"), verbs or protocols on edges ("HTTPS", "publishes event"). Shapes mean something: [(db)] storage, ([pill]) users and external systems, [[subroutine]] services and agents, [/io/] queues, {decision}. Edges: --> sync or control, -.-> (dots) async, events, replies, optional or fallback paths, ==> the main path. Vary lines by meaning: `linkStyle 3 stroke-dasharray:6 4` dashes for planned or proposed links, `linkStyle 5 stroke:#e03131` a red error path (linkStyle counts edges in the order written, from 0); `classDef planned stroke-dasharray:6 4` gives nodes a dashed outline.',
			'Leave most nodes plain (they draw in quiet grey); colour only what must stand out, sparingly and by meaning, with `classDef name fill:#..,stroke:#..` plus `class A,B name` (or A:::name), light fill with a darker stroke: blue #a5d8ff/#1971c2 core, green #b2f2bb/#2f9e44 data, yellow #ffec99/#f08c00 async, purple #eebefa/#9c36b5 AI and models, red #ffc9c9/#e03131 external or risk, gray #e9ecef/#868e96 out of scope.',
			'AI systems: keep UI, orchestrator, agents, tools, model providers, memory or vector store, guardrails and human approval, and tracing apart. Do not invent components; mark assumptions with "?" or a sticky note; keep proposed and existing apart (own frame, or dashed edges and outlines). Check the returned image and fix overlaps, crossings or clipped labels with `replace` before you answer.',
			'Nothing may overlap: a line never runs through a shape that is not one of its ends, and an edge label never sits on a shape or another label. The layout routes an edge that skips a level around the nodes in between, but it cannot fix every graph: the result names each overlap it finds, and you redraw until it reports none. Help it: declare nodes in flow order, keep side branches (cancel, fail, timeout) after the main path, give an edge that jumps several steps a short label or none, and avoid many edges into one node from far apart.',
			'Architecture pictures (how a system fits together: services, vendors, machines, the numbered path a request or ticket takes) use `diagram` instead of `mermaid`: a hand-drawn board in the Excalidraw style with real icons and brand logos fetched from Aria Icons. Groups are the places things run (a vendor like Neon or Vercel, "Your Mac", "Sources") drawn as coloured containers with an icon and a name; each holds cards with an icon, a title and a quieter subtitle ("Webhook inbox" / "Linear and GitHub"). Edges join cards or whole groups, with numbered labels beside the line ("1. New ticket"). Always place every group on a grid with `row` and `col` from 0 (rowSpan/colSpan to stretch), so the flow reads left to right and top to bottom and linked groups sit next to each other; a 2-3 column grid reads best. Without them the layout lines groups up along `direction`, which is wider and tangles more.',
			'Pages (a comparison, a scorecard, a summary with takeaways: anything that reads best as a hand-lettered slide) use `page`: a big heading, a table whose row names sit in quiet grey with the values centred under their columns, a small footnote and a few takeaway bullets, all in the hand font. Put the things compared in `columns` (colour one to single it out, e.g. the subject in blue) and one row per measure; give a row `best: "high"` or `"low"` and its winning number turns green on its own, or mark a cell `{ "text": "yes, Nov 4", "best": true }`. Keep cells short ("$2 / $10", "67.2%"), say in the footnote where the numbers come from and what green means, and keep bullets to one line each. A page can go with notes or cards but not with `mermaid` or `diagram`: draw those in another call.',
			'Anything else, draw it yourself with `elements`, and be creative: this is a whiteboard, so make the picture someone would sketch to explain the idea, not a table of text. Illustrated explainers (a metaphor drawn out: a funnel, a pipeline of machines, a tree, a map), timelines and roadmaps, mind maps, hand-drawn bar or line charts, before/after, UI wireframes, a user journey with faces and speech bubbles, an annotated diagram with callouts. `elements` are the board\'s own pieces at x, y in your own coordinates (they are moved into place together): shapes (rectangle, ellipse, diamond, triangle, hexagon, parallelogram, cylinder, pill, document, cloud, star) with optional `text` inside; `text`; `arrow` and `line` with `points` [[x, y], ...] (a curve through them: arrowType "round"; right angles: "elbow") or `from`/`to` element ids so they stay attached; `freehand` strokes (underlines, circles round a word, squiggles, ticks) and `highlighter`; `note` (sticky, fill yellow/pink/blue/green/violet/orange); `icon` (an Aria Icons id or a word). Style each one: `stroke`, `fill` (a colour name or hex), `fillStyle` hachure, cross-hatch or solid (hachure reads hand-made), `strokeWidth`, `strokeStyle` dashed or dotted, `roughness` 0 clean to 2 sketchy, `opacity`, `angle` in degrees, `font` hand/sans/mono, `fontSize` (or small/medium/large/huge), `group` to move pieces together. Make it look designed: a clear title at the top, a grid you keep to (same gaps, aligned edges), two or three colours with meaning, big type for what matters and small grey type for asides, arrows with short labels, and nothing touching that should not. Then look at the returned image and redraw with `replace` until it is something you would show off.',
			'Icons: an Aria Icons id, `logos:<brand>-icon` (logos:github-icon, logos:slack-icon, logos:vercel-icon, logos:neon-icon, logos:linear-icon, logos:postgresql, logos:aws) or `simple-icons:<brand>` for brand logos, `lucide:<name>` for everything else (lucide:webhook, lucide:database, lucide:monitor, lucide:git-pull-request, lucide:laptop, lucide:inbox, lucide:history, lucide:radio); a plain word is searched. Colours by name: green, cyan, blue, violet, purple, pink, red, orange, yellow, gray: a group in its colour, cards inside take it unless they set their own. `dashed: true` marks something planned or not built yet.',
		].join(' '),
		inputSchema: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'The frame\'s name, e.g. "OAuth sign-in (PKCE)".' },
				mermaid: { type: 'string', description: 'A Mermaid flowchart for the diagram.' },
				diagram: {
					type: 'object',
					description: 'An architecture picture (instead of `mermaid`): groups of icon cards joined by labelled connectors.',
					properties: {
						direction: { type: 'string', enum: ['LR', 'TB'], description: 'Which way the flow runs when groups have no row/col.' },
						groups: {
							type: 'array',
							items: {
								type: 'object',
								properties: {
									id: { type: 'string' },
									label: { type: 'string', description: 'The name in the header, e.g. "Neon".' },
									sub: { type: 'string', description: 'A quieter note after the name, e.g. "Database and inbox".' },
									icon: { type: 'string', description: 'Icon id (logos:neon-icon, lucide:laptop) or a word.' },
									color: { type: 'string', description: 'green, cyan, blue, violet, purple, pink, red, orange, yellow, gray, or #hex.' },
									dashed: { type: 'boolean' },
									layout: { type: 'string', enum: ['row', 'column'], description: 'Cards side by side (icon above the title) or stacked (icon before it).' },
									row: { type: 'number' },
									col: { type: 'number' },
									rowSpan: { type: 'number' },
									colSpan: { type: 'number' },
									nodes: {
										type: 'array',
										items: {
											type: 'object',
											properties: {
												id: { type: 'string' },
												label: { type: 'string' },
												sub: { type: 'string', description: 'One short line under the title.' },
												icon: { type: 'string' },
												color: { type: 'string' },
												dashed: { type: 'boolean' },
											},
											required: ['label'],
										},
									},
								},
								required: ['label'],
							},
						},
						nodes: { type: 'array', description: 'Cards outside every group (same fields as a group\'s nodes, plus row and col).', items: { type: 'object' } },
						edges: {
							type: 'array',
							items: {
								type: 'object',
								properties: {
									from: { type: 'string', description: 'A card or group id.' },
									to: { type: 'string' },
									label: { type: 'string', description: 'Short, numbered along the main path: "2. Claim it".' },
									color: { type: 'string' },
									style: { type: 'string', enum: ['solid', 'dashed', 'dotted'] },
									both: { type: 'boolean', description: 'Arrowheads at both ends.' },
									labelSide: { type: 'string', enum: ['top', 'bottom'], description: 'Above/right of the line (default) or below/left.' },
								},
								required: ['from', 'to'],
							},
						},
					},
				},
				page: {
					type: 'object',
					description: 'A hand-lettered page (instead of `mermaid` or `diagram`): heading, comparison table, footnote, takeaway bullets.',
					properties: {
						heading: { type: 'string', description: 'The big title on the page; defaults to `title`.' },
						subtitle: { type: 'string', description: 'One quieter line under the heading.' },
						table: {
							type: 'object',
							properties: {
								columns: {
									type: 'array',
									description: 'The names along the top, one per value column (the row names need none).',
									items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { label: { type: 'string' }, color: { type: 'string', description: 'blue, green, red, violet, ... or #hex.' } }, required: ['label'] }] },
								},
								rows: {
									type: 'array',
									items: {
										type: 'object',
										properties: {
											label: { type: 'string', description: 'What the row measures, e.g. "cost per task (AA)".' },
											cells: {
												type: 'array',
												description: 'One value per column, in column order.',
												items: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'object', properties: { text: { type: 'string' }, color: { type: 'string' }, best: { type: 'boolean' } }, required: ['text'] }] },
											},
											best: { type: 'string', enum: ['high', 'low'], description: 'Which number wins: its cell turns green.' },
										},
										required: ['label', 'cells'],
									},
								},
							},
							required: ['columns', 'rows'],
						},
						footnote: { type: 'string', description: 'Small print under the table: sources, dates, what green means.' },
						bullets: { type: 'array', items: { type: 'string' }, description: 'Takeaways under the table, one line each.' },
					},
				},
				elements: {
					type: 'array',
					description: 'Free-form pieces you place yourself: anything the other modes do not cover. Coordinates are yours; the whole set is moved into place together.',
					items: {
						type: 'object',
						properties: {
							type: { type: 'string', enum: ['rectangle', 'ellipse', 'diamond', 'triangle', 'hexagon', 'parallelogram', 'cylinder', 'pill', 'document', 'cloud', 'star', 'text', 'arrow', 'line', 'freehand', 'highlighter', 'note', 'icon'] },
							id: { type: 'string', description: 'For arrows\' `from`/`to`.' },
							x: { type: 'number' },
							y: { type: 'number' },
							width: { type: 'number' },
							height: { type: 'number' },
							text: { type: 'string', description: 'Inside a shape, along an arrow, or the text itself (markdown; \\n for a new line).' },
							points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'Arrows, lines and freehand: [[x, y], ...] in your coordinates.' },
							from: { type: 'string', description: 'Arrows and lines: the id they start on.' },
							to: { type: 'string' },
							arrowType: { type: 'string', enum: ['sharp', 'round', 'elbow'] },
							startArrowhead: { type: 'string' },
							endArrowhead: { type: 'string', description: 'arrow, triangle, dot, circle, bar, diamond, none, ...' },
							icon: { type: 'string', description: 'Icons: lucide:rocket, logos:github-icon, or a word.' },
							stroke: { type: 'string', description: 'A colour name (red, blue, green, violet, orange, gray, ...) or #hex.' },
							fill: { type: 'string', description: 'A colour name or #hex; notes: their paper.' },
							fillStyle: { type: 'string', enum: ['hachure', 'cross-hatch', 'solid'] },
							strokeWidth: { type: 'number' },
							strokeStyle: { type: 'string', enum: ['solid', 'dashed', 'dotted'] },
							roughness: { type: 'number', description: '0 clean, 1 hand-drawn, 2 sketchy.' },
							opacity: { type: 'number' },
							angle: { type: 'number', description: 'Degrees, clockwise.' },
							font: { type: 'string', enum: ['hand', 'sans', 'serif', 'mono'] },
							fontSize: { anyOf: [{ type: 'number' }, { type: 'string', enum: ['small', 'medium', 'large', 'huge'] }] },
							textColor: { type: 'string' },
							align: { type: 'string', enum: ['left', 'center', 'right'] },
							group: { type: 'string', description: 'Pieces with the same group move together.' },
						},
						required: ['type'],
					},
				},
				notes: {
					type: 'array',
					maxItems: MAX_NOTES,
					description: 'Sticky notes (grey, in the system font): short points, ideas, open questions, risks.',
					items: {
						type: 'object',
						properties: {
							text: { type: 'string', description: 'Markdown; a few lines at most.' },
						},
						required: ['text'],
					},
				},
				cards: {
					type: 'array',
					maxItems: MAX_CARDS,
					description: 'Markdown cards for longer text: a spec, a checklist, a table, code.',
					items: { type: 'string' },
				},
				replace: { type: 'string', description: 'The frameId of a frame to redraw in place (from scratch_read, the context the user sent, or an earlier scratch_draw).' },
				boardId: { type: 'string', description: 'Usually leave it out: the board this chat came from.' },
			},
			required: ['title'],
		},
	},
];

interface INoteInput {
	readonly text: string;
}

/** Serves scratch_read and scratch_draw on Volt's MCP server. */
export class ScratchBoardToolProvider extends Disposable implements IVoltHostToolProvider {

	readonly tools = SCRATCH_TOOLS;

	private readonly exporter: ScratchExporter;

	constructor(
		@IScratchBoardService private readonly boards: IScratchBoardService,
		@IEditorService private readonly editorService: IEditorService,
		@IScratchSessionLinks private readonly links: IScratchSessionLinks,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.exporter = instantiationService.createInstance(ScratchExporter);
	}

	async invoke(name: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		try {
			switch (name) {
				case SCRATCH_READ_TOOL_NAME: return await this.read(args, call);
				case SCRATCH_DRAW_TOOL_NAME: return await this.draw(args, call);
			}
			return { error: `Unknown tool ${name}` };
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
	}

	/** The board a call is about: the one named, else the one its chat was started from, else the one the user last opened. */
	private async boardFor(args: Record<string, unknown>, call: IVoltHostToolCall | undefined, create = false): Promise<string> {
		await this.boards.whenReady;
		if (typeof args.boardId === 'string' && args.boardId) {
			if (!this.boards.getBoard(args.boardId)) {
				throw new Error(`There is no Scratch board ${args.boardId}.`);
			}
			return args.boardId;
		}
		const linked = call?.sessionId ? this.links.boardFor(call.sessionId) : undefined;
		const fromChat = linked && this.boards.getBoard(linked) ? linked : call?.sessionId ? await this.boards.findBoardForSession(call.sessionId) : undefined;
		if (fromChat) {
			return fromChat;
		}
		const index = this.boards.index;
		const last = index.lastOpened && this.boards.getBoard(index.lastOpened) ? index.lastOpened : undefined;
		const newest = [...index.boards].filter(b => !b.deleted && !b.archived).sort((a, b) => (b.edited || b.created) - (a.edited || a.created))[0]?.id;
		const id = last ?? newest;
		if (!id) {
			// A chat can sketch before the user ever opened Scratch: its drawing starts their first board.
			if (create) {
				return this.boards.createBoard();
			}
			throw new Error('The user has no Scratch board yet. They can open one from the Scratch button beside New Chat.');
		}
		return id;
	}

	private async read(args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const boardId = await this.boardFor(args, call);
		const ref = await this.boards.acquireModel(boardId);
		try {
			const scene = ref.object.scene;
			const elements = scene.getElements();
			const title = boardDisplayTitle(this.boards.getBoard(boardId)!);
			if (!elements.length) {
				return { text: `Scratch board "${title}" (boardId ${boardId}) is empty.` };
			}
			const described = describeForAgent(elements, { boardTitle: title, whole: true });
			const lines = readingOrder(elements).map(el => {
				const b = geometricBounds(el);
				const text = elementText(el);
				return `- ${el.id} ${kindOf(el)} at ${Math.round(b.minX)},${Math.round(b.minY)} ${Math.round(b.maxX - b.minX)}x${Math.round(b.maxY - b.minY)}${el.frameId ? ` in ${el.frameId}` : ''}${text ? `: ${text}` : ''}`;
			});
			const image = await this.render(scene, elements);
			return { text: `${described}\n\nboardId ${boardId}.${image ? ' The image is the board as the user sees it.' : ''} Elements (id, kind, position, size):\n${lines.join('\n')}`, ...(image ? { image } : {}) };
		} finally {
			ref.dispose();
		}
	}

	private async draw(args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim().slice(0, 120) : '';
		if (!title) {
			return { error: 'Give the drawing a `title`.' };
		}
		const mermaid = typeof args.mermaid === 'string' && args.mermaid.trim() ? args.mermaid.trim().slice(0, MAX_TEXT) : undefined;
		const notes = (Array.isArray(args.notes) ? args.notes : []).slice(0, MAX_NOTES).map(parseNote).filter((n): n is INoteInput => !!n);
		const cards = (Array.isArray(args.cards) ? args.cards : []).slice(0, MAX_CARDS).filter((c): c is string => typeof c === 'string' && !!c.trim()).map(c => c.slice(0, MAX_TEXT));
		let architecture: IArchitectureSpec | undefined;
		let warnings: string[] = [];
		if (args.diagram !== undefined && args.diagram !== null) {
			if (mermaid) {
				return { error: 'Pass `diagram` or `mermaid`, not both: draw the other in a second scratch_draw.' };
			}
			const parsed = parseArchitectureSpec(args.diagram);
			if ('error' in parsed) {
				return { error: parsed.error };
			}
			architecture = parsed.spec;
			warnings = parsed.warnings;
		}
		let page: IPageSpec | undefined;
		if (args.page !== undefined && args.page !== null) {
			if (mermaid || architecture) {
				return { error: 'Pass `page` on its own (notes and cards may go with it), not with `mermaid` or `diagram`: draw the other in a second scratch_draw.' };
			}
			const parsed = parsePageSpec(args.page, title);
			if ('error' in parsed) {
				return { error: parsed.error };
			}
			page = parsed.spec;
			warnings.push(...parsed.warnings);
		}
		const hasSketch = Array.isArray(args.elements) && args.elements.length > 0;
		if (!mermaid && !architecture && !page && !hasSketch && !notes.length && !cards.length) {
			return { error: 'Nothing to draw: pass `elements`, `diagram`, `mermaid`, `page`, `notes` or `cards`.' };
		}
		const graph = mermaid ? parseMermaidFlowchart(extractMermaidSource(mermaid) ?? mermaid) : undefined;
		if (mermaid && (!graph || !graph.nodes.length)) {
			return { error: 'That Mermaid did not parse as a flowchart. Start with `flowchart LR` (or TD) and use only nodes, edges and subgraphs; sequence diagrams are not supported, so draw the steps as a flowchart.' };
		}
		// Icons and the hand font's widths before the board is touched: the user may draw meanwhile.
		let architectureElements: ScratchElement[] = [];
		if (architecture) {
			const names = [...architecture.groups, ...architecture.groups.flatMap(g => g.nodes), ...architecture.nodes].map(item => item.icon).filter((n): n is string => !!n);
			const [icons, measure] = await Promise.all([fetchDiagramIcons(names), handTextMeasure(mainWindow.document)]);
			const missing = [...new Set(names)].filter(n => !icons.has(n));
			if (missing.length) {
				warnings.push(`no icon was found for ${missing.map(n => `"${n}"`).join(', ')}, so those draw without one`);
			}
			architectureElements = architectureToElements(architecture, [0, 0], { style: AGENT_DIAGRAM_STYLE, icon: name => icons.get(name), measure });
		}
		const pageElements = page ? pageToElements(page, [0, 0], { style: AGENT_DIAGRAM_STYLE, measure: await handTextMeasure(mainWindow.document) }) : [];
		let sketchElements: ScratchElement[] = [];
		if (hasSketch) {
			const names = sketchIconNames(args.elements);
			const [icons, measure] = await Promise.all([fetchDiagramIcons(names), handTextMeasure(mainWindow.document)]);
			const sketched = sketchToElements(args.elements, { style: AGENT_DIAGRAM_STYLE, measure, icon: name => icons.get(name), rich: markdown => markdownToRichHtml(markdown, mainWindow.document) });
			if ('error' in sketched) {
				return { error: sketched.error };
			}
			sketchElements = sketched.elements;
			warnings.push(...sketched.warnings);
		}

		const boardId = await this.boardFor(args, call, true);
		// The chat drew here: its toolbar in Agents leads to this board.
		if (call?.sessionId) {
			this.links.link(call.sessionId, boardId);
		}
		const ref = await this.boards.acquireModel(boardId);
		try {
			const model = ref.object;
			const scene = model.scene;
			if (!await whenIdle(scene)) {
				return { error: 'The user is in the middle of drawing on the board. Try again in a moment.' };
			}
			const doc = mainWindow.document;
			// The agent's house style: clean lines, the system font, grey notes.
			const style = AGENT_SCRATCH_STYLE;

			// Lay the parts out from (0, 0): diagram, then a row of notes, then the cards.
			const content: ScratchElement[] = [];
			let cursorY = 0;
			for (const drawn of [architectureElements, pageElements]) {
				if (!drawn.length) {
					continue;
				}
				content.push(...drawn);
				const b = unionBounds(drawn.map(el => geometricBounds(el)));
				if (b) {
					cursorY = b.maxY + GAP;
				}
			}
			if (graph) {
				const diagram = mermaidToElements(graph, [0, 0], style);
				content.push(...diagram);
				const b = unionBounds(diagram.map(el => geometricBounds(el)));
				if (b) {
					cursorY = b.maxY + GAP;
				}
			}
			// The agent's own pieces keep their places relative to each other, under whatever came before.
			const sketchBounds = unionBounds(sketchElements.map(el => geometricBounds(el)));
			if (sketchBounds) {
				const dx = -sketchBounds.minX, dy = cursorY - sketchBounds.minY;
				content.push(...sketchElements.map(el => ({ ...el, x: el.x + dx, y: el.y + dy })));
				cursorY += sketchBounds.maxY - sketchBounds.minY + GAP;
			}
			if (notes.length) {
				// Rows as tall as their longest note: a note grows to fit its text, and must not grow into the next row.
				const perRow = 4;
				for (let row = 0; row * perRow < notes.length; row++) {
					const inRow = notes.slice(row * perRow, (row + 1) * perRow);
					const rowHeight = Math.max(...inRow.map(note => estimateNoteHeight(note.text)));
					inRow.forEach((note, i) => {
						content.push(createNote({
							x: i * (NOTE_SIZE + 24),
							y: cursorY,
							height: rowHeight,
							html: markdownToRichHtml(note.text, doc),
							fontSize: NOTE_FONT_SIZE,
						}, style));
					});
					cursorY += rowHeight + 24;
				}
				cursorY += GAP - 24;
			}
			if (cards.length) {
				const perRow = 2;
				let rowHeight = 0;
				cards.forEach((card, i) => {
					if (i > 0 && i % perRow === 0) {
						cursorY += rowHeight + 24;
						rowHeight = 0;
					}
					// The board fits a card's height to its text once drawn; this is a first guess for the frame.
					const height = estimateCardHeight(card);
					rowHeight = Math.max(rowHeight, height);
					content.push(createCard({ x: (i % perRow) * (420 + 24), y: cursorY, height, html: markdownToRichHtml(card, doc) }, style));
				});
				cursorY += rowHeight;
			}
			const inner = unionBounds(content.map(el => geometricBounds(el)))!;

			// Where it goes: in place of the drawing it replaces, else beside what the chat was sent, else beside the board.
			const replaced = typeof args.replace === 'string' ? scene.get(args.replace) : undefined;
			if (typeof args.replace === 'string' && args.replace && (!replaced || replaced.type !== 'frame')) {
				return { error: `There is no frame ${args.replace} on this board to replace.` };
			}
			const width = inner.maxX - inner.minX + FRAME_PADDING * 2;
			const height = inner.maxY - inner.minY + FRAME_PADDING * 2;
			// The frame, and everything in it, frames in frames included (a swimlane's steps sit in its lanes).
			const removed = replaced ? withFrameContents(scene.getElements(), new Set([replaced.id])) : new Set<string>();
			// A chat asked with nothing attached kept a free spot on the board: the drawing goes there.
			const run = runOf(scene, call?.sessionId);
			const spot = !replaced && run && !run.elementIds.length ? run : undefined;
			// In place stays in place while the new size fits there; a bigger drawing moves down past what it would cover.
			const origin = replaced
				? placeAt(scene, replaced.x, replaced.y, width, height, run?.id, removed)
				: spot
					? placeAt(scene, spot.bounds.x, spot.bounds.y, width, height, run?.id)
					: placeBeside(scene, removed, anchorFor(scene, call?.sessionId), width, height, run?.id);
			const dx = origin[0] + FRAME_PADDING - inner.minX;
			const dy = origin[1] + FRAME_PADDING - inner.minY;
			const frame = createFrame({ x: origin[0], y: origin[1], width, height, name: title }, style);
			const placed = content.map((el): ScratchElement => ({ ...el, x: el.x + dx, y: el.y + dy, frameId: el.frameId ?? frame.id }));

			scene.transact(`Drawn by agent: ${title}`, tx => {
				for (const id of removed) {
					tx.remove(id);
				}
				// Connectors left pointing at what was replaced let go of it.
				for (const el of scene.getElements()) {
					if (isLinear(el) && ((el.startBinding && removed.has(el.startBinding.elementId)) || (el.endBinding && removed.has(el.endBinding.elementId)))) {
						tx.update(el.id, {
							startBinding: el.startBinding && removed.has(el.startBinding.elementId) ? null : el.startBinding,
							endBinding: el.endBinding && removed.has(el.endBinding.elementId) ? null : el.endBinding,
						});
					}
				}
				tx.add(frame, 0);
				for (const el of placed) {
					tx.add(el, el.type === 'frame' ? 0 : undefined);
				}
				// The run's outline moves from the empty spot onto the drawing, and a run outlining what was
				// replaced outlines the new drawing (else it keeps the old size and the new one spills out of it).
				const frameBounds = { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
				if (spot || scene.runs.some(r => r.elementIds.some(id => removed.has(id)))) {
					tx.setRuns(scene.runs.map(r => {
						if (r.id === spot?.id) {
							return { ...r, elementIds: [frame.id], bounds: frameBounds };
						}
						if (!r.elementIds.some(id => removed.has(id))) {
							return r;
						}
						const elementIds = [...new Set(r.elementIds.map(id => removed.has(id) ? frame.id : id))];
						return { ...r, elementIds, bounds: elementIds.length === 1 ? frameBounds : r.bounds };
					}));
				}
				// Connectors land on their shapes' outlines; elbows keep their routes, or go round what is in the way.
				// An architecture diagram's lines were routed with it (sides, tracks) and only moved: they stay.
				const routed = new Set(architectureElements.filter(isLinear).map(el => el.id));
				let around = routeContext(scene.getElements());
				for (const el of placed) {
					if (isLinear(el) && !routed.has(el.id)) {
						const patch = rebindConnector(scene.get(el.id) as typeof el, id => scene.get(id), undefined, around);
						if (patch) {
							around = withLegs(around, el.id, patch.points.map(p => [patch.x + p[0], patch.y + p[1]] as const));
							tx.update(el.id, patch);
						}
					}
				}
			});
			await model.flush();
			this.show(boardId, [frame.id]);
			const image = await this.picture(scene, frame.id);

			const sketched = new Set(sketchElements.map(el => el.id));
			const shapes = placed.filter(el => el.type === 'shape' && !sketched.has(el.id)).length;
			const connectors = placed.filter(el => isLinear(el) && !sketched.has(el.id)).length;
			const groups = architectureElements.filter(el => el.type === 'frame').length;
			const parts = [
				sketchElements.length ? `${sketchElements.length} pieces of your own` : '',
				groups ? `${groups} groups` : '',
				shapes ? `${shapes} ${architecture ? 'cards' : 'shapes'}` : '',
				connectors ? `${connectors} connectors` : '',
				page ? `a page with ${describePage(page) || 'a heading'}` : '',
				notes.length ? `${notes.length} sticky notes` : '',
				cards.length ? `${cards.length} cards` : '',
			].filter(Boolean).join(', ');
			const boardTitle = boardDisplayTitle(this.boards.getBoard(boardId)!);
			const drawn = withFrameContents(scene.getElements(), new Set([frame.id]));
			// Free-form pieces overlap on purpose (a word circled, a label on a shape): the agent judges those from the image.
			const overlaps = diagramOverlaps(scene.getElements().filter(el => drawn.has(el.id) && !sketched.has(el.id)), htmlToPlainText);
			const check = overlaps.length
				? `Overlaps to fix before you answer: ${overlaps.join('; ')}. Redraw with replace: "${frame.id}": reorder the nodes or edges so the ends sit next to each other, split a crowded diagram into two, or shorten the labels.`
				: 'No line runs through a shape and no label sits on a shape or another label.';
			const notices = warnings.length ? ` Note: ${warnings.join('; ')}.` : '';
			// The picture goes in the chat too, with Open to see the drawing on its board.
			const visual = image ? await this.publish(image, title, boardId, frame.id, replaced?.id) : undefined;
			return {
				text: `Drew "${title}" on the Scratch board "${boardTitle}" (${parts}), ${replaced ? 'in place of the earlier drawing' : spot ? 'in the free spot kept for it' : 'beside what the user sent'}. frameId ${frame.id}, boardId ${boardId}. ${check}${notices} ${image ? 'The image is the drawing as the user sees it: check it here (no screenshots or desktop tools needed). ' : ''}The user sees it on their board now${visual ? ' and as a picture in the chat' : ''}, and can undo it; to change it, call scratch_draw again with replace: "${frame.id}". Do not repeat the drawing in your reply.`,
				...(image ? { image } : {}),
				...(visual ? { visual } : {}),
			};
		} finally {
			ref.dispose();
		}
	}

	/** Stores the drawing's picture for the chat: the transcript shows it with Open, which shows `frameId` on its board. */
	private async publish(dataUrl: string, title: string, boardId: string, frameId: string, replaces: string | undefined): Promise<IVoltVisualRef | undefined> {
		try {
			const png = decodeBase64(dataUrl.slice(dataUrl.indexOf(',') + 1)).buffer;
			// The chat's picture is extra: a history store that does not answer (an agent server out of
			// reach) must not hold up the drawing's result.
			const ref = await raceTimeout(this.history.putAttachment(png, 'image/png'), PUBLISH_TIMEOUT_MS);
			if (!ref) {
				return undefined;
			}
			// A PNG's width and height are the big-endian words at 16 and 20 of its header.
			const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
			const size = png.byteLength > 24 ? [view.getUint32(16), view.getUint32(20)] as const : undefined;
			return { kind: 'scratch', ref, title, board: boardId, frame: frameId, ...(size ? { size } : {}), ...(replaces ? { replaces } : {}) };
		} catch {
			return undefined;
		}
	}

	/** The frame and its contents as a PNG data URL, drawn as the board shows them (dark boards stay dark). */
	private async picture(scene: ScratchScene, frameId: string): Promise<string | undefined> {
		const ids = withFrameContents(scene.getElements(), new Set([frameId]));
		return this.render(scene, scene.getElements().filter(el => ids.has(el.id)));
	}

	private async render(scene: ScratchScene, elements: readonly ScratchElement[]): Promise<string | undefined> {
		try {
			const canvas = this.visibleCanvas(scene);
			const dark = canvas?.isDarkBoard ?? false;
			const source = canvas ?? { scene, isDarkBoard: dark, mapColor: (c: string) => c, element: mainWindow.document.body };
			const blob = await this.exporter.renderPng(source, elements, { scale: 1, maxSide: 1600, asShown: true });
			return blob ? `data:image/png;base64,${encodeBase64(VSBuffer.wrap(new Uint8Array(await blob.arrayBuffer())))}` : undefined;
		} catch {
			return undefined;
		}
	}

	private visibleCanvas(scene: ScratchScene): ScratchCanvas | undefined {
		for (const pane of this.editorService.visibleEditorPanes) {
			if (pane instanceof ScratchBoardEditor && pane.canvas?.scene === scene) {
				return pane.canvas;
			}
		}
		return undefined;
	}

	/** Brings the drawing into view when the board is on screen (it is not selected: the user may be busy). */
	private show(boardId: string, ids: readonly string[]): void {
		for (const pane of this.editorService.visibleEditorPanes) {
			if (pane instanceof ScratchBoardEditor && pane.canvas?.model?.id === boardId) {
				pane.canvas.bringIntoView(ids);
			}
		}
	}
}

function parseNote(value: unknown): INoteInput | undefined {
	if (typeof value === 'string' && value.trim()) {
		return { text: value.slice(0, 2000) };
	}
	if (value && typeof value === 'object') {
		const v = value as { text?: unknown; color?: unknown };
		if (typeof v.text === 'string' && v.text.trim()) {
			// Agents' notes are all one grey: a `color` from an older prompt is ignored.
			return { text: v.text.slice(0, 2000) };
		}
	}
	return undefined;
}

/** A sticky note's height for its text: 20px hand lettering wraps at about 15 characters in a 220px note. */
function estimateNoteHeight(markdown: string): number {
	let lines = 0;
	for (const paragraph of markdown.replace(/[*_`#>]/g, '').split('\n')) {
		let line = 0;
		lines++;
		for (const word of paragraph.split(/\s+/).filter(Boolean)) {
			if (line && line + 1 + word.length > NOTE_LINE_CHARS) {
				lines++;
				line = word.length;
			} else {
				line += (line ? 1 : 0) + word.length;
			}
		}
	}
	return Math.max(NOTE_MIN_HEIGHT, 36 + lines * NOTE_LINE_HEIGHT);
}

function estimateCardHeight(markdown: string): number {
	const lines = markdown.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 52)), 0);
	return Math.min(1600, Math.max(120, 36 + lines * 23));
}

async function whenIdle(scene: ScratchScene): Promise<boolean> {
	const deadline = Date.now() + IDLE_WAIT_MS;
	while (scene.inTransaction) {
		const left = deadline - Date.now();
		if (left <= 0) {
			return false;
		}
		await raceTimeout(Event.toPromise(scene.onDidEndTransaction), left);
	}
	return true;
}

/** The chat's newest run on this board. */
function runOf(scene: ScratchScene, sessionId: string | undefined): IScratchAgentRun | undefined {
	return sessionId ? [...scene.runs].reverse().find(r => r.sessionId === sessionId) : undefined;
}

/** What the chat was sent: the bounds of its run on this board, if any. */
function anchorFor(scene: ScratchScene, sessionId: string | undefined): IScratchBounds | undefined {
	const run = runOf(scene, sessionId);
	if (!run) {
		return undefined;
	}
	const live = run.elementIds.map(id => scene.get(id)).filter((el): el is ScratchElement => !!el);
	return unionBounds(live.map(el => geometricBounds(el))) ?? { minX: run.bounds.x, minY: run.bounds.y, maxX: run.bounds.x + run.bounds.width, maxY: run.bounds.y + run.bounds.height };
}

/** A free spot of `width` x `height` to the right of `anchor` (or of the whole board), stepping down past what is in the way. */
function placeBeside(scene: ScratchScene, ignore: ReadonlySet<string>, anchor: IScratchBounds | undefined, width: number, height: number, ownRunId: string | undefined): readonly [number, number] {
	const others = [...scene.getElements().filter(el => !ignore.has(el.id)).map(roomOf), ...reservedSpots(scene, ownRunId)];
	const reference = anchor ?? unionBounds(others);
	if (!reference) {
		return [-width / 2, -height / 2];
	}
	const x = reference.maxX + 120;
	let y = reference.minY + FRAME_TITLE_ROOM;
	for (let i = 0; i < 60; i++) {
		const box = drawingRoom(x, y, width, height);
		const hit = others.filter(b => boundsIntersect(b, box));
		if (!hit.length) {
			break;
		}
		y = Math.max(...hit.map(b => b.maxY)) + 48 + FRAME_TITLE_ROOM;
	}
	return [x, y];
}

/**
 * Room above a frame for its name tab. The name keeps 13px on screen however far the board is
 * zoomed out, so in board units it grows: this covers it down to about a third of full size.
 */
const FRAME_TITLE_ROOM = 72;

/** What an element takes on the board: a frame's name tab above it included. */
function roomOf(el: ScratchElement): IScratchBounds {
	const b = elementBounds(el);
	return el.type === 'frame' ? { ...b, minY: b.minY - FRAME_TITLE_ROOM } : b;
}

/** The drawing's frame at `x, y` with its name tab and a margin. */
function drawingRoom(x: number, y: number, width: number, height: number): IScratchBounds {
	return { minX: x - 24, minY: y - 24 - FRAME_TITLE_ROOM, maxX: x + width + 24, maxY: y + height + 24 };
}

/** The empty spots other chats were given to draw in. */
function reservedSpots(scene: ScratchScene, ownRunId: string | undefined): IScratchBounds[] {
	return scene.runs.filter(r => r.id !== ownRunId && !r.elementIds.length && !r.hidden).map(r => ({ minX: r.bounds.x, minY: r.bounds.y, maxX: r.bounds.x + r.bounds.width, maxY: r.bounds.y + r.bounds.height }));
}

/** `x, y` if that box is free (leaving out `ignore`, what is being replaced), else the first free place below it. */
function placeAt(scene: ScratchScene, x: number, y: number, width: number, height: number, ownRunId: string | undefined, ignore: ReadonlySet<string> = new Set()): readonly [number, number] {
	const others = [...scene.getElements().filter(el => !ignore.has(el.id)).map(roomOf), ...reservedSpots(scene, ownRunId)];
	for (let i = 0; i < 60; i++) {
		const box = drawingRoom(x, y, width, height);
		const hit = others.filter(b => boundsIntersect(b, box));
		if (!hit.length) {
			break;
		}
		y = Math.max(...hit.map(b => b.maxY)) + 48 + FRAME_TITLE_ROOM;
	}
	return [x, y];
}

function kindOf(el: ScratchElement): string {
	switch (el.type) {
		case 'shape': return el.shape;
		case 'arrow': return el.startBinding || el.endBinding ? 'connector' : 'arrow';
		default: return el.type;
	}
}

function elementText(el: ScratchElement): string {
	let html = '';
	if (el.type === 'text' || el.type === 'note' || el.type === 'card') {
		html = el.html;
	} else if ((el.type === 'shape' || el.type === 'arrow' || el.type === 'line' || el.type === 'icon') && el.label) {
		html = el.label.html;
	} else if (el.type === 'frame') {
		return JSON.stringify(el.name);
	}
	const text = htmlToPlainText(html).replace(/\s+/g, ' ').trim();
	return text ? JSON.stringify(text.length > 80 ? `${text.slice(0, 79)}…` : text) : '';
}
