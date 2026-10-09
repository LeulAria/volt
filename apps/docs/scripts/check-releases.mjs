// Checks src/lib/releases.ts against a fixture shaped like the GitHub Releases API.
// Run with `npm run test:releases` (Node 22.18+ strips the TypeScript types itself).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  detectPlatform,
  findAsset,
  formatSize,
  parseAssetName,
  pickChannelReleases,
  primaryAsset,
  trimReleases,
} from "../src/lib/releases.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../src/lib/releases.fixture.json", import.meta.url)),
);
const releases = pickChannelReleases(trimReleases(fixture));

test("parses every documented asset name", () => {
  const cases = {
    "volt-stable-0.0.1-darwin-arm64.dmg": [
      "stable",
      "0.0.1",
      "darwin",
      "arm64",
      "dmg",
    ],
    "volt-stable-0.0.1-darwin-arm64.zip": [
      "stable",
      "0.0.1",
      "darwin",
      "arm64",
      "zip",
    ],
    "volt-stable-0.0.1-darwin-universal.dmg": [
      "stable",
      "0.0.1",
      "darwin",
      "universal",
      "dmg",
    ],
    "volt-beta-0.0.1-beta.1-win32-x64-user-setup.exe": [
      "beta",
      "0.0.1-beta.1",
      "win32",
      "x64",
      "user-setup",
    ],
    "volt-stable-0.0.1-win32-arm64-system-setup.exe": [
      "stable",
      "0.0.1",
      "win32",
      "arm64",
      "system-setup",
    ],
    "volt-stable-0.0.1-win32-x64.zip": [
      "stable",
      "0.0.1",
      "win32",
      "x64",
      "zip",
    ],
    "volt-nightly-0.0.1-nightly.20261006-linux-armhf.deb": [
      "nightly",
      "0.0.1-nightly.20261006",
      "linux",
      "armhf",
      "deb",
    ],
    "volt-stable-0.0.1-linux-x64.rpm": [
      "stable",
      "0.0.1",
      "linux",
      "x64",
      "rpm",
    ],
    "volt-stable-0.0.1-linux-arm64.tar.gz": [
      "stable",
      "0.0.1",
      "linux",
      "arm64",
      "tar.gz",
    ],
  };
  for (const [name, [channel, version, os, arch, pkg]] of Object.entries(
    cases,
  )) {
    assert.deepEqual(
      parseAssetName(name),
      { channel, version, os, arch, pkg },
      name,
    );
  }
});

test("ignores legacy and auxiliary assets", () => {
  for (const name of [
    "Volt-0.1.0-arm64.dmg",
    "Volt-0.1.0-setup.exe",
    "volt-stable-0.0.1-darwin-arm64.dmg.blockmap",
    "volt-nightly-0.0.1-darwin-arm64.dmg.sha256",
    "latest-mac.yml",
    "volt-canary-0.0.1-darwin-arm64.dmg",
  ]) {
    assert.equal(parseAssetName(name), null, name);
  }
});

test("picks the newest published release per channel", () => {
  assert.equal(releases.stable?.tag, "v0.0.1");
  assert.equal(releases.stable?.version, "0.0.1");
  // v0.0.2-beta.1 is a draft and v0.0.1-beta.1 is older
  assert.equal(releases.beta?.tag, "v0.0.1-beta.2");
  assert.equal(releases.nightly?.tag, "nightly");
  assert.equal(releases.nightly?.version, "0.0.1-nightly.20261006");
  // the legacy v0.0.4 release has no matching assets, so it never wins stable
  assert.ok(Object.values(releases).every((r) => r.tag !== "v0.0.4"));
});

test("legacy-only data yields no channels", () => {
  const legacy = fixture.filter((r) => r.tag_name === "v0.0.4");
  assert.deepEqual(pickChannelReleases(trimReleases(legacy)), {});
  assert.deepEqual(
    pickChannelReleases(trimReleases({ message: "API rate limit exceeded" })),
    {},
  );
});

test("finds assets and reports missing combos", () => {
  const dmg = findAsset(releases.stable, "darwin", "arm64", "dmg");
  assert.equal(
    dmg?.url,
    "https://github.com/LeulAria/VOLT/releases/download/v0.0.1/volt-stable-0.0.1-darwin-arm64.dmg",
  );
  assert.equal(formatSize(dmg?.size ?? 0), "182 MB");
  assert.equal(findAsset(releases.stable, "linux", "armhf", "deb"), undefined);
  assert.equal(
    findAsset(releases.nightly, "win32", "arm64", "user-setup"),
    undefined,
  );
});

test("primary asset falls back to a universal Mac build", () => {
  const onlyUniversal = {
    ...releases.stable,
    assets: releases.stable.assets.filter((a) => a.arch === "universal"),
  };
  assert.equal(
    primaryAsset(onlyUniversal, "darwin", "arm64", "dmg")?.arch,
    "universal",
  );
  assert.equal(
    primaryAsset(releases.stable, "win32", "arm64", "user-setup")?.pkg,
    "user-setup",
  );
  assert.equal(
    primaryAsset(releases.stable, "linux", "armhf", "deb"),
    undefined,
  );
});

test("detects platform and arch", () => {
  const macUa =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  const winUa =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  const linuxUa =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  const pick = (d) => [d.os, d.arch, d.archKnown, d.pkg];

  // Mac: Apple Silicon unless something says Intel
  assert.deepEqual(pick(detectPlatform({ userAgent: macUa })), [
    "darwin",
    "arm64",
    false,
    "dmg",
  ]);
  assert.deepEqual(
    pick(
      detectPlatform({
        userAgent: macUa,
        uaData: { platform: "macOS", architecture: "arm" },
      }),
    ),
    ["darwin", "arm64", true, "dmg"],
  );
  assert.deepEqual(
    pick(
      detectPlatform({
        userAgent: macUa,
        uaData: { platform: "macOS", architecture: "x86" },
      }),
    ),
    ["darwin", "x64", true, "dmg"],
  );
  assert.deepEqual(
    pick(
      detectPlatform({
        userAgent: macUa,
        gpu: "ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 655, OpenGL 4.1)",
      }),
    ),
    ["darwin", "x64", true, "dmg"],
  );
  assert.deepEqual(
    pick(
      detectPlatform({
        userAgent: macUa,
        gpu: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)",
      }),
    ),
    ["darwin", "arm64", true, "dmg"],
  );
  assert.deepEqual(
    pick(detectPlatform({ userAgent: macUa, gpu: "Apple GPU" })),
    ["darwin", "arm64", false, "dmg"],
  );
  // iPad asks for the desktop site with a Mac UA
  assert.equal(
    detectPlatform({ userAgent: macUa, maxTouchPoints: 5 }).os,
    null,
  );

  assert.deepEqual(pick(detectPlatform({ userAgent: winUa })), [
    "win32",
    "x64",
    true,
    "user-setup",
  ]);
  assert.deepEqual(
    pick(
      detectPlatform({
        userAgent: winUa,
        uaData: { platform: "Windows", architecture: "arm", bitness: "64" },
      }),
    ),
    ["win32", "arm64", true, "user-setup"],
  );
  assert.deepEqual(pick(detectPlatform({ userAgent: linuxUa })), [
    "linux",
    "x64",
    true,
    "deb",
  ]);
  assert.deepEqual(
    pick(
      detectPlatform({
        userAgent:
          "Mozilla/5.0 (X11; Linux aarch64; rv:131.0) Gecko/20100101 Firefox/131.0",
      }),
    ),
    ["linux", "arm64", true, "deb"],
  );
  assert.deepEqual(
    pick(
      detectPlatform({
        userAgent: "Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36",
      }),
    ),
    ["linux", "armhf", true, "deb"],
  );
  assert.deepEqual(
    pick(
      detectPlatform({
        userAgent:
          "Mozilla/5.0 (X11; Fedora; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
      }),
    ),
    ["linux", "x64", true, "rpm"],
  );
  assert.deepEqual(
    pick(
      detectPlatform({
        userAgent: linuxUa,
        uaData: { platform: "Linux", architecture: "arm", bitness: "32" },
      }),
    ),
    ["linux", "armhf", true, "deb"],
  );
  assert.equal(
    detectPlatform({
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile",
    }).os,
    null,
  );
  assert.equal(
    detectPlatform({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    }).os,
    null,
  );
});
