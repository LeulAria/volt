/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { VoltLane } from '../../common/harness/lanes.js';
import { IRunReceipt } from '../../common/harness/proofOfDone.js';
import { EvidenceKind } from '../../common/harness/taskIntel.js';
import { VoltMode } from '../../common/modes.js';

/**
 * Every gated run as an eval case, one JSON line each: the request as typed, where it ran, the
 * contract it was held to, and how its receipt came out. A replay sends the same request in the
 * same project and holds it to the same contract, so "did this change make long runs better"
 * becomes a pass rate instead of a feeling. The newest cases are kept, up to a cap; the file is
 * rewritten atomically (the user-data provider has no reliable append), one write per run's end.
 */

export interface IProofCase {
	readonly v: 1;
	readonly at: number;
	readonly sessionId: string;
	readonly runId: string;
	/** The folder the run worked in. */
	readonly project?: string;
	readonly request: string;
	readonly mode: VoltMode;
	readonly model: string;
	readonly lane: VoltLane;
	readonly contract: readonly { readonly text: string; readonly kind: EvidenceKind; readonly command?: string }[];
	readonly verdict: IRunReceipt['verdict'];
	readonly lines: readonly { readonly text: string; readonly kind: EvidenceKind; readonly status: IRunReceipt['lines'][number]['status'] }[];
	readonly review?: 'pass' | 'fail';
	readonly sentBack: number;
	readonly changed: number;
	readonly open: number;
}

export type IProofCaseInput = Omit<IProofCase, 'v' | 'at' | 'verdict' | 'lines' | 'review' | 'sentBack' | 'changed' | 'open'> & { readonly receipt: IRunReceipt };

const MAX_CASES = 500;
const REQUEST_CHARS = 8_000;

export class ProofCaseJournal {

	private writing: Promise<void> = Promise.resolve();

	constructor(
		private readonly uri: URI,
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
	) { }

	record(input: IProofCaseInput): void {
		const { receipt, ...rest } = input;
		const entry: IProofCase = {
			v: 1,
			at: Date.now(),
			...rest,
			request: rest.request.length > REQUEST_CHARS ? rest.request.slice(0, REQUEST_CHARS) : rest.request,
			verdict: receipt.verdict,
			lines: receipt.lines.map(line => ({ text: line.text, kind: line.kind, status: line.status })),
			...(receipt.review ? { review: receipt.review.verdict } : {}),
			sentBack: receipt.sentBack,
			changed: receipt.changedCount,
			open: receipt.open.length,
		};
		this.writing = this.writing.then(async () => {
			const lines = await this.lines();
			lines.push(JSON.stringify(entry));
			await this.fileService.writeFile(this.uri, VSBuffer.fromString(`${lines.slice(-MAX_CASES).join('\n')}\n`), { atomic: { postfix: '.vsctmp' } });
		}).catch(err => this.logService.warn('[volt] could not save the proof case', err));
	}

	/** The kept cases, oldest first. Lines that do not parse are skipped. */
	async read(): Promise<IProofCase[]> {
		await this.writing;
		const cases: IProofCase[] = [];
		for (const line of await this.lines()) {
			try {
				const value = JSON.parse(line) as IProofCase;
				if (value?.v === 1) {
					cases.push(value);
				}
			} catch {
				// A torn line from a crash mid-write of an older version: skip it.
			}
		}
		return cases;
	}

	private lines(): Promise<string[]> {
		return this.fileService.readFile(this.uri).then(content => content.value.toString().split('\n').filter(Boolean), () => []);
	}
}
