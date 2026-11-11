import type { AgentSession, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Editor, type Focusable, Markdown, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type Action = "send" | "chat" | "discard";
export interface Block { role: "user" | "assistant" | "tool"; text: string }
export interface Result { action: Action; final?: string; transcript: Block[] }

const ACTIONS: { id: Action; label: string }[] = [
	{ id: "send", label: "Send" },
	{ id: "chat", label: "Put to chat" },
	{ id: "discard", label: "Discard" },
];

export class NailOverlay implements Focusable {
	focused = false;
	blocks: Block[] = [];
	draft = "";
	private streaming = "";
	private busy = true;
	private scroll = 0; // lines up from bottom
	private mode: "editor" | "bar" = "editor";
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
		this.editor = new Editor(tui, { borderColor: (s) => theme.fg("border", s), selectList: getSelectListTheme() });
		this.editor.onSubmit = (text) => this.submit(text);
		this.unsub = session.subscribe((e: any) => this.onEvent(e));
		this.submit(`Rough prompt:\n\n${roughPrompt}`);
	}

	/** Called by index.ts when final_prompt fires. */
	setDraft(draft: string) { this.draft = draft; this.tui.requestRender(); }

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

	private finish(action: Action) {
		this.unsub();
		this.done({ action, final: this.draft || undefined, transcript: this.blocks });
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			if (this.busy) void this.session.abort();
			else this.finish("discard");
			return;
		}
		if (matchesKey(data, "pageUp")) { this.scroll += 8; this.tui.requestRender(); return; }
		if (matchesKey(data, "pageDown")) { this.scroll = Math.max(0, this.scroll - 8); this.tui.requestRender(); return; }
		if (matchesKey(data, "tab")) {
			this.mode = this.mode === "editor" ? "bar" : "editor";
			this.tui.requestRender();
			return;
		}
		if (this.mode === "bar") {
			if (matchesKey(data, "left")) this.selectedActionIndex = (this.selectedActionIndex + ACTIONS.length - 1) % ACTIONS.length;
			else if (matchesKey(data, "right")) this.selectedActionIndex = (this.selectedActionIndex + 1) % ACTIONS.length;
			else if (matchesKey(data, "return")) {
				const action = ACTIONS[this.selectedActionIndex]!.id;
				if (action !== "discard" && !this.draft) return; // nothing to send yet
				this.finish(action);
				return;
			}
			this.tui.requestRender();
			return;
		}
		this.editor.handleInput(data);
		this.tui.requestRender();
	}

	invalidate() { this.editor.invalidate(); }

	render(width: number): string[] {
		const theme = this.theme;
		const inner = Math.max(20, width - 4);
		const rows = process.stdout.rows || 40;
		const bodyH = Math.max(6, Math.floor(rows * 0.85) - 14 - (this.draft ? Math.min(10, this.draft.split("\n").length + 2) : 0));

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

		const end = Math.max(0, lines.length - this.scroll);
		const view = lines.slice(Math.max(0, end - bodyH), end);
		while (view.length < bodyH) view.push("");

		const out: string[] = [];
		const title = ` ◆ nail ${theme.fg("dim", "· side chat, hidden from main agent")} `;
		out.push(theme.fg("accent", "─".repeat(width)), title);
		out.push(...view.map((l) => " " + truncateToWidth(l, inner + 2)));

		if (this.draft) {
			out.push(theme.fg("success", "─ draft prompt " + "─".repeat(Math.max(0, width - 15))));
			out.push(...new Markdown(this.draft, 1, 0, getMarkdownTheme()).render(width - 2).slice(0, 10));
		}
		out.push(...this.editor.render(width));

		const actionBar = ACTIONS.map((action, i) => {
			const disabled = action.id !== "discard" && !this.draft;
			const label = ` ${action.label} `;
			if (this.mode === "bar" && i === this.selectedActionIndex) return theme.bg("selectedBg", disabled ? theme.fg("dim", label) : theme.fg("accent", label));
			return disabled ? theme.fg("dim", label) : theme.fg("muted", label);
		}).join(" ");
		const hint = this.busy ? "esc stop" : "esc discard";
		out.push(` ${actionBar}   ${theme.fg("dim", `tab focus · ←/→ enter choose · pgup/pgdn scroll · ${hint}`)}`);
		out.push(theme.fg("accent", "─".repeat(width)));
		// solid background: pad every line so the main chat does not bleed through
		return out.map((l) => truncateToWidth(l, width) + " ".repeat(Math.max(0, width - visibleWidth(l))));
	}

	dispose() { this.unsub(); }
}
