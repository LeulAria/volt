/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionHostKind } from './extensionHostKind.js';

export class LocalProcessRunningLocation {
	public readonly kind = ExtensionHostKind.LocalProcess;
	constructor(
		public readonly affinity: number
	) { }
	public equals(other: ExtensionRunningLocation) {
		return (this.kind === other.kind && this.affinity === other.affinity);
	}
	public asString(): string {
		if (this.affinity === 0) {
			return 'LocalProcess';
		}
		return `LocalProcess${this.affinity}`;
	}
}

export class LocalWebWorkerRunningLocation {
	public readonly kind = ExtensionHostKind.LocalWebWorker;
	constructor(
		public readonly affinity: number
	) { }
	public equals(other: ExtensionRunningLocation) {
		return (this.kind === other.kind && this.affinity === other.affinity);
	}
	public asString(): string {
		if (this.affinity === 0) {
			return 'LocalWebWorker';
		}
		return `LocalWebWorker${this.affinity}`;
	}
}

export class RemoteRunningLocation {
	public readonly kind = ExtensionHostKind.Remote;
	constructor(
		/** Volt: 0 is the shared remote host; from {@link VOLT_SANDBOX_AFFINITY_BASE} up, one sandboxed extension's own host. */
		public readonly affinity: number = 0
	) { }
	public equals(other: ExtensionRunningLocation) {
		return (this.kind === other.kind && this.affinity === other.affinity);
	}
	public asString(): string {
		if (this.affinity === 0) {
			return 'Remote';
		}
		return `Remote${this.affinity}`;
	}
}

export type ExtensionRunningLocation = LocalProcessRunningLocation | LocalWebWorkerRunningLocation | RemoteRunningLocation;

/**
 * Volt (P2, P6): affinities from here up are hosts of one extension each, run in the OS sandbox
 * (an opted-in extension). They never share a host with another extension (H.6).
 */
export const VOLT_SANDBOX_AFFINITY_BASE = 1000;

export function isVoltSandboxedRunningLocation(location: ExtensionRunningLocation | null | undefined): boolean {
	return !!location && location.affinity >= VOLT_SANDBOX_AFFINITY_BASE;
}
