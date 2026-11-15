// Evaluates one expression in a Node process over its inspector (the agent server launched with
// VOLT_AGENT_SERVER_INSPECT=1 NODE_OPTIONS=--inspect-port=<port>, then `kill -USR1 <pid>`).
//   node nodeeval.mjs http://127.0.0.1:9239 'JSON.stringify(process.memoryUsage())'
const [target, expression] = process.argv.slice(2);
const list = await (await fetch(`${target}/json`)).json();
const ws = new WebSocket(list[0].webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
const reply = new Promise(r => ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id === 1) { r(m); } }));
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
const m = await reply;
console.log(m.result?.exceptionDetails ? JSON.stringify(m.result.exceptionDetails).slice(0, 500) : m.result?.result?.value);
ws.close();
