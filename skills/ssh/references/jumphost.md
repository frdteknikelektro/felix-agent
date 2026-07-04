# Jump Host

Reach an internal host through a bastion or jump host.

## When to use

- The target host is not directly reachable from this machine.
- The user mentions "bastion", "jump host", "through the proxy", or a multi-hop path.

## SSH ProxyJump (preferred)

```
ssh -o ProxyJump=<user>@<jump-host>:<jump-port> -p <target-port> <user>@<target-host> '<command>'
```

If `~/.ssh/config` defines a `JumpHost` entry, use that alias instead of building the ProxyJump string manually.

## SSH ProxyCommand (legacy fallback)

```
ssh -o ProxyCommand="ssh -W %h:%p -p <jump-port> <user>@<jump-host>" -p <target-port> <user>@<target-host> '<command>'
```

## Constraints

- Confirm the full hop path with the user before connecting.
- Key-based auth is mandatory for jump hosts in non-interactive flows. If the jump host requires a password, the flow stalls — warn the user.
- Test each hop independently if the user reports connection failures at a specific hop.
