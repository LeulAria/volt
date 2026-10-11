/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Redirect, useLocalSearchParams } from 'expo-router';

/** `volt://pair?url=<pairing link>`: confirmed on the connect screen before anything is sent. */
export default function PairLink() {
	const { url } = useLocalSearchParams<{ url?: string }>();
	return <Redirect href={url ? { pathname: '/connect', params: { link: url } } : '/connect'} />;
}
