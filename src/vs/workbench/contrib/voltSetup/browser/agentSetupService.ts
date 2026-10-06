/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IVoltStdioService } from '../../../../platform/voltStdio/common/voltStdio.js';
import { CLI_AGENT_DEFINITIONS, detectCliAgent, ICliAgentDefinition } from '../../../services/voltRuntime/browser/agents/cliAgents.js';
import { IDetectResult } from '../../../services/voltRuntime/common/providers.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { AgentSignIn, agentSetupInfo, authCheckCommand, IAgentSetupInfo, installCommand, parseAuthCheck, parseCredentialsFile, SetupPlatform, setupTerminalName } from '../common/agentSetup.js';

const STATUS_TIMEOUT_MS = 10_000;

export interface IAgentSetupState {
	readonly id: string;
	readonly label: string;
	readonly earlyAccess: boolean;
	readonly installed: boolean;
	readonly version?: string;
	/** The executable found on PATH (`cursor-agent` or `agent`, ...). */
	readonly command?: string;
	readonly path?: string;
	readonly signIn: AgentSignIn;
	readonly info: IAgentSetupInfo | undefined;
}

export function setupPlatform(): SetupPlatform {
	return isWindows ? 'windows' : isMacintosh ? 'mac' : 'linux';
}

/** Finds Volt's agent CLIs, asks each whether it is signed in, and runs installs and sign-ins in a terminal. */
export class AgentSetupService {

	constructor(
		@IVoltStdioService private readonly stdio: IVoltStdioService,
		@ITerminalService private readonly terminalService: ITerminalService,
	) { }

	definitions(): readonly ICliAgentDefinition[] {
		return CLI_AGENT_DEFINITIONS;
	}

	async detect(def: ICliAgentDefinition): Promise<IAgentSetupState> {
		const info = agentSetupInfo(def.id);
		const missing: IDetectResult = { available: false };
		const found = await detectCliAgent(this.stdio, def).catch(() => missing);
		const base = { id: def.id, label: def.label, earlyAccess: !!def.earlyAccess, info };
		if (!found.available) {
			return { ...base, installed: false, signIn: { kind: 'unknown' } };
		}
		const command = def.commands.find(candidate => found.path && (found.path.endsWith(`/${candidate}`) || found.path.endsWith(`\\${candidate}`) || found.path.toLowerCase().endsWith(`\\${candidate}.exe`) || found.path.toLowerCase().endsWith(`\\${candidate}.cmd`))) ?? def.commands[0];
		const signIn = info ? await this.signIn(info, command) : { kind: 'unknown' as const };
		return { ...base, installed: true, version: found.version, command, path: found.path, signIn };
	}

	private async signIn(info: IAgentSetupInfo, command: string): Promise<AgentSignIn> {
		const check = info.authCheck;
		if (check.kind === 'none') {
			return { kind: 'unknown' };
		}
		if (check.kind === 'file') {
			const line = isWindows
				? `if exist "%USERPROFILE%\\${check.path.replace(/\//g, '\\')}" (exit 0) else (exit 1)`
				: `test -f "$HOME/${check.path}"`;
			const result = await this.exec(line);
			return parseCredentialsFile(result ? result.exitCode === 0 : undefined);
		}
		const line = authCheckCommand(check, command);
		if (!line) {
			return { kind: 'unknown' };
		}
		const result = await this.exec(line);
		return result ? parseAuthCheck(check, result.exitCode, result.stdout, result.stderr) : { kind: 'unknown' };
	}

	private async exec(command: string): Promise<{ exitCode: number | null; stdout: string; stderr: string } | undefined> {
		try {
			const result = await this.stdio.exec({ id: `volt-setup-${generateUuid().slice(0, 8)}`, command, timeoutMs: STATUS_TIMEOUT_MS, inlineChars: 8_000, env: { NO_COLOR: '1' } });
			return result.timedOut ? undefined : { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
		} catch {
			return undefined;
		}
	}

	installCommand(state: IAgentSetupState): string | undefined {
		return state.info ? installCommand(state.info, setupPlatform()) : undefined;
	}

	loginCommand(state: IAgentSetupState): string | undefined {
		const login = state.info?.login;
		if (!login) {
			return undefined;
		}
		// `cursor-agent login` when only `agent` is installed, and so on.
		const def = CLI_AGENT_DEFINITIONS.find(candidate => candidate.id === state.id);
		const [first, ...rest] = login.split(' ');
		return state.command && def?.commands.includes(first) ? [state.command, ...rest].join(' ') : login;
	}

	/** Opens a terminal the user can see and runs `command` in it. Fires when that terminal closes. */
	async runInTerminal(action: 'install' | 'login', label: string, command: string): Promise<Event<unknown>> {
		const terminal = await this.terminalService.createTerminal({ config: { name: setupTerminalName(action, label) } });
		this.terminalService.setActiveInstance(terminal);
		await this.terminalService.revealActiveTerminal();
		await terminal.sendText(command, true);
		return Event.map(terminal.onDisposed, () => undefined);
	}
}
