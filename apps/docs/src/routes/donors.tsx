import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowUpRight,
  Check,
  Coffee,
  Gift,
  Heart,
  type LucideIcon,
  Rocket,
  Zap,
} from "lucide-react";
import { SiteFooter } from "@/components/landing/closing";
import {
  COLUMN,
  Eyebrow,
  Guides,
  SectionRule,
} from "@/components/landing/geometry";
import { focusRing, GithubMarkIcon } from "@/components/landing/install";
import { HEADING_INSET } from "@/components/landing/primitives";
import { SiteHeader } from "@/components/landing/siteHeader";
import { cn } from "@/lib/cn";
import { sitePageLinks, sitePageMeta } from "@/lib/seo";
import {
  DONATION_TIERS,
  DONORS,
  DONORS_PAGE,
  type DonationTier,
  type Donor,
  SPONSOR_URL,
  tierUrl,
} from "@/lib/sitePages";

export const Route = createFileRoute("/donors")({
  component: DonorsPage,
  head: () => ({
    meta: sitePageMeta({
      title: DONORS_PAGE.eyebrow,
      description: DONORS_PAGE.description,
      path: DONORS_PAGE.path,
    }) as Array<Record<string, unknown> & { title?: string }>,
    links: sitePageLinks(DONORS_PAGE.path),
  }),
});

/** Hairline grid shared with the download page: 1px gaps over a tinted backdrop. */
const GRID =
  "grid grid-cols-1 gap-px border-y border-white/[0.08] border-x border-x-transparent bg-white/[0.08] bg-clip-padding max-md:border-x-white/[0.08]";
const PRIMARY = `inline-flex h-10 items-center justify-center gap-2 rounded-[6px] bg-white px-4 text-[13px] font-semibold text-black transition-opacity hover:opacity-90 ${focusRing}`;
const SECONDARY = `inline-flex h-10 items-center justify-center gap-2 rounded-[6px] border border-white/20 px-4 text-[13px] font-semibold text-white transition-colors hover:border-white/35 hover:bg-white/5 ${focusRing}`;
const H2 =
  "text-[24px] font-semibold tracking-[-0.025em] text-white md:text-[30px]";
const LEAD = "mt-3 text-pretty text-[14.5px] leading-[1.65] text-white/50";

const TIER_ICONS: Record<string, LucideIcon> = {
  Supporter: Coffee,
  Backer: Zap,
  Sponsor: Rocket,
  "One-time": Gift,
};
const FEATURED = "Backer";
const ONE_TIME =
  DONATION_TIERS.find((t) => t.amount === undefined) ?? DONATION_TIERS[0];
const BACKER =
  DONATION_TIERS.find((t) => t.name === FEATURED) ?? DONATION_TIERS[0];

/** Donations: the GitHub Sponsors tiers, the donor wall and a few answers. */
function DonorsPage() {
  return (
    <div className="home-page relative min-h-dvh overflow-x-clip bg-[#0a0d0c] font-sans text-white antialiased">
      <SiteHeader />
      <main className="relative">
        <Guides />
        <section
          className={cn(COLUMN, "relative pt-20 pb-20 md:pt-28 md:pb-28")}
        >
          <div className={HEADING_INSET}>
            <Eyebrow>{DONORS_PAGE.eyebrow}</Eyebrow>
            <h1 className="mt-6 text-balance text-[40px] font-semibold leading-[1.02] tracking-[-0.035em] text-white sm:text-[56px] md:text-[68px]">
              {DONORS_PAGE.title}
              <span className="block text-white/35">
                {DONORS_PAGE.subtitle}
              </span>
            </h1>
            <p className="mt-5 max-w-xl text-pretty text-[15px] leading-[1.65] text-white/50 md:text-[17px]">
              {DONORS_PAGE.description}
            </p>
            <div className="mt-10 flex flex-wrap gap-2">
              <a
                href={SPONSOR_URL}
                target="_blank"
                rel="noreferrer"
                className={PRIMARY}
              >
                <Heart className="size-4" />
                Sponsor on GitHub
              </a>
              <a
                href={tierUrl(ONE_TIME)}
                target="_blank"
                rel="noreferrer"
                className={SECONDARY}
              >
                Give once
              </a>
            </div>
          </div>
        </section>

        <SectionRule />
        <section
          aria-labelledby="tiers-title"
          className={cn(COLUMN, "relative pt-16 md:pt-20")}
        >
          <div className={cn(HEADING_INSET, "max-w-2xl")}>
            <h2 id="tiers-title" className={H2}>
              Pick your tier.
            </h2>
            <p className={LEAD}>
              Monthly or once, through GitHub Sponsors. Change or cancel
              anytime.
            </p>
          </div>
          <div className={cn(GRID, "mt-10 sm:grid-cols-2 lg:grid-cols-4")}>
            {DONATION_TIERS.map((tier) => (
              <TierCell key={tier.name} tier={tier} />
            ))}
          </div>
        </section>

        <section
          aria-labelledby="donors-title"
          className={cn(COLUMN, "relative pt-20 md:pt-24")}
        >
          <div className={cn(HEADING_INSET, "max-w-2xl")}>
            <h2 id="donors-title" className={H2}>
              Donors.
            </h2>
            <p className={LEAD}>The people keeping Volt's agents fed.</p>
          </div>
          <div className="mt-10">
            {DONORS.length ? <DonorWall /> : <EmptyWall />}
          </div>
        </section>

        <section
          aria-labelledby="faq-title"
          className={cn(COLUMN, "relative pt-20 pb-24 md:pt-24 md:pb-32")}
        >
          <h2 id="faq-title" className={cn(HEADING_INSET, H2)}>
            Questions.
          </h2>
          <dl className={cn(GRID, "mt-10 md:grid-cols-3")}>
            {DONORS_PAGE.faq.map((item) => (
              <div key={item.q} className="bg-[#0a0d0c] px-6 pt-7 pb-8 md:px-8">
                <dt className="text-[15.5px] font-medium tracking-[-0.01em] text-white">
                  {item.q}
                </dt>
                <dd className="mt-2 text-pretty text-[13.5px] leading-relaxed text-white/45">
                  {item.a}
                </dd>
              </div>
            ))}
          </dl>
        </section>
        <SectionRule />
        <SiteFooter />
      </main>
    </div>
  );
}

/** One tier as a cell of the grid; the featured one is lifted and marked with the accent line. */
function TierCell({ tier }: { tier: DonationTier }) {
  const featured = tier.name === FEATURED;
  const Icon = TIER_ICONS[tier.name] ?? Heart;
  return (
    <div
      className={cn(
        "relative flex flex-col px-6 pt-7 pb-6 md:px-8",
        featured ? "bg-[#0d1110]" : "bg-[#0a0d0c]",
      )}
    >
      {featured ? (
        <span
          aria-hidden
          className="absolute inset-x-0 -top-px h-px bg-[#ff8a5a]"
        />
      ) : null}
      <div className="flex items-center gap-2.5">
        <Icon
          className={cn(
            "size-4",
            featured ? "text-[#ff8a5a]" : "text-white/55",
          )}
        />
        <h3 className="text-[15.5px] font-medium tracking-[-0.01em] text-white">
          {tier.name}
        </h3>
        {featured ? (
          <span className="ml-auto font-mono text-[11px] text-[#ff8a5a]">
            Recommended
          </span>
        ) : null}
      </div>
      <div className="mt-6 flex items-baseline gap-1.5">
        <span className="text-[36px] font-semibold leading-none tracking-[-0.04em] text-white">
          {tier.amount === undefined ? "Any" : `$${tier.amount}`}
        </span>
        <span className="text-[13px] text-white/40">
          {tier.amount === undefined ? "amount" : "/ month"}
        </span>
      </div>
      <p className="mt-3 min-h-[2lh] text-pretty text-[13.5px] leading-relaxed text-white/45">
        {tier.blurb}
      </p>
      <ul className="mt-5 space-y-2 border-t border-white/[0.06] pt-5">
        {tier.perks.map((perk) => (
          <li
            key={perk}
            className="flex items-start gap-2.5 text-[13.5px] leading-[1.5] text-white/70"
          >
            <Check
              className={cn(
                "mt-[3px] size-3.5 shrink-0",
                featured ? "text-[#ff8a5a]" : "text-white/40",
              )}
            />
            {perk}
          </li>
        ))}
      </ul>
      <div className="mt-auto pt-8">
        <a
          href={tierUrl(tier)}
          target="_blank"
          rel="noreferrer"
          className={cn("w-full", featured ? PRIMARY : SECONDARY)}
        >
          {tier.amount === undefined
            ? "Give any amount"
            : `Give $${tier.amount} a month`}
        </a>
      </div>
    </div>
  );
}

/** Before the first donor: open seats, and a way to take the first one. */
function EmptyWall() {
  return (
    <div className={cn(GRID, "md:grid-cols-[minmax(0,1fr)_auto]")}>
      <div className="flex items-center gap-3 bg-[#0a0d0c] px-6 py-6 md:px-8">
        <Heart className="size-4 shrink-0 text-[#ff8a5a]" />
        <p className="text-pretty text-[14.5px] text-white/60">
          No names here yet. Yours could be the first.
        </p>
      </div>
      <div className="flex items-center bg-[#0a0d0c] px-6 py-6 md:px-8">
        <a
          href={tierUrl(BACKER)}
          target="_blank"
          rel="noreferrer"
          className={cn(SECONDARY, "max-md:w-full")}
        >
          <GithubMarkIcon className="size-4" />
          Become a Backer
          <ArrowUpRight className="size-4" />
        </a>
      </div>
    </div>
  );
}

function DonorWall() {
  const top = DONORS.filter((d) => d.top);
  const rest = DONORS.filter((d) => !d.top);
  return (
    <div className={cn(GRID, "sm:grid-cols-2 lg:grid-cols-4")}>
      {[...top, ...rest].map((donor) => (
        <div
          key={donor.name}
          className={cn(
            "flex items-center gap-2.5 truncate px-6 py-5 md:px-8",
            donor.top
              ? "bg-[#0d1110] text-[16px] font-semibold text-white"
              : "bg-[#0a0d0c] text-[14px] text-white/70",
          )}
        >
          {donor.top ? (
            <Heart className="size-3.5 shrink-0 text-[#ff8a5a]" />
          ) : null}
          <DonorName donor={donor} />
        </div>
      ))}
    </div>
  );
}

function DonorName({ donor }: { donor: Donor }) {
  return donor.url ? (
    <a
      href={donor.url}
      target="_blank"
      rel="noreferrer"
      className={`truncate rounded transition-colors hover:text-white ${focusRing}`}
    >
      {donor.name}
    </a>
  ) : (
    <span className="truncate">{donor.name}</span>
  );
}
