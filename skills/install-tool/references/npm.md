# npm packages

Use this branch only when the user names npm or supplies an npm package specifier. A suffix such as `gh@2.67.0` is not proof that the tool is an npm package; plain install requests use the archive branch unless npm is explicit.

## Install or update

1. Preserve scoped package syntax. Append `@latest` only when no version or dist-tag was supplied.
2. Inspect package metadata before mutation:

   ```bash
   npm view "$PKG" name version bin --json
   ```

   Require a nonempty `bin` mapping. If several binaries are exported and the user did not identify one, ask which command they need.
3. Install into the persistent prefix:

   ```bash
   npm install "$PKG" --prefix "$NPM_PREFIX" --no-save
   ```

4. Resolve the command from the metadata's `bin` key, not from the package name. Verify:

   ```bash
   command -v "$COMMAND"
   "$COMMAND" --version 2>&1 || "$COMMAND" version 2>&1
   ```

5. Confirm the resolved command points into `workspace/runtime/npm/bin`.

For an update, capture the old version first and report `old → new`. Do not uninstall before updating: a failed replacement should not deliberately remove the working package.

## Remove

Resolve the installed package name from `$NPM_PREFIX/lib/node_modules` or npm metadata, then run:

```bash
npm uninstall "$PACKAGE_NAME" --prefix "$NPM_PREFIX"
```

Completion requires both the package directory and its exported bin links to be absent.

## Failure handling

- Missing package or `bin`: report that it is not an npm CLI.
- Registry/auth/network failure: preserve the existing installation and report npm's error.
- Probe failure: report the installed package path but mark the CLI unusable; do not call the operation successful.
