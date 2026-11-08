/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as semver from '../../../base/common/semver/semver.js';
import { IUpdate } from './update.js';

/**
 * Volt's update feed is static: CI writes one JSON file per channel and updater platform
 * (`<feedUrl>/<channel>/<platform>.json`, see build/volt/release/publish.mjs), so the
 * "is there something newer" decision happens here instead of on an update server.
 */

export const VOLT_RELEASE_CHANNELS = ['stable', 'beta', 'nightly'] as const;
export type VoltReleaseChannel = typeof VOLT_RELEASE_CHANNELS[number];

export const VOLT_RELEASE_CHANNEL_SETTING = 'update.releaseChannel';

/** Each channel's app name (product `nameLong`, the .app and install folder name), as in build/volt/qualities.json. */
export const VOLT_CHANNEL_APP_NAMES: Record<VoltReleaseChannel, string> = {
	stable: 'Volt',
	beta: 'Volt Beta',
	nightly: 'Volt Nightly',
};

export interface IVoltFeedEntry {
	readonly version: string;
	readonly productVersion: string;
	readonly commit: string;
	readonly timestamp: number;
	/** What the in-app updater installs (darwin zip, win32 setup, archive). */
	readonly url: string;
	readonly sha256hash?: string;
	readonly size?: number;
	/** What a person should download (dmg, user setup, deb). */
	readonly downloadUrl?: string;
	readonly releaseUrl?: string;
	readonly notes?: string;
}

export interface IVoltUpdate extends IUpdate {
	/** The channel the update comes from; set when it is not this build's channel. */
	readonly voltChannel?: VoltReleaseChannel;
	readonly releaseUrl?: string;
	/** The installer a person would download (dmg, user setup, deb). */
	readonly downloadUrl?: string;
	/** Release notes (GitHub Release body, markdown). */
	readonly notes?: string;
	/** Size in bytes of `url`, for download progress. */
	readonly size?: number;
}

export interface IVoltCurrentBuild {
	readonly commit: string | undefined;
	/** Build date (product.json `date`, ISO). */
	readonly date: string | undefined;
	/** This build's channel (product.json `quality`). */
	readonly quality: string | undefined;
}

export function isVoltReleaseChannel(value: unknown): value is VoltReleaseChannel {
	return typeof value === 'string' && (VOLT_RELEASE_CHANNELS as readonly string[]).includes(value);
}

/** The channel to follow: the setting, or this build's own channel for `default`. */
export function resolveVoltReleaseChannel(setting: unknown, quality: string | undefined): VoltReleaseChannel | undefined {
	if (isVoltReleaseChannel(setting)) {
		return setting;
	}
	return isVoltReleaseChannel(quality) ? quality : undefined;
}

export function voltFeedUrl(feedUrl: string, channel: VoltReleaseChannel, platform: string, suffix = '.json'): string {
	return `${feedUrl.replace(/\/+$/, '')}/${channel}/${platform}${suffix}`;
}

/** Linux feed ids use VS Code's arch names (`arm` is published as `armhf`). */
export function voltLinuxPlatform(arch: string): string {
	return `linux-${arch === 'arm' ? 'armhf' : arch}`;
}

function isHttps(value: unknown): value is string {
	return typeof value === 'string' && /^https:\/\//.test(value);
}

function isFeedEntry(value: unknown): value is IVoltFeedEntry {
	const entry = value as IVoltFeedEntry | undefined;
	return !!entry && typeof entry === 'object'
		&& typeof entry.version === 'string' && !!entry.version
		&& typeof entry.commit === 'string' && !!entry.commit
		&& isHttps(entry.url)
		&& (entry.downloadUrl === undefined || isHttps(entry.downloadUrl))
		&& (entry.releaseUrl === undefined || isHttps(entry.releaseUrl))
		&& typeof entry.timestamp === 'number';
}

//#region Feed signature (INV-28)

/**
 * A signed feed entry carries, next to the fields above:
 * - `channel` and `platform`: what it was published for, so one channel's entry can't be served as another's;
 * - `feedVersion`: publish time in ms, monotonic per channel;
 * - `expires`: ms since the epoch after which the entry is stale (a frozen feed stops being trusted);
 * - `signature`: base64 Ed25519 over `VOLT_FEED_SIGNATURE_CONTEXT + canonicalVoltFeedJson(entry without signature)`,
 *   by the channel's key. build/volt/release/feedSigning.mjs writes the same bytes.
 */
export interface IVoltSignedFeedFields {
	readonly channel?: string;
	readonly platform?: string;
	readonly feedVersion?: number;
	readonly expires?: number;
	readonly signature?: string;
}

export const VOLT_FEED_SIGNATURE_CONTEXT = 'volt-update-feed-v1\n';

/** JSON with object keys sorted (UTF-16 code unit order), no whitespace, undefined members dropped. */
export function canonicalVoltFeedJson(value: unknown): string {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') {
		return JSON.stringify(value);
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new Error('Feed numbers must be finite');
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(item => canonicalVoltFeedJson(item === undefined ? null : item)).join(',')}]`;
	}
	if (typeof value === 'object') {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).filter(key => record[key] !== undefined).sort();
		return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalVoltFeedJson(record[key])}`).join(',')}}`;
	}
	throw new Error(`Feed values can't be ${typeof value}`);
}

/** The exact text the channel key signs for an entry. */
export function voltFeedSigningMessage(entry: object): string {
	const { signature: _signature, ...signed } = entry as IVoltSignedFeedFields & Record<string, unknown>;
	return VOLT_FEED_SIGNATURE_CONTEXT + canonicalVoltFeedJson(signed);
}

export type IVoltFeedPublicKeys = { readonly [channel: string]: string | readonly string[] | undefined };

export interface IVoltFeedTrust {
	/** product.json `voltRelease.feedPublicKeys`. Verification is off (and logged) without it. */
	readonly publicKeys: IVoltFeedPublicKeys | undefined;
	/** Ed25519 verification of `message` (utf8) against a base64 signature and a pinned key. */
	readonly verify: (message: string, signature: string, publicKey: string) => boolean;
	readonly now: number;
	/** The running build: its Volt version and channel, for the rollback check. */
	readonly installed: { readonly version: string | undefined; readonly channel: string | undefined };
	/** The highest `feedVersion` already accepted for this channel and platform. */
	readonly lastFeedVersion?: number;
}

export type VoltFeedTrustResult =
	| { readonly trusted: true; readonly verified: false }
	| { readonly trusted: true; readonly verified: true; readonly feedVersion: number }
	| { readonly trusted: false; readonly reason: string };

export function hasVoltFeedPublicKeys(publicKeys: IVoltFeedPublicKeys | undefined): publicKeys is IVoltFeedPublicKeys {
	return !!publicKeys && Object.values(publicKeys).some(keys => typeof keys === 'string' ? !!keys : !!keys?.length);
}

function keysOf(publicKeys: IVoltFeedPublicKeys, channel: string): readonly string[] {
	const keys = publicKeys[channel];
	return (typeof keys === 'string' ? [keys] : keys ?? []).filter(key => typeof key === 'string' && !!key);
}

function compareVoltVersions(a: string, b: string): number | undefined {
	if (!semver.valid(a) || !semver.valid(b)) {
		return undefined;
	}
	return semver.compare(a, b);
}

/**
 * Decides whether a feed entry for `channel` can be trusted (INV-28, SUP-1..3). With no pinned keys
 * every entry is trusted unverified, which keeps forks and local builds working. With pinned keys an
 * entry must carry a valid signature by `channel`'s own key, must be for `channel`, must not be
 * expired, must not be older than a feed already seen, and on this build's own channel must not
 * offer a version below the installed one.
 */
export function checkVoltFeedTrust(entry: unknown, channel: VoltReleaseChannel, trust: IVoltFeedTrust): VoltFeedTrustResult {
	if (!hasVoltFeedPublicKeys(trust.publicKeys)) {
		return { trusted: true, verified: false };
	}
	if (!entry || typeof entry !== 'object') {
		return { trusted: false, reason: 'The update feed is not an object' };
	}
	const signed = entry as IVoltFeedEntry & IVoltSignedFeedFields;
	if (typeof signed.signature !== 'string' || !signed.signature) {
		return { trusted: false, reason: `The ${channel} update feed is not signed` };
	}
	const keys = keysOf(trust.publicKeys, channel);
	if (!keys.length) {
		return { trusted: false, reason: `No update feed key is pinned for the ${channel} channel` };
	}
	let message: string;
	try {
		message = voltFeedSigningMessage(signed);
	} catch (err) {
		return { trusted: false, reason: `The ${channel} update feed can't be canonicalized: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!keys.some(key => trust.verify(message, signed.signature!, key))) {
		const signer = VOLT_RELEASE_CHANNELS.find(other => other !== channel && keysOf(trust.publicKeys!, other).some(key => trust.verify(message, signed.signature!, key)));
		return {
			trusted: false,
			reason: signer
				? `The ${channel} update feed is signed with the ${signer} channel's key`
				: `The ${channel} update feed signature is not valid`,
		};
	}
	if (signed.channel !== channel) {
		return { trusted: false, reason: `The ${channel} update feed was published for ${String(signed.channel)}` };
	}
	if (typeof signed.expires !== 'number' || !Number.isFinite(signed.expires)) {
		return { trusted: false, reason: `The ${channel} update feed has no expiry` };
	}
	if (signed.expires <= trust.now) {
		return { trusted: false, reason: `The ${channel} update feed expired on ${new Date(signed.expires).toISOString()}` };
	}
	if (typeof signed.feedVersion !== 'number' || !Number.isSafeInteger(signed.feedVersion)) {
		return { trusted: false, reason: `The ${channel} update feed has no version` };
	}
	if (trust.lastFeedVersion !== undefined && signed.feedVersion < trust.lastFeedVersion) {
		return { trusted: false, reason: `The ${channel} update feed is older than one already seen (${signed.feedVersion} < ${trust.lastFeedVersion})` };
	}
	if (channel === trust.installed.channel && trust.installed.version && typeof signed.version === 'string') {
		const order = compareVoltVersions(signed.version, trust.installed.version);
		if (order === undefined) {
			return { trusted: false, reason: `The ${channel} update feed version ${signed.version} can't be compared with ${trust.installed.version}` };
		}
		if (order < 0) {
			return { trusted: false, reason: `The ${channel} update feed offers ${signed.version}, below the installed ${trust.installed.version}` };
		}
	}
	return { trusted: true, verified: true, feedVersion: signed.feedVersion };
}

//#endregion

/**
 * Decides whether a feed entry is an update for the running build.
 * Same channel: newer only when the commit differs and the entry was published after this
 * build was made (never offers a downgrade). Another channel: that channel is a separate app,
 * so its latest build is always offered, to install next to this one (`url` is still the
 * installable archive; `downloadUrl` is the channel's download page for platforms that can't).
 */
export function decideVoltUpdate(entry: unknown, current: IVoltCurrentBuild, channel: VoltReleaseChannel, downloadPage: string | undefined): IVoltUpdate | undefined {
	if (!isFeedEntry(entry)) {
		return undefined;
	}
	const crossChannel = channel !== current.quality;
	if (!crossChannel) {
		if (entry.commit === current.commit) {
			return undefined;
		}
		const built = current.date ? Date.parse(current.date) : NaN;
		if (!isNaN(built) && entry.timestamp <= built) {
			return undefined;
		}
	}
	return {
		version: entry.commit,
		productVersion: entry.productVersion || entry.version,
		timestamp: entry.timestamp,
		url: entry.url,
		sha256hash: entry.sha256hash,
		voltChannel: crossChannel ? channel : undefined,
		releaseUrl: entry.releaseUrl,
		downloadUrl: crossChannel && downloadPage ? `${downloadPage}?channel=${channel}` : entry.downloadUrl,
		notes: typeof entry.notes === 'string' && entry.notes ? entry.notes.slice(0, 8000) : undefined,
		size: entry.size,
	};
}

/** GitHub release tag for a Volt version: the rolling `nightly`, else `v<version>`. */
export function voltReleaseTag(version: string): string {
	return /-nightly(\.|$)/.test(version) ? 'nightly' : `v${version}`;
}
