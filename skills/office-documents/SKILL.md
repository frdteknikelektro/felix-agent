---
name: office-documents
description: >-
  Create, edit, read, and convert Office documents — Word (.docx),
  PowerPoint (.pptx), Excel (.xlsx), and PDF. Use when the user mentions a
  document, report, memo, letter, deck, slides, presentation, spreadsheet,
  workbook, or PDF, or attaches one of these files.
metadata:
  author: felix-agent
  kind: operational
  version: "1.0.0"
  match: document, word, docx, report, memo, letter, excel, xlsx, spreadsheet, workbook, csv, powerpoint, pptx, deck, slides, presentation, pdf
---

# Office Documents

Produce and manipulate `.docx`, `.pptx`, `.xlsx`, and `.pdf` artifacts with
open-source tooling that runs directly in the Felix runtime image.

## Permissions

No permissions required. Producing and editing document artifacts in the session
workspace is this skill's purpose, not a sensitive mutation — files are written
only where the deliverable belongs.

## Toolchain

Every capability below uses tooling already in (or addable to) the runtime — no
proprietary libraries, no cloud services. OOXML files (`.docx`/`.pptx`/`.xlsx`)
are ZIP archives of XML; the reliable edit path is unpack → edit XML → repack.

| Format | Read | Create | Edit |
|--------|------|--------|------|
| docx   | `pandoc` / unpack | `docx` (npm, docx-js) | unpack → XML → pack |
| pptx   | `markitdown` / unpack | `pptxgenjs` (npm) | unpack → XML → pack |
| xlsx   | `openpyxl` | `openpyxl` / `xlsxwriter` | `openpyxl` |
| pdf    | `pdfplumber` / `pypdf` | `reportlab` | `pypdf` |

JS builders (docx-js, pptxgenjs) resolve their package from the runtime's
`/app/node_modules`. Because ESM `import` ignores `NODE_PATH`, symlink it into
the working directory first: `ln -sfn /app/node_modules node_modules`.

Bundled helpers in `scripts/`:

- `ooxml_unpack.py <file> <dir>` — explode an OOXML file into editable XML.
- `ooxml_pack.py <dir> <file>` — repack a directory into a valid OOXML file.
- `accept_tracked_changes.py <in.docx> <out.docx>` — resolve Word tracked
  changes by pure XML edit (no LibreOffice).

## Execution

1. Identify the format and intent (read / create / edit / convert).
   Completion: target file path and one of read|create|edit|convert are fixed.
2. For reads, extract and answer directly.
   Completion: requested content is returned, or the file is reported unreadable.
3. Build the deliverable with the matching tool (see the per-format reference).
   Completion: the target file exists in the session working directory.
4. Validate structurally before delivering.
   Completion: OOXML repacks and reopens without error (`ooxml_unpack.py`
   round-trips), xlsx has zero formula errors, PDF opens and page count is
   correct.
5. Deliver the file and state the QA boundary (see below).
   Completion: reply links the final artifact, includes the visual-QA note, and
   never claims layout was verified.

## Visual QA boundary

This image ships no LibreOffice/soffice engine, so there is **no automated
visual render gate**. Structural validity is checked programmatically; pixel
layout (spacing, overflow, wrapping, slide overlap) is **not**. Always deliver
with a note asking the user to eyeball the result.

## Branch reference

Read the reference for the format in play before building:

- Word → `references/docx.md`
- PowerPoint → `references/pptx.md`
- Excel → `references/xlsx.md`
- PDF → `references/pdf.md`

## Constraints

- Never fake structure: real Word styles/numbering for headings and lists, real
  cell formats for spreadsheets, real placeholders for slides — not hand-typed
  bullets or spaces.
- Keep edits to existing files minimal and local; match the file's existing
  fonts, styles, and conventions rather than restyling wholesale.
- Deliver only the requested artifact. Thumbnails or intermediates are for your
  own inspection unless the user asks for them.
