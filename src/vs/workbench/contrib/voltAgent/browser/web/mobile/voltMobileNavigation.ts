/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The phone's bottom navigation: a row of destinations (Chat, Projects, Editor, Terminal, More)
// under the workbench, above the home indicator. Features add destinations through
// `VoltMobileDestinations.register`; each says how to open itself and when it is the one on screen,
// so the bar never needs to know about a feature to show it.

import { $, addDisposableListener, append, getWindow } from '../../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { voltHaptic } from '../../../../../../base/browser/ui/voltMobile/voltTouchFeedback.js';
import { VoltFormFactor, VoltViewport } from '../../../../../../base/browser/ui/voltMobile/voltViewport.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { ContextKeyExpression, IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';

export interface IVoltMobileDestination {
	readonly id: string;
	readonly label: string;
	readonly icon: ThemeIcon;
	/** Left to right. */
	readonly order: number;
	/** Listed only while this holds. */
	readonly when?: ContextKeyExpression;
	/** Brings the destination on screen. */
	open(accessor: ServicesAccessor): void | Promise<void>;
	/** Whether the workbench shows this destination now; the first active one in order is highlighted. */
	isActive(accessor: ServicesAccessor): boolean;
}

class VoltMobileDestinationRegistry {

	private readonly destinations = new Map<string, IVoltMobileDestination>();
	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;
	private readonly _onDidChangeActive = new Emitter<void>();
	/** A destination's surface opened or closed in a way the bar cannot observe (a page of its own). */
	readonly onDidChangeActive: Event<void> = this._onDidChangeActive.event;

	register(destination: IVoltMobileDestination): IDisposable {
		this.destinations.set(destination.id, destination);
		this._onDidChange.fire();
		return toDisposable(() => {
			if (this.destinations.get(destination.id) === destination) {
				this.destinations.delete(destination.id);
				this._onDidChange.fire();
			}
		});
	}

	getAll(): IVoltMobileDestination[] {
		return [...this.destinations.values()].sort((a, b) => a.order - b.order);
	}

	/** Asks the bar to read which destination is active again. */
	notifyActiveChanged(): void {
		this._onDidChangeActive.fire();
	}
}

export const VoltMobileDestinations = new VoltMobileDestinationRegistry();

/** The bar's height, safe area excluded: with labels in portrait, icons only on a phone on its side. */
const BAR_HEIGHT = 56;
const BAR_HEIGHT_LANDSCAPE = 44;

export class VoltMobileNavigationBar extends Disposable {

	private readonly element: HTMLElement;
	private readonly rendered = this._register(new DisposableStore());
	private readonly buttons = new Map<string, HTMLButtonElement>();
	private shown: IVoltMobileDestination[] = [];
	private active: string | undefined;
	/** A tap shows its destination as active at once; reads wait until its open has run. */
	private pending: string | undefined;
	private frame: number | undefined;

	constructor(
		private readonly root: HTMLElement,
		private readonly viewport: VoltViewport,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.element = append(root, $('nav.volt-mobile-nav'));
		this.element.setAttribute('aria-label', localize('voltMobile.nav', "Primary Navigation"));
		this._register(toDisposable(() => this.element.remove()));

		this._register(VoltMobileDestinations.onDidChange(() => this.render()));
		this._register(VoltMobileDestinations.onDidChangeActive(() => this.scheduleActive()));
		this._register(contextKeyService.onDidChangeContext(e => {
			const keys = new Set<string>();
			for (const destination of VoltMobileDestinations.getAll()) {
				for (const key of destination.when?.keys() ?? []) {
					keys.add(key);
				}
			}
			if (keys.size && e.affectsSome(keys)) {
				this.render();
			}
		}));
		this._register(viewport.onDidChange(() => this.syncHeight()));
		// Drawers, pages, panels and layouts all show as classes on the workbench.
		const observer = new MutationObserver(() => this.scheduleActive());
		observer.observe(root, { attributes: true, attributeFilter: ['class'] });
		this._register(toDisposable(() => observer.disconnect()));
		this._register(toDisposable(() => {
			if (this.frame !== undefined) {
				getWindow(root).cancelAnimationFrame(this.frame);
			}
		}));

		this.render();
		this.syncHeight();
	}

	/** Reads which destination is on screen again on the next frame. */
	scheduleActive(): void {
		if (this.frame === undefined) {
			this.frame = getWindow(this.root).requestAnimationFrame(() => {
				this.frame = undefined;
				this.updateActive();
			});
		}
	}

	private render(): void {
		this.rendered.clear();
		this.buttons.clear();
		this.element.replaceChildren();
		this.shown = VoltMobileDestinations.getAll().filter(d => !d.when || this.contextKeyService.contextMatchesRules(d.when));
		for (const destination of this.shown) {
			const button = append(this.element, $('button.volt-mobile-nav-item')) as HTMLButtonElement;
			button.type = 'button';
			button.dataset.destination = destination.id;
			button.setAttribute('aria-label', destination.label);
			append(button, $('span.volt-mobile-nav-indicator.volt-ripple-host')).appendChild(renderIcon(destination.icon));
			append(button, $('span.volt-mobile-nav-label')).textContent = destination.label;
			this.rendered.add(addDisposableListener(button, 'click', () => this.open(destination)));
			this.buttons.set(destination.id, button);
		}
		this.element.style.setProperty('--volt-mobile-nav-count', String(this.shown.length));
		this.updateActive();
	}

	private async open(destination: IVoltMobileDestination): Promise<void> {
		voltHaptic('tick');
		this.pending = destination.id;
		this.setActive(destination.id);
		try {
			await this.instantiationService.invokeFunction(accessor => destination.open(accessor));
		} catch (error) {
			this.logService.error(`[volt mobile] opening ${destination.id} failed`, error);
		} finally {
			if (this.pending === destination.id) {
				this.pending = undefined;
			}
			this.scheduleActive();
		}
	}

	private updateActive(): void {
		if (this.pending) {
			return;
		}
		const active = this.instantiationService.invokeFunction(accessor => this.shown.find(d => {
			try {
				return d.isActive(accessor);
			} catch {
				return false;
			}
		}));
		this.setActive(active?.id);
	}

	private setActive(id: string | undefined): void {
		if (id === this.active) {
			return;
		}
		this.active = id;
		for (const [key, button] of this.buttons) {
			const on = key === id;
			button.classList.toggle('active', on);
			if (on) {
				button.setAttribute('aria-current', 'page');
			} else {
				button.removeAttribute('aria-current');
			}
		}
	}

	private syncHeight(): void {
		const s = this.viewport.state;
		const visible = s.formFactor === VoltFormFactor.Phone && !s.keyboardOpen && this.shown.length > 0;
		this.element.classList.toggle('hidden', !visible);
		const bar = s.landscape ? BAR_HEIGHT_LANDSCAPE : BAR_HEIGHT;
		this.root.style.setProperty('--volt-mobile-nav-height', `${bar}px`);
		this.viewport.setBottomBar(visible ? bar + s.safe.bottom : 0);
	}
}
