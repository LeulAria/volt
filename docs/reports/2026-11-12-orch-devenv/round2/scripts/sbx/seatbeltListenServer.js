const net = require('net');
const host = process.argv[2];
const s = net.createServer(c => { c.end('hello-from-sandbox\n'); });
s.on('error', e => { console.log(JSON.stringify({ error: e.code })); process.exit(0); });
s.listen(0, host, () => { console.log(JSON.stringify({ listening: s.address() })); });
setTimeout(() => process.exit(0), 4000);
