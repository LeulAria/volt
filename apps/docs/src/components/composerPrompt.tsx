import { Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { cn } from "@/lib/cn";

const DEFAULT_PROMPT = "";

type ProviderId = "all" | "cloud" | "grok" | "claude" | "gemini" | "local";
type Effort = "Extra High" | "High" | "Medium" | "Low";
type Flyout = "models" | "effort" | null;
type SvgIcon = (props: { className?: string }) => ReactElement;

type Model = {
  id: string;
  name: string;
  provider: Exclude<ProviderId, "all">;
  preview: string;
};

const EFFORTS: Effort[] = ["Extra High", "High", "Medium", "Low"];

const MODELS: Model[] = [
  { id: "auto", name: "Auto", provider: "grok", preview: "Auto" },
  { id: "grok-4.6", name: "Grok 4.6", provider: "grok", preview: "Grok 4.6 Extra High Fast" },
  { id: "composer-2.5", name: "Composer 2.5", provider: "cloud", preview: "Composer 2.5 Fast" },
  { id: "opus-5", name: "Claude Opus 5", provider: "claude", preview: "Claude Opus 5 Medium Fast" },
  { id: "opus-4.8", name: "Claude Opus 4.8", provider: "claude", preview: "Claude Opus 4.8 Medium" },
  { id: "gpt-5.6", name: "GPT 5.6 Sol", provider: "local", preview: "GPT 5.6 Sol Medium" },
  { id: "gpt-5.5", name: "GPT 5.5", provider: "local", preview: "GPT 5.5 Medium" },
  { id: "fable-5", name: "Claude Fable 5", provider: "claude", preview: "Claude Fable 5 High" },
  { id: "grok-4.5", name: "Grok 4.5", provider: "grok", preview: "Grok 4.5 High Fast" },
  { id: "gemini-3", name: "Gemini 3 Flash", provider: "gemini", preview: "Gemini 3 Flash" },
];

const RAIL: { id: ProviderId; label: string; icon: SvgIcon }[] = [
  { id: "all", label: "All models", icon: InfinityIcon },
  { id: "cloud", label: "Cloud", icon: CloudIcon },
  { id: "grok", label: "Grok", icon: BoxIcon },
  { id: "claude", label: "Claude", icon: SquareIcon },
  { id: "gemini", label: "Gemini", icon: SparkleIcon },
  { id: "local", label: "Local", icon: MonitorIcon },
];

function modelLabel(model: Model, effort: Effort, fast: boolean, selectedId: string) {
  if (model.id === "auto") return "Auto";
  if (model.id === selectedId) {
    return [model.name, effort, fast ? "Fast" : null].filter(Boolean).join(" ");
  }
  return model.preview;
}

function triggerLabel(model: Model, effort: Effort, fast: boolean) {
  if (model.id === "auto") return "Auto";
  return [effort, fast ? "Fast" : null].filter(Boolean).join(" ");
}

export function ComposerPrompt() {
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<ProviderId>("all");
  const [selectedId, setSelectedId] = useState("grok-4.6");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [effort, setEffort] = useState<Effort>("Extra High");
  const [fast, setFast] = useState(true);
  const [flyout, setFlyout] = useState<Flyout>(null);

  const selected = MODELS.find((model) => model.id === selectedId) ?? MODELS[1];

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return MODELS.filter((model) => {
      if (model.id === "auto") {
        return provider === "all" && (!needle || "auto".includes(needle));
      }
      if (provider !== "all" && model.provider !== provider) return false;
      if (!needle) return true;
      return modelLabel(model, effort, fast, selectedId).toLowerCase().includes(needle);
    });
  }, [effort, fast, provider, query, selectedId]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(28, el.scrollHeight)}px`;
  }, [prompt]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const activeModelId = hoveredId && hoveredId !== "auto" ? hoveredId : selectedId;
  const activeModel = MODELS.find((model) => model.id === activeModelId) ?? selected;

  function openPicker() {
    setOpen((current) => {
      const next = !current;
      if (next) {
        setFlyout(null);
        setHoveredId(selectedId);
        setQuery("");
      }
      return next;
    });
  }

  const picker = (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={openPicker}
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[12px] text-white/45 transition-colors duration-150",
          "hover:bg-white/10 hover:text-white/75",
          open && "bg-white/10 text-white/80",
        )}
      >
        <span className="whitespace-nowrap">{triggerLabel(selected, effort, fast)}</span>
        <ChevronDownIcon className="w-[10px] text-current" />
      </button>

      {open ? (
        <div className="absolute right-0 bottom-[calc(100%+8px)] z-50 origin-bottom-right scale-[0.86]">
          <div className="relative w-max">
            {flyout === "models" ? (
              <div
                className="absolute right-full bottom-0 z-10 mr-1"
                onMouseEnter={() => setFlyout("models")}
              >
                <ModelsMenu
                  query={query}
                  onQuery={setQuery}
                  provider={provider}
                  onProvider={setProvider}
                  selectedId={selectedId}
                  hoveredId={activeModelId}
                  effort={effort}
                  fast={fast}
                  models={visible}
                  onHover={setHoveredId}
                  onSelect={(id) => {
                    setSelectedId(id);
                    setFlyout("models");
                  }}
                />
              </div>
            ) : null}
            {flyout === "effort" ? (
              <div
                className="absolute right-full bottom-0 z-10 mr-1"
                onMouseEnter={() => setFlyout("effort")}
              >
                <OptionList
                  title="Effort"
                  value={effort}
                  options={EFFORTS}
                  onPick={(value) => {
                    setEffort(value);
                  }}
                />
              </div>
            ) : null}
            <OptionsCard
              model={activeModel}
              effort={effort}
              fast={fast}
              flyout={flyout}
              onFast={() => setFast((value) => !value)}
              onEffort={() => setFlyout("effort")}
              onHoverFast={() => setFlyout(null)}
              onHoverEffort={() => setFlyout("effort")}
              onHoverModel={() => setFlyout("models")}
            />
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <div ref={rootRef} className="w-full max-w-full text-white md:w-[min(500px,88vw)]">
      <div className="mb-2 flex items-center gap-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
          <span className="inline-flex h-7 shrink-0 items-center rounded-full border border-white/15 bg-white/[0.08] px-2.5 text-[12px] text-white/80 backdrop-blur-xl">
            Changes
            <span className="ml-1.5 text-[#3ecf8e]">+15863</span>
            <span className="ml-1 text-[#f07178]">-1237</span>
          </span>
          <span className="inline-flex h-7 shrink-0 items-center rounded-full border border-white/15 bg-white/[0.08] px-2.5 text-[12px] text-white/80 backdrop-blur-xl">
            Worked for 36s
          </span>
          <button
            type="button"
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-white/15 bg-white/[0.08] px-2.5 text-[12px] text-white/80 backdrop-blur-xl transition-colors hover:bg-white/[0.12]"
          >
            Commit & Push
            <ChevronDownIcon className="w-[9px] text-white/45" />
          </button>
        </div>
        <span className="hidden h-7 shrink-0 items-center rounded-full border border-white/15 bg-white/[0.08] px-2.5 text-[12px] text-white/45 backdrop-blur-xl sm:inline-flex">
          {triggerLabel(selected, effort, fast)}
        </span>
      </div>

      <div className="flex h-9 min-h-9 items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.08] py-0.5 pr-1.5 pl-1 backdrop-blur-xl">
        <span className="inline-flex size-[25px] shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-white/55">
          <Plus className="size-3" strokeWidth={1.75} />
        </span>
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={1}
          spellCheck
          aria-label="Follow-up"
          placeholder="Send follow-up"
          className="max-h-24 min-h-7 w-full resize-none overflow-y-auto bg-transparent py-1 text-[13px] leading-5 text-white/90 outline-none placeholder:text-white/35"
        />
        {picker}
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-white text-black">
          <MicrophoneFill className="size-3.5" />
        </span>
      </div>
    </div>
  );
}

function ModelsMenu({
  query,
  onQuery,
  provider,
  onProvider,
  selectedId,
  hoveredId,
  effort,
  fast,
  models,
  onHover,
  onSelect,
}: {
  query: string;
  onQuery: (value: string) => void;
  provider: ProviderId;
  onProvider: (id: ProviderId) => void;
  selectedId: string;
  hoveredId: string;
  effort: Effort;
  fast: boolean;
  models: Model[];
  onHover: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded-[12px] border border-white/8 bg-[#2a2a2a] shadow-[0_8px_24px_rgba(0,0,0,0.4)]">
      <div className="flex flex-col gap-0.5 border-r border-white/8 px-1 py-1">
        {RAIL.map((tab) => {
          const Icon = tab.icon;
          const active = provider === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              title={tab.label}
              aria-label={tab.label}
              onClick={() => onProvider(tab.id)}
              className={cn(
                "inline-flex size-[26px] items-center justify-center rounded-[6px] text-white/45 transition-colors hover:bg-white/8 hover:text-white/80",
                active && "bg-white/10 text-white",
              )}
            >
              <Icon className="size-3.5" />
            </button>
          );
        })}
      </div>
      <div className="flex w-[210px] flex-col py-1">
        <label className="mx-1.5 mb-0.5 flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-white/35">
          <SearchIcon className="size-3 shrink-0" />
          <input
            type="search"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="Search models"
            className="w-full bg-transparent text-[12px] text-white/90 outline-none placeholder:text-white/35"
          />
        </label>
        <div className="max-h-[220px] overflow-y-auto py-0.5">
          {models.length === 0 ? (
            <p className="px-2.5 py-1.5 text-[11px] text-white/35">No models match.</p>
          ) : (
            models.map((model) => {
              const selected = model.id === selectedId;
              const hovered = model.id === hoveredId;
              return (
                <button
                  key={model.id}
                  type="button"
                  onMouseEnter={() => onHover(model.id)}
                  onClick={() => onSelect(model.id)}
                  className={cn(
                    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-white/90",
                    (selected || hovered) && "bg-white/8",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {modelLabel(model, effort, fast, selectedId)}
                  </span>
                  {selected ? <CheckIcon className="size-3 shrink-0 text-white/90" /> : null}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function OptionsCard({
  model,
  effort,
  fast,
  flyout,
  onFast,
  onEffort,
  onHoverFast,
  onHoverEffort,
  onHoverModel,
}: {
  model: Model;
  effort: Effort;
  fast: boolean;
  flyout: Flyout;
  onFast: () => void;
  onEffort: () => void;
  onHoverFast: () => void;
  onHoverEffort: () => void;
  onHoverModel: () => void;
}) {
  return (
    <div className="w-[196px] overflow-hidden rounded-[12px] border border-white/8 bg-[#2a2a2a] py-0.5 shadow-[0_8px_24px_rgba(0,0,0,0.4)]">
      <div className="flex items-center px-2.5 py-1.5" onMouseEnter={onHoverFast}>
        <span className="text-[12px] text-white/90">Fast</span>
        <button
          type="button"
          role="switch"
          aria-checked={fast}
          onClick={onFast}
          className={cn(
            "relative ml-auto h-4 w-7 rounded-full transition-colors",
            fast ? "bg-[#3ecf8e]" : "bg-white/20",
          )}
        >
          <span
            className={cn(
              "absolute top-[2px] size-3 rounded-full bg-white transition-[left]",
              fast ? "left-[14px]" : "left-[2px]",
            )}
          />
        </button>
      </div>
      <button
        type="button"
        onMouseEnter={onHoverEffort}
        onClick={onEffort}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-1.5 text-[12px] text-white/90",
          flyout === "effort" && "bg-white/8",
        )}
      >
        <span>Effort</span>
        <span className="ml-auto inline-flex items-center gap-1 text-white/45">
          {effort}
          <ChevronRightIcon className="size-3" />
        </span>
      </button>
      <button
        type="button"
        onMouseEnter={onHoverModel}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-1.5 text-[12px] text-white/90",
          flyout === "models" && "bg-white/8",
        )}
      >
        <span>Model</span>
        <span className="ml-auto inline-flex min-w-0 items-center gap-1 text-white/45">
          <span className="max-w-[92px] truncate">{model.name}</span>
          <ChevronRightIcon className="size-3 shrink-0" />
        </span>
      </button>
    </div>
  );
}

function OptionList({
  title,
  value,
  options,
  onPick,
}: {
  title: string;
  value: string;
  options: string[];
  onPick: (value: Effort) => void;
}) {
  return (
    <div className="w-[148px] overflow-hidden rounded-[12px] border border-white/8 bg-[#2a2a2a] py-0.5 shadow-[0_8px_24px_rgba(0,0,0,0.4)]">
      <p className="px-2.5 py-1 text-[10px] text-white/35">{title}</p>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onPick(option as Effort)}
          className={cn(
            "flex w-full items-center px-2.5 py-1.5 text-left text-[12px] text-white/90 hover:bg-white/8",
            option === value && "bg-white/8",
          )}
        >
          <span className="flex-1">{option}</span>
          {option === value ? <CheckIcon className="size-3" /> : null}
        </button>
      ))}
    </div>
  );
}

function MicrophoneFill({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 256 256"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path d="M80 128V64a48 48 0 0 1 96 0v64a48 48 0 0 1-96 0m128 0a8 8 0 0 0-16 0a64 64 0 0 1-128 0a8 8 0 0 0-16 0a80.11 80.11 0 0 0 72 79.6V240a8 8 0 0 0 16 0v-32.4a80.11 80.11 0 0 0 72-79.6" />
    </svg>
  );
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="3 0 10 7"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path d="M8 6.5a.47.47 0 0 1-.35-.15l-4.5-4.5c-.2-.2-.2-.51 0-.71s.51-.2.71 0l4.15 4.15l4.14-4.14c.2-.2.51-.2.71 0s.2.51 0 .71l-4.5 4.5c-.1.1-.23.15-.35.15Z" />
    </svg>
  );
}

function iconProps(className?: string) {
  return {
    className,
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <path d="m21 21-4.34-4.34" />
      <circle cx="11" cy="11" r="8" />
    </svg>
  );
}

function InfinityIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <path d="M6 16c5 0 7-8 12-8a4 4 0 0 1 0 8c-5 0-7-8-12-8a4 4 0 1 0 0 8" />
    </svg>
  );
}

function CloudIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
    </svg>
  );
}

function BoxIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </svg>
  );
}

function SquareIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
    </svg>
  );
}

function SparkleIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" />
    </svg>
  );
}

function MonitorIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}
