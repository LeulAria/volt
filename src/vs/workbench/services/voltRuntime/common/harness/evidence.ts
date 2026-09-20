/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { pickString } from '../tools/args.js';
import { IToolCall, IToolResult } from '../tools/tool.js';
import { truncateHeadTail } from './toolResult.js';
import { EvidenceKind } from './taskIntel.js';

/**
 * The evidence store. Tool results are transient - they are fed to the model once and then
 * compacted away - but the *facts* they established have to outlive the transcript, because the
 * completion check runs at the end of a run and has to answer "did this actually work?" against
 * something more durable than the model's own summary.
 *
 * The rule that makes this worth building: **evidence expires when the workspace changes.** A
 * test run that passed before the last edit proves nothing about the code as it stands now.
 * Everything here is ordered by step so `provenSince` can enforce that.
 */

export type EvidenceTag =
	| 'observation'   // a file was read, a search ran - the run learned something
	| 'mutation'      // the workspace changed
	| 'verification'  // a project check ran and reported pass or fail
	| 'external';     // a page was fetched, a browser snapshot taken

export interface IEvidence {
	readonly id: string;
	readonly step: number;
	readonly tag: EvidenceTag;
	readonly tool: string;
	/** What it was about: a path, a command, a URL, a pattern. */
	readonly subject: string;
	/** Already truncated. Never the full tool output. */
	readonly detail: string;
	readonly ok: boolean;
	/** Set on verification evidence: which criterion kind this run proves or disproves. */
	readonly proves?: EvidenceKind;
	/** Identical evidence recorded more than once collapses, and this counts the occurrences. */
	readonly occurrences: number;
}

/** Tells the store which shell commands are project checks rather than arbitrary commands. */
export interface IEvidenceClassifier {
	(command: string): EvidenceKind | undefined;
}

const DETAIL_CHARS = 600;
const DIGEST_LIMIT = 24;

export class EvidenceStore {

	private readonly items: IEvidence[] = [];
	private readonly byKey = new Map<string, IEvidence>();
	private seq = 0;

	constructor(private readonly classifier: IEvidenceClassifier = () => undefined) { }

	/**
	 * Normalizes one step's results into evidence. Results are matched to their calls by id so
	 * the subject can come from the arguments - a `read_file` result on its own does not say
	 * which file it read.
	 */
	record(step: number, calls: readonly IToolCall[], results: readonly IToolResult[]): IEvidence[] {
		const argsById = new Map(calls.map(call => [call.id, call.args]));
		const recorded: IEvidence[] = [];

		for (const result of results) {
			const args = argsById.get(result.callId);
			const subject = subjectOf(result.name, args) || result.name;
			const command = pickString(args, 'command', 'cmd');
			const proves = command ? this.classifier(command) : undefined;
			const tag = tagOf(result, proves);

			const key = `${tag}\0${result.name}\0${subject}\0${result.isError ? 'err' : 'ok'}`;
			const existing = this.byKey.get(key);
			if (existing && existing.step === step) {
				// The same call twice in one step is one fact, not two.
				const merged: IEvidence = { ...existing, occurrences: existing.occurrences + 1 };
				this.replace(existing, merged);
				recorded.push(merged);
				continue;
			}

			const evidence: IEvidence = {
				id: `e${++this.seq}`,
				step,
				tag,
				tool: result.name,
				subject,
				detail: truncateHeadTail(result.text ?? '', DETAIL_CHARS).text,
				ok: !result.isError,
				...(proves ? { proves } : {}),
				occurrences: 1,
			};
			this.items.push(evidence);
			this.byKey.set(key, evidence);
			recorded.push(evidence);
		}
		return recorded;
	}

	/** Records a mutation the loop learned about from a `file.change` event rather than a tool. */
	recordFileChange(step: number, path: string, kind: 'edit' | 'create' | 'delete'): IEvidence {
		const evidence: IEvidence = {
			id: `e${++this.seq}`,
			step,
			tag: 'mutation',
			tool: kind === 'delete' ? 'delete_file' : kind === 'create' ? 'write_file' : 'edit_file',
			subject: path,
			detail: `${kind} ${path}`,
			ok: true,
			occurrences: 1,
		};
		this.items.push(evidence);
		return evidence;
	}

	all(): readonly IEvidence[] {
		return this.items;
	}

	/** Distinct paths the run changed, in the order they were first touched. */
	changedFiles(): string[] {
		const seen = new Set<string>();
		for (const item of this.items) {
			if (item.tag === 'mutation' && item.ok) {
				seen.add(item.subject);
			}
		}
		return [...seen];
	}

	commands(): IEvidence[] {
		return this.items.filter(item => item.tool === 'shell');
	}

	/** -1 when nothing has been changed yet, so `provenSince` accepts evidence from step 0. */
	lastMutationStep(): number {
		let last = -1;
		for (const item of this.items) {
			if (item.tag === 'mutation' && item.ok) {
				last = Math.max(last, item.step);
			}
		}
		return last;
	}

	/**
	 * The most recent verification of `kind` that ran after the last change to the workspace.
	 * Anything older is stale by definition and is not returned, which is what stops a run from
	 * claiming "tests pass" on the strength of a run from before its own edits.
	 */
	provenSince(kind: EvidenceKind): IEvidence | undefined {
		const floor = this.lastMutationStep();
		let best: IEvidence | undefined;
		for (const item of this.items) {
			if (item.tag === 'verification' && item.proves === kind && item.step >= floor) {
				best = item;
			}
		}
		return best;
	}

	/**
	 * The current state of every check the run has performed since the last change: one entry
	 * per kind, the most recent run winning. This is the run's verification status, and an empty
	 * result after an edit means nothing has been checked at all.
	 */
	verifiedSince(): IEvidence[] {
		const floor = this.lastMutationStep();
		const latest = new Map<EvidenceKind, IEvidence>();
		for (const item of this.items) {
			if (item.tag === 'verification' && item.proves && item.step >= floor) {
				latest.set(item.proves, item);
			}
		}
		return [...latest.values()];
	}

	/** Verification evidence of any kind that is currently failing. */
	failing(): IEvidence[] {
		return this.verifiedSince().filter(item => !item.ok);
	}

	/**
	 * A compact, model-readable account of what the run established. Used when the context is
	 * compacted or reset: the transcript goes, this stays, so the model does not re-read files it
	 * already read.
	 */
	/** A successful search or fetch. Used to prove a `lookup` criterion. */
	lookedUp(): boolean {
		return this.items.some(item => item.ok && (item.tag === 'external' || item.tool === 'web_search' || item.tool === 'web_fetch'));
	}

	digest(limit = DIGEST_LIMIT): string {
		if (!this.items.length) {
			return '';
		}
		const sections: string[] = [];
		const changed = this.changedFiles();
		if (changed.length) {
			sections.push(`Changed: ${changed.slice(0, limit).join(', ')}${changed.length > limit ? ` (+${changed.length - limit} more)` : ''}`);
		}

		const verifications = this.items.filter(item => item.tag === 'verification');
		if (verifications.length) {
			const lines = dedupeTail(verifications, limit).map(item => `- ${item.ok ? 'passed' : 'FAILED'}: ${item.subject}${item.ok ? '' : ` - ${firstLine(item.detail)}`}`);
			sections.push(['Checks run:', ...lines].join('\n'));
		}

		const observed = this.items.filter(item => item.tag === 'observation' && item.ok);
		if (observed.length) {
			const subjects = [...new Set(observed.map(item => item.subject))];
			sections.push(`Already inspected (do not re-read): ${subjects.slice(0, limit).join(', ')}${subjects.length > limit ? ` (+${subjects.length - limit} more)` : ''}`);
		}

		const external = this.items.filter(item => item.tag === 'external' && item.ok);
		if (external.length) {
			const subjects = [...new Set(external.map(item => item.subject))];
			sections.push(`Looked up: ${subjects.slice(0, limit).join(', ')}${subjects.length > limit ? ` (+${subjects.length - limit} more)` : ''}`);
		}

		const failures = this.items.filter(item => !item.ok && item.tag !== 'verification');
		if (failures.length) {
			const lines = dedupeTail(failures, 6).map(item => `- ${item.tool} ${item.subject}: ${firstLine(item.detail)}`);
			sections.push(['Failed attempts (do not repeat):', ...lines].join('\n'));
		}

		return sections.join('\n\n');
	}

	private replace(previous: IEvidence, next: IEvidence): void {
		const index = this.items.indexOf(previous);
		if (index >= 0) {
			this.items[index] = next;
		}
		for (const [key, value] of this.byKey) {
			if (value === previous) {
				this.byKey.set(key, next);
			}
		}
	}
}

// --- normalization ------------------------------------------------------------------------

function tagOf(result: IToolResult, proves: EvidenceKind | undefined): EvidenceTag {
	if (proves) {
		return 'verification';
	}
	switch (result.kind) {
		case 'edit': return 'mutation';
		case 'fetch':
		case 'browser': return 'external';
		case 'read':
		case 'search': return 'observation';
		case 'execute': return 'observation';
		default: return 'observation';
	}
}

function subjectOf(tool: string, args: unknown): string {
	return pickString(args, 'path', 'file', 'file_path', 'directory', 'command', 'cmd', 'url', 'pattern', 'query', 'q') ?? tool;
}

/** The most recent `limit` entries, with earlier duplicates of the same subject dropped. */
function dedupeTail(items: readonly IEvidence[], limit: number): IEvidence[] {
	const latest = new Map<string, IEvidence>();
	for (const item of items) {
		latest.set(item.subject, item);
	}
	return [...latest.values()].slice(-limit);
}

function firstLine(text: string): string {
	return (text.split('\n').find(line => line.trim()) ?? '').trim().slice(0, 160);
}
