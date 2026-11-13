/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../../base/common/lifecycle.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { BrandedService, IConstructorSignature } from '../../../../platform/instantiation/common/instantiation.js';
import { ExtensionHostKind } from './extensionHostKind.js';
import { IExtensionHostProxy } from './extensionHostProxy.js';
import { IInternalExtensionService } from './extensions.js';
import { IRPCProtocol, ProxyIdentifier } from './proxyIdentifier.js';

export interface IExtHostContext extends IRPCProtocol {
	readonly remoteAuthority: string | null;
	readonly extensionHostKind: ExtensionHostKind;
	/**
	 * Whether the extension runs in this extension host. An RPC payload names its extension
	 * itself, so a customer that keys secrets, storage, sessions or a webview origin on that id
	 * honours it only for one that does (Volt, spec B-08): an extension cannot act as one running
	 * in another host. Extensions that share a host are not told apart by this.
	 */
	hostsExtension(extensionId: ExtensionIdentifier | string): boolean;
	/**
	 * Volt (P2, P6): this host runs one opted-in extension in the OS sandbox. Fixed when the host
	 * starts, from its running location, never from settings the extension could change. Customers
	 * whose calls would run or write something outside that sandbox refuse such a host.
	 */
	readonly voltSandboxed?: boolean;
}

/** Refuses a call that would run or write something outside the sandbox, from a sandboxed extension's host. */
export function assertNotVoltSandboxed(context: IExtHostContext, what: string): void {
	if (context.voltSandboxed) {
		throw new VoltSandboxedHostError(what);
	}
}

/**
 * Volt (P2): public commands that run or install something outside the sandbox (a terminal's
 * shell, a task, a debug session, an extension). A sandboxed extension's host may not run them.
 * A list, not a rule: commands of other extensions run in their own hosts as before.
 */
const SANDBOX_REFUSED_COMMAND_PREFIXES: readonly string[] = [
	'workbench.action.terminal.', 'workbench.action.tasks.', 'workbench.extensions.', 'workbench.action.debug.',
	'debug.', '_workbench.', 'workbench.action.installCommandLine', 'workbench.action.openSettingsJson',
	'workbench.action.openWorkspaceSettingsFile', 'workbench.action.openFolderSettingsFile', 'workbench.action.configureRuntimeArguments',
];

export function voltSandboxRefusesCommand(id: string): boolean {
	return SANDBOX_REFUSED_COMMAND_PREFIXES.some(prefix => id.startsWith(prefix));
}

/** Thrown to a sandboxed extension's host for an API that would act outside its sandbox. */
export class VoltSandboxedHostError extends Error {
	static readonly NAME = 'VoltSandboxRefusal';
	constructor(what: string) {
		super(`${what} is not available to an extension that runs in Volt's sandbox: it would run or write outside it.`);
		this.name = VoltSandboxedHostError.NAME;
	}
}

/**
 * Throws unless the extension named in a payload runs in the calling extension host (B-08).
 */
export function assertHostsExtension(context: IExtHostContext, extensionId: ExtensionIdentifier | string): void {
	// An identifier that crossed RPC is a plain object: only its `value` is read, as consumers do.
	const value = typeof extensionId === 'string' ? extensionId : extensionId?.value;
	if (typeof value !== 'string' || !context.hostsExtension(value)) {
		throw new ExtensionNotInHostError(String(value));
	}
}

/** Thrown to an extension host that names an extension it does not run. */
export class ExtensionNotInHostError extends Error {
	static readonly NAME = 'ExtensionNotInHost';

	constructor(readonly extensionId: string) {
		super(`Extension '${extensionId}' does not run in this extension host.`);
		this.name = ExtensionNotInHostError.NAME;
	}
}

export interface IInternalExtHostContext extends IExtHostContext {
	readonly internalExtensionService: IInternalExtensionService;
	_setExtensionHostProxy(extensionHostProxy: IExtensionHostProxy): void;
	_setAllMainProxyIdentifiers(mainProxyIdentifiers: ProxyIdentifier<any>[]): void;
}

export type IExtHostNamedCustomer<T extends IDisposable> = [ProxyIdentifier<T>, IExtHostCustomerCtor<T>];

export type IExtHostCustomerCtor<T extends IDisposable> = IConstructorSignature<T, [IExtHostContext]>;

export function extHostNamedCustomer<T extends IDisposable>(id: ProxyIdentifier<T>) {
	return function <Services extends BrandedService[]>(ctor: { new(context: IExtHostContext, ...services: Services): T }): void {
		ExtHostCustomersRegistryImpl.INSTANCE.registerNamedCustomer(id, ctor as IExtHostCustomerCtor<T>);
	};
}

export function extHostCustomer<T extends IDisposable, Services extends BrandedService[]>(ctor: { new(context: IExtHostContext, ...services: Services): T }): void {
	ExtHostCustomersRegistryImpl.INSTANCE.registerCustomer(ctor as IExtHostCustomerCtor<T>);
}

export namespace ExtHostCustomersRegistry {

	export function getNamedCustomers(): IExtHostNamedCustomer<IDisposable>[] {
		return ExtHostCustomersRegistryImpl.INSTANCE.getNamedCustomers();
	}

	export function getCustomers(): IExtHostCustomerCtor<IDisposable>[] {
		return ExtHostCustomersRegistryImpl.INSTANCE.getCustomers();
	}
}

class ExtHostCustomersRegistryImpl {

	public static readonly INSTANCE = new ExtHostCustomersRegistryImpl();

	private _namedCustomers: IExtHostNamedCustomer<any>[];
	private _customers: IExtHostCustomerCtor<any>[];

	constructor() {
		this._namedCustomers = [];
		this._customers = [];
	}

	public registerNamedCustomer<T extends IDisposable>(id: ProxyIdentifier<T>, ctor: IExtHostCustomerCtor<T>): void {
		const entry: IExtHostNamedCustomer<T> = [id, ctor];
		this._namedCustomers.push(entry);
	}
	public getNamedCustomers(): IExtHostNamedCustomer<any>[] {
		return this._namedCustomers;
	}

	public registerCustomer<T extends IDisposable>(ctor: IExtHostCustomerCtor<T>): void {
		this._customers.push(ctor);
	}
	public getCustomers(): IExtHostCustomerCtor<any>[] {
		return this._customers;
	}
}
