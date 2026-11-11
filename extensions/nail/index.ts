import { randomUUID } from "node:crypto";
import type { EntryRenderer, ExtensionAPI, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { type Block, NailOverlay, type Result } from "./overlay.ts";
import { createCoachSession } from "./coach-session.ts";

interface StoredSessionEntry { id: string; rough: string; transcript: Block[]; final?: string; action: string; ts: number }

// ponytail: unread set is in-memory, resets on reload. Persist via appendEntry("nail-read") if it matters.
const readEntryIds = new Set<string>();

export default function (pi: ExtensionAPI) {
	// Custom entries are rendered in the TUI but NEVER sent to the LLM.
	const renderEntry: EntryRenderer<StoredSessionEntry> = (customEntry, { expanded }, theme) => {
		const entry = customEntry.data;
		if (!entry) return undefined;
		if (expanded) readEntryIds.add(entry.id);
		const box = new Box(1, 1, (s) => theme.bg("customMessageBg", s));
		const unread = readEntryIds.has(entry.id) ? "" : ` ${theme.fg("warning", "● unread")}`;
		const head = `${theme.fg("accent", "◆ nail")}${unread} ${theme.fg("dim", `· ${entry.transcript.length} msgs · ${entry.action} · hidden from agent`)}`;
		box.addChild(new Text(head, 0, 0));
		if (!expanded) {
			box.addChild(new Text(theme.fg("dim", keyHint("app.tools.expand", "to expand")), 0, 0));
			return box;
		}
		const markdownTheme = getMarkdownTheme();
		for (const block of entry.transcript) {
			const body = block.role === "tool" ? theme.fg("dim", `⚙ ${block.text}`) : block.role === "user" ? `**you ›** ${block.text}` : block.text;
			box.addChild(block.role === "tool" ? new Text(body, 0, 0) : new Markdown(body, 0, 0, markdownTheme));
		}
		if (entry.final) box.addChild(new Markdown(`---\n**Final prompt**\n\n${entry.final}`, 0, 0, markdownTheme));
		return box;
	};
	pi.registerEntryRenderer<StoredSessionEntry>("nail", renderEntry);
	// back-compat: sessions saved before the rename use the "preprompt" entry type
	pi.registerEntryRenderer<StoredSessionEntry>("preprompt", renderEntry);

	const command: Omit<RegisteredCommand, "name" | "sourceInfo"> = {
		description: "Improve a rough prompt in a hidden side chat, then send / put in editor / discard",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return void ctx.ui.notify("/nail needs interactive mode", "error");
			if (!ctx.model) return void ctx.ui.notify("No model selected", "error");
			let roughPrompt = args.trim() || ctx.ui.getEditorText().trim();
			if (!roughPrompt) roughPrompt = ((await ctx.ui.input("Rough prompt", "what do you want done?")) ?? "").trim();
			if (!roughPrompt) return;

			let overlay: NailOverlay | undefined;
			let pendingDraft = ""; // draft that arrives before overlay exists (shouldn't, but cheap)
			let session;
			try {
				session = await createCoachSession(ctx, (draft) => (overlay ? overlay.setDraft(draft) : (pendingDraft = draft)));
			} catch (error) {
				return void ctx.ui.notify(`nail: ${error instanceof Error ? error.message : error}`, "error");
			}

			let result: Result;
			try {
				result = await ctx.ui.custom<Result>(
					(tui, theme, _kb, done) => {
						overlay = new NailOverlay(tui, theme, session, done, roughPrompt);
						if (pendingDraft) overlay.setDraft(pendingDraft);
						return overlay;
					},
					{ overlay: true, overlayOptions: { width: "92%", maxHeight: "90%", anchor: "center" } },
				);
			} finally {
				session.dispose();
			}

			pi.appendEntry<StoredSessionEntry>("nail", {
				id: randomUUID(), rough: roughPrompt, transcript: result.transcript, final: result.final,
				action: result.action, ts: Date.now(),
			});
			if (!result.final) return;
			if (result.action === "send") pi.sendUserMessage(result.final, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
			else if (result.action === "chat") ctx.ui.setEditorText(result.final);
		},
	};
	pi.registerCommand("nail", command);
	// back-compat alias
	pi.registerCommand("preprompt", command);
}
