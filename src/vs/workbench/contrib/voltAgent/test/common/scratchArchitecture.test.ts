/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { architectureToElements, IArchitectureIcon, IArchitectureSpec, parseArchitectureSpec } from '../../common/scratchBoard/scratchArchitecture.js';
import { diagramOverlaps } from '../../common/scratchBoard/scratchDiagram.js';
import { parseElement } from '../../common/scratchBoard/scratchDocument.js';
import { geometricBounds } from '../../common/scratchBoard/scratchGeometry.js';
import { htmlToPlainText } from '../../common/scratchBoard/scratchHtml.js';
import { boundsContain } from '../../common/scratchBoard/scratchMath.js';
import { IScratchFrameElement, IScratchLinearElement, IScratchShapeElement, isLinear } from '../../common/scratchBoard/scratchTypes.js';

/** The user's reference picture: five vendors and machines, nine numbered links. */
const FACTORY = {
	direction: 'LR',
	groups: [
		{
			id: 'sources', label: 'Sources', icon: 'lucide:inbox', color: 'green', layout: 'column', row: 0, col: 0, nodes: [
				{ id: 'gh', label: 'GitHub Issues', sub: 'Next', icon: 'lucide:circle-dot', color: 'gray', dashed: true },
				{ id: 'slack', label: 'Slack', sub: 'Next', icon: 'logos:slack-icon', color: 'gray', dashed: true },
				{ id: 'linear', label: 'Linear', sub: 'Today', icon: 'logos:linear-icon', color: 'violet' },
			],
		},
		{
			id: 'neon', label: 'Neon', sub: 'Database and inbox', icon: 'logos:neon-icon', color: 'cyan', layout: 'row', row: 0, col: 1, nodes: [
				{ id: 'webhook', label: 'Webhook inbox', sub: 'Linear and GitHub', icon: 'lucide:webhook' },
				{ id: 'events', label: 'Events', sub: 'Every step, stored', icon: 'lucide:history' },
				{ id: 'live', label: 'Live updates', sub: 'Pushed instantly', icon: 'lucide:radio' },
			],
		},
		{ id: 'vercel', label: 'Vercel', icon: 'logos:vercel-icon', row: 0, col: 2, nodes: [{ id: 'panel', label: 'Panel', sub: 'The live board', icon: 'lucide:monitor', color: 'orange' }] },
		{
			id: 'mac', label: 'Your Mac', icon: 'lucide:laptop', color: 'gray', row: 1, col: 1, layout: 'row', nodes: [
				{ id: 'runner', label: 'Runner', sub: 'Claims and watches', icon: 'lucide:activity', color: 'orange' },
				{ id: 't3', label: 'T3 threads', sub: 'Claude Code + PStack, one per ticket', icon: 'logos:claude-icon', color: 'blue' },
			],
		},
		{
			id: 'github', label: 'GitHub', icon: 'logos:github-icon', color: 'purple', row: 1, col: 2, layout: 'column', nodes: [
				{ id: 'pr', label: 'Pull request', sub: 'Opened by the thread', icon: 'lucide:git-pull-request' },
				{ id: 'merge', label: 'Merge', sub: 'You or the agent', icon: 'lucide:git-merge', color: 'pink', dashed: true },
			],
		},
	],
	edges: [
		{ from: 'sources', to: 'neon', label: '1. New ticket' },
		{ from: 'neon', to: 'mac', label: '2. Claim it' },
		{ from: 'runner', to: 't3', label: '3. Start' },
		{ from: 'mac', to: 'neon', label: '4. Stage, agents, cost' },
		{ from: 'neon', to: 'vercel', label: '5. Live board' },
		{ from: 'mac', to: 'github', label: '6. Push the PR' },
		{ from: 'pr', to: 'merge' },
		{ from: 'github', to: 'neon', label: '7. Merged' },
		{ from: 'mac', to: 'sources', label: 'Unclear? It asks you on the ticket', color: 'violet', labelSide: 'bottom' },
	],
};

const ICON: IArchitectureIcon = { iconId: 'lucide:box', svg: '<svg viewBox="0 0 24 24"><path d="M2 2h20v20H2z" stroke="currentColor"/></svg>', tintable: true };

function spec(value: unknown): IArchitectureSpec {
	const parsed = parseArchitectureSpec(value);
	assert.ok(!('error' in parsed), 'error' in parsed ? parsed.error : '');
	return parsed.spec;
}

suite('Scratch architecture diagrams', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses ends by label, counts rows from 1 as from 0, and drops edges to nothing', () => {
		const parsed = parseArchitectureSpec(JSON.stringify({
			groups: [{ label: 'API', row: 1, col: 1, nodes: ['Gateway', { label: 'Auth', color: 'red' }] }, { label: 'Data', row: 1, col: 2, nodes: [{ label: 'Postgres' }] }],
			edges: [{ from: 'gateway', to: 'Postgres', label: 'SQL' }, { from: 'Gateway', to: 'nowhere' }],
		}));
		assert.ok(!('error' in parsed));
		assert.deepStrictEqual(parsed.spec.groups.map(g => [g.id, g.cell?.row, g.cell?.col]), [['api', 0, 0], ['data', 0, 1]]);
		assert.strictEqual(parsed.spec.groups[0].nodes[1].color, '#e03131');
		assert.deepStrictEqual(parsed.spec.edges.map(e => [e.from, e.to]), [['gateway', 'postgres']]);
		assert.ok(parsed.warnings.some(w => w.includes('nowhere')));
		assert.ok('error' in parseArchitectureSpec({ edges: [] }));
		assert.ok('error' in parseArchitectureSpec('{not json'));
	});

	test('draws groups as containers holding their cards, with icons and nothing overlapping', () => {
		const elements = architectureToElements(spec(FACTORY), [0, 0], { icon: () => ICON });
		const frames = elements.filter((el): el is IScratchFrameElement => el.type === 'frame');
		const cards = elements.filter((el): el is IScratchShapeElement => el.type === 'shape');
		const lines = elements.filter(isLinear);
		assert.deepStrictEqual(frames.map(f => f.name), ['Sources', 'Neon', 'Vercel', 'Your Mac', 'GitHub']);
		assert.strictEqual(frames[1].header?.subtitle, 'Database and inbox');
		assert.strictEqual(cards.length, 11);
		assert.strictEqual(lines.length, 9);
		for (const card of cards) {
			assert.ok(card.icon, `${card.id} has an icon`);
			const frame = frames.find(f => f.id === card.frameId)!;
			assert.ok(boundsContain(geometricBounds(frame), geometricBounds(card)), `${htmlToPlainText(card.label!.html)} sits inside ${frame.name}`);
		}
		// Row cards put the icon above the title, stacked ones before it.
		assert.strictEqual(cards.find(c => c.label?.html.includes('Webhook'))!.icon!.placement, 'top');
		assert.strictEqual(cards.find(c => c.label?.html.includes('Slack'))!.icon!.placement, 'left');
		assert.deepStrictEqual(diagramOverlaps(elements, htmlToPlainText), []);
	});

	test('a link between groups off each other\'s corners takes the way round that keeps off the other lines and labels', () => {
		const elements = architectureToElements(spec(FACTORY), [0, 0]);
		const neon = elements.find(el => el.type === 'frame' && el.name === 'Neon')!;
		const merged = elements.find((el): el is IScratchLinearElement => isLinear(el) && !!el.label?.html.includes('7. Merged'))!;
		assert.strictEqual(merged.endBinding?.elementId, neon.id);
		// Into Neon's right side: its bottom already takes "2. Claim it" and "4. Stage, agents, cost".
		assert.strictEqual(merged.endBinding?.anchor?.[0], 1);
	});

	test('cards and container headers survive a save and load', () => {
		const elements = architectureToElements(spec(FACTORY), [0, 0], { icon: () => ICON });
		const frame = elements.find(el => el.type === 'frame')!;
		const card = elements.find(el => el.type === 'shape')!;
		assert.deepStrictEqual(parseElement(JSON.parse(JSON.stringify(frame))), frame);
		assert.deepStrictEqual(parseElement(JSON.parse(JSON.stringify(card))), card);
	});
});
