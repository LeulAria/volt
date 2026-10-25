/**
 * Parses the repository's CHANGELOG.md (Keep a Changelog, as Volt writes it) for the /changelog
 * page. Pure: no DOM, no imports. The shape it understands:
 *
 *   ## [0.0.3] - 2026-10-25        a release
 *   A paragraph.                   its intro
 *   ### Added                      a section
 *   **Scratch**                    a group label inside a section
 *   - An item that may wrap        an item; lines indented two spaces continue it
 *     onto a second line.
 *
 * Everything before the first release and the `[x]: url` link definitions at the end are skipped.
 */

export interface ChangelogGroup {
  /** The bold line above the items, if the section is split into groups. */
  label?: string;
  items: string[];
}

export interface ChangelogSection {
  title: string;
  paragraphs: string[];
  groups: ChangelogGroup[];
}

export interface ChangelogRelease {
  version: string;
  date: string;
  /** Paragraphs between the release heading and its first section. */
  intro: string[];
  sections: ChangelogSection[];
}

const RELEASE_RE = /^##\s+\[?([^\]\s]+)\]?(?:\s+-\s+(\S+))?/;
const SECTION_RE = /^###\s+(.+)$/;
const GROUP_RE = /^\*\*([^*]+)\*\*$/;
const ITEM_RE = /^[-*]\s+(.*)$/;
const LINK_DEF_RE = /^\[[^\]]+\]:\s+\S+/;

export function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let release: ChangelogRelease | undefined;
  let section: ChangelogSection | undefined;
  let group: ChangelogGroup | undefined;
  // What a continuation line (or the next plain line) extends.
  let open: { list: string[] } | undefined;

  const paragraphs = () => (section ? section.paragraphs : release?.intro);

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const text = line.trim();
    const releaseMatch = RELEASE_RE.exec(line);
    if (releaseMatch) {
      release = {
        version: releaseMatch[1],
        date: releaseMatch[2] ?? "",
        intro: [],
        sections: [],
      };
      releases.push(release);
      section = undefined;
      group = undefined;
      open = undefined;
      continue;
    }
    if (!release) {
      continue;
    }
    if (!text) {
      open = undefined;
      continue;
    }
    if (LINK_DEF_RE.test(text)) {
      continue;
    }
    const sectionMatch = SECTION_RE.exec(line);
    if (sectionMatch) {
      section = { title: sectionMatch[1].trim(), paragraphs: [], groups: [] };
      release.sections.push(section);
      group = undefined;
      open = undefined;
      continue;
    }
    const groupMatch = GROUP_RE.exec(text);
    if (groupMatch && section) {
      group = { label: groupMatch[1].trim(), items: [] };
      section.groups.push(group);
      open = undefined;
      continue;
    }
    const itemMatch = ITEM_RE.exec(text);
    if (itemMatch && !/^\s{2,}/.test(line)) {
      if (!section) {
        section = { title: "", paragraphs: [], groups: [] };
        release.sections.push(section);
      }
      if (!group) {
        group = { items: [] };
        section.groups.push(group);
      }
      group.items.push(itemMatch[1]);
      open = { list: group.items };
      continue;
    }
    if (open) {
      // A wrapped item or paragraph line: join it to the last entry.
      const last = open.list.length - 1;
      open.list[last] = `${open.list[last]} ${text}`;
      continue;
    }
    const list = paragraphs();
    if (list) {
      list.push(text);
      open = { list };
    }
  }
  return releases;
}

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

const INLINE_RE =
  /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Bold, italic, code and links; anything else is text. */
export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const index = match.index ?? 0;
    if (index > last) {
      tokens.push({ kind: "text", text: text.slice(last, index) });
    }
    if (match[1] !== undefined) {
      tokens.push({ kind: "strong", text: match[1] });
    } else if (match[2] !== undefined) {
      tokens.push({ kind: "em", text: match[2] });
    } else if (match[3] !== undefined) {
      tokens.push({ kind: "code", text: match[3] });
    } else {
      tokens.push({ kind: "link", text: match[4], href: match[5] });
    }
    last = index + match[0].length;
  }
  if (last < text.length) {
    tokens.push({ kind: "text", text: text.slice(last) });
  }
  return tokens;
}

/** Links in CHANGELOG.md are relative to the repository root; on the site they point at GitHub. */
export function resolveChangelogHref(href: string, repoUrl: string): string {
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(href) ||
    href.startsWith("#") ||
    href.startsWith("/")
  ) {
    return href;
  }
  return `${repoUrl}/blob/main/${href.replace(/^\.\//, "")}`;
}
