import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	getAgentDir,
	SessionManager,
	type AgentSession,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(moduleDir, "../../templates");

function catalog(): string {
	const lines = readdirSync(templatesDir)
		.filter((f) => f.endsWith(".md"))
		.map((f) => {
			const desc = /^description:\s*(.+)$/m.exec(readFileSync(join(templatesDir, f), "utf8"))?.[1] ?? "";
			return `- ${f.replace(/\.md$/, "")}: ${desc}\n  path: ${join(templatesDir, f)}`;
		});
	return `\n\n# Template catalog\n${lines.join("\n")}\n`;
}

/** Hidden coach session: in-memory, no extensions, read-only tools + final_prompt. */
export async function createCoachSession(
	ctx: ExtensionCommandContext,
	onDraft: (prompt: string) => void,
): Promise<AgentSession> {
	const finalPrompt = defineTool({
		name: "final_prompt",
		label: "Final prompt",
		description: "Submit the finished improved prompt. Call again to replace it after revisions.",
		parameters: Type.Object({ prompt: Type.String({ description: "Complete, self-contained prompt text" }) }),
		async execute(_id, params) {
			onDraft(params.prompt);
			return { content: [{ type: "text", text: "Draft shown to the user." }], details: undefined };
		},
	});

	const agentDir = getAgentDir();
	const resourceLoader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: false, // keep AGENTS.md/CLAUDE.md so the coach sees repo conventions
		systemPrompt: readFileSync(join(moduleDir, "system.md"), "utf8") + catalog(),
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		agentDir,
		model: ctx.model,
		thinkingLevel: "low",
		resourceLoader,
		tools: ["read", "grep", "find", "ls", "final_prompt"],
		customTools: [finalPrompt],
		sessionManager: SessionManager.inMemory(ctx.cwd),
	});
	return session;
}
