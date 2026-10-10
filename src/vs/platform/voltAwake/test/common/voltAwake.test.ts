/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AWAKE_BATTERY_FLOOR_SETTING, AWAKE_LID_CLOSED_MODE_SETTING, decideAwake, DEFAULT_AWAKE_PREFS, formatKeyValues, IAwakePolicyInput, parseActiveSchemeGuid, parseClamshellState, parseKeyValues, parseLidAction, parsePmsetSleepDisabled, readAwakePrefs } from '../../common/voltAwake.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

suite('Volt awake policy', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const base: IAwakePolicyInput = {
		now: 10 * HOUR,
		prefs: DEFAULT_AWAKE_PREFS,
		working: 1,
		lastBusyAt: 10 * HOUR,
		episodeStartedAt: 10 * HOUR - MINUTE,
		snoozed: false,
		onBattery: false,
		batteryPercent: undefined,
		thermal: 'nominal',
	};

	test('agents working: idle and lid held (Lid-Closed Mode is on by default)', () => {
		assert.deepStrictEqual(decideAwake(base), { idle: true, lid: true, reason: 'agents' });
	});

	test('the hold outlasts the last run by the grace period, then lets go', () => {
		const idle = { ...base, working: 0, lastBusyAt: base.now - 1 * MINUTE };
		assert.deepStrictEqual(decideAwake(idle), { idle: true, lid: true, reason: 'grace' });
		assert.deepStrictEqual(decideAwake({ ...idle, lastBusyAt: base.now - 3 * MINUTE }), { idle: false, lid: false, reason: 'none' });
		assert.deepStrictEqual(decideAwake({ ...idle, lastBusyAt: undefined }), { idle: false, lid: false, reason: 'none' });
	});

	test('Lid-Closed Mode off: only idle sleep is held', () => {
		assert.deepStrictEqual(decideAwake({ ...base, prefs: { ...DEFAULT_AWAKE_PREFS, lidClosedMode: false } }), { idle: true, lid: false, reason: 'agents' });
	});

	test('both settings off: nothing is held', () => {
		assert.deepStrictEqual(decideAwake({ ...base, prefs: { ...DEFAULT_AWAKE_PREFS, lidClosedMode: false, whileAgentsWork: false } }), { idle: false, lid: false, reason: 'none' });
	});

	test('Lid-Closed Mode alone still holds idle sleep (a closed lid implies it)', () => {
		assert.deepStrictEqual(decideAwake({ ...base, prefs: { ...DEFAULT_AWAKE_PREFS, whileAgentsWork: false } }), { idle: true, lid: true, reason: 'agents' });
	});

	test('battery floor applies on battery only, and 0 turns it off', () => {
		const low = { ...base, onBattery: true, batteryPercent: 15 };
		assert.deepStrictEqual(decideAwake(low), { idle: true, lid: false, reason: 'agents', blockedBy: 'battery' });
		assert.deepStrictEqual(decideAwake({ ...low, onBattery: false }), { idle: true, lid: true, reason: 'agents' });
		assert.deepStrictEqual(decideAwake({ ...low, prefs: { ...DEFAULT_AWAKE_PREFS, batteryFloorPercent: 0 } }), { idle: true, lid: true, reason: 'agents' });
		assert.deepStrictEqual(decideAwake({ ...low, batteryPercent: undefined }), { idle: true, lid: true, reason: 'agents' }, 'an unknown level is no reason to let go');
	});

	test('critical heat lets go of the lid; serious does not', () => {
		assert.deepStrictEqual(decideAwake({ ...base, thermal: 'critical' }), { idle: true, lid: false, reason: 'agents', blockedBy: 'thermal' });
		assert.deepStrictEqual(decideAwake({ ...base, thermal: 'serious' }), { idle: true, lid: true, reason: 'agents' });
	});

	test('the hard cap lets go of the lid after maxHours of unbroken work', () => {
		assert.deepStrictEqual(decideAwake({ ...base, episodeStartedAt: base.now - 13 * HOUR }), { idle: true, lid: false, reason: 'agents', blockedBy: 'cap' });
		assert.deepStrictEqual(decideAwake({ ...base, episodeStartedAt: base.now - 11 * HOUR }), { idle: true, lid: true, reason: 'agents' });
	});

	test('"allow sleep now" drops both holds', () => {
		assert.deepStrictEqual(decideAwake({ ...base, snoozed: true }), { idle: false, lid: false, reason: 'agents', blockedBy: 'snoozed' });
	});

	test('settings: defaults, and out-of-range numbers are clamped', () => {
		assert.deepStrictEqual(readAwakePrefs(() => undefined), DEFAULT_AWAKE_PREFS);
		const prefs = readAwakePrefs(key => ({ [AWAKE_LID_CLOSED_MODE_SETTING]: false, [AWAKE_BATTERY_FLOOR_SETTING]: 400 } as Record<string, unknown>)[key]);
		assert.strictEqual(prefs.lidClosedMode, false);
		assert.strictEqual(prefs.batteryFloorPercent, 90);
	});
});

suite('Volt awake parsers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('pmset -g SleepDisabled', () => {
		assert.strictEqual(parsePmsetSleepDisabled('System-wide power settings:\n SleepDisabled\t\t1\nCurrently in use:\n sleep 0\n'), true);
		assert.strictEqual(parsePmsetSleepDisabled('System-wide power settings:\n SleepDisabled\t\t0\n'), false);
		assert.strictEqual(parsePmsetSleepDisabled('Currently in use:\n standby 1\n sleep 0 (sleep prevented by powerd)\n'), false);
	});

	test('ioreg AppleClamshellState', () => {
		assert.strictEqual(parseClamshellState('    "AppleClamshellState" = Yes\n'), true);
		assert.strictEqual(parseClamshellState('  | "AppleClamshellState" = No\n'), false);
		assert.strictEqual(parseClamshellState(''), undefined, 'a Mac without a lid lists no such key');
	});

	test('powercfg output, English and German (labels are localized)', () => {
		assert.strictEqual(parseActiveSchemeGuid('Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)'), '381b4222-f694-41f0-9685-ff5bb260df2e');
		assert.strictEqual(parseActiveSchemeGuid('GUID des Energieschemas: 381B4222-F694-41F0-9685-FF5BB260DF2E  (Ausbalanciert)'), '381b4222-f694-41f0-9685-ff5bb260df2e');
		const english = [
			'Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)',
			'  Subgroup GUID: 4f971e89-eebd-4455-a8de-9e59040e7347  (Power buttons and lid)',
			'    Power Setting GUID: 5ca83367-6e45-459f-a27b-476b1d01c936  (Lid close action)',
			'      Possible Setting Index: 000',
			'      Possible Setting Friendly Name: Do nothing',
			'      Possible Setting Index: 001',
			'      Possible Setting Friendly Name: Sleep',
			'    Current AC Power Setting Index: 0x00000001',
			'    Current DC Power Setting Index: 0x00000002',
			'',
		].join('\n');
		assert.deepStrictEqual(parseLidAction(english), { ac: 1, dc: 2 });
		const german = english.replace('Current AC Power Setting Index', 'Aktueller Wechselstrom-Einstellungsindex').replace('Current DC Power Setting Index', 'Aktueller Gleichstrom-Einstellungsindex');
		assert.deepStrictEqual(parseLidAction(german), { ac: 1, dc: 2 });
		assert.strictEqual(parseLidAction('Access denied.'), undefined);
	});

	test('key=value files round-trip', () => {
		const map = new Map([['pid', '42'], ['started', 'Fri Oct 10 12:40:01 2026'], ['lid', '1']]);
		assert.deepStrictEqual(parseKeyValues(formatKeyValues(map)), map);
		assert.deepStrictEqual(parseKeyValues('a=1\r\nbroken\nb = x=y\n'), new Map([['a', '1'], ['b', 'x=y']]));
	});
});
