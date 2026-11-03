/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { legsOf, routeCrossings, routeOverlap } from '../../common/scratchBoard/scratchBinding.js';
import { describeComments, describeForAgent } from '../../common/scratchBoard/scratchDescribe.js';
import { diagramOverlaps, elementsToMermaid, mermaidToElements } from '../../common/scratchBoard/scratchDiagram.js';
import { createLabel, createNote, createShape, createText } from '../../common/scratchBoard/scratchFactory.js';
import {
	decodeEntities, escapeHtml, htmlToMarkdown, htmlToPlainText, isEmptyRichText, looksLikeMarkdown, parseHtmlFragment,
	plainTextToHtml, richTextExcerpt,
} from '../../common/scratchBoard/scratchHtml.js';
import { layeredLayout, layeredLayoutWithRoutes } from '../../common/scratchBoard/scratchLayout.js';
import { extractMermaidSource, graphToMermaid, parseMermaidFlowchart } from '../../common/scratchBoard/scratchMermaid.js';
import type { IScratchLinearElement, IScratchShapeElement } from '../../common/scratchBoard/scratchTypes.js';

suite('Scratch board text', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('html parsing', () => {
		test('builds a tree, closes open paragraphs and list items, never throws', () => {
			const nodes = parseHtmlFragment('<p>one<p>two<ul><li>a<li>b</ul><br/>tail <b>x');
			assert.deepStrictEqual(nodes.map(n => n.tag), ['p', 'p', 'ul', 'br', undefined, 'b']);
			assert.strictEqual(nodes[2].children.filter(c => c.tag === 'li').length, 2);
			assert.doesNotThrow(() => parseHtmlFragment('<<<>>> </div></p> <a href="x>y</a> <!-- c'));
		});

		test('decodes entities and escapes', () => {
			assert.strictEqual(decodeEntities('&amp; &lt;b&gt; &quot;q&quot; &#39;s&#x27; &nbsp;&#128512; &bogus;'), '& <b> "q" \'s\'  \u{1F600} &bogus;');
			assert.strictEqual(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
		});
	});

	suite('htmlToMarkdown', () => {
		test('inline marks, links and entities', () => {
			assert.strictEqual(
				htmlToMarkdown('<p><strong>Bold</strong>, <em>it</em>, <s>gone</s>, <u>under</u>, <code>a`b</code> and <a href="https://x.dev">link</a> &amp; more</p>'),
				'**Bold**, *it*, ~~gone~~, under, ``a`b`` and [link](https://x.dev) & more',
			);
			assert.strictEqual(htmlToMarkdown('<p><b> spaced </b>word</p>'), '**spaced** word');
			assert.strictEqual(htmlToMarkdown('<p>a\n   b<br>c</p><p></p><p>d</p>'), 'a b\nc\n\nd');
		});

		test('nested lists, numbering and checklists', () => {
			const md = htmlToMarkdown('<ul><li>one<ul><li>inner</li></ul></li><li>two</li></ul><ol start="3"><li>three</li><li>four</li></ol>'
				+ '<ul><li data-checked="true">done</li><li data-checked="false">todo</li></ul>');
			assert.strictEqual(md, '- one\n  - inner\n- two\n\n3. three\n4. four\n\n- [x] done\n- [ ] todo');
		});

		test('code blocks keep their text and language', () => {
			assert.strictEqual(
				htmlToMarkdown('<pre><code class="language-ts">const a = 1;\n  if (a &lt; 2) {}\n</code></pre>'),
				'```ts\nconst a = 1;\n  if (a < 2) {}\n```',
			);
		});

		test('tables pad cells and escape pipes', () => {
			assert.strictEqual(
				htmlToMarkdown('<table><thead><tr><th>Name</th><th>Note</th></tr></thead><tbody><tr><td>a|b</td><td><b>x</b></td></tr><tr><td>c</td></tr></tbody></table>'),
				'| Name | Note  |\n| ---- | ----- |\n| a\\|b | **x** |\n| c    |       |',
			);
		});

		test('headings, quotes and rules', () => {
			assert.strictEqual(htmlToMarkdown('<h2>Title</h2><blockquote><p>q1</p><p>q2</p></blockquote><hr>'), '## Title\n\n> q1\n>\n> q2\n\n---');
		});
	});

	suite('plain text', () => {
		test('blocks, bullets, tables', () => {
			assert.strictEqual(
				htmlToPlainText('<h1>T</h1><p>a <b>b</b></p><ul><li>x</li><li data-checked="true">y</li></ul><table><tr><td>1</td><td>2</td></tr></table>'),
				'T\na b\n• x\n[x] y\n1\t2',
			);
		});

		test('plainTextToHtml, empty and excerpts', () => {
			assert.strictEqual(plainTextToHtml('a<b\n\nc'), '<p>a&lt;b</p><p><br></p><p>c</p>');
			assert.strictEqual(isEmptyRichText('<p><br></p><p>&nbsp;</p>'), true);
			assert.strictEqual(isEmptyRichText('<p>x</p>'), false);
			assert.strictEqual(isEmptyRichText('<hr>'), false);
			assert.strictEqual(richTextExcerpt('<p>Hello</p><p>wide world</p>', 9), 'Hello wi…');
			assert.strictEqual(richTextExcerpt('<p>Hi</p>', 9), 'Hi');
		});
	});

	suite('looksLikeMarkdown', () => {
		test('plain text stays plain', () => {
			assert.strictEqual(looksLikeMarkdown('Just a normal sentence, nothing more.'), false);
			assert.strictEqual(looksLikeMarkdown('https://example.com/some/path?x=1'), false);
			assert.strictEqual(looksLikeMarkdown('const x = a * b;\nreturn x;'), false);
			assert.strictEqual(looksLikeMarkdown('# Only a heading'), false);
		});

		test('markdown is recognised', () => {
			assert.strictEqual(looksLikeMarkdown('| a | b |\n|---|---|\n| 1 | 2 |'), true);
			assert.strictEqual(looksLikeMarkdown('# Plan\n\nShip the canvas.'), true);
			assert.strictEqual(looksLikeMarkdown('- first\n- second'), true);
			assert.strictEqual(looksLikeMarkdown('**bold** and [link](https://x.dev)'), true);
			assert.strictEqual(looksLikeMarkdown('Run this:\n```sh\nnpm test\n```'), true);
		});
	});

	suite('mermaid', () => {
		const source = [
			'```mermaid',
			'flowchart LR',
			'  %% the login path',
			'  A[Client] -->|HTTPS| B(API gateway)',
			'  B --> C{Auth?} -- yes --> D[(Users DB)]',
			'  C -.->|no| E([Reject])',
			'  B & C ==> F{{Cache}}',
			'  subgraph back [Back end]',
			'    D',
			'    G[/Queue/] --- H[[Worker]]',
			'  end',
			'  H <--> D; I>Flag]',
			'  classDef hot fill:#f00',
			'  style A stroke:#333',
			'  J@{ shape: doc, label: "Spec<br>v2" }',
			'```',
		].join('\n');

		test('extracts the fenced source', () => {
			assert.ok(extractMermaidSource(source)?.startsWith('flowchart LR'));
			assert.ok(extractMermaidSource('graph TD\nA-->B'));
			assert.strictEqual(extractMermaidSource('sequenceDiagram\nA->>B: hi'), undefined);
		});

		test('parses shapes, chains, labels and subgraphs', () => {
			const graph = parseMermaidFlowchart(extractMermaidSource(source)!)!;
			assert.strictEqual(graph.direction, 'LR');
			const shapes = Object.fromEntries(graph.nodes.map(n => [n.id, `${n.shape}:${n.label}`]));
			assert.deepStrictEqual(shapes, {
				A: 'rectangle:Client', B: 'rounded:API gateway', C: 'diamond:Auth?', D: 'cylinder:Users DB', E: 'stadium:Reject',
				F: 'hexagon:Cache', G: 'parallelogram:Queue', H: 'subroutine:Worker', I: 'parallelogram:Flag', J: 'document:Spec\nv2',
			});
			const edges = graph.edges.map(e => `${e.from}${e.startHead ? '<' : ''}-${e.style}${e.endHead ? '>' : ''}${e.to}${e.label ? `:${e.label}` : ''}`);
			assert.deepStrictEqual(edges, [
				'A-solid>B:HTTPS', 'B-solid>C', 'C-solid>D:yes', 'C-dotted>E:no', 'B-thick>F', 'C-thick>F', 'G-solidH', 'H<-solid>D',
			]);
			assert.deepStrictEqual(graph.subgraphs, [{ id: 'back', label: 'Back end', nodeIds: ['D', 'G', 'H'] }]);
		});

		test('prints text that parses back to the same graph', () => {
			const graph = parseMermaidFlowchart(extractMermaidSource(source)!)!;
			const again = parseMermaidFlowchart(graphToMermaid(graph))!;
			assert.deepStrictEqual(again, graph);
		});

		test('colours from classDef, class, ::: and style; they print back and reach the board', () => {
			const coloured = parseMermaidFlowchart([
				'flowchart LR',
				'  classDef core fill:#A5D8FF,stroke:#1971c2,stroke-width:2px',
				'  classDef data fill:#b2f2bb',
				'  classDef bad fill:red,stroke:rgb(1,2,3)',
				'  A[API]:::core --> B[(Postgres)]',
				'  C[Worker] --> B',
				'  class B data',
				'  class C bad',
				'  style C stroke:#e03131',
				'  subgraph back [Back end]',
				'    B',
				'  end',
				'  style back fill:#f8f9fa',
			].join('\n'))!;
			const colours = Object.fromEntries(coloured.nodes.map(n => [n.id, { fill: n.fill, stroke: n.stroke }]));
			assert.deepStrictEqual(colours, {
				A: { fill: '#a5d8ff', stroke: '#1971c2' },
				B: { fill: '#b2f2bb', stroke: undefined },
				// Named and rgb() colours are not taken; its own style still is.
				C: { fill: undefined, stroke: '#e03131' },
			});
			assert.strictEqual(coloured.subgraphs[0].fill, '#f8f9fa');
			assert.deepStrictEqual(parseMermaidFlowchart(graphToMermaid(coloured)), coloured);

			const elements = mermaidToElements(coloured, [0, 0]);
			const api = elements.find((e): e is IScratchShapeElement => e.type === 'shape' && e.shape === 'rectangle' && e.stroke === '#1971c2')!;
			assert.strictEqual(api.fill, '#a5d8ff');
			assert.strictEqual(api.fillStyle, 'solid');
			assert.strictEqual(elements.find(e => e.type === 'frame')!.fill, '#f8f9fa');
			const back = elementsToMermaid(elements, html => html.replace(/<[^>]+>/g, ''))!;
			assert.ok(back.includes('fill:#a5d8ff,stroke:#1971c2'), back);
		});

		test('line variants from linkStyle and dashed outlines from classDef; they print back and reach the board', () => {
			const source = [
				'flowchart LR',
				'  classDef planned stroke-dasharray: 6 4',
				'  A[API] --> B[(DB)]',
				'  A -.->|events| Q[/Queue/]',
				'  A --> C[Cache]:::planned',
				'  Q --> M[Mailer]',
				'  linkStyle 2 stroke:#2F9E44,stroke-dasharray:6 4',
				'  linkStyle 3 interpolate basis stroke:#e03131,stroke-width:3px',
				'  linkStyle 1 stroke-dasharray: 2 4',
			].join('\n');
			const graph = parseMermaidFlowchart(source)!;
			assert.deepStrictEqual(graph.edges.map(e => [e.style, e.strokeStyle, e.stroke, e.strokeWidth, e.curve]), [
				['solid', undefined, undefined, undefined, undefined],
				['dotted', 'dotted', undefined, undefined, undefined],
				['solid', 'dashed', '#2f9e44', undefined, undefined],
				['solid', undefined, '#e03131', 3, 'round'],
			]);
			assert.strictEqual(graph.nodes.find(n => n.id === 'C')!.strokeStyle, 'dashed');
			assert.strictEqual(graph.curve, undefined);
			assert.deepStrictEqual(parseMermaidFlowchart(graphToMermaid(graph)), graph);

			const elements = mermaidToElements(graph, [0, 0]);
			const arrows = elements.filter((e): e is IScratchLinearElement => e.type === 'arrow');
			assert.deepStrictEqual(arrows.map(a => [a.strokeStyle, a.arrowType]), [['solid', 'elbow'], ['dotted', 'elbow'], ['dashed', 'elbow'], ['solid', 'round']]);
			assert.strictEqual(arrows[2].stroke, '#2f9e44');
			assert.strictEqual(arrows[3].strokeWidth, 3);
			assert.strictEqual(elements.find((e): e is IScratchShapeElement => e.type === 'shape' && !!e.label?.html.includes('Cache'))!.strokeStyle, 'dashed');
			// Read back off the board: dots stay `-.->`, dashes and the colour come back as linkStyle.
			const back = parseMermaidFlowchart(elementsToMermaid(elements, htmlToPlainText)!)!;
			assert.deepStrictEqual(back.edges.map(e => [e.style, e.strokeStyle ?? '', e.stroke ?? '']).sort(), [
				['dotted', '', ''], ['dotted', 'dashed', '#2f9e44'], ['solid', '', ''], ['solid', '', '#e03131'],
			].sort());
		});

		test('the whole diagram curves from linkStyle default, an init directive or front matter', () => {
			assert.strictEqual(parseMermaidFlowchart('flowchart TD\n  A --> B\n  linkStyle default interpolate basis')!.curve, 'round');
			assert.strictEqual(parseMermaidFlowchart('%%{init: {"flowchart": {"curve": "linear"}}}%%\nflowchart TD\n  A --> B')!.curve, 'straight');
			assert.strictEqual(parseMermaidFlowchart('---\nconfig:\n  flowchart:\n    curve: stepAfter\n---\nflowchart TD\n  A --> B')!.curve, 'elbow');
			const curved = mermaidToElements(parseMermaidFlowchart('flowchart TD\n  A --> B --> C\n  linkStyle default interpolate basis')!, [0, 0]);
			assert.ok(curved.filter((e): e is IScratchLinearElement => e.type === 'arrow').every(a => a.arrowType === 'round'));
		});

		test('other diagrams are not flowcharts', () => {
			assert.strictEqual(parseMermaidFlowchart('sequenceDiagram\nA->>B: hi'), undefined);
			assert.deepStrictEqual(parseMermaidFlowchart('graph TD; A-->B')?.edges.map(e => `${e.from}${e.to}`), ['AB']);
		});
	});

	suite('layout', () => {
		const nodes = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, width: 120, height: 60 }));
		const edges = [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }, { from: 'e', to: 'e' }];

		function overlaps(pos: Map<string, readonly [number, number]>): boolean {
			const boxes = nodes.map(n => ({ x: pos.get(n.id)![0], y: pos.get(n.id)![1], w: n.width, h: n.height }));
			for (let i = 0; i < boxes.length; i++) {
				for (let j = i + 1; j < boxes.length; j++) {
					const a = boxes[i], b = boxes[j];
					if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
						return true;
					}
				}
			}
			return false;
		}

		test('ranks follow edges top to bottom and left to right', () => {
			const tb = layeredLayout(nodes, edges, 'TB');
			for (const e of edges.filter(e => e.from !== e.to)) {
				assert.ok(tb.get(e.to)![1] > tb.get(e.from)![1], `${e.from}->${e.to} goes down`);
			}
			assert.strictEqual(overlaps(tb), false);
			const lr = layeredLayout(nodes, edges, 'LR');
			for (const e of edges.filter(e => e.from !== e.to)) {
				assert.ok(lr.get(e.to)![0] > lr.get(e.from)![0], `${e.from}->${e.to} goes right`);
			}
			assert.strictEqual(overlaps(lr), false);
			const bt = layeredLayout(nodes, edges, 'BT');
			assert.ok(bt.get('d')![1] < bt.get('a')![1]);
		});

		test('cycles finish and stay apart', () => {
			const cyclic = layeredLayout(nodes, [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }, { from: 'd', to: 'e' }, { from: 'e', to: 'd' }], 'TB');
			assert.strictEqual(cyclic.size, 5);
			assert.strictEqual(overlaps(cyclic), false);
		});

		test('is deterministic', () => {
			assert.deepStrictEqual([...layeredLayout(nodes, edges, 'LR')], [...layeredLayout(nodes, edges, 'LR')]);
		});

		test('an edge that skips ranks bends around the nodes it passes', () => {
			// a -> b -> c with a shortcut a -> c: the shortcut gets a waypoint on b's rank, beside b.
			const three = [{ id: 'a', width: 100, height: 40 }, { id: 'b', width: 100, height: 40 }, { id: 'c', width: 100, height: 40 }];
			const { positions, routes } = layeredLayoutWithRoutes(three, [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'c' }], 'TB');
			const route = routes.get('a>c')!;
			assert.strictEqual(route.length, 1);
			const b = positions.get('b')!;
			assert.ok(route[0][0] < b[0] || route[0][0] > b[0] + 100, 'the waypoint is beside b, not on it');
			assert.ok(!routes.has('a>b') && !routes.has('b>c'));
		});
	});

	suite('diagram elements', () => {
		const graph = parseMermaidFlowchart([
			'flowchart TB',
			'  A[Client] --> B(API)',
			'  B -.->|reads| C[(DB)]',
			'  subgraph data [Data]',
			'    C',
			'  end',
		].join('\n'))!;

		test('a booking lifecycle draws without lines through shapes or labels on them', () => {
			// The hotel flow a user drew by hand: PENDING's shortcuts to Cancelled and CHECKED IN cut through CONFIRMED.
			const flow = parseMermaidFlowchart([
				'flowchart TD',
				'  R([Reserved]) --> P{{3a. PENDING<br/>room held, not paid}}',
				'  P -->|pay deposit<br/>or press Confirm| C{{3b. CONFIRMED<br/>booking secured}}',
				'  P -->|hold expires| X([Cancelled])',
				'  P --> I[4. CHECKED IN<br/>guest stays]',
				'  C -->|guest cancels| X',
				'  C -->|no arrival| N([No-show])',
				'  C --> I',
				'  W([Walk-in]) --> I',
				'  I --> O([5. CHECKED OUT<br/>bill settled])',
			].join('\n'))!;
			const elements = mermaidToElements(flow, [0, 0]);
			assert.deepStrictEqual(diagramOverlaps(elements, html => html.replace(/<\/p><p>/g, '\n').replace(/<[^>]+>/g, '')), []);
			// Right angles only, and no two lines run on top of each other.
			const arrows = elements.filter((e): e is IScratchLinearElement => e.type === 'arrow');
			assert.ok(arrows.every(a => a.arrowType === 'elbow' && a.points.every((p, i) => i === 0 || p[0] === a.points[i - 1][0] || p[1] === a.points[i - 1][1])));
			const segments = arrows.flatMap(a => a.points.slice(1).map((p, i) => ({ id: a.id, from: [a.x + a.points[i][0], a.y + a.points[i][1]], to: [a.x + p[0], a.y + p[1]] })));
			for (const s of segments) {
				for (const t of segments) {
					// Parallel and closer than a track (12px) reads as one line.
					for (const axis of [0, 1]) {
						const along = 1 - axis;
						const parallel = s.from[axis] === s.to[axis] && t.from[axis] === t.to[axis] && Math.abs(s.from[axis] - t.from[axis]) < 11.5;
						const overlap = Math.min(Math.max(s.from[along], s.to[along]), Math.max(t.from[along], t.to[along])) - Math.max(Math.min(s.from[along], s.to[along]), Math.min(t.from[along], t.to[along]));
						assert.ok(s.id === t.id || !parallel || overlap <= 1, 'two lines run on top of each other');
					}
				}
			}
			// Ends that face each other a little out of line are lined up: no kinks of a few pixels.
			for (const a of arrows) {
				for (let i = 2; i < a.points.length; i++) {
					const step = Math.hypot(a.points[i - 1][0] - a.points[i - 2][0], a.points[i - 1][1] - a.points[i - 2][1]);
					assert.ok(i === 2 || i === a.points.length - 1 || step >= 8, `a ${step}px kink`);
				}
			}
		});

		test('lines are untangled against each other: the revised booking flow crosses once at most', () => {
			// An agent's redraw of the flow: routed one after another, three of its lines crossed.
			const flow = parseMermaidFlowchart([
				'flowchart TB',
				'  n1(["Reserved"]) --> n2{{"3a. PENDING<br>room held, not paid"}}',
				'  n2 -.->|"hold expires"| n3{"Payment received<br>or in progress?"}',
				'  n2 -->|"pay deposit<br>or press Confirm"| n4{{"3b. CONFIRMED<br>booking secured"}}',
				'  n2 --> n8["4. CHECKED IN<br>guest stays"]',
				'  n3 -.->|"no"| n6(["Cancelled"])',
				'  n3 -->|"yes"| n4',
				'  n4 -->|"guest cancels"| n6',
				'  n4 -.->|"no arrival"| n7(["No-show"])',
				'  n4 --> n8',
				'  n5(["Walk-in"]) --> n8',
				'  n8 --> n9(["5. CHECKED OUT<br>bill settled"])',
			].join('\n'))!;
			const elements = mermaidToElements(flow, [0, 0]);
			assert.deepStrictEqual(diagramOverlaps(elements, html => html.replace(/<\/p><p>/g, '\n').replace(/<[^>]+>/g, '')), []);
			const routes = elements.filter((e): e is IScratchLinearElement => e.type === 'arrow').map(a => ({ id: a.id, world: a.points.map((p): [number, number] => [a.x + p[0], a.y + p[1]]) }));
			let crossings = 0, overlap = 0;
			for (const [i, r] of routes.entries()) {
				for (const q of routes.slice(i + 1)) {
					crossings += routeCrossings(r.world, legsOf(q.id, q.world));
					overlap += routeOverlap(r.world, legsOf(q.id, q.world));
				}
			}
			assert.ok(crossings <= 1, `${crossings} crossings`);
			assert.strictEqual(overlap, 0);
		});

		test('diagramOverlaps names a line through a shape and a label on one', () => {
			const a = createShape({ shape: 'rectangle', x: 0, y: 0, width: 100, height: 50, label: createLabel('<p>A</p>') });
			const b = createShape({ shape: 'rectangle', x: 0, y: 100, width: 100, height: 50, label: createLabel('<p>B</p>') });
			const c = createShape({ shape: 'rectangle', x: 0, y: 200, width: 100, height: 50, label: createLabel('<p>C</p>') });
			const straight = mermaidToElements(parseMermaidFlowchart('flowchart TD\n  A --> B')!, [0, 0]).find(e => e.type === 'arrow') as IScratchLinearElement;
			const through: IScratchLinearElement = { ...straight, x: 50, y: 25, points: [[0, 0], [0, 200]], startBinding: { elementId: a.id, anchor: null }, endBinding: { elementId: c.id, anchor: null }, label: createLabel('<p>skips</p>') };
			const found = diagramOverlaps([a, b, c, through], html => html.replace(/<[^>]+>/g, ''));
			assert.ok(found.some(f => f.includes('runs through "B"')), found.join('; '));
			assert.ok(found.some(f => f.includes('"skips"') && f.includes('sits on "B"')), found.join('; '));
		});

		test('mermaidToElements binds arrows and puts frames first', () => {
			const elements = mermaidToElements(graph, [100, 100]);
			const ids = new Set(elements.map(e => e.id));
			const arrows = elements.filter((e): e is IScratchLinearElement => e.type === 'arrow');
			assert.strictEqual(arrows.length, 2);
			for (const arrow of arrows) {
				assert.ok(ids.has(arrow.startBinding!.elementId));
				assert.ok(ids.has(arrow.endBinding!.elementId));
			}
			// `-.->` is a row of dots, and every connector a right-angled elbow.
			assert.strictEqual(arrows[1].strokeStyle, 'dotted');
			assert.ok(arrows.every(a => a.arrowType === 'elbow'));
			assert.strictEqual(elements[0].type, 'frame');
			const db = elements.find((e): e is IScratchShapeElement => e.type === 'shape' && e.shape === 'cylinder')!;
			assert.strictEqual(db.frameId, elements[0].id);
			assert.ok(elements.filter(e => e.type === 'shape').every(s => s.x >= 100 && s.y >= 100));
		});

		test('subgraphs become swimlanes that never overlap, steps kept in order', () => {
			const flow = parseMermaidFlowchart([
				'flowchart TD',
				'  subgraph User', '    U1[Click sign in]', '    U2[Log in]', '  end',
				'  subgraph App', '    A1[Create PKCE pair]', '    A2[Send code]', '  end',
				'  subgraph Auth', '    S1[Show login]', '    S2[Issue tokens]', '  end',
				'  U1 --> A1 --> S1 --> U2 --> A2 --> S2',
			].join('\n'))!;
			const elements = mermaidToElements(flow, [0, 0]);
			const frames = elements.filter(e => e.type === 'frame');
			assert.strictEqual(frames.length, 3);
			for (let i = 0; i < frames.length; i++) {
				for (let j = i + 1; j < frames.length; j++) {
					const a = frames[i], b = frames[j];
					const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
					assert.ok(!overlap, `${i} and ${j} overlap`);
				}
				// Every lane runs the whole length of the flow.
				assert.strictEqual(frames[i].y, frames[0].y);
				assert.strictEqual(frames[i].height, frames[0].height);
			}
			const shapes = elements.filter((e): e is IScratchShapeElement => e.type === 'shape');
			for (const shape of shapes) {
				const frame = frames.find(f => f.id === shape.frameId)!;
				assert.ok(shape.x >= frame.x && shape.x + shape.width <= frame.x + frame.width, 'inside its lane');
			}
			const yOf = (text: string) => shapes.find(s => s.label?.html.includes(text))!.y;
			assert.ok(yOf('Click sign in') < yOf('Create PKCE') && yOf('Create PKCE') < yOf('Show login') && yOf('Show login') < yOf('Log in'));
			assert.ok(elements.filter((e): e is IScratchLinearElement => e.type === 'arrow').every(a => a.arrowType === 'elbow'));
		});

		test('elementsToMermaid names every label', () => {
			const elements = mermaidToElements(graph, [0, 0]);
			const text = elementsToMermaid(elements, htmlToPlainText)!;
			for (const label of ['Client', 'API', 'DB', 'reads', 'Data']) {
				assert.ok(text.includes(label), `${label} in\n${text}`);
			}
			const back = parseMermaidFlowchart(text)!;
			assert.strictEqual(back.edges.length, 2);
			assert.strictEqual(back.edges.filter(e => e.style === 'dotted').length, 1);
			assert.strictEqual(elementsToMermaid([createShape({ x: 0, y: 0, width: 10, height: 10, shape: 'rectangle' })], htmlToPlainText), undefined);
		});
	});

	suite('describeForAgent', () => {
		test('text, diagram and frames in reading order', () => {
			const graph = parseMermaidFlowchart('flowchart LR\n  A[Web] --> B[(Store)]')!;
			const diagram = mermaidToElements(graph, [0, 400]);
			const note = createNote({ x: 300, y: 0, html: '<p>Remember <b>caching</b></p>' });
			const text = createText({ x: 0, y: 0, html: '<h1>Plan</h1><ul><li>ship</li></ul>' });
			const lonely = createShape({ x: 600, y: 0, width: 100, height: 60, shape: 'ellipse', label: createLabel('<p>Idea</p>') });
			const out = describeForAgent([note, ...diagram, text, lonely], { boardTitle: 'Arch', renderName: 'scratch-selection.png', whole: false });
			assert.ok(out.startsWith('Scratch board “Arch”: a selection, 6 elements.'));
			assert.ok(out.includes('Attached: scratch-selection.png is a render of the selection.'));
			const textAt = out.indexOf('## Text');
			assert.ok(textAt > 0);
			// The heading text (left) reads before the note (right) in the same row.
			assert.ok(out.indexOf('# Plan') < out.indexOf('Sticky note: Remember **caching**'));
			assert.ok(out.includes('```mermaid\nflowchart'));
			assert.ok(out.includes('n1') && out.includes('Store'));
			assert.ok(out.indexOf('## Diagram') > textAt);
		});

		test('shapes without connectors are listed, empty sections skipped', () => {
			const out = describeForAgent([
				createShape({ x: 0, y: 0, width: 100, height: 60, shape: 'rectangle', label: createLabel('<p>API gateway</p>') }),
				createShape({ x: 200, y: 0, width: 100, height: 60, shape: 'ellipse' }),
				createShape({ x: 400, y: 0, width: 100, height: 60, shape: 'ellipse' }),
			], { boardTitle: '', whole: true });
			assert.ok(out.includes('## Shapes\n\n- Rectangle “API gateway”\n- 2 unlabelled shapes: ellipse ×2'));
			assert.ok(!out.includes('## Text'));
			assert.ok(!out.includes('Attached'));
			assert.ok(out.includes('the whole board, 3 elements'));
		});

		test('comments name what they are on, in pin order', () => {
			const queue = createShape({ x: 0, y: 0, width: 100, height: 60, shape: 'pill', label: createLabel('<p>Queue</p>') });
			const blank = createShape({ x: 200, y: 0, width: 100, height: 60, shape: 'rectangle' });
			const note = createNote({ x: 400, y: 0, html: '<p>Ship it</p>' });
			const out = describeComments([
				{ text: 'Make it red', elements: [queue] },
				{ text: 'Add a cache here', elements: [] },
				{ text: 'Group these\nplease', elements: [blank, note] },
			]);
			assert.strictEqual(out, [
				'1. On “Queue” (pill): Make it red',
				'2. On a spot on the board: Add a cache here',
				'3. On 2 elements: an unlabelled rectangle, “Ship it” (sticky note): Group these / please',
			].join('\n'));
		});
	});
});
