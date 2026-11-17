import type { AgentSession, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { DraftPane, type DraftVersion } from "./draft-pane.ts";
import { Editor, type Focusable, Markdown, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type Action = "send" | "chat" | "discard";
export interface Block { role: "user" | "assistant" | "tool"; text: string }
export interface Result { action: Action; final?: string; transcript: Block[]; versions?: DraftVersion[] }

const WIDE_MIN = 100; // overlay width at which the draft pane goes on the right
const HISTORY_KEY = "ctrl+o"; // ctrl+h = backspace in legacy terminals, ctrl+v = paste

type Mode = "chat" | "draft" | "actions"; // tab cycles chat → draft → actions → chat
const MODES: Mode[] = ["chat", "draft", "actions"];

const ACTIONS: { id: Action; label: string }[] = [
	{ id: "send", label: "Send" },
	{ id: "chat", label: "Put to chat" },
	{ id: "discard", label: "Discard" },
];

export class NailOverlay implements Focusable {
	focused = false;
	blocks: Block[] = [];
	draft = "";
	versions: DraftVersion[];
	private pane: DraftPane;
	private streaming = "";
	private busy = true;
	private scroll = 0; // lines up from bottom
	private mode: Mode = "chat";
	private draftEditor: Editor;
	private draftEditing = false;
	private draftEditIndex = 0; // versions[] index loaded into the draft editor
	private selectedActionIndex = 0;
	private editor: Editor;
	private unsub: () => void;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private session: AgentSession,
		private done: (r: Result) => void,
		roughPrompt: string,
	) {
		this.versions = [{ label: "rough", text: roughPrompt, ts: Date.now() }];
		this.pane = new DraftPane(theme, this.versions);
		this.editor = new Editor(tui, { borderColor: (s) => theme.fg("border", s), selectList: getSelectListTheme() });
		this.editor.onSubmit = (text) => this.submit(text);
		this.draftEditor = new Editor(tui, { borderColor: (s) => theme.fg("accent", s), selectList: getSelectListTheme() });
		this.draftEditor.disableSubmit = true; // return inserts a newline while editing a draft
		this.unsub = session.subscribe((e: any) => this.onEvent(e));
		this.submit(`Rough prompt:\n\n${roughPrompt}`);
	}

	/** Called by index.ts when final_prompt fires. */
	setDraft(draft: string) {
		this.draft = draft;
		if (this.versions[this.versions.length - 1]!.text !== draft) {
			this.versions.push({ label: `v${this.versions.length}`, text: draft, ts: Date.now() });
		}
		this.tui.requestRender();
	}

	private onEvent(e: any) {
		if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
			this.streaming += e.assistantMessageEvent.delta;
		} else if (e.type === "message_end" && e.message?.role === "assistant") {
			if (this.streaming.trim()) this.blocks.push({ role: "assistant", text: this.streaming.trim() });
			this.streaming = "";
		} else if (e.type === "tool_execution_start" && e.toolName !== "final_prompt") {
			const toolArgs = e.args ? JSON.stringify(e.args) : "";
			this.blocks.push({ role: "tool", text: `${e.toolName} ${toolArgs}`.slice(0, 160) });
		} else if (e.type === "agent_end") {
			this.busy = false;
		}
		this.tui.requestRender();
	}

	private submit(text: string) {
		text = text.trim();
		if (!text) return;
		this.blocks.push({ role: "user", text });
		this.editor.setText("");
		this.scroll = 0;
		this.busy = true;
		const pending = this.busy && this.session.isStreaming ? this.session.steer(text) : this.session.prompt(text);
		pending.catch((err: unknown) => {
			this.blocks.push({ role: "assistant", text: `error: ${err instanceof Error ? err.message : String(err)}` });
			this.busy = false;
			this.tui.requestRender();
		});
		this.tui.requestRender();
	}

	/** Load the shown draft version into the draft editor for in-place editing. */
	private enterDraft() {
		this.draftEditIndex = Math.min(this.pane.shown, this.versions.length - 1);
		this.draftEditor.setText(this.versions[this.draftEditIndex]?.text ?? "");
		this.draftEditing = true;
	}

	/** Write the edited text back into the version it came from (and this.draft when it is the latest). */
	private commitDraft() {
		if (!this.draftEditing) return;
		this.draftEditing = false;
		const idx = Math.min(this.draftEditIndex, this.versions.length - 1);
		this.versions[idx]!.text = this.draftEditor.getText();
		if (idx === this.versions.length - 1) this.draft = this.draftEditor.getText();
	}

	private setMode(mode: Mode) {
		if (mode !== "draft") this.commitDraft();
		this.mode = mode;
		if (mode === "draft") this.enterDraft();
		this.tui.requestRender();
	}

	private finish(action: Action) {
		this.commitDraft();
		this.unsub();
		this.done({ action, final: this.draft || undefined, transcript: this.blocks, versions: this.versions });
	}

	handleInput(data: string): void {
		if (matchesKey(data, HISTORY_KEY)) {
			this.pane.toggleHistory();
			this.tui.requestRender();
			return;
		}
		if (this.pane.isHistoryOpen) {
			if (matchesKey(data, "escape")) this.pane.backToLatest();
			else if (matchesKey(data, "up")) this.pane.moveSelection(-1);
			else if (matchesKey(data, "down")) this.pane.moveSelection(1);
			else if (matchesKey(data, "return")) this.pane.previewSelected();
			this.tui.requestRender();
			return; // history view swallows input
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			const delta = matchesKey(data, "tab") ? 1 : -1;
			this.setMode(MODES[(MODES.indexOf(this.mode) + delta + MODES.length) % MODES.length]!);
			return;
		}
		if (this.mode === "draft") {
			if (matchesKey(data, "escape")) { // exit the edit, keep the text, back to the latest version
				this.commitDraft();
				this.pane.backToLatest();
				this.setMode("chat");
				return;
			}
			this.draftEditor.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "escape")) {
			if (this.busy) void this.session.abort();
			else this.finish("discard");
			return;
		}
		if (this.mode === "chat") {
			if (matchesKey(data, "up")) this.scroll++;
			else if (matchesKey(data, "down")) this.scroll = Math.max(0, this.scroll - 1);
			else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) return; // arrows scroll the transcript
			else this.editor.handleInput(data); // typing goes into the input editor
			this.tui.requestRender();
			return;
		}
		if (this.mode === "actions") {
			if (matchesKey(data, "left") || matchesKey(data, "up")) this.selectedActionIndex = (this.selectedActionIndex + ACTIONS.length - 1) % ACTIONS.length;
			else if (matchesKey(data, "right") || matchesKey(data, "down")) this.selectedActionIndex = (this.selectedActionIndex + 1) % ACTIONS.length;
			else if (matchesKey(data, "return")) {
				const action = ACTIONS[this.selectedActionIndex]!.id;
				if (action !== "discard" && !this.draft) return; // nothing to send yet
				this.finish(action);
				return;
			} else return; // no text input in actions mode
			this.tui.requestRender();
			return;
		}
	}

	invalidate() { this.editor.invalidate(); this.draftEditor.invalidate(); }

	render(width: number): string[] {
		const theme = this.theme;
		const wide = width >= WIDE_MIN;
		const colW = wide ? Math.floor((width - 1) * 0.55) : width;
		const paneW = width - colW - 1;
		const inner = Math.max(20, colW - 4);
		const rows = process.stdout.rows || 40;
		const editDraft = this.draftEditing && !this.pane.isHistoryOpen;
		let draftLines: string[] | undefined; // narrow: pre-rendered draft editor, sizes the chat column
		if (!wide && editDraft) draftLines = this.draftEditor.render(width);
		const bodyH = wide
			? Math.max(8, Math.floor(rows * 0.85) - 12)
			: Math.max(6, Math.floor(rows * 0.85) - 15 - (draftLines ? draftLines.length : this.draft ? Math.min(10, this.draft.split("\n").length + 2) : 0));

		const lines: string[] = [];
		const renderMarkdown = (s: string) => new Markdown(s, 0, 0, getMarkdownTheme()).render(inner);
		for (const b of this.blocks) {
			if (b.role === "tool") lines.push(theme.fg("dim", truncateToWidth(`  ⚙ ${b.text}`, inner)));
			else if (b.role === "user") lines.push(...renderMarkdown(`**you ›** ${b.text}`));
			else lines.push(...renderMarkdown(b.text));
			lines.push("");
		}
		if (this.streaming) lines.push(...renderMarkdown(this.streaming));
		else if (this.busy) lines.push(theme.fg("dim", "  … thinking"));

		const maxScroll = Math.max(0, lines.length - bodyH);
		this.scroll = Math.min(Math.max(0, this.scroll), maxScroll);
		const end = lines.length - this.scroll;
		const view = lines.slice(Math.max(0, end - bodyH), end);
		while (view.length < bodyH) view.push("");

		const out: string[] = [];
		const more = [this.scroll < maxScroll ? "↑ more" : "", this.scroll > 0 ? "↓ more" : ""].filter(Boolean).join(" ");
		const left = ` ${theme.fg("accent", "◆ nail")} ${theme.fg(this.mode === "chat" ? "accent" : "dim", "· side chat, hidden from main agent")}`;
		const right = more ? theme.fg("muted", more) + " " : "";
		const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
		out.push(theme.fg("accent", "─".repeat(width)));
		out.push(visibleWidth(left) + visibleWidth(right) + 1 > width ? truncateToWidth(left, width - visibleWidth(right) - 1) + " " + right : left + " ".repeat(gap) + right);
		const chat = view.map((l) => " " + truncateToWidth(l, inner + 2));
		if (wide) {
			let pane: string[];
			if (editDraft) pane = this.draftEditor.render(paneW);
			else {
				this.pane.height = bodyH;
				pane = this.pane.render(paneW);
			}
			const sep = theme.fg("border", "│");
			for (let i = 0; i < bodyH; i++) {
				const l = truncateToWidth(chat[i] ?? "", colW);
				out.push(l + " ".repeat(Math.max(0, colW - visibleWidth(l))) + sep + (pane[i] ?? ""));
			}
		} else out.push(...chat);

		if (!wide && this.pane.isHistoryOpen) {
			this.pane.height = 8;
			out.push(...this.pane.render(width));
		} else if (!wide && draftLines) {
			out.push(...draftLines);
		} else if (!wide && this.draft) {
			out.push(theme.fg("success", "─ draft prompt " + "─".repeat(Math.max(0, width - 15))));
			out.push(...new Markdown(this.draft, 1, 0, getMarkdownTheme()).render(width - 2).slice(0, 10));
		}
		out.push(theme.fg("border", "─".repeat(width)));
		// focus indicators: accent the focused region's border/title
		this.editor.focused = this.focused && this.mode === "chat";
		this.editor.borderColor = (s) => theme.fg(this.mode === "chat" ? "accent" : "border", s);
		this.draftEditor.focused = this.focused && editDraft;
		this.pane.focused = this.mode === "draft";
		out.push(...this.editor.render(width));

		const actionBar = ACTIONS.map((action, i) => {
			const disabled = action.id !== "discard" && !this.draft;
			const label = ` ${action.label} `;
			if (this.mode === "actions" && i === this.selectedActionIndex) return theme.bg("selectedBg", disabled ? theme.fg("dim", label) : theme.fg("accent", label));
			return disabled ? theme.fg("dim", label) : theme.fg("muted", label);
		}).join(" ");
		const hint = this.pane.isHistoryOpen
			? `↑/↓ select · enter preview · esc back · ${HISTORY_KEY} close · tab cycle focus`
			: `tab cycle focus (chat|draft|actions) · ${this.mode === "actions" ? "←/→ enter choose" : this.mode === "chat" ? "↑/↓ scroll, type to chat" : "↑/↓ edit draft"} · ${HISTORY_KEY} history · esc ${this.busy ? "stop" : this.mode === "draft" ? "back" : "discard"}`;
		out.push(` ${actionBar}`);
		out.push(" " + theme.fg("dim", truncateToWidth(hint, width - 2, "…")));
		out.push(theme.fg("accent", "─".repeat(width)));
		// solid background: pad every line so the main chat does not bleed through
		return out.map((l) => truncateToWidth(l, width) + " ".repeat(Math.max(0, width - visibleWidth(l))));
	}

	dispose() { this.unsub(); }
}
