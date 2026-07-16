# Customer release contract for 0.1.1

`0.1.1` is the first recommended production Felix Release. It is distributed as `frdinawan/felix-agent:0.1.1`, with Git tag `v0.1.1`; the same release build also publishes the `latest` convenience alias. The supported deployment environment is single-host Docker Compose on `linux/amd64` and `linux/arm64`. Published `v0.1.0` artifacts remain immutable but are superseded.

The Release promises support for every implemented source adapter and harness, plus every skill bundled in the image. Felix's own durable state remains filesystem-based Workspace data; database engines belong to the bundled `database` Skill, not to Felix's internal persistence layer. Workspace data must survive supported upgrades and have documented backup, restore, and rollback procedures.

Publication is the successful multi-architecture Docker build in the `Release`
workflow. Release-time security evidence is intentionally optional; the owner
console is private by default, public access requires customer-managed HTTPS,
Felix-owned telemetry is not collected, and support is best-effort without an
SLA. The source and image are distributed publicly under Apache-2.0.
