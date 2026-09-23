/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../../base/browser/dom.js';

interface MermaidNode {
	id: string;
	label: string;
	shape: 'rect' | 'round' | 'diamond' | 'circle';
}

interface MermaidEdge {
	from: string;
	to: string;
	label?: string;
}

const NODE_ID = /[A-Za-z][\w-]*/;

export function renderMermaidDiagram(parent: HTMLElement, source: string): void {
	const wrap = append(parent, $('.volt-agent-block.mermaid.volt-agent-mermaid'));
	const doc = parent.ownerDocument;
	const svg = renderFlowchart(doc, source) ?? renderPie(doc, source) ?? renderSequence(doc, source);
	if (svg) {
		wrap.appendChild(svg);
		return;
	}
	const lang = append(wrap, $('span.volt-agent-code-lang.volt-agent-searchable'));
	lang.textContent = 'mermaid';
	const pre = append(wrap, $('pre.volt-agent-searchable'));
	pre.textContent = source.trim();
}

function renderFlowchart(doc: Document, source: string): SVGSVGElement | undefined {
	const lines = stripMermaid(source);
	const header = /^(?:graph|flowchart)\s+(TD|TB|BT|LR|RL)\b/i.exec(lines[0] ?? '');
	if (!header) {
		return undefined;
	}
	const direction = header[1].toUpperCase() === 'TB' ? 'TD' : header[1].toUpperCase();
	const nodes = new Map<string, MermaidNode>();
	const edges: MermaidEdge[] = [];
	const ensure = (id: string, label?: string, shape?: MermaidNode['shape']) => {
		const current = nodes.get(id);
		if (!current) {
			nodes.set(id, { id, label: label ?? id, shape: shape ?? 'rect' });
			return;
		}
		if (label) {
			current.label = label;
		}
		if (shape) {
			current.shape = shape;
		}
	};

	for (const raw of lines.slice(1)) {
		const line = raw.replace(/%%.*$/, '').trim();
		if (!line || /^(classDef|class|click|style|subgraph|end)\b/i.test(line)) {
			continue;
		}
		const edge = parseEdge(line);
		if (edge) {
			ensure(edge.from.id, edge.from.label, edge.from.shape);
			ensure(edge.to.id, edge.to.label, edge.to.shape);
			edges.push({ from: edge.from.id, to: edge.to.id, label: edge.label });
			continue;
		}
		const node = parseNodeToken(line);
		if (node) {
			ensure(node.id, node.label, node.shape);
		}
	}
	if (!nodes.size) {
		return undefined;
	}
	return layoutFlow(doc, nodes, edges, direction.startsWith('L') || direction === 'RL' ? 'LR' : 'TD');
}

function parseEdge(line: string): { from: ReturnType<typeof parseNodeToken>; to: ReturnType<typeof parseNodeToken>; label?: string } | undefined {
	const labeled = /^(.+?)\s*(?:-->|---)\s*\|\s*([^|]+)\s*\|\s*(.+)$/.exec(line)
		?? /^(.+?)\s*--\s+([^-]+?)\s+-->\s*(.+)$/.exec(line);
	if (labeled) {
		const from = parseNodeToken(labeled[1].trim());
		const to = parseNodeToken(labeled[3].trim());
		return from && to ? { from, to, label: labeled[2].trim() } : undefined;
	}
	const plain = /^(.+?)\s*(?:-->|---|-.->|==>)\s*(.+)$/.exec(line);
	if (!plain) {
		return undefined;
	}
	const from = parseNodeToken(plain[1].trim());
	const to = parseNodeToken(plain[2].trim());
	return from && to ? { from, to } : undefined;
}

function parseNodeToken(token: string): { id: string; label?: string; shape?: MermaidNode['shape'] } | undefined {
	const diamond = /^([A-Za-z][\w-]*)\{+([^{}]+)\}+$/.exec(token);
	if (diamond) {
		return { id: diamond[1], label: diamond[2].trim(), shape: 'diamond' };
	}
	const circle = /^([A-Za-z][\w-]*)\(\(+([^()]+)\)+\)$/.exec(token);
	if (circle) {
		return { id: circle[1], label: circle[2].trim(), shape: 'circle' };
	}
	const round = /^([A-Za-z][\w-]*)\(+([^()]+)\)+$/.exec(token);
	if (round) {
		return { id: round[1], label: round[2].trim(), shape: 'round' };
	}
	const rect = /^([A-Za-z][\w-]*)\[+([^[\]]+)\]+$/.exec(token);
	if (rect) {
		return { id: rect[1], label: rect[2].trim(), shape: 'rect' };
	}
	const id = NODE_ID.exec(token)?.[0];
	return id ? { id } : undefined;
}

function layoutFlow(doc: Document, nodes: Map<string, MermaidNode>, edges: readonly MermaidEdge[], axis: 'TD' | 'LR'): SVGSVGElement | undefined {
	const incoming = new Map<string, number>();
	for (const id of nodes.keys()) {
		incoming.set(id, 0);
	}
	for (const edge of edges) {
		incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
	}
	const rank = new Map<string, number>();
	const queue = [...nodes.keys()].filter(id => (incoming.get(id) ?? 0) === 0);
	if (!queue.length) {
		queue.push([...nodes.keys()][0]);
	}
	for (const id of queue) {
		rank.set(id, 0);
	}
	const adj = new Map<string, string[]>();
	for (const edge of edges) {
		const list = adj.get(edge.from) ?? [];
		list.push(edge.to);
		adj.set(edge.from, list);
	}
	const seen = new Set(queue);
	while (queue.length) {
		const id = queue.shift()!;
		for (const next of adj.get(id) ?? []) {
			rank.set(next, Math.max(rank.get(next) ?? 0, (rank.get(id) ?? 0) + 1));
			if (!seen.has(next)) {
				seen.add(next);
				queue.push(next);
			}
		}
	}
	for (const id of nodes.keys()) {
		if (!rank.has(id)) {
			rank.set(id, 0);
		}
	}

	const byRank = new Map<number, MermaidNode[]>();
	for (const node of nodes.values()) {
		const r = rank.get(node.id) ?? 0;
		const list = byRank.get(r) ?? [];
		list.push(node);
		byRank.set(r, list);
	}
	const ranks = [...byRank.keys()].sort((a, b) => a - b);
	const measure = (node: MermaidNode) => Math.min(180, Math.max(72, node.label.length * 7.2 + 24));
	const nodeH = 34;
	const gap = 28;
	const rankGap = 56;
	const positions = new Map<string, { x: number; y: number; w: number; h: number }>();
	let width = 0;
	let height = 0;
	for (const r of ranks) {
		const row = byRank.get(r) ?? [];
		const widths = row.map(measure);
		const rowWidth = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, row.length - 1);
		let x = 0;
		for (const [index, node] of row.entries()) {
			const w = widths[index];
			const h = node.shape === 'diamond' ? 44 : nodeH;
			if (axis === 'TD') {
				positions.set(node.id, { x, y: r * (nodeH + rankGap), w, h });
			} else {
				positions.set(node.id, { x: r * (180 + rankGap), y: x, w, h });
			}
			x += w + gap;
		}
		if (axis === 'TD') {
			width = Math.max(width, rowWidth);
			height = Math.max(height, r * (nodeH + rankGap) + nodeH);
		} else {
			width = Math.max(width, r * (180 + rankGap) + 180);
			height = Math.max(height, rowWidth);
		}
	}
	if (axis === 'TD') {
		for (const r of ranks) {
			const row = byRank.get(r) ?? [];
			const rowWidth = row.reduce((sum, node) => sum + (positions.get(node.id)?.w ?? 0), 0) + gap * Math.max(0, row.length - 1);
			const shift = Math.max(0, (width - rowWidth) / 2);
			for (const node of row) {
				const pos = positions.get(node.id);
				if (pos) {
					pos.x += shift;
				}
			}
		}
	}

	const pad = 16;
	const markerId = `volt-mermaid-arrow-${Math.random().toString(36).slice(2, 8)}`;
	const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', `0 0 ${width + pad * 2} ${height + pad * 2}`);
	svg.setAttribute('width', String(Math.min(width + pad * 2, 560)));
	svg.setAttribute('role', 'img');
	const defs = svgEl(svg, 'defs');
	const marker = svgEl(svg, 'marker');
	marker.setAttribute('id', markerId);
	marker.setAttribute('viewBox', '0 0 10 10');
	marker.setAttribute('refX', '8');
	marker.setAttribute('refY', '5');
	marker.setAttribute('markerWidth', '8');
	marker.setAttribute('markerHeight', '8');
	marker.setAttribute('orient', 'auto-start-reverse');
	const head = svgEl(svg, 'path');
	head.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
	head.setAttribute('fill', 'currentColor');
	marker.appendChild(head);
	defs.appendChild(marker);
	svg.appendChild(defs);

	const g = svgEl(svg, 'g');
	g.setAttribute('transform', `translate(${pad} ${pad})`);
	for (const edge of edges) {
		const from = positions.get(edge.from);
		const to = positions.get(edge.to);
		if (!from || !to) {
			continue;
		}
		const path = svgEl(svg, 'path');
		const x1 = from.x + from.w / 2;
		const y1 = axis === 'TD' ? from.y + from.h : from.y + from.h / 2;
		const x2 = axis === 'TD' ? to.x + to.w / 2 : to.x;
		const y2 = axis === 'TD' ? to.y : to.y + to.h / 2;
		path.setAttribute('d', `M ${x1} ${y1} L ${x2} ${y2}`);
		path.setAttribute('fill', 'none');
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-opacity', '0.45');
		path.setAttribute('stroke-width', '1.25');
		path.setAttribute('marker-end', `url(#${markerId})`);
		g.appendChild(path);
		if (edge.label) {
			const label = svgEl(svg, 'text');
			label.setAttribute('x', String((x1 + x2) / 2));
			label.setAttribute('y', String((y1 + y2) / 2 - 4));
			label.setAttribute('text-anchor', 'middle');
			label.setAttribute('class', 'volt-agent-mermaid-label');
			label.textContent = edge.label;
			g.appendChild(label);
		}
	}
	for (const node of nodes.values()) {
		const pos = positions.get(node.id);
		if (!pos) {
			continue;
		}
		const shape = svgEl(svg, node.shape === 'circle' ? 'ellipse' : node.shape === 'diamond' ? 'polygon' : 'rect');
		if (node.shape === 'diamond') {
			const cx = pos.x + pos.w / 2;
			const cy = pos.y + pos.h / 2;
			shape.setAttribute('points', `${cx},${pos.y} ${pos.x + pos.w},${cy} ${cx},${pos.y + pos.h} ${pos.x},${cy}`);
		} else if (node.shape === 'circle') {
			shape.setAttribute('cx', String(pos.x + pos.w / 2));
			shape.setAttribute('cy', String(pos.y + pos.h / 2));
			shape.setAttribute('rx', String(pos.w / 2));
			shape.setAttribute('ry', String(pos.h / 2));
		} else {
			shape.setAttribute('x', String(pos.x));
			shape.setAttribute('y', String(pos.y));
			shape.setAttribute('width', String(pos.w));
			shape.setAttribute('height', String(pos.h));
			shape.setAttribute('rx', node.shape === 'round' ? String(pos.h / 2) : '6');
		}
		shape.setAttribute('fill', 'var(--vscode-editorWidget-background, transparent)');
		shape.setAttribute('stroke', 'currentColor');
		shape.setAttribute('stroke-opacity', '0.28');
		g.appendChild(shape);
		const label = svgEl(svg, 'text');
		label.setAttribute('x', String(pos.x + pos.w / 2));
		label.setAttribute('y', String(pos.y + pos.h / 2 + 4));
		label.setAttribute('text-anchor', 'middle');
		label.setAttribute('class', 'volt-agent-mermaid-node');
		label.textContent = node.label;
		g.appendChild(label);
	}
	svg.appendChild(g);
	return svg;
}

function renderPie(doc: Document, source: string): SVGSVGElement | undefined {
	const lines = stripMermaid(source);
	if (!/^pie\b/i.test(lines[0] ?? '')) {
		return undefined;
	}
	const slices: Array<{ label: string; value: number }> = [];
	let title = '';
	for (const raw of lines.slice(1)) {
		const titled = /^title\s+(.+)$/i.exec(raw);
		if (titled) {
			title = titled[1].trim();
			continue;
		}
		const slice = /^"([^"]+)"\s*:\s*([\d.]+)/.exec(raw) ?? /^([^:]+):\s*([\d.]+)/.exec(raw);
		if (slice) {
			slices.push({ label: slice[1].trim().replace(/^["']|["']$/g, ''), value: Number(slice[2]) });
		}
	}
	if (slices.length < 2) {
		return undefined;
	}
	const total = slices.reduce((sum, slice) => sum + slice.value, 0) || 1;
	const size = 168;
	const cx = 84;
	const cy = 84;
	const r = 62;
	const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
	const legend = slices.length * 22;
	svg.setAttribute('viewBox', `0 0 ${size + 180} ${Math.max(size, legend + 24)}`);
	svg.setAttribute('width', String(Math.min(size + 180, 420)));
	svg.setAttribute('role', 'img');
	if (title) {
		const label = svgEl(svg, 'text');
		label.setAttribute('x', '8');
		label.setAttribute('y', '16');
		label.setAttribute('class', 'volt-agent-mermaid-node');
		label.textContent = title;
		svg.appendChild(label);
	}
	let angle = -Math.PI / 2;
	const colors = ['var(--vscode-charts-blue, #58a6ff)', 'var(--vscode-charts-green, #3fb950)', 'var(--vscode-charts-orange, #d29922)', 'var(--vscode-charts-purple, #a371f7)', 'var(--vscode-charts-red, #f85149)'];
	slices.forEach((slice, index) => {
		const next = angle + (slice.value / total) * Math.PI * 2;
		const path = svgEl(svg, 'path');
		path.setAttribute('d', arcPath(cx, cy + (title ? 8 : 0), r, angle, next));
		path.setAttribute('fill', colors[index % colors.length]);
		path.setAttribute('fill-opacity', '0.85');
		svg.appendChild(path);
		const ly = 28 + index * 22;
		const swatch = svgEl(svg, 'rect');
		swatch.setAttribute('x', String(size + 8));
		swatch.setAttribute('y', String(ly - 10));
		swatch.setAttribute('width', '8');
		swatch.setAttribute('height', '8');
		swatch.setAttribute('rx', '2');
		swatch.setAttribute('fill', colors[index % colors.length]);
		svg.appendChild(swatch);
		const text = svgEl(svg, 'text');
		text.setAttribute('x', String(size + 22));
		text.setAttribute('y', String(ly - 2));
		text.setAttribute('class', 'volt-agent-mermaid-label');
		text.textContent = `${slice.label}  ${slice.value}`;
		svg.appendChild(text);
		angle = next;
	});
	return svg;
}

function renderSequence(doc: Document, source: string): SVGSVGElement | undefined {
	const lines = stripMermaid(source);
	if (!/^sequenceDiagram\b/i.test(lines[0] ?? '')) {
		return undefined;
	}
	const actors: string[] = [];
	const messages: Array<{ from: string; to: string; text: string }> = [];
	const addActor = (name: string) => {
		if (!actors.includes(name)) {
			actors.push(name);
		}
	};
	for (const raw of lines.slice(1)) {
		const participant = /^(?:participant|actor)\s+(\S+)/i.exec(raw);
		if (participant) {
			addActor(participant[1]);
			continue;
		}
		const msg = /^(\S+)\s*-{1,2}>>?\s*(\S+)\s*:\s*(.+)$/.exec(raw);
		if (msg) {
			addActor(msg[1]);
			addActor(msg[2]);
			messages.push({ from: msg[1], to: msg[2], text: msg[3].trim() });
		}
	}
	if (actors.length < 2 || !messages.length) {
		return undefined;
	}
	const col = 120;
	const width = Math.max(240, actors.length * col);
	const height = 48 + messages.length * 36;
	const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
	svg.setAttribute('width', String(Math.min(width, 520)));
	svg.setAttribute('role', 'img');
	actors.forEach((actor, index) => {
		const x = 60 + index * col;
		const line = svgEl(svg, 'line');
		line.setAttribute('x1', String(x));
		line.setAttribute('x2', String(x));
		line.setAttribute('y1', '28');
		line.setAttribute('y2', String(height - 8));
		line.setAttribute('stroke', 'currentColor');
		line.setAttribute('stroke-opacity', '0.2');
		svg.appendChild(line);
		const label = svgEl(svg, 'text');
		label.setAttribute('x', String(x));
		label.setAttribute('y', '18');
		label.setAttribute('text-anchor', 'middle');
		label.setAttribute('class', 'volt-agent-mermaid-node');
		label.textContent = actor;
		svg.appendChild(label);
	});
	messages.forEach((message, index) => {
		const y = 48 + index * 36;
		const x1 = 60 + actors.indexOf(message.from) * col;
		const x2 = 60 + actors.indexOf(message.to) * col;
		const path = svgEl(svg, 'line');
		path.setAttribute('x1', String(x1));
		path.setAttribute('y1', String(y));
		path.setAttribute('x2', String(x2));
		path.setAttribute('y2', String(y));
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-opacity', '0.55');
		svg.appendChild(path);
		const label = svgEl(svg, 'text');
		label.setAttribute('x', String((x1 + x2) / 2));
		label.setAttribute('y', String(y - 6));
		label.setAttribute('text-anchor', 'middle');
		label.setAttribute('class', 'volt-agent-mermaid-label');
		label.textContent = message.text;
		svg.appendChild(label);
	});
	return svg;
}

function arcPath(cx: number, cy: number, r: number, start: number, end: number): string {
	const x1 = cx + r * Math.cos(start);
	const y1 = cy + r * Math.sin(start);
	const x2 = cx + r * Math.cos(end);
	const y2 = cy + r * Math.sin(end);
	const large = end - start > Math.PI ? 1 : 0;
	return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
}

function stripMermaid(source: string): string[] {
	return source.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('%%'));
}

function svgEl(host: SVGElement, tag: string): SVGElement {
	return host.ownerDocument.createElementNS('http://www.w3.org/2000/svg', tag);
}
