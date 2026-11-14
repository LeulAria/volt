/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import { Emitter } from '../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import type { AgentServerClientKind } from '../../../../platform/voltAgentServer/common/protocol.js';
import type { IAgentOrchestratorService } from '../../../../workbench/services/voltRuntime/common/orchestration/orchestrator.js';
import { DESKTOP_QUIT_EXIT_MS, IDLE_EXIT_MS, stopWhenIdle } from '../../../node/voltAgent/serverIdleExit.js';

suite('Agent server idle exit', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let clock: sinon.SinonFakeTimers;

	setup(() => {
		clock = sinon.useFakeTimers({ now: 1_000_000 });
	});

	teardown(() => {
		clock.restore();
	});

	function rig(options: { runsIdle?: () => boolean; busy?: () => string | undefined } = {}) {
		let kinds: AgentServerClientKind[] = [];
		const changes = store.add(new Emitter<void>());
		let stops = 0;
		const orchestrator = { getState: () => ({ threads: {} }) } as unknown as IAgentOrchestratorService;
		store.add(stopWhenIdle({
			clients: () => kinds,
			onDidChangeClients: changes.event,
			runsIdle: options.runsIdle ?? (() => true),
			orchestrator,
			network: false,
			busy: options.busy,
			stop: () => stops++,
			logService: new NullLogService(),
		}));
		return {
			set(next: AgentServerClientKind[]) {
				kinds = next;
				changes.fire();
			},
			get stops() { return stops; },
		};
	}

	test('stops soon after the app quits (the last clients were desktop windows)', () => {
		const server = rig();
		server.set(['desktop', 'desktop']);
		clock.tick(5 * 60_000);
		server.set([]);
		clock.tick(DESKTOP_QUIT_EXIT_MS - 1);
		assert.strictEqual(server.stops, 0);
		clock.tick(1);
		assert.strictEqual(server.stops, 1);
		// Nothing runs twice.
		clock.tick(IDLE_EXIT_MS);
		assert.strictEqual(server.stops, 1);
	});

	test('a window that comes back within the grace keeps the server', () => {
		const server = rig();
		server.set(['desktop']);
		server.set([]);
		clock.tick(DESKTOP_QUIT_EXIT_MS / 2);
		server.set(['desktop']);
		clock.tick(IDLE_EXIT_MS * 2);
		assert.strictEqual(server.stops, 0);
	});

	test('a browser or phone leaving keeps the long wait', () => {
		const server = rig();
		server.set(['desktop', 'web']);
		server.set([]);
		clock.tick(DESKTOP_QUIT_EXIT_MS + 60_000);
		assert.strictEqual(server.stops, 0);
		clock.tick(IDLE_EXIT_MS);
		assert.strictEqual(server.stops, 1);
	});

	test('work still going after the quit keeps the server until it ends', () => {
		let running = true;
		let terminal: string | undefined = 'an agent terminal is running';
		const server = rig({ runsIdle: () => !running, busy: () => terminal });
		server.set(['desktop']);
		server.set([]);
		clock.tick(DESKTOP_QUIT_EXIT_MS);
		assert.strictEqual(server.stops, 0);
		running = false;
		clock.tick(60_000);
		assert.strictEqual(server.stops, 0, 'a live terminal keeps it up');
		terminal = undefined;
		clock.tick(60_000);
		assert.strictEqual(server.stops, 1);
	});

	test('a server nobody ever connected to waits the long way', () => {
		const server = rig();
		clock.tick(IDLE_EXIT_MS - 60_000);
		assert.strictEqual(server.stops, 0);
		clock.tick(60_000);
		assert.strictEqual(server.stops, 1);
	});
});
