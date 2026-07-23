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
LOCAL_PATH=$(felix-workspace-path session-attachment "$FELIX_THREAD_DIR" "<filename>")
scp -P <port> <user>@<host>:<remote-path> "$LOCAL_PATH"
```

## Rsync — directories or multiple files

Sync a directory to the remote:
```
rsync -avz -e "ssh -p <port>" <local-dir>/ <user>@<host>:<remote-dir>/
```

Sync from remote:
```
LOCAL_DIR=$(felix-workspace-path session-work "$FELIX_THREAD_DIR" "<work-name>")
rsync -avz -e "ssh -p <port>" <user>@<host>:<remote-dir>/ "$LOCAL_DIR"/
```

Flags: `-a` archive mode, `-v` verbose, `-z` compress during transfer.

## Constraints

- Confirm both source and destination paths with the user before running.
- Before any remote-to-local transfer, classify the result: use `session-attachment` for a file delivered in this conversation, `session-work` for request-specific directory work, or `file-collection` for a persistent non-software collection. Use exactly the path returned by `felix-workspace-path` and stop if it rejects the destination.
- Use `-v` on SCP for visibility into what was transferred.
- For rsync, always use trailing `/` on the source to control whether the directory itself or its contents are copied.
- If the remote path does not exist, create it first with `mkdir -p` via SSH.
