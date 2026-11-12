/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IMessagePassingProtocol } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ProxyIdentifier } from '../../common/proxyIdentifier.js';
import { RPCProtocol } from '../../common/rpcProtocol.js';
import { VoltCapabilityError } from '../../../voltPlugins/common/capabilities.js';

// EXT-REFUSE-RPC-1: a `vscode.volt` refusal crosses the extension host's RPC with its capability and
// layer. VS Code's protocol rebuilt errors from name, message and stack only, so an extension saw
// `VoltCapabilityError` with `capability` and `deniedBy` undefined (measured with Agent Lab).

suite('Volt extension refusals over RPC', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	class Pipe implements IMessagePassingProtocol {
		other?: Pipe;
		private readonly _onMessage = new Emitter<VSBuffer>();
		readonly onMessage: Event<VSBuffer> = this._onMessage.event;
		send(buffer: VSBuffer): void {
			void Promise.resolve().then(() => this.other!._onMessage.fire(buffer));
		}
		dispose(): void {
			this._onMessage.dispose();
		}
	}

	test('EXT-REFUSE-RPC-1: the error keeps its code, which carries capability, target and deniedBy', async () => {
		const store = new DisposableStore();
		const a = new Pipe();
		const b = new Pipe();
		a.other = b;
		b.other = a;
		store.add(a);
		store.add(b);
		const caller = store.add(new RPCProtocol(a));
		const callee = store.add(new RPCProtocol(b));
		const id = new ProxyIdentifier<{ $call(): Promise<void> }>('voltRefusal');
		callee.set(id, { $call: () => Promise.reject(new VoltCapabilityError('automations.schedule', 'agent lab fixture', 'manifest', 'automations.schedule (high) is not declared in contributes.voltCapabilities')) });
		try {
			await caller.getProxy(id).$call();
			assert.fail('expected a refusal');
		} catch (err) {
			assert.strictEqual((err as Error).name, 'VoltCapabilityError');
			assert.deepStrictEqual(JSON.parse((err as { code: string }).code), { capability: 'automations.schedule', target: 'agent lab fixture', deniedBy: 'manifest' });
		} finally {
			store.dispose();
		}
	});
});
