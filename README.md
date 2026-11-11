# pi-nail

For people who are unsure how to prompt. Prompt once, nail it the first time. Type `/nail <rough idea>` (or leave args empty to use the editor text). `/preprompt` still works as an alias (old name).

A hidden side chat opens as an overlay. It restates your task, explores the repo (read-only tools), asks only what is genuinely vague, picks a prompt template (zero-shot, one-shot, few-shot, bug, feature, refactor, plan, role) and drafts one improved prompt. Keep typing to refine it.

Tab to the action bar:
- **Send**: improved prompt goes straight to the main agent
- **Put to chat**: improved prompt lands in the editor for you to tweak
- **Discard**

The side transcript stays visible in the main chat as a collapsed `◆ nail ● unread` block (Ctrl+O expands it) but is a custom entry, so the main agent never sees it. Only the final prompt reaches it.

## Install

```
pi install npm:pi-nail
```

From source: `pi install ./` (or `pi -e ./extensions/nail/index.ts` to try). Add templates by dropping a `.md` with a `description:` front-matter line into `templates/`.

## Usage

```
/nail fix the flaky login test
```

## License

MIT
