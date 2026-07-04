# Troubleshooting

Diagnose and report SSH connection failures.

## Error: Connection refused

The host is reachable but no SSH daemon is listening on the expected port.
- Verify the port number with the user.
- Suggest checking the remote host: `systemctl status sshd` or `ss -tlnp | grep :22`.

## Error: Connection timed out

The host did not respond within the timeout window.
- Check if the host is online: `ping -c 3 <host>` or `nc -zv <host> <port>`.
- Check firewall rules — the remote host or an intermediate firewall may be blocking the port.
- Suggest running `ssh -vvv <user>@<host>` locally for verbose connection diagnostics, or a traceroute to map the network path.

## Error: Permission denied (publickey)

The server rejected the offered key.
- Verify the key is loaded: `ssh-add -l`.
- Verify the key is in `~/.ssh/authorized_keys` on the remote.
- Check file permissions: `~/.ssh/` should be 700, `authorized_keys` should be 600.
- Suggest the user test with `ssh -vvv <user>@<host>` to see which keys are offered.

## Error: Host key verification failed

The remote host key does not match what is stored locally.
- This can be legitimate (host reinstalled) or a warning (MITM).
- If the user trusts the host, suggest: `ssh-keygen -R <host>` then reconnect.
- If the host is unknown, confirm with the user before adding it.

## Error: No route to host

The network cannot reach the host at all.
- Check local routing: `ip route` or `route -n`.
- Check if a VPN is needed.
- Verify the IP address or DNS resolution.

## Generic: exit code non-zero

The command ran but returned an error.
- Report the exit code, stdout, and stderr.
- Suggest common causes based on the command (e.g., missing binary, permission issue on a file).
- If the command was destructive, ask the user if they want to undo or inspect the result.
