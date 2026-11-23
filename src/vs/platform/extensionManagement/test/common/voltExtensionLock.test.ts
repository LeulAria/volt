/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// SUP-9: what holds an extension update for the user (H.10, GlassWorm's hijacked publishers and
// sleeper updates): a changed publisher identity, a worse signature, new capabilities, new
// `high` code-scan findings. Pure decisions; the install side and the sheet are tested elsewhere.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { approvedUpdateKey, canonicalManifest, compareWithLock, declaredVoltCapabilities, describeMismatch, gained, heldUpdateMessage, isUnlockedPath, IVoltHeldUpdate, parseHeldUpdate, voltPublisherConcerns } from '../../common/voltExtensionLock.js';

suite('Volt extension lock and update holds (SUP-9)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('SUP-9-1: the publisher\'s identity: a new publisher id, a lost verified flag, a worse signature', () => {
		const installed = { publisher: 'acme', publisherId: 'p-1', publisherDisplayName: 'Acme', verified: true, signature: 'Success' };
		assert.deepStrictEqual(voltPublisherConcerns(installed, { ...installed }), [], 'same identity: nothing to ask');
		assert.deepStrictEqual(voltPublisherConcerns(installed, { ...installed, publisherId: 'p-2', publisherDisplayName: 'Acme Ltd' }), [{ kind: 'publisher-changed', from: 'Acme', to: 'Acme Ltd' }]);
		assert.deepStrictEqual(voltPublisherConcerns(installed, { ...installed, verified: false }), [{ kind: 'publisher-unverified', publisher: 'acme' }]);
		assert.deepStrictEqual(voltPublisherConcerns(installed, { ...installed, signature: 'NotSigned' }), [{ kind: 'signature-worse', from: 'Success', to: 'NotSigned' }]);
		assert.deepStrictEqual(voltPublisherConcerns({ ...installed, signature: 'NotSigned' }, { ...installed, signature: 'SignatureIsInvalid' }), [{ kind: 'signature-worse', from: 'NotSigned', to: 'SignatureIsInvalid' }]);
		assert.deepStrictEqual(voltPublisherConcerns({ ...installed, signature: 'NotSigned' }, { ...installed, signature: 'Success' }), [], 'better is fine');
		// What the gallery doesn't say is no concern (a .vsix, a gallery without publisher ids or a verified flag).
		assert.deepStrictEqual(voltPublisherConcerns({ publisher: 'acme' }, { publisher: 'acme', publisherId: 'p-9', verified: false, signature: 'NotSigned' }), []);
		assert.deepStrictEqual(voltPublisherConcerns({ publisher: 'acme' }, { publisher: 'other' }), [{ kind: 'publisher-changed', from: 'acme', to: 'other' }]);
	});

	test('SUP-9-2: capabilities and findings an update gains', () => {
		const v1 = { contributes: { voltCapabilities: { required: [{ id: 'net.connect', targets: ['api.acme.dev'] }], optional: [{ id: 'agents.read:any@1' }] } } };
		const v2 = { contributes: { voltCapabilities: { required: [{ id: 'net.connect', targets: ['api.acme.dev', 'paste.ee'] }], optional: [{ id: 'agents.read:any' }, { id: 'agents.send' }] } } };
		assert.deepStrictEqual(declaredVoltCapabilities(v1), ['agents.read:any', 'net.connect api.acme.dev']);
		assert.deepStrictEqual(gained(declaredVoltCapabilities(v1), declaredVoltCapabilities(v2)), ['agents.send', 'net.connect paste.ee']);
		assert.deepStrictEqual(gained(declaredVoltCapabilities(v2), declaredVoltCapabilities(v1)), [], 'dropping one is no concern');
		assert.deepStrictEqual(declaredVoltCapabilities({}), []);
		assert.deepStrictEqual(gained(['hidden-name: eval'], ['hidden-name: eval', 'invisible-code: variation selectors in a string']), ['invisible-code: variation selectors in a string']);
	});

	test('SUP-9-3: a held update crosses processes in the error text and is approved for that version only', () => {
		const held: IVoltHeldUpdate = { id: 'acme.lint', version: '2.0.0', installedVersion: '1.0.0', publisher: 'acme', concerns: [{ kind: 'code', added: ['invisible-code: variation selectors in a string'] }] };
		assert.deepStrictEqual(parseHeldUpdate(new Error(`Installing failed: ${heldUpdateMessage(held)}`)), held);
		assert.strictEqual(parseHeldUpdate(new Error('Download failed')), undefined);
		assert.strictEqual(parseHeldUpdate(new Error('volt-update-held:{not json')), undefined);
		assert.strictEqual(approvedUpdateKey('Acme.Lint', '2.0.0'), 'acme.lint@2.0.0');
	});

	test('SUP-9-4: the lock\'s comparisons: stats decide what to hash; install metadata and OS files are not the extension\'s', () => {
		const file = { sha256: 'a', size: 3, mtimeMs: 1, ctimeMs: 1 };
		const disk = new Map([['a.js', { size: 3, mtimeMs: 1, ctimeMs: 1 }], ['b.js', { size: 3, mtimeMs: 1, ctimeMs: 2 }], ['new.js', { size: 1, mtimeMs: 1, ctimeMs: 1 }]]);
		assert.deepStrictEqual(compareWithLock({ files: { 'a.js': file, 'b.js': file, 'gone.js': file } }, disk), { added: ['new.js'], removed: ['gone.js'], toHash: ['b.js'] }, 'a changed change time is hashed even with the same modification time');
		assert.strictEqual(describeMismatch({ added: [], removed: [], modified: [] }), undefined);
		assert.strictEqual(describeMismatch({ added: ['x.js', 'y.js'], removed: [], modified: ['out/a.js'] }), 'out/a.js was modified; x.js and 1 more were added');
		assert.strictEqual(canonicalManifest('{"name":"a","__metadata":{"pinned":true}}'), canonicalManifest('{\n\t"name": "a"\n}'));
		assert.strictEqual(canonicalManifest('not json'), undefined);
		assert.ok(isUnlockedPath('.DS_Store') && isUnlockedPath('lib/__pycache__/x.cpython-312.pyc'));
		assert.ok(!isUnlockedPath('lib/x.pyc') && !isUnlockedPath('out/extension.js'));
	});
});
