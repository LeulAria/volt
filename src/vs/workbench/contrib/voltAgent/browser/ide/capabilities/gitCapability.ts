/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFileService } from '../../../../../../platform/files/common/files.js';
import { cliText, display, fail, IIdeCapability, IIdeCapabilityContext, IIdeCapabilityResult, list, num, ok, resolvePath, safeName, str } from './capability.js';

/**
 * Source control beyond git_status / git_diff / git_log: staging, commits, branches, merge
 * conflicts, blame and file history. Runs git itself in the chat's folder, so the Source Control
 * view, the gutter and the chat's change set all see the result.
 */
export class GitCapability implements IIdeCapability {

	readonly id = 'git';

	constructor(private readonly fileService: IFileService) { }

	async invoke(op: string, args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		const git = (gitArgs: string[], timeoutMs = 30_000) => ctx.cli.run('git', gitArgs, { timeoutMs });
		const paths = list(args, 'paths').map(path => resolvePath(ctx.root, path)).filter(uri => !!uri).map(uri => display(ctx.root, uri!));
		switch (op) {
			case 'branches': {
				const result = await git(['for-each-ref', '--sort=-committerdate', '--format=%(HEAD)\t%(refname:short)\t%(upstream:short)\t%(upstream:track)\t%(committerdate:relative)\t%(subject)', 'refs/heads']);
				if (result.code !== 0) {
					return cliText(result, 'git');
				}
				const lines = result.stdout.trim().split('\n').filter(Boolean).slice(0, 40).map(line => {
					const [head, name, upstream, track, when, subject] = line.split('\t');
					return `${head === '*' ? '*' : ' '} ${name}${upstream ? ` -> ${upstream}${track ? ` ${track}` : ''}` : ''}  (${when}) ${subject.slice(0, 80)}`;
				});
				return ok(lines.join('\n') || 'No branches.');
			}
			case 'conflicts': return this.conflicts(ctx);
			case 'blame': {
				const uri = resolvePath(ctx.root, str(args, 'path'));
				const line = num(args, 'line');
				if (!uri || !line) {
					return fail('blame needs path and line.');
				}
				const end = num(args, 'end_line') ?? line;
				return cliText(await git(['blame', '--date=short', '-L', `${line},${end}`, '--', display(ctx.root, uri)]), 'git blame', 80);
			}
			case 'history': {
				const limit = Math.min(num(args, 'limit') ?? 15, 100);
				const path = str(args, 'path');
				const uri = path ? resolvePath(ctx.root, path) : undefined;
				return cliText(await git(['log', `-n${limit}`, '--date=short', '--format=%h %ad %an  %s', ...(uri ? ['--follow', '--', display(ctx.root, uri)] : [])]), 'git log');
			}
			case 'show': {
				const uri = resolvePath(ctx.root, str(args, 'path'));
				const ref = safeName(str(args, 'ref') ?? 'HEAD');
				if (!uri || !ref) {
					return fail('show needs path and a ref (commit, branch, HEAD~1).');
				}
				return cliText(await git(['show', `${ref}:${display(ctx.root, uri)}`]), 'git show', 400);
			}
			case 'stage': {
				const result = await git(paths.length ? ['add', '--', ...paths] : ['add', '-A']);
				return result.code === 0 ? this.status(ctx, `Staged ${paths.length ? paths.join(', ') : 'all changes'}.`) : cliText(result, 'git add');
			}
			case 'unstage': {
				const result = await git(['restore', '--staged', '--', ...(paths.length ? paths : ['.'])]);
				return result.code === 0 ? this.status(ctx, `Unstaged ${paths.length ? paths.join(', ') : 'everything'}.`) : cliText(result, 'git restore');
			}
			case 'commit': {
				const message = str(args, 'message');
				if (!message) {
					return fail('commit needs message.');
				}
				const result = await git(['commit', '-m', message, ...(paths.length ? ['--', ...paths] : [])], 120_000);
				if (result.code !== 0) {
					return cliText(result, 'git commit');
				}
				return cliText(await git(['log', '-1', '--stat', '--format=%h %s']), 'git log', 40);
			}
			case 'switch': {
				const branch = safeName(str(args, 'branch'));
				if (!branch) {
					return fail('switch needs a branch name.');
				}
				return cliText(await git(['switch', ...(args.create === true ? ['-c'] : []), branch]), 'git switch');
			}
			case 'stash': {
				const action = str(args, 'action') ?? 'list';
				if (action === 'list') {
					return cliText(await git(['stash', 'list']), 'git stash');
				}
				if (action === 'pop') {
					return cliText(await git(['stash', 'pop']), 'git stash');
				}
				const message = str(args, 'message');
				return cliText(await git(['stash', 'push', ...(message ? ['-m', message] : [])]), 'git stash');
			}
		}
		return fail(`git has no op ${op}.`);
	}

	private async status(ctx: IIdeCapabilityContext, done: string): Promise<IIdeCapabilityResult> {
		const status = await ctx.cli.run('git', ['status', '--short', '--branch'], { timeoutMs: 15_000 });
		return ok(`${done}\n${status.stdout.trim()}`);
	}

	/** Conflicted files and their regions, read from the markers in the working tree. */
	private async conflicts(ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		const result = await ctx.cli.run('git', ['diff', '--name-only', '--diff-filter=U'], { timeoutMs: 15_000 });
		if (result.code !== 0) {
			return cliText(result, 'git');
		}
		const files = result.stdout.trim().split('\n').filter(Boolean);
		if (!files.length) {
			return ok('No merge conflicts.');
		}
		const out: string[] = [`${files.length} conflicted file${files.length === 1 ? '' : 's'}:`];
		for (const file of files.slice(0, 20)) {
			const uri = resolvePath(ctx.root, file);
			const text = uri ? await this.fileService.readFile(uri).then(content => content.value.toString(), () => undefined) : undefined;
			const regions = text ? conflictRegions(text) : [];
			out.push(`${file} (${regions.length} region${regions.length === 1 ? '' : 's'})`);
			for (const region of regions.slice(0, 8)) {
				out.push(`  lines ${region.start}-${region.end}`, `    ours (${region.oursLabel}):`, ...region.ours.slice(0, 6).map(line => `      ${line}`), `    theirs (${region.theirsLabel}):`, ...region.theirs.slice(0, 6).map(line => `      ${line}`));
			}
		}
		return ok(out.join('\n'));
	}
}

interface IConflictRegion {
	readonly start: number;
	readonly end: number;
	readonly oursLabel: string;
	readonly theirsLabel: string;
	readonly ours: readonly string[];
	readonly theirs: readonly string[];
}

export function conflictRegions(text: string): IConflictRegion[] {
	const lines = text.split('\n');
	const out: IConflictRegion[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].startsWith('<<<<<<<')) {
			continue;
		}
		const start = i + 1;
		const oursLabel = lines[i].slice(7).trim() || 'HEAD';
		const ours: string[] = [];
		const theirs: string[] = [];
		let side: 'ours' | 'base' | 'theirs' = 'ours';
		let j = i + 1;
		let theirsLabel = '';
		for (; j < lines.length; j++) {
			if (lines[j].startsWith('|||||||')) {
				side = 'base';
			} else if (lines[j].startsWith('=======')) {
				side = 'theirs';
			} else if (lines[j].startsWith('>>>>>>>')) {
				theirsLabel = lines[j].slice(7).trim();
				break;
			} else if (side === 'ours') {
				ours.push(lines[j]);
			} else if (side === 'theirs') {
				theirs.push(lines[j]);
			}
		}
		out.push({ start, end: j + 1, oursLabel, theirsLabel: theirsLabel || 'incoming', ours, theirs });
		i = j;
	}
	return out;
}
