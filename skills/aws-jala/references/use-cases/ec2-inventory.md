# EC2 Inventory

## When to use
Use this recipe when the user asks which EC2 instances exist, which are running, what instance types are used, or needs a compact compute inventory.

## Permission
Required permission: `aws-jala:aws.read`.

## Inputs
Optional:
- Region. Use `AWS_JALA_REGION` or AWS CLI defaults when omitted.
- State filter. Default to all states unless the user asks for running instances only.
- Tag filter, commonly `Name`, `Environment`, or `Project`.

## Workflow
1. Use environment variables and export AWS CLI variables from `AWS_JALA_*`.
2. Confirm identity with `aws sts get-caller-identity`.
3. Run `aws ec2 describe-instances` with the requested filters.
4. Summarize instance id, Name tag, state, type, private IP, public IP, availability zone, launch time, and key security group names.

## Commands
Running instances:

```bash
aws ec2 describe-instances \
  --filters Name=instance-state-name,Values=running \
  --query 'Reservations[].Instances[].{InstanceId:InstanceId,Name:Tags[?Key==`Name`]|[0].Value,State:State.Name,Type:InstanceType,PrivateIp:PrivateIpAddress,PublicIp:PublicIpAddress,AZ:Placement.AvailabilityZone}' \
  --output table
```

All instances:

```bash
aws ec2 describe-instances \
  --query 'Reservations[].Instances[].{InstanceId:InstanceId,Name:Tags[?Key==`Name`]|[0].Value,State:State.Name,Type:InstanceType,LaunchTime:LaunchTime}' \
  --output table
```

## Output
Return a compact table in chat unless the user asks for a file export.

## Failure modes
- Region mismatch or no default region: ask for the target region.
- No instances found: state the filters used.
- Access denied: report the missing EC2 read permission from AWS.
