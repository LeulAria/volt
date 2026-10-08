/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Expo config plugin: adds the widget extension (Live Activities, Dynamic Island, home and Lock
// Screen widgets) to the prebuilt iOS project. It copies the Swift sources and brand assets, creates
// the target, shares an App Group with the app, and wires the Stop intent into both targets.

const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod, withEntitlementsPlist, withInfoPlist, withXcodeProject } = require('@expo/config-plugins');

const PACKAGE_ROOT = path.join(__dirname, '..');
const EXTENSION = 'VoltWidgetExtension';
const BRANDS = require(path.join(PACKAGE_ROOT, 'brands', 'brands.json'));
const ACTIVITY_ATTRIBUTES = path.join(PACKAGE_ROOT, 'ios', 'Shared', 'VoltActivityAttributes.swift');
const STOP_INTENT = path.join(PACKAGE_ROOT, 'targets', 'app', 'VoltStopTurnIntent.swift');
const WIDGET_SOURCES = path.join(PACKAGE_ROOT, 'targets', 'widget');

function withVoltWidgets(config, props = {}) {
	const bundleId = config.ios?.bundleIdentifier;
	if (!bundleId) {
		throw new Error('volt-mobile-widgets needs ios.bundleIdentifier in app.json.');
	}
	const extensionBundleId = `${bundleId}.widgets`;
	const appGroup = props.appGroup ?? `group.${bundleId}`;
	const scheme = Array.isArray(config.scheme) ? config.scheme[0] : config.scheme ?? 'volt';

	config = withEntitlementsPlist(config, mod => {
		mod.modResults['com.apple.security.application-groups'] = [appGroup];
		return mod;
	});

	config = withInfoPlist(config, mod => {
		mod.modResults.NSSupportsLiveActivities = true;
		mod.modResults.NSSupportsLiveActivitiesFrequentUpdates = true;
		mod.modResults.VoltWidgetsAppGroup = appGroup;
		mod.modResults.VoltWidgetsURLScheme = scheme;
		return mod;
	});

	const version = config.version ?? '1.0';
	const build = config.ios?.buildNumber ?? '1';

	config = withDangerousMod(config, [
		'ios',
		async mod => {
			const icon = config.icon ? path.resolve(mod.modRequest.projectRoot, config.icon) : undefined;
			writeExtensionFiles(mod.modRequest.platformProjectRoot, { appGroup, scheme, icon });
			return mod;
		},
	]);

	config = withXcodeProject(config, mod => {
		addExtensionTarget(mod.modResults, { bundleId: extensionBundleId, version, build });
		return mod;
	});

	return config;
}

function writeExtensionFiles(platformRoot, { appGroup, scheme, icon }) {
	const extensionDir = path.join(platformRoot, EXTENSION);
	const appDir = path.join(platformRoot, 'Volt');
	fs.mkdirSync(extensionDir, { recursive: true });

	for (const file of fs.readdirSync(WIDGET_SOURCES).filter(name => name.endsWith('.swift'))) {
		fs.copyFileSync(path.join(WIDGET_SOURCES, file), path.join(extensionDir, file));
	}
	fs.copyFileSync(ACTIVITY_ATTRIBUTES, path.join(extensionDir, path.basename(ACTIVITY_ATTRIBUTES)));
	fs.copyFileSync(STOP_INTENT, path.join(extensionDir, path.basename(STOP_INTENT)));
	fs.copyFileSync(STOP_INTENT, path.join(appDir, path.basename(STOP_INTENT)));

	fs.writeFileSync(path.join(extensionDir, 'Info.plist'), infoPlist({ appGroup, scheme }));
	fs.writeFileSync(path.join(extensionDir, `${EXTENSION}.entitlements`), entitlementsPlist(appGroup));
	writeAssets(path.join(extensionDir, 'Images.xcassets'), icon);
}

function writeAssets(catalog, icon) {
	writeJson(path.join(catalog, 'Contents.json'), { info: { author: 'xcode', version: 1 } });
	for (const [id, brand] of Object.entries(BRANDS)) {
		imageSet(catalog, `brand-${id}`, `brand-${id}.svg`, brandSvg(brand));
	}
	if (icon && fs.existsSync(icon)) {
		const imageDir = path.join(catalog, 'volt-icon.imageset');
		fs.mkdirSync(imageDir, { recursive: true });
		fs.copyFileSync(icon, path.join(imageDir, 'volt-icon.png'));
		writeJson(path.join(imageDir, 'Contents.json'), imageContents('volt-icon.png', false));
	}
}

function imageSet(catalog, name, file, svg) {
	const dir = path.join(catalog, `${name}.imageset`);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, file), svg);
	writeJson(path.join(dir, 'Contents.json'), imageContents(file, true));
}

function imageContents(file, vector) {
	return {
		images: [{ filename: file, idiom: 'universal' }],
		info: { author: 'xcode', version: 1 },
		properties: vector ? { 'preserves-vector-representation': true } : {},
	};
}

function brandSvg(brand) {
	const paths = brand.paths
		.map(p => `<path d="${p.d}"${p.fill ? ` fill="${p.fill}"` : ''}${p.evenOdd ? ' fill-rule="evenodd" clip-rule="evenodd"' : ''}/>`)
		.join('');
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${brand.viewBox}">${paths}</svg>\n`;
}

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function infoPlist({ appGroup, scheme }) {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>$(DEVELOPMENT_LANGUAGE)</string>
	<key>CFBundleDisplayName</key>
	<string>Volt</string>
	<key>CFBundleExecutable</key>
	<string>$(EXECUTABLE_NAME)</string>
	<key>CFBundleIdentifier</key>
	<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>$(PRODUCT_NAME)</string>
	<key>CFBundlePackageType</key>
	<string>$(PRODUCT_BUNDLE_PACKAGE_TYPE)</string>
	<key>CFBundleShortVersionString</key>
	<string>$(MARKETING_VERSION)</string>
	<key>CFBundleVersion</key>
	<string>$(CURRENT_PROJECT_VERSION)</string>
	<key>NSExtension</key>
	<dict>
		<key>NSExtensionPointIdentifier</key>
		<string>com.apple.widgetkit-extension</string>
	</dict>
	<key>VoltWidgetsAppGroup</key>
	<string>${appGroup}</string>
	<key>VoltWidgetsURLScheme</key>
	<string>${scheme}</string>
</dict>
</plist>
`;
}

function entitlementsPlist(appGroup) {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.security.application-groups</key>
	<array>
		<string>${appGroup}</string>
	</array>
</dict>
</plist>
`;
}

function addExtensionTarget(project, { bundleId, version, build }) {
	if (project.pbxTargetByName(EXTENSION)) {
		return;
	}
	const app = project.getFirstTarget();
	const target = project.addTarget(EXTENSION, 'app_extension', EXTENSION, bundleId);
	project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', target.uuid);
	project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
	project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);

	const extensionGroup = project.addPbxGroup([], EXTENSION, EXTENSION);
	const mainGroup = project.getPBXGroupByKey(project.getFirstProject().firstProject.mainGroup);
	mainGroup.children.push({ value: extensionGroup.uuid, comment: EXTENSION });
	const swiftFiles = [...fs.readdirSync(WIDGET_SOURCES), path.basename(ACTIVITY_ATTRIBUTES), path.basename(STOP_INTENT)].filter(name => name.endsWith('.swift'));
	for (const file of swiftFiles) {
		project.addSourceFile(file, { target: target.uuid }, extensionGroup.uuid);
	}
	const assets = project.addFile('Images.xcassets', extensionGroup.uuid);
	assets.uuid = project.generateUuid();
	assets.target = target.uuid;
	project.addToPbxBuildFileSection(assets);
	project.addToPbxResourcesBuildPhase(assets);
	project.addFile('Info.plist', extensionGroup.uuid);
	project.addFile(`${EXTENSION}.entitlements`, extensionGroup.uuid);

	const appGroupKey = project.findPBXGroupKey({ name: 'Volt' });
	project.addSourceFile(`Volt/${path.basename(STOP_INTENT)}`, { target: app.uuid }, appGroupKey);
	const objects = project.hash.project.objects;
	objects.PBXContainerItemProxy = objects.PBXContainerItemProxy || {};
	objects.PBXTargetDependency = objects.PBXTargetDependency || {};
	project.addTargetDependency(app.uuid, [target.uuid]);

	const settings = {
		CODE_SIGN_ENTITLEMENTS: `${EXTENSION}/${EXTENSION}.entitlements`,
		INFOPLIST_FILE: `${EXTENSION}/Info.plist`,
		IPHONEOS_DEPLOYMENT_TARGET: '16.4',
		SWIFT_VERSION: '5.0',
		TARGETED_DEVICE_FAMILY: '"1,2"',
		APPLICATION_EXTENSION_API_ONLY: 'YES',
		GENERATE_INFOPLIST_FILE: 'NO',
		MARKETING_VERSION: `"${version}"`,
		CURRENT_PROJECT_VERSION: `"${build}"`,
	};
	const configList = project.pbxXCConfigurationList()[target.pbxNativeTarget.buildConfigurationList];
	for (const { value } of configList.buildConfigurations) {
		Object.assign(project.pbxXCBuildConfigurationSection()[value].buildSettings, settings);
	}
}

module.exports = withVoltWidgets;
