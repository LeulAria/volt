/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import qrcode from 'qrcode-generator';
import { memo, useMemo } from 'react';

/** A QR code as one SVG path (scanned by the Volt phone app or any camera). */
export const QRCode = memo(function QRCode({ value, size = 200 }: { readonly value: string; readonly size?: number }) {
	const { path, count } = useMemo(() => {
		const qr = qrcode(0, 'M');
		qr.addData(value);
		qr.make();
		const n = qr.getModuleCount();
		let d = '';
		for (let row = 0; row < n; row++) {
			for (let col = 0; col < n; col++) {
				if (qr.isDark(row, col)) {
					d += `M${col} ${row}h1v1h-1z`;
				}
			}
		}
		return { path: d, count: n };
	}, [value]);
	const quiet = 2;
	return (
		<svg className="qr" width={size} height={size} viewBox={`${-quiet} ${-quiet} ${count + quiet * 2} ${count + quiet * 2}`} role="img" aria-label="Pairing QR code" shapeRendering="crispEdges">
			<rect x={-quiet} y={-quiet} width={count + quiet * 2} height={count + quiet * 2} rx={2} fill="#fff" />
			<path d={path} fill="#111" />
		</svg>
	);
});
