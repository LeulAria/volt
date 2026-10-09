import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { useState } from "react";
import {
  AllDownloads,
  ChannelPicker,
} from "@/components/download/allDownloads";
import { PrimaryDownload } from "@/components/download/primaryDownload";
import { SiteFooter } from "@/components/landing/closing";
import {
  COLUMN,
  Eyebrow,
  Guides,
  SectionRule,
} from "@/components/landing/geometry";
import { focusRing, InstallCommand } from "@/components/landing/install";
import { HEADING_INSET } from "@/components/landing/primitives";
import { SiteHeader } from "@/components/landing/siteHeader";
import { cn } from "@/lib/cn";
import {
  type Arch,
  CHANNEL_INFO,
  CHANNELS,
  type Channel,
  defaultArch,
  defaultChannel,
  formatDate,
  type Os,
  platformOf,
} from "@/lib/releases";
import { downloadRouteLinks, downloadRouteMeta } from "@/lib/seo";
import {
  GITHUB_RELEASES_URL,
  useDetectedPlatform,
  useReleases,
} from "@/lib/useReleases";

const OSES: readonly Os[] = ["darwin", "win32", "linux"];

interface DownloadSearch {
  os?: Os;
  channel?: Channel;
}

export const Route = createFileRoute("/download")({
  component: DownloadPage,
  validateSearch: (search: Record<string, unknown>): DownloadSearch => ({
    os: OSES.find((o) => o === search.os),
    channel: CHANNELS.find((c) => c === search.channel),
  }),
  head: () => ({
    meta: downloadRouteMeta(),
    links: downloadRouteLinks(),
  }),
});

const LINK = `inline-flex items-center gap-1 rounded text-white/70 underline-offset-4 transition-colors hover:text-white hover:underline ${focusRing}`;

function DownloadPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/download" });
  const state = useReleases();
  const detected = useDetectedPlatform();

  // ?os= (from the landing's platform icons) wins over detection; phones fall back to macOS
  const os: Os = search.os ?? detected?.os ?? "darwin";
  const detectedArch = detected?.os === os ? detected.arch : defaultArch(os);
  const [archChoice, setArchChoice] = useState<Arch | null>(null);
  const arch = archChoice ?? detectedArch;

  const channel: Channel =
    search.channel ??
    (state.status === "ready" ? defaultChannel(state.releases) : "stable");
  const release =
    state.status === "ready" ? state.releases[channel] : undefined;
  const info = CHANNEL_INFO[channel];

  const unsupported = detected !== null && detected.os === null;
  const platformLabel = platformOf(os).label;

  return (
    <div className="home-page relative min-h-dvh overflow-x-clip bg-[#0a0d0c] font-sans text-white antialiased">
      <SiteHeader />
      <main className="relative">
        <Guides />
        <section
          className={cn(COLUMN, "relative pt-20 pb-20 md:pt-28 md:pb-28")}
        >
          <div className={HEADING_INSET}>
            <Eyebrow>Download</Eyebrow>
            <h1 className="mt-6 text-balance text-[40px] font-semibold leading-[1.02] tracking-[-0.035em] text-white sm:text-[56px] md:text-[68px]">
              Get Volt.
            </h1>
            <p className="mt-5 max-w-xl text-pretty text-[15px] leading-[1.65] text-white/50 md:text-[17px]">
              {unsupported
                ? "Volt is a desktop app for macOS, Windows, and Linux. Open this page on your computer, or grab a build below."
                : `Free while in public beta. Here is the build for ${platformLabel}; every other platform and channel is listed below.`}
            </p>
            <PrimaryDownload
              state={state}
              channel={channel}
              os={os}
              arch={arch}
              onArch={setArchChoice}
              className="mt-10"
            />
          </div>
        </section>

        <SectionRule />
        <section
          aria-labelledby="channels-title"
          className={cn(COLUMN, "relative pt-16 md:pt-20")}
        >
          <div className={cn(HEADING_INSET, "max-w-2xl")}>
            <h2
              id="channels-title"
              className="text-[24px] font-semibold tracking-[-0.025em] text-white md:text-[30px]"
            >
              Choose a channel.
            </h2>
            <p className="mt-3 text-pretty text-[14.5px] leading-[1.65] text-white/50">
              Channels install side by side. Volt, Volt Beta, and Volt Nightly
              are separate apps with their own settings and updates, so trying
              Nightly never touches your Stable install.
            </p>
          </div>
          <div className="mt-10">
            <ChannelPicker
              state={state}
              channel={channel}
              onChannel={(c) =>
                navigate({
                  search: (prev) => ({ ...prev, channel: c }),
                  replace: true,
                  resetScroll: false,
                })
              }
            />
          </div>
        </section>

        <section
          aria-labelledby="all-title"
          className={cn(COLUMN, "relative pt-20 md:pt-24")}
        >
          <div
            className={cn(
              HEADING_INSET,
              "flex flex-col gap-2 md:flex-row md:items-end md:justify-between md:pr-8",
            )}
          >
            <h2
              id="all-title"
              className="text-[24px] font-semibold tracking-[-0.025em] text-white md:text-[30px]"
            >
              All downloads
            </h2>
            <p className="flex flex-wrap items-center gap-x-2 text-[13px] text-white/45">
              {state.status === "loading" ? (
                "Loading releases…"
              ) : release ? (
                <>
                  <span className="text-white/75">
                    {info.app} {release.version}
                  </span>
                  <span>· {formatDate(release.publishedAt)} ·</span>
                  <a
                    href={release.htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                    className={LINK}
                  >
                    Release notes
                    <ArrowUpRight className="size-3.5" />
                  </a>
                </>
              ) : (
                <>
                  <span>
                    {state.status === "error"
                      ? "GitHub didn't answer."
                      : `No ${info.label} release yet.`}
                  </span>
                  <a
                    href={GITHUB_RELEASES_URL}
                    target="_blank"
                    rel="noreferrer"
                    className={LINK}
                  >
                    All releases on GitHub
                    <ArrowUpRight className="size-3.5" />
                  </a>
                </>
              )}
            </p>
          </div>
          <div className="mt-8">
            <AllDownloads release={release} highlight={search.os} />
          </div>
        </section>

        <section
          className={cn(COLUMN, "relative pt-20 pb-24 md:pt-24 md:pb-32")}
        >
          <div
            className={cn(
              HEADING_INSET,
              "flex flex-col gap-8 md:flex-row md:items-end md:justify-between md:pr-8",
            )}
          >
            <div className="w-full max-w-[460px]">
              <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.16em] text-white/35">
                Or install from a terminal
              </div>
              <InstallCommand />
            </div>
            <a
              href={GITHUB_RELEASES_URL}
              target="_blank"
              rel="noreferrer"
              className={cn(LINK, "text-[13px]")}
            >
              Every release and checksum on GitHub
              <ArrowUpRight className="size-3.5" />
            </a>
          </div>
        </section>
        <SectionRule />
        <SiteFooter />
      </main>
    </div>
  );
}
