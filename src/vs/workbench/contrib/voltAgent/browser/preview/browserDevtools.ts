/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IVoltSiteCookie, IVoltSiteData, VOLT_SITE_DATA_KINDS, VoltSiteDataKind } from '../../../../../platform/voltBrowser/common/voltBrowser.js';
import { IVoltHostToolResult } from '../../../../services/voltRuntime/common/hostTools.js';
import { clearPageStorageScript, inspectElementScript, PERFORMANCE_SCRIPT, pageStorageScript, setStorageScript } from './browserAutomationScripts.js';
import type { VoltBrowserView } from './browserEditor.js';

/** What `browser_devtools` uses of the automation around it: page scripts and the page-state footer. */
export interface IDevtoolsHost {
	run<T>(code: string, token: CancellationToken): Promise<T>;
	pageState(): Promise<string[]>;
}

interface IStorageItem { readonly key: string; readonly size: number; readonly value: string }
type StorageArea = { readonly count: number; readonly bytes: number; readonly items: readonly IStorageItem[] } | { readonly error: string };
type Listed<T> = readonly T[] | { readonly error: string };

interface IPageStorage {
	readonly origin: string;
	readonly local: StorageArea;
	readonly session: StorageArea;
	readonly indexedDB?: Listed<{ readonly name?: string; readonly version?: number }>;
	readonly caches?: Listed<{ readonly name: string; readonly entries: number }>;
	readonly serviceWorkers?: Listed<{ readonly scope: string; readonly state: string; readonly script: string; readonly waiting: boolean; readonly controlling: boolean }>;
	readonly quota?: { readonly usage?: number; readonly quota?: number };
}

interface IInspected {
	readonly missing?: boolean;
	readonly element: string;
	readonly ref: string;
	readonly box: readonly [number, number, number, number];
	readonly inViewport: boolean;
	readonly covered?: string;
	readonly overflow?: { readonly scroll: readonly [number, number]; readonly client: readonly [number, number] };
	readonly styles: Readonly<Record<string, string>>;
	readonly rules: readonly { readonly selector: string; readonly declarations: string; readonly sheet: string }[];
	readonly blockedSheets: number;
	readonly text: string;
	readonly attributes: readonly string[];
}

interface IPerformance {
	readonly url: string;
	readonly ttfb?: number;
	readonly domContentLoaded?: number;
	readonly load?: number;
	readonly fcp?: number;
	readonly lcp?: number;
	readonly cls: number;
	readonly resources: number;
	readonly transferKB: number;
	readonly slowest: readonly { readonly url: string; readonly ms: number; readonly type: string }[];
	readonly largest: readonly { readonly url: string; readonly kb: number; readonly type: string }[];
	readonly domNodes: number;
	readonly heapMB?: number;
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function bytes(value: number | undefined): string {
	if (value === undefined) {
		return '?';
	}
	return value >= 1 << 30 ? `${(value / (1 << 30)).toFixed(1)} GB` : value >= 1 << 20 ? `${(value / (1 << 20)).toFixed(1)} MB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} B`;
}

function listed<T>(value: Listed<T> | undefined, format: (item: T) => string, empty = 'none'): string {
	if (!value) {
		return 'unavailable';
	}
	if ('error' in value) {
		return `unavailable (${value.error.slice(0, 80)})`;
	}
	return value.length ? value.map(format).join(', ') : empty;
}

function areaLines(name: string, area: StorageArea): string[] {
	if ('error' in area) {
		return [`- ${name}: unavailable (${area.error.slice(0, 80)})`];
	}
	if (!area.count) {
		return [`- ${name}: empty`];
	}
	return [
		`- ${name}: ${area.count} key${area.count === 1 ? '' : 's'}, ${bytes(area.bytes * 2)}`,
		...area.items.map(item => `  - ${item.key} (${item.size} chars): ${JSON.stringify(item.value)}`),
		...(area.items.length < area.count ? [`  - …${area.count - area.items.length} more${area.items.length ? '' : ' (none match the filter)'}`] : []),
	];
}

function cookieLine(cookie: IVoltSiteCookie, reveal: boolean): string {
	const flags = [
		cookie.httpOnly ? 'HttpOnly' : undefined,
		cookie.secure ? 'Secure' : undefined,
		cookie.sameSite && cookie.sameSite !== 'unspecified' ? cookie.sameSite : undefined,
		cookie.session ? 'session' : cookie.expires ? `expires ${new Date(cookie.expires * 1000).toISOString().slice(0, 10)}` : undefined,
		cookie.domain ? cookie.domain : undefined,
		cookie.path && cookie.path !== '/' ? `path ${cookie.path}` : undefined,
	].filter(Boolean).join(', ');
	const value = reveal ? JSON.stringify(cookie.value.length > 120 ? `${cookie.value.slice(0, 120)}…` : cookie.value) : `${cookie.value.length} chars`;
	return `  - ${cookie.name} = ${value}${flags ? ` (${flags})` : ''}`;
}

function storageLines(page: IPageStorage, site: IVoltSiteData | undefined, filter: string | undefined, reveal: boolean): string[] {
	const cookies = (site?.cookies ?? []).filter(cookie => !filter || cookie.name.toLowerCase().includes(filter.toLowerCase()));
	return [
		`### Site storage of ${page.origin}`,
		site
			? `- Cookies: ${cookies.length ? `${cookies.length}${reveal ? '' : ' (values hidden: pass reveal: true to show them)'}` : 'none'}`
			: '- Cookies: unavailable (the page has no http origin, or the session could not be read)',
		...cookies.slice(0, 30).map(cookie => cookieLine(cookie, reveal)),
		...areaLines('localStorage', page.local),
		...areaLines('sessionStorage', page.session),
		`- IndexedDB: ${listed(page.indexedDB, db => `${db.name ?? '?'} v${db.version ?? '?'}`)}`,
		`- Cache Storage: ${listed(page.caches, cache => `${cache.name} (${cache.entries} entries)`)}`,
		`- Service workers: ${listed(page.serviceWorkers, worker => `${worker.scope} (${worker.state}${worker.controlling ? ', controls this page' : ''}${worker.waiting ? ', an update waits to activate' : ''}; ${worker.script.split('/').pop()})`)}`,
		...(page.quota ? [`- Quota: ${bytes(page.quota.usage)} used of ${bytes(page.quota.quota)}`] : []),
	];
}

function inspectLines(found: IInspected): string[] {
	const [x, y, w, h] = found.box;
	return [
		`### Element ${found.element} (${found.ref})`,
		`- Box: x ${x}, y ${y}, ${w}×${h} CSS px${found.inViewport ? '' : ' · outside the viewport'}${!w || !h ? ' · has no size' : ''}`,
		...(found.covered ? [`- Covered at its center by ${found.covered}: clicks land there, not on this element`] : []),
		...(found.overflow ? [`- Content overflows: scroll ${found.overflow.scroll.join('×')} in client ${found.overflow.client.join('×')}`] : []),
		...(found.text ? [`- Text: ${JSON.stringify(found.text)}`] : []),
		...(found.attributes.length ? [`- Attributes: ${found.attributes.join(' ')}`] : []),
		'- Computed (non-default):',
		...Object.entries(found.styles).map(([prop, value]) => `  ${prop}: ${value}`),
		`- Matching rules${found.rules.length ? '' : ': none in readable stylesheets'}${found.blockedSheets ? ` (${found.blockedSheets} cross-origin sheet${found.blockedSheets === 1 ? '' : 's'} not readable)` : ''}:`,
		...found.rules.map(rule => `  ${rule.selector} { ${rule.declarations} } · ${rule.sheet}`),
	];
}

function performanceLines(perf: IPerformance): string[] {
	const ms = (value: number | undefined) => value === undefined ? '?' : `${value} ms`;
	return [
		`### Performance of ${perf.url}`,
		`- Load: TTFB ${ms(perf.ttfb)} · DOMContentLoaded ${ms(perf.domContentLoaded)} · load ${ms(perf.load)}`,
		`- Paint: FCP ${ms(perf.fcp)} · LCP ${ms(perf.lcp)} · CLS ${perf.cls}`,
		`- Resources: ${perf.resources}, ${perf.transferKB} KB transferred · DOM ${perf.domNodes} elements${perf.heapMB !== undefined ? ` · JS heap ${perf.heapMB} MB` : ''}`,
		...(perf.slowest.length ? ['- Slowest:', ...perf.slowest.map(entry => `  ${entry.ms} ms ${entry.type} ${entry.url}`)] : []),
		...(perf.largest.length ? ['- Largest:', ...perf.largest.map(entry => `  ${entry.kb} KB ${entry.type} ${entry.url}`)] : []),
	];
}

/**
 * `browser_devtools`: the Application, Elements and Performance panels as one tool, so debugging a
 * stale cache, a broken session or a layout bug is one call with a short answer, not a hand-written
 * browser_evaluate script per question.
 */
export async function runDevtools(view: VoltBrowserView, args: Record<string, unknown>, host: IDevtoolsHost, token: CancellationToken): Promise<IVoltHostToolResult> {
	switch (args.action) {
		case 'storage': {
			const filter = str(args.filter);
			const [page, site] = await Promise.all([host.run<IPageStorage>(pageStorageScript(filter), token), view.siteDataForAgent().catch(() => undefined)]);
			return { text: storageLines(page, site, filter, args.reveal === true).join('\n') };
		}
		case 'clear': {
			const wanted = Array.isArray(args.what) ? args.what.filter((item): item is string => typeof item === 'string') : [];
			const kinds: VoltSiteDataKind[] = !wanted.length || wanted.includes('all') ? [...VOLT_SITE_DATA_KINDS] : VOLT_SITE_DATA_KINDS.filter(kind => wanted.includes(kind));
			if (!kinds.length) {
				return { error: `clear takes \`what\` from ${[...VOLT_SITE_DATA_KINDS, 'all'].join(', ')}.` };
			}
			const origin = (() => {
				try {
					return new URL(view.pageUrl).origin;
				} catch {
					return view.pageUrl;
				}
			})();
			if (kinds.includes('storage')) {
				// Session storage lives in the tab, and a file: page's local storage has no origin to clear by.
				await host.run(clearPageStorageScript(!/^https?:/i.test(view.pageUrl)), token);
			}
			if (!await view.clearSiteForAgent(kinds)) {
				return { error: 'The page is not ready, so its data was not cleared. Wait for it to load (browser_wait_for), then try again.' };
			}
			const reload = args.reload !== false;
			if (reload) {
				await view.historyForAgent('reload-fresh', token);
			}
			return {
				text: [
					'### Action: clear site data',
					`- Site: ${origin}`,
					`- Cleared: ${kinds.join(', ')}${kinds.includes('http_cache') ? ' (the HTTP cache is the whole browser profile\'s)' : ''}`,
					`- Reloaded: ${reload ? 'yes, skipping the cache' : 'no'}`,
					...(reload ? ['', ...await host.pageState()] : []),
				].join('\n'),
			};
		}
		case 'set_storage': {
			const key = str(args.key);
			if (!key) {
				return { error: 'set_storage needs `key` (and `value`, or none to remove it).' };
			}
			const area = args.area === 'session' ? 'session' : 'local';
			const value = typeof args.value === 'string' ? args.value : undefined;
			const result = await host.run<{ before: string | null }>(setStorageScript(area, key, value), token);
			return { text: [`### Action: ${value === undefined ? 'remove' : 'set'} ${area}Storage key`, `- Key: ${key}`, `- Before: ${result.before === null ? 'not set' : JSON.stringify(result.before)}`, ...(value !== undefined ? [`- Now: ${JSON.stringify(value.length > 160 ? `${value.slice(0, 160)}…` : value)}`] : []), '- Reload (browser_reload) if the page reads it only at start.'].join('\n') };
		}
		case 'hard_reload':
			await view.historyForAgent('reload-fresh', token);
			return { text: ['### Action: reload, skipping the cache', '', ...await host.pageState()].join('\n') };
		case 'inspect': {
			const ref = str(args.ref);
			const selector = str(args.selector);
			if (!ref && !selector) {
				return { error: 'inspect needs `ref` (from browser_snapshot) or `selector`.' };
			}
			const found = await host.run<IInspected>(inspectElementScript(ref, selector), token);
			if (found.missing) {
				return { error: ref ? `Ref ${ref} is not on the page anymore. Call browser_snapshot and use a current ref.` : `No element matches ${selector}.` };
			}
			return { text: inspectLines(found).join('\n') };
		}
		case 'performance':
			return { text: performanceLines(await host.run<IPerformance>(PERFORMANCE_SCRIPT, token)).join('\n') };
		case 'open':
			return view.openDevToolsForUser()
				? { text: 'DevTools are open beside the page for the user. You cannot read the panel: use the other browser_devtools actions for what it shows.' }
				: { error: 'Open a page first (browser_navigate).' };
	}
	return { error: 'browser_devtools needs `action`: storage, clear, set_storage, hard_reload, inspect, performance or open.' };
}
