import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/cn";
import { gitConfig } from "@/lib/shared";
import { formatStars, useGithubStars } from "@/lib/useGithubStars";
import {
  GITHUB_RELEASES_URL,
  latestVersion,
  useReleases,
} from "@/lib/useReleases";
import { DISCORD_URL, DiscordIcon, focusRing, GithubMarkIcon } from "./install";

const PILL =
  "inline-flex h-6 items-center justify-center rounded-full border border-white/15 bg-white/[0.06] px-2.5 leading-none text-[10px] font-medium uppercase tracking-[0.16em] text-white/70 backdrop-blur-xl transition-colors duration-150 hover:border-white/25 hover:bg-white/10 hover:text-white";

/** Logo, the beta badge with the current version (a link to the GitHub releases), and the Download / Discord / GitHub pills (GitHub with its live star count). */
export function SiteHeader({
  animate = false,
  className,
}: {
  /** Mark the items for the landing's opening sequence (they stay hidden until it runs). */
  animate?: boolean;
  className?: string;
}) {
  const version = latestVersion(useReleases());
  const stars = useGithubStars();
  const hero = animate ? { "data-hero": "head" } : {};
  return (
    <header
      className={cn(
        "relative z-20 mx-auto flex w-full max-w-[1296px] shrink-0 items-center justify-end gap-1.5 px-4 pt-4 sm:px-6 sm:pt-5 md:px-10 lg:px-12",
        className,
      )}
    >
      <Link
        {...hero}
        to="/"
        aria-label="Volt home"
        className={`mr-auto inline-flex items-center gap-2 rounded-md ${focusRing}`}
      >
        <img
          src="/volt-icon-256.png"
          alt=""
          width={256}
          height={256}
          className="size-7"
        />
      </Link>
      <a
        {...hero}
        href={GITHUB_RELEASES_URL}
        target="_blank"
        rel="noreferrer"
        title="Volt releases on GitHub"
        aria-label={
          version
            ? `Public beta, version ${version}: releases on GitHub`
            : "Public beta: releases on GitHub"
        }
        className={`inline-flex h-6 min-w-0 items-center justify-center gap-1.5 rounded-full border border-white/15 bg-white/[0.06] px-2 text-center text-[10px] font-medium tracking-[0.08em] text-white/75 backdrop-blur-xl transition-colors duration-150 hover:border-white/25 hover:bg-white/10 hover:text-white sm:gap-2 sm:px-2.5 sm:tracking-[0.16em] ${focusRing}`}
      >
        <span className="inline-flex items-center pt-px pl-[0.16em] uppercase leading-none">
          Public beta
        </span>
        {version ? (
          <>
            <span
              className="inline-block h-2.5 w-px shrink-0 self-center bg-white/20"
              aria-hidden
            />
            <span className="inline-flex items-center pt-px font-mono text-[10px] font-semibold leading-none tracking-normal text-white/55">
              v{version}
            </span>
          </>
        ) : null}
      </a>
      <Link
        {...hero}
        to="/download"
        className={`${PILL} max-sm:hidden ${focusRing}`}
      >
        Download
      </Link>
      <a
        {...hero}
        href={DISCORD_URL}
        target="_blank"
        rel="noreferrer"
        title="Volt on Discord"
        aria-label="Volt on Discord"
        className={`group gap-1.5 ${PILL} ${focusRing}`}
      >
        <DiscordIcon className="size-3.5 shrink-0 opacity-80 transition-opacity group-hover:opacity-100" />
        <span className="max-sm:sr-only">Discord</span>
      </a>
      <a
        {...hero}
        href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}
        target="_blank"
        rel="noreferrer"
        title="Volt on GitHub"
        aria-label={
          stars === null
            ? "Volt on GitHub"
            : `Volt on GitHub, ${stars.toLocaleString("en-US")} stars`
        }
        className={`group gap-1.5 ${PILL} ${focusRing}`}
      >
        <GithubMarkIcon className="size-3.5 shrink-0 opacity-80 transition-opacity group-hover:opacity-100" />
        <span className="max-sm:sr-only">GitHub</span>
        {stars !== null ? (
          <>
            <span
              className="inline-block h-2.5 w-px shrink-0 self-center bg-white/20"
              aria-hidden
            />
            <span
              className="inline-flex items-center gap-1 font-mono text-[10px] font-semibold tracking-normal text-white/55"
              aria-hidden
            >
              <StarIcon className="size-2.5" />
              {formatStars(stars)}
            </span>
          </>
        ) : null}
      </a>
    </header>
  );
}

function StarIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        fill="currentColor"
        d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"
      />
    </svg>
  );
}
