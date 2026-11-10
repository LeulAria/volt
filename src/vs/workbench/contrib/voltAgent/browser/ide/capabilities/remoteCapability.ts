/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../../../../base/common/resources.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkbenchEnvironmentService } from '../../../../../services/environment/common/environmentService.js';
import { IPathService } from '../../../../../services/path/common/pathService.js';
import { DEVCONTAINER_FILES } from '../../../../../services/voltRuntime/common/ide/ideSandbox.js';
import { cliText, fail, IIdeCapability, IIdeCapabilityContext, IIdeCapabilityResult, ok, safeName, str } from './capability.js';

/** Remote and container environments: where the window runs, SSH hosts, dev containers. */
export class RemoteCapability implements IIdeCapability {

	readonly id = 'remote';

	constructor(
		private readonly environment: IWorkbenchEnvironmentService,
		private readonly fileService: IFileService,
		private readonly pathService: IPathService,
	) { }

	async invoke(op: string, args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		switch (op) {
			case 'info': {
				const authority = this.environment.remoteAuthority;
				const lines = [authority ? `This window runs remotely: ${authority.split('+')[0]} (${authority}).` : 'This window runs locally.'];
				for (const name of DEVCONTAINER_FILES) {
					const uri = ctx.root ? joinPath(ctx.root, name) : undefined;
					const text = uri ? await this.fileService.readFile(uri).then(file => file.value.toString(), () => undefined) : undefined;
					if (text) {
						lines.push(`Dev container config ${name}:`, text.split('\n').filter(line => !/^\s*\/\//.test(line)).slice(0, 40).join('\n'));
						break;
					}
				}
				return ok(lines.join('\n'));
			}
			case 'hosts': {
				const home = await this.pathService.userHome();
				const text = await this.fileService.readFile(joinPath(home, '.ssh/config')).then(file => file.value.toString(), () => undefined);
				if (!text) {
					return ok('No ~/.ssh/config.');
				}
				const hosts: string[] = [];
				let current: { name: string; host?: string; user?: string } | undefined;
				for (const raw of text.split('\n')) {
					const [key, ...rest] = raw.trim().split(/\s+/);
					const value = rest.join(' ');
					if (/^host$/i.test(key)) {
						if (current) {
							hosts.push(`${current.name}${current.host ? `  ${current.user ? `${current.user}@` : ''}${current.host}` : ''}`);
						}
						current = value.includes('*') ? undefined : { name: value };
					} else if (current && /^hostname$/i.test(key)) {
						current.host = value;
					} else if (current && /^user$/i.test(key)) {
						current.user = value;
					}
				}
				if (current) {
					hosts.push(`${current.name}${current.host ? `  ${current.user ? `${current.user}@` : ''}${current.host}` : ''}`);
				}
				return ok(hosts.length ? hosts.join('\n') : 'No hosts in ~/.ssh/config.');
			}
			case 'exec': {
				const host = safeName(str(args, 'host'));
				const command = str(args, 'command');
				if (!host || !command) {
					return fail('exec needs host and command.');
				}
				return cliText(await ctx.cli.run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, command], { timeoutMs: 300_000 }), 'ssh', 200);
			}
			case 'devcontainer': {
				const action = str(args, 'action') ?? 'up';
				if (!ctx.root) {
					return fail('No workspace folder.');
				}
				if (action === 'up') {
					return cliText(await ctx.cli.run('devcontainer', ['up', '--workspace-folder', ctx.root.fsPath], { timeoutMs: 1_200_000 }), 'devcontainer', 60);
				}
				const command = str(args, 'command');
				if (action === 'exec' && command) {
					return cliText(await ctx.cli.run('devcontainer', ['exec', '--workspace-folder', ctx.root.fsPath, 'sh', '-c', command], { timeoutMs: 600_000 }), 'devcontainer', 200);
				}
				return fail('devcontainer action must be up, or exec with command.');
			}
		}
		return fail(`remote has no op ${op}.`);
	}
}
