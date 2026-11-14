/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Builds Agent Lab and packs it as a .vsix (a zip: extension/ plus the two manifest files).
//
//   node build.mjs            the published build: dist/volt-agent-lab-<version>.vsix (no test fixture)
//   node build.mjs --fixture  the TEST build: also compiles src/testFixture (mock misbehavior) into
//                             dist/volt-agent-lab-<version>-fixture.vsix. Never publish it.
//   --no-pack                 compile into out/ only (Run Extension, or install the folder)
//
// Uses the repository's TypeScript and /usr/bin/zip (macOS, Linux).

import { execFileSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(fileURLToPath(import.meta.url));
const fixture = process.argv.includes('--fixture');
const pack = !process.argv.includes('--no-pack');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const tsc = [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), join(root, '..', '..', '..', '..', 'node_modules', 'typescript', 'bin', 'tsc')].find(existsSync);
if (!tsc) {
	throw new Error('TypeScript is not installed: run npm install here or in the Volt repository.');
}
rmSync(join(root, 'out'), { recursive: true, force: true });
execFileSync(process.execPath, [tsc, '-p', join(root, fixture ? 'tsconfig.fixture.json' : 'tsconfig.json')], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
console.log(`compiled ${fixture ? 'the TEST build (with src/testFixture)' : 'the published build'} into out/`);
if (!pack) {
	process.exit(0);
}

const name = `${manifest.name}-${manifest.version}${fixture ? '-fixture' : ''}`;
const stage = join(root, 'dist', `.stage-${name}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'extension'), { recursive: true });
for (const file of ['package.json', 'README.md']) {
	cpSync(join(root, file), join(stage, 'extension', file));
}
cpSync(join(root, 'out'), join(stage, 'extension', 'out'), { recursive: true });
const escape = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
writeFileSync(join(stage, 'extension.vsixmanifest'), `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
	<Metadata>
		<Identity Language="en-US" Id="${escape(manifest.name)}" Version="${escape(manifest.version)}" Publisher="${escape(manifest.publisher)}" />
		<DisplayName>${escape(manifest.displayName)}</DisplayName>
		<Description xml:space="preserve">${escape(manifest.description)}</Description>
		<Categories>Other</Categories>
		<GalleryFlags>Public</GalleryFlags>
		<Properties>
			<Property Id="Microsoft.VisualStudio.Code.Engine" Value="${escape(manifest.engines.vscode)}" />
			<Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="volt" />
		</Properties>
	</Metadata>
	<Installation>
		<InstallationTarget Id="Microsoft.VisualStudio.Code" />
	</Installation>
	<Dependencies />
	<Assets>
		<Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
		<Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
	</Assets>
</PackageManifest>
`);
writeFileSync(join(stage, '[Content_Types].xml'), `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json" /><Default Extension=".js" ContentType="application/javascript" /><Default Extension=".md" ContentType="text/markdown" /><Default Extension=".vsixmanifest" ContentType="text/xml" /></Types>
`);
const vsix = join(root, 'dist', `${name}.vsix`);
rmSync(vsix, { force: true });
execFileSync('zip', ['-q', '-r', '-X', vsix, '.'], { cwd: stage, stdio: 'inherit' });
rmSync(stage, { recursive: true, force: true });
console.log(`packed ${vsix}`);
