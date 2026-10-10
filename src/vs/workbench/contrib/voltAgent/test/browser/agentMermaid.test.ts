/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { diagramKind, normalizeClassDiagram, roundedPath, scopeMermaidStyle } from '../../browser/blocks/agentMermaid.js';

suite('Agent mermaid diagrams', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('names each diagram by its first keyword', () => {
		assert.deepStrictEqual(
			['flowchart LR\n A-->B', 'graph TD\n A-->B', 'sequenceDiagram\n A->>B: hi', 'classDiagram\n class A', 'stateDiagram-v2\n [*] --> A', 'stateDiagram\n [*] --> A', 'erDiagram\n A ||--o{ B : has', '%% note\nflowchart TD\n A-->B', 'gitGraph\n commit'].map(source => diagramKind(source).label),
			['Flowchart', 'Flowchart', 'Sequence diagram', 'Class diagram', 'State diagram', 'State diagram', 'Entity relationship', 'Flowchart', 'Diagram'],
		);
	});

	test('rewrites `name: Type` class members into the renderer\'s `Type name`', () => {
		const source = [
			'classDiagram',
			'  class Order {',
			'    +id: UUID',
			'    -items: List~LineItem~',
			'    +total(): Money',
			'    +cancel()',
			'    +String note',
			'    <<entity>>',
			'  }',
			'  Order : +status: OrderStatus',
			'  Customer "1" --> "*" Order : places',
		].join('\n');
		assert.deepStrictEqual(normalizeClassDiagram(source).split('\n'), [
			'classDiagram',
			'  class Order {',
			'    +UUID id',
			'    -List~LineItem~ items',
			'    +total() Money',
			'    +cancel()',
			'    +String note',
			'    <<entity>>',
			'  }',
			'  Order : +OrderStatus status',
			'  Customer "1" --> "*" Order : places',
		]);
	});

	test('rounds every corner of a shape, and only the bends of a connector', () => {
		// A diamond: each corner cut 6 units back along both sides and joined by a curve.
		const diamond = roundedPath([[50, 0], [100, 50], [50, 100], [0, 50]], true);
		assert.strictEqual((diamond.match(/Q/g) ?? []).length, 4);
		assert.ok(diamond.startsWith('M54.24 4.24') && diamond.endsWith('Z'), diamond);
		// An elbow: straight ends (the arrowheads keep their direction), one rounded bend.
		assert.strictEqual(roundedPath([[0, 0], [40, 0], [40, 30]], false), 'M0 0 L34 0 Q40 0 40 6 L40 30');
		// A short side never gets a radius bigger than half of it.
		assert.strictEqual(roundedPath([[0, 0], [4, 0], [4, 30]], false), 'M0 0 L2 0 Q4 0 4 2 L4 30');
		assert.strictEqual(roundedPath([[0, 0], [10, 0]], false), 'M0 0 L10 0');
	});

	test('scopes the renderer\'s bare svg, text and .mono rules to the diagram', () => {
		const markup = '<svg><style>\n  text { font-family: x; }\n  .mono { font-family: y; }\n  svg {\n    --_text: var(--fg);\n  }\n</style><text>a</text></svg>';
		const scoped = scopeMermaidStyle(markup);
		assert.ok(scoped.includes('.volt-md-mermaid-svg text {'), scoped);
		assert.ok(scoped.includes('.volt-md-mermaid-svg .mono {'), scoped);
		assert.ok(scoped.includes('svg.volt-md-mermaid-svg {'), scoped);
		assert.ok(!/(^|[}\n])\s*(text|svg|\.mono)\s*\{/.test(scoped.replace(/\.volt-md-mermaid-svg (text|\.mono)|svg\.volt-md-mermaid-svg/g, 'X')), scoped);
		assert.ok(scoped.endsWith('<text>a</text></svg>'));
	});

	test('leaves other diagrams alone', () => {
		const flow = 'flowchart LR\n  A[id: x] --> B';
		assert.strictEqual(normalizeClassDiagram(flow), flow);
	});
});
