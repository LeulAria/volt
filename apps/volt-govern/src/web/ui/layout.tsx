/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, Kbd } from './controls';
import { keys } from '../lib/format';
import { Codicon, type CodiconName } from './icons';

//#region Sash

/** The workbench's sash: drag to resize, double-click to reset. */
export function Sash({ orientation, size, onResize, onReset, invert, min = 120, max = 1200 }: {
	readonly orientation: 'vertical' | 'horizontal';
	readonly size: number;
	readonly onResize: (size: number) => void;
	readonly onReset?: () => void;
	/** The sized part is after the sash (right of it, or below it). */
	readonly invert?: boolean;
	readonly min?: number;
	readonly max?: number;
}) {
	const start = useRef<{ pos: number; size: number } | undefined>(undefined);
	const [active, setActive] = useState(false);
	const vertical = orientation === 'vertical';
	return (
		<div
			className={`${vertical ? 'sash-v' : 'sash-h'}${active ? ' active' : ''}`}
			role="separator"
			aria-orientation={orientation}
			onDoubleClick={onReset}
			onPointerDown={e => {
				e.preventDefault();
				e.currentTarget.setPointerCapture(e.pointerId);
				start.current = { pos: vertical ? e.clientX : e.clientY, size };
				setActive(true);
				document.body.classList.add(vertical ? 'resizing-x' : 'resizing-y');
			}}
			onPointerMove={e => {
				if (!start.current) {
					return;
				}
				const delta = (vertical ? e.clientX : e.clientY) - start.current.pos;
				onResize(Math.min(max, Math.max(min, start.current.size + (invert ? -delta : delta))));
			}}
			onPointerUp={e => {
				start.current = undefined;
				setActive(false);
				e.currentTarget.releasePointerCapture(e.pointerId);
				document.body.classList.remove('resizing-x', 'resizing-y');
			}}
		/>
	);
}

//#endregion

//#region View pane

/** A collapsible section of a side bar view (the Explorer's OPEN EDITORS / OUTLINE / TIMELINE). */
export function Pane({ title, expanded, onToggle, actions, badge, children }: {
	readonly title: string;
	readonly expanded: boolean;
	readonly onToggle: () => void;
	readonly actions?: ReactNode;
	readonly badge?: ReactNode;
	readonly children: ReactNode;
}) {
	return (
		<section className={`pane ${expanded ? 'expanded' : 'collapsed'}`}>
			<div className="pane-header" role="button" tabIndex={0} aria-expanded={expanded} onClick={onToggle}
				onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}>
				<Codicon name={expanded ? 'chevron-down' : 'chevron-right'} className="twistie" />
				<span className="pane-title">{title}</span>
				{badge}
				{actions ? <span className="actions" onClick={e => e.stopPropagation()}>{actions}</span> : null}
			</div>
			{expanded ? <div className="pane-body">{children}</div> : null}
		</section>
	);
}

/** Expanded state for a side bar's panes, remembered per view. */
export function usePanes(view: string, defaults: Record<string, boolean>): [Record<string, boolean>, (id: string) => void] {
	const key = `volt.govern.panes.${view}`;
	const [state, setState] = useState<Record<string, boolean>>(() => {
		try {
			return { ...defaults, ...(JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, boolean>) };
		} catch {
			return defaults;
		}
	});
	const toggle = (id: string) => setState(s => {
		const next = { ...s, [id]: !s[id] };
		try {
			localStorage.setItem(key, JSON.stringify(next));
		} catch {
			// Private mode.
		}
		return next;
	});
	return [state, toggle];
}

//#endregion

//#region List

export interface IListItem {
	readonly id: string;
	readonly label: ReactNode;
	readonly icon?: CodiconName | ReactNode;
	readonly description?: ReactNode;
	readonly meta?: ReactNode;
	readonly actions?: ReactNode;
	readonly indent?: number;
	readonly twistie?: 'open' | 'closed';
	readonly title?: string;
}

/**
 * A keyboard-navigable list with VS Code's selection and focus look. Single click opens in preview
 * (italic tab), double click or Enter pins — like the Explorer.
 */
export function List({ items, selected, onOpen, onContextMenu, emptyText, label }: {
	readonly items: readonly IListItem[];
	readonly selected?: string;
	readonly onOpen: (id: string, pinned: boolean) => void;
	readonly onContextMenu?: (id: string, e: MouseEvent) => void;
	readonly emptyText?: ReactNode;
	readonly label: string;
}) {
	const [focus, setFocus] = useState<string | undefined>(selected);
	const ref = useRef<HTMLDivElement>(null);
	if (!items.length) {
		return <div className="list-empty">{emptyText ?? 'Nothing here yet.'}</div>;
	}
	const current = focus ?? selected;
	const onKey = (e: KeyboardEvent) => {
		const i = items.findIndex(it => it.id === current);
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			const next = items[Math.min(items.length - 1, i + 1)];
			setFocus(next.id);
			onOpen(next.id, false);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			const next = items[Math.max(0, i - 1)];
			setFocus(next.id);
			onOpen(next.id, false);
		} else if (e.key === 'Enter' && current) {
			e.preventDefault();
			onOpen(current, true);
		}
	};
	return (
		<div className="list" role="listbox" aria-label={label} tabIndex={0} ref={ref} onKeyDown={onKey}>
			{items.map(item => (
				<div key={item.id} role="option" aria-selected={item.id === selected} title={item.title}
					className={`list-row${item.id === (selected ?? current) ? ' selected' : ''}`}
					style={{ ['--indent' as string]: `${20 + (item.indent ?? 0) * 8}px` }}
					onClick={() => { setFocus(item.id); onOpen(item.id, false); }}
					onDoubleClick={() => onOpen(item.id, true)}
					onContextMenu={onContextMenu ? e => { setFocus(item.id); onContextMenu(item.id, e); } : undefined}>
					{item.twistie ? <Codicon name="chevron-right" className={`twistie${item.twistie === 'open' ? ' open' : ''}`} /> : null}
					{typeof item.icon === 'string' ? <Codicon name={item.icon as CodiconName} /> : item.icon}
					<span className="list-label">{item.label}</span>
					{item.description ? <span className="list-desc">{item.description}</span> : null}
					{item.meta ? <span className={`list-meta${item.actions ? ' hide-on-hover' : ''}`}>{item.meta}</span> : null}
					{item.actions ? <span className="row-actions" onClick={e => e.stopPropagation()}>{item.actions}</span> : null}
				</div>
			))}
		</div>
	);
}

//#endregion

//#region Table

export interface IColumn<T> {
	readonly id: string;
	readonly title: string;
	readonly width?: number;
	readonly align?: 'right';
	readonly mono?: boolean;
	readonly sort?: (row: T) => string | number;
	readonly render: (row: T) => ReactNode;
}

/** VS Code's table widget (Keyboard Shortcuts editor): sticky header, resizable and sortable columns. */
export function Table<T>({ columns, rows, rowKey, onRowClick, onRowContextMenu, selected, empty, emptyIcon = 'inbox', maxHeight, initialSort }: {
	readonly columns: readonly IColumn<T>[];
	readonly rows: readonly T[];
	readonly rowKey: (row: T) => string;
	readonly onRowClick?: (row: T) => void;
	readonly onRowContextMenu?: (row: T, e: MouseEvent) => void;
	readonly selected?: string;
	readonly empty?: ReactNode;
	readonly emptyIcon?: CodiconName;
	readonly maxHeight?: number | string;
	readonly initialSort?: { readonly column: string; readonly desc?: boolean };
}) {
	const [widths, setWidths] = useState<Record<string, number>>({});
	const [sort, setSort] = useState<{ column: string; desc: boolean } | undefined>(initialSort ? { column: initialSort.column, desc: !!initialSort.desc } : undefined);
	const drag = useRef<{ id: string; x: number; w: number } | undefined>(undefined);
	const sorted = useMemo(() => {
		const col = sort && columns.find(c => c.id === sort.column);
		if (!col?.sort) {
			return rows;
		}
		const key = col.sort;
		return [...rows].sort((a, b) => {
			const x = key(a);
			const y = key(b);
			const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
			return sort!.desc ? -r : r;
		});
	}, [rows, sort, columns]);
	if (!rows.length) {
		return (
			<div className="table-wrap table-wrap-empty">
				<div className="empty-state"><Codicon name={emptyIcon} /><div className="empty-state-body">{empty ?? 'No rows.'}</div></div>
			</div>
		);
	}
	return (
		<div className="table-wrap" style={maxHeight !== undefined ? { maxHeight } : undefined}>
			<table className="table">
				<colgroup>{columns.map(c => <col key={c.id} style={{ width: widths[c.id] ?? c.width }} />)}</colgroup>
				<thead>
					<tr>
						{columns.map(c => (
							<th key={c.id} className={`${c.sort ? 'sortable' : ''}${c.align === 'right' ? ' num' : ''}`}
								aria-sort={sort?.column === c.id ? (sort.desc ? 'descending' : 'ascending') : undefined}
								onClick={() => c.sort && setSort(s => s?.column === c.id ? { column: c.id, desc: !s.desc } : { column: c.id, desc: false })}>
								{c.title}
								{sort?.column === c.id ? <Codicon name={sort.desc ? 'arrow-down' : 'arrow-up'} /> : null}
								<span className="col-sash" onClick={e => e.stopPropagation()}
									onPointerDown={e => {
										e.preventDefault();
										e.stopPropagation();
										const th = e.currentTarget.parentElement as HTMLElement;
										drag.current = { id: c.id, x: e.clientX, w: th.offsetWidth };
										e.currentTarget.setPointerCapture(e.pointerId);
										document.body.classList.add('resizing-x');
									}}
									onPointerMove={e => {
										const d = drag.current;
										if (d) {
											setWidths(w => ({ ...w, [d.id]: Math.max(48, d.w + e.clientX - d.x) }));
										}
									}}
									onPointerUp={e => {
										drag.current = undefined;
										e.currentTarget.releasePointerCapture(e.pointerId);
										document.body.classList.remove('resizing-x');
									}} />
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{sorted.map(row => {
						const key = rowKey(row);
						return (
							<tr key={key} className={`${onRowClick ? 'clickable' : ''}${selected === key ? ' selected' : ''}`}
								onClick={onRowClick ? () => onRowClick(row) : undefined}
								onContextMenu={onRowContextMenu ? e => onRowContextMenu(row, e) : undefined}>
								{columns.map(c => <td key={c.id} className={`${c.align === 'right' ? 'num' : ''}${c.mono ? ' mono' : ''}${c.id === 'actions' ? ' actions-cell' : ''}`}>{c.render(row)}</td>)}
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

//#endregion

//#region Page scaffolding

/** An editor's page: a quiet title and subtitle, actions on the right, then the content (Volt's settings column). */
export function Page({ title, subtitle, actions, children, wide, badge }: {
	readonly title: ReactNode;
	readonly subtitle?: ReactNode;
	readonly actions?: ReactNode;
	readonly children: ReactNode;
	readonly wide?: boolean;
	readonly badge?: ReactNode;
}) {
	return (
		<div className={`page${wide ? ' wide' : ''}`}>
			<header className="page-head">
				<div className="page-head-text">
					<h1 className="page-title">{title}{badge}</h1>
					{subtitle ? <div className="page-sub">{subtitle}</div> : null}
				</div>
				{actions ? <div className="page-actions">{actions}</div> : null}
			</header>
			{children}
		</div>
	);
}

export function Section({ title, hint, actions, children }: { readonly title: ReactNode; readonly hint?: ReactNode; readonly actions?: ReactNode; readonly children: ReactNode }) {
	return (
		<section className="section">
			<h2 className="section-title">{title}{actions ? <span className="actions">{actions}</span> : null}</h2>
			{hint ? <p className="section-hint">{hint}</p> : null}
			{children}
		</section>
	);
}

/** A titled card of setting rows (voltSettings' group). */
export function Group({ title, hint, actions, children, id, danger }: { readonly title?: ReactNode; readonly hint?: ReactNode; readonly actions?: ReactNode; readonly children: ReactNode; readonly id?: string; readonly danger?: boolean }) {
	const card = <div className={`group${danger ? ' danger' : ''}`}>{children}</div>;
	if (!title) {
		return card;
	}
	return (
		<section className="section" id={id} data-section={id}>
			<h2 className="section-title">{title}{actions ? <span className="actions">{actions}</span> : null}</h2>
			{hint ? <p className="section-hint">{hint}</p> : null}
			{card}
		</section>
	);
}

/**
 * One setting row: its name and description on the left, its control on the right, like Volt's
 * and Cursor's settings. `wide` stacks a control that needs the full width (lists, tables) below.
 * A modified setting gets VS Code's bar at the left edge.
 */
export function Setting({ title, description, modified, inherited, children, wide, tags }: {
	readonly category?: string;
	readonly title: ReactNode;
	readonly description?: ReactNode;
	readonly modified?: boolean;
	readonly inherited?: ReactNode;
	readonly children?: ReactNode;
	readonly wide?: boolean;
	readonly tags?: ReactNode;
}) {
	return (
		<div className={`setting${wide ? ' stacked' : ''}${modified ? ' modified' : ''}`}>
			<div className="setting-copy">
				<div className="setting-title">{title}{tags}</div>
				{description ? <div className="setting-desc">{description}</div> : null}
				{inherited ? <div className="setting-inherit"><Codicon name="type-hierarchy" />{inherited}</div> : null}
			</div>
			{children !== undefined ? <div className="setting-control">{children}</div> : null}
		</div>
	);
}

/** Skeleton placeholders: a page's outline (`page`), or a few rows where a list or table will be. */
/**
 * The unsaved-changes bar: floats at the bottom of the editor while there is something to save,
 * with Discard, Save and ⌘S. One pattern for every editor with a draft.
 */
export function SaveBar({ dirty, busy, onSave, onDiscard, saveLabel = 'Save', message = 'You have unsaved changes', disabled }: {
	readonly dirty: boolean;
	readonly busy?: boolean;
	readonly onSave: () => void;
	readonly onDiscard: () => void;
	readonly saveLabel?: string;
	readonly message?: ReactNode;
	readonly disabled?: boolean;
}) {
	useEffect(() => {
		if (!dirty) {
			return;
		}
		const onKey = (e: globalThis.KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
				e.preventDefault();
				if (!busy && !disabled) {
					onSave();
				}
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [dirty, busy, disabled, onSave]);
	if (!dirty) {
		return null;
	}
	return (
		<div className="savebar" role="region" aria-label="Unsaved changes">
			<span className="savebar-dot" aria-hidden="true" />
			<span className="savebar-text">{message}</span>
			<Button size="sm" variant="ghost" disabled={busy} onClick={onDiscard}>Discard</Button>
			<Button size="sm" variant="primary" busy={busy} disabled={disabled} onClick={onSave}>{saveLabel}<Kbd>{keys('⌘S')}</Kbd></Button>
		</div>
	);
}

export function Loading({ label = 'Loading…', page }: { readonly label?: string; readonly page?: boolean }) {
	if (page) {
		return (
			<div className="skeleton-page" aria-busy="true" aria-label={label}>
				<div className="skeleton" style={{ width: 240, height: 28 }} />
				<div className="skeleton" style={{ width: 440, maxWidth: '80%', height: 14, marginBottom: 22 }} />
				<div className="skeleton" style={{ height: 132, borderRadius: 12 }} />
				<div className="skeleton" style={{ height: 66, borderRadius: 12 }} />
				<div className="skeleton" style={{ height: 66, borderRadius: 12 }} />
			</div>
		);
	}
	return (
		<div className="stack tight" style={{ padding: '14px 18px' }} aria-busy="true" aria-label={label}>
			{[92, 74, 84].map(w => <div key={w} className="skeleton" style={{ width: `${w}%`, height: 14 }} />)}
		</div>
	);
}

export function ErrorView({ error, retry }: { readonly error: Error; readonly retry?: () => void }) {
	return (
		<div className="page">
			<div className="empty-state">
				<Codicon name="error" />
				<div className="empty-state-title">Something went wrong</div>
				<div className="empty-state-body">{error.message || 'The server could not be reached.'}</div>
				{retry ? <div className="btn-group"><Button icon="refresh" onClick={retry}>Try Again</Button></div> : null}
			</div>
		</div>
	);
}

//#endregion

//#region Charts

/**
 * Daily bars at a steady width (a single day is one slim bar, not a block), faint bars for days
 * without data, dashed gridlines with the top value, and a hover title per bar.
 */
export function BarChart({ data, height = 140, format }: { readonly data: readonly { readonly label: string; readonly value: number }[]; readonly height?: number; readonly format: (value: number) => string }) {
	const max = Math.max(...data.map(d => d.value), 0);
	const slots = Math.max(data.length, 14);
	const width = 600;
	const slot = width / slots;
	const bar = Math.min(18, slot * 0.62);
	const top = 14;
	const base = height - 2;
	const scale = max > 0 ? (base - top) / max : 0;
	const offset = (slots - data.length) * slot;
	return (
		<svg className="chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" height={height} role="img" aria-label="Chart">
			{[0, 0.5, 1].map(f => <line key={f} className="grid-line" x1="0" x2={width} y1={top + (base - top) * f} y2={top + (base - top) * f} vectorEffect="non-scaling-stroke" />)}
			{data.map((d, i) => {
				const h = d.value > 0 ? Math.max(2, d.value * scale) : 2;
				return (
					<rect key={d.label} className={`bar${d.value > 0 ? '' : ' zero'}`} x={offset + i * slot + (slot - bar) / 2} width={bar} y={base - h} height={h} rx={Math.min(3, bar / 3)}>
						<title>{`${d.label}: ${format(d.value)}`}</title>
					</rect>
				);
			})}
		</svg>
	);
}

export interface IPoint {
	readonly label: string;
	readonly value: number;
}

/** A round axis top: 1, 2 or 5 times a power of ten. */
function niceMax(value: number): number {
	if (value <= 0) {
		return 1;
	}
	const power = Math.pow(10, Math.floor(Math.log10(value)));
	const n = value / power;
	return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * power;
}

/** A gradient id that survives `url(#…)` (React's ids carry characters CSS does not take there). */
function useSvgId(): string {
	return `g${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

function pathOf(values: readonly number[], width: number, height: number, max: number, top: number): { line: string; area: string } {
	const n = values.length;
	const x = (i: number) => n > 1 ? (i / (n - 1)) * width : width / 2;
	const y = (v: number) => height - (v / max) * (height - top);
	const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join('');
	return { line, area: n ? `${line}L${x(n - 1).toFixed(2)},${height}L${x(0).toFixed(2)},${height}Z` : '' };
}

/**
 * An area chart with a soft gradient, dashed gridlines, and a hover cursor that reads out the
 * value under the pointer (Vercel Analytics style). Text is HTML over the SVG, so it never stretches.
 */
export function AreaChart({ data, height = 200, format, formatLabel = l => l }: {
	readonly data: readonly IPoint[];
	readonly height?: number;
	readonly format: (value: number) => string;
	readonly formatLabel?: (label: string) => string;
}) {
	const [hover, setHover] = useState<number>();
	const ref = useRef<HTMLDivElement>(null);
	const gradient = useSvgId();
	const width = 1000;
	const top = 10;
	const max = niceMax(Math.max(0, ...data.map(d => d.value)));
	const n = data.length;
	const y = (v: number) => height - (v / max) * (height - top);
	const { line, area } = pathOf(data.map(d => d.value), width, height, max, top);
	const at = (i: number) => (n > 1 ? i / (n - 1) : 0.5) * 100;
	const ticks = [...new Set([0, Math.round((n - 1) / 4), Math.round((n - 1) / 2), Math.round((3 * (n - 1)) / 4), n - 1])].filter(i => i >= 0);
	const point = hover !== undefined ? data[hover] : undefined;
	return (
		<div className="area-chart" ref={ref}
			onMouseMove={e => {
				const box = ref.current?.getBoundingClientRect();
				if (box && n) {
					setHover(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - box.left) / box.width) * (n - 1)))));
				}
			}}
			onMouseLeave={() => setHover(undefined)}>
			<div style={{ position: 'relative', height }}>
				<svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" height={height} role="img" aria-label="Chart">
					<defs>
						<linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
							<stop offset="0%" style={{ stopColor: 'var(--chart)', stopOpacity: 0.3 }} />
							<stop offset="100%" style={{ stopColor: 'var(--chart)', stopOpacity: 0 }} />
						</linearGradient>
					</defs>
					{[0, 0.5, 1].map(t => <line key={t} className="grid-line" x1="0" x2={width} y1={y(max * t)} y2={y(max * t)} vectorEffect="non-scaling-stroke" />)}
					<path d={area} fill={`url(#${gradient})`} />
					<path d={line} className="line" vectorEffect="non-scaling-stroke" />
				</svg>
				{data.some(d => d.value > 0)
					? [0.5, 1].map(t => <span key={t} className="y-label" style={{ top: y(max * t) }}>{format(max * t)}</span>)
					: <div className="chart-empty"><span>No activity in this period</span></div>}
				{point && hover !== undefined ? (
					<>
						<div className="cursor" style={{ left: `${at(hover)}%`, height }} />
						<div className="cursor-dot" style={{ left: `${at(hover)}%`, top: y(point.value) }} />
						<div className="chart-tip" style={at(hover) > 70 ? { right: `calc(${100 - at(hover)}% + 12px)` } : { left: `calc(${at(hover)}% + 12px)` }}>
							<div className="chart-tip-date">{formatLabel(point.label)}</div>
							<div className="chart-tip-value">{format(point.value)}</div>
						</div>
					</>
				) : null}
			</div>
			<div className="x-labels">{n ? ticks.map(i => <span key={i} style={{ left: `${at(i)}%` }}>{formatLabel(data[i].label)}</span>) : null}</div>
		</div>
	);
}

/** A tiny trend line for a tile. */
export function Sparkline({ values }: { readonly values: readonly number[] }) {
	const gradient = useSvgId();
	const width = 200;
	const height = 40;
	const { line, area } = pathOf(values, width, height, niceMax(Math.max(0, ...values)), 4);
	return (
		<svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
			<defs>
				<linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
					<stop offset="0%" style={{ stopColor: 'var(--chart)', stopOpacity: 0.22 }} />
					<stop offset="100%" style={{ stopColor: 'var(--chart)', stopOpacity: 0 }} />
				</linearGradient>
			</defs>
			<path d={area} fill={`url(#${gradient})`} />
			<path d={line} className="line" vectorEffect="non-scaling-stroke" />
		</svg>
	);
}

export interface IMetric {
	readonly id: string;
	readonly label: string;
	readonly icon?: CodiconName;
	readonly value: ReactNode;
	readonly sub?: ReactNode;
	readonly points: readonly IPoint[];
	readonly format: (value: number) => string;
}

/** Metric tabs over one area chart: pick a metric by its headline number. */
export function MetricChart({ metrics, height = 200, formatLabel }: { readonly metrics: readonly IMetric[]; readonly height?: number; readonly formatLabel?: (label: string) => string }) {
	const [active, setActive] = useState(metrics[0]?.id);
	const metric = metrics.find(m => m.id === active) ?? metrics[0];
	if (!metric) {
		return null;
	}
	return (
		<div className="card metric-card">
			<div className="metric-tabs" role="tablist">
				{metrics.map(m => (
					<button key={m.id} type="button" role="tab" aria-selected={m.id === metric.id} className={`metric-tab${m.id === metric.id ? ' active' : ''}`} onClick={() => setActive(m.id)}>
						<div className="metric-label">{m.icon ? <Codicon name={m.icon} /> : null}{m.label}</div>
						<div className="metric-value">{m.value}</div>
						{m.sub ? <div className="metric-sub">{m.sub}</div> : null}
					</button>
				))}
			</div>
			<div className="metric-body"><AreaChart data={metric.points} height={height} format={metric.format} formatLabel={formatLabel} /></div>
		</div>
	);
}

export function HBars({ data, format }: { readonly data: readonly { readonly label: string; readonly value: number }[]; readonly format: (value: number) => string }) {
	const max = Math.max(1, ...data.map(d => d.value));
	if (!data.length) {
		return <div className="muted">No data yet.</div>;
	}
	return (
		<div className="hbar">
			{data.map(d => (
				<div key={d.label} style={{ display: 'contents' }}>
					<span className="hbar-label" title={d.label}>{d.label}</span>
					<span className="hbar-value">{format(d.value)}</span>
					<div className="hbar-track"><div className="hbar-fill" style={{ width: `${(d.value / max) * 100}%` }} /></div>
				</div>
			))}
		</div>
	);
}

export function Tile({ icon, label, value, sub, onClick }: { readonly icon: CodiconName; readonly label: string; readonly value: ReactNode; readonly sub?: ReactNode; readonly onClick?: () => void }) {
	const body = (
		<>
			<div className="tile-label"><Codicon name={icon} />{label}{onClick ? <Codicon name="arrow-right" className="go" /> : null}</div>
			<div className="tile-value">{value}</div>
			{sub ? <div className="tile-sub">{sub}</div> : null}
		</>
	);
	return onClick ? <button type="button" className="tile" onClick={onClick}>{body}</button> : <div className="tile">{body}</div>;
}

//#endregion
