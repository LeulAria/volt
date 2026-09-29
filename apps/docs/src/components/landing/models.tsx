import { type ReactNode, useRef } from "react";
import { cn } from "@/lib/cn";
import { gsap, REDUCED, ScrollTrigger, useGSAP } from "@/lib/gsap";
import { COLUMN } from "./geometry";
import { SectionHeading } from "./primitives";
import { PROVIDER_ICONS, type ProviderIconId } from "./providerIcons";

type Provider = { id: ProviderIconId; name: string };

const FRONTIER: Provider[] = [
  { id: "claude", name: "Claude" },
  { id: "openai", name: "OpenAI" },
  { id: "gemini", name: "Gemini" },
  { id: "grok", name: "Grok" },
  { id: "deepseek", name: "DeepSeek" },
  { id: "mistral", name: "Mistral" },
  { id: "meta", name: "Llama" },
  { id: "qwen", name: "Qwen" },
  { id: "kimi", name: "Kimi" },
  { id: "zhipu", name: "GLM" },
  { id: "minimax", name: "MiniMax" },
  { id: "perplexity", name: "Perplexity" },
];

const SELF_HOSTED: Provider[] = [
  { id: "ollama", name: "Ollama" },
  { id: "lmstudio", name: "LM Studio" },
  { id: "vllm", name: "vLLM" },
  { id: "nvidia", name: "NVIDIA NIM" },
  { id: "huggingface", name: "Hugging Face" },
  { id: "openrouter", name: "OpenRouter" },
  { id: "groq", name: "Groq" },
  { id: "together", name: "Together AI" },
  { id: "bedrock", name: "Amazon Bedrock" },
  { id: "vertexai", name: "Vertex AI" },
  { id: "azure", name: "Azure OpenAI" },
];

export function Models() {
  const ref = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const root = ref.current;
      if (!root) return;
      gsap.matchMedia().add(`not ${REDUCED}`, () => {
        // Each row loops by sliding half its width (the list renders twice). Scrolling kicks
        // the rows forward in proportion to scroll speed, then they ease back to cruising.
        const loops = gsap.utils
          .toArray<HTMLElement>("[data-ticker]", root)
          .map((list) => {
            const reverse = list.dataset.reverse !== undefined;
            return gsap.fromTo(
              list,
              { xPercent: reverse ? -50 : 0 },
              {
                xPercent: reverse ? 0 : -50,
                duration: Number(list.dataset.speed),
                ease: "none",
                repeat: -1,
              },
            );
          });
        const cruise = (boost: number, duration: number) => {
          for (const loop of loops) {
            gsap.to(loop, { timeScale: boost, duration, overwrite: true });
          }
        };
        let settle: gsap.core.Tween | undefined;
        ScrollTrigger.create({
          trigger: root,
          start: "top bottom",
          end: "bottom top",
          onUpdate: (self) => {
            const boost = gsap.utils.clamp(
              1,
              7,
              1 + Math.abs(self.getVelocity()) / 350,
            );
            cruise(boost, 0.25);
            settle?.kill();
            settle = gsap.delayedCall(0.2, () => cruise(1, 1.4));
          },
        });

        gsap.from(root.querySelectorAll(".ticker-row"), {
          autoAlpha: 0,
          x: (i) => (i % 2 ? -60 : 60),
          stagger: 0.12,
          duration: 1.6,
          scrollTrigger: {
            trigger: root.querySelector("[data-tickers]"),
            start: "top 90%",
            once: true,
          },
        });
      });
    },
    { scope: ref },
  );

  return (
    <section ref={ref} className="relative pt-24 md:pt-32">
      <div className={COLUMN}>
        <SectionHeading
          title={
            <>
              Bring your own subscription.
              <br />
              <span className="text-white/40">Or any model you like.</span>
            </>
          }
          body="Volt doesn't sell tokens. Plug in Claude Code, Codex, OpenCode, Cursor, Grok, Antigravity, or Kimi Code with the sign-in you already have. Volt runs them; you keep your plan."
        />
      </div>

      <div data-tickers className="relative z-10 mt-14 flex flex-col md:mt-20">
        <Ticker items={FRONTIER} speed={70} />
        <Ticker items={SELF_HOSTED} speed={80} reverse />
      </div>
    </section>
  );
}

/** One news-ticker row: full-bleed, hairlines above and below, edges fading out. */
function Ticker({
  items,
  speed,
  reverse,
}: {
  items: Provider[];
  speed: number;
  reverse?: boolean;
}) {
  const loop = [...items, ...items];
  return (
    <div className="ticker-row relative z-10 -mt-px overflow-hidden border-y border-white/[0.07] bg-[#0a0d0c]">
      <div className="[mask-image:linear-gradient(90deg,transparent,#000_10%,#000_90%,transparent)]">
        <ul
          data-ticker
          data-speed={speed}
          data-reverse={reverse || undefined}
          className="flex w-max will-change-transform"
        >
          {loop.map((p, i) => (
            <Item
              // biome-ignore lint/suspicious/noArrayIndexKey: the list is repeated for a seamless loop
              key={`${p.id}-${i}`}
              hidden={i >= items.length}
            >
              <ProviderIcon id={p.id} className="size-[22px]" />
              {p.name}
            </Item>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Item({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  return (
    <li
      aria-hidden={hidden || undefined}
      className="flex h-[88px] shrink-0 items-center gap-3 border-r border-white/[0.07] px-10 text-[15px] font-medium whitespace-nowrap text-white/55 transition-colors duration-300 hover:text-white"
    >
      {children}
    </li>
  );
}

function ProviderIcon({
  id,
  className,
}: {
  id: ProviderIconId;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      aria-hidden
      className={cn("block shrink-0", className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: static brand paths bundled in providerIcons.ts
      dangerouslySetInnerHTML={{ __html: PROVIDER_ICONS[id] }}
    />
  );
}
