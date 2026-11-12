/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Iterable } from '../../../base/common/iterator.js';
import { IJSONSchema } from '../../../base/common/jsonSchema.js';
import { IDisposable, markAsSingleton, toDisposable } from '../../../base/common/lifecycle.js';
import { LinkedList } from '../../../base/common/linkedList.js';
import { TypeConstraint, validateConstraints } from '../../../base/common/types.js';
import { ILocalizedString } from '../../action/common/action.js';
import { createDecorator, ServicesAccessor } from '../../instantiation/common/instantiation.js';

export const ICommandService = createDecorator<ICommandService>('commandService');

export interface ICommandEvent {
	commandId: string;
	args: any[];
}

export interface ICommandService {
	readonly _serviceBrand: undefined;
	onWillExecuteCommand: Event<ICommandEvent>;
	onDidExecuteCommand: Event<ICommandEvent>;
	executeCommand<T = any>(commandId: string, ...args: any[]): Promise<T | undefined>;
}

export type ICommandsMap = Map<string, ICommand>;

export interface ICommandHandler {
	(accessor: ServicesAccessor, ...args: any[]): void;
}

/**
 * Who may run a command (Volt, spec I.14):
 * - `internal`: the workbench's own code only. An extension host's call is refused with
 *   {@link CommandNotAllowedError}, and an extension cannot register a command over it.
 * - `exported:<capability>`: extensions too; a documented extension API depends on it. The
 *   capability names what it lets an extension do, for the per-extension grants that come with
 *   per-extension hosts.
 * - `public`: any extension, as in VS Code.
 *
 * Volt's commands (see {@link isVoltCommandId}) are `internal` unless their registration says
 * otherwise; every other command is `public` unless marked.
 */
export type CommandVisibility = 'internal' | 'public' | `exported:${string}`;

export interface ICommand {
	id: string;
	handler: ICommandHandler;
	metadata?: ICommandMetadata | null;
	/** See {@link CommandVisibility}; when absent, {@link defaultCommandVisibility} of the id. */
	visibility?: CommandVisibility;
	/** Set by `registerCommandAlias`: the alias runs this command and is no more visible than it. */
	aliasOf?: string;
}

/** Volt's command id families: `volt.x`, `voltAgent.x`, `_volt.x`, `_voltScratch.x`. */
export function isVoltCommandId(id: string): boolean {
	return /^_?volt[A-Za-z0-9]*\./.test(id);
}

/** A command's visibility when its registration names none (or it is not registered yet). */
export function defaultCommandVisibility(id: string): CommandVisibility {
	return isVoltCommandId(id) ? 'internal' : 'public';
}

/** Thrown to an extension that runs an `internal` command. */
export class CommandNotAllowedError extends Error {
	static readonly NAME = 'CommandNotAllowed';

	constructor(readonly commandId: string) {
		super(`Command '${commandId}' is internal and cannot be run by an extension.`);
		this.name = CommandNotAllowedError.NAME;
	}
}

export interface ICommandMetadata {
	/**
	 * NOTE: Please use an ILocalizedString. string is in the type for backcompat for now.
	 * A short summary of what the command does. This will be used in:
	 * - API commands
	 * - when showing keybindings that have no other UX
	 * - when searching for commands in the Command Palette
	 */
	readonly description: ILocalizedString | string;
	readonly args?: ReadonlyArray<{
		readonly name: string;
		readonly isOptional?: boolean;
		readonly description?: string;
		readonly constraint?: TypeConstraint;
		readonly schema?: IJSONSchema;
	}>;
	readonly returns?: string;
}

export interface ICommandRegistry {
	onDidRegisterCommand: Event<string>;
	registerCommand(id: string, command: ICommandHandler, visibility?: CommandVisibility): IDisposable;
	registerCommand(command: ICommand): IDisposable;
	registerCommandAlias(oldId: string, newId: string): IDisposable;
	getCommand(id: string): ICommand | undefined;
	getCommands(): ICommandsMap;
	/**
	 * Who may run `id` now: the registration's visibility, else the id's default. An alias is
	 * never more visible than the command it runs.
	 */
	getCommandVisibility(id: string): CommandVisibility;
}

/** Orders visibilities from least to most visible; any `exported:*` sits between the others. */
function visibilityRank(visibility: CommandVisibility): number {
	return visibility === 'internal' ? 0 : visibility === 'public' ? 2 : 1;
}

export const CommandsRegistry: ICommandRegistry = new class implements ICommandRegistry {

	private readonly _commands = new Map<string, LinkedList<ICommand>>();

	private readonly _onDidRegisterCommand = new Emitter<string>();
	readonly onDidRegisterCommand: Event<string> = this._onDidRegisterCommand.event;

	registerCommand(idOrCommand: string | ICommand, handler?: ICommandHandler, visibility?: CommandVisibility): IDisposable {

		if (!idOrCommand) {
			throw new Error(`invalid command`);
		}

		if (typeof idOrCommand === 'string') {
			if (!handler) {
				throw new Error(`invalid command`);
			}
			return this.registerCommand(visibility ? { id: idOrCommand, handler, visibility } : { id: idOrCommand, handler });
		}

		// add argument validation if rich command metadata is provided
		if (idOrCommand.metadata && Array.isArray(idOrCommand.metadata.args)) {
			const constraints: Array<TypeConstraint | undefined> = [];
			for (const arg of idOrCommand.metadata.args) {
				constraints.push(arg.constraint);
			}
			const actualHandler = idOrCommand.handler;
			idOrCommand.handler = function (accessor, ...args: any[]) {
				validateConstraints(args, constraints);
				return actualHandler(accessor, ...args);
			};
		}

		// find a place to store the command
		const { id } = idOrCommand;

		let commands = this._commands.get(id);
		if (!commands) {
			commands = new LinkedList<ICommand>();
			this._commands.set(id, commands);
		}

		const removeFn = commands.unshift(idOrCommand);

		const ret = toDisposable(() => {
			removeFn();
			const command = this._commands.get(id);
			if (command?.isEmpty()) {
				this._commands.delete(id);
			}
		});

		// tell the world about this command
		this._onDidRegisterCommand.fire(id);

		return markAsSingleton(ret);
	}

	registerCommandAlias(oldId: string, newId: string): IDisposable {
		return CommandsRegistry.registerCommand({ id: oldId, handler: (accessor, ...args) => accessor.get(ICommandService).executeCommand(newId, ...args), aliasOf: newId });
	}

	getCommandVisibility(id: string): CommandVisibility {
		let visibility = defaultCommandVisibility(id);
		let current: string | undefined = id;
		const seen = new Set<string>();
		while (current !== undefined && !seen.has(current)) {
			seen.add(current);
			const command = this.getCommand(current);
			const own = command?.visibility ?? defaultCommandVisibility(current);
			visibility = current === id || visibilityRank(own) < visibilityRank(visibility) ? own : visibility;
			current = command?.aliasOf;
		}
		return visibility;
	}

	getCommand(id: string): ICommand | undefined {
		const list = this._commands.get(id);
		if (!list || list.isEmpty()) {
			return undefined;
		}
		return Iterable.first(list);
	}

	getCommands(): ICommandsMap {
		const result = new Map<string, ICommand>();
		for (const key of this._commands.keys()) {
			const command = this.getCommand(key);
			if (command) {
				result.set(key, command);
			}
		}
		return result;
	}
};

CommandsRegistry.registerCommand('noop', () => { });
