# AWS Jala Platform Context

- **Scope** — AWS is the cloud provider used by Jala workloads, including compute, storage, IAM, observability, serverless, managed databases, container services, and billing data.
- **Primary interface** — Use the AWS CLI through the project-level `AWS_JALA_*` secret env contract. Commands should be auditable from the session transcript and must not expose credential values.
- **Credential posture** — Credentials live in environment variables provided by the runtime. Do not place AWS credentials in skill files, references, scripts, examples with real values, or repo-tracked config.
- **Read examples** — Identity checks, resource inventory, policy inspection, logs and metrics reads, Cost Explorer queries, and service diagnostics.
- **Write examples** — Creating or modifying resources, deploying stacks, changing IAM policies, attaching or detaching resources, restoring backups, revoking access, deleting resources, and terminating compute.
- **Fallbacks** — If the AWS CLI is unavailable, install it through the `install-tool` skill. If CLI access fails because of credentials, region, or AWS-side authorization, report the exact blocker without printing secrets.
