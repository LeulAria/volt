import { Link } from "@tanstack/react-router";
import { ArrowDownToLine, ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { focusRing, OsIcon } from "@/components/landing/install";
import { Spinner } from "@/components/landing/primitives";
import { cn } from "@/lib/cn";
import {
  type Arch,
  archLabel,
  CHANNEL_INFO,
  type Channel,
  formatDate,
  formatSize,
  type Os,
  packageOf,
  platformOf,
  primaryAsset,
  recommendedPkg,
} from "@/lib/releases";
import { GITHUB_RELEASES_URL, type ReleasesState } from "@/lib/useReleases";

const BUTTON =
  "inline-flex h-12 min-w-0 items-center justify-center gap-2.5 rounded-[6px] px-5 font-sans text-[14px] font-semibold transition-opacity duration-150 sm:h-14 sm:px-7 sm:text-[15px]";

/**
 * The one big button: the recommended package for the chosen platform on the chosen channel,
 * with version, date and size underneath. Falls back to GitHub Releases whenever the API
 * can't answer or the build doesn't exist.
 */
export function PrimaryDownload({
  state,
  channel,
  os,
  arch,
  onArch,
  className,
}: {
  state: ReleasesState;
  channel: Channel;
  os: Os;
  arch: Arch;
  /** When set, macOS shows an Apple Silicon / Intel switch under the button. */
  onArch?: (arch: Arch) => void;
  className?: string;
}) {
  const platform = platformOf(os);
  const release =
    state.status === "ready" ? state.releases[channel] : undefined;
  const asset = primaryAsset(release, os, arch, recommendedPkg(os));
  const info = CHANNEL_INFO[channel];
  const title = `Download for ${platform.label}`;

  let button: ReactNode;
  let meta: ReactNode;
  if (state.status === "loading") {
    button = (
      <span className={cn(BUTTON, "cursor-progress bg-white/80 text-black/70")}>
        <Spinner className="size-4" />
        Finding the latest build
      </span>
    );
    meta = <span>Asking GitHub for the newest {info.label} release.</span>;
  } else if (asset) {
    button = (
      <a
        href={asset.url}
        className={cn(
          BUTTON,
          "bg-white text-black hover:opacity-90",
          focusRing,
        )}
      >
        <OsIcon
          os={os}
          className={cn(
            "size-5 shrink-0",
            os === "linux" ? "invert-0" : "text-black",
          )}
        />
        <span className="truncate">{title}</span>
        <ArrowDownToLine className="size-4 shrink-0 opacity-60" />
      </a>
    );
    meta = (
      <>
        <span className="text-white/75">
          {info.app} {asset.version}
        </span>
        <Dot />
        <span>{archLabel(os, asset.arch)}</span>
        <Dot />
        <span>{packageOf(os, asset.pkg)?.label ?? asset.pkg}</span>
        <Dot />
        <span>{formatSize(asset.size)}</span>
        {release ? (
          <>
            <Dot />
            <span>{formatDate(release.publishedAt)}</span>
          </>
        ) : null}
      </>
    );
  } else {
    const href = release?.htmlUrl ?? GITHUB_RELEASES_URL;
    button = (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={cn(
          BUTTON,
          "border border-white/25 text-white hover:border-white/40 hover:bg-white/5",
          focusRing,
        )}
      >
        <span className="truncate">Get Volt on GitHub</span>
        <ArrowUpRight className="size-4 shrink-0 opacity-70" />
      </a>
    );
    meta =
      state.status === "error" ? (
        <span>
          Couldn't reach the GitHub API (it may be rate limiting this network).
          Every build is on GitHub Releases.
        </span>
      ) : release ? (
        <span>
          {platform.label} {archLabel(os, arch)} is not available in {info.app}{" "}
          {release.version}.
        </span>
      ) : (
        <span>No {info.label} build has been published yet.</span>
      );
  }

  return (
    <div className={cn("flex flex-col items-start", className)}>
      {button}
      <p
        aria-live="polite"
        className="mt-4 flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-white/45"
      >
        {meta}
      </p>
      {onArch && os === "darwin" ? (
        <MacArchSwitch arch={arch} onArch={onArch} />
      ) : null}
    </div>
  );
}

function Dot() {
  return <span aria-hidden className="size-[3px] rounded-full bg-white/25" />;
}

function MacArchSwitch({
  arch,
  onArch,
}: {
  arch: Arch;
  onArch: (arch: Arch) => void;
}) {
  return (
    <div className="mt-6 flex flex-wrap items-center gap-3 text-[13px] text-white/45">
      <fieldset className="inline-flex rounded-[6px] border border-white/15 p-0.5">
        <legend className="sr-only">Mac processor</legend>
        {(["arm64", "x64"] as const).map((a) => (
          <label
            key={a}
            className={cn(
              "cursor-pointer rounded-[4px] px-3 py-1.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-white/35",
              arch === a
                ? "bg-white/[0.12] text-white"
                : "text-white/55 hover:text-white",
            )}
          >
            <input
              type="radio"
              name="mac-arch"
              value={a}
              checked={arch === a}
              onChange={() => onArch(a)}
              className="sr-only"
            />
            {a === "arm64" ? "Apple Silicon" : "Intel"}
          </label>
        ))}
      </fieldset>
      <span className="text-pretty">
        Apple menu, About This Mac: a chip named Apple M-something means Apple
        Silicon.
      </span>
    </div>
  );
}

/** Compact version for the landing page: the button, its meta line, and a way to the rest. */
export function LandingDownload({
  state,
  os,
  arch,
}: {
  state: ReleasesState;
  os: Os;
  arch: Arch;
}) {
  const channel: Channel =
    state.status === "ready" && !state.releases.stable && state.releases.beta
      ? "beta"
      : "stable";
  return (
    <div className="flex flex-col items-center">
      <PrimaryDownload
        state={state}
        channel={channel}
        os={os}
        arch={arch}
        className="items-center text-center [&>p]:justify-center"
      />
      <Link
        to="/download"
        className={cn(
          "mt-3 inline-flex items-center gap-1 rounded text-[13px] text-white/60 underline-offset-4 transition-colors hover:text-white hover:underline",
          focusRing,
        )}
      >
        Other platforms, Beta and Nightly
        <ArrowUpRight className="size-3.5" />
      </Link>
    </div>
  );
}
