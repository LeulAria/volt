import changelogSource from "virtual:changelog";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Inline } from "@/components/inlineMarkdown";
import { SiteFooter } from "@/components/landing/closing";
import {
  COLUMN,
  Eyebrow,
  Guides,
  SectionRule,
} from "@/components/landing/geometry";
import { focusRing } from "@/components/landing/install";
import { HEADING_INSET, PageBackdrop } from "@/components/landing/primitives";
import { SiteHeader } from "@/components/landing/siteHeader";
import {
  type ChangelogRelease,
  type ChangelogSection,
  parseChangelog,
  splitReleaseTitle,
} from "@/lib/changelog";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/releases";
import { changelogRouteLinks, changelogRouteMeta } from "@/lib/seo";
import { gitConfig } from "@/lib/shared";
import { GITHUB_RELEASES_URL } from "@/lib/useReleases";

const REPO_URL = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;
const RELEASES = parseChangelog(changelogSource);
/** Each release's anchor, which is also its entry's id. */
const RELEASE_IDS = RELEASES.map((release) => `v${release.version}`);

export const Route = createFileRoute("/changelog")({
  component: ChangelogPage,
  head: () => ({
    meta: changelogRouteMeta(),
    links: changelogRouteLinks(),
  }),
});

const LINK = `inline-flex items-center gap-1 rounded text-white/70 underline-offset-4 transition-colors hover:text-white hover:underline ${focusRing}`;

function ChangelogPage() {
  return (
    <div className="home-page relative min-h-dvh overflow-x-clip bg-[#0a0d0c] font-sans text-white antialiased">
      <SiteHeader />
      <main className="relative">
        <Guides />
        <div className="relative">
          <PageBackdrop src="/changelog-backdrop.webp" position="50% 30%" />
          <section
            className={cn(COLUMN, "relative pt-20 pb-16 md:pt-28 md:pb-20")}
          >
            <div className={HEADING_INSET}>
              <Eyebrow>Changelog</Eyebrow>
              <h1 className="mt-6 text-balance text-[40px] font-semibold leading-[1.02] tracking-[-0.035em] text-white sm:text-[56px] md:text-[68px]">
                What's new in Volt.
              </h1>
              <p className="mt-5 max-w-xl text-pretty text-[15px] leading-[1.65] text-white md:text-[17px]">
                Every release, newest first. Volt is in public beta, so expect
                changes between versions.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 text-[13px]">
                <Link
                  to="/download"
                  className="inline-flex h-9 items-center rounded-full bg-white px-4 font-medium text-[#0a0d0c] transition-colors hover:bg-white/85"
                >
                  Download the latest
                </Link>
                <a
                  href={GITHUB_RELEASES_URL}
                  target="_blank"
                  rel="noreferrer"
                  className={LINK}
                >
                  Releases on GitHub
                  <ArrowUpRight className="size-3.5" />
                </a>
              </div>
            </div>
          </section>
        </div>
        <div className="relative">
          {/* From lg, the versions run down the left of the entries. Above them, so the rail takes
              its clicks; only the rail itself catches the pointer. */}
          <div className="pointer-events-none absolute inset-0 z-10 hidden lg:block">
            <div className={cn(COLUMN, "h-full")}>
              <div className={cn(HEADING_INSET, "h-full")}>
                <ReleaseRail />
              </div>
            </div>
          </div>
          {RELEASES.map((release, index) => (
            <ReleaseEntry
              key={release.version}
              release={release}
              latest={index === 0}
            />
          ))}
        </div>
        <div className="pb-16 md:pb-24" />
        <SectionRule />
        <SiteFooter />
      </main>
    </div>
  );
}

function ReleaseEntry({
  release,
  latest,
}: {
  release: ChangelogRelease;
  latest: boolean;
}) {
  const id = `v${release.version}`;
  const { title, intro } = splitReleaseTitle(release.intro);
  return (
    <>
      <SectionRule />
      <article
        id={id}
        aria-labelledby={`${id}-title`}
        className={cn(COLUMN, "relative pt-12 pb-4 md:pt-16")}
      >
        <div
          className={cn(
            HEADING_INSET,
            // from lg the rail sits in the first 160px; the text keeps its width
            "max-w-[820px] pr-4 md:pr-8 lg:max-w-[948px] lg:pl-40",
          )}
        >
          <header>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-[15px]">
              <a
                href={`#${id}`}
                className={`rounded text-white/90 transition-colors hover:text-white ${focusRing}`}
              >
                {release.version}
              </a>
              {release.date ? (
                <span className="text-white/40">
                  {formatDate(`${release.date}T12:00:00Z`)}
                </span>
              ) : null}
              <span
                className={cn(
                  "inline-flex h-7 items-center rounded-full border px-3 font-sans text-[13px]",
                  latest
                    ? "border-[#ff8a5a]/40 text-[#ff8a5a]"
                    : "border-white/15 text-white/60",
                )}
              >
                {latest ? "Latest" : "Stable"}
              </span>
              <a
                href={`${REPO_URL}/releases/tag/v${release.version}`}
                target="_blank"
                rel="noreferrer"
                className={cn(LINK, "font-sans text-[13px] text-white/45")}
              >
                Release notes
                <ArrowUpRight className="size-3.5" />
              </a>
            </div>
            <h2
              id={`${id}-title`}
              className="mt-4 text-balance text-[24px] font-semibold leading-[1.25] tracking-[-0.02em] text-white md:text-[28px]"
            >
              {title ?? `Volt ${release.version}`}
            </h2>
          </header>
          {intro.map((paragraph) => (
            <p
              key={paragraph}
              className="mt-3 text-pretty text-[16px] leading-[1.75] text-white/60 md:text-[17px]"
            >
              <Inline text={paragraph} />
            </p>
          ))}
          {release.sections.map((section) => (
            <Section key={section.title} section={section} />
          ))}
        </div>
      </article>
    </>
  );
}

/**
 * The release being read: the last one whose entry has reached a line 30% down the window. At the
 * bottom of the page it is the last release, which is too short to ever reach that line.
 */
function useActiveRelease(ids: readonly string[]) {
  const [active, setActive] = useState(ids[0]);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = window.innerHeight * 0.3;
      let current = ids[0];
      for (const id of ids) {
        const top = document.getElementById(id)?.getBoundingClientRect().top;
        if (top !== undefined && top <= line) current = id;
      }
      const atBottom =
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 2;
      setActive(atBottom ? ids[ids.length - 1] : current);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [ids]);
  return active;
}

/** Every version, sticky beside the entries: the one being read is lit, and each jumps to its entry. */
function ReleaseRail() {
  const active = useActiveRelease(RELEASE_IDS);
  const navigate = useNavigate();
  return (
    <nav
      aria-label="Releases"
      // level with the first entry's version line: its rule (1px) and top padding (64px)
      className="pointer-events-auto sticky top-10 mt-[65px] w-fit"
    >
      <ol className="flex flex-col gap-0.5">
        {RELEASES.map((release) => {
          const id = `v${release.version}`;
          const current = id === active;
          return (
            <li key={id}>
              <a
                href={`#${id}`}
                aria-current={current ? "true" : undefined}
                // Through the router: with its scroll restoration on, following a bare hash link
                // changes the URL but leaves the page where it was. Replace, not push: Back from a
                // jump would change the hash without scrolling back.
                onClick={(event) => {
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  navigate({ to: "/changelog", hash: id, replace: true });
                }}
                className={cn(
                  "flex h-7 items-center gap-2.5 rounded pr-2 font-mono text-[14px] transition-colors duration-200",
                  current ? "text-white" : "text-white/35 hover:text-white/70",
                  focusRing,
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full bg-[#ff8a5a] transition-opacity duration-200",
                    current ? "opacity-100" : "opacity-0",
                  )}
                />
                {release.version}
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Keep a Changelog's section names, each with its colour and the mark its items lead with. */
const SECTION_STYLES: Record<string, { tone: string; mark: string }> = {
  highlights: { tone: "text-[#ff8a5a]", mark: "★" },
  added: { tone: "text-emerald-400", mark: "+" },
  changed: { tone: "text-amber-300", mark: "~" },
  performance: { tone: "text-sky-400", mark: "↑" },
  fixed: { tone: "text-violet-300", mark: "✓" },
  removed: { tone: "text-red-400", mark: "–" },
  deprecated: { tone: "text-orange-300", mark: "!" },
  security: { tone: "text-red-400", mark: "!" },
};
const DEFAULT_SECTION_STYLE = { tone: "text-white/50", mark: "•" };

function Section({ section }: { section: ChangelogSection }) {
  const style =
    SECTION_STYLES[section.title.toLowerCase()] ?? DEFAULT_SECTION_STYLE;
  return (
    <section className="mt-10">
      {section.title ? (
        <h3 className={cn("text-[14px] font-medium", style.tone)}>
          {section.title}
        </h3>
      ) : null}
      {section.paragraphs.map((paragraph) => (
        <p
          key={paragraph}
          className="mt-3 text-pretty text-[16px] leading-[1.75] text-white/60"
        >
          <Inline text={paragraph} />
        </p>
      ))}
      {section.groups.map((group, index) => (
        <div key={group.label ?? index} className="mt-4">
          {group.label ? (
            <h4 className="mt-6 mb-2 text-[15px] font-medium text-white/85">
              {group.label}
            </h4>
          ) : null}
          <ul className="space-y-2.5">
            {group.items.map((item) => (
              <li
                key={item}
                className="grid grid-cols-[1.5rem_minmax(0,1fr)] text-pretty text-[16px] leading-[1.75] text-white/60"
              >
                <span
                  aria-hidden
                  className={cn("select-none font-mono opacity-80", style.tone)}
                >
                  {style.mark}
                </span>
                <span>
                  <Inline text={item} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
