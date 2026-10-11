/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Renders catalog devices with the studio in headless Chromium and saves PNGs.
//   node build/volt/deviceStudio/harness/shoot.mjs --id iphone-17-pro --view angle --out /tmp/x.png
// Options: --id <id> (repeatable) | --all, --view front|angle|side|back, --yaw <rad>, --pitch <rad>,
// --finish <id>, --posture closed|half|open, --hinge <deg>, --landscape, --light, --size 900x1000,
// --out <file.png> (one shot) | --dir <folder> (one file per id), --entry <file.json> (repeatable): a full
// IDeviceCatalogEntry to draw besides the catalog (use its id with --id). The studio and catalog are
// bundled fresh on every run (in memory), so several runs can share this folder.
import { chromium } from '../../../../node_modules/playwright/index.mjs';
import { build } from '../../../node_modules/esbuild/lib/main.js';
import { createServer } from 'http';
import { readFile, mkdir, stat } from 'fs/promises';
import { dirname, extname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : fallback;
};
const values = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));

const bundle = await build({
	entryPoints: [join(here, 'entry.ts')],
	bundle: true,
	format: 'esm',
	platform: 'browser',
	target: 'es2022',
	write: false,
	logLevel: 'warning',
});
const bundleText = bundle.outputFiles[0].text;
const entries = await Promise.all(values('entry').map(async (file) => JSON.parse(await readFile(file, 'utf8'))));

const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = createServer(async (req, res) => {
	try {
		const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
		if (pathname === '/harness.js') {
			res.writeHead(200, { 'content-type': 'text/javascript' });
			res.end(bundleText);
			return;
		}
		const path = join(here, pathname);
		const body = await readFile(path);
		res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
		res.end(body);
	} catch {
		res.writeHead(404);
		res.end();
	}
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
	headless: true,
	// The installed Chrome renders WebGL on the GPU (Metal); Playwright's bundled shell may be missing.
	channel: process.env.VOLT_HARNESS_CHANNEL ?? 'chrome',
	args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
try {
	// Page pictures the device screens show: a phone-shaped and a wide one.
	const exists = async (p) => !!(await stat(p).catch(() => undefined));
	for (const [name, width, height] of [['page-phone.png', 440, 1000], ['page-wide.png', 1512, 945]]) {
		const file = join(here, name);
		if (!(await exists(file))) {
			const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
			const p = await context.newPage();
			await p.goto(`${base}/sample.html`);
			await p.screenshot({ path: file });
			await context.close();
		}
	}
	const [w, h] = value('size', '900x1000').split('x').map(Number);
	const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
	const page = await context.newPage();
	page.on('console', (m) => {
		if (m.type() === 'error' || m.type() === 'warning') {
			console.error('[page]', m.text());
		}
	});
	page.on('pageerror', (e) => console.error('[page error]', e.message));
	await page.goto(`${base}/index.html`);
	await page.waitForFunction(() => document.title === 'ready');
	for (const entry of entries) {
		await page.evaluate((e) => window.voltHarness.add(e), entry);
	}
	const ids = flag('all') ? await page.evaluate(() => window.voltHarness.ids()) : values('id');
	if (!ids.length) {
		throw new Error('pass --id <id> or --all');
	}
	const dir = value('dir');
	if (dir) {
		await mkdir(dir, { recursive: true });
	}
	for (const id of ids) {
		const options = {
			id,
			finish: value('finish'),
			posture: value('posture'),
			landscape: flag('landscape'),
			view: value('view'),
			yaw: value('yaw') !== undefined ? Number(value('yaw')) : undefined,
			pitch: value('pitch') !== undefined ? Number(value('pitch')) : undefined,
			hinge: value('hinge') !== undefined ? Number(value('hinge')) : undefined,
			light: flag('light'),
		};
		const info = await page.evaluate((o) => window.voltHarness.show(o), options);
		const out = dir ? join(dir, `${id}${options.view ? '-' + options.view : ''}.png`) : value('out', `/tmp/volt-device-${id}.png`);
		await page.screenshot({ path: out });
		console.log(out, info);
	}
} finally {
	await browser.close();
	server.close();
}
