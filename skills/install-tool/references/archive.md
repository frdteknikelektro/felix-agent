# Binary and directory tools

Use this branch for a direct executable or an official `.tar.gz`, `.tar.xz`, `.tar.bz2`, or `.zip` release.

## Resolve the artifact

If the user supplied a URL, use that exact HTTPS URL. If the user supplied a local file, require a readable regular file and copy it into staging. Otherwise use the publisher's official release metadata, matching the detected OS and architecture. Require an unambiguous artifact; do not construct an unverified URL from memory.

Capture the current version before an update.

## Stage safely

Use one private temporary directory and a cleanup trap:

```bash
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT INT TERM
ARTIFACT="$STAGE/artifact"
if [ -n "${LOCAL_ARTIFACT:-}" ]; then
  cp -- "$LOCAL_ARTIFACT" "$ARTIFACT"
else
  curl --fail --show-error --location --proto '=https' "$URL" --output "$ARTIFACT"
fi
```

When the publisher exposes a checksum or signature, download it from the same official release and verify before extraction. Example:

```bash
printf '%s  %s\n' "$SHA256" "$ARTIFACT" | sha256sum --check -
```

Abort on any verification failure.

## Inspect before extraction

List archive entries first:

```bash
tar -tf "$ARTIFACT" > "$STAGE/entries"   # tar formats
unzip -Z1 "$ARTIFACT" > "$STAGE/entries" # zip
```

Reject entries that are absolute paths or contain a `..` path component. Determine from publisher documentation whether the requested command is:

- a self-contained executable; or
- a directory tool whose executable requires sibling files.

Never fall back to `find ... | head -1`.

## Single executable

Extract into staging, identify the documented executable, and verify it before replacing the installed copy:

```bash
EXTRACTED="$STAGE/extracted"
mkdir -p "$EXTRACTED"
tar -xf "$ARTIFACT" -C "$EXTRACTED" # or: unzip -q "$ARTIFACT" -d "$EXTRACTED"
SOURCE_BIN="$EXTRACTED/<documented/path>"
test -f "$SOURCE_BIN"
chmod +x "$SOURCE_BIN"
"$SOURCE_BIN" --version 2>&1 || "$SOURCE_BIN" version 2>&1
install -m 0755 "$SOURCE_BIN" "$WORKSPACE_BIN/$NAME.new"
mv "$WORKSPACE_BIN/$NAME.new" "$WORKSPACE_BIN/$NAME"
```

For a direct executable, use `$ARTIFACT` as `SOURCE_BIN`.

The `.new` rename keeps replacement atomic. On a failed probe, leave the previous executable untouched.

## Directory tool

Extract under `$STAGE`, verify the documented nested executable with its sibling files present, then move the verified root into the runtime:

```bash
EXTRACTED="$STAGE/extracted"
mkdir -p "$EXTRACTED"
tar -xf "$ARTIFACT" -C "$EXTRACTED" # or: unzip -q "$ARTIFACT" -d "$EXTRACTED"
SOURCE_ROOT="$EXTRACTED/<documented/root>"
NESTED_BIN="$SOURCE_ROOT/<documented/path>"
chmod +x "$NESTED_BIN"
"$NESTED_BIN" --version 2>&1 || "$NESTED_BIN" version 2>&1

NEW_DIR="$WORKSPACE_TOOLS/$NAME.new"
OLD_DIR="$WORKSPACE_TOOLS/$NAME.old"
rm -rf "$NEW_DIR" "$OLD_DIR"
mv "$SOURCE_ROOT" "$NEW_DIR"
```

Create the wrapper in staging with the final path, then swap:

```bash
WRAPPER="$STAGE/$NAME"
printf '%s\n' '#!/bin/sh' \
  "exec \"$WORKSPACE_TOOLS/$NAME/<documented/path>\" \"\$@\"" > "$WRAPPER"
chmod +x "$WRAPPER"

test ! -e "$WORKSPACE_TOOLS/$NAME" || mv "$WORKSPACE_TOOLS/$NAME" "$OLD_DIR"
mv "$NEW_DIR" "$WORKSPACE_TOOLS/$NAME"
install -m 0755 "$WRAPPER" "$WORKSPACE_BIN/$NAME.new"
mv "$WORKSPACE_BIN/$NAME.new" "$WORKSPACE_BIN/$NAME"
"$WORKSPACE_BIN/$NAME" --version 2>&1 || "$WORKSPACE_BIN/$NAME" version 2>&1
rm -rf "$OLD_DIR"
```

If the post-swap probe fails, remove the failed directory and restore `$OLD_DIR` when present before reporting failure.

## Completion

Resolve with `command -v "$NAME"`, require a path below `$WORKSPACE_RUNTIME`, record the new version, and let the cleanup trap remove staging.
