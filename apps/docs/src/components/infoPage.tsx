import { Inline } from "@/components/inlineMarkdown";
import { SiteFooter } from "@/components/landing/closing";
import {
  COLUMN,
  Eyebrow,
  Guides,
  SectionRule,
} from "@/components/landing/geometry";
import { HEADING_INSET } from "@/components/landing/primitives";
import { SiteHeader } from "@/components/landing/siteHeader";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/releases";
import type { InfoPage } from "@/lib/sitePages";

/** About, Contact and Privacy: the download page's frame around plain, readable text. */
export function InfoPageView({ page }: { page: InfoPage }) {
  return (
    <div className="home-page relative min-h-dvh overflow-x-clip bg-[#0a0d0c] font-sans text-white antialiased">
      <SiteHeader />
      <main className="relative">
        <Guides />
        <section
          className={cn(COLUMN, "relative pt-20 pb-24 md:pt-28 md:pb-32")}
        >
          <div className={cn(HEADING_INSET, "max-w-[760px] pr-4 md:pr-8")}>
            <Eyebrow>{page.eyebrow}</Eyebrow>
            <h1 className="mt-6 text-balance text-[40px] font-semibold leading-[1.02] tracking-[-0.035em] text-white sm:text-[56px]">
              {page.title}
            </h1>
            <p className="mt-5 text-pretty text-[16px] leading-[1.7] text-white/60 md:text-[17px]">
              {page.description}
            </p>
            <p className="mt-3 font-mono text-[12px] text-white/35">
              Last updated {formatDate(`${page.updated}T12:00:00Z`)}
            </p>
            {page.sections.map((section) => (
              <section key={section.heading} className="mt-12">
                <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-white">
                  {section.heading}
                </h2>
                {section.paragraphs.map((paragraph) => (
                  <p
                    key={paragraph}
                    className="mt-4 text-pretty text-[16px] leading-[1.75] text-white/65"
                  >
                    <Inline text={paragraph} />
                  </p>
                ))}
                {section.items?.length ? (
                  <ul className="mt-4 space-y-3">
                    {section.items.map((item) => (
                      <li
                        key={item}
                        className="grid grid-cols-[1.25rem_minmax(0,1fr)] text-pretty text-[16px] leading-[1.75] text-white/65"
                      >
                        <span aria-hidden className="text-white/35">
                          –
                        </span>
                        <span>
                          <Inline text={item} />
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ))}
          </div>
        </section>
        <SectionRule />
        <SiteFooter />
      </main>
    </div>
  );
}
