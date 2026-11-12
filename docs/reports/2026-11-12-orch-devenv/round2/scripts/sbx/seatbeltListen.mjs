import { spawn } from 'child_process';
import net from 'net';
const LAN = process.argv[2];
const base = '(version 1)(allow default)(deny network-bind (local tcp "*:*"))(deny network-inbound (local ip "*:*"))(allow network-inbound (local udp "*:*"))';
const variants = {
  'bind+inbound localhost:*': '(allow network-bind (local ip "localhost:*"))(allow network-inbound (local ip "localhost:*"))',
  'bind localhost:* + inbound localhost:* & *:*': '(allow network-bind (local ip "localhost:*"))(allow network-inbound (local ip "localhost:*") (local ip "*:*"))',
  'bind localhost:* + inbound (remote ip localhost:*)': '(allow network-bind (local ip "localhost:*"))(allow network-inbound (remote ip "localhost:*"))',
  'bind localhost:* + inbound (require-all local localhost:* remote localhost:*)': '(allow network-bind (local ip "localhost:*"))(allow network-inbound (require-all (local ip "localhost:*") (remote ip "localhost:*")))',
  'bind ip4 localhost:* + inbound ip4 localhost:*': '(allow network-bind (local ip4 "localhost:*"))(allow network-inbound (local ip4 "localhost:*"))',
};
const tryConnect = (host, port) => new Promise(res => {
  const c = net.connect({ host, port, timeout: 1500 });
  let data = '';
  c.on('data', d => data += d);
  c.on('end', () => res(data.trim() ? 'DATA' : 'connected-no-data'));
  c.on('timeout', () => { c.destroy(); res(data ? 'DATA' : 'timeout'); });
  c.on('error', e => res('error:' + e.code));
});
for (const [name, rules] of Object.entries(variants)) {
  for (const host of ['127.0.0.1', '0.0.0.0', '::', LAN]) {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', base + rules, process.execPath, 'server.js', host]);
    const line = await new Promise(res => { let out=''; child.stdout.on('data', d => { out += d; if (out.includes('\n')) res(out.split('\n')[0]); }); child.on('exit', () => res(out || 'exit')); });
    let result = line;
    try {
      const j = JSON.parse(line);
      if (j.listening) {
        const port = j.listening.port;
        const lo = await tryConnect('127.0.0.1', port);
        const lan = await tryConnect(LAN, port);
        result = `bound ${j.listening.address}:${port}  via 127.0.0.1 -> ${lo}  via ${LAN} -> ${lan}`;
      } else result = 'bind refused: ' + j.error;
    } catch {}
    child.kill();
    console.log(`[${name}] host=${host}: ${result}`);
  }
}
