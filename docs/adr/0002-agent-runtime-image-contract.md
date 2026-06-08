# Agent Runtime Image Contract

## Status

Accepted.

## Context

Felix is gaining more operational and reporting skills. Those skills increasingly need predictable local tooling for Node execution, Python execution, data analysis, chart generation, file artifacts, shell utilities, and project editing.

The current image was intentionally small: `node:24-bookworm-slim` plus a few runtime packages. That made the image compact, but it forced skills to probe for common tooling or install basic packages during a session. The project also already reserves `workspace/runtime/` for runtime support, and the Docker `PATH` points at `workspace/runtime/bin`.

## Decision

Use `node:24-bookworm-slim` as the Agent runtime image base and add provider-neutral runtime batteries during image build.

The stable runtime capabilities are:

- Node execution.
- Python execution, including `pip` and `venv` support.
- Core data stack for common reporting and chart generation.
- Basic image and PDF utility work.
- Shell, network, archive, and compression utilities.
- Git/project editing basics.
- Shared runtime tooling through `workspace/runtime/bin`, `workspace/runtime/tools`, and `workspace/runtime/python`.

Runtime packages are implementation detail. The initial package set includes Python, build tools, Git, jq, zip/unzip, Poppler utilities, Ghostscript, ImageMagick, and a pip-installed Core data stack including NumPy, pandas, matplotlib, seaborn, Pillow, requests, openpyxl, xlsxwriter, and python-dateutil.

Provider-specific operational CLIs are excluded from the Agent runtime image. Examples include AWS CLI, gcloud, kubectl, and Terraform. Skills that need those tools use the install-tool workflow or another explicit setup path.

LibreOffice and browser automation runtimes are excluded from v1. LibreOffice is large relative to current needs, and browser binaries add size and system dependency complexity before bundled skills require in-container browser execution.

## Consequences

Skill execution becomes more predictable because common reporting and artifact tooling exists before a harness turn starts.

The Docker image becomes larger, but the added size is bounded to provider-neutral capabilities that multiple skills can reuse.

Future package additions should be justified against Runtime capability categories. A new package can change without redefining the capability, but a new capability or a previously excluded heavy runtime should be treated as a new architectural decision.

Shared runtime tooling remains under `workspace/runtime/`, so owner-installed tools can persist across container restarts and rebuilds without editing bundled skills or session records.
