/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Expo config plugin for the Android side of the shell.
//
// The activity handles every window change a foldable, a tablet or a resizable window makes
// itself, so it is never recreated: recreating it would remount React Native and reload the
// workbench. Expo's template lists most of them; it leaves out `density`, which changes when the
// app moves between a foldable's two screens, onto another display, or when the display size
// setting changes. React Native and the WebView take the new size and density in place.
//
// Fresco's GIF and WebP decoders stay out of the APK (about 0.8 MB of native code): the shell's
// own screens show PNGs only, and the WebView decodes the page's images itself.

const { AndroidConfig, withAndroidManifest, withGradleProperties } = require('expo/config-plugins');

const CONFIG_CHANGES = ['keyboard', 'keyboardHidden', 'orientation', 'screenSize', 'smallestScreenSize', 'screenLayout', 'density', 'uiMode'];

const PROPERTIES = {
	'expo.gif.enabled': 'false',
	'expo.webp.enabled': 'false',
	'expo.webp.animated': 'false',
};

module.exports = function withAndroidShell(config) {
	config = withAndroidManifest(config, mod => {
		const activity = AndroidConfig.Manifest.getMainActivityOrThrow(mod.modResults);
		const current = (activity.$['android:configChanges'] ?? '').split('|').filter(Boolean);
		activity.$['android:configChanges'] = [...new Set([...current, ...CONFIG_CHANGES])].join('|');
		// The default since Android 7; said outright so split screen and free-form windows never letterbox it.
		activity.$['android:resizeableActivity'] = 'true';
		return mod;
	});

	return withGradleProperties(config, mod => {
		for (const [key, value] of Object.entries(PROPERTIES)) {
			const item = mod.modResults.find(entry => entry.type === 'property' && entry.key === key);
			if (item) {
				item.value = value;
			} else {
				mod.modResults.push({ type: 'property', key, value });
			}
		}
		return mod;
	});
};
