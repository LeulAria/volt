/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as crypto from 'crypto';
import { bufferToStream, VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IProductConfiguration } from '../../../../base/common/product.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IRequestContext } from '../../../../base/parts/request/common/request.js';
import { IConfigurationService } from '../../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../../environment/electron-main/environmentMainService.js';
import { ILifecycleMainService } from '../../../lifecycle/electron-main/lifecycleMainService.js';
import { NullLogService } from '../../../log/common/log.js';
import { IProductService } from '../../../product/common/productService.js';
import { IRequestService } from '../../../request/common/request.js';
import { IUpdate } from '../../common/update.js';
import { IVoltFeedEntry, VoltReleaseChannel, voltFeedSigningMessage } from '../../common/voltUpdateFeed.js';
import { AbstractUpdateService } from '../../electron-main/abstractUpdateService.js';

/** The update service's feed check end to end: product.json pins turn verification on (INV-28, SUP-1/2). */
suite('Volt update service feed verification', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	class TestUpdateService extends AbstractUpdateService {
		constructor(product: Partial<IProductConfiguration>, channel: VoltReleaseChannel) {
			super(
				{ when: () => new Promise<void>(() => { }) } as unknown as ILifecycleMainService,
				{ onDidChangeConfiguration: () => Disposable.None } as unknown as IConfigurationService,
				{} as IEnvironmentMainService,
				{} as IRequestService,
				new NullLogService(),
				{ _serviceBrand: undefined, ...product } as unknown as IProductService,
			);
			this.channel = channel;
			this.url = `https://feed.example/${channel}/darwin-arm64.json`;
		}
		parse(entry: unknown): Promise<IUpdate | null> {
			const context: IRequestContext = { res: { headers: {}, statusCode: 200 }, stream: bufferToStream(VSBuffer.fromString(JSON.stringify(entry))) };
			return this.parseUpdateResponse(context);
		}
		protected buildUpdateFeedUrl(): string | undefined { return undefined; }
		protected doCheckForUpdates(): void { }
	}

	const stableKey = crypto.generateKeyPairSync('ed25519');
	const nightlyKey = crypto.generateKeyPairSync('ed25519');
	const spki = (key: crypto.KeyObject) => key.export({ type: 'spki', format: 'der' }).toString('base64');
	const voltRelease = { repository: 'LeulAria/VOLT', feedUrl: 'https://feed.example', downloadPage: 'https://volt.example/download' };
	const product = { commit: 'aaaaaaa', date: '2026-11-01T00:00:00Z', quality: 'stable', voltVersion: '0.0.2' };
	const pinned = { ...product, voltRelease: { ...voltRelease, feedPublicKeys: { stable: spki(stableKey.publicKey), nightly: spki(nightlyKey.publicKey) } } };

	const entry: IVoltFeedEntry = {
		version: '0.0.3',
		productVersion: '0.0.3',
		commit: 'ccccccc',
		timestamp: Date.parse('2026-11-07T00:00:00Z'),
		url: 'https://github.com/LeulAria/VOLT/releases/download/v0.0.3/volt-stable-0.0.3-darwin-arm64.zip',
		sha256hash: 'abc',
	};

	function sign(value: object, channel: VoltReleaseChannel, key: crypto.KeyObject): object {
		const unsigned = { ...value, channel, platform: 'darwin-arm64', feedVersion: Date.now(), expires: Date.now() + 86400000 };
		return { ...unsigned, signature: crypto.sign(null, Buffer.from(voltFeedSigningMessage(unsigned), 'utf8'), key).toString('base64') };
	}

	test('SUP-1: with pinned keys an unsigned feed is refused and a signed one is offered', async () => {
		const service = new TestUpdateService(pinned, 'stable');
		await assert.rejects(service.parse(entry), /not signed/);
		assert.strictEqual((await service.parse(sign(entry, 'stable', stableKey.privateKey)))?.version, 'ccccccc');
	});

	test('SUP-2: with pinned keys the nightly key\'s signature is refused on stable', async () => {
		const service = new TestUpdateService(pinned, 'stable');
		await assert.rejects(service.parse(sign(entry, 'nightly', nightlyKey.privateKey)), /nightly channel's key/);
	});

	test('SUP-3: a feed older than one already accepted is refused', async () => {
		const service = new TestUpdateService(pinned, 'stable');
		const older = sign(entry, 'stable', stableKey.privateKey);
		await new Promise(resolve => setTimeout(resolve, 5));
		assert.ok(await service.parse(sign(entry, 'stable', stableKey.privateKey)));
		await assert.rejects(service.parse(older), /older than one already seen/);
	});

	test('without pinned keys an unsigned feed is offered as before', async () => {
		const service = new TestUpdateService({ ...product, voltRelease }, 'stable');
		assert.strictEqual((await service.parse(entry))?.version, 'ccccccc');
		assert.strictEqual(await service.parse({ ...entry, commit: 'aaaaaaa' }), null);
	});
});
