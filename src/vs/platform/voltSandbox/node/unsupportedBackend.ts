/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { allEnforcement, ISandboxBackendCapabilities, SandboxUnavailableError } from '../common/sandboxBackend.js';
import { ISandboxBackend, ISandboxLaunchSpec } from './sandboxBackends.js';

/**
 * Platforms without an OS sandbox backend (Windows today). Every launch is refused: Volt never
 * runs a workload that asked for a sandbox without one. MXC is the recommended Windows backend
 * (docs/security/sandbox/01-decisions.md, ADR-5).
 */
export class UnsupportedBackend implements ISandboxBackend {

	readonly id = 'unsupported' as const;

	constructor(private readonly platform: string) { }

	async probe(): Promise<ISandboxBackendCapabilities> {
		const reason = this.platform === 'win32'
			? 'OS sandboxing is not available on Windows yet. Sandboxed runs are refused rather than run without isolation.'
			: `OS sandboxing is not available on ${this.platform}.`;
		return { backend: 'unsupported', available: false, enforcement: allEnforcement('unsupported'), notes: {}, details: [], diagnostics: [reason] };
	}

	async launch(): Promise<ISandboxLaunchSpec> {
		const { diagnostics } = await this.probe();
		throw new SandboxUnavailableError(diagnostics[0], 'unavailable', [], diagnostics);
	}
}
