// Shared Volt code arrives prebuilt in src/core/voltCore.js (build/volt/buildMobileCore.mjs), so
// Metro never reads the repo's src/vs or its Electron node_modules: the defaults are enough.
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
