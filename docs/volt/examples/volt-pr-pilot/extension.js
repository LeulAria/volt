// PR Pilot: an example Volt plugin. It links the chat in front to its pull request and CI,
// visually, through Volt's plugin UI (contributes.voltViews / voltSlotItems / voltSettingsPages):
//
// - a chip above the composer ("#12 · 2 failing"), kept current with vscode.volt.ui.update;
// - three webview views Volt places where the user wants (right panel, popover, left sidebar, ...);
// - a menu in the chat's side toolbar, buttons in the title bar, files sidebar and footer;
// - its settings on its own page in Volt Settings, and per-chat notes in vscode.volt.storage;
// - Volt's model picker (vscode.volt.chats.pickModel) for the model reviews run on.
//
// Plain JavaScript, no build step. Pull requests and checks come from the `gh` CLI.

const vscode = require('vscode');
const cp = require('child_process');

const FAILED = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ERROR', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** @param {vscode.ExtensionContext} context */
function activate(context) {
	const volt = /** @type {any} */ (vscode).volt;
	if (!volt) {
		return; // Not running in Volt.
	}

	/** Every view on screen, by kind (panel, checks, notes). */
	const views = new Set();
	let state = { loading: true, chat: undefined, pr: undefined, checks: [], error: undefined, notes: '', reviewModel: undefined, updatedAt: 0 };
	let refreshing;

	const config = () => vscode.workspace.getConfiguration('prPilot');

	const post = view => view.webview.postMessage({ type: 'state', state, kind: view.__kind });
	const broadcast = () => views.forEach(post);

	function gh(args, cwd) {
		return new Promise(resolve => {
			const env = { ...process.env, PATH: `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin` };
			cp.execFile('gh', args, { cwd: cwd || undefined, env, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
				resolve(err ? { error: (stderr || err.message || '').trim().split('\n')[0] } : { value: stdout });
			});
		});
	}

	function summarize(checks) {
		const failing = checks.filter(check => FAILED.has(check.conclusion)).length;
		const passing = checks.filter(check => PASSED.has(check.conclusion)).length;
		return { failing, passing, pending: checks.length - failing - passing, total: checks.length };
	}

	function updateChip() {
		const pr = state.pr;
		const show = config().get('showChip', true) && !!state.chat;
		if (!pr) {
			volt.ui.update('prPilot.chip', { hidden: !show, label: state.loading ? 'PR…' : 'Link PR', badge: '', tone: undefined, description: state.error || 'No pull request for this chat yet: click to see why, or link one.' }).catch(() => { });
			return;
		}
		const s = summarize(state.checks);
		const checksText = s.total === 0 ? 'no checks' : s.failing ? `${s.failing} failing` : s.pending ? `${s.pending} running` : 'checks passed';
		const mode = config().get('chipText', 'both');
		const label = mode === 'number' ? `#${pr.number}` : mode === 'checks' ? checksText : `#${pr.number} · ${checksText}`;
		const tone = s.failing ? 'error' : s.pending ? 'warning' : s.total ? 'success' : undefined;
		volt.ui.update('prPilot.chip', { hidden: !show, label, badge: '', tone, description: `${pr.title} (${pr.state.toLowerCase()})` }).catch(() => { });
		volt.ui.update('prPilot.filesTab', { badge: s.failing ? String(s.failing) : '', tone }).catch(() => { });
	}

	async function linkedUrl(chat) {
		try {
			const links = await volt.pullRequests.list(chat.id);
			if (links && links.length) {
				return links[0].url;
			}
		} catch {
			// hosting.read refused or not granted yet: the link PR Pilot keeps itself.
		}
		return volt.storage.get(`pr:${chat.id}`);
	}

	async function refresh() {
		if (refreshing) {
			return refreshing;
		}
		refreshing = (async () => {
			state = { ...state, loading: true };
			updateChip();
			broadcast();
			let chat;
			try {
				chat = await volt.chats.current();
			} catch (err) {
				state = { ...state, loading: false, chat: undefined, pr: undefined, checks: [], error: String(err && err.message || err) };
				return;
			}
			const reviewModel = await volt.storage.get('reviewModel');
			const notes = chat ? (await volt.storage.get(`notes:${chat.id}`)) || '' : '';
			let pr;
			let checks = [];
			let error;
			if (chat) {
				const url = await linkedUrl(chat);
				const fields = 'number,title,state,url,headRefName,isDraft,reviewDecision,statusCheckRollup';
				const result = url ? await gh(['pr', 'view', url, '--json', fields]) : chat.project ? await gh(['pr', 'view', '--json', fields], chat.project) : { error: 'This chat has no project folder.' };
				if (result.value) {
					const raw = JSON.parse(result.value);
					pr = { number: raw.number, title: raw.title, state: raw.isDraft ? 'DRAFT' : raw.state, url: raw.url, branch: raw.headRefName, review: raw.reviewDecision || '' };
					checks = (raw.statusCheckRollup || []).map(check => ({
						name: check.name || check.context || 'check',
						workflow: check.workflowName || '',
						conclusion: (check.conclusion || check.state || '').toUpperCase(),
						status: (check.status || '').toUpperCase(),
						url: check.detailsUrl || check.targetUrl || '',
					}));
				} else {
					error = /no pull requests found/i.test(result.error || '') ? 'No pull request for this branch yet.' : result.error;
				}
			}
			state = { loading: false, chat, pr, checks, error, notes, reviewModel, updatedAt: Date.now() };
		})().finally(() => {
			refreshing = undefined;
			updateChip();
			broadcast();
		});
		return refreshing;
	}

	async function linkPr() {
		const chat = await volt.chats.current();
		if (!chat) {
			vscode.window.showInformationMessage('Open a chat first.');
			return;
		}
		const url = await vscode.window.showInputBox({ title: 'Link a pull request to this chat', placeHolder: 'https://github.com/owner/repo/pull/123', validateInput: value => /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(value.trim()) ? undefined : 'A GitHub pull request URL' });
		if (!url) {
			return;
		}
		await volt.storage.set(`pr:${chat.id}`, url.trim());
		try {
			await volt.pullRequests.link(chat.id, url.trim());
		} catch {
			// Kept by PR Pilot only (the user didn't allow it to link through Volt).
		}
		await refresh();
	}

	async function pickReviewModel() {
		const model = await volt.chats.pickModel({ placeHolder: 'The model PR Pilot starts reviews on' });
		if (model) {
			await volt.storage.set('reviewModel', model);
			await config().update('reviewModel', model.id, vscode.ConfigurationTarget.Global);
			state = { ...state, reviewModel: model };
			broadcast();
		}
	}

	async function fixChecks() {
		const failing = state.checks.filter(check => FAILED.has(check.conclusion));
		if (!state.chat || !state.pr || !failing.length) {
			vscode.window.showInformationMessage('No failing checks on this chat\'s pull request.');
			return;
		}
		const list = failing.map(check => `- ${check.workflow ? check.workflow + ' / ' : ''}${check.name}: ${check.url}`).join('\n');
		await volt.chats.send(state.chat.id, `These checks fail on PR #${state.pr.number} (${state.pr.url}):\n${list}\nRead their logs with \`gh run view --log-failed\`, fix the cause, and push.`);
	}

	async function review() {
		if (!state.pr) {
			return;
		}
		const model = state.reviewModel && state.reviewModel.id;
		await volt.chats.start({ title: `Review PR #${state.pr.number}`, message: `Review ${state.pr.url}: correctness first, then tests. Use \`gh pr diff ${state.pr.number}\`.`, ...(model ? { model } : {}) });
	}

	async function onMessage(message, view) {
		switch (message && message.type) {
			case 'ready': post(view); break;
			case 'refresh': await refresh(); break;
			case 'open': if (typeof message.url === 'string' && /^https:\/\//.test(message.url)) { vscode.env.openExternal(vscode.Uri.parse(message.url)); } break;
			case 'link': await linkPr(); break;
			case 'pickModel': await pickReviewModel(); break;
			case 'fix': await fixChecks(); break;
			case 'review': await review(); break;
			case 'showPanel': await volt.ui.showView('prPilot.panel'); break;
			case 'saveNotes':
				if (state.chat && typeof message.text === 'string') {
					await volt.storage.set(`notes:${state.chat.id}`, message.text);
					state = { ...state, notes: message.text };
				}
				break;
		}
	}

	const provider = kind => ({
		resolveWebviewView(view) {
			view.__kind = kind;
			const media = vscode.Uri.joinPath(context.extensionUri, 'media');
			view.webview.options = { enableScripts: true, localResourceRoots: [media] };
			const nonce = Math.random().toString(36).slice(2);
			const script = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
			const style = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
			view.webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}"></head>
<body data-kind="${kind}"><main id="root"></main><script nonce="${nonce}" src="${script}"></script></body></html>`;
			views.add(view);
			view.onDidDispose(() => views.delete(view));
			view.webview.onDidReceiveMessage(message => void onMessage(message, view));
		},
	});

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('prPilot.panel', provider('panel')),
		vscode.window.registerWebviewViewProvider('prPilot.checks', provider('checks')),
		vscode.window.registerWebviewViewProvider('prPilot.notes', provider('notes')),
		vscode.commands.registerCommand('prPilot.refresh', () => refresh()),
		vscode.commands.registerCommand('prPilot.linkPr', () => linkPr()),
		vscode.commands.registerCommand('prPilot.pickReviewModel', () => pickReviewModel()),
		vscode.commands.registerCommand('prPilot.fixChecks', () => fixChecks()),
		volt.chats.onDidChangeCurrent(() => void refresh()),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('prPilot')) {
				updateChip();
				schedule();
			}
		}),
	);

	let timer;
	function schedule() {
		clearInterval(timer);
		timer = setInterval(() => void refresh(), Math.max(5, config().get('pollSeconds', 30)) * 1000);
	}
	context.subscriptions.push({ dispose: () => clearInterval(timer) });
	schedule();
	void refresh();
}

function deactivate() { }

module.exports = { activate, deactivate };
