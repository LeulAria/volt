/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the model has seen of each file in this conversation, and at which version. It lets the
 * harness answer a repeated read with a pointer instead of the same content again, refuse to
 * overwrite a file the model never looked at, and hand a compact "files touched" list to
 * compaction so the model does not re-read the repository afterwards.
 */

interface ILedgerEntry {
	version: string | undefined;
	/** 1-based inclusive line ranges read at `version`, with the step they were read in. */
	ranges: { start: number; end: number; step: number }[];
	readStep: number;
	writeStep: number;
	path: string;
}

/** A repeat read is answered with a pointer only while the earlier result is recent enough to still be in view. */
const STUB_WINDOW_STEPS = 6;

export class FileLedger {

	private readonly entries = new Map<string, ILedgerEntry>();
	private step = 0;
	/** Old results may have been cleared from the provider's view; stop pointing at them. */
	private referencesValid = true;

	/** Advance once per model call. */
	nextStep(): number {
		return ++this.step;
	}

	get currentStep(): number {
		return this.step;
	}

	recordRead(key: string, path: string, version: string | undefined, start: number, end: number): void {
		const entry = this.entry(key, path);
		if (entry.version !== version) {
			entry.ranges = [];
			entry.version = version;
		}
		entry.ranges.push({ start, end, step: this.step });
		entry.readStep = this.step;
	}

	recordWrite(key: string, path: string, version: string | undefined): void {
		const entry = this.entry(key, path);
		entry.version = version;
		entry.ranges = [];
		entry.writeStep = this.step;
	}

	/** The model read or wrote this file in this conversation. */
	knows(key: string): boolean {
		const entry = this.entries.get(key);
		return !!entry && (entry.readStep > 0 || entry.writeStep > 0);
	}

	lastKnownVersion(key: string): string | undefined {
		return this.entries.get(key)?.version;
	}

	/**
	 * The step at which the model already read exactly these lines of this version, when that
	 * result is recent enough to still be in its context.
	 */
	coveredRead(key: string, version: string | undefined, start: number, end: number): number | undefined {
		if (!this.referencesValid || version === undefined) {
			return undefined;
		}
		const entry = this.entries.get(key);
		if (!entry || entry.version !== version) {
			return undefined;
		}
		const hit = entry.ranges.find(range => range.start <= start && range.end >= end && this.step - range.step <= STUB_WINDOW_STEPS && range.step < this.step);
		return hit?.step;
	}

	/** After compaction or server-side clearing, earlier results can no longer be pointed at. */
	invalidateReferences(): void {
		this.referencesValid = false;
		for (const entry of this.entries.values()) {
			entry.ranges = [];
		}
	}

	resumeReferences(): void {
		this.referencesValid = true;
	}

	changedFiles(): string[] {
		return [...this.entries.values()].filter(entry => entry.writeStep > 0).map(entry => entry.path);
	}

	/** For compaction: which files were read and changed, most recent first. */
	summary(limit = 40): string | undefined {
		const entries = [...this.entries.values()].sort((a, b) => Math.max(b.readStep, b.writeStep) - Math.max(a.readStep, a.writeStep));
		if (!entries.length) {
			return undefined;
		}
		const changed = entries.filter(entry => entry.writeStep > 0).slice(0, limit).map(entry => entry.path);
		const read = entries.filter(entry => entry.writeStep === 0).slice(0, limit).map(entry => entry.path);
		return [
			changed.length ? `Files changed: ${changed.join(', ')}` : undefined,
			read.length ? `Files read: ${read.join(', ')}` : undefined,
		].filter(Boolean).join('\n');
	}

	private entry(key: string, path: string): ILedgerEntry {
		let entry = this.entries.get(key);
		if (!entry) {
			entry = { version: undefined, ranges: [], readStep: 0, writeStep: 0, path };
			this.entries.set(key, entry);
		}
		entry.path = path;
		return entry;
	}
}
