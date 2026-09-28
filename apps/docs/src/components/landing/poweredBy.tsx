import { Blocks, Bug, Keyboard, Palette } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { BOLT_H, BOLT_PATH, BOLT_W } from "@/lib/boltGeometry";
import { cn } from "@/lib/cn";
import { gsap, REDUCED, useGSAP } from "@/lib/gsap";
import { COLUMN, Eyebrow } from "./geometry";
import { SectionHeading } from "./primitives";

const CARRIED: { icon: ReactNode; title: string; body: string }[] = [
  {
    icon: <Blocks className="size-[18px]" strokeWidth={1.5} />,
    title: "Extensions",
    body: "Install from Open VSX, or side-load any .vsix.",
  },
  {
    icon: <Palette className="size-[18px]" strokeWidth={1.5} />,
    title: "Themes & icons",
    body: "Every color theme and icon pack you already use.",
  },
  {
    icon: <Keyboard className="size-[18px]" strokeWidth={1.5} />,
    title: "Keybindings",
    body: "Your shortcuts, settings, and snippets carry over.",
  },
  {
    icon: <Bug className="size-[18px]" strokeWidth={1.5} />,
    title: "Language tooling",
    body: "Language servers, debuggers, and tasks just work.",
  },
];

export function PoweredBy() {
  const ref = useRef<HTMLElement>(null);

  // the two marks slide in from either side and settle next to each other
  useGSAP(
    () => {
      gsap.matchMedia().add(`not ${REDUCED}`, () => {
        const root = ref.current;
        if (!root) return;
        gsap
          .timeline({
            scrollTrigger: {
              trigger: root.querySelector("[data-pair]"),
              start: "top 80%",
              once: true,
            },
            defaults: { duration: 1.3, ease: "expo.out" },
          })
          .from("[data-mark='left']", { x: -40, autoAlpha: 0 })
          .from("[data-mark='right']", { x: 40, autoAlpha: 0 }, "<")
          .from(
            "[data-carried]",
            { y: 18, autoAlpha: 0, stagger: 0.08, duration: 1.1 },
            0.5,
          );
      });
    },
    { scope: ref },
  );

  return (
    <section ref={ref} className={cn(COLUMN, "relative pt-24 md:pt-32")}>
      <SectionHeading
        eyebrow={<Eyebrow>Foundation</Eyebrow>}
        title="Powered by VS Code."
        body="Volt is built on the open-source VS Code core. The editor, extensions, and muscle memory you rely on come along; the agent layer is what's new."
      />

      <div
        data-pair
        className="flex items-start justify-center gap-20 py-20 sm:gap-36 md:py-28"
      >
        <Mark side="left" label="VS Code" caption="Open-source core">
          <VsCodeMark className="size-14 sm:size-[76px]" />
        </Mark>
        <Mark side="right" label="Volt" caption="Agent workspace">
          <svg
            viewBox={`0 0 ${BOLT_W} ${BOLT_H}`}
            aria-hidden
            className="h-16 w-auto sm:h-[88px]"
          >
            <path d={BOLT_PATH} fill="#fff" fillRule="evenodd" />
          </svg>
        </Mark>
      </div>

      <ul className="grid grid-cols-1 gap-px border-y border-white/[0.07] bg-white/[0.07] sm:grid-cols-2 md:grid-cols-4">
        {CARRIED.map((item) => (
          <li
            key={item.title}
            data-carried
            className="flex flex-col gap-4 bg-[#0a0d0c] px-6 py-8 md:px-7"
          >
            <span className="text-white/60">{item.icon}</span>
            <div>
              <div className="text-[14.5px] font-medium text-white">
                {item.title}
              </div>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-white/45">
                {item.body}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Mark({
  side,
  label,
  caption,
  children,
}: {
  side: "left" | "right";
  label: string;
  caption: string;
  children: ReactNode;
}) {
  return (
    <div data-mark={side} className="flex flex-col items-center gap-6">
      <div className="grid h-16 place-items-center sm:h-[84px]">{children}</div>
      <div className="text-center">
        <div className="text-[15px] font-medium text-white">{label}</div>
        <div className="mt-1 font-mono text-[10px] tracking-[0.14em] text-white/35 uppercase">
          {caption}
        </div>
      </div>
    </div>
  );
}

export function VsCodeMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="#fff"
      aria-hidden
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M0.228341 8.36915C0.228341 8.36915 -0.356212 7.94324 0.345251 7.37453L1.97956 5.89736C1.97956 5.89736 2.44721 5.40004 2.94164 5.83334L18.0231 17.375V22.9094C18.0231 22.9094 18.0158 23.7785 16.9124 23.6825L0.228341 8.36915Z" />
      <path d="M4.11555 11.9367L0.228273 15.5089C0.228273 15.5089 -0.171172 15.8093 0.228273 16.346L2.03308 18.0053C2.03308 18.0053 2.46175 18.4706 3.09502 17.9413L7.21611 14.7827L4.11555 11.9367Z" />
      <path d="M10.94 11.9661L18.0691 6.46362L18.0228 0.95865C18.0228 0.95865 17.7183 -0.242793 16.7027 0.382548L7.21589 9.11025L10.94 11.9661Z" />
      <path d="M16.9121 23.69C17.3261 24.1183 17.8279 23.978 17.8279 23.978L23.3838 21.2108C24.0951 20.7208 23.9952 20.1127 23.9952 20.1127V3.58803C23.9952 2.86175 23.2596 2.61063 23.2596 2.61063L18.4441 0.264377C17.3919 -0.392968 16.7027 0.382548 16.7027 0.382548C16.7027 0.382548 17.5892 -0.262484 18.0228 0.95865L18.0228 22.8086C18.0228 22.9588 17.9911 23.1065 17.9278 23.2394C17.8011 23.4979 17.5259 23.7392 16.8658 23.6383L16.9121 23.69Z" />
    </svg>
  );
}
