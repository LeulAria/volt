# Release notes: Volt 0.9

Volt 0.9 focuses on **speed**, *clarity* and ~~legacy~~ cleanup. Inline `code`, a [link](https://github.com/microsoft/vscode), and an autolink https://example.com all sit in one paragraph. Keyboard: press <kbd>Cmd</kbd>+<kbd>K</kbd>.

## What changed

1. Rendering
   - Streaming markdown no longer reflows finished paragraphs
   - Code blocks keep their highlight while text streams
     1. Ordered inside unordered inside ordered
     2. Second nested item with `inline code`
   - Tables scroll horizontally
2. Agents
   - Background runs survive a window close
3. Fixes
   * Bullet written with an asterisk
   + Bullet written with a plus

### Checklist

- [x] Parse incrementally
- [x] Keep finished blocks stable
- [ ] Virtualize very long chats
- [ ] Ship it

#### Quotes

> A quote with **bold** and `code`.
>
> > A nested quote, two levels deep.

---

A footnote reference[^1] and a second one[^perf].

![Volt logo placeholder](https://placehold.co/320x80/png?text=Volt)

Emoji: ✅ done, ⚠️ warning, 🚀 launch.

[^1]: The first footnote.
[^perf]: Measured on an M-series Mac.
