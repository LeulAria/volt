/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { tableElementToMarkdown, tableElementToPlainText } from '../../browser/blocks/agentBlockRenderers.js';

suite('Agent table copy', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function sampleTable(): HTMLTableElement {
		const table = document.createElement('table');
		const thead = table.createTHead();
		const headRow = thead.insertRow();
		for (const header of ['Rank', 'Name']) {
			const cell = headRow.insertCell();
			cell.textContent = header;
		}
		const tbody = table.createTBody();
		const row = tbody.insertRow();
		row.insertCell().textContent = '1';
		row.insertCell().textContent = 'Python';
		return table;
	}

	test('serializes tables to tab-separated text', () => {
		assert.strictEqual(tableElementToPlainText(sampleTable()), 'Rank\tName\n1\tPython');
	});

	test('serializes tables to markdown', () => {
		assert.strictEqual(
			tableElementToMarkdown(sampleTable()),
			'| Rank | Name |\n| --- | --- |\n| 1 | Python |',
		);
	});
});
