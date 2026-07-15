# Security policy

## Supported versions

The current stable release is `0.1.1`. Security fixes are prioritized for the current stable release. `0.1.0` remains immutable and available but is superseded; upgrade before requesting support.

## Reporting a vulnerability

Please do not disclose a suspected vulnerability in a public issue. Use GitHub's private vulnerability reporting for [frdteknikelektro/felix-agent](https://github.com/frdteknikelektro/felix-agent/security/advisories/new). Include:

- affected release or image digest;
- deployment shape and configuration relevant to the issue;
- reproduction steps or a proof of concept;
- impact assessment; and
- any suggested mitigation.

We will acknowledge reports when reviewed and coordinate a fix or mitigation before public disclosure where practical. Do not include real customer credentials, private messages, or Workspace data in a report.

## Deployment security expectations

- Keep the owner console private or behind customer-managed HTTPS.
- Do not expose port `53318` directly to the public internet.
- Use a strong, unique `OWNER_UI_SECRET`.
- Set `OWNER_UI_SECURE_COOKIE=true` when HTTPS terminates at a reverse proxy.
- Configure webhook secrets before exposing Telegram or WhatsApp webhooks.
- Back up the Workspace volume and `DB_ENCRYPTION_KEY` securely.

## Release vulnerability policy

Candidate images retain full vulnerability, secret, and misconfiguration reports. Fixable high/critical findings, reachable high/critical findings, embedded secrets, high/critical image misconfigurations, and CISA KEV findings block publication. A KEV or non-fixable finding may be classified `not_affected` only by an exact package-PURL OpenVEX statement with committed evidence, reviewer, review date, and unexpired review metadata under `security/`. Medium, low, and unknown findings remain visible and are reviewed without automatically blocking unless promoted by KEV or manual review.
