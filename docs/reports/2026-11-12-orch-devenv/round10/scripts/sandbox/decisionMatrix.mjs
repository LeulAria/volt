/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// macOS: what the REAL agent policy (real home folder, real temp folders) decides for real path
// classes and Mach services, without touching any of them. A tiny C program runs inside the
// sandbox and asks the kernel about its own sandbox with sandbox_check(getpid(), operation, ...):
// the answer is the policy's decision, nothing is opened, read, written or looked up.
//
//   node decisionMatrix.mjs [--out file.json] [--volt-out /path/to/out] [--scratch dir]
//
// Each row says what the policy should decide (`want`) and what it decides. Exit code 1 when a row
// that should be denied is allowed.

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.platform !== 'darwin') {
	console.log('macOS only (sandbox_check)');
	process.exit(0);
}
const arg = (name, fallback) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : fallback; };
const here = dirname(fileURLToPath(import.meta.url));
const OUT = arg('--volt-out', process.env.VOLT_OUT ?? join(here, '..', '..', '..', '..', '..', '..', 'out'));
globalThis._VSCODE_FILE_ROOT = OUT;
const load = path => import(pathToFileURL(join(OUT, path)).href);
const { SandboxManager } = await load('vs/platform/voltSandbox/node/sandboxManager.js');
const { agentSandboxPolicy } = await load('vs/platform/voltSandbox/common/sandboxPolicy.js');
const { AGENT_CONFIG_NAMES } = await load('vs/platform/voltSandbox/common/sandboxProfiles.js');
const { agentStatePlan } = await load('vs/platform/voltSandbox/common/agentState.js');
const { sandboxHostFacts } = await load('vs/platform/voltSandbox/node/sandboxResolver.js');

const scratchParent = arg('--scratch', join(os.homedir(), '.volt-r10', 'sandbox', 'canary'));
await fs.mkdir(scratchParent, { recursive: true });
const scratch = await fs.realpath(await fs.mkdtemp(join(scratchParent, 'matrix-')));
const ws = join(scratch, 'ws');
const otherWs = join(scratch, 'other-chat-ws');
for (const dir of [ws, otherWs, join(scratch, 'runs'), join(scratch, 'cache'), join(scratch, 'state')]) {
	await fs.mkdir(dir, { recursive: true });
}

// The checker: one line per question on stdin (`operation<TAB>kind<TAB>argument`), one answer per line.
const source = join(scratch, 'sbcheck.c');
await fs.writeFile(source, `#include <stdio.h>
#include <string.h>
#include <unistd.h>
extern int sandbox_check(pid_t pid, const char *operation, int type, ...);
int main(void) {
	char line[4096];
	while (fgets(line, sizeof line, stdin)) {
		line[strcspn(line, "\\n")] = 0;
		char *op = strtok(line, "\\t"), *kind = strtok(NULL, "\\t"), *value = strtok(NULL, "\\t");
		if (!op || !kind || !value) { continue; }
		/* SANDBOX_FILTER_PATH 1, SANDBOX_FILTER_GLOBAL_NAME 2, SANDBOX_CHECK_NO_REPORT 0x40000000 */
		int type = (strcmp(kind, "mach") == 0 ? 2 : 1) | 0x40000000;
		printf("%s\\t%s\\t%s\\n", sandbox_check(getpid(), op, type, value) == 0 ? "ALLOW" : "DENY", op, value);
	}
	return 0;
}
`);
const checker = join(ws, 'sbcheck');
execFileSync('/usr/bin/cc', ['-o', checker, source], { stdio: 'inherit' });

// The policy a real launch builds (sandboxLauncher.ts `hostFacts`): the real home and temp folders.
const facts = await sandboxHostFacts();
const home = facts.home;
const user = os.userInfo().username;
const real = path => fs.realpath(path).catch(() => path);
const darwinCache = await real(execFileSync('/usr/bin/getconf', ['DARWIN_USER_CACHE_DIR'], { encoding: 'utf8' }).trim());
const tmp = facts.tmpRoot;
const tempDirs = [...new Set([tmp, await real('/tmp'), await real('/var/tmp'), darwinCache])];
const userData = join(home, 'Library', 'Application Support', 'Volt');
const manager = new SandboxManager(undefined, { runRoot: join(scratch, 'runs') });
// The chat's config overlay as a real launch plans it (paths only: no overlay is made, the user's config is not copied).
const statePlan = agentStatePlan('claude-code', 'matrix-chat', { platform: 'darwin', home, root: join(scratch, 'state'), hostEnv: {} }, AGENT_CONFIG_NAMES);
const policyFor = network => agentSandboxPolicy(
	{ level: 'workspace-write', network, providerId: 'claude-code', workspaceRoots: [ws], stateKey: 'matrix-chat' },
	{ platform: 'darwin', home, tempDirs, uid: process.getuid(), userDataDir: userData, sshPrivateKeys: [], cacheDir: join(scratch, 'cache'), statePlan },
);

const H = rel => join(home, rel);
const W = 'file-write-data', R = 'file-read-data';
// [class, want, operation, kind, argument]
const QUESTIONS = [
	// --- controls: what the agent must be able to do ---
	['control', 'ALLOW', W, 'path', join(ws, 'questions.tsv')],
	['control', 'ALLOW', R, 'path', join(ws, 'sbcheck')],
	['control', 'ALLOW', W, 'path', tmp],
	['control', 'ALLOW', R, 'path', '/usr/bin/git'],
	['control', 'ALLOW', 'mach-lookup', 'mach', 'com.apple.system.opendirectoryd.libinfo'],
	// --- shell startup files, launch agents, login items ---
	...['.zshrc', '.zshenv', '.zprofile', '.zlogin', '.zlogout', '.bashrc', '.bash_profile', '.bash_logout', '.profile', '.inputrc', '.config/fish/config.fish', '.config/fish/conf.d/x.fish'].map(p => ['shell rc (write)', 'DENY', W, 'path', H(p)]),
	...['Library/LaunchAgents/com.x.plist', 'Library/Services/x.workflow', 'Library/Scripts/x.scpt', 'Library/Application Scripts/x/y', 'Library/QuickLook/x.qlgenerator', 'Library/Spotlight/x.mdimporter', 'Library/Input Methods/x.app',
		'Library/Screen Savers/x.saver', 'Library/PreferencePanes/x.prefPane', 'Library/Internet Plug-Ins/x.plugin', 'Library/Preferences/com.apple.Terminal.plist', 'Library/Preferences/com.apple.loginwindow.plist', 'Applications/x.app/Contents/MacOS/x',
		'Library/Developer/Xcode/UserData/x', 'Library/Keychains/login.keychain-db', 'Library/Application Support/iTerm2/DynamicProfiles/x.json', 'Library/Application Support/com.apple.sharedfilelist/x'].map(p => ['macOS persistence (write)', 'DENY', W, 'path', H(p)]),
	['macOS persistence (write)', 'DENY', W, 'path', `/usr/lib/cron/tabs/${user}`], ['macOS persistence (write)', 'DENY', W, 'path', `/private/var/at/tabs/${user}`], ['macOS persistence (write)', 'DENY', W, 'path', '/Library/LaunchAgents/com.x.plist'], ['macOS persistence (write)', 'DENY', W, 'path', '/Applications/x.app'],
	// --- agent and tool config ---
	...['.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/x.sh', '.claude/CLAUDE.md', '.claude/skills/x/SKILL.md', '.claude/plugins/x/plugin.json', '.claude/commands/x.md', '.claude/agents/x.md', '.claude.json',
		'.codex/config.toml', '.codex/auth.json', '.cursor/mcp.json', '.cursor/cli-config.json', '.gemini/settings.json', '.config/opencode/opencode.json', '.agents/skills/x/SKILL.md', '.grok/settings.json', '.pi/agent/settings.json'].map(p => ['agent CLI config (write)', 'DENY', W, 'path', H(p)]),
	...['.volt/hooks.json', '.volt/hooks/x.sh', '.volt/mcp.json', '.volt/sandbox.json', '.volt/settings/x.json', '.volt/trust/grants.json', '.volt/accounts/claude/x', '.volt/acp-node-cache/x.js', '.volt/claude-plugins/x/plugin.json', '.volt/plugins/x/plugin.json',
		'.volt/skills/x/SKILL.md', '.volt/agents/x.md', '.volt/memory/x.md', '.volt/customize/looks/x.json', '.volt/speech/volt-speech-helper', '.volt/awake/x', '.volt/data/globalStorage/x', '.volt/sandbox/runs/other-run/x', '.volt/sandbox-cache/other-chat/npm/x',
		'.volt/sandbox/agent-state/other-chat/claude-code/settings.json', '.volt/worktrees/other/repo/src/a.ts', '.volt/worktrees/other/repo/.git/hooks/pre-commit'].map(p => ['Volt state (write)', 'DENY', W, 'path', H(p)]),
	...['Library/Application Support/Volt/User/settings.json', 'Library/Application Support/Volt/User/keybindings.json', 'Library/Application Support/Volt/token', 'Library/Application Support/Code/User/settings.json', 'Library/Application Support/Cursor/User/settings.json'].map(p => ['editor settings (write)', 'DENY', W, 'path', H(p)]),
	...['.gitconfig', '.config/git/config', '.config/git/attributes', '.config/git/ignore', '.gitignore_global', '.npmrc', '.yarnrc.yml', '.bunfig.toml', '.ssh/authorized_keys', '.ssh/config', '.ssh/rc', '.aws/config', '.docker/config.json', '.kube/config', '.netrc', '.gnupg/gpg.conf', '.config/gh/config.yml',
		'.tmux.conf', '.vimrc', '.config/nvim/init.lua', '.mise.toml', '.config/mise/config.toml', '.tool-versions', '.cargo/config.toml', '.m2/settings.xml', '.gradle/init.gradle', '.pip/pip.conf', '.config/pip/pip.conf', '.curlrc', '.wgetrc'].map(p => ['tool config (write)', 'DENY', W, 'path', H(p)]),
	// --- programs on PATH the host runs later ---
	...['.local/bin/git', '.cargo/bin/cargo', '.bun/bin/bun', '.npm/_npx/x/node_modules/y/index.js', '.npm-global/bin/x', 'go/bin/x', '.deno/bin/x', '.volta/bin/node', '.pyenv/shims/python', '.rbenv/shims/ruby', 'bin/x'].map(p => ['programs on PATH (write)', 'DENY', W, 'path', H(p)]),
	['programs on PATH (write)', 'DENY', W, 'path', process.execPath], ['programs on PATH (write)', 'DENY', W, 'path', join(dirname(process.execPath), 'npx')],
	...['/opt/homebrew/bin/x', '/opt/homebrew/etc/gitconfig', '/opt/homebrew/lib/node_modules/x/index.js', '/opt/homebrew/Cellar/x', '/usr/local/bin/x', '/usr/local/etc/gitconfig', '/usr/local/lib/x.dylib', '/Library/Developer/CommandLineTools/usr/bin/git', '/etc/hosts', '/private/etc/zshrc'].map(p => ['programs on PATH (write)', 'DENY', W, 'path', p]),
	// --- temp folders: writable, except what the host runs or trusts from there ---
	['temp (write)', 'DENY', W, 'path', join(tmp, 'xcrun_db')],
	// --- other projects, documents, other chats ---
	...['Documents/x.txt', 'Desktop/x.txt', 'Downloads/x.sh', 'Pictures/x.png', 'Library/Mobile Documents/com~apple~CloudDocs/x'].map(p => ['other folders (write)', 'DENY', W, 'path', H(p)]),
	['other folders (write)', 'DENY', W, 'path', join(otherWs, 'x.txt')], ['other folders (read)', 'DENY', R, 'path', join(otherWs, 'x.txt')], ['other folders (write)', 'DENY', W, 'path', '/Volumes/x/y'],
	// --- reads: credentials and private data ---
	...['.ssh/id_ed25519', '.ssh/id_rsa', '.aws/credentials', '.netrc', '.npmrc', '.config/gh/hosts.yml', '.docker/config.json', '.kube/config', '.gnupg/private-keys-v1.d/x.key', '.git-credentials', '.config/gcloud/credentials.db', '.azure/accessTokens.json',
		'.codex/auth.json', '.cursor/auth.json', '.gemini/oauth_creds.json', '.grok/auth.json', '.volt/accounts/claude/x/.credentials.json', '.volt/trust/grants.json', '.password-store/x.gpg', '.vault-token', '.terraform.d/credentials.tfrc.json'].map(p => ['credentials (read)', 'DENY', R, 'path', H(p)]),
	...['.zshrc', '.zsh_history', '.bash_history', '.python_history', '.node_repl_history', '.psql_history', '.mysql_history', '.lesshst', '.viminfo', 'Documents/x.txt', 'Desktop/x.txt', 'Downloads/x.pdf', 'Library/Messages/chat.db', 'Library/Mail/V10/x.emlx', 'Library/Safari/History.db',
		'Library/Application Support/Google/Chrome/Default/Cookies', 'Library/Application Support/Firefox/Profiles/x/logins.json', 'Library/Cookies/Cookies.binarycookies', 'Library/Application Support/Volt/token', 'Library/Application Support/Volt/User/globalStorage/state.vscdb',
		'Library/Application Support/Slack/Cookies', 'Library/Application Support/1Password/x', 'Library/Group Containers/x/y', 'Library/Containers/com.apple.Notes/x', 'Library/Calendars/x', 'Library/Application Support/AddressBook/x', '.volt/memory/x.md', '.volt/worktrees/other/repo/src/a.ts',
		'.claude/projects/other-project/session.jsonl', '.claude/history.jsonl', '.volt/data/globalStorage/x', 'Library/Application Support/Code/User/settings.json'].map(p => ['private data (read)', 'DENY', R, 'path', H(p)]),
	['private data (read)', 'DENY', R, 'path', '/Volumes/x/y'], ['private data (read)', 'DENY', R, 'path', '/Users/Shared/x'],
	// --- Mach services that run code, act or answer for the agent outside the sandbox ---
	...['com.apple.coreservices.appleevents', 'com.apple.CoreServices.coreservicesd', 'com.apple.coreservices.launchservicesd', 'com.apple.lsd.open', 'com.apple.lsd.modifydb', 'com.apple.windowserver.active', 'com.apple.pasteboard.1', 'com.apple.cfprefsd.agent', 'com.apple.cfprefsd.daemon',
		'com.apple.xpc.smd', 'com.apple.xpc.loginitemregisterd', 'com.apple.backgroundtaskmanagement', 'com.apple.backgroundtaskmanagementagent', 'com.apple.coreservices.sharedfilelistd.xpc'].map(name => ['mach: already denied (MACOS-OUT-2)', 'DENY', 'mach-lookup', 'mach', name]),
	...[
		['com.apple.siri.VoiceShortcuts.xpc', 'runs the user\'s Shortcuts (`shortcuts run`)'], ['com.apple.shortcuts.daemon', 'Shortcuts'], ['com.apple.WorkflowKit.BackgroundShortcutRunner', 'Shortcuts runner'],
		['com.apple.metadata.mds', 'Spotlight: names and text of every indexed file (`mdfind`)'], ['com.apple.metadata.mds.legacy', 'Spotlight'], ['com.apple.corespotlightd', 'Spotlight (app items)'], ['com.apple.spotlight.IndexAgent', 'Spotlight'],
		['com.apple.quicklook.ThumbnailsAgent', 'renders any file as an image (`qlmanage -t`)'], ['com.apple.quicklook.ui.helper', 'Quick Look'], ['com.apple.quicklook.satellite.general', 'Quick Look'],
		['com.apple.pluginkit.pkd', 'registers app extensions the system starts later (`pluginkit -a`)'],
		['com.apple.CoreSimulator.CoreSimulatorService', 'runs programs in a simulator, outside the sandbox (`simctl spawn`)'], ['com.apple.CoreDevice.coredeviceservice', 'runs programs on a connected device (`devicectl`)'],
		['com.apple.DiskArbitration.diskarbitrationd', 'mounts disk images over any folder (`hdiutil attach -mountpoint`)'], ['com.apple.diskimagesiod.xpc', 'disk images'], ['com.apple.diskmanagementd', 'disks (`diskutil`)'],
		['com.apple.tccd', 'privacy permissions (`tccutil reset`)'], ['com.apple.tccd.system', 'privacy permissions'],
		['com.apple.usernotifications.usernotificationservice', 'posts notifications as another app'], ['com.apple.usernoted.daemon_client', 'notifications'], ['com.apple.notificationcenterui.tcc', 'notifications'],
		['com.apple.speech.speechsynthesisd', 'speaks (`say`)'], ['com.apple.audio.audiohald', 'audio in and out'], ['com.apple.audio.coreaudiod', 'audio in and out'], ['com.apple.cmio.registerassistantservice', 'camera'],
		['com.apple.screencapture.interactive', 'screen capture'], ['com.apple.replayd', 'screen recording'], ['com.apple.sharingd', 'AirDrop'], ['com.apple.sharing.transfer.xpc', 'AirDrop'],
		['com.apple.imagent.desktop.auth', 'Messages'], ['com.apple.identityservicesd.desktop.auth', 'Messages'], ['com.apple.AddressBook.abd', 'contacts'], ['com.apple.CalendarAgent', 'calendars'], ['com.apple.photos.service', 'photos'],
		['com.apple.dock.server', 'Dock'], ['com.apple.dock.launchpad', 'Dock'], ['com.apple.systemuiserver.ServiceProvider', 'menu bar'], ['com.apple.Finder.ServiceProvider', 'Finder services'],
		['com.apple.universalaccessd', 'accessibility'], ['com.apple.accessibility.mediaaccessibilityd', 'accessibility'], ['com.apple.tsm.uiserver', 'keyboard input sources'], ['com.apple.inputmethodkit.launchagent', 'input methods'],
		['com.apple.iohideventsystem', 'keyboard and mouse events'], ['com.apple.hidd', 'keyboard and mouse events'], ['com.apple.bluetoothd', 'Bluetooth'], ['com.apple.airportd', 'Wi-Fi'], ['com.apple.locationd.desktop.registration', 'location'],
		['com.apple.SecurityServer', 'the keychain (documented: the CLI reads its own login there)'], ['com.apple.securityd.xpc', 'the keychain (documented)'], ['com.apple.authd', 'authorization prompts'], ['com.apple.security.agent', 'authorization prompts'], ['com.apple.security.authhost', 'authorization prompts'],
		['com.apple.coreduetd.knowledge', 'app usage history'], ['com.apple.biome.access.user', 'app usage history'], ['com.apple.knowledge-agent', 'app usage history'], ['com.apple.sysmond', 'process list'],
		['com.apple.logd.admin', 'unified log'], ['com.apple.diagnosticd', 'unified log stream'], ['com.apple.spindump', 'samples other processes'], ['com.apple.ReportCrash', 'crash reports'],
		['com.apple.FileProvider', 'cloud files'], ['com.apple.bird', 'iCloud Drive'], ['com.apple.cloudd', 'iCloud'], ['com.apple.printd', 'printing'], ['com.apple.installd', 'installs packages'], ['com.apple.remoted', 'remote services'],
		['com.apple.dt.Xcode.DeveloperSystemPolicyService', 'Xcode'], ['com.apple.TimeMachine.Helper', 'Time Machine backups (`tmutil`)'], ['com.apple.backupd.xpc', 'Time Machine backups'], ['com.apple.FSEvents', 'file events of the whole disk'], ['com.apple.fseventsd', 'file events of the whole disk'],
		['com.apple.networkd', 'network config'], ['com.apple.nehelper', 'VPN and filters'], ['com.apple.nesessionmanager', 'VPN'], ['com.apple.SystemConfiguration.configd', 'network config (read for DNS)'],
		['com.apple.coreservices.quarantine-resolver', 'quarantine'], ['com.apple.runningboard', 'app lifecycle'], ['com.apple.appkit.xpc.openAndSavePanelService', 'open and save panels'], ['com.apple.ViewBridgeAuxiliary', 'remote views'],
	].map(([name, note]) => ['mach: reachable?', 'REPORT', 'mach-lookup', 'mach', name, note]),
];

// sandbox_check answers for paths that exist (a name that does not exist is always "denied", which
// would prove nothing): each path is asked as itself when it exists, else as its nearest existing
// folder. Only whether a name exists is looked at here, outside the sandbox; nothing is opened.
const nearestExisting = async path => {
	let at = path;
	while (at !== '/' && !await fs.lstat(at).then(() => true, () => false)) {
		at = dirname(at);
	}
	return at;
};
for (const q of QUESTIONS) {
	q[6] = q[3] === 'path' ? await nearestExisting(q[4]) : q[4];
}
const input = QUESTIONS.map(q => `${q[2]}\t${q[3]}\t${q[6]}`).join('\n') + '\n';
await fs.writeFile(join(ws, 'questions.tsv'), input);
const rows = [];
try {
	const capabilities = await manager.capabilities();
	if (!capabilities.available) {
		throw new Error(`No sandbox backend: ${capabilities.diagnostics?.join(' ')}`);
	}
	for (const network of [false, true]) {
		const result = await manager.run({
			command: '/bin/sh', args: ['-c', `'${checker}' < '${join(ws, 'questions.tsv')}'`],
			policy: policyFor(network),
			context: { workspaceRoots: [ws], hostEnv: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, LANG: 'C' } },
		}, { timeoutMs: 120_000 });
		if (result.status !== 'completed' || !result.stdout.trim()) {
			throw new Error(`the checker did not run: ${result.status} ${result.error ?? ''} ${result.stderr}`);
		}
		const answers = result.stdout.trim().split('\n').map(line => line.split('\t')[0]);
		QUESTIONS.forEach((q, i) => rows.push({ network, cls: q[0], want: q[1], operation: q[2], target: q[4].replace(home, '~'), asked: q[6].replace(home, '~'), exact: q[6] === q[4], note: q[5], decision: answers[i] }));
	}
} finally {
	await manager.dispose();
	await fs.rm(scratch, { recursive: true, force: true });
}
const wrong = rows.filter(row => row.want !== 'REPORT' && row.decision !== row.want);
const reachable = rows.filter(row => row.want === 'REPORT' && row.decision === 'ALLOW' && !row.network);
const byClass = new Map();
for (const row of rows.filter(row => !row.network)) {
	const entry = byClass.get(row.cls) ?? { total: 0, allow: 0, deny: 0, wrong: 0 };
	entry.total++;
	entry[row.decision === 'ALLOW' ? 'allow' : 'deny']++;
	entry.wrong += row.want !== 'REPORT' && row.decision !== row.want ? 1 : 0;
	byClass.set(row.cls, entry);
}
for (const [cls, entry] of byClass) {
	console.log(`${cls.padEnd(36)} ${String(entry.total).padStart(3)} asked  allow ${String(entry.allow).padStart(3)}  deny ${String(entry.deny).padStart(3)}  wrong ${entry.wrong}`);
}
console.log(`paths asked as themselves: ${rows.filter(row => !row.network && row.operation !== 'mach-lookup' && row.exact).length}, as their nearest existing folder: ${rows.filter(row => !row.network && row.operation !== 'mach-lookup' && !row.exact).length}`);
for (const row of wrong) {
	console.log(`WRONG   network=${row.network} ${row.cls}: ${row.operation} ${row.target} (asked as ${row.asked}) is ${row.decision}, should be ${row.want}`);
}
for (const row of reachable) {
	console.log(`REACHABLE ${row.target}  (${row.note})`);
}
console.log(JSON.stringify({ when: new Date().toISOString(), macOS: os.release(), asked: QUESTIONS.length, wrong: wrong.length, machReachable: reachable.length }));
if (arg('--out', undefined)) {
	await fs.writeFile(arg('--out'), JSON.stringify({ rows }, null, '\t') + '\n');
}
process.exit(wrong.some(row => row.want === 'DENY') ? 1 : 0);
