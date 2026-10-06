import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/cn";
import { gitConfig } from "@/lib/shared";
import { latestVersion, useReleases } from "@/lib/useReleases";
import { focusRing, GithubMarkIcon } from "./install";

const PILL =
  "inline-flex h-6 items-center justify-center rounded-full border border-white/15 bg-white/[0.06] px-2.5 leading-none text-[10px] font-medium uppercase tracking-[0.16em] text-white/70 backdrop-blur-xl transition-colors duration-150 hover:border-white/25 hover:bg-white/10 hover:text-white";

/** Logo, beta badge with the current version, and the Download / Docs / GitHub pills. */
export function SiteHeader({
  animate = false,
  className,
}: {
  /** Mark the items for the landing's opening sequence (they stay hidden until it runs). */
  animate?: boolean;
  className?: string;
}) {
  const version = latestVersion(useReleases());
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
      <div
        {...hero}
        className="inline-flex h-6 min-w-0 items-center justify-center gap-1.5 rounded-full border border-white/15 bg-white/[0.06] px-2 text-center text-[10px] font-medium tracking-[0.08em] text-white/75 backdrop-blur-xl sm:gap-2 sm:px-2.5 sm:tracking-[0.16em]"
      >
        <span className="inline-flex items-center pt-px pl-[0.16em] uppercase leading-none">
          Public beta
        </span>
        <span
          className="inline-block h-2.5 w-px shrink-0 self-center bg-white/20"
          aria-hidden
        />
        <span className="inline-flex items-center pt-px font-mono text-[10px] font-semibold leading-none tracking-normal text-white/55">
          v{version}
        </span>
      </div>
      <Link
        {...hero}
        to="/download"
        className={`${PILL} max-sm:hidden ${focusRing}`}
      >
        Download
      </Link>
      <Link
        {...hero}
        to="/docs/$"
        params={{ _splat: "" }}
        className={`${PILL} ${focusRing}`}
      >
        Docs
      </Link>
      <a
        {...hero}
        href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}
        target="_blank"
        rel="noreferrer"
        title="Volt on GitHub"
        aria-label="Volt on GitHub"
        className={`group gap-1.5 ${PILL} ${focusRing}`}
      >
        <GithubMarkIcon className="size-3.5 shrink-0 opacity-80 transition-opacity group-hover:opacity-100" />
        <span className="max-[380px]:sr-only">GitHub</span>
      </a>
    </header>
  );
}
