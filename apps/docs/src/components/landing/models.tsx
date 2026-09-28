import { type CSSProperties, type ReactNode, useRef } from "react";
import { cn } from "@/lib/cn";
import { gsap, REDUCED, useGSAP } from "@/lib/gsap";
import { type BrandId, BrandIcon } from "./brandIcons";
import { COLUMN, Eyebrow } from "./geometry";
import { SectionHeading } from "./primitives";
import { PROVIDER_ICONS, type ProviderIconId } from "./providerIcons";

/** Agent CLIs Volt detects on PATH and drives with the user's own sign-in. */
const HARNESSES: { id: BrandId; name: string; command: string }[] = [
  { id: "claude", name: "Claude Code", command: "claude" },
  { id: "codex", name: "Codex CLI", command: "codex" },
  { id: "opencode", name: "OpenCode", command: "opencode" },
  { id: "cursor", name: "Cursor", command: "cursor-agent" },
  { id: "grok", name: "Grok CLI", command: "grok" },
  { id: "antigravity", name: "Antigravity", command: "agy" },
];

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
        gsap.from(root.querySelectorAll("[data-harness]"), {
          y: 16,
          autoAlpha: 0,
          stagger: 0.06,
          duration: 1.1,
          scrollTrigger: {
            trigger: root.querySelector("[data-harnesses]"),
            start: "top 88%",
            once: true,
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
          eyebrow={<Eyebrow>Models</Eyebrow>}
          title={
            <>
              Bring your own subscription.
              <br />
              <span className="text-white/40">Or any model you like.</span>
            </>
          }
          body="Volt doesn't sell tokens. Plug in Claude Code, Codex, OpenCode, Cursor, Grok, Antigravity, or Kimi Code with the sign-in you already have. Volt runs them; you keep your plan."
        />

        <ul
          data-harnesses
          className="mt-14 grid grid-cols-2 gap-px overflow-hidden rounded-[16px] border border-white/[0.09] bg-white/[0.09] sm:grid-cols-3 md:mt-20 lg:grid-cols-6"
        >
          {HARNESSES.map((h) => (
            <li
              key={h.id}
              data-harness
              className="group flex items-center gap-3.5 bg-[#0c0f0e] px-5 py-6 transition-colors duration-300 hover:bg-[#111413]"
            >
              <span className="grid size-7 shrink-0 place-items-center text-white transition-transform duration-300 group-hover:scale-110">
                <BrandIcon id={h.id} size={24} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[14.5px] font-medium text-white">
                  {h.name}
                </span>
                <span className="mt-0.5 block truncate font-mono text-[12px] text-white/40">
                  {h.command}
                </span>
              </span>
            </li>
          ))}
        </ul>

        <Eyebrow className="mt-20 md:mt-24">
          Or an API key, or a model on your own hardware
        </Eyebrow>
      </div>

      <div data-tickers className="mt-8 flex flex-col">
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
    <div className="ticker-row relative -mt-px overflow-hidden border-y border-white/[0.07] [mask-image:linear-gradient(90deg,transparent,#000_10%,#000_90%,transparent)]">
      <ul
        className="ticker flex w-max"
        data-reverse={reverse || undefined}
        style={{ "--ticker-speed": `${speed}s` } as CSSProperties}
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
