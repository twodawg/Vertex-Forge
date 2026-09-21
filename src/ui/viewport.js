/**
 * The 3D viewer. Owns all three.js state and translates pointer events into
 * picking results; it never mutates the document. Keeping rendering here and
 * behaviour in app.js means the document core stays testable headlessly.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { newellNormal } from '../core/geometry.js';

const HANDLE_PX = 9; // on-screen diameter of a vertex handle
const HIT_PX = 11; // pick radius around a handle
const EDGE_PREFER_PX = 6; // closer than this, an edge outranks the face behind it

export class Viewport {
  constructor(container) {
    this.container = container;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x14171c);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 500);
    this.camera.position.set(3.2, 2.6, 3.6);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.target.set(0, 0, 0);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();

    /* ---- studio-ish light rig: key + fill + rim so faces read as volumes ---- */
    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x2a2440, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(4, 6, 3);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.6);
    fill.position.set(-5, 2, -3);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffcc88, 0.8);
    rim.position.set(0, -3, -5);
    this.scene.add(rim);

    /* ---- static references ---- */
    this.grid = new THREE.GridHelper(10, 20, 0x3d4654, 0x232a33);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.55;
    this.scene.add(this.grid);

    this.axes = new THREE.AxesHelper(1.1);
    this.scene.add(this.axes);

    /* ---- solid mesh ---- */
    this.solidGeo = new THREE.BufferGeometry();
    // One shared material for uncoloured documents; setMaterials() swaps in an
    // array of per-colour materials when the document actually uses any.
    this.baseMat = new THREE.MeshStandardMaterial({
      color: 0xc9d2e3,
      roughness: 0.42,
      metalness: 0.05,
      flatShading: true,
      side: THREE.DoubleSide,
    });
    this.solidMats = [this.baseMat];
    this.solid = new THREE.Mesh(this.solidGeo, this.solidMats);
    this.solid.frustumCulled = false;
    this.scene.add(this.solid);

    /* ---- highlighted faces (selection / hover), rendered on top of the solid ---- */
    this.hiGeo = new THREE.BufferGeometry();
    this.hiMat = new THREE.MeshBasicMaterial({
      color: 0x5cc8ff,
      transparent: true,
      opacity: 0.42,
      side: THREE.DoubleSide,
      depthTest: false,
    });
    this.highlight = new THREE.Mesh(this.hiGeo, this.hiMat);
    this.highlight.frustumCulled = false;
    this.highlight.renderOrder = 3;
    this.scene.add(this.highlight);

    /* ---- wireframe overlay ---- */
    this.lineGeo = new THREE.BufferGeometry();
    this.lineMat = new THREE.LineBasicMaterial({ color: 0x0d1117, transparent: true, opacity: 0.8 });
    this.wire = new THREE.LineSegments(this.lineGeo, this.lineMat);
    this.wire.frustumCulled = false;
    this.wire.renderOrder = 2;
    this.scene.add(this.wire);

    this.selLineGeo = new THREE.BufferGeometry();
    this.selLineMat = new THREE.LineBasicMaterial({ color: 0x5cc8ff, depthTest: false });
    this.selWire = new THREE.LineSegments(this.selLineGeo, this.selLineMat);
    this.selWire.frustumCulled = false;
    this.selWire.renderOrder = 4;
    this.scene.add(this.selWire);

    /* ---- pending edge/face chain, drawn as one bright polyline ---- */
    this.chainGeo = new THREE.BufferGeometry();
    this.chainMat = new THREE.LineBasicMaterial({ color: 0xffb020, depthTest: false, toneMapped: false });
    this.chain = new THREE.Line(this.chainGeo, this.chainMat);
    this.chain.frustumCulled = false;
    this.chain.renderOrder = 6;
    this.chain.visible = false;
    this.scene.add(this.chain);

    /* ---- face-normal overlay: one segment per face, from centroid along the
       winding-derived Newell normal. Outward-ish green, inward red - a quick
       visual proxy for "is this face pointing the wrong way". ---- */
    this.normalGeo = new THREE.BufferGeometry();
    this.normalMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
      toneMapped: false,
    });
    this.normals = new THREE.LineSegments(this.normalGeo, this.normalMat);
    this.normals.frustumCulled = false;
    this.normals.renderOrder = 5;
    this.normals.visible = false;
    this.scene.add(this.normals);

    /* ---- vertex handles: one InstancedMesh keeps 10k handles cheap ---- */
    this.handleGeo = new THREE.SphereGeometry(1, 14, 10);
    this.handleMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.handles = new THREE.InstancedMesh(this.handleGeo, this.handleMat, 16);
    this.handles.count = 0; // nothing to draw until the first sync
    this.handles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.handles.frustumCulled = false;
    this.handles.renderOrder = 5;
    this.scene.add(this.handles);

    this._m4 = new THREE.Matrix4();
    this._c = new THREE.Color();
    this._v = new THREE.Vector3();
    this._plane = new THREE.Plane();

    this.mesh = null; // latest buildMesh() result
    this.doc = null;
    this.view = { verts: new Set(), edges: new Set(), faces: new Set() };
    this.opts = { handles: true, wire: true, shade: true, normals: false };

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(container);
    this.resize();

    this._frame = this._frame.bind(this);
    requestAnimationFrame(this._frame);
  }

  _frame() {
    this.controls.update();
    // Handles track screen size, so they must be re-scaled every frame.
    if (this.mesh && this.mesh.positions.length) this._layoutHandles();
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this._frame);
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** World units covered by one CSS pixel at `dist` from the camera. */
  worldPerPixel(dist) {
    const h = this.container.clientHeight || 1;
    return (2 * dist * Math.tan(((this.camera.fov / 2) * Math.PI) / 180)) / h;
  }

  _layoutHandles() {
    const pos = this.mesh.positions;
    const n = pos.length / 3;
    if (n > this.handles.instanceMatrix.count) {
      // Grow the instance buffer. Must detach the old mesh first, otherwise it
      // stays in the scene forever and doubles the draw cost every resize-up.
      this.scene.remove(this.handles);
      this.handles.dispose();
      this.handles = new THREE.InstancedMesh(this.handleGeo, this.handleMat, Math.ceil(n * 1.5) + 16);
      this.handles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.handles.frustumCulled = false;
      this.handles.renderOrder = 5;
      this.handles.visible = this.opts.handles;
      this.scene.add(this.handles);
    }
    this.handles.count = n;
    if (!n) return;

    const cam = this.camera;
    const base = HANDLE_PX * 0.5;
    for (let i = 0; i < n; i++) {
      this._v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      const r = base * this.worldPerPixel(cam.position.distanceTo(this._v)) || 0.02;
      this._m4.makeScale(r, r, r);
      this._m4.setPosition(this._v);
      this.handles.setMatrixAt(i, this._m4);

      const id = this.idByIndex?.get(i);
      const selected = id && this.view.verts.has(id);
      const hovered = id && id === this.view.hoverVertex;
      this._c.setHex(selected ? 0x5cc8ff : hovered ? 0xffd166 : 0xf2f6ff);
      this.handles.setColorAt(i, this._c);
    }
    this.handles.instanceMatrix.needsUpdate = true;
    if (this.handles.instanceColor) this.handles.instanceColor.needsUpdate = true;
  }

  /* ------------------------------------------------------------------ *
   * Rebuild from the document
   * ------------------------------------------------------------------ */
  sync(doc, mesh, view) {
    this.doc = doc;
    this.mesh = mesh;
    if (view) this.view = view;

    this.solidGeo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    this.solidGeo.setIndex(mesh.indices);
    this.solidGeo.clearGroups();
    if (mesh.groups) {
      for (const g of mesh.groups) this.solidGeo.addGroup(g.start, g.count, g.materialIndex);
    }
    this._applyMaterials(mesh.colors);
    this.solidGeo.computeBoundingSphere();
    this.solidGeo.computeVertexNormals();
    this.solid.visible = this.opts.shade && mesh.indices.length > 0;

    // index -> vertex id, for handle picking
    this.idByIndex = new Map();
    for (const [id, i] of mesh.vertexIndex) this.idByIndex.set(i, id);

    this._rebuildWire();
    this._rebuildChain();
    this._rebuildHighlight();
    this._rebuildNormals();
    this._layoutHandles();
  }

  /**
   * Keep one MeshStandardMaterial per distinct face colour, reused between
   * syncs so editing a model does not thrash shader programs every frame.
   * Index N corresponds to mesh.colors[N], which is what the geometry groups
   * reference as `materialIndex`.
   */
  _applyMaterials(colors) {
    const list = colors?.length ? colors : ['#c9d2e3'];
    const mats = this.solidMats;

    // Drop extras first, so a shrunk palette never leaves a stale material
    // referenced by an index we are about to hand to three.js.
    while (mats.length > list.length) {
      const m = mats.pop();
      if (m !== this.baseMat) m.dispose();
    }
    for (let i = 0; i < list.length; i++) {
      if (!mats[i]) mats[i] = this.baseMat.clone();
      const mat = mats[i];
      if (mat.userData.hex !== list[i]) {
        mat.color.set(list[i]);
        mat.userData.hex = list[i];
      }
    }
    // A Mesh with an ARRAY material renders only what geometry.groups covers -
    // with no groups, three.js silently draws nothing. Uncoloured documents
    // have groups:null, so hand them the single material instead.
    this.solid.material = mats.length === 1 ? mats[0] : mats;
  }

  /** Replace the selection/hover/pending state and refresh the overlays. */
  setSelection(view) {
    this.view = view;
    if (this.mesh) {
      this._rebuildHighlight();
      this._rebuildChain();
      this._layoutHandles();
    }
  }

  /** Bright polyline through the staged vertices of the edge/face chain. */
  _rebuildChain() {
    const ids = this.view?.pending;
    if (!ids || !ids.size || !this.mesh) {
      this.chain.visible = false;
      return;
    }
    const list = [...ids];
    const pts = [];
    for (const id of list) {
      const i = this.mesh.vertexIndex.get(id);
      if (i === undefined) continue;
      pts.push(this.mesh.positions[i * 3], this.mesh.positions[i * 3 + 1], this.mesh.positions[i * 3 + 2]);
    }
    this.chain.visible = pts.length >= 6;
    this.chainGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
  }

  setOptions(opts) {
    Object.assign(this.opts, opts);
    this.handles.visible = this.opts.handles;
    this.wire.visible = this.opts.wire;
    if (this.doc && this.mesh) {
      this.solid.visible = this.opts.shade && this.mesh.indices.length > 0;
      this._rebuildHighlight();
      this._rebuildNormals();
    }
  }

  _rebuildWire() {
    const src = this.mesh.positions;
    const ei = this.mesh.edgeIndices;
    // Two endpoints × three components per edge index pair.
    const arr = new Float32Array(ei.length * 3);
    let o = 0;
    for (let i = 0; i < ei.length; i += 2) {
      for (const idx of [ei[i], ei[i + 1]]) {
        arr[o++] = src[idx * 3];
        arr[o++] = src[idx * 3 + 1];
        arr[o++] = src[idx * 3 + 2];
      }
    }
    this.lineGeo.setAttribute('position', new THREE.BufferAttribute(arr, 3));

    // Selected edges as their own bright pass.
    const sel = [];
    const pairs = this.mesh.edgePairs || [];
    pairs.forEach(([a, b], i) => {
      if (!this.view.edges.has(i)) return;
      for (const idx of [a, b]) sel.push(src[idx * 3], src[idx * 3 + 1], src[idx * 3 + 2]);
    });
    this.selLineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sel), 3));
  }

  _rebuildHighlight() {
    const wanted = new Set([...this.view.faces]);
    const tris = [];
    for (const [fid, list] of this.mesh.faceTriangles) {
      if (!wanted.has(fid)) continue;
      for (const t of list) tris.push(t[0], t[1], t[2]);
    }
    this.hiGeo.setAttribute('position', this.solidGeo.getAttribute('position'));
    this.hiGeo.setIndex(tris);
    this.highlight.visible = tris.length > 0;
  }

  /**
   * One line per face: centroid to centroid+normal. The normal is the Newell
   * normal of the face ring - the same derivation the shading uses - so what
   * you see is exactly what the renderer thinks the face points at. Green when
   * the normal points away from the model centre, red when it points inward,
   * which makes inverted or inconsistent winding obvious at a glance.
   *
   * "Setting a normal" in this app means changing the ring winding, so the
   * Flip / Unify winding ops are the editor; this is the feedback layer.
   */
  _rebuildNormals() {
    if (!this.opts.normals || !this.doc || !this.mesh || !this.doc.faces.length) {
      this.normals.visible = false;
      return;
    }
    const pos = this.mesh.positions;
    const vi = this.mesh.vertexIndex;
    const c = this.mesh.bounds.center;
    const len = Math.max(this.mesh.bounds.radius * 0.28, 1e-4);

    const verts = [];
    const cols = [];
    const out = new THREE.Color(0x4fd07a);
    const inw = new THREE.Color(0xff5a5a);

    for (const f of this.doc.faces) {
      const pts = [];
      for (const id of f.loop) {
        const i = vi.get(id);
        if (i === undefined) continue;
        pts.push([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
      }
      if (pts.length < 3) continue;
      const n = newellNormal(pts);
      const mag = Math.hypot(n[0], n[1], n[2]);
      if (mag < 1e-12) continue; // degenerate ring: no meaningful normal
      const ux = n[0] / mag;
      const uy = n[1] / mag;
      const uz = n[2] / mag;

      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (const p of pts) {
        cx += p[0];
        cy += p[1];
        cz += p[2];
      }
      cx /= pts.length;
      cy /= pts.length;
      cz /= pts.length;

      // Outward if the normal agrees with "away from the model centre".
      const outward = ux * (cx - c[0]) + uy * (cy - c[1]) + uz * (cz - c[2]) >= 0;
      const col = outward ? out : inw;

      verts.push(cx, cy, cz, cx + ux * len, cy + uy * len, cz + uz * len);
      cols.push(col.r, col.g, col.b, col.r, col.g, col.b);
    }

    this.normalGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    this.normalGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cols), 3));
    this.normals.visible = verts.length > 0;
  }

  /* ------------------------------------------------------------------ *
   * Picking
   * ------------------------------------------------------------------ */
  _ndc(ev) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    return { rect: r, width: r.width, height: r.height };
  }

  /**
   * Priority pick: handle > face > edge > ground. Returns a discriminated
   * result the tools can act on without knowing anything about three.js.
   */
  pick(ev) {
    this._ndc(ev);
    this.raycaster.setFromCamera(this.pointer, this.camera);

    if (this.opts.handles && this.mesh && this.mesh.positions.length) {
      const hits = this.raycaster.intersectObject(this.handles, false);
      if (hits.length) {
        const i = hits[0].instanceId;
        const id = this.idByIndex.get(i);
        if (id) return { type: 'vertex', id, index: i, point: hits[0].point };
      }
    }

    // Edges sit on top of faces geometrically, so a near-miss on an edge wins
    // over the face behind it. Beyond EDGE_PREFER_PX the face takes priority.
    const edgeHit = this._pickEdge(ev);

    if (this.mesh && this.mesh.indices.length && (!edgeHit || edgeHit.distance > EDGE_PREFER_PX)) {
      const hits = this.raycaster.intersectObject(this.solid, false);
      if (hits.length) {
        const faceId = this.mesh.triFace[hits[0].faceIndex];
        return {
          type: 'face',
          faceId: faceId ?? null,
          triIndex: hits[0].faceIndex,
          distance: hits[0].distance,
          point: hits[0].point,
          normal: hits[0].face
            ? new THREE.Vector3()
                .copy(hits[0].face.normal)
                .transformDirection(this.camera.matrixWorld)
                .normalize()
            : null,
        };
      }
    }

    if (edgeHit) return edgeHit;

    // Fall back to the construction plane through the orbit target, facing the camera.
    const n = new THREE.Vector3();
    this.camera.getWorldDirection(n);
    this._plane.setFromNormalAndCoplanarPoint(n, this.controls.target);
    const p = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this._plane, p)) {
      return { type: 'ground', point: p };
    }
    return { type: 'none' };
  }

  /** Edge picking in screen space - far more reliable than ray/Line thresholds. */
  _pickEdge(ev) {
    const pairs = this.mesh?.edgePairs;
    if (!pairs?.length) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    this._ndc(ev);
    const mx = ((this.pointer.x + 1) / 2) * r.width;
    const my = ((1 - this.pointer.y) / 2) * r.height;

    const pos = this.mesh.positions;
    const px = new Float64Array((pos.length / 3) * 2);
    for (let i = 0; i < pos.length; i += 3) {
      this._v.set(pos[i], pos[i + 1], pos[i + 2]).project(this.camera);
      px[(i / 3) * 2] = ((this._v.x + 1) / 2) * r.width;
      px[(i / 3) * 2 + 1] = ((1 - this._v.y) / 2) * r.height;
    }

    let best = null;
    let bestD = HIT_PX;
    pairs.forEach(([a, b], i) => {
      const d = segDist(mx, my, px[a * 2], px[a * 2 + 1], px[b * 2], px[b * 2 + 1]);
      if (d < bestD) {
        bestD = d;
        best = { type: 'edge', edgeIndex: i, distance: d, a, b };
      }
    });
    return best;
  }

  /** Plane through `worldPoint` perpendicular to the view: the vertex-drag surface. */
  dragPlane(worldPoint) {
    const n = new THREE.Vector3();
    this.camera.getWorldDirection(n);
    return new THREE.Plane().setFromNormalAndCoplanarPoint(n, worldPoint);
  }

  rayOnPlane(plane, ev) {
    this._ndc(ev);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, out) ? out : null;
  }

  /* ------------------------------------------------------------------ *
   * Camera presets
   * ------------------------------------------------------------------ */
  frame(center = [0, 0, 0], radius = 1) {
    const c = new THREE.Vector3(...center);
    const r = Math.max(radius, 0.05);
    this.controls.target.copy(c);
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-9) dir.set(1, 0.7, 1);
    dir.normalize();
    const d = (r * 1.9) / Math.tan((this.camera.fov * Math.PI) / 360);
    this.camera.position.copy(c).addScaledVector(dir, Math.min(Math.max(d, 0.4), 200));
    this.camera.near = Math.max(d / 1000, 0.001);
    this.camera.far = d * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /** Move the camera to a named orthographic-style preset. */
  setCameraPreset(name) {
    const c = this.mesh?.bounds?.center ?? [0, 0, 0];
    const r = this.mesh?.bounds?.radius ?? 1;
    const d = (r * 1.9) / Math.tan((this.camera.fov * Math.PI) / 360) || 4;
    const dirs = {
      persp: [1, 0.72, 1.15],
      front: [0, 0, 1],
      back: [0, 0, -1],
      right: [1, 0, 0],
      left: [-1, 0, 0],
      top: [0, 1, 0.0001],
      bottom: [0, -1, 0.0001],
    };
    const dir = dirs[name];
    if (!dir) return false; // never move the camera on an unknown preset
    const v = new THREE.Vector3(...dir).normalize();
    this.controls.target.set(...c);
    this.camera.position.set(...c).addScaledVector(v, Math.max(d, 0.5));
    this.camera.updateProjectionMatrix();
    this.controls.update();
    return true;
  }

  /**
   * Snapshot of the shaded mesh for GLB export (no scene pollution kept).
   * Reuses the live geometry's colour groups, so painted faces export as
   * per-primitive materials rather than one flat grey.
   */
  buildExportMesh() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(this.mesh.positions), 3));
    g.setIndex([...this.mesh.indices]);
    g.computeVertexNormals();
    g.computeBoundingSphere();

    const colors = this.mesh.colors?.length ? this.mesh.colors : ['#c9d2e3'];
    const mats = colors.map(
      (hex) => new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: 0.5, metalness: 0, name: `face-${hex.slice(1)}` }),
    );

    let mesh;
    if (this.mesh.groups) {
      // One primitive per material keeps the exporter's output simple: glTF has
      // no per-triangle colour, so groups become grouped primitives.
      for (const grp of this.mesh.groups) g.addGroup(grp.start, grp.count, grp.materialIndex);
      mesh = new THREE.Mesh(g, mats);
    } else {
      mesh = new THREE.Mesh(g, mats[0]);
    }
    mesh.name = this.doc?.name || 'VertexForgeModel';
    mesh.userData.disposeMaterials = () => mats.forEach((m) => m.dispose());
    return mesh;
  }

  screenshot() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  dispose() {
    this._ro.disconnect();
    this.renderer.dispose();
  }
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
