/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Takes a renderer heap snapshot over CDP and reports what keeps detached DOM alive and which
// object types hold the most memory.
// Usage: node --max-old-space-size=8192 build/volt/perf/heapRetainers.mjs --port 9931 [--save file.heapsnapshot] [--grep Agent]

import * as fs from 'node:fs';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const CDP = createRequire(path.join(root, 'package.json'))('chrome-remote-interface');
const { values: opts } = parseArgs({ options: { port: { type: 'string', default: '9931' }, save: { type: 'string' }, load: { type: 'string' }, grep: { type: 'string' }, top: { type: 'string', default: '25' } } });

async function takeSnapshot() {
	const targets = await CDP.List({ port: +opts.port });
	const client = await CDP({ port: +opts.port, target: targets.find(t => t.type === 'page' && /workbench/.test(t.url)) });
	const chunks = [];
	client.HeapProfiler.addHeapSnapshotChunk(({ chunk }) => chunks.push(chunk));
	await client.HeapProfiler.collectGarbage();
	await client.HeapProfiler.takeHeapSnapshot({ reportProgress: false });
	await client.close();
	return chunks.join('');
}

const text = opts.load ? fs.readFileSync(opts.load, 'utf8') : await takeSnapshot();
if (opts.save) {
	fs.writeFileSync(opts.save, text);
}
const snap = JSON.parse(text);
const meta = snap.snapshot.meta;
const N = meta.node_fields.length, E = meta.edge_fields.length;
const nTypes = meta.node_types[0], eTypes = meta.edge_types[0];
const [nType, nName, nId, nSelf, nEdges] = ['type', 'name', 'id', 'self_size', 'edge_count'].map(f => meta.node_fields.indexOf(f));
const [eType, eName, eTo] = ['type', 'name_or_index', 'to_node'].map(f => meta.edge_fields.indexOf(f));
const nodes = snap.nodes, edges = snap.edges, strings = snap.strings;
const count = nodes.length / N;

const firstEdge = new Uint32Array(count + 1);
for (let i = 0, e = 0; i < count; i++) {
	firstEdge[i] = e;
	e += nodes[i * N + nEdges] * E;
	firstEdge[i + 1] = e;
}
// Reverse edges (retainers), skipping weak edges.
const retainerCount = new Uint32Array(count);
for (let i = 0; i < count; i++) {
	for (let e = firstEdge[i]; e < firstEdge[i + 1]; e += E) {
		if (eTypes[edges[e + eType]] !== 'weak') {
			retainerCount[edges[e + eTo] / N]++;
		}
	}
}
const retainerStart = new Uint32Array(count + 1);
for (let i = 0; i < count; i++) {
	retainerStart[i + 1] = retainerStart[i] + retainerCount[i];
}
const retainers = new Uint32Array(retainerStart[count]);
const retainerEdge = new Uint32Array(retainerStart[count]);
const fill = retainerStart.slice(0, count);
for (let i = 0; i < count; i++) {
	for (let e = firstEdge[i]; e < firstEdge[i + 1]; e += E) {
		if (eTypes[edges[e + eType]] !== 'weak') {
			const to = edges[e + eTo] / N;
			retainers[fill[to]] = i;
			retainerEdge[fill[to]++] = e;
		}
	}
}

const name = i => strings[nodes[i * N + nName]];
const type = i => nTypes[nodes[i * N + nType]];
const edgeName = e => eTypes[edges[e + eType]] === 'element' || eTypes[edges[e + eType]] === 'hidden' ? `[${edges[e + eName]}]` : strings[edges[e + eName]];

// 1. Object types by total self size.
const byName = new Map();
for (let i = 0; i < count; i++) {
	if (type(i) !== 'object' && type(i) !== 'native') {
		continue;
	}
	const key = name(i);
	const v = byName.get(key) ?? { n: 0, size: 0 };
	v.n++;
	v.size += nodes[i * N + nSelf];
	byName.set(key, v);
}
const top = +opts.top;
console.log(`heap: ${(snap.snapshot.node_count)} nodes`);
console.log('\n# Largest object types (self size)');
for (const [k, v] of [...byName].filter(([k]) => !opts.grep || k.includes(opts.grep)).sort((a, b) => b[1].size - a[1].size).slice(0, top)) {
	console.log(`${(v.size / 1048576).toFixed(2).padStart(8)} MB ${String(v.n).padStart(8)}  ${k.slice(0, 90)}`);
}

// 2. Detached DOM: count, and the first non-DOM JS owner up the retainer chain.
const isDom = i => /^(Detached )?(HTML|SVG|Text|Comment|DocumentFragment|CSSStyle|DOMTokenList|NamedNodeMap|Attr|CharacterData)/.test(name(i)) || name(i).startsWith('Detached ');
const detached = [];
for (let i = 0; i < count; i++) {
	if (name(i).startsWith('Detached ')) {
		detached.push(i);
	}
}
console.log(`\n# Detached DOM nodes: ${detached.length}`);
const owners = new Map();
for (const start of detached) {
	// BFS up retainers until an object that is not DOM/system/closure-internal.
	const seen = new Set([start]);
	let frontier = [start];
	let owner;
	for (let depth = 0; depth < 12 && !owner && frontier.length; depth++) {
		const next = [];
		for (const node of frontier) {
			for (let r = retainerStart[node]; r < retainerStart[node + 1]; r++) {
				const from = retainers[r];
				if (seen.has(from)) {
					continue;
				}
				seen.add(from);
				const t = type(from), n = name(from);
				if ((t === 'object' && !isDom(from) && !/^(system|Object|Array|\(|Map|Set|WeakMap)/.test(n)) || t === 'closure') {
					owner = `${t === 'closure' ? 'closure ' : ''}${n || '(anonymous)'} .${edgeName(retainerEdge[r])}`;
					break;
				}
				next.push(from);
			}
			if (owner) {
				break;
			}
		}
		frontier = next.slice(0, 2000);
	}
	owner ??= '(not found)';
	owners.set(owner, (owners.get(owner) ?? 0) + 1);
}
for (const [k, v] of [...owners].sort((a, b) => b[1] - a[1]).slice(0, top)) {
	console.log(`${String(v).padStart(7)}  ${k.slice(0, 120)}`);
}
