# Runtime dependency inventory

The base image is pinned by multi-architecture digest. Debian packages are limited to TLS/networking, Git/SSH and transfer tools, process init, Python/pip, and the document/media utilities required by bundled skills. `python3-venv` was removed because Felix installs optional user packages under `workspace/runtime/python` rather than creating venvs.

The bundled Python office/data stack is declared in `requirements-runtime.in`; its full transitive graph is version- and hash-locked in `requirements-runtime.txt` and installed binary-only. wacli and gog are rebuilt from pinned, checksummed sources with a supported, digest-pinned Go toolchain. Downloaded whisper.cpp and Piper archives are versioned and SHA-256 verified for both supported architectures. The runtime npm CLI is explicitly upgraded to a fixed pinned version. Candidate CI smoke-tests the resulting commands and scans the exact multi-architecture digest.

Review the base digest, Go-derived binaries, Debian packages, and Python lock at least monthly and for every security advisory affecting a shipped component. Every change must pass dependency audits, both architecture builds, runtime smoke tests, SBOM generation, and the release risk gate.
