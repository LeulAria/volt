import { cn } from "@/lib/cn";
import { COLUMN, Eyebrow } from "./geometry";
import { Reveal, SectionHeading } from "./primitives";

/** The same window three ways, from a lone prompt to everything at once. */
const STAGES = [
  {
    label: "Just a prompt",
    body: "A project, a branch, a model and the prompt. Nothing else on screen.",
    src: "/scale/simple.webp",
    width: 1600,
    height: 1005,
    alt: "Volt with only a new agent's prompt: the project, branch, This Mac and Full access pickers, the model, and Plan New Idea and Multitask",
    span: "lg:col-span-3",
  },
  {
    label: "Tools beside it",
    body: "Files, a terminal, a browser, a device and more open beside the chat, each one shortcut away.",
    src: "/scale/tools.webp",
    width: 1600,
    height: 997,
    alt: "A new agent's prompt beside the panel that opens a file, terminal, browser, device, changes, scratch, canvas, automations or a side chat, each with its shortcut",
    span: "lg:col-span-4",
  },
  {
    label: "Everything at once",
    body: "Every agent in the sidebar, subagents at work, a queue, a pull request and source control in one window.",
    src: "/scale/everything.webp",
    width: 1600,
    height: 1012,
    alt: "Volt with everything open: the agents sidebar, a running chat with subagents, tasks and a queued message, the subagents and pull request list, and source control",
    span: "lg:col-span-5",
  },
] as const;

/**
 * Simple to complex: the window at three stages, each wider than the last from lg, so the row
 * climbs like a staircase. Below lg they stack.
 */
export function WorkspaceScale() {
  return (
    <section
      aria-label="As simple or as complex as you need"
      // opaque so the column guides stop at this section
      className={cn(
        COLUMN,
        "relative bg-[#0a0d0c] pt-24 pb-10 md:pt-32 md:pb-12",
      )}
    >
      <SectionHeading
        title={
          <>
            As simple as it gets.
            <br />
            <span className="text-white/40">As complex as you need.</span>
          </>
        }
        body="Start with a prompt and nothing else. Open tools beside it when the work calls for them, or keep every agent, subagent and change in view at once."
      />
      <ol className="mt-14 grid grid-cols-1 gap-x-4 gap-y-12 md:mt-20 lg:grid-cols-12 lg:items-end">
        {STAGES.map((stage, index) => (
          <li key={stage.src} className={stage.span}>
            <Reveal delay={index * 0.12}>
              <Eyebrow index={index + 1}>{stage.label}</Eyebrow>
              <p className="mt-3 max-w-md text-pretty text-[14px] leading-[1.6] text-white/50">
                {stage.body}
              </p>
              <div className="mt-5 overflow-hidden rounded-[12px] bg-[#0a0d0c] ring-1 ring-white/[0.08]">
                <img
                  src={stage.src}
                  alt={stage.alt}
                  width={stage.width}
                  height={stage.height}
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  className="aspect-[16/10] w-full object-cover object-top"
                />
              </div>
            </Reveal>
          </li>
        ))}
      </ol>
    </section>
  );
}
