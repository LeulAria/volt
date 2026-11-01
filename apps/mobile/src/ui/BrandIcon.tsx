/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type IBrand, modelBrand, providerBrand } from '@volt/client-core';
import { memo, useId } from 'react';
import Svg, { Defs, FeGaussianBlur, Filter, G, Mask, Path } from 'react-native-svg';
import { useTheme } from '../theme/theme';

/** A provider or model mark, as the desktop's createBrandIcon draws it. */
export const BrandIcon = memo(function BrandIcon({ brand, size = 16, color }: { readonly brand: IBrand; readonly size?: number; readonly color?: string }) {
	const { p } = useTheme();
	const id = useId().replace(/[^a-zA-Z0-9]/g, '');
	const tint = brand.color ?? color ?? p.fg;
	if (brand.blobs) {
		const mask = `${id}m`;
		return (
			<Svg width={size} height={size} viewBox={brand.viewBox}>
				<Defs>
					<Mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="15">
						{brand.paths?.map((path, i) => <Path key={i} d={path.d} fill="#fff" />)}
					</Mask>
					{brand.blobs.map((blob, i) => (
						<Filter key={i} id={`${id}f${i}`} x={blob.blur[0]} y={blob.blur[1]} width={blob.blur[2]} height={blob.blur[3]} filterUnits="userSpaceOnUse">
							<FeGaussianBlur stdDeviation={blob.blur[4]} />
						</Filter>
					))}
				</Defs>
				<G mask={`url(#${mask})`}>
					{brand.blobs.map((blob, i) => <Path key={i} d={blob.d} fill={blob.fill} filter={`url(#${id}f${i})`} />)}
				</G>
			</Svg>
		);
	}
	return (
		<Svg width={size} height={size} viewBox={brand.viewBox}>
			{brand.paths?.map((path, i) => <Path key={i} d={path.d} fill={path.fill ?? tint} fillRule={path.evenOdd ? 'evenodd' : 'nonzero'} clipRule={path.evenOdd ? 'evenodd' : 'nonzero'} />)}
		</Svg>
	);
});

export function ProviderIcon({ providerId, size, color }: { readonly providerId: string | undefined; readonly size?: number; readonly color?: string }) {
	return <BrandIcon brand={providerBrand(providerId)} size={size} color={color} />;
}

export function ModelIcon({ label, providerId, size, color }: { readonly label: string | undefined; readonly providerId: string | undefined; readonly size?: number; readonly color?: string }) {
	return <BrandIcon brand={modelBrand(label, providerId)} size={size} color={color} />;
}
