/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MenuRegistry } from '../../../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IExtensionService } from '../../../../../services/extensions/common/extensions.js';
import { fail, IIdeCapability, IIdeCapabilityContext, IIdeCapabilityResult, ok, str } from './capability.js';

export { HttpCapability } from './httpCapability.js';

/** Installed extensions and the commands they (and the editor) offer; running one needs the user's yes. */
export class ExtensionsCapability implements IIdeCapability {

	readonly id = 'extensions';

	constructor(
		private readonly extensionService: IExtensionService,
		private readonly commandService: ICommandService,
	) { }

	async invoke(op: string, args: Readonly<Record<string, unknown>>, _ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		switch (op) {
			case 'list': {
				const query = str(args, 'query')?.toLowerCase();
				const extensions = this.extensionService.extensions.filter(extension => !extension.isBuiltin || query).filter(extension => !query || `${extension.identifier.value} ${extension.displayName ?? ''} ${extension.description ?? ''}`.toLowerCase().includes(query));
				const lines = extensions.slice(0, 60).map(extension => {
					const contributes = Object.keys(extension.contributes ?? {}).slice(0, 6).join(', ');
					return `${extension.identifier.value}  ${extension.displayName ?? extension.name}${contributes ? `  (${contributes})` : ''}`;
				});
				return ok(lines.length ? lines.join('\n') : 'No matching extensions.');
			}
			case 'commands': {
				const query = str(args, 'query')?.toLowerCase();
				if (!query) {
					return fail('commands needs query.');
				}
				const titles = new Map<string, string>();
				for (const [id, command] of MenuRegistry.getCommands()) {
					const title = typeof command.title === 'string' ? command.title : command.title.value;
					const category = command.category ? (typeof command.category === 'string' ? command.category : command.category.value) : '';
					titles.set(id, category ? `${category}: ${title}` : title);
				}
				const matches = [...CommandsRegistry.getCommands().keys()].filter(id => !id.startsWith('_')).filter(id => id.toLowerCase().includes(query) || titles.get(id)?.toLowerCase().includes(query)).slice(0, 40);
				return ok(matches.length ? matches.map(id => `${id}${titles.get(id) ? `  ${titles.get(id)}` : ''}`).join('\n') : `No commands match "${query}".`);
			}
			case 'run': {
				const command = str(args, 'command');
				if (!command || !CommandsRegistry.getCommand(command)) {
					return fail(`No command ${command ?? '(missing)'}. Find one with op commands.`);
				}
				const commandArgs = Array.isArray(args.args) ? args.args : [];
				const result = await this.commandService.executeCommand(command, ...commandArgs);
				const text = result === undefined ? '' : typeof result === 'string' ? result : safeJson(result);
				return ok(`Ran ${command}.${text ? `\n${text.slice(0, 4_000)}` : ''}`);
			}
		}
		return fail(`extensions has no op ${op}.`);
	}
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 1) ?? '';
	} catch {
		return String(value);
	}
}
