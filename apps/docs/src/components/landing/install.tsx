import { Check } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { gitConfig } from "@/lib/shared";

export const INSTALL_CURL =
  "curl -fsSL https://raw.githubusercontent.com/LeulAria/VOLT/main/install.sh | bash";

export const REPO_URL = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;
const RELEASES_BASE = `${REPO_URL}/releases/latest`;
export const RELEASES_URL = RELEASES_BASE;
const DOWNLOAD_MAC = `${RELEASES_BASE}/download/Volt-mac.dmg`;
const DOWNLOAD_WIN = `${RELEASES_BASE}/download/Volt-windows.exe`;
const DOWNLOAD_LINUX = `${RELEASES_BASE}/download/Volt-linux.AppImage`;

export const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/35 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]";

/** Fixed square so Windows & Linux controls always match. */
const platformOutlineBtn = `inline-flex size-11 shrink-0 items-center justify-center rounded-[5px] border border-white/25 bg-transparent text-white transition-colors duration-150 hover:border-white/40 hover:bg-white/5 md:size-9 ${focusRing}`;

/** Windows logo — 4 panes, monochrome (inherits `currentColor`) */
function WindowsIcon({ className }: { className?: string }) {
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

/** GitHub mark (Streamline Unicons) — uses `currentColor` for light-on-dark header */
export function GithubMarkIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        fill="currentColor"
        d="M7.999933333333333 0.35346666666666665c-1.8616000000000001 0.00006666666666666667 -3.662466666666666 0.6626 -5.080266666666667 1.8689333333333331C1.5017999999999998 3.4287333333333327 0.5594666666666666 5.100266666666666 0.26126666666666665 6.937866666666666c-0.29819999999999997 1.8375333333333332 0.0672 3.7212666666666667 1.0308 5.3141333333333325 0.9635333333333334 1.5927333333333333 2.462466666666667 2.790733333333333 4.228533333333333 3.3795333333333333 0.39199999999999996 0.0686 0.5389999999999999 -0.1666 0.5389999999999999 -0.37239999999999995 0 -0.18619999999999998 -0.0098 -0.8036 -0.0098 -1.4602 -1.9697999999999998 0.36260000000000003 -2.4794 -0.4801333333333333 -2.6361999999999997 -0.9211333333333332 -0.174 -0.4288666666666666 -0.4498 -0.8089333333333333 -0.8036 -1.1074 -0.2744 -0.147 -0.6664 -0.5095999999999999 -0.0098 -0.5194 0.2507333333333333 0.027200000000000002 0.4911333333333333 0.11446666666666666 0.7010000000000001 0.2543333333333333 0.2098 0.13986666666666664 0.3828666666666667 0.3283333333333333 0.5044 0.5492666666666666 0.10719999999999999 0.1926 0.25139999999999996 0.36219999999999997 0.4242666666666666 0.499 0.17286666666666664 0.13679999999999998 0.37106666666666666 0.2382 0.5831999999999999 0.29819999999999997 0.2121333333333333 0.060066666666666664 0.434 0.07773333333333332 0.6529333333333334 0.05193333333333333s0.43066666666666664 -0.09453333333333333 0.6229333333333333 -0.2023333333333333c0.03393333333333333 -0.39859999999999995 0.2116 -0.7712666666666667 0.4998666666666667 -1.0486 -1.7444 -0.19599999999999998 -3.5671999999999997 -0.8722 -3.5671999999999997 -3.8709999999999996 -0.011 -0.7791333333333333 0.27646666666666664 -1.533 0.8036 -2.106933333333333 -0.23966666666666664 -0.6772 -0.21166666666666667 -1.4203999999999999 0.0784 -2.0776 0 0 0.6565333333333333 -0.20579999999999998 2.1559999999999997 0.8036 1.2828 -0.3528 2.6370666666666667 -0.3528 3.9199333333333333 0 1.4993999999999998 -1.0191999999999999 2.1559999999999997 -0.8036 2.1559999999999997 -0.8036 0.29006666666666664 0.6572 0.3181333333333333 1.4003999999999999 0.0784 2.0776 0.5286 0.5729333333333333 0.8164666666666666 1.3275333333333332 0.8036 2.106933333333333 0 3.0086 -1.8325999999999998 3.675 -3.577 3.8709999999999996 0.18706666666666666 0.1896 0.3311333333333333 0.41733333333333333 0.42246666666666666 0.6675333333333333 0.09133333333333334 0.2503333333333333 0.1277333333333333 0.5173333333333333 0.10673333333333332 0.7828666666666666 0 1.0486666666666666 -0.0098 1.8913333333333333 -0.0098 2.1559333333333335 0 0.20579999999999998 0.147 0.4508 0.5389999999999999 0.37239999999999995 1.7629333333333332 -0.5935333333333332 3.2575333333333334 -1.7943333333333333 4.217 -3.3879333333333332 0.9595333333333333 -1.5936666666666666 1.3214 -3.476466666666666 1.0211333333333332 -5.312266666666666 -0.3002666666666667 -1.8357333333333332 -1.2431333333333332 -3.5050666666666666 -2.6604 -4.709933333333333C11.659466666666667 1.0164666666666666 9.860133333333334 0.3544666666666666 7.999933333333333 0.35346666666666665Z"
      />
    </svg>
  );
}

/** Apple logo */
function AppleIcon({ className }: { className?: string }) {
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

/** Mac + Win + Linux — single row; Mac grows, platform icons fixed size */
export function DownloadButtons({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex w-full min-w-0 flex-nowrap items-center gap-2 sm:gap-2.5 md:w-max md:max-w-full",
        className,
      )}
    >
      <a
        href={DOWNLOAD_MAC}
        target="_blank"
        rel="noreferrer"
        title="Download for Mac"
        aria-label="Download for Mac"
        className={`inline-flex h-9 min-h-9 min-w-0 flex-1 items-center justify-center gap-2 rounded-[5px] bg-white px-2.5 font-sans text-xs font-semibold text-black transition-opacity duration-150 hover:opacity-90 sm:px-3 ${focusRing}`}
      >
        <span className="min-w-0 truncate sm:whitespace-nowrap">
          Download for Mac
        </span>
        <AppleIcon className="size-4 shrink-0 text-black" />
      </a>
      <a
        href={DOWNLOAD_WIN}
        target="_blank"
        rel="noreferrer"
        title="Download for Windows"
        aria-label="Download for Windows"
        className={platformOutlineBtn}
      >
        <WindowsIcon className="size-5 text-white md:size-[18px]" />
      </a>
      <a
        href={DOWNLOAD_LINUX}
        target="_blank"
        rel="noreferrer"
        title="Download for Linux"
        aria-label="Download for Linux"
        className={platformOutlineBtn}
      >
        <img
          src="/linux-icon.svg"
          alt=""
          className="size-6 opacity-90 brightness-0 invert md:size-5"
        />
      </a>
    </div>
  );
}
