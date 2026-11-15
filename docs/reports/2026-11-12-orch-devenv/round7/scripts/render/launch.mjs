// node launch.mjs [--live]   start the dev test instance (replay server unless --live); node launch.mjs stop
import { launchDev, waitWorkbench, writeSettings, stopInstance, load } from './lib.mjs';
const cmd = process.argv[2];
if (cmd === 'stop') {
	await stopInstance();
	console.log('stopped');
} else {
	writeSettings();
	const pid = launchDev({ replay: !process.argv.includes('--live') });
	const ms = await waitWorkbench();
	console.log(JSON.stringify({ pid, ms, load: load() }));
}
