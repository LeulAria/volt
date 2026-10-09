/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IUpdate } from './update.js';

/**
 * Volt's update feed is static: CI writes one JSON file per channel and updater platform
 * (`<feedUrl>/<channel>/<platform>.json`, see build/volt/release/publish.mjs), so the
 * "is there something newer" decision happens here instead of on an update server.
 */

export const VOLT_RELEASE_CHANNELS = ['stable', 'beta', 'nightly'] as const;
export type VoltReleaseChannel = typeof VOLT_RELEASE_CHANNELS[number];

export const VOLT_RELEASE_CHANNEL_SETTING = 'update.releaseChannel';

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

function isFeedEntry(value: unknown): value is IVoltFeedEntry {
	const entry = value as IVoltFeedEntry | undefined;
	return !!entry && typeof entry === 'object'
		&& typeof entry.version === 'string' && !!entry.version
		&& typeof entry.commit === 'string' && !!entry.commit
		&& typeof entry.url === 'string' && /^https:\/\//.test(entry.url)
		&& typeof entry.timestamp === 'number';
}

/**
 * Decides whether a feed entry is an update for the running build.
 * Same channel: newer only when the commit differs and the entry was published after this
 * build was made (never offers a downgrade). Another channel: that channel is a separate app,
 * so its latest build is always offered as a download, never installed over this one.
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
		url: crossChannel ? (downloadPage ? `${downloadPage}?channel=${channel}` : entry.downloadUrl ?? entry.url) : entry.url,
		sha256hash: crossChannel ? undefined : entry.sha256hash,
		voltChannel: crossChannel ? channel : undefined,
		releaseUrl: entry.releaseUrl,
		downloadUrl: entry.downloadUrl,
		notes: typeof entry.notes === 'string' && entry.notes ? entry.notes.slice(0, 8000) : undefined,
		size: crossChannel ? undefined : entry.size,
	};
}

/** GitHub release tag for a Volt version: the rolling `nightly`, else `v<version>`. */
export function voltReleaseTag(version: string): string {
	return /-nightly(\.|$)/.test(version) ? 'nightly' : `v${version}`;
}
