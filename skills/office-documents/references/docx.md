# Word (.docx)

A `.docx` is a ZIP archive of XML parts. The document body lives in
`word/document.xml`; styles in `word/styles.xml`; numbering in
`word/numbering.xml`.

## Read

```bash
# Clean text/markdown, including tracked changes
pandoc --track-changes=all in.docx -o out.md

# Raw XML for surgical edits
python scripts/ooxml_unpack.py in.docx unpacked/
```

## Create

Use docx-js (npm `docx`). Build a small `.mjs`, run it, then validate. Symlink
the runtime node_modules into your working directory first (see SKILL.md
Toolchain).

```js
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";
import { writeFileSync } from "node:fs";

const doc = new Document({
  sections: [{
    // docx-js defaults to A4 — set US Letter explicitly (DXA: 1 inch = 1440)
    properties: { page: { size: { width: 12240, height: 15840 } } },
    children: [
      new Paragraph({ heading: HeadingLevel.HEADING_1, text: "Title" }),
      new Paragraph({ children: [new TextRun("Body text.")] }),
    ],
  }],
});
Packer.toBuffer(doc).then((b) => writeFileSync("out.docx", b));
```

Rules:
- Use real heading styles (`HeadingLevel.*`) and real numbered/bulleted lists —
  never hand-typed `1.` or `•` prefixes.
- Set page size explicitly; the A4 default surprises US readers.
- Tables: use `Table`/`TableRow`/`TableCell` with explicit widths, not tabs.

## Edit

Unpack, edit the XML, repack — this preserves everything docx-js would drop.

```bash
python scripts/ooxml_unpack.py in.docx unpacked/
# edit unpacked/word/document.xml
python scripts/ooxml_pack.py unpacked/ out.docx
```

Match the existing document's styles; make the smallest change that satisfies
the request.

## Accept tracked changes

Pure XML resolution — no LibreOffice:

```bash
python scripts/accept_tracked_changes.py in.docx out.docx
```

Accepts insertions (`w:ins` unwrapped) and removes deletions (`w:del` /
`w:delText` dropped). Rejecting is the inverse; adapt the script if needed.

## Validate

`ooxml_pack.py` round-trips the archive; if it repacks and `ooxml_unpack.py`
re-reads it, the container is sound. There is no pixel render in this image —
ask the user to open the file and confirm layout.
