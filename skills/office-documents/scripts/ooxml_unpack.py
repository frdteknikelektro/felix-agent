#!/usr/bin/env python3
"""Explode an OOXML file (.docx/.pptx/.xlsx) into a directory of XML parts.

Usage: ooxml_unpack.py <input.(docx|pptx|xlsx)> <output_dir>

OOXML files are plain ZIP archives. This extracts every part so the XML can be
edited by hand, then repacked with ooxml_pack.py.
"""
import sys
import zipfile
from pathlib import Path


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    src, dest = Path(argv[1]), Path(argv[2])
    if not src.is_file():
        print(f"error: not a file: {src}", file=sys.stderr)
        return 1
    if not zipfile.is_zipfile(src):
        print(f"error: not a valid OOXML/ZIP archive: {src}", file=sys.stderr)
        return 1
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(src) as zf:
        # Guard against path traversal in crafted archives.
        for name in zf.namelist():
            target = (dest / name).resolve()
            if not str(target).startswith(str(dest.resolve())):
                print(f"error: unsafe path in archive: {name}", file=sys.stderr)
                return 1
        zf.extractall(dest)
    print(f"unpacked {src} -> {dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
