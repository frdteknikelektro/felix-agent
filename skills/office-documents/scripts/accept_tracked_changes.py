#!/usr/bin/env python3
"""Accept all tracked changes in a .docx by editing OOXML directly.

Usage: accept_tracked_changes.py <input.docx> <output.docx>

No LibreOffice required. Applies the standard "accept all revisions" transform
to word/document.xml and every header/footer part:

  - <w:ins>        insertions   -> unwrapped (content kept)
  - <w:del>        deletions    -> removed entirely
  - <w:moveTo>     move target  -> unwrapped (content kept)
  - <w:moveFrom>   move source  -> removed entirely
  - <w:*Change>    format-change records (rPrChange, pPrChange, tblPrChange,
                   tcPrChange, trPrChange, sectPrChange) -> removed

Requires lxml (pip install lxml).
"""
import sys
import zipfile
from pathlib import Path

try:
    from lxml import etree
except ImportError:  # pragma: no cover
    print("error: lxml is required (pip install lxml)", file=sys.stderr)
    raise SystemExit(1)

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

# Elements whose *content is kept* but the wrapper is dropped.
UNWRAP = {f"{{{W}}}ins", f"{{{W}}}moveTo"}
# Elements removed whole (wrapper + content).
DROP = {f"{{{W}}}del", f"{{{W}}}moveFrom"}
# Change-tracking records removed whole.
CHANGE_SUFFIX = "Change"


def _unwrap(el) -> None:
    parent = el.getparent()
    if parent is None:
        return
    idx = parent.index(el)
    for child in reversed(list(el)):
        parent.insert(idx, child)
    # Preserve tail text.
    if el.tail:
        prev = el.getprevious()
        if prev is not None:
            prev.tail = (prev.tail or "") + el.tail
        else:
            parent.text = (parent.text or "") + el.tail
    parent.remove(el)


def transform(xml: bytes) -> bytes:
    root = etree.fromstring(xml)
    # Iterate over a static list because we mutate the tree.
    for el in list(root.iter()):
        tag = el.tag
        if not isinstance(tag, str) or not tag.startswith(f"{{{W}}}"):
            continue
        local = tag.split("}", 1)[1]
        if tag in DROP or (tag in {f"{{{W}}}moveFromRangeStart",
                                   f"{{{W}}}moveFromRangeEnd"}):
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)
        elif tag in UNWRAP:
            _unwrap(el)
        elif local.endswith(CHANGE_SUFFIX):
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8",
                          standalone=True)


def _is_target(name: str) -> bool:
    return (name == "word/document.xml"
            or name.startswith("word/header")
            or name.startswith("word/footer")) and name.endswith(".xml")


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    src, dest = Path(argv[1]), Path(argv[2])
    if not zipfile.is_zipfile(src):
        print(f"error: not a valid .docx: {src}", file=sys.stderr)
        return 1
    dest.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(src) as zin, \
            zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.namelist():
            data = zin.read(item)
            if _is_target(item):
                data = transform(data)
            zout.writestr(item, data)
    print(f"accepted tracked changes: {src} -> {dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
