// One line about the test window's renderer now: phys footprint, JS heap after GC, WebAssembly memories (MiB each),
// DOM element count, and its memory-infra top-level allocators. Exploratory.   node rsnap.mjs <label>
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { UD, cdp, load } from './lib.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const c = await cdp();
await c.send('HeapProfiler.collectGarbage');
const heap = (await c.send('Runtime.getHeapUsage')).result;
const proto = await c.send('Runtime.evaluate', { expression: 'WebAssembly.Memory.prototype' });
const q = await c.send('Runtime.queryObjects', { prototypeObjectId: proto.result.result.objectId });
const w = await c.send('Runtime.callFunctionOn', { objectId: q.result.objects.objectId, returnByValue: true, functionDeclaration: 'function () { return this.map(m => Math.round(m.buffer.byteLength / 1048576)); }' });
const dom = await c.evaluate('document.querySelectorAll("*").length');
c.close();
const pid = execFileSync('pgrep', ['-f', `type=renderer.*${UD}`]).toString().trim().split('\n')[0];
const gpid = execFileSync('pgrep', ['-f', `type=gpu-process.*${UD}`]).toString().trim().split('\n')[0];
const fp = p => /Footprint: ([\d.]+ \w+)/.exec(execFileSync('footprint', ['-p', p]).toString())?.[1];
let alloc = '';
try { alloc = execFileSync('node', [join(here, 'allocators.mjs'), '', '1'], { maxBuffer: 64 << 20 }).toString().split('\n').filter(l => /Renderer|^\s+[\d.]+\s+(blink_gc|v8|malloc|partition_alloc|parkable_strings|cc|gpu|web_cache|font_caches|skia)$/.test(l)).map(l => l.trim().replace(/\s+/g, ' ')).join('; '); } catch (e) { alloc = 'allocators failed'; }
console.log(`${process.argv[2] ?? ''} ${new Date().toTimeString().slice(0, 8)} load ${load()} renderer ${fp(pid)} gpu ${fp(gpid)} heap ${Math.round(heap.usedSize / 1048576)}/${Math.round(heap.totalSize / 1048576)} MiB wasm [${w.result.result.value}] dom ${dom}\n   ${alloc}`);
process.exit(0);
