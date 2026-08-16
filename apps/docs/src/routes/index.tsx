import { createFileRoute } from "@tanstack/react-router";
import { Check, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { DynamicText } from "@/components/dynamicText";
import { homeRouteLinks, homeRouteMeta } from "@/lib/seo";
import { gitConfig } from "@/lib/shared";

const INSTALL_CURL = "curl -fsSL https://raw.githubusercontent.com/LeulAria/VOLT/main/install.sh | bash";

const RELEASES_BASE = `https://github.com/${gitConfig.user}/${gitConfig.repo}/releases/latest`;
const DOWNLOAD_MAC = `${RELEASES_BASE}/download/Volt-mac.dmg`;
const DOWNLOAD_WIN = `${RELEASES_BASE}/download/Volt-windows.exe`;
const DOWNLOAD_LINUX = `${RELEASES_BASE}/download/Volt-linux.AppImage`;

/** Replace with your public demo URL when it ships (YouTube, Loom, etc.) */
const DEMO_VIDEO_URL = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

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
function GithubMarkIcon({ className }: { className?: string }) {
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
        strokeWidth={0.6667}
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

/** Fixed square so Windows & Linux controls always match. */
const platformOutlineBtn =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-[4px] border border-white/40 bg-transparent text-white transition-colors hover:border-white/55 hover:bg-white/5";

export const Route = createFileRoute("/")({
  component: Home,
  head: () => ({
    // TanStack Router supports `title` and `script:ld+json` in meta; types are narrower than runtime.
    meta: [...homeRouteMeta()] as Array<Record<string, unknown> & { title?: string }>,
    links: [...homeRouteLinks()],
  }),
});

function Home() {
  const [copied, setCopied] = useState(false);
  const [releaseTag, setReleaseTag] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const url = `https://api.github.com/repos/${gitConfig.user}/${gitConfig.repo}/releases/latest`;
    fetch(url, { headers: { Accept: "application/vnd.github+json" } })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { tag_name?: string } | null) => {
        if (!cancelled && data?.tag_name) setReleaseTag(data.tag_name);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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
    <div className="relative min-h-screen bg-black font-sans text-white antialiased">
      <img
        src="/hero-ide.png"
        alt=""
        width={1024}
        height={656}
        className="pointer-events-none absolute inset-0 h-full w-full object-cover object-top-left"
        decoding="async"
        fetchPriority="high"
        sizes="100vw"
      />
      <div
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,#00000066_0%,#00000066_50%,#00000080_58%,#000000bf_72%,#000_88%,#000_100%)]"
        aria-hidden
      />

      {/* md–xl: baked-in ~90% scale so layout matches reference whether browser is at 100% or 90% zoom */}
      <div className="relative z-10 flex min-h-screen flex-col md:min-h-[111.11vh] md:[zoom:0.9]">
        <header className="mx-auto flex w-full max-w-[1200px] shrink-0 flex-wrap items-center justify-end gap-2 px-4 pt-5 sm:gap-3 sm:px-6 sm:pt-6 md:px-10 lg:px-12">
          <div className="flex flex-col gap-0.5 rounded-[4px] border border-white/20 px-2 py-1.5 text-[10px] font-medium uppercase tracking-[0.2em] text-white/95">
            <span>Public beta</span>
            {releaseTag ? (
              <span className="font-mono text-[9px] font-semibold normal-case tracking-normal text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.85)]">
                {releaseTag}
              </span>
            ) : null}
          </div>
          <a
            href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}
            target="_blank"
            rel="noreferrer"
            title="Volt on GitHub"
            aria-label="Volt on GitHub"
            className="group inline-flex items-center gap-2 rounded-[4px] px-1.5 py-1 text-[10px] font-medium uppercase tracking-wider text-white/90 transition-colors [text-shadow:0_1px_2px_rgba(0,0,0,0.9),0_2px_8px_rgba(0,0,0,0.55)] hover:bg-white/5 hover:text-white"
          >
            <GithubMarkIcon className="size-4 shrink-0 filter-[drop-shadow(0_1px_1px_rgba(0,0,0,0.85))] transition-transform group-hover:scale-105" />
            <span>GitHub</span>
          </a>
        </header>

        <div className="flex min-h-0 flex-1 flex-col justify-end overflow-x-hidden px-4 pb-10 pt-6 sm:px-6 sm:pb-12 sm:pt-8 md:px-10 md:pb-16 md:pt-12 lg:px-12">
          <div className="mx-auto w-full max-h-[1200px] min-h-0 max-w-[1200px] overflow-y-auto overscroll-contain">
            <h1 className="font-sans font-semibold tracking-tight">
              <div className="min-h-[36px] h-[40px]">
                <DynamicText />
              </div>
              <span className="inline-flex shrink-0 items-center font-mono text-4xl font-bold tracking-wide sm:text-5xl md:text-7xl">
                volt
              </span>
              <div className="flex flex-col gap-2">
                <span className="mt-2 max-w-xl py-1 text-xl leading-tight sm:py-2 sm:text-2xl md:mt-3 md:text-4xl md:leading-[1.05]">
                  The agentic development workspace.
                </span>
              </div>
            </h1>

            <div className="mt-3 w-full space-y-1.5 text-sm leading-snug text-white/55 sm:mt-4 sm:text-[15px] md:text-base">
              <p className="max-w-xl">
                Workspace, editor, Git, and terminal, unified in one lightning-fast surface.
                <br className="hidden sm:block" /> AI agents handle the mechanics so you stay in
                flow.
              </p>
            </div>

            <div className="mt-5 w-full min-w-0 sm:mt-6">
              <div className="mb-1 text-xs text-white/40">Install</div>
              <div className="flex w-full min-w-0 flex-col gap-3 md:flex-row md:items-center md:justify-between md:gap-4">
                {/* Below md: 2 lines (curl, then platforms). md+: one line with curl capped at 300px */}
                <div className="flex w-full min-w-0 flex-col gap-3 md:flex-row md:items-center md:gap-3">
                  <div className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-[4px] border border-white/30 bg-black/40 py-[5px] pl-3 pr-2 text-[11px] text-white/75 md:max-w-[300px] md:shrink-0 md:text-xs">
                    <span className="shrink-0 font-mono text-emerald-400/90">&gt;_</span>
                    <div className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:thin]">
                      <code className="block whitespace-nowrap pr-1 font-mono">{INSTALL_CURL}</code>
                    </div>
                    <button
                      type="button"
                      onClick={copyInstall}
                      className="shrink-0 rounded-[4px] border border-white/15 bg-white/5 px-2.5 py-1.5 text-xs font-semibold text-white/90 transition-colors hover:bg-white/10 sm:px-3 sm:text-sm"
                    >
                      {copied ? (
                        <span className="inline-flex items-center gap-1.5 text-emerald-400/90">
                          <Check className="size-3.5" strokeWidth={2.5} />
                          Copied
                        </span>
                      ) : (
                        "Copy"
                      )}
                    </button>
                  </div>

                  {/* Mac + Win + Linux — single row; Mac grows, platform icons fixed size */}
                  <div className="w-full min-w-0 overflow-x-auto [scrollbar-width:thin] md:w-auto md:min-w-0 md:overflow-visible">
                    <div className="flex w-full min-w-0 flex-nowrap items-center gap-2 sm:gap-2.5 md:w-max md:max-w-full">
                      <a
                        href={DOWNLOAD_MAC}
                        target="_blank"
                        rel="noreferrer"
                        title="Download for Mac"
                        aria-label="Download for Mac"
                        className="inline-flex h-11 min-h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-[4px] bg-white px-2.5 font-sans text-sm font-semibold text-black transition-opacity hover:opacity-90 sm:px-3.5"
                      >
                        <span className="min-w-0 truncate sm:whitespace-nowrap">Download for Mac</span>
                        <AppleIcon className="size-5 shrink-0 text-black" />
                      </a>
                      <a
                        href={DOWNLOAD_WIN}
                        target="_blank"
                        rel="noreferrer"
                        title="Download for Windows"
                        aria-label="Download for Windows"
                        className={platformOutlineBtn}
                      >
                        <WindowsIcon className="size-[22px] text-white" />
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
                          className="size-6 opacity-90 grayscale brightness-0 invert"
                        />
                      </a>
                    </div>
                  </div>
                </div>

                <a
                  href={DEMO_VIDEO_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-10 w-full shrink-0 items-center justify-center gap-2 rounded-[4px] border border-white/35 bg-white/5 px-3 font-sans text-xs font-semibold text-white backdrop-blur-sm transition-colors hover:border-white/50 hover:bg-white/10 sm:h-11 md:w-auto md:min-w-[220px] md:px-4 md:text-sm"
                >
                  <Play className="size-3.5 shrink-0 sm:size-4" strokeWidth={2.25} />
                  <span className="whitespace-nowrap">Watch 47-second demo</span>
                </a>
              </div>
            </div>

            <p className="mt-3 max-w-xl text-pretty text-[11px] leading-relaxed text-white/45 [text-shadow:0_1px_16px_rgba(0,0,0,0.75)] sm:mt-4 sm:text-xs">
              Already in public beta • 4.9k developers joined this week
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
