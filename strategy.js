// ============================================================
// ダイス戦記 - 戦域図（戦略レイヤー）
//   軍の編成のあと「出陣」で戦域図へ。プレイヤーとCPUが交互に、すべての隊を動かす（SRPG方式）。
//   敵の隊に隣接して「攻撃」すると局地戦（main.js の局地戦の画面）になり、結果をマップに持ち帰る。
//   main.js より先に読み込む（関数と定数の定義だけ。画面のイベントは initStrategy で登録する）
// ============================================================

const SMAP_MIN_W = 12;
const SMAP_MIN_H = 12;
const SMAP_DICE = { n: 2, sides: 4 };     // 幅・高さ = 最低値 + 2d4（14〜20）
const TERRAIN = {
  '平地': { cost: 1 },
  '森':   { cost: 2 },
  '山':   { cost: 3 },
  '浅瀬': { cost: 2 },
  '川':   { cost: Infinity },             // 通れない（浅瀬から渡る）
};
const SQUAD_VISION_MAP = 3;               // 隊の視界（戦域図）
const SCOUT_VISION_MAP = 6;               // 単独の斥候の視界
const ASSASSIN_VISION_MAP = 2;            // 単独の暗殺者の視界
const FORT_VISION = 3;                    // 守備隊のいる砦の視界
const SCOUT_MOVE_MAP = 6;
const ASSASSIN_MOVE_MAP = 4;
const CPU_ATTACK_RATIO = 0.7;             // CPU は相手を囲む自軍の戦力の合計が相手の 0.7 倍以上なら攻撃する
const HUB_RANGE = 2;                      // 砦・本陣から何マス以内の隊が再編成できるか
const FORT_NAMES = ['東砦', '西砦', '南砦', '北砦', '中砦', '旧砦'];
// 罠（落とし穴）: 斥候が仕掛ける。仕掛けたマスに乗るまで相手には分からない
const TRAPS_PER_SCOUT = 2;                // 斥候1人につき仕掛けられる数
const TRAP_DETECT = 2;                    // 斥候はこのマス数まで近づくと罠を見つける
const TRAP_LOSS = 0.1;                    // かかった隊の兵士の駒は人数の10%を失う
const TRAP_LOSS_CAVALRY = 0.2;            // 騎兵の駒は20%（落とし穴は騎兵に効く）

// ------------------------------------------------------------
// マップ生成
// ------------------------------------------------------------

function smapCell(m, x, y) {
  return x >= 0 && y >= 0 && x < m.w && y < m.h ? m.cells[y * m.w + x] : null;
}

function setCell(m, x, y, t) {
  if (x >= 0 && y >= 0 && x < m.w && y < m.h) m.cells[y * m.w + x] = t;
}

/** 地形の塊をランダムウォークで置く（両軍の本陣の列には置かない） */
function blob(m, type, size) {
  let x = Math.floor(Math.random() * m.w), y = 2 + Math.floor(Math.random() * (m.h - 4));
  for (let i = 0; i < size; i++) {
    if (y >= 2 && y < m.h - 2 && smapCell(m, x, y) === '平地') setCell(m, x, y, type);
    const [dx, dy] = DIRS[Math.floor(Math.random() * 4)];
    x = Math.max(0, Math.min(m.w - 1, x + dx));
    y = Math.max(2, Math.min(m.h - 3, y + dy));
  }
}

/** 地形のコストで最短の移動コスト（ユニットは無視）。from から各マスまで */
function costMap(m, from) {
  const dist = new Array(m.w * m.h).fill(Infinity);
  dist[from.y * m.w + from.x] = 0;
  const open = [[0, from.x, from.y]];
  while (open.length) {
    open.sort((a, b) => a[0] - b[0]);
    const [c, x, y] = open.shift();
    if (c > dist[y * m.w + x]) continue;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy, t = smapCell(m, nx, ny);
      if (!t) continue;
      const nc = c + TERRAIN[t].cost;
      if (nc < dist[ny * m.w + nx]) { dist[ny * m.w + nx] = nc; open.push([nc, nx, ny]); }
    }
  }
  return dist;
}

/** 戦域図を作る: 広さはダイス。森・山・川（浅瀬）と砦を置く。両軍の本陣がつながるまで作り直す */
function genStrategicMap() {
  for (;;) {
    const wd = roll(SMAP_DICE.n, SMAP_DICE.sides), hd = roll(SMAP_DICE.n, SMAP_DICE.sides);
    const m = { w: SMAP_MIN_W + wd.total, h: SMAP_MIN_H + hd.total, wd, hd };
    m.cells = new Array(m.w * m.h).fill('平地');
    for (let i = 0; i < 2 + d(4); i++) blob(m, '森', 4 + d(8));
    for (let i = 0; i < 1 + d(3); i++) blob(m, '山', 3 + d(5));
    // 川: 半分の確率で、中央付近を横切る。浅瀬が 2〜3か所
    if (d(2) === 1) {
      let y = Math.floor(m.h / 2) + d(3) - 2;
      const river = [];
      for (let x = 0; x < m.w; x++) {
        const ny = Math.max(3, Math.min(m.h - 4, y + d(3) - 2));
        for (let yy = Math.min(y, ny); yy <= Math.max(y, ny); yy++) { setCell(m, x, yy, '川'); river.push([x, yy]); }
        y = ny;
      }
      for (let i = 0; i < 1 + d(2); i++) { const [x, yy] = pick(river); setCell(m, x, yy, '浅瀬'); }
    }
    m.bases = { player: { x: Math.floor(m.w / 2), y: m.h - 1 }, cpu: { x: Math.floor((m.w - 1) / 2), y: 0 } };
    // 砦: 1d3+1 か所。中ほどの平地に、互いと本陣から 4マス以上離して置く
    m.forts = [];
    const nForts = 1 + d(3);
    for (let tries = 0; m.forts.length < nForts && tries < 500; tries++) {
      const x = Math.floor(Math.random() * m.w), y = 3 + Math.floor(Math.random() * (m.h - 6));
      if (smapCell(m, x, y) === '川') continue;
      const p = { x, y };
      if (m.forts.some(f => distance(f, p) < 4) || distance(p, m.bases.player) < 4 || distance(p, m.bases.cpu) < 4) continue;
      setCell(m, x, y, '平地');
      m.forts.push({ id: `F${m.forts.length}`, name: FORT_NAMES[m.forts.length], x, y, owner: null });
    }
    const dist = costMap(m, m.bases.player);
    if (dist[m.bases.cpu.y * m.w + m.bases.cpu.x] < Infinity && m.forts.every(f => dist[f.y * m.w + f.x] < Infinity)) return m;
  }
}

// ------------------------------------------------------------
// 隊（トークン）
// ------------------------------------------------------------

function smap() { return campaign.smap; }

function tokenSquad(t) {
  return campaign.armies[t.side].squads.find(q => q.id === t.id);
}

/** 今もいる隊（戦闘で全滅・解散した隊は、結果の反映まで tokens に残るので除く） */
function liveTokens() {
  return smap().tokens.filter(t => tokenSquad(t));
}

function tokenAt(x, y) {
  return liveTokens().find(t => t.x === x && t.y === y);
}

function fortAt(x, y) {
  return smap().forts.find(f => f.x === x && f.y === y);
}

/** 隊の種類: 本隊 / 分隊 / 小隊 / 斥候 / 暗殺者 / 守備隊 */
function tokenKind(t) {
  const army = campaign.armies[t.side], q = tokenSquad(t);
  if (q.garrison) return '守備隊';
  if (q.solo) return memberById(army, q.leader).kind;
  return squadKind(army, q);
}

/** 隊の兵数 */
function tokenTroops(t) {
  return squadTroops(tokenSquad(t));
}

/** 戦力のめやす（CPU の判断用）: 兵数 + 将1人あたり150 */
function tokenStrength(t) {
  const q = tokenSquad(t);
  return squadTroops(q) + 150 * (1 + q.members.length);
}

/** 移動力: 兵数が多いほど遅い。統率オーバーなら −1。単独の斥候・暗殺者は固定、守備隊は動かない */
function tokenMove(t) {
  const kind = tokenKind(t);
  if (kind === '守備隊') return 0;
  if (kind === '斥候') return SCOUT_MOVE_MAP;
  if (kind === '暗殺者') return ASSASSIN_MOVE_MAP;
  const army = campaign.armies[t.side], q = tokenSquad(t);
  const n = squadTroops(q);
  const base = n <= 200 ? 4 : n <= 500 ? 3 : n <= 1000 ? 2 : 1;
  return Math.max(1, base - (overCommand(army, q) ? 1 : 0));
}

function tokenVision(t) {
  const kind = tokenKind(t);
  return kind === '斥候' ? SCOUT_VISION_MAP : kind === '暗殺者' ? ASSASSIN_VISION_MAP : kind === '守備隊' ? FORT_VISION : SQUAD_VISION_MAP;
}

/** その陣営から見えているマス */
function smapSight(side) {
  const m = smap(), seen = new Set();
  for (const t of liveTokens().filter(t => t.side === side)) {
    const r = tokenVision(t);
    for (let dy = -r; dy <= r; dy++) for (let dx = -(r - Math.abs(dy)); dx <= r - Math.abs(dy); dx++) seen.add(`${t.x + dx},${t.y + dy}`);
  }
  // 自軍の砦は見張り台: 守備隊がいなくても周囲が見える
  for (const f of m.forts.filter(f => f.owner === side)) {
    const r = FORT_VISION;
    for (let dy = -r; dy <= r; dy++) for (let dx = -(r - Math.abs(dy)); dx <= r - Math.abs(dy); dx++) seen.add(`${f.x + dx},${f.y + dy}`);
  }
  return seen;
}

/** その陣営から敵の隊 t が見えているか（単独の暗殺者は隣接、斥候なら2マスまで） */
function tokenVisibleTo(side, t) {
  if (t.side === side || !state.fog) return true;
  const mine = liveTokens().filter(o => o.side === side);
  const forts = smap().forts.filter(f => f.owner === side);
  if (tokenKind(t) === '暗殺者') return mine.some(o => distance(o, t) <= (tokenKind(o) === '斥候' ? 2 : 1)) || forts.some(f => distance(f, t) <= 1);
  return mine.some(o => distance(o, t) <= tokenVision(o)) || forts.some(f => distance(f, t) <= FORT_VISION);
}

/** 隊が今のターンに止まれるマス（地形のコスト。敵の隊は通れない、味方の隊は通れるが止まれない） */
function tokenReach(t) {
  return [...tokenPaths(t).stops.values()];
}

/**
 * 移動の経路探索。stops = 止まれるマス、prev = 経路をたどるための1つ前のマス。
 * 敵の隊は通れない、味方の隊は通れるが止まれない。見つけている敵の罠のマスには入らない
 */
function tokenPaths(t) {
  const m = smap(), mp = tokenMove(t);
  const dist = new Map([[`${t.x},${t.y}`, 0]]);
  const prev = new Map();
  const stops = new Map();
  const open = [[0, t.x, t.y]];
  while (open.length) {
    open.sort((a, b) => a[0] - b[0]);
    const [c, x, y] = open.shift();
    if (c > dist.get(`${x},${y}`)) continue;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy, ter = smapCell(m, nx, ny);
      if (!ter) continue;
      const nc = c + TERRAIN[ter].cost, key = `${nx},${ny}`;
      // 移動力が足りなくても、隣の1マスへは必ず進める（移動力1の大部隊が森や山で立ち往生しないように）
      if ((nc > mp && c > 0) || TERRAIN[ter].cost === Infinity || nc >= (dist.get(key) ?? Infinity)) continue;
      const o = tokenAt(nx, ny);
      if (o && o.side !== t.side) continue;
      const trap = trapAt(nx, ny);
      if (trap && trap.side !== t.side && trap.known[t.side]) continue;
      dist.set(key, nc);
      prev.set(key, `${x},${y}`);
      open.push([nc, nx, ny]);
      if (!o) stops.set(key, [nx, ny]); else stops.delete(key);
    }
  }
  return { stops, prev };
}

/** 隣接している、攻撃できる（見えている）敵の隊。単独の斥候は攻撃しない */
function tokenTargets(t) {
  if (tokenKind(t) === '斥候' || tokenKind(t) === '守備隊') return [];
  return liveTokens().filter(o => o.side !== t.side && distance(o, t) === 1 && tokenVisibleTo(t.side, o));
}

/** 隊を移動する。砦に入ったら、守備隊のいない砦は自軍のものになる */
function moveToken(t, x, y) {
  const before = `(${t.x},${t.y})`;
  const q = tokenSquad(t);
  // 経路をたどり、知らない敵の罠があればそこで止まる（単独の暗殺者は罠にかからない）
  const { prev } = tokenPaths(t);
  const path = [];
  for (let k = `${x},${y}`; k && k !== `${t.x},${t.y}`; k = prev.get(k)) path.unshift(k.split(',').map(Number));
  let trap = null;
  if (tokenKind(t) !== '暗殺者') {
    for (let i = 0; i < path.length; i++) {
      const tr = trapAt(path[i][0], path[i][1]);
      if (tr && tr.side !== t.side) {
        trap = tr;
        // 斥候のいる隊は、踏む前に罠に気づいて手前で止まる。ほかは罠のマスで止まる
        // （止まるマスに別の隊がいれば、その手前の空いたマス）
        let j = hasScout(t) ? i - 1 : i;
        while (j >= 0 && tokenAt(path[j][0], path[j][1])) j--;
        [x, y] = j >= 0 ? path[j] : [t.x, t.y];
        break;
      }
    }
  }
  [t.x, t.y] = [x, y];
  if (t.side === 'player' || tokenVisibleTo('player', t)) smapLog(`${q.name} が移動 ${before} → (${x},${y})`, t.side);
  if (trap && hasScout(t)) {
    trap.known[t.side] = true;
    t.acted = true;
    t.trapped = true;
    if (t.side === 'player') smapLog(`🔍 ${q.name} が (${trap.x},${trap.y}) の罠に気づいて足を止めた。`, 'player');
  } else if (trap) springTrap(t, trap);
  const f = fortAt(x, y);
  if (f && f.owner !== t.side && tokenKind(t) !== '斥候' && tokenKind(t) !== '暗殺者') {
    f.owner = t.side;
    smapLog(`🏯 ${q.name} が${f.name}を押さえた！`, t.side);
  }
  updateTrapKnowledge();
}

// ------------------------------------------------------------
// 罠
// ------------------------------------------------------------

function trapAt(x, y) {
  return (smap().traps || []).find(tr => tr.x === x && tr.y === y);
}

/** 斥候がいる隊か（単独の斥候、または配下に斥候がいる隊） */
function hasScout(t) {
  if (tokenKind(t) === '斥候') return true;
  const army = campaign.armies[t.side];
  return tokenSquad(t).members.some(id => memberById(army, id)?.kind === '斥候');
}

/** その陣営が今仕掛けられる罠の残り数（生きている斥候1人につき TRAPS_PER_SCOUT） */
function trapsLeft(side) {
  const scouts = campaign.armies[side].specials.filter(x => x.kind === '斥候').length;
  return scouts * TRAPS_PER_SCOUT - (smap().traps || []).filter(tr => tr.side === side).length;
}

/** 罠を仕掛けられるマス: 隣の空いたマス（川・砦・本陣・すでに罠があるマスは不可） */
function trapCells(t) {
  const m = smap();
  if (!hasScout(t) || trapsLeft(t.side) <= 0) return [];
  return DIRS.map(([dx, dy]) => [t.x + dx, t.y + dy]).filter(([x, y]) => {
    const ter = smapCell(m, x, y);
    return ter && TERRAIN[ter].cost < Infinity && !tokenAt(x, y) && !fortAt(x, y) && !trapAt(x, y) &&
      !Object.values(m.bases).some(b => b.x === x && b.y === y);
  });
}

/** 解除できる罠: 隣接している、見つけている敵の罠 */
function disarmCells(t) {
  if (!hasScout(t)) return [];
  return (smap().traps || []).filter(tr => tr.side !== t.side && tr.known[t.side] && distance(tr, t) === 1).map(tr => [tr.x, tr.y]);
}

function placeTrap(t, x, y) {
  const m = smap();
  m.traps = m.traps || [];
  m.traps.push({ x, y, side: t.side, known: { [t.side]: true } });
  if (t.side === 'player') smapLog(`🪤 ${tokenSquad(t).name} が (${x},${y}) に罠を仕掛けた。`, t.side);
  t.acted = true;
}

function disarmTrap(t, x, y) {
  const m = smap();
  m.traps = m.traps.filter(tr => !(tr.x === x && tr.y === y));
  if (t.side === 'player' || tokenVisibleTo('player', t)) smapLog(`🪤 ${tokenSquad(t).name} が (${x},${y}) の罠を解除した。`, t.side);
  t.acted = true;
}

/** 罠にかかる: 兵士の駒が人数の10%（騎兵は20%）を失い、その隊の行動は終わる */
function springTrap(t, trap) {
  const m = smap(), army = campaign.armies[t.side], q = tokenSquad(t);
  m.traps = m.traps.filter(tr => tr !== trap);
  let lost = 0;
  q.pieces = q.pieces.map(p => {
    const rate = p.type === '騎兵' ? TRAP_LOSS_CAVALRY : TRAP_LOSS;
    const n = Math.min(p.size, Math.max(10, Math.round(p.size * rate / 10) * 10));
    army.totals[p.type] -= n;
    lost += n;
    return { ...p, size: p.size - n };
  }).filter(p => p.size >= MIN_TROOPS);
  t.acted = true;
  t.trapped = true;
  smapLog(`🪤 ${q.name} が罠にかかった！ 兵 ${lost}人を失い、足が止まった。`, trap.side);
}

/** 斥候が近づいた敵の罠を見つける */
function updateTrapKnowledge() {
  const m = smap();
  for (const tr of m.traps || []) {
    for (const side of ['player', 'cpu']) {
      if (side === tr.side || tr.known[side]) continue;
      if (liveTokens().some(o => o.side === side && hasScout(o) && distance(o, tr) <= TRAP_DETECT)) {
        tr.known[side] = true;
        if (side === 'player') smapLog(`🔍 斥候が (${tr.x},${tr.y}) に敵の罠を見つけた！`, 'player');
      }
    }
  }
}

/** 駐留できる副将（隊長以外の配下の副将）。自軍の砦の上にいるときだけ */
function stationOptions(t) {
  const f = fortAt(t.x, t.y);
  if (!f || f.owner !== t.side) return [];
  const army = campaign.armies[t.side];
  return tokenSquad(t).members.map(id => memberById(army, id)).filter(m => m?.rank === '副将');
}

/** 駐留: 副将を砦に残して守備隊にする（隊は隣の空いたマスへ出る） */
function station(t, gid) {
  const m = smap(), army = campaign.armies[t.side], q = tokenSquad(t), f = fortAt(t.x, t.y);
  const exit = DIRS.map(([dx, dy]) => [t.x + dx, t.y + dy])
    .find(([x, y]) => smapCell(m, x, y) && TERRAIN[smapCell(m, x, y)].cost < Infinity && !tokenAt(x, y));
  if (!f || !exit) return false;
  const g = memberById(army, gid);
  q.members = q.members.filter(id => id !== gid);
  const gq = { id: `${t.side}-Q${army.seq++}`, name: `${f.name}守備隊`, leader: gid, members: [], pieces: [], garrison: f.id };
  army.squads.push(gq);
  [t.x, t.y] = exit;
  m.tokens.push({ id: gq.id, side: t.side, x: f.x, y: f.y, acted: true, fort: f.id });
  smapLog(`🏯 ${g.name} が${f.name}に駐留した。`, t.side);
  return true;
}

// ------------------------------------------------------------
// 再編成（自軍の砦・本陣で）
// ------------------------------------------------------------

/** 隊がいる拠点（自軍の本陣か自軍の砦の上・隣）。なければ null */
function hubOf(t) {
  const m = smap();
  const base = m.bases[t.side];
  if (distance(t, base) <= HUB_RANGE) return { kind: 'base', x: base.x, y: base.y, name: '本陣' };
  const f = m.forts.find(f => f.owner === t.side && distance(f, t) <= HUB_RANGE);
  return f ? { kind: 'fort', x: f.x, y: f.y, name: f.name, id: f.id } : null;
}

/** 拠点に集まっている自軍の隊 */
function hubSquads(hub, side) {
  return liveTokens().filter(o => o.side === side && distance(o, hub) <= HUB_RANGE).map(tokenSquad);
}

/** 副将は総大将・副将が率いる隊にだけ入れる（兵長が率いる小隊には入れない） */
function canHold(army, q, mid) {
  const m = memberById(army, mid), lead = memberById(army, q.leader);
  return !(m?.rank === '副将' && !lead?.rank);
}

function reorg(op, a) {
  const army = campaign.armies.player, hub = ui.reorg;
  const group = hubSquads(hub, 'player');
  const Q = id => group.find(q => q.id === id);
  const from = Q(a.from), to = Q(a.to);
  const fail = msg => { alert(msg); return false; };
  switch (op) {
    case 'piece': {   // 兵士の駒を別の隊へ（to なしなら予備へ: 本陣だけ）
      const piece = from.pieces[a.i];
      if (to) {
        const why = pieceBlock(army, to, piece.size);
        if (why) return fail(why);
        to.pieces.push(piece);
      } else if (hub.kind !== 'base') return fail('予備に戻せるのは本陣だけです。');
      from.pieces.splice(a.i, 1);
      break;
    }
    case 'member': {  // 配下の将・斥候・暗殺者を別の隊へ（to なしなら予備へ: 本陣だけ）
      if (to) {
        if (!canHold(army, to, a.id)) return fail('副将は、兵長が率いる小隊には入れません。');
        if (memberUse(memberById(army, a.id)) > squadRoom(army, to)) return fail(`${to.name}が率いられるのはあと${Math.max(0, squadRoom(army, to))}人分です。`);
        to.members.push(a.id);
      } else if (hub.kind !== 'base') return fail('予備に戻せるのは本陣だけです。');
      from.members = from.members.filter(x => x !== a.id);
      break;
    }
    case 'split': {   // 配下の副将・兵長を隊長にして、新しい隊を作る
      const m = smap();
      const cell = [];
      // 拠点にいちばん近い空きマス（拠点の範囲内）に置く
      for (let dy = -HUB_RANGE; dy <= HUB_RANGE; dy++) for (let dx = -HUB_RANGE; dx <= HUB_RANGE; dx++) {
        const x = hub.x + dx, y = hub.y + dy, ter = smapCell(m, x, y);
        if (ter && TERRAIN[ter].cost < Infinity && !tokenAt(x, y) && distance({ x, y }, hub) <= HUB_RANGE) cell.push([x, y]);
      }
      cell.sort((p1, p2) => distance({ x: p1[0], y: p1[1] }, hub) - distance({ x: p2[0], y: p2[1] }, hub));
      if (!cell.length) return fail(`拠点のまわり（${HUB_RANGE}マス以内）に新しい隊を置く空きマスがありません。`);
      from.members = from.members.filter(x => x !== a.id);
      const leader = memberById(army, a.id);
      const q = { id: `player-Q${army.seq++}`, name: `${leader.name}隊`, leader: a.id, members: [], pieces: [] };
      army.squads.push(q);
      m.tokens.push({ id: q.id, side: 'player', x: cell[0][0], y: cell[0][1], acted: true });
      smapLog(`🏯 ${hub.name}で ${q.name} を編成した。`, 'player');
      break;
    }
    case 'merge': {   // 隊ごと別の隊に合流（隊長は合流先の配下になる）
      if (!canHold(army, to, from.leader)) return fail('副将が率いる隊は、兵長が率いる小隊には合流できません。');
      to.pieces.push(...from.pieces);
      to.members.push(from.leader, ...from.members);
      army.squads = army.squads.filter(q => q !== from);
      smap().tokens = smap().tokens.filter(t => t.id !== from.id);
      smapLog(`🏯 ${from.name} が ${to.name} に合流した。`, 'player');
      break;
    }
    case 'addpiece': {  // 予備から兵士の駒を足す（本陣だけ）
      const size = Math.floor(a.size / 10) * 10;
      if (size < MIN_PIECE) return fail(`新しい駒は${MIN_PIECE}人以上です。`);
      if (size > poolLeft(army, a.type)) return fail(`${a.type}の予備は${poolLeft(army, a.type)}人です。`);
      const why = pieceBlock(army, to, size);
      if (why) return fail(why);
      to.pieces.push({ type: a.type, size });
      break;
    }
    case 'addmember': {  // 予備の将・斥候・暗殺者を隊に入れる（本陣だけ）
      if (!canHold(army, to, a.id)) return fail('副将は、兵長が率いる小隊には入れません。');
      if (memberUse(memberById(army, a.id)) > squadRoom(army, to)) return fail(`${to.name}が率いられるのはあと${Math.max(0, squadRoom(army, to))}人分です。`);
      to.members.push(a.id);
      break;
    }
  }
  saveCampaign();
  renderCampaign();
  renderStrat();
  return true;
}

/** 再編成の画面（拠点に集まっている隊どうしで、駒・将の受け渡し、分割、合流。本陣では予備も使える） */
function renderReorg() {
  const hub = ui.reorg, army = campaign.armies.player;
  const group = hubSquads(hub, 'player');
  if (!group.length) { ui.reorg = null; return ''; }
  const atBase = hub.kind === 'base';
  const desc = m => m.kind ? `${m.name}（${m.kind}）` : `${m.name}（${m.rank || m.type + '長'}）`;
  const dests = (q, extra = '') => `<option value="">移す…</option>${group.filter(o => o !== q).map(o => `<option value="${o.id}">→ ${o.name}</option>`).join('')}${atBase ? '<option value="__pool">→ 予備</option>' : ''}${extra}`;
  const rows = group.map(q => {
    const lead = memberById(army, q.leader);
    const pieces = q.pieces.map((p, i) => `<span class="chip">${p.type}${p.size}
      <select class="ro" data-op="piece" data-from="${q.id}" data-i="${i}">${dests(q)}</select></span>`).join('') || '<span class="sub">なし</span>';
    const members = q.members.map(id => { const m = memberById(army, id); return `<span class="chip">${desc(m)}
      <select class="ro" data-op="member" data-from="${q.id}" data-id="${id}">${dests(q)}</select>
      ${!m.kind ? `<button class="small ro-btn" data-op="split" data-from="${q.id}" data-id="${id}">新しい隊に</button>` : ''}</span>`; }).join('') || '<span class="sub">なし</span>';
    const merge = q.name !== '本隊' && group.length > 1   // 守備隊も隊ごと合流できる（砦の守りを解いて、副将がほかの隊に戻る）
      ? `<select class="ro" data-op="merge" data-from="${q.id}"><option value="">隊ごと合流…</option>${group.filter(o => o !== q).map(o => `<option value="${o.id}">→ ${o.name}</option>`).join('')}</select>` : '';
    const add = atBase ? `<div class="ro-add">予備から:
      <select data-role="ro-type">${TYPE_NAMES.map(t => `<option>${t}</option>`).join('')}</select>
      <input type="number" data-role="ro-size" value="${PIECE_DEFAULT}" step="10" min="${MIN_PIECE}">人
      <button class="small ro-btn" data-op="addpiece" data-to="${q.id}">駒を足す</button>
      <select class="ro" data-op="addmember" data-to="${q.id}"><option value="">将などを入れる…</option>${
        [...army.generals.filter(g => g.rank === '副将'), ...army.sergeants, ...army.specials].filter(m => !squadOf(army, m.id)).map(m => `<option value="${m.id}">${desc(m)}</option>`).join('')}</select></div>` : '';
    return `<div class="squad"><div class="sq-head"><b>${q.name}</b>（${squadKind(army, q)}）隊長 ${desc(lead)} ／ 率いる人数 ${squadUsed(army, q)}/${squadMenCap(army, q)}人分 ／ 駒 ${q.pieces.length}/${squadCap(army, q)} ／ 兵 ${squadTroops(q)}人 ${merge}</div>
      <div>配下: ${members}</div><div>兵士の駒: ${pieces}</div>${add}</div>`;
  }).join('');
  return `<div class="reorg"><div class="ap-head"><b>🏯 ${hub.name}で再編成</b> <button class="small" id="sm-reorg-close">閉じる</button></div>
    <div class="sub">拠点（${atBase ? '本陣' : '砦'}）から${HUB_RANGE}マス以内にいる隊どうしで、駒や将を受け渡し・分割・合流できます（行動は使いません）。${atBase ? '本陣では予備の兵・将も使えます。' : '予備の兵・将は本陣でしか使えません。'}</div>
    ${atBase ? `<div class="sub">予備: ${TYPE_NAMES.map(t => `${t}${poolLeft(army, t)}`).join('・')}</div>` : ''}
    ${rows}</div>`;
}

// ------------------------------------------------------------
// 出陣（戦域図の開始）
// ------------------------------------------------------------

/** 本陣の近くの空いたマスへ、隊を順に置く */
function deploy(side) {
  const m = smap(), army = campaign.armies[side], base = m.bases[side];
  // どの隊にも入っていない斥候・暗殺者は、単独の隊として出る
  for (const x of army.specials.filter(x => !squadOf(army, x.id))) {
    army.squads.push({ id: `${side}-Q${army.seq++}`, name: x.name, leader: x.id, members: [], pieces: [], solo: true });
  }
  const order = [...army.squads].sort((a, b) => (a.name === '本隊' ? -1 : b.name === '本隊' ? 1 : 0));
  const dist = costMap(m, base);
  const cells = [];
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    if (TERRAIN[smapCell(m, x, y)].cost < Infinity && !fortAt(x, y)) cells.push({ x, y, c: dist[y * m.w + x] + distance({ x, y }, base) * 0.01 });
  }
  cells.sort((a, b) => a.c - b.c);
  order.forEach((q, i) => m.tokens.push({ id: q.id, side, x: cells[i].x, y: cells[i].y, acted: false }));
}

function startMapStage() {
  const A = campaign.armies;
  if (!A || A.player.defeated || A.cpu.defeated) return;
  campaign.smap = genStrategicMap();
  campaign.setup = null;   // ゲーム開始の手順はここで終わり
  Object.assign(campaign.smap, { tokens: [], traps: [], turn: 1, phase: 'player', cpuQueue: [], battle: null, pending: null, logs: [] });
  deploy('player');
  deploy('cpu');
  ui.selected = null;
  smapLog(`🗺 戦域図 ${campaign.smap.w}×${campaign.smap.h}（幅 ${SMAP_MIN_W}+🎲[${campaign.smap.wd.dice.join('][')}] / 高さ ${SMAP_MIN_H}+🎲[${campaign.smap.hd.dice.join('][')}]）。砦 ${campaign.smap.forts.length}か所`, 'turn');
  smapLog('--- ターン 1（自軍） ---', 'turn');
  saveCampaign();
  renderCampaign();
  renderStrat();
  showView('map');
}

// ------------------------------------------------------------
// 戦闘（戦術レイヤーへ）
// ------------------------------------------------------------

function attackToken(t, target) {
  const m = smap();
  const pt = t.side === 'player' ? t : target, ct = t.side === 'player' ? target : t;
  t.acted = true;
  m.battle = { player: pt.id, cpu: ct.id, attacker: t.side };
  smapLog(`⚔ ${tokenSquad(t).name} が ${tokenSquad(target).name} に攻撃！`, t.side);
  saveCampaign();
  startCampaignBattle(pt.id, ct.id);
  if (t.side === 'cpu') log(`CPU軍の攻撃！ 迎え撃つのは ${tokenSquad(pt).name} です。`, 'turn');
  // 砦の守り: 自軍の砦の上か隣にいる隊（守備隊を含む）は DEF +20%
  if (state.campaignBattle) {
    const bonus = side => { const tok = side === 'player' ? pt : ct; return !!tok.fort || m.forts.some(f => f.owner === side && distance(f, tok) <= 1); };
    state.campaignBattle.fortBonus = { player: bonus('player'), cpu: bonus('cpu') };
    for (const side of ['player', 'cpu']) if (state.campaignBattle.fortBonus[side]) log(`🏯 ${side === 'player' ? '自軍' : 'CPU軍'}は砦の守りを得ている（DEF +${Math.round(FORT_DEF * 100)}%）`, side);
    saveGame();
  }
  renderStrat();
}

/** 局地戦が終わったとき（main.js の applyBattleResult から呼ばれる） */
function onMapBattleEnd(msg) {
  const m = smap();
  if (!m || !m.battle || m.pending) return;
  m.pending = { ...m.battle, msg };
  smapLog(`📜 戦闘の結果: ${msg}`, 'turn');
  saveCampaign();
  renderStrat();
}

/** 「戦域図に戻る」: 戦闘の結果をマップに反映する（全滅した隊は消え、負けた隊は1マス下がり、砦は落ちる） */
function resolvePending() {
  const m = smap(), p = m.pending, A = campaign.armies;
  if (!p) return;
  const winner = /勝利/.test(p.msg) ? 'player' : /敗北/.test(p.msg) ? 'cpu' : null;
  for (const side of ['player', 'cpu']) {
    const t = m.tokens.find(x => x.id === p[side]);
    if (!t) continue;
    const q = tokenSquad(t);
    const lost = winner && winner !== side;
    if (t.fort) {
      // 守備隊: 負けるか全滅したら砦は落ちる（生き残った副将は予備に戻る）
      if (lost || !q) {
        const f = m.forts.find(x => x.id === t.fort);
        if (lost) { f.owner = winner; smapLog(`🏯 ${f.name}が陥落した！`, winner); }
        if (q) A[side].squads = A[side].squads.filter(x => x !== q);
      }
    } else if (q && lost) {
      // 負けた隊は相手から1マス離れる（空いていて通れるマスがあれば）
      const foe = m.tokens.find(x => x.id === p[winner]) || t;
      const exits = DIRS.map(([dx, dy]) => ({ x: t.x + dx, y: t.y + dy }))
        .filter(c => smapCell(m, c.x, c.y) && TERRAIN[smapCell(m, c.x, c.y)].cost < Infinity && !tokenAt(c.x, c.y) && distance(c, foe) > distance(t, foe));
      if (exits.length) {
        const c = pick(exits);
        [t.x, t.y] = [c.x, c.y];
        smapLog(`${q.name} は退いた。`, side);
      }
    }
  }
  // 全滅・解散した隊を消す
  m.tokens = m.tokens.filter(t => tokenSquad(t));
  m.battle = null;
  m.pending = null;
  setBattleOpen(false);
  if (A.player.defeated || A.cpu.defeated) {
    m.phase = 'over';
    smapLog(A.cpu.defeated ? '🏆 CPU軍の総大将を討ち取った！ 自軍の勝利！' : '💀 総大将を失い、自軍は敗北した。', 'turn');
  }
  saveCampaign();
  renderCampaign();
  renderStrat();
  if (m.phase === 'cpu') setTimeout(cpuRun, 300);
}

// ------------------------------------------------------------
// ターン
// ------------------------------------------------------------

function endPlayerTurn() {
  const m = smap();
  if (m.phase !== 'player' || m.battle) return;
  ui.selected = null;
  m.phase = 'cpu';
  for (const t of m.tokens) t.acted = false;
  m.cpuQueue = m.tokens.filter(t => t.side === 'cpu').map(t => t.id);
  smapLog(`--- ターン ${m.turn}（CPU軍） ---`, 'turn');
  renderStrat();
  setTimeout(cpuRun, 300);
}

/** CPU の隊を順に動かす。戦闘が始まったらそこで止まり、結果の反映後に続きから */
function cpuRun() {
  const m = smap();
  if (!m || m.phase !== 'cpu' || m.battle) return;
  while (m.cpuQueue.length) {
    const t = m.tokens.find(x => x.id === m.cpuQueue[0]);
    m.cpuQueue.shift();
    if (!t || !tokenSquad(t)) continue;
    if (cpuAct(t)) return;   // 戦闘開始
  }
  m.phase = 'player';
  m.turn++;
  for (const t of m.tokens) t.acted = false;
  smapLog(`--- ターン ${m.turn}（自軍） ---`, 'turn');
  updateTrapKnowledge();
  saveCampaign();
  renderStrat();
}

/** CPU が攻撃したい相手（隣接・見えている・勝てそうな相手。弱い順） */
function cpuTarget(t) {
  // 相手を囲んでいる味方（隣接しているCPUの隊）の戦力も合わせて考える（順に攻めかかれば削り切れる）
  const around = o => liveTokens().filter(x => x.side === t.side && distance(x, o) === 1 && tokenKind(x) !== '斥候')
    .reduce((a, x) => a + tokenStrength(x), 0);
  return tokenTargets(t)
    .filter(o => ['守備隊', '斥候'].includes(tokenKind(o)) || tokenKind(t) === '暗殺者' || around(o) >= tokenStrength(o) * CPU_ATTACK_RATIO)
    .sort((a, b) => tokenStrength(a) - tokenStrength(b))[0] || null;
}

/** CPU の1隊分の行動。戦闘を始めたら true */
function cpuAct(t) {
  const m = smap(), kind = tokenKind(t);
  if (kind === '守備隊') return false;
  let target = cpuTarget(t);
  if (target) { attackToken(t, target); return true; }
  // 総大将は本陣で待つ（砦をすべて押さえたか、ほかに動ける隊がいなくなったら自ら出る）
  if (kind === '本隊' && m.forts.some(f => f.owner !== 'cpu') &&
      liveTokens().some(o => o.side === 'cpu' && o !== t && !['守備隊', '斥候'].includes(tokenKind(o)))) return false;
  // 自軍の砦にいて余っている副将がいれば駐留させる
  const opts = stationOptions(t);
  const f0 = fortAt(t.x, t.y);
  if (opts.length && f0 && !liveTokens().some(o => o !== t && o.x === f0.x && o.y === f0.y)) station(t, opts[0].id);
  // 目標: 自軍のものでない砦（ほかの隊が狙っていない近いもの）→ 見えている敵 → 敵の本陣
  const sight = new Set(liveTokens().filter(o => o.side === 'player' && tokenVisibleTo('cpu', o)).map(o => o.id));
  const claimed = new Set(liveTokens().filter(o => o.side === 'cpu' && o !== t && o.goal).map(o => o.goal));
  let goal;
  if (kind === '斥候') goal = m.bases.player;
  else {
    const forts = m.forts.filter(f => f.owner !== 'cpu' && !claimed.has(f.id) && kind !== '暗殺者')
      .sort((a, b) => (b.id === t.goal) - (a.id === t.goal) || distance(a, t) - distance(b, t));   // 今の目標を優先
    const foes = liveTokens().filter(o => sight.has(o.id)).sort((a, b) => distance(a, t) - distance(b, t));
    if (forts[0]) { goal = forts[0]; t.goal = forts[0].id; }
    else goal = foes[0] || m.bases.player;
  }
  const dist = costMap(m, goal);
  const reach = tokenReach(t);
  // 斥候は見えている敵から3マス以上離れる
  const safe = ([x, y]) => kind !== '斥候' || liveTokens().every(o => o.side === 'cpu' || !sight.has(o.id) || distance(o, { x, y }) >= 3);
  let best = null, bestC = dist[t.y * m.w + t.x];
  for (const [x, y] of reach) {
    const c = dist[y * m.w + x] + Math.random() * 0.3;
    if (safe([x, y]) && c < bestC) { bestC = c; best = [x, y]; }
  }
  // 見つけている罠が隣にあれば解除してこのターンは終わり
  const dis = disarmCells(t);
  if (dis.length) { disarmTrap(t, dis[0][0], dis[0][1]); return false; }
  if (best) moveToken(t, best[0], best[1]);
  if (t.trapped) { t.trapped = false; return false; }   // 罠にかかって足が止まった
  if (t.goal && fortAt(t.x, t.y)?.owner === 'cpu') t.goal = null;
  // 斥候がいれば、自軍の本陣より前で、プレイヤーの本陣へ向かう側に罠を仕掛ける（ときどき）
  const tc = trapCells(t).filter(([x, y]) => y > m.bases.cpu.y + 2);
  if (tc.length && d(3) === 1) {
    const pd = costMap(m, m.bases.player);
    tc.sort((a, b) => pd[a[1] * m.w + a[0]] - pd[b[1] * m.w + b[0]]);
    placeTrap(t, tc[0][0], tc[0][1]);
    return false;
  }
  // 見えている敵を目指して隣まで来たなら、戦力で劣っていても攻めかかる（隣で睨み合ったまま動かなくなるのを防ぐ）
  target = cpuTarget(t) || (goal && goal.side === 'player' && tokenTargets(t).includes(goal) ? goal : null);
  if (target) { attackToken(t, target); return true; }
  t.acted = true;
  return false;
}

// ------------------------------------------------------------
// 画面
// ------------------------------------------------------------

const ui = { selected: null, moved: false, mode: null, reorg: null, info: null, anchor: null };   // anchor = 操作の箱を寄せるマス [x, y] / 'center'   // reorg = 再編成中の拠点、info = 説明を出している砦・本陣   // mode = 'trap'（罠を仕掛ける）/ 'disarm'（解除）

function smapLog(text, cls = 'sys') {
  const m = smap();
  if (!m) return;
  m.logs.push({ text, cls });
  if (m.logs.length > 200) m.logs.splice(0, m.logs.length - 200);
}

function tokenGlyph(t) {
  const kind = tokenKind(t);
  return { '本隊': '★本', '分隊': '☆', '小隊': '◆', '斥候': '斥', '暗殺者': '暗', '守備隊': '守' }[kind] || '?';
}

/** 描き直しでスクロール位置が先頭に戻されないよう、覚えておいて描き直した後に戻す */
function renderStrat() {
  const wrap = $('smap-wrap'), keep = [wrap.scrollTop, wrap.scrollLeft, window.scrollY];
  renderStratBody();
  [wrap.scrollTop, wrap.scrollLeft] = keep;
  if (window.scrollY !== keep[2]) window.scrollTo(window.scrollX, keep[2]);
}

function renderStratBody() {
  const box = $('strat-box'), m = smap();
  box.classList.toggle('hidden', !m);
  $('strat-empty').classList.toggle('hidden', !!m);
  if (!m) return;
  const A = campaign.armies;
  const sight = state.fog ? smapSight('player') : null;
  const sel = liveTokens().find(t => t.id === ui.selected);
  const myTurn = m.phase === 'player' && !m.battle;
  if (!sel || sel.acted || !myTurn) ui.mode = null;
  const reach = new Set(sel && myTurn && !sel.acted && !ui.moved && !ui.mode ? tokenReach(sel).map(([x, y]) => `${x},${y}`) : []);
  const modeCells = new Set(!sel || !ui.mode ? [] : (ui.mode === 'trap' ? trapCells(sel) : disarmCells(sel)).map(([x, y]) => `${x},${y}`));
  const targets = new Set(sel && myTurn && !sel.acted ? tokenTargets(sel).map(o => o.id) : []);
  const grid = $('smap');
  grid.style.gridTemplateColumns = `repeat(${m.w}, minmax(0, 1fr))`;
  let html = '';
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    const ter = smapCell(m, x, y), f = fortAt(x, y);
    let t = tokenAt(x, y);
    if (t && !tokenVisibleTo('player', t)) t = null;
    const base = m.bases.player.x === x && m.bases.player.y === y ? 'player' : m.bases.cpu.x === x && m.bases.cpu.y === y ? 'cpu' : null;
    const tr = trapAt(x, y);
    const trapShown = tr && tr.known.player;
    const cls = ['scell', `t-${ter}`,
      ui.mode && modeCells.has(`${x},${y}`) ? 'trapmode' : '',
      sight && !sight.has(`${x},${y}`) ? 'fog' : '',
      reach.has(`${x},${y}`) ? 'reach' : '',
      t && targets.has(t.id) ? 'target' : '',
      t ? (t.side === 'player' ? 'p' : 'c') : '',
      t && t === sel ? 'acting' : '',
      t && t.side === 'player' && t.acted && m.phase === 'player' ? 'done' : '',
      f ? `fortcell fort-${f.owner || 'none'}` : ''].filter(Boolean).join(' ');
    const title = t ? `${tokenSquad(t).name}（${tokenKind(t)}）兵 ${tokenTroops(t)}人 / 移動 ${tokenMove(t)}`
      : f ? `${f.name}（${f.owner ? (f.owner === 'player' ? '自軍' : 'CPU軍') : '中立'}）` : ter;
    html += `<div class="${cls}" data-x="${x}" data-y="${y}" title="${title}">` +
      (f ? `<span class="fort ${f.owner ? 'own-' + f.owner : ''}">🏯</span>` : '') +
      (base ? `<span class="base own-${base}">陣</span>` : '') +
      (trapShown ? `<span class="trap ${tr.side === 'player' ? 'own' : 'foe'}">🪤</span>` : '') +
      (t ? `<span class="glyph">${tokenGlyph(t)}</span>` : '') +
      (t && targets.has(t.id) ? '<span class="tgt-mark">⚔</span>' : '') + `</div>`;
  }
  grid.innerHTML = html;
  applyZoom('smap');
  const forts = side => m.forts.filter(f => f.owner === side).length;
  $('strat-label').textContent = `${m.w}×${m.h}　ターン ${m.turn}（${m.phase === 'player' ? '自軍の番' : m.phase === 'cpu' ? 'CPU軍の番' : '決着'}）　砦 自軍${forts('player')} / CPU${forts('cpu')} / 中立${m.forts.length - forts('player') - forts('cpu')}`;
  // 操作: 右上の箱（hud: 状況・ターン終了）と、選んだマスの近くに出る箱（info: 隊の操作・砦の説明。再編成は大きく中央に）
  let info = '', hud = '';
  ui.anchor = null;
  if (m.phase === 'over') {
    hud = `<div class="result">${A.cpu.defeated ? '🏆 自軍の勝利！' : '💀 自軍の敗北…'}</div>`;
  } else if (m.pending) {
    hud = `<div>戦闘の結果: <b>${m.pending.msg}</b></div><button id="sm-resolve">結果を反映する</button>`;
  } else if (m.battle) {
    hud = `<div>⚔ 戦闘中: ${A.player.squads.find(q => q.id === m.battle.player)?.name} vs ${A.cpu.squads.find(q => q.id === m.battle.cpu)?.name}</div>
      <button id="sm-open-battle">⚔ 局地戦の画面を開く</button>`;
  } else if (m.phase === 'cpu') {
    hud = '<div>CPU軍が行動中…</div>';
  } else if (ui.reorg) {
    info = renderReorg();
    ui.anchor = 'center';
  } else if (sel && sel.side === 'player') {
    ui.anchor = [sel.x, sel.y];
    const q = tokenSquad(sel), opts = stationOptions(sel);
    const hub = hubOf(sel);
    info = `<div><b>${q.name}</b>（${tokenKind(sel)}）兵 ${tokenTroops(sel)}人 ／ 移動 ${tokenMove(sel)} ／ 視界 ${tokenVision(sel)}${sel.acted ? ' ／ 行動済み' : ''}</div>
      <div class="sub">${sel.acted ? '' : ui.mode === 'trap' ? '黄色のマスをクリックして罠を仕掛けます（行動を使います）。' : ui.mode === 'disarm' ? '黄色のマスの罠をクリックして解除します（行動を使います）。' : ui.moved ? '点滅する赤枠（⚔）の敵をクリックで攻撃、または「待機」。' : '青いマスをクリックで移動。隣の点滅する赤枠（⚔）の敵をクリックで攻撃。'}</div>
      <div class="ap-buttons">
        ${!sel.acted ? '<button id="sm-wait">待機</button>' : ''}
        ${!sel.acted && hasScout(sel) ? `<button id="sm-trap" class="${ui.mode === 'trap' ? 'skill' : ''}" ${trapCells(sel).length ? '' : 'disabled'}>🪤 罠を仕掛ける（残り${trapsLeft('player')}）</button>` : ''}
        ${!sel.acted && disarmCells(sel).length ? `<button id="sm-disarm" class="${ui.mode === 'disarm' ? 'skill' : ''}">罠を解除</button>` : ''}
        ${!sel.acted && opts.length ? `<select id="sm-station"><option value="">副将を駐留させる…</option>${opts.map(g => `<option value="${g.id}">${g.name}</option>`).join('')}</select>` : ''}
        ${hub ? `<button id="sm-reorg">🏯 ${hub.name}で再編成</button>` : ''}
      </div>
      ${hub ? `<div class="sub">${hub.name}の近く（${HUB_RANGE}マス以内）にいるので、再編成できます${m.forts.some(f => f.owner === 'player' && distance(f, sel) <= 1) ? `。戦闘になると砦の守り（DEF +${Math.round(FORT_DEF * 100)}%）` : ''}。</div>` : ''}`;
  } else if (ui.info) {
    info = placeInfo(ui.info);
    const f = m.forts.find(f => f.id === ui.info), b = f || m.bases[ui.info === 'base-player' ? 'player' : 'cpu'];
    ui.anchor = [b.x, b.y];
  }
  if (m.phase === 'player' && !m.battle) {
    hud += `<div class="ap-buttons"><button id="sm-end">ターン終了</button></div>`;
  }
  $('strat-hud').innerHTML = hud;
  $('strat-hud').classList.toggle('hidden', !hud);
  $('smap-log').innerHTML = m.logs.slice(-30).reverse().map(l => `<div class="${l.cls}">${fmtLog(l.text)}</div>`).join('');
  if (info && ui.anchor !== 'center') info = '<button class="small ap-close" id="sm-close" title="閉じる">✕</button>' + info;
  $('strat-info').innerHTML = info;
  $('strat-info').classList.toggle('hidden', !info);
  placeStratInfo();
  const on = (id, ev, fn) => { const el = $(id); if (el) el[ev] = fn; };
  on('sm-resolve', 'onclick', resolvePending);
  on('sm-close', 'onclick', () => { ui.selected = null; ui.info = null; ui.moved = false; ui.mode = null; renderStrat(); });
  on('sm-open-battle', 'onclick', () => setBattleOpen(true));
  on('sm-reorg', 'onclick', () => { ui.reorg = hubOf(sel); ui.mode = null; renderStrat(); });
  on('sm-reorg-close', 'onclick', () => { ui.reorg = null; renderStrat(); });
  const box2 = $('strat-info');
  box2.querySelectorAll('select.ro').forEach(el => el.onchange = () => {
    if (!el.value) return;
    const d = el.dataset, to = el.value === '__pool' ? null : el.value;
    if (d.op === 'addmember') reorg('addmember', { to: d.to, id: el.value });
    else reorg(d.op, { from: d.from, to, i: +d.i, id: d.id });
  });
  box2.querySelectorAll('button.ro-btn').forEach(el => el.onclick = () => {
    const d = el.dataset;
    if (d.op === 'addpiece') {
      const row = el.closest('.ro-add');
      reorg('addpiece', { to: d.to, type: row.querySelector('[data-role=ro-type]').value, size: +row.querySelector('[data-role=ro-size]').value });
    } else reorg('split', { from: d.from, id: d.id });
  });
  on('sm-end', 'onclick', () => {
    // まだ動ける隊があれば確認する
    const left = liveTokens().filter(t => t.side === 'player' && !t.acted && (tokenMove(t) > 0 || tokenTargets(t).length));
    if (left.length && !confirm(`まだ行動できる隊があります（${left.map(t => tokenSquad(t).name).join('・')}）。\nターンを終了しますか？`)) return;
    endPlayerTurn();
  });
  on('sm-trap', 'onclick', () => { ui.mode = ui.mode === 'trap' ? null : 'trap'; renderStrat(); });
  on('sm-disarm', 'onclick', () => { ui.mode = ui.mode === 'disarm' ? null : 'disarm'; renderStrat(); });
  on('sm-wait', 'onclick', () => { sel.acted = true; ui.selected = null; ui.moved = false; saveCampaign(); renderStrat(); });
  on('sm-station', 'onchange', e => {
    if (e.target.value && station(sel, e.target.value)) { sel.acted = true; ui.selected = null; ui.moved = false; saveCampaign(); renderCampaign(); }
    renderStrat();
  });
}

/** 操作の箱を、選んだマスの近く（右、入らなければ左）に置く。マップのスクロール・拡大でも付いていく */
function placeStratInfo() {
  const box = $('strat-info'), stage = $('strat-stage');
  if (!box || box.classList.contains('hidden')) return;
  box.classList.toggle('center', ui.anchor === 'center');
  if (!Array.isArray(ui.anchor)) { box.style.left = box.style.top = ''; return; }
  const cell = document.querySelector(`#smap .scell[data-x="${ui.anchor[0]}"][data-y="${ui.anchor[1]}"]`);
  if (!cell) return;
  const S = stage.getBoundingClientRect(), C = cell.getBoundingClientRect();
  const w = box.offsetWidth, h = box.offsetHeight, gap = 8;
  const clampX = v => Math.max(gap, Math.min(S.width - w - gap, v)), clampY = v => Math.max(gap, Math.min(S.height - h - gap, v));
  let left, top;
  if (C.right - S.left + gap + w <= S.width - gap) [left, top] = [C.right - S.left + gap, clampY(C.top - S.top - 10)];   // 右
  else if (C.left - S.left - gap - w >= gap) [left, top] = [C.left - S.left - gap - w, clampY(C.top - S.top - 10)];   // 左
  else {
    // 横に入らない（縦長の画面）: マスの下、入らなければ上。マスにかぶらないように
    left = clampX(C.left - S.left + C.width / 2 - w / 2);
    const below = C.bottom - S.top + gap, above = C.top - S.top - gap - h;
    top = below + h <= S.height - gap ? below : above >= gap ? above : (S.height - h - gap);
  }
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(top)}px`;
}

/** 砦・本陣の説明 */
function placeInfo(key) {
  const m = smap();
  const f = m.forts.find(f => f.id === key);
  if (f) {
    const g = liveTokens().find(t => t.fort === f.id);
    const owner = f.owner ? (f.owner === 'player' ? '自軍' : 'CPU軍') : '中立';
    return `<div><b>🏯 ${f.name}</b>（${owner}）${g && tokenVisibleTo('player', g) ? ` 守備隊: ${tokenSquad(g).name}` : ''}</div>
      <div class="sub">砦の効果（持ち主の軍に）:<br>
      ・守り: 砦の上か隣にいる隊・守備隊は、戦闘で DEF +${Math.round(FORT_DEF * 100)}%<br>
      ・再編成: 砦から${HUB_RANGE}マス以内にいる隊どうしで、駒や将を受け渡し・分割・合流できる<br>
      ・見張り: 守備隊がいなくても、周囲${FORT_VISION}マスが見える<br>
      ・奪い方: 守備隊のいない砦は、隊が入ると自軍のものになる。守備隊がいれば戦って倒す<br>
      ・駐留: 砦の上にいる隊から、配下の副将を残して守備隊にできる</div>`;
  }
  const side = key === 'base-player' ? 'player' : 'cpu';
  return `<div><b>陣 ${side === 'player' ? '自軍' : 'CPU軍'}の本陣</b></div>
    <div class="sub">本陣から${HUB_RANGE}マス以内にいる隊は再編成でき、予備の兵・将も使える。</div>`;
}

function onSmapClick(x, y) {
  const m = smap();
  if (!m || m.phase !== 'player' || m.battle) return;
  const sel = liveTokens().find(t => t.id === ui.selected);
  const t = tokenAt(x, y);
  // 罠を仕掛ける / 解除
  if (sel && ui.mode) {
    const cells = ui.mode === 'trap' ? trapCells(sel) : disarmCells(sel);
    if (cells.some(([cx, cy]) => cx === x && cy === y)) {
      if (ui.mode === 'trap') placeTrap(sel, x, y); else disarmTrap(sel, x, y);
      ui.mode = null; ui.selected = null; ui.moved = false;
      saveCampaign();
      renderStrat();
      return;
    }
    ui.mode = null;
  }
  // 攻撃
  if (sel && t && t.side === 'cpu' && !sel.acted && tokenTargets(sel).includes(t)) {
    ui.selected = null; ui.moved = false;
    attackToken(sel, t);
    return;
  }
  // 移動
  if (sel && !t && !sel.acted && !ui.moved && tokenReach(sel).some(([cx, cy]) => cx === x && cy === y)) {
    moveToken(sel, x, y);
    ui.moved = true;
    if (sel.trapped) sel.trapped = false;   // 罠にかかった隊は springTrap で行動済み
    if (sel.acted || (!tokenTargets(sel).length && !stationOptions(sel).length && !trapCells(sel).length && !disarmCells(sel).length)) {
      sel.acted = true; ui.selected = null; ui.moved = false;
    }
    saveCampaign();
    renderStrat();
    return;
  }
  // 選択（移動したまま別の隊を選んだら、前の隊は行動済み）
  if (sel && ui.moved) sel.acted = true;
  ui.moved = false;
  ui.reorg = null;
  ui.selected = t && t.side === 'player' ? t.id : null;
  // 砦・本陣のマス（隊がいない）をクリックしたら説明を出す
  const f = fortAt(x, y);
  ui.info = !ui.selected ? (f ? f.id : m.bases.player.x === x && m.bases.player.y === y ? 'base-player' : m.bases.cpu.x === x && m.bases.cpu.y === y ? 'base-cpu' : null) : null;
  renderStrat();
}

function initStrategy() {
  $('smap').addEventListener('click', e => {
    const cell = e.target.closest('.scell');
    if (cell) onSmapClick(Number(cell.dataset.x), Number(cell.dataset.y));
  });
  renderStrat();
  // 戦闘中にCPUの番だった（再読み込み）なら続きから
  const m = smap();
  if (m && m.phase === 'cpu' && !m.battle) setTimeout(cpuRun, 500);
}
