// Probe: CDP-typed keys and Chromium's EventLatency (key to presentation) in the test window. Analysis aid.
//   node keylat-probe.mjs [keys=10] [categories=latencyInfo,input,benchmark]
import { cdp, focusComposer, sleep } from './lib.mjs';
import { keyLatencies } from './a8.mjs';
const n = Number(process.argv[2] ?? 10);
const cats = (process.argv[3] ?? 'latencyInfo,input,benchmark').split(',');
const c = await cdp();
await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
await focusComposer(c);
const chunks = [];
c.on('Tracing.dataCollected', p => { for (const e of p.value) { if (e.name === 'EventLatency') { chunks.push(e); } } });
const done = new Promise(r => c.on('Tracing.tracingComplete', r));
await c.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: cats } });
await sleep(300);
for (let i = 0; i < n; i++) {
	const ch = 'abcdefghij'[i % 10];
	const code = ch.toUpperCase().charCodeAt(0);
	await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, text: ch });
	await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
	await sleep(250);
}
await sleep(1000);
await c.send('Tracing.end');
await done;
console.log(`${chunks.length} EventLatency events; key to presentation ms:`, JSON.stringify(keyLatencies(chunks)));
await c.key('a', 'KeyA', 65, 4);
await c.key('Backspace', 'Backspace', 8);
c.close();
