/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { checkOnDevice, DeviceRefs, deviceView, IDesktopNode, locateOnDevice, parseDeviceUi, readDesktopScreen } from '../../../common/tools/deviceUi.js';
import { renderPage } from '../../../common/tools/pageModel.js';

/** The Android 16 Settings home screen as `uiautomator dump` printed it (default-valued attributes dropped). */
const SETTINGS = "<hierarchy rotation=\"0\"><node class=\"android.widget.FrameLayout\" package=\"com.android.settings\" bounds=\"[0,0][720,1280]\"><node class=\"android.widget.LinearLayout\" bounds=\"[0,0][720,1280]\"><node resource-id=\"android:id/content\" class=\"android.widget.FrameLayout\" bounds=\"[0,0][720,1280]\"><node resource-id=\"android:id/settings_homepage_container\" class=\"android.widget.ScrollView\" bounds=\"[0,0][720,1232]\"><node resource-id=\"android:id/app_bar\" class=\"android.widget.LinearLayout\" bounds=\"[0,0][720,240]\"><node resource-id=\"android:id/app_bar_container\" class=\"android.widget.LinearLayout\" bounds=\"[0,0][720,240]\"><node class=\"androidx.cardview.widget.CardView\" bounds=\"[32,64][688,208]\"><node resource-id=\"android:id/search_action_bar\" class=\"android.widget.LinearLayout\" clickable=\"true\" bounds=\"[32,64][688,208]\"><node resource-id=\"android:id/imageView\" class=\"android.widget.ImageView\" bounds=\"[80,112][128,160]\"/><node text=\"Search Settings\" resource-id=\"android:id/search_bar_title\" class=\"android.widget.TextView\" bounds=\"[144,109][440,163]\"/></node></node></node></node><node resource-id=\"android:id/main_content_scrollable_container\" class=\"android.widget.ScrollView\" scrollable=\"true\" bounds=\"[0,240][720,1232]\"><node resource-id=\"android:id/homepage_container\" class=\"android.widget.LinearLayout\" bounds=\"[0,240][720,1232]\"><node resource-id=\"android:id/main_content\" class=\"android.widget.FrameLayout\" bounds=\"[0,240][720,1232]\"><node resource-id=\"android:id/container_material\" class=\"android.widget.LinearLayout\" bounds=\"[0,240][720,1232]\"><node resource-id=\"android:id/list_container\" class=\"android.widget.FrameLayout\" bounds=\"[0,240][720,1232]\"><node resource-id=\"android:id/recycler_view\" class=\"androidx.recyclerview.widget.RecyclerView\" scrollable=\"true\" bounds=\"[0,240][720,1232]\"><node class=\"android.widget.LinearLayout\" clickable=\"true\" bounds=\"[0,240][720,428]\"><node resource-id=\"android:id/icon_frame\" class=\"android.widget.LinearLayout\" bounds=\"[32,278][144,358]\"><node resource-id=\"android:id/icon\" class=\"android.widget.ImageView\" bounds=\"[64,278][144,358]\"/></node><node resource-id=\"android:id/text_frame\" class=\"android.widget.RelativeLayout\" bounds=\"[128,240][688,396]\"><node text=\"Google\" resource-id=\"android:id/title\" class=\"android.widget.TextView\" bounds=\"[160,272][286,326]\"/><node text=\"Services &amp; preferences\" resource-id=\"android:id/summary\" class=\"android.widget.TextView\" bounds=\"[160,326][445,364]\"/></node></node><node class=\"android.widget.LinearLayout\" clickable=\"true\" bounds=\"[0,428][720,584]\"><node resource-id=\"android:id/icon_frame\" class=\"android.widget.LinearLayout\" bounds=\"[32,466][144,546]\"><node resource-id=\"android:id/icon\" class=\"android.widget.ImageView\" bounds=\"[64,466][144,546]\"/></node><node resource-id=\"android:id/text_frame\" class=\"android.widget.RelativeLayout\" bounds=\"[128,428][688,584]\"><node text=\"Network &amp; internet\" resource-id=\"android:id/title\" class=\"android.widget.TextView\" bounds=\"[160,460][491,514]\"/><node text=\"Mobile, Wi\u2011Fi, hotspot\" resource-id=\"android:id/summary\" class=\"android.widget.TextView\" bounds=\"[160,514][428,552]\"/></node></node><node class=\"android.widget.LinearLayout\" clickable=\"true\" bounds=\"[0,584][720,772]\"><node resource-id=\"android:id/icon_frame\" class=\"android.widget.LinearLayout\" bounds=\"[32,622][144,702]\"><node resource-id=\"android:id/icon\" class=\"android.widget.ImageView\" bounds=\"[64,622][144,702]\"/></node><node resource-id=\"android:id/text_frame\" class=\"android.widget.RelativeLayout\" bounds=\"[128,584][688,740]\"><node text=\"Connected devices\" resource-id=\"android:id/title\" class=\"android.widget.TextView\" bounds=\"[160,616][498,670]\"/><node text=\"Bluetooth, pairing\" resource-id=\"android:id/summary\" class=\"android.widget.TextView\" bounds=\"[160,670][377,708]\"/></node></node><node class=\"android.widget.LinearLayout\" clickable=\"true\" bounds=\"[0,772][720,928]\"><node resource-id=\"android:id/icon_frame\" class=\"android.widget.LinearLayout\" bounds=\"[32,810][144,890]\"><node resource-id=\"android:id/icon\" class=\"android.widget.ImageView\" bounds=\"[64,810][144,890]\"/></node><node resource-id=\"android:id/text_frame\" class=\"android.widget.RelativeLayout\" bounds=\"[128,772][688,928]\"><node text=\"Apps\" resource-id=\"android:id/title\" class=\"android.widget.TextView\" bounds=\"[160,804][251,858]\"/><node text=\"Assistant, recent apps, default apps\" resource-id=\"android:id/summary\" class=\"android.widget.TextView\" bounds=\"[160,858][602,896]\"/></node></node><node class=\"android.widget.LinearLayout\" clickable=\"true\" bounds=\"[0,928][720,1084]\"><node resource-id=\"android:id/icon_frame\" class=\"android.widget.LinearLayout\" bounds=\"[32,966][144,1046]\"><node resource-id=\"android:id/icon\" class=\"android.widget.ImageView\" bounds=\"[64,966][144,1046]\"/></node><node resource-id=\"android:id/text_frame\" class=\"android.widget.RelativeLayout\" bounds=\"[128,928][688,1084]\"><node text=\"Notifications\" resource-id=\"android:id/title\" class=\"android.widget.TextView\" bounds=\"[160,960][389,1014]\"/><node text=\"Notification history, conversations\" resource-id=\"android:id/summary\" class=\"android.widget.TextView\" bounds=\"[160,1014][581,1052]\"/></node></node><node class=\"android.widget.LinearLayout\" clickable=\"true\" bounds=\"[0,1084][720,1232]\"><node resource-id=\"android:id/icon_frame\" class=\"android.widget.LinearLayout\" bounds=\"[32,1122][144,1202]\"><node resource-id=\"android:id/icon\" class=\"android.widget.ImageView\" bounds=\"[64,1122][144,1202]\"/></node><node resource-id=\"android:id/text_frame\" class=\"android.widget.RelativeLayout\" bounds=\"[128,1084][688,1232]\"><node text=\"Sound &amp; vibration\" resource-id=\"android:id/title\" class=\"android.widget.TextView\" bounds=\"[160,1116][474,1170]\"/><node text=\"Volume and haptics\" resource-id=\"android:id/summary\" class=\"android.widget.TextView\" bounds=\"[160,1170][407,1208]\"/></node></node><node class=\"android.widget.LinearLayout\" clickable=\"true\" bounds=\"[0,1240][720,1232]\"><node resource-id=\"android:id/icon_frame\" class=\"android.widget.LinearLayout\" bounds=\"[32,1278][144,1232]\"><node resource-id=\"android:id/icon\" class=\"android.widget.ImageView\" bounds=\"[64,1278][144,1232]\"/></node><node resource-id=\"android:id/text_frame\" class=\"android.widget.RelativeLayout\" bounds=\"[128,1240][688,1232]\"><node text=\"Modes\" resource-id=\"android:id/title\" class=\"android.widget.TextView\" bounds=\"[160,1272][283,1232]\"/></node></node></node></node></node></node></node></node></node></node></node></node></hierarchy>";

/** A login form: labelled fields, a password, a checkbox, a disabled button, and icon-font glyphs. */
const FORM = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node class="android.widget.FrameLayout" package="com.example.app" bounds="[0,0][720,1280]">
	<node class="android.widget.TextView" text="Sign in" bounds="[40,100][680,160]" />
	<node class="android.widget.TextView" text="Email" bounds="[40,200][680,240]" />
	<node class="android.widget.EditText" resource-id="com.example.app:id/email" text="ada@example.com" clickable="true" focused="true" bounds="[40,240][680,320]" />
	<node class="android.widget.EditText" resource-id="com.example.app:id/password" text="••••••" hint="Password" password="true" clickable="true" bounds="[40,340][680,420]" />
	<node class="android.widget.CheckBox" text="Remember me" checkable="true" checked="false" clickable="true" bounds="[40,440][680,500]" />
	<node class="android.view.ViewGroup" clickable="true" content-desc="Sign in, " bounds="[40,520][680,600]"><node class="android.widget.TextView" text="Sign in" bounds="[300,540][420,580]" /></node>
	<node class="android.widget.Button" text="Create account" enabled="false" bounds="[40,620][680,700]" />
	<node class="android.widget.TextView" text="&#xe5cd;" bounds="[600,40][680,90]" />
	<node class="android.widget.TextView" text="Offscreen" bounds="[40,1300][680,1240]" />
</node></hierarchy>`;

/** An iOS simulator screen as `axe describe-ui` prints it (frames in points). */
const IOS = JSON.stringify([{
	type: 'Application', AXLabel: 'Settings', frame: { x: 0, y: 0, width: 393, height: 852 }, enabled: true, children: [
		{ type: 'StaticText', AXLabel: 'Settings', frame: { x: 16, y: 100, width: 200, height: 40 }, enabled: true, children: [] },
		{ type: 'SearchField', AXLabel: 'Search', AXValue: null, frame: { x: 16, y: 150, width: 361, height: 36 }, enabled: true, children: [] },
		{ type: 'Cell', AXLabel: 'Wi-Fi', AXValue: 'Home', frame: { x: 0, y: 220, width: 393, height: 44 }, enabled: true, children: [] },
		{ type: 'Switch', AXLabel: 'Airplane Mode', AXValue: '0', frame: { x: 320, y: 270, width: 51, height: 31 }, enabled: true, children: [] },
		{ type: 'Button', AXLabel: 'General', frame: { x: 0, y: 320, width: 393, height: 44 }, enabled: true, children: [] },
	],
}]);

suite('Device UI', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads a real Android screen as tappable rows named by their text', () => {
		const screen = parseDeviceUi('uiautomator', SETTINGS, new DeviceRefs())!;
		assert.strictEqual(screen.app, 'com.android.settings');
		assert.deepStrictEqual([screen.width, screen.height], [720, 1280]);
		assert.deepStrictEqual(renderPage(deviceView(screen)), [
			'- button "Search Settings" [ref=d0]',
			'- region [scrollable] [ref=d1]:',
			'  - list [scrollable] [ref=d2]:',
			'    - button "Google, Services & preferences" [ref=d3]',
			'    - button "Network & internet, Mobile, Wi‑Fi, hotspot" [ref=d4]',
			'    - button "Connected devices, Bluetooth, pairing" [ref=d5]',
			'    - button "Apps, Assistant, recent apps, default apps" [ref=d6]',
			'    - button "Notifications, Notification history, conversations" [ref=d7]',
			'    - button "Sound & vibration, Volume and haptics" [ref=d8]',
		]);
	});

	test('keeps refs across reads, so a scrolled list diffs by what moved in and out', () => {
		const refs = new DeviceRefs();
		const first = parseDeviceUi('uiautomator', SETTINGS, refs)!;
		const shifted = SETTINGS.replace(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g, (_, a, b, c, d) => `bounds="[${a},${Number(b) - 10}][${c},${Number(d) - 10}]"`);
		const second = parseDeviceUi('uiautomator', shifted, refs)!;
		assert.deepStrictEqual(second.elements.map(e => e.ref), first.elements.map(e => e.ref));
	});

	test('fields take their label, passwords stay hidden, glyphs and offscreen nodes go', () => {
		const screen = parseDeviceUi('uiautomator', FORM, new DeviceRefs())!;
		assert.deepStrictEqual(renderPage(deviceView(screen)), [
			'- text: Sign in',
			'- text: Email',
			'- textbox "Email" [focused] [ref=d0]: "ada@example.com"',
			'- textbox "Password" [ref=d1]: "••••••"',
			'- checkbox "Remember me" [unchecked] [ref=d2]',
			'- button "Sign in" [ref=d3]',
			'- button "Create account" [disabled] [ref=d4]',
		]);
		const password = locateOnDevice(screen.elements, { label: 'Password' });
		assert.ok(!('error' in password) && password.element.secret);
	});

	test('locates by text (promoted to the row), role + name, label, id and ref; ambiguity is reported', () => {
		const screen = parseDeviceUi('uiautomator', SETTINGS, new DeviceRefs())!;
		const network = locateOnDevice(screen.elements, { text: 'Network & internet' });
		assert.ok(!('error' in network));
		assert.strictEqual(network.element.ref, 'd4');
		assert.deepStrictEqual(network.element.box, [0, 428, 720, 156]);
		const form = parseDeviceUi('uiautomator', FORM, new DeviceRefs())!;
		const byId = locateOnDevice(form.elements, { selector: 'email' });
		assert.ok(!('error' in byId) && byId.element.name === 'Email');
		const signIn = locateOnDevice(form.elements, { text: 'Sign in' });
		assert.ok('error' in signIn && signIn.error === 'ambiguous', 'the heading and the button both say Sign in');
		const button = locateOnDevice(form.elements, { role: 'button', name: 'Sign in' });
		assert.ok(!('error' in button) && button.element.ref === 'd3');
		assert.ok('error' in locateOnDevice(form.elements, { ref: 'd99' }));
	});

	test('checks postconditions against the screen', () => {
		const form = parseDeviceUi('uiautomator', FORM, new DeviceRefs())!;
		assert.ok(checkOnDevice(form, { text: 'Remember me' }).ok);
		assert.ok(checkOnDevice(form, { target: { label: 'Email' }, value: 'ada@example.com' }).ok);
		assert.ok(checkOnDevice(form, { target: { role: 'button', name: 'Create account' }, state: 'disabled' }).ok);
		assert.deepStrictEqual(checkOnDevice(form, { target: { label: 'Remember me' }, state: 'checked' }), { ok: false, detail: 'it is not checked (unchecked)' });
		assert.deepStrictEqual(checkOnDevice(form, { textGone: 'Sign in' }), { ok: false, detail: '"Sign in" is still on screen' });
	});

	test('reads a Mac app window from its accessibility tree', () => {
		const node = (role: string, extra: Partial<IDesktopNode> = {}, f: [number, number, number, number] = [100, 100, 200, 24]): IDesktopNode => ({ h: `h${Math.random()}`, role, f, ...extra });
		const root = node('AXWindow', {
			title: 'Sign in', sub: 'AXDialog', c: [
				node('AXStaticText', { value: 'Welcome to Acme' }),
				node('AXTextField', { ph: 'Email', value: 'ada@example.com', focused: true }),
				node('AXTextField', { sub: 'AXSecureTextField', desc: 'Password', value: '••••' }),
				node('AXCheckBox', { title: 'Remember me', value: '1' }),
				node('AXCheckBox', { sub: 'AXSwitch', title: 'Sync', value: '0' }),
				node('AXButton', { title: 'Cancel' }),
				node('AXButton', { title: 'Sign In', disabled: true }),
				node('AXScrollBar', { c: [node('AXValueIndicator')] }),
				node('AXGroup', { c: [node('AXRadioButton', { sub: 'AXTabButton', title: 'General', value: '1' }), node('AXRadioButton', { sub: 'AXTabButton', title: 'Advanced', value: '0' })] }),
			],
		}, [0, 0, 600, 400]);
		const screen = readDesktopScreen({ app: 'Acme', root }, new DeviceRefs())!;
		assert.strictEqual(screen.app, 'Acme');
		assert.deepStrictEqual(renderPage(deviceView(screen)), [
			'- dialog "Sign in" [ref=d0]:',
			'  - text: Welcome to Acme',
			'  - textbox "Email" [focused] [ref=d1]: "ada@example.com"',
			'  - textbox "Password" [ref=d2]: "••••"',
			'  - checkbox "Remember me" [checked] [ref=d3]',
			'  - switch "Sync" [unchecked] [ref=d4]',
			'  - button "Cancel" [ref=d5]',
			'  - button "Sign In" [disabled] [ref=d6]',
			'  - tab "General" [selected] [ref=d7]',
			'  - tab "Advanced" [ref=d8]',
		]);
		const email = locateOnDevice(screen.elements, { label: 'Email' });
		assert.ok(!('error' in email) && email.element.handle === root.c![1].h, 'elements keep the handle to act on them');
		const password = locateOnDevice(screen.elements, { label: 'Password' });
		assert.ok(!('error' in password) && password.element.secret);
	});

	test('reads an iOS AXe tree', () => {
		const screen = parseDeviceUi('axe', IOS, new DeviceRefs())!;
		assert.strictEqual(screen.app, 'Settings');
		assert.deepStrictEqual(renderPage(deviceView(screen)), [
			'- text: Settings',
			'- searchbox "Search" [ref=d0]',
			'- listitem "Wi-Fi" [ref=d1]',
			'- switch "Airplane Mode" [unchecked] [ref=d2]',
			'- button "General" [ref=d3]',
		]);
		const airplane = locateOnDevice(screen.elements, { role: 'switch', name: 'Airplane Mode' });
		assert.ok(!('error' in airplane) && airplane.element.box[0] === 320);
	});
});
