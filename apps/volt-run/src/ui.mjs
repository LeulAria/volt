/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Terminal output: colors (off for NO_COLOR, pipes and dumb terminals), one status line that
// redraws in place (spinner, download progress), and QR codes for pairing a phone.

const env = process.env;
export const useColor = env.FORCE_COLOR ? env.FORCE_COLOR !== '0' : !env.NO_COLOR && !!process.stdout.isTTY && env.TERM !== 'dumb';

const paint = (open, close) => text => useColor ? `\x1b[${open}m${text}\x1b[${close}m` : String(text);
export const bold = paint(1, 22);
export const dim = paint(2, 22);
export const red = paint(31, 39);
export const green = paint(32, 39);
export const yellow = paint(33, 39);
export const cyan = paint(36, 39);

/** Old Windows consoles draw neither braille nor block characters. */
const fancy = process.platform !== 'win32' || !!env.WT_SESSION || env.TERM_PROGRAM === 'vscode';
const SPINNER = fancy ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] : ['|', '/', '-', '\\'];
export const ARROW = fancy ? '➜' : '>';
export const CHECK = fancy ? '✓' : 'ok';

/** @param {number} bytes */
export function formatBytes(bytes) {
	if (bytes < 1024 * 1024) {
		return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	}
	const mb = bytes / (1024 * 1024);
	return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** @param {number} ms */
export function formatDuration(ms) {
	if (ms < 1000) {
		return `${Math.round(ms)} ms`;
	}
	if (ms < 60_000) {
		return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
	}
	const minutes = Math.floor(ms / 60_000);
	return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * One line of status on stderr. On a terminal it redraws in place and its last text is replaced by
 * whatever comes next; elsewhere each new text is a plain line (logs stay readable).
 */
export class Status {
	constructor(stream = process.stderr) {
		this.stream = stream;
		this.live = !!stream.isTTY;
		this.text = '';
		this.frame = 0;
		this.timer = undefined;
		this.lastDraw = 0;
	}

	/** A step that is going on: a spinner in front of it. */
	set(text) {
		if (text === this.text) {
			return;
		}
		this.text = text;
		if (!this.live) {
			this.stream.write(`${text}\n`);
			return;
		}
		this.timer ??= setInterval(() => this.draw(), 80);
		this.timer.unref?.();
		this.draw();
	}

	/**
	 * A download: bar, share, size and speed, drawn at most ten times a second.
	 * @param {string} label
	 * @param {number} done
	 * @param {number} total
	 * @param {number} startedAt
	 */
	progress(label, done, total, startedAt) {
		const now = Date.now();
		if (!this.live || (now - this.lastDraw < 100 && done < total)) {
			return;
		}
		this.lastDraw = now;
		const share = total ? Math.min(1, done / total) : 0;
		const width = 24;
		const filled = Math.round(share * width);
		const bar = fancy ? '█'.repeat(filled) + dim('░'.repeat(width - filled)) : '#'.repeat(filled) + '.'.repeat(width - filled);
		const speed = done / Math.max(0.001, (now - startedAt) / 1000);
		this.stopSpinner();
		this.text = `${label}  ${bar}  ${String(Math.round(share * 100)).padStart(3)}%  ${dim(`${formatBytes(done)} / ${formatBytes(total)}  ${formatBytes(speed)}/s`)}`;
		this.write(this.text);
	}

	/** Clears the line (and stops the spinner); `text`, if given, stays printed. */
	done(text) {
		this.stopSpinner();
		if (this.live && this.text) {
			this.stream.write('\r\x1b[2K');
		}
		this.text = '';
		if (text) {
			this.stream.write(`${text}\n`);
		}
	}

	draw() {
		this.write(`${cyan(SPINNER[this.frame++ % SPINNER.length])} ${this.text}`);
	}

	write(line) {
		this.stream.write(`\r\x1b[2K${line}`);
	}

	stopSpinner() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}
}

/**
 * A QR code as terminal lines, two modules per character. Drawn black on white so phone cameras
 * read it on dark terminals too; without colors it is left to the terminal's own.
 * @param {string} text
 */
export async function qrLines(text) {
	const { default: qrcode } = await import('../../../src/vs/workbench/contrib/voltSettings/browser/vendor/qrcode.js');
	const qr = qrcode(0, 'L');
	qr.addData(text);
	qr.make();
	const size = qr.getModuleCount();
	const margin = 2;
	const dark = (row, col) => row >= 0 && col >= 0 && row < size && col < size && qr.isDark(row, col);
	const lines = [];
	for (let row = -margin; row < size + margin; row += 2) {
		let line = '';
		for (let col = -margin; col < size + margin; col++) {
			const top = dark(row, col);
			const bottom = dark(row + 1, col);
			if (useColor) {
				line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
			} else {
				// The terminal's text color is the light part here: draw the light modules.
				line += !top && !bottom ? '█' : !top ? '▀' : !bottom ? '▄' : ' ';
			}
		}
		lines.push(useColor ? `\x1b[30;47m${line}\x1b[0m` : line);
	}
	return lines;
}
