/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { GalleryTheme, ScreenFrameKind } from './galleryPages.js';

/**
 * What a screens_capture call asks for, checked and normalized before anything runs: where the
 * screens are (a web app, a simulator or emulator, a desktop window, image files), which screens,
 * and the variants of each (light and dark, per device or viewport). Pure, so it is unit tested.
 */

export type ScreensSource = 'web' | 'device' | 'window' | 'files';

export interface IScreenViewport {
	readonly id: string;
	readonly label: string;
	readonly width: number;
	readonly height: number;
	readonly mobile: boolean;
	/** Image pixels per CSS pixel. */
	readonly scale: number;
}

export const VIEWPORT_PRESETS: Readonly<Record<string, IScreenViewport>> = {
	phone: { id: 'phone', label: 'Phone', width: 390, height: 844, mobile: true, scale: 2 },
	tablet: { id: 'tablet', label: 'Tablet', width: 820, height: 1180, mobile: true, scale: 1.5 },
	laptop: { id: 'laptop', label: 'Laptop', width: 1280, height: 800, mobile: false, scale: 1 },
	desktop: { id: 'desktop', label: 'Desktop', width: 1440, height: 900, mobile: false, scale: 1 },
};

export interface IScreenSpec {
	readonly name: string;
	/** Web: a URL, or a path on `url`. */
	readonly url?: string;
	/** Device: a deep link, URL or app id to open. Window: the app to bring forward. */
	readonly open?: string;
	/** Steps that reach the screen (browser_act, device_act or desktop_act script). */
	readonly act?: string;
	/** Files: the image. */
	readonly path?: string;
	/** Text to wait for before the capture. */
	readonly wait?: string;
}

export interface IScreensPlan {
	readonly source: ScreensSource;
	readonly title: string;
	/** Web: where relative screen URLs resolve. */
	readonly base?: string;
	readonly screens: readonly IScreenSpec[];
	/** Undefined: as it is now (no switching). */
	readonly themes?: readonly GalleryTheme[];
	readonly viewports: readonly IScreenViewport[];
	/** Device names or ids; one empty entry is "the chat's device, or the only booted one". */
	readonly devices: readonly string[];
	readonly host?: string;
	readonly app?: string;
	readonly window?: string;
	/** Steps run once before the screens, e.g. signing in. */
	readonly setup?: string;
	/** Web: how many pages to add from the first page's navigation (0: none). */
	readonly discover: number;
	readonly fullPage: boolean;
	readonly look: boolean;
	readonly vars?: Readonly<Record<string, string>>;
	/** Extra wait after reaching each screen, ms. */
	readonly settleMs?: number;
}

/** Most shots one call takes; past it, the agent splits the work. */
export const MAX_SHOTS = 60;
export const MAX_SCREENS = 30;
export const MAX_DISCOVER = 30;
const DEFAULT_DISCOVER = 12;

function str(value: unknown, max = 2000): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

function isUrl(value: string | undefined): boolean {
	return !!value && /^(https?|file):\/\//i.test(value);
}

/** "localhost:3000" and "127.0.0.1:5173/x" as http URLs; anything with a scheme stays. */
export function normalizeBase(value: string): string {
	const raw = value.trim();
	if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) {
		return raw;
	}
	return `http://${raw.replace(/^\/+/, '')}`;
}

/** A screen's URL: absolute as given, else on `base`. Undefined when it cannot be resolved. */
export function resolveScreenUrl(base: string | undefined, url: string | undefined): string | undefined {
	if (!url) {
		return base;
	}
	if (isUrl(url)) {
		return url;
	}
	if (/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(url)) {
		return normalizeBase(url);
	}
	if (!base) {
		return undefined;
	}
	try {
		return new URL(url, base.endsWith('/') || /\/[^/]*\.[a-z\d]+$/i.test(base) ? base : `${base}/`).toString();
	} catch {
		return undefined;
	}
}

function parseThemes(value: unknown, source: ScreensSource): readonly GalleryTheme[] | undefined {
	if (Array.isArray(value)) {
		const themes = value.map(String).map(item => item.toLowerCase()).filter((item): item is GalleryTheme => item === 'light' || item === 'dark');
		return themes.length ? [...new Set(themes)] : undefined;
	}
	switch (typeof value === 'string' ? value.toLowerCase().trim() : undefined) {
		case 'light': return ['light'];
		case 'dark': return ['dark'];
		case 'both': return ['light', 'dark'];
		case 'current': case 'as-is': case 'none': return undefined;
	}
	// Web pages and devices can switch; a desktop window and files are shown as they are.
	return source === 'web' || source === 'device' ? ['light', 'dark'] : undefined;
}

function parseViewport(value: unknown): IScreenViewport | string {
	if (typeof value === 'string') {
		const key = value.toLowerCase().trim();
		const preset = VIEWPORT_PRESETS[key] ?? (key === 'mobile' ? VIEWPORT_PRESETS.phone : undefined);
		if (preset) {
			return preset;
		}
		const size = /^(\d{3,4})\s*[x\u00d7]\s*(\d{3,4})$/.exec(key);
		if (size) {
			const width = Number(size[1]);
			return { id: key, label: `${size[1]}×${size[2]}`, width, height: Number(size[2]), mobile: width < 600, scale: width < 600 ? 2 : 1 };
		}
		return `Unknown viewport "${value}": use phone, tablet, laptop, desktop, "1024x768" or { "width", "height" }.`;
	}
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		const width = typeof record.width === 'number' ? Math.round(record.width) : NaN;
		const height = typeof record.height === 'number' ? Math.round(record.height) : NaN;
		if (!(width >= 240 && width <= 3840 && height >= 240 && height <= 4320)) {
			return 'A viewport needs "width" (240-3840) and "height" (240-4320) in CSS px.';
		}
		const mobile = typeof record.mobile === 'boolean' ? record.mobile : width < 600;
		return { id: `${width}x${height}`, label: str(record.name, 40) ?? `${width}×${height}`, width, height, mobile, scale: mobile ? 2 : 1 };
	}
	return 'Pass viewports as names ("phone", "desktop") or { "width", "height" }.';
}

function parseScreen(value: unknown, index: number): IScreenSpec | string {
	if (typeof value === 'string') {
		// A bare string is a URL/path (web) or a deep link (device).
		return { name: value, url: value, open: value };
	}
	if (!value || typeof value !== 'object') {
		return `screens[${index}] must be an object like { "name": "Settings", "url": "/settings" }.`;
	}
	const record = value as Record<string, unknown>;
	const url = str(record.url);
	const open = str(record.open);
	const act = str(record.act, 8000);
	const path = str(record.path);
	const name = str(record.name, 80) ?? str(record.title, 80) ?? url ?? open ?? path?.replace(/^.*[\\/]/, '') ?? `Screen ${index + 1}`;
	return { name, url, open, act, path, wait: str(record.wait, 200) };
}

function sourceOf(args: Record<string, unknown>, screens: readonly IScreenSpec[]): ScreensSource | undefined {
	const explicit = str(args.source)?.toLowerCase();
	if (explicit === 'web' || explicit === 'device' || explicit === 'window' || explicit === 'files') {
		return explicit;
	}
	if (explicit === 'browser' || explicit === 'url' || explicit === 'site') {
		return 'web';
	}
	if (explicit === 'simulator' || explicit === 'emulator' || explicit === 'ios' || explicit === 'android') {
		return 'device';
	}
	if (explicit === 'desktop' || explicit === 'app') {
		return 'window';
	}
	if (explicit === 'images' || explicit === 'image' || explicit === 'file') {
		return 'files';
	}
	if (screens.length && screens.every(screen => screen.path && !screen.url && !screen.act)) {
		return 'files';
	}
	if (str(args.url) || screens.some(screen => isUrl(screen.url) || screen.url?.startsWith('/'))) {
		return 'web';
	}
	if (args.device !== undefined || args.devices !== undefined || str(args.app)) {
		return str(args.window) ? 'window' : 'device';
	}
	if (str(args.window)) {
		return 'window';
	}
	return undefined;
}

/** The call's arguments as a plan, or what is wrong with them in words the agent can act on. */
export function parseScreensArgs(args: Record<string, unknown>): IScreensPlan | { readonly error: string } {
	const rawScreens = Array.isArray(args.screens) ? args.screens : args.screens !== undefined ? [args.screens] : [];
	if (rawScreens.length > MAX_SCREENS) {
		return { error: `That is ${rawScreens.length} screens; one call takes up to ${MAX_SCREENS}. Split them over several calls.` };
	}
	const parsed = rawScreens.map(parseScreen);
	const bad = parsed.find((screen): screen is string => typeof screen === 'string');
	if (bad) {
		return { error: bad };
	}
	let screens = parsed as IScreenSpec[];
	const source = sourceOf(args, screens);
	if (!source) {
		return { error: 'Say where the screens are: "url" (a web app, e.g. http://localhost:3000), "device" (a booted simulator or emulator, see device_list), "window" (a desktop app) or screens with "path" (image files).' };
	}
	// A bare string meant a URL on the web and a deep link on a device; drop the other reading.
	screens = screens.map(screen => source === 'web' ? { ...screen, open: undefined } : source === 'device' || source === 'window' ? { ...screen, url: undefined } : screen);
	const title = str(args.title, 120) ?? (source === 'web' ? 'Screens' : source === 'device' ? 'App screens' : source === 'window' ? 'Window screens' : 'Images');
	const base = str(args.url) ? normalizeBase(str(args.url)!) : undefined;
	const discoverRaw = args.discover;
	const discover = source !== 'web' ? 0 : discoverRaw === true ? DEFAULT_DISCOVER : typeof discoverRaw === 'number' && discoverRaw > 0 ? Math.min(MAX_DISCOVER, Math.round(discoverRaw)) : 0;

	if (source === 'web') {
		if (!base && !screens.some(screen => isUrl(screen.url) || /^(localhost|127\.)/i.test(screen.url ?? ''))) {
			return { error: 'Web screens need "url" (e.g. http://localhost:3000), or a full URL on each screen.' };
		}
		const unresolved = screens.find(screen => screen.url && !resolveScreenUrl(base, screen.url));
		if (unresolved) {
			return { error: `"${unresolved.url}" is relative; pass "url" so it can be resolved.` };
		}
		if (!screens.length) {
			screens = [{ name: '' }];
		}
	} else if (source === 'files') {
		const missing = screens.find(screen => !screen.path);
		if (missing || !screens.length) {
			return { error: 'Image screens each need a "path" (PNG, JPEG or WebP).' };
		}
	} else if (!screens.length) {
		// The screen that is up now.
		screens = [{ name: source === 'window' ? (str(args.window, 80) ?? 'Window') : 'Current screen' }];
	}

	const themes = parseThemes(args.themes ?? args.theme, source);
	let viewports: IScreenViewport[] = [VIEWPORT_PRESETS.desktop];
	if (source === 'web' && args.viewports !== undefined) {
		const list = Array.isArray(args.viewports) ? args.viewports : [args.viewports];
		const out: IScreenViewport[] = [];
		for (const item of list.slice(0, 4)) {
			const viewport = parseViewport(item);
			if (typeof viewport === 'string') {
				return { error: viewport };
			}
			if (!out.some(existing => existing.id === viewport.id)) {
				out.push(viewport);
			}
		}
		if (out.length) {
			viewports = out;
		}
	}
	const devices = source !== 'device' ? [''] : Array.isArray(args.devices) ? args.devices.map(String).filter(Boolean).slice(0, 4) : Array.isArray(args.device) ? args.device.map(String).filter(Boolean).slice(0, 4) : [str(args.device) ?? ''];
	const variants = (themes?.length ?? 1) * (source === 'web' ? viewports.length : source === 'device' ? Math.max(1, devices.length) : 1);
	const shots = (screens.length + discover) * variants;
	if (shots > MAX_SHOTS) {
		return { error: `That is up to ${shots} shots (${screens.length + discover} screens × ${variants} variants); one call takes up to ${MAX_SHOTS}. Capture fewer screens, viewports or themes per call.` };
	}
	const vars = args.vars && typeof args.vars === 'object' && !Array.isArray(args.vars) ? Object.fromEntries(Object.entries(args.vars as Record<string, unknown>).map(([key, value]) => [key, String(value)])) : undefined;
	const settle = typeof args.settle_ms === 'number' && Number.isFinite(args.settle_ms) ? Math.max(0, Math.min(10_000, Math.round(args.settle_ms))) : undefined;
	return {
		source,
		title,
		...(base ? { base } : {}),
		screens,
		...(themes ? { themes } : {}),
		viewports: source === 'web' ? viewports : [],
		devices: devices.length ? devices : [''],
		...(str(args.host) ? { host: str(args.host) } : {}),
		...(str(args.app) ? { app: str(args.app) } : {}),
		...(str(args.window) ? { window: str(args.window) } : {}),
		...(str(args.setup, 8000) ? { setup: str(args.setup, 8000) } : {}),
		discover,
		fullPage: args.full_page === true,
		look: args.look === true,
		...(vars ? { vars } : {}),
		...(settle !== undefined ? { settleMs: settle } : {}),
	};
}

//#region Discovering pages

export interface INavLink {
	readonly href: string;
	readonly text: string;
}

/** Links that change state or leave the app; never followed when discovering pages. */
const UNSAFE_LINK = /log[- _]?out|sign[- _]?out|log[- _]?off|delete|remove|destroy|unsubscribe|revoke|reset|deactivate|\/api\/|\.(pdf|zip|gz|png|jpe?g|gif|svg|webp|csv|xlsx?|docx?|json|xml|txt|mp4|mov)(\?|#|$)/i;

/**
 * Which of the links read from a page's navigation to visit: same origin, not one that signs out
 * or deletes, not a file, one per path (query kept, hash dropped), not already a screen, in the
 * page's order. Named by their text, else their path.
 */
export function pickNavLinks(links: readonly INavLink[], base: string, limit: number, known: readonly string[]): IScreenSpec[] {
	let origin: string;
	try {
		origin = new URL(base).origin;
	} catch {
		return [];
	}
	const seen = new Set(known.map(url => keyOf(url)).filter(Boolean));
	const out: IScreenSpec[] = [];
	for (const link of links) {
		if (out.length >= limit) {
			break;
		}
		let url: URL;
		try {
			url = new URL(link.href, base);
		} catch {
			continue;
		}
		if (url.origin !== origin || !/^https?:$/.test(url.protocol) || UNSAFE_LINK.test(url.pathname + url.search) || UNSAFE_LINK.test(link.text)) {
			continue;
		}
		url.hash = '';
		const key = keyOf(url.toString());
		if (!key || seen.has(key)) {
			continue;
		}
		seen.add(key);
		const text = link.text.replace(/\s+/g, ' ').trim();
		out.push({ name: text && text.length <= 40 ? text : (url.pathname === '/' ? 'Home' : url.pathname), url: url.toString() });
	}
	return out;
}

function keyOf(href: string): string {
	try {
		const url = new URL(href);
		return `${url.origin}${url.pathname.replace(/\/+$/, '') || '/'}${url.search}`;
	} catch {
		return '';
	}
}

/**
 * Collects a page's navigation links in document order: nav, header, aside, menus and tab lists
 * first, then (when those have fewer than three) any link on the page. Runs in the page.
 */
export const NAV_LINKS_SCRIPT = `(() => {
	const pick = selector => Array.from(document.querySelectorAll(selector)).filter(a => {
		const r = a.getBoundingClientRect();
		return a.href && (r.width > 0 || r.height > 0 || a.closest('nav, [role=navigation], aside'));
	}).map(a => ({ href: a.href, text: (a.getAttribute('aria-label') || a.textContent || a.title || '').trim().slice(0, 80) }));
	const nav = pick('nav a[href], header a[href], aside a[href], [role=navigation] a[href], [role=menu] a[href], [role=tablist] a[href], [role=menubar] a[href]');
	return nav.length >= 3 ? nav : nav.concat(pick('a[href]'));
})()`;

//#endregion

//#region Variants and files

export interface IShotVariant {
	readonly id: string;
	readonly label: string;
	readonly theme?: GalleryTheme;
	/** Web. */
	readonly viewport?: IScreenViewport;
	/** Device query (name or id) as the agent gave it. */
	readonly device?: string;
}

function themeLabel(theme: GalleryTheme | undefined): string {
	return theme === 'dark' ? 'Dark' : theme === 'light' ? 'Light' : '';
}

/** The columns of the gallery: viewport or device first, then theme. */
export function shotVariants(plan: IScreensPlan, deviceLabels: readonly string[] = plan.devices): IShotVariant[] {
	const themes: (GalleryTheme | undefined)[] = plan.themes?.length ? [...plan.themes] : [undefined];
	const out: IShotVariant[] = [];
	if (plan.source === 'web') {
		for (const viewport of plan.viewports) {
			for (const theme of themes) {
				const label = plan.viewports.length > 1 ? [viewport.label, themeLabel(theme)].filter(Boolean).join(' · ') : themeLabel(theme) || viewport.label;
				out.push({ id: `${viewport.id}${theme ? `-${theme}` : ''}`, label, theme, viewport });
			}
		}
		return out;
	}
	if (plan.source === 'device') {
		plan.devices.forEach((device, index) => {
			for (const theme of themes) {
				const name = deviceLabels[index] || device || 'Device';
				const label = plan.devices.length > 1 ? [name, themeLabel(theme)].filter(Boolean).join(' · ') : themeLabel(theme) || name;
				out.push({ id: `d${index}${theme ? `-${theme}` : ''}`, label, theme, device });
			}
		});
		return out;
	}
	return [{ id: 'shot', label: plan.source === 'files' ? 'Image' : 'Screen' }];
}

export function slug(value: string, max = 40): string {
	return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z\d]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'screen';
}

/** `03-settings-dark.jpg`: sorted like the gallery, readable in a file list. */
export function shotFileName(index: number, screen: string, variant: IShotVariant, ext = 'jpg'): string {
	const parts = [String(index + 1).padStart(2, '0'), slug(screen)];
	if (variant.viewport && variant.label.includes('·')) {
		parts.push(slug(variant.viewport.id, 12));
	}
	if (variant.device !== undefined && variant.label.includes('·')) {
		parts.push(slug(variant.label.split('·')[0], 16));
	}
	if (variant.theme) {
		parts.push(variant.theme);
	}
	return `${parts.join('-')}.${ext}`;
}

/** The frame look for the gallery. */
export function frameKindOf(plan: IScreensPlan, shot?: { readonly width: number; readonly height: number }): ScreenFrameKind {
	switch (plan.source) {
		case 'web': {
			const viewport = plan.viewports[0];
			return !viewport ? 'desktop' : viewport.width < 600 ? 'phone' : viewport.mobile ? 'tablet' : 'desktop';
		}
		case 'device':
			return shot && shot.width / shot.height > 0.68 ? 'tablet' : 'phone';
		case 'window':
			return 'window';
		default:
			return 'image';
	}
}

//#endregion

//#region The report the agent reads

export interface IShotRecord {
	readonly screen: number;
	readonly variant: string;
	readonly file?: string;
}

export interface IScreenOutcome {
	readonly name: string;
	readonly detail?: string;
	readonly notes: readonly string[];
	readonly failure?: string;
}

export interface IScreensReport {
	readonly plan: IScreensPlan;
	readonly screens: readonly IScreenOutcome[];
	readonly shots: readonly IShotRecord[];
	readonly variants: readonly IShotVariant[];
	readonly folder?: string;
	readonly ms: number;
	readonly notes: readonly string[];
}

/** One compact block of text: what was captured and where it went, then only what needs attention. */
export function formatScreensReport(report: IScreensReport): string {
	const captured = report.screens.filter(screen => !screen.failure);
	const failed = report.screens.filter(screen => screen.failure);
	const variantNames = report.variants.map(variant => variant.label).join(' / ');
	const where = report.plan.source === 'web' ? (report.plan.base ?? 'the web app') : report.plan.source === 'device' ? 'the device' : report.plan.source === 'window' ? 'the window' : 'the images';
	const lines = [`Captured ${captured.length} screen${captured.length === 1 ? '' : 's'}${report.variants.length > 1 ? ` × ${variantNames}` : ''} (${report.shots.length} shots) of ${where} in ${(report.ms / 1000).toFixed(1)}s. They are shown to the user above your reply as a gallery they can browse; do not describe or list them unless asked.`];
	if (report.folder) {
		lines.push(`Saved in ${report.folder}/:`);
	}
	report.screens.forEach((screen, index) => {
		if (screen.failure) {
			return;
		}
		const files = report.shots.filter(shot => shot.screen === index && shot.file).map(shot => shot.file);
		const parts = [`${index + 1}. ${screen.name || '(page)'}${screen.detail ? ` (${screen.detail})` : ''}`];
		if (files.length) {
			parts.push(files.join(', '));
		}
		// allow-any-unicode-next-line
		lines.push([parts.join(': '), ...screen.notes.map(note => `⚠ ${note}`)].join(' — '));
	});
	if (failed.length) {
		lines.push('Not captured:', ...failed.map(screen => `- ${screen.name}: ${screen.failure}`));
	}
	lines.push(...report.notes);
	return lines.join('\n');
}

//#endregion
