/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Local images a page names, which the visual tools read and inline (html_render, html_preview,
 * canvas frames). Here so the sandbox gate checks exactly the paths those tools will read.
 */

/** Absolute local image paths in a page: `src="/abs/a.png"`, `url(/abs/b.webp)`, `'file:///abs/c.jpg'`. */
const LOCAL_IMAGE = /(["'(])((?:file:\/\/)?\/[^"'()<>\s]+\.(png|jpe?g|gif|webp|avif|svg|bmp|ico))(?=["')])/gi;

export function localImagePaths(html: string): string[] {
	const paths = new Set<string>();
	for (const match of html.matchAll(LOCAL_IMAGE)) {
		paths.add(match[2]);
	}
	return [...paths];
}

/** The page with each local image path replaced by its data URL (paths missing from `images` stay as they are). */
export function inlineLocalImages(html: string, images: ReadonlyMap<string, string>): string {
	return html.replace(LOCAL_IMAGE, (match, quote: string, path: string) => {
		const data = images.get(path);
		return data ? `${quote}${data}` : match;
	});
}
