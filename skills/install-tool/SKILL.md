---
id: install-tool
name: Install Tool
description: Workspace-scoped tool management. Use to install or update a binary, directory-style tool, npm CLI, or pip CLI; remove one; list installed tools; or check a tool and its version.
version: 1
enabled: true
kind: operational
permissions:
  - install.run
match:
  - install tool
  - update tool
  - remove tool
  - list installed tools
  - check tool
  - npm install
  - pip install
---

# Install Tool

Manage persistent tools without modifying the base image or using system package managers.

## Permissions

- `install.run` — Install, update, or remove a tool in the workspace runtime.

List and check are read-only but still follow the runtime's declared permission policy.

## Runtime layout

Resolve paths from `$WORKSPACE_DIR`; never hardcode a home directory:

```bash
WORKSPACE_RUNTIME="${WORKSPACE_DIR}/runtime"
WORKSPACE_BIN="${WORKSPACE_RUNTIME}/bin"
WORKSPACE_TOOLS="${WORKSPACE_RUNTIME}/tools"
NPM_PREFIX="${WORKSPACE_RUNTIME}/npm"
PYTHON_USER_BASE="${WORKSPACE_RUNTIME}/python"
mkdir -p "$WORKSPACE_BIN" "$WORKSPACE_TOOLS" "$NPM_PREFIX" "$PYTHON_USER_BASE"
```

- Single executables: `workspace/runtime/bin/`
- Directory tools with required sibling files: `workspace/runtime/tools/<name>/`, plus a wrapper in the shared bin
- npm packages: `workspace/runtime/npm/`; both `workspace/runtime/bin/` and `workspace/runtime/npm/bin` are on `PATH`
- pip packages: `workspace/runtime/python/`, resolved automatically via `PYTHONUSERBASE`; `workspace/runtime/python/bin` is on `PATH`

## Execution

1. Require `install-tool:install.run` before any mutation. `list` and `check` remain read-only but still follow the runtime's declared permission policy.
2. Classify the operation: install, update, remove, list, or check.
3. Inspect current state with `command -v` and the runtime directories:
   - On install, if the tool already works and no update was requested, report its path/version and stop.
   - Never infer an update from a plain install request.
4. For install/update, select one mode:
   - Explicit npm package or “via npm”: read [npm packages](references/npm.md).
   - Explicit pip/PyPI package or “via pip”: read [pip packages](references/pip.md).
   - Direct binary or archive: read [binary and directory tools](references/archive.md).
   - If neither the artifact nor a trustworthy official release can be identified, ask for a URL; do not guess one.
5. For remove/list/check, read [installed-tool operations](references/operations.md).
6. Verify independently after every mutation:
   - the resolved executable is inside `$WORKSPACE_RUNTIME`;
   - it starts successfully with `--version`, `version`, or a documented non-mutating probe;
   - temporary files are gone.
7. Report the tool, operation, resolved version, and install mode. On failure, include the attempted source and concrete error without claiming success.

Completion requires the requested final state to be observed from disk and, for installs/updates, from a successful executable probe.

## Boundaries

- Do not use `apt`, `brew`, or another system package manager.
- Do not build from source. For pip, that means wheels only (`--only-binary=:all:`) — see [pip packages](references/pip.md).
- Accept only HTTPS artifacts unless the user explicitly supplied a local file.
- Verify a publisher checksum or signature whenever one is available; abort on mismatch.
- Never choose the first executable in an archive heuristically. Identify the intended executable from publisher layout or ask.
- Normalize platform only for archive downloads:

  ```bash
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  case "$(uname -m)" in
    x86_64) ARCH=amd64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) echo "unsupported architecture" >&2; exit 1 ;;
  esac
  ```
