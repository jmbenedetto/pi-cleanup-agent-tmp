import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OWNERSHIP_FILE = ".pi-session-tmp.json";

function sessionTmpPaths(cwd: string, sessionId: string): [string, string, string] {
	if (typeof sessionId !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId)) {
		throw new Error("Missing or unsafe session ID; refusing shared temporary-directory access");
	}
	const agents = join(resolve(cwd), ".agents");
	const tmp = join(agents, "tmp");
	return [agents, tmp, join(tmp, sessionId)];
}

async function checkDirectory(path: string): Promise<void> {
	const stats = await lstat(path);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error(`Refusing non-directory or symbolic-link temporary path: ${path}`);
	}
}

async function checkOwnership(directory: string, sessionId: string): Promise<void> {
	try {
		const marker = join(directory, OWNERSHIP_FILE);
		const stats = await lstat(marker);
		if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 1024) throw new Error("Invalid marker");
		const owner = JSON.parse(await readFile(marker, "utf8"));
		if (owner?.extension !== "pi-cleanup-agent-tmp" || owner.version !== 1 || owner.sessionId !== sessionId) {
			throw new Error("Mismatched marker");
		}
	} catch {
		throw new Error(`Session temporary-directory ownership is unverified: ${directory}`);
	}
}

async function ensureSessionTmp(cwd: string, sessionId: string): Promise<string> {
	const paths = sessionTmpPaths(cwd, sessionId);
	for (const path of paths) {
		let created = false;
		try {
			await mkdir(path, { mode: 0o700 });
			created = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		await checkDirectory(path);
		if (path === paths[2] && created) {
			await writeFile(join(path, OWNERSHIP_FILE), JSON.stringify({
				extension: "pi-cleanup-agent-tmp", version: 1, sessionId,
			}) + "\n", { flag: "wx", mode: 0o600 });
		}
	}
	await checkOwnership(paths[2], sessionId);
	return paths[2];
}

export async function cleanAgentTmp(cwd: string, sessionId: string): Promise<void> {
	try {
		const paths = sessionTmpPaths(cwd, sessionId);
		for (const path of paths) await checkDirectory(path);
		await checkOwnership(paths[2], sessionId);
		await rm(paths[2], { recursive: true, force: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		console.error("[cleanup-agent-tmp] Session cleanup skipped:", error);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const directory = await ensureSessionTmp(ctx.cwd, sessionId);
		return {
			systemPrompt: `${event.systemPrompt}\n\n## Session temporary files\n` +
				`- Your session ID is ${sessionId}. Save temporary files, scratch scripts, and intermediate outputs under ${JSON.stringify(directory)}. Create subfolders there as needed.\n` +
				"- Each agent and subagent uses its own session ID and its own session directory. Subagents must not reuse the parent agent's temporary directory.\n" +
				`- Keep ${OWNERSHIP_FILE} intact; the extension uses this metadata to verify ownership before cleanup.\n` +
				"- The extension removes only your session directory on graceful quit. Keep deliverables and files needed after this session in an explicitly chosen persistent location.\n" +
				"- Leave other session directories and legacy shared temporary files untouched. This session directory is temporary storage, not a durable cache.\n",
		};
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason !== "quit") return;
		await cleanAgentTmp(ctx.cwd, ctx.sessionManager?.getSessionId());
	});
}
