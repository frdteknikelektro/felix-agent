#!/usr/bin/env python3
"""Repack a directory of OOXML parts into a valid .docx/.pptx/.xlsx file.

Usage: ooxml_pack.py <input_dir> <output.(docx|pptx|xlsx)>

Writes a deflate-compressed ZIP. `[Content_Types].xml` is stored first when
present, matching how Office writers order the archive; every other part is
added deterministically (sorted) so repacks are reproducible.
"""
import sys
import zipfile
from pathlib import Path


CONTENT_TYPES = "[Content_Types].xml"


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    src, dest = Path(argv[1]), Path(argv[2])
    if not src.is_dir():
        print(f"error: not a directory: {src}", file=sys.stderr)
        return 1
    if not (src / CONTENT_TYPES).is_file():
        print(f"error: {CONTENT_TYPES} missing — not an OOXML part dir: {src}",
              file=sys.stderr)
        return 1

    files = sorted(p for p in src.rglob("*") if p.is_file())
    # Emit [Content_Types].xml first.
    files.sort(key=lambda p: p.relative_to(src).as_posix() != CONTENT_TYPES)

    dest.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in files:
            arcname = path.relative_to(src).as_posix()
            zf.write(path, arcname)
    print(f"packed {src} -> {dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
