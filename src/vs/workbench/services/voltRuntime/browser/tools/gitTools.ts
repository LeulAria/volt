/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { truncateHeadTail } from '../../common/harness/toolResult.js';
import { IToolContext, IToolResult, IVoltTool } from '../../common/tools/tool.js';
import { objectSchema } from './schema.js';

export function createGitTools(stdio: IVoltStdioService, root: () => URI | undefined): IVoltTool[] {
	return [
		gitTool('git_status', 'git_status - working tree status', ['status', '--short', '--branch'], stdio, root),
		gitTool('git_diff', 'git_diff - unstaged and staged diff', ['diff', '--stat', 'HEAD'], stdio, root),
		gitTool('git_branch', 'git_branch - current branch name', ['rev-parse', '--abbrev-ref', 'HEAD'], stdio, root),
	];
}

function gitTool(name: string, snippet: string, args: readonly string[], stdio: IVoltStdioService, root: () => URI | undefined): IVoltTool {
	return {
		name,
		group: 'git',
		kind: 'search',
		parallelSafe: true,
		snippet,
		description: `${snippet}. Use when you need git state. Do not use to commit, push, or rewrite history.`,
		schema: objectSchema({}, []),
		execute: async (_args, ctx) => runGit(stdio, root(), args, name, ctx),
	};
}

async function runGit(stdio: IVoltStdioService, cwd: URI | undefined, args: readonly string[], name: string, ctx: IToolContext): Promise<IToolResult> {
	if (!cwd) {
		return { callId: '', name, kind: 'search', text: 'No workspace is open.', isError: true };
	}
	let id: string;
	try {
		id = await stdio.spawn({ command: 'git', args: [...args], cwd: cwd.fsPath });
	} catch (err) {
		return { callId: '', name, kind: 'search', text: err instanceof Error ? err.message : String(err), isError: true };
	}
	const output = await new Promise<{ code: number | null; text: string }>(resolve => {
		let text = '';
		const data = stdio.onData(event => { if (event.id === id) { text += event.data; } });
		const exit = stdio.onExit(event => {
			if (event.id === id) {
				data.dispose();
				exit.dispose();
				resolve({ code: event.code, text });
			}
		});
		const timer = setTimeout(() => {
			void stdio.kill(id);
			data.dispose();
			exit.dispose();
			resolve({ code: null, text: text || 'git timed out.' });
		}, 15_000);
		if (ctx.signal.aborted) {
			void stdio.kill(id);
		}
		ctx.signal.addEventListener('abort', () => void stdio.kill(id));
		const original = resolve;
		resolve = value => {
			clearTimeout(timer);
			original(value);
		};
	});
	return {
		callId: '',
		name,
		kind: 'search',
		text: truncateHeadTail(output.text || `(git ${args.join(' ')})`).text,
		isError: output.code !== 0 && output.code !== null,
	};
}
