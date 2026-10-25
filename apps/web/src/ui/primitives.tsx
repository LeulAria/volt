/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type ChatStatus, type IconName, ICONS, MODE_COLORS, timer, type ComposerMode } from '@volt/client-core';
import { type ButtonHTMLAttributes, type CSSProperties, forwardRef, memo, type ReactNode } from 'react';
import { useNow } from '../app/client';

export const Icon = memo(function Icon({ name, size = 16, className, style, strokeWidth = 1.75 }: { readonly name: IconName; readonly size?: number; readonly className?: string; readonly style?: CSSProperties; readonly strokeWidth?: number }) {
	const def = ICONS[name];
	const fill = 'fill' in def && def.fill;
	return (
		<svg className={className ? `icon ${className}` : 'icon'} style={style} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
			fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
			{def.paths.map((d, i) => <path key={i} d={d} />)}
		</svg>
	);
});

export type ButtonVariant = 'secondary' | 'primary' | 'ghost' | 'danger';

export interface IButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	readonly variant?: ButtonVariant;
	readonly size?: 'sm' | 'md' | 'lg';
	readonly icon?: IconName;
	readonly trailingIcon?: IconName;
	readonly busy?: boolean;
}

/** Volt's button (voltButton.css): a lit surface with a hairline edge, or the primary fill. */
export const Button = forwardRef<HTMLButtonElement, IButtonProps>(function Button({ variant = 'secondary', size = 'md', icon, trailingIcon, busy, className, children, disabled, ...rest }, ref) {
	return (
		<button ref={ref} type="button" className={`btn btn-${variant} btn-${size}${className ? ` ${className}` : ''}`} disabled={disabled || busy} {...rest}>
			{busy ? <Spinner size={13} /> : icon ? <Icon name={icon} size={size === 'sm' ? 13 : 15} /> : null}
			{children}
			{trailingIcon ? <Icon name={trailingIcon} size={13} className="btn-trailing" /> : null}
		</button>
	);
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { readonly icon: IconName; readonly label: string; readonly size?: number; readonly active?: boolean }>(
	function IconButton({ icon, label, size = 16, active, className, ...rest }, ref) {
		return (
			<button ref={ref} type="button" aria-label={label} title={label} className={`icon-btn${active ? ' active' : ''}${className ? ` ${className}` : ''}`} {...rest}>
				<Icon name={icon} size={size} />
			</button>
		);
	});

export function Spinner({ size = 14 }: { readonly size?: number }) {
	return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />;
}

/** Text that shimmers while the agent works on it (Volt's live status line). */
export function Shimmer({ children, active = true }: { readonly children: ReactNode; readonly active?: boolean }) {
	return <span className={active ? 'shimmer' : undefined}>{children}</span>;
}

export const STATUS_ICON: Record<ChatStatus, IconName> = {
	approval: 'shieldAlert',
	question: 'help',
	working: 'circleDashed',
	queued: 'queue',
	limit: 'clock',
	failed: 'alertCircle',
	unread: 'checkCircle',
	stopped: 'pause',
	idle: 'dot',
};

export function StatusIcon({ status, size = 14 }: { readonly status: ChatStatus; readonly size?: number }) {
	return (
		<span className={`status-icon status-${status}`} aria-hidden="true">
			<Icon name={STATUS_ICON[status]} size={size} className={status === 'working' ? 'spin-slow' : undefined} />
		</span>
	);
}

export function LiveTimer({ since, className }: { readonly since: number; readonly className?: string }) {
	const now = useNow(1000);
	return <span className={`timer${className ? ` ${className}` : ''}`}>{timer((now || Date.now()) - since)}</span>;
}

export function ModeDot({ mode }: { readonly mode: ComposerMode }) {
	return <span className="mode-dot" style={{ background: mode === 'Agent' ? 'var(--fg3)' : MODE_COLORS[mode].fg }} />;
}

export function Kbd({ children }: { readonly children: ReactNode }) {
	return <kbd className="kbd">{children}</kbd>;
}

export function EmptyState({ icon, title, body, action }: { readonly icon: IconName; readonly title: string; readonly body?: ReactNode; readonly action?: ReactNode }) {
	return (
		<div className="empty">
			<div className="empty-icon"><Icon name={icon} size={22} /></div>
			<div className="empty-title">{title}</div>
			{body ? <div className="empty-body">{body}</div> : null}
			{action ? <div className="empty-action">{action}</div> : null}
		</div>
	);
}

export function Toggle({ checked, onChange, label, disabled }: { readonly checked: boolean; readonly onChange: (next: boolean) => void; readonly label: string; readonly disabled?: boolean }) {
	return (
		<button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`toggle${checked ? ' on' : ''}`} onClick={() => onChange(!checked)}>
			<span className="toggle-knob" />
		</button>
	);
}

export function Segmented<T extends string>({ value, options, onChange }: { readonly value: T; readonly options: readonly { readonly id: T; readonly label: string; readonly icon?: IconName }[]; readonly onChange: (value: T) => void }) {
	return (
		<div className="segmented" role="radiogroup">
			{options.map(option => (
				<button key={option.id} type="button" role="radio" aria-checked={value === option.id} className={value === option.id ? 'on' : undefined} onClick={() => onChange(option.id)}>
					{option.icon ? <Icon name={option.icon} size={14} /> : null}
					{option.label}
				</button>
			))}
		</div>
	);
}

/** Volt's app icon (brand/volt-icon.svg, cropped to its squircle). Size and shadow come from `className`. */
export function VoltMark({ className }: { readonly className?: string }) {
	return <img className={className ? `volt-mark ${className}` : 'volt-mark'} src="/volt-mark.svg" alt="" draggable={false} />;
}

/** The app icon and wordmark. */
export function Wordmark({ subtitle }: { readonly subtitle?: ReactNode }) {
	return (
		<div className="wordmark">
			<VoltMark className="wordmark-mark" />
			<span className="wordmark-text">Volt</span>
			{subtitle ? <span className="wordmark-sub">{subtitle}</span> : null}
		</div>
	);
}
