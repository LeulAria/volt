/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the sandbox would do on this machine, without running anything: the backend's capability
// matrix and diagnostics, and the resolved policy (real paths, environment names) for a profile and
// workspace. The home folder is shown as ~. Uses the transpiled sources in out/.
//
//   node scripts/volt-sandbox-inspect.mjs [workspace] [--profile restricted|workspace|network|agent] [--policy file.json]

import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// As bootstrap-esm sets it: the macOS backend finds its helper (.build/volt-helpers) from the app root.
globalThis._VSCODE_FILE_ROOT = join(root, 'out');
const load = path => import(pathToFileURL(join(root, 'out', path)).href);
const { createBackend } = await load('vs/platform/voltSandbox/node/sandboxManager.js');
const { builtinProfile } = await load('vs/platform/voltSandbox/common/sandboxProfiles.js');
const { agentSandboxPolicy } = await load('vs/platform/voltSandbox/common/sandboxPolicy.js');
const { checkEnforcement, redactSandboxText } = await load('vs/platform/voltSandbox/common/sandboxBackend.js');
const { composeSandboxPolicy } = await load('vs/platform/voltSandbox/common/sandboxComposition.js');
const { parseSandboxPolicyText } = await load('vs/platform/voltSandbox/common/sandboxSchema.js');
const { resolveSandboxPolicy, sandboxHostFacts } = await load('vs/platform/voltSandbox/node/sandboxResolver.js');

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const profileName = option('--profile') ?? 'workspace';
const policyFile = option('--policy');
const workspace = resolve(args[0] ?? process.cwd());

const host = await sandboxHostFacts();
const backend = createBackend(process.platform);
const capabilities = await backend.probe();
const redact = text => redactSandboxText(text, host.home);

let policy = profileName === 'agent'
	? agentSandboxPolicy({ level: 'workspace-write', network: false, providerId: 'claude-code', workspaceRoots: [workspace] }, { platform: host.platform, home: host.home, tempDirs: [host.tmpRoot], cacheDir: join(host.home, '.volt', 'sandbox-cache') })
	: builtinProfile(profileName);
let ignored = [];
if (policyFile) {
	const parsed = parseSandboxPolicyText(await fs.readFile(policyFile, 'utf8'), true);
	if (!parsed.ok) {
		console.error(`${policyFile} is not a valid sandbox policy:`);
		for (const error of parsed.errors) {
			console.error(`  ${error.path || '(root)'}: ${error.message}`);
		}
		process.exit(1);
	}
	// A policy file is treated as a repository's: untrusted, narrow-only.
	({ policy, ignored } = composeSandboxPolicy(policy, [{ source: 'workspace', trusted: false, layer: parsed.value }]));
}

console.log(`Backend: ${capabilities.backend} (${capabilities.available ? 'available' : 'UNAVAILABLE'})`);
for (const line of [...capabilities.details, ...capabilities.diagnostics]) {
	console.log(`  ${redact(line)}`);
}
console.log('\nEnforcement:');
for (const [dimension, enforcement] of Object.entries(capabilities.enforcement)) {
	const note = capabilities.notes[dimension];
	console.log(`  ${dimension.padEnd(28)} ${enforcement.padEnd(12)}${note ? ` ${note}` : ''}`);
}
const check = checkEnforcement(policy, capabilities);
console.log(`\nProfile "${policy.name}": ${check.blocking.length ? `REFUSED (cannot enforce: ${check.blocking.join(', ')})` : check.unenforced.length ? `partial (${check.unenforced.join(', ')})` : 'fully enforced'}`);
for (const note of ignored) {
	console.log(`  ignored from ${note.source}: ${note.field} ${note.value} (${note.reason})`);
}

const runTmp = await fs.mkdtemp(join(tmpdir(), 'volt-sbx-inspect-'));
try {
	const { policy: resolved, notes } = await resolveSandboxPolicy(policy, { workspaceRoots: [workspace], hostEnv: process.env }, host, runTmp);
	const shown = { ...resolved, env: Object.keys(resolved.env).sort() };
	console.log(`\nResolved policy (environment names only):\n${redact(JSON.stringify(shown, null, 2))}`);
	for (const note of notes) {
		console.log(`note: ${redact(note)}`);
	}
} catch (err) {
	console.log(`\nRefused while resolving: ${redact(err.message)}`);
} finally {
	await fs.rm(runTmp, { recursive: true, force: true });
}
