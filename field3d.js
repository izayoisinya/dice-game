// ============================================================
// 3D 表示（試作）: 局地戦（設定「局地戦を3Dで表示」）と戦域図（設定「戦域図を3Dで表示」）
//   Three.js（vendor/three.min.js）は、どちらかをオンにしたときだけ読み込む
//   ルールや操作は今までのまま。いつものマス（#field / #smap の中、3D のときは隠す）を作ってから、その印（reach / target など）や
//   駒・隊を読み取って立体で描き直す。押したマスは onCellClick（局地戦）/ onSmapClick（戦域図）へ渡す
//   描く仕組みは Board3D（盤ひとつ分）にまとめ、局地戦と戦域図で同じものを使う
//   カメラ: 1本指（マウスはドラッグ）で移動、ピンチ（ホイール）で拡大縮小、2本指でひねると回転、2本指を上下にずらすと見下ろす角度
//   （マウスは右ドラッグで回転・角度）。⟲ ⟳ のボタンで 45°（六角は 60°）ずつ回す。「全体」で元の向きに戻す
// ============================================================

const F3_ELEV = 52 * Math.PI / 180;   // カメラの見下ろす角度（水平から）の初めの値
const F3_ELEV_MIN = 22 * Math.PI / 180, F3_ELEV_MAX = 88 * Math.PI / 180;   // 低すぎると奥のマスが押しにくいので制限
const F3_ZOOM_MIN = 0.5;              // 回すと全体が収まらなくなるので、全体（1）より引ける
const F3_FOV = 30;
const F3_TOP = 0.16;                  // 床のタイルの厚み
const F3_BORDER = 9;                  // マップの外に並べるタイルの段数
const HEX_R = 1 / Math.sqrt(3);       // 六角形のタイルの半径（高さ 1 のとき）

const TEX3 = new Map();               // 駒の表の絵など（同じ見た目は使い回す）
let threeLoading = false;

/** その設定（チェックボックス）で 3D にしたいか */
function want3d(id = 'battle3d') { return !!document.getElementById(id)?.checked; }
/** Three.js を読み込む（読み込み済みなら true）。読み込みが終わったら描き直す */
function ready3d() {
  if (window.THREE) return true;
  if (!threeLoading) {
    threeLoading = true;
    const s = document.createElement('script');
    s.src = 'vendor/three.min.js';
    s.onload = () => {
      if (state.player && !$('battle').classList.contains('hidden')) render();
      if (campaign.smap) renderStrat();
    };
    s.onerror = () => { threeLoading = false; };
    document.head.appendChild(s);
  }
  return false;
}
/** 3D で描いている盤（zoom の種類 'field' / 'smap'）。3D でなければ null */
function board3d(kind) {
  const b = kind === 'field' ? fieldBoard : kind === 'smap' ? smapBoard : null;
  return b && b.on() ? b : null;
}

/** 色の付いた材質（使い回す） */
const MAT3 = new Map();
function mat3(color, extra = {}) {
  const key = color + JSON.stringify(extra);
  if (!MAT3.has(key)) MAT3.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.05, ...extra }));
  return MAT3.get(key);
}

// ------------------------------------------------------------
// 盤ひとつ分（床のタイル・縁取り・駒・カメラ・操作）
// ------------------------------------------------------------

class Board3D {
  /**
   * kind = zoom の種類（'field' / 'smap'）、wrap = 入れ物の id、root = 3D のとき 'three' を付ける画面の id、
   * map() = 今のマップ（w, h, hex）、onCell(x, y) = マスを押したとき、onCamera() = カメラが動いたとき（操作の箱を付いていかせる）
   */
  constructor(o) {
    Object.assign(this, o);
    this.pieces = new Map();   // id → 駒・建物の 3D（Group）
    this.pan = { x: 0, z: 0 }; // 画面の移動（マップの真ん中からのずれ）
    this.yaw = 0; this.yawTo = null; this.elev = F3_ELEV;
    this.fitDist = 20; this.fitKey = '';
    this.raf = null; this.mouse = null; this.map = null; this.heights = [];
    this.soon = null;
  }

  /** 3D で描いているところか */
  on() { return !!document.getElementById(this.root)?.classList.contains('three'); }
  /** 見えているか（画面が開いている） */
  visible() { return this.on() && !document.getElementById(this.root).classList.contains('hidden') && !document.hidden; }

  init() {
    if (this.renderer) return;
    const T = THREE;
    const canvas = document.createElement('canvas');
    canvas.className = 'board3d';
    $(this.wrap).appendChild(canvas);
    const r = new T.WebGLRenderer({ canvas, antialias: true });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.shadowMap.enabled = true;
    r.shadowMap.type = T.PCFSoftShadowMap;
    this.renderer = r;
    this.scene = new T.Scene();
    this.scene.background = new T.Color(0x14161a);
    this.camera = new T.PerspectiveCamera(F3_FOV, 1, 0.5, 300);
    this.scene.add(new T.HemisphereLight(0xe4ecff, 0x30362a, 0.6));
    const sun = new T.DirectionalLight(0xfff0d8, 0.7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0008;
    this.scene.add(sun, sun.target);
    this.sun = sun;
    this.initInput(canvas);
  }

  /** マス (x, y) の床の真ん中（マップの真ん中を原点にした x, z） */
  pos(x, y) {
    const m = this.map;
    const px = m.hex ? x * HEX_COL : x, pz = m.hex ? y + (x & 1) * 0.5 : y;
    const cx = (m.hex ? (m.w - 1) * HEX_COL : m.w - 1) / 2, cz = (m.h - 1 + (m.hex ? 0.5 : 0)) / 2;
    return [px - cx, pz - cz];
  }
  /** マス (x, y) の床の高さ */
  height(x, y) { return this.heights[y * this.map.w + x] || 0; }

  /** マップが変わったら床を作り直す。cell(x, y) / outer(x, y, far) = { h: 高さ, c: 色 }、decorate(board) = 木・山などの飾りを足す */
  build(m, cell, outer, decorate) {
    const T = THREE, sc = this.scene;
    for (const o of [this.floor, this.border, this.ringsThin, this.ringsThick, this.ground, this.decor]) if (o) sc.remove(o);
    for (const p of this.pieces.values()) sc.remove(p);
    this.pieces.clear();
    this.map = m;
    this.pan = { x: 0, z: 0 };
    this.yaw = 0; this.yawTo = null; this.elev = F3_ELEV;
    this.fitKey = '';
    zoom[this.kind] = 1;
    // 床のタイル: 正方形は箱、六角形は6角柱（辺が上下になる向き）。上の面が高さ 0（高いマスは縦に伸ばして持ち上げる）
    const tile = m.hex ? new T.CylinderGeometry(HEX_R * 0.95, HEX_R * 0.95, F3_TOP, 6, 1, false, Math.PI / 2) : new T.BoxGeometry(0.94, F3_TOP, 0.94);
    tile.translate(0, -F3_TOP / 2, 0);
    const tileMat = new T.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
    const col = new T.Color();
    const put = (mesh, i, x, y, h) => {
      const [px, pz] = this.pos(x, y);
      mesh.setMatrixAt(i, new T.Matrix4().compose(new T.Vector3(px, h, pz), new T.Quaternion(), new T.Vector3(1, (F3_TOP + Math.max(0, h)) / F3_TOP, 1)));
    };
    this.floor = new T.InstancedMesh(tile, tileMat, m.w * m.h);
    this.cellIndex = [];
    this.heights = [];
    this.baseColors = [];
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
      const i = y * m.w + x, c = cell(x, y);
      this.heights[i] = c.h;
      this.baseColors[i] = c.c;
      put(this.floor, i, x, y, c.h);
      this.floor.setColorAt(i, col.set(c.c));
      this.cellIndex[i] = [x, y];
    }
    this.floor.receiveShadow = true;
    // マップの外（入れない）
    const B = F3_BORDER, outs = [];
    for (let y = -B; y < m.h + B; y++) for (let x = -B; x < m.w + B; x++) {
      if (x >= 0 && y >= 0 && x < m.w && y < m.h) continue;
      outs.push([x, y, Math.min(6, Math.max(-x, -y, x - m.w + 1, y - m.h + 1))]);
    }
    this.border = new T.InstancedMesh(tile, tileMat, outs.length);
    outs.forEach(([x, y, far], i) => { const c = outer(x, y, far); put(this.border, i, x, y, c.h); this.border.setColorAt(i, col.set(c.c)); });
    this.border.receiveShadow = true;
    // 縁取り（手番・攻撃対象・布陣のマスなど）。細いのと太いの
    const ring = w => {
      const out = m.hex ? HEX_R * 0.95 : 0.47 / Math.cos(Math.PI / 4);
      const inner = m.hex ? out - w / Math.cos(Math.PI / 6) : out - w / Math.cos(Math.PI / 4);
      const g = new T.RingGeometry(inner, out, m.hex ? 6 : 4, 1, m.hex ? 0 : Math.PI / 4);
      g.rotateX(-Math.PI / 2);
      g.translate(0, 0.01, 0);
      const mesh = new T.InstancedMesh(g, new T.MeshBasicMaterial({ color: 0xffffff }), m.w * m.h);
      mesh.setColorAt(0, new T.Color(0xffffff));   // 色の入れ物を先に作っておく（後から作ると色が反映されない）
      mesh.count = 0;
      return mesh;
    };
    this.ringsThin = ring(0.05);
    this.ringsThick = ring(0.1);
    // いちばん下の地面（タイルのすき間から見える）
    this.ground = new T.Mesh(new T.PlaneGeometry(400, 400), new T.MeshBasicMaterial({ color: 0x101214 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.3;
    this.decor = new T.Group();
    if (decorate) decorate(this);
    sc.add(this.floor, this.border, this.ringsThin, this.ringsThick, this.ground, this.decor);
    // 影を落とす光は、マップ全体を覆う
    const span = Math.max(m.w, m.h) / 2 + 3;
    Object.assign(this.sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: 80 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.position.set(-span * 0.6, 22, span * 0.9);
    this.sun.target.position.set(0, 0, 0);
  }

  /**
   * 描き直し。floor(x, y) = 床の色（null ならいつもの色）、rings = [{ x, y, color, thick }]、
   * pieces = [{ id, key, make() → Group, x, y, ox, oz（マスの中でのずれ）, face（カメラの方を向く）, acting, tgt, buff, hp }]
   */
  update({ floor, rings, pieces }) {
    const T = THREE, m = this.map, col = new T.Color(), mtx = new T.Matrix4();
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
      const i = y * m.w + x;
      this.floor.setColorAt(i, col.set(floor(x, y) ?? this.baseColors[i]));
    }
    this.floor.instanceColor.needsUpdate = true;
    let thin = 0, thick = 0;
    for (const r of rings) {
      const [px, pz] = this.pos(r.x, r.y), mesh = r.thick ? this.ringsThick : this.ringsThin, i = r.thick ? thick++ : thin++;
      mtx.makeTranslation(px, this.height(r.x, r.y), pz);
      mesh.setMatrixAt(i, mtx);
      mesh.setColorAt(i, col.set(r.color));
    }
    for (const [mesh, n] of [[this.ringsThin, thin], [this.ringsThick, thick]]) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    const seen = new Set();
    for (const it of pieces) {
      let p = this.pieces.get(it.id);
      if (p && p.userData.key !== it.key) { this.scene.remove(p); p = null; }
      if (!p) {
        p = it.make();
        p.userData.key = it.key;
        const [px, pz] = this.pos(it.x, it.y);
        p.position.set(px + (it.ox || 0), this.height(it.x, it.y), pz + (it.oz || 0));
        this.pieces.set(it.id, p);
        this.scene.add(p);
      }
      const d = p.userData;
      [d.tx, d.tz] = this.pos(it.x, it.y);
      d.tx += it.ox || 0; d.tz += it.oz || 0;
      d.ty = this.height(it.x, it.y);
      Object.assign(d, { cx: it.x, cy: it.y, face: !!it.face, acting: !!it.acting });
      if (d.tgt) d.tgt.visible = !!it.tgt;
      if (d.buff) d.buff.visible = !!it.buff;
      if (d.hp && it.hp != null) d.hp.scale.x = 0.62 * Math.max(0, it.hp);
      seen.add(it.id);
    }
    for (const [id, p] of this.pieces) if (!seen.has(id)) { this.scene.remove(p); this.pieces.delete(id); }
    this.placeCamera();
    this.dirty = true;
    if (!this.raf) this.raf = requestAnimationFrame(t => this.loop(t));
  }

  /** 毎フレーム: 駒を新しい位置へなめらかに動かす・手番の駒を上下させる・⚔ を脈打たせる */
  loop(t) {
    this.raf = null;
    if (!this.visible()) return;
    const wrap = $(this.wrap);
    if (wrap.clientWidth !== this.w || wrap.clientHeight !== this.h) this.placeCamera();
    let busy = false;
    if (this.yawTo != null) {   // ボタンで回したとき
      const dy = this.yawTo - this.yaw;
      if (Math.abs(dy) < 0.002) { this.yaw = this.yawTo; this.yawTo = null; } else this.yaw += dy * 0.2;
      this.placeCamera();
      this.cameraMoved();
    }
    for (const p of this.pieces.values()) {
      const d = p.userData;
      if (d.face && p.rotation.y !== this.yaw) { p.rotation.y = this.yaw; busy = true; }   // 駒の板はいつもカメラの方を向く
      const dx = d.tx - p.position.x, dz = d.tz - p.position.z;
      if (Math.abs(dx) + Math.abs(dz) > 0.002) { p.position.x += dx * 0.25; p.position.z += dz * 0.25; busy = true; }
      else { p.position.x = d.tx; p.position.z = d.tz; }
      const y = d.ty + (d.acting ? 0.06 + Math.sin(t / 260) * 0.05 : 0);
      if (p.position.y !== y) { p.position.y = y; busy = true; }
      if (d.tgt?.visible) { const s = 0.36 * (1 + Math.sin(t / 160) * 0.12); d.tgt.scale.set(s, s, 1); busy = true; }
    }
    if (busy || this.dirty) { this.renderer.render(this.scene, this.camera); this.dirty = false; }
    this.raf = requestAnimationFrame(tt => this.loop(tt));
  }

  // ---- カメラ: zoom[kind]（1 = 全体が収まる）と pan で寄せる・ずらす。yaw = 向き、elev = 見下ろす角度 ----

  /** 見ている点からカメラへの向き（長さ 1） */
  camDir(yaw = this.yaw) { const c = Math.cos(this.elev); return [Math.sin(yaw) * c, Math.sin(this.elev), Math.cos(yaw) * c]; }

  placeCamera() {
    const wrap = $(this.wrap), W = wrap.clientWidth, H = wrap.clientHeight;
    if (!W || !H || !this.map) return;
    this.w = W; this.h = H;
    this.renderer.setSize(W, H, false);
    const cam = this.camera, m = this.map;
    cam.aspect = W / H;
    cam.updateProjectionMatrix();
    // 全体が収まる距離（四隅と駒の頭が画面に入る）を探す。向きは手前から見たときで決める（回しても寄ったり引いたりしないように）
    const key = `${W}x${H}|${m.w}x${m.h}|${m.hex}|${this.elev.toFixed(3)}`;
    if (this.fitKey !== key) {
      const hx = (m.hex ? (m.w - 1) * HEX_COL : m.w - 1) / 2 + 0.7, hz = (m.h - 1 + (m.hex ? 0.5 : 0)) / 2 + 0.7;
      const corners = [];
      for (const x of [-hx, hx]) for (const z of [-hz, hz]) for (const y of [0, 1.2]) corners.push(new THREE.Vector3(x, y, z));
      let lo = 1, hi = 300;
      for (let i = 0; i < 40; i++) {
        const d = (lo + hi) / 2;
        const [, sy, sz] = this.camDir(0);
        cam.position.set(0, d * sy, d * sz); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
        const fits = corners.every(c => { const p = c.clone().project(cam); return Math.abs(p.x) <= 0.96 && Math.abs(p.y) <= 0.96; });
        if (fits) hi = d; else lo = d;
      }
      this.fitDist = hi;
      this.fitKey = key;
    }
    const hx = (m.hex ? (m.w - 1) * HEX_COL : m.w - 1) / 2 + 1, hz = (m.h - 1) / 2 + 1;
    this.pan.x = Math.max(-hx, Math.min(hx, this.pan.x));
    this.pan.z = Math.max(-hz, Math.min(hz, this.pan.z));
    const d = this.fitDist / zoom[this.kind], [sx, sy, sz] = this.camDir();
    cam.position.set(this.pan.x + d * sx, d * sy, this.pan.z + d * sz);
    cam.lookAt(this.pan.x, 0, this.pan.z);
    cam.updateMatrixWorld();
    this.dirty = true;
  }

  /** カメラが動いたら、操作の箱を付いていかせる（1フレームに1回） */
  cameraMoved() {
    if (this.soon || !this.onCamera) return;
    this.soon = requestAnimationFrame(() => { this.soon = null; this.onCamera(); });
  }

  /** 画面上の点の下にある地面（y = 0）の位置 */
  groundAt(cx, cy) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((cx - r.left) / r.width * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), this.camera);
    const p = new THREE.Vector3();
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p) ? p : null;
  }

  /** 指・マウスで動かした分だけ地図をずらす（画面の移動） */
  panBy(dx, dy) {
    if (!this.renderer) return;
    const d = this.fitDist / zoom[this.kind];
    const perPx = 2 * d * Math.tan(F3_FOV * Math.PI / 360) / this.h;
    // 画面の右・上に当たる地面の向き（カメラの向きで変わる）
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw), up = perPx / Math.sin(this.elev);
    this.pan.x -= dx * perPx * c - dy * up * s;
    this.pan.z -= -dx * perPx * s + dy * up * c;
    this.placeCamera();
    this.cameraMoved();
  }

  /** 拡大率を変える。(cx, cy) の下の地点が動かないように寄せる。全体（z = 1、中心指定なし）なら元の向き・角度に戻す */
  zoomTo(z, cx, cy) {
    if (!this.renderer) { zoom[this.kind] = z; return; }
    const before = cx != null ? this.groundAt(cx, cy) : null;
    zoom[this.kind] = Math.max(F3_ZOOM_MIN, Math.min(ZOOM_MAX * 1.5, z));
    if (cx == null && z === 1) { this.pan = { x: 0, z: 0 }; this.yawTo = nearestTurn(this.yaw, 0); this.elev = F3_ELEV; this.kick(); }
    this.placeCamera();
    const after = before && this.groundAt(cx, cy);
    if (before && after) { this.pan.x += before.x - after.x; this.pan.z += before.z - after.z; this.placeCamera(); }
    this.cameraMoved();
  }

  /** カメラを回す（ラジアン。正 = マップが時計回りに回って見える） */
  rotate(da) {
    if (!this.renderer) return;
    this.yawTo = null;
    this.yaw += da;
    this.placeCamera();
    this.cameraMoved();
  }
  /** ボタン: 45°（六角は 60°）ずつ、きりのいい向きへなめらかに回す */
  rotateStep(dir) {
    if (!this.renderer) return;
    const step = (this.map?.hex ? 60 : 45) * Math.PI / 180, from = this.yawTo ?? this.yaw;
    this.yawTo = (Math.round(from / step) + dir) * step;
    this.kick();
  }
  /** 見下ろす角度を変える（画面の下向き = 正。上へずらすと低い視点に） */
  tilt(dy) {
    if (!this.renderer) return;
    this.elev = Math.max(F3_ELEV_MIN, Math.min(F3_ELEV_MAX, this.elev + dy * 0.004));
    this.placeCamera();
    this.cameraMoved();
  }
  kick() { if (!this.raf) this.raf = requestAnimationFrame(t => this.loop(t)); }

  /** マス (x, y) が画面のどこに見えるか（操作の箱を置くため。getBoundingClientRect と同じ形） */
  rect(x, y, tall = false) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const [px, pz] = this.pos(x, y), h = this.height(x, y);
    let [l, t, rt, b] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [ox, oz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) for (const oy of tall ? [0, 1.2] : [0]) {
      const p = new THREE.Vector3(px + ox, h + oy, pz + oz).project(this.camera);
      const sx = r.left + (p.x + 1) / 2 * r.width, sy = r.top + (1 - p.y) / 2 * r.height;
      l = Math.min(l, sx); rt = Math.max(rt, sx); t = Math.min(t, sy); b = Math.max(b, sy);
    }
    return { left: l, top: t, right: rt, bottom: b, width: rt - l, height: b - t };
  }
  /** getBoundingClientRect を持つ目印（placeFloat に渡す） */
  anchor(x, y, tall = false) { return { getBoundingClientRect: () => this.rect(x, y, tall) }; }

  // ---- 操作: 押したマス（駒を押したらその駒のマス）を onCell へ。マウスはドラッグで移動・右ドラッグで回転・ホイールで拡大縮小 ----

  initInput(canvas) {
    canvas.addEventListener('click', e => {
      if (this.mouse?.moved) { this.mouse = null; return; }
      const r = canvas.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
      const objs = [this.floor];
      for (const p of this.pieces.values()) p.traverse(o => { if (o.isMesh) objs.push(o); });
      const hit = ray.intersectObjects(objs, false)[0];
      if (!hit) return;
      if (hit.object === this.floor) { const c = this.cellIndex[hit.instanceId]; if (c) this.onCell(c[0], c[1]); return; }
      let o = hit.object;
      while (o && !this.pieces.has(o.userData.id)) o = o.parent;
      if (o) this.onCell(o.userData.cx, o.userData.cy);
    });
    canvas.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'mouse' || (e.button !== 0 && e.button !== 2)) return;
      this.mouse = { x: e.clientX, y: e.clientY, moved: false, down: true, turn: e.button === 2 || e.shiftKey };   // 右ドラッグ（Shift + ドラッグ）= 回転・角度
    });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('pointermove', e => {
      const m = this.mouse;
      if (!m?.down || e.pointerType !== 'mouse') return;
      const dx = e.clientX - m.x, dy = e.clientY - m.y;
      if (!m.moved && Math.hypot(dx, dy) < 5) return;
      m.moved = true;
      m.x = e.clientX; m.y = e.clientY;
      if (m.turn) { this.rotate(dx * 0.008); this.tilt(dy); } else this.panBy(dx, dy);
    });
    window.addEventListener('pointerup', e => { if (this.mouse && e.pointerType === 'mouse') { this.mouse.down = false; if (!this.mouse.moved) this.mouse = null; } });
    canvas.addEventListener('wheel', e => {
      if (e.ctrlKey) return;   // Ctrl + ホイール（ピンチ）は initZoom が扱う
      e.preventDefault();
      this.zoomTo(zoom[this.kind] * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    }, { passive: false });
  }
}

/** 0 と同じ向き（360° の倍数）のうち今の向きにいちばん近いもの（回り過ぎずに戻すため） */
function nearestTurn(yaw, to) { return to + Math.round((yaw - to) / (Math.PI * 2)) * Math.PI * 2; }

// ------------------------------------------------------------
// 駒: 台座 + 立てた板（表に文字・階級の印）+ HP バー + ⚔ の印
// ------------------------------------------------------------

const RANK_EDGE = { 'rk-lead': '#ffd76f', 'rk-gen': '#e8c25a', 'rk-sgt': '#c9d3df' };

/** 駒の表の絵。dim = 行動済み（暗く） */
function pieceTex(side, letter, mark, rank, dim = false) {
  const key = [side, letter, mark, rank, dim].join('|');
  if (TEX3.has(key)) return TEX3.get(key);
  const c = document.createElement('canvas');
  c.width = 128; c.height = 168;
  const g = c.getContext('2d');
  const [top, bottom, edge] = side === 'player' ? ['#4677b4', '#25467a', '#7fb0ea'] : ['#b44646', '#7a2525', '#ea8f7f'];
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, top); grad.addColorStop(1, bottom);
  g.fillStyle = grad; g.fillRect(0, 0, c.width, c.height);
  g.lineWidth = rank ? 12 : 6;
  g.strokeStyle = RANK_EDGE[rank] || edge;
  g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, c.width - g.lineWidth, c.height - g.lineWidth);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  if (mark) {   // 階級の印は文字の後ろに大きく（すかし）
    g.globalAlpha = 0.5;
    g.fillStyle = RANK_EDGE[rank] || '#fff';
    g.font = 'bold 150px sans-serif';
    g.fillText(mark, c.width / 2, c.height / 2 + 6);
    g.globalAlpha = 1;
  }
  g.font = 'bold 84px sans-serif';
  g.fillStyle = '#fff';
  g.shadowColor = 'rgba(0,0,0,0.8)'; g.shadowBlur = 6; g.shadowOffsetY = 2;
  g.fillText(letter, c.width / 2, c.height / 2 + 4);
  if (dim) { g.shadowColor = 'transparent'; g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(0, 0, c.width, c.height); }
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  TEX3.set(key, t);
  return t;
}

/** 文字1つの絵（⚔・▲ など、駒の上に浮かべる） */
function glyphTex(ch, color, bg) {
  const key = `g|${ch}|${color}|${bg}`;
  if (TEX3.has(key)) return TEX3.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (bg) { g.fillStyle = bg; g.beginPath(); g.arc(32, 32, 30, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = color; g.font = 'bold 40px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(ch, 32, 34);
  const t = new THREE.CanvasTexture(c);
  TEX3.set(key, t);
  return t;
}

const PIECE_GEO = {};
/** 駒（台座 + 板）。hp = HP バーを付けるか */
function makePiece(id, side, tex, { lead = false, hp = true } = {}) {
  const T = THREE;
  PIECE_GEO.base ||= new T.CylinderGeometry(0.3, 0.33, 0.07, 24);
  PIECE_GEO.board ||= new T.BoxGeometry(0.64, 0.92, 0.09);
  const g = new T.Group();
  const sideCol = side === 'player' ? 0x2f5d96 : 0x9a3434;
  const base = new T.Mesh(PIECE_GEO.base, mat3(lead ? 0x8a7020 : sideCol, lead ? { emissive: 0x3a2c08 } : {}));
  base.position.y = 0.035;
  base.castShadow = true;
  const sideMat = mat3(side === 'player' ? 0x284f80 : 0x822c2c);
  const front = new T.MeshStandardMaterial({ map: tex, roughness: 0.6 });
  const board = new T.Mesh(PIECE_GEO.board, [sideMat, sideMat, sideMat, sideMat, front, sideMat]);
  board.position.y = 0.07 + 0.46;
  board.castShadow = true;
  g.add(base, board);
  g.userData = { id };
  if (hp) {
    // 下地と緑は同じ深さに重なるので、下地は奥行きを書かずに先に描き、緑を必ずその上に描く（向きによって緑が隠れてちらつかないように）
    const hpBg = new T.Sprite(new T.SpriteMaterial({ color: 0x222222, depthWrite: false }));
    hpBg.center.set(0, 0.5); hpBg.scale.set(0.62, 0.075, 1); hpBg.position.set(-0.31, 1.12, 0); hpBg.renderOrder = 5;
    const bar = new T.Sprite(new T.SpriteMaterial({ color: 0x55cc55 }));
    bar.center.set(0, 0.5); bar.scale.set(0.62, 0.075, 1); bar.position.set(-0.31, 1.12, 0); bar.renderOrder = 6;
    g.add(hpBg, bar);
    g.userData.hp = bar;
  }
  const tgt = new T.Sprite(new T.SpriteMaterial({ map: glyphTex('⚔', '#fff', '#ff5a4f'), depthTest: false }));
  tgt.scale.set(0.36, 0.36, 1); tgt.position.set(0.3, 1.36, 0); tgt.renderOrder = 10;
  const buff = new T.Sprite(new T.SpriteMaterial({ map: glyphTex('▲', '#ffd76f'), depthTest: false }));
  buff.scale.set(0.26, 0.26, 1); buff.position.set(-0.3, 1.32, 0); buff.renderOrder = 10;
  g.add(tgt, buff);
  Object.assign(g.userData, { tgt, buff });
  return g;
}

// ------------------------------------------------------------
// 局地戦（renderField の最後に呼ばれる）
// ------------------------------------------------------------

const fieldBoard = new Board3D({
  kind: 'field', wrap: 'field-wrap', root: 'battle',
  onCell: (x, y) => onCellClick(x, y),
  onCamera: () => placeActionPanel(),
});

function pieceMark(u) { return u.isCommander ? '★' : u.rank === '副将' ? '☆' : u.rank === '兵長' ? '◆' : ''; }

function render3d() {
  const b = fieldBoard, m = state.map;
  b.init();
  if (b.map !== m) {
    b.build(m, () => ({ h: 0, c: 0x3a4a32 }), (x, y, far) => {
      // マップのすぐ外の1列: 手前（自陣側）は青、奥（敵陣側）は赤。回してもどちらから攻めているかわかるように
      const edge = x >= 0 && x < m.w ? (y === m.h ? 0x3a6db0 : y === -1 ? 0xb04040 : null) : null;
      if (edge != null) return { h: -0.03, c: edge };
      const k = 0.5 - far * 0.06;
      return { h: -0.06, c: new THREE.Color().setRGB(0.165 * k, 0.2 * k, 0.15 * k).getHex() };
    });
  }
  const els = new Map();
  for (const el of document.querySelectorAll('#field .cell[data-x]')) els.set(`${el.dataset.x},${el.dataset.y}`, el.classList);
  const col = new THREE.Color(), mix = new THREE.Color();
  const rings = [];
  for (const [k, cl] of els) {
    const [x, y] = k.split(',').map(Number);
    const ringCol = cl.contains('target') ? 0xff5a4f : cl.contains('acting') ? 0xffc83a : cl.contains('spearhit') ? 0xffd84a : null;
    if (ringCol != null) rings.push({ x, y, color: ringCol, thick: true });
    else if (cl.contains('deployzone')) rings.push({ x, y, color: 0xd9b452 });
  }
  const pieces = [];
  for (const u of allUnits()) {
    if (!u.alive || (u.side === 'cpu' && !visibleTo('player', u))) continue;   // 霧の中の敵は描かない
    const cl = els.get(`${u.x},${u.y}`);
    const rank = cl ? (['rk-lead', 'rk-gen', 'rk-sgt'].find(c => cl.contains(c)) || '') : '';
    pieces.push({
      id: u.id, key: `${u.side}|${u.type}|${pieceMark(u)}|${rank}`, x: u.x, y: u.y, face: true,
      make: () => makePiece(u.id, u.side, pieceTex(u.side, u.type[0], pieceMark(u), rank), { lead: rank === 'rk-lead' }),
      acting: cl?.contains('acting'), tgt: cl?.contains('target'), buff: cl?.contains('buffed'), hp: u.hp / u.maxHp,
    });
  }
  b.update({
    floor: (x, y) => {
      const cl = els.get(`${x},${y}`);
      if (!cl) return null;
      col.set(cl.contains('charge') ? 0xa8662a : cl.contains('reach') ? 0x3f6a8f : 0x3a4a32);
      if (cl.contains('atkrange')) col.lerp(mix.set(0xd0523e), 0.4);
      if (cl.contains('skillrange')) col.lerp(mix.set(0xaa78ff), 0.4);
      if (cl.contains('deployzone')) col.lerp(mix.set(0xffd76f), 0.12);
      if (cl.contains('fog')) col.multiplyScalar(0.5);
      return col.getHex();
    },
    rings, pieces,
  });
}

// ------------------------------------------------------------
// 戦域図（renderStratBody の最後に呼ばれる）: 地形に高さ（山は高く、川は低く）、森に木、砦・本陣は建物、隊は駒
// ------------------------------------------------------------

const smapBoard = new Board3D({
  kind: 'smap', wrap: 'smap-wrap', root: 'view-map',
  onCell: (x, y) => onSmapClick(x, y),
  onCamera: () => placeStratInfo(),
});

const TERRAIN3D = {
  '平地': { h: 0, c: 0x3a4a32 },
  '森':   { h: 0.03, c: 0x2a4a2c },
  '山':   { h: 0.45, c: 0x6a5f50 },
  '浅瀬': { h: -0.06, c: 0x4a7090 },
  '川':   { h: -0.12, c: 0x2a4a72 },
};

/** 地形の飾り: 森の木・山の岩（決まった乱数で、描き直しても同じ形） */
function decorateStrat(b) {
  const T = THREE, m = b.map;
  let seed = m.w * 131 + m.h * 17 + (m.forts[0]?.x || 0);
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const trees = [], rocks = [];
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    const t = smapCell(m, x, y);
    if (t === '森') for (let k = 0; k < 3; k++) trees.push([x, y, (rnd() - 0.5) * 0.5, (rnd() - 0.5) * 0.5, 0.7 + rnd() * 0.5]);
    if (t === '山') rocks.push([x, y, (rnd() - 0.5) * 0.15, (rnd() - 0.5) * 0.15, 0.8 + rnd() * 0.4]);
  }
  const place = (mesh, list, lift) => {
    list.forEach(([x, y, ox, oz, s], i) => {
      const [px, pz] = b.pos(x, y);
      mesh.setMatrixAt(i, new T.Matrix4().compose(new T.Vector3(px + ox, b.height(x, y) + lift * s, pz + oz), new T.Quaternion(), new T.Vector3(s, s, s)));
    });
    mesh.castShadow = true;
    b.decor.add(mesh);
  };
  if (trees.length) place(new T.InstancedMesh(new T.ConeGeometry(0.17, 0.5, 7), mat3(0x1f5a2a), trees.length), trees, 0.25);
  if (rocks.length) place(new T.InstancedMesh(new T.ConeGeometry(0.38, 0.45, 6), mat3(0x7d7262), rocks.length), rocks, 0.22);
}

/** 砦の建物（持ち主で屋根の色が変わる） */
function makeFort(id, owner) {
  const T = THREE, g = new T.Group();
  const roof = owner === 'player' ? 0x3a78c8 : owner === 'cpu' ? 0xc84040 : 0x8a8a8a;
  const wall = new T.Mesh(new T.CylinderGeometry(0.36, 0.4, 0.22, 6), mat3(0x9a9080));
  wall.position.y = 0.11;
  const tower = new T.Mesh(new T.BoxGeometry(0.26, 0.42, 0.26), mat3(0xb8ae9a));
  tower.position.y = 0.43;
  const top = new T.Mesh(new T.ConeGeometry(0.24, 0.22, 4), mat3(roof));
  top.position.y = 0.75; top.rotation.y = Math.PI / 4;
  for (const o of [wall, tower, top]) { o.castShadow = true; g.add(o); }
  g.userData = { id };
  return g;
}

/** 本陣（陣幕と旗） */
function makeBase(id, side) {
  const T = THREE, g = new T.Group();
  const color = side === 'player' ? 0x3a78c8 : 0xc84040;
  const tent = new T.Mesh(new T.ConeGeometry(0.34, 0.4, 8), mat3(0xd8d0c0));
  tent.position.y = 0.2;
  const pole = new T.Mesh(new T.CylinderGeometry(0.015, 0.015, 0.7, 6), mat3(0x6a5030));
  pole.position.set(0.22, 0.35, 0);
  const flag = new T.Mesh(new T.BoxGeometry(0.22, 0.14, 0.01), mat3(color));
  flag.position.set(0.33, 0.62, 0);
  for (const o of [tent, pole, flag]) { o.castShadow = true; g.add(o); }
  g.userData = { id };
  return g;
}

/** 罠の目印（自軍の罠は青、見つけた敵の罠は赤） */
function makeTrap(id, own) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glyphTex('🪤', '#fff', own ? '#3c8cff' : '#ff463c'), depthTest: false }));
  s.scale.set(0.34, 0.34, 1);
  s.position.set(0.28, 0.3, 0.2);
  s.renderOrder = 9;
  const g = new THREE.Group();
  g.add(s);
  g.userData = { id };
  return g;
}

const TOKEN3D = { '本隊': ['本', '★', 'rk-lead'], '分隊': ['分', '☆', 'rk-gen'], '小隊': ['小', '◆', 'rk-sgt'], '斥候': ['斥', '', ''], '暗殺者': ['暗', '', ''], '守備隊': ['守', '', ''] };

function renderStrat3d() {
  const b = smapBoard, m = smap();
  b.init();
  if (b.map !== m) {
    b.build(m, (x, y) => TERRAIN3D[smapCell(m, x, y)] || TERRAIN3D['平地'], (x, y, far) => {
      // 外側: いちばん近いマップの端の地形を、暗くして続ける
      const t = TERRAIN3D[smapCell(m, Math.max(0, Math.min(m.w - 1, x)), Math.max(0, Math.min(m.h - 1, y)))];
      return { h: Math.min(t.h, 0) - 0.06, c: new THREE.Color(t.c).multiplyScalar(0.45 - far * 0.04).getHex() };
    }, decorateStrat);
  }
  const els = new Map();
  for (const el of document.querySelectorAll('#smap .scell[data-x]')) els.set(`${el.dataset.x},${el.dataset.y}`, el);
  const col = new THREE.Color(), mix = new THREE.Color();
  const rings = [], pieces = [];
  for (const [k, el] of els) {
    const [x, y] = k.split(',').map(Number), cl = el.classList;
    if (cl.contains('target')) rings.push({ x, y, color: 0xff5a4f, thick: true });
    else if (cl.contains('acting')) rings.push({ x, y, color: 0xffc83a, thick: true });
    const base = el.querySelector('.base');
    if (base) {
      const side = base.classList.contains('own-player') ? 'player' : 'cpu';
      pieces.push({ id: `base-${side}`, key: side, x, y, ox: -0.22, oz: -0.2, make: () => makeBase(`base-${side}`, side) });
    }
    const tr = el.querySelector('.trap');
    if (tr) {
      const own = tr.classList.contains('own');
      pieces.push({ id: `trap-${x},${y}`, key: String(own), x, y, make: () => makeTrap(`trap-${x},${y}`, own) });
    }
  }
  // 建物はマスの奥に寄せる（隊の駒が同じマスに立っても隠れないように）
  for (const f of m.forts) pieces.push({ id: `fort-${f.id}`, key: f.owner || 'none', x: f.x, y: f.y, ox: -0.12, oz: -0.22, make: () => makeFort(`fort-${f.id}`, f.owner) });
  const sel = ui.selected;
  for (const t of liveTokens()) {
    if (!tokenVisibleTo('player', t)) continue;
    const [letter, mark, rank] = TOKEN3D[tokenKind(t)] || ['?', '', ''];
    const done = t.side === 'player' && t.acted && m.phase === 'player';
    const cl = els.get(`${t.x},${t.y}`)?.classList;
    pieces.push({
      id: `tok-${t.id}`, key: `${t.side}|${letter}|${rank}|${done}`, x: t.x, y: t.y, oz: 0.12, face: true,
      make: () => makePiece(`tok-${t.id}`, t.side, pieceTex(t.side, letter, mark, rank, done), { lead: rank === 'rk-lead', hp: false }),
      acting: t.id === sel, tgt: cl?.contains('target'),
    });
  }
  b.update({
    floor: (x, y) => {
      const cl = els.get(`${x},${y}`)?.classList;
      if (!cl) return null;
      col.set((TERRAIN3D[smapCell(m, x, y)] || TERRAIN3D['平地']).c);
      if (cl.contains('reach')) col.lerp(mix.set(0x5aa0ff), 0.45);
      if (cl.contains('trapmode')) col.lerp(mix.set(0xffd76f), 0.45);
      if (cl.contains('fog')) col.multiplyScalar(0.5);
      return col.getHex();
    },
    rings, pieces,
  });
}
