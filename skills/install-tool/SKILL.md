---
id: install-tool
name: Install Tool
description: Install, update, remove, list, and check tools in the agent workspace. Supports single-file static binaries and directory-style tools (e.g. AWS CLI) that bundle their own libs. Tools are placed on PATH and persist across container restarts and rebuilds.
version: 1
enabled: true
kind: operational
permissions:
  - install.run
match:
  - install
  - install tool
  - install binary
  - update tool
  - remove tool
  - uninstall
  - list tools
  - list installed
  - check tool
  - is installed
---

# Install Tool

## Purpose
Manage tools available to the agent and other skills. Tools are installed into the workspace and persist across container restarts and image rebuilds. Two install modes are supported:

- **Single-binary** — one executable file, placed directly in `workspace/runtime/bin/`
- **Directory tool** — tool ships with bundled libs or multiple files (e.g. AWS CLI), extracted to `workspace/runtime/tools/<name>/`, with a wrapper script placed in `workspace/runtime/bin/<name>`

Both modes end up on PATH identically. Callers never need to know which mode was used.

## Operations
- **install** — download, extract, place, verify
- **update** — reinstall latest version over existing
- **remove** — delete binary and tool directory if present
- **list** — show all tools currently installed
- **check** — report whether a tool is installed and its version

## When to use
- User asks to install, update, remove, or check a tool or binary
- User asks what tools are available or installed
- Another skill is blocked because a required tool is missing

## Out of scope
- apt, brew, or any system package manager — workspace tools only
- Building from source

## Environment

Detect platform before every download:

```bash
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
esac
```

Resolve workspace directories at runtime — never hardcode paths:

```bash
WORKSPACE_RUNTIME="${WORKSPACE_DIR}/runtime"
WORKSPACE_BIN="${WORKSPACE_RUNTIME}/bin"
WORKSPACE_TOOLS="${WORKSPACE_RUNTIME}/tools"
mkdir -p "$WORKSPACE_BIN" "$WORKSPACE_TOOLS"
```

`WORKSPACE_DIR` is always set in the container environment. `workspace/runtime/bin` is on `PATH` in the agent runtime image.

## Finding the download URL

If the user provides a URL, use it directly.

If the user provides only a name:
1. Check if it is a well-known tool with a predictable release (jq, yq, gh, rclone, ffmpeg, aws, etc.).
2. Construct the URL from the latest release using the detected OS and ARCH.
3. If the URL cannot be determined with confidence, ask the user to provide it before proceeding.

Do not guess URLs. If unsure, ask.

## Detecting install mode

After extracting the archive, determine which mode to use:

- **Single-binary**: the archive contains exactly one executable, or an executable whose name matches `$NAME` with no required sibling files
- **Directory tool**: the archive contains a nested binary that depends on sibling files or directories (e.g. `dist/aws` alongside `dist/*.so`)

When in doubt, attempt single-binary first. If the binary fails `--version` after placement (exit non-zero or missing shared lib error), fall back to directory mode and reinstall.

## Install workflow — single-binary

1. Detect OS and ARCH.
2. Resolve `WORKSPACE_BIN`.
3. Determine download URL.
4. Download:
```bash
TMP="$(mktemp)"
curl -fsSL "$URL" -o "$TMP"
```
5. Extract by format:

**Direct binary:**
```bash
mv "$TMP" "$WORKSPACE_BIN/$NAME"
chmod +x "$WORKSPACE_BIN/$NAME"
```

**`.tar.gz` / `.tar.xz` / `.tar.bz2`:**
```bash
TMPDIR="$(mktemp -d)"
tar -xf "$TMP" -C "$TMPDIR"
BINARY="$(find "$TMPDIR" -type f -name "$NAME" | head -1)"
[ -z "$BINARY" ] && BINARY="$(find "$TMPDIR" -maxdepth 2 -type f -perm /111 | head -1)"
mv "$BINARY" "$WORKSPACE_BIN/$NAME"
chmod +x "$WORKSPACE_BIN/$NAME"
rm -rf "$TMPDIR"
```

**`.zip`:**
```bash
TMPDIR="$(mktemp -d)"
unzip -q "$TMP" -d "$TMPDIR"
BINARY="$(find "$TMPDIR" -type f -name "$NAME" | head -1)"
[ -z "$BINARY" ] && BINARY="$(find "$TMPDIR" -maxdepth 2 -type f -perm /111 | head -1)"
mv "$BINARY" "$WORKSPACE_BIN/$NAME"
chmod +x "$WORKSPACE_BIN/$NAME"
rm -rf "$TMPDIR"
```

6. Cleanup: `rm -f "$TMP"`
7. Verify: `"$WORKSPACE_BIN/$NAME" --version 2>&1 || "$WORKSPACE_BIN/$NAME" version 2>&1`

## Install workflow — directory tool

Use this mode when the tool requires sibling files to run (e.g. AWS CLI v2).

1–4. Same as single-binary (detect, resolve, URL, download).

5. Extract entire archive to `workspace/runtime/tools/<name>/`:
```bash
TOOL_DIR="${WORKSPACE_TOOLS}/$NAME"
rm -rf "$TOOL_DIR"
mkdir -p "$TOOL_DIR"
# tar:
tar -xf "$TMP" -C "$TOOL_DIR" --strip-components=1
# zip:
unzip -q "$TMP" -d "$TOOL_DIR"
```

6. Locate the main executable inside the extracted directory:
```bash
BINARY="$(find "$TOOL_DIR" -type f -name "$NAME" -perm /111 | head -1)"
[ -z "$BINARY" ] && BINARY="$(find "$TOOL_DIR" -maxdepth 3 -type f -perm /111 | head -1)"
```

7. Write a wrapper script to `workspace/runtime/bin/<name>`:
```bash
cat > "$WORKSPACE_BIN/$NAME" << EOF
#!/bin/sh
exec "$BINARY" "\$@"
EOF
chmod +x "$WORKSPACE_BIN/$NAME"
```

8. Cleanup: `rm -f "$TMP"`
9. Verify: `"$WORKSPACE_BIN/$NAME" --version 2>&1 || "$WORKSPACE_BIN/$NAME" version 2>&1`

**AWS CLI example:**
```bash
# URL: https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip
# After unzip: aws/dist/aws (binary), aws/dist/*.so (bundled libs)
# BINARY resolves to: workspace/runtime/tools/aws/dist/aws
# Wrapper calls: exec "workspace/runtime/tools/aws/dist/aws" "$@"
```

## Update workflow

Same as install for the detected mode. For directory tools, remove the old `workspace/runtime/tools/<name>/` before re-extracting. Report old version → new version.

## Remove workflow

```bash
rm -f "$WORKSPACE_BIN/$NAME"
rm -rf "${WORKSPACE_TOOLS}/$NAME"
```

Confirm deletion. If not found, say so.

## List workflow

```bash
ls -1 "$WORKSPACE_BIN"
```

For each entry, run `$NAME --version 2>&1 | head -1` to show version. Mark directory tools with `(dir)` in the list. Skip version check if it takes more than 2 seconds.

## Check workflow

```bash
command -v "$NAME"
"$NAME" --version 2>&1 | head -1
```

Report: installed or not, single-binary or directory tool, version if available.

## Checksum verification (optional)

If the user provides a checksum (SHA256 or SHA512), verify before installing:

```bash
echo "$CHECKSUM  $TMP" | sha256sum -c -
```

Abort and report mismatch if verification fails.

## Binary naming

Strip platform/version suffixes when naming the binary in `workspace/runtime/bin/` (e.g. `gh_2.67.0_linux_amd64` → `gh`). If the user specifies a target name ("save as X"), use that name.

## Output

**Success (minimal):**
> `jq` installed. Version: 1.7.1

**Directory tool install:**
> `aws` installed (directory tool). Version: aws-cli/2.x.x

**Update:**
> `gh` updated. 2.66.1 → 2.67.0

**Remove:**
> `rclone` removed.

**List:**
> Installed tools in workspace/runtime/bin:
> - aws 2.x.x (dir)
> - gh 2.67.0
> - jq 1.7.1
> - rclone v1.68.2

**Check:**
> `aws` is installed (directory tool). Version: aws-cli/2.x.x

**Failure (verbose):**
> Failed to install `wkhtmltopdf`.
> URL tried: https://...
> Error: curl exit 22 — HTTP 404
> Please provide a direct download URL for linux/amd64.

## Checks
- Always detect OS and ARCH before downloading — never assume linux/amd64.
- Never hardcode workspace paths — always resolve from `$WORKSPACE_DIR`.
- Do not use apt, brew, or any system package manager.
- If URL cannot be determined with confidence, ask before downloading anything.
- Clean up all temp files and directories on both success and failure.
- If the tool is already installed and the user did not ask to update, report current version and ask if they want to update.
- For directory tools, always remove the old `workspace/runtime/tools/<name>/` before reinstalling to avoid stale files.

## Cross-skill convention
Other skills that depend on an external tool should check for it at the start of their workflow:

```bash
if ! command -v TOOLNAME &>/dev/null; then
  # inform the user the tool is missing and suggest:
  # "Ask me to install TOOLNAME first."
fi
```

Do not silently fail. Do not attempt to install on behalf of another skill — defer to this skill.
