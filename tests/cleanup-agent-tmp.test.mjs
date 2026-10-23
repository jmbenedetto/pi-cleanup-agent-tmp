import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import cleanupAgentTmpExtension from "../extensions/cleanup-agent-tmp.ts";

function registerExtension() {
	const handlers = new Map();
	cleanupAgentTmpExtension({
		on(event, handler) { handlers.set(event, handler); },
	});
	return {
		async before(ctx, systemPrompt = "Base system prompt") {
			const handler = handlers.get("before_agent_start");
			assert.ok(handler, "before_agent_start handler was not registered");
			return handler({ systemPrompt }, ctx);
		},
		async shutdown(event, ctx) {
			const handler = handlers.get("session_shutdown");
			assert.ok(handler, "session_shutdown handler was not registered");
			return handler(event, ctx);
		},
	};
}

function context(cwd, sessionId = "own-session") {
	return { cwd, sessionManager: { getSessionId: () => sessionId } };
}

test("before each run the prompt directs the agent to its existing session directory", async () => {
	const project = await mkdtemp(join(tmpdir(), "pi-cleanup-agent-tmp-"));
	const result = await registerExtension().before(context(project, "parent-session"));
	const own = join(project, ".agents", "tmp", "parent-session");
	assert.ok(result.systemPrompt.startsWith("Base system prompt"));
	assert.ok(result.systemPrompt.includes(own));
	assert.match(result.systemPrompt, /parent-session/);
	assert.match(result.systemPrompt, /subagents/i);
	assert.match(result.systemPrompt, /own session/i);
	assert.ok((await lstat(own)).isDirectory());
});

test("a legacy directory matching the session ID is never adopted or deleted, even without a run", async (t) => {
	t.mock.method(console, "error", () => {});
	const project = await mkdtemp(join(tmpdir(), "pi-cleanup-agent-tmp-"));
	const own = join(project, ".agents", "tmp", "prime-raw");
	await mkdir(own, { recursive: true });
	await writeFile(join(own, "evidence.json"), "legacy evidence");
	const ctx = { cwd: project, sessionManager: SessionManager.inMemory(project, { id: "prime-raw" }) };
	const extension = registerExtension();
	await extension.shutdown({ reason: "quit" }, ctx);
	assert.equal(await readFile(join(own, "evidence.json"), "utf8"), "legacy evidence");
	await assert.rejects(extension.before(ctx), /ownership/);
	await extension.shutdown({ reason: "quit" }, ctx);
	assert.equal(await readFile(join(own, "evidence.json"), "utf8"), "legacy evidence");
});

test("safe custom IDs accepted by Pi, including dots and long IDs, receive guidance and cleanup", async () => {
	for (const id of ["review.1", "review..1", "x", "a".repeat(129)]) {
		const project = await mkdtemp(join(tmpdir(), "pi-cleanup-agent-tmp-"));
		const ctx = { cwd: project, sessionManager: SessionManager.inMemory(project, { id }) };
		const extension = registerExtension();
		const result = await extension.before(ctx);
		assert.ok(result.systemPrompt.includes(join(project, ".agents", "tmp", id)));
		await extension.shutdown({ reason: "quit" }, ctx);
		assert.deepEqual(await readdir(join(project, ".agents", "tmp")), []);
	}
});

test("real Pi session managers supply independent IDs and update after a new session", async () => {
	const project = await mkdtemp(join(tmpdir(), "pi-cleanup-agent-tmp-"));
	const parent = { cwd: project, sessionManager: SessionManager.inMemory(project) };
	const child = { cwd: project, sessionManager: SessionManager.inMemory(project) };
	const parentExtension = registerExtension();
	const childExtension = registerExtension();
	const parentId = parent.sessionManager.getSessionId();
	const childId = child.sessionManager.getSessionId();
	assert.notEqual(parentId, childId);
	await parentExtension.before(parent);
	const childPrompt = await childExtension.before(child);
	assert.ok(childPrompt.systemPrompt.includes(join(project, ".agents", "tmp", childId)));
	const parentFile = join(project, ".agents", "tmp", parentId, "keep.txt");
	await writeFile(parentFile, "real parent session");
	await childExtension.shutdown({ reason: "quit" }, child);
	assert.equal(await readFile(parentFile, "utf8"), "real parent session");
	parent.sessionManager.newSession();
	const newId = parent.sessionManager.getSessionId();
	assert.notEqual(newId, parentId);
	const newPrompt = await parentExtension.before(parent);
	assert.ok(newPrompt.systemPrompt.includes(join(project, ".agents", "tmp", newId)));
	assert.ok(!newPrompt.systemPrompt.includes(parentId));
	await parentExtension.shutdown({ reason: "quit" }, parent);
	assert.deepEqual(await readdir(join(project, ".agents", "tmp")), [parentId]);
});

test("a subagent quit removes only its session directory, preserving its parent and legacy files", async () => {
	const project = await mkdtemp(join(tmpdir(), "pi-cleanup-agent-tmp-"));
	const child = registerExtension();
	await child.before(context(project, "child-session"));
	const tmp = join(project, ".agents", "tmp");
	await mkdir(join(tmp, "parent-session"), { recursive: true });
	await mkdir(join(tmp, "child-session", "nested"), { recursive: true });
	await writeFile(join(tmp, "parent-session", "evidence.json"), "parent evidence");
	await writeFile(join(tmp, "child-session", ".hidden"), "hidden");
	await writeFile(join(tmp, "child-session", "nested", "scratch.txt"), "scratch");
	await writeFile(join(tmp, "legacy.txt"), "legacy");

	await child.shutdown({ reason: "quit" }, context(project, "child-session"));

	assert.deepEqual((await readdir(tmp)).sort(), ["legacy.txt", "parent-session"]);
	assert.equal(await readFile(join(tmp, "parent-session", "evidence.json"), "utf8"), "parent evidence");
	assert.equal(await readFile(join(tmp, "legacy.txt"), "utf8"), "legacy");
});

test("does not clean on reload or session replacement", async () => {
	const project = await mkdtemp(join(tmpdir(), "pi-cleanup-agent-tmp-"));
	const tmp = join(project, ".agents", "tmp", "own-session");
	await mkdir(tmp, { recursive: true });
	await writeFile(join(tmp, "keep.txt"), "keep");
	const extension = registerExtension();

	for (const reason of ["reload", "new", "resume", "fork"]) {
		await extension.shutdown({ reason }, context(project));
	}

	assert.equal(await readFile(join(tmp, "keep.txt"), "utf8"), "keep");
});

test("does nothing when .agents/tmp is absent", async () => {
	const project = await mkdtemp(join(tmpdir(), "pi-cleanup-agent-tmp-"));
	await registerExtension().shutdown({ reason: "quit" }, context(project));
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

	const originalError = console.error;
	console.error = () => {};
	try {
		await registerExtension().shutdown({ reason: "quit" }, context(project));
	} finally {
		console.error = originalError;
	}

	assert.equal(await readFile(join(target, "keep.txt"), "utf8"), "keep");
});

test("concurrent parent and child runs receive distinct paths and either may quit first", async () => {
	for (const first of ["parent-session", "child-session"]) {
		const project = await mkdtemp(join(tmpdir(), "pi-cleanup-agent-tmp-"));
		const parent = registerExtension();
		const child = registerExtension();
		const [parentPrompt, childPrompt] = await Promise.all([
			parent.before(context(project, "parent-session")),
			child.before(context(project, "child-session")),
		]);
		assert.ok(parentPrompt.systemPrompt.includes(join(project, ".agents", "tmp", "parent-session")));
		assert.ok(childPrompt.systemPrompt.includes(join(project, ".agents", "tmp", "child-session")));
		const survivor = first === "parent-session" ? "child-session" : "parent-session";
		await writeFile(join(project, ".agents", "tmp", survivor, "live.txt"), "still running");
		const leaving = first === "parent-session" ? parent : child;
		await leaving.shutdown({ reason: "quit" }, context(project, first));
		assert.deepEqual(await readdir(join(project, ".agents", "tmp")), [survivor]);
		assert.equal(await readFile(join(project, ".agents", "tmp", survivor, "live.txt"), "utf8"), "still running");
	}
});

for (const reason of ["new", "resume", "fork"]) {
	test(`after ${reason} the next run and quit use the fresh session ID`, async () => {
		const project = await mkdtemp(join(tmpdir(), "pi-cleanup-agent-tmp-"));
		const extension = registerExtension();
		let id = "previous-session";
		const ctx = { cwd: project, sessionManager: { getSessionId: () => id } };
		await extension.before(ctx);
		const oldFile = join(project, ".agents", "tmp", id, "keep.txt");
		await writeFile(oldFile, "previous session");
		await extension.shutdown({ reason }, ctx);
		id = "active-session";
		const prompt = await extension.before(ctx);
		assert.ok(prompt.systemPrompt.includes(join(project, ".agents", "tmp", id)));
		assert.ok(!prompt.systemPrompt.includes("previous-session"));
		await extension.shutdown({ reason: "quit" }, ctx);
		assert.equal(await readFile(oldFile, "utf8"), "previous session");
		assert.deepEqual(await readdir(join(project, ".agents", "tmp")), ["previous-session"]);
	});
}

test("repeated runs preserve scratch files and repeated quit is harmless", async () => {
	const project = await mkdtemp(join(tmpdir(), "pi-cleanup-agent-tmp-"));
	const extension = registerExtension();
	const ctx = context(project);
	await extension.before(ctx);
	const own = join(project, ".agents", "tmp", "own-session");
	await writeFile(join(own, "keep.txt"), "same session");
	await extension.before(ctx);
	assert.equal(await readFile(join(own, "keep.txt"), "utf8"), "same session");
	await extension.shutdown({ reason: "quit" }, ctx);
	await extension.shutdown({ reason: "quit" }, ctx);
	assert.deepEqual(await readdir(join(project, ".agents", "tmp")), []);
});

test("the same session ID in a different project is not cleaned", async () => {
	const project = await mkdtemp(join(tmpdir(), "pi-cleanup-agent-tmp-"));
	const other = await mkdtemp(join(tmpdir(), "pi-cleanup-agent-tmp-"));
	const extension = registerExtension();
	await extension.before(context(project));
	await extension.before(context(other));
	const otherFile = join(other, ".agents", "tmp", "own-session", "keep.txt");
	await writeFile(otherFile, "other project");
	await extension.shutdown({ reason: "quit" }, context(project));
	assert.equal(await readFile(otherFile, "utf8"), "other project");
});

test("missing and unsafe session IDs never fall back to shared-root cleanup or creation", async (t) => {
	t.mock.method(console, "error", () => {});
	const project = await mkdtemp(join(tmpdir(), "pi-cleanup-agent-tmp-"));
	const root = join(project, ".agents", "tmp");
	await mkdir(join(root, "parent-session"), { recursive: true });
	await writeFile(join(root, "legacy.txt"), "legacy");
	for (const id of [undefined, null, "", ".", "..", "../parent-session", "/absolute", "parent/session", "parent\\session", "x\n", "x\0", ".prefix", "trailing.", "trailing-"]) {
		const ctx = { cwd: project, sessionManager: { getSessionId: () => id } };
		const extension = registerExtension();
		await assert.rejects(extension.before(ctx), /session ID/);
		await extension.shutdown({ reason: "quit" }, ctx);
		assert.deepEqual((await readdir(root)).sort(), ["legacy.txt", "parent-session"]);
	}
	await registerExtension().shutdown({ reason: "quit" }, { cwd: project });
	assert.equal(await readFile(join(root, "legacy.txt"), "utf8"), "legacy");
});

for (const level of [".agents", "tmp", "session"]) {
	test(`refuses a symlink at the ${level} boundary during guidance and cleanup`, async (t) => {
		t.mock.method(console, "error", () => {});
		const project = await mkdtemp(join(tmpdir(), "pi-cleanup-agent-tmp-"));
		const target = join(project, "unrelated-target");
		await mkdir(target);
		await writeFile(join(target, "keep.txt"), "outside session");
		const link = level === ".agents" ? join(project, ".agents") : level === "tmp" ? join(project, ".agents", "tmp") : join(project, ".agents", "tmp", "own-session");
		if (level === "tmp") await mkdir(join(project, ".agents"));
		if (level === "session") await mkdir(join(project, ".agents", "tmp"), { recursive: true });
		await symlink(target, link);
		const extension = registerExtension();
		await assert.rejects(extension.before(context(project)), /symbolic-link/);
		await extension.shutdown({ reason: "quit" }, context(project));
		assert.equal(await readFile(join(target, "keep.txt"), "utf8"), "outside session");
		assert.ok((await lstat(link)).isSymbolicLink());
		assert.deepEqual(await readdir(target), ["keep.txt"]);
	});
}

test("an internal symlink is unlinked without removing files in the sibling session", async () => {
	const project = await mkdtemp(join(tmpdir(), "pi-cleanup-agent-tmp-"));
	const extension = registerExtension();
	await extension.before(context(project));
	await extension.before(context(project, "sibling-session"));
	const sibling = join(project, ".agents", "tmp", "sibling-session");
	await writeFile(join(sibling, "keep.txt"), "sibling");
	await symlink(sibling, join(project, ".agents", "tmp", "own-session", "link"));
	await extension.shutdown({ reason: "quit" }, context(project));
	assert.equal(await readFile(join(sibling, "keep.txt"), "utf8"), "sibling");
	assert.deepEqual(await readdir(join(project, ".agents", "tmp")), ["sibling-session"]);
});

test("a fresh extension instance can resume an owned directory and clean it on quit", async () => {
	const project = await mkdtemp(join(tmpdir(), "pi-cleanup-agent-tmp-"));
	const ctx = context(project);
	await registerExtension().before(ctx);
	const own = join(project, ".agents", "tmp", "own-session");
	await writeFile(join(own, "keep.txt"), "resumed");
	const resumed = registerExtension();
	await resumed.before(ctx);
	assert.equal(await readFile(join(own, "keep.txt"), "utf8"), "resumed");
	await resumed.shutdown({ reason: "quit" }, ctx);
	assert.deepEqual(await readdir(join(project, ".agents", "tmp")), []);
});

test("invalid, oversized or mismatched ownership evidence is never adopted or cleaned", async (t) => {
	t.mock.method(console, "error", () => {});
	for (const marker of ["not json", "null", "{}", "x".repeat(1025), JSON.stringify({ extension: "pi-cleanup-agent-tmp", version: 1, sessionId: "somebody-else" })]) {
		const project = await mkdtemp(join(tmpdir(), "pi-cleanup-agent-tmp-"));
		const extension = registerExtension();
		const ctx = context(project);
		await extension.before(ctx);
		const own = join(project, ".agents", "tmp", "own-session");
		await writeFile(join(own, "evidence.json"), "preserve");
		await writeFile(join(own, ".pi-session-tmp.json"), marker);
		await assert.rejects(extension.before(ctx), /ownership/);
		await extension.shutdown({ reason: "quit" }, ctx);
		assert.equal(await readFile(join(own, "evidence.json"), "utf8"), "preserve");
		assert.equal(await readFile(join(own, ".pi-session-tmp.json"), "utf8"), marker);
	}
});

for (const markerState of ["missing", "symlinked"]) {
	test(`${markerState} ownership evidence prevents cleanup`, async (t) => {
		t.mock.method(console, "error", () => {});
		const project = await mkdtemp(join(tmpdir(), "pi-cleanup-agent-tmp-"));
		const ctx = context(project);
		const extension = registerExtension();
		await extension.before(ctx);
		const own = join(project, ".agents", "tmp", "own-session");
		const marker = join(own, ".pi-session-tmp.json");
		await writeFile(join(own, "keep.txt"), "preserve");
		await rename(marker, join(project, "saved-marker.json"));
		if (markerState === "symlinked") await symlink(join(project, "saved-marker.json"), marker);
		await assert.rejects(extension.before(ctx), /ownership/);
		await extension.shutdown({ reason: "quit" }, ctx);
		assert.equal(await readFile(join(own, "keep.txt"), "utf8"), "preserve");
		assert.ok((await readFile(join(project, "saved-marker.json"), "utf8")).includes("own-session"));
	});
}

test("a file at the session path is preserved rather than removed", async (t) => {
	t.mock.method(console, "error", () => {});
	const project = await mkdtemp(join(tmpdir(), "pi-cleanup-agent-tmp-"));
	const root = join(project, ".agents", "tmp");
	await mkdir(root, { recursive: true });
	await writeFile(join(root, "own-session"), "legacy file");
	const extension = registerExtension();
	await assert.rejects(extension.before(context(project)), /non-directory/);
	await extension.shutdown({ reason: "quit" }, context(project));
	assert.equal(await readFile(join(root, "own-session"), "utf8"), "legacy file");
});
