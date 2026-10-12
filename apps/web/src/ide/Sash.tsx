/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useRef } from 'react';

/** The desktop's sash: drag to resize a side bar, double-click to reset it. */
export function Sash({ side, width, onResize, onReset }: { readonly side: 'left' | 'right'; readonly width: number; readonly onResize: (width: number) => void; readonly onReset?: () => void }) {
	const start = useRef<{ x: number; width: number } | undefined>(undefined);
	return (
		<div
			className={`sash sash-${side}`}
			role="separator"
			aria-orientation="vertical"
			onDoubleClick={onReset}
			onPointerDown={e => {
				e.preventDefault();
				e.currentTarget.setPointerCapture(e.pointerId);
				start.current = { x: e.clientX, width };
				document.body.classList.add('resizing');
			}}
			onPointerMove={e => {
				if (!start.current) {
					return;
				}
				const delta = e.clientX - start.current.x;
				onResize(side === 'left' ? start.current.width + delta : start.current.width - delta);
			}}
			onPointerUp={e => {
				start.current = undefined;
				e.currentTarget.releasePointerCapture(e.pointerId);
				document.body.classList.remove('resizing');
			}}
		/>
	);
}
