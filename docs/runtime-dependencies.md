# Runtime dependency inventory

The Node Trixie base image is pinned by multi-architecture digest. Debian packages are limited to TLS/networking, Git/SSH and transfer tools, process init, Python/pip/venv, and the document/media utilities required by bundled skills. Trixie's Python 3.13 runtime matches the version used to resolve the hash-locked Python dependency graph. Felix installs shared optional packages under `workspace/runtime/python`; `python3-venv` remains available for isolated skill and project environments as promised by the runtime contract.

The bundled Python office/data stack is declared in `requirements-runtime.in`; its full transitive graph is version- and hash-locked in `requirements-runtime.txt` and installed binary-only. wacli and gog are rebuilt from pinned, checksummed sources with a supported, digest-pinned Go toolchain. Downloaded whisper.cpp and Piper archives are versioned and SHA-256 verified for both supported architectures. The runtime npm CLI is explicitly upgraded to a fixed pinned version. The release workflow builds the resulting runtime for `linux/amd64`.

Review the base digest, Go-derived binaries, Debian packages, and Python lock at
least monthly and for every security advisory affecting a shipped component.
These reviews are intentionally separate from the fast release publication
path.
