# pi-cleanup-agent-tmp

A small [Pi](https://github.com/badlogic/pi-mono) extension that empties the current project's `.agents/tmp` directory when Pi exits normally.

The extension preserves the `tmp` directory itself and removes every file and nested directory inside it, including hidden files.

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

## Development

```bash
npm install
npm run check
```

## License

MIT
