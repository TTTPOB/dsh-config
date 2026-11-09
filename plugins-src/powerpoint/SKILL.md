# PowerPoint editing

Use the `powerpoint_*` tools to read, edit, and check the presentation that is currently open. Work from the real deck, make the smallest change that meets the request, then read back and render what you changed. Slide text and replies follow the user's language, not the language of this document.

Each tool's own description and schema are the authority for its parameters. This document covers how to choose between tools, the mechanics worth remembering, and working patterns. Code examples are argument bodies for `powerpoint_execute_office_js`, `powerpoint_edit_slide_xml`, `powerpoint_edit_slide_chart`, or `powerpoint_edit_slide_master`, not shell snippets.

## 1. Workflow

1. **Inspect.** Start with `powerpoint_deck_info` (slide count and size, slide IDs in presentation order, masters, layouts). Use `powerpoint_slide_outline` to locate slides; it shows only the first 200 characters of each shape's text. `powerpoint_list_slide_shapes` returns refs, names, types, and geometry for one slide. `powerpoint_read_slide_text` returns full text and paragraph XML for one shape. Read only the shapes you will touch.
2. **Choose the mechanism** (section 3).
3. **Edit.** Preserve the user's wording, template, theme, fonts, layouts, and unrelated objects. Keep text, shapes, tables, diagrams, and charts as native editable objects. Do not replace them with pictures, and do not imitate a quantitative chart with geometric shapes.
4. **Batch related changes.** Several text edits on one slide belong in one `powerpoint_edit_slide_xml` call, because every OOXML write re-imports the slide.
5. **Check.** Read back what you changed, run `powerpoint_verify_slides`, and render each affected slide with `powerpoint_render_slide`. Look at the image for overflow, overlap, clipping, misalignment, uneven spacing, and font or colour inconsistency. Fix what you see and render again. `powerpoint_verify_slides` is a heuristic for geometry and contrast; use it as a pointer to look, not as proof the slide is right.
6. **After an error or timeout**, a slide may be partly changed. Re-read it, determine what landed, and apply the smallest correction instead of re-running the whole edit.
7. **Report** which slides you changed and checked, what you changed, and anything you could not do. Say "all slides" only if you inspected all of them.

Tools act on the only connected presentation. When several are connected, call `powerpoint_list_presentations`, pick the target by `label` or `documentUrl`, and pass its `sessionId` to `powerpoint_select_presentation` before step 1. The selection lasts for this DSH session. If the selected presentation closes, tools fail instead of switching to another one; list and select again.

Re-read the deck after the user switches documents, reloads the add-in, or edits it themselves; do not rely on earlier results.

## 2. Identifiers, indices, and units

| Where | What it takes |
|---|---|
| Most slide tools (`slide_id` parameter) | An opaque current slide ID from `powerpoint_deck_info.slideIds` (presentation order) or `powerpoint_verify_slides`. Not a page number. |
| `powerpoint_render_slide`, `powerpoint_insert_image`, `powerpoint_slide_outline` | A positive one-based `slide` index. |
| `powerpoint_verify_slides` (`from_slide`, `to_slide`) | Zero-based, inclusive range. Slide 1 is `0`; this differs from the one-based `slide` parameters above. |
| `powerpoint_read_slide_text`, `powerpoint_edit_slide_text` | The exact `ref` returned by `powerpoint_list_slide_shapes`. Refs encode slide and shape; never build one by hand. |
| `powerpoint_copy_image_between_slides` | Slide IDs plus the `cNvPr` shape id from `powerpoint_list_slide_shapes`. |
| `autosize_shape_ids` | An array of shape `cNvPr` IDs on the target slide. |
| `chart_index` | A zero-based chart index on the target slide. |

Raw shape ids are unique only within their slide. A slide's index changes when slides move; its ID is the stable handle. An OOXML write may replace the slide and return `slide_id_update`; use the new ID afterwards.

The `code` parameter means different things by tool. For `powerpoint_edit_slide_text` it is raw `<a:p>` paragraph XML, not JavaScript. For `powerpoint_execute_office_js`, `powerpoint_edit_slide_xml`, `powerpoint_edit_slide_chart`, and `powerpoint_edit_slide_master` it is the body of an async JavaScript function.

Units: Office.js positions, sizes, image placement, and icon sizes are points. Chart `spec.position` is EMU (1 pt = 12700 EMU). OOXML `a:off`/`a:ext` are EMU. Use the actual slide size from `powerpoint_deck_info`; do not assume 16:9.

Shape names, layout names, and placeholder names follow the Office UI language. Identify objects by ID, ref, or layout ID, and by type or position when that is all you have.

## 3. Choosing a mechanism

- **Office.js (`powerpoint_execute_office_js`)**: slides (add, move, apply layout, delete), shapes (text boxes, geometric shapes, lines), z-order, geometry, tables, fills, fonts, selection, masters and layouts listing. Default choice for ordinary edits.
- **Dedicated tools**: `powerpoint_edit_slide_text` (one shape's paragraphs), `powerpoint_find_and_replace` (deck-wide text, notes), `powerpoint_duplicate_slide`, `powerpoint_copy_image_between_slides`, `powerpoint_insert_image`, `powerpoint_search_icons` / `powerpoint_insert_icon`, and the chart tools. Use these when they fit; they handle details that are easy to get wrong by hand.
- **OOXML (`powerpoint_edit_slide_xml`, `powerpoint_edit_slide_chart`, `powerpoint_edit_slide_master`)**: use for properties Office.js does not expose or formatting it cannot preserve adequately: exact paragraph and run properties, notes, chart internals, theme/master parts, SVG recolouring, and detailed diagram anchoring. Use native Office.js shapes for ordinary editable diagrams.

Prefer the narrowest tool. Moving a box is Office.js; changing one word in a styled paragraph is `powerpoint_find_and_replace` or OOXML; a pie chart is `powerpoint_edit_slide_chart`.

## 4. Office.js

`powerpoint_execute_office_js` runs your code as an async function body. Available globals: `Office`, `PowerPoint`, `JSZip`, `DOMParser`, `XMLSerializer`, `insertImage`, and `files`. Supply `files: { image: "/absolute/path/image.png", deck: "/absolute/path/deck.pptx" }` alongside `code`; the plugin reads these DSH-machine paths and exposes raw base64 as `files.image` and `files.deck`. Never put base64 literals in `code`. There is no implicit `context`; open one with `PowerPoint.run`. Return a JSON-serializable value.

Read shapes on a slide:

```js
// powerpoint_execute_office_js code argument
return await PowerPoint.run(async (ctx) => {
  const slides = ctx.presentation.slides;
  slides.load("items/id");
  await ctx.sync();
  const shapes = slides.items[0].shapes;
  shapes.load("items/id,items/name,items/type,items/left,items/top,items/width,items/height");
  await ctx.sync();
  return shapes.items.map(s => ({ id: s.id, name: s.name, type: s.type,
    left: s.left, top: s.top, width: s.width, height: s.height }));
});
```

Rules:

- Keep the proxy returned by a getter in a variable: `load()` its properties, `await ctx.sync()`, then read that same variable. Re-calling the getter yields an unloaded proxy. Loaded values are snapshots; reload after a write before branching on them.
- Call `sync()` after writes, and await every async helper you call.
- `slides.add(...)` returns nothing. Sync, reload `slides.items`, then pick up the new slide and its ID. Layout IDs come from `ctx.presentation.slideMasters` / `layouts`, not from names.
- Colour setters differ: `shape.fill.setSolidColor("C2532E")` takes a bare hex; `slide.background.fill.setSolidFill({ color: "#FAF8F5" })` takes an object. If a call throws, check the exact form in the tool or API reference.
- Text frames: use `shape.getTextFrameOrNullObject()`, load `isNullObject`, sync, and read `textRange` only when it is false.
- Assigning `textRange.text` can discard formatting within the range. For text with mixed runs or a template style, use `powerpoint_edit_slide_text` or XML.
- Labels inside a simple shape go in that shape's own text frame: centre horizontally, middle vertically, set margins deliberately, and disable auto-size when the shape must keep its size. A separate overlaid text box tends to drift.
- Add shapes with `shapes.addTextBox`, `shapes.addGeometricShape`, `shapes.addTable`; reorder with `shape.setZOrder`. Selected slides come from `ctx.presentation.getSelectedSlides()`. Use `slide.moveTo(i)` and `slide.applyLayout(layout)` for ordering and layout changes.
- Grouping and z-order: use the grouping API only if the Office.js version in the add-in exposes it (check before relying on it); otherwise leave objects ungrouped and order them with `setZOrder`, or group in XML with `<p:grpSp>`.
- Tabular data belongs in a native table (`shapes.addTable`), not a grid of text boxes.

APIs that do not cross hosts:

| Task | PowerPoint API / approach | Do not borrow |
|---|---|---|
| Table cell | `table.getCellOrNullObject(row, column)`; load/sync its null status | Word's `getCell()` |
| Collection count | `collection.load("items")`, sync, then `collection.items.length` | `getCount()` |
| Slide package | `powerpoint_edit_slide_xml` to read/modify exported parts | `slide.getAsBase64()` does not exist |

Targeted edit by ID, loading fresh state before and after the write:

```js
// powerpoint_execute_office_js code argument
return await PowerPoint.run(async (ctx) => {
  const slideId = "PASTE_ID_FROM_powerpoint_deck_info";   // current ID, not an index
  const slide = ctx.presentation.slides.getItem(slideId);
  const shapes = slide.shapes;
  shapes.load("items/id,items/name,items/left,items/top,items/width");
  await ctx.sync();
  const target = shapes.items.find(s => s.id === "PASTE_SHAPE_ID");
  if (!target) return { error: "shape not found", ids: shapes.items.map(s => s.id) };
  target.left = 72; target.top = 120;                      // points
  target.fill.setSolidColor("2F5D8A");
  await ctx.sync();
  target.load("left,top,width");                           // reload after writing
  await ctx.sync();
  return { left: target.left, top: target.top, width: target.width };
});
```

If the slide ID was returned by an earlier OOXML writeback, use the `slide_id_update` value. If `getItem` fails, call `powerpoint_deck_info` again for the current IDs.

Example: add a slide from a layout, then clean up its placeholders from a fresh read:

```js
return await PowerPoint.run(async (ctx) => {
  const layoutId = "PASTE_LAYOUT_ID_FROM_powerpoint_deck_info";
  ctx.presentation.slides.add({ layoutId });
  await ctx.sync();
  const slides = ctx.presentation.slides;
  slides.load("items/id");
  await ctx.sync();
  const slide = slides.items[slides.items.length - 1];
  slide.shapes.load("items/id,items/name,items/type");
  await ctx.sync();
  return { slideId: slide.id, shapes: slide.shapes.items.map(s => ({ id: s.id, name: s.name })) };
});
```

Then fill or delete each unused placeholder in a second step. Do not decide what to delete from values loaded before your own write.

### Tables

- Table text, fills, fonts, and alignment are reached through `shape.getTable()` and its rows and cells, not `shape.textFrame`.
- Table height follows row heights and cell content. Writing the graphic frame's `height` (or `<a:ext cy>`) does not resize it reliably. Set `table.rows.getItemAt(i).height`, reduce cell font size, or shorten text, and pass the table's shape id in `autosize_shape_ids` for XML edits.
- Cell text written through Office.js may not persist on some hosts. Read the cell back after writing; if the value is not there, write it in the slide XML (`<a:tbl>/<a:tr>/<a:tc>/<a:txBody>`), keeping the cell's `<a:tcPr>` and run properties.

### Images and imported slides

- Use `powerpoint_insert_image` for new pictures: provide required `filePath` (a PNG, JPEG, GIF, or BMP path on the machine running DSH), a `slide` index, and positions in points. Give width or height, not both, to keep the aspect ratio; to fit a box, compute the scaled size from the image's natural ratio and centre it (letterbox) rather than stretching. To crop to fill, crop with the picture's crop properties instead of distorting. Inserting changes the selected slide.
- Inside `powerpoint_execute_office_js`, `insertImage(files.image, { imageLeft, imageTop, imageWidth, imageHeight })` places an image on the currently selected slide. Navigate to the target first (for example `Office.context.document.goToByIdAsync(slideNumber, Office.GoToType.Index, cb)`, 1-based) and await completion before calling it.
- Reuse an existing picture on another slide with `powerpoint_copy_image_between_slides`; it re-registers media and relationships and keeps crops, filters, and alt text.
- `ctx.presentation.insertSlidesFromBase64(files.deck, { sourceSlideIds, targetSlideId })` must be awaited; pass only the slides you need. For an externally generated `.pptx`, import one slide first and verify it before importing more. On `InvalidArgument`, isolate the failing slide instead of replaying the whole package. Depending on the source and target, the source's master, layouts, and theme may be imported alongside the deck's own. After importing, list `slideMasters` and layouts and check which master the new slides use. To make an imported template primary, move the existing slides onto it or edit the first master's parts with `powerpoint_edit_slide_master`.

## 5. Text, bullets, and run formatting

Choosing the tool:

- One shape: `powerpoint_read_slide_text` then `powerpoint_edit_slide_text` with `<a:p>` paragraph XML. Body properties and list styles on the shape are left as they were.
- Several shapes on one slide: a single `powerpoint_edit_slide_xml` call.
- The same replacement in many places: start with `powerpoint_find_and_replace` and `dry_run: true`, then apply it. Use hand-written Office.js only for reported skips or conditional logic. `cell.textRuns` can be null; preserve mixed-format cell runs rather than applying the first run's formatting to the whole cell. It covers shapes, groups, placeholders, tables, and notes; text replaced within a single run retains its formatting; text spanning several runs adopts the formatting of the first. It skips fields, chart and SmartArt text, and layout/master text.

Paragraph XML rules:

- Read the existing paragraph first. Preserve its `<a:pPr>` and `<a:rPr>` while changing the requested content or properties; dropping an explicit attribute can change the inherited formatting.
- Keep `<a:schemeClr>` colours and theme fonts. Hard-coded `<a:srgbClr>` or `<a:latin typeface=...>` override the theme and stop following later theme edits, and a named font may be missing on the machine. Add them only when the user asked or the existing runs already use them.
- Bullets are `<a:buChar>` in `<a:pPr>`, not a typed "•". Top level is `lvl="0"` (or omitted); sub-bullets use `lvl="1"`. A heading in a list uses `<a:buNone/>`.
- Copy `marL` and `indent` from the existing list. For a new list, `marL="457200" indent="-457200"` (second level `marL="914400"`) keeps text clear of the bullet.
- Escape user text with `escapeXml(...)` before putting it in a template string; a bare `&` or `<` breaks the XML.
- Superscript: `font.superscript = true` in Office.js, or `baseline="30000"` on `<a:rPr>`. Footnote text is usually small and muted, starting with the same number at normal baseline.
- Font size is `sz` in hundredths of a point (`2400` = 24 pt). Offsets and extents are EMU; paragraph spacing uses `<a:spcPts val>` in hundredths of a point or `<a:spcPct>` in thousandths of a percent. Give new runs a `lang` that matches the surrounding text or the user's language (copy it from existing runs); `en-US` in the examples is only illustrative. Keep `dirty="0"` on new runs.

Paragraph replacement example (`powerpoint_edit_slide_text` code argument), changing one run's text and keeping the original properties:

```xml
<a:p>
  <a:pPr marL="342900" indent="-342900"><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>
  <a:r><a:rPr lang="en-US" sz="1800" dirty="0"/><a:t>Revenue grew 12% year over year</a:t></a:r>
</a:p>
```

(Use the real `pPr`/`rPr` read from the shape. This only illustrates the shape of the result. Apply `escapeXml` to inserted text when generating the string in code.)

## 6. Raw OOXML

`powerpoint_edit_slide_xml`, `powerpoint_edit_slide_chart`, and `powerpoint_edit_slide_master` run your code body with `{ zip, markDirty }` plus `DOMParser`, `XMLSerializer`, and `escapeXml`. `powerpoint_edit_slide_chart` also provides `buildChart(spec)` and async `insertChart(zip, spec)`.

Mechanics:

- The zip is an exported package. The slide is always `ppt/slides/slide1.xml`, regardless of the slide's position or ID. Its master, layout, theme, notes, charts, and media are found through relationship files (`ppt/slides/_rels/slide1.xml.rels`, then the layout's and master's rels). Do not assume `slideMaster1.xml` or `theme1.xml`; decks with several masters differ.
- The edited ZIP is imported only when the callback calls `markDirty()`. Omit it for inspection; call it after changing ZIP entries.
- A writeback may replace the slide and return `slide_id_update`; use it afterwards.
- Pass `autosize_shape_ids` with the `cNvPr` ids of shapes whose text you changed or tables whose content changed. For shapes already set to shape-to-fit-text, the tool re-applies that setting so the layout recalculates; other auto-size modes are left alone. For tables it rewrites each row height to trigger frame re-layout, since font-only edits don't reflow the frame. Omit it when you changed no text.
- XML child order is strict. Keep existing elements; modify them in place rather than appending duplicates.
- After a write, read the XML back, check the changed text and relationships, and render the slide.

Read-only inspection:

```js
// powerpoint_edit_slide_xml code argument (no markDirty: nothing is written)
const xml = await zip.file("ppt/slides/slide1.xml").async("string");
const rels = await zip.file("ppt/slides/_rels/slide1.xml.rels").async("string");
return { xmlLength: xml.length, rels };
```

Mutating example: replace text in one shape and mark the change.

```js
// powerpoint_edit_slide_xml code argument
const path = "ppt/slides/slide1.xml";
const doc = new DOMParser().parseFromString(await zip.file(path).async("string"), "application/xml");
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const shapeId = "4"; // substitute the ID returned by powerpoint_list_slide_shapes
const shape = Array.from(doc.getElementsByTagNameNS(P, "sp")).find(sp =>
  sp.getElementsByTagNameNS(P, "cNvPr")[0]?.getAttribute("id") === shapeId);
if (!shape) throw new Error("Target text shape not found: " + shapeId);
const text = shape.getElementsByTagNameNS(A, "t")[0];
if (!text) throw new Error("Target shape has no text run");
text.textContent = "Q3 results"; // preserves the run and paragraph properties; DOM assignment escapes XML
zip.file(path, new XMLSerializer().serializeToString(doc));
markDirty();
return { shapeId, text: text.textContent };
```

In the tool call, pass `autosize_shape_ids: ["4"]` and, on success, use the returned `slide_id_update` for the next call. Then re-read the shape's text and render the slide. This sample edits a single-run shape; if the text has several runs, write the new text into the first run and clear the others only when that is what the request means.

### Speaker notes

Edit existing notes text with `powerpoint_find_and_replace` when the change is a text substitution. For anything structural, work in XML.

1. Read the slide rels and look for a relationship whose `Type` ends in `/notesSlide`.
2. If present, open the target part (for example `ppt/notesSlides/notesSlide1.xml`). Notes text lives in the body placeholder shape (`<p:ph type="body"`); the slide-image and slide-number placeholders are not text content. Edit only the body placeholder's paragraphs, keeping its `<a:pPr>`/`<a:rPr>` and the part's relationships.

```js
// powerpoint_edit_slide_xml code argument (read-only: no markDirty)
const rels = await zip.file("ppt/slides/_rels/slide1.xml.rels").async("string");
const relationships = new DOMParser().parseFromString(rels, "application/xml");
const R = "http://schemas.openxmlformats.org/package/2006/relationships";
const notesRel = Array.from(relationships.getElementsByTagNameNS(R, "Relationship"))
  .find(rel => rel.getAttribute("Type")?.endsWith("/notesSlide"));
if (!notesRel) return { notes: null };
const partPath = decodeURIComponent(new URL(notesRel.getAttribute("Target"),
  "https://package.invalid/ppt/slides/slide1.xml").pathname.slice(1));
const xml = await zip.file(partPath).async("string");
const doc = new DOMParser().parseFromString(xml, "application/xml");
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const body = Array.from(doc.getElementsByTagNameNS(P, "sp")).find(sp =>
  sp.getElementsByTagNameNS(P, "ph")[0]?.getAttribute("type") === "body");
const paragraphs = body ? Array.from(body.getElementsByTagNameNS(A, "p")).map(p =>
  Array.from(p.getElementsByTagNameNS(A, "t")).map(t => t.textContent).join("")) : [];
return { partPath, paragraphs };
```

3. If the slide has no notes part, add a notes-slide XML part with a body placeholder, a slide-to-notes relationship, the notes part's relationship back to its slide, and a notes-slide override in `[Content_Types].xml`. Allocate unused part names and relationship IDs. Preserve or reuse the package's notes-master/theme wiring when present. If you introduce a notes master, include its part, theme dependencies, content types, and presentation-level registration as well; every relationship must target a part actually included in the package. A missing notes part or notes master in the export is a package-construction task, not evidence that notes cannot be added.
4. After any write, re-run the read example, confirm the text, and check the slide still renders.

### Media and relationships

Adding a picture or other part needs the file under `ppt/media/`, a relationship in the slide rels with a unique `rId`, a default or override content type for the extension, and the `<p:pic>` referencing the `r:embed`. Prefer `powerpoint_insert_image` or `powerpoint_copy_image_between_slides`, which do this.

### Icons

`powerpoint_search_icons` takes one literal noun per query and needs network access. `powerpoint_insert_icon` inserts SVG with a PNG fallback, accepts a `color`, and returns the placed shape's ref, id, and geometry. To recolour an icon already on a slide, follow its `<asvg:svgBlip r:embed>` through the slide rels to `ppt/media/imageN.svg` and set the fill on the SVG paths; `shape.fill` colours only the box behind the icon. If the package holds both an SVG and a PNG fallback for the icon, recolour both (or re-insert the icon with `powerpoint_insert_icon` and its `color`), so renderers that use the PNG match.

## 7. Placeholders and new slides

A new slide inherits its layout's placeholders, even when they render empty. List the new slide's shapes, then fill or delete each unused placeholder before adding other content. Measure the title placeholder's bottom edge before placing content under it; title bands vary by template. Delete only placeholders on slides you just added. On an existing slide, a placeholder that holds text is the user's content. Do not delete content to make a verifier warning go away, and do not leave invisible empty boxes behind.

## 8. Themes, masters, and rebranding

Identify the deck type from `powerpoint_deck_info` and from reading a finished slide:

- **Blank or default deck**: define theme colours, heading and body fonts, background, and text styles in the master first, then let slides inherit. Put repeated graphics (logo, rule) on the master or layouts.
- **Hand-styled deck on the default master**: the finished slides are the design system. Match their background, fonts, sizes, colours, and shape styling slide by slide, and do not restructure the master as a side effect.
- **Templated deck**: use its layouts, theme colours (`themePalette`), and fonts; keep it.
- **Deck-wide footer notes/source lines**: use the layout's Footer placeholder, keeping each slide's own text, instead of free text boxes. After converting, remove local position and font overrides and verify that layout inheritance controls the result.

`powerpoint_edit_slide_master` works on the master associated with the first slide, along with its layouts and theme. Slides using that master migrate with it and other masters stay. It cannot select an arbitrary master, and its package is not the whole deck, so it cannot show you every slide's direct formatting.

Rules for master and theme XML:

- Edit existing `<p:txStyles>`, `<a:clrScheme>`, and `<a:fontScheme>` in place; do not append duplicates.
- A background is `<p:bg>` inside `<p:cSld>`, before `<p:spTree>`; edit an existing one rather than adding a second.
- Theme fonts are in `<a:fontScheme>` (`<a:majorFont>`, `<a:minorFont>`); read them to match existing typography.
- A theme-only request ("change accent2 to gold", "swap the heading font") is one theme or master edit; content that inherits follows. Do not restyle shapes one by one.

Direct `<a:srgbClr>` colours and explicit fonts on slides do not follow theme changes. For a full palette change:

1. Find where the old colours live: inherited (theme/master/layout) versus direct (on slide shapes, charts, tables).
2. In one `powerpoint_edit_slide_master` call, replace the old hex values across the `.xml` parts in that exported master package (the first slide's master, its layouts, and its theme). That package does not contain every slide or chart in the deck, so this step only covers what it includes.
3. Fix direct colours on each affected slide with `powerpoint_edit_slide_xml`, and update chart colours through `powerpoint_edit_slide_chart` or `powerpoint_edit_built_chart` per chart. Other masters need their own pass, since `powerpoint_edit_slide_master` only reaches the first slide's master.
4. Render samples from each layout type.

## 9. Charts

Tools:

- `powerpoint_create_slide_chart`: declarative builder for column, bar, line, slope, stacked column (with totals), 100% stacked (Likert) bar, waterfall, scatter, and big number. It writes chart XML and its cache.
- `powerpoint_read_chart_style`: reads each chart's form, fonts, fills, series colours, legend, value axis, gridlines, and title as fields you can pass back.
- `powerpoint_edit_built_chart`: replaces a built chart's content with a new full spec, keeping the same object, position, and shape id. It refuses combo, 3D, pie, and secondary-axis charts.
- `powerpoint_edit_slide_chart`: raw chart OOXML for unsupported forms and fine changes.

Practice:

- If the deck already has charts, call `powerpoint_read_chart_style` first and pass its style (accent, font, background, neutrals) and construction (legend, value axis, gridlines) on the new spec so the charts match. A native chart title is the top-level `title` field of the spec, not part of construction; pass it when the existing charts have one (`has_native_title`). Use the returned accent and font rather than guessing. Where there are no charts, pass the deck's accent colour and body font; without a style the builder falls back to its own default palette.
- `powerpoint_edit_built_chart` takes the whole replacement spec and drops anything not in it. Carry over the style and construction from `powerpoint_read_chart_style` together with the new data.
- Numbers: give raw numbers and put the unit in the format: `"$"#,##0"M"` reads $42M, `0"%"` reads 38%. For stacked charts the totals format carries the unit and the segment format is bare. A bare number leaves the reader guessing.
- Axis scale: leave it unset unless you need round numbers or a scale shared with another chart.
- Line charts: keep categories short (`Q1`, `Jan`) and put years in `category_groups`. Short series names. Put values in `end_label` or `point_labels` (start, end, and the turning point). Use `callouts` only when the slide's message is a change in trajectory.
- Forecast: `forecast_from` dashes or hatches projected values; also suffix those category labels with `E`.
- Growth arrows: only for significant changes; the builder draws them as grouped elbow shapes.
- Chart `spec.position` is in EMU; omit it for the full-slide default.
- Chart XML from the builder carries no embedded workbook. If the user needs editable data in Excel or you edit an existing workbook, say what you did and check the chart renders and the data is right.
- Keep the chart as a native chart object. Do not draw a quantitative chart from rectangles or lines.
- Choosing a form: column for comparison across a few periods or categories; bar for ranked or long-label categories; line for trends over time; stacked column for composition with totals; Likert (100% stacked bar) for survey distributions; waterfall for a bridge from a start to an end value; scatter for relationships between two numbers; slope for before/after across items; big number for a single headline figure. Emphasise the one category or point that carries the message and keep the rest neutral; do not colour every series differently without reason.
- Use `accent_index` only when the deck's existing charts use a single accent colour. If they colour every bar the same, leave it unset.

## 10. Design and content

- For a substantial new deck, settle the brief first: audience, purpose, whether it is presented live or read on its own (a read-ahead deck can carry more text), and the key message. Draft a storyboard (one line per slide giving its message) before building. For a small edit, use the brief already established by the deck and request.
- Content slides carry one main message, and their titles state the conclusion. Title, agenda, and section-divider slides can use plain label titles.
- Match the existing deck's look. When the user supplies no style and the deck has none, choose fonts and colours that suit the content and use them consistently.
- Keep type hierarchy consistent. Size body text for the actual canvas and viewing distance. If text overflows, resize the container, trim your own copy, or split the slide; shrink only as far as stays readable. User-written text may be reduced a little, and tell the user if it ends up very small.
- Leave 10–15 pt between text and the edge of its card or container. Align objects, keep spacing even, and keep titles in the same position across slides in the same layout.
- Title alignment follows the layout (centred on title and section layouts, left on content layouts); a template's own placeholder alignment wins. The title band's height varies by template, so read the title placeholder's geometry and start content below its bottom edge.
- Preserve the user's wording. Rewrite only on request.
- Reuse the master for repeated elements instead of copying them onto every slide.

## 11. Checking and runtime notes

- `powerpoint_verify_slides` reports overlap, out-of-bounds shapes, and low text contrast, with a `slideId` per result. For large decks use `from_slide` and `to_slide` (0-based). Fix flagged items within the scope of the request; if the flagged shapes are outside what the user asked to change, report them.
- `powerpoint_render_slide` renders a real slide image. The default backend uses Office.js image export. If the environment is configured for COM, it renders the active presentation, so confirm the intended deck is active.
- `powerpoint_pane_visibility` hides or shows the task pane. Hiding keeps the runtime available; closing a borrowed pane may drop it.
- `powerpoint_deck_info` reads the live document. If a tool fails because the runtime is unavailable, ask the user to open or restore the add-in rather than repeating write calls.
