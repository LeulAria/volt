/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type ButtonHTMLAttributes, forwardRef, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type TextareaHTMLAttributes, useEffect, useRef, useState } from 'react';
import { Codicon, type CodiconName } from './icons';
import { Popover } from './overlays';

//#region Buttons

export interface IButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	readonly variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
	readonly size?: 'sm' | 'md';
	readonly icon?: CodiconName;
	readonly busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, IButtonProps>(function Button({ variant = 'secondary', size = 'md', icon, busy, className, children, disabled, type = 'button', ...rest }, ref) {
	return (
		<button ref={ref} type={type} className={`btn btn-${variant}${size === 'sm' ? ' btn-sm' : ''}${className ? ` ${className}` : ''}`} disabled={disabled || busy} {...rest}>
			{busy ? <Codicon name="loading" spin /> : icon ? <Codicon name={icon} /> : null}
			{children}
		</button>
	);
});

/** A toolbar icon (VS Code's action bar item). */
export const Action = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { readonly icon: CodiconName; readonly label: string; readonly active?: boolean; readonly spin?: boolean }>(
	function Action({ icon, label, active, spin, className, ...rest }, ref) {
		return (
			<button ref={ref} type="button" title={label} aria-label={label} className={`action-btn${active ? ' on' : ''}${className ? ` ${className}` : ''}`} {...rest}>
				<Codicon name={icon} spin={spin} />
			</button>
		);
	});

//#endregion

//#region Inputs

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { readonly icon?: CodiconName; readonly mono?: boolean; readonly invalid?: boolean; readonly suffix?: ReactNode }>(
	function Input({ icon, mono, invalid, suffix, className, ...rest }, ref) {
		const input = <input ref={ref} className={`input${mono ? ' mono' : ''}${invalid ? ' invalid' : ''}${className ? ` ${className}` : ''}`} spellCheck={false} autoComplete="off" {...rest} />;
		if (!icon && !suffix) {
			return input;
		}
		return (
			<div className="input-box">
				{icon ? <Codicon name={icon} /> : null}
				{input}
				{suffix ? <div className="input-suffix">{suffix}</div> : null}
			</div>
		);
	});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { readonly mono?: boolean }>(
	function TextArea({ mono, className, ...rest }, ref) {
		return <textarea ref={ref} className={`textarea${mono ? ' mono' : ''}${className ? ` ${className}` : ''}`} spellCheck={false} {...rest} />;
	});

/** A filter box that reports after typing settles. */
export function FilterInput({ value, onChange, placeholder = 'Filter' }: { readonly value: string; readonly onChange: (value: string) => void; readonly placeholder?: string }) {
	return <Input icon="filter" value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} onKeyDown={e => e.key === 'Escape' && onChange('')} />;
}

export function Field({ label, hint, error, optional, children }: { readonly label: ReactNode; readonly hint?: ReactNode; readonly error?: string; readonly optional?: boolean; readonly children: ReactNode }) {
	return (
		<label className="field">
			<span className="field-label">{label}{optional ? <span className="optional">optional</span> : null}</span>
			{children}
			{error ? <span className="input-msg error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
		</label>
	);
}

//#endregion

//#region Checkbox, radio

export function Checkbox({ checked, onChange, label, disabled, title }: { readonly checked: boolean; readonly onChange: (next: boolean) => void; readonly label?: ReactNode; readonly disabled?: boolean; readonly title?: string }) {
	return (
		<span role="checkbox" aria-checked={checked} aria-disabled={disabled} tabIndex={disabled ? -1 : 0} title={title}
			className={`checkbox${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}`}
			onClick={() => !disabled && onChange(!checked)}
			onKeyDown={e => { if (!disabled && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); onChange(!checked); } }}>
			<span className="checkbox-box"><Codicon name="check" /></span>
			{label ? <span className="checkbox-label">{label}</span> : null}
		</span>
	);
}

export function RadioGroup<T extends string>({ value, options, onChange }: { readonly value: T; readonly options: readonly { readonly id: T; readonly label: ReactNode; readonly detail?: ReactNode }[]; readonly onChange: (value: T) => void }) {
	return (
		<div className="radio-group" role="radiogroup">
			{options.map(o => (
				<span key={o.id} role="radio" aria-checked={value === o.id} tabIndex={0} className={`radio${value === o.id ? ' checked' : ''}`}
					onClick={() => onChange(o.id)} onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onChange(o.id); } }}>
					<span className="radio-dot" />
					<span className="radio-text"><span>{o.label}</span>{o.detail ? <span className="radio-detail">{o.detail}</span> : null}</span>
				</span>
			))}
		</div>
	);
}

/** Volt's switch (voltSettings' toggle): for a setting that is on or off. */
export function Toggle({ checked, onChange, label, disabled, title }: { readonly checked: boolean; readonly onChange: (next: boolean) => void; readonly label?: ReactNode; readonly disabled?: boolean; readonly title?: string }) {
	const button = <button type="button" role="switch" aria-checked={checked} aria-label={typeof label === 'string' ? label : title} title={title} disabled={disabled}
		className={`toggle${checked ? ' on' : ''}`} onClick={() => onChange(!checked)} />;
	return label ? <label className="toggle-label">{label}{button}</label> : button;
}

/** Volt's segmented control: two to four short, mutually exclusive choices. */
export function Segmented<T extends string>({ value, options, onChange, disabled }: { readonly value: T; readonly options: readonly { readonly value: T; readonly label: ReactNode; readonly icon?: CodiconName; readonly danger?: boolean; readonly title?: string }[]; readonly onChange: (value: T) => void; readonly disabled?: boolean }) {
	return (
		<div className="segmented" role="radiogroup">
			{options.map(o => (
				<button key={o.value} type="button" role="radio" aria-checked={o.value === value} disabled={disabled} title={o.title}
					className={`segment${o.value === value ? ' active' : ''}${o.danger ? ' danger' : ''}`} onClick={() => o.value !== value && onChange(o.value)}>
					{o.icon ? <Codicon name={o.icon} /> : null}{o.label}
				</button>
			))}
		</div>
	);
}

/** A radio group with a sentence per choice, drawn as cards. */
export function ChoiceGroup<T extends string>({ value, options, onChange, disabled }: { readonly value: T; readonly options: readonly { readonly id: T; readonly label: ReactNode; readonly detail?: ReactNode; readonly icon?: CodiconName }[]; readonly onChange: (value: T) => void; readonly disabled?: boolean }) {
	return (
		<div className="choices" role="radiogroup">
			{options.map(o => (
				<button key={o.id} type="button" role="radio" aria-checked={value === o.id} disabled={disabled} className={`choice${value === o.id ? ' checked' : ''}`} onClick={() => onChange(o.id)}>
					<span className="choice-title">
						<span className={`radio${value === o.id ? ' checked' : ''}`}><span className="radio-dot" /></span>
						{o.icon ? <Codicon name={o.icon} /> : null}{o.label}
					</span>
					{o.detail ? <span className="choice-detail">{o.detail}</span> : null}
				</button>
			))}
		</div>
	);
}

/** A number with its unit; empty means "no limit". */
export function NumberField({ value, onChange, placeholder = 'No limit', unit, min = 0, width, disabled }: { readonly value: number | undefined; readonly onChange: (value: number | undefined) => void; readonly placeholder?: string; readonly unit?: string; readonly min?: number; readonly width?: number; readonly disabled?: boolean }) {
	return (
		<span className="number-field">
			<Input type="number" min={min} value={value ?? ''} placeholder={placeholder} disabled={disabled} style={width ? { width } : undefined}
				onChange={e => onChange(e.target.value === '' ? undefined : Math.max(min, Number(e.target.value)))} />
			{unit ? <span className="unit">{unit}</span> : null}
		</span>
	);
}

//#endregion

//#region Select

export interface ISelectOption<T extends string> {
	readonly value: T;
	readonly label: string;
	readonly detail?: string;
	readonly disabled?: boolean;
}

/** VS Code's select box: a button showing the value; a keyboard-driven list below it. */
export function Select<T extends string>({ value, options, onChange, placeholder = 'Select…', compact, disabled, width, title }: {
	readonly value: T | undefined;
	readonly options: readonly ISelectOption<T>[];
	readonly onChange: (value: T) => void;
	readonly placeholder?: string;
	readonly compact?: boolean;
	readonly disabled?: boolean;
	readonly width?: number | string;
	readonly title?: string;
}) {
	const [open, setOpen] = useState(false);
	const [focus, setFocus] = useState(0);
	const ref = useRef<HTMLButtonElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const current = options.find(o => o.value === value);

	useEffect(() => {
		if (open) {
			setFocus(Math.max(0, options.findIndex(o => o.value === value)));
			requestAnimationFrame(() => listRef.current?.focus());
		}
	}, [open, options, value]);

	const pick = (o: ISelectOption<T> | undefined) => {
		if (o && !o.disabled) {
			onChange(o.value);
			setOpen(false);
			ref.current?.focus();
		}
	};
	const move = (delta: number) => {
		let i = focus;
		for (let n = 0; n < options.length; n++) {
			i = (i + delta + options.length) % options.length;
			if (!options[i].disabled) {
				break;
			}
		}
		setFocus(i);
	};
	const onListKey = (e: KeyboardEvent) => {
		if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
		else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
		else if (e.key === 'Home') { e.preventDefault(); setFocus(0); }
		else if (e.key === 'End') { e.preventDefault(); setFocus(options.length - 1); }
		else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(options[focus]); }
		else if (e.key === 'Tab') { setOpen(false); }
		else if (e.key.length === 1) {
			const i = options.findIndex((o, idx) => idx > focus && o.label.toLowerCase().startsWith(e.key.toLowerCase()));
			const j = i >= 0 ? i : options.findIndex(o => o.label.toLowerCase().startsWith(e.key.toLowerCase()));
			if (j >= 0) {
				setFocus(j);
			}
		}
	};
	const onButtonKey = (e: KeyboardEvent) => {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			setOpen(true);
		}
	};

	return (
		<>
			<button ref={ref} type="button" className={`select${compact ? ' compact' : ''}`} style={width !== undefined ? { width } : undefined} disabled={disabled} title={title}
				aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(o => !o)} onKeyDown={onButtonKey}>
				<span className={`select-value${current ? '' : ' placeholder'}`}>{current?.label ?? placeholder}</span>
				<Codicon name="chevron-down" />
			</button>
			<Popover anchor={ref} open={open} onClose={() => setOpen(false)} minWidth={Math.max(180, ref.current?.offsetWidth ?? 0)}>
				<div className="select-list" role="listbox" tabIndex={-1} ref={listRef} onKeyDown={onListKey}>
					{options.map((o, i) => (
						<button key={o.value} type="button" role="option" aria-selected={o.value === value} tabIndex={-1}
							className={`select-option${o.value === value ? ' checked' : ''}${i === focus ? ' focused' : ''}${o.disabled ? ' disabled' : ''}`}
							onMouseEnter={() => setFocus(i)} onClick={() => pick(o)}>
							<span className="select-option-label">{o.label}</span>
							{o.detail ? <span className="select-option-detail">{o.detail}</span> : <span className="spacer" />}
							<Codicon name="check" className="check" />
						</button>
					))}
				</div>
			</Popover>
		</>
	);
}

/** A multi-value list typed as tags (globs, domains, models). Enter or comma adds; Backspace removes. */
export function TagInput({ values, onChange, placeholder, suggestions }: { readonly values: readonly string[]; readonly onChange: (values: string[]) => void; readonly placeholder?: string; readonly suggestions?: readonly string[] }) {
	const [draft, setDraft] = useState('');
	const listId = useRef(`tags-${Math.random().toString(36).slice(2)}`).current;
	const add = (raw: string) => {
		const parts = raw.split(/[,\n]/).map(s => s.trim()).filter(Boolean).filter(s => !values.includes(s));
		if (parts.length) {
			onChange([...values, ...parts]);
		}
		setDraft('');
	};
	return (
		<div className="tag-input" onClick={e => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
			{values.map(v => (
				<span key={v} className="tag mono">
					{v}
					<button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter(x => x !== v))}><Codicon name="close" size={12} /></button>
				</span>
			))}
			<input value={draft} placeholder={values.length ? '' : placeholder} list={suggestions ? listId : undefined}
				onChange={e => e.target.value.includes(',') ? add(e.target.value) : setDraft(e.target.value)}
				onBlur={() => draft && add(draft)}
				onKeyDown={e => {
					if (e.key === 'Enter') { e.preventDefault(); add(draft); }
					else if (e.key === 'Backspace' && !draft && values.length) { onChange(values.slice(0, -1)); }
				}} />
			{suggestions ? <datalist id={listId}>{suggestions.filter(s => !values.includes(s)).map(s => <option key={s} value={s} />)}</datalist> : null}
		</div>
	);
}

//#endregion

//#region Small pieces

export function Tag({ children, tone, icon, mono, title }: { readonly children: ReactNode; readonly tone?: 'ok' | 'warn' | 'err' | 'info'; readonly icon?: CodiconName; readonly mono?: boolean; readonly title?: string }) {
	return <span className={`tag${tone ? ` ${tone}` : ''}${mono ? ' mono' : ''}`} title={title}>{icon ? <Codicon name={icon} /> : null}{children}</span>;
}

export function CountBadge({ count, tone }: { readonly count: number; readonly tone?: 'warn' | 'info' }) {
	return <span className={`count-badge${tone ? ` ${tone}` : ''}`}>{count > 999 ? '999+' : count}</span>;
}

export function Kbd({ children }: { readonly children: ReactNode }) {
	return <kbd className="kbd">{children}</kbd>;
}

/** A stable hue per name, so a person keeps their colour everywhere. */
function hueOf(name: string): number {
	let h = 0;
	for (let i = 0; i < name.length; i++) {
		h = (h * 31 + name.charCodeAt(i)) % 360;
	}
	return h;
}

export function Avatar({ name, large, small }: { readonly name: string; readonly large?: boolean; readonly small?: boolean }) {
	const initials = name.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('') || '?';
	return <span className={`avatar${large ? ' lg' : small ? ' sm' : ''}`} style={{ ['--hue' as string]: `hsl(${hueOf(name)} 58% 62%)` }} aria-hidden="true">{initials}</span>;
}

/** A person in a table or list: avatar and name, opening them when clickable. */
export function Person({ name, onOpen }: { readonly name: string; readonly onOpen?: () => void }) {
	const body = <><Avatar name={name} small /><span className="person-name">{name}</span></>;
	return onOpen
		? <button type="button" className="person" onClick={e => { e.stopPropagation(); onOpen(); }}>{body}</button>
		: <span className="person">{body}</span>;
}

export function Callout({ tone = 'info', icon, children, action }: { readonly tone?: 'info' | 'warn' | 'err' | 'ok'; readonly icon?: CodiconName; readonly children: ReactNode; readonly action?: ReactNode }) {
	const fallback: Record<string, CodiconName> = { info: 'info', warn: 'warning', err: 'error', ok: 'pass' };
	return <div className={`callout ${tone}`}><Codicon name={icon ?? fallback[tone]} /><div>{children}</div>{action ? <span className="callout-action">{action}</span> : null}</div>;
}

/** A quiet, centred empty state with an optional next step. */
export function EmptyState({ icon, title, children, actions }: { readonly icon?: CodiconName; readonly title: ReactNode; readonly children?: ReactNode; readonly actions?: ReactNode }) {
	return (
		<div className="empty-state">
			{icon ? <Codicon name={icon} /> : null}
			<div className="empty-state-title">{title}</div>
			{children ? <div className="empty-state-body">{children}</div> : null}
			{actions ? <div className="btn-group">{actions}</div> : null}
		</div>
	);
}

/** A secret shown once, with copy. */
export function SecretBox({ value, label = 'Copy' }: { readonly value: string; readonly label?: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="secret-box">
			<code>{value}</code>
			<Action icon={copied ? 'check' : 'copy'} label={copied ? 'Copied' : label} onClick={() => {
				void navigator.clipboard.writeText(value).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				});
			}} />
		</div>
	);
}

export function CopyAction({ value, label = 'Copy' }: { readonly value: string; readonly label?: string }) {
	const [copied, setCopied] = useState(false);
	return <Action icon={copied ? 'check' : 'copy'} label={copied ? 'Copied' : label} onClick={e => {
		e.stopPropagation();
		void navigator.clipboard.writeText(value).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	}} />;
}

//#endregion
