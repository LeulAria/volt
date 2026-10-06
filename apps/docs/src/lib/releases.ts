/**
 * Release parsing and platform selection for the download page. Pure: no DOM, no fetch, no
 * imports, so `node scripts/check-releases.mjs` can run it straight from source.
 *
 * Conventions (set by CI):
 * - tags: stable `vX.Y.Z`, beta `vX.Y.Z-beta.N`, nightly is one rolling prerelease tagged `nightly`
 * - assets: `volt-<channel>-<version>-<os>-<arch>[-user-setup|-system-setup].<ext>`
 * The channel comes from the asset name, so releases whose assets don't follow it are ignored.
 */

export type Channel = "stable" | "beta" | "nightly";
export type Os = "darwin" | "win32" | "linux";
export type Arch = "x64" | "arm64" | "armhf" | "universal";
export type Pkg =
  | "dmg"
  | "zip"
  | "exe"
  | "user-setup"
  | "system-setup"
  | "deb"
  | "rpm"
  | "tar.gz";

export const CHANNELS: readonly Channel[] = ["stable", "beta", "nightly"];

/** The subset of the GitHub Releases API response this page reads. */
export interface GhAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface GhRelease {
  tag_name: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets: GhAsset[];
}

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
  channel: Channel;
  version: string;
  os: Os;
  arch: Arch;
  pkg: Pkg;
}

export interface ChannelRelease {
  channel: Channel;
  tag: string;
  version: string;
  publishedAt: string;
  htmlUrl: string;
  assets: ReleaseAsset[];
}

export type ChannelReleases = Partial<Record<Channel, ChannelRelease>>;

const ASSET_RE =
  /^volt-(stable|beta|nightly)-(.+)-(darwin|win32|linux)-(x64|arm64|armhf|universal)(-user-setup|-system-setup)?\.(dmg|zip|exe|deb|rpm|tar\.gz)$/;

export function parseAssetName(
  name: string,
): Omit<ReleaseAsset, "name" | "url" | "size"> | null {
  const m = ASSET_RE.exec(name);
  if (!m) return null;
  const [, channel, version, os, arch, setup, ext] = m;
  return {
    channel: channel as Channel,
    version,
    os: os as Os,
    arch: arch as Arch,
    pkg: (setup ? setup.slice(1) : ext) as Pkg,
  };
}

/** Keeps only what the page needs, so the cached copy stays small. */
export function trimReleases(raw: unknown): GhRelease[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is GhRelease => !!r && typeof r.tag_name === "string")
    .map((r) => ({
      tag_name: r.tag_name,
      html_url: r.html_url,
      draft: !!r.draft,
      prerelease: !!r.prerelease,
      published_at: r.published_at ?? null,
      assets: (Array.isArray(r.assets) ? r.assets : []).map((a: GhAsset) => ({
        name: a.name,
        browser_download_url: a.browser_download_url,
        size: a.size,
      })),
    }));
}

/** The newest published release per channel (by `published_at`). Drafts are skipped. */
export function pickChannelReleases(releases: GhRelease[]): ChannelReleases {
  const out: ChannelReleases = {};
  for (const release of releases) {
    if (release.draft || !release.published_at) continue;
    const byChannel = new Map<Channel, ReleaseAsset[]>();
    for (const a of release.assets) {
      const parsed = parseAssetName(a.name);
      if (!parsed) continue;
      const list = byChannel.get(parsed.channel) ?? [];
      list.push({
        ...parsed,
        name: a.name,
        url: a.browser_download_url,
        size: a.size,
      });
      byChannel.set(parsed.channel, list);
    }
    for (const [channel, assets] of byChannel) {
      const current = out[channel];
      if (
        current &&
        Date.parse(current.publishedAt) >= Date.parse(release.published_at)
      )
        continue;
      out[channel] = {
        channel,
        tag: release.tag_name,
        version: assets[0].version,
        publishedAt: release.published_at,
        htmlUrl: release.html_url,
        assets,
      };
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Platforms                                                           */
/* ------------------------------------------------------------------ */

export interface PackageOption {
  pkg: Pkg;
  label: string;
  hint?: string;
  recommended?: boolean;
}

export interface PlatformOption {
  os: Os;
  label: string;
  arches: { arch: Arch; label: string }[];
  packages: PackageOption[];
}

export const PLATFORMS: readonly PlatformOption[] = [
  {
    os: "darwin",
    label: "macOS",
    arches: [
      { arch: "arm64", label: "Apple Silicon" },
      { arch: "x64", label: "Intel" },
      { arch: "universal", label: "Universal" },
    ],
    packages: [
      { pkg: "dmg", label: ".dmg", hint: "Disk image", recommended: true },
      { pkg: "zip", label: ".zip", hint: "Archive" },
    ],
  },
  {
    os: "win32",
    label: "Windows",
    arches: [
      { arch: "x64", label: "x64" },
      { arch: "arm64", label: "Arm64" },
    ],
    packages: [
      {
        pkg: "user-setup",
        label: "User Installer",
        hint: "No admin rights needed",
        recommended: true,
      },
      { pkg: "system-setup", label: "System Installer", hint: "All users" },
      { pkg: "zip", label: ".zip", hint: "Portable" },
    ],
  },
  {
    os: "linux",
    label: "Linux",
    arches: [
      { arch: "x64", label: "x64" },
      { arch: "arm64", label: "Arm64" },
      { arch: "armhf", label: "ARMv7 (armhf)" },
    ],
    packages: [
      {
        pkg: "deb",
        label: ".deb",
        hint: "Debian, Ubuntu",
        recommended: true,
      },
      { pkg: "rpm", label: ".rpm", hint: "Fedora, RHEL, openSUSE" },
      { pkg: "tar.gz", label: ".tar.gz", hint: "Any distro" },
    ],
  },
];

export function platformOf(os: Os): PlatformOption {
  return PLATFORMS.find((p) => p.os === os) ?? PLATFORMS[0];
}

export function archLabel(os: Os, arch: Arch): string {
  return platformOf(os).arches.find((a) => a.arch === arch)?.label ?? arch;
}

export function packageOf(os: Os, pkg: Pkg): PackageOption | undefined {
  return platformOf(os).packages.find((p) => p.pkg === pkg);
}

export function findAsset(
  release: ChannelRelease | undefined,
  os: Os,
  arch: Arch,
  pkg: Pkg,
): ReleaseAsset | undefined {
  return release?.assets.find(
    (a) => a.os === os && a.arch === arch && a.pkg === pkg,
  );
}

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

export interface DetectInput {
  userAgent: string;
  /** navigator.userAgentData.getHighEntropyValues(['platform', 'architecture', 'bitness']) */
  uaData?: { platform?: string; architecture?: string; bitness?: string };
  /** WebGL unmasked renderer, e.g. "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, ...)" */
  gpu?: string;
  /** navigator.maxTouchPoints; iPadOS reports a Mac user agent */
  maxTouchPoints?: number;
}

export interface Detected {
  /** null on phones, tablets and anything Volt doesn't ship for */
  os: Os | null;
  arch: Arch;
  /** false when the arch is a default guess rather than something the browser told us */
  archKnown: boolean;
  pkg: Pkg;
}

export function defaultArch(os: Os): Arch {
  return os === "darwin" ? "arm64" : "x64";
}

export function recommendedPkg(os: Os, userAgent = ""): Pkg {
  if (os === "darwin") return "dmg";
  if (os === "win32") return "user-setup";
  return /fedora|red hat|centos|suse|rocky|alma/i.test(userAgent)
    ? "rpm"
    : "deb";
}

export function detectPlatform(input: DetectInput): Detected {
  const ua = input.userAgent;
  const hint = input.uaData;
  const platform = (hint?.platform ?? "").toLowerCase();
  const cpu = (hint?.architecture ?? "").toLowerCase();

  let os: Os | null = null;
  if (/android|iphone|ipad|ipod|cros/i.test(ua) || platform === "android") {
    os = null;
  } else if (platform === "macos" || /mac os x|macintosh/i.test(ua)) {
    os = (input.maxTouchPoints ?? 0) > 1 ? null : "darwin";
  } else if (platform === "windows" || /windows/i.test(ua)) {
    os = "win32";
  } else if (platform === "linux" || /linux|x11/i.test(ua)) {
    os = "linux";
  }

  if (!os) return { os, arch: "arm64", archKnown: false, pkg: "dmg" };

  let arch = defaultArch(os);
  let archKnown = false;
  if (cpu === "arm" || cpu === "x86") {
    archKnown = true;
    if (cpu === "x86") arch = "x64";
    else arch = os === "linux" && hint?.bitness === "32" ? "armhf" : "arm64";
  } else if (os === "darwin" && input.gpu) {
    // Safari and Firefox always say "Intel Mac OS X"; the GPU name is the tell.
    if (/apple m\d/i.test(input.gpu)) archKnown = true;
    else if (/intel|amd|radeon|nvidia/i.test(input.gpu)) {
      arch = "x64";
      archKnown = true;
    }
  } else if (/aarch64|arm64/i.test(ua)) {
    arch = "arm64";
    archKnown = true;
  } else if (/armv7|armhf/i.test(ua)) {
    arch = os === "linux" ? "armhf" : "arm64";
    archKnown = true;
  } else if (/x86_64|x64|win64|wow64|amd64/i.test(ua) && os !== "darwin") {
    archKnown = true;
  }
  return { os, arch, archKnown, pkg: recommendedPkg(os, ua) };
}

/**
 * The asset for the big button: the recommended package for the detected platform, falling
 * back to a universal Mac build, then to any package for that platform and arch.
 */
export function primaryAsset(
  release: ChannelRelease | undefined,
  os: Os,
  arch: Arch,
  pkg: Pkg,
): ReleaseAsset | undefined {
  if (!release) return undefined;
  const arches: Arch[] = os === "darwin" ? [arch, "universal"] : [arch];
  for (const a of arches) {
    const exact = findAsset(release, os, a, pkg);
    if (exact) return exact;
  }
  for (const a of arches) {
    for (const p of platformOf(os).packages) {
      const any = findAsset(release, os, a, p.pkg);
      if (any) return any;
    }
  }
  return undefined;
}

/** Stable when there is one, else beta, else nightly. */
export function defaultChannel(releases: ChannelReleases): Channel {
  return CHANNELS.find((c) => releases[c]) ?? "stable";
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export const CHANNEL_INFO: Record<
  Channel,
  { label: string; app: string; blurb: string }
> = {
  stable: {
    label: "Stable",
    app: "Volt",
    blurb: "Tested releases. The one to use every day.",
  },
  beta: {
    label: "Beta",
    app: "Volt Beta",
    blurb: "Release candidates, a step ahead of Stable.",
  },
  nightly: {
    label: "Nightly",
    app: "Volt Nightly",
    blurb: "Built from main every night. Expect rough edges.",
  },
};
