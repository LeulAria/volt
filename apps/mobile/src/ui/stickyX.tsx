/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createContext, type ReactNode, useContext } from 'react';
import type { ScrollViewProps, StyleProp, ViewStyle } from 'react-native';
import Animated, { type SharedValue, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

/**
 * Line numbers that stay put while code scrolls sideways (the editor's gutter): the rows sit in a
 * horizontal StickyXScroll, and each row's StickyX is moved back by the scroll offset on the UI
 * thread, so it holds still at the left edge with the code passing under it.
 */

const ScrollX = createContext<SharedValue<number> | undefined>(undefined);

export function StickyXScroll({ children, ...props }: Omit<ScrollViewProps, 'horizontal' | 'onScroll'> & { readonly children: ReactNode }) {
	const x = useSharedValue(0);
	const onScroll = useAnimatedScrollHandler(e => {
		x.value = e.contentOffset.x;
	});
	return (
		<Animated.ScrollView {...props} horizontal onScroll={onScroll} scrollEventThrottle={16}>
			<ScrollX.Provider value={x}>{children}</ScrollX.Provider>
		</Animated.ScrollView>
	);
}

/** Held at the left edge of the nearest StickyXScroll; give it an opaque background, the code slides under it. */
export function StickyX({ style, children }: { readonly style?: StyleProp<ViewStyle>; readonly children: ReactNode }) {
	const x = useContext(ScrollX);
	const held = useAnimatedStyle(() => ({ transform: [{ translateX: x ? Math.max(0, x.value) : 0 }] }));
	return <Animated.View style={[{ zIndex: 1 }, style, x ? held : null]}>{children}</Animated.View>;
}
