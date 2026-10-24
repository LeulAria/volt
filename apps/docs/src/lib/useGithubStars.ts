import { useEffect, useState } from "react";
import { gitConfig } from "./shared";

const REPO_API = `https://api.github.com/repos/${gitConfig.user}/${gitConfig.repo}`;
const CACHE_KEY = "volt:stars:v1";
const CACHE_MS = 10 * 60 * 1000;

let inflight: Promise<number> | null = null;

function readCache(): number | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { at, stars } = JSON.parse(raw) as { at: number; stars: number };
    return Date.now() - at < CACHE_MS && typeof stars === "number"
      ? stars
      : null;
  } catch {
    return null;
  }
}

async function fetchStars(): Promise<number> {
  const cached = readCache();
  if (cached !== null) return cached;
  const res = await fetch(REPO_API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  // 403/429 here is almost always the unauthenticated rate limit
  if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
  const stars = (await res.json())?.stargazers_count;
  if (typeof stars !== "number") throw new Error("no stargazers_count");
  try {
    sessionStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ at: Date.now(), stars }),
    );
  } catch {
    /* storage full or disabled */
  }
  return stars;
}

/** The repository's star count from the GitHub API, fetched once per tab and cached briefly. `null` until it arrives or when GitHub can't be reached. */
export function useGithubStars(): number | null {
  const [stars, setStars] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    inflight ??= fetchStars().catch((err) => {
      inflight = null;
      throw err;
    });
    inflight.then(
      (value) => {
        if (!cancelled) setStars(value);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return stars;
}

/** 950 → "950", 1234 → "1.2k", 12500 → "12.5k". */
export function formatStars(stars: number): string {
  if (stars < 1000) return String(stars);
  const k = stars / 1000;
  return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}
