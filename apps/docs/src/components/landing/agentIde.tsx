import { cn } from "@/lib/cn";
import { COLUMN } from "./geometry";
import { Reveal, SectionHeading } from "./primitives";

const SHOTS = [
  {
    src: "/volt-ipad-chat.jpg",
    width: 868,
    height: 868,
    alt: "Volt on an iPad: the sidebar with workspaces and finished chats next to an agent conversation",
    label: "Chats",
    caption: "Every chat and workspace in one sidebar.",
  },
  {
    src: "/volt-ipad-tools.jpg",
    width: 773,
    height: 773,
    alt: "Volt on an iPad: the workspace menu with Files, Terminal, Browser, Git and previous agents",
    label: "Tools",
    caption: "Files, terminal, browser, and Git a click away.",
  },
] as const;

/** Product shots: the two halves of the agent layout, side by side on wide screens. */
export function AgentIde() {
  return (
    <section
      aria-label="Agent and IDE"
      className={cn(COLUMN, "relative pt-24 md:pt-32")}
    >
      <SectionHeading
        title="Agent + IDE."
        body="Volt integrates the agent and the IDE into one. Highly inspired by Cursor, Volt is an open-source agentic development environment."
      />
      <Reveal className="mt-14 md:mt-20">
        <ul className="grid grid-cols-1 gap-px border-y border-white/[0.08] border-x border-x-transparent bg-white/[0.08] bg-clip-padding max-md:border-x-white/[0.08] sm:grid-cols-2">
          {SHOTS.map((shot, i) => (
            <li key={shot.src} className="flex flex-col bg-[#0a0d0c]">
              <img
                src={shot.src}
                alt={shot.alt}
                width={shot.width}
                height={shot.height}
                loading="lazy"
                decoding="async"
                className="aspect-square w-full object-cover"
              />
              <p className="flex items-baseline gap-3 border-t border-white/[0.08] px-5 py-4 text-[13.5px] text-white/45 md:px-7">
                <span className="shrink-0 whitespace-nowrap font-mono text-[10.5px] tracking-[0.16em] text-[#ff8a5a] uppercase">
                  {String(i + 1).padStart(2, "0")} {shot.label}
                </span>
                <span className="min-w-0 text-pretty">{shot.caption}</span>
              </p>
            </li>
          ))}
        </ul>
      </Reveal>
    </section>
  );
}
