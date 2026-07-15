# Account Resolution

How to select which Google account to use for a `gog` command.

## Rules

1. **User specifies an account** → use `--account <email>`.
2. **Only one account authorized** → use it implicitly (no `--account` needed).
3. **Multiple accounts, user doesn't specify** → ask which account to use.
4. **Default alias exists** → use it when user says "default" or doesn't specify.

## Checking accounts

```bash
gog auth list --check --json
```

Returns array of authorized accounts with token status. Use this to:
- Determine if any account exists before running commands
- Check token validity (expired? needs re-auth?)
- Identify the default account

## Setting default

```bash
gog auth alias set default user@gmail.com
```

After this, `GOG_ACCOUNT=user@gmail.com` or `gog auth alias set default` makes it implicit.

## Domain auto-map

When multiple OAuth clients exist (e.g., personal vs work), map domains:

```bash
gog --client work auth credentials ~/Downloads/work.json --domain example.com
```

Any `@example.com` account auto-selects the `work` client.
