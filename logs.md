# Change log

## 2026-10-23 Session-scoped temporary files

- Cloned `https://github.com/jmbenedetto/pi-cleanup-agent-tmp.git` into `/Users/jmb/code/pi-cleanup-agent-tmp` at main `1ed724e7630f378a40503e7df7bbafcb4361bb3a`; created local branch `fix/session-scoped-tmp`.
- Reproduced the parent/subagent deletion bug through the public shutdown hook before changing the implementation. Evidence: `.tmp/red-cleanup.out`; the original code erased both the parent directory and a legacy root file.
- Added session-ID-scoped cleanup and a `before_agent_start` directive containing the current session's absolute temporary path. Captured the missing-prompt-hook failure before implementation in `.tmp/red-prompt.out`.
- Preserve other sessions, legacy root files, reload and session replacement. Reject missing/unsafe IDs and symlink/non-directory boundaries; do not rewrite commands or mutate process-wide temporary-path variables.
- Extended public-hook tests for concurrency, fresh IDs after replacement, idempotence, project boundaries, unsafe IDs and symlinks. Updated README and ignored local `.tmp/` scratch artifacts.
- Installed locked dependencies with `npm ci --ignore-scripts`. npm reported 3 existing dependency vulnerabilities: 1 moderate, 2 high. No dependency changes or automatic audit fixes applied.
- Follow-up read-only audit confirmed fixes are published: brace-expansion 5.0.9 → 5.0.12 and undici 8.9.0 → 8.10.2. The third vulnerable-package entry is the SDK inheriting the undici finding. SDK 0.84.3 pins undici 8.9.0; npm recommends SDK 1.4.0 as a SemVer-major update, which pins undici 8.10.2. Evidence: `.tmp/audit.json`, `.tmp/audit-tree.txt` and registry version queries. No manifest, lockfile or installed dependencies changed during this check.
- First independent review `f5da20f2-bb0f-447c-bab0-9775dfbb73fd` blocked on ownership ambiguity for a pre-existing directory matching a custom session ID, and rejection of valid Pi IDs containing dots or exceeding 128 characters. Both findings were reproduced before fixing: `.tmp/red-ownership.out` and `.tmp/red-valid-ids.out`.
- Added exclusive creation and validation of `.pi-session-tmp.json` ownership metadata. Unmarked legacy directories are never adopted; missing, malformed, oversized, symlinked or mismatched markers prevent both reuse and cleanup. Matching metadata permits a later extension instance to resume the same logical session.
- ID validation now matches Pi's documented implementation exactly, without an additional 128-character cap. Filesystem component limits still apply.
- Validation after those fixes: `TMPDIR="$PWD/.tmp" npm run check` exited 0 with TypeScript clean and 42/42 tests passing, including real offline Pi `SessionManager.inMemory` IDs and `newSession()`. Full output: `.tmp/check.out`.
- Final `git diff --check` and `npm pack --dry-run --json` exited 0 after the ownership changes. `.tmp/pack.json` includes the corrected cleanup and unchanged OneDrive guard, without scratch artifacts.
- Independent re-review `c120adc3-fd8d-4416-889c-4ddcc9d24f5b`: PASS, no issues found, merge verdict OK. Fresh final validation after review still passed TypeScript and all 42 tests.
- No GitHub publication, commit, Pi package activation, or user configuration changes performed.

## 2026-10-23 Dependency security update

- User authorized dependency adjustments and re-testing. Baseline audit reported 3 vulnerable package entries; exact prior report remains in `.tmp/audit.json`.
- Initial SDK 1.4.0 install was rejected by npm's configured seven-day `min-release-age` policy. It was published 2026-10-21; no age override or policy/configuration change was used. The failed install left the manifest and lockfile unchanged. Evidence: `.tmp/dependency-upgrade.out` and `.tmp/sdk-release-times.json`.
- Selected SDK 1.3.0, published 2026-10-15 and admitted by the same policy. Updated the exact development pin in `package.json` and regenerated `package-lock.json` with `npm install --save-dev --save-exact @earendil-works/pi-coding-agent@1.3.0 --ignore-scripts`.
- The resulting dependency graph uses undici 8.10.2 and brace-expansion 5.0.12, including nested consumers. No overrides, forced audit fix, or extension-code changes were needed. README now states the development SDK's Node.js >=22.19.0 requirement and distinguishes it from the host-provided runtime.
- Reinstalled strictly from the lockfile with `npm ci --ignore-scripts`: exit 0. Evidence: `.tmp/ci-sdk-1.3.0.out`.
- After the clean install, TypeScript and all 42 tests passed; `npm audit --json` reported 0 vulnerabilities and exited 0. `npm pack --dry-run --json` and `git diff --check` also exited 0. Evidence: `.tmp/check-after-ci.out`, `.tmp/audit-after-ci.json`, `.tmp/pack-after-ci.json`, `.tmp/tree-sdk-1.3.0.txt`.
- Dependency-focused independent review `e7d764f4-c234-4598-a149-60d74f675816`: PASS, no blocking findings. It confirmed manifest/lock agreement, corrected nested dependency versions, registry HTTPS/integrity metadata, and unchanged security policy. Audit covers known advisories only, not unknown vulnerabilities or the separately installed global Pi runtime.
- No global Pi install, release, commit, push, or user configuration change performed during the dependency update.

## 2026-10-23 Local commit authorization

- User requested a local commit and asked whether work was on main/master. Verified the checkout is on `fix/session-scoped-tmp`, not main/master, with no previously staged changes.
- Repeated pre-commit validation: TypeScript and all 42 tests passed, `npm audit` reported 0 known vulnerabilities, and `git diff --check` passed. Evidence: `.tmp/precommit-check.out`, `.tmp/precommit-audit.json`, `.tmp/precommit-source.diff`.
- Commit scope: `.gitignore`, `README.md`, `extensions/cleanup-agent-tmp.ts`, `package.json`, `package-lock.json`, `tests/cleanup-agent-tmp.test.mjs`, and this log. No push, release, or global Pi activation authorized.
