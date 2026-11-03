import { Link } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { useState } from "react";
import { DownloadDialog } from "@/components/download/downloadDialog";
import { cn } from "@/lib/cn";
import {
  defaultArch,
  defaultChannel,
  type Os,
  primaryAsset,
  recommendedPkg,
} from "@/lib/releases";
import { gitConfig } from "@/lib/shared";
import { useDetectedPlatform, useReleases } from "@/lib/useReleases";

export const INSTALL_CURL =
  "curl -fsSL https://raw.githubusercontent.com/LeulAria/VOLT/main/install.sh | bash";

export const REPO_URL = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

export const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/35 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]";

/** Fixed square so Windows & Linux controls always match. */
const platformOutlineBtn = `inline-flex size-11 shrink-0 items-center justify-center rounded-[5px] border border-white/25 bg-transparent text-white transition-colors duration-150 hover:border-white/40 hover:bg-white/5 md:size-9 ${focusRing}`;

/** Windows logo — 4 panes, monochrome (inherits `currentColor`) */
export function WindowsIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 512 512"
      xmlns="http://www.w3.org/2000/svg"
      xmlSpace="preserve"
      aria-hidden
    >
      <path
        fill="currentColor"
        d="M0 0h242.7v242.6H0zm269.3 0H512v242.6H269.3zM0 269.3h242.7V512H0zm269.3 0H512V512H269.3"
      />
    </svg>
  );
}

/**
 * A monochrome mark drawn from a static SVG through a CSS mask, so it takes `currentColor` like an inline
 * icon without putting the path into every page's HTML (the GitHub mark alone is 3 KB, and it appears
 * in the header and the footer).
 */
function MaskIcon({ src, className }: { src: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block shrink-0 bg-current", className)}
      style={{
        mask: `url(${src}) center / contain no-repeat`,
        WebkitMask: `url(${src}) center / contain no-repeat`,
      }}
    />
  );
}

/** GitHub mark (Streamline Unicons) — uses `currentColor` for light-on-dark header */
export function GithubMarkIcon({ className }: { className?: string }) {
  return <MaskIcon src="/icons/github-mark.svg" className={className} />;
}

export const DISCORD_URL = "https://discord.gg/SJ97jqDVN";

/** Discord mark (Simple Icons), monochrome (inherits `currentColor`) */
export function DiscordIcon({ className }: { className?: string }) {
  return <MaskIcon src="/icons/discord.svg" className={className} />;
}

/** Apple logo */
export function AppleIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="47.6 0 416.8 512"
      xmlns="http://www.w3.org/2000/svg"
      xmlSpace="preserve"
      aria-hidden
    >
      <path
        fill="currentColor"
        d="M451.1 174.6c-3 2.3-55.4 31.8-55.4 97.5 0 76 66.7 102.9 68.7 103.5-.3 1.6-10.6 36.8-35.2 72.7-21.9 31.5-44.8 63-79.6 63s-43.8-20.2-84-20.2c-39.2 0-53.1 20.9-84.9 20.9s-54.1-29.2-79.6-65c-29.6-42.1-53.5-107.5-53.5-169.5 0-99.5 64.7-152.3 128.4-152.3 33.8 0 62.1 22.2 83.3 22.2 20.2 0 51.8-23.6 90.3-23.6 14.6 0 67 1.3 101.5 50.8m-119.8-93c15.9-18.9 27.2-45.1 27.2-71.3 0-3.6-.3-7.3-1-10.3-25.9 1-56.7 17.3-75.3 38.8-14.6 16.6-28.2 42.8-28.2 69.4 0 4 .7 8 1 9.3 1.6.3 4.3.7 7 .7 23.2-.1 52.4-15.6 69.3-36.6"
      />
    </svg>
  );
}

export function InstallCommand({ className }: { className?: string }) {
  const [copied, setCopied] = useState(false);

  async function copyInstall() {
    try {
      await navigator.clipboard.writeText(INSTALL_CURL);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }

  return (
    <div
      className={cn(
        "flex h-9 min-h-9 w-full min-w-0 items-center gap-2 rounded-[5px] border border-white/15 bg-transparent py-1 pl-3 pr-1.5 text-[11px] text-white/75 md:text-xs",
        className,
      )}
    >
      <span className="shrink-0 font-mono text-emerald-400/90">&gt;_</span>
      <div className="min-w-0 flex-1 overflow-hidden [mask-image:linear-gradient(90deg,#000_72%,transparent)]">
        <code className="block whitespace-nowrap pr-6 font-mono">
          {INSTALL_CURL}
        </code>
      </div>
      <button
        type="button"
        onClick={copyInstall}
        aria-label={copied ? "Copied" : "Copy"}
        className={`relative inline-grid h-6 shrink-0 place-items-center overflow-hidden rounded-[5px] border border-white/20 bg-transparent px-2 text-[11px] font-semibold leading-none text-white/90 transition-colors duration-200 hover:border-white/35 hover:bg-white/5 sm:px-2.5 ${focusRing}`}
      >
        <span
          className={`col-start-1 row-start-1 inline-flex items-center gap-1 text-emerald-400 transition-all duration-200 ease-out ${
            copied
              ? "scale-100 opacity-100"
              : "pointer-events-none scale-95 opacity-0"
          }`}
          aria-hidden={!copied}
        >
          <Check className="size-3.5 shrink-0" strokeWidth={2.5} />
          Copied
        </span>
        <span
          className={`col-start-1 row-start-1 transition-all duration-200 ease-out ${
            copied
              ? "pointer-events-none scale-95 opacity-0"
              : "scale-100 opacity-100"
          }`}
          aria-hidden={copied}
        >
          Copy
        </span>
      </button>
    </div>
  );
}

export function LinuxIcon({ className }: { className?: string }) {
  return (
    <img
      src="/linux-icon.svg"
      alt=""
      className={cn("opacity-90 brightness-0 invert", className)}
    />
  );
}

export const OS_NAME: Record<Os, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

const OS_ORDER: Os[] = ["darwin", "win32", "linux"];

export function OsIcon({ os, className }: { os: Os; className?: string }) {
  if (os === "darwin") return <AppleIcon className={className} />;
  if (os === "win32") return <WindowsIcon className={className} />;
  return <LinuxIcon className={className} />;
}

/**
 * Download for the visitor's OS, plus the other two platforms as icons. The main button asks
 * first (a dialog with the build it will download) once GitHub Releases answered; until then,
 * and for the icons, it opens /download, which resolves the file itself.
 */
export function DownloadButtons({ className }: { className?: string }) {
  const detected = useDetectedPlatform();
  const primary = detected?.os ?? "darwin";
  const releases = useReleases();
  const [confirming, setConfirming] = useState(false);
  const asset =
    releases.status === "ready"
      ? primaryAsset(
          releases.releases[defaultChannel(releases.releases)],
          primary,
          detected?.os === primary ? detected.arch : defaultArch(primary),
          recommendedPkg(primary),
        )
      : undefined;
  return (
    <div
      className={cn(
        "flex w-full min-w-0 flex-nowrap items-center gap-2 sm:gap-2.5 md:w-max md:max-w-full",
        className,
      )}
    >
      <Link
        to="/download"
        search={{ os: primary }}
        title={`Download for ${OS_NAME[primary]}`}
        onClick={(e) => {
          if (!asset) return;
          e.preventDefault();
          setConfirming(true);
        }}
        className={`inline-flex h-9 min-h-9 min-w-0 flex-1 items-center justify-center gap-2 rounded-[5px] bg-white px-2.5 font-sans text-xs font-semibold text-black transition-opacity duration-150 hover:opacity-90 sm:px-3 ${focusRing}`}
      >
        <span className="min-w-0 truncate sm:whitespace-nowrap">
          Download for {OS_NAME[primary]}
        </span>
        <OsIcon
          os={primary}
          className={cn(
            "size-4 shrink-0",
            primary === "linux" ? "invert-0" : "text-black",
          )}
        />
      </Link>
      {OS_ORDER.filter((os) => os !== primary).map((os) => (
        <Link
          key={os}
          to="/download"
          search={{ os }}
          title={`Download for ${OS_NAME[os]}`}
          aria-label={`Download for ${OS_NAME[os]}`}
          className={platformOutlineBtn}
        >
          <OsIcon
            os={os}
            className={
              os === "linux"
                ? "size-6 md:size-5"
                : "size-5 text-white md:size-[18px]"
            }
          />
        </Link>
      ))}
      {asset ? (
        <DownloadDialog
          asset={asset}
          open={confirming}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
}
