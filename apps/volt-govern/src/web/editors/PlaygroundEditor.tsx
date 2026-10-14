/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState } from 'react';
import type { IPlaygroundModel, IPlaygroundRequest } from '../../shared/api';
import { api } from '../lib/api';
import { keys, useOrg } from '../lib/data';
import { formatCount, formatMs } from '../lib/format';
import { invalidate, useQuery } from '../lib/query';
import { Button, Callout, EmptyState, Field, NumberField, Select, TextArea, Toggle } from '../ui/controls';
import { Codicon } from '../ui/icons';
import { Loading, Page } from '../ui/layout';
import { open } from '../workbench/commands';

interface ITurn {
	readonly role: 'user' | 'assistant' | 'error';
	readonly content: string;
	readonly streaming?: boolean;
}

interface IResult {
	readonly model: string;
	readonly status: number;
	readonly latencyMs: number;
	readonly firstTokenMs?: number;
	readonly input?: number;
	readonly output?: number;
	readonly stopReason?: string;
}

/** The parts of Anthropic and OpenAI responses (whole or streamed) the playground reads. */
interface IWireEvent {
	readonly type?: string;
	readonly message?: { readonly usage?: { readonly input_tokens?: number } };
	readonly delta?: { readonly type?: string; readonly text?: string; readonly stop_reason?: string };
	readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number; readonly prompt_tokens?: number; readonly completion_tokens?: number };
	readonly choices?: readonly { readonly delta?: { readonly content?: string }; readonly message?: { readonly content?: string }; readonly finish_reason?: string | null }[];
	readonly content?: readonly { readonly type: string; readonly text?: string }[];
	readonly stop_reason?: string;
}

/** Server-sent events from a fetch body: `{ event, data }` per blank-line separated block. */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ readonly event?: string; readonly data: string }> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	for (;;) {
		const { value, done } = await reader.read();
		if (done) {
			return;
		}
		buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
		let end: number;
		while ((end = buffer.indexOf('\n\n')) >= 0) {
			const block = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			let event: string | undefined;
			const data: string[] = [];
			for (const line of block.split('\n')) {
				if (line.startsWith('event:')) {
					event = line.slice(6).trim();
				} else if (line.startsWith('data:')) {
					data.push(line.slice(5).trimStart());
				}
			}
			if (data.length) {
				yield { event, data: data.join('\n') };
			}
		}
	}
}

/** The message in whichever error shape answered: the console's, Anthropic's or OpenAI's. */
function errorText(text: string, status: number): string {
	try {
		const json = JSON.parse(text) as { error?: string | { message?: string } };
		const message = typeof json.error === 'string' ? json.error : json.error?.message;
		if (message) {
			return message;
		}
	} catch {
		// Not JSON.
	}
	return text.trim().slice(0, 400) || `The gateway answered ${status}`;
}

/**
 * Sends prompts through the gateway as the signed-in admin: their effective policy, the
 * organization's keys, metering and audit, so keys and policies can be checked before developers
 * meet them. Every request shows up in Gateway Requests like one from Volt.
 */
export default function PlaygroundEditor() {
	const { orgId, orgName, role } = useOrg();
	const models = useQuery(`${orgId}:playground-models`, () => api.get<IPlaygroundModel[]>('/playground/models'));
	const [model, setModel] = useState<string>();
	const [system, setSystem] = useState('');
	const [maxTokens, setMaxTokens] = useState<number | undefined>(1024);
	const [stream, setStream] = useState(true);
	const [draft, setDraft] = useState('');
	const [turns, setTurns] = useState<ITurn[]>([]);
	const [result, setResult] = useState<IResult>();
	const [busy, setBusy] = useState(false);
	const abort = useRef<AbortController | undefined>(undefined);
	const transcript = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!model && models.data?.length) {
			setModel(models.data[0].id);
		}
	}, [model, models.data]);
	useEffect(() => {
		transcript.current?.scrollTo({ top: transcript.current.scrollHeight });
	}, [turns]);
	useEffect(() => () => abort.current?.abort(), []);

	if (models.error) {
		return <div className="page"><Callout tone="err">{models.error.message}</Callout></div>;
	}
	if (!models.data) {
		return <Loading page />;
	}
	const chosen = models.data.find(m => m.id === model);

	const send = async () => {
		const text = draft.trim();
		if (!text || !chosen || busy) {
			return;
		}
		const history = [...turns.filter(t => t.role !== 'error'), { role: 'user' as const, content: text }];
		setTurns([...history, { role: 'assistant', content: '', streaming: true }]);
		setDraft('');
		setBusy(true);
		setResult(undefined);
		const controller = new AbortController();
		abort.current = controller;
		const started = performance.now();
		let firstTokenMs: number | undefined;
		let reply = '';
		let input: number | undefined;
		let output: number | undefined;
		let stopReason: string | undefined;
		const show = (streaming: boolean) => setTurns([...history, { role: 'assistant', content: reply, streaming }]);
		const request: IPlaygroundRequest = {
			format: chosen.format, model: chosen.id, stream, maxTokens, system: system || undefined,
			messages: history.map(t => ({ role: t.role === 'assistant' ? 'assistant' : 'user', content: t.content })),
		};
		let status = 0;
		try {
			const res = await fetch('/api/govern/playground/send', {
				method: 'POST', credentials: 'same-origin', signal: controller.signal,
				headers: { 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json' },
				body: JSON.stringify(request),
			});
			status = res.status;
			if (!res.ok) {
				const message = errorText(await res.text(), res.status);
				setTurns([...history, { role: 'error', content: message }]);
				setResult({ model: chosen.id, status, latencyMs: performance.now() - started });
				return;
			}
			if ((res.headers.get('content-type') ?? '').includes('text/event-stream') && res.body) {
				for await (const { data } of readSse(res.body)) {
					if (data === '[DONE]') {
						continue;
					}
					const event = JSON.parse(data) as IWireEvent;
					const delta: string | undefined = chosen.format === 'anthropic'
						? event.type === 'content_block_delta' && event.delta?.type === 'text_delta' ? event.delta.text : undefined
						: event.choices?.[0]?.delta?.content;
					if (event.type === 'message_start') {
						input = event.message?.usage?.input_tokens;
					} else if (event.type === 'message_delta') {
						output = event.usage?.output_tokens;
						stopReason = event.delta?.stop_reason ?? stopReason;
					} else if (event.usage) {
						input = event.usage.prompt_tokens ?? input;
						output = event.usage.completion_tokens ?? output;
					}
					stopReason = event.choices?.[0]?.finish_reason ?? stopReason;
					if (delta) {
						firstTokenMs ??= performance.now() - started;
						reply += delta;
						show(true);
					}
				}
			} else {
				const json = await res.json() as IWireEvent;
				reply = chosen.format === 'anthropic'
					? json.content?.filter(b => b.type === 'text').map(b => b.text).join('') ?? ''
					: json.choices?.[0]?.message?.content ?? '';
				input = json.usage?.input_tokens ?? json.usage?.prompt_tokens;
				output = json.usage?.output_tokens ?? json.usage?.completion_tokens;
				stopReason = json.stop_reason ?? json.choices?.[0]?.finish_reason ?? undefined;
			}
			show(false);
			setResult({ model: chosen.id, status, latencyMs: performance.now() - started, firstTokenMs, input, output, stopReason });
		} catch (err) {
			if (controller.signal.aborted) {
				show(false);
				setResult({ model: chosen.id, status, latencyMs: performance.now() - started, firstTokenMs, input, output, stopReason: 'stopped' });
			} else {
				setTurns([...history, { role: 'error', content: err instanceof Error ? err.message : String(err) }]);
			}
		} finally {
			setBusy(false);
			abort.current = undefined;
			invalidate(`${keys.requests(orgId)}:`, keys.overview(orgId), keys.usage(orgId), `${keys.audit(orgId)}:`);
		}
	};

	if (!models.data.length) {
		return (
			<Page title="Gateway Playground" subtitle="Send prompts through the gateway as yourself.">
				<EmptyState icon="beaker" title="No models you can use" actions={<><Button variant="primary" icon="key" onClick={() => open.credentials()}>Provider Keys</Button><Button icon="law" onClick={() => open.policy('org', orgId, 'Organization Policy', true)}>Organization Policy</Button></>}>
					Models come from {orgName}'s active provider keys, narrowed by your effective policy. Add a key, or allow a model in the policy.
				</EmptyState>
			</Page>
		);
	}

	return (
		<Page title="Gateway Playground" wide
			subtitle="Prompts go through the gateway as you: your effective policy, the organization's keys, request inspection, metering and audit. What Volt gets, without a device."
			actions={turns.length ? <Button variant="ghost" icon="clear-all" disabled={busy} onClick={() => { setTurns([]); setResult(undefined); }}>Clear</Button> : undefined}>
			<div className="playground">
				<div>
					<div className="transcript" ref={transcript} style={{ maxHeight: 'calc(100vh - 360px)', overflowY: 'auto' }}>
						{turns.length ? turns.map((t, i) => (
							<div key={i} className={`bubble ${t.role}`}>
								{t.role === 'error' ? <span className="row" style={{ alignItems: 'flex-start' }}><Codicon name="error" className="err-text" /><span>{t.content}</span></span> : t.content}
								{t.streaming ? <span className="caret" /> : null}
							</div>
						)) : (
							<EmptyState icon="beaker" title="Try a prompt">
								Check that a key works, that a policy allows (or blocks) a model, or that redaction catches a secret. Each request appears in Gateway Requests.
							</EmptyState>
						)}
					</div>
					<div className="composer">
						<textarea value={draft} placeholder={`Message ${chosen?.id ?? 'the model'}…`} rows={3} onChange={e => setDraft(e.target.value)}
							onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
						<div className="composer-bar">
							<Select compact value={model} onChange={setModel} options={models.data.map(m => ({ value: m.id, label: m.id, detail: m.provider }))} />
							<span className="spacer" />
							<span className="faint" style={{ fontSize: 11.5 }}>Enter to send · Shift+Enter for a new line</span>
							{busy
								? <Button size="sm" icon="stop-circle" onClick={() => abort.current?.abort()}>Stop</Button>
								: <Button size="sm" variant="primary" icon="send" disabled={!draft.trim() || !chosen} onClick={() => void send()}>Send</Button>}
						</div>
					</div>
				</div>
				<aside className="stack">
					<div className="card">
						<div className="card-title"><Codicon name="settings-gear" /> Request</div>
						<Field label="Model" hint={chosen ? `${chosen.provider} · ${chosen.format === 'anthropic' ? 'Anthropic Messages' : 'OpenAI Chat Completions'}` : undefined}>
							<Select value={model} onChange={setModel} options={models.data.map(m => ({ value: m.id, label: m.id, detail: m.provider }))} />
						</Field>
						<Field label="Max output tokens" hint="Capped at 4,096 here; your policy may cap it lower.">
							<NumberField value={maxTokens} onChange={setMaxTokens} placeholder="1024" min={1} unit="tokens" width={120} />
						</Field>
						<Field label="System prompt" optional>
							<TextArea rows={3} value={system} placeholder="You are a helpful assistant." onChange={e => setSystem(e.target.value)} />
						</Field>
						<div className="row" style={{ justifyContent: 'space-between' }}>
							<span className="field-label">Stream the answer</span>
							<Toggle checked={stream} title="Stream the answer" onChange={setStream} />
						</div>
					</div>
					<div className="card">
						<div className="card-title"><Codicon name="pulse" /> Last response</div>
						{result ? (
							<dl className="kv" style={{ gridTemplateColumns: '110px minmax(0, 1fr)', gap: '8px 12px' }}>
								<dt>Status</dt><dd>{result.status >= 200 && result.status < 300 ? <span className="ok-text">{result.status} OK</span> : <span className="err-text">{result.status || 'failed'}</span>}</dd>
								<dt>Model</dt><dd className="mono" style={{ fontSize: 12 }}>{result.model}</dd>
								<dt>Latency</dt><dd>{formatMs(Math.round(result.latencyMs))}{result.firstTokenMs !== undefined ? <span className="faint"> · first token {formatMs(Math.round(result.firstTokenMs))}</span> : null}</dd>
								<dt>Tokens</dt><dd>{result.input !== undefined || result.output !== undefined ? `${formatCount(result.input ?? 0)} in · ${formatCount(result.output ?? 0)} out` : '—'}</dd>
								{result.stopReason ? <><dt>Stop reason</dt><dd className="mono" style={{ fontSize: 12 }}>{result.stopReason}</dd></> : null}
							</dl>
						) : <div className="muted" style={{ fontSize: 12.5 }}>Send a prompt to see status, latency and tokens.</div>}
						<div style={{ marginTop: 12 }}><Button size="sm" variant="ghost" icon="link-external" onClick={() => open.requests()}>Open Gateway Requests</Button></div>
					</div>
					<Callout tone="info" icon="workspace-trusted">Runs as you ({role}) under your effective policy. Requests are metered to you and audited as playground use.</Callout>
				</aside>
			</div>
		</Page>
	);
}
