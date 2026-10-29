/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	activeRuns, archiveRunGroup, canPickRun, errorMessage, formatRunCost, formatRunTime, formatRunTokens, type IRunGroup, type IRunGroupRun, isRunLive, pickRunWinner, PROVIDER_COLORS,
	projectRecords, refreshRunStats, retryRunSetup, runGroupBase, runGroupById, runGroupSummary, runStatusLabel, runStatusOf, runStatusTone, runWorkMs, type RunWinnerAction, stopRunGroup,
	winnerActionDetail, winnerActionLabel
} from '@volt/client-core';
import { useEffect, useMemo, useState } from 'react';
import { useClient, useCollections, useNow } from '../app/client';
import { chatPath, navigate } from '../app/router';
import { Dialog } from '../ui/overlays';
import { Button, EmptyState, Icon, IconButton, StatusIcon } from '../ui/primitives';
import '../styles/compare.css';

const GROUP_COLLECTIONS = ['runGroups', 'projects'];

function familyColor(family: string): string {
	return (PROVIDER_COLORS as Record<string, string>)[family] ?? PROVIDER_COLORS.generic;
}

function groupTone(group: IRunGroup): 'question' | 'working' | 'failed' | 'stopped' | 'unread' {
	switch (group.rollup?.status) {
		case 'needsInput': return 'question';
		case 'running': return 'working';
		case 'failed': return 'failed';
		case 'stopped': return 'stopped';
		default: return 'unread';
	}
}

/**
 * A model comparison, as the desktop's compare view: one column per run with its status, time,
 * changes against the base, tokens, cost and latest reply; open each run's chat, stop a run or all
 * of them, and pick the winner (merge, check out its branch, or open a pull request).
 */
export function CompareView({ groupId }: { readonly groupId: string }) {
	const client = useClient();
	const cols = useCollections(GROUP_COLLECTIONS);
	const group = runGroupById(cols, groupId);
	const project = useMemo(() => group?.projectId ? projectRecords(cols).find(pr => pr.id === group.projectId) : undefined, [cols, group?.projectId]);
	const live = !!group?.rollup?.live;
	const now = useNow(1000, live) || Date.now();
	const [winner, setWinner] = useState<IRunGroupRun | undefined>();
	const [refreshing, setRefreshing] = useState(false);

	useEffect(() => {
		void refreshRunStats(client, groupId).catch(() => undefined);
	}, [client, groupId]);

	if (!group) {
		return <div className="compare"><EmptyState icon="layers" title="This comparison no longer exists." /></div>;
	}
	const runs = activeRuns(group);
	const winnerRun = group.winner ? group.runs.find(run => run.id === group.winner!.runId) : undefined;

	return (
		<div className="compare">
			<header className="compare-header">
				<IconButton className="back-btn" icon="chevronLeft" label="Back" onClick={() => window.history.length > 1 ? window.history.back() : navigate('/')} />
				<div className="compare-heading">
					<div className="compare-title" title={group.prompt.text}>{group.title}</div>
					<div className="compare-sub">
						<span className={`status-text status-${groupTone(group)}`}><StatusIcon status={groupTone(group)} size={12} />{runGroupSummary(group)}</span>
						<span className="mono"><Icon name="branch" size={12} />from {runGroupBase(group)}</span>
						{project ? <span><Icon name="folder" size={12} />{project.displayName}</span> : null}
					</div>
				</div>
				{live ? <Button size="sm" variant="danger" icon="stop" onClick={() => void stopRunGroup(client, groupId).catch(err => client.toast('error', errorMessage(err)))}>Stop all</Button> : null}
				<IconButton icon="refresh" label="Refresh changes" disabled={refreshing} onClick={() => {
					setRefreshing(true);
					void refreshRunStats(client, groupId).catch(() => undefined).finally(() => setRefreshing(false));
				}} />
				{!group.archived ? <IconButton icon="archive" label="Archive this comparison" onClick={() => {
					void archiveRunGroup(client, groupId).then(() => client.toast('success', 'Comparison archived'), err => client.toast('error', errorMessage(err)));
				}} /> : null}
			</header>
			{winnerRun && group.winner ? (
				<div className="compare-winner"><Icon name="checkCircle" size={15} />{winnerRun.model.label} won · {winnerActionLabel(group.winner.action, group.base.ref)}</div>
			) : null}
			<div className="compare-runs" style={{ ['--runs' as string]: String(Math.max(1, runs.length)) }}>
				{runs.map(run => <RunColumn key={run.id} group={group} run={run} now={now} onPick={() => setWinner(run)} />)}
			</div>
			{group.runs.length > runs.length ? <div className="compare-note">{group.runs.length - runs.length} other run{group.runs.length - runs.length === 1 ? ' was' : 's were'} archived.</div> : null}
			<WinnerDialog group={group} run={winner} onClose={() => setWinner(undefined)} />
		</div>
	);
}

function RunColumn({ group, run, now, onPick }: { readonly group: IRunGroup; readonly run: IRunGroupRun; readonly now: number; readonly onPick: () => void }) {
	const client = useClient();
	const status = runStatusOf(group, run.id);
	const tone = runStatusTone(status);
	const isWinner = group.winner?.runId === run.id;
	const live = isRunLive(status) || status === 'needsInput';
	const failedStep = run.setup.steps.find(step => step.state === 'failed');
	const [busy, setBusy] = useState<'stop' | 'retry' | undefined>();
	const stats = run.stats;
	return (
		<section className={`compare-run${isWinner ? ' winner' : ''}`}>
			<div className="run-head">
				<span className="run-dot" style={{ background: familyColor(run.model.family) }} />
				<span className="run-model">{run.model.label}</span>
				{isWinner ? <span className="tag run-winner-tag">Winner</span> : null}
			</div>
			<div className={`run-status status-text status-${tone}`}><StatusIcon status={tone} size={12} />{runStatusLabel(status, run, now)}</div>
			<div className="run-branch mono" title={run.worktreePath ?? run.branch}><Icon name="branch" size={12} />{run.branch}</div>
			<dl className="run-metrics">
				<div><dt>Time</dt><dd>{run.workMs || run.activeSince ? formatRunTime(runWorkMs(run, now)) : '—'}</dd></div>
				<div><dt>Files</dt><dd>{stats ? stats.files : '—'}</dd></div>
				<div><dt>Lines</dt><dd>{stats ? <><span className="add">+{stats.additions}</span> <span className="del">{'−'}{stats.deletions}</span></> : '—'}</dd></div>
				<div><dt>Tokens</dt><dd>{formatRunTokens(run)}</dd></div>
				<div><dt>Cost</dt><dd>{formatRunCost(run)}</dd></div>
			</dl>
			{status === 'setupFailed' && run.setup.error ? (
				<div className="run-error">
					<div>{run.setup.error}</div>
					{failedStep?.tail ? <pre className="mono">{failedStep.tail}</pre> : null}
				</div>
			) : (
				<div className={`run-reply${stats?.lastMessage ? '' : ' empty'}`}>{stats?.lastMessage ?? (live ? 'No reply yet.' : 'No reply.')}</div>
			)}
			<div className="run-actions">
				<Button size="sm" icon="message" onClick={() => navigate(chatPath(run.id))}>Open chat</Button>
				{live ? <Button size="sm" variant="danger" icon="stop" busy={busy === 'stop'} onClick={() => {
					setBusy('stop');
					void stopRunGroup(client, group.id, run.id).catch(err => client.toast('error', errorMessage(err))).finally(() => setBusy(undefined));
				}}>Stop</Button> : null}
				{status === 'setupFailed' ? <Button size="sm" icon="refresh" busy={busy === 'retry'} onClick={() => {
					setBusy('retry');
					void retryRunSetup(client, group.id, run.id).catch(err => client.toast('error', errorMessage(err))).finally(() => setBusy(undefined));
				}}>Retry</Button> : null}
				<span className="spacer" />
				{!group.winner ? <Button size="sm" variant="primary" icon="checkCircle" disabled={!canPickRun(group, run)} title={canPickRun(group, run) ? undefined : 'Available once this run stops working'} onClick={onPick}>Pick winner</Button> : null}
			</div>
		</section>
	);
}

function WinnerDialog({ group, run, onClose }: { readonly group: IRunGroup; readonly run: IRunGroupRun | undefined; readonly onClose: () => void }) {
	const client = useClient();
	const actions: readonly RunWinnerAction[] = group.base.ref ? ['merge', 'checkout', 'pr'] : ['checkout', 'pr'];
	const [action, setAction] = useState<RunWinnerAction>(actions[0]);
	const [removeOthers, setRemoveOthers] = useState(false);
	const [busy, setBusy] = useState(false);
	const others = run ? group.runs.filter(other => other.id !== run.id && !other.discarded && other.worktreePath && !other.worktreeRemoved).length : 0;
	const confirm = async () => {
		if (!run) {
			return;
		}
		setBusy(true);
		try {
			const result = await pickRunWinner(client, group.id, run.id, action, removeOthers);
			if (!result.ok) {
				client.toast('error', result.error ?? 'Could not pick the winner.');
				return;
			}
			onClose();
			if (result.kept?.length) {
				client.toast('info', `Kept ${result.kept.length} worktree${result.kept.length === 1 ? '' : 's'} that could not be removed.`);
			}
			const handoff = result.pullRequest;
			if (handoff?.worktreePath) {
				// The server committed the winner on its branch; the pull request is opened from its worktree.
				const pr = await client.createPullRequest(handoff.worktreePath, {
					title: group.title,
					body: `${group.prompt.text}\n\nPicked from ${group.runs.length} models in Volt (${run.model.label} won).`,
					...(handoff.base ? { base: handoff.base } : {}),
				});
				client.toast('success', `Opened pull request #${pr.number}`);
				window.open(pr.url, '_blank', 'noopener');
			} else {
				client.toast('success', `${run.model.label} won · ${winnerActionLabel(action, group.base.ref)}`);
			}
		} catch (err) {
			client.toast('error', errorMessage(err));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open={!!run} onClose={onClose} title={run ? `Pick ${run.model.label} as the winner?` : 'Pick winner'} width={440} footer={<>
			<Button variant="ghost" onClick={onClose}>Cancel</Button>
			<Button variant="primary" busy={busy} onClick={() => void confirm()}>Pick winner</Button>
		</>}>
			<div className="winner-actions" role="radiogroup">
				{actions.map(id => (
					<button key={id} type="button" role="radio" aria-checked={action === id} className={`winner-action${action === id ? ' checked' : ''}`} onClick={() => setAction(id)}>
						<Icon name={id === 'merge' ? 'branch' : id === 'checkout' ? 'folder' : 'pullRequest'} size={15} />
						<span>{winnerActionLabel(id, group.base.ref)}</span>
						{action === id ? <Icon name="check" size={14} className="winner-check" /> : null}
					</button>
				))}
			</div>
			{run ? <div className="dialog-text">{winnerActionDetail(action, group, run)}</div> : null}
			{others ? (
				<label className="winner-remove">
					<input type="checkbox" checked={removeOthers} onChange={e => setRemoveOthers(e.target.checked)} />
					Also delete their worktrees and branches ({others})
				</label>
			) : null}
		</Dialog>
	);
}
