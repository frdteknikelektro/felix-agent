# ADR 0010: Current Debian runtime base

## Status

Accepted for Felix 0.1.1.

## Context

The first `0.1.1` candidate used digest-pinned Node and Go images based on
Debian Bookworm. Its exact multi-architecture image passed runtime smoke tests
but the release risk gate found unresolved high and critical Debian findings
with no reviewed OpenVEX exception. The Python dependency lock was also
resolved for Python 3.13 while Bookworm supplied Python 3.11.

## Decision

Felix uses digest-pinned `node:24-trixie-slim` and
`golang:1.26.5-trixie` images for the `0.1.1` release. Debian packages remain
limited to the documented runtime capability inventory. Security findings may
still be reviewed during maintenance, but they do not block publication.

The release image targets `linux/amd64`; other platform builds are an optional
maintenance concern rather than a release gate.

## Consequences

The runtime and locked Python graph now share Python 3.13. The simplified
release workflow builds only `linux/amd64` and does not require release-time
scans, SBOMs, attestations, or candidate evidence. Security review remains an
optional maintenance activity outside publication.
