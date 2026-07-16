# ADR 0008: Simple release and platform identity snapshots

The original candidate-first release design was replaced because its multiple
workflows and duplicated gates prevented timely delivery. Felix now uses one
`Release` workflow. A manual version input or `v*` tag triggers one
`linux/amd64` Docker build that publishes the version tag and `latest`, followed
by a GitHub Release. Release-time scans, evidence, attestations, acceptance, and
separate promotion are intentionally omitted.

Each source exposes a runtime platform identity snapshot containing the bot ID
or JID, optional username, optional display name, discovery source, and
discovery status. Bot identity is discovered from the authenticated platform or
paired account and is never written into `.env`; human owner authorization is
stored as stable platform IDs or JIDs discovered during setup. Telegram requires
API discovery, while WhatsApp uses its paired JID and `FELIX_NAME` for agent
presentation.
