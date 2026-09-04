import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export async function cleanAgentTmp(cwd: string): Promise<void> {
	const tmpDir = join(cwd, ".agents", "tmp");

	try {
		const stats = await lstat(tmpDir);
		if (!stats.isDirectory() || stats.isSymbolicLink()) {
			console.warn(`[cleanup-agent-tmp] Skipping non-directory path: ${tmpDir}`);
			return;
		}

		const entries = await readdir(tmpDir);
		await Promise.all(
			entries.map((entry) => rm(join(tmpDir, entry), { recursive: true, force: true })),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		console.error(`[cleanup-agent-tmp] Failed to clean ${tmpDir}:`, error);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason !== "quit") return;
		await cleanAgentTmp(ctx.cwd);
	});
}
