/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { VoltHostToolService } from '../../browser/host/hostToolService.js';
import { dataUrlBytes, decodeDataUrl, encodeImage, scaleScreenshot } from '../../browser/host/imageCodec.js';
import { createBrowserTools } from '../../browser/tools/browserTool.js';
import { BrowserBlockReason, IVoltBrowserAccessService } from '../../common/browserAccess.js';
import { AUTOMATE_BROWSER_COMMAND_ID, BROWSER_PAGE_URL_COMMAND_ID, IVoltBrowserAutomationOptions, IVoltHostToolApproval, IVoltHostToolInvocation, VOLT_HOST_TOOLS } from '../../common/hostTools.js';
import { VoltMode } from '../../common/modes.js';
import { createImage, IRgbaImage } from '../../common/tools/imageAnalysis.js';

interface ICommandCall {
	readonly id: string;
	readonly args: unknown[];
}

function fill(image: IRgbaImage, x0: number, y0: number, w: number, h: number, rgb: readonly [number, number, number]): IRgbaImage {
	for (let y = y0; y < y0 + h; y++) {
		for (let x = x0; x < x0 + w; x++) {
			const p = (y * image.width + x) * 4;
			image.data[p] = rgb[0];
			image.data[p + 1] = rgb[1];
			image.data[p + 2] = rgb[2];
		}
	}
	return image;
}

suite('Volt host tool service', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(options: { pageUrl?: string; files?: Map<string, Uint8Array> } = {}) {
		const calls: ICommandCall[] = [];
		const commands = {
			_serviceBrand: undefined,
			onWillExecuteCommand: Event.None,
			onDidExecuteCommand: Event.None,
			executeCommand: async (id: string, ...args: unknown[]) => {
				calls.push({ id, args });
				if (id === BROWSER_PAGE_URL_COMMAND_ID) {
					return options.pageUrl;
				}
				return { text: `ran ${String(args[1])}` };
			},
		} as unknown as ICommandService;
		const files = {
			readFile: async (uri: URI) => {
				const bytes = options.files?.get(uri.path);
				if (!bytes) {
					throw new Error('missing');
				}
				return { value: VSBuffer.wrap(bytes) };
			},
		} as unknown as IFileService;
		const workspace = { getWorkspace: () => ({ folders: [{ uri: URI.file('/ws') }] }) } as unknown as IWorkspaceContextService;
		const blocked = new Map<string | undefined, BrowserBlockReason>();
		const access = { blockReason: (sessionId: string | undefined) => blocked.get(sessionId) } as unknown as IVoltBrowserAccessService;
		const service = store.add(new VoltHostToolService(commands, files, workspace, access));
		const modes = new Map<string, VoltMode>();
		service.setSessionResolver({ mode: id => modes.get(id), cwd: () => undefined });
		const automated = () => calls.filter(call => call.id === AUTOMATE_BROWSER_COMMAND_ID);
		return { service, calls, modes, automated, blocked };
	}

	test('hands agents the endpoint with the bearer token and optional tool groups', () => {
		const { service } = setup();
		assert.deepStrictEqual(service.getMcpServers('s1'), []);
		service.setMcpEndpoint('http://127.0.0.1:4000/mcp', 'tok');
		assert.deepStrictEqual(service.getMcpServers('chat 1'), [{ type: 'http', name: 'volt', url: 'http://127.0.0.1:4000/mcp/chat%201', headers: [{ name: 'Authorization', value: 'Bearer tok' }] }]);
		assert.strictEqual(service.getMcpServers('s', { groups: ['core', 'image'] })[0].url, 'http://127.0.0.1:4000/mcp/s?groups=core,image');
	});

	test('Ask mode refuses browser_evaluate without an approver, and asks the approver when there is one', async () => {
		const { service, modes, automated } = setup();
		modes.set('s1', 'ask');
		const refused = await service.invokeTool('browser_evaluate', { expression: 'document.title' }, { sessionId: 's1' });
		assert.match(refused.error ?? '', /not run: in Ask mode it needs the user's approval because it runs JavaScript/);
		assert.strictEqual(automated().length, 0);

		const asked: IVoltHostToolApproval[] = [];
		let allow = false;
		service.setApprover({ approve: async request => { asked.push(request); return allow; } });
		const denied = await service.invokeTool('browser_evaluate', { expression: '1' }, { sessionId: 's1' });
		assert.match(denied.error ?? '', /did not allow/);
		allow = true;
		const allowed = await service.invokeTool('browser_evaluate', { expression: '1' }, { sessionId: 's1' });
		assert.strictEqual(allowed.text, 'ran browser_evaluate');
		assert.strictEqual(asked.length, 2);
		assert.strictEqual(asked[0].mode, 'ask');
		assert.strictEqual(automated().length, 1);

		// Agent mode, or a mode the caller passes explicitly, decides too.
		modes.set('s1', 'agent');
		service.setApprover(undefined);
		assert.strictEqual((await service.invokeTool('browser_evaluate', { expression: '1' }, { sessionId: 's1' })).text, 'ran browser_evaluate');
		assert.ok((await service.invokeTool('browser_evaluate', { expression: '1' }, { sessionId: 's1', mode: 'plan' })).error);
	});

	test('a provider can require approval in every mode, and is told when it was given', async () => {
		const { service, modes } = setup();
		modes.set('s1', 'agent');
		const invoked: string[] = [];
		const approved: string[] = [];
		store.add(service.registerToolProvider({
			tools: [{ name: 'desktop_act', title: 'Acted', description: '', inputSchema: {} }],
			invoke: async name => { invoked.push(name); return { text: 'done' }; },
			needsApproval: async () => approved.length ? undefined : 'controls apps on your Mac',
			approved: (_name, _args, call) => { approved.push(call.sessionId!); },
		}));
		assert.match((await service.invokeTool('desktop_act', {}, { sessionId: 's1' })).error ?? '', /needs the user's approval/);
		assert.match((await service.invokeTool('desktop_act', {}, undefined)).error ?? '', /needs the user's approval/);
		let allow = false;
		const asked: IVoltHostToolApproval[] = [];
		service.setApprover({ approve: async request => { asked.push(request); return allow; } });
		assert.match((await service.invokeTool('desktop_act', {}, { sessionId: 's1' })).error ?? '', /did not allow desktop_act/);
		allow = true;
		assert.strictEqual((await service.invokeTool('desktop_act', {}, { sessionId: 's1' })).text, 'done');
		assert.strictEqual((await service.invokeTool('desktop_act', {}, { sessionId: 's1' })).text, 'done');
		assert.strictEqual(asked.length, 2, 'once approved, the provider stops asking');
		assert.strictEqual(asked[0].mode, 'agent');
		assert.deepStrictEqual(approved, ['s1']);
		assert.deepStrictEqual(invoked, ['desktop_act', 'desktop_act']);
		service.setApprover(undefined);
	});

	test('Plan mode judges clicks by the page the chat shows', async () => {
		const remote = setup({ pageUrl: 'https://mail.example.com/inbox' });
		remote.modes.set('s1', 'plan');
		assert.match((await remote.service.invokeTool('browser_click', { element: 'Delete', ref: 'e3' }, { sessionId: 's1' })).error ?? '', /mail\.example\.com/);
		assert.strictEqual((await remote.service.invokeTool('browser_snapshot', {}, { sessionId: 's1' })).text, 'ran browser_snapshot');

		const local = setup({ pageUrl: 'http://localhost:5173/' });
		local.modes.set('s1', 'plan');
		assert.strictEqual((await local.service.invokeTool('browser_click', { element: 'Add', ref: 'e3' }, { sessionId: 's1' })).text, 'ran browser_click');
	});

	test('passes cancellation through and only reports MCP calls to the transcript', async () => {
		const { service, automated } = setup();
		const seen: IVoltHostToolInvocation[] = [];
		store.add(service.onDidInvokeTool(call => seen.push(call)));
		const cancel = new CancellationTokenSource();
		await service.invokeTool('browser_snapshot', {}, { sessionId: 's1', token: cancel.token, source: 'mcp' });
		await service.invokeTool('browser_snapshot', {}, { sessionId: 's1', source: 'native' });
		assert.strictEqual(seen.length, 1);
		const options = automated()[0].args[3] as IVoltBrowserAutomationOptions;
		cancel.cancel();
		assert.strictEqual(options.token?.isCancellationRequested, true);
		assert.strictEqual((await service.invokeTool('browser_snapshot', {}, { sessionId: 's1', token: cancel.token })).error, 'Cancelled.');
		assert.ok((await service.invokeTool('browser_click', { element: 'x', ref: 'e1' })).error?.includes('need a Volt chat'));
		cancel.dispose();
	});

	test('image_inspect and browser_compare_image read images relative to the workspace', async () => {
		const reference = fill(createImage(120, 80, [243, 244, 246]), 20, 20, 60, 30, [255, 255, 255]);
		const png = dataUrlBytes(await encodeImage(reference, 'png')).bytes;
		const { service, automated } = setup({ files: new Map([['/ws/design/ref.png', png]]) });

		const inspected = await service.invokeTool('image_inspect', { path: 'design/ref.png', points: [{ x: 30, y: 30 }], crop: { x: 20, y: 20, w: 20, h: 10 } });
		assert.ok(inspected.text?.includes('Size: 120×80'), inspected.text);
		assert.ok(inspected.text?.includes('(30, 30) #ffffff'), inspected.text);
		assert.ok(inspected.text?.includes('x 20, y 20, 60×30 fill #ffffff'), inspected.text);
		assert.match(inspected.image ?? '', /^data:image\/png;base64,/);

		const compared = await service.invokeTool('browser_compare_image', { reference_path: 'design/ref.png' }, { sessionId: 's1' });
		assert.strictEqual(compared.text, 'ran browser_compare_image');
		const options = automated()[0].args[3] as IVoltBrowserAutomationOptions;
		assert.deepStrictEqual([options.reference?.width, options.reference?.height], [120, 80]);
		assert.strictEqual(options.referenceLabel, 'design/ref.png');

		assert.match((await service.invokeTool('image_inspect', { path: 'missing.png' })).error ?? '', /Could not read/);
	});

	test('screenshots come down to CSS pixels and the size cap', async () => {
		const retina = await encodeImage(createImage(800, 600, [10, 20, 30]), 'png');
		const css = await scaleScreenshot(retina, { maxSide: 1280, targetWidth: 400 });
		assert.deepStrictEqual([css.width, css.height, css.sourceWidth], [400, 300, 800]);
		assert.match(css.dataUrl, /^data:image\/jpeg;base64,/);
		const capped = await scaleScreenshot(retina, { maxSide: 256, format: 'webp' });
		assert.deepStrictEqual([capped.width, capped.height], [256, 192]);
		const crop = await scaleScreenshot(retina, { maxSide: 1280, targetWidth: 400, crop: { x: 100, y: 50, w: 50, h: 40 } });
		assert.deepStrictEqual([crop.width, crop.height], [50, 40]);
		const decoded = await decodeDataUrl(css.dataUrl);
		assert.ok(Math.abs(decoded.data[0] - 10) <= 3);
	});

	test('native browser tools mirror every browser and image host tool', () => {
		const { service } = setup();
		const tools = createBrowserTools(service);
		assert.deepStrictEqual(tools.map(tool => tool.name), VOLT_HOST_TOOLS.filter(tool => tool.group !== 'core').map(tool => tool.name));
		assert.ok(tools.find(tool => tool.name === 'browser_snapshot')?.parallelSafe);
		assert.ok(!tools.find(tool => tool.name === 'browser_click')?.parallelSafe);
	});

	test('native tools pass the chat, mode and abort signal', async () => {
		const { service, automated } = setup();
		const controller = new AbortController();
		const tool = createBrowserTools(service).find(item => item.name === 'browser_evaluate')!;
		const refused = await tool.execute({ expression: '1' }, { signal: controller.signal, sessionId: 's9', mode: 'ask' });
		assert.strictEqual(refused.isError, true);
		const ran = await tool.execute({ expression: '1' }, { signal: controller.signal, sessionId: 's9', mode: 'agent' });
		assert.strictEqual(ran.text, 'ran browser_evaluate');
		assert.strictEqual(automated()[0].args[0], 's9');
	});

	test('blocked browser access refuses every browser tool with a reason, without touching the page', async () => {
		const { service, automated, blocked } = setup();
		blocked.set('s1', 'chat');
		const refused = await service.invokeTool('browser_click', { element: 'Buy', ref: 'e2' }, { sessionId: 's1' });
		assert.match(refused.error ?? '', /^browser_click was not run: the user turned off browser access for agents in this chat\. Do not retry/);
		assert.match((await service.invokeTool('browser_navigate', { url: 'http://localhost:3000' }, { sessionId: 's1' })).error ?? '', /turned off browser access/);
		assert.strictEqual(automated().length, 0);

		// The setting blocks calls without a chat too (the visible pane's screenshot).
		blocked.set(undefined, 'setting');
		assert.match((await service.invokeTool('browser_screenshot', {})).error ?? '', /volt\.browser\.allowAgents/);

		// Other chats and non-browser tools are unaffected.
		assert.strictEqual((await service.invokeTool('browser_snapshot', {}, { sessionId: 's2' })).text, 'ran browser_snapshot');
		assert.strictEqual(automated().length, 1);
	});

	test('provider tools marked for approval ask in Ask and Plan modes and run freely in Agent mode', async () => {
		const { service, modes } = setup();
		const ran: string[] = [];
		store.add(service.registerToolProvider({
			tools: [
				{ name: 'device_tap', title: 'Tapped', description: '', inputSchema: {}, approvalInReadOnlyModes: 'taps on the device' },
				{ name: 'device_list', title: 'Listed', description: '', inputSchema: {} },
			],
			invoke: async name => { ran.push(name); return { text: `ran ${name}` }; },
		}));
		modes.set('s1', 'plan');
		assert.match((await service.invokeTool('device_tap', { x: 1, y: 2 }, { sessionId: 's1' })).error ?? '', /in Plan mode it needs the user's approval because it taps on the device/);
		assert.strictEqual((await service.invokeTool('device_list', {}, { sessionId: 's1' })).text, 'ran device_list');
		const asked: IVoltHostToolApproval[] = [];
		service.setApprover({ approve: async request => { asked.push(request); return true; } });
		assert.strictEqual((await service.invokeTool('device_tap', { x: 1, y: 2 }, { sessionId: 's1' })).text, 'ran device_tap');
		assert.strictEqual(asked[0].reason, 'taps on the device');
		modes.set('s1', 'agent');
		assert.strictEqual((await service.invokeTool('device_tap', { x: 1, y: 2 }, { sessionId: 's1' })).text, 'ran device_tap');
		assert.strictEqual(asked.length, 1);
		assert.deepStrictEqual(ran, ['device_list', 'device_tap', 'device_tap']);
	});
});
