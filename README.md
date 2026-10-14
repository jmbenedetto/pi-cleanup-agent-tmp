# pi-cleanup-agent-tmp

A [Pi](https://github.com/badlogic/pi-mono) package that cleans the project's `.agents/tmp` on graceful exit and blocks known over-limit file destinations in OneDrive folders.

Cleanup preserves the `tmp` directory itself and removes every file and nested directory inside it, including hidden files.

## Install

Install the tagged release globally:

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

The extension skips `.agents/tmp` if that path is a file or symbolic link.

## Concurrent sessions

`.agents/tmp` belongs to the project, not to one Pi session. If several Pi sessions use the same project, quitting any one of them empties the shared directory.

## OneDrive path-length guard

Microsoft documents a **400-character maximum for the entire decoded cloud path**, including folders, separators, filename and extension. Exactly 400 is allowed; 401 is blocked. This is not a 400-character filename limit, and the cloud path is not the local absolute path. See [Microsoft's path-length limits](https://support.microsoft.com/en-us/onedrive/what-are-file-path-length-limits) and [restrictions and limitations](https://support.microsoft.com/en-us/onedrive/restrictions-and-limitations-in-onedrive-and-sharepoint).

The `tool_call` hook checks destinations **before** Pi executes a supported tool. It runs without a UI and reports the measured length and how many characters must be removed. The cleanup hook is unchanged.

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

This change is not in the existing `v1.0.0` tag. To try the guard without changing your package configuration, start a new Pi session with:

```bash
pi -e /absolute/path/to/pi-cleanup-agent-tmp/extensions/path-length-guard.ts
```

To load the full local package instead of a Git release, replace its Git package entry with the absolute checkout path in your Pi settings, then `/reload`. Do not load both cleanup entry points, since that registers cleanup twice.

## Development

```bash
npm install
npm run check
```

## License

MIT
