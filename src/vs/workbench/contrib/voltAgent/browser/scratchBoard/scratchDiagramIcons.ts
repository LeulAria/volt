/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IArchitectureIcon } from '../../common/scratchBoard/scratchArchitecture.js';
import { fontStack } from './scratchRenderer.js';

const ARIA_SEARCH = 'https://icons.leularia.com/api/v1/search';
const ARIA_ICONS = 'https://icons.leularia.com/api/v1/icons';
/** The icons endpoint answers at most this many ids per request. */
const ARIA_BATCH = 20;
/** A diagram draws without the icons it could not get in this long. */
const FETCH_TIMEOUT_MS = 8000;
const MAX_SVG = 200_000;

/** Icons fetched this session, by what the agent asked for (an id or a word). */
const cache = new Map<string, IArchitectureIcon | null>();

/**
 * An icon as a diagram draws it. Line icons draw in currentColor and take the card's colour; a
 * one-colour logo with no colour of its own (Simple Icons) would draw black, invisible on a dark
 * board, so it takes the card's colour too. Logos in their own colours keep them.
 */
function toIcon(id: string, svg: string): IArchitectureIcon | undefined {
	if (!/^\s*<svg[\s>]/i.test(svg) || svg.length > MAX_SVG) {
		return undefined;
	}
	if (/currentColor/i.test(svg)) {
		return { iconId: id, svg, tintable: true };
	}
	const coloured = /(?:fill|stroke|stop-color)\s*[:=]\s*["']?\s*(?:#|rgb|hsl|url\()/i.test(svg) || /<style[\s>]/i.test(svg);
	return coloured ? { iconId: id, svg, tintable: false } : { iconId: id, svg: svg.replace(/<svg\b/i, '<svg fill="currentColor"'), tintable: true };
}

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T | undefined> {
	try {
		const response = await fetch(url, { headers: { accept: 'application/json' }, signal });
		return response.ok ? await response.json() as T : undefined;
	} catch {
		return undefined;
	}
}

async function byIds(ids: readonly string[], signal: AbortSignal): Promise<Map<string, IArchitectureIcon>> {
	const out = new Map<string, IArchitectureIcon>();
	const batches: string[][] = [];
	for (let i = 0; i < ids.length; i += ARIA_BATCH) {
		batches.push(ids.slice(i, i + ARIA_BATCH));
	}
	await Promise.all(batches.map(async batch => {
		const data = await fetchJson<{ icons?: { id: string; svg?: string }[] }>(`${ARIA_ICONS}?${new URLSearchParams({ ids: batch.join(',') })}`, signal);
		for (const icon of data?.icons ?? []) {
			const made = typeof icon.svg === 'string' ? toIcon(icon.id, icon.svg) : undefined;
			if (made) {
				out.set(icon.id, made);
			}
		}
	}));
	return out;
}

/** The best match for a word (`webhook`, `postgres`): the search's first hit. */
async function bySearch(word: string, signal: AbortSignal): Promise<string | undefined> {
	const data = await fetchJson<{ icons?: { id: string }[] }>(`${ARIA_SEARCH}?${new URLSearchParams({ q: word, limit: '1' })}`, signal);
	const id = data?.icons?.[0]?.id;
	return typeof id === 'string' ? id : undefined;
}

/**
 * The icons a diagram names, from Aria Icons (icons.leularia.com). A name is an icon id
 * (`lucide:webhook`, `logos:github-icon`) or a word to search for; an id that does not exist is
 * searched by its name part. What cannot be had in time is left out, and the diagram draws without it.
 */
export async function fetchDiagramIcons(names: Iterable<string>): Promise<Map<string, IArchitectureIcon>> {
	const all = [...new Set(names)];
	const wanted = all.filter(name => !cache.has(name));
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
	try {
		const ids = wanted.filter(name => /^[a-z0-9-]+:[a-z0-9-]+$/i.test(name));
		const found = await byIds(ids, abort.signal);
		// Words, and ids that were not there: search.
		const searched = await Promise.all(wanted.filter(name => !found.has(name)).map(async name => [name, await bySearch(name.includes(':') ? name.slice(name.indexOf(':') + 1).replace(/-/g, ' ') : name, abort.signal)] as const));
		const more = await byIds([...new Set(searched.map(([, id]) => id).filter((id): id is string => !!id && !found.has(id)))], abort.signal);
		for (const name of wanted) {
			const hit = found.get(name) ?? (() => {
				const id = searched.find(([n]) => n === name)?.[1];
				return id ? found.get(id) ?? more.get(id) : undefined;
			})();
			// A miss is remembered only when the service answered: a timeout may do better next time.
			if (hit || !abort.signal.aborted) {
				cache.set(name, hit ?? null);
			}
		}
	} finally {
		clearTimeout(timer);
	}
	const out = new Map<string, IArchitectureIcon>();
	for (const name of all) {
		const icon = cache.get(name);
		if (icon) {
			out.set(name, icon);
		}
	}
	return out;
}

/**
 * Width of text in the hand font, measured on a canvas once the font has loaded (an estimate from
 * the font size until then), so cards fit their titles.
 */
export async function handTextMeasure(doc: Document): Promise<(text: string, fontSize: number) => number> {
	const family = fontStack('hand');
	try {
		await doc.fonts.load(`20px ${family}`);
	} catch {
		// Measured in the fallback.
	}
	const context = doc.createElement('canvas').getContext('2d');
	if (!context) {
		return (text, fontSize) => text.length * fontSize * 0.56;
	}
	return (text, fontSize) => {
		context.font = `${fontSize}px ${family}`;
		return context.measureText(text).width;
	};
}
