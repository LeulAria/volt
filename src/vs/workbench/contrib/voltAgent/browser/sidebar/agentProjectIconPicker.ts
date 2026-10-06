/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentSnooze.css';
import '../media/agentProjectIcons.css';
import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import {
	deriveProjectColor,
	deriveProjectMonogram,
	normalizeMonogramLetters,
	PROJECT_ICON_IMAGE_SIZE,
	PROJECT_MONOGRAM_COLORS,
	VoltProjectIcon,
} from '../../common/agentProjectIcons.js';
import { createVoltSegmented } from '../ui/segmented/voltSegmented.js';
import { createProjectIcon, IVoltProjectIconService } from './agentProjectIconService.js';

/** Icons a project picks from: places, kinds of software, and a few marks. */
const PROJECT_CODICONS: readonly ThemeIcon[] = [
	Codicon.folder, Codicon.repo, Codicon.rocket, Codicon.beaker, Codicon.globe, Codicon.server,
	Codicon.database, Codicon.deviceMobile, Codicon.deviceDesktop, Codicon.terminal, Codicon.book, Codicon.flame,
	Codicon.zap, Codicon.heart, Codicon.star, Codicon.bug, Codicon.tools, Codicon.package,
	Codicon.cloud, Codicon.code, Codicon.symbolColor, Codicon.game, Codicon.github, Codicon.organization,
	Codicon.home, Codicon.briefcase, Codicon.lightbulb, Codicon.gear, Codicon.shield, Codicon.key,
	Codicon.graph, Codicon.pulse, Codicon.music, Codicon.fileMedia, Codicon.paintcan, Codicon.sparkle,
	Codicon.robot, Codicon.mortarBoard, Codicon.compass, Codicon.coffee, Codicon.squirrel, Codicon.layers,
];

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'];

type PickerTab = 'monogram' | 'icon' | 'image';

let openPicker: IDisposable | undefined;

/**
 * Change a project's icon: a monogram (letters and color), a codicon (with a tint), or a picture
 * from disk resized to 64px. Save stores it; Reset goes back to the default. The dialog uses the
 * Custom snooze dialog's card so the two read as one family.
 */
export function showProjectIconPicker(instantiationService: IInstantiationService, root: URI, name: string): void {
	instantiationService.invokeFunction(accessor => {
		const service = accessor.get(IVoltProjectIconService);
		const fileDialogs = accessor.get(IFileDialogService);
		const files = accessor.get(IFileService);
		const logService = accessor.get(ILogService);
		const host = accessor.get(IWorkbenchLayoutService).activeContainer;
		openPicker?.dispose();
		openPicker = renderPicker(host, root, name, service, fileDialogs, files, logService);
	});
}

function renderPicker(
	host: HTMLElement,
	root: URI,
	name: string,
	service: IVoltProjectIconService,
	fileDialogs: IFileDialogService,
	files: IFileService,
	logService: ILogService,
): IDisposable {
	const store = new DisposableStore();
	store.add(toDisposable(() => {
		if (openPicker === store) {
			openPicker = undefined;
		}
	}));
	const window = getWindow(host);
	const previousFocus = window.document.activeElement as HTMLElement | null;
	const close = () => store.dispose();

	const stored = service.get(root);
	let tab: PickerTab = stored?.kind === 'codicon' ? 'icon' : stored?.kind === 'image' ? 'image' : 'monogram';
	let letters = stored?.kind === 'monogram' ? stored.letters ?? '' : '';
	let monogramColor = stored?.kind === 'monogram' ? stored.color : undefined;
	let codicon = stored?.kind === 'codicon' ? stored.id : Codicon.folder.id;
	let codiconColor = stored?.kind === 'codicon' ? stored.color : undefined;
	let image = stored?.kind === 'image' ? stored.dataUrl : undefined;

	const layer = append(host, $('.volt-agent-snooze-layer.volt-project-icon-layer'));
	store.add(toDisposable(() => {
		layer.remove();
		previousFocus?.focus?.();
	}));
	const backdrop = append(layer, $('.volt-agent-snooze-backdrop'));
	const dialog = append(layer, $('.volt-agent-snooze-dialog.volt-project-icon-dialog'));
	dialog.setAttribute('role', 'dialog');
	dialog.setAttribute('aria-modal', 'true');
	dialog.tabIndex = -1;

	const body = append(dialog, $('.volt-agent-snooze-body'));
	const head = append(body, $('.volt-project-icon-head'));
	const preview = append(head, $('.volt-project-icon-preview'));
	const titles = append(head, $('.volt-project-icon-titles'));
	const title = append(titles, $('h2.volt-agent-snooze-title'));
	title.id = 'volt-project-icon-title';
	title.textContent = localize('voltAgent.projectIcon.title', "Project icon");
	dialog.setAttribute('aria-labelledby', title.id);
	append(titles, $('p.volt-agent-snooze-subtitle')).textContent = name;

	const closeButton = append(dialog, $('button.volt-agent-snooze-close')) as HTMLButtonElement;
	closeButton.type = 'button';
	closeButton.setAttribute('aria-label', localize('voltAgent.projectIcon.close', "Close"));
	closeButton.appendChild(renderIcon(Codicon.close));

	const tabs = createVoltSegmented<PickerTab>(append(body, $('.volt-agent-snooze-tabs')), [
		{ id: 'monogram', label: localize('voltAgent.projectIcon.monogram', "Monogram") },
		{ id: 'icon', label: localize('voltAgent.projectIcon.icon', "Icon") },
		{ id: 'image', label: localize('voltAgent.projectIcon.image', "Image") },
	], tab, next => {
		tab = next;
		sync();
	}, store, 'fill');

	// Monogram: the letters (blank derives them) and a tile color (Auto derives it).
	const monogramPane = append(body, $('.volt-project-icon-pane'));
	const lettersField = append(monogramPane, $('.volt-agent-snooze-field'));
	append(lettersField, $('span.volt-agent-snooze-label')).textContent = localize('voltAgent.projectIcon.letters', "Letters");
	const lettersInput = append(lettersField, $('input.volt-project-icon-input')) as HTMLInputElement;
	lettersInput.type = 'text';
	lettersInput.maxLength = 2;
	lettersInput.spellcheck = false;
	lettersInput.placeholder = deriveProjectMonogram(name);
	lettersInput.value = letters;
	lettersInput.setAttribute('aria-label', localize('voltAgent.projectIcon.letters', "Letters"));
	const monogramSwatches = swatchRow(monogramPane, localize('voltAgent.projectIcon.color', "Color"), deriveProjectColor(name), () => monogramColor, next => {
		monogramColor = next;
		sync();
	}, store);

	// Icon: a grid of codicons and a tint (Auto follows the sidebar's text color).
	const iconPane = append(body, $('.volt-project-icon-pane'));
	const grid = append(iconPane, $('.volt-project-icon-grid'));
	grid.setAttribute('role', 'listbox');
	grid.setAttribute('aria-label', localize('voltAgent.projectIcon.icons', "Icons"));
	const iconButtons = new Map<string, HTMLButtonElement>();
	for (const icon of PROJECT_CODICONS) {
		const button = append(grid, $('button.volt-project-icon-choice')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('role', 'option');
		button.setAttribute('aria-label', icon.id);
		button.title = icon.id;
		button.appendChild(renderIcon(icon));
		iconButtons.set(icon.id, button);
		store.add(addDisposableListener(button, 'click', () => {
			codicon = icon.id;
			sync();
		}));
	}
	const iconSwatches = swatchRow(iconPane, localize('voltAgent.projectIcon.tint', "Tint"), undefined, () => codiconColor, next => {
		codiconColor = next;
		sync();
	}, store);

	// Image: a picture from disk, drawn into a 64px square.
	const imagePane = append(body, $('.volt-project-icon-pane.volt-project-icon-image-pane'));
	const choose = append(imagePane, $('button.volt-agent-snooze-button')) as HTMLButtonElement;
	choose.type = 'button';
	choose.textContent = localize('voltAgent.projectIcon.chooseImage', "Choose Image…");
	const imageNote = append(imagePane, $('.volt-agent-snooze-preview'));
	imageNote.textContent = localize('voltAgent.projectIcon.imageNote', "PNG, JPEG, WebP, GIF or SVG. It is scaled to {0}×{0}.", PROJECT_ICON_IMAGE_SIZE);
	store.add(addDisposableListener(choose, 'click', async () => {
		const picked = await fileDialogs.showOpenDialog({
			title: localize('voltAgent.projectIcon.chooseImageTitle', "Choose a project image"),
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: [{ name: localize('voltAgent.projectIcon.images', "Images"), extensions: IMAGE_EXTENSIONS }],
		});
		const resource = picked?.[0];
		if (!resource || store.isDisposed) {
			return;
		}
		try {
			const content = await files.readFile(resource);
			image = await scaledImage(content.value.buffer, resource.path, window);
			imageNote.classList.remove('error');
			imageNote.textContent = resource.path.split('/').pop() ?? '';
		} catch (err) {
			logService.warn('[volt] project image could not be read', err);
			imageNote.classList.add('error');
			imageNote.textContent = localize('voltAgent.projectIcon.imageFailed', "That file could not be read as an image.");
		}
		sync();
	}));

	const footer = append(dialog, $('.volt-agent-snooze-footer.volt-project-icon-footer'));
	const reset = append(footer, $('button.volt-agent-snooze-button.volt-project-icon-reset')) as HTMLButtonElement;
	reset.type = 'button';
	reset.textContent = localize('voltAgent.projectIcon.reset', "Use Default");
	reset.disabled = !stored;
	const cancel = append(footer, $('button.volt-agent-snooze-button')) as HTMLButtonElement;
	cancel.type = 'button';
	cancel.textContent = localize('voltAgent.projectIcon.cancel', "Cancel");
	const save = append(footer, $('button.volt-agent-snooze-button.primary')) as HTMLButtonElement;
	save.type = 'button';
	save.textContent = localize('voltAgent.projectIcon.save', "Save");

	const current = (): VoltProjectIcon | undefined => {
		switch (tab) {
			case 'monogram': {
				const typed = normalizeMonogramLetters(letters);
				return { kind: 'monogram', ...(typed ? { letters: typed } : {}), ...(monogramColor ? { color: monogramColor } : {}) };
			}
			case 'icon': return { kind: 'codicon', id: codicon, ...(codiconColor ? { color: codiconColor } : {}) };
			case 'image': return image ? { kind: 'image', dataUrl: image } : undefined;
		}
	};
	const sync = () => {
		monogramPane.classList.toggle('hidden', tab !== 'monogram');
		iconPane.classList.toggle('hidden', tab !== 'icon');
		imagePane.classList.toggle('hidden', tab !== 'image');
		preview.replaceChildren(createProjectIcon(current() ?? { kind: 'monogram' }, name, 44));
		for (const [id, button] of iconButtons) {
			button.classList.toggle('selected', id === codicon);
			button.setAttribute('aria-selected', String(id === codicon));
		}
		monogramSwatches.sync();
		iconSwatches.sync();
		save.disabled = !current();
	};
	const submit = () => {
		const icon = current();
		if (!icon) {
			return;
		}
		service.set(root, icon);
		close();
	};

	store.add(addDisposableListener(lettersInput, 'input', () => {
		letters = lettersInput.value;
		sync();
	}));
	store.add(addDisposableListener(reset, 'click', () => {
		service.set(root, undefined);
		close();
	}));
	store.add(addDisposableListener(cancel, 'click', close));
	store.add(addDisposableListener(closeButton, 'click', close));
	store.add(addDisposableListener(backdrop, 'mousedown', close));
	store.add(addDisposableListener(save, 'click', submit));
	store.add(addDisposableListener(dialog, 'keydown', e => {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			close();
		} else if (e.key === 'Enter' && (e.target as HTMLElement | null)?.tagName !== 'BUTTON') {
			e.preventDefault();
			submit();
		}
	}));
	store.add(addDisposableListener(window.document, 'focusin', e => {
		if (e.target instanceof Node && !layer.contains(e.target)) {
			dialog.focus();
		}
	}, true));

	sync();
	window.requestAnimationFrame(() => tabs.sync());
	if (tab === 'monogram') {
		lettersInput.focus();
	} else {
		dialog.focus();
	}
	return store;
}

/** Auto, then the palette; `auto` is what Auto shows (undefined: the text color). */
function swatchRow(parent: HTMLElement, label: string, auto: string | undefined, get: () => string | undefined, set: (color: string | undefined) => void, store: DisposableStore): { sync(): void } {
	const field = append(parent, $('.volt-agent-snooze-field'));
	append(field, $('span.volt-agent-snooze-label')).textContent = label;
	const row = append(field, $('.volt-project-icon-swatches'));
	row.setAttribute('role', 'radiogroup');
	row.setAttribute('aria-label', label);
	const buttons: { readonly color: string | undefined; readonly button: HTMLButtonElement }[] = [];
	for (const color of [undefined, ...PROJECT_MONOGRAM_COLORS]) {
		const button = append(row, $('button.volt-project-icon-swatch')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('role', 'radio');
		if (color) {
			button.style.backgroundColor = color;
			button.setAttribute('aria-label', color);
		} else {
			button.classList.add('auto');
			if (auto) {
				button.style.setProperty('--volt-swatch-auto', auto);
			}
			const autoLabel = localize('voltAgent.projectIcon.auto', "Auto");
			button.setAttribute('aria-label', autoLabel);
			button.title = autoLabel;
		}
		buttons.push({ color, button });
		store.add(addDisposableListener(button, 'click', () => set(color)));
	}
	return {
		sync: () => {
			const value = get();
			for (const { color, button } of buttons) {
				button.classList.toggle('selected', color === value);
				button.setAttribute('aria-checked', String(color === value));
			}
		},
	};
}

/** The picture drawn into a square (cover), as a PNG data URL. */
async function scaledImage(bytes: Uint8Array, path: string, targetWindow: Window = mainWindow): Promise<string> {
	const extension = path.split('.').pop()?.toLowerCase() ?? '';
	const type = extension === 'svg' ? 'image/svg+xml' : extension === 'jpg' ? 'image/jpeg' : `image/${extension}`;
	const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
	try {
		const element = targetWindow.document.createElement('img');
		await new Promise<void>((resolve, reject) => {
			element.onload = () => resolve();
			element.onerror = () => reject(new Error('image failed to load'));
			element.src = url;
		});
		const size = PROJECT_ICON_IMAGE_SIZE;
		const canvas = targetWindow.document.createElement('canvas');
		canvas.width = size;
		canvas.height = size;
		const context = canvas.getContext('2d');
		if (!context) {
			throw new Error('no 2d context');
		}
		const width = element.naturalWidth || size;
		const height = element.naturalHeight || size;
		const scale = Math.max(size / width, size / height);
		const drawWidth = width * scale;
		const drawHeight = height * scale;
		context.imageSmoothingQuality = 'high';
		context.drawImage(element, (size - drawWidth) / 2, (size - drawHeight) / 2, drawWidth, drawHeight);
		return canvas.toDataURL('image/png');
	} finally {
		URL.revokeObjectURL(url);
	}
}
