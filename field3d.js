// ============================================================
// 局地戦の 3D 表示（試作）: 設定の「局地戦を3Dで表示」。Three.js（vendor/three.min.js）はオンにしたときだけ読み込む
//   ルールや操作は今までのまま。renderField が作るマス（#field の中、3D のときは隠す）の印（reach / target など）を読み取って、
//   床のタイル・縁取り・駒を立体で描き直す。押したマスは onCellClick へ渡す
//   カメラ: 1本指（マウスはドラッグ）で移動、ピンチ（ホイール）で拡大縮小、2本指でひねると回転、2本指を上下にずらすと見下ろす角度
//   （マウスは右ドラッグで回転・角度）。⟲ ⟳ のボタンで 45°（六角は 60°）ずつ回す。「全体」で元の向きに戻す
// ============================================================

const F3_ELEV = 52 * Math.PI / 180;   // カメラの見下ろす角度（水平から）の初めの値
const F3_ELEV_MIN = 22 * Math.PI / 180, F3_ELEV_MAX = 88 * Math.PI / 180;   // 低すぎると奥のマスが押しにくいので制限
const F3_ZOOM_MIN = 0.5;              // 回すと全体が収まらなくなるので、全体（1）より引ける
const F3_FOV = 30;
const F3_TOP = 0.16;                  // 床のタイルの厚み
const F3_BORDER = 9;                  // マップの外に並べるタイルの段数

const F3 = {
  loading: false, renderer: null, scene: null, camera: null, sun: null,
  map: null, floor: null, border: null, ringsThin: null, ringsThick: null, ground: null,
  cellIndex: [],            // 床のタイルの番号 → [x, y]
  pieces: new Map(),        // 駒の id → 駒の 3D（Group）
  tex: new Map(),           // 駒の表の絵（同じ見た目は使い回す）
  pan: { x: 0, z: 0 },      // 画面の移動（マップの真ん中からのずれ）
  yaw: 0, yawTo: null,      // カメラの向き（0 = 手前（自陣側）から。ボタンで回すときは yawTo へなめらかに）
  elev: F3_ELEV,            // 見下ろす角度
  fitDist: 20, fitKey: '',  // 全体が収まるカメラの距離（画面の大きさ・マップごとに計算）
  raf: null, mouse: null,
};

/** 3D 表示にしたいか（設定） */
function want3d() { return !!document.getElementById('battle3d')?.checked; }
/** 3D で描いているところか */
function is3d() { return document.getElementById('battle')?.classList.contains('three'); }
/** Three.js を読み込む（読み込み済みなら true）。読み込みが終わったら描き直す */
function ready3d() {
  if (window.THREE) return true;
  if (!F3.loading) {
    F3.loading = true;
    const s = document.createElement('script');
    s.src = 'vendor/three.min.js';
    s.onload = () => { if (state.player) render(); };
    s.onerror = () => { F3.loading = false; };
    document.head.appendChild(s);
  }
  return false;
}
function active3d() { return want3d() && ready3d(); }

/** マス (x, y) の床の真ん中（マップの真ん中を原点にした x, z） */
function pos3(x, y) {
  const m = state.map;
  const px = m.hex ? x * HEX_COL : x, pz = m.hex ? y + (x & 1) * 0.5 : y;
  const cx = (m.hex ? (m.w - 1) * HEX_COL : m.w - 1) / 2, cz = (m.h - 1 + (m.hex ? 0.5 : 0)) / 2;
  return [px - cx, pz - cz];
}

function init3d() {
  const T = THREE;
  const canvas = document.createElement('canvas');
  canvas.id = 'field3d';
  $('field-wrap').appendChild(canvas);
  const r = new T.WebGLRenderer({ canvas, antialias: true });
  r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  r.shadowMap.enabled = true;
  r.shadowMap.type = T.PCFSoftShadowMap;
  F3.renderer = r;
  F3.scene = new T.Scene();
  F3.scene.background = new T.Color(0x14161a);
  F3.camera = new T.PerspectiveCamera(F3_FOV, 1, 0.5, 300);
  F3.scene.add(new T.HemisphereLight(0xe4ecff, 0x30362a, 0.6));
  const sun = new T.DirectionalLight(0xfff0d8, 0.7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0008;
  F3.scene.add(sun, sun.target);
  F3.sun = sun;
  // 形は使い回す
  F3.geo = {
    base: new T.CylinderGeometry(0.3, 0.33, 0.07, 24),
    board: new T.BoxGeometry(0.64, 0.92, 0.09),
  };
  F3.matCache = new Map();
  initInput3d(canvas);
}

/** 色の付いた材質（使い回す） */
function mat3(color, extra = {}) {
  const key = color + JSON.stringify(extra);
  if (!F3.matCache.has(key)) F3.matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.05, ...extra }));
  return F3.matCache.get(key);
}

/** マップが変わったら床を作り直す */
function buildMap3d() {
  const T = THREE, m = state.map, sc = F3.scene;
  for (const k of ['floor', 'border', 'ringsThin', 'ringsThick', 'ground']) if (F3[k]) { sc.remove(F3[k]); F3[k].geometry.dispose(); F3[k] = null; }
  for (const p of F3.pieces.values()) sc.remove(p);
  F3.pieces.clear();
  F3.map = m;
  F3.pan = { x: 0, z: 0 };
  F3.yaw = 0; F3.yawTo = null; F3.elev = F3_ELEV;
  F3.fitKey = '';
  zoom.field = 1;
  // 床のタイル: 正方形は箱、六角形は6角柱（辺が上下になる向き）。上の面が高さ 0
  const R = 1 / Math.sqrt(3);
  const tile = m.hex ? new T.CylinderGeometry(R * 0.95, R * 0.95, F3_TOP, 6, 1, false, Math.PI / 2) : new T.BoxGeometry(0.94, F3_TOP, 0.94);
  tile.translate(0, -F3_TOP / 2, 0);
  const tileMat = new T.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
  const mtx = new T.Matrix4(), col = new T.Color();
  F3.floor = new T.InstancedMesh(tile, tileMat, m.w * m.h);
  F3.cellIndex = [];
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    const i = y * m.w + x, [px, pz] = pos3(x, y);
    mtx.makeTranslation(px, 0, pz);
    F3.floor.setMatrixAt(i, mtx);
    F3.floor.setColorAt(i, col.set(0x3a4a32));
    F3.cellIndex[i] = [x, y];
  }
  F3.floor.receiveShadow = true;
  // マップの外: 少し低く、離れるほど暗い（入れない）
  const B = F3_BORDER, outs = [];
  for (let y = -B; y < m.h + B; y++) for (let x = -B; x < m.w + B; x++) {
    if (x >= 0 && y >= 0 && x < m.w && y < m.h) continue;
    outs.push([x, y, Math.min(6, Math.max(-x, -y, x - m.w + 1, y - m.h + 1))]);
  }
  F3.border = new T.InstancedMesh(tile, tileMat, outs.length);
  outs.forEach(([x, y, far], i) => {
    const [px, pz] = pos3(x, y);
    // マップのすぐ外の1列: 手前（自陣側）は青、奥（敵陣側）は赤。回してもどちらから攻めているかわかるように
    const edge = x >= 0 && x < m.w ? (y === m.h ? 0x3a6db0 : y === -1 ? 0xb04040 : null) : null;
    mtx.makeTranslation(px, edge != null ? -0.03 : -0.06, pz);
    F3.border.setMatrixAt(i, mtx);
    const k = 0.5 - far * 0.06;
    if (edge != null) F3.border.setColorAt(i, col.set(edge));
    else F3.border.setColorAt(i, col.setRGB(0.165 * k, 0.2 * k, 0.15 * k));
  });
  F3.border.receiveShadow = true;
  // 縁取り（手番・攻撃対象・布陣のマスなど）。細いのと太いの
  const ring = w => {
    const out = m.hex ? R * 0.95 : 0.47 / Math.cos(Math.PI / 4);
    const inner = m.hex ? out - w / Math.cos(Math.PI / 6) : out - w / Math.cos(Math.PI / 4);
    const g = new T.RingGeometry(inner, out, m.hex ? 6 : 4, 1, m.hex ? 0 : Math.PI / 4);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0.01, 0);
    const mesh = new T.InstancedMesh(g, new T.MeshBasicMaterial({ color: 0xffffff }), m.w * m.h);
    mesh.setColorAt(0, new T.Color(0xffffff));   // 色の入れ物を先に作っておく（後から作ると色が反映されない）
    mesh.count = 0;
    return mesh;
  };
  F3.ringsThin = ring(0.05);
  F3.ringsThick = ring(0.1);
  // いちばん下の地面（タイルのすき間から見える）
  F3.ground = new T.Mesh(new T.PlaneGeometry(400, 400), new T.MeshBasicMaterial({ color: 0x101214 }));
  F3.ground.rotation.x = -Math.PI / 2;
  F3.ground.position.y = -0.3;
  sc.add(F3.floor, F3.border, F3.ringsThin, F3.ringsThick, F3.ground);
  // 影を落とす光は、マップ全体を覆う
  const span = Math.max(m.w, m.h) / 2 + 3;
  Object.assign(F3.sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: 80 });
  F3.sun.shadow.camera.updateProjectionMatrix();
  F3.sun.position.set(-span * 0.6, 22, span * 0.9);
  F3.sun.target.position.set(0, 0, 0);
}

// ------------------------------------------------------------
// 駒: 台座 + 立てた板（表に兵種の文字・階級の印）+ HP バー + ⚔ の印
// ------------------------------------------------------------

const RANK_EDGE = { 'rk-lead': '#ffd76f', 'rk-gen': '#e8c25a', 'rk-sgt': '#c9d3df' };

/** 駒の表の絵 */
function pieceTex(side, letter, mark, rank) {
  const key = [side, letter, mark, rank].join('|');
  if (F3.tex.has(key)) return F3.tex.get(key);
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
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = F3.renderer.capabilities.getMaxAnisotropy();
  F3.tex.set(key, t);
  return t;
}

/** 文字1つの絵（⚔・▲ など、駒の上に浮かべる） */
function glyphTex(ch, color, bg) {
  const key = `g|${ch}|${color}|${bg}`;
  if (F3.tex.has(key)) return F3.tex.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (bg) { g.fillStyle = bg; g.beginPath(); g.arc(32, 32, 30, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = color; g.font = 'bold 40px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(ch, 32, 34);
  const t = new THREE.CanvasTexture(c);
  F3.tex.set(key, t);
  return t;
}

function makePiece(u, rank) {
  const T = THREE;
  const g = new T.Group();
  const sideCol = u.side === 'player' ? 0x2f5d96 : 0x9a3434;
  const base = new T.Mesh(F3.geo.base, mat3(rank === 'rk-lead' ? 0x8a7020 : sideCol, rank === 'rk-lead' ? { emissive: 0x3a2c08 } : {}));
  base.position.y = 0.035;
  base.castShadow = true;
  const side = mat3(u.side === 'player' ? 0x284f80 : 0x822c2c);
  const front = new T.MeshStandardMaterial({ map: pieceTex(u.side, u.type[0], pieceMark(u), rank), roughness: 0.6 });
  const board = new T.Mesh(F3.geo.board, [side, side, side, side, front, side]);
  board.position.y = 0.07 + 0.46;
  board.castShadow = true;
  // HP バー（いつもこちらを向く板）
  // 下地と緑は同じ深さに重なるので、下地は奥行きを書かずに先に描き、緑を必ずその上に描く（向きによって緑が隠れてちらつかないように）
  const hpBg = new T.Sprite(new T.SpriteMaterial({ color: 0x222222, depthWrite: false }));
  hpBg.center.set(0, 0.5); hpBg.scale.set(0.62, 0.075, 1); hpBg.position.set(-0.31, 1.12, 0); hpBg.renderOrder = 5;
  const hp = new T.Sprite(new T.SpriteMaterial({ color: 0x55cc55 }));
  hp.center.set(0, 0.5); hp.scale.set(0.62, 0.075, 1); hp.position.set(-0.31, 1.12, 0); hp.renderOrder = 6;
  const tgt = new T.Sprite(new T.SpriteMaterial({ map: glyphTex('⚔', '#fff', '#ff5a4f'), depthTest: false }));
  tgt.scale.set(0.36, 0.36, 1); tgt.position.set(0.3, 1.36, 0); tgt.renderOrder = 10;
  const buff = new T.Sprite(new T.SpriteMaterial({ map: glyphTex('▲', '#ffd76f'), depthTest: false }));
  buff.scale.set(0.26, 0.26, 1); buff.position.set(-0.3, 1.32, 0); buff.renderOrder = 10;
  g.add(base, board, hpBg, hp, tgt, buff);
  g.userData = { unit: u, hp, tgt, buff, key: '' };
  board.userData.piece = g;
  base.userData.piece = g;
  return g;
}

function pieceMark(u) { return u.isCommander ? '★' : u.rank === '副将' ? '☆' : u.rank === '兵長' ? '◆' : ''; }

// ------------------------------------------------------------
// 描き直し（renderField の最後に呼ばれる）
// ------------------------------------------------------------

function render3d() {
  if (!F3.renderer) init3d();
  if (F3.map !== state.map) buildMap3d();
  const T = THREE, m = state.map;
  const col = new T.Color(), mix = new T.Color();
  const els = new Map();
  for (const el of document.querySelectorAll('#field .cell[data-x]')) els.set(`${el.dataset.x},${el.dataset.y}`, el.classList);
  const mtx = new T.Matrix4();
  let thin = 0, thick = 0;
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    const cl = els.get(`${x},${y}`);
    if (!cl) continue;
    col.set(cl.contains('charge') ? 0xa8662a : cl.contains('reach') ? 0x3f6a8f : 0x3a4a32);
    if (cl.contains('atkrange')) col.lerp(mix.set(0xd0523e), 0.4);
    if (cl.contains('skillrange')) col.lerp(mix.set(0xaa78ff), 0.4);
    if (cl.contains('deployzone')) col.lerp(mix.set(0xffd76f), 0.12);
    if (cl.contains('fog')) col.multiplyScalar(0.5);
    F3.floor.setColorAt(y * m.w + x, col);
    const ringCol = cl.contains('target') ? 0xff5a4f : cl.contains('acting') ? 0xffc83a : cl.contains('spearhit') ? 0xffd84a : null;
    const [px, pz] = pos3(x, y);
    mtx.makeTranslation(px, 0, pz);
    if (ringCol != null) { F3.ringsThick.setMatrixAt(thick, mtx); F3.ringsThick.setColorAt(thick++, col.set(ringCol)); }
    else if (cl.contains('deployzone')) { F3.ringsThin.setMatrixAt(thin, mtx); F3.ringsThin.setColorAt(thin++, col.set(0xd9b452)); }
  }
  F3.floor.instanceColor.needsUpdate = true;
  for (const r of [F3.ringsThin, F3.ringsThick]) {
    r.count = r === F3.ringsThin ? thin : thick;
    r.instanceMatrix.needsUpdate = true;
    if (r.instanceColor) r.instanceColor.needsUpdate = true;
  }
  // 駒（霧の中の敵は描かない）
  const seen = new Set();
  for (const u of allUnits()) {
    if (!u.alive || (u.side === 'cpu' && !visibleTo('player', u))) continue;
    const cl = els.get(`${u.x},${u.y}`);
    const rank = cl ? (['rk-lead', 'rk-gen', 'rk-sgt'].find(c => cl.contains(c)) || '') : '';
    const key = `${u.side}|${u.type}|${pieceMark(u)}|${rank}`;
    let p = F3.pieces.get(u.id);
    if (p && p.userData.key !== key) { F3.scene.remove(p); p = null; }
    if (!p) {
      p = makePiece(u, rank);
      p.userData.key = key;
      const [px, pz] = pos3(u.x, u.y);
      p.position.set(px, 0, pz);
      F3.pieces.set(u.id, p);
      F3.scene.add(p);
    }
    const d = p.userData;
    [d.tx, d.tz] = pos3(u.x, u.y);
    d.acting = !!cl?.contains('acting');
    d.tgt.visible = !!cl?.contains('target');
    d.buff.visible = !!cl?.contains('buffed');
    d.hp.scale.x = 0.62 * Math.max(0, u.hp / u.maxHp);
    seen.add(u.id);
  }
  for (const [id, p] of F3.pieces) if (!seen.has(id)) { F3.scene.remove(p); F3.pieces.delete(id); }
  place3dCamera();
  F3.dirty = true;
  if (!F3.raf) F3.raf = requestAnimationFrame(loop3d);
}

/** 毎フレーム: 駒を新しい位置へなめらかに動かす・手番の駒を上下させる・⚔ を脈打たせる */
function loop3d(t) {
  F3.raf = null;
  if (!is3d() || document.getElementById('battle').classList.contains('hidden') || document.hidden) return;
  const wrap = $('field-wrap');
  if (wrap.clientWidth !== F3.w || wrap.clientHeight !== F3.h) place3dCamera();
  let busy = false;
  if (F3.yawTo != null) {   // ボタンで回したとき
    const dy = F3.yawTo - F3.yaw;
    if (Math.abs(dy) < 0.002) { F3.yaw = F3.yawTo; F3.yawTo = null; } else F3.yaw += dy * 0.2;
    place3dCamera();
    placeActionPanelSoon();
  }
  for (const p of F3.pieces.values()) {
    if (p.rotation.y !== F3.yaw) { p.rotation.y = F3.yaw; busy = true; }   // 駒の板はいつもカメラの方を向く
    const d = p.userData;
    const dx = d.tx - p.position.x, dz = d.tz - p.position.z;
    if (Math.abs(dx) + Math.abs(dz) > 0.002) { p.position.x += dx * 0.25; p.position.z += dz * 0.25; busy = true; }
    else { p.position.x = d.tx; p.position.z = d.tz; }
    const y = d.acting ? 0.06 + Math.sin(t / 260) * 0.05 : 0;
    if (p.position.y !== y) { p.position.y = y; busy = true; }
    if (d.tgt.visible) { const s = 0.36 * (1 + Math.sin(t / 160) * 0.12); d.tgt.scale.set(s, s, 1); busy = true; }
  }
  if (busy || F3.dirty) { F3.renderer.render(F3.scene, F3.camera); F3.dirty = false; }
  F3.raf = requestAnimationFrame(loop3d);
}

// ------------------------------------------------------------
// カメラ: 斜め上の決まった角度から。zoom.field（1 = 全体が収まる）と F3.pan で寄せる・ずらす
// ------------------------------------------------------------

/** 見ている点からカメラへの向き（長さ 1） */
function camDir(yaw = F3.yaw) { const c = Math.cos(F3.elev); return [Math.sin(yaw) * c, Math.sin(F3.elev), Math.cos(yaw) * c]; }

function place3dCamera() {
  const wrap = $('field-wrap'), W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W || !H) return;
  F3.w = W; F3.h = H;
  F3.renderer.setSize(W, H, false);
  const cam = F3.camera;
  cam.aspect = W / H;
  cam.updateProjectionMatrix();
  const m = state.map;
  // 全体が収まる距離（四隅と駒の頭が画面に入る）を探す。向きは手前から見たときで決める（回しても寄ったり引いたりしないように）
  const key = `${W}x${H}|${m.w}x${m.h}|${m.hex}|${F3.elev.toFixed(3)}`;
  if (F3.fitKey !== key) {
    const hx = (m.hex ? (m.w - 1) * HEX_COL : m.w - 1) / 2 + 0.7, hz = (m.h - 1 + (m.hex ? 0.5 : 0)) / 2 + 0.7;
    const corners = [];
    for (const x of [-hx, hx]) for (const z of [-hz, hz]) for (const y of [0, 1.2]) corners.push(new THREE.Vector3(x, y, z));
    let lo = 1, hi = 300;
    for (let i = 0; i < 40; i++) {
      const d = (lo + hi) / 2;
      const [, sy, sz] = camDir(0);
      cam.position.set(0, d * sy, d * sz); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
      const fits = corners.every(c => { const p = c.clone().project(cam); return Math.abs(p.x) <= 0.96 && Math.abs(p.y) <= 0.96; });
      if (fits) hi = d; else lo = d;
    }
    F3.fitDist = hi;
    F3.fitKey = key;
  }
  clampPan3d();
  const d = F3.fitDist / zoom.field, [sx, sy, sz] = camDir();
  cam.position.set(F3.pan.x + d * sx, d * sy, F3.pan.z + d * sz);
  cam.lookAt(F3.pan.x, 0, F3.pan.z);
  cam.updateMatrixWorld();
  F3.dirty = true;
}

function clampPan3d() {
  const m = state.map;
  const hx = (m.hex ? (m.w - 1) * HEX_COL : m.w - 1) / 2 + 1, hz = (m.h - 1) / 2 + 1;
  F3.pan.x = Math.max(-hx, Math.min(hx, F3.pan.x));
  F3.pan.z = Math.max(-hz, Math.min(hz, F3.pan.z));
}

/** 画面上の点の下にある地面（y = 0）の位置 */
function groundAt3d(cx, cy) {
  const r = F3.renderer.domElement.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2((cx - r.left) / r.width * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), F3.camera);
  const p = new THREE.Vector3();
  return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p) ? p : null;
}

/** 指・マウスで動かした分だけ地図をずらす（画面の移動） */
function pan3d(dx, dy) {
  if (!F3.renderer) return;
  const d = F3.fitDist / zoom.field;
  const perPx = 2 * d * Math.tan(F3_FOV * Math.PI / 360) / F3.h;
  // 画面の右・上に当たる地面の向き（カメラの向きで変わる）
  const c = Math.cos(F3.yaw), s = Math.sin(F3.yaw), up = perPx / Math.sin(F3.elev);
  F3.pan.x -= dx * perPx * c - dy * up * s;
  F3.pan.z -= -dx * perPx * s + dy * up * c;
  place3dCamera();
  placeActionPanelSoon();
}

/** 拡大率を変える。(cx, cy) の下の地点が動かないように寄せる。全体（z = 1、中心指定なし）なら真ん中に戻す */
function zoom3d(z, cx, cy) {
  if (!F3.renderer) { zoom.field = z; return; }
  const before = cx != null ? groundAt3d(cx, cy) : null;
  zoom.field = Math.max(F3_ZOOM_MIN, Math.min(ZOOM_MAX * 1.5, z));
  if (cx == null && z === 1) { F3.pan = { x: 0, z: 0 }; F3.yawTo = nearestTurn(F3.yaw, 0); F3.elev = F3_ELEV; }   // 「全体」: 元の向き・角度に戻す
  place3dCamera();
  const after = before && groundAt3d(cx, cy);
  if (before && after) { F3.pan.x += before.x - after.x; F3.pan.z += before.z - after.z; place3dCamera(); }
  placeActionPanelSoon();
}

/** 0 と同じ向き（360° の倍数）のうち今の向きにいちばん近いもの（回り過ぎずに戻すため） */
function nearestTurn(yaw, to) { return to + Math.round((yaw - to) / (Math.PI * 2)) * Math.PI * 2; }

/** カメラを回す（ラジアン。正 = マップが時計回りに回って見える） */
function rotate3d(da) {
  if (!F3.renderer) return;
  F3.yawTo = null;
  F3.yaw += da;
  place3dCamera();
  placeActionPanelSoon();
}
/** ボタン: 45°（六角は 60°）ずつ、きりのいい向きへなめらかに回す */
function rotateStep3d(dir) {
  if (!F3.renderer) return;
  const step = (state.map?.hex ? 60 : 45) * Math.PI / 180, from = F3.yawTo ?? F3.yaw;
  F3.yawTo = (Math.round(from / step) + dir) * step;
  if (!F3.raf) F3.raf = requestAnimationFrame(loop3d);
}
/** 見下ろす角度を変える（画面の下向き = 正。上へずらすと低い視点に） */
function tilt3d(dy) {
  if (!F3.renderer) return;
  F3.elev = Math.max(F3_ELEV_MIN, Math.min(F3_ELEV_MAX, F3.elev + dy * 0.004));
  place3dCamera();
  placeActionPanelSoon();
}

let panelSoon = null;
function placeActionPanelSoon() {
  if (panelSoon) return;
  panelSoon = requestAnimationFrame(() => { panelSoon = null; placeActionPanel(); });
}

/** マス (x, y) が画面のどこに見えるか（操作の箱を置くため。getBoundingClientRect と同じ形） */
function cellRect3d(x, y, tall = false) {
  const r = F3.renderer.domElement.getBoundingClientRect();
  const [px, pz] = pos3(x, y);
  let [l, t, rt, b] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [ox, oz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) for (const oy of tall ? [0, 1.2] : [0]) {
    const p = new THREE.Vector3(px + ox, oy, pz + oz).project(F3.camera);
    const sx = r.left + (p.x + 1) / 2 * r.width, sy = r.top + (1 - p.y) / 2 * r.height;
    l = Math.min(l, sx); rt = Math.max(rt, sx); t = Math.min(t, sy); b = Math.max(b, sy);
  }
  return { left: l, top: t, right: rt, bottom: b, width: rt - l, height: b - t };
}

// ------------------------------------------------------------
// 操作: 押したマス（駒を押したらその駒のマス）を onCellClick へ。マウスはドラッグで移動・ホイールで拡大縮小
// ------------------------------------------------------------

function initInput3d(canvas) {
  canvas.addEventListener('click', e => {
    if (F3.mouse?.moved) { F3.mouse = null; return; }
    const r = canvas.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), F3.camera);
    const objs = [F3.floor];
    for (const p of F3.pieces.values()) objs.push(p.children[0], p.children[1]);
    const hit = ray.intersectObjects(objs, false)[0];
    if (!hit) return;
    if (hit.object === F3.floor) { const c = F3.cellIndex[hit.instanceId]; if (c) onCellClick(c[0], c[1]); return; }
    const u = hit.object.userData.piece?.userData.unit;
    if (u) onCellClick(u.x, u.y);
  });
  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse' || (e.button !== 0 && e.button !== 2)) return;
    F3.mouse = { x: e.clientX, y: e.clientY, moved: false, down: true, turn: e.button === 2 || e.shiftKey };   // 右ドラッグ（Shift + ドラッグ）= 回転・角度
  });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('pointermove', e => {
    const m = F3.mouse;
    if (!m?.down || e.pointerType !== 'mouse') return;
    const dx = e.clientX - m.x, dy = e.clientY - m.y;
    if (!m.moved && Math.hypot(dx, dy) < 5) return;
    m.moved = true;
    m.x = e.clientX; m.y = e.clientY;
    if (m.turn) { rotate3d(dx * 0.008); tilt3d(dy); } else pan3d(dx, dy);
  });
  window.addEventListener('pointerup', e => { if (F3.mouse && e.pointerType === 'mouse') { F3.mouse.down = false; if (!F3.mouse.moved) F3.mouse = null; } });
  canvas.addEventListener('wheel', e => {
    if (e.ctrlKey) return;   // Ctrl + ホイール（ピンチ）は initZoom が扱う
    e.preventDefault();
    zoom3d(zoom.field * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
  }, { passive: false });
}
