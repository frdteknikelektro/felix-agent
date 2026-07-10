# pip packages

Use this branch only when the user names pip/PyPI or supplies a PyPI package specifier. This is for installing a Python-distributed CLI, not for importing a library into ad-hoc scripts. `PYTHONUSERBASE` is already set to `$PYTHON_USER_BASE` in the runtime environment, so a plain `pip install --user` resolves into the workspace automatically — no `--target` or venv bookkeeping needed.

## Install or update

1. Preserve the exact package name and version pin the user gave. Do not invent a version if none was supplied.
2. Install wheels only — this is the pip equivalent of npm's "no build from source" rule:

   ```bash
   pip install --user --only-binary=:all: "$PKG"
   ```

   A failure here (no prebuilt wheel for this platform) means the package is out of scope for this skill. Report that; do not retry without `--only-binary`.
3. Resolve the exported command(s) from installed metadata, not from the package name:

   ```bash
   python3 -c "
import importlib.metadata as m
d = m.distribution('$PKG')
print('\n'.join(sorted({ep.name for ep in d.entry_points if ep.group == 'console_scripts'})))
"
   ```

   Require at least one console-script entry point. If several are exported and the user did not identify one, ask which command they need.
4. Verify:

   ```bash
   command -v "$COMMAND"
   "$COMMAND" --version 2>&1 || "$COMMAND" version 2>&1
   ```
5. Confirm the resolved command points into `workspace/runtime/python/bin`.

For an update, capture the old version first (`python3 -m pip show "$PKG" | grep '^Version:'`), then reinstall with `--upgrade`:

```bash
pip install --user --only-binary=:all: --upgrade "$PKG"
```

Report `old → new`. Do not uninstall before updating: a failed replacement should not deliberately remove the working package.

## Remove

```bash
pip uninstall -y "$PKG"
```

Completion requires the package's dist-info and every console-script it exported under `workspace/runtime/python/bin` to be absent.

## Failure handling

- No prebuilt wheel for this platform/`--only-binary=:all:` fails: report that the package requires building from source and is out of scope.
- No `console_scripts` entry point (library only): report that it is not a CLI tool; this skill does not install bare libraries.
- Index/network/auth failure: preserve the existing installation and report pip's error.
- Probe failure: report the installed package path but mark the CLI unusable; do not call the operation successful.
