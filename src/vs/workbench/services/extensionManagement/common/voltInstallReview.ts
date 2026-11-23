/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationError } from '../../../../base/common/errors.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { InstallOptions } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { approvedUpdateKey, IVoltHeldUpdate, parseHeldUpdate, VOLT_UPDATE_APPROVED_CONTEXT } from '../../../../platform/extensionManagement/common/voltExtensionLock.js';
import { IExtensionManifest } from '../../../../platform/extensions/common/extensions.js';

/**
 * Volt's review before an extension installs (spec H.10 step 3, P4): the user sees what it declares
 * and chooses where its code runs before any of it runs. Installing used to put a new extension in
 * the shared extension host at once, where `onStartupFinished` code ran with the user's access
 * before the permission sheet (shown at first activation) was even on screen.
 *
 * Installs from Volt's UI (a `.vsix`, the gallery) wait for it; the Security contribution sets it.
 *
 * Updates: the install side holds an update whose publisher changed, whose signature got worse, or
 * that gains Volt capabilities or `high` code-scan findings (`voltExtensionLock.ts`); the window
 * shows the sheet with why ({@link IVoltInstallReview.reviewHeldUpdate}) and installs it only when
 * the user says so. Auto-update goes through the same path, so it never applies such a version alone.
 */
export interface IVoltInstallReview {
	/** False: the user cancelled, nothing is installed. */
	review(manifest: IExtensionManifest): Promise<boolean>;
	/** False: the user kept the installed version. */
	reviewHeldUpdate?(held: IVoltHeldUpdate): Promise<boolean>;
}

let current: IVoltInstallReview | undefined;

export function setVoltInstallReview(review: IVoltInstallReview): IDisposable {
	current = review;
	return toDisposable(() => {
		if (current === review) {
			current = undefined;
		}
	});
}

/** Throws a cancellation when the user cancels the install in the review. */
export async function voltReviewInstall(manifest: IExtensionManifest): Promise<void> {
	if (current && !await current.review(manifest)) {
		throw new CancellationError();
	}
}

/**
 * Runs an install that may come back held (an update the install side won't apply without the
 * user): asks, and runs it again with the user's approval for that version, or throws a
 * cancellation when the user keeps the installed version.
 */
export async function voltWithHeldUpdateReview<T>(options: InstallOptions | undefined, run: (options: InstallOptions | undefined) => Promise<T>): Promise<T> {
	try {
		return await run(options);
	} catch (error) {
		const held = parseHeldUpdate(error);
		if (!held) {
			throw error;
		}
		return run(await voltApproveHeldUpdate(held, options));
	}
}

/** The install options that approve `held`, once the user said so; throws a cancellation otherwise. */
export async function voltApproveHeldUpdate(held: IVoltHeldUpdate, options: InstallOptions | undefined): Promise<InstallOptions> {
	if (!current?.reviewHeldUpdate) {
		throw new Error(localize('voltUpdateHeldNoReview', "Volt held the update of {0} to {1} for your review.", held.id, held.version));
	}
	if (!await current.reviewHeldUpdate(held)) {
		throw new CancellationError();
	}
	return { ...options, context: { ...options?.context, [VOLT_UPDATE_APPROVED_CONTEXT]: approvedUpdateKey(held.id, held.version) } };
}
