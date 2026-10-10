/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IPageExpectation, IPageLocator, IPageNode, IPageView } from './pageModel.js';

/**
 * A simulator's or emulator's screen as the agent reads it: the platform's accessibility tree
 * (Android uiautomator XML, iOS AXe/idb JSON) turned into the same role/name/state nodes the
 * browser uses, so devices get the same compact outline, diffs and locators as web pages. Layout
 * containers are flattened, offscreen nodes dropped, and a tappable row is named by its text.
 */

export type DeviceBox = readonly [number, number, number, number];

/** One element on screen, in document order; boxes are in the device's input units (Android px, iOS points). */
export interface IDeviceElement extends IPageNode {
	readonly box: DeviceBox;
	/** Android resource-id (its last part), iOS accessibility identifier. */
	readonly id?: string;
	readonly clickable?: boolean;
	readonly editable?: boolean;
	readonly scrollable?: boolean;
	/** A password field: its value is never shown. */
	readonly secret?: boolean;
	/** Visible text of the element and everything under it, for text matching. */
	readonly text: string;
	/** Index of the nearest kept ancestor in the element list (-1 at the top). */
	readonly up: number;
	/** Desktop: the helper's handle, to act on the element through accessibility instead of a click. */
	readonly handle?: string;
}

export interface IDeviceScreen {
	/** The foreground app (Android package; iOS the application's label). */
	readonly app: string;
	readonly elements: readonly IDeviceElement[];
	/** The screen's size in input units (the root's box). */
	readonly width: number;
	readonly height: number;
}

/** A node as the platform reported it, before naming, roles and flattening. */
interface IRawNode {
	readonly cls: string;
	readonly text: string;
	readonly desc: string;
	readonly id: string;
	readonly hint: string;
	readonly pkg: string;
	readonly box: DeviceBox;
	readonly clickable: boolean;
	readonly checkable: boolean;
	readonly checked: boolean;
	readonly enabled: boolean;
	readonly focused: boolean;
	readonly selected: boolean;
	readonly scrollable: boolean;
	readonly password: boolean;
	/** iOS and the desktop: the platform already told us the role. */
	readonly role?: string;
	readonly value?: string;
	readonly handle?: string;
	readonly children: IRawNode[];
}

/** Where a screen comes from: Android and iOS devices, or an app on the desktop (macOS accessibility). */
export type ScreenPlatform = 'android' | 'ios' | 'desktop';

//#region Parsing

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };

function decode(value: string): string {
	return value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, entity: string) => {
		if (entity[0] === '#') {
			const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
		}
		return ENTITIES[entity] ?? whole;
	});
}

function parseBounds(value: string | undefined): DeviceBox {
	const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(value ?? '');
	if (!m) {
		return [0, 0, 0, 0];
	}
	const [x1, y1, x2, y2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
	return [x1, y1, x2 - x1, y2 - y1];
}

/** Android's `uiautomator dump`: nested `<node attr="…">` elements. */
export function parseUiautomator(xml: string): IRawNode | undefined {
	const root: IRawNode = { cls: 'hierarchy', text: '', desc: '', id: '', hint: '', pkg: '', box: [0, 0, 0, 0], clickable: false, checkable: false, checked: false, enabled: true, focused: false, selected: false, scrollable: false, password: false, children: [] };
	const stack: IRawNode[] = [root];
	const tag = /<(\/?)node\b([^>]*?)(\/?)>/g;
	for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
		if (m[1]) {
			if (stack.length > 1) {
				stack.pop();
			}
			continue;
		}
		const attrs: Record<string, string> = {};
		for (const a of m[2].matchAll(/([\w:-]+)="([^"]*)"/g)) {
			attrs[a[1]] = decode(a[2]);
		}
		const yes = (name: string) => attrs[name] === 'true';
		const node: IRawNode = {
			cls: attrs.class ?? '',
			text: attrs.text ?? '',
			desc: attrs['content-desc'] ?? '',
			id: (attrs['resource-id'] ?? '').replace(/^.*:id\//, ''),
			hint: attrs.hint ?? '',
			pkg: attrs.package ?? '',
			box: parseBounds(attrs.bounds),
			clickable: yes('clickable') || yes('long-clickable'),
			checkable: yes('checkable'),
			checked: yes('checked'),
			enabled: attrs.enabled !== 'false',
			focused: yes('focused'),
			selected: yes('selected'),
			scrollable: yes('scrollable'),
			password: yes('password'),
			children: [],
		};
		stack[stack.length - 1].children.push(node);
		if (!m[3]) {
			stack.push(node);
		}
	}
	return root.children.length ? root : undefined;
}

const IOS_ROLES: Record<string, string> = {
	button: 'button', link: 'link', statictext: 'text', text: 'text', textfield: 'textbox', searchfield: 'searchbox', textview: 'textbox', securetextfield: 'textbox',
	switch: 'switch', toggle: 'switch', slider: 'slider', stepper: 'spinbutton', image: 'img', icon: 'img', cell: 'listitem', table: 'list', collectionview: 'list',
	tab: 'tab', tabbar: 'tablist', segmentedcontrol: 'tablist', navigationbar: 'banner', heading: 'heading', checkbox: 'checkbox', radiobutton: 'radio', picker: 'combobox',
	popupbutton: 'combobox', menuitem: 'menuitem', progressindicator: 'progressbar', alert: 'alertdialog', sheet: 'dialog', scrollview: 'region', keyboard: 'group', key: 'button',
};

/** iOS `axe describe-ui` / `idb ui describe-all --json`: a JSON element tree (or a flat list) with frames in points. */
export function parseIosTree(json: string): IRawNode | undefined {
	let data: unknown;
	try {
		data = JSON.parse(json.slice(Math.max(0, Math.min(...['[', '{'].map(c => json.indexOf(c)).filter(i => i >= 0)))));
	} catch {
		return undefined;
	}
	const toNode = (raw: Record<string, unknown>): IRawNode => {
		const typeName = String(raw.type ?? raw.role_description ?? raw.role ?? '').replace(/^AX/, '').replace(/\s+/g, '').toLowerCase();
		const frame = raw.frame as { x?: number; y?: number; width?: number; height?: number } | undefined;
		const axFrame = typeof raw.AXFrame === 'string' ? /\{\{(-?[\d.]+),\s*(-?[\d.]+)\},\s*\{(-?[\d.]+),\s*(-?[\d.]+)\}\}/.exec(raw.AXFrame) : null;
		const box: DeviceBox = frame && typeof frame.x === 'number'
			? [frame.x, frame.y ?? 0, frame.width ?? 0, frame.height ?? 0]
			: axFrame ? [Number(axFrame[1]), Number(axFrame[2]), Number(axFrame[3]), Number(axFrame[4])] : [0, 0, 0, 0];
		const value = raw.AXValue === null || raw.AXValue === undefined ? undefined : String(raw.AXValue);
		const role = IOS_ROLES[typeName];
		const checkable = role === 'switch' || role === 'checkbox' || role === 'radio';
		const kids = Array.isArray(raw.children) ? raw.children as Record<string, unknown>[] : [];
		return {
			cls: typeName,
			text: '',
			desc: String(raw.AXLabel ?? raw.title ?? '') || '',
			id: String(raw.AXUniqueId ?? raw.identifier ?? '') || '',
			hint: String(raw.placeholder ?? raw.AXPlaceholderValue ?? '') || '',
			pkg: typeName === 'application' ? String(raw.AXLabel ?? '') : '',
			box,
			clickable: role === 'button' || role === 'link' || role === 'listitem' || role === 'tab' || role === 'menuitem' || checkable,
			checkable,
			checked: checkable && (value === '1' || value === 'true' || value === 'on'),
			enabled: raw.enabled !== false,
			focused: raw.focused === true || raw.has_keyboard_focus === true,
			selected: raw.selected === true,
			scrollable: role === 'list' || role === 'region',
			password: typeName === 'securetextfield',
			role,
			value: checkable ? undefined : value,
			children: kids.map(toNode),
		};
	};
	const list = Array.isArray(data) ? data as Record<string, unknown>[] : [data as Record<string, unknown>];
	const children = list.filter(item => item && typeof item === 'object').map(toNode);
	if (!children.length) {
		return undefined;
	}
	return { cls: 'hierarchy', text: '', desc: '', id: '', hint: '', pkg: children[0].pkg, box: children[0].box, clickable: false, checkable: false, checked: false, enabled: true, focused: false, selected: false, scrollable: false, password: false, children };
}

//#endregion

//#region Elements

function androidRole(node: IRawNode): string | undefined {
	const c = node.cls.slice(node.cls.lastIndexOf('.') + 1);
	if (/EditText|AutoCompleteTextView|SearchAutoComplete/.test(c)) { return 'textbox'; }
	if (/CheckBox|CheckedTextView/.test(c)) { return 'checkbox'; }
	if (/Switch|ToggleButton/.test(c)) { return 'switch'; }
	if (/RadioButton/.test(c)) { return 'radio'; }
	if (/SeekBar|Slider/.test(c)) { return 'slider'; }
	if (/ProgressBar/.test(c)) { return 'progressbar'; }
	if (/Spinner/.test(c)) { return 'combobox'; }
	if (/Button/.test(c)) { return 'button'; }
	if (/WebView/.test(c)) { return 'document'; }
	if (node.checkable) { return 'checkbox'; }
	if (node.clickable) { return /TextView/.test(c) && /^(Tab|.*Tab.*)$/.test(c) ? 'tab' : 'button'; }
	if (/RecyclerView|ListView|GridView/.test(c)) { return 'list'; }
	if (node.scrollable) { return 'region'; }
	if (/ImageView/.test(c)) { return node.desc ? 'img' : undefined; }
	if (/TextView/.test(c)) { return node.text || node.desc ? 'text' : undefined; }
	return node.desc ? 'text' : undefined;
}

const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch', 'combobox', 'slider', 'spinbutton', 'tab', 'menuitem', 'listitem']);

function clean(value: string, max = 100): string {
	// Icon fonts draw with private-use characters; they read as nothing.
	const text = value.replace(/[\uE000-\uF8FF\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim().replace(/^[,\s]+|[,\s]+$/g, '');
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Text a person sees in this node and its descendants, in order. */
function visibleTexts(node: IRawNode, out: string[] = []): string[] {
	const own = node.role === 'textbox' || /EditText/.test(node.cls) ? '' : clean(node.text || node.desc);
	if (own) {
		out.push(own);
	}
	for (const child of node.children) {
		visibleTexts(child, out);
	}
	return out;
}

function hasInteractive(node: IRawNode, platform: ScreenPlatform): boolean {
	return node.children.some(child => {
		const role = platform !== 'android' ? child.role : androidRole(child);
		return (role !== undefined && INTERACTIVE.has(role) && role !== 'listitem') || hasInteractive(child, platform);
	});
}

/** Stable refs per device: the same element keeps its ref across dumps, so diffs can follow it. */
export class DeviceRefs {
	private readonly refs = new Map<string, string>();
	private next = 0;

	refFor(key: string): string {
		let ref = this.refs.get(key);
		if (!ref) {
			ref = `d${this.next++}`;
			this.refs.set(key, ref);
		}
		return ref;
	}
}

/**
 * Flattens the raw tree: wrappers without a role or text disappear, offscreen nodes go, a tappable
 * container without its own label takes its text (and, with nothing tappable inside, hides the
 * text children it was named by), and text fields take their hint or the label beside them.
 */
export function readDeviceScreen(raw: IRawNode, platform: ScreenPlatform, refs: DeviceRefs): IDeviceScreen {
	const elements: IDeviceElement[] = [];
	const screen = raw.children[0]?.box ?? raw.box;
	const app = raw.children.find(child => child.pkg)?.pkg ?? raw.pkg ?? '';
	const roleOf = (node: IRawNode) => platform !== 'android' ? node.role : androidRole(node);
	const occurrences = new Map<string, number>();
	const walk = (node: IRawNode, depth: number, up: number, parentRef: string, labelBefore: string) => {
		const [, , w, h] = node.box;
		if (node !== raw && (w <= 0 || h <= 0)) {
			return;
		}
		let role = node === raw ? undefined : roleOf(node);
		const editable = role === 'textbox' || role === 'searchbox';
		let name = '';
		let value: string | undefined;
		let leaf = false;
		if (editable) {
			value = node.value ?? (node.text && node.text !== node.hint ? node.text : undefined);
			name = clean(node.desc || node.hint || labelBefore || node.id.replace(/_/g, ' '));
		} else if (role) {
			name = clean(node.desc || node.text || (platform !== 'android' && role !== 'text' ? node.value ?? '' : ''));
			if (INTERACTIVE.has(role)) {
				if (!name) {
					// A tappable row named by what it shows: "Network & internet, Mobile, Wi-Fi, hotspot".
					name = clean(visibleTexts(node).map(text => clean(text)).filter(Boolean).slice(0, 3).join(', '), 120);
				}
				// Nothing tappable inside: its text children only repeat its name.
				leaf = !hasInteractive(node, platform);
			}
			if (role === 'text' && !name) {
				role = undefined;
			}
		}
		const texts = clean(visibleTexts(node).join(' '), 300);
		let index = up;
		let childDepth = depth;
		let childRef = parentRef;
		if (role) {
			const states: string[] = [];
			if (!node.enabled) { states.push('disabled'); }
			if (node.checkable) { states.push(node.checked ? 'checked' : 'unchecked'); }
			if (node.selected) { states.push('selected'); }
			if (node.focused) { states.push('focused'); }
			if (node.scrollable) { states.push('scrollable'); }
			const shown = node.password && value ? '•'.repeat(Math.min(8, value.length)) : value;
			// Keyed by meaning, not position: a row keeps its ref when the list scrolls.
			const base = `${role}|${name.slice(0, 60) || node.id}`;
			const nth = occurrences.get(base) ?? 0;
			occurrences.set(base, nth + 1);
			const ref = role === 'text' ? undefined : refs.refFor(`${base}#${nth}`);
			const element: IDeviceElement = {
				ref,
				role,
				name: name || undefined,
				depth,
				parent: parentRef,
				value: shown ? clean(shown, 200) : undefined,
				states: states.length ? states : undefined,
				box: node.box,
				id: node.id || undefined,
				clickable: node.clickable || INTERACTIVE.has(role) || undefined,
				editable: editable || undefined,
				scrollable: node.scrollable || undefined,
				secret: node.password || undefined,
				text: texts,
				up,
				handle: node.handle,
			};
			elements.push(element);
			index = elements.length - 1;
			childDepth = depth + 1;
			childRef = ref ?? parentRef;
		}
		if (leaf || role === 'text' || editable) {
			return;
		}
		let label = '';
		for (const child of node.children) {
			walk(child, childDepth, index, childRef, label);
			// The text just before a field is usually its label.
			const childRole = roleOf(child);
			label = childRole === 'text' || (!childRole && (child.text || child.desc)) ? clean(child.text || child.desc) : '';
		}
	};
	walk(raw, 0, -1, 'root', '');
	return { app, elements, width: screen[0] + screen[2], height: screen[1] + screen[3] };
}

//#region Desktop (macOS accessibility)

/** A node from the desktop helper (see `IVoltDesktopNode`), kept structural so this file stays platform-free. */
export interface IDesktopNode {
	readonly h: string;
	readonly role: string;
	readonly sub?: string;
	readonly title?: string;
	readonly desc?: string;
	readonly value?: string;
	readonly help?: string;
	readonly ph?: string;
	readonly id?: string;
	readonly disabled?: boolean;
	readonly focused?: boolean;
	readonly selected?: boolean;
	readonly f?: readonly [number, number, number, number];
	readonly c?: readonly IDesktopNode[];
}

const MAC_ROLES: Readonly<Record<string, string>> = {
	AXButton: 'button', AXMenuButton: 'button', AXDisclosureTriangle: 'button', AXColorWell: 'button', AXPopUpButton: 'combobox', AXComboBox: 'combobox',
	AXCheckBox: 'checkbox', AXRadioButton: 'radio', AXTextField: 'textbox', AXTextArea: 'textbox', AXDateField: 'textbox', AXStaticText: 'text',
	AXLink: 'link', AXImage: 'img', AXSlider: 'slider', AXIncrementor: 'spinbutton', AXTabGroup: 'tablist', AXRow: 'row', AXCell: 'cell',
	AXTable: 'table', AXOutline: 'list', AXList: 'list', AXBrowser: 'list', AXMenuItem: 'menuitem', AXMenuBarItem: 'menuitem', AXToolbar: 'toolbar',
	AXSheet: 'dialog', AXHeading: 'heading', AXWebArea: 'document', AXProgressIndicator: 'progressbar', AXLevelIndicator: 'meter', AXScrollArea: 'region',
};

/** Chrome that never helps an agent and only costs tokens. */
const MAC_SKIP = new Set(['AXScrollBar', 'AXGrowArea', 'AXValueIndicator', 'AXSplitter', 'AXMenuBar']);

function macRole(node: IDesktopNode): string | undefined {
	switch (node.sub) {
		case 'AXSearchField': return 'searchbox';
		case 'AXSecureTextField': return 'textbox';
		case 'AXSwitch': case 'AXToggle': return node.role === 'AXCheckBox' ? 'switch' : MAC_ROLES[node.role];
		case 'AXTabButton': return 'tab';
		case 'AXOutlineRow': return 'treeitem';
		case 'AXDialog': case 'AXSystemDialog': case 'AXFloatingWindow': return node.role === 'AXWindow' ? 'dialog' : MAC_ROLES[node.role];
	}
	return MAC_ROLES[node.role];
}

function desktopRaw(node: IDesktopNode, app: string): IRawNode | undefined {
	if (MAC_SKIP.has(node.role)) {
		return undefined;
	}
	const role = macRole(node);
	const checkable = role === 'checkbox' || role === 'radio' || role === 'switch';
	const textual = role === 'text' || role === 'heading';
	return {
		cls: node.role,
		// Static text carries its words in the value; controls in the title.
		text: textual ? node.value ?? node.title ?? '' : node.title ?? '',
		desc: node.desc ?? '',
		id: node.id ?? '',
		hint: node.ph ?? node.help ?? '',
		pkg: node.role === 'AXWindow' ? app : '',
		box: node.f ? [node.f[0], node.f[1], node.f[2], node.f[3]] : [0, 0, 0, 0],
		clickable: role !== undefined && role !== 'text' && role !== 'img' && role !== 'heading' && role !== 'region' && role !== 'table' && role !== 'list' && role !== 'document' && role !== 'tablist' && role !== 'toolbar' && role !== 'dialog' && role !== 'progressbar' && role !== 'meter',
		checkable,
		checked: checkable && (node.value === '1' || node.value === 'true'),
		enabled: !node.disabled,
		focused: !!node.focused,
		selected: !!node.selected || (role === 'tab' && node.value === '1'),
		scrollable: node.role === 'AXScrollArea',
		password: node.sub === 'AXSecureTextField',
		role,
		value: checkable || textual || role === 'tab' ? undefined : node.value,
		handle: node.h,
		children: (node.c ?? []).map(child => desktopRaw(child, app)).filter((child): child is IRawNode => !!child),
	};
}

/** An app window's accessibility tree from the desktop helper, as a screen. */
export function readDesktopScreen(tree: { readonly app: string; readonly root?: IDesktopNode }, refs: DeviceRefs): IDeviceScreen | undefined {
	const window = tree.root && desktopRaw(tree.root, tree.app);
	if (!window) {
		return undefined;
	}
	const raw: IRawNode = { cls: 'hierarchy', text: '', desc: '', id: '', hint: '', pkg: tree.app, box: window.box, clickable: false, checkable: false, checked: false, enabled: true, focused: false, selected: false, scrollable: false, password: false, children: [window] };
	return readDeviceScreen(raw, 'desktop', refs);
}

//#endregion

/** The screen as a page view, so the browser's outline, folding and diffs apply. */
export function deviceView(screen: IDeviceScreen): IPageView {
	return { doc: screen.app || 'device', url: screen.app, title: screen.app, nodes: screen.elements };
}

export function parseDeviceUi(format: 'uiautomator' | 'axe' | 'idb', data: string, refs: DeviceRefs): IDeviceScreen | undefined {
	const raw = format === 'uiautomator' ? parseUiautomator(data) : parseIosTree(data);
	return raw ? readDeviceScreen(raw, format === 'uiautomator' ? 'android' : 'ios', refs) : undefined;
}

//#endregion

//#region Locating

export type DeviceLocateResult =
	| { readonly element: IDeviceElement; readonly index: number; readonly count: number }
	| { readonly error: 'not-found' | 'ambiguous' | 'stale' | 'nth' | 'within-not-found' | 'within-ambiguous'; readonly count?: number; readonly candidates?: readonly IDeviceElement[] };

function norm(value: string | undefined): string {
	return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function tier(have: string | undefined, want: string, exact: boolean | undefined): number {
	if (!want) {
		return 3;
	}
	const h = norm(have);
	if (!h) {
		return 0;
	}
	if (h === want) {
		return 3;
	}
	if (exact) {
		return 0;
	}
	return h.startsWith(want) ? 2 : h.includes(want) ? 1 : 0;
}

function within(elements: readonly IDeviceElement[], index: number, container: number): boolean {
	for (let i = elements[index].up; i >= 0; i = elements[i].up) {
		if (i === container) {
			return true;
		}
	}
	return false;
}

/** The nearest tappable element at or above `index`: text taps go to the row or button holding it. */
function tappable(elements: readonly IDeviceElement[], index: number): number {
	for (let i = index; i >= 0; i = elements[i].up) {
		if (elements[i].clickable) {
			return i;
		}
	}
	return index;
}

/**
 * Finds one element like the in-page locator does: ref, role + name, text (promoted to the row or
 * button that holds it), label (fields), selector (the resource-id / accessibility id), within a
 * container, nth, exact. The best tier of matches wins; several equally good ones are ambiguous.
 */
export function locateOnDevice(elements: readonly IDeviceElement[], locator: IPageLocator): DeviceLocateResult {
	let scopes: (number | undefined)[] = [undefined];
	/** Flat layouts put a row's button beside the row, not in it: then "within" means the same row on screen. */
	let band: readonly [number, number] | undefined;
	if (locator.within) {
		const outer = locateOnDevice(elements, locator.within);
		if ('error' in outer) {
			return { error: outer.error === 'ambiguous' ? 'within-ambiguous' : 'within-not-found', candidates: outer.candidates, count: outer.count };
		}
		scopes = [];
		for (let i: number = outer.index; i >= 0; i = elements[i].up) {
			scopes.push(i);
		}
		scopes.push(-1);
		band = [outer.element.box[1], outer.element.box[1] + outer.element.box[3]];
	}
	if (locator.ref) {
		const index = elements.findIndex(element => element.ref === locator.ref);
		return index < 0 ? { error: 'stale' } : { element: elements[index], index, count: 1 };
	}
	for (const scope of scopes) {
		const found = new Map<number, number>();
		const inScope = (index: number) => {
			if (scope === -1) {
				const [, y, , h] = elements[index].box;
				const middle = y + h / 2;
				return !!band && middle >= band[0] && middle <= band[1];
			}
			return scope === undefined || index === scope || within(elements, index, scope);
		};
		const consider = (index: number, score: number) => {
			if (score > 0 && inScope(index) && score > (found.get(index) ?? 0)) {
				found.set(index, score);
			}
		};
		elements.forEach((element, index) => {
			if (locator.selector) {
				consider(index, element.id && norm(element.id) === norm(locator.selector) ? 3 : 0);
			} else if (locator.label || locator.placeholder) {
				if (element.editable || element.role === 'checkbox' || element.role === 'switch' || element.role === 'radio') {
					consider(index, tier(element.name, norm(locator.label ?? locator.placeholder), locator.exact));
				}
			} else if (locator.role) {
				const fits = element.role === locator.role || (locator.role === 'textbox' && element.role === 'searchbox') || (locator.role === 'button' && element.role === 'listitem');
				if (fits) {
					consider(index, tier(element.name, norm(locator.name), locator.exact));
				}
			} else if (locator.text) {
				const want = norm(locator.text);
				const own = Math.max(tier(element.name, want, locator.exact), element.role === 'text' ? 0 : tier(element.value, want, true));
				if (own) {
					consider(tappable(elements, index), own);
				}
			}
		});
		if (!found.size) {
			continue;
		}
		const best = Math.max(...found.values());
		let top = [...found.entries()].filter(([, score]) => score === best).map(([index]) => index);
		// The same target reached twice (a row and the text in it) counts once: keep the outer tappable.
		top = top.filter(index => !top.some(other => other !== index && within(elements, index, other) && elements[other].clickable));
		top.sort((a, b) => a - b);
		if (locator.nth !== undefined) {
			const i = locator.nth < 0 ? top.length + locator.nth : locator.nth;
			return i >= 0 && i < top.length ? { element: elements[top[i]], index: top[i], count: top.length } : { error: 'nth', count: top.length };
		}
		if (top.length > 1) {
			return { error: 'ambiguous', count: top.length, candidates: top.slice(0, 6).map(index => elements[index]) };
		}
		return { element: elements[top[0]], index: top[0], count: 1 };
	}
	return { error: locator.within ? 'within-not-found' : 'not-found' };
}

/** Whether the screen meets a postcondition, and what it shows instead when it does not. */
export function checkOnDevice(screen: IDeviceScreen, expectation: IPageExpectation): { readonly ok: boolean; readonly detail: string } {
	const fails: string[] = [];
	const all = norm(screen.elements.map(element => `${element.name ?? ''} ${element.role === 'text' ? '' : element.value ?? ''}`).join(' \n '));
	if (expectation.url && !screen.app.includes(expectation.url)) {
		fails.push(`the app is ${screen.app}`);
	}
	if (expectation.text && !all.includes(norm(expectation.text))) {
		fails.push(`${JSON.stringify(expectation.text)} is not on screen`);
	}
	if (expectation.textGone && all.includes(norm(expectation.textGone))) {
		fails.push(`${JSON.stringify(expectation.textGone)} is still on screen`);
	}
	if (expectation.target) {
		const found = locateOnDevice(screen.elements, expectation.target);
		const state = expectation.state ?? (expectation.value === undefined && expectation.count === undefined ? 'visible' : undefined);
		if (expectation.count !== undefined) {
			const n = 'error' in found ? (found.error === 'ambiguous' || found.error === 'nth' ? found.count ?? 0 : 0) : found.count;
			if (n !== expectation.count) {
				fails.push(`${n} matching elements, not ${expectation.count}`);
			}
		}
		if (state === 'hidden') {
			if (!('error' in found)) {
				fails.push('it is on screen');
			}
		} else if (state || expectation.value !== undefined) {
			if ('error' in found) {
				fails.push(found.error === 'ambiguous' ? `${found.count} elements match; make the target unique` : 'no element matches');
			} else {
				const states = found.element.states ?? [];
				const flags: Record<string, boolean> = {
					visible: true,
					enabled: !states.includes('disabled'),
					disabled: states.includes('disabled'),
					checked: states.includes('checked'),
					unchecked: states.includes('unchecked'),
					focused: states.includes('focused'),
					selected: states.includes('selected'),
					expanded: false,
					collapsed: false,
				};
				if (state && !flags[state]) {
					fails.push(`it is not ${state} (${states.join(', ') || 'no states'})`);
				}
				if (expectation.value !== undefined && norm(found.element.value) !== norm(expectation.value)) {
					fails.push(`its value is ${JSON.stringify(found.element.secret ? '(hidden)' : found.element.value ?? '')}`);
				}
			}
		}
	}
	return { ok: !fails.length, detail: fails.join('; ') };
}

//#endregion
