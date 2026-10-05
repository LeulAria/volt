/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Types for the vendored beautiful-mermaid bundle (only what Volt uses).

export interface RenderOptions {
	bg?: string;
	fg?: string;
	line?: string;
	accent?: string;
	muted?: string;
	surface?: string;
	border?: string;
	font?: string;
	padding?: number;
	nodeSpacing?: number;
	layerSpacing?: number;
	componentSpacing?: number;
	transparent?: boolean;
	interactive?: boolean;
}

/** Renders Mermaid source to an SVG string. Throws on unsupported or invalid diagrams. */
export declare function renderMermaidSVG(text: string, options?: RenderOptions): string;
