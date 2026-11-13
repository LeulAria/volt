/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IUserGestureToken, SubjectKey, chatSubject } from '../../../../platform/voltSandbox/common/principals.js';
import { EMPTY_TRUST_STATE, GestureTokenRegistry, ITrustChange, ITrustCommitResult, ITrustHistoryEntry, ITrustState, PromptBudget, TrustGrantDraft } from '../../../../platform/voltSandbox/common/trust.js';
import { IVoltPromptBudget, IVoltSandboxApproval, IVoltStdioService } from '../../../../platform/voltStdio/common/voltStdio.js';
import { IVoltTrustService, TrustRecordOrigin } from '../common/voltTrust.js';

export class VoltTrustService extends Disposable implements IVoltTrustService {

	declare readonly _serviceBrand: undefined;

	private _state: ITrustState = EMPTY_TRUST_STATE;
	private readonly _onDidChange = this._register(new Emitter<ITrustState>());
	readonly onDidChange = this._onDidChange.event;
	readonly whenReady: Promise<void>;
	readonly budget: PromptBudget;
	readonly gestures: GestureTokenRegistry;
	private reading: Promise<ITrustState> | undefined;

	constructor(
		@IVoltStdioService private readonly stdio: IVoltStdioService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.budget = new PromptBudget();
		this.gestures = new GestureTokenRegistry(Date.now, generateUuid);
		if (stdio.onDidChangeTrust) {
			this._register(stdio.onDidChangeTrust(() => void this.refresh()));
		}
		this.whenReady = this.refresh().then(() => undefined, () => undefined);
	}

	get state(): ITrustState {
		return this._state;
	}

	refresh(): Promise<ITrustState> {
		this.reading ??= (async () => {
			try {
				const next = this.stdio.trustState ? await this.stdio.trustState() : EMPTY_TRUST_STATE;
				if (next.epoch !== this._state.epoch || next.grants.length !== this._state.grants.length || next.refusals.length !== this._state.refusals.length || next.status !== this._state.status) {
					this._state = next;
					this._onDidChange.fire(next);
				}
			} catch (err) {
				this.logService.warn('[volt-trust] could not read the grant store', err);
			} finally {
				this.reading = undefined;
			}
			return this._state;
		})();
		return this.reading;
	}

	async grant(subject: SubjectKey, drafts: readonly TrustGrantDraft[], gesture: IUserGestureToken | undefined): Promise<ITrustCommitResult> {
		// G.7: a prompt's answer counts only with a token this window minted for a real input event on its control.
		if (!this.gestures.consume(gesture, subject)) {
			throw new Error('Volt did not record this permission: it was not given by a click or key press on Volt\'s own prompt.');
		}
		if (drafts.some(draft => draft.subject !== subject)) {
			throw new Error('a prompt grants only to the subject it asked about');
		}
		return this.commit({ add: drafts, unrefuse: drafts.map(draft => ({ subject: draft.subject, capability: draft.capability })) });
	}

	narrow(change: Pick<ITrustChange, 'revoke' | 'refuse' | 'dropSubjects' | 'touch'>): Promise<ITrustCommitResult> {
		return this.commit({ ...change.revoke ? { revoke: change.revoke } : {}, ...change.refuse ? { refuse: change.refuse } : {}, ...change.dropSubjects ? { dropSubjects: change.dropSubjects } : {}, ...change.touch ? { touch: change.touch } : {} });
	}

	record(change: ITrustChange, origin: TrustRecordOrigin): Promise<ITrustCommitResult> {
		this.logService.info(`[volt-trust] recording ${change.add?.length ?? 0} grant(s) from ${origin}`);
		return this.commit(change);
	}

	async approveDenial(chatId: string, processId: string, denialId: string, epoch: number, scope: 'run' | 'chat', gesture: IUserGestureToken | undefined): Promise<IVoltSandboxApproval> {
		if (!this.gestures.consume(gesture, chatSubject(chatId))) {
			return { ok: false, epoch, reason: 'not allowed: the click did not come from Volt\'s own card' };
		}
		if (!this.stdio.approveSandboxDenial) {
			return { ok: false, epoch, reason: 'this execution host has no network broker' };
		}
		const result = await this.stdio.approveSandboxDenial(processId, denialId, epoch, scope);
		if (result.ok) {
			void this.refresh();
		}
		return result;
	}

	async approveChatDenial(chatId: string, denialId: string, epoch: number, gesture: IUserGestureToken | undefined): Promise<IVoltSandboxApproval> {
		if (!this.gestures.consume(gesture, chatSubject(chatId))) {
			return { ok: false, epoch, reason: 'not allowed: the click did not come from Volt\'s own card' };
		}
		if (!this.stdio.approveChatDenial) {
			return { ok: false, epoch, reason: 'this execution host has no network broker' };
		}
		const result = await this.stdio.approveChatDenial(chatId, denialId, epoch);
		if (result.ok) {
			void this.refresh();
		}
		return result;
	}

	async refuseDenial(processId: string, denialId: string): Promise<void> {
		await this.stdio.refuseSandboxDenial?.(processId, denialId).catch(() => false);
	}

	async history(limit: number, subject?: SubjectKey): Promise<readonly ITrustHistoryEntry[]> {
		return this.stdio.trustHistory ? this.stdio.trustHistory(limit, subject).catch(() => []) : [];
	}

	async brokerBudgets(): Promise<readonly IVoltPromptBudget[]> {
		return this.stdio.trustPromptBudgets ? this.stdio.trustPromptBudgets().catch(() => []) : [];
	}

	async resetBudgets(subject?: SubjectKey): Promise<void> {
		this.budget.reset(subject);
		await this.stdio.resetPromptBudgets?.(subject).catch(() => undefined);
	}

	private async commit(change: ITrustChange): Promise<ITrustCommitResult> {
		if (!this.stdio.trustCommit) {
			throw new Error('this execution host has no grant store');
		}
		const result = await this.stdio.trustCommit(change);
		// A read that started before the commit may not have seen it.
		await this.reading;
		await this.refresh();
		return result;
	}
}

registerSingleton(IVoltTrustService, VoltTrustService, InstantiationType.Delayed);
