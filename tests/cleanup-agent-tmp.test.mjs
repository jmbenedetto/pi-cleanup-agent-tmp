import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import cleanupAgentTmpExtension from "../extensions/cleanup-agent-tmp.ts";

function registerExtension() {
	let shutdownHandler;
	cleanupAgentTmpExtension({
		on(event, handler) {
			if (event === "session_shutdown") shutdownHandler = handler;
		},
	});
	assert.ok(shutdownHandler, "session_shutdown handler was not registered");
	return shutdownHandler;
}

test("empties .agents/tmp on quit while preserving the directory", async () => {
	const project = await mkdtemp(join(tmpdir(), "pi-cleanup-agent-tmp-"));
	const tmp = join(project, ".agents", "tmp");
	await mkdir(join(tmp, "nested"), { recursive: true });
	await writeFile(join(tmp, "file.txt"), "file");
	await writeFile(join(tmp, ".hidden"), "hidden");
	await writeFile(join(tmp, "nested", "file.txt"), "nested");

	await registerExtension()({ reason: "quit" }, { cwd: project });

	assert.deepEqual(await readdir(tmp), []);
});

test("does not clean on reload or session replacement", async () => {
	const project = await mkdtemp(join(tmpdir(), "pi-cleanup-agent-tmp-"));
	const tmp = join(project, ".agents", "tmp");
	await mkdir(tmp, { recursive: true });
	await writeFile(join(tmp, "keep.txt"), "keep");
	const shutdown = registerExtension();

	for (const reason of ["reload", "new", "resume", "fork"]) {
		await shutdown({ reason }, { cwd: project });
	}

	assert.equal(await readFile(join(tmp, "keep.txt"), "utf8"), "keep");
});

test("does nothing when .agents/tmp is absent", async () => {
	const project = await mkdtemp(join(tmpdir(), "pi-cleanup-agent-tmp-"));
	await registerExtension()({ reason: "quit" }, { cwd: project });
	assert.deepEqual(await readdir(project), []);
});

test("does not follow a symlinked .agents/tmp", async () => {
	const project = await mkdtemp(join(tmpdir(), "pi-cleanup-agent-tmp-"));
	const target = join(project, "target");
	const tmp = join(project, ".agents", "tmp");
	await mkdir(target, { recursive: true });
	await mkdir(join(project, ".agents"), { recursive: true });
	await writeFile(join(target, "keep.txt"), "keep");
	await symlink(target, tmp);

	const originalWarn = console.warn;
	console.warn = () => {};
	try {
		await registerExtension()({ reason: "quit" }, { cwd: project });
	} finally {
		console.warn = originalWarn;
	}

	assert.equal(await readFile(join(target, "keep.txt"), "utf8"), "keep");
});
