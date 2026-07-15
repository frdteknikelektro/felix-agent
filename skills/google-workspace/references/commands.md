# Google Workspace Commands

Quick reference mapping user intents to `gog` commands. For full details, run `gog schema --json` or `gog <command> --help`.

## Gmail

| Intent | Command |
|---|---|
| Search email | `gog gmail search '<query>' --json` |
| Read email | `gog gmail get <messageId> --json` |
| Send email | `gog gmail send --to <email> --subject <subj> --body <body> --json` |
| Reply to email | `gog gmail reply <messageId> --body <body> --json` |
| Forward email | `gog gmail forward <messageId> --to <email> --json` |
| List labels | `gog gmail labels list --json` |
| Create label | `gog gmail labels create <name> --json` |
| Trash email | `gog gmail trash <messageId> --json` |
| Archive email | `gog gmail archive <messageId> --json` |
| Mark read | `gog gmail mark-read <messageId> --json` |
| List drafts | `gog gmail drafts list --json` |
| Create draft | `gog gmail drafts create --to <email> --subject <subj> --body <body> --json` |
| List threads | `gog gmail search '<query>' --json` |
| Get thread | `gog gmail thread get <threadId> --json` |
| List attachments | `gog gmail thread attachments <threadId> --json` |
| Download attachment | `gog gmail attachment <messageId> <attachmentId> --out <path> --json` |

## Calendar

| Intent | Command |
|---|---|
| List today's events | `gog calendar events --today --json` |
| List events (range) | `gog calendar events --from <date> --to <date> --json` |
| Create event | `gog calendar create --summary <title> --from <datetime> --to <datetime> --json` |
| Update event | `gog calendar update <eventId> --summary <title> --json` |
| Delete event | `gog calendar delete <eventId> --json` |
| Search events | `gog calendar search '<query>' --json` |
| List calendars | `gog calendar calendars --json` |
| Respond to invite | `gog calendar respond <eventId> --status accepted --json` |
| Free/busy | `gog calendar freebusy --from <datetime> --to <datetime> --json` |
| Create focus time | `gog calendar focus-time --from <datetime> --to <datetime> --json` |

## Drive

| Intent | Command |
|---|---|
| List files | `gog drive ls --json` |
| Search files | `gog drive search '<query>' --json` |
| Get file info | `gog drive get <fileId> --json` |
| Download file | `gog drive download <fileId> --out <path> --json` |
| Upload file | `gog drive upload <localPath> --parent <folderId> --json` |
| Create folder | `gog drive mkdir <name> --parent <folderId> --json` |
| Move file | `gog drive move <fileId> --parent <folderId> --json` |
| Rename file | `gog drive rename <fileId> <newName> --json` |
| Delete file | `gog drive delete <fileId> --json` |
| Copy file | `gog drive copy <fileId> --json` |
| Share file | `gog drive share <fileId> --role reader --type user --email <email> --json` |
| List permissions | `gog drive permissions <fileId> --json` |
| Folder tree | `gog drive tree --parent <folderId> --depth 2 --json` |
| Folder size | `gog drive du --parent <folderId> --json` |

## Docs

| Intent | Command |
|---|---|
| Read doc | `gog docs cat <docId> --json` |
| Create doc | `gog docs create <title> --json` |
| Write to doc | `gog docs write <docId> --content <text> --json` |
| Format text | `gog docs format <docId> --match <text> --bold --json` |
| Find and replace | `gog docs find-replace <docId> --find <old> --replace <new> --json` |
| Export doc | `gog docs export <docId> --format pdf --out <path> --json` |
| Insert table | `gog docs insert-table <docId> --rows 3 --cols 2 --json` |
| List tabs | `gog docs list-tabs <docId> --json` |
| Get structure | `gog docs structure <docId> --json` |

## Sheets

| Intent | Command |
|---|---|
| Read range | `gog sheets get <spreadsheetId> 'Sheet1!A1:D20' --json` |
| Append row | `gog sheets table append <spreadsheetId> <tableName> '<col1>|<col2>' --json` |
| Create spreadsheet | `gog sheets create <title> --json` |
| Batch update | `gog sheets batch-update <spreadsheetId> --json` |

## Slides

| Intent | Command |
|---|---|
| Create from markdown | `gog slides create-from-markdown <title> --content-file <path> --json` |
| Get presentation | `gog slides get <presentationId> --json` |
| Replace text | `gog slides replace-text <presentationId> --find <old> --replace <new> --json` |

## Contacts

| Intent | Command |
|---|---|
| List contacts | `gog contacts list --json` |
| Search contacts | `gog contacts search '<query>' --json` |
| Create contact | `gog contacts create --first <first> --last <last> --email <email> --json` |
| Update contact | `gog contacts update <resourceName> --json` |
| Delete contact | `gog contacts delete <resourceName> --json` |
| Dedupe contacts | `gog contacts dedupe --json` (preview) / `gog contacts dedupe --apply --json` |

## Tasks

| Intent | Command |
|---|---|
| List task lists | `gog tasks lists --json` |
| List tasks | `gog tasks list <taskListId> --json` |
| Create task | `gog tasks create <taskListId> --title <title> --json` |
| Update task | `gog tasks update <taskListId> <taskId> --title <title> --json` |
| Delete task | `gog tasks delete <taskListId> <taskId> --json` |
| Complete task | `gog tasks complete <taskListId> <taskId> --json` |

## Admin (Workspace only, requires domain-wide delegation)

| Intent | Command |
|---|---|
| List users | `gog --account admin@example.com admin users list --json` |
| Create user | `gog --account admin@example.com admin users create user@example.com --first-name First --last-name Last --change-password --json` |
| Get user | `gog --account admin@example.com admin users get user@example.com --json` |
| Suspend user | `gog --account admin@example.com admin users suspend user@example.com --json` |
| Delete user | `gog --account admin@example.com admin users delete user@example.com --json` |
| List org units | `gog --account admin@example.com admin orgunits list --type all --json` |
| Create org unit | `gog --account admin@example.com admin orgunits create --name <name> --parent / --json` |

## Chat

| Intent | Command |
|---|---|
| List spaces | `gog chat spaces list --json` |
| Send message | `gog chat messages send <spaceId> --text <message> --json` |
| List messages | `gog chat messages list <spaceId> --json` |

## Groups (Workspace only)

| Intent | Command |
|---|---|
| List groups | `gog --account admin@example.com groups list --json` |
| List members | `gog --account admin@example.com groups members <groupEmail> --json` |

## YouTube

| Intent | Command |
|---|---|
| Search videos | `gog youtube search '<query>' --json` |
| List playlists | `gog youtube playlists list --json` |
| Get video | `gog youtube videos get <videoId> --json` |

## Forms

| Intent | Command |
|---|---|
| Create form | `gog forms create <title> --json` |
| Get form | `gog forms get <formId> --json` |
| Add question | `gog forms questions add <formId> --type text --question <text> --json` |
| List responses | `gog forms responses list <formId> --json` |

## Maps

| Intent | Command |
|---|---|
| Geocode | `gog maps geocode '<address>' --json` |
| Directions | `gog maps directions '<origin>' '<destination>' --json` |
| Search places | `gog maps places search '<query>' --json` |

## Meet

| Intent | Command |
|---|---|
| Create meeting | `gog meet create --json` |
| Get meeting | `gog meet get <spaceId> --json` |
| End meeting | `gog meet end <spaceId> --json` |

## Keep (Workspace only)

| Intent | Command |
|---|---|
| List notes | `gog keep list --json` |
| Create note | `gog keep create --title <title> --body <body> --json` |
| Search notes | `gog keep search '<query>' --json` |

## Classroom

| Intent | Command |
|---|---|
| List courses | `gog classroom courses list --json` |
| Get course | `gog classroom courses get <courseId> --json` |
| List coursework | `gog classroom coursework list <courseId> --json` |

## Photos

| Intent | Command |
|---|---|
| List photos | `gog photos list --json` |
| Get photo | `gog photos get <mediaItemId> --json` |
| Download photo | `gog photos download <mediaItemId> --out <path> --json` |
