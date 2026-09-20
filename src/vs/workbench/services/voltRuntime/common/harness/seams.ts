/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Capability seams. DeepSeek's "everything is a plugin" is the right *shape* -
 * a swappable capability has a definition, a provider, and a consumer - but
 * Cordis is not Volt's runtime. This registry is the Volt-owned equivalent:
 *
 *   register('fs', fileService)   a provider mounts
 *   resolve('fs')                 a consumer binds
 *   retract('fs')                 the provider unloads
 *
 * The UI never sees this. `IAgentRuntimeService` stays the only public door.
 */

export type SeamName =
	| 'llm'
	| 'tools'
	| 'fs'
	| 'sandbox'
	| 'session'
	| 'eval'
	| 'shell'
	| 'mcp';

export interface ISeamRegistration<T = unknown> {
	readonly name: SeamName;
	readonly provider: T;
	readonly source: string;
}

export class SeamRegistry {

	private readonly providers = new Map<SeamName, ISeamRegistration>();

	register<T>(name: SeamName, provider: T, source = 'runtime'): void {
		this.providers.set(name, { name, provider, source });
	}

	resolve<T>(name: SeamName): T | undefined {
		return this.providers.get(name)?.provider as T | undefined;
	}

	retract(name: SeamName, source?: string): boolean {
		const current = this.providers.get(name);
		if (!current) {
			return false;
		}
		if (source && current.source !== source) {
			return false;
		}
		return this.providers.delete(name);
	}

	has(name: SeamName): boolean {
		return this.providers.has(name);
	}

	all(): readonly ISeamRegistration[] {
		return [...this.providers.values()];
	}
}
