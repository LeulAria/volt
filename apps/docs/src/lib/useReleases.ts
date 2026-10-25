import { useEffect, useState } from "react";
import {
  type ChannelReleases,
  type Detected,
  type DetectInput,
  detectPlatform,
  type GhRelease,
  pickChannelReleases,
  trimReleases,
} from "./releases";
import { gitConfig } from "./shared";

export const RELEASES_API = `https://api.github.com/repos/${gitConfig.user}/${gitConfig.repo}/releases?per_page=100`;
export const GITHUB_RELEASES_URL = `https://github.com/${gitConfig.user}/${gitConfig.repo}/releases`;

const CACHE_KEY = "volt:releases:v1";

export type ReleasesState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; releases: ChannelReleases };

let inflight: Promise<GhRelease[]> | null = null;

/**
 * The tab's last answer from GitHub, shown at once while a fresh one loads. It is never trusted as
 * current: a release published since must show up on the next page load, not minutes later.
 */
function readCache(): GhRelease[] | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as { data: GhRelease[] }).data : null;
  } catch {
    return null;
  }
}

async function fetchReleases(): Promise<GhRelease[]> {
  // Dev only: `/download?fixture=1` renders the checked-in API fixture instead of GitHub.
  if (
    import.meta.env.DEV &&
    new URLSearchParams(location.search).has("fixture")
  ) {
    const mod = await import("./releases.fixture.json");
    return trimReleases(mod.default);
  }
  // Once per page load. The browser's HTTP cache (GitHub sends max-age=60 and an ETag) keeps
  // reloads off the unauthenticated rate limit.
  const res = await fetch(RELEASES_API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  // 403/429 here is almost always the unauthenticated rate limit
  if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
  const data = trimReleases(await res.json());
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data }));
  } catch {
    /* storage full or disabled */
  }
  return data;
}

/** Releases per channel from the GitHub API: the tab's last answer at once, then a fresh one per page load. */
export function useReleases(): ReleasesState {
  const [state, setState] = useState<ReleasesState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    const show = (data: GhRelease[]) => {
      if (!cancelled)
        setState({ status: "ready", releases: pickChannelReleases(data) });
    };
    const cached = readCache();
    if (cached) show(cached);
    inflight ??= fetchReleases().catch((err) => {
      inflight = null;
      throw err;
    });
    inflight.then(show, () => {
      // A failed refresh keeps the last answer on screen
      if (!cancelled && !cached) setState({ status: "error" });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

/** Newest stable (else beta) version GitHub reports, or undefined until it answers (never a guess). */
export function latestVersion(state: ReleasesState): string | undefined {
  if (state.status !== "ready") return undefined;
  return state.releases.stable?.version ?? state.releases.beta?.version;
}

interface UaDataLike {
  platform?: string;
  getHighEntropyValues?: (
    hints: string[],
  ) => Promise<{ platform?: string; architecture?: string; bitness?: string }>;
}

function webglRenderer(): string | undefined {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return ext
      ? String(gl?.getParameter(ext.UNMASKED_RENDERER_WEBGL))
      : undefined;
  } catch {
    return undefined;
  }
}

/** The visitor's OS and CPU, or null until the browser has been asked (never during prerender). */
export function useDetectedPlatform(): Detected | null {
  const [detected, setDetected] = useState<Detected | null>(null);
  useEffect(() => {
    let cancelled = false;
    const uaData = (navigator as Navigator & { userAgentData?: UaDataLike })
      .userAgentData;
    const base: DetectInput = {
      userAgent: navigator.userAgent,
      maxTouchPoints: navigator.maxTouchPoints,
    };
    const finish = (input: DetectInput) => {
      if (!cancelled) setDetected(detectPlatform(input));
    };
    if (uaData?.getHighEntropyValues) {
      uaData.getHighEntropyValues(["architecture", "bitness", "platform"]).then(
        (uaValues) => finish({ ...base, uaData: uaValues }),
        () => finish({ ...base, gpu: webglRenderer() }),
      );
    } else {
      // Safari and Firefox: no client hints, so the GPU name tells Apple Silicon from Intel
      finish({
        ...base,
        gpu: /mac/i.test(base.userAgent) ? webglRenderer() : undefined,
      });
    }
    return () => {
      cancelled = true;
    };
  }, []);
  return detected;
}
