/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What a project can be run with, read from its files the way VS Code's Run and Debug reads
 * launch.json: Flutter, Expo, React Native, package.json scripts, and a few other stacks. Each
 * runner says which devices it runs on (a simulator, an emulator, Volt's browser, the desktop),
 * and the command for a picked device.
 */

/** Where a run shows: a simulator or emulator in the device panel, Volt's browser, or this computer. */
export type AgentRunDeviceKind = 'ios' | 'android' | 'browser' | 'desktop';

export type AgentRunStack = 'flutter' | 'expo' | 'react-native' | 'web' | 'node' | 'python' | 'go' | 'rust' | 'dart';

/** The picked device as a runner needs it. */
export interface IAgentRunDevice {
	readonly kind: AgentRunDeviceKind;
	/** The simulator's UDID, the emulator's adb serial once it runs (else its AVD name), or the desktop's platform (`macos`). */
	readonly id?: string;
	readonly name: string;
}

/** A command that runs the project in a terminal, detected from its files. */
export interface IAgentRunScript {
	/** Stable across reads, e.g. `flutter`, `npm:dev`. */
	readonly id: string;
	/** As the picker shows it: "Flutter", "npm run dev". */
	readonly label: string;
	/** The file it came from, and the command. */
	readonly description: string;
	readonly stack: AgentRunStack;
	/** The devices it runs on, first is the default; empty when it only prints to a terminal. */
	readonly devices: readonly AgentRunDeviceKind[];
	/** The command with no device picked. */
	readonly command: string;
}

/** Top-level names and the few files whose contents say what the project is. */
export interface IAgentRunProjectFiles {
	/** The project folder's top-level entries (files and folders). */
	readonly names: ReadonlySet<string>;
	readonly packageJson?: string;
	readonly pubspec?: string;
	/** This computer's system: which of Flutter's desktop folders (macos, windows, linux) counts. */
	readonly platform: 'mac' | 'windows' | 'linux';
}

const LOCAL_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:\/[^\s"'<>`]*)?/i;

/** The first local web address in a run's output (Vite's "Local:", Flutter's "being served at"), as Volt's browser opens it. */
export function findLocalUrl(text: string): string | undefined {
	const match = LOCAL_URL_RE.exec(text);
	if (!match) {
		return undefined;
	}
	// Sentence punctuation after the address is not part of it.
	return match[0].replace(/[.,;:)\]]+$/, '').replace('://0.0.0.0', '://localhost');
}

/** Scripts that start something to look at; listed first, in this order. */
const PREFERRED_SCRIPTS = ['dev', 'start', 'serve', 'preview', 'web', 'storybook'];
/** A script whose body starts one of these serves a web page. */
const WEB_SCRIPT_RE = /\b(vite|next(?:\s+(?:dev|start))?|nuxt|astro|remix|svelte-kit|webpack(?:-dev-server|\s+serve)|react-scripts\s+start|ng\s+serve|parcel|http-server|live-server|serve\b|storybook|gatsby\s+develop|vue-cli-service\s+serve|expo\s+start\s+--web|eleventy\s+--serve|docusaurus\s+start|wrangler\s+dev)\b/i;
const SCRIPT_NAME_RE = /^(dev|start|serve|preview|web|storybook|watch)(?::[\w-]+)?$/i;
/** Between a runner's command and the file it came from: a middle dot. */
export const RUN_DESCRIPTION_SEPARATOR = ` ${String.fromCharCode(0xB7)} `;
const DOT = RUN_DESCRIPTION_SEPARATOR;
/** At most this many package.json scripts, after the preferred ones. */
const MAX_SCRIPTS = 8;

/** Runners for the project, best first: its stack's own runner, then its package.json scripts, then other stacks. */
export function detectRunScripts(files: IAgentRunProjectFiles): IAgentRunScript[] {
	const scripts: IAgentRunScript[] = [];
	const pkg = parsePackageJson(files.packageJson);
	const pm = packageManager(files.names);

	if (files.pubspec !== undefined) {
		if (/^\s*flutter\s*:/m.test(files.pubspec) || /sdk\s*:\s*flutter/.test(files.pubspec)) {
			const devices: AgentRunDeviceKind[] = [];
			if (files.names.has('ios')) {
				devices.push('ios');
			}
			if (files.names.has('android')) {
				devices.push('android');
			}
			if (files.names.has('web')) {
				devices.push('browser');
			}
			const desktop = files.platform === 'mac' ? 'macos' : files.platform;
			if (files.names.has(desktop)) {
				devices.push('desktop');
			}
			// A new project without platform folders still runs on whatever Flutter finds.
			scripts.push({ id: 'flutter', label: 'Flutter', description: `flutter run${DOT}pubspec.yaml`, stack: 'flutter', devices: devices.length ? devices : ['ios', 'android', 'browser'], command: 'flutter run' });
		} else {
			scripts.push({ id: 'dart', label: 'Dart', description: `dart run${DOT}pubspec.yaml`, stack: 'dart', devices: [], command: 'dart run' });
		}
	}

	if (pkg) {
		const deps = { ...pkg.dependencies, ...pkg.devDependencies };
		if (deps['expo']) {
			scripts.push({ id: 'expo', label: 'Expo', description: `npx expo start${DOT}package.json`, stack: 'expo', devices: ['ios', 'android', 'browser'], command: 'npx expo start' });
		} else if (deps['react-native']) {
			const devices: AgentRunDeviceKind[] = [];
			if (files.names.has('ios')) {
				devices.push('ios');
			}
			if (files.names.has('android')) {
				devices.push('android');
			}
			scripts.push({ id: 'react-native', label: 'React Native', description: `npx react-native${DOT}package.json`, stack: 'react-native', devices: devices.length ? devices : ['ios', 'android'], command: 'npx react-native start' });
		}
		const names = Object.keys(pkg.scripts);
		const preferred = PREFERRED_SCRIPTS.filter(name => names.includes(name));
		const others = names.filter(name => !preferred.includes(name) && SCRIPT_NAME_RE.test(name));
		for (const name of [...preferred, ...others].slice(0, MAX_SCRIPTS)) {
			const body = pkg.scripts[name];
			const web = WEB_SCRIPT_RE.test(body) || (PREFERRED_SCRIPTS.includes(name) && !!webFramework(deps));
			const command = runScriptCommand(pm, name);
			scripts.push({ id: `npm:${name}`, label: command, description: `${body}${DOT}package.json`, stack: web ? 'web' : 'node', devices: web ? ['browser'] : [], command });
		}
	}

	if (files.names.has('manage.py')) {
		scripts.push({ id: 'django', label: 'Django', description: 'python manage.py runserver', stack: 'python', devices: ['browser'], command: 'python manage.py runserver' });
	}
	if (files.names.has('go.mod')) {
		scripts.push({ id: 'go', label: 'go run .', description: 'go.mod', stack: 'go', devices: [], command: 'go run .' });
	}
	if (files.names.has('Cargo.toml')) {
		scripts.push({ id: 'cargo', label: 'cargo run', description: 'Cargo.toml', stack: 'rust', devices: [], command: 'cargo run' });
	}
	if (!scripts.length && files.names.has('index.html')) {
		scripts.push({ id: 'static', label: 'Serve index.html', description: 'npx serve', stack: 'web', devices: ['browser'], command: 'npx --yes serve -l 4173 .' });
	}
	return scripts;
}

/** The command that runs the script on the picked device. Undefined device: the script's own default. */
export function runCommandFor(script: IAgentRunScript, device: IAgentRunDevice | undefined): string {
	if (!device) {
		return script.command;
	}
	switch (script.stack) {
		case 'flutter': {
			if (device.kind === 'browser') {
				// Served, not opened in Chrome: Volt opens the address it prints in its own browser.
				return 'flutter run -d web-server';
			}
			if (device.kind === 'desktop') {
				return `flutter run -d ${device.id ?? 'macos'}`;
			}
			return device.id ? `flutter run -d ${shellQuote(device.id)}` : 'flutter run';
		}
		case 'expo':
			return device.kind === 'ios' ? 'npx expo start --ios' : device.kind === 'android' ? 'npx expo start --android' : device.kind === 'browser' ? 'npx expo start --web' : script.command;
		case 'react-native':
			if (device.kind === 'ios') {
				return device.id ? `npx react-native run-ios --udid ${shellQuote(device.id)}` : 'npx react-native run-ios';
			}
			if (device.kind === 'android') {
				return device.id ? `npx react-native run-android --deviceId ${shellQuote(device.id)}` : 'npx react-native run-android';
			}
			return script.command;
		default:
			return script.command;
	}
}

/** Whether the run's output needs reading for a local address to open in Volt's browser. */
export function runOpensBrowser(script: IAgentRunScript, device: IAgentRunDevice | undefined): boolean {
	if (device) {
		return device.kind === 'browser';
	}
	return script.devices[0] === 'browser';
}

/**
 * The prompt behind "Let Agent Debug and Run the App": the agent finds how the project runs, starts
 * it, shows it inside Volt, and fixes what stops it. The chat shows a chip, not this text.
 */
export function agentRunPrompt(options: { readonly folder: string; readonly device?: string; readonly runners: readonly string[] }): string {
	const lines = [
		`Work out how to run this project (${options.folder}) and run it for me inside Volt.`,
		'Read what says how it runs (package.json scripts, pubspec.yaml, README, .vscode/launch.json, Makefile) and install missing dependencies if it needs them.',
		'Start it with terminal_start so I can watch it.',
		options.device
			? `Run it on ${options.device} (I picked it in Volt's Run menu).`
			: 'If it is a mobile app (Flutter, React Native, Expo, iOS or Android), list the simulators and emulators with device_list and ask me which one to use with ask_question (add Volt\'s browser when it also runs on the web), then start it with device_boot so it shows in Volt\'s device panel, and run the app on it.',
		'If it is a web app, open its local address in Volt\'s browser with browser_navigate.',
		'If it fails to start, read the error, fix the cause and start it again.',
		'When it is running, reply with one short line: what runs and where.',
	];
	if (options.runners.length) {
		lines.splice(2, 0, `Volt found these ways to run it: ${options.runners.join(', ')}.`);
	}
	return lines.join(' ');
}

interface IPackageJson {
	readonly scripts: Record<string, string>;
	readonly dependencies: Record<string, string>;
	readonly devDependencies: Record<string, string>;
}

function parsePackageJson(raw: string | undefined): IPackageJson | undefined {
	if (!raw) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const record = (value: unknown): Record<string, string> => {
			const out: Record<string, string> = {};
			if (value && typeof value === 'object') {
				for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
					if (typeof entry === 'string') {
						out[key] = entry;
					}
				}
			}
			return out;
		};
		return { scripts: record(parsed.scripts), dependencies: record(parsed.dependencies), devDependencies: record(parsed.devDependencies) };
	} catch {
		return undefined;
	}
}

function webFramework(deps: Record<string, string>): string | undefined {
	return ['vite', 'next', 'nuxt', 'astro', '@remix-run/dev', '@sveltejs/kit', 'react-scripts', '@angular/cli', 'parcel', 'gatsby', '@vue/cli-service', 'webpack-dev-server'].find(name => !!deps[name]);
}

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

function packageManager(names: ReadonlySet<string>): PackageManager {
	if (names.has('pnpm-lock.yaml')) {
		return 'pnpm';
	}
	if (names.has('yarn.lock')) {
		return 'yarn';
	}
	if (names.has('bun.lockb') || names.has('bun.lock')) {
		return 'bun';
	}
	return 'npm';
}

function runScriptCommand(pm: PackageManager, name: string): string {
	switch (pm) {
		case 'yarn': return `yarn ${name}`;
		case 'pnpm': return `pnpm ${name}`;
		case 'bun': return `bun run ${name}`;
		default: return name === 'start' ? 'npm start' : `npm run ${name}`;
	}
}

function shellQuote(value: string): string {
	return /^[\w.:@/-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
