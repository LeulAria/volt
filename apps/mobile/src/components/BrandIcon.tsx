import Svg, { Path } from 'react-native-svg';
import { PROVIDER_BRAND_DATA, providerFamily } from '@/core/voltCore';
import { colors } from '@/lib/theme';

/** A model's provider mark, from the same path data the agent window draws. */
export function BrandIcon({ providerId, size = 14 }: { readonly providerId: string; readonly size?: number }) {
	const brand = PROVIDER_BRAND_DATA[providerFamily(providerId)] ?? PROVIDER_BRAND_DATA.generic;
	const paths = brand?.paths?.length ? brand.paths : PROVIDER_BRAND_DATA.generic?.paths ?? [];
	const color = brand?.color ?? colors.textSecondary;
	return (
		<Svg width={size} height={size} viewBox={brand?.paths?.length ? brand.viewBox : PROVIDER_BRAND_DATA.generic?.viewBox ?? '0 0 24 24'}>
			{paths.map((path, index) => (
				<Path key={index} d={path.d} fill={path.fill ?? color} fillRule={path.evenOdd ? 'evenodd' : 'nonzero'} clipRule={path.evenOdd ? 'evenodd' : 'nonzero'} />
			))}
		</Svg>
	);
}
