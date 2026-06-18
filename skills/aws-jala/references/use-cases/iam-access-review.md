# IAM Access Review

## When to use
Use this recipe when the user asks to inspect IAM users, access keys, attached policies, broad permissions, inactive keys, or access risk.

## Permission
Required permission: `aws-jala:aws.read`.

Use `aws-jala:aws.write` only if the user explicitly asks to change IAM state, such as deactivating a key, detaching a policy, deleting a user, or revoking access.

## Inputs
Optional:
- Target user, role, group, or policy name.
- Review focus: access keys, attached policies, administrator access, inactive credentials, or all IAM users.

## Workflow
1. Use environment variables and export AWS CLI variables from `AWS_JALA_*`.
2. Confirm identity with `aws sts get-caller-identity`.
3. For account-wide review, list users and collect access key metadata.
4. For a principal-specific review, inspect attached managed policies and inline policies.
5. Report findings as confirmed facts and separate any risk interpretation.

## Commands
List users:

```bash
aws iam list-users --output table
```

List access keys for a user:

```bash
aws iam list-access-keys --user-name <user-name> --output table
```

List attached user policies:

```bash
aws iam list-attached-user-policies --user-name <user-name> --output table
```

List inline user policies:

```bash
aws iam list-user-policies --user-name <user-name> --output table
```

## Output
For read-only reviews, return:
- reviewed scope
- users or principals inspected
- active access keys and age when available
- attached policies
- inline policies
- risk notes, clearly marked as interpretation

## Failure modes
- Access denied: report the IAM read permission blocker.
- Large account: summarize first and ask before expanding every principal.
- Write request without explicit target: ask for the exact principal and action.
