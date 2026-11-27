/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath, isEqualOrParent } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { asJson, IRequestService } from '../../../../platform/request/common/request.js';
import type { VoltViewLocation } from '../../../services/voltPlugins/common/voltContributions.js';
import { voltLayoutGlyphSvg } from '../common/voltLayoutGlyphs.js';
import { voltIconStrokeSvg } from '../common/voltPluginDesign.js';
import type { VoltSlotId } from '../common/voltSlots.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

/** Aria Icons' public API (https://icons.leularia.com, github.com/LeulAria/Aria-Icons). */
export const ARIA_ICONS_API = 'https://icons.leularia.com/api/v1';

export interface IAriaIconHit {
	/** `lucide:house` */
	readonly id: string;
	readonly set: string;
	readonly name: string;
}

/**
 * Icons for plugin buttons, views and settings pages. A spec is one of:
 * - `aria:<set>:<name>`: an Aria Icons SVG, fetched once and kept (application storage);
 * - `codicon:<id>`: one of VS Code's codicons;
 * - `<path>.svg`: a file in the extension's folder.
 *
 * SVGs are drawn as a CSS mask over `currentColor`, so they follow the theme like codicons do and
 * never put the plugin's markup in the window.
 */
export const IVoltIconService = createDecorator<IVoltIconService>('voltIconService');

export interface IVoltIconService {
	readonly _serviceBrand: undefined;
	/** An element sized by CSS (`.volt-plugin-icon`); its glyph arrives when the SVG is loaded. */
	render(spec: string | undefined, extensionLocation?: URI, fallback?: ThemeIcon): HTMLElement;
	svg(spec: string, extensionLocation?: URI): Promise<string | undefined>;
	search(query: string, options?: { set?: string; limit?: number }): Promise<readonly IAriaIconHit[]>;
}

const STORAGE_PREFIX = 'volt.ariaIcon/';
const MAX_SVG = 64 * 1024;

/** Only an SVG document: no script, no event handlers, no external references. */
export function isSafeIconSvg(svg: string): boolean {
	return svg.length <= MAX_SVG
		&& /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(svg)
		&& !/<script|<foreignObject|\son[a-z]+\s*=|javascript:|(?:href|src)\s*=\s*["'](?!#)/i.test(svg);
}

export function voltIconMaskUrl(svg: string): string {
	return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
}

/** A small map of the window with `target` (a slot or a view location) marked, as an icon. */
export function renderVoltLayoutGlyph(target: VoltSlotId | VoltViewLocation): HTMLElement {
	const element = $('span.volt-plugin-icon.is-svg.volt-layout-glyph');
	element.setAttribute('aria-hidden', 'true');
	element.style.setProperty('--volt-plugin-icon', voltIconMaskUrl(voltLayoutGlyphSvg(target)));
	return element;
}

export class VoltIconService implements IVoltIconService {
	declare readonly _serviceBrand: undefined;

	private readonly memory = new Map<string, Promise<string | undefined>>();

	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@IStorageService private readonly storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) { }

	render(spec: string | undefined, extensionLocation?: URI, fallback: ThemeIcon = { id: 'extensions' }): HTMLElement {
		const element = $('span.volt-plugin-icon');
		element.setAttribute('aria-hidden', 'true');
		const codicon = spec?.startsWith('codicon:') ? spec.slice('codicon:'.length) : undefined;
		if (!spec || codicon) {
			element.classList.add(...ThemeIcon.asClassNameArray(codicon ? { id: codicon } : fallback));
			return element;
		}
		element.classList.add('is-svg');
		void this.svg(spec, extensionLocation).then(svg => {
			if (svg) {
				element.style.setProperty('--volt-plugin-icon', voltIconMaskUrl(svg));
			} else {
				element.classList.remove('is-svg');
				element.classList.add(...ThemeIcon.asClassNameArray(fallback));
			}
		});
		return element;
	}

	svg(spec: string, extensionLocation?: URI): Promise<string | undefined> {
		const key = spec.startsWith('aria:') ? spec : `${extensionLocation?.toString() ?? ''}#${spec}`;
		let pending = this.memory.get(key);
		if (!pending) {
			pending = (spec.startsWith('aria:') ? this.aria(spec.slice('aria:'.length)) : this.file(spec, extensionLocation)).then(svg => svg && isSafeIconSvg(svg) ? voltIconStrokeSvg(svg) : undefined, err => {
				this.logService.warn(`[volt] icon ${spec} could not be loaded: ${err}`);
				return undefined;
			});
			this.memory.set(key, pending);
			// A failed load is tried again next time.
			void pending.then(svg => { if (!svg) { this.memory.delete(key); } });
		}
		return pending;
	}

	private async aria(id: string): Promise<string | undefined> {
		const stored = this.storageService.get(STORAGE_PREFIX + id, StorageScope.APPLICATION);
		if (stored) {
			return stored;
		}
		const context = await this.requestService.request({ type: 'GET', url: `${ARIA_ICONS_API}/icon?id=${encodeURIComponent(id)}`, timeout: 10_000 }, CancellationToken.None);
		const body = await asJson<{ svg?: unknown }>(context);
		const svg = typeof body?.svg === 'string' ? body.svg : undefined;
		if (svg && isSafeIconSvg(svg)) {
			this.storageService.store(STORAGE_PREFIX + id, svg, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		return svg;
	}

	private async file(path: string, extensionLocation: URI | undefined): Promise<string | undefined> {
		if (!extensionLocation) {
			return undefined;
		}
		const resource = joinPath(extensionLocation, path);
		if (!isEqualOrParent(resource, extensionLocation)) {
			return undefined;
		}
		return (await this.fileService.readFile(resource, { limits: { size: MAX_SVG } })).value.toString();
	}

	async search(query: string, options?: { set?: string; limit?: number }): Promise<readonly IAriaIconHit[]> {
		const params = new URLSearchParams({ q: query, limit: String(options?.limit ?? 60) });
		if (options?.set) {
			params.set('set', options.set);
		}
		const context = await this.requestService.request({ type: 'GET', url: `${ARIA_ICONS_API}/search?${params.toString()}`, timeout: 10_000 }, CancellationToken.None);
		const body = await asJson<{ icons?: { id?: unknown; set?: unknown; name?: unknown }[] }>(context);
		return (body?.icons ?? []).flatMap(icon => typeof icon.id === 'string' && /^[a-z0-9-]+:[a-z0-9-]+$/.test(icon.id)
			? [{ id: icon.id, set: String(icon.set ?? ''), name: String(icon.name ?? '') }]
			: []);
	}
}
