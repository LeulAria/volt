/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A board saved in a project: `<name>.scratch`, tab-indented JSON so a diff reads in review. The
 * same shape as the older "Save Board File" export (`type`, `version`, `title`, `elements`,
 * `settings`), plus `assets`: the pasted images as base64, so the board opens anywhere.
 */

export const SCRATCH_FILE_EXTENSION = '.scratch';
export const SCRATCH_FILE_TYPE = 'volt-scratch';
const SCRATCH_FILE_VERSION = 1;

export interface IScratchFileAsset {
	readonly mime: string;
	/** Base64 bytes. */
	readonly data: string;
}

export interface IScratchFileContent {
	readonly title: string;
	/** Board elements as the board stores them; parseBoardDocument checks them on the way in. */
	readonly elements: readonly unknown[];
	readonly settings: unknown;
	/** assetId → image, for the image elements. */
	readonly assets: Readonly<Record<string, IScratchFileAsset>>;
}

export function serializeScratchFile(content: IScratchFileContent): string {
	const assets = Object.keys(content.assets).length ? { assets: content.assets } : {};
	return `${JSON.stringify({ type: SCRATCH_FILE_TYPE, version: SCRATCH_FILE_VERSION, title: content.title, elements: content.elements, settings: content.settings, ...assets }, null, '\t')}\n`;
}

/** Undefined when the text is not a board file (another JSON, a newer format, or not JSON). */
export function parseScratchFile(text: string): IScratchFileContent | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return undefined;
	}
	const v = raw as Record<string, unknown>;
	if (v.type !== SCRATCH_FILE_TYPE || !Array.isArray(v.elements) || (typeof v.version === 'number' && v.version > SCRATCH_FILE_VERSION)) {
		return undefined;
	}
	const assets: Record<string, IScratchFileAsset> = {};
	if (v.assets && typeof v.assets === 'object' && !Array.isArray(v.assets)) {
		for (const [id, asset] of Object.entries(v.assets as Record<string, unknown>)) {
			const a = asset as Partial<IScratchFileAsset> | null;
			if (a && typeof a.mime === 'string' && typeof a.data === 'string' && /^[A-Za-z0-9._-]+$/.test(id)) {
				assets[id] = { mime: a.mime, data: a.data };
			}
		}
	}
	return {
		title: typeof v.title === 'string' ? v.title.slice(0, 500) : '',
		elements: v.elements,
		settings: v.settings,
		assets,
	};
}

/** The asset ids the image elements use. */
export function scratchAssetIds(elements: readonly unknown[]): string[] {
	const ids = new Set<string>();
	for (const el of elements) {
		const e = el as { type?: unknown; assetId?: unknown } | null;
		if (e?.type === 'image' && typeof e.assetId === 'string' && e.assetId) {
			ids.add(e.assetId);
		}
	}
	return [...ids];
}
