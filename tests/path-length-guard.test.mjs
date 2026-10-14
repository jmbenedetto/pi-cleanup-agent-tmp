import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import extension, { guardToolCall } from "../extensions/path-length-guard.ts";
import { countedPath, loadConfig } from "../extensions/lib/path-policy.ts";
import { shellDestinations } from "../extensions/lib/shell-destinations.ts";

async function fixture(t) {
	const temp = await realpath(await mkdtemp(join(tmpdir(), "pi-path-guard-")));
	t.after(() => rm(temp, { recursive: true, force: true }));
	const root = join(temp, "OneDrive");
	await mkdir(root);
	return { temp, root, config: { roots: [{ localRoot: root, cloudPrefix: "" }] } };
}
const cloudPath = (root, length) => join(root, "a".repeat(190), "b".repeat(length - 191));
const invoke = (toolName, input, f) => guardToolCall(toolName, input, f.temp, f.config);

for (const length of [399, 400, 401]) {
	test(`write ${length} decoded cloud characters ${length > 400 ? "blocks" : "passes"}`, async (t) => {
		const f = await fixture(t);
		const result = await invoke("write", { path: cloudPath(f.root, length), content: "note" }, f);
		assert.equal(result?.block, length > 400 ? true : undefined);
		if (result) assert.match(result.reason, /401 characters exceeds 400 by 1/);
	});
}

test("only OneDrive paths are guarded, including boundary-safe root matching", async (t) => {
	const f = await fixture(t);
	for (const root of [f.temp, `${f.root}-unrelated`]) {
		assert.equal(await invoke("write", { path: cloudPath(root, 500) }, f), undefined);
	}
});

test("read and edit of existing over-limit files remain available", async (t) => {
	const f = await fixture(t);
	for (const tool of ["read", "edit", "grep", "ls"]) {
		assert.equal(await invoke(tool, { path: cloudPath(f.root, 401) }, f), undefined);
	}
});

test("default OneDrive policy counts absolute local path; explicit mapping counts prefix", async (t) => {
	const f = await fixture(t);
	const path = cloudPath(f.root, 350);
	assert.equal(countedPath(path, { roots: [{ localRoot: f.root }] }), path);
	assert.equal(countedPath(path, { roots: [{ localRoot: f.root, cloudPrefix: "Documents/vault" }] }).length, 366);
	const longest = { roots: [
		{ localRoot: f.root, cloudPrefix: "Documents" },
		{ localRoot: join(f.root, "vault"), cloudPrefix: "Other library/vault" },
	] };
	assert.equal(countedPath(join(f.root, "vault", "note.md"), longest), "Other library/vault/note.md");
});

test("spaces, extension, separators and literal percent sequences count without URL decoding", async (t) => {
	const f = await fixture(t);
	const prefix = "Documents/My vault";
	const path = join(f.root, "x%20 y.md");
	assert.equal(countedPath(path, { roots: [{ localRoot: f.root, cloudPrefix: prefix }] }), `${prefix}/x%20 y.md`);
	const unicode = `${"a".repeat(399)}😀`;
	assert.equal(unicode.length, 401);
	assert.equal(countedPath(join(f.root, unicode), f.config).length, 401);
});

test("resolves aliases and nonexistent descendants, but ignores links escaping OneDrive", async (t) => {
	const f = await fixture(t);
	const alias = join(f.temp, "workbench");
	await symlink(f.root, alias);
	assert.equal((await invoke("write", { path: cloudPath(alias, 401) }, f))?.block, true);
	const external = join(f.temp, "external");
	await mkdir(external);
	await symlink(external, join(f.root, "escape"));
	assert.equal(await invoke("write", { path: cloudPath(join(f.root, "escape"), 401) }, f), undefined);
});

test("literal shell creation and rename destinations block before execution", async (t) => {
	const f = await fixture(t);
	const long = cloudPath(f.root, 401);
	for (const command of [
		`mv -- old '${long}'`, `/bin/mv -f old '${long}'`, `cp -r old '${long}'`,
		`mkdir -p '${long}'`, `touch '${long}'`, `echo hello > '${long}'`,
		`echo hello >> '${long}'`, `printf x | tee -a '${long}'`,
	]) assert.equal((await invoke("bash", { command }, f))?.block, true, command);
});

test("copy and move to existing directories include source basename", async (t) => {
	const f = await fixture(t);
	const target = cloudPath(f.root, 398);
	await mkdir(target, { recursive: true });
	for (const command of [`mv abc '${target}'`, `cp -t '${target}' abc`, `mv --target-directory='${target}' abc`]) {
		assert.equal((await invoke("bash", { command }, f))?.block, true, command);
	}
});

test("moving or copying a directory validates descendants without mutating the source", async (t) => {
	const f = await fixture(t);
	const source = join(f.temp, "source");
	await mkdir(join(source, "nested"), { recursive: true });
	await writeFile(join(source, "nested", "note.md"), "unchanged");
	const target = cloudPath(f.root, 390);
	for (const command of [`mv '${source}' '${target}'`, `cp -r '${source}' '${target}'`]) {
		assert.equal((await invoke("bash", { command }, f))?.block, true);
	}
	assert.equal(await readFile(join(source, "nested", "note.md"), "utf8"), "unchanged");
	assert.equal(await invoke("bash", { command: `mv '${source}' '${join(f.root, "short")}'` }, f), undefined);
});

test("does not follow symlinks while scanning source descendants", async (t) => {
	const f = await fixture(t);
	const source = join(f.temp, "source"), external = join(f.temp, "external");
	await mkdir(source); await mkdir(external);
	await writeFile(join(external, "x".repeat(100)), "keep");
	await symlink(external, join(source, "link"));
	assert.equal(await invoke("bash", { command: `mv '${source}' '${cloudPath(f.root, 390)}'` }, f), undefined);
});

test("shortening an already over-limit source is permitted", async (t) => {
	const f = await fixture(t);
	const source = cloudPath(f.root, 401);
	await mkdir(dirname(source), { recursive: true });
	await writeFile(source, "keep");
	assert.equal(await invoke("bash", { command: `mv '${source}' '${join(f.root, "short.md")}'` }, f), undefined);
});

test("tracks literal cd && commands, quotes and shell escapes", () => {
	assert.deepEqual(shellDestinations("cd 'sub folder' && touch 'a b.md' c\\ d.md", "/root"), [
		{ path: "a b.md", cwd: "/root/sub folder" }, { path: "c d.md", cwd: "/root/sub folder" },
	]);
	assert.deepEqual(shellDestinations("echo 'if' > out.md", "/root"), [{ path: "out.md", cwd: "/root" }]);
	assert.deepEqual(shellDestinations("touch 'literal$cash'", "/root"), [{ path: "literal$cash", cwd: "/root" }]);
	assert.deepEqual(shellDestinations("touch '~/note.md'", "/root"), [{ path: "./~/note.md", cwd: "/root" }]);
	assert.deepEqual(shellDestinations("touch ~unknown/note.md", "/root"), []);
	assert.deepEqual(shellDestinations("touch a; mkdir -m 755 -- b", "/root"), [
		{ path: "a", cwd: "/root" }, { path: "b", cwd: "/root" },
	]);
});

test("explicitly leaves expansions, embedded scripts, heredocs and compound flow unguarded", () => {
	for (const command of [
		'touch "$DEST"', 'mv old "$(pwd)/new"', 'touch `pwd`/new', "touch *.md",
		"python -c 'open(\"new\", \"w\")'", "node script.js", "for f in *; do touch $f; done",
		"cat <<EOF > out\nhello\nEOF", "(cd /tmp && touch new)", "cd missing; touch new", "mv --unknown old new",
	]) assert.deepEqual(shellDestinations(command, "/root"), [], command);
});

test("named structured create/copy/move tools are checked", async (t) => {
	const f = await fixture(t), destination = cloudPath(f.root, 401);
	for (const tool of ["move_file", "copy_file"]) assert.equal((await invoke(tool, { source: "old", destination }, f))?.block, true);
	for (const tool of ["create_directory", "write_file"]) assert.equal((await invoke(tool, { path: destination }, f))?.block, true);
});

test("configuration canonicalizes root aliases, discovers env roots and fails on invalid config", async (t) => {
	const f = await fixture(t);
	const configPath = join(f.temp, "config.json"), alias = join(f.temp, "alias");
	await symlink(f.root, alias);
	const oldConfig = process.env.PI_PATH_LENGTH_GUARD_CONFIG, oldRoot = process.env.OneDrive;
	process.env.PI_PATH_LENGTH_GUARD_CONFIG = configPath; process.env.OneDrive = alias;
	t.after(() => {
		if (oldConfig === undefined) delete process.env.PI_PATH_LENGTH_GUARD_CONFIG; else process.env.PI_PATH_LENGTH_GUARD_CONFIG = oldConfig;
		if (oldRoot === undefined) delete process.env.OneDrive; else process.env.OneDrive = oldRoot;
	});
	assert.ok((await loadConfig()).roots.some((r) => r.localRoot === f.root && r.cloudPrefix === undefined));
	await writeFile(configPath, JSON.stringify({ roots: [{ localRoot: alias, cloudPrefix: "Documents" }] }));
	assert.ok((await loadConfig()).roots.some((r) => r.localRoot === f.root && r.cloudPrefix === "Documents"));
	await writeFile(configPath, "{broken");
	assert.equal((await guardToolCall("write", { path: join(f.root, "short") }, f.temp))?.block, true);
	await writeFile(configPath, JSON.stringify({ roots: [{ localRoot: alias, cloudPrefix: "https://example.com/Documents" }] }));
	await assert.rejects(loadConfig(), /not a URL/);
});

test("extension blocks via the actual tool_call hook without requiring a UI", async (t) => {
	const f = await fixture(t), configPath = join(f.temp, "hook-config.json");
	await writeFile(configPath, JSON.stringify(f.config));
	const previous = process.env.PI_PATH_LENGTH_GUARD_CONFIG;
	process.env.PI_PATH_LENGTH_GUARD_CONFIG = configPath;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_PATH_LENGTH_GUARD_CONFIG; else process.env.PI_PATH_LENGTH_GUARD_CONFIG = previous;
	});
	let handler;
	extension({ on(name, fn) { assert.equal(name, "tool_call"); handler = fn; } });
	assert.equal(typeof handler, "function");
	const event = { toolName: "write", input: { path: cloudPath(f.root, 401), content: "not written" } };
	assert.equal((await handler(event, { cwd: f.temp, hasUI: false }))?.block, true);
	let notification;
	assert.equal((await handler(event, { cwd: f.temp, hasUI: true, ui: { notify: (message) => { notification = message; } } }))?.block, true);
	assert.match(notification, /401/);
	assert.equal(await handler({ toolName: "read", input: { path: event.input.path } }, { cwd: f.temp, hasUI: false }), undefined);
});
