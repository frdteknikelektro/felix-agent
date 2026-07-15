# Customer release contract for 0.1.0

`0.1.0` is the first stable Felix Release. It is distributed as `frdteknikelektro/felix-agent:0.1.0`, with Git tag `v0.1.0`; `latest` is only a convenience alias and production deployments use the versioned tag or an immutable digest. The supported deployment environment is single-host Docker Compose on `linux/amd64` and `linux/arm64`.

The Release promises support for every implemented source adapter and harness, plus every skill bundled in the image. Felix's own durable state remains filesystem-based Workspace data; database engines belong to the bundled `database` Skill, not to Felix's internal persistence layer. Workspace data must survive supported upgrades and have documented backup, restore, and rollback procedures.

Publication is gated by integration, skill, image, lifecycle, documentation, and security evidence. High- or critical-severity vulnerabilities block the Release; a moderate finding may ship only with a time-bounded Security exception. The owner console is private by default, public access requires customer-managed HTTPS, Felix-owned telemetry is not collected, and support is best-effort without an SLA. The source and image are distributed publicly under Apache-2.0.
