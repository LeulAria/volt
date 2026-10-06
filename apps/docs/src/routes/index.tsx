import { createFileRoute } from "@tanstack/react-router";
import { useRef } from "react";
import { ComposerPrompt } from "@/components/composerPrompt";
import { DynamicText } from "@/components/dynamicText";
import { AgentIde } from "@/components/landing/agentIde";
import { Capabilities } from "@/components/landing/capabilities";
import { ClosingCta, SiteFooter } from "@/components/landing/closing";
import { FeatureBento } from "@/components/landing/featureBento";
import { Guides, SectionRule } from "@/components/landing/geometry";
import { HeroGeometry } from "@/components/landing/heroGeometry";
import { DownloadButtons, InstallCommand } from "@/components/landing/install";
import { Manifesto } from "@/components/landing/manifesto";
import { Models } from "@/components/landing/models";
import { PoweredBy } from "@/components/landing/poweredBy";
import { ScrollRuler } from "@/components/landing/scrollRuler";
import { SiteHeader } from "@/components/landing/siteHeader";
import { WaveField } from "@/components/waveField";
import { gsap, REDUCED, SplitText, useGSAP } from "@/lib/gsap";
import { homeRouteLinks, homeRouteMeta } from "@/lib/seo";

export const Route = createFileRoute("/")({
  component: Home,
  head: () => ({
    // TanStack Router supports `title` and `script:ld+json` in meta; types are narrower than runtime.
    meta: [...homeRouteMeta()] as Array<
      Record<string, unknown> & { title?: string }
    >,
    links: [...homeRouteLinks()],
  }),
});

function Home() {
  const root = useRef<HTMLDivElement>(null);

  // Opening sequence: chrome settles, the wordmark rises letter by letter, then the rest follows.
  useGSAP(
    () => {
      gsap.matchMedia().add(`not ${REDUCED}`, () => {
        const word = root.current?.querySelector("[data-hero-word]");
        const line = root.current?.querySelector("[data-hero-line]");
        if (!word || !line) return;
        const chars = SplitText.create(word, { type: "chars", mask: "chars" });
        const lines = SplitText.create(line, { type: "lines", mask: "lines" });
        gsap
          .timeline({
            delay: 0.3,
            defaults: { duration: 1.3, ease: "expo.out" },
          })
          .fromTo(
            "[data-hero='head']",
            { autoAlpha: 0, y: -12 },
            { autoAlpha: 1, y: 0, stagger: 0.06 },
          )
          .set("[data-hero='title']", { autoAlpha: 1 }, 0.1)
          .from(
            chars.chars,
            { yPercent: 110, stagger: 0.07, duration: 1.4 },
            0.15,
          )
          .from(lines.lines, { yPercent: 110 }, 0.4)
          .fromTo(
            "[data-hero='rest']",
            { autoAlpha: 0, y: 20 },
            { autoAlpha: 1, y: 0, stagger: 0.1 },
            0.6,
          );
      });
    },
    { scope: root },
  );

  return (
    <div
      ref={root}
      className="home-page relative min-h-dvh overflow-x-clip bg-[#0a0d0c] font-sans text-white antialiased"
    >
      <div
        aria-hidden
        className="scroll-progress pointer-events-none fixed inset-x-0 top-0 z-50 h-px bg-[#ff8a5a]"
      />
      <section className="home-shell relative min-h-dvh md:h-[100vh] md:overflow-hidden">
        <div className="home-grain" aria-hidden />
        <WaveField />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 z-[2] h-40 bg-gradient-to-b from-transparent to-[#0a0d0c]"
        />
        <div className="relative z-10 flex min-h-dvh flex-col md:h-[100vh] md:min-h-0 md:overflow-hidden">
          <SiteHeader animate />

          <div className="relative z-0 flex min-h-0 flex-1 flex-col md:min-h-0 md:flex-1">
            <div className="relative z-0 flex flex-1 items-center justify-center px-4 py-2 sm:px-5 sm:py-6 md:flex-none md:px-4 md:py-1">
              <div className="relative">
                <HeroGeometry />
                {/* square slot the construction drawing scales into */}
                <div className="relative mx-auto aspect-square size-[min(76vw,320px)] sm:size-[min(46vw,300px)] md:mx-0 md:size-auto md:h-[min(60vh,680px)] md:max-h-[min(92vw,680px)] md:w-auto md:max-w-[min(92vw,680px)] md:shrink-0" />
              </div>
            </div>

            <div className="relative z-20 flex shrink-0 flex-col px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-1 max-md:mt-auto sm:px-6 sm:pb-10 md:-mt-[calc(min(60vh,680px)+0.5rem)] md:h-[calc(100vh-2.75rem)] md:justify-end md:px-10 md:pb-6 md:pt-0 lg:px-12">
              <div className="mx-auto w-full max-w-[1200px]">
                <div className="flex flex-col">
                  <div className="min-w-0">
                    <div data-hero="title">
                      <h1 className="font-sans font-semibold tracking-tight">
                        <div className="h-[40px] min-h-[36px]">
                          <DynamicText />
                        </div>
                        <span
                          data-hero-word
                          className="inline-flex shrink-0 items-center font-mono text-4xl font-semibold tracking-wide text-white sm:text-5xl md:text-7xl"
                        >
                          volt
                        </span>
                        <div className="flex flex-col gap-2">
                          <span
                            data-hero-line
                            className="mt-2 block max-w-xl text-balance text-[20px] leading-tight text-white sm:mt-1.5 sm:text-xl md:mt-2 md:text-[32px] md:leading-[1.1]"
                          >
                            The agentic development workspace.
                          </span>
                        </div>
                      </h1>
                    </div>

                    <div data-hero="rest">
                      <div className="mt-4 w-full text-[14px] leading-relaxed text-white/55 sm:mt-3 sm:text-sm md:text-[15px] md:leading-snug">
                        <p className="max-w-xl text-pretty">
                          Workspace, editor, Git, and terminal, unified in one
                          lightning-fast surface.
                          <br className="hidden sm:block" /> AI agents handle
                          the mechanics so you stay in flow.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                <div data-hero="rest" className="mt-6 w-full min-w-0 sm:mt-6">
                  <div className="flex w-full min-w-0 flex-col gap-6 md:flex-row md:items-end md:justify-between md:gap-8">
                    {/* Below md: 2 lines (curl, then platforms). md+: one line with curl capped at 300px */}
                    <div className="flex w-full min-w-0 flex-col gap-3 md:flex-row md:items-end md:gap-3">
                      <div className="flex w-full min-w-0 flex-col md:w-auto md:max-w-[300px] md:shrink-0">
                        <div className="mb-1 w-fit text-[10px] font-medium uppercase tracking-[0.16em] text-white/35">
                          Install
                        </div>
                        <InstallCommand />
                      </div>

                      {/* Mac + Win + Linux — single row; Mac grows, platform icons fixed size */}
                      <div className="w-full min-w-0 md:w-auto md:overflow-visible">
                        <DownloadButtons />
                      </div>
                    </div>

                    <div className="hidden w-full min-w-0 lg:block">
                      <ComposerPrompt />
                    </div>
                  </div>
                </div>

                <p
                  data-hero="rest"
                  className="mt-5 inline-flex max-w-xl items-center gap-2 text-pretty text-[12px] leading-relaxed text-white/40 sm:mt-4 sm:text-xs"
                >
                  <span className="relative inline-flex size-1.5" aria-hidden>
                    <span className="absolute inset-0 animate-ping rounded-full bg-[#3ecf8e] opacity-60" />
                    <span className="relative size-1.5 rounded-full bg-[#3ecf8e]" />
                  </span>
                  Already in public beta • 4.9k developers joined this week
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <ScrollRuler />
      <main className="relative">
        <Guides />
        <SectionRule />
        <Manifesto />
        <SectionRule className="mt-0" />
        <AgentIde />
        <SectionRule className="mt-24 md:mt-32" />
        <PoweredBy />
        <SectionRule className="mt-24 md:mt-32" />
        <FeatureBento />
        <SectionRule className="mt-24 md:mt-32" />
        <Capabilities />
        <SectionRule className="mt-24 md:mt-32" />
        <Models />
        <SectionRule className="mt-24 md:mt-32" />
        <ClosingCta />
        <SectionRule />
        <SiteFooter />
      </main>
    </div>
  );
}
