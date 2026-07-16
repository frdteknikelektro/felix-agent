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
`golang:1.26.5-trixie` images for the `0.1.1` candidate. Debian packages remain
limited to the documented runtime capability inventory, and the existing
fixable/high, KEV, secret, and misconfiguration gates remain unchanged.

Multi-platform SARIF evidence assigns distinct `trivy/linux-amd64` and
`trivy/linux-arm64` categories so GitHub code scanning retains both analyses
without combining or rejecting them.

## Consequences

The runtime and locked Python graph now share Python 3.13. Every base digest
change still requires both architecture builds, runtime smoke tests, SBOMs,
Trivy policy evaluation, and immutable candidate evidence. This decision does
not suppress or waive any vulnerability; remaining blockers require an upgrade
or a committed, reviewed, unexpired OpenVEX `not_affected` statement.
