import changelogSource from "virtual:changelog";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { SiteFooter } from "@/components/landing/closing";
import {
  COLUMN,
  Eyebrow,
  Guides,
  SectionRule,
} from "@/components/landing/geometry";
import { focusRing } from "@/components/landing/install";
import { HEADING_INSET } from "@/components/landing/primitives";
import { SiteHeader } from "@/components/landing/siteHeader";
import {
  type ChangelogRelease,
  type ChangelogSection,
  parseChangelog,
  parseInline,
  resolveChangelogHref,
} from "@/lib/changelog";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/releases";
import { changelogRouteLinks, changelogRouteMeta } from "@/lib/seo";
import { gitConfig } from "@/lib/shared";
import { GITHUB_RELEASES_URL } from "@/lib/useReleases";

const REPO_URL = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;
const RELEASES = parseChangelog(changelogSource);

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
        <section
          className={cn(COLUMN, "relative pt-20 pb-16 md:pt-28 md:pb-20")}
        >
          <div className={HEADING_INSET}>
            <Eyebrow>Changelog</Eyebrow>
            <h1 className="mt-6 text-balance text-[40px] font-semibold leading-[1.02] tracking-[-0.035em] text-white sm:text-[56px] md:text-[68px]">
              What's new in Volt.
            </h1>
            <p className="mt-5 max-w-xl text-pretty text-[15px] leading-[1.65] text-white/50 md:text-[17px]">
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
        {RELEASES.map((release, index) => (
          <ReleaseEntry
            key={release.version}
            release={release}
            latest={index === 0}
          />
        ))}
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
  return (
    <>
      <SectionRule />
      <article
        id={id}
        aria-labelledby={`${id}-title`}
        className={cn(
          COLUMN,
          "relative grid gap-6 pt-12 pb-4 md:grid-cols-[220px_minmax(0,1fr)] md:gap-10 md:pt-16",
        )}
      >
        <header
          className={cn(HEADING_INSET, "md:sticky md:top-8 md:self-start")}
        >
          <a
            href={`#${id}`}
            className={`inline-flex items-center gap-3 rounded ${focusRing}`}
          >
            <h2
              id={`${id}-title`}
              className="font-mono text-[22px] font-semibold tracking-[-0.01em] text-white md:text-[26px]"
            >
              {release.version}
            </h2>
            {latest ? (
              <span className="inline-flex h-5 items-center rounded-full border border-[#ff8a5a]/40 bg-[#ff8a5a]/10 px-2 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-[#ff8a5a]">
                Latest
              </span>
            ) : null}
          </a>
          {release.date ? (
            <div className="mt-2 text-[13px] text-white/45">
              {formatDate(`${release.date}T12:00:00Z`)}
            </div>
          ) : null}
          <a
            href={`${REPO_URL}/releases/tag/v${release.version}`}
            target="_blank"
            rel="noreferrer"
            className={cn(LINK, "mt-3 text-[13px]")}
          >
            Release notes
            <ArrowUpRight className="size-3.5" />
          </a>
        </header>
        <div className="max-w-[720px] pl-4 sm:pl-6 md:pl-0 md:pr-8">
          {release.intro.map((paragraph) => (
            <p
              key={paragraph}
              className="text-pretty text-[16px] leading-[1.7] text-white/75"
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

function Section({ section }: { section: ChangelogSection }) {
  return (
    <section className="mt-10 first:mt-0">
      {section.title ? (
        <h3 className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-white/45">
          {section.title}
        </h3>
      ) : null}
      {section.paragraphs.map((paragraph) => (
        <p
          key={paragraph}
          className="mt-4 text-pretty text-[14.5px] leading-[1.7] text-white/65"
        >
          <Inline text={paragraph} />
        </p>
      ))}
      {section.groups.map((group, index) => (
        <div key={group.label ?? index} className="mt-5">
          {group.label ? (
            <h4 className="mb-2 text-[14px] font-medium text-white/85">
              {group.label}
            </h4>
          ) : null}
          <ul className="space-y-2">
            {group.items.map((item) => (
              <li
                key={item}
                className="relative pl-5 text-pretty text-[14.5px] leading-[1.7] text-white/65 before:absolute before:top-[0.8em] before:left-1 before:size-1 before:rounded-full before:bg-white/30"
              >
                <Inline text={item} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((token, index) => {
        const key = `${index}-${token.text}`;
        switch (token.kind) {
          case "strong":
            return (
              <strong key={key} className="font-semibold text-white/90">
                {token.text}
              </strong>
            );
          case "em":
            return (
              <em key={key} className="text-white/80">
                {token.text}
              </em>
            );
          case "code":
            return (
              <code
                key={key}
                className="rounded bg-white/[0.07] px-1.5 py-0.5 font-mono text-[0.86em] text-white/80"
              >
                {token.text}
              </code>
            );
          case "link":
            return (
              <a
                key={key}
                href={resolveChangelogHref(token.href, REPO_URL)}
                target="_blank"
                rel="noreferrer"
                className="text-white/85 underline decoration-white/30 underline-offset-4 transition-colors hover:text-white hover:decoration-white/70"
              >
                {token.text}
              </a>
            );
          default:
            return <span key={key}>{token.text}</span>;
        }
      })}
    </>
  );
}
