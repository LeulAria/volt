/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Volt UI kit, built into every agent page (html_render / html_preview): a few tags and
 * attributes that would otherwise cost an agent hundreds of lines and several preview rounds.
 *
 * - `<volt-device type="iphone|android|tablet|browser|window">`: a device frame around app markup.
 * - `<volt-flow>`: a Figma-style canvas of screens, with prototype arrows from `data-next`.
 * - `data-screens` / `data-screen` / `data-go` / `data-back`: clickable prototypes with transitions.
 * - `data-enter`: entrance motion, staggered by `--i`.
 * - Option-click any element to point at it: the agent reads it as `userPointedAt` in the page
 *   state, with the screen the user is on, so "make this bigger" means exactly that element.
 *
 * `voltKitRuntime` is self-contained (no imports): pages get it as source, like the charts engine.
 */

export const KIT_GUIDE = [
	'UI kit (built in; a few tags instead of hundreds of lines). <volt-device type="iphone|android|tablet|browser|window" width="260" label="Sign in" dark bare fullbleed url="acme.com" name="Notes" height="420"> draws a finished device frame (status bar at 9:41, Dynamic Island, home indicator, a scrolling screen) around your app markup; the screen has its own light theme (`dark` flips it, `bare` drops the bezel for a Figma-frame look, `fullbleed` runs content under the status bar). browser/window are desktop windows with traffic lights and a URL or name.',
	'<volt-flow device-width="210"> lays devices out on a dotted canvas and draws prototype arrows from any element with data-next="<id of a device or element>" to it; use it for user flows, onboarding and before/after.',
	'Clickable prototypes: a container with data-screens holds <section data-screen="home">...</section> siblings (the first shows); any element with data-go="details" pushes that screen with an iOS transition (data-transition="fade|up|none"), data-back pops. data-enter fades an element up on load (style="--i:2" staggers).',
	'Give main parts stable ids. The user can Option-click any element to point at it; you receive it (selector, text, markup, screen) as userPointedAt in <volt_page_state> with currentScreens, so change exactly that element next turn.',
].join(' ');

/** Light-DOM styles for the kit; shadow styles live with each device. */
export const KIT_CSS = `
volt-device{display:inline-flex;vertical-align:top}
volt-device:not(:defined){visibility:hidden}
volt-flow{position:relative;display:flex;flex-wrap:wrap;justify-content:center;align-items:flex-start;gap:var(--flow-gap,44px 52px);padding:32px 24px;border-radius:var(--radius);background:radial-gradient(circle,color-mix(in srgb,var(--foreground) 14%,transparent) 1px,transparent 1.4px) 0 0/18px 18px}
volt-flow>svg.volt-flow-links{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;z-index:5}
.volt-flow-links path.link{fill:none;stroke:var(--accent);stroke-width:1.5;stroke-linecap:round;opacity:.8;transition:stroke-width .15s,opacity .15s}
.volt-flow-links path.link.hot{stroke-width:2.5;opacity:1}
.volt-flow-links circle{fill:var(--accent)}
[data-screens]{position:relative}
[data-screens]>[data-screen]:not(.volt-on){display:none}
[data-go],[data-back],volt-flow [data-next]{cursor:pointer}
@keyframes volt-push{from{transform:translateX(28%);opacity:0}}
@keyframes volt-pop{from{transform:translateX(-22%);opacity:0}}
@keyframes volt-up{from{transform:translateY(14%);opacity:0}}
@keyframes volt-fade{from{opacity:0}}
@keyframes volt-enter{from{transform:translateY(10px);opacity:0;filter:blur(4px)}}
@keyframes volt-focus{40%{transform:scale(1.03)}}
.volt-in-push{animation:volt-push .38s cubic-bezier(.32,.72,0,1) both}
.volt-in-pop{animation:volt-pop .38s cubic-bezier(.32,.72,0,1) both}
.volt-in-up{animation:volt-up .42s cubic-bezier(.32,.72,0,1) both}
.volt-in-fade{animation:volt-fade .25s ease both}
.volt-flow-focus{animation:volt-focus .6s cubic-bezier(.32,.72,0,1)}
[data-enter]{animation:volt-enter .6s cubic-bezier(.2,.8,.2,1) both;animation-delay:calc(var(--i,0) * 70ms)}
.volt-still [data-enter]{animation:none}
@media (prefers-reduced-motion:reduce){[data-enter],.volt-in-push,.volt-in-pop,.volt-in-up,.volt-in-fade,.volt-flow-focus{animation:none}}
.volt-pick-box{position:fixed;z-index:2147483647;pointer-events:none;border:1.5px solid var(--accent);border-radius:4px;background:color-mix(in srgb,var(--accent) 10%,transparent)}
.volt-pick-tag{position:absolute;left:-1.5px;bottom:100%;margin-bottom:4px;padding:2px 7px;border-radius:5px;background:var(--accent);color:var(--accent-foreground);font:500 11px/16px var(--font-sans);white-space:nowrap}
.volt-picked{outline:2px solid var(--accent)!important;outline-offset:2px}
`;

interface IKitPageApi {
	preview?: boolean;
	still?: boolean;
	setContext(value: unknown): void;
	prompt(text: string): void;
}

interface IPointedAt {
	selector: string;
	element: string;
	text?: string;
	html: string;
	screen?: string;
	device?: string;
}

export function voltKitRuntime(win: Window & typeof globalThis): void {
	const doc = win.document;
	const volt = (win as unknown as { volt?: IKitPageApi }).volt;
	if (!volt || win.customElements.get('volt-device')) {
		return;
	}
	const still = !!(volt.preview || volt.still);
	if (still) {
		doc.documentElement.classList.add('volt-still');
	}
	const NS = 'http://www.w3.org/2000/svg';
	const esc = (value: string) => value.replace(/[&<>"]/g, c => c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');

	//#region Devices

	const PHONES: Record<string, { w: number; h: number; radius: number; bezel: number; bar: number; width: number; cut: string; home: number }> = {
		iphone: { w: 390, h: 844, radius: 55, bezel: 11, bar: 54, width: 260, cut: '<div class="island"></div>', home: 134 },
		android: { w: 412, h: 892, radius: 40, bezel: 9, bar: 40, width: 260, cut: '<div class="hole"></div>', home: 108 },
		tablet: { w: 820, h: 1180, radius: 38, bezel: 18, bar: 30, width: 440, cut: '', home: 160 },
	};
	const LIGHT = '--foreground:#0b0b0c;--card-foreground:#0b0b0c;--muted-foreground:#6e6e73;--background:#fff;--card:#f5f5f7;--muted:rgb(0 0 0/.05);--secondary:rgb(0 0 0/.05);--border:rgb(0 0 0/.1);--input:#fff;--primary:#0b0b0c;--primary-foreground:#fff;--code-foreground:#0b0b0c;color-scheme:light;background:#fff;color:#0b0b0c';
	const DARK = '--foreground:#f5f5f7;--card-foreground:#f5f5f7;--muted-foreground:#98989f;--background:#000;--card:#1c1c1e;--muted:rgb(255 255 255/.08);--secondary:rgb(255 255 255/.08);--border:rgb(255 255 255/.12);--input:#1c1c1e;--primary:#f5f5f7;--primary-foreground:#000;--code-foreground:#f5f5f7;color-scheme:dark;background:#000;color:#f5f5f7';
	const STATUS_ICONS = '<svg width="17" height="11" viewBox="0 0 17 11"><rect y="7" width="3" height="4" rx="1"/><rect x="4.6" y="5" width="3" height="6" rx="1"/><rect x="9.2" y="2.5" width="3" height="8.5" rx="1"/><rect x="13.8" width="3" height="11" rx="1"/></svg>'
		+ '<svg width="15" height="11" viewBox="0 0 15 11"><path d="M7.5 2.3c2.1 0 4 .8 5.4 2.1l1.2-1.2A9.4 9.4 0 0 0 7.5.6C5 .6 2.6 1.6.9 3.2l1.2 1.2a7.7 7.7 0 0 1 5.4-2.1Zm0 3.3c1.2 0 2.3.4 3.1 1.2l1.2-1.2a6.4 6.4 0 0 0-8.6 0l1.2 1.2c.8-.8 1.9-1.2 3.1-1.2Zm0 3.2L5.7 10.6 7.5 11l1.8-.4-1.8-1.8Z"/></svg>'
		+ '<svg width="25" height="12" viewBox="0 0 25 12"><rect x=".5" y=".5" width="21" height="11" rx="3.5" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="18" height="8" rx="2"/><path d="M23 4v4a2 2 0 0 0 0-4Z" opacity=".4"/></svg>';

	class VoltDevice extends win.HTMLElement {
		static get observedAttributes() { return ['type', 'width', 'height', 'label', 'dark', 'bare', 'fullbleed', 'url', 'name', 'time', 'background']; }
		private root: ShadowRoot | undefined;

		connectedCallback() {
			this.render();
		}

		attributeChangedCallback() {
			if (this.root) {
				this.render();
			}
		}

		/** The frame's box (without the label), for flow arrows. */
		frameRect(): DOMRect {
			return (this.root?.querySelector('.frame') ?? this).getBoundingClientRect();
		}

		private render() {
			const root = this.root ??= this.attachShadow({ mode: 'open' });
			const type = (this.getAttribute('type') || 'iphone').toLowerCase();
			const dark = this.hasAttribute('dark');
			const label = this.getAttribute('label');
			const background = this.getAttribute('background');
			const fg = dark ? '#f5f5f7' : '#0b0b0c';
			const labelHtml = label ? `<div class="label" part="label">${esc(label)}</div>` : '';
			const screen = `${dark ? DARK : LIGHT}${background ? `;background:${background.replace(/[;{}<>]/g, '')}` : ''}`;
			const phone = PHONES[type === 'ipad' ? 'tablet' : type === 'phone' ? 'iphone' : type];
			if (!phone) {
				const height = Number(this.getAttribute('height')) || 420;
				const width = Number(this.getAttribute('width'));
				const browser = type !== 'window';
				const bar = browser
					? `<div class="url">${esc(this.getAttribute('url') || 'localhost:3000')}</div>`
					: `<div class="name">${esc(this.getAttribute('name') || '')}</div>`;
				root.innerHTML = `<style>
:host{display:${width ? 'inline-flex' : 'flex'};flex-direction:column;gap:10px;vertical-align:top;${width ? `width:${width}px` : 'width:100%'}}
.label{font:500 12px/16px var(--font-sans);color:var(--muted-foreground)}
.frame{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px var(--border),0 22px 44px -22px rgb(0 0 0/.4);${screen}}
.bar{display:flex;align-items:center;gap:10px;height:38px;padding:0 12px;border-bottom:1px solid ${dark ? 'rgb(255 255 255/.08)' : 'rgb(0 0 0/.08)'};background:${dark ? '#1f1f21' : '#f3f3f4'}}
.dots{display:flex;gap:7px;width:47px}.dots i{width:11px;height:11px;border-radius:50%;background:#ff5f57}.dots i:nth-child(2){background:#febc2e}.dots i:nth-child(3){background:#28c840}
.url{flex:1;max-width:440px;margin:0 auto;height:24px;padding:0 10px;border-radius:7px;background:${dark ? 'rgb(255 255 255/.07)' : '#fff'};box-shadow:${dark ? 'none' : '0 0 0 1px rgb(0 0 0/.06)'};font:12px/24px var(--font-sans);text-align:center;color:${dark ? '#98989f' : '#6e6e73'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.name{flex:1;text-align:center;font:600 12.5px/1 var(--font-sans);color:${fg}}
.end{width:47px}
.content{position:relative;height:${height}px;overflow:auto;scrollbar-width:thin}
</style>${labelHtml}<div class="frame" part="frame"><div class="bar"><span class="dots"><i></i><i></i><i></i></span>${bar}<span class="end"></span></div><div class="content" part="content screen"><slot></slot></div></div>`;
				requestLinks();
				return;
			}
			const bare = this.hasAttribute('bare');
			const bezel = bare ? 0 : phone.bezel;
			const flow = this.closest('volt-flow');
			const width = Number(this.getAttribute('width')) || Number(flow?.getAttribute('device-width')) || phone.width;
			const top = this.hasAttribute('fullbleed') ? 0 : phone.bar;
			root.innerHTML = `<style>
:host{display:inline-flex;flex-direction:column;gap:10px;vertical-align:top}
.label{font:500 12px/16px var(--font-sans);color:var(--muted-foreground);padding-left:2px}
.frame{zoom:${width / (phone.w + bezel * 2)};position:relative;box-sizing:border-box;width:${phone.w + bezel * 2}px;height:${phone.h + bezel * 2}px;padding:${bezel}px;border-radius:${phone.radius + bezel}px;background:#0b0b0c;box-shadow:inset 0 0 0 1.5px #3a3a3f,0 0 0 1px color-mix(in srgb,var(--foreground) 12%,transparent),0 40px 80px -30px rgb(0 0 0/.45)}
.frame.bare{background:none;box-shadow:0 0 0 1.5px var(--border),0 30px 60px -30px rgb(0 0 0/.3)}
.screen{position:relative;width:100%;height:100%;overflow:hidden;border-radius:${phone.radius}px;${screen}}
.status{position:absolute;z-index:3;top:0;left:0;right:0;height:${phone.bar}px;display:flex;align-items:center;justify-content:space-between;box-sizing:border-box;padding:${type === 'iphone' || type === 'phone' ? '2px 30px 0 46px' : '0 24px'};font:600 ${type === 'tablet' || type === 'ipad' ? 13 : 16}px/1 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:${fg};pointer-events:none}
.icons{display:flex;gap:6px;align-items:center}.icons svg{fill:currentColor}
.island{position:absolute;z-index:4;left:50%;top:11px;width:122px;height:35px;margin-left:-61px;border-radius:18px;background:#000}
.hole{position:absolute;z-index:4;left:50%;top:11px;width:19px;height:19px;margin-left:-9.5px;border-radius:50%;background:#000}
.content{position:absolute;inset:${top}px 0 0;overflow:auto;scrollbar-width:none}
.content::-webkit-scrollbar{display:none}
.home{position:absolute;z-index:3;left:50%;bottom:8px;width:${phone.home}px;height:5px;margin-left:-${phone.home / 2}px;border-radius:3px;background:${fg};opacity:.85;pointer-events:none}
</style>${labelHtml}<div class="frame${bare ? ' bare' : ''}" part="frame"><div class="screen" part="screen"><div class="status"><span>${esc(this.getAttribute('time') || '9:41')}</span><span class="icons">${STATUS_ICONS}</span></div>${bare ? '' : phone.cut}<div class="content" part="content"><slot></slot></div><div class="home"></div></div></div>`;
			requestLinks();
		}
	}
	win.customElements.define('volt-device', VoltDevice);

	//#endregion

	//#region Flows

	let linkFrame = 0;
	const sourceLinks = new Map<Element, SVGPathElement[]>();
	const observer = new win.ResizeObserver(() => requestLinks());
	const observed = new WeakSet<Element>();

	function requestLinks() {
		if (!linkFrame) {
			linkFrame = win.requestAnimationFrame(() => {
				linkFrame = 0;
				sourceLinks.clear();
				doc.querySelectorAll('volt-flow').forEach((flow, index) => drawLinks(flow as HTMLElement, index));
			});
		}
	}

	function rectOf(element: Element): DOMRect {
		return element instanceof VoltDevice ? element.frameRect() : element.getBoundingClientRect();
	}

	function linkPath(a: DOMRect, b: DOMRect, o: DOMRect): string {
		const ax = a.left + a.width / 2 - o.left, ay = a.top + a.height / 2 - o.top;
		const bx = b.left + b.width / 2 - o.left, by = b.top + b.height / 2 - o.top;
		if (b.left >= a.right || b.right <= a.left) {
			const dir = bx > ax ? 1 : -1;
			const x1 = (dir > 0 ? a.right : a.left) - o.left;
			const x2 = (dir > 0 ? b.left - 3 : b.right + 3) - o.left;
			const y2 = Math.max(b.top - o.top + 28, Math.min(b.bottom - o.top - 28, ay));
			const bend = Math.max(32, Math.abs(x2 - x1) / 2);
			return `M${x1} ${ay}C${x1 + dir * bend} ${ay} ${x2 - dir * bend} ${y2} ${x2} ${y2}`;
		}
		const dir = by > ay ? 1 : -1;
		const y1 = (dir > 0 ? a.bottom : a.top) - o.top;
		const y2 = (dir > 0 ? b.top - 3 : b.bottom + 3) - o.top;
		const bend = Math.max(32, Math.abs(y2 - y1) / 2);
		return `M${ax} ${y1}C${ax} ${y1 + dir * bend} ${bx} ${y2 - dir * bend} ${bx} ${y2}`;
	}

	function drawLinks(flow: HTMLElement, index: number) {
		if (!observed.has(flow)) {
			observed.add(flow);
			observer.observe(flow);
		}
		let svg = flow.querySelector(':scope > svg.volt-flow-links') as SVGSVGElement | null;
		if (!svg) {
			svg = doc.createElementNS(NS, 'svg');
			svg.classList.add('volt-flow-links');
			flow.appendChild(svg);
		}
		const marker = `volt-arrow-${index}`;
		const box = flow.getBoundingClientRect();
		let markup = `<defs><marker id="${marker}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1.5 1.5 8 5 1.5 8.5" style="fill:none;stroke:var(--accent);stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round"/></marker></defs>`;
		const sources: [Element, number][] = [];
		let count = 0;
		flow.querySelectorAll('[data-next]').forEach(source => {
			const from = source.getBoundingClientRect();
			if (!from.width && !from.height) {
				return;
			}
			for (const id of (source.getAttribute('data-next') || '').split(/[\s,]+/)) {
				const target = id ? doc.getElementById(id) : null;
				if (!target || target === source || target.contains(source) || !flow.contains(target)) {
					continue;
				}
				const to = rectOf(target);
				const from2 = source instanceof VoltDevice ? source.frameRect() : from;
				markup += `<path class="link" d="${linkPath(from2, to, box)}" marker-end="url(#${marker})"/>`;
				if (!(source instanceof VoltDevice)) {
					markup += `<circle cx="${(to.left > from2.right ? from2.right : to.right < from2.left ? from2.left : from2.left + from2.width / 2) - box.left}" cy="${(to.left > from2.right || to.right < from2.left ? from2.top + from2.height / 2 : to.top > from2.bottom ? from2.bottom : from2.top) - box.top}" r="3"/>`;
				}
				sources.push([source, count++]);
			}
		});
		svg.innerHTML = markup;
		const paths = svg.querySelectorAll('path.link');
		for (const [source, at] of sources) {
			const list = sourceLinks.get(source) ?? [];
			list.push(paths[at] as SVGPathElement);
			sourceLinks.set(source, list);
		}
	}

	doc.addEventListener('mouseover', event => {
		const source = (event.target as Element).closest?.('[data-next]');
		sourceLinks.forEach((paths, element) => paths.forEach(path => path.classList.toggle('hot', element === source)));
	});

	//#endregion

	//#region Prototypes

	const stacks = new WeakMap<Element, string[]>();
	const current = new Map<string, string>();

	function screensOf(container: Element): HTMLElement[] {
		return Array.from(container.children).filter(child => child.hasAttribute('data-screen')) as HTMLElement[];
	}

	function stackOf(container: Element): string[] {
		let stack = stacks.get(container);
		if (!stack) {
			const screens = screensOf(container);
			const first = screens.find(screen => screen.classList.contains('volt-on') || screen.hasAttribute('data-start')) ?? screens[0];
			stack = first ? [first.getAttribute('data-screen')!] : [];
			first?.classList.add('volt-on');
			stacks.set(container, stack);
		}
		return stack;
	}

	function show(container: Element, id: string, how: string) {
		const screens = screensOf(container);
		const next = screens.find(screen => screen.getAttribute('data-screen') === id);
		if (!next) {
			return;
		}
		for (const screen of screens) {
			screen.classList.remove('volt-in-push', 'volt-in-pop', 'volt-in-up', 'volt-in-fade');
			screen.classList.toggle('volt-on', screen === next);
		}
		if (how !== 'none' && !still) {
			void next.offsetWidth;
			next.classList.add(`volt-in-${how === 'slide' ? 'push' : how}`);
		}
		(next.closest('volt-device')?.shadowRoot?.querySelector('.content') as HTMLElement | null)?.scrollTo(0, 0);
		const device = container.closest('volt-device');
		current.set(device?.getAttribute('label') || device?.id || container.id || selectorOf(container), id);
		flush();
		requestLinks();
		win.setTimeout(requestLinks, 450);
	}

	function containerFor(trigger: Element, id: string): Element | null {
		const has = (container: Element) => screensOf(container).some(screen => screen.getAttribute('data-screen') === id);
		let container = trigger.closest('[data-screens]');
		while (container && !has(container)) {
			container = container.parentElement?.closest('[data-screens]') ?? null;
		}
		return container ?? Array.from(doc.querySelectorAll('[data-screens]')).find(has) ?? null;
	}

	function init() {
		doc.querySelectorAll('[data-screens]').forEach(stackOf);
		requestLinks();
	}

	doc.addEventListener('click', event => {
		if (event.altKey || event.defaultPrevented) {
			return;
		}
		const target = event.target as Element;
		const back = target.closest?.('[data-back]');
		const go = target.closest?.('[data-go]');
		if (go && (!back || go.contains(back))) {
			const id = go.getAttribute('data-go') || '';
			const container = containerFor(go, id);
			if (container) {
				event.preventDefault();
				const stack = stackOf(container);
				if (stack[stack.length - 1] !== id) {
					stack.push(id);
					show(container, id, go.getAttribute('data-transition') || container.getAttribute('data-transition') || 'push');
				}
				return;
			}
		}
		if (back) {
			const container = back.closest('[data-screens]');
			const stack = container ? stackOf(container) : [];
			if (container && stack.length > 1) {
				event.preventDefault();
				stack.pop();
				const how = back.getAttribute('data-transition') || container.getAttribute('data-transition') || 'push';
				show(container, stack[stack.length - 1], how === 'push' || how === 'slide' ? 'pop' : how);
			}
			return;
		}
		// In a flow, a hotspot without a prototype screen focuses the screen it points to.
		const source = target.closest?.('volt-flow [data-next]');
		const next = source && doc.getElementById((source.getAttribute('data-next') || '').split(/[\s,]+/)[0]);
		if (next && !still) {
			next.classList.remove('volt-flow-focus');
			void (next as HTMLElement).offsetWidth;
			next.classList.add('volt-flow-focus');
			next.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
		}
	});

	//#endregion

	//#region Pointing at elements (Option-click)

	const send = volt.setContext.bind(volt);
	let own: string | undefined;
	let refs: IPointedAt[] = [];

	function flush() {
		if (!refs.length && !current.size) {
			if (own !== undefined) {
				send(own);
			}
			return;
		}
		let pageState: unknown = own;
		try {
			pageState = own !== undefined ? JSON.parse(own) : undefined;
		} catch { /* a plain string */ }
		send(JSON.stringify({
			...(pageState !== undefined ? { pageState } : {}),
			...(current.size ? { currentScreens: Object.fromEntries(current) } : {}),
			...(refs.length ? { userPointedAt: refs } : {}),
		}));
	}

	volt.setContext = (value: unknown) => {
		own = typeof value === 'string' ? value : JSON.stringify(value);
		flush();
	};

	function selectorOf(element: Element): string {
		const parts: string[] = [];
		let node: Element | null = element;
		while (node && node !== doc.body && node !== doc.documentElement && parts.length < 6) {
			if (node.id) {
				parts.unshift(`#${win.CSS.escape(node.id)}`);
				break;
			}
			const screen = node.getAttribute('data-screen');
			if (screen) {
				parts.unshift(`[data-screen="${screen}"]`);
				break;
			}
			const parent: Element | null = node.parentElement;
			const name = node.localName;
			const same = parent ? Array.from(parent.children).filter(child => child.localName === name) : [];
			parts.unshift(same.length > 1 ? `${name}:nth-of-type(${same.indexOf(node) + 1})` : name);
			node = parent;
		}
		return parts.join(' > ');
	}

	function describe(element: Element): string {
		const classes = Array.from(element.classList).filter(name => !name.startsWith('volt-')).slice(0, 2).map(name => `.${name}`).join('');
		const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
		return `${element.localName}${element.id ? `#${element.id}` : classes}${text ? ` "${text.length > 32 ? `${text.slice(0, 32)}…` : text}"` : ''}`;
	}

	let box: HTMLElement | undefined;

	function highlight(element: Element | undefined) {
		if (!element || element === doc.body || element === doc.documentElement) {
			box?.remove();
			box = undefined;
			return;
		}
		if (!box) {
			box = doc.createElement('div');
			box.className = 'volt-pick-box';
			box.appendChild(doc.createElement('span')).className = 'volt-pick-tag';
			doc.body.appendChild(box);
		}
		const rect = element.getBoundingClientRect();
		Object.assign(box.style, { left: `${rect.left - 2}px`, top: `${rect.top - 2}px`, width: `${rect.width + 4}px`, height: `${rect.height + 4}px` });
		(box.firstChild as HTMLElement).textContent = describe(element);
	}

	if (!volt.preview) {
		doc.addEventListener('mousemove', event => highlight(event.altKey ? event.target as Element : undefined), true);
		win.addEventListener('keyup', event => event.key === 'Alt' && highlight(undefined));
		win.addEventListener('blur', () => highlight(undefined));
		doc.addEventListener('click', event => {
			if (!event.altKey) {
				return;
			}
			const element = event.target as Element;
			if (!element || element === doc.body || element === doc.documentElement) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
			const device = element.closest('volt-device');
			const ref: IPointedAt = {
				selector: selectorOf(element),
				element: describe(element),
				...(text ? { text: text.slice(0, 200) } : {}),
				html: element.outerHTML.replace(/\s+/g, ' ').slice(0, 1200),
				...(element.closest('[data-screen]') ? { screen: element.closest('[data-screen]')!.getAttribute('data-screen')! } : {}),
				...(device ? { device: device.getAttribute('label') || device.id || device.getAttribute('type') || 'device' } : {}),
			};
			refs = [ref, ...refs.filter(other => other.selector !== ref.selector)].slice(0, 6);
			flush();
			element.classList.add('volt-picked');
			win.setTimeout(() => element.classList.remove('volt-picked'), 1200);
			volt.prompt(`About ${ref.element}${ref.device ? ` in ${ref.device}` : ''}: `);
		}, true);
	}

	//#endregion

	if (doc.readyState === 'loading') {
		doc.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
	win.addEventListener('load', requestLinks);
	doc.fonts?.ready.then(requestLinks);
}
