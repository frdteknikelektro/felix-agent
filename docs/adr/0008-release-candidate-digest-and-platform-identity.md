# ADR 0008: Release candidate digests and platform identity snapshots

Felix builds a multi-architecture candidate image under an immutable
`candidate-<commit-sha>` tag, scans its exact registry digest, and creates the
customer-facing `0.1.1` tag only after scan policy, attestations, and manual
acceptance pass. Manual `latest` promotion accepts only a digest that matches
the verified `0.1.1` manifest. The `v0.1.0` source tag and image are never moved.
Completed manual evidence is supplied separately from the immutable candidate
commit and must repeat its run ID, commit, version, and digest exactly.
Publication is serialized per version. Before creating or resuming a release,
the publish workflow recomputes scan policy from the candidate's sanitized
report, verifies the multi-architecture manifest and platform digests, verifies
the index provenance and both platform SBOM attestations against the candidate
commit, and compares the attested SBOM predicates with the uploaded SPDX files.
Existing source or image tags may be resumed only when they already resolve to
the accepted commit and digest. Existing GitHub Release assets may be resumed
only when every existing byte matches the candidate evidence; missing assets
are added without replacing any existing asset. The generated evidence
manifest records the SHA-256 digest of every candidate and manual evidence
asset present before the manifest itself is generated.

Each source exposes a runtime platform identity snapshot containing the bot ID
or JID, optional username, optional display name, discovery source, and
discovery status. Bot identity is discovered from the authenticated platform or
paired account and is never written into `.env`; human owner IDs remain
customer-configured. Telegram requires API discovery, while WhatsApp uses its
paired JID and keeps display naming as an explicit override or `FELIX_NAME`
fallback.
