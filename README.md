# pi-cleanup-agent-tmp

A [Pi](https://github.com/badlogic/pi-mono) package that gives each agent or subagent its own temporary directory and blocks known over-limit file destinations in OneDrive folders.

Before each agent run, the extension reads `ctx.sessionManager.getSessionId()`, creates `.agents/tmp/<session-id>/` under the current project, and appends its absolute path to the system prompt. Agents are directed to save scratch scripts and intermediate outputs there. Each subagent uses its own session ID, not its parent's ID.

New session directories contain `.pi-session-tmp.json`, an ownership marker recording the extension, format version and session ID. Existing directories are reused only when that regular, non-symlink marker matches the session. An unmarked directory is never adopted, even if its name matches a valid session ID.

On graceful quit, cleanup verifies ownership again and removes only that session directory, including its nested and hidden files. Other sessions, unowned legacy directories, files directly in `.agents/tmp`, and the shared root itself are preserved. Missing, malformed or mismatched ownership evidence leaves the directory untouched and reports a skipped cleanup.

## Install

The session-isolation change is not in the existing `v1.0.0` tag. Use the local checkout instructions below to test it. The existing published release can be installed globally with:

```bash
pi install git:github.com/jmbenedetto/pi-cleanup-agent-tmp@v1.0.0
```

Then start a new Pi session or run `/reload`.

Remove it with:

```bash
pi remove git:github.com/jmbenedetto/pi-cleanup-agent-tmp
```

## When cleanup runs

Cleanup runs for a graceful Pi quit:

- `/quit`
- Ctrl+D
- Ctrl+C twice
- SIGHUP
- SIGTERM

It does not run for `/reload`, `/new`, `/resume`, or `/fork`. SIGKILL and process crashes cannot run shutdown hooks.

Reload and session replacement preserve temporary files. The next run uses the current context's session ID, so new, resumed and forked sessions are directed to their own directory. Preserved directories are not swept automatically; a resumed session cleans its directory when it eventually quits.

Session IDs follow Pi's safe-component format: alphanumeric start and end, with alphanumeric characters, dots, underscores and hyphens internally. There is no additional application-level length cap; filesystem limits still apply. Missing or unsafe session IDs never fall back to shared-root cleanup. Directory creation and cleanup refuse files and symbolic links at `.agents`, `tmp`, or the session-directory boundary. These checks assume a trusted workspace; they are not a sandbox against concurrent filesystem tampering.

## Concurrent sessions

Sessions with different IDs use sibling directories. A parent or subagent can quit without removing the other's files. The same ID in a different project has a different directory. Two processes deliberately opening the same logical session ID in the same project share that directory; use separate sessions for concurrent work.

Keep the ownership marker intact. If an ID collides with an unowned legacy directory, or its marker cannot be verified, prompt preparation reports an error rather than adopting or moving that directory. Resolve the collision explicitly; no automatic migration is performed.

Guidance applies wherever this extension is enabled, including non-interactive SDK subagents. It does not rewrite shell commands, set a process-wide `TMPDIR`, or sandbox writes. Scripts and skills with hard-coded shared temporary paths must be pointed at the session directory. Keep deliverables, durable caches and cross-session handoff files in explicitly chosen persistent locations, not in a session's temporary directory. No legacy files are moved or deleted.

## OneDrive path-length guard

Microsoft documents a **400-character maximum for the entire decoded cloud path**, including folders, separators, filename and extension. Exactly 400 is allowed; 401 is blocked. This is not a 400-character filename limit, and the cloud path is not the local absolute path. See [Microsoft's path-length limits](https://support.microsoft.com/en-us/onedrive/what-are-file-path-length-limits) and [restrictions and limitations](https://support.microsoft.com/en-us/onedrive/restrictions-and-limitations-in-onedrive-and-sharepoint).

The `tool_call` hook checks destinations **before** Pi executes a supported tool. It runs without a UI and reports the measured length and how many characters must be removed. This guard does not perform cleanup.

### OneDrive only

The guard discovers existing OneDrive roots from:

- `OneDrive`, `OneDriveConsumer` and `OneDriveCommercial` environment variables.
- Direct children named `OneDrive`, `OneDrive-*` or `OneDrive - *` in your home folder or `~/Library/CloudStorage`.

It resolves roots and existing destination ancestors through symlinks. An alias such as `~/workbench` pointing into OneDrive is covered. Other destinations are unaffected. Discovery uses directory names and metadata, not file contents.

Without a cloud mapping, the guard conservatively checks the **resolved absolute local path** against 400. That includes the local OneDrive root and may reject paths whose cloud path would still fit. For actual cloud-path counting, add mappings to `~/.pi/agent/path-length-guard.json`, or under `PI_CODING_AGENT_DIR` if set:

```json
{
  "roots": [
    {
      "localRoot": "~/Library/CloudStorage/OneDrive-Personal",
      "cloudPrefix": "Documents"
    }
  ]
}
```

`localRoot` must be an existing absolute path or `~/...`. Set `cloudPrefix` to the decoded cloud folder path corresponding to that local root. For a root that represents a subfolder, include that subfolder in the prefix. Do not include a hostname, query string or URL encodings. An empty prefix counts only the path relative to the mapped root, so use it only if that matches your cloud namespace. Literal `%20` in a local filename stays `%20`; the guard never URL-decodes filesystem names.

Explicit mappings override the same discovered root; the most specific matching root wins. You can map nonstandard OneDrive/SharePoint sync locations this way. The config is read on every checked call. `PI_PATH_LENGTH_GUARD_CONFIG` selects a different config file. Invalid configuration or unreadable paths block checked calls rather than silently disabling validation.

### Checked operations

- Pi `write`, including writes to existing files.
- Plain structured tools named `write_file` or `create_directory` with `path`, and `move_file` or `copy_file` with `source` and `destination`. These are exact tool names, not discovery or registration of additional tools.
- Literal `bash` commands using `mv`, `cp`, `mkdir`, `touch` or `tee`, plus output redirections `>`, `>>` and `>|`.
- Quoted/escaped literal paths, command lists, supported flags, `mv`/`cp` target directories and `cd literal-directory && ...`.
- Directory copies and moves into OneDrive, including projected descendant names. The scan reads directory metadata only and does not follow source symlinks.

The hook does not mutate files. It allows reads, edits, and moves that shorten existing over-limit paths. Path counts use UTF-16 code units, so an emoji outside the BMP conservatively counts as two. Separate filename, filesystem-byte, Windows/Office and sync-client limits are not enforced.

### Limits of the hook

This is an explicit-destination check, **not a filesystem sandbox**. Arbitrary scripts, shell expansions, globs, command substitutions, heredocs, compound control flow, unsupported flags, wrappers such as `sudo`/`env`, PowerShell, MCP proxy calls, and unrecognized tools can bypass it. A `cd` chain without `&&` is not analyzed after the directory change. External applications, direct extension filesystem writes, and changes made after the metadata check are also outside its scope. Supported copy checks assume symlinks are not dereferenced.

It does not scan or rename existing files on startup. No OneDrive account or cloud metadata is queried, so verify configured cloud prefixes yourself.

### Try the local checkout

The session-isolation change and the path-length guard are not in the existing `v1.0.0` tag. To try only the guard without changing your package configuration, start a new Pi session with:

```bash
pi -e /absolute/path/to/pi-cleanup-agent-tmp/extensions/path-length-guard.ts
```

To load the full local package instead of a Git release, replace its Git package entry with the absolute checkout path in your Pi settings, then `/reload`. For a checkout under `~/code`, that entry is `/Users/<your-user>/code/pi-cleanup-agent-tmp`. Load only one cleanup extension: the old globally installed version would still erase the shared root even alongside the corrected local version. Existing running sessions and subagents retain their loaded code until reloaded or restarted.

## Development

The development SDK is pinned to Pi 1.3.0 and requires Node.js 22.19.0 or newer. The SDK remains a development dependency and a host-provided peer; it is not bundled with the extension. Updating this checkout does not update an installed Pi runtime.

```bash
npm ci --ignore-scripts
mkdir -p .tmp
TMPDIR="$PWD/.tmp" npm run check
```

## License

MIT
