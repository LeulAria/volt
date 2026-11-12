/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Token use of one Claude Code session from its own transcript (<session>.jsonl plus
// <session>/subagents/*.jsonl): requests, cache reads/writes, output, and the context of the first
// request, for the main agent and its subagents. Works for Volt's sandboxed sessions and plain CLI ones.
// Usage: node scripts/volt-e2e/orch/claudeTranscriptTokens.mjs <session.jsonl>
import { existsSync, readdirSync, readFileSync } from 'fs';

const file = process.argv[2];
const read = path => {
	const seen = new Map();
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		if (!line.trim()) {
			continue;
		}
		const entry = JSON.parse(line);
		const message = entry.message;
		if (entry.type === 'assistant' && message?.usage && message.id) {
			seen.set(message.id, { model: message.model, usage: message.usage });
		}
	}
	const requests = [...seen.values()];
	const sum = key => requests.reduce((total, request) => total + (request.usage[key] ?? 0), 0);
	const first = requests[0]?.usage;
	return {
		requests: requests.length,
		model: requests[0]?.model,
		input: sum('input_tokens'),
		cacheRead: sum('cache_read_input_tokens'),
		cacheWrite: sum('cache_creation_input_tokens'),
		output: sum('output_tokens'),
		firstContext: first ? (first.input_tokens ?? 0) + (first.cache_read_input_tokens ?? 0) + (first.cache_creation_input_tokens ?? 0) : 0,
		firstCacheWrite: first?.cache_creation_input_tokens ?? 0,
	};
};
const main = read(file);
const dir = file.replace(/\.jsonl$/, '/subagents');
const subagents = existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith('.jsonl')).map(name => read(`${dir}/${name}`)) : [];
console.log(JSON.stringify({ main, subagents }, null, 1));
