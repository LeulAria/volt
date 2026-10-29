/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMarketplacePlugin } from '../../browser/customize/agentMarketplace.js';
import { rankPlugins } from '../../browser/customize/agentMarketplaceView.js';

function plugin(name: string, description = '', category?: string): IMarketplacePlugin {
	return { name, description, author: 'Anthropic', category, source: { kind: 'path', path: `./plugins/${name}` }, marketplace: 'claude-plugins-official', installed: false, installedInVolt: false };
}

suite('Agent marketplace search', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('names that match come before descriptions that mention the query', () => {
		const plugins = [
			plugin('atomic-agents', 'Agents that review architecture'),
			plugin('canva', 'Design with Canva, then review'),
			plugin('pr-review-toolkit', 'PR review agents'),
			plugin('reviewdog', 'Linters in review comments'),
			plugin('code-review', 'Automated code review'),
			plugin('review'),
		];
		assert.deepStrictEqual(rankPlugins(plugins, 'Review').map(p => p.name), ['review', 'reviewdog', 'pr-review-toolkit', 'code-review', 'atomic-agents', 'canva']);
	});

	test('the category ranks above the description, and the listing order breaks ties', () => {
		const plugins = [
			plugin('sentry', 'Error tracking with security alerts'),
			plugin('semgrep', 'Static analysis', 'security'),
			plugin('snyk', 'Find vulnerabilities', 'security'),
		];
		assert.deepStrictEqual(rankPlugins(plugins, 'security').map(p => p.name), ['semgrep', 'snyk', 'sentry']);
	});

	test('nothing matches an empty query or an unknown word', () => {
		const plugins = [plugin('code-review', 'Automated code review')];
		assert.deepStrictEqual(rankPlugins(plugins, '  '), []);
		assert.deepStrictEqual(rankPlugins(plugins, 'kubernetes'), []);
	});
});
