import { readFileSync } from 'fs';
const token = JSON.parse(readFileSync(process.env.HOME + '/.volt-r5/orch/c1/cfg-clean/.credentials.json', 'utf8')).claudeAiOauth.accessToken;
async function count(system) {
	const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20,token-counting-2024-11-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-haiku-5-5', system, messages: [{ role: 'user', content: 'hi' }] }) });
	return (await res.json()).input_tokens;
}
const a = (await import('/Users/leularia/Desktop/VOLT/volt-e5-base/out/vs/platform/voltHostMcp/common/voltHostMcp.js')).hostMcpInstructions();
const b = (await import('/Users/leularia/Desktop/VOLT/volt-e5-orch/out/vs/platform/voltHostMcp/common/voltHostMcp.js')).hostMcpInstructions();
const [ta, tb] = [await count(a), await count(b)];
console.log(JSON.stringify({ before: { chars: a.length, tokens: ta }, after: { chars: b.length, tokens: tb }, delta: tb - ta }));
