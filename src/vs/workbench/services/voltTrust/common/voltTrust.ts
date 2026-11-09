/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IUserGestureToken, SubjectKey } from '../../../../platform/voltSandbox/common/principals.js';
import { GestureTokenRegistry, ITrustChange, ITrustCommitResult, ITrustHistoryEntry, ITrustState, PromptBudget, TrustGrantDraft } from '../../../../platform/voltSandbox/common/trust.js';
import type { IVoltPromptBudget, IVoltSandboxApproval } from '../../../../platform/voltStdio/common/voltStdio.js';

export const IVoltTrustService = createDecorator<IVoltTrustService>('voltTrustService');

/** Why a change that widens access was recorded without a prompt's gesture. */
export type TrustRecordOrigin =
	/** Answers the user gave before the grant store (the extension pages' consents), moved once. */
	| 'migration'
	/** The user's own toggle on an extension's Features page (core UI with its own consent). */
	| 'extension-page'
	/** "Allow for This Chat" on a transcript approval card (a trusted click only). */
	| 'approval-card'
	/** The install sheet's Allow (its own gesture-armed button). */
	| 'install-sheet'
	/** "Let It Ask Again" on the Access page: refusals forgotten, nothing granted. */
	| 'access-page';

/**
 * The window's side of the grant store (spec P4): a cached copy of `~/.volt/trust/grants.json`
 * from the execution host, the prompt budget of the window's own prompts (G.12) and the gesture
 * tokens its prompts mint (G.7). Every widening from a prompt carries a gesture token this window
 * minted for the subject; narrowing (revoke, refuse, drop) never needs one.
 */
export interface IVoltTrustService {
	readonly _serviceBrand: undefined;

	/** The last state read from the execution host. */
	readonly state: ITrustState;
	readonly onDidChange: Event<ITrustState>;
	/** The first read finished (or failed: the state stays empty). */
	readonly whenReady: Promise<void>;
	refresh(): Promise<ITrustState>;

	/** The window's prompts' budget (G.12); network denials keep theirs in the broker. */
	readonly budget: PromptBudget;
	/** Minted by Volt-owned controls for real input events (gestureTokens.ts). */
	readonly gestures: GestureTokenRegistry;

	/** A prompt's answer: refused unless `gesture` is a live token minted for `subject`. */
	grant(subject: SubjectKey, drafts: readonly TrustGrantDraft[], gesture: IUserGestureToken | undefined): Promise<ITrustCommitResult>;
	/** Revocations, refusals and dropped subjects: narrowing only. */
	narrow(change: Pick<ITrustChange, 'revoke' | 'refuse' | 'dropSubjects' | 'touch'>): Promise<ITrustCommitResult>;
	/** A widening that is not a prompt's (see {@link TrustRecordOrigin}). */
	record(change: ITrustChange, origin: TrustRecordOrigin): Promise<ITrustCommitResult>;

	/** "Allow" / "Allow for This Chat" on a network denial card: the broker's approve, after the gesture. */
	approveDenial(chatId: string, processId: string, denialId: string, epoch: number, scope: 'run' | 'chat', gesture: IUserGestureToken | undefined): Promise<IVoltSandboxApproval>;
	/** "Allow for This Chat": by the broker's record of the chat's denial; needs no live run of it. */
	approveChatDenial(chatId: string, denialId: string, epoch: number, gesture: IUserGestureToken | undefined): Promise<IVoltSandboxApproval>;
	/** "Skip" on a network denial card: counts toward the broker's refusals. */
	refuseDenial(processId: string, denialId: string): Promise<void>;

	history(limit: number, subject?: SubjectKey): Promise<readonly ITrustHistoryEntry[]>;
	/** The broker's open routes' budgets. */
	brokerBudgets(): Promise<readonly IVoltPromptBudget[]>;
	/** The Access page was opened: prompts may be offered again, here and in the broker (G.12). */
	resetBudgets(subject?: SubjectKey): Promise<void>;
}
