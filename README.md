# Vertex Forge

A static, in-browser **3D vertex editor**. You place individual vertices, join them
into edges and n-gon faces, paint those faces, and export as native JSON or binary
glTF (`.glb`). You can also **import** existing 3D files (OBJ, STL, PLY, GLB,
glTF) and edit their geometry and colour directly.

No build step. No bundler. No npm dependencies. The browser loads ES modules
straight from disk.

```bash
npm run serve      # -> http://localhost:5173/
```

---

## Table of contents

- [Why it works this way](#why-it-works-this-way)
- [Getting started](#getting-started)
- [The editing model](#the-editing-model)
- [Importing 3D files](#importing-3d-files)
- [Exporting](#exporting)
- [Native file format](#native-file-format)
- [Keyboard & toolbar reference](#keyboard--toolbar-reference)
- [Architecture](#architecture)
- [Development](#development)
- [Design decisions](#design-decisions)
- [Known issues](#known-issues)

---

## Why it works this way

Most browser modelers are mesh-subdivision tools: you push around pre-existing
topology. Vertex Forge is deliberately the other thing — a **point-first** editor,
closer to a CAD vertex snap than to Blender in edit mode. Every corner you see is
a document vertex with an `id`, listed in a panel, and nudgeable with the arrow
keys.

That goal dictates the two hardest parts of the codebase:

1. **Faces are n-gons, not triangles.** A face stores an ordered ring of vertex
   ids. Triangulation happens at render time only, so a flat quad stays one quad
   you can select by its centre.
2. **Imported files must be repaired before they are editable.** An STL has no
   shared vertices at all — every facet owns its own three. Loaded verbatim, a
   100-triangle STL is 300 overlapping handles you cannot work with. The
   [`merge`](src/core/merge.js) pass exists to undo the damage each format does
   on the way in. See [Importing 3D files](#importing-3d-files).

---

## Getting started

Requires **Node 18+** (for `node --test` and ES module syntax).

```bash
npm run serve              # http://localhost:5173/
PORT=8080 npm run serve    # alternate port
```

[`tools/serve.cjs`](tools/serve.cjs) is a ~60-line zero-dependency static server.
It exists only because browsers refuse to load ES modules over `file://`. It
serves `index.html` at `/`, sets correct MIME types (including
`text/javascript` for `.mjs` and `application/wasm`), sends `Cache-Control:
no-store`, and confines every request to the project tree.

There is no install step — `npm install` has nothing to do. Everything the app
needs, including three.js, is committed under [`vendor/`](vendor/).

---

## The editing model

A **document** is three arrays plus metadata:

| Entity     | Shape                           | Notes                                             |
| ---------- | ------------------------------- | ------------------------------------------------- |
| `vertices` | `{ id, x, y, z }`               | The atoms. Everything else references them by id.  |
| `edges`    | `{ id, a, b }`                  | Loose wire. Face boundaries are drawn regardless.  |
| `faces`    | `{ id, loop: [vertexId, ...], color? }` | Ordered ring, **3 or more** vertices. `color` is a display-space `#rrggbb`, present only when painted. |

Positions are plain numbers in a unit-less space; documents carry `units: "unit"`
for round-trip honesty. Faces may be non-planar — the Newell method derives the
normal, so a warped n-gon still shades.

**Tools** (`V` `B` `E` `F` `M` `P`): select, place vertex, join edge, close face, move, paint.
Vertex and edge placement work as *chains*: click a run of points, then `Enter` to
commit or `Esc` to abandon. `F` on a selected closed boundary fills it.

**Ops** on the selection: extrude faces, weld by distance, snap to grid, centre on
origin, delete, flip winding, and unify winding (re-orient every face outward by
flood-filling across shared edges).

**Colour** is per-face, never per-vertex: a brush hex from the palette (or a custom
colour picker), applied with the Paint tool (`P`) — click a face to fill it,
shift-click to build a run, or select faces and press **Paint selected**.
**Clear** returns faces to the default shade. Colour lives on the face's `color`
field, survives undo/redo, extrusion (the new walls inherit the cap's colour), and
round-trips through both JSON and GLB. Uncoloured faces omit the key entirely, so a
colourless document serialises byte-identically to earlier versions.

**Undo** is snapshot-based: mutate the document in place, call `hist.begin()`
first and `hist.commit(label)` after. `commit()` compares serialisations, so a
no-op edit does not pollute the stack. Depth is `HISTORY_LIMIT = 100`.

**Autosave** writes the document to `localStorage` under
`vertexforge.autosave.v1`, debounced. Reload restores your model; the first-ever
visit seeds a cube.

---

## Importing 3D files

The file input accepts `.json .obj .stl .ply .glb .gltf`. Native JSON loads
straight in — it is already in this exact format, so no options are needed.
Anything else opens an options dialog.

### Supported formats

| Format | What is handled |
| ------ | --------------- |
| **OBJ** | `v` / `vt` / `vn` / `f` / `l` / `o`. True n-gons preserved. Negative indices, `v/vt/vn` and `v//vn` specifiers, and homogeneous `w` are honoured. Vertices that no face or line references are dropped, so a file with 50k `v` lines whose geometry uses 300 of them imports 300 handles. **Vertex colour** (`v x y z r g b`, 0-1 or 0-255) is read. A `.mtl` sidecar (`usemtl` + `Kd`) is honoured when the parser is given its text. |
| **STL** | ASCII and binary, auto-detected from content. No colour exists in STL. |
| **PLY** | ASCII plus binary in either endianness. `list` properties and extra columns (normals, texture coords) are stepped over. **Vertex colour** (`red`/`green`/`blue` or `diffuse_*`) is read, scaled by the *declared property type* — `uchar` channels are 0-255, `ushort` 0-65535, `float`/`double` 0-1 — never guessed from the values, so a genuinely dark scan stays dark. Vertices no face references stay in the document as loose points — which is what a raw scan should import as. |
| **GLB** | Version-2 container, JSON + BIN chunks with 4-byte alignment, accessors, buffer views, node transforms (translation, rotation, scale, matrix), and draw modes including `LINES` / `LINE_LOOP` / `LINE_STRIP` / `TRIANGLES` / `TRIANGLE_STRIP` / `TRIANGLE_FAN`. **Colour** from `COLOR_0` (per-vertex), material `baseColorFactor`, or an embedded PNG `baseColorTexture` sampled through the mesh's UVs. |
| **glTF** | Same reader, plus `data:` URI buffers. |

Every reader returns one neutral shape —
`{ name, kind, note, positions, colors?, uvs?, textureJobs?, polygons, triangles, lines }` —
so nothing downstream has to care where the geometry came from. `colors` is flat
`rgb` in 0-1, **strictly parallel to `positions`**; `buildDocument` averages a
face's vertex colours into its single `#rrggbb`.

### Colour spaces, because it is a real trap

glTF defines colour as **linear-light**; the document's hex is display-space
**sRGB**. Copying linear values straight into a hex makes a bright imported model
come in dark and muddy (linear 0.5 grey reads as `#808080` instead of `#bcbcbc`),
so `formats.js` runs glTF colour — `COLOR_0` *and* `baseColorFactor` — through the
sRGB transfer function on the way in. OBJ and PLY channel values are treated as
already display-space, matching what their writers actually emit. Export inverts
the conversion via `THREE.Color`, which is linear-managed internally.

### What is still discarded

Normals (recomputed from winding), skinning, animation and morph targets are
dropped — Vertex Forge edits vertices and has nowhere sane to put them. The import
toast says so when it happens. UVs and `baseColorTexture` are the one exception:
they exist only long enough to bake texture colour into per-vertex colours.

PNG decoding needs async inflate, while the core parsers are sync by design, so
`parseGLTF` records `textureJobs` and `applyTextures()` (in
[`src/core/texture.js`](src/core/texture.js), called by `importFile`) finishes the
work. The decoder itself is [`src/core/png.js`](src/core/png.js): dependency-free,
8/16-bit RGB/RGBA/greyscale/palette, all five row filters, inflating via
`DecompressionStream` in the browser and `node:zlib` in tests. **JPEG textures are
not supported** — the import falls back to the flat material colour and notes it.

A `.gltf` that needs an external `.bin` cannot load in a browser page on its own,
so the error explains why and tells you to convert to a single-file `.glb`.

### Colour and welding: why corners split at material boundaries

`weldPositions` refuses to merge two coincident corners carrying **different**
colours. A vertex shared by a red face and a blue face cannot exist as one vertex
in a vertex-colour model — whichever colour won the weld would be wrong for the
other face. This is exactly what three's `GLTFExporter` emits for a painted model
(one shared `POSITION` accessor, absolute indices, colour in the materials), so
without the split, re-importing your own GLB recolours the entire mesh in the
first material's shade. The cost is honest: a two-tone cube comes back with more
vertices than it left with, split where the colours meet. Same trade every DCC
makes.

### The repair pipeline

```
bytes ─> parseAny()              detect format by extension, fall back to sniffing
   ─> normalisePositions()       up-axis swap · uniform scale · centre or fit-to-size
   ─> weldPositions()            coincident corners become ONE document vertex
   ─> mergeCoplanarTriangles()   flat triangle runs become one n-gon
   ─> buildDocument()            emit vertices, faces, edges + a stats report
```

**Why welding is the important step.** It uses a rounded 3-D grid plus a
27-cell neighbourhood scan, so two duplicates straddling a cell boundary still
find each other. Tolerance is either `auto` (scaled to the model's bounding
radius) or an explicit value. The **first** occurrence wins, which keeps import
order — and therefore undo diffs — stable. Without welding, a 100-facet STL is
300 overlapping handles; with it, it is roughly 50 real corners you can actually
grab.

**Why coplanar merging is careful.** Gluing triangles two at a time walks into
self-intersecting rings on concave shapes. Instead each *connected island* of
mutually-coplanar triangles is merged as a unit: union-find the islands, take the
edges used exactly once inside the island (its boundary), and stitch them into a
single ring. Three guards reject anything suspicious and leave it as plain
triangles:

- the whole island must truly lie in one plane — union-find is transitive, so a
  chain of merely "close enough" neighbours can drift;
- triangles must traverse a shared edge in **opposite** directions, otherwise it
  is a non-manifold join that would stitch into nonsense;
- the ring's re-triangulated area must match the triangles' summed area within
  2%, which catches self-intersecting rings that the ear clipper would otherwise
  silently fall back to fanning.

A plate with a hole in it yields two boundary loops, not one, and is therefore
left as triangles. Wrong topology would be worse than a busy mesh.

### Options in the dialog

| Option          | Values | Notes |
| --------------- | ------ | ----- |
| Mode | Replace / Add to current model | *Add* offsets the import clear of the origin and welds nothing. |
| Up axis | Y up (glTF, OBJ, PLY) / Z up (STL, CAD) | Z-up rotates −90° about X, preserving handedness so face windings stay valid. |
| Scale | 1:1 · mm→units · cm→units · m→units | Applied before fitting. |
| Weld radius | Auto · Off · 0.001 · 0.01 · 0.1 | `Off` keeps every duplicated corner. |
| Fit size | Keep as-is · 2 · 4 · 10 units | Overrides centring; leaves a note in the toast. |
| Merge triangles | on by default | Collapse flat runs into polygons. |
| Keep outlines | off by default | Also write every polygon boundary as an editable `edge`. |
| Show handles | off by default | Force-on when you want handles over a large import. |

### Size limits

- **2,000,000** output vertices (`MAX_OUTPUT_VERTS`) — above this the reader
  refuses rather than freezing the tab.
- **12,000** vertices (`LARGE_IMPORT_VERTS`) — above this, handles and dense wire
  overlays switch off automatically (press `H` to opt back in), because the editor
  is unusable with that many dots.
- **6,000** triangles (`LARGE_IMPORT_TRIS`) — above this, coplanar merging is
  skipped: it is quadratic and not worth the wait on a scan.

### Limitations

- **No materials or shaders in or out.** Face colour is per-face (`#rrggbb`), not
  per-vertex: an import averages a face's vertex colours into one hex, and GLB
  export writes one material per distinct colour. Metallic/roughness, normal maps
  and emissive are dropped. JPEG textures are not decoded (PNG only).
- **No hierarchy.** Nodes are flattened and transforms baked into positions.
- **Sparse glTF accessors are unsupported** and fail loudly rather than importing
  wrong data.
- **Non-finite coordinates** are reset to the origin rather than dropped, because
  removing one would shift every later vertex out of index alignment.

---

## Exporting

| Target | Path |
| ------ | ---- |
| **Native JSON** | `serialize(doc)` → `.vforge.json`. Also on `Ctrl+S`. |
| **GLB** | three's `GLTFExporter` with `binary: true`, from the vendored copy. |

GLB export is **geometry only**: n-gons are re-triangulated, loose edges are
dropped, and no material is attached. Note that three's exporter resolves with an
**`ArrayBuffer`** in binary mode, not a `Blob` — see the comment above
`exportGLB` in [`src/ui/io.js`](src/ui/io.js) before changing that call.

`safeName()` sanitises the download filename from the document name.

---

## Native file format

```jsonc
{
  "format": "vertex-forge",   // required; anything else is rejected on load
  "version": 1,
  "name": "Cube",
  "units": "unit",
  "vertices": [ { "id": "v1", "x": -0.5, "y": -0.5, "z": -0.5 } ],
  "edges":    [ { "id": "ef", "a": "v5", "b": "v6" } ],
  "faces":    [ { "id": "f9", "loop": ["v5", "v6", "v7", "v8"] } ],
  "stats":    { "vertices": 8, "edges": 12, "faces": 6, "triangles": 0 }
}
```

- **Ids are opaque strings, preserved across a round trip**, so an exported file
  can be re-imported and references still mean the same thing.
- **Faces store one ordered ring of vertex ids**, never triangle indices.
- **`stats` is advisory.** `serialize()` writes it; `deserialize()` ignores it and
  the app recomputes counts from the actual arrays.
- **`format` is checked**, with a clear error:
  `Not a Vertex Forge file (format "...")`.

### How loading handles bad data

`deserialize()` takes a **parsed object** (`readJSONFile()` does the
`JSON.parse`), then builds a *new* document from only the fields it knows about.
Consequences, all covered by tests:

- An edge naming a missing vertex is **dropped**; a face ring containing one is
  **stripped of that entry**, and the face survives if 3+ vertices remain. It
  errs toward importing your model rather than refusing to open it.
- Unknown injected keys — including `__proto__` — never reach the document, so a
  hostile file cannot pollute `Object.prototype`.
- Documents are re-validated on load. `validate()` reports mesh health as
  `{ errors, warnings, boundaryEdges, nonManifold }`. Note that a dangling
  reference fixed by dropping is not an `error`: `boundaryEdges > 0` simply means
  the mesh is not watertight, which is normal for an in-progress model.

---

## Keyboard & toolbar reference

Keys are ignored while focus is in an input, select, or textarea.

### Tools

| Key | Action |
| --- | ------ |
| `V` | Select |
| `B` | Place vertex |
| `E` | Draw edge chain |
| `F` | Close face / fill selection |
| `M` | Move |
| `P` | Paint — fill the face under the cursor with the brush colour; shift-click adds faces to the selection first |
| `Enter` | Commit the current chain |
| `Esc` | Cancel chain and clear selection |
| `Del` / `Backspace` | Delete selection |

### View

| Key | Action |
| --- | ------ |
| `H` | Toggle vertex handles |
| `W` | Toggle wire overlay |
| `X` | Toggle shading (shaded ↔ wire only) |
| `Home` | Frame the model |
| `1`–`6` | Front · Right · Top · Back · Left · Bottom |
| `0` | Perspective |

### Edit

| Key | Action |
| --- | ------ |
| Arrows | Nudge selection in the view plane |
| `Shift`+Arrows | Fine nudge (0.01) |
| `G` | Cycle grid snap: off · 0.05 · 0.125 · 0.25 · 0.5 · 1 |
| `Ctrl`/`Cmd`+`Z` | Undo |
| `Ctrl`/`Cmd`+`Shift`+`Z` | Redo |
| `Ctrl`/`Cmd`+`S` | Export native JSON |

Arrow nudge uses the snap step when snapping is on, otherwise 0.1 (0.01 with
`Shift`).

### Toolbar

Import · Export JSON · Export GLB · Cube · Plane · Tetra · Clear · Center · Frame ·
Weld · Fill · Extrude · Delete · Flip · Unify · Snap · Undo · Redo · Screenshot.

**Colour panel:** a `brush` colour picker (with hex readout), a 15-swatch preset
palette, and two ops — **Paint selected** (fill every selected face) and **Clear**
(return them to the default shade `#c9d2e3`). The Paint tool's status hint:
*"Click a face to fill it with the brush colour · shift-click to build a multi-face
selection"*.

**Debugging handle:** `window.__vf = { state, viewport }` is exposed in the
console.

---

## Architecture

```
index.html            markup, toolbar, import dialog, import map
src/
  core/               PURE data. No three.js, no DOM. Unit-testable in Node.
    geometry.js       vectors, Newell normal, ear clipping, bounds, loop stitching
    model.js          document CRUD, ids, validate, serialize/deserialize, history
    mesh.js           document -> renderable buffers, triangulation, watertight test
    ops.js            delete, fill, extrude, weld, snap, ring ordering
    primitives.js     cube, plane, tetra
    formats.js        OBJ / STL / PLY / glTF / GLB readers  (zero dependencies)
    merge.js          welding + coplanar triangle merging
    importer.js       normalise -> weld -> merge -> emit document
  ui/
    app.js            editor shell: state, tools, keyboard, HUD. Wiring only.
    viewport.js       ALL three.js lives here: scene, camera presets, handles, picking
    io.js             import/export orchestration, GLB, downloads
    style.css         layout and theme
tools/
  serve.cjs           zero-dependency static dev server
  check-imports.mjs   static link checker (see Development)
tests/                node:test suites
vendor/three/         three.js r169 + the addons the app uses
```

### The rules that keep it honest

- **`core/` never imports from `ui/` or from three.js.** Geometry math must stay
  runnable in Node so it can be tested without a browser. This is also why the
  format readers are hand-written: three's loaders build `THREE.Scene` graphs
  that would have to be dismantled anyway, and they assume a DOM.
- **`viewport.js` is the only three.js consumer.** `app.js` talks to it through a
  small surface (`setOptions`, `frame`, `setCameraPreset`, picking callbacks).
- **Modules resolve by relative path through an import map** in `index.html`,
  which maps `three` and `three/addons/` into `vendor/`. With no bundler, the
  import map *is* the module resolver.
- **Face rings are the contract.** Triangulation, extrusion, normal computation
  and GLB export all treat `loop` as an ordered, non-repeating cycle.

---

## Development

```bash
npm test                            # node --test tests/*.test.js
node --test tests/import.test.js    # one file
node tools/check-imports.mjs        # static link + unused-import audit
```

### `tools/check-imports.mjs` — read this before adding an import

ES modules fail **at link time**. One bad named import does not degrade a
feature; it aborts the entire module graph, so `app.js` never runs and the page
is blank with no useful error. This actually happened here: `app.js` imported
`extOf` from `io.js`, which had imported it from `formats.js` but never
re-exported it.

The checker walks `src/`, parses every local `import { … } from './…'`, and
verifies each binding really exists in the target module's exports. It reports
`BAD BINDING`, `MISSING FILE`, `NO DEFAULT`, and unused imports. It cannot check
bare specifiers like `three`, which the browser resolves via the import map.

**Run it after touching any import statement.** A green `npm test` will *not*
catch a broken link: the test files import modules individually and never import
`app.js` at all.

### Test layout

- `tests/geometry.test.js` — vectors, ear clipping, bounds, loop stitching.
- `tests/model.test.js` — document CRUD, validation, serialisation round trips,
  history, primitives, mesh building.
- `tests/import.test.js` — every format reader against byte-accurate fixtures
  (including a hand-assembled GLB and a GLB round trip), welding and merging edge
  cases, `buildDocument` option matrices, and `importFile` end to end.
- `tests/color.test.js` — the whole colour pipeline: `normalizeColor`, palette →
  contiguous mesh groups, JSON/GLB persistence, paint → export → re-import
  round-trips, and import colour fidelity for OBJ / PLY / glTF (linear → sRGB).

Current status: **131 of 131 pass.** The suites are self-contained — the head
fixtures under `test-assets/` (regeneratable via `node tools/make-head-assets.mjs
test-assets`) are for the `tools/check-*` fidelity audits, not for `npm test`.

---

## Design decisions

**Why hand-written format readers instead of three.js's loaders?** The loaders
produce `THREE.Scene` graphs that would have to be taken apart to get at positions
and indices, and they assume a DOM. `formats.js` has zero dependencies, runs in
Node, and returns a single neutral shape.

**Why is weld tolerance relative to model size?** Real exporters leave float
noise. An absolute epsilon that works on a 2-unit part either shatters a 2-metre
CAD assembly into duplicates or, worse, fuses distinct corners. `auto` scales it
to the bounding radius.

**Why centre imports on the origin?** A file authored 4 km off origin gives the
camera and the snapping grid something absurd to work with. Fit overrides
centring, since asking for "make it 4 units across" means you also want it where
you can see it.

**Why default to Z-up only for STL?** STL and CAD tools are conventionally Z-up,
while glTF, OBJ and PLY are Y-up by spec. The dialog still exposes the choice,
because that convention is broken often enough that guessing once is not enough.

**Why does a merged import weld nothing?** Auto-welding two deliberately-placed
models together would fuse whatever happens to touch. The editor has an explicit
`Weld` op for that.

**Why is `hidden` paired with `.modal[hidden] { display: none }`?** The modal sets
`display: grid`, which would otherwise override the `hidden` attribute and leave
the dialog painted over the viewport on load.

---

## Known issues

**Draco-compressed glTF fails with a confusing error.** A file using
`KHR_draco_mesh_compression` (e.g. three.js's `duck.glb`) legitimately has
accessors with no `bufferView`, so the reader dies with *"glTF accessor has no
readable bufferView"* instead of saying "this model is Draco-compressed and we
cannot decode it." There is no decoder here; the fix is to detect the extension
and fail with the right message. Found by testing against real third-party
assets — our own fixtures do not cover it.

**Textured imports are approximate.** A `baseColorTexture` is baked to per-vertex
colour by nearest-texel UV sampling, so a 4k face texture on a coarse mesh
visually quantises (measured on the procedural head: eye region Δ1, skin Δ~39 at
128px). Native `.vforge.json` is the lossless format; GLB is exact only where
colour is flat per material.

**No committed browser smoke test.** Import/paint flows have been verified by
headless-Chromium probes (SwiftShader WebGL, real file inputs and downloads), but
those scripts live in `scratch/` and are gitignored, so CI-equivalent coverage is
Node-only. Promoting at least one browser probe into `tools/` would be worth it.

**`IMPORT_ACCEPT`** in `src/ui/io.js` is exported but never used — `index.html`
hard-codes the `<input accept="…">` list. They agree today, but only by
discipline. Wire the constant in or drop it.

**Import dialog focus.** `Escape` and `Enter` are trapped with a capturing
listener on `window`, correctly swallowing them before the app-wide handler, but
focus is not restored to the previously-focused element when the dialog closes.

**Unused imports.** `node tools/check-imports.mjs` lists several in `core/ops.js`,
`ui/app.js` and `ui/io.js` (e.g. `addEdge`, `findEdge`, `removeEdge`,
`removeFace`). Harmless, but they should go.

**`stats` round-trip is lossy by design** — see
[Native file format](#native-file-format). Do not trust it as source data.

---

## Version

`0.1.0` — private, pre-release. The document format is `version: 1`. If the schema
changes incompatibly, bump both and teach `deserialize()` to migrate old files.
