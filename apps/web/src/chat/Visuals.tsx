/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { darkPalette, type IRenderedPage, type IRenderTheme, lightPalette, renderThemeFor, texToText } from '@volt/client-core';
import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useClient } from '../app/client';
import { useAppliedTheme } from '../app/theme';
import { Dialog } from '../ui/overlays';
import { Icon, Spinner } from '../ui/primitives';
import { useChatRow } from './rowContext';

/**
 * What the desktop draws in its window, drawn here from the server (serverRender.ts): agents'
 * pages and charts, mermaid diagrams and math. Pages and diagrams run in sandboxed frames sized to
 * their content; math is KaTeX markup with the server's KaTeX stylesheet.
 */

function useRenderTheme(): IRenderTheme {
	const scheme = useAppliedTheme();
	return useMemo(() => renderThemeFor(scheme === 'light' ? lightPalette : darkPalette), [scheme]);
}

function useRendered(load: (theme: IRenderTheme) => Promise<IRenderedPage> | undefined, deps: readonly unknown[]): { readonly page?: IRenderedPage; readonly error?: string } {
	const theme = useRenderTheme();
	const [state, setState] = useState<{ page?: IRenderedPage; error?: string }>({});
	useEffect(() => {
		let live = true;
		load(theme)?.then(page => live && setState({ page }), err => live && setState({ error: err instanceof Error ? err.message : String(err) }));
		return () => {
			live = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [theme, ...deps]);
	return state;
}

let katexLinked = false;

/** KaTeX's stylesheet, from the server, once per page. */
function useKatexStylesheet(): void {
	const client = useClient();
	useEffect(() => {
		const href = client.katexStylesheet ?? '/vendor/katex/katex.min.css';
		if (katexLinked) {
			return;
		}
		katexLinked = true;
		const link = document.createElement('link');
		link.rel = 'stylesheet';
		link.href = href;
		document.head.appendChild(link);
	}, [client]);
}

/** A server-drawn page in a sandboxed frame that grows to fit what it reports. */
export function Frame({ html, initialHeight, maxHeight = 2000, fill, onHeight }: { readonly html: string; readonly initialHeight: number; readonly maxHeight?: number; readonly fill?: boolean; readonly onHeight?: (height: number) => void }) {
	const scheme = useAppliedTheme();
	const row = useChatRow();
	const client = useClient();
	const ref = useRef<HTMLIFrameElement | null>(null);
	const [height, setHeight] = useState(initialHeight);
	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			if (!ref.current || event.source !== ref.current.contentWindow) {
				return;
			}
			const message = event.data as { type?: string; height?: number; href?: string; text?: string } | undefined;
			if (message?.type === 'volt-frame-height' && typeof message.height === 'number') {
				const next = Math.min(maxHeight, Math.max(24, Math.ceil(message.height)));
				setHeight(next);
				onHeight?.(next);
			} else if (message?.type === 'volt-open' && message.href && /^(https?:|mailto:)/i.test(message.href)) {
				window.open(message.href, '_blank', 'noopener,noreferrer');
			} else if (message?.type === 'volt-send' && typeof message.text === 'string' && row?.chatId) {
				void client.send({ threadId: row.chatId, text: message.text });
			}
		};
		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	}, [maxHeight, onHeight, row?.chatId, client]);
	return (
		<iframe
			ref={ref}
			className="rich-frame"
			srcDoc={html}
			// Scripts run, but the page gets no access to this origin, its storage or the session.
			sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
			title="Visual"
			scrolling={fill ? 'auto' : 'no'}
			// A frame whose color scheme differs from its page's is painted opaque: they match.
			style={{ height: fill ? '100%' : height, colorScheme: scheme }}
		/>
	);
}

function FullScreen({ title, html, onClose }: { readonly title: string; readonly html: string; readonly onClose: () => void }) {
	return (
		<Dialog open title={title} onClose={onClose} width={Math.min(1100, window.innerWidth - 32)}>
			<div className="rich-full"><Frame html={html} initialHeight={600} fill /></div>
		</Dialog>
	);
}

function Card({ icon, title, actions, children, tone }: { readonly icon: Parameters<typeof Icon>[0]['name']; readonly title: string; readonly actions?: ReactNode; readonly children: ReactNode; readonly tone?: 'code' }) {
	return (
		<div className={`rich-card${tone === 'code' ? ' rich-card-code' : ''}`}>
			<div className="rich-head">
				<Icon name={icon} size={13} />
				<span className="rich-title">{title}</span>
				{actions}
			</div>
			<div className="rich-body">{children}</div>
		</div>
	);
}

function Loading({ height, label }: { readonly height: number; readonly label: string }) {
	return <div className="rich-loading" style={{ height }}><Spinner size={14} /><span>{label}</span></div>;
}

const INLINE_MAX = 720;

/** An agent's html_render page or render_chart dashboard. */
export const VisualCard = memo(function VisualCard({ visualRef, kind, title, height, detail, pending }: { readonly visualRef: string; readonly kind: 'chart' | 'html' | 'canvas'; readonly title: string; readonly height?: number; readonly detail?: string; readonly pending?: boolean }) {
	const client = useClient();
	const ready = !!visualRef && !pending && kind !== 'canvas';
	const { page, error } = useRendered(theme => ready ? client.renderVisual(visualRef, kind === 'chart' ? 'chart' : 'html', { theme }) : undefined, [visualRef, kind, ready]);
	const [full, setFull] = useState(false);
	const [measured, setMeasured] = useState<number>();
	const label = title || (kind === 'chart' ? 'Chart' : kind === 'canvas' ? 'Canvas' : 'Page');
	const guess = Math.min(INLINE_MAX, Math.max(kind === 'chart' ? 260 : 160, height ?? (kind === 'chart' ? 300 : 360)));
	return (
		<Card icon={kind === 'chart' ? 'layers' : kind === 'canvas' ? 'palette' : 'globe'} title={label} actions={page ? <button type="button" className="rich-action" aria-label="Open full screen" title="Open full screen" onClick={() => setFull(true)}><Icon name="expand" size={13} /></button> : null}>
			{kind === 'canvas'
				? <div className="rich-note">{detail ? <div>{detail}</div> : null}<div className="rich-muted">Design canvases open in Volt on your computer.</div></div>
				: error ? <div className="rich-note rich-muted"><Icon name="alertCircle" size={13} /> {error}</div>
					: page ? <>
						<Frame html={page.html} initialHeight={guess} maxHeight={INLINE_MAX} onHeight={setMeasured} />
						{(measured ?? 0) >= INLINE_MAX ? <button type="button" className="rich-more" onClick={() => setFull(true)}>Show all</button> : null}
					</>
						: <Loading height={guess} label={pending ? (kind === 'chart' ? 'Drawing chart…' : 'Building page…') : 'Loading…'} />}
			{full && page ? <FullScreen title={label} html={page.html} onClose={() => setFull(false)} /> : null}
		</Card>
	);
});

function CopyButton({ text, label }: { readonly text: string; readonly label: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button type="button" className="rich-action" aria-label={label} title={label} onClick={() => void navigator.clipboard?.writeText(text).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1400);
		})}><Icon name={copied ? 'check' : 'copy'} size={13} /></button>
	);
}

/** A mermaid diagram as the desktop draws it; the source if it can't be drawn. */
export const MermaidBlock = memo(function MermaidBlock({ source, fallback }: { readonly source: string; readonly fallback: ReactNode }) {
	const client = useClient();
	const { page, error } = useRendered(theme => client.renderMermaid(source, { theme }), [source]);
	const [full, setFull] = useState(false);
	if (error) {
		return <>{fallback}</>;
	}
	return (
		<Card icon="list" title="Diagram" tone="code" actions={<>
			<CopyButton text={source} label="Copy diagram source" />
			{page ? <button type="button" className="rich-action" aria-label="Open full screen" title="Open full screen" onClick={() => setFull(true)}><Icon name="expand" size={13} /></button> : null}
		</>}>
			{page ? <Frame html={page.html} initialHeight={200} maxHeight={INLINE_MAX} /> : <Loading height={160} label="Drawing diagram…" />}
			{full && page ? <FullScreen title="Diagram" html={page.html} onClose={() => setFull(false)} /> : null}
		</Card>
	);
});

/** A ```volt-chart fence drawn by Volt's chart engine; the JSON if it isn't a chart. */
export const ChartFenceBlock = memo(function ChartFenceBlock({ spec, fallback }: { readonly spec: string; readonly fallback: ReactNode }) {
	const client = useClient();
	const { page, error } = useRendered(theme => client.renderChart(spec, { theme }), [spec]);
	if (error) {
		return <>{fallback}</>;
	}
	return (
		<Card icon="layers" title="Chart">
			{page ? <Frame html={page.html} initialHeight={300} maxHeight={INLINE_MAX} /> : <Loading height={260} label="Drawing chart…" />}
		</Card>
	);
});

/** Display math typeset by KaTeX on the server. */
export const MathBlock = memo(function MathBlock({ tex }: { readonly tex: string }) {
	useKatexStylesheet();
	const client = useClient();
	const [state, setState] = useState<{ markup?: string; failed?: boolean }>({});
	useEffect(() => {
		let live = true;
		client.renderMath(tex, true).then(page => live && setState({ markup: page.markup }), () => live && setState({ failed: true }));
		return () => {
			live = false;
		};
	}, [client, tex]);
	return state.markup
		// KaTeX's own output, typeset on the server from the formula (no HTML from the reply passes through).
		? <div className="md-math-block" dangerouslySetInnerHTML={{ __html: state.markup }} />
		: <pre className="md-math">{tex}</pre>;
});

/** Inline math: KaTeX markup once typeset, readable Unicode until then. */
export function MathInline({ tex }: { readonly tex: string }) {
	useKatexStylesheet();
	const client = useClient();
	const [markup, setMarkup] = useState<string>();
	useEffect(() => {
		let live = true;
		client.renderMathInline(tex).then(page => live && setMarkup(page.markup), () => undefined);
		return () => {
			live = false;
		};
	}, [client, tex]);
	return markup ? <span className="md-math-inline" dangerouslySetInnerHTML={{ __html: markup }} /> : <span className="md-math-inline md-math-text">{texToText(tex)}</span>;
}
