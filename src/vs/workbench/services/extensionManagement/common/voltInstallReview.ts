/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationError } from '../../../../base/common/errors.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IExtensionManifest } from '../../../../platform/extensions/common/extensions.js';

/**
 * Volt's review before an extension installs (spec H.10 step 3, P4): the user sees what it declares
 * and chooses where its code runs before any of it runs. Installing used to put a new extension in
 * the shared extension host at once, where `onStartupFinished` code ran with the user's access
 * before the permission sheet (shown at first activation) was even on screen.
 *
 * Installs from Volt's UI (a `.vsix`, the gallery) wait for it; the Security contribution sets it.
 */
export interface IVoltInstallReview {
	/** False: the user cancelled, nothing is installed. */
	review(manifest: IExtensionManifest): Promise<boolean>;
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
