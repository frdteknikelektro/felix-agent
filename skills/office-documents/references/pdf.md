# PDF (.pdf)

## Read / extract

```python
import pdfplumber
with pdfplumber.open("in.pdf") as pdf:
    text = "\n".join(page.extract_text() or "" for page in pdf.pages)
    tables = pdf.pages[0].extract_tables()
```

`markitdown` also produces clean markdown from a PDF for summarization.

## Manipulate (merge / split / rotate / forms)

Use `pypdf`:

```python
from pypdf import PdfReader, PdfWriter

# Merge
w = PdfWriter()
for f in ["a.pdf", "b.pdf"]:
    for page in PdfReader(f).pages:
        w.add_page(page)
w.write("merged.pdf")

# Split / rotate / extract pages: slice reader.pages and add selectively
```

Fill AcroForm fields with `writer.update_page_form_field_values(...)`.

## Create

Use `reportlab` for programmatic PDFs:

```python
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

c = canvas.Canvas("out.pdf", pagesize=letter)
c.setFont("Helvetica-Bold", 18)
c.drawString(72, 720, "Title")
c.setFont("Helvetica", 11)
c.drawString(72, 690, "Body text.")
c.showPage()
c.save()
```

For content-heavy PDFs, prefer building the source as `.docx` (docx-js) or HTML
and letting the user export to PDF — reportlab is best for generated reports,
labels, and forms rather than richly laid-out prose.

## Rasterize (for your own inspection)

`poppler-utils` is installed:

```bash
pdftoppm -jpeg -r 150 in.pdf page   # -> page-1.jpg, page-2.jpg, ...
```

Use this to inspect a PDF yourself; still ask the user to confirm the final
layout, since no automated visual gate runs here.

## Validate

Re-open the output with `PdfReader` and confirm `len(reader.pages)` matches the
intended page count and text extracts cleanly.
