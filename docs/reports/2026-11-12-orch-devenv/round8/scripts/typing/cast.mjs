// Check (not a timing): a screencast of one streaming reply per arm, to compare how the fade looks before and after.
// Per arm: a fresh profile, one new chat sent `replay:stream-1`, 3 s, then every screencast frame for 8 s into
// ~/.volt-r8/typing/cast/<arm>/ (jpeg, with frames.json: file and timestamp) and <arm>.mp4 at the frames' own timing.
//   node cast.mjs <arm,arm,...>
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { freshProfile } from './a8.mjs';
import { arm as armOf, cdp, HOME, launch, newChat, send, sleep, stop, waitWorkbench, writeSettings } from './lib.mjs';

const OUT = `${HOME}/.volt-r8/typing/cast`;
for (const arm of (process.argv[2] ?? 'before,after').split(',').map(armOf)) {
	const dir = `${OUT}/${arm}`;
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	await freshProfile(arm);
	writeSettings(arm);
	launch(arm, { keepRendering: true });
	await waitWorkbench();
	await sleep(8000);
	const c = await cdp();
	await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
	await newChat(c);
	await sleep(1500);
	await send(c, 'replay:stream-1');
	await sleep(3000);
	const frames = [];
	c.on('Page.screencastFrame', p => {
		const file = `${String(frames.length).padStart(4, '0')}.jpg`;
		writeFileSync(`${dir}/${file}`, Buffer.from(p.data, 'base64'));
		frames.push({ file, t: p.metadata.timestamp });
		c.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => { });
	});
	await c.send('Page.startScreencast', { format: 'jpeg', quality: 90, everyNthFrame: 1 });
	await sleep(8000);
	await c.send('Page.stopScreencast');
	await sleep(300);
	writeFileSync(`${dir}/frames.json`, JSON.stringify(frames));
	// ffmpeg concat list with each frame's own duration (a screencast timestamp can run a few ms backwards).
	const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, (frames[i + 1]?.t ?? f.t + 1 / 60) - f.t).toFixed(4)}`).join('\n');
	writeFileSync(`${dir}/list.txt`, `${list}\nfile '${frames.at(-1).file}'\n`);
	execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', `${dir}/list.txt`, '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-pix_fmt', 'yuv420p', '-r', '120', `${OUT}/${arm}.mp4`]);
	const span = frames.length > 1 ? frames.at(-1).t - frames[0].t : 0;
	console.log(`${arm}: ${frames.length} frames in ${span.toFixed(2)} s (${(frames.length / Math.max(span, 0.001)).toFixed(0)} fps) -> ${OUT}/${arm}.mp4`);
	c.close();
	await stop(arm);
}
