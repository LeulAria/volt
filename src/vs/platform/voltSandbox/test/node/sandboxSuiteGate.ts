/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ISandboxBackendCapabilities } from '../../common/sandboxBackend.js';
import { SandboxDimension } from '../../common/sandboxSchema.js';

/**
 * The rule every suite that runs real sandboxes follows: a machine whose backend cannot run the
 * suite skips it loudly; with `VOLT_SANDBOX_REQUIRED` set (CI's Sandbox Security job and the Linux
 * rig, which install a working backend) the suite FAILS instead, so CI cannot pass without
 * actually exercising the sandbox. Generic test jobs (bubblewrap without socat, or a bubblewrap
 * the probe refuses) only skip.
 */

export const SANDBOX_REQUIRED = !!process.env.VOLT_SANDBOX_REQUIRED;

/**
 * Dimensions the platform-independent real-sandbox tests rely on. A backend missing one is not a
 * working backend for them: bubblewrap without socat has no `network.proxy`, and a chat's sandbox
 * with the network off runs through the proxy.
 */
export const SUITE_DIMENSIONS: readonly SandboxDimension[] = ['filesystem.read', 'filesystem.write', 'filesystem.deny', 'filesystem.protect', 'network.none', 'network.proxy', 'network.loopbackPorts', 'host.unixSockets', 'env.clear'];

/**
 * Writes a skip notice straight to stderr. Not `console.*`: the Electron runner fails any test
 * during which the console was used. Call it from `suiteSetup`, never while the file loads: the
 * Node runner fails ("should not explode while loading") when anything reaches stderr then.
 */
export function writeSkipNotice(message: string, skipped: string): void {
	process.stderr.write(`\n\n!!! ${message}\n!!! ${skipped} SKIPPED. Set VOLT_SANDBOX_REQUIRED=1 to make this fail.\n\n`);
}

/**
 * Whether this machine's backend can run a real-sandbox suite: available, and enforcing every
 * dimension in `dimensions`. When it cannot, throws under `VOLT_SANDBOX_REQUIRED`, else writes a
 * loud skip notice and returns false (the suite's `setup` then skips each test).
 */
export function realSandboxAvailable(capabilities: ISandboxBackendCapabilities, suiteName: string, dimensions: readonly SandboxDimension[] = SUITE_DIMENSIONS): boolean {
	const missing = capabilities.available ? dimensions.filter(dimension => capabilities.enforcement[dimension] !== 'enforced') : [];
	if (capabilities.available && missing.length === 0) {
		return true;
	}
	const message = `[volt-sandbox] NO SANDBOX BACKEND on ${process.platform}: ${missing.length ? `not enforced: ${missing.join(', ')}.` : ''} ${capabilities.diagnostics.join(' ')}`.trim();
	if (SANDBOX_REQUIRED) {
		throw new Error(`${message} (CI requires the sandbox; failing instead of skipping)`);
	}
	writeSkipNotice(message, `The ${suiteName} is`);
	return false;
}
