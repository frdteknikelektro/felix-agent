# PowerPoint (.pptx)

A `.pptx` is a ZIP of XML. Each slide is `ppt/slides/slideN.xml`; layouts and
masters live under `ppt/slideLayouts/` and `ppt/slideMasters/`.

## Read

```bash
# Text extraction
python -m markitdown in.pptx

# Raw XML
python scripts/ooxml_unpack.py in.pptx unpacked/
```

## Create

Use pptxgenjs (npm `pptxgenjs`). Build a `.mjs` and run it. Symlink the runtime
node_modules into your working directory first (see SKILL.md Toolchain).

```js
import pptxgen from "pptxgenjs";
const pptx = new pptxgen();
pptx.defineLayout({ name: "W", width: 13.333, height: 7.5 }); // 16:9
pptx.layout = "W";

const slide = pptx.addSlide();
slide.addText("Slide title", { x: 0.5, y: 0.4, fontSize: 32, bold: true });
slide.addText("Body point", { x: 0.5, y: 1.6, fontSize: 18 });

await pptx.writeFile({ fileName: "out.pptx" });
```

Rules:
- Keep density low: high-value content per slide, generous margins.
- Minimum readable sizes when no template is given — deck title ~44pt, slide
  title ~32pt, body ~18pt.
- Place elements with explicit `x/y/w/h` (inches). Watch for overlap and text
  boxes wider than the slide — there is no automated overlap check here.
- Prefer real images over programmatic vector doodles.

## Edit

Template-based editing preserves brand/layout better than regenerating:

```bash
python scripts/ooxml_unpack.py template.pptx unpacked/
# duplicate/reorder slideN.xml, edit text runs (<a:t> elements)
python scripts/ooxml_pack.py unpacked/ out.pptx
```

## Validate

Round-trip through `ooxml_unpack.py`/`ooxml_pack.py`. No pixel render in this
image — deliver and ask the user to review slides visually for overflow and
overlap.
