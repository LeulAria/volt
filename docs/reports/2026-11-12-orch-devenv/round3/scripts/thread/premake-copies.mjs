#!/usr/bin/env node
// Writes the brotli-11 copies the branch's server keeps on disk (serverCompression.ts
// CompressedCopies.writeCache: same name, same level, same folder) for an app's large launch files,
// the state a server is in after a phone's first visit. Lets the slow-link launch run measure the
// "later launches" case without a non-loopback client (the proxy's requests count as this computer's).
//   node premake-copies.mjs <appDir> <userDataDir>
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const [app, ud] = process.argv.slice(2);
const dir = path.join(ud, 'agentServer', 'compressed');
fs.mkdirSync(dir, { recursive: true });
for (const rel of ['out/vs/code/browser/workbench/workbench.js', 'out/vs/code/browser/workbench/workbench.css']) {
	// The server names a copy by the path it serves, which is the real one (/tmp is /private/tmp).
	const file = fs.realpathSync(path.join(app, rel));
	const stat = fs.statSync(file);
	const contents = fs.readFileSync(file);
	const prefix = createHash('sha1').update(`br:${file}`).digest('hex').slice(0, 20);
	const name = `${prefix}-${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}.br`;
	if (fs.existsSync(path.join(dir, name))) {
		continue;
	}
	const t = Date.now();
	const best = zlib.brotliCompressSync(contents, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: contents.length } });
	fs.writeFileSync(path.join(dir, name), best);
	console.log(`${rel}: ${contents.length} -> ${best.length} (${Date.now() - t} ms) as ${name}`);
}
