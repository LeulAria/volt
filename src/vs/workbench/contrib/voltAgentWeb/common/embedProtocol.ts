/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Messages between the mobile app and the web app's embedded thread view (`/?embed=thread`):
// the app sends commands with `window.voltEmbed.receive`, the page posts events through the
// web view's message channel.

/** What the native app tells the embedded thread. */
export type EmbedCommand =
	| { readonly type: 'open'; readonly chat: string }
	| { readonly type: 'clear'; readonly chat: string }
	| { readonly type: 'scrollToEnd' }
	| { readonly type: 'insets'; readonly top: number; readonly bottom: number };

/** What the embedded thread tells the native app. */
export type EmbedEvent =
	| { readonly type: 'ready' }
	| { readonly type: 'state'; readonly chat: string | undefined; readonly messages: number; readonly streaming: boolean; readonly status: string; readonly scrolledUp: boolean; readonly connected: boolean }
	| { readonly type: 'link'; readonly url: string };
