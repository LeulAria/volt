/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ConfigurationModelParser } from '../../../../../platform/configuration/common/configurationModels.js';
import { ConfigurationScope, Extensions, IConfigurationNode, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { parseSshTarget, sshCommand } from '../../../../../platform/voltDevices/common/deviceCommands.js';
import { WORKSPACE_SCOPES } from '../../../../services/configuration/common/configuration.js';
import { DEVICE_REMOTE_HOSTS_SCHEMA, DEVICE_REMOTE_HOSTS_SETTING, isSafeIdentityFile, parseRemoteHosts, workspaceRemoteHosts } from '../../common/agentDevices.js';

suite('Volt devices: remote hosts come from the user only (CFG-1, B-36)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('CFG-1: the setting is application-scoped, so a workspace\'s settings file cannot set it', () => {
		assert.strictEqual(DEVICE_REMOTE_HOSTS_SCHEMA.scope, ConfigurationScope.APPLICATION);
		const registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
		const node: IConfigurationNode = { id: 'volt.devices.cfg1Test', type: 'object', properties: { [DEVICE_REMOTE_HOSTS_SETTING]: DEVICE_REMOTE_HOSTS_SCHEMA } };
		const registered = !!registry.getConfigurationProperties()[DEVICE_REMOTE_HOSTS_SETTING];
		if (!registered) {
			registry.registerConfiguration(node);
		}
		try {
			assert.strictEqual(registry.getConfigurationProperties()[DEVICE_REMOTE_HOSTS_SETTING].scope, ConfigurationScope.APPLICATION);
			const repoSettings = JSON.stringify({ [DEVICE_REMOTE_HOSTS_SETTING]: [{ host: 'attacker.example' }] });
			const workspace = new ConfigurationModelParser('workspace', new NullLogService());
			workspace.parse(repoSettings, { scopes: WORKSPACE_SCOPES, skipRestricted: false });
			assert.strictEqual(workspace.configurationModel.getValue(DEVICE_REMOTE_HOSTS_SETTING), undefined);
			const user = new ConfigurationModelParser('user', new NullLogService());
			user.parse(repoSettings);
			assert.deepStrictEqual(user.configurationModel.getValue(DEVICE_REMOTE_HOSTS_SETTING), [{ host: 'attacker.example' }]);
		} finally {
			if (!registered) {
				registry.deregisterConfigurations([node]);
			}
		}
	});

	test('CFG-1: a user or key that ssh could read as an option drops the entry', () => {
		assert.deepStrictEqual(parseRemoteHosts([
			{ host: '-oProxyCommand=touch$IFS/tmp/pwn@mac' },
			{ host: 'mac', user: '-oProxyCommand=touch /tmp/pwn' },
			{ host: 'mac', user: 'me me' },
			{ host: 'mac', identityFile: '-oProxyCommand=touch /tmp/pwn' },
			{ host: 'mac', identityFile: 'keys/id_ed25519' },
			{ host: 'mac', identityFile: '/Users/me/.ssh/id\nProxyCommand x' },
			{ host: 'mac', androidSdk: '$(touch /tmp/pwn)' },
			{ host: '-v' },
		]), []);
		assert.strictEqual(parseSshTarget('-oProxyCommand=x@host'), undefined);
		assert.strictEqual(parseSshTarget('-host'), undefined);
	});

	test('valid entries still work, and the ssh destination never starts with -', () => {
		const hosts = parseRemoteHosts([
			{ name: 'Mac mini', host: 'me@mac-mini.local:2222', identityFile: '~/.ssh/id_ed25519' },
			{ host: 'build', user: 'ci.bot_1', identityFile: '/Users/me/.ssh/ci' },
			'studio.local',
		]);
		assert.deepStrictEqual(hosts.map(host => host.ssh), [
			{ host: 'mac-mini.local', user: 'me', port: 2222, identityFile: '~/.ssh/id_ed25519' },
			{ host: 'build', user: 'ci.bot_1', port: undefined, identityFile: '/Users/me/.ssh/ci' },
			{ host: 'studio.local', user: undefined, port: undefined, identityFile: undefined },
		]);
		for (const host of hosts) {
			const command = sshCommand(host.ssh!, 'true');
			const destination = command.args[command.args.indexOf('--') - 1];
			assert.ok(!destination.startsWith('-'), destination);
		}
		assert.ok(isSafeIdentityFile('C:\\Users\\me\\.ssh\\id'));
	});

	test('B-AP-5: what a workspace settings file sets is found, to show the user', () => {
		assert.deepStrictEqual(workspaceRemoteHosts({ [DEVICE_REMOTE_HOSTS_SETTING]: [{ host: 'a' }] }), [{ host: 'a' }]);
		assert.strictEqual(workspaceRemoteHosts({ [DEVICE_REMOTE_HOSTS_SETTING]: [] }), undefined);
		assert.strictEqual(workspaceRemoteHosts({ other: 1 }), undefined);
		assert.strictEqual(workspaceRemoteHosts(undefined), undefined);
	});
});
