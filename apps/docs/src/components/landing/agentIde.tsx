import { cn } from "@/lib/cn";
import { COLUMN } from "./geometry";
import { Reveal, SectionHeading } from "./primitives";

const SHOTS = [
  {
    src: "/volt-ipad-chat.jpg",
    width: 868,
    height: 868,
    alt: "Volt on an iPad: the sidebar with workspaces and finished chats next to an agent conversation",
  },
  {
    src: "/volt-ipad-tools.jpg",
    width: 773,
    height: 773,
    alt: "Volt on an iPad: the workspace menu with Files, Terminal, Browser, Git and previous agents",
  },
] as const;

/** Product shots: the two halves of the agent layout, side by side on wide screens. */
export function AgentIde() {
  return (
    <section
      aria-label="Agent and IDE"
      // opaque so the column guides stop at this section
      className={cn(
        COLUMN,
        // no top padding: the section above already ends with its own, and no rule sits between them
        "relative bg-[#0a0d0c] pb-10 md:pb-12",
      )}
    >
      <SectionHeading
        title="Agent + IDE."
        body="Volt integrates the agent and the IDE into one. Highly inspired by Cursor, Volt is an open-source agentic development environment."
      />
      <Reveal className="mt-14 md:mt-20">
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:gap-4">
          {SHOTS.map((shot) => (
            <li
              key={shot.src}
              className="overflow-hidden rounded-[15px] bg-[#0a0d0c] ring-1 ring-white/[0.08]"
            >
              <img
                src={shot.src}
                alt={shot.alt}
                width={shot.width}
                height={shot.height}
                loading="lazy"
                decoding="async"
                className="aspect-square w-full object-cover"
              />
            </li>
          ))}
        </ul>
      </Reveal>
    </section>
  );
}
