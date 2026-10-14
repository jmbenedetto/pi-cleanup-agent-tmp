import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkDestination, loadConfig } from "./lib/path-policy.ts";
import type { Destination, GuardConfig } from "./lib/path-policy.ts";
import { shellDestinations } from "./lib/shell-destinations.ts";

export async function guardToolCall(
	toolName: string, input: Record<string, unknown>, cwd: string, config?: GuardConfig,
): Promise<{ block: true; reason: string } | undefined> {
	const destinations: (Destination & { cwd: string })[] = [];
	if (toolName === "write" && typeof input.path === "string") {
		destinations.push({ path: input.path, cwd });
	} else if (toolName === "bash" && typeof input.command === "string") {
		destinations.push(...shellDestinations(input.command, cwd));
	} else if (["move_file", "copy_file"].includes(toolName) &&
		typeof input.source === "string" && typeof input.destination === "string") {
		destinations.push({ path: input.destination, source: input.source, intoDirectory: false, cwd });
	} else if (["create_directory", "write_file"].includes(toolName) && typeof input.path === "string") {
		destinations.push({ path: input.path, cwd });
	}
	if (!destinations.length) return;
	try {
		const policy = config ?? await loadConfig();
		for (const destination of destinations) {
			const reason = await checkDestination(destination, destination.cwd, policy);
			if (reason) return { block: true, reason };
		}
	} catch (error) {
		return { block: true, reason: `Path-length guard could not validate this destination: ${error instanceof Error ? error.message : String(error)}` };
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const result = await guardToolCall(event.toolName, event.input, ctx.cwd);
		if (result && ctx.hasUI) ctx.ui.notify(result.reason, "warning");
		return result;
	});
}
