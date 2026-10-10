/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { VoltDeviceButton } from '../../../../../platform/voltDevices/common/voltDevices.js';
import { parseActScript } from '../../../../services/voltRuntime/common/tools/actScript.js';
import { DeviceRefs, IDeviceElement, IDeviceScreen, parseDeviceUi, readDesktopScreen } from '../../../../services/voltRuntime/common/tools/deviceUi.js';
import { IActStep } from '../../../../services/voltRuntime/common/tools/pageModel.js';
import { DeviceActRunner, IDeviceDriver } from '../../browser/devices/deviceAct.js';
import { formatActRun } from '../../browser/preview/browserAct.js';

interface IFakeElement {
	readonly type: string;
	readonly label: string;
	readonly value?: string;
	readonly frame: { x: number; y: number; width: number; height: number };
	readonly enabled?: boolean;
	readonly onTap?: () => void;
}

/**
 * A small iOS-like app behind the device driver: a home screen with a long list, a sign-in form
 * whose field drops the first keystrokes when typing starts before it has focus, and two rows with
 * the same "Delete" button. Screens are produced as AXe JSON, so they go through the real parser.
 */
class FakeApp implements IDeviceDriver {
	readonly platform = 'ios';
	private readonly refs = new DeviceRefs();
	screen: 'home' | 'signin' | 'done' = 'home';
	email = '';
	focused = false;
	/** Keystrokes the field loses the first time (it was not ready). */
	dropOnce = 0;
	alwaysDrop = 0;
	scroll = 0;
	remember = false;
	rows = ['Project A', 'Project B'];
	taps = 0;
	private elements: IFakeElement[] = [];

	private build(): IFakeElement[] {
		const at = (y: number, height = 44) => ({ x: 0, y, width: 390, height });
		if (this.screen === 'signin') {
			return [
				{ type: 'StaticText', label: 'Sign in', frame: at(60) },
				{ type: 'TextField', label: 'Email', value: this.email, frame: at(120), onTap: () => { this.focused = true; } },
				{ type: 'Switch', label: 'Remember me', value: this.remember ? '1' : '0', frame: at(180), onTap: () => { this.remember = !this.remember; } },
				{ type: 'Button', label: 'Continue', frame: at(240), enabled: this.email.includes('@'), onTap: () => { this.screen = 'done'; } },
			];
		}
		if (this.screen === 'done') {
			return [{ type: 'StaticText', label: `Welcome, ${this.email}`, frame: at(60) }];
		}
		const items = Array.from({ length: 30 }, (_, i) => `Item ${i + 1}`).map((label, i) => ({ type: 'Cell', label, frame: at(300 + i * 44 - this.scroll) })).filter(item => item.frame.y >= 300 && item.frame.y < 800);
		return [
			{ type: 'Button', label: 'Sign in', frame: at(60), onTap: () => { this.screen = 'signin'; } },
			...this.rows.map((row, i) => ({ type: 'Cell', label: row, frame: at(120 + i * 60, 50) })),
			...this.rows.map((row, i) => ({ type: 'Button', label: 'Delete', frame: { x: 300, y: 125 + i * 60, width: 80, height: 40 }, onTap: () => { this.rows = this.rows.filter(r => r !== row); } })),
			...items,
		];
	}

	async read(): Promise<IDeviceScreen> {
		this.elements = this.build();
		const json = [{
			type: 'Application', AXLabel: 'Fake', frame: { x: 0, y: 0, width: 390, height: 844 }, children: this.elements.map(e => ({
				type: e.type, AXLabel: e.label, AXValue: e.value ?? null, frame: e.frame, enabled: e.enabled !== false,
				focused: e.type === 'TextField' && this.focused, children: [],
			})),
		}];
		return parseDeviceUi('axe', JSON.stringify(json), this.refs)!;
	}

	async tap(x: number, y: number): Promise<void> {
		this.taps++;
		this.elements = this.build();
		// Rows hold their buttons: the smallest box under the point is the one tapped.
		const hit = this.elements.filter(e => x >= e.frame.x && x < e.frame.x + e.frame.width && y >= e.frame.y && y < e.frame.y + e.frame.height)
			.sort((a, b) => a.frame.width * a.frame.height - b.frame.width * b.frame.height)[0];
		if (hit?.enabled !== false) {
			hit?.onTap?.();
		}
	}

	async swipe(_x1: number, y1: number, _x2: number, y2: number): Promise<void> {
		this.scroll = Math.max(0, Math.min(30 * 44 - 500, this.scroll + (y1 - y2)));
	}

	async type(text: string): Promise<void> {
		if (!this.focused) {
			return;
		}
		const drop = this.alwaysDrop || this.dropOnce;
		this.dropOnce = 0;
		this.email += text.slice(drop);
	}

	async clear(count: number): Promise<void> {
		this.email = this.email.slice(0, Math.max(0, this.email.length - count));
	}

	async press(button: VoltDeviceButton): Promise<void> {
		if (button === 'back') {
			this.screen = 'home';
		}
	}

	async launch(): Promise<void> {
		this.screen = 'home';
	}
}

function script(text: string): readonly IActStep[] {
	const parsed = parseActScript(text);
	if ('error' in parsed) {
		throw new Error(parsed.error);
	}
	return parsed.steps;
}

/** A Mac window behind the desktop driver: presses and values go through accessibility handles. */
class FakeDesktop implements IDeviceDriver {
	readonly platform = 'desktop';
	private readonly refs = new DeviceRefs();
	readonly log: string[] = [];
	email = '';
	saved = false;
	opened = false;

	async read(): Promise<IDeviceScreen> {
		const node = (h: string, role: string, extra: Record<string, unknown>, y: number) => ({ h, role, f: [0, y, 300, 24] as [number, number, number, number], ...extra });
		const children = this.opened
			? [node('h1', 'AXTextField', { ph: 'Email', value: this.email }, 40), node('h2', 'AXButton', { title: 'Save', disabled: !this.email }, 80), ...(this.saved ? [node('h3', 'AXStaticText', { value: 'Saved' }, 120)] : [])]
			: [node('h4', 'AXButton', { title: 'New Contact' }, 40)];
		return readDesktopScreen({ app: 'Contacts', root: { h: 'h0', role: 'AXWindow', title: 'Contacts', f: [0, 0, 600, 400], c: children } }, this.refs)!;
	}

	async tap(x: number, y: number): Promise<void> {
		this.log.push(`click ${x},${y}`);
	}

	async swipe(): Promise<void> { }

	async type(text: string): Promise<void> {
		this.log.push(`type ${text}`);
	}

	async clear(): Promise<void> { }

	async press(): Promise<void> { }

	async launch(app: string): Promise<void> {
		this.log.push(`open ${app}`);
	}

	async activate(element: IDeviceElement): Promise<boolean> {
		this.log.push(`press ${element.name}`);
		if (element.name === 'New Contact') {
			this.opened = true;
		} else if (element.name === 'Save') {
			this.saved = true;
		}
		return true;
	}

	async setText(element: IDeviceElement, text: string): Promise<boolean> {
		this.log.push(`set ${element.name}=${text}`);
		this.email = text;
		return true;
	}

	async key(combo: string): Promise<void> {
		this.log.push(`key ${combo}`);
	}

	async menu(path: readonly string[]): Promise<void> {
		if (path[0] !== 'File') {
			throw new Error(`No menu item "${path[0]}". Items: file, edit.`);
		}
		this.log.push(`menu ${path.join(' > ')}`);
	}
}

suite('Device act', function () {

	this.timeout(30_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	test('signs in by what the screen says, and re-types when the field lost keystrokes', async () => {
		const app = new FakeApp();
		app.dropOnce = 2;
		const run = await new DeviceActRunner(app, CancellationToken.None).run(script(`
			tap "Sign in"
			type "Email" ada@example.com
			check "Remember me"
			tap button "Continue" => "Welcome, ada@example.com"
		`));
		assert.ok(run.ok, formatActRun(run, 'device_act').join('\n'));
		assert.strictEqual(app.email, 'ada@example.com');
		assert.strictEqual(app.remember, true);
		assert.strictEqual(app.screen, 'done');
	});

	test('a field that keeps losing keystrokes fails the step instead of passing silently', async () => {
		const app = new FakeApp();
		app.alwaysDrop = 1;
		const run = await new DeviceActRunner(app, CancellationToken.None).run(script('tap "Sign in"\ntype "Email" ada@example.com\ntap "Continue"'));
		assert.strictEqual(run.results[1].code, 'VERIFY_FAILED');
		assert.match(run.results[1].detail, /twice, but it reads "da@example.com"/);
		assert.strictEqual(run.results[2].status, 'skipped');
	});

	test('a disabled button is reported, not tapped blindly', async () => {
		const app = new FakeApp();
		const run = await new DeviceActRunner(app, CancellationToken.None).run(script('tap "Sign in"\ntap button "Continue"'));
		assert.strictEqual(run.results[1].code, 'DISABLED');
	});

	test('scrolls a long list until the target shows, and stops at the end of it', async () => {
		const app = new FakeApp();
		const found = await new DeviceActRunner(app, CancellationToken.None).run(script('scroll down until "Item 20"\ntap "Item 20"'));
		assert.ok(found.ok, formatActRun(found, 'device_act').join('\n'));
		assert.ok(app.scroll > 0);
		const missing = await new DeviceActRunner(new FakeApp(), CancellationToken.None).run(script('scroll down until "Item 99"'));
		assert.strictEqual(missing.results[0].code, 'NOT_FOUND');
		assert.match(missing.results[0].detail, /reached the end|did not show/);
	});

	test('two equal buttons are ambiguous; "in" picks the row', async () => {
		const app = new FakeApp();
		const ambiguous = await new DeviceActRunner(app, CancellationToken.None).run(script('tap "Delete"'));
		assert.strictEqual(ambiguous.results[0].code, 'AMBIGUOUS');
		assert.strictEqual(app.taps, 0);
		const run = await new DeviceActRunner(app, CancellationToken.None).run(script('tap button "Delete" in "Project B" => gone "Project B"'));
		assert.ok(run.ok, formatActRun(run, 'device_act').join('\n'));
		assert.deepStrictEqual(app.rows, ['Project A']);
	});

	test('on the desktop, buttons are pressed and fields set through accessibility, never clicked', async () => {
		const desktop = new FakeDesktop();
		const run = await new DeviceActRunner(desktop, CancellationToken.None).run(script(`
			open Contacts
			click button "New Contact"
			type "Email" ada@example.com
			click button "Save" => "Saved"
			press cmd+s
			menu File > Export > vCard…
		`));
		assert.ok(run.ok, formatActRun(run, 'desktop_act').join('\n'));
		assert.deepStrictEqual(desktop.log, ['open Contacts', 'press New Contact', 'set Email=ada@example.com', 'press Save', 'key cmd+s', 'menu File > Export > vCard…']);
		const missing = await new DeviceActRunner(desktop, CancellationToken.None).run(script('menu Window > Zoom'));
		assert.strictEqual(missing.results[0].code, 'NOT_FOUND');
		assert.match(missing.results[0].detail, /No menu item "Window"/);
	});

	test('check does nothing when the switch is already on', async () => {
		const app = new FakeApp();
		app.screen = 'signin';
		app.remember = true;
		const run = await new DeviceActRunner(app, CancellationToken.None).run(script('check "Remember me"'));
		assert.ok(run.ok);
		assert.match(run.results[0].detail, /already checked/);
		assert.strictEqual(app.taps, 0);
	});
});
