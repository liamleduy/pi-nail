import type { Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface DraftVersion { label: string; text: string; ts: number }

/** Right-side pane: shows one draft version (scrollable) or the version history list. */
export class DraftPane implements Component {
	height = 10; // total rows incl. title; set by owner before render
	private pinned: number | undefined; // previewed version index; undefined = latest
	private historyOpen = false;
	private selected = 0;
	private scroll = 0; // lines down from top

	constructor(private theme: Theme, private versions: DraftVersion[]) {}

	get isHistoryOpen() { return this.historyOpen; }

	/** Index of the version being shown. */
	private get shown() { return Math.min(this.pinned ?? this.versions.length - 1, this.versions.length - 1); }

	toggleHistory() {
		this.historyOpen = !this.historyOpen;
		if (this.historyOpen) this.selected = this.shown;
	}

	/** Leave history and show the latest draft. */
	backToLatest() { this.historyOpen = false; this.pinned = undefined; this.scroll = 0; }

	moveSelection(delta: number) {
		this.selected = Math.min(this.versions.length - 1, Math.max(0, this.selected + delta));
	}

	/** Preview the selected version and close the list. */
	previewSelected() {
		this.pinned = this.selected === this.versions.length - 1 ? undefined : this.selected;
		this.historyOpen = false;
		this.scroll = 0;
	}

	scrollBy(delta: number) { this.scroll = Math.max(0, this.scroll + delta); }

	invalidate() {}

	render(width: number): string[] {
		const theme = this.theme;
		const n = this.versions.length;
		const bodyH = Math.max(1, this.height - 1);
		const vLabel = (i: number) => (i === 0 ? "rough" : `v${i}`);
		const body: string[] = [];
		let title: string;
		if (this.historyOpen) {
			title = `─ history (${n})`;
			const start = Math.min(Math.max(0, this.selected - bodyH + 1), Math.max(0, n - bodyH));
			for (let i = start; i < Math.min(n, start + bodyH); i++) {
				const v = this.versions[i]!;
				const time = new Date(v.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
				const first = v.text.split("\n").find((l) => l.trim())?.trim() ?? "";
				const row = ` ${vLabel(i).padEnd(5)} ${time}  ${first}`;
				body.push(i === this.selected ? theme.bg("selectedBg", theme.fg("accent", truncateToWidth(row, width, "…", true))) : theme.fg("muted", truncateToWidth(row, width, "…")));
			}
		} else {
			const idx = this.shown;
			const tag = n === 0 ? "" : ` ${vLabel(idx)} ${idx + 1}/${n}${idx === n - 1 ? "" : " (old)"}`;
			const text = this.versions[idx]?.text ?? "";
			const all = text ? new Markdown(text, 1, 0, getMarkdownTheme()).render(width) : [theme.fg("dim", " no draft yet")];
			this.scroll = Math.min(this.scroll, Math.max(0, all.length - bodyH));
			body.push(...all.slice(this.scroll, this.scroll + bodyH));
			const more = [this.scroll > 0 ? "↑" : "", this.scroll + bodyH < all.length ? "↓" : ""].join("");
			title = `─ draft prompt${tag}${more ? ` ${more}` : ""}`;
		}
		while (body.length < bodyH) body.push("");
		const head = theme.fg("success", truncateToWidth(title + " ", width, "…") );
		const out = [head + theme.fg("success", "─".repeat(Math.max(0, width - visibleWidth(head)))), ...body.slice(0, bodyH)];
		return out.map((l) => truncateToWidth(l, width, "", true));
	}
}
