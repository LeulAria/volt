/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, dirname, errorMessage, type IGrepMatch } from '@volt/client-core';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useClient } from '../app/client';
import { Codicon, FileIcon } from './icons';
import { relativeTo, useActiveRoot } from './roots';
import { revealInFile } from './workbench';

interface IOptions {
	readonly caseSensitive: boolean;
	readonly wholeWord: boolean;
	readonly regex: boolean;
}

const SEARCH_KEY = 'volt.web.search';

function loadSaved(): { query: string; include: string; exclude: string; options: IOptions } {
	try {
		const saved = JSON.parse(window.sessionStorage.getItem(SEARCH_KEY) ?? '{}') as Partial<{ query: string; include: string; exclude: string; options: IOptions }>;
		return { query: saved.query ?? '', include: saved.include ?? '', exclude: saved.exclude ?? '', options: saved.options ?? { caseSensitive: false, wholeWord: false, regex: false } };
	} catch {
		return { query: '', include: '', exclude: '', options: { caseSensitive: false, wholeWord: false, regex: false } };
	}
}

/** Search across the project (ripgrep on the computer), results grouped by file as in the desktop. */
export function SearchView() {
	const client = useClient();
	const { root } = useActiveRoot();
	const saved = useMemo(loadSaved, []);
	const [query, setQuery] = useState(saved.query);
	const [include, setInclude] = useState(saved.include);
	const [exclude, setExclude] = useState(saved.exclude);
	const [options, setOptions] = useState<IOptions>(saved.options);
	const [showFilters, setShowFilters] = useState(!!(saved.include || saved.exclude));
	const [result, setResult] = useState<{ matches: readonly IGrepMatch[]; truncated: boolean; error?: string } | undefined>();
	const [busy, setBusy] = useState(false);
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
	const input = useRef<HTMLInputElement>(null);
	const run = useRef(0);

	useEffect(() => {
		input.current?.focus();
		input.current?.select();
	}, []);

	useEffect(() => {
		try {
			window.sessionStorage.setItem(SEARCH_KEY, JSON.stringify({ query, include, exclude, options }));
		} catch {
			// private mode
		}
		if (!root || !query.trim()) {
			setResult(undefined);
			setBusy(false);
			return;
		}
		const id = ++run.current;
		setBusy(true);
		const timer = setTimeout(() => {
			client.grep(root.path, query, { ...options, include, exclude, maxResults: 3000 }).then(
				r => id === run.current && setResult(r),
				err => id === run.current && setResult({ matches: [], truncated: false, error: errorMessage(err) }),
			).finally(() => id === run.current && setBusy(false));
		}, 260);
		return () => clearTimeout(timer);
	}, [client, root, query, include, exclude, options]);

	const groups = useMemo(() => {
		const map = new Map<string, IGrepMatch[]>();
		for (const match of result?.matches ?? []) {
			const list = map.get(match.path);
			if (list) {
				list.push(match);
			} else {
				map.set(match.path, [match]);
			}
		}
		return [...map.entries()];
	}, [result]);

	const toggle = (key: keyof IOptions, label: string, icon: Parameters<typeof Codicon>[0]['name']) => (
		<button type="button" className={`search-toggle${options[key] ? ' on' : ''}`} title={label} aria-pressed={options[key]} onClick={() => setOptions(o => ({ ...o, [key]: !o[key] }))}>
			<Codicon name={icon} />
		</button>
	);

	return (
		<div className="search-view">
			<div className="search-form">
				<div className="search-box">
					<input ref={input} value={query} placeholder="Search" spellCheck={false} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Escape' && setQuery('')} />
					{toggle('caseSensitive', 'Match Case', 'case-sensitive')}
					{toggle('wholeWord', 'Match Whole Word', 'whole-word')}
					{toggle('regex', 'Use Regular Expression', 'regex')}
				</div>
				<button type="button" className={`search-more${showFilters ? ' on' : ''}`} title="Toggle Search Details" onClick={() => setShowFilters(v => !v)}><Codicon name="ellipsis" /></button>
				{showFilters ? (
					<div className="search-filters">
						<label>files to include</label>
						<input value={include} placeholder="e.g. src/**/*.ts, *.md" spellCheck={false} onChange={e => setInclude(e.target.value)} />
						<label>files to exclude</label>
						<input value={exclude} placeholder="e.g. dist, **/*.test.ts" spellCheck={false} onChange={e => setExclude(e.target.value)} />
					</div>
				) : null}
			</div>
			<div className="search-summary">
				{busy ? <span className="spinner" style={{ width: 11, height: 11 }} /> : null}
				{result?.error ? <span className="error">{result.error}</span>
					: result ? <span>{result.matches.length ? `${result.matches.length}${result.truncated ? '+' : ''} ${result.matches.length === 1 ? 'result' : 'results'} in ${groups.length} ${groups.length === 1 ? 'file' : 'files'}` : 'No results found.'}</span>
						: <span className="dim">{root ? `Searching ${root.name}` : 'Open a project to search it.'}</span>}
				{groups.length ? (
					<span className="view-actions">
						<button type="button" className="ide-icon-btn" title="Collapse All" onClick={() => setCollapsed(new Set(groups.map(([path]) => path)))}><Codicon name="collapse-all" /></button>
						<button type="button" className="ide-icon-btn" title="Clear Search Results" onClick={() => setQuery('')}><Codicon name="clear-all" /></button>
					</span>
				) : null}
			</div>
			<div className="search-results">
				{groups.map(([path, matches]) => {
					const open = !collapsed.has(path);
					const rel = relativeTo(root?.path, path);
					return (
						<Fragment key={path}>
							<button type="button" className="search-file" onClick={() => setCollapsed(prev => {
								const next = new Set(prev);
								if (next.has(path)) {
									next.delete(path);
								} else {
									next.add(path);
								}
								return next;
							})}>
								<Codicon name="chevron-right" className={`twistie${open ? ' open' : ''}`} />
								<FileIcon path={path} />
								<span className="search-file-name">{basename(path)}</span>
								<span className="search-file-dir">{dirname(rel)}</span>
								<span className="search-count">{matches.length}</span>
							</button>
							{open ? matches.map((match, i) => <MatchRow key={`${match.line}:${i}`} match={match} />) : null}
						</Fragment>
					);
				})}
			</div>
		</div>
	);
}

function MatchRow({ match }: { readonly match: IGrepMatch }) {
	// Long lines are cut around the first match, as the desktop's results are.
	const first = match.ranges[0] ?? [0, 0];
	const cut = Math.max(0, first[0] - 30);
	const text = match.text.slice(cut, cut + 240);
	const parts: { text: string; hit: boolean }[] = [];
	let at = 0;
	for (const [s, e] of match.ranges) {
		const start = s - cut;
		const end = e - cut;
		if (end <= 0 || start >= text.length) {
			continue;
		}
		if (start > at) {
			parts.push({ text: text.slice(at, start), hit: false });
		}
		parts.push({ text: text.slice(Math.max(start, at), end), hit: true });
		at = end;
	}
	parts.push({ text: text.slice(at), hit: false });
	return (
		<button type="button" className="search-match" title={`${match.line}: ${match.text.trim()}`} onClick={() => revealInFile(match.path, match.line, first[0] + 1, first[1] + 1)}>
			{cut > 0 ? '…' : ''}{parts.map((part, i) => part.hit ? <mark key={i}>{part.text}</mark> : <Fragment key={i}>{part.text.replace(/^\s+/, i === 0 && cut === 0 ? '' : ' ')}</Fragment>)}
		</button>
	);
}
