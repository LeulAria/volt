/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as net from 'net';
import { VSBuffer } from '../../base/common/buffer.js';
import { Emitter, Event } from '../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../base/common/lifecycle.js';
import { FileAccess } from '../../base/common/network.js';
import { delimiter, join } from '../../base/common/path.js';
import { IProcessEnvironment, isWindows } from '../../base/common/platform.js';
import { removeDangerousEnvVariables } from '../../base/common/processes.js';
import { createRandomIPCHandle, NodeSocket, WebSocketNodeSocket } from '../../base/parts/ipc/node/ipc.net.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IRemoteExtensionHostStartParams } from '../../platform/remote/common/remoteAgentConnection.js';
import { getResolvedShellEnv } from '../../platform/shell/node/shellEnv.js';
import { IExtensionHostStatusService } from './extensionHostStatusService.js';
import { getNLSConfiguration } from './remoteLanguagePacks.js';
import { IServerEnvironmentService } from './serverEnvironmentService.js';
import { IPCExtHostConnection, SocketExtHostConnection, writeExtHostConnection } from '../../workbench/services/extensions/common/extensionHostEnv.js';
import { IExtHostReadyMessage, IExtHostReduceGraceTimeMessage, IExtHostSocketMessage } from '../../workbench/services/extensions/common/extensionHostProtocol.js';
import type { IVoltSandboxedHostStartParams } from '../../platform/voltSandbox/common/extensionHostSandbox.js';
import type { ISandboxedHost } from '../../platform/voltSandbox/node/supervisor.js';

export async function buildUserEnvironment(startParamsEnv: { [key: string]: string | null } = {}, withUserShellEnvironment: boolean, language: string, environmentService: IServerEnvironmentService, logService: ILogService, configurationService: IConfigurationService): Promise<IProcessEnvironment> {
	const nlsConfig = await getNLSConfiguration(language, environmentService.userDataPath);

	let userShellEnv: typeof process.env = {};
	if (withUserShellEnvironment) {
		try {
			userShellEnv = await getResolvedShellEnv(configurationService, logService, environmentService.args, process.env);
		} catch (error) {
			logService.error('ExtensionHostConnection#buildUserEnvironment resolving shell environment failed', error);
		}
	}

	const processEnv = process.env;

	const env: IProcessEnvironment = {
		...processEnv,
		...userShellEnv,
		...{
			VSCODE_ESM_ENTRYPOINT: 'vs/workbench/api/node/extensionHostProcess',
			VSCODE_HANDLES_UNCAUGHT_ERRORS: 'true',
			VSCODE_NLS_CONFIG: JSON.stringify(nlsConfig)
		},
		...startParamsEnv
	};

	const binFolder = environmentService.isBuilt ? join(environmentService.appRoot, 'bin') : join(environmentService.appRoot, 'resources', 'server', 'bin-dev');
	const remoteCliBinFolder = join(binFolder, 'remote-cli'); // contains the `code` command that can talk to the remote server

	let PATH = readCaseInsensitive(env, 'PATH');
	if (PATH) {
		PATH = remoteCliBinFolder + delimiter + PATH;
	} else {
		PATH = remoteCliBinFolder;
	}
	setCaseInsensitive(env, 'PATH', PATH);

	if (!environmentService.args['without-browser-env-var']) {
		env.BROWSER = join(binFolder, 'helpers', isWindows ? 'browser.cmd' : 'browser.sh'); // a command that opens a browser on the local machine
	}

	removeNulls(env);
	return env;
}

/** A sandboxed extension host, started and attested; `ready` resolves when it asks for its connection. */
export interface ISandboxedExtensionHostStart {
	readonly host: ISandboxedHost;
	readonly ready: Promise<boolean>;
}

export interface IVoltExtensionHostSandboxStartOptions {
	/** The user's environment (shell env included) the host's fixed list copies from. */
	readonly hostEnv: Readonly<Record<string, string | undefined>>;
	readonly nlsConfig?: string;
	/** `bootstrap-fork` flags. */
	readonly args: readonly string[];
	/** This server's folders (file paths): where it finds the extension and where the host may write. */
	readonly dirs: {
		readonly extensions: string;
		readonly builtinExtensions: string;
		readonly globalStorage: string;
		readonly workspaceStorage: string;
		readonly logs: string;
	};
}

/**
 * Volt (P2): starts one extension alone in a sandboxed extension host (the agent server provides
 * it, `serverExtensionSandbox.ts`). A refusal is typed, and the window shows it; nothing falls back
 * to the unsandboxed fork.
 */
export interface IVoltExtensionHostSandbox {
	start(params: IVoltSandboxedHostStartParams, options: IVoltExtensionHostSandboxStartOptions): Promise<{ readonly ok: true; readonly started: ISandboxedExtensionHostStart } | { readonly ok: false; readonly code: string; readonly reason: string }>;
}

/** The sandboxed start for `startParams.voltSandbox`, before the connection is accepted, so a refusal goes back on it. */
export async function startSandboxedExtensionHost(sandbox: IVoltExtensionHostSandbox | undefined, startParams: IRemoteExtensionHostStartParams, accessor: { environmentService: IServerEnvironmentService; logService: ILogService; configurationService: IConfigurationService; userEnvironment?: () => Promise<IProcessEnvironment> }): Promise<{ readonly ok: true; readonly started: ISandboxedExtensionHostStart } | { readonly ok: false; readonly code: string; readonly reason: string }> {
	const params = startParams.voltSandbox;
	if (!params || typeof params.extensionId !== 'string' || !/^[a-z0-9-]+\.[a-z0-9-]+$/i.test(params.extensionId)) {
		return { ok: false, code: 'request', reason: 'The request names no extension.' };
	}
	if (!sandbox) {
		return { ok: false, code: 'platform', reason: 'This server does not run sandboxed extension hosts.' };
	}
	// The user's environment as a forked host would get it; the sandbox copies only the fixed list from it.
	const hostEnv = await (accessor.userEnvironment?.() ?? buildUserEnvironment(startParams.env, true, startParams.language, accessor.environmentService, accessor.logService, accessor.configurationService));
	const args = ['--type=extensionHost', ...(params.transformURIs ? ['--transformURIs'] : []), '--useHostProxy=false'];
	const environment = accessor.environmentService;
	return sandbox.start(params, {
		hostEnv, nlsConfig: hostEnv['VSCODE_NLS_CONFIG'], args,
		dirs: {
			extensions: environment.extensionsPath,
			builtinExtensions: environment.builtinExtensionsPath,
			globalStorage: join(environment.userRoamingDataHome.fsPath, 'globalStorage'),
			workspaceStorage: environment.workspaceStorageHome.fsPath,
			logs: environment.logsHome.fsPath,
		},
	});
}

class ConnectionData {
	constructor(
		public readonly socket: NodeSocket | WebSocketNodeSocket,
		public readonly initialDataChunk: VSBuffer
	) { }

	public socketDrain(): Promise<void> {
		return this.socket.drain();
	}

	public toIExtHostSocketMessage(): IExtHostSocketMessage {

		let skipWebSocketFrames: boolean;
		let permessageDeflate: boolean;
		let inflateBytes: VSBuffer;

		if (this.socket instanceof NodeSocket) {
			skipWebSocketFrames = true;
			permessageDeflate = false;
			inflateBytes = VSBuffer.alloc(0);
		} else {
			skipWebSocketFrames = false;
			permessageDeflate = this.socket.permessageDeflate;
			inflateBytes = this.socket.recordedInflateBytes;
		}

		return {
			type: 'VSCODE_EXTHOST_IPC_SOCKET',
			initialDataChunk: (<Buffer>this.initialDataChunk.buffer).toString('base64'),
			skipWebSocketFrames: skipWebSocketFrames,
			permessageDeflate: permessageDeflate,
			inflateBytes: (<Buffer>inflateBytes.buffer).toString('base64'),
		};
	}
}

export class ExtensionHostConnection extends Disposable {

	private _onClose = new Emitter<void>();
	readonly onClose: Event<void> = this._onClose.event;

	private readonly _canSendSocket: boolean;
	private _disposed: boolean;
	private _remoteAddress: string;
	private _extensionHostProcess: cp.ChildProcess | null;
	private _sandboxedHost: ISandboxedHost | null = null;
	private _sandboxedReady = false;
	private _connectionData: ConnectionData | null;

	constructor(
		private readonly _reconnectionToken: string,
		remoteAddress: string,
		socket: NodeSocket | WebSocketNodeSocket,
		initialDataChunk: VSBuffer,
		@IServerEnvironmentService private readonly _environmentService: IServerEnvironmentService,
		@ILogService private readonly _logService: ILogService,
		@IExtensionHostStatusService private readonly _extensionHostStatusService: IExtensionHostStatusService,
		@IConfigurationService private readonly _configurationService: IConfigurationService
	) {
		super();
		this._canSendSocket = (!isWindows || !this._environmentService.args['socket-path']);
		this._disposed = false;
		this._remoteAddress = remoteAddress;
		this._extensionHostProcess = null;
		this._connectionData = new ConnectionData(socket, initialDataChunk);

		this._log(`New connection established.`);
	}

	override dispose(): void {
		this._cleanResources();
		super.dispose();
	}

	private get _logPrefix(): string {
		return `[${this._remoteAddress}][${this._reconnectionToken.substr(0, 8)}][ExtensionHostConnection] `;
	}

	private _log(_str: string): void {
		this._logService.info(`${this._logPrefix}${_str}`);
	}

	private _logError(_str: string): void {
		this._logService.error(`${this._logPrefix}${_str}`);
	}

	private async _pipeSockets(extHostSocket: net.Socket, connectionData: ConnectionData): Promise<void> {

		const disposables = new DisposableStore();
		disposables.add(connectionData.socket);
		disposables.add(toDisposable(() => {
			extHostSocket.destroy();
		}));

		const stopAndCleanup = () => {
			disposables.dispose();
		};

		disposables.add(connectionData.socket.onEnd(stopAndCleanup));
		disposables.add(connectionData.socket.onClose(stopAndCleanup));

		disposables.add(Event.fromNodeEventEmitter<void>(extHostSocket, 'end')(stopAndCleanup));
		disposables.add(Event.fromNodeEventEmitter<void>(extHostSocket, 'close')(stopAndCleanup));
		disposables.add(Event.fromNodeEventEmitter<void>(extHostSocket, 'error')(stopAndCleanup));

		disposables.add(connectionData.socket.onData((e) => extHostSocket.write(e.buffer)));
		disposables.add(Event.fromNodeEventEmitter<Buffer>(extHostSocket, 'data')((e) => {
			connectionData.socket.write(VSBuffer.wrap(e));
		}));

		if (connectionData.initialDataChunk.byteLength > 0) {
			extHostSocket.write(connectionData.initialDataChunk.buffer);
		}
	}

	private async _sendSocketToExtensionHost(extensionHostProcess: cp.ChildProcess | ISandboxedHost, connectionData: ConnectionData): Promise<void> {
		// Make sure all outstanding writes have been drained before sending the socket
		await connectionData.socketDrain();
		const msg = connectionData.toIExtHostSocketMessage();
		let socket: net.Socket;
		if (connectionData.socket instanceof NodeSocket) {
			socket = connectionData.socket.socket;
		} else {
			socket = connectionData.socket.socket.socket;
		}
		extensionHostProcess.send(msg, socket);
	}

	public shortenReconnectionGraceTimeIfNecessary(): void {
		const host = this._extensionHostProcess ?? this._sandboxedHost;
		if (!host) {
			return;
		}
		const msg: IExtHostReduceGraceTimeMessage = {
			type: 'VSCODE_EXTHOST_IPC_REDUCE_GRACE_TIME'
		};
		host.send(msg);
	}

	public acceptReconnection(remoteAddress: string, _socket: NodeSocket | WebSocketNodeSocket, initialDataChunk: VSBuffer): void {
		this._remoteAddress = remoteAddress;
		this._log(`The client has reconnected.`);
		const connectionData = new ConnectionData(_socket, initialDataChunk);

		const host = this._extensionHostProcess ?? (this._sandboxedReady ? this._sandboxedHost : null);
		if (!host) {
			// The extension host didn't even start up yet
			this._connectionData = connectionData;
			return;
		}

		this._sendSocketToExtensionHost(host, connectionData);
	}

	private _cleanResources(): void {
		if (this._disposed) {
			// already called
			return;
		}
		this._disposed = true;
		if (this._connectionData) {
			this._connectionData.socket.end();
			this._connectionData = null;
		}
		if (this._extensionHostProcess) {
			this._extensionHostProcess.kill();
			this._extensionHostProcess = null;
		}
		if (this._sandboxedHost) {
			// The whole tree, through the supervisor.
			void this._sandboxedHost.terminate('stopped');
			this._sandboxedHost = null;
		}
		this._onClose.fire(undefined);
	}

	/**
	 * Volt (P2): the extension host was started alone in the sandbox, by the supervisor, before the
	 * connection was accepted (`startSandboxedExtensionHost`). It gets its connection on its channel
	 * once it is ready, as a forked host does.
	 */
	private _startSandboxed(started: ISandboxedExtensionHostStart): void {
		const host = started.host;
		this._sandboxedHost = host;
		const pid = host.pid;
		this._log(`<${pid}> Extension Host Process running in the sandbox (${host.label}).`);
		this._register(host.onExit(exit => {
			const tail = host.stderrTail().trim().split('\n').slice(-5).join('\n');
			if (tail) {
				this._log(`<${pid}><stderr> ${tail}`);
			}
			this._extensionHostStatusService.setExitInfo(this._reconnectionToken, { code: exit.code ?? 0, signal: exit.signal ?? '' });
			this._log(`<${pid}> Sandboxed Extension Host Process exited (${exit.reason}, code: ${exit.code}, signal: ${exit.signal}).`);
			this._sandboxedHost = null;
			this._cleanResources();
		}));
		void started.ready.then(ready => {
			if (ready && this._sandboxedHost === host && this._connectionData) {
				this._sandboxedReady = true;
				this._sendSocketToExtensionHost(host, this._connectionData);
				this._connectionData = null;
			}
		});
	}

	public async start(startParams: IRemoteExtensionHostStartParams, sandboxed?: ISandboxedExtensionHostStart): Promise<void> {
		if (sandboxed) {
			this._startSandboxed(sandboxed);
			return;
		}
		try {
			let execArgv: string[] = process.execArgv ? process.execArgv.filter(a => !/^--inspect(-brk)?=/.test(a)) : [];
			if (startParams.port && !(<any>process).pkg) {
				execArgv = [
					`--inspect${startParams.break ? '-brk' : ''}=${startParams.port}`,
					'--experimental-network-inspection'
				];
			}

			const env = await buildUserEnvironment(startParams.env, true, startParams.language, this._environmentService, this._logService, this._configurationService);
			removeDangerousEnvVariables(env);

			let extHostNamedPipeServer: net.Server | null;

			if (this._canSendSocket) {
				writeExtHostConnection(new SocketExtHostConnection(), env);
				extHostNamedPipeServer = null;
			} else {
				const { namedPipeServer, pipeName } = await this._listenOnPipe();
				writeExtHostConnection(new IPCExtHostConnection(pipeName), env);
				extHostNamedPipeServer = namedPipeServer;
			}

			const opts = {
				env,
				execArgv,
				silent: true
			};

			// Refs https://github.com/microsoft/vscode/issues/189805
			opts.execArgv.unshift('--dns-result-order=ipv4first');

			// Run Extension Host as fork of current process
			const args = ['--type=extensionHost', `--transformURIs`];
			const useHostProxy = this._environmentService.args['use-host-proxy'];
			args.push(`--useHostProxy=${useHostProxy ? 'true' : 'false'}`);
			if (this._configurationService.getValue<boolean>('extensions.supportNodeGlobalNavigator')) {
				args.push('--supportGlobalNavigator');
			}
			this._extensionHostProcess = cp.fork(FileAccess.asFileUri('bootstrap-fork').fsPath, args, opts);
			const pid = this._extensionHostProcess.pid;
			this._log(`<${pid}> Launched Extension Host Process.`);

			// Catch all output coming from the extension host process
			this._extensionHostProcess.stdout!.setEncoding('utf8');
			this._extensionHostProcess.stderr!.setEncoding('utf8');
			const onStdout = Event.fromNodeEventEmitter<string>(this._extensionHostProcess.stdout!, 'data');
			const onStderr = Event.fromNodeEventEmitter<string>(this._extensionHostProcess.stderr!, 'data');
			this._register(onStdout((e) => this._log(`<${pid}> ${e}`)));
			this._register(onStderr((e) => this._log(`<${pid}><stderr> ${e}`)));

			// Lifecycle
			this._extensionHostProcess.on('error', (err) => {
				this._logError(`<${pid}> Extension Host Process had an error`);
				this._logService.error(err);
				this._cleanResources();
			});

			this._extensionHostProcess.on('exit', (code: number, signal: string) => {
				this._extensionHostStatusService.setExitInfo(this._reconnectionToken, { code, signal });
				this._log(`<${pid}> Extension Host Process exited with code: ${code}, signal: ${signal}.`);
				this._cleanResources();
			});

			if (extHostNamedPipeServer) {
				extHostNamedPipeServer.on('connection', (socket) => {
					extHostNamedPipeServer.close();
					this._pipeSockets(socket, this._connectionData!);
				});
			} else {
				const messageListener = (msg: IExtHostReadyMessage) => {
					if (msg.type === 'VSCODE_EXTHOST_IPC_READY') {
						this._extensionHostProcess!.removeListener('message', messageListener);
						this._sendSocketToExtensionHost(this._extensionHostProcess!, this._connectionData!);
						this._connectionData = null;
					}
				};
				this._extensionHostProcess.on('message', messageListener);
			}

		} catch (error) {
			console.error('ExtensionHostConnection errored');
			if (error) {
				console.error(error);
			}
		}
	}

	private _listenOnPipe(): Promise<{ pipeName: string; namedPipeServer: net.Server }> {
		return new Promise<{ pipeName: string; namedPipeServer: net.Server }>((resolve, reject) => {
			const pipeName = createRandomIPCHandle();

			const namedPipeServer = net.createServer();
			namedPipeServer.on('error', reject);
			namedPipeServer.listen(pipeName, () => {
				namedPipeServer?.removeListener('error', reject);
				resolve({ pipeName, namedPipeServer });
			});
		});
	}
}

function readCaseInsensitive(env: { [key: string]: string | undefined }, key: string): string | undefined {
	const pathKeys = Object.keys(env).filter(k => k.toLowerCase() === key.toLowerCase());
	const pathKey = pathKeys.length > 0 ? pathKeys[0] : key;
	return env[pathKey];
}

function setCaseInsensitive(env: { [key: string]: unknown }, key: string, value: string): void {
	const pathKeys = Object.keys(env).filter(k => k.toLowerCase() === key.toLowerCase());
	const pathKey = pathKeys.length > 0 ? pathKeys[0] : key;
	env[pathKey] = value;
}

function removeNulls(env: { [key: string]: unknown | null }): void {
	// Don't delete while iterating the object itself
	for (const key of Object.keys(env)) {
		if (env[key] === null) {
			delete env[key];
		}
	}
}
