import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const MAX_PATH_LENGTH = 400;
export interface RootMapping { localRoot: string; cloudPrefix?: string }
export interface GuardConfig { roots: RootMapping[] }
export interface Destination { path: string; source?: string; intoDirectory?: boolean }

function expandHome(path: string): string {
	return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

// Resolve existing ancestors too: the final file usually does not exist yet.
export async function resolveDestination(path: string, cwd: string): Promise<string> {
	let ancestor = resolve(cwd, expandHome(path));
	const missing: string[] = [];
	for (;;) {
		try {
			return join(await realpath(ancestor), ...missing.reverse());
		} catch (error) {
			if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
			const parent = dirname(ancestor);
			if (parent === ancestor) throw error;
			missing.push(basename(ancestor));
			ancestor = parent;
		}
	}
}

export async function discoverOneDriveRoots(): Promise<RootMapping[]> {
	const candidates = new Set<string>();
	for (const key of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) {
		if (process.env[key]) candidates.add(process.env[key]!);
	}
	for (const parent of [homedir(), join(homedir(), "Library", "CloudStorage")]) {
		try {
			for (const entry of await readdir(parent)) {
				if (/^OneDrive(?:$|[- ])/.test(entry)) candidates.add(join(parent, entry));
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	const roots: RootMapping[] = [];
	for (const candidate of candidates) {
		try {
			const localRoot = await realpath(candidate);
			if (await isDirectory(localRoot) && !roots.some((root) => root.localRoot === localRoot)) roots.push({ localRoot });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return roots;
}

export async function loadConfig(): Promise<GuardConfig> {
	const discovered = await discoverOneDriveRoots();
	const configPath = process.env.PI_PATH_LENGTH_GUARD_CONFIG ?? join(
		process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "path-length-guard.json",
	);
	let text: string;
	try { text = await readFile(configPath, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { roots: discovered };
		throw error;
	}
	const config = JSON.parse(text);
	if (!config || !Array.isArray(config.roots)) throw new Error("Config must contain a roots array");
	const roots: RootMapping[] = [];
	for (const root of config.roots) {
		if (!root || typeof root.localRoot !== "string" || !isAbsolute(expandHome(root.localRoot)) ||
			typeof root.cloudPrefix !== "string" || root.cloudPrefix.includes("\\") ||
			/^[a-z]+:\/\//i.test(root.cloudPrefix) || root.cloudPrefix.split("/").some((part: string) => part === "." || part === "..")) {
			throw new Error("Each root needs an absolute localRoot and a decoded cloudPrefix, not a URL");
		}
		roots.push({ localRoot: await realpath(expandHome(root.localRoot)), cloudPrefix: root.cloudPrefix.replace(/^\/+|\/+$/g, "") });
	}
	for (const root of discovered) {
		if (!roots.some((existing) => existing.localRoot === root.localRoot)) roots.push(root);
	}
	roots.sort((a, b) => b.localRoot.length - a.localRoot.length);
	return { roots };
}

export function countedPath(absolute: string, config: GuardConfig): string | undefined {
	for (const root of [...config.roots].sort((a, b) => b.localRoot.length - a.localRoot.length)) {
		const child = relative(root.localRoot, absolute);
		if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) continue;
		if (root.cloudPrefix === undefined) return absolute;
		return [root.cloudPrefix, child.split(sep).join("/")].filter(Boolean).join("/");
	}
	return undefined;
}

async function isDirectory(path: string): Promise<boolean> {
	try { return (await stat(path)).isDirectory(); }
	catch (error) {
		if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
		throw error;
	}
}

export async function checkDestination(destination: Destination, cwd: string, config: GuardConfig): Promise<string | undefined> {
	let target = await resolveDestination(destination.path, cwd);
	const source = destination.source ? resolve(cwd, expandHome(destination.source)) : undefined;
	if (source && (destination.intoDirectory === true ||
		(destination.intoDirectory === undefined && await isDirectory(target)))) {
		target = await resolveDestination(join(target, basename(source)), cwd);
	}
	const check = (path: string): string | undefined => {
		const counted = countedPath(path, config);
		// UTF-16 code units are conservative for non-BMP characters, matching .NET Length.
		if (counted !== undefined && counted.length > MAX_PATH_LENGTH) {
			return `Path-length guard: ${counted.length} characters exceeds ${MAX_PATH_LENGTH} by ${counted.length - MAX_PATH_LENGTH}. Shorten the destination: ${counted}`;
		}
	};
	const violation = check(target);
	if (violation || countedPath(target, config) === undefined || !source) return violation;
	let sourceIsDirectory = false;
	try { sourceIsDirectory = (await lstat(source)).isDirectory(); }
	catch (error) {
		if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
	}
	if (!sourceIsDirectory) return;

	// Inspect names only. Never open file contents or follow descendant symlinks.
	async function walk(folder: string, projected: string): Promise<string | undefined> {
		for (const entry of await readdir(folder, { withFileTypes: true })) {
			const next = join(projected, entry.name);
			const violation = check(next);
			if (violation) return violation;
			if (entry.isDirectory()) {
				const nested = await walk(join(folder, entry.name), next);
				if (nested) return nested;
			}
		}
	}
	return walk(source, target);
}
