/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The app shares code with the web app (apps/client-core) and uses the widgets package
// (apps/mobile-widgets), both linked from outside this folder: Metro watches them and resolves
// their imports from this app's node_modules.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const core = path.resolve(__dirname, '../client-core');
const widgets = path.resolve(__dirname, '../mobile-widgets');

config.watchFolders = [core, widgets];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];
config.resolver.extraNodeModules = {
	'@volt/client-core': core,
	'volt-mobile-widgets': widgets,
};

module.exports = config;
