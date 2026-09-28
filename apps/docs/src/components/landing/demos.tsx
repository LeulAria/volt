import { type ReactNode, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { gsap, REDUCED, useGSAP } from "@/lib/gsap";
import { AgentStage, type Mode, ModeSwitch } from "./agentShowcase";
import { BrowserStage } from "./browserComment";
import { COLUMN, Eyebrow, SectionRule } from "./geometry";
import { Reveal, SectionHeading } from "./primitives";
import { SplitStage } from "./splitEditor";

/** The three product demos, one after another. */
export function Demos() {
  const [mode, setMode] = useState<Mode>("agent");
  return (
    <>
      <DemoSection
        id="demo"
        index={1}
        eyebrow="Agent workspace"
        title="First ever agent + IDE view."
        muted="One window."
        body="Volt integrates the agent and the IDE into one. Highly inspired by Cursor, Volt is an open-source agentic development environment."
        aside={<ModeSwitch mode={mode} onMode={setMode} />}
      >
        <AgentStage mode={mode} />
      </DemoSection>
      <SectionRule className="mt-24 md:mt-32" />
      <DemoSection
        index={2}
        eyebrow="Editor"
        title="Chat and code, side by side."
        muted="Watch every edit land."
        body="Open any file next to the conversation. Edits stream into the editor as the agent writes them, marked in the gutter until you keep them."
      >
        <SplitStage />
      </DemoSection>
      <SectionRule className="mt-24 md:mt-32" />
      <DemoSection
        index={3}
        eyebrow="Built-in browser"
        title="Point at it."
        muted="Say what should change."
        body="Click any element in your running app and leave a comment. The agent gets the element, its source location, and your note, then edits the code while the page updates."
      >
        <BrowserStage />
      </DemoSection>
    </>
  );
}

function DemoSection({
  id,
  index,
  eyebrow,
  title,
  muted,
  body,
  aside,
  children,
}: {
  id?: string;
  index: number;
  eyebrow: string;
  title: string;
  muted: string;
  body: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null);

  // the window tilts up out of the page and settles flat as it scrolls into view
  useGSAP(
    () => {
      gsap.matchMedia().add(`not ${REDUCED}`, () => {
        gsap.fromTo(
          stage.current,
          {
            rotateX: 12,
            scale: 0.92,
            y: 60,
            autoAlpha: 0.35,
            transformPerspective: 1800,
            transformOrigin: "50% 0%",
          },
          {
            rotateX: 0,
            scale: 1,
            y: 0,
            autoAlpha: 1,
            ease: "none",
            scrollTrigger: {
              trigger: stage.current,
              start: "top bottom",
              end: "top 60%",
              scrub: 0.8,
            },
          },
        );
      });
    },
    { scope: stage },
  );

  return (
    <section id={id} className={cn(COLUMN, "relative pt-24 md:pt-32")}>
      <div className="flex flex-col gap-8 md:flex-row md:items-end md:justify-between">
        <SectionHeading
          eyebrow={<Eyebrow index={index}>{eyebrow}</Eyebrow>}
          title={
            <>
              {title}
              <br />
              <span className="text-white/40">{muted}</span>
            </>
          }
          body={body}
        />
        {aside ? (
          <Reveal delay={0.1} className="shrink-0">
            {aside}
          </Reveal>
        ) : null}
      </div>
      <div ref={stage} className="mt-12 md:mt-16">
        {children}
      </div>
    </section>
  );
}
