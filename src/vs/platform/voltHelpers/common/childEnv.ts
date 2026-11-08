/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IProcessEnvironment } from '../../../base/common/platform.js';

/**
 * The environment Volt gives the processes it starts outside a sandbox (agents, commands, helpers,
 * the agent server), built from the host's by an allow rule (spec F.7, B-38, INV-24):
 *
 * - Volt's own plumbing never passes: `VSCODE_*` (the main process's IPC socket in
 *   `VSCODE_IPC_HOOK*`, whose `launch` channel opens windows with any arguments), `ELECTRON_*`
 *   (`ELECTRON_RUN_AS_NODE` turns a child Electron into Node), `CHROME_*`, `NODE_CHANNEL_FD`.
 *   A caller that needs one (a Node host) sets it itself.
 * - Secret-looking names never pass (D-18): on macOS any process can read another's environment
 *   (`KERN_PROCARGS2`, B-12), sandboxed agents of other chats included. A credential reaches a CLI
 *   through its own store, never through the environment Volt hands it.
 * - Everything else from the user's shell passes: toolchains (`PATH`, `JAVA_HOME`), locale,
 *   `SSH_AUTH_SOCK`, `DISPLAY`. These are not secrets, and agents need them.
 *
 * What the caller sets on purpose (a project's environment from Project Settings, a provider's
 * launch variables) is added afterwards and is not filtered here; the env lint test
 * (`envLint.test.ts`, K.4) keeps secret-looking names out of spawn sites in Volt's code.
 */

/** Volt's and Electron's internal variables: the IPC socket, run-as-Node, Chromium switches. */
const HOST_INTERNAL_ENV = /^(?:VSCODE_|ELECTRON_|CHROME_|GOOGLE_API_KEY$|NODE_CHANNEL_FD$|NODE_CHANNEL_SERIALIZATION_MODE$|NODE_UNIQUE_ID$|ORIGINAL_XDG_CURRENT_DESKTOP$)/i;

/**
 * Names that hold a credential by convention: tokens, keys, passwords, cookies, connection strings.
 * Covers the suffix forms `*_KEY`, `*_PAT`, `*_JWT` (B-41). Agent sockets and X authority files are
 * paths to the user's agents, not secrets, and stay.
 */
const SECRET_LIKE_ENV = /(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH(?!OR)|COOKIE|_KEY$|_PAT$|_JWT$|_DSN$|CONNECTION_?STRING|DATABASE_URL$|^PGPASS)/i;
const NOT_SECRET_ENV = /^(?:SSH_AUTH_SOCK|XAUTHORITY|GPG_AGENT_INFO|SSH_ASKPASS|SUDO_ASKPASS|GIT_ASKPASS)$/i;

/** Whether a variable name looks like it holds a credential. */
export function isSecretLikeEnvName(name: string): boolean {
	return !NOT_SECRET_ENV.test(name) && SECRET_LIKE_ENV.test(name);
}

/** Whether a variable is Volt's or Electron's own plumbing (never inherited by a child). */
export function isHostInternalEnvName(name: string): boolean {
	return HOST_INTERNAL_ENV.test(name);
}

/** Whether a host variable may be copied into a child's environment. */
export function isInheritableEnvName(name: string): boolean {
	return !isHostInternalEnvName(name) && !isSecretLikeEnvName(name);
}

/** The host environment a child may inherit: {@link isInheritableEnvName} names only. */
export function childEnvFromHost(host: IProcessEnvironment): IProcessEnvironment {
	const env: IProcessEnvironment = {};
	for (const [name, value] of Object.entries(host)) {
		if (value !== undefined && isInheritableEnvName(name)) {
			env[name] = value;
		}
	}
	return env;
}
