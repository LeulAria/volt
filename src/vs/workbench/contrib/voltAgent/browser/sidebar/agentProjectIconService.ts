/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentProjectIcons.css';
import { $ } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { monogramTextColor, projectIconKey, resolveMonogram, reviveProjectIcon, VoltProjectIcon } from '../../common/agentProjectIcons.js';

const STORAGE_KEY = 'volt.agent.projectIcons';

export const IVoltProjectIconService = createDecorator<IVoltProjectIconService>('voltProjectIconService');

/**
 * Each project's icon: a codicon, a picture, or a monogram (letters and color derived from the
 * name unless set). Kept per folder in application storage, so every window shows the same one.
 * Other UI (project settings, pickers) reads it here and draws it with {@link createProjectIcon}.
 */
export interface IVoltProjectIconService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	/** The icon the user chose; undefined means the default (the folder glyph, a monogram on the rail). */
	get(root: URI | string): VoltProjectIcon | undefined;
	set(root: URI | string, icon: VoltProjectIcon | undefined): void;
}

class VoltProjectIconService extends Disposable implements IVoltProjectIconService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private icons = new Map<string, VoltProjectIcon>();

	constructor(@IStorageService private readonly storageService: IStorageService) {
		super();
		this.icons = this.read();
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, STORAGE_KEY, this._store)(() => {
			this.icons = this.read();
			this._onDidChange.fire();
		}));
	}

	get(root: URI | string): VoltProjectIcon | undefined {
		return this.icons.get(keyOf(root));
	}

	set(root: URI | string, icon: VoltProjectIcon | undefined): void {
		const key = keyOf(root);
		const revived = icon ? reviveProjectIcon(icon) : undefined;
		if (revived) {
			this.icons.set(key, revived);
		} else if (!this.icons.delete(key)) {
			return;
		}
		this.storageService.store(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.icons)), StorageScope.APPLICATION, StorageTarget.USER);
		this._onDidChange.fire();
	}

	private read(): Map<string, VoltProjectIcon> {
		const icons = new Map<string, VoltProjectIcon>();
		try {
			const raw = JSON.parse(this.storageService.get(STORAGE_KEY, StorageScope.APPLICATION, '{}')) as Record<string, unknown>;
			for (const [key, value] of Object.entries(raw ?? {})) {
				const icon = reviveProjectIcon(value);
				if (icon) {
					icons.set(key, icon);
				}
			}
		} catch {
			// A damaged value starts over.
		}
		return icons;
	}
}

function keyOf(root: URI | string): string {
	return projectIconKey(typeof root === 'string' ? root : root.toString());
}

registerSingleton(IVoltProjectIconService, VoltProjectIconService, InstantiationType.Delayed);

/** A project icon at `size` pixels: the chosen codicon or picture, else a monogram tile. */
export function createProjectIcon(icon: VoltProjectIcon | undefined, name: string, size: number): HTMLElement {
	const element = $('span.volt-project-icon');
	element.style.setProperty('--volt-project-icon-size', `${size}px`);
	if (icon?.kind === 'image') {
		element.classList.add('kind-image');
		const image = document.createElement('img');
		image.src = icon.dataUrl;
		image.alt = '';
		image.draggable = false;
		element.appendChild(image);
		return element;
	}
	if (icon?.kind === 'codicon') {
		element.classList.add('kind-codicon');
		element.appendChild(renderIcon(ThemeIcon.fromId(icon.id)));
		if (icon.color) {
			element.classList.add('tinted');
			element.style.color = icon.color;
		}
		return element;
	}
	const monogram = resolveMonogram(name, icon);
	element.classList.add('kind-monogram');
	element.style.backgroundColor = monogram.color;
	element.style.color = monogramTextColor(monogram.color);
	element.textContent = monogram.letters;
	element.classList.toggle('two-letters', Array.from(monogram.letters).length > 1);
	return element;
}
