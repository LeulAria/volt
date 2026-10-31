/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Expo config plugin: moves the iOS app onto the UIScene life cycle, which iOS 27 requires (apps
// without it abort at launch with "UIScene life cycle is required for apps built with this SDK").
// Expo ships the scene delegate (ExpoAppSceneDelegate); the generated AppDelegate still creates its
// own window, so this registers the scene delegate and lets it own the window instead.

const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

const SCENE_DELEGATE = 'EXExpoAppSceneDelegate';

// The template's window setup in application(_:didFinishLaunchingWithOptions:). The scene
// delegate creates the window from its UIWindowScene and starts React Native into it.
const WINDOW_SETUP = /\n#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\([\s\S]*?\)\n#endif\n/;

function withSceneLifecycle(config) {
	config = withInfoPlist(config, mod => {
		mod.modResults.UIApplicationSceneManifest = {
			UIApplicationSupportsMultipleScenes: false,
			UISceneConfigurations: {
				UIWindowSceneSessionRoleApplication: [{
					UISceneConfigurationName: 'Default Configuration',
					UISceneDelegateClassName: SCENE_DELEGATE,
				}],
			},
		};
		return mod;
	});

	return withAppDelegate(config, mod => {
		if (mod.modResults.language !== 'swift') {
			throw new Error('withSceneLifecycle expects a Swift AppDelegate.');
		}
		let contents = mod.modResults.contents;
		if (!contents.includes('ExpoReactNativeFactoryProvider')) {
			contents = contents.replace(
				'class AppDelegate: ExpoAppDelegate {',
				'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {'
			);
		}
		contents = contents.replace(WINDOW_SETUP, '');
		if (!contents.includes('ExpoReactNativeFactoryProvider') || contents.includes('UIWindow(frame:')) {
			throw new Error('withSceneLifecycle could not adapt AppDelegate.swift; the Expo template changed.');
		}
		mod.modResults.contents = contents;
		return mod;
	});
}

module.exports = withSceneLifecycle;
