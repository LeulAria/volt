/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Small web apps for the `browser_act` benchmark and reliability tests. Each one behaves like a
 * real app where it matters to an agent: shared site chrome, async "network" (a fake fetch with
 * latency, which Volt's runtime sees as a request), renders that land after the click, keyed DOM
 * updates, repeated controls that only differ by their row, custom widgets, and dialogs.
 */

const CHROME_TOP = `<header><nav aria-label="Main"><a href="#/">Home</a> <a href="#/product">Product</a> <a href="#/pricing">Pricing</a> <a href="#/customers">Customers</a> <a href="#/docs">Docs</a> <a href="#/blog">Blog</a> <a href="#/changelog">Changelog</a> <a href="#/support">Support</a> <button aria-label="Open menu">☰</button> <input type="search" aria-label="Search site" placeholder="Search"></nav></header>`;

const CHROME_BOTTOM = `<footer><h2>Company</h2><ul><li><a href="#/about">About</a></li><li><a href="#/careers">Careers</a></li><li><a href="#/press">Press</a></li><li><a href="#/contact">Contact</a></li></ul>
<h2>Resources</h2><ul><li><a href="#/guides">Guides</a></li><li><a href="#/api">API reference</a></li><li><a href="#/status">Status</a></li><li><a href="#/security">Security</a></li></ul>
<h2>Legal</h2><ul><li><a href="#/terms">Terms</a></li><li><a href="#/privacy">Privacy</a></li><li><a href="#/cookies">Cookies</a></li></ul><p>© 2026 Acme Inc. All rights reserved.</p></footer>`;

/** A fetch with latency: `api(path, body)` resolves after `ms` with canned JSON. */
const FAKE_API = `<script>
window.fetch = (url, init) => new Promise(resolve => setTimeout(() => resolve(new Response(JSON.stringify(window.API && window.API[String(url)] || {}), { status: 200, headers: { 'Content-Type': 'application/json' } })), window.API_MS || 250));
</script>`;

function page(title: string, body: string, script: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:14px system-ui;margin:16px} [hidden]{display:none!important} .toast{position:fixed;bottom:16px;right:16px} .switch{display:inline-block;width:32px;height:18px;background:#ccc;cursor:pointer} .switch[aria-checked=true]{background:#2a6} li.done label{text-decoration:line-through} [role=option]{cursor:pointer} #overlay{position:fixed;inset:0;background:rgba(0,0,0,.3)}</style>
${FAKE_API}</head><body>${CHROME_TOP}<main>${body}</main>${CHROME_BOTTOM}<script>${script}</script></body></html>`;
}

export const LOGIN_PAGE = page('Acme — Sign in', `
<h1>Sign in to Acme</h1>
<form id="login">
	<p><label for="email">Email</label> <input id="email" type="email" autocomplete="email"></p>
	<p><label for="pw">Password</label> <input id="pw" type="password" autocomplete="current-password"></p>
	<p><label><input id="remember" type="checkbox"> Remember me</label></p>
	<p><button id="go" type="submit" disabled>Sign in</button> <a href="#/forgot">Forgot password?</a></p>
</form>
<section aria-label="Other ways to sign in"><h2>Or continue with</h2><button>Google</button> <button>GitHub</button> <button>Microsoft</button> <button>SAML SSO</button></section>
<p>New to Acme? <a href="#/signup">Create an account</a></p>`, `
window.API = { '/api/session': { name: 'Ada' } };
const email = document.getElementById('email');
const pw = document.getElementById('pw');
const go = document.getElementById('go');
const check = () => { go.disabled = !(email.value.includes('@') && pw.value.length >= 6); };
email.addEventListener('input', check);
pw.addEventListener('input', check);
document.getElementById('login').addEventListener('submit', e => {
	e.preventDefault();
	go.disabled = true;
	go.textContent = 'Signing in…';
	fetch('/api/session', { method: 'POST' }).then(r => r.json()).then(user => {
		document.querySelector('main').innerHTML = '<h1>Dashboard</h1><p>Welcome back, ' + user.name + '</p><section aria-label="Projects"><h2>Projects</h2><ul><li><a href="#/p/1">Apollo</a></li><li><a href="#/p/2">Gemini</a></li><li><a href="#/p/3">Mercury</a></li></ul></section>';
		location.hash = '#/dashboard';
	});
});`);

export const TODO_PAGE = page('Todos', `
<h1>todos</h1>
<input class="new-todo" placeholder="What needs to be done?" aria-label="New todo" autofocus>
<ul class="todo-list" aria-label="Todos"></ul>
<p><span id="count">0 items left</span> <button id="clear">Clear completed</button></p>`, `
const list = document.querySelector('.todo-list');
const count = document.getElementById('count');
const input = document.querySelector('.new-todo');
const todos = new Map();
let next = 0;
const update = () => {
	const left = [...todos.values()].filter(t => !t.done).length;
	count.textContent = left + (left === 1 ? ' item left' : ' items left');
};
const add = text => {
	const id = next++;
	const li = document.createElement('li');
	li.innerHTML = '<input type="checkbox" class="toggle" aria-label="Complete"> <label></label> <button class="destroy" aria-label="Delete">×</button>';
	li.querySelector('label').textContent = text;
	const todo = { text, done: false, li };
	li.querySelector('.toggle').addEventListener('change', e => { todo.done = e.target.checked; li.classList.toggle('done', todo.done); update(); });
	li.querySelector('.destroy').addEventListener('click', () => { li.remove(); todos.delete(id); update(); });
	todos.set(id, todo);
	list.appendChild(li);
	update();
};
input.addEventListener('keydown', e => {
	if (e.key === 'Enter' && input.value.trim()) { add(input.value.trim()); input.value = ''; }
});
document.getElementById('clear').addEventListener('click', () => { for (const [id, t] of todos) { if (t.done) { t.li.remove(); todos.delete(id); } } update(); });`);

const SETTING_ROWS = Array.from({ length: 24 }, (_, i) => `<p><label><input type="checkbox"${i % 3 === 0 ? ' checked' : ''}> ${['Weekly digest', 'Product updates', 'Security alerts', 'Billing receipts', 'Mentions', 'Comments', 'Team invites', 'Deploy notices'][i % 8]} (${['email', 'slack', 'sms'][i % 3]})</label></p>`).join('');

export const SETTINGS_PAGE = page('Settings — Acme', `
<h1>Settings</h1>
<section aria-label="Notifications"><h2>Notifications</h2>
	<p><span class="switch" role="switch" aria-checked="false" tabindex="0" aria-label="Email notifications"></span> Email notifications</p>
	<p><span class="switch" role="switch" aria-checked="true" tabindex="0" aria-label="Push notifications"></span> Push notifications</p>
	${SETTING_ROWS}
</section>
<section aria-label="Appearance"><h2>Appearance</h2>
	<p>Theme: <span id="theme" role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-label="Theme" tabindex="0">System</span></p>
	<ul role="listbox" id="themes" aria-label="Themes" hidden><li role="option">Light</li><li role="option">Dark</li><li role="option">System</li></ul>
</section>
<p><button id="save">Save changes</button> <button>Discard</button></p>
<div id="dialog-root"></div>
<div class="toast" role="status" id="toast"></div>`, `
window.API = { '/api/settings': { ok: true } };
for (const sw of document.querySelectorAll('[role=switch]')) {
	sw.addEventListener('click', () => sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true'));
}
const theme = document.getElementById('theme');
const themes = document.getElementById('themes');
theme.addEventListener('click', () => { const open = themes.hidden; themes.hidden = !open; theme.setAttribute('aria-expanded', String(open)); });
for (const option of themes.children) {
	option.addEventListener('click', () => { theme.textContent = option.textContent; themes.hidden = true; theme.setAttribute('aria-expanded', 'false'); });
}
document.getElementById('save').addEventListener('click', () => {
	const root = document.getElementById('dialog-root');
	root.innerHTML = '<div role="dialog" aria-label="Save changes?" aria-modal="true"><h2>Save changes?</h2><p>Your notification and appearance settings will be updated.</p><button id="cancel">Cancel</button> <button id="confirm">Save</button></div>';
	document.getElementById('cancel').addEventListener('click', () => { root.innerHTML = ''; });
	document.getElementById('confirm').addEventListener('click', () => {
		root.innerHTML = '';
		fetch('/api/settings', { method: 'PUT' }).then(() => {
			const toast = document.getElementById('toast');
			toast.textContent = 'Settings saved';
			setTimeout(() => { toast.textContent = ''; }, 4000);
		});
	});
});`);

const PRODUCTS = ['Desk Lamp', 'Floor Lamp', 'Lamp Shade', 'Office Chair', 'Standing Desk', 'Monitor Arm', 'Keyboard', 'Mouse Pad', 'Webcam', 'Headphones'];

export const CATALOG_PAGE = page('Catalog — Acme Store', `
<h1>Catalog</h1>
<p><input type="search" id="q" aria-label="Search products" placeholder="Search products"> <span id="shown">Showing 300 of 300</span></p>
<table aria-label="Products"><thead><tr><th>Product</th><th>SKU</th><th>Price</th><th></th></tr></thead><tbody id="rows"></tbody></table>
<aside aria-label="Details" id="details" hidden></aside>`, `
const rows = document.getElementById('rows');
const items = [];
for (let i = 0; i < 300; i++) {
	const base = ${JSON.stringify(PRODUCTS)}[i % 10];
	const name = i < 10 ? base : base + ' ' + (Math.floor(i / 10) + 1);
	const price = i === 0 ? 49 : 10 + (i * 7) % 290;
	const tr = document.createElement('tr');
	tr.innerHTML = '<td></td><td>SKU-' + (1000 + i) + '</td><td>$' + price + '</td><td><button>Details</button></td>';
	tr.firstChild.textContent = name;
	tr.querySelector('button').addEventListener('click', () => {
		const d = document.getElementById('details');
		d.hidden = false;
		d.innerHTML = '<h2></h2><p></p>';
		d.querySelector('h2').textContent = name;
		d.querySelector('p').textContent = name + ' — $' + price;
	});
	rows.appendChild(tr);
	items.push({ name, tr });
}
let timer;
document.getElementById('q').addEventListener('input', e => {
	clearTimeout(timer);
	timer = setTimeout(() => {
		const q = e.target.value.trim().toLowerCase();
		let shown = 0;
		for (const item of items) { const hit = !q || (item.name.toLowerCase().includes(q) && !/ \\d+$/.test(item.name)); item.tr.hidden = !hit; if (hit) { shown++; } }
		document.getElementById('shown').textContent = 'Showing ' + shown + ' of 300';
	}, 250);
});`);

export const WIZARD_PAGE = page('Create your account', `
<h1>Create your account</h1>
<p id="progress">Step 1 of 3</p>
<form id="wizard" novalidate>
	<fieldset id="s1"><legend>About you</legend>
		<p><label for="name">Full name</label> <input id="name" autocomplete="name"></p>
		<p><label for="mail">Work email</label> <input id="mail" type="email"></p>
		<p><label for="company">Company (optional)</label> <input id="company"></p>
	</fieldset>
	<fieldset id="s2" hidden><legend>Your plan</legend>
		<p><label for="country">Country</label> <select id="country"><option value="">Choose…</option><option>France</option><option>Germany</option><option>Japan</option><option>United States</option></select></p>
		<p><label><input type="radio" name="plan" value="Starter"> Starter</label> <label><input type="radio" name="plan" value="Pro"> Pro</label> <label><input type="radio" name="plan" value="Enterprise"> Enterprise</label></p>
	</fieldset>
	<fieldset id="s3" hidden><legend>Confirm</legend>
		<p><label><input type="checkbox" id="terms"> I agree to the Terms</label></p>
		<p><label><input type="checkbox"> Send me product news</label></p>
	</fieldset>
	<p><button type="button" id="back" hidden>Back</button> <button type="button" id="next">Next</button> <button type="submit" id="create" hidden disabled>Create account</button></p>
</form>
<p id="result" role="status"></p>`, `
window.API = { '/api/accounts': { ok: true } };
let step = 1;
const show = () => {
	for (let i = 1; i <= 3; i++) { document.getElementById('s' + i).hidden = i !== step; }
	document.getElementById('progress').textContent = 'Step ' + step + ' of 3';
	document.getElementById('back').hidden = step === 1;
	document.getElementById('next').hidden = step === 3;
	document.getElementById('create').hidden = step !== 3;
};
document.getElementById('next').addEventListener('click', () => {
	if (step === 1 && !(document.getElementById('name').value && document.getElementById('mail').value.includes('@'))) { return; }
	if (step === 2 && !(document.getElementById('country').value && document.querySelector('input[name=plan]:checked'))) { return; }
	step++;
	show();
});
document.getElementById('back').addEventListener('click', () => { step--; show(); });
document.getElementById('terms').addEventListener('change', e => { document.getElementById('create').disabled = !e.target.checked; });
document.getElementById('wizard').addEventListener('submit', e => {
	e.preventDefault();
	fetch('/api/accounts', { method: 'POST' }).then(() => {
		const plan = document.querySelector('input[name=plan]:checked').value;
		document.getElementById('result').textContent = 'Account created for ' + document.getElementById('name').value + ' (' + plan + ', ' + document.getElementById('country').value + ')';
	});
});`);

/** Odd pages for the reliability tests. */
export const TRICKY_PAGE = page('Tricky', `
<h1>Projects</h1>
<ul aria-label="Projects">
	<li>Project A <button>Delete</button></li>
	<li>Project B <button>Delete</button></li>
</ul>
<p id="plain">Just some text.</p>
<p><button id="later-host">Load more</button></p>
<div id="slot"></div>
<p><button id="covered">Covered button</button> <span id="covered-count">0</span></p>
<p><button id="slow">Slow save</button> <span id="slow-state">idle</span></p>
<p><label><input type="checkbox" id="agree" checked> Already agreed</label></p>
<p><label for="secret">Password</label> <input id="secret" type="password"></p>`, `
document.getElementById('later-host').addEventListener('click', () => {
	setTimeout(() => { document.getElementById('slot').innerHTML = '<button id="late">Late button</button> <span id="late-state">not clicked</span>'; document.getElementById('late').addEventListener('click', () => { document.getElementById('late-state').textContent = 'late clicked'; }); }, 700);
});
document.getElementById('covered').addEventListener('click', () => { const c = document.getElementById('covered-count'); c.textContent = String(Number(c.textContent) + 1); });
document.getElementById('slow').addEventListener('click', () => {
	window.API_MS = 4500;
	document.getElementById('slow-state').textContent = 'saving';
	fetch('/api/slow').then(() => { document.getElementById('slow-state').textContent = 'saved'; });
});
for (const b of document.querySelectorAll('li button')) { b.addEventListener('click', () => b.closest('li').remove()); }`);
