import { spawn } from 'child_process';
import net from 'net';
const LAN = process.argv[2];
const srv = net.createServer(c => { c.on('error', () => {}); c.end('x'); }).listen(0, '0.0.0.0');
await new Promise(r => srv.on('listening', r));
const p = srv.address().port;
for (const target of ['127.0.0.1', LAN, '100.68.14.63']) {
  const prof = `(version 1)(allow default)(deny network-outbound (remote ip "*:*"))(allow network-outbound (remote ip "localhost:${p}"))`;
  const out = await new Promise(res => { const c = spawn('/usr/bin/sandbox-exec', ['-p', prof, process.execPath, '-e', `require('net').connect(${p}, '${target}').on('connect', () => { console.log('connected'); process.exit(0) }).on('error', e => { console.log(e.code); process.exit(0) })`]); let o=''; c.stdout.on('data', d => o+=d); c.on('exit', () => res(o.trim())); });
  console.log(`outbound with (remote ip "localhost:${p}") to ${target}: ${out}`);
}
srv.close();
