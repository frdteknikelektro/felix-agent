---
id: ssh
name: SSH
description: Connect to a remote host over SSH and execute commands. Use when the user says "ssh", "remote", or "deploy" to a server.
version: 1
enabled: true
kind: operational
permissions:
  - ssh.execute
  - ssh.transfer
match:
  - ssh
  - remote
  - deploy to server
  - connect to server
  - log into server
---

# SSH

Connect to a remote host and execute commands. Requires the host address and a way to authenticate (key or password).

## Branch reference

- **Transfer files** — when the user wants to copy files to/from the remote: read `references/transfer.md`.
- **Jump host** — when the user needs to reach a host through a bastion: read `references/jumphost.md`.

## Execution

1. Verify the `ssh` binary is available.
   - Run: `command -v ssh`
   - If missing, tell the user the runtime image needs `openssh-client` and stop.
   Completion: `ssh` is on PATH, or the user has been told why it's unavailable.

2. Resolve the target host.
   - Confirm the hostname or IP address with the user if not stated explicitly.
   - Confirm the SSH port (default 22) and username (default: current user) if not stated.
   - If the user provided a host alias from `~/.ssh/config`, use its resolved values.
   Completion: host, port, and username are known and confirmed or defaulted.

3. Check SSH key availability.
   - Run `ssh-add -l` to list loaded keys. If no keys are loaded or none target this host, check `~/.ssh/` for a key pair.
   - If no key exists and the user expects key-based auth, warn and offer to generate one.
   - If key-based auth is not available, fall through to password auth (the user will be prompted by the SSH process).
   Completion: authentication method is determined — key, password, or agent forwarding.

4. Test connectivity.
   - Run: `ssh -o ConnectTimeout=10 -o BatchMode=yes -p <port> <user>@<host> echo "felix-ssh-ok"`
   - If the command returns `felix-ssh-ok`, the connection is live and authenticated.
   - If it fails with "Host key verification failed" or "known_hosts", the host is new — ask the user if they trust it, then run `ssh-keyscan -p <port> <host> >> ~/.ssh/known_hosts` and retry.
   - For any other failure, read `references/troubleshooting.md` and report the cause.
   Completion: a round-trip command succeeds on the target host.

5. Execute the requested command.
   - Build the full SSH command: `ssh -o ConnectTimeout=10 -p <port> <user>@<host> '<command>'`
   - Run it and capture stdout and stderr separately.
   - Return stdout to the user. Include stderr only if it contains warnings or errors.
   - If the exit code is non-zero, report the exit code, stderr, and a short interpretation.
   Completion: the remote command has finished, its exit code and output are captured and reported to the user.

6. Confirm side effects.
   - If the command modified state on the remote (deployed, deleted, restarted, installed), state what changed.
   - If the command was destructive or irreversible, suggest a verification step the user can run to confirm the result.
   - If the command was read-only (ls, cat, grep, status checks), skip this step.
   Completion: the user knows what changed on the remote, or has a follow-up command to verify the result.

## Constraints

- Never hardcode passwords or private key paths in skill files. Prompt or use agent forwarding.
- Default to key-based auth. Password auth is a fallback, not the primary path.
- Use `BatchMode=yes` for connectivity tests so a missing key fails fast instead of hanging on an interactive prompt.
- Set `ConnectTimeout=10` on every SSH invocation to prevent indefinite hangs.
- Distinguish between connection failures (network, host down) and auth failures (key mismatch, permission denied) in error reports.
- Do not parse or transform command output unless the user explicitly asks for formatting.
- If the command contains single quotes, switch to double-quote wrapping or escape them to avoid breaking the SSH shell string.
- If a command runs longer than 60 seconds, warn the user it may still be running on the remote host.
