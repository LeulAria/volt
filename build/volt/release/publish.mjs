/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Publishes a release run: creates or updates the GitHub Release (nightly is one rolling
// prerelease re-created at the new commit), uploads the assets, then writes the update feed
// (<channel>/<platform>.json, plus <platform>.squirrel.json for Squirrel.Mac) to the
// `volt-update-feed` branch, served from raw.githubusercontent.com.
// env: GH_TOKEN, CHANNEL, VERSION, TAG, PRERELEASE, REPOSITORY, COMMIT, ASSETS_DIR

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { feedEntries, parseAssetName } from './releaseNaming.mjs';

const FEED_BRANCH = 'volt-update-feed';
const { CHANNEL: channel, VERSION: version, TAG: tag, PRERELEASE, REPOSITORY: repo, COMMIT: commit } = process.env;
const assetsDir = path.resolve(process.env.ASSETS_DIR ?? 'assets');
const prerelease = PRERELEASE === 'true';

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts }).trim();
const gh = (...args) => run('gh', args);
const tryGh = (...args) => { try { return gh(...args); } catch { return undefined; } };

const files = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).filter(name => parseAssetName(name)) : [];
if (!files.length) {
	console.error(`No release assets in ${assetsDir}`);
	process.exit(1);
}
console.log(`Publishing ${files.length} assets for ${channel} ${version} (${tag})`);

const title = channel === 'stable' ? `Volt ${version}` : channel === 'beta' ? `Volt Beta ${version}` : `Volt Nightly ${version}`;
const notesFile = path.join(os.tmpdir(), 'volt-release-notes.md');
fs.writeFileSync(notesFile, releaseNotesHeader());

const existing = tryGh('release', 'view', tag, '--repo', repo, '--json', 'tagName');
if (channel === 'nightly' && existing) {
	// One rolling nightly: drop the old release and tag so the new one points at this commit.
	gh('release', 'delete', tag, '--repo', repo, '--cleanup-tag', '--yes');
}
const paths = files.map(name => path.join(assetsDir, name));
if (channel !== 'nightly' && existing) {
	gh('release', 'upload', tag, '--repo', repo, '--clobber', ...paths);
} else {
	const args = ['release', 'create', tag, '--repo', repo, '--target', commit, '--title', title, '--notes-file', notesFile];
	if (channel !== 'nightly') {
		args.push('--generate-notes');
	}
	args.push(prerelease ? '--prerelease' : '--latest', ...(prerelease ? ['--latest=false'] : []));
	gh(...args, ...paths);
}

const release = JSON.parse(gh('api', `repos/${repo}/releases/tags/${tag}`));
const assets = release.assets
	.filter(a => files.includes(a.name))
	.map(a => {
		const data = fs.readFileSync(path.join(assetsDir, a.name));
		return { name: a.name, url: a.browser_download_url, size: a.size, sha256: createHash('sha256').update(data).digest('hex') };
	});
const timestamp = Date.parse(release.published_at ?? release.created_at);
const feed = feedEntries(assets, { channel, version, commit, timestamp, releaseUrl: release.html_url, notes: (release.body ?? '').slice(0, 20000) });
console.log(`Feed entries: ${Object.keys(feed).join(', ')}`);

writeFeed(feed, assets, release);

function releaseNotesHeader() {
	const lines = [`${title} (\`${commit.slice(0, 8)}\`)`, ''];
	if (channel === 'nightly') {
		lines.push('Built every night from `main`. Nightly installs next to Volt and Volt Beta.', '', '### Latest commits', '');
		try {
			lines.push(...run('git', ['log', '--no-merges', '--format=- %s (%h)', '-n', '25', commit]).split('\n'));
		} catch {
			// shallow clone
		}
	} else {
		lines.push(channel === 'beta' ? 'Beta builds install next to Volt.' : 'Download for your platform at https://volt.leularia.com/download.');
	}
	lines.push('', '**Downloads:** https://volt.leularia.com/download');
	return lines.join('\n') + '\n';
}

function writeFeed(feed, assets, release) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volt-feed-'));
	const remote = `https://x-access-token:${process.env.GH_TOKEN}@github.com/${repo}.git`;
	const git = (...args) => run('git', args, { cwd: dir });
	git('init', '-q');
	git('config', 'user.name', 'github-actions[bot]');
	git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
	git('remote', 'add', 'origin', remote);

	for (let attempt = 1; attempt <= 5; attempt++) {
		let hasBranch = true;
		try {
			git('fetch', '-q', '--depth', '1', 'origin', FEED_BRANCH);
			git('checkout', '-q', '-B', FEED_BRANCH, 'FETCH_HEAD');
		} catch {
			hasBranch = false;
			git('checkout', '-q', '--orphan', FEED_BRANCH);
		}
		const channelDir = path.join(dir, channel);
		fs.mkdirSync(channelDir, { recursive: true });
		for (const [id, entry] of Object.entries(feed)) {
			fs.writeFileSync(path.join(channelDir, `${id}.json`), JSON.stringify(entry, null, '\t') + '\n');
			if (id.startsWith('darwin')) {
				// Squirrel.Mac reads { url, name, notes, pub_date } and installs whatever it is given.
				fs.writeFileSync(path.join(channelDir, `${id}.squirrel.json`), JSON.stringify({ url: entry.url, name: entry.version, notes: '', pub_date: new Date(entry.timestamp).toISOString() }, null, '\t') + '\n');
			}
		}
		fs.writeFileSync(path.join(channelDir, 'latest.json'), JSON.stringify({
			channel, version, commit, tag, releaseUrl: release.html_url, publishedAt: release.published_at, platforms: Object.keys(feed), assets,
		}, null, '\t') + '\n');
		if (!fs.existsSync(path.join(dir, 'README.md'))) {
			fs.writeFileSync(path.join(dir, 'README.md'), '# Volt update feed\n\nWritten by `.github/workflows/volt-build.yml`. Volt reads `<channel>/<platform>.json`.\n');
		}
		git('add', '-A');
		try {
			git('commit', '-q', '-m', `feed: ${channel} ${version}`);
		} catch {
			console.log('Feed unchanged');
			return;
		}
		try {
			git('push', '-q', 'origin', `${FEED_BRANCH}:${FEED_BRANCH}`);
			console.log(`Feed updated: https://raw.githubusercontent.com/${repo}/${FEED_BRANCH}/${channel}/`);
			return;
		} catch (err) {
			console.log(`Feed push failed (attempt ${attempt}${hasBranch ? '' : ', new branch'}), retrying`);
			fs.rmSync(path.join(dir, channel), { recursive: true, force: true });
		}
	}
	throw new Error('Could not push the update feed');
}
