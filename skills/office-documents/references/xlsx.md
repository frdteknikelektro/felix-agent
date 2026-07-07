# Excel (.xlsx)

Fully covered by libraries already in the image: `openpyxl` (read + write +
edit, preserves formatting) and `xlsxwriter` (fast write-only with rich
formatting). Default to `openpyxl` for anything that edits an existing file.

## Read / analyze

```python
import openpyxl
wb = openpyxl.load_workbook("in.xlsx", data_only=False)  # keep formulas
ws = wb.active
for row in ws.iter_rows(values_only=True):
    ...
```

Use `data_only=True` to read the last-cached computed values. Note: values are
only present if the file was last saved by an app that computed them — this
image does not recalculate on load (see below).

## Create / edit

```python
import openpyxl
from openpyxl.styles import Font, numbers

wb = openpyxl.Workbook()
ws = wb.active
ws["A1"] = "Revenue ($mm)"
ws["A2"] = 1234.5
ws["A2"].number_format = "#,##0"
ws["A3"] = "=A2*1.1"          # real formula, not a hardcoded result
wb.save("out.xlsx")
```

Rules:
- **Zero formula errors** in the delivered file — no `#REF!`, `#DIV/0!`,
  `#VALUE!`, `#N/A`, `#NAME?`. Check every formula's references resolve.
- Keep calculations as live formulas, not baked-in numbers, so the user can
  audit and change them.
- Number formats: currency `#,##0` with units in the header; percentages
  `0.0%`; years as text (`"2024"`, not `2,024`); negatives in parentheses.
- Editing an existing workbook: match its existing fonts, colors, and number
  formats; extend conditional formatting to new rows/columns; don't restyle the
  whole sheet.
- Financial-model convention (unless the file says otherwise): blue = hardcoded
  input, black = formula, green = link to another sheet.

## Recalculation

openpyxl writes formula strings but does not compute them. Excel/Sheets will
recalc on open, so a normal deliverable is fine. If the user needs computed
values written into the file without opening it, add the pure-Python `formulas`
library via `install-tool` — it recalculates most common functions (no
LibreOffice needed). Full-fidelity recalc of exotic functions still needs a real
spreadsheet engine.

## Validate

Re-open with `openpyxl.load_workbook` after writing; confirm sheet names, cell
values, and that no formula string references a missing cell/range.
