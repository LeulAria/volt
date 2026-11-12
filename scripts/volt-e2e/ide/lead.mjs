/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The [Volt] lead Volt prepends to a Claude Code (ACP) prompt in a chat with the volt MCP server,
// computed by the real classifier and context pack in out/. Usage: node lead.mjs "<prompt>" [--json]
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../../out/vs/workbench/services/voltRuntime/common/harness');
const { classifyIntent } = await import(`${out}/intent.js`);
const { buildAcpLead } = await import(`${out}/contextPack.js`);

export function voltLead(prompt, { mode = 'agent', sandboxed = true } = {}) {
	const intent = classifyIntent(prompt, mode, { hasWorkspace: true });
	// A large indexed project with the volt MCP server and its IDE tools, in a Supervised (sandboxed) chat:
	// what the hotel chat is. Code from before the sandboxed flag ignores it.
	const lead = buildAcpLead({ intent, mode, codeIndexed: true, ideTools: true, sandboxed, visuals: true, browserTools: true });
	return { lane: intent.lane, signals: intent.signals, lead };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const r = voltLead(process.argv[2]);
	console.log(process.argv.includes('--json') ? JSON.stringify(r) : `lane=${r.lane} signals=${r.signals.join(',')}\n${r.lead}`);
}
