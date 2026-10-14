/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `session/update` payloads Claude Code (claude-agent-acp 0.81.2, Opus 5.5) sent for
 * "Add a GET /api/health endpoint to harness-server.mjs". Recorded from a real turn; long
 * tool output trimmed. Replayed through the ACP mapper and the session controller.
 */
export const CLAUDE_EDIT_TURN: readonly Record<string, unknown>[] = [
	{
		_meta: {
			claudeCode: {
				toolName: 'Bash',
			},
		},
		toolCallId: 'toolu_01F8i3H1C2m5br9deVVnAuQ5',
		sessionUpdate: 'tool_call',
		name: 'Bash',
		rawInput: {},
		status: 'pending',
		title: 'Terminal',
		kind: 'execute',
		content: [],
	},
	{
		_meta: {
			claudeCode: {
				toolName: 'Bash',
			},
		},
		toolCallId: 'toolu_01F8i3H1C2m5br9deVVnAuQ5',
		sessionUpdate: 'tool_call_update',
		rawInput: {
			command: 'ls -la; grep -n "phase\\|/api/\\|createServer\\|writeHead\\|function send\\|json" harness-server.mjs | head -80',
		},
		title: 'ls -la; grep -n "phase\\|/api/\\|createServer\\|writeHead\\|function send\\|json" harness-server.mjs | head -80',
		kind: 'execute',
	},
	{
		_meta: {
			claudeCode: {
				toolName: 'Bash',
				title: 'List files and find routes in server',
			},
		},
		toolCallId: 'toolu_01F8i3H1C2m5br9deVVnAuQ5',
		sessionUpdate: 'tool_call_update',
		rawInput: {
			command: 'ls -la; grep -n "phase\\|/api/\\|createServer\\|writeHead\\|function send\\|json" harness-server.mjs | head -80',
			description: 'List files and find routes in server',
		},
		title: 'ls -la; grep -n "phase\\|/api/\\|createServer\\|writeHead\\|function send\\|json" harness-server.mjs | head -80',
		kind: 'execute',
		content: [
			{
				type: 'content',
				content: {
					type: 'text',
					text: 'List files and find routes in server',
				},
			},
		],
	},
	{
		_meta: {
			claudeCode: {
				toolResponse: {
					stdout: 'total 136\ndrwxr-xr-x@ 9 leularia  wheel    288 Sep 23 16:06 .\ndrwxr-xr-x@ 3 leularia  wheel     96 Sep 28 08:43 ..\nlrwxr-xr-x@ 1 leularia  wheel     67 Sep 13 02:23 .codegraph -> /Users/leularia/.omo/',
					stderr: '',
					interrupted: false,
					isImage: false,
					noOutputExpected: false,
				},
				toolName: 'Bash',
			},
		},
		toolCallId: 'toolu_01F8i3H1C2m5br9deVVnAuQ5',
		sessionUpdate: 'tool_call_update',
	},
	{
		_meta: {
			claudeCode: {
				toolName: 'Bash',
			},
		},
		toolCallId: 'toolu_01F8i3H1C2m5br9deVVnAuQ5',
		sessionUpdate: 'tool_call_update',
		status: 'completed',
		rawOutput: 'total 136\ndrwxr-xr-x@ 9 leularia  wheel    288 Sep 23 16:06 .\ndrwxr-xr-x@ 3 leularia  wheel     96 Sep 28 08:43 ..\nlrwxr-xr-x@ 1 leularia  wheel     67 Sep 13 02:23 .codegraph -> /Users/leularia/.omo/codegraph/projects/Agent-Test-aa518fa710c5fd3b\ndrwxr-xr-x@ 5 leularia  wheel    160 Sep 23 16:00 .ds',
		content: [
			{
				type: 'content',
				content: {
					type: 'text',
					text: '```console\ntotal 136\ndrwxr-xr-x@ 9 leularia  wheel    288 Sep 23 16:06 .\ndrwxr-xr-x@ 3 leularia  wheel     96 Sep 28 08:43 ..\nlrwxr-xr-x@ 1 leularia  wheel     67 Sep 13 02:23 .codegraph -> /Users/leularia/.omo/codegraph/projects/Agent-Test-aa518fa710c5fd3b\ndrwxr-xr-x@ 5 leularia  wheel    160 Sep 2\n```',
				},
			},
		],
	},
	{
		_meta: {
			claudeCode: {
				toolName: 'Read',
			},
		},
		toolCallId: 'toolu_01NTkU27QHW4MNWUuk6JJ5vD',
		sessionUpdate: 'tool_call',
		name: 'Read',
		rawInput: {},
		status: 'pending',
		title: 'Read File',
		kind: 'read',
		locations: [],
		content: [],
	},
	{
		_meta: {
			claudeCode: {
				toolName: 'Read',
			},
		},
		toolCallId: 'toolu_01NTkU27QHW4MNWUuk6JJ5vD',
		sessionUpdate: 'tool_call_update',
		rawInput: {
			file_path: '/work/Agent-Test/harness-server.mjs',
		},
		title: 'Read harness-server.mjs',
		kind: 'read',
		locations: [
			{
				path: '/work/Agent-Test/harness-server.mjs',
				line: 1,
			},
		],
	},
	{
		_meta: {
			claudeCode: {
				toolName: 'Read',
			},
		},
		toolCallId: 'toolu_01NTkU27QHW4MNWUuk6JJ5vD',
		sessionUpdate: 'tool_call_update',
		rawInput: {
			file_path: '/work/Agent-Test/harness-server.mjs',
			offset: 510,
		},
		title: 'Read harness-server.mjs (from line 510)',
		kind: 'read',
		locations: [
			{
				path: '/work/Agent-Test/harness-server.mjs',
				line: 510,
			},
		],
	},
	{
		_meta: {
			claudeCode: {
				toolName: 'Read',
			},
		},
		toolCallId: 'toolu_01NTkU27QHW4MNWUuk6JJ5vD',
		sessionUpdate: 'tool_call_update',
		rawInput: {
			file_path: '/work/Agent-Test/harness-server.mjs',
			offset: 510,
			limit: 60,
		},
		title: 'Read harness-server.mjs (510 - 569)',
		kind: 'read',
		locations: [
			{
				path: '/work/Agent-Test/harness-server.mjs',
				line: 510,
			},
		],
		content: [],
	},
	{
		_meta: {
			claudeCode: {
				toolResponse: {
					type: 'text',
					file: '…',
				},
				toolName: 'Read',
			},
		},
		toolCallId: 'toolu_01NTkU27QHW4MNWUuk6JJ5vD',
		sessionUpdate: 'tool_call_update',
	},
	{
		_meta: {
			claudeCode: {
				toolName: 'Read',
			},
		},
		toolCallId: 'toolu_01NTkU27QHW4MNWUuk6JJ5vD',
		sessionUpdate: 'tool_call_update',
		status: 'completed',
		rawOutput: '510\t    broadcast({ type: "status", status: await getStatus() });\n511\t  }\n512\t}\n513\t\n514\tfunction json(response, statusCode, payload) {\n515\t  const body = JSON.stringify(payload);\n516\t  response.writeHead(statusCode, {\n517\t    "Content-Type": "application/json; charset=utf-8",\n518\t    "Content-Lengt',
		content: [
			{
				type: 'content',
				content: {
					type: 'text',
					text: '```\n510\t    broadcast({ type: "status", status: await getStatus() });\n511\t  }\n512\t}\n513\t\n514\tfunction json(response, statusCode, payload) {\n515\t  const body = JSON.stringify(payload);\n516\t  response.writeHead(statusCode, {\n517\t    "Content-Type": "application/json; charset=utf-8",\n518\t    "Content-L\n```',
				},
			},
		],
	},
	{
		_meta: {
			claudeCode: {
				toolName: 'Edit',
			},
		},
		toolCallId: 'toolu_01NDnXPZggRhbNFrSQqmj3zu',
		sessionUpdate: 'tool_call',
		name: 'Edit',
		rawInput: {},
		status: 'pending',
		title: 'Edit',
		kind: 'edit',
		content: [],
		locations: [],
	},
	{
		_meta: {
			claudeCode: {
				toolName: 'Edit',
			},
		},
		toolCallId: 'toolu_01NDnXPZggRhbNFrSQqmj3zu',
		sessionUpdate: 'tool_call_update',
		rawInput: {
			file_path: '/work/Agent-Test/harness-server.mjs',
		},
		title: 'Edit harness-server.mjs',
		kind: 'edit',
		locations: [
			{
				path: '/work/Agent-Test/harness-server.mjs',
			},
		],
	},
	{
		_meta: {
			claudeCode: {
				toolName: 'Edit',
			},
		},
		toolCallId: 'toolu_01NDnXPZggRhbNFrSQqmj3zu',
		sessionUpdate: 'tool_call_update',
		rawInput: {
			file_path: '/work/Agent-Test/harness-server.mjs',
			old_string: '    if (request.method === "GET" && url.pathname === "/api/status") {',
		},
		title: 'Edit harness-server.mjs',
		kind: 'edit',
		locations: [
			{
				path: '/work/Agent-Test/harness-server.mjs',
			},
		],
	},
	{
		_meta: {
			claudeCode: {
				toolName: 'Edit',
			},
		},
		toolCallId: 'toolu_01NDnXPZggRhbNFrSQqmj3zu',
		sessionUpdate: 'tool_call_update',
		rawInput: {
			replace_all: false,
			file_path: '/work/Agent-Test/harness-server.mjs',
			old_string: '    if (request.method === "GET" && url.pathname === "/api/status") {',
			new_string: '    if (request.method === "GET" && url.pathname === "/api/health") {\n      json(response, 200, { ok: true, phase: state.phase });\n      return;\n    }\n\n    if (request.method === "GET" && url.pathname === "/api/status") {',
		},
		title: 'Edit harness-server.mjs',
		kind: 'edit',
		content: [
			{
				type: 'diff',
				path: '/work/Agent-Test/harness-server.mjs',
				oldText: '    if (request.method === "GET" && url.pathname === "/api/status") {',
				newText: '    if (request.method === "GET" && url.pathname === "/api/health") {\n      json(response, 200, { ok: true, phase: state.phase });\n      return;\n    }\n\n    if (request.method === "GET" && url.pathname === "/api/status") {',
			},
		],
		locations: [
			{
				path: '/work/Agent-Test/harness-server.mjs',
			},
		],
	},
	{
		_meta: {
			claudeCode: {
				toolResponse: {
					filePath: '/work/Agent-Test/harness-server.mjs',
					oldString: '    if (request.method === "GET" && url.pathname === "/api/status") {',
					newString: '    if (request.method === "GET" && url.pathname === "/api/health") {\n      json(response, 200, { ok: true, phase: state.phase });\n      return;\n    }\n\n    if (request.method === "GET" && url.pathname === "/api/status") {',
					originalFile: '#!/usr/bin/env node\n\nimport { spawn } from "node:child_process";\nimport fs from "node:fs";\nimport http from "node:http";\nimport os from "node:os";\nimport path from "node:path";\nimport { fileURLToPath ',
					structuredPatch: [
						{
							oldStart: 551,
							oldLines: 6,
							newStart: 551,
							newLines: 11,
							lines: [
								'       return;',
								'     }',
								' ',
								'+    if (request.method === "GET" && url.pathname === "/api/health") {',
								'+      json(response, 200, { ok: true, phase: state.phase });',
								'+      return;',
								'+    }',
								'+',
								'     if (request.method === "GET" && url.pathname === "/api/status") {',
								'       json(response, 200, await getStatus());',
								'       return;',
							],
						},
					],
					userModified: false,
					replaceAll: false,
				},
				toolName: 'Edit',
			},
		},
		toolCallId: 'toolu_01NDnXPZggRhbNFrSQqmj3zu',
		sessionUpdate: 'tool_call_update',
		content: [
			{
				type: 'diff',
				path: '/work/Agent-Test/harness-server.mjs',
				oldText: '      return;\n    }\n\n    if (request.method === "GET" && url.pathname === "/api/status") {\n      json(response, 200, await getStatus());\n      return;',
				newText: '      return;\n    }\n\n    if (request.method === "GET" && url.pathname === "/api/health") {\n      json(response, 200, { ok: true, phase: state.phase });\n      return;\n    }\n\n    if (request.method === "GET" && url.pathname === "/api/status") {\n      json(response, 200, await getStatus());\n      return;',
				_meta: {
					jetbrains: {
						air: {
							version: 1,
							diffStats: {
								version: 1,
								added: 5,
								removed: 0,
							},
						},
					},
				},
			},
		],
		locations: [
			{
				path: '/work/Agent-Test/harness-server.mjs',
				line: 551,
			},
		],
	},
	{
		_meta: {
			claudeCode: {
				toolName: 'Edit',
			},
		},
		toolCallId: 'toolu_01NDnXPZggRhbNFrSQqmj3zu',
		sessionUpdate: 'tool_call_update',
		status: 'completed',
		rawOutput: 'The file /work/Agent-Test/harness-server.mjs has been updated successfully. (file state is current in your context — no need to Read it back)',
	},
	{
		_meta: {
			claudeCode: {
				toolName: 'Bash',
			},
		},
		toolCallId: 'toolu_01TJGqgkE9cxWRAHLEB13r32',
		sessionUpdate: 'tool_call',
		name: 'Bash',
		rawInput: {},
		status: 'pending',
		title: 'Terminal',
		kind: 'execute',
		content: [],
	},
	{
		_meta: {
			claudeCode: {
				toolName: 'Bash',
			},
		},
		toolCallId: 'toolu_01TJGqgkE9cxWRAHLEB13r32',
		sessionUpdate: 'tool_call_update',
		rawInput: {
			command: 'node --check harness-server.mjs && grep -n "const PORT\\|PORT =" harness-server.mjs | head',
		},
		title: 'node --check harness-server.mjs && grep -n "const PORT\\|PORT =" harness-server.mjs | head',
		kind: 'execute',
	},
	{
		_meta: {
			claudeCode: {
				toolName: 'Bash',
				title: 'Syntax-check server and find port',
			},
		},
		toolCallId: 'toolu_01TJGqgkE9cxWRAHLEB13r32',
		sessionUpdate: 'tool_call_update',
		rawInput: {
			command: 'node --check harness-server.mjs && grep -n "const PORT\\|PORT =" harness-server.mjs | head',
			description: 'Syntax-check server and find port',
		},
		title: 'node --check harness-server.mjs && grep -n "const PORT\\|PORT =" harness-server.mjs | head',
		kind: 'execute',
		content: [
			{
				type: 'content',
				content: {
					type: 'text',
					text: 'Syntax-check server and find port',
				},
			},
		],
	},
	{
		_meta: {
			claudeCode: {
				toolResponse: {
					stdout: '11:const PORT = Number(process.env.HARNESS_LAUNCHER_PORT) || 3091;\n12:const DSH_PORT = Number(process.env.DSH_PORT) || 3080;',
					stderr: '',
					interrupted: false,
					isImage: false,
					noOutputExpected: false,
				},
				toolName: 'Bash',
			},
		},
		toolCallId: 'toolu_01TJGqgkE9cxWRAHLEB13r32',
		sessionUpdate: 'tool_call_update',
	},
	{
		_meta: {
			claudeCode: {
				toolName: 'Bash',
			},
		},
		toolCallId: 'toolu_01TJGqgkE9cxWRAHLEB13r32',
		sessionUpdate: 'tool_call_update',
		status: 'completed',
		rawOutput: '11:const PORT = Number(process.env.HARNESS_LAUNCHER_PORT) || 3091;\n12:const DSH_PORT = Number(process.env.DSH_PORT) || 3080;',
		content: [
			{
				type: 'content',
				content: {
					type: 'text',
					text: '```console\n11:const PORT = Number(process.env.HARNESS_LAUNCHER_PORT) || 3091;\n12:const DSH_PORT = Number(process.env.DSH_PORT) || 3080;\n```',
				},
			},
		],
	},
	{
		_meta: {
			claudeCode: {
				toolName: 'Bash',
			},
		},
		toolCallId: 'toolu_01SCtpHpi3vStVU9jDquutyB',
		sessionUpdate: 'tool_call',
		name: 'Bash',
		rawInput: {},
		status: 'pending',
		title: 'Terminal',
		kind: 'execute',
		content: [],
	},
	{
		_meta: {
			claudeCode: {
				toolName: 'Bash',
			},
		},
		toolCallId: 'toolu_01SCtpHpi3vStVU9jDquutyB',
		sessionUpdate: 'tool_call_update',
		rawInput: {
			command: 'sed -n 630,700p harness-server.mjs',
		},
		title: 'sed -n 630,700p harness-server.mjs',
		kind: 'execute',
	},
	{
		_meta: {
			claudeCode: {
				toolName: 'Bash',
				title: 'Show server startup code',
			},
		},
		toolCallId: 'toolu_01SCtpHpi3vStVU9jDquutyB',
		sessionUpdate: 'tool_call_update',
		rawInput: {
			command: 'sed -n 630,700p harness-server.mjs',
			description: 'Show server startup code',
		},
		title: 'sed -n 630,700p harness-server.mjs',
		kind: 'execute',
		content: [
			{
				type: 'content',
				content: {
					type: 'text',
					text: 'Show server startup code',
				},
			},
		],
	},
	{
		_meta: {
			claudeCode: {
				toolResponse: {
					stdout: '      }\n      return;\n    }\n\n    notFound(response);\n  } catch (error) {\n    json(response, 500, { error: error instanceof Error ? error.message : String(error) });\n  }\n});\n\nserver.listen(PORT, "127.0',
					stderr: '',
					interrupted: false,
					isImage: false,
					noOutputExpected: false,
				},
				toolName: 'Bash',
			},
		},
		toolCallId: 'toolu_01SCtpHpi3vStVU9jDquutyB',
		sessionUpdate: 'tool_call_update',
	},
	{
		_meta: {
			claudeCode: {
				toolName: 'Bash',
			},
		},
		toolCallId: 'toolu_01SCtpHpi3vStVU9jDquutyB',
		sessionUpdate: 'tool_call_update',
		status: 'completed',
		rawOutput: '      }\n      return;\n    }\n\n    notFound(response);\n  } catch (error) {\n    json(response, 500, { error: error instanceof Error ? error.message : String(error) });\n  }\n});\n\nserver.listen(PORT, "127.0.0.1", () => {\n  const url = `http://127.0.0.1:${PORT}/`;\n  console.log(`DeepSeek Harness launcher: ',
		content: [
			{
				type: 'content',
				content: {
					type: 'text',
					text: '```console\n      }\n      return;\n    }\n\n    notFound(response);\n  } catch (error) {\n    json(response, 500, { error: error instanceof Error ? error.message : String(error) });\n  }\n});\n\nserver.listen(PORT, "127.0.0.1", () => {\n  const url = `http://127.0.0.1:${PORT}/`;\n  console.log(`DeepSeek Harness\n```',
				},
			},
		],
	},
	{
		sessionUpdate: 'agent_message_chunk',
		content: {
			type: 'text',
			text: 'I added `GET /api/health` to `harness-server.mjs:554`. It returns `{ "ok": true, "phase": "<current phase>" }` with a 200 status. It uses the same `json()` helper as the other API routes, so the headers match theirs.\n\nThe file passes a Node syntax check, but I haven\'t called the endpoint. I didn\'t start the server because on macOS it opens a browser window on launch. To check it yourself, start the server and run `curl http://127.0.0.1:3091/api/health`. It should return `{"ok":true,"phase":"idle"}` before anything is installed.',
		},
		messageId: 'msg_011CfVE4cL6qi6CiAskvWTNM',
	},
];

/**
 * The same request through Cursor's agent (`cursor-agent acp`, Grok 4.7). Cursor sends the whole
 * file as the edit's old and new text; here it is cut to the region around the change.
 */
export const CURSOR_EDIT_TURN: readonly Record<string, unknown>[] = [
	{
		sessionUpdate: 'session_info_update',
		title: 'Health Check Endpoint',
	},
	{
		sessionUpdate: 'agent_thought_chunk',
		content: {
			type: 'text',
			text: 'Adding a GET /api/health endpoint to harness-server.mjs that returns { ok: true, phase } as JSON.\n\nReading the file to understand its current structure.',
		},
	},
	{
		sessionUpdate: 'agent_message_chunk',
		content: {
			type: 'text',
			text: 'I\'ll look at `harness-server.mjs` and add a GET `/api/health` route that returns `{ ok: true, phase }` as JSON.',
		},
	},
	{
		sessionUpdate: 'tool_call',
		toolCallId: 'call-77f7f5af-d467-42f2-a8ee-0b03efdf51ad-0\nfc_9e757d63-9d06-94e1-bfae-343cde87454b_0',
		title: 'Find',
		kind: 'search',
		status: 'pending',
		rawInput: {},
	},
	{
		sessionUpdate: 'tool_call_update',
		toolCallId: 'call-77f7f5af-d467-42f2-a8ee-0b03efdf51ad-0\nfc_9e757d63-9d06-94e1-bfae-343cde87454b_0',
		title: 'Find `**/harness-server.mjs`',
		rawInput: {
			pattern: '**/harness-server.mjs',
		},
	},
	{
		sessionUpdate: 'tool_call_update',
		toolCallId: 'call-77f7f5af-d467-42f2-a8ee-0b03efdf51ad-0\nfc_9e757d63-9d06-94e1-bfae-343cde87454b_0',
		status: 'in_progress',
	},
	{
		sessionUpdate: 'tool_call_update',
		toolCallId: 'call-77f7f5af-d467-42f2-a8ee-0b03efdf51ad-0\nfc_9e757d63-9d06-94e1-bfae-343cde87454b_0',
		status: 'completed',
		rawOutput: {
			totalFiles: 1,
			truncated: false,
		},
	},
	{
		sessionUpdate: 'agent_thought_chunk',
		content: {
			type: 'text',
			text: 'Located the target file. Reading it now.',
		},
	},
	{
		sessionUpdate: 'tool_call',
		toolCallId: 'call-948f6c44-6f72-431f-9630-1a48d95d43f7-1\nfc_ecb28034-85ad-99bf-85da-790ade9f1bfa_0',
		title: 'Read File',
		kind: 'read',
		status: 'pending',
		rawInput: {},
	},
	{
		sessionUpdate: 'tool_call_update',
		toolCallId: 'call-948f6c44-6f72-431f-9630-1a48d95d43f7-1\nfc_ecb28034-85ad-99bf-85da-790ade9f1bfa_0',
		title: 'Read harness-server.mjs',
		rawInput: {
			path: '/work/Agent-Test/harness-server.mjs',
		},
		locations: [
			{
				path: '/work/Agent-Test/harness-server.mjs',
			},
		],
	},
	{
		sessionUpdate: 'tool_call_update',
		toolCallId: 'call-948f6c44-6f72-431f-9630-1a48d95d43f7-1\nfc_ecb28034-85ad-99bf-85da-790ade9f1bfa_0',
		status: 'in_progress',
	},
	{
		sessionUpdate: 'tool_call_update',
		toolCallId: 'call-948f6c44-6f72-431f-9630-1a48d95d43f7-1\nfc_ecb28034-85ad-99bf-85da-790ade9f1bfa_0',
		status: 'completed',
	},
	{
		sessionUpdate: 'agent_thought_chunk',
		content: {
			type: 'text',
			text: 'Adding a GET /api/health endpoint to harness-server.mjs that returns JSON with ok and phase fields.\n\nThe `phase` value comes from `state.phase`. I\'ll use the existing `json()` helper and place the route near `/api/status`. This avoids the heavier `getStatus()` probing.',
		},
	},
	{
		sessionUpdate: 'agent_message_chunk',
		content: {
			type: 'text',
			text: 'The server already has a JSON helper and a `phase` on its state. I\'ll add a lightweight GET `/api/health` next to the other API routes.',
		},
	},
	{
		sessionUpdate: 'tool_call',
		toolCallId: 'call-26729fbc-3a1a-43fa-92ca-7f9e69a466cd-2\nfc_2b483f85-e393-9103-a0de-aebfd5130f34_0',
		title: 'Edit File',
		kind: 'edit',
		status: 'pending',
		rawInput: {},
	},
	{
		sessionUpdate: 'tool_call_update',
		toolCallId: 'call-26729fbc-3a1a-43fa-92ca-7f9e69a466cd-2\nfc_2b483f85-e393-9103-a0de-aebfd5130f34_0',
		title: 'Edit `/work/Agent-Test/harness-server.mjs`',
		rawInput: {
			path: '/work/Agent-Test/harness-server.mjs',
		},
		locations: [
			{
				path: '/work/Agent-Test/harness-server.mjs',
			},
		],
	},
	{
		sessionUpdate: 'tool_call_update',
		toolCallId: 'call-26729fbc-3a1a-43fa-92ca-7f9e69a466cd-2\nfc_2b483f85-e393-9103-a0de-aebfd5130f34_0',
		status: 'in_progress',
	},
	{
		sessionUpdate: 'tool_call_update',
		toolCallId: 'call-26729fbc-3a1a-43fa-92ca-7f9e69a466cd-2\nfc_2b483f85-e393-9103-a0de-aebfd5130f34_0',
		status: 'completed',
		content: [
			{
				type: 'diff',
				path: '/work/Agent-Test/harness-server.mjs',
				oldText: '        "Content-Type": "text/html; charset=utf-8",\n        "Cache-Control": "no-store"\n      });\n      response.end(html);\n      return;\n    }\n\n    if (request.method === "GET" && url.pathname === "/api/status") {\n      json(response, 200, await getStatus());\n      return;\n    }\n\n    if (request.method === "GET" && url.pathname === "/api/events") {\n      response.writeHead(200, {\n        "Content-Type": "text/event-stream",',
				newText: '        "Content-Type": "text/html; charset=utf-8",\n        "Cache-Control": "no-store"\n      });\n      response.end(html);\n      return;\n    }\n\n    if (request.method === "GET" && url.pathname === "/api/health") {\n      json(response, 200, { ok: true, phase: state.phase });\n      return;\n    }\n\n    if (request.method === "GET" && url.pathname === "/api/status") {\n      json(response, 200, await getStatus());\n      return;\n    }\n\n    if (request.method === "GET" && url.pathname === "/api/events") {\n      response.writeHead(200, {\n        "Content-Type": "text/event-stream",',
			},
		],
	},
	{
		sessionUpdate: 'agent_thought_chunk',
		content: {
			type: 'text',
			text: 'The requested endpoint has been added.\n\nIt uses the existing `json()` helper for consistent headers. The response includes `ok: true` and the current `phase`.',
		},
	},
	{
		sessionUpdate: 'agent_message_chunk',
		content: {
			type: 'text',
			text: '`GET /api/health` is now on `harness-server.mjs`. It responds with `200` and JSON `{ ok: true, phase }`, where `phase` is the launcher\'s current state (`idle`, `installing`, `configuring`, `starting`, `ready`, or `error`).',
		},
	},
];

/**
 * The `/compact` turn claude-agent-acp 0.81.2 (Haiku 4.5) sent after a turn that read three
 * 29 KB files, with Volt advertising `session.compaction`: the compaction as its own entity,
 * then `used` set to the kept summary alone. Recorded 2026-10-06; the summary is trimmed.
 */
export const CLAUDE_COMPACT_TURN: readonly Record<string, unknown>[] = [
	{ sessionUpdate: 'compaction_update', compactionId: 'bf443240-8698-47cb-9402-444c11428453', status: 'in_progress', _meta: { contextCompaction: { version: 1 } } },
	{
		sessionUpdate: 'compaction_update',
		compactionId: 'bf443240-8698-47cb-9402-444c11428453',
		status: 'completed',
		summary: [{ type: 'text', text: '1. Primary Request and Intent:\n   The user requested that I read three text files (notes1.txt, notes2.txt, and notes3.txt) in full using the Read tool, and then provide a one-line response per file stating the line count for each file.\n\n2.\n…' }],
		_meta: { contextCompaction: { version: 1 } },
	},
	{ sessionUpdate: 'compaction_update', compactionId: 'bf443240-8698-47cb-9402-444c11428453', status: 'completed', _meta: { contextCompaction: { version: 1, trigger: 'manual', preTokens: 51787, postTokens: 2244, durationMs: 14734 } } },
	{ sessionUpdate: 'usage_update', used: 2244, size: 200000 },
];

/** The same turn without `session.compaction`: a "Compact conversation" tool call marked by `_meta.contextCompaction`. */
export const CLAUDE_COMPACT_TURN_LEGACY: readonly Record<string, unknown>[] = [
	{ sessionUpdate: 'tool_call', toolCallId: '900e1d46-90fd-4fdf-9fec-08be32e628ff', title: 'Compact conversation', kind: 'think', status: 'in_progress', _meta: { contextCompaction: { version: 1 }, claudeCode: { toolName: 'compact' } } },
	{ sessionUpdate: 'tool_call_update', toolCallId: '900e1d46-90fd-4fdf-9fec-08be32e628ff', status: 'completed', _meta: { contextCompaction: { version: 1 }, claudeCode: { toolName: 'compact' } } },
	{
		sessionUpdate: 'tool_call_update',
		toolCallId: '900e1d46-90fd-4fdf-9fec-08be32e628ff',
		rawOutput: { trigger: 'manual', preTokens: 49437, postTokens: 2075, durationMs: 12513 },
		_meta: { contextCompaction: { version: 1, trigger: 'manual', preTokens: 49437, postTokens: 2075, durationMs: 12513 }, claudeCode: { toolName: 'compact' } },
	},
	{ sessionUpdate: 'usage_update', used: 2075, size: 200000 },
];
