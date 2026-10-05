/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * An inert copy of the Usage page for the model dialog's blurred backdrop. Ids are dropped so
 * they stay unique; the copy's SVG then paints with the page's own gradients. A cloned canvas
 * comes out blank, so the dot meters are painted across.
 */
export function copyUsagePage(page: HTMLElement): HTMLElement {
	const copy = page.cloneNode(true) as HTMLElement;
	copy.classList.add('volt-usage-mirror');
	copy.setAttribute('aria-hidden', 'true');
	copy.inert = true;
	for (const el of copy.querySelectorAll('[id]')) {
		el.removeAttribute('id');
	}
	const sources = page.querySelectorAll('canvas');
	copy.querySelectorAll('canvas').forEach((canvas, index) => {
		const source = sources[index];
		if (source && source.width && source.height) {
			canvas.getContext('2d')?.drawImage(source, 0, 0);
		}
	});
	return copy;
}
