/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { chatTerminals, errorMessage, isTerminalLive, type ITerminalInfo, type ITerminalStreamState, relativeTime, terminalStatusLabel, tokenizeShell } from '@volt/client-core';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useClient, useCollections } from '../app/client';
import { Dialog } from '../ui/overlays';
import { Icon, IconButton, Spinner } from '../ui/primitives';

/** A chat's terminals, live or finished. */
export function useChatTerminals(chatId: string): readonly ITerminalInfo[] {
	const cols = useCollections(['terminals']);
	return useMemo(() => chatTerminals(cols['terminals'], chatId), [cols, chatId]);
}

/** The header's terminal button: shown while the chat has terminals, with a dot while one runs. */
export function TerminalsButton({ chatId }: { readonly chatId: string }) {
	const terminals = useChatTerminals(chatId);
	const [open, setOpen] = useState(false);
	if (!terminals.length) {
		return null;
	}
	const live = terminals.some(t => isTerminalLive(t.status));
	return (
		<>
			<span className="terminals-btn">
				<IconButton icon="terminal" label={`Terminals (${terminals.length})`} onClick={() => setOpen(true)} />
				{live ? <span className="terminals-dot" /> : null}
			</span>
			<Dialog open={open} onClose={() => setOpen(false)} title="Terminals" width={760}>
				{open ? <TerminalsView terminals={terminals} /> : null}
			</Dialog>
		</>
	);
}

/** The desktop's Terminals tab: a tab per terminal, its command, its live output. Stop and Restart reach the computer. */
function TerminalsView({ terminals }: { readonly terminals: readonly ITerminalInfo[] }) {
	const [selected, setSelected] = useState<string | undefined>();
	const current = terminals.find(t => t.id === selected) ?? terminals[0];
	return (
		<div className="terminals">
			{terminals.length > 1 ? (
				<div className="terminals-tabs" role="tablist">
					{terminals.map(t => (
						<button key={t.id} type="button" role="tab" aria-selected={t.id === current?.id} className={`terminals-tab${t.id === current?.id ? ' active' : ''}`} onClick={() => setSelected(t.id)}>
							<StatusDot info={t} />
							<span>{t.label || t.command}</span>
						</button>
					))}
				</div>
			) : null}
			{current ? <TerminalOutput key={current.id} info={current} /> : null}
		</div>
	);
}

function StatusDot({ info }: { readonly info: ITerminalInfo }) {
	if (isTerminalLive(info.status) && info.status !== 'ready' && info.status !== 'attention') {
		return <Spinner size={10} />;
	}
	return <span className={`terminal-dot ${info.status}`} />;
}

function useStream(id: string): ITerminalStreamState {
	const client = useClient();
	const [state, setState] = useState<ITerminalStreamState>({ text: '', loading: true });
	useEffect(() => {
		const stream = client.openTerminal(id);
		setState(stream.current);
		const off = stream.onChange(setState);
		return () => {
			off();
			stream.dispose();
		};
	}, [client, id]);
	return state;
}

function TerminalOutput({ info }: { readonly info: ITerminalInfo }) {
	const client = useClient();
	const stream = useStream(info.id);
	const scroller = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
	const live = isTerminalLive(info.status) && stream.exitCode === undefined;
	const tokens = useMemo(() => tokenizeShell(info.command), [info.command]);
	useLayoutEffect(() => {
		const el = scroller.current;
		if (el && follow.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [stream.text]);
	const act = (label: string, run: () => Promise<unknown>) => void run().catch(err => client.toast('error', `${label} failed: ${errorMessage(err)}`));
	return (
		<div className="terminal-view">
			<div className="terminal-head">
				<StatusDot info={info} />
				<span className={`terminal-status ${info.status}`}>{terminalStatusLabel(info)}</span>
				<span className="terminal-when">· {relativeTime(info.endedAt ?? info.startedAt)}</span>
				<span className="terminal-spacer" />
				{info.urls.map(url => <a key={url} className="terminal-url" href={url} target="_blank" rel="noreferrer"><Icon name="globe" size={12} />{url.replace(/^https?:\/\//, '')}</a>)}
				{live ? <button type="button" className="approval-btn secondary" onClick={() => act('Stop', () => client.stopTerminal(info.id))}>Stop</button>
					: info.kind === 'terminal' ? <button type="button" className="approval-btn secondary" onClick={() => act('Restart', () => client.restartTerminal(info.id))}>Restart</button> : null}
				<IconButton icon="copy" label="Copy output" size={14} onClick={() => void navigator.clipboard?.writeText(stream.text)} />
			</div>
			<code className="tr-terminal-command terminal-command"><span className="prompt">$ </span>{tokens.map((t, i) => t.kind === 'text' ? <Fragment key={i}>{t.value}</Fragment> : <span key={i} className={t.kind}>{t.value}</span>)}</code>
			<div className="terminal-output" ref={scroller} onScroll={e => {
				const el = e.currentTarget;
				follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
			}}>
				{stream.loading && !stream.text ? <Spinner size={13} /> : <pre>{stream.gone ? 'This terminal\'s output is no longer kept.' : stream.text || (live ? 'Waiting for output…' : 'No output.')}</pre>}
				{stream.exitCode !== undefined ? <div className={`terminal-exit${stream.exitCode ? ' failed' : ''}`}>[exited{stream.exitCode !== null ? ` with ${stream.exitCode}` : ''}]</div> : null}
			</div>
			{info.error && !live ? <div className="terminal-error">{info.error}</div> : null}
		</div>
	);
}
