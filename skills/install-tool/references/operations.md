# Installed-tool operations

Classify tools from their resolved paths:

- `$WORKSPACE_BIN/<name>` plus `$WORKSPACE_TOOLS/<name>/`: directory tool
- `$WORKSPACE_BIN/<name>` only: single executable
- `$NPM_PREFIX/bin/<name>`: npm CLI
- `$PYTHON_USER_BASE/bin/<name>`: pip CLI

## Check

```bash
RESOLVED=$(command -v "$NAME" || true)
```

If empty, report not installed. Otherwise require `RESOLVED` to be under `$WORKSPACE_RUNTIME`, then run the documented version probe with a short timeout. Report path, mode, and version. A command elsewhere on system `PATH` is not a workspace installation.

## List

Enumerate the three bin directories, deduplicate command names, and inspect each through the check procedure:

```bash
find "$WORKSPACE_BIN" "$NPM_PREFIX/bin" "$PYTHON_USER_BASE/bin" -maxdepth 1 \( -type f -o -type l \) -print 2>/dev/null
```

Sort by command name. Do not execute arbitrary long-running commands; use only documented non-mutating probes with a short timeout.

## Remove

First identify the mode.

Single executable or directory tool:

```bash
rm -f "$WORKSPACE_BIN/$NAME"
rm -rf "$WORKSPACE_TOOLS/$NAME"
```

npm CLI: read [npm packages](npm.md) and uninstall its owning package rather than deleting only a symlink.

pip CLI: read [pip packages](pip.md) and `pip uninstall` its owning package rather than deleting only the console-script entry point.

Completion requires `command -v "$NAME"` not to resolve inside `$WORKSPACE_RUNTIME` and all mode-specific artifacts to be absent. If the name was not installed in the workspace, report that and do nothing.
