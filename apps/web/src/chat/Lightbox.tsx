/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../ui/primitives';

let current: { readonly src: string; readonly name: string } | undefined;
const listeners = new Set<() => void>();

/** Shows an image full size over the app (prompt images, pictures in replies). */
export function openLightbox(src: string, name: string): void {
	current = { src, name };
	listeners.forEach(l => l());
}

function close(): void {
	current = undefined;
	listeners.forEach(l => l());
}

export function LightboxHost() {
	const image = useSyncExternalStore(listener => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	}, () => current, () => undefined);
	useEffect(() => {
		if (!image) {
			return;
		}
		const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, [image]);
	if (!image) {
		return null;
	}
	return createPortal(
		<div className="lightbox" onPointerDown={e => e.target === e.currentTarget && close()}>
			<img src={image.src} alt={image.name} />
			<div className="lightbox-bar">
				<span>{image.name}</span>
				<a className="lightbox-btn" href={image.src} download={image.name} title="Download"><Icon name="arrowDown" size={15} /></a>
				<button type="button" className="lightbox-btn" onClick={close} aria-label="Close"><Icon name="close" size={15} /></button>
			</div>
		</div>,
		document.body,
	);
}
