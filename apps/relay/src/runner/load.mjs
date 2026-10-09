/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import os from 'node:os';

/**
 * Host load for heartbeats. Inside a container the load average is the whole host's (every
 * container on a Docker VM reports the same number), so the busy fraction comes from the
 * container's own cgroup CPU counter and its CPU quota instead; on bare machines it comes from
 * the CPU time counters. Memory likewise prefers the cgroup limit.
 */
export class LoadSampler {

	constructor(root = '/sys/fs/cgroup') {
		this.root = root;
		this.previous = undefined;
	}

	sample() {
		const now = performance.now();
		const cpus = this.effectiveCpus();
		const [load1, load5] = os.loadavg();
		const usage = this.cgroupCpuUsec();
		const times = usage === undefined ? cpuTimes() : undefined;
		let cpu;
		const previous = this.previous;
		if (previous) {
			if (usage !== undefined && previous.usage !== undefined) {
				const elapsedUsec = (now - previous.at) * 1000;
				cpu = elapsedUsec > 0 ? (usage - previous.usage) / elapsedUsec / cpus : undefined;
			} else if (times && previous.times) {
				const busy = times.busy - previous.times.busy;
				const total = times.total - previous.times.total;
				cpu = total > 0 ? busy / total : undefined;
			}
		}
		this.previous = { at: now, usage, times };
		const memory = this.cgroupMemory() ?? { free: os.freemem(), total: os.totalmem() };
		return {
			cpus: round(cpus, 2),
			load1: round(load1, 2),
			load5: round(load5, 2),
			...(cpu !== undefined ? { cpu: round(Math.max(0, Math.min(1, cpu)), 3) } : {}),
			memFree: memory.free,
			memTotal: memory.total,
			container: usage !== undefined,
		};
	}

	effectiveCpus() {
		const host = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
		const max = this.read('cpu.max');
		if (max) {
			const [quota, period] = max.trim().split(/\s+/);
			if (quota !== 'max' && Number(period) > 0) {
				return Math.max(0.1, Math.min(host, Number(quota) / Number(period)));
			}
		}
		return host;
	}

	cgroupCpuUsec() {
		const stat = this.read('cpu.stat');
		const match = stat && /usage_usec\s+(\d+)/.exec(stat);
		return match ? Number(match[1]) : undefined;
	}

	cgroupMemory() {
		const current = Number(this.read('memory.current'));
		const max = this.read('memory.max')?.trim();
		if (!Number.isFinite(current) || current <= 0) {
			return undefined;
		}
		const total = max && max !== 'max' ? Number(max) : os.totalmem();
		return { free: Math.max(0, total - current), total };
	}

	read(name) {
		try {
			return fs.readFileSync(`${this.root}/${name}`, 'utf8');
		} catch {
			return undefined;
		}
	}
}

function cpuTimes() {
	let busy = 0;
	let total = 0;
	for (const cpu of os.cpus()) {
		const { user, nice, sys, idle, irq } = cpu.times;
		busy += user + nice + sys + irq;
		total += user + nice + sys + idle + irq;
	}
	return { busy, total };
}

function round(value, digits) {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}
