/**
 * Editor shell: document state, tools, keyboard, HUD. All three.js lives in
 * viewport.js; all geometry lives in core/. This file is the wiring only.
 */
import { Viewport } from './viewport.js';
import {
  createDocument,
  createHistory,
  addVertex,
  getVertex,
  setVertexPosition,
  findEdge,
  removeEdge,
  removeFace,
  addEdge,
  addFace,
  validate,
  centerOnOrigin,
  unifyWinding,
  flipAllFaces,
} from '../core/model.js';
import { buildMesh, isWatertight } from '../core/mesh.js';
import { makeCube, makePlane, makeTetra } from '../core/primitives.js';
import {
  deleteSelection,
  fillEdgeLoop,
  extrudeFaces,
  weldVertices,
  snapVerticesToGrid,
  orderRing,
} from '../core/ops.js';
import { download, exportJSON, readJSONFile, exportGLB, safeName, importFile, stemOf, extOf } from './io.js';
import { boundsOf } from '../core/geometry.js';

const AUTOSAVE_KEY = 'vertexforge.autosave.v1';
const q = (sel) => document.querySelector(sel);
const qa = (sel) => [...document.querySelectorAll(sel)];

const SNAP_STEPS = [0, 0.05, 0.125, 0.25, 0.5, 1];

const state = {
  doc: createDocument('Untitled'),
  hist: null,
  tool: 'select',
  mesh: null,
  view: { verts: new Set(), edges: new Set(), faces: new Set(), pending: new Set(), hoverVertex: null },
  pending: [], // staged vertex ids for the edge / face chains
  snap: 0,
  show: { handles: true, wire: true, shade: true },
  drag: null,
  extrudeDistance: 0.25,
};

const viewport = new Viewport(q('#viewport'));
state.hist = createHistory(state.doc);

/* ------------------------------------------------------------------ *
 * Selection helpers
 * ------------------------------------------------------------------ */

function clearSelection() {
  state.view.verts.clear();
  state.view.edges.clear();
  state.view.faces.clear();
}

function selectVertex(id, additive) {
  if (!additive) clearSelection();
  state.view.verts.add(id);
}

function selectedEdgeIdPairs() {
  const out = [];
  for (const i of state.view.edges) {
    const pair = state.mesh?.edgePairs[i];
    if (!pair) continue;
    const a = state.doc.vertices[pair[0]]?.id;
    const b = state.doc.vertices[pair[1]]?.id;
    if (a && b) out.push([a, b]);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Mutation + sync
 * ------------------------------------------------------------------ */

function mutate(label, fn) {
  state.hist.begin();
  const result = fn();
  if (state.hist.commit(label)) sync();
  return result;
}

function sync(refit = false) {
  state.mesh = buildMesh(state.doc);
  viewport.sync(state.doc, state.mesh, state.view);
  if (refit) viewport.frame(state.mesh.bounds.center, state.mesh.bounds.radius);
  updateHUD();
  scheduleAutosave();
}

function afterSelectionChange() {
  viewport.setSelection(state.view);
  updateHUD();
}

/**
 * After a history step, drop selection ids the restored document no longer
 * has. Edge selection is positional (an index into the built edge list), so it
 * is cleared wholesale - indices could point at a different edge after a revert.
 */
function pruneSelection() {
  const vIds = new Set(state.doc.vertices.map((v) => v.id));
  state.view.verts.forEach((id) => {
    if (!vIds.has(id)) state.view.verts.delete(id);
  });
  const fIds = new Set(state.doc.faces.map((f) => f.id));
  state.view.faces.forEach((id) => {
    if (!fIds.has(id)) state.view.faces.delete(id);
  });
  state.view.edges.clear();
}

/* ------------------------------------------------------------------ *
 * Tool actions
 * ------------------------------------------------------------------ */

function snapValue(v) {
  return state.snap > 0 ? Math.round(v / state.snap) * state.snap : v;
}

function placeAt(point) {
  const x = snapValue(point.x);
  const y = snapValue(point.y);
  const z = snapValue(point.z);
  mutate('place vertex', () => {
    const v = addVertex(state.doc, { x, y, z });
    clearSelection();
    state.view.verts.add(v.id);
    if (state.tool === 'edge' || state.tool === 'face') state.pending.push(v.id);
    return v;
  });
}

function commitChain() {
  const chain = state.pending;
  if (state.tool === 'edge') {
    if (chain.length < 2) return;
    mutate('draw edge chain', () => {
      for (let i = 0; i + 1 < chain.length; i++) addEdge(state.doc, chain[i], chain[i + 1]);
    });
  } else if (state.tool === 'face') {
    if (chain.length < 3) {
      toast('A face needs at least 3 vertices.', 'warn');
      return;
    }
    const loop = [...chain];
    const created = mutate('make face', () => addFace(state.doc, loop));
    if (!created) toast('Those vertices cannot form a face (duplicates?).', 'warn');
  }
  state.pending = [];
  state.view.pending.clear();
  sync();
}

function cancelChain() {
  state.pending = [];
  state.view.pending.clear();
  viewport.setSelection(state.view);
}

function onClick(ev) {
  const hit = viewport.pick(ev);
  const additive = ev.shiftKey;

  switch (state.tool) {
    case 'select': {
      if (hit.type === 'vertex') selectVertex(hit.id, additive);
      else if (hit.type === 'face' && hit.faceId) {
        if (!additive) clearSelection();
        state.view.faces.add(hit.faceId);
      } else if (hit.type === 'edge') {
        if (!additive) clearSelection();
        state.view.edges.add(hit.edgeIndex);
      } else if (!additive) {
        clearSelection();
      }
      afterSelectionChange();
      break;
    }
    case 'vertex':
      if (hit.type === 'vertex') {
        clearSelection();
        state.view.verts.add(hit.id);
        afterSelectionChange();
      } else if (hit.point) {
        placeAt(hit.point);
      }
      break;
    case 'edge': {
      if (hit.type === 'vertex') {
        if (state.pending.length && hit.id === state.pending[0] && state.pending.length >= 3) {
          commitChain(); // clicked the first vertex: close the loop
          break;
        }
        if (state.pending.length) {
          const last = state.pending[state.pending.length - 1];
          mutate('draw edge', () => addEdge(state.doc, last, hit.id));
          state.pending.shift();
        }
        state.pending.push(hit.id);
        state.view.pending = new Set(state.pending);
        viewport.setSelection(state.view);
      } else {
        cancelChain();
        toast('Edge tool: click vertices to connect them.', 'info');
      }
      break;
    }
    case 'face': {
      if (hit.type === 'vertex') {
        if (state.pending.length >= 3 && hit.id === state.pending[0]) {
          commitChain();
          break;
        }
        if (!state.pending.includes(hit.id)) {
          state.pending.push(hit.id);
          state.view.pending = new Set(state.pending);
          viewport.setSelection(state.view);
        }
      } else if (hit.type === 'ground') {
        placeAt(hit.point);
        state.view.pending = new Set(state.pending);
        viewport.setSelection(state.view);
      } else {
        cancelChain();
      }
      break;
    }
    case 'move': {
      if (hit.type === 'vertex') {
        clearSelection();
        state.view.verts.add(hit.id);
        afterSelectionChange();
      }
      break;
    }
  }
}

function onPointerDown(ev) {
  if (ev.button !== 0) return;
  const hit = viewport.pick(ev);
  if (state.tool === 'move' && hit.type === 'vertex') {
    if (!state.view.verts.has(hit.id)) {
      clearSelection();
      state.view.verts.add(hit.id);
      afterSelectionChange();
    }
    state.hist.begin();
    state.drag = {
      id: hit.id,
      plane: viewport.dragPlane(hit.point),
      start: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
      moved: false,
    };
    viewport.controls.enabled = false;
    ev.preventDefault();
  }
}

function onPointerMove(ev) {
  if (state.drag) {
    const p = viewport.rayOnPlane(state.drag.plane, ev);
    if (!p) return;
    const x = snapValue(p.x);
    const y = snapValue(p.y);
    const z = snapValue(p.z);
    const v = getVertex(state.doc, state.drag.id);
    if (v && (v.x !== x || v.y !== y || v.z !== z)) {
      state.drag.moved = true;
      setVertexPosition(state.doc, state.drag.id, x, y, z);
      state.mesh = buildMesh(state.doc);
      viewport.sync(state.doc, state.mesh, state.view);
      readout(x, y, z);
    }
    return;
  }
  const hit = viewport.pick(ev);
  const hover = hit.type === 'vertex' ? hit.id : null;
  if (hover !== state.view.hoverVertex) {
    state.view.hoverVertex = hover;
    viewport.setSelection(state.view);
  }
  canvas.style.cursor = hover ? 'grab' : hit.type === 'face' ? 'crosshair' : 'default';  if (hit.point) readout(hit.point.x, hit.point.y, hit.point.z);
}

function onPointerUp() {
  if (!state.drag) return;
  const wasDrag = state.drag.moved;
  state.drag = null;
  viewport.controls.enabled = true;
  if (wasDrag) {
    state.hist.commit('move vertex');
    sync();
  } else {
    state.hist.touch();
  }
}

/* ------------------------------------------------------------------ *
 * Ops
 * ------------------------------------------------------------------ */

function opDelete() {
  const sel = {
    verts: [...state.view.verts],
    edges: selectedEdgeIdPairs(),
    faces: [...state.view.faces],
  };
  if (!sel.verts.length && !sel.edges.length && !sel.faces.length) {
    toast('Select something to delete.', 'warn');
    return;
  }
  mutate('delete', () => deleteSelection(state.doc, sel));
  clearSelection();
  sync();
}

function opExtrude() {
  const faces = [...state.view.faces];
  if (!faces.length) {
    toast('Select faces to extrude.', 'warn');
    return;
  }
  const res = mutate('extrude', () => extrudeFaces(state.doc, faces, state.extrudeDistance));
  if (res?.error) toast(res.error, 'warn');
  else if (res) {
    clearSelection();
    for (const f of res.faces) state.view.faces.add(f.id);
    for (const id of faces) state.view.faces.add(id);
    sync();
    toast(`Extruded ${res.moved} face${res.moved === 1 ? '' : 's'} (+${res.created} walls).`, 'ok');
  }
}

function opFillEdges() {
  const pairs = selectedEdgeIdPairs();
  if (!pairs.length) {
    toast('Select a closed loop of edges first.', 'warn');
    return;
  }
  const res = mutate('fill loop', () => fillEdgeLoop(state.doc, pairs));
  if (res?.error) toast(res.error, 'warn');
  else if (res?.face) {
    clearSelection();
    state.view.faces.add(res.face.id);
    sync();
    toast('Face filled.', 'ok');
  }
}

function opFaceFromSelection() {
  const ids = [...state.view.verts];
  if (ids.length < 3) {
    toast('Select 3 or more vertices.', 'warn');
    return;
  }
  const loop = orderRing(state.doc, ids);
  if (!loop) {
    toast('Could not order those vertices into a ring.', 'warn');
    return;
  }
  const f = mutate('face from vertices', () => addFace(state.doc, loop));
  if (!f) toast('Those vertices cannot form a face.', 'warn');
}

function opWeld() {
  const eps = state.snap > 0 ? state.snap * 0.5 : 1e-4;
  const res = mutate('weld vertices', () => weldVertices(state.doc, eps));
  toast(res.merged ? `Welded ${res.merged} vertices.` : 'Nothing within tolerance to weld.', res.merged ? 'ok' : 'info');
}

function opSnapGrid() {
  if (!state.snap) {
    toast('Turn on grid snap first (G).', 'warn');
    return;
  }
  const ids = state.view.verts.size ? [...state.view.verts] : null;
  const res = mutate('snap to grid', () => snapVerticesToGrid(state.doc, state.snap, ids));
  toast(`Snapped ${res.moved} vertices.`, 'ok');
}

function opUnify() {
  const res = mutate('unify winding', () => unifyWinding(state.doc));
  toast(`Winding unified (${res.flipped} flipped).`, 'ok');
}

function opCenter() {
  mutate('center on origin', () => centerOnOrigin(state.doc));
  sync(true);
}

function opNew(builder, label) {
  state.doc = builder();
  state.hist = createHistory(state.doc);
  clearSelection();
  cancelChain();
  sync(true);
  toast(`${label} created.`, 'ok');
}

/* ------------------------------------------------------------------ *
 * Import / export
 * ------------------------------------------------------------------ */

async function doExportJSON() {
  const text = exportJSON(state.doc, state.mesh);
  download(new Blob([text], { type: 'application/json' }), `${safeName(state.doc.name, 'model')}.vforge.json`);
  toast('JSON exported.', 'ok');
}

async function doExportGLB() {
  try {
    const blob = await exportGLB(viewport, state.doc);
    download(blob, `${safeName(state.doc.name, 'model')}.glb`);
    toast('GLB exported.', 'ok');
  } catch (err) {
    toast(`GLB export failed: ${err.message}`, 'err');
  }
}

async function doImport(file) {
  if (!file) return;
  try {
    const doc = await readJSONFile(file);
    state.doc = doc;
    state.hist = createHistory(state.doc);
    clearSelection();
    cancelChain();
    sync(true);
    toast(`Loaded ${file.name} (${doc.vertices.length} vertices).`, 'ok');
  } catch (err) {
    toast(`Import failed: ${err.message}`, 'err');
  }
}

/* ------------------------------------------------------------------ *
 * Import flow: pick -> options -> parse (off the click) -> apply
 * ------------------------------------------------------------------ */

const dlg = {
  el: null,
  pending: null,
};

const NATIVE_EXT = new Set(['json']);

function beginImport(file) {
  // Native documents need no options: they are already in our exact format.
  if (NATIVE_EXT.has(extOf(file.name))) {
    doImport(file);
    return;
  }
  dlg.pending = file;
  const isSTL = extOf(file.name) === 'stl';
  q('#imp-file').textContent = file.name;
  q('#imp-preview').textContent = `${(file.size / 1024).toFixed(0)} KB`;
  q('#imp-note').textContent = 'STL and CAD files are usually Z-up; glTF, OBJ and PLY are Y-up.';
  // STL and CAD exports are conventionally Z-up; everything else here is Y-up.
  q('#imp-up').value = isSTL ? 'z-up' : 'y-up';
  q('#imp-scale').value = '1';
  q('#imp-merge').checked = true;
  q('#imp-edges').checked = false;
  q('#importdlg').hidden = false;
  q('#imp-ok').focus();
}

function importOptions() {
  const weldSel = q('#imp-weld').value;
  return {
    up: q('#imp-up').value,
    scale: Number(q('#imp-scale').value) || 1,
    fit: Number(q('#imp-fit').value) || null,
    weld: weldSel === 'auto' ? true : Number(weldSel),
    mergePolys: q('#imp-merge').checked,
    keepEdges: q('#imp-edges').checked,
    mode: qa('[name="imp-mode"]').find((r) => r.checked)?.value || 'replace',
    showHandles: q('#imp-handles').checked,
  };
}

function closeImportDialog() {
  dlg.pending = null;
  q('#importdlg').hidden = true;
}

q('#imp-ok').addEventListener('click', () => confirmImport());
q('#imp-cancel').addEventListener('click', () => closeImportDialog());
q('#importdlg').addEventListener('pointerdown', (ev) => {
  if (ev.target === q('#importdlg')) closeImportDialog();
});
// Escape backs out of the dialog without also cancelling a chain / clearing the
// selection underneath, so swallow the event before the app's key handler runs.
window.addEventListener(
  'keydown',
  (ev) => {
    if (q('#importdlg').hidden) return;
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      ev.preventDefault();
      closeImportDialog();
    } else if (ev.key === 'Enter' && ev.target.matches('button, select')) {
      ev.stopPropagation();
      confirmImport();
    }
  },
  true,
);

async function confirmImport() {
  const file = dlg.pending;
  if (!file) return;
  dlg.pending = null;
  const opts = importOptions();
  q('#importdlg').hidden = true;
  q('#stage').classList.add('importing');
  toast(`Importing ${file.name}…`, 'info');
  // Let the toast paint before a parse that can take a second or two.
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  try {
    const { doc, stats } = await importFile(file, { ...opts, name: docNameFor(file) });
    if (opts.mode === 'merge') {
      state.hist.begin();
      mergeIntoCurrent(doc);
      if (!state.hist.commit(`import ${stats.vertices} verts`)) {
        state.hist.touch();
      }
    } else {
      state.doc = doc;
      state.hist = createHistory(state.doc);
    }
    clearSelection();
    cancelChain();

    // Big meshes: handles and dense wire overlays make the editor unusable, so
    // start with them off and let the user opt back in.
    if (stats.large && !opts.showHandles) {
      state.show.handles = false;
      viewport.setOptions(state.show);
      syncToggles();
    }

    sync(true);
    const bits = [`${stats.vertices} verts`, `${stats.faces} faces`];
    if (stats.edges) bits.push(`${stats.edges} edges`);
    if (stats.merged) bits.push(`${stats.merged} welded`);
    if (stats.polygonGroups) bits.push(`${stats.polygonGroups} polys rebuilt`);
    toast(`${file.name}: ${bits.join(', ')}.`, 'ok');
    if (stats.note) toast(`${stats.note}${stats.large ? ' Large mesh: vertex handles are off (press H).' : ''}`, 'info');
    else if (stats.large) toast('Large mesh: vertex handles are off - press H to show them.', 'info');
    else if (!opts.showHandles && state.show.handles) {
      // no-op: handles stay on for small imports
    }
  } catch (err) {
    toast(`Import failed: ${err.message}`, 'err');
  } finally {
    q('#stage').classList.remove('importing');
  }
}

function docNameFor(file) {
  return stemOf(file.name) || 'Imported';
}

/**
 * Append an imported document's geometry into the live one. Offsets it clear of
 * the origin so two models do not perfectly overlap, then welds nothing - the
 * user can do that deliberately.
 */
function mergeIntoCurrent(incoming) {
  const base = state.doc;
  const m = new Map(); // incoming vertex id -> new id
  const b = boundsOf(base.vertices);
  const offset = b.radius > 0 ? b.radius * 2 + 1 : 2;
  for (const v of incoming.vertices) {
    const nv = addVertex(base, { x: v.x + offset, y: v.y, z: v.z });
    m.set(v.id, nv.id);
  }
  for (const e of incoming.edges) {
    if (m.has(e.a) && m.has(e.b)) addEdge(base, m.get(e.a), m.get(e.b));
  }
  for (const f of incoming.faces) {
    if (f.loop.every((id) => m.has(id))) addFace(base, f.loop.map((id) => m.get(id)));
  }
}

let autosaveTimer = 0;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ name: state.doc.name, doc: state.doc }));
    } catch {
      /* quota or private mode: autosave is best-effort */
    }
  }, 600);
}

function restoreAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    const doc = parsed.doc;
    if (!doc || !Array.isArray(doc.vertices)) return false;
    state.doc = doc;
    state.hist = createHistory(state.doc);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * HUD
 * ------------------------------------------------------------------ */

function readout(x, y, z) {
  const r = (v) => (Number.isFinite(v) ? v.toFixed(3) : '—');
  q('#readout').textContent = `x ${r(x)}  y ${r(y)}  z ${r(z)}`;
}

function updateHUD() {
  const d = state.doc;
  const m = state.mesh;
  const sel = state.view;
  q('#stat-v').textContent = d.vertices.length;
  q('#stat-e').textContent = m ? m.edgePairs.length : d.edges.length;
  q('#stat-f').textContent = d.faces.length;
  q('#stat-t').textContent = m ? m.triangleCount : 0;
  q('#stat-sel').textContent = `V ${sel.verts.size} · E ${sel.edges.size} · F ${sel.faces.size}`;

  const tight = d.faces.length > 0 && isWatertight(d);
  const badge = q('#stat-tight');
  badge.textContent = tight ? 'watertight' : d.faces.length ? 'open mesh' : 'no faces';
  badge.classList.toggle('good', tight);
  badge.classList.toggle('dim', !tight);

  const v = validate(d);
  const list = q('#problems');
  const items = [...v.errors.map((t) => ['err', t]), ...v.warnings.map((t) => ['warn', t])];
  list.innerHTML = '';
  for (const [kind, text] of items.slice(0, 6)) {
    const li = document.createElement('li');
    li.className = kind;
    li.textContent = text;
    list.appendChild(li);
  }
  list.style.display = items.length ? '' : 'none';

  // Inspector: one vertex selected -> editable coordinates.
  const box = q('#inspector');
  const ids = [...sel.verts];
  if (ids.length === 1) {
    const vtx = getVertex(d, ids[0]);
    box.hidden = false;
    if (vtx && !box.dataset.editing) {
      q('#px').value = vtx.x;
      q('#py').value = vtx.y;
      q('#pz').value = vtx.z;
    }
    q('#vlabel').textContent = vtx ? `vertex ${vtx.id}` : 'vertex';
  } else {
    box.hidden = true;
  }
}

let toastTimer = 0;
function toast(msg, kind = 'info') {
  const el = q('#toast');
  el.textContent = msg;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 2600);
}

function setTool(tool) {
  state.tool = tool;
  cancelChain();
  qa('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  q('#hint').textContent = HINTS[tool] || '';
}

const HINTS = {
  select: 'Click to select · Shift-click adds · drag to orbit · wheel to zoom',
  vertex: 'Click anywhere to drop a vertex on the surface under the cursor',
  edge: 'Click vertices to chain edges · click the first one to close the loop',
  face: 'Click vertices in order · Enter or click the first one to make the face',
  move: 'Drag a vertex · arrow keys nudge · coordinates in the panel',
};

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

const canvas = viewport.renderer.domElement; // three.js owns this element
canvas.id = 'gl';
let downAt = null;
canvas.addEventListener('pointerdown', (ev) => {
  downAt = { x: ev.clientX, y: ev.clientY, t: performance.now() };
  onPointerDown(ev);
});
canvas.addEventListener('pointermove', onPointerMove);
window.addEventListener('pointerup', (ev) => {
  onPointerUp();
  if (!downAt || state.drag) {
    downAt = null;
    return;
  }
  const moved = Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y);
  const quick = performance.now() - downAt.t < 400;
  downAt = null;
  if (ev.target === canvas && moved < 4 && quick) onClick(ev);
});
canvas.addEventListener('dblclick', (ev) => {
  if (ev.shiftKey) {
    const hit = viewport.pick(ev);
    if (hit.type === 'face' && hit.faceId) {
      // Shift-double-click: select the whole face loop.
      const f = state.doc.faces.find((x) => x.id === hit.faceId);
      if (f) {
        clearSelection();
        for (const id of f.loop) state.view.verts.add(id);
        afterSelectionChange();
      }
    }
  }
});

qa('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

qa('[data-op]').forEach((b) =>
  b.addEventListener('click', () => {
    const op = b.dataset.op;
    if (op === 'delete') opDelete();
    else if (op === 'extrude') opExtrude();
    else if (op === 'fill') opFillEdges();
    else if (op === 'face-sel') opFaceFromSelection();
    else if (op === 'weld') opWeld();
    else if (op === 'snap') opSnapGrid();
    else if (op === 'unify') opUnify();
    else if (op === 'flip') mutate('flip faces', () => flipAllFaces(state.doc));
    else if (op === 'center') opCenter();
    else if (op === 'frame') viewport.frame(state.mesh.bounds.center, state.mesh.bounds.radius);
    else if (op === 'undo') {
      const e = state.hist.undo();
      if (e) {
        pruneSelection();
        sync();
        toast(`Undo: ${e.label}`, 'info');
      } else toast('Nothing to undo.', 'info');
    } else if (op === 'redo') {
      const e = state.hist.redo();
      if (e) {
        pruneSelection();
        sync();
        toast(`Redo: ${e.label}`, 'info');
      } else toast('Nothing to redo.', 'info');
    } else if (op === 'cube') opNew(() => makeCube(), 'Cube');
    else if (op === 'plane') opNew(() => makePlane(), 'Grid plane');
    else if (op === 'tetra') opNew(() => makeTetra(), 'Tetra');
    else if (op === 'clear') opNew(() => createDocument(q('#docname').value || 'Untitled'), 'Empty document');
    else if (op === 'export-json') doExportJSON();
    else if (op === 'export-glb') doExportGLB();
    else if (op === 'import') q('#file').click();
    else if (op === 'shot') {
      const url = viewport.screenshot();
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeName(state.doc.name, 'model')}.png`;
      a.click();
      toast('Screenshot saved.', 'ok');
    }
  }),
);

q('#file').addEventListener('change', (ev) => {
  const file = ev.target.files[0];
  ev.target.value = ''; // allow re-picking the same file
  if (file) beginImport(file);
});

q('#docname').addEventListener('input', (ev) => {
  state.doc.name = ev.target.value || 'Untitled';
  scheduleAutosave();
});

q('#snap').addEventListener('change', (ev) => {
  state.snap = Number(ev.target.value);
});

q('#dist').addEventListener('change', (ev) => {
  state.extrudeDistance = Math.abs(Number(ev.target.value) || 0.25);
});

for (const id of ['#px', '#py', '#pz']) {
  const el = q(id);
  el.addEventListener('focus', () => (q('#inspector').dataset.editing = '1'));
  el.addEventListener('blur', () => {
    delete q('#inspector').dataset.editing;
    updateHUD();
  });
  el.addEventListener('keydown', (ev) => ev.stopPropagation());
}

q('#apply-coord').addEventListener('click', () => {
  const ids = [...state.view.verts];
  if (ids.length !== 1) return;
  const x = Number(q('#px').value);
  const y = Number(q('#py').value);
  const z = Number(q('#pz').value);
  if (![x, y, z].every(Number.isFinite)) {
    toast('Coordinates must be numbers.', 'warn');
    return;
  }
  mutate('set coordinates', () => setVertexPosition(state.doc, ids[0], x, y, z));
  q('#inspector').dataset.editing = '';
  updateHUD();
});

qa('[data-view]').forEach((b) => b.addEventListener('click', () => viewport.setCameraPreset(b.dataset.view)));

/* Display toggles: the checkboxes and the H/W/X keys drive the same state. */
for (const [id, key] of [['#t-handles', 'handles'], ['#t-wire', 'wire'], ['#t-shade', 'shade']]) {
  q(id).addEventListener('change', (ev) => {
    state.show[key] = ev.target.checked;
    viewport.setOptions(state.show);
  });
}

function syncToggles() {
  q('#t-handles').checked = state.show.handles;
  q('#t-wire').checked = state.show.wire;
  q('#t-shade').checked = state.show.shade;
}

window.addEventListener('keydown', (ev) => {
  if (ev.target.matches('input, select, textarea')) return;
  const k = ev.key.toLowerCase();

  if ((ev.ctrlKey || ev.metaKey) && k === 'z') {
    ev.preventDefault();
    q(`[data-op="${ev.shiftKey ? 'redo' : 'undo'}"]`).click();
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && k === 's') {
    ev.preventDefault();
    q('[data-op="export-json"]').click();
    return;
  }
  if (ev.ctrlKey || ev.metaKey) return;

  if (k === 'v') setTool('select');
  else if (k === 'b') setTool('vertex');
  else if (k === 'e') setTool('edge');
  else if (k === 'f') setTool('face');
  else if (k === 'm') setTool('move');
  else if (k === 'enter') commitChain();
  else if (k === 'escape') {
    cancelChain();
    clearSelection();
    afterSelectionChange();
  } else if (k === 'delete' || k === 'backspace') opDelete();
  else if (k === 'g') {
    state.snap = SNAP_STEPS[(SNAP_STEPS.indexOf(state.snap) + 1) % SNAP_STEPS.length];
    q('#snap').value = String(state.snap);
    toast(state.snap ? `Grid snap ${state.snap}` : 'Grid snap off', 'info');
  } else if (k === 'h') {
    state.show.handles = !state.show.handles;
    viewport.setOptions(state.show);
    syncToggles();
  } else if (k === 'w') {
    state.show.wire = !state.show.wire;
    viewport.setOptions(state.show);
    syncToggles();
  } else if (k === 'x') {
    state.show.shade = !state.show.shade;
    viewport.setOptions(state.show);
    syncToggles();
    toast(state.show.shade ? 'Shaded' : 'Wire only', 'info');
  } else if (k === 'home') viewport.frame(state.mesh.bounds.center, state.mesh.bounds.radius);
  else if (['1', '2', '3', '4', '5', '6', '0'].includes(k)) {
    const map = { 0: 'persp', 1: 'front', 2: 'right', 3: 'top', 4: 'back', 5: 'left', 6: 'bottom' };
    viewport.setCameraPreset(map[k]);
  } else if (ev.key.startsWith('Arrow')) {
    nudge(ev);
  }
});

function nudge(ev) {
  const ids = [...state.view.verts];
  if (!ids.length) return;
  ev.preventDefault();
  const step = state.snap || (ev.shiftKey ? 0.01 : 0.1);
  const d = { ArrowLeft: [-1, 0, 0], ArrowRight: [1, 0, 0], ArrowUp: [0, 1, 0], ArrowDown: [0, -1, 0] }[ev.key];
  if (!d) return;
  mutate('nudge', () => {
    for (const id of ids) {
      const v = getVertex(state.doc, id);
      setVertexPosition(state.doc, id, v.x + d[0] * step, v.y + d[1] * step, v.z + d[2] * step);
    }
  });
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

setTool('select');
const restored = restoreAutosave();
if (!restored) makeCube(state.doc);
q('#docname').value = state.doc.name || 'Untitled';
sync(true);
toast(restored ? 'Restored your last session.' : 'Cube seeded — press B to place vertices.', 'info');
window.__vf = { state, viewport }; // debugging handle
