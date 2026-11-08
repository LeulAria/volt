/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IVoltSandboxSettings } from '../../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { FIND_FILES_TOOL_NAME, FIND_SYMBOL_TOOL_NAME, INSTANT_GREP_TOOL_NAME } from '../../common/codeIntelligence.js';
import { CAPTURE_TOOL_NAMES, DEVICE_TOOL_NAMES } from '../../common/deviceTools.js';
import { DESKTOP_TOOL_NAMES } from '../../common/desktopTools.js';
import { WORKSPACE_STATUS_TOOL_NAME } from '../../common/harness/workspaceContext.js';
import { AUTOMATION_TOOL_NAMES, canonicalHostToolName, COMMIT_PLAN_TOOL_NAMES, PULL_REQUEST_TOOL_NAMES, THREAD_TOOL_NAMES, VISUAL_TOOL_NAMES, VOLT_HOST_TOOLS } from '../../common/hostTools.js';
import { HOST_TOOL_SANDBOX_CLASSES, hostToolSandboxUse, ISandboxPathContext, sandboxBrowserUrlRefusal, sandboxCovers, sandboxReadRefusal, sandboxRefusalMessage, sandboxWriteRefusal } from '../../common/hostToolSandbox.js';
import { MEMORY_TOOL_NAMES } from '../../common/memory/voltMemory.js';
import { AGENT_TASK_TOOL_NAMES } from '../../common/orchestration/agentTasks.js';
import { PLAYGROUND_TOOL_NAMES } from '../../common/playgroundTools.js';
import { WATCHED_TASK_TOOL_NAMES } from '../../common/terminals/watchedTasks.js';
import { TERMINAL_TOOL_NAMES } from '../../common/terminalTools.js';

const WRITE: IVoltSandboxSettings = { level: 'workspace-write', network: false };
const READ: IVoltSandboxSettings = { level: 'read-only', network: false };
const OFF: IVoltSandboxSettings = { level: 'off', network: true };

/** Every host tool any provider registers (window or agent server). */
const SERVED_TOOLS = new Set<string>([
	...VOLT_HOST_TOOLS.map(tool => tool.name),
	...THREAD_TOOL_NAMES, ...PULL_REQUEST_TOOL_NAMES, ...COMMIT_PLAN_TOOL_NAMES, ...AUTOMATION_TOOL_NAMES,
	...VISUAL_TOOL_NAMES.map(canonicalHostToolName), ...DEVICE_TOOL_NAMES, ...CAPTURE_TOOL_NAMES, ...DESKTOP_TOOL_NAMES,
	...PLAYGROUND_TOOL_NAMES, ...MEMORY_TOOL_NAMES, ...TERMINAL_TOOL_NAMES, ...AGENT_TASK_TOOL_NAMES, ...WATCHED_TASK_TOOL_NAMES,
	INSTANT_GREP_TOOL_NAME, FIND_SYMBOL_TOOL_NAME, FIND_FILES_TOOL_NAME, WORKSPACE_STATUS_TOOL_NAME, 'scratch_draw', 'scratch_read',
]);

suite('Volt host tool sandbox classes', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('every host tool Volt serves is classified, and nothing else', () => {
		const unclassified = [...SERVED_TOOLS].filter(name => hostToolSandboxUse(name, {}) === undefined);
		assert.deepStrictEqual(unclassified, [], 'a new host tool must say what it does outside the sandbox');
		const unknown = Object.keys(HOST_TOOL_SANDBOX_CLASSES).filter(name => !SERVED_TOOLS.has(name));
		assert.deepStrictEqual(unknown, [], 'no stale or misspelled names');
		assert.strictEqual(hostToolSandboxUse('brand_new_tool', {}), undefined);
		assert.strictEqual(hostToolSandboxUse('render_html', {}), undefined, 'the gate sees canonical names only');
	});

	test('the escape routes are classified as such', () => {
		const kind = (name: string, args: Record<string, unknown> = {}) => hostToolSandboxUse(name, args)?.kind;
		for (const name of ['task_watch', 'app_open', 'device_install_app', 'device_launch_app', 'desktop_apps', 'desktop_snapshot', 'desktop_act', 'worktree_handoff', 'thread_merge_back', 'stack_branch', 'restack_stack', 'rename_branch', 'window_capture', 'window_record_start']) {
			assert.strictEqual(kind(name), 'escapes', name);
		}
		// The chat's terminals run in its own sandbox (F.6): the tools carry it, or refuse.
		for (const name of ['terminal_start', 'terminal_send', 'terminal_stop', 'docker_ensure']) {
			assert.strictEqual(kind(name), 'sandboxed', name);
		}
		// Reading other chats needs agents.read:other (INV-26).
		assert.deepStrictEqual(hostToolSandboxUse('thread_read', { thread_id: 'volt://session/abc' }), { kind: 'reads-other', target: 'abc' });
		assert.deepStrictEqual(hostToolSandboxUse('thread_read', {}), { kind: 'reads-other', target: undefined });
		assert.deepStrictEqual(hostToolSandboxUse('thread_search', { query: 'x' }), { kind: 'reads-other', readsAnyChat: true });
		for (const name of ['memory_write', 'skill_write', 'memory_delete']) {
			assert.strictEqual(kind(name), 'persists', name);
		}
		// New chats inherit the caller's sandbox (SPAWNED_CHATS_INHERIT_SANDBOX); one that makes a worktree runs Volt's setup outside it.
		for (const name of ['thread_launch', 'thread_fork', 'delegate_task', 'message_task']) {
			assert.strictEqual(kind(name), 'safe', name);
		}
		assert.strictEqual(kind('thread_launch', { workspace: { type: 'worktree' } }), 'escapes');
		for (const name of ['thread_send', 'queue_edit', 'queue_send_now', 'queue_resume']) {
			assert.strictEqual(kind(name), 'delegates', name);
		}
		for (const name of ['image_inspect', 'browser_compare_image', 'html_render', 'html_preview', 'canvas_render', 'canvas_update', 'screens_capture']) {
			assert.strictEqual(kind(name), 'reads', name);
		}
		// B-15: Volt's search and the workspace summary read the chat's folder outside the sandbox.
		for (const name of [INSTANT_GREP_TOOL_NAME, FIND_SYMBOL_TOOL_NAME, FIND_FILES_TOOL_NAME, WORKSPACE_STATUS_TOOL_NAME]) {
			assert.strictEqual(kind(name), 'reads', name);
		}
		assert.strictEqual(kind('manage_automations', { action: 'create' }), 'escapes');
		assert.strictEqual(kind('manage_automations', { action: 'update' }), 'escapes');
		assert.strictEqual(kind('manage_automations', { action: 'run_now' }), 'escapes');
		assert.strictEqual(kind('manage_automations', { action: 'something_new' }), 'escapes', 'an action the gate does not know');
		assert.strictEqual(kind('manage_automations', { action: 'list' }), 'safe');
		assert.strictEqual(kind('manage_automations', { action: 'delete' }), 'safe');
		assert.strictEqual(kind('automation', { action: 'open_pr' }), 'escapes');
		assert.strictEqual(kind('automation', { action: 'memory_write' }), 'persists');
		assert.strictEqual(kind('automation', { action: 'memory_append' }), 'persists');
		assert.strictEqual(kind('automation', { action: 'send_slack' }), 'network');
		assert.strictEqual(kind('automation', { action: 'memory_read' }), 'safe');
		assert.strictEqual(kind('automation', {}), 'escapes');
	});

	test('what one call reads, writes, opens and prompts', () => {
		assert.deepStrictEqual(hostToolSandboxUse('browser_run', { url: 'http://localhost:3000', edits: [{ path: 'src/a.ts', old: 'a', new: 'b' }, { path: '.git/config', content: '' }], steps: [{ action: 'navigate', url: 'https://evil.example' }, { action: 'click' }] }), {
			kind: 'browser', urls: ['http://localhost:3000', 'https://evil.example'], writes: ['src/a.ts', '.git/config'],
		});
		assert.deepStrictEqual(hostToolSandboxUse('browser_act', { script: 'goto ${home}/login\ntype "Email" a@b.co; goto https://x.dev\nclick "Go"', vars: { home: 'http://localhost:4000' }, save: 'login' }), {
			kind: 'browser', urls: ['http://localhost:4000/login', 'https://x.dev'], writes: ['.volt/flows/login.flow'],
		});
		assert.deepStrictEqual(hostToolSandboxUse('browser_act', { script: 'goto ', steps: 'not steps' })?.urls, [], 'a script that does not parse is judged by its lines');
		assert.deepStrictEqual(hostToolSandboxUse('browser_act', { script: 'goto file:///etc/passwd\nbad line here (' })?.urls, ['file:///etc/passwd']);
		assert.deepStrictEqual(hostToolSandboxUse('browser_navigate', { url: 'file:///x' }), { kind: 'browser', urls: ['file:///x'] });
		assert.deepStrictEqual(hostToolSandboxUse('browser_compare_image', { reference_path: 'design/a.png', url: 'http://localhost:1' }), { kind: 'reads', reads: ['design/a.png'], urls: ['http://localhost:1'] });
		assert.deepStrictEqual(hostToolSandboxUse('html_render', { html: '<img src="/a/b.png"><div style="background:url(file:///c/d.jpg)">' }), { kind: 'reads', reads: ['/a/b.png', 'file:///c/d.jpg'] });
		assert.deepStrictEqual(hostToolSandboxUse('canvas_update', { frames: [{ id: 'a', image: '/x.png', html: '<img src="/y.webp">' }, { id: 'b', image: 'data:image/png;base64,AA' }, { patch: { image: 'https://cdn/z.png' } }, { nested: [{ image: '/deep.png' }] }] })?.reads, ['/x.png', '/y.webp', '/deep.png']);
		assert.deepStrictEqual(hostToolSandboxUse('device_act', { script: 'tap "Sign in"', save: 'signin' }), { kind: 'safe', writes: ['.volt/flows/signin.flow'] });
		assert.strictEqual(hostToolSandboxUse('device_act', { steps: [{ action: 'launch', target: 'com.example.app' }] })?.kind, 'escapes');
		assert.strictEqual(hostToolSandboxUse('device_act', { script: 'open myapp://settings' })?.kind, 'escapes');
		assert.deepStrictEqual(hostToolSandboxUse('screens_capture', { url: 'http://localhost:3000', screens: [{ name: 'a', url: '/settings' }, { name: 'b', url: 'https://other.example/x' }, { name: 'c', act: 'goto https://third.example' }] }), {
			kind: 'reads', reads: [], urls: ['http://localhost:3000', 'https://other.example/x', 'https://third.example'],
		});
		assert.strictEqual(hostToolSandboxUse('screens_capture', { screens: [{ name: 'a', open: 'com.example.app' }] })?.kind, 'escapes', 'a device screen launches its app');
		assert.strictEqual(hostToolSandboxUse('screens_capture', { setup: 'launch com.example.app', screens: [{ name: 'a' }] })?.kind, 'escapes');
		assert.strictEqual(hostToolSandboxUse('screens_capture', { window: 'Notes', screens: [{ name: 'a', open: 'Notes' }] })?.kind, 'reads', 'window captures go through desktop_act, judged when called');
		assert.deepStrictEqual(hostToolSandboxUse('screens_capture', { screens: [{ name: 'a', path: '/tmp/a.png' }] })?.reads, ['/tmp/a.png']);
		assert.deepStrictEqual(hostToolSandboxUse('thread_send', { thread_id: 'volt://session/abc' }), { kind: 'delegates', target: 'abc' });
		assert.deepStrictEqual(hostToolSandboxUse('queue_edit', {}), { kind: 'delegates', target: undefined });
		assert.deepStrictEqual(hostToolSandboxUse('image_inspect', { path: 7 }), { kind: 'reads', reads: [] });
		assert.deepStrictEqual(hostToolSandboxUse(INSTANT_GREP_TOOL_NAME, { pattern: 'x' }), { kind: 'reads', reads: ['.'] }, 'the chat\'s folder');
		assert.deepStrictEqual(hostToolSandboxUse(INSTANT_GREP_TOOL_NAME, { pattern: 'x', path: '/Users/me/.ssh' }), { kind: 'reads', reads: ['/Users/me/.ssh'] });
		assert.deepStrictEqual(hostToolSandboxUse(FIND_FILES_TOOL_NAME, { query: 'x', path: 'src' }), { kind: 'reads', reads: ['src'] });
		assert.deepStrictEqual(hostToolSandboxUse(WORKSPACE_STATUS_TOOL_NAME, {}), { kind: 'reads', reads: ['.'] });
	});

	test('a target chat covers the caller only when it is confined at least as much', () => {
		const ws = { target: '/p', caller: '/p' };
		assert.ok(sandboxCovers(OFF, OFF), 'an unsandboxed caller can prompt anyone');
		assert.ok(sandboxCovers(undefined, undefined));
		assert.ok(sandboxCovers(WRITE, WRITE, ws));
		assert.ok(sandboxCovers(READ, WRITE, ws));
		assert.ok(sandboxCovers(READ, READ));
		assert.ok(!sandboxCovers(OFF, WRITE, ws));
		assert.ok(!sandboxCovers(undefined, WRITE, ws));
		assert.ok(!sandboxCovers(WRITE, READ, ws), 'read-only caller, writing target');
		assert.ok(!sandboxCovers({ ...WRITE, network: true }, WRITE, ws), 'network on');
		assert.ok(sandboxCovers({ ...WRITE, network: false }, { ...WRITE, network: true }, ws), 'less network is fine');
		assert.ok(!sandboxCovers({ ...READ, allowedDomains: ['evil.example'] }, READ), 'a host the caller may not reach');
		assert.ok(sandboxCovers({ ...READ, allowedDomains: ['api.x.dev'] }, { ...READ, allowedDomains: ['*.x.dev'] }));
		assert.ok(!sandboxCovers({ ...READ, extraWritableRoots: ['/data'] }, READ), 'a folder the caller may not write');
		assert.ok(sandboxCovers({ ...READ, extraWritableRoots: ['/p/gen'] }, WRITE, ws), 'inside the caller\'s workspace');
		assert.ok(!sandboxCovers(WRITE, WRITE, { target: '/other', caller: '/p' }), 'a workspace the caller may not write');
		assert.ok(!sandboxCovers(WRITE, WRITE), 'folders unknown');
		assert.ok(sandboxCovers(WRITE, WRITE, { target: '/p/sub', caller: '/p' }));
		assert.ok(sandboxCovers(WRITE, { ...READ, extraWritableRoots: ['/w'] }, { target: '/w/x' }) === false, 'a read-only caller never covers a writing target');
	});

	test('reads: workspace, allowed folders and temp; never credential folders, never via ..', () => {
		const context: ISandboxPathContext = { roots: ['/Users/me/proj'], home: '/Users/me', tmpdir: '/var/folders/ab/xyz/T/', platform: 'darwin' };
		const read = (path: string, settings: IVoltSandboxSettings = WRITE, ctx = context) => sandboxReadRefusal(settings, path, ctx);
		assert.strictEqual(read('/Users/me/proj/design/a.png'), undefined);
		assert.strictEqual(read('/Users/me/proj/.ssh/fixture.png'), undefined, 'a .ssh inside the project is the project\'s');
		assert.strictEqual(read('/tmp/a.png'), undefined);
		assert.strictEqual(read('/private/tmp/a.png'), undefined, '/private/tmp is /tmp on macOS');
		assert.strictEqual(read('/private/var/folders/ab/xyz/T/shot.png'), undefined, 'the per-user temp folder');
		assert.match(read('/Users/me/proj/../.ssh/id_rsa') ?? '', /credentials/);
		assert.match(read('/Users/me/.aws/credentials') ?? '', /credentials/);
		assert.match(read('/Users/me/Library/Keychains/login.keychain-db') ?? '', /credentials/);
		assert.match(read('/Users/me/Library/Application Support/Google/Chrome/Default/Cookies') ?? '', /credentials/);
		assert.match(read('/Users/me/.volt/accounts/claude/auth.json') ?? '', /credentials/);
		assert.match(read('/Users/me/Desktop/a.png') ?? '', /outside this chat's workspace/);
		assert.match(read('/etc/hosts') ?? '', /outside/);
		assert.match(read('relative.png') ?? '', /not an absolute path/);
		assert.strictEqual(read('/data/shared/a.png', { ...READ, extraWritableRoots: ['/data/shared'] }), undefined, 'a folder the user allowed');
		// A worktree under ~/.volt is a workspace like any other.
		assert.strictEqual(read('/Users/me/.volt/worktrees/x/proj/a.png', WRITE, { ...context, roots: ['/Users/me/.volt/worktrees/x/proj'] }), undefined);
		// A chat whose workspace is the home folder reads only temp (the OS plan never makes home a workspace).
		assert.match(read('/Users/me/notes.png', WRITE, { ...context, roots: ['/Users/me'] }) ?? '', /outside/);
		assert.match(read('/Users/me/proj/a.png', WRITE, { ...context, roots: [] }) ?? '', /outside/, 'no known folder: only temp');
		assert.strictEqual(read('/etc/hosts', OFF), undefined, 'unsandboxed');
		assert.strictEqual(sandboxReadRefusal(undefined, '/etc/hosts', context), undefined);
	});

	test('writes: the rule the OS enforces on the agent itself', () => {
		const context: ISandboxPathContext = { roots: ['/p'], home: '/Users/me', tmpdir: '/tmp', platform: 'darwin' };
		const write = (path: string, settings: IVoltSandboxSettings = WRITE, ctx = context) => sandboxWriteRefusal(settings, path, ctx);
		assert.strictEqual(write('/p/src/a.ts'), undefined);
		assert.strictEqual(write('/p/.volt/flows/login.flow'), undefined);
		assert.strictEqual(write('/tmp/scratch.txt'), undefined);
		for (const path of ['/p/.git/config', '/p/.git/hooks/pre-commit', '/p/.vscode/tasks.json', '/p/.claude/settings.json', '/p/.volt/hooks.json', '/p/.mcp.json', '/Users/me/.zshrc', '/p/../etc/x', '/elsewhere/a']) {
			assert.ok(write(path), path);
		}
		assert.match(write('/p/src/a.ts', READ) ?? '', /read-only/);
		assert.strictEqual(write('/data/out/a.ts', { ...READ, extraWritableRoots: ['/data/out'] }), undefined, 'a folder the user allowed stays writable when read-only');
		assert.ok(write('/p/src/a.ts', { ...READ, extraWritableRoots: ['/p/src'] }), 'the read-only workspace wins over a folder inside it, as in the OS plan');
		assert.ok(write('/p/src/a.ts', WRITE, { ...context, home: undefined }), 'no home: cannot resolve the plan, refused');
		assert.ok(write('/p/src/a.ts', WRITE, { ...context, roots: [] }), 'no known folder: the workspace is not writable');
		assert.strictEqual(write('/etc/x', OFF), undefined, 'unsandboxed');
	});

	test('browser pages: no local files, and only allowed hosts and granted local ports with the network off', () => {
		const online = { ...WRITE, network: true };
		const page = (url: string, settings: IVoltSandboxSettings = WRITE) => sandboxBrowserUrlRefusal(settings, url);
		for (const url of ['about:blank', 'data:text/html,hi', '/settings', './next', '?tab=2', '#top', '']) {
			assert.strictEqual(page(url), undefined, url);
		}
		// B-16: a local page is a server the agent may run itself, so only on a port the user granted.
		const local = ['http://localhost:3000/x', 'localhost:5173', '4400', 'http://127.0.0.1:8080', 'http://[::1]:3000', 'http://app.localhost', 'http://0.0.0.0:3000'];
		for (const url of local) {
			assert.match(page(url) ?? '', /local server on a port this chat's sandbox was not granted/, url);
			assert.strictEqual(page(url, online), undefined, `${url} with the network on`);
		}
		const granted = { ...WRITE, listenPorts: [3000, 5173, 4400, 8080, 80] };
		for (const url of local) {
			assert.strictEqual(page(url, granted), undefined, `${url} on a granted port`);
		}
		assert.match(page('http://localhost:3001', granted) ?? '', /not granted/);
		assert.match(page('https://example.com') ?? '', /network is off/);
		assert.match(page('//example.com/x') ?? '', /network is off/, 'a scheme-relative URL is another site');
		assert.match(page('example.com') ?? '', /network is off/);
		assert.match(page('ws://example.com/socket') ?? '', /network is off/);
		assert.strictEqual(page('https://example.com', online), undefined);
		assert.strictEqual(page('https://api.x.dev/a', { ...WRITE, allowedDomains: ['*.x.dev'] }), undefined);
		assert.match(page('file:///Users/me/proj/index.html', online) ?? '', /local file page/, 'even inside the workspace: a local page can frame any local file');
		assert.match(page('FILE:///etc/passwd', online) ?? '', /local file page/);
		assert.match(page('chrome://settings', online) ?? '', /pages are not opened/);
		assert.match(page('javascript:alert(1)', online) ?? '', /pages are not opened/);
		assert.match(page('view-source:http://localhost:3000', online) ?? '', /pages are not opened/);
		assert.strictEqual(page('file:///etc/passwd', OFF), undefined, 'unsandboxed');
	});

	test('refusals tell the model what to do instead', () => {
		assert.strictEqual(sandboxRefusalMessage('terminal_start', 'escapes', WRITE), 'terminal_start was not run: this chat runs in Volt\'s sandbox, and terminal_start would run outside it. Run the command with your own shell tool instead: it runs inside the sandbox.');
		assert.match(sandboxRefusalMessage('worktree_handoff', 'escapes', READ), /^worktree_handoff was not run: this chat runs in Volt's read-only sandbox, .* Run git with your own shell tool instead/);
		assert.match(sandboxRefusalMessage('new_tool', undefined, WRITE), /not cleared to run from a sandboxed chat/);
	});
});
