/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, diffText, errorMessage, languageForPath, parseUnifiedDiff, type VoltClient } from '@volt/client-core';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { editPatch } from '../src/chat/ChangeRow';
import { openFile } from '../src/chat/context';
import { DiffList, diffItems } from '../src/chat/Diff';
import { type DiffsEvent, DiffsView, type IDiffsView } from '../src/files/DiffsView';
import { DiffCounts, PathBar } from '../src/files/PathBar';
import { useClient, useOptionalClient } from '../src/state/client';
import { conversationPrefs, useConversationPrefs } from '../src/state/prefs';
import { useTheme } from '../src/theme/theme';
import { EmptyState, IconButton } from '../src/ui/core';

type IParams = {
	/** The absolute path of the file (the right side, when no blob names it). */
	readonly file?: string;
	readonly title?: string;
	readonly repoRoot?: string;
	readonly oldBlob?: string;
	readonly newBlob?: string;
	readonly kind?: string;
	/** `git`: the file against its last commit, instead of a checkpoint's blobs. */
	readonly mode?: string;
	/** `1`: the whole file with the changes marked, no unchanged stretch folded. */
	readonly full?: string;
	/** One transcript edit (ChangeRow's openEditDiff): the patch undone on the file as it is now. */
	readonly edit?: string;
	/** The counts, when the opener knows them (the page reports its own once it has diffed). */
	readonly additions?: string;
	readonly deletions?: string;
};

interface ISides {
	readonly before: string;
	readonly after: string;
}

export default function DiffScreen() {
	const params = useLocalSearchParams<IParams>();
	const client = useOptionalClient();
	return client && params.file ? <Diff params={params} /> : null;
}

/** Past this after the text arrived without the page drawing, the built-in diff list shows instead. */
const PAGE_TIMEOUT = 10_000;

/**
 * One file's diff, both sides loaded from the computer in parallel: checkpoint blobs, the last
 * commit and the file now, or one transcript edit undone on the file. Drawn by @pierre/diffs
 * (DiffsView), whose page starts while the sides load and diffs them itself; the built-in list
 * shows only if the page fails.
 */
function Diff({ params }: { readonly params: IParams }) {
	const { p } = useTheme();
	const client = useClient();
	const file = params.file!;
	const [sides, setSides] = useState<ISides | undefined>();
	const [error, setError] = useState<string | undefined>();
	// One choice for every code view (Settings > Wrap long lines); the header toggle flips it.
	const { codeWrap: wrap } = useConversationPrefs();
	const [page, setPage] = useState<'loading' | 'shown' | 'same' | 'failed'>('loading');
	const [counts, setCounts] = useState<{ readonly additions: number; readonly deletions: number } | undefined>(
		params.additions !== undefined && params.deletions !== undefined ? { additions: Number(params.additions) || 0, deletions: Number(params.deletions) || 0 } : undefined);
	const view = useRef<IDiffsView>(null);
	useEffect(() => {
		view.current?.setWrap(wrap);
	}, [wrap]);
	const name = params.title ?? file;
	// A turn that edited the file and then put it back: the server counts the edits, but the blobs match.
	const sameBody = params.oldBlob && params.oldBlob === params.newBlob && (Number(params.additions) || Number(params.deletions))
		? 'The agent changed this file in that turn, then put it back the way it was.'
		: 'Both sides are the same.';

	useEffect(() => {
		let live = true;
		loadSides(client, params).then(result => live && setSides(result), err => live && setError(errorMessage(err)));
		return () => {
			live = false;
		};
	}, [client, file, params.repoRoot, params.oldBlob, params.newBlob, params.kind, params.mode, params.edit]);

	useEffect(() => {
		if (page !== 'loading' || !sides) {
			return;
		}
		const timer = setTimeout(() => setPage(state => state === 'loading' ? 'failed' : state), PAGE_TIMEOUT);
		return () => clearTimeout(timer);
	}, [page, sides]);

	const onEvent = (event: DiffsEvent) => {
		if (event.type === 'diff') {
			setCounts({ additions: event.additions, deletions: event.deletions });
			if (!event.hunks) {
				setPage('same');
			}
		} else if (event.type === 'rendered') {
			setPage(state => state === 'loading' ? 'shown' : state);
		} else if (event.type === 'error') {
			setPage(state => state === 'shown' ? state : 'failed');
		}
	};

	const source = useMemo(() => sides && { name, before: sides.before, after: sides.after }, [sides, name]);
	// The phone diffs only when the page can't: the page does it off this thread.
	const fallback = useMemo(() => {
		if (page !== 'failed' || !sides) {
			return undefined;
		}
		const diff = diffText(sides.before, sides.after, 3);
		return { diff, items: diffItems(diff.hunks) };
	}, [page, sides]);
	useEffect(() => {
		if (fallback) {
			setCounts({ additions: fallback.diff.additions, deletions: fallback.diff.deletions });
		}
	}, [fallback]);

	return (
		<View style={{ flex: 1, backgroundColor: p.canvas }}>
			<Stack.Screen options={{
				title: basename(name),
				headerRight: () => (
					<View style={{ flexDirection: 'row' }}>
						<IconButton icon="wrapText" active={wrap} label="Wrap lines" color={wrap ? p.fg : p.fgSecondary} onPress={() => conversationPrefs.set({ codeWrap: !wrap })} />
						{params.kind !== 'deleted' ? <IconButton icon="file" label="Open file" color={p.fg} onPress={() => openFile(file)} /> : null}
					</View>
				),
			}} />
			<PathBar path={name} right={counts ? <DiffCounts additions={counts.additions} deletions={counts.deletions} /> : undefined} />
			{error ? <EmptyState icon="alertCircle" title="Couldn't load the diff" body={error} />
				: page === 'same' ? <EmptyState icon="checkCircle" title="No differences" body={sameBody} />
					: fallback ? (fallback.items.length ? <DiffList items={fallback.items} wrap={wrap} fence={languageForPath(file).fence} /> : <EmptyState icon="checkCircle" title="No differences" body={sameBody} />)
						: <DiffsView ref={view} p={p} mode="diff" full={params.full === '1'} wrap={wrap} source={source} onEvent={onEvent} />}
		</View>
	);
}

async function readText(client: VoltClient, file: string): Promise<string> {
	const content = await client.readFile(file);
	if (content.kind !== 'text') {
		throw new Error(content.kind === 'tooLarge' ? 'The file is too large to compare here.' : 'This file isn\'t text.');
	}
	return content.text;
}

/** Both sides, fetched together. */
async function loadSides(client: VoltClient, params: IParams): Promise<ISides> {
	const file = params.file!;
	if (params.mode === 'git') {
		const [before, after] = await Promise.all([client.gitShow(file).then(r => r.text), readText(client, file).catch(() => '')]);
		return { before, after };
	}
	if (params.repoRoot || params.oldBlob || params.newBlob) {
		const side = async (blob: string | undefined, current: boolean): Promise<string> => blob && params.repoRoot ? (await client.gitBlob(params.repoRoot, blob)).text : current ? readText(client, file) : '';
		const [before, after] = await Promise.all([side(params.oldBlob, false), side(params.newBlob, params.kind !== 'deleted')]);
		return { before, after };
	}
	// One edit from the transcript: the file now, and the file with that edit undone.
	const after = await readText(client, file);
	if (params.kind === 'added') {
		return { before: '', after };
	}
	const patch = editPatch(params.edit);
	const before = patch !== undefined ? unapply(after, patch) : undefined;
	// Edited again since in a way the patch no longer fits (or the app restarted): against the last commit.
	return { before: before ?? (await client.gitShow(file)).text, after };
}

/** `text` with the patch's hunks put back the way they were; undefined if a hunk's new lines aren't there. */
function unapply(text: string, patch: string): string | undefined {
	const hunks = parseUnifiedDiff(patch).flatMap(f => f.hunks);
	if (!hunks.length) {
		return undefined;
	}
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const lines = text.split(eol);
	const out: string[] = [];
	let at = 0;
	for (const hunk of hunks) {
		const now = hunk.lines.filter(l => l.kind !== 'del').map(l => l.text);
		const was = hunk.lines.filter(l => l.kind !== 'add').map(l => l.text);
		const start = findBlock(lines, now, at, hunk.newLines ? hunk.newStart - 1 : hunk.newStart);
		if (start < 0) {
			return undefined;
		}
		for (let i = at; i < start; i++) {
			out.push(lines[i]);
		}
		out.push(...was);
		at = start + now.length;
	}
	for (let i = at; i < lines.length; i++) {
		out.push(lines[i]);
	}
	return out.join(eol);
}

/** Where `block` starts in `lines` at or after `from`, the nearest to `near` first; -1 if it isn't there. */
function findBlock(lines: readonly string[], block: readonly string[], from: number, near: number): number {
	const last = lines.length - block.length;
	const at = Math.min(Math.max(near, from), Math.max(last, from));
	if (!block.length) {
		return Math.min(at, lines.length);
	}
	const fits = (i: number) => block.every((line, k) => lines[i + k] === line);
	for (let d = 0; at - d >= from || at + d <= last; d++) {
		if (at + d <= last && fits(at + d)) {
			return at + d;
		}
		if (d && at - d >= from && at - d <= last && fits(at - d)) {
			return at - d;
		}
	}
	return -1;
}
