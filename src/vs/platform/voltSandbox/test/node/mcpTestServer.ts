/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';

/**
 * A minimal stdio MCP server for the C6 suites: a POSIX shell script speaking MCP's
 * newline-delimited JSON-RPC, so it runs the same on macOS and in the Linux rig with nothing
 * installed. Tools: `read`/`write` a path (the canary), `crash`, `grow` (64 MB held in a pipe),
 * `bigfile` (150 MB into its temp folder), `child` (a `sleep 31337` in the background), `env`.
 */
export const MCP_TEST_SERVER_SCRIPT = `
reply() { printf '{"jsonrpc":"2.0","id":%s,"result":%s}\\n' "$1" "$2"; }
text() { reply "$1" "{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"$2\\"}]}"; }
arg() { printf '%s\\n' "$line" | sed -n "s/.*\\"$1\\":\\"\\([^\\"]*\\)\\".*/\\1/p"; }
while IFS= read -r line; do
	id=$(printf '%s\\n' "$line" | sed -n 's/.*"id":\\([0-9][0-9]*\\).*/\\1/p')
	[ -n "$id" ] || continue
	case "$line" in
	*'"method":"initialize"'*) reply "$id" '{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"sh-test","version":"1"}}' ;;
	*'"method":"tools/list"'*) reply "$id" '{"tools":[{"name":"read","inputSchema":{"type":"object","properties":{"path":{"type":"string"}}}},{"name":"write"},{"name":"crash"},{"name":"grow"},{"name":"bigfile"},{"name":"child"},{"name":"env"}]}' ;;
	*'"name":"read"'*) if content=$(cat "$(arg path)" 2>/dev/null); then text "$id" "READ:$content"; else text "$id" "DENIED"; fi ;;
	*'"name":"write"'*) if (echo pwned > "$(arg path)") 2>/dev/null; then text "$id" "WROTE"; else text "$id" "DENIED"; fi ;;
	*'"name":"crash"'*) echo 'mcp test server: crash requested' >&2; exit 3 ;;
	*'"name":"grow"'*) (dd if=/dev/urandom bs=67108864 count=1 2>/dev/null | sleep 60) & text "$id" "GROWING" ;;
	*'"name":"bigfile"'*) dd if=/dev/zero of="$TMPDIR/big" bs=1048576 count=150 2>/dev/null; text "$id" "SIZE:$(wc -c < "$TMPDIR/big" | tr -d ' ')" ;;
	*'"name":"child"'*) sleep 31337 & text "$id" "CHILD" ;;
	*'"name":"env"'*) text "$id" "HOME:$HOME" ;;
	esac
done
`;

export const MCP_TEST_SERVER_TOOLS = ['read', 'write', 'crash', 'grow', 'bigfile', 'child', 'env'];

/** JSON-RPC over a line stream: requests by id, replies matched by id. */
export class McpTestClient {
	private next = 1;
	private buffer = '';
	private readonly waiting = new Map<number, (message: Record<string, unknown>) => void>();

	constructor(private readonly send: (line: string) => unknown) { }

	push(chunk: string): void {
		this.buffer += chunk;
		let newline: number;
		while ((newline = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) {
				continue;
			}
			const message = JSON.parse(line) as Record<string, unknown>;
			const resolve = this.waiting.get(message.id as number);
			if (resolve) {
				this.waiting.delete(message.id as number);
				resolve(message);
			}
		}
	}

	request(method: string, params: unknown, ms = 15_000): Promise<Record<string, unknown>> {
		const id = this.next++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiting.delete(id);
				reject(new Error(`no reply to ${method}`));
			}, ms);
			this.waiting.set(id, message => {
				clearTimeout(timer);
				resolve(message);
			});
			try {
				void Promise.resolve(this.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')).catch(fail);
			} catch (err) {
				fail(err);
			}
			function fail(err: unknown) {
				clearTimeout(timer);
				reject(err);
			}
		});
	}

	/** `tools/call`, as MCP clients write it (compact JSON, `name` first); the first text content. */
	async call(tool: string, args: Record<string, string> = {}): Promise<string> {
		const reply = await this.request('tools/call', { name: tool, arguments: args });
		return (reply.result as { content: { text: string }[] }).content[0].text;
	}

	/** `initialize`, then `tools/list`: the tool names. */
	async initialize(): Promise<string[]> {
		const init = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Volt', version: '1' } });
		assert.strictEqual((init.result as { serverInfo: { name: string } }).serverInfo.name, 'sh-test');
		const list = await this.request('tools/list', {});
		return (list.result as { tools: { name: string }[] }).tools.map(tool => tool.name);
	}
}
