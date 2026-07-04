# File Transfer

Use SCP or rsync to move files to/from the remote host. This branch requires the `ssh.transfer` permission declared in the skill frontmatter.

## When to use

- User wants to copy a file to the server (upload).
- User wants to copy a file from the server (download).
- User says "upload", "copy to", "transfer", "sync".

## Binary check

- SCP ships with `openssh-client` — available wherever `ssh` is.
- Run `command -v rsync` before rsync operations. If missing, fall back to SCP for single files or tell the user rsync is not installed.

## SCP — single file

Upload:
```
scp -P <port> <local-path> <user>@<host>:<remote-path>
```

Download:
```
scp -P <port> <user>@<host>:<remote-path> <local-path>
```

## Rsync — directories or multiple files

Sync a directory to the remote:
```
rsync -avz -e "ssh -p <port>" <local-dir>/ <user>@<host>:<remote-dir>/
```

Sync from remote:
```
rsync -avz -e "ssh -p <port>" <user>@<host>:<remote-dir>/ <local-dir>/
```

Flags: `-a` archive mode, `-v` verbose, `-z` compress during transfer.

## Constraints

- Confirm both source and destination paths with the user before running.
- Use `-v` on SCP for visibility into what was transferred.
- For rsync, always use trailing `/` on the source to control whether the directory itself or its contents are copied.
- If the remote path does not exist, create it first with `mkdir -p` via SSH.
