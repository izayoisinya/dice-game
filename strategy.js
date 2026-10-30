// ============================================================
// ダイス戦記 - 戦域図（戦略レイヤー）
//   軍の編成のあと「出陣」で戦域図へ。プレイヤーとCPUが交互に、すべての隊を動かす（SRPG方式）。
//   敵の隊に隣接して「攻撃」すると局地戦（main.js の局地戦の画面）になり、結果をマップに持ち帰る。
//   main.js より先に読み込む（関数と定数の定義だけ。画面のイベントは initStrategy で登録する）
// ============================================================

const SMAP_MIN_W = 14;
const SMAP_MIN_H = 14;
const SMAP_DICE = { n: 2, sides: 4 };     // 幅・高さ = 最低値 + 2d4（16〜22）
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
const TOKEN_MOVE_MIN = 2;                 // 戦域図の隊の最低移動力（兵が多くても・統率オーバーでも）
const ASSASSIN_MOVE_MAP = 4;
const CPU_ATTACK_RATIO = 0.7;             // CPU は相手を囲む自軍の戦力の合計が、見積もった相手の戦力の 0.7 倍以上なら攻撃する
const CPU_GUESS = 0.3;                     // CPU は相手の戦力を正確には知らない: 見積もりは ±30% ずれる（相手ごと・ターンごとに振る）
const CPU_STARE_TURNS = 2;                 // 隣で睨み合ったまま、このターン数たったら戦力に関係なく攻めかかる
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

/** 戦域図のマスの形（六角か）。マップを作るときの設定で決まり、マップごとに保存される */
function sHex(m = smap()) { return !!m?.hex; }
/** 戦域図の距離（歩数）。正方形は上下左右、六角形は6方向 */
function sDist(a, b, m = smap()) { return gridDist(a, b, sHex(m)); }
/** 戦域図の隣のマス */
function sNeighbors(x, y, m = smap()) { return neighbors(x, y, sHex(m)); }

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
    const [nx, ny] = pick(sNeighbors(x, y, m));
    x = Math.max(0, Math.min(m.w - 1, nx));
    y = Math.max(2, Math.min(m.h - 3, ny));
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
    for (const [nx, ny] of sNeighbors(x, y, m)) {
      const t = smapCell(m, nx, ny);
      if (!t) continue;
      const nc = c + TERRAIN[t].cost;
      if (nc < dist[ny * m.w + nx]) { dist[ny * m.w + nx] = nc; open.push([nc, nx, ny]); }
    }
  }
  return dist;
}

const BASE_ROWS = 3;   // 本陣を置ける段（自軍は下から、CPU軍は上から）

/** 自軍の本陣を置けるマス: 下の BASE_ROWS 段の、通れるマス（川・砦の上と、砦から3マス未満は不可） */
function baseCells() {
  const m = smap(), out = [];
  for (let y = m.h - BASE_ROWS; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    if (TERRAIN[smapCell(m, x, y)].cost === Infinity || m.forts.some(f => sDist(f, { x, y }) < 3)) continue;
    const dist = costMap(m, { x, y });
    if (dist[m.bases.cpu.y * m.w + m.bases.cpu.x] < Infinity && m.forts.every(f => dist[f.y * m.w + f.x] < Infinity)) out.push([x, y]);
  }
  return out;
}

/** 自軍の本陣を動かし、自軍の隊を置き直す（出陣直後の「本陣を置く」でだけ） */
function moveBase(x, y) {
  const m = smap();
  m.bases.player = { x, y };
  m.tokens = m.tokens.filter(t => t.side !== 'player');
  deploy('player');
  saveCampaign();
  renderStrat();
}

/** 戦域図を作る: 広さはダイス。森・山・川（浅瀬）と砦を置く。両軍の本陣がつながるまで作り直す */
function genStrategicMap() {
  for (;;) {
    const wd = roll(SMAP_DICE.n, SMAP_DICE.sides), hd = roll(SMAP_DICE.n, SMAP_DICE.sides);
    const m = { w: SMAP_MIN_W + wd.total, h: SMAP_MIN_H + hd.total, wd, hd, hex: !!$('hexmap')?.checked };
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
    // 本陣: 自軍は下の真ん中（出陣のときに自分で動かせる）。CPU軍は上の3段のどこか（ランダム）
    m.bases = { player: { x: Math.floor(m.w / 2), y: m.h - 1 }, cpu: { x: 1 + Math.floor(Math.random() * (m.w - 2)), y: Math.floor(Math.random() * BASE_ROWS) } };
    setCell(m, m.bases.player.x, m.bases.player.y, '平地');
    setCell(m, m.bases.cpu.x, m.bases.cpu.y, '平地');
    // 砦: 1d3+1 か所。中ほどの平地に、互いと本陣から 4マス以上離して置く
    m.forts = [];
    const nForts = 1 + d(3);
    for (let tries = 0; m.forts.length < nForts && tries < 500; tries++) {
      const x = Math.floor(Math.random() * m.w), y = 3 + Math.floor(Math.random() * (m.h - 6));
      if (smapCell(m, x, y) === '川') continue;
      const p = { x, y };
      if (m.forts.some(f => sDist(f, p, m) < 4) || sDist(p, m.bases.player, m) < 4 || sDist(p, m.bases.cpu, m) < 4) continue;
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

/** 移動力: 兵数が多いほど遅い（〜400人 4・〜800人 3・それ以上 2）。統率オーバーなら −1。最低 TOKEN_MOVE_MIN。単独の斥候・暗殺者は固定、守備隊は動かない */
function tokenMove(t) {
  const kind = tokenKind(t);
  if (kind === '守備隊') return 0;
  if (kind === '斥候') return SCOUT_MOVE_MAP;
  if (kind === '暗殺者') return ASSASSIN_MOVE_MAP;
  const army = campaign.armies[t.side], q = tokenSquad(t);
  const n = squadTroops(q);
  // 兵数が多いほど遅い（兵士が 1d20×100 になったので段階も広げた）。どんな隊でも最低 TOKEN_MOVE_MIN は動ける
  const base = n <= 400 ? 4 : n <= 800 ? 3 : 2;
  return Math.max(TOKEN_MOVE_MIN, base - (overCommand(army, q) ? 1 : 0));
}

function tokenVision(t) {
  const kind = tokenKind(t);
  return kind === '斥候' ? SCOUT_VISION_MAP : kind === '暗殺者' ? ASSASSIN_VISION_MAP : kind === '守備隊' ? FORT_VISION : SQUAD_VISION_MAP;
}

/** その陣営から見えているマス */
/** CPU軍の本陣を描くか（霧ありなら、一度でも見えたら） */
function cpuBaseShown() {
  const m = smap();
  return !state.fog || !!m.cpuBaseSeen;
}

function smapSight(side) {
  const m = smap(), seen = new Set();
  for (const t of liveTokens().filter(t => t.side === side)) {
    const r = tokenVision(t);
    for (const [x, y] of cellsAround(t.x, t.y, r, true, sHex(m))) seen.add(`${x},${y}`);
  }
  // 自軍の砦は見張り台: 守備隊がいなくても周囲が見える
  for (const f of m.forts.filter(f => f.owner === side)) {
    const r = FORT_VISION;
    for (const [x, y] of cellsAround(f.x, f.y, r, true, sHex(m))) seen.add(`${x},${y}`);
  }
  return seen;
}

/** その陣営から敵の隊 t が見えているか（単独の暗殺者は隣接、斥候なら2マスまで） */
function tokenVisibleTo(side, t) {
  if (t.side === side || !state.fog) return true;
  const mine = liveTokens().filter(o => o.side === side);
  const forts = smap().forts.filter(f => f.owner === side);
  if (tokenKind(t) === '暗殺者') return mine.some(o => sDist(o, t) <= (tokenKind(o) === '斥候' ? STEALTH_SPOT.scout : STEALTH_SPOT.base)) || forts.some(f => sDist(f, t) <= STEALTH_SPOT.base);
  return mine.some(o => sDist(o, t) <= tokenVision(o)) || forts.some(f => sDist(f, t) <= FORT_VISION);
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
    for (const [nx, ny] of sNeighbors(x, y, m)) {
      const ter = smapCell(m, nx, ny);
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
  return liveTokens().filter(o => o.side !== t.side && sDist(o, t) === 1 && tokenVisibleTo(t.side, o));
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
  if (t.side === 'player' || tokenVisibleTo('player', t)) smapLog(`${squadLabel(t.side, q)} が移動 ${before} → (${x},${y})`, t.side);
  if (trap && hasScout(t)) {
    trap.known[t.side] = true;
    t.acted = true;
    t.trapped = true;
    if (t.side === 'player') smapLog(`🔍 ${q.name} が (${trap.x},${trap.y}) の罠に気づいて足を止めた。`, 'player');
  } else if (trap) springTrap(t, trap);
  const f = fortAt(x, y);
  if (f && f.owner !== t.side && tokenKind(t) !== '斥候' && tokenKind(t) !== '暗殺者') {
    f.owner = t.side;
    smapLog(`🏯 ${squadLabel(t.side, q)} が${f.name}を押さえた！`, t.side);
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
  return sNeighbors(t.x, t.y).filter(([x, y]) => {
    const ter = smapCell(m, x, y);
    return ter && TERRAIN[ter].cost < Infinity && !tokenAt(x, y) && !fortAt(x, y) && !trapAt(x, y) &&
      !Object.values(m.bases).some(b => b.x === x && b.y === y);
  });
}

/** 解除できる罠: 隣接している、見つけている敵の罠 */
function disarmCells(t) {
  if (!hasScout(t)) return [];
  return (smap().traps || []).filter(tr => tr.side !== t.side && tr.known[t.side] && sDist(tr, t) === 1).map(tr => [tr.x, tr.y]);
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
  smapLog(`🪤 ${squadLabel(t.side, q)} が罠にかかった！ 兵 ${lost}人を失い、足が止まった。`, trap.side);
}

/** 斥候が近づいた敵の罠を見つける */
function updateTrapKnowledge() {
  const m = smap();
  for (const tr of m.traps || []) {
    for (const side of ['player', 'cpu']) {
      if (side === tr.side || tr.known[side]) continue;
      if (liveTokens().some(o => o.side === side && hasScout(o) && sDist(o, tr) <= TRAP_DETECT)) {
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
  const exit = sNeighbors(t.x, t.y)
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
  if (sDist(t, base) <= HUB_RANGE) return { kind: 'base', x: base.x, y: base.y, name: '本陣' };
  const f = m.forts.find(f => f.owner === t.side && sDist(f, t) <= HUB_RANGE);
  return f ? { kind: 'fort', x: f.x, y: f.y, name: f.name, id: f.id } : null;
}

/** 拠点に集まっている自軍の隊 */
function hubSquads(hub, side) {
  return liveTokens().filter(o => o.side === side && sDist(o, hub) <= HUB_RANGE).map(tokenSquad);
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
        if (ter && TERRAIN[ter].cost < Infinity && !tokenAt(x, y) && sDist({ x, y }, hub) <= HUB_RANGE) cell.push([x, y]);
      }
      cell.sort((p1, p2) => sDist({ x: p1[0], y: p1[1] }, hub) - sDist({ x: p2[0], y: p2[1] }, hub));
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
  const desc = m => m.kind ? `${nm(m.name)}（${m.kind}）` : `${nm(m.name)}（${m.rank || m.type + '長'}）`;
  const dests = (q, extra = '') => `<option value="">移す…</option>${group.filter(o => o !== q).map(o => `<option value="${o.id}">→ ${nm(o.name)}</option>`).join('')}${atBase ? '<option value="__pool">→ 予備</option>' : ''}${extra}`;
  const rows = group.map(q => {
    const lead = memberById(army, q.leader);
    const pieces = q.pieces.map((p, i) => `<span class="chip">${p.type}${p.size}
      <select class="ro" data-op="piece" data-from="${q.id}" data-i="${i}">${dests(q)}</select></span>`).join('') || '<span class="sub">なし</span>';
    const members = q.members.map(id => { const m = memberById(army, id); return `<span class="chip">${desc(m)}
      <select class="ro" data-op="member" data-from="${q.id}" data-id="${id}">${dests(q)}</select>
      ${!m.kind ? `<button class="small ro-btn" data-op="split" data-from="${q.id}" data-id="${id}">新しい隊に</button>` : ''}</span>`; }).join('') || '<span class="sub">なし</span>';
    const merge = q.name !== '本隊' && group.length > 1   // 守備隊も隊ごと合流できる（砦の守りを解いて、副将がほかの隊に戻る）
      ? `<select class="ro" data-op="merge" data-from="${q.id}"><option value="">隊ごと合流…</option>${group.filter(o => o !== q).map(o => `<option value="${o.id}">→ ${nm(o.name)}</option>`).join('')}</select>` : '';
    const add = atBase ? `<div class="ro-add">予備から:
      <select data-role="ro-type">${TYPE_NAMES.map(t => `<option>${t}</option>`).join('')}</select>
      <input type="number" data-role="ro-size" value="${PIECE_DEFAULT}" step="10" min="${MIN_PIECE}">人
      <button class="small ro-btn" data-op="addpiece" data-to="${q.id}">駒を足す</button>
      <select class="ro" data-op="addmember" data-to="${q.id}"><option value="">将などを入れる…</option>${
        [...army.generals.filter(g => g.rank === '副将'), ...army.sergeants, ...army.specials].filter(m => !squadOf(army, m.id)).map(m => `<option value="${m.id}">${desc(m)}</option>`).join('')}</select></div>` : '';
    return `<div class="squad"><div class="sq-head"><b>${nm(q.name)}</b>（${squadKind(army, q)}）隊長 ${desc(lead)} ／ 率いる人数 ${squadUsed(army, q)}/${squadMenCap(army, q)}人分 ／ 駒 ${q.pieces.length}/${squadCap(army, q)} ／ 兵 ${squadTroops(q)}人 ${merge}</div>
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
    if (TERRAIN[smapCell(m, x, y)].cost < Infinity && !fortAt(x, y)) cells.push({ x, y, c: dist[y * m.w + x] + sDist({ x, y }, base) * 0.01 });
  }
  cells.sort((a, b) => a.c - b.c);
  order.forEach((q, i) => m.tokens.push({ id: q.id, side, x: cells[i].x, y: cells[i].y, acted: false }));
}

/** 軍全体の戦力（コスト換算）と兵数・将の数。兵士は100人で1,000、兵長1,000・副将1,500・総大将2,000、斥候500・暗殺者1,000 */
function armySnapshot(army) {
  const troops = Object.values(army.totals).reduce((a, n) => a + n, 0);
  const worth = troops * RANKS['雑兵'].cost / BASE_TROOPS
    + army.generals.reduce((a, g) => a + (RANKS[g.rank]?.cost || 0), 0)
    + army.sergeants.length * RANKS['兵長'].cost
    + army.specials.reduce((a, x) => a + (x.kind === '暗殺者' ? RANKS['兵長'].cost : RANKS['雑兵'].cost), 0);
  return { worth: Math.round(worth), troops, generals: army.generals.length, sergeants: army.sergeants.length, specials: army.specials.length };
}

// ------------------------------------------------------------
// 戦闘の記録の分析（決着のまとめ・記録のページで使う）
// ------------------------------------------------------------

const fmtN = n => Math.round(n).toLocaleString();

/** 戦力比（自軍 ÷ CPU軍）の言い方 */
function ratioText(p, c) {
  const r = p / Math.max(1, c);
  return r >= 1.05 ? `自軍${r.toFixed(2)}倍` : r <= 0.95 ? `敵${(1 / r).toFixed(2)}倍` : '互角';
}

/** 戦闘の記録の分析: 戦力で上回った・互角・下回った戦いごとの勝敗と、失った戦力の比べ合わせ */
function analysisHtml(hist) {
  if (!hist.length) return '<div class="sub">まだ戦闘の記録がありません。</div>';
  const groups = [['自軍が上回った（1.05倍以上）', h => h.player.start >= h.cpu.start * 1.05],
    ['ほぼ互角', h => h.player.start < h.cpu.start * 1.05 && h.cpu.start < h.player.start * 1.05],
    ['CPU軍が上回った（1.05倍以上）', h => h.cpu.start >= h.player.start * 1.05]];
  const won = h => /勝利/.test(h.result), lost = h => /敗北|撤退/.test(h.result);
  const rows = groups.map(([label, f]) => {
    const hs = hist.filter(f), w = hs.filter(won).length, l = hs.filter(lost).length;
    return `<tr><th>${label}</th><td>${hs.length}戦</td><td><b>${w}勝 ${l}敗</b>${hs.length - w - l ? ` ${hs.length - w - l}分` : ''}</td><td>${hs.length ? `勝率 ${Math.round(w / hs.length * 100)}%` : ''}</td></tr>`;
  }).join('');
  const lostP = hist.reduce((a, h) => a + h.player.start - h.player.end, 0), lostC = hist.reduce((a, h) => a + h.cpu.start - h.cpu.end, 0);
  const w = hist.filter(won).length;
  return `<table class="rep-table"><tbody>${rows}</tbody></table>
    <div>通算 <b>${w}勝 ${hist.filter(lost).length}敗</b>（${hist.length}戦）／ 失った戦力 自軍 ${fmtN(lostP)} : CPU軍 ${fmtN(lostC)}（${lostP > lostC ? `自軍が${(lostP / Math.max(1, lostC)).toFixed(2)}倍多く失った` : `CPU軍が${(lostC / Math.max(1, lostP)).toFixed(2)}倍多く失った`}）</div>`;
}

/** 戦闘ごとの記録の表 */
function historyTable(hist) {
  if (!hist.length) return '';
  return `<table class="rep-table rep-hist"><thead><tr><th>戦闘</th><th>結果</th><th>開戦時（自軍 : CPU軍）</th><th>終了時</th></tr></thead><tbody>` +
    hist.map(h => `<tr><td>${h.title}</td><td>${h.result.replace(/プレイヤー軍の/, '')}</td><td>${fmtN(h.player.start)} : ${fmtN(h.cpu.start)} <small class="sub">（${ratioText(h.player.start, h.cpu.start)}）</small></td><td>${fmtN(h.player.end)} : ${fmtN(h.cpu.end)}</td></tr>`).join('') + '</tbody></table>';
}

const ARCHIVE_KEY = 'diceSenkiArchive';
/** 決着した戦いの記録を残す（記録のページの「これまでの戦い」。新しい順に30件まで） */
function archiveCampaign() {
  const m = smap(), A = campaign.armies;
  if (!m || m.archived) return;
  m.archived = true;
  let list = [];
  try { list = JSON.parse(localStorage.getItem(ARCHIVE_KEY)) || []; } catch {}
  list.unshift({ date: new Date().toISOString(), win: !!A.cpu.defeated, turn: m.turn, start: { player: A.player.start || null, cpu: A.cpu.start || null },
    end: { player: armySnapshot(A.player), cpu: armySnapshot(A.cpu) }, history: m.history || [], size: `${m.w}×${m.h}${m.hex ? '・六角' : ''}` });
  try { localStorage.setItem(ARCHIVE_KEY, JSON.stringify(list.slice(0, 30))); } catch {}
}

/** 記録のページ: 今の戦い（出陣中なら）と、これまでの戦い */
function renderRecords() {
  const m = smap(), A = campaign.armies;
  if (m && m.phase === 'over') archiveCampaign();   // この版より前に決着した戦いも残す
  let html = '';
  if (m) {
    html += `<section class="panel"><h2>今の戦い <small class="sub">ターン ${m.turn}${m.phase === 'over' ? '（決着）' : ''}</small></h2>
      ${A.player.start && A.cpu.start ? `<div>出陣したときの軍全体の戦力: 自軍 ${fmtN(A.player.start.worth)} : CPU軍 ${fmtN(A.cpu.start.worth)}（${ratioText(A.player.start.worth, A.cpu.start.worth)}）</div>` : ''}
      ${analysisHtml(m.history || [])}${historyTable(m.history || [])}</section>`;
  }
  let list = [];
  try { list = JSON.parse(localStorage.getItem(ARCHIVE_KEY)) || []; } catch {}
  html += `<section class="panel"><h2>これまでの戦い <small class="sub">${list.length}回（新しい順・30回まで）</small></h2>` + (list.length ? list.map(g => {
    const d = new Date(g.date);
    const st = g.start.player && g.start.cpu ? `開始時 ${fmtN(g.start.player.worth)} : ${fmtN(g.start.cpu.worth)}（${ratioText(g.start.player.worth, g.start.cpu.worth)}）` : '';
    const w = g.history.filter(h => /勝利/.test(h.result)).length;
    return `<details class="rec-game"><summary>${g.win ? '🏆 勝利' : '💀 敗北'}　${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}　${g.turn}ターン・戦域図 ${g.size}　${st}　局地戦 ${w}勝${g.history.length - w}敗</summary>
      ${analysisHtml(g.history)}${historyTable(g.history)}</details>`;
  }).join('') : '<div class="sub">決着した戦いはまだありません（戦域図で決着すると、ここに残ります）。</div>') + '</section>';
  $('records').innerHTML = html;
}

/** 戦域図の決着のまとめ: 軍全体の戦力の比べ合わせと、戦闘ごとの記録 */
function renderFinal() {
  const m = smap(), A = campaign.armies;
  const fmt = n => n.toLocaleString(), pct = (a, b) => (b ? Math.round(a / b * 100) : 0);
  const now = { player: armySnapshot(A.player), cpu: armySnapshot(A.cpu) };
  const start = { player: A.player.start || null, cpu: A.cpu.start || null };
  const bar = (a, b) => `<div class="rep-bar"><span class="rp" style="width:${pct(a, a + b)}%">${fmt(a)}</span><span class="rc">${fmt(b)}</span></div>`;
  let html = `<button class="small ap-close" id="sm-final-close" title="閉じる">✕</button>
    <h3>${A.cpu.defeated ? '🏆 自軍の勝利！' : '💀 自軍の敗北…'} <small class="sub">（${m.turn}ターン）</small></h3>`;
  if (start.player && start.cpu) {
    const r = start.cpu.worth / Math.max(1, start.player.worth);
    html += `<div class="rep-head">開始時の軍全体の戦力（コスト換算）: ${r >= 1.05 ? `CPU軍が <b>${r.toFixed(2)}倍</b>` : r <= 0.95 ? `自軍が <b>${(1 / r).toFixed(2)}倍</b>` : 'ほぼ互角'}</div>${bar(start.player.worth, start.cpu.worth)}`;
  }
  html += `<div class="rep-head">終わったときの軍全体の戦力</div>${bar(now.player.worth, now.cpu.worth)}
    <table class="rep-table"><thead><tr><th></th><th class="nm-p">自軍</th><th class="nm-c">CPU軍</th></tr></thead><tbody>
    <tr><th>戦力</th>${['player', 'cpu'].map(sd => `<td>${start[sd] ? `${fmt(start[sd].worth)} → ` : ''}<b>${fmt(now[sd].worth)}</b>${start[sd] ? `（${pct(now[sd].worth, start[sd].worth)}%）` : ''}</td>`).join('')}</tr>
    <tr><th>兵士</th>${['player', 'cpu'].map(sd => `<td>${start[sd] ? `${fmt(start[sd].troops)} → ` : ''}<b>${fmt(now[sd].troops)}</b>人</td>`).join('')}</tr>
    <tr><th>将（総大将・副将）</th>${['player', 'cpu'].map(sd => `<td>${start[sd] ? `${start[sd].generals} → ` : ''}<b>${now[sd].generals}</b>人</td>`).join('')}</tr>
    <tr><th>兵長</th>${['player', 'cpu'].map(sd => `<td>${start[sd] ? `${start[sd].sergeants} → ` : ''}<b>${now[sd].sergeants}</b>人</td>`).join('')}</tr>
    <tr><th>砦</th>${['player', 'cpu'].map(sd => `<td><b>${m.forts.filter(f => f.owner === sd).length}</b> / ${m.forts.length}</td>`).join('')}</tr>
    </tbody></table>`;
  const hist = m.history || [];
  if (hist.length) html += `<div class="rep-head">戦闘の分析</div>${analysisHtml(hist)}<div class="rep-head">戦闘の記録（${hist.length}回）</div>${historyTable(hist)}`;
  html += `<div class="sub">戦力 = コスト換算（兵士100人で1,000、兵長1,000・副将1,500・総大将2,000、斥候500・暗殺者1,000）。予備の兵も含む軍全体。</div>`;
  return html;
}

function startMapStage() {
  const A = campaign.armies;
  if (!A || A.player.defeated || A.cpu.defeated) return;
  for (const side of ['player', 'cpu']) A[side].start = armySnapshot(A[side]);   // 決着のまとめで比べる
  campaign.smap = genStrategicMap();
  campaign.setup = null;   // ゲーム開始の手順はここで終わり
  Object.assign(campaign.smap, { tokens: [], traps: [], turn: 1, phase: 'setbase', cpuQueue: [], battle: null, pending: null, logs: [], cpuBaseSeen: false });
  ui.scrolled = false;
  deploy('player');
  deploy('cpu');
  ui.selected = null;
  smapLog(`🗺 戦域図 ${campaign.smap.w}×${campaign.smap.h}（幅 ${SMAP_MIN_W}+🎲[${campaign.smap.wd.dice.join('][')}] / 高さ ${SMAP_MIN_H}+🎲[${campaign.smap.hd.dice.join('][')}]）。砦 ${campaign.smap.forts.length}か所`, 'turn');
  smapLog('🏯 自軍の本陣の位置を決めてください（光っているマス）。', 'turn');
  saveCampaign();
  renderCampaign();
  renderStrat();
  showView('map');
}

// ------------------------------------------------------------
// 戦闘（戦術レイヤーへ）
// ------------------------------------------------------------

/**
 * 局地戦に一緒に加わる隊（援軍）: main と同じ陣営で、相手 foe の隣にいて、main と（同じ条件の味方を伝って）隣どうしでつながっている隊。
 * 単独の斥候と砦の守備隊は加わらない。戦域図で左にいる順に並べる（局地戦でも左右の並びをそろえる）
 */
function battleGroup(main, foe) {
  const group = [main], seen = new Set([main.id]);
  for (let i = 0; i < group.length; i++) {
    for (const o of liveTokens()) {
      if (seen.has(o.id) || o.side !== main.side || sDist(o, foe) !== 1 || sDist(o, group[i]) !== 1) continue;
      if (['斥候', '守備隊'].includes(tokenKind(o))) continue;
      seen.add(o.id);
      group.push(o);
    }
  }
  return group.sort((a, b) => a.x - b.x);
}

function attackToken(t, target) {
  const m = smap();
  const pt = t.side === 'player' ? t : target, ct = t.side === 'player' ? target : t;
  t.acted = true;
  const groups = { player: battleGroup(pt, ct), cpu: battleGroup(ct, pt) };
  for (const o of groups[t.side]) o.acted = true;   // 攻めた側の援軍も、このターンの行動を使う
  m.battle = { player: pt.id, cpu: ct.id, attacker: t.side, squads: { player: groups.player.map(o => o.id), cpu: groups.cpu.map(o => o.id) } };
  smapLog(`⚔ ${squadLabel(t.side, tokenSquad(t))} が ${squadLabel(target.side, tokenSquad(target))} に攻撃！`, t.side);
  for (const side of ['player', 'cpu']) {
    const extra = groups[side].filter(o => o !== pt && o !== ct);
    if (extra.length) smapLog(`🤝 援軍: ${extra.map(o => squadLabel(side, tokenSquad(o))).join('・')} が加わる`, side);
  }
  saveCampaign();
  startCampaignBattle(pt.id, ct.id, m.battle.squads);
  if (t.side === 'cpu') log(`CPU軍の攻撃！ 迎え撃つのは ${nm(tokenSquad(pt).name)} です。`, 'turn');
  // 砦の守り: 自軍の砦の上か隣にいる隊（守備隊を含む）は DEF +20%
  if (state.campaignBattle) {
    const bonus = side => { const tok = side === 'player' ? pt : ct; return !!tok.fort || m.forts.some(f => f.owner === side && sDist(f, tok) <= 1); };
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
  for (const side of ['player', 'cpu']) for (const id of p.squads?.[side] || [p[side]]) {
    const t = m.tokens.find(x => x.id === id);
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
      const exits = sNeighbors(t.x, t.y).map(([x, y]) => ({ x, y }))
        .filter(c => smapCell(m, c.x, c.y) && TERRAIN[smapCell(m, c.x, c.y)].cost < Infinity && !tokenAt(c.x, c.y) && sDist(c, foe) > sDist(t, foe));
      if (exits.length) {
        const c = pick(exits);
        [t.x, t.y] = [c.x, c.y];
        smapLog(`${squadLabel(side, q)} は退いた。`, side);
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
    archiveCampaign();
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
  for (const t of m.tokens) { t.acted = false; t.moved = false; }
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
  for (const t of m.tokens) { t.acted = false; t.moved = false; }
  smapLog(`--- ターン ${m.turn}（自軍） ---`, 'turn');
  updateTrapKnowledge();
  saveCampaign();
  renderStrat();
}

/** CPU が攻撃したい相手（隣接・見えている・勝てそうな相手。弱い順） */
function cpuTarget(t) {
  // 援軍として一緒に加わる隊（相手の隣でつながっている味方）の戦力も合わせて考える
  const around = o => battleGroup(t, o).reduce((a, x) => a + tokenStrength(x), 0);
  // 相手の戦力は見積もり（プレイヤーと同じく正確には分からない）。同じターンのうちは同じ見積もりを使う
  const m = smap();
  const guess = o => {
    if (!o.guess || o.guess.turn !== m.turn) o.guess = { turn: m.turn, k: 1 + (Math.random() * 2 - 1) * CPU_GUESS };
    return tokenStrength(o) * o.guess.k;
  };
  return tokenTargets(t)
    .filter(o => ['守備隊', '斥候'].includes(tokenKind(o)) || tokenKind(t) === '暗殺者' || (t.stare || 0) >= CPU_STARE_TURNS
      || around(o) >= battleGroup(o, t).reduce((a, x) => a + guess(x), 0) * CPU_ATTACK_RATIO)   // 相手側の援軍も見積もりに入れる
    .sort((a, b) => tokenStrength(a) - tokenStrength(b))[0] || null;
}

/** CPU の1隊分の行動。戦闘を始めたら true */
function cpuAct(t) {
  const m = smap(), kind = tokenKind(t);
  if (kind === '守備隊') return false;
  let target = cpuTarget(t);
  if (target) { t.stare = 0; attackToken(t, target); return true; }
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
      .sort((a, b) => (b.id === t.goal) - (a.id === t.goal) || sDist(a, t) - sDist(b, t));   // 今の目標を優先
    const foes = liveTokens().filter(o => sight.has(o.id)).sort((a, b) => sDist(a, t) - sDist(b, t));
    if (forts[0]) { goal = forts[0]; t.goal = forts[0].id; }
    else goal = foes[0] || m.bases.player;
  }
  const dist = costMap(m, goal);
  const reach = tokenReach(t);
  // 斥候は見えている敵から3マス以上離れる
  const safe = ([x, y]) => kind !== '斥候' || liveTokens().every(o => o.side === 'cpu' || !sight.has(o.id) || sDist(o, { x, y }) >= 3);
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
  if (target) { t.stare = 0; attackToken(t, target); return true; }
  // 隣に敵がいるのに攻めなかったターンを数える（CPU_STARE_TURNS で攻めかかる）
  t.stare = tokenTargets(t).length ? (t.stare || 0) + 1 : 0;
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
  ui.justCentered = false;
  renderStratBody();
  if (!ui.justCentered) [wrap.scrollTop, wrap.scrollLeft] = keep;   // 真ん中に合わせた直後は戻さない
  if (window.scrollY !== keep[2]) window.scrollTo(window.scrollX, keep[2]);
}

function renderStratBody() {
  const box = $('strat-box'), m = smap();
  box.classList.toggle('hidden', !m);
  $('strat-empty').classList.toggle('hidden', !!m);
  if (!m) return;
  const three = want3d('strat3d') && ready3d();   // 3D 表示（field3d.js）。マスは今まで通り作って隠し、印を 3D 側が読む
  $('view-map').classList.toggle('three', three);
  const A = campaign.armies;
  const sight = state.fog ? smapSight('player') : null;
  const sel = liveTokens().find(t => t.id === ui.selected);
  const myTurn = m.phase === 'player' && !m.battle;
  if (!sel || sel.acted || !myTurn) ui.mode = null;
  const reach = new Set(sel && myTurn && !sel.acted && !sel.moved && !ui.mode ? tokenReach(sel).map(([x, y]) => `${x},${y}`) : []);
  const modeCells = new Set(!sel || !ui.mode ? [] : (ui.mode === 'trap' ? trapCells(sel) : disarmCells(sel)).map(([x, y]) => `${x},${y}`));
  const targets = new Set(sel && myTurn && !sel.acted ? tokenTargets(sel).map(o => o.id) : []);
  const grid = $('smap');
  if (sight && sight.has(`${m.bases.cpu.x},${m.bases.cpu.y}`)) m.cpuBaseSeen = true;
  const baseSpots = new Set(m.phase === 'setbase' ? baseCells().map(([x, y]) => `${x},${y}`) : []);
  // マップの外側も描いて、画面いっぱいに続いているように見せる（入れない）。外側の段数は、全体表示で画面が埋まる分
  const wrap = $('smap-wrap');
  const hex = sHex(m), colK = hex ? HEX_COL : 1;   // 六角形は列の間隔が詰まる
  const fit = Math.min((wrap.clientWidth - 12) / ((m.w + 2) * colK), (wrap.clientHeight - 12) / (m.h + (hex ? 2.5 : 2)));   // 全体表示で、マップと外側1段が収まる大きさ
  const oldPad = ui.pad ? `${ui.pad.x},${ui.pad.y}` : '';
  ui.pad = wrap.clientWidth && fit > 0
    ? { x: Math.max(1, Math.ceil(((wrap.clientWidth - 12) / (fit * colK) - m.w) / 2) + 1), y: Math.max(1, Math.ceil(((wrap.clientHeight - 12) / fit - m.h) / 2) + 1) }
    : { x: 0, y: 0 };
  const P = ui.pad;
  if (oldPad && oldPad !== `${P.x},${P.y}`) ui.scrolled = false;   // 外側の段数が変わったら（画面の大きさが変わった）真ん中に合わせ直す
  grid.classList.toggle('hex', hex);
  grid.style.gridTemplateColumns = hex ? '' : `repeat(${m.w + P.x * 2}, minmax(0, 1fr))`;
  // 六角形: マスは置き場所（--x, --y）を指定して並べる。奇数の列は半マス下へ
  const at = (x, y) => (hex ? `--x:${x + P.x};--y:${y + P.y + (x & 1) * 0.5};` : '');
  let html = '';
  for (let y = -P.y; y < m.h + P.y; y++) for (let x = -P.x; x < m.w + P.x; x++) {
    if (x < 0 || y < 0 || x >= m.w || y >= m.h) {
      // 外側: いちばん近いマップの端の地形を、暗くして続ける
      const cx = Math.max(0, Math.min(m.w - 1, x)), cy = Math.max(0, Math.min(m.h - 1, y));
      const far = Math.max(cx - x, x - cx, cy - y, y - cy);
      html += `<div class="scell oob t-${smapCell(m, cx, cy)}" style="${at(x, y)}--far:${Math.min(far, 6)}"></div>`;
      continue;
    }
    const ter = smapCell(m, x, y), f = fortAt(x, y);
    let t = tokenAt(x, y);
    if (t && !tokenVisibleTo('player', t)) t = null;
    const base = m.bases.player.x === x && m.bases.player.y === y ? 'player' : cpuBaseShown() && m.bases.cpu.x === x && m.bases.cpu.y === y ? 'cpu' : null;
    const tr = trapAt(x, y);
    const trapShown = tr && tr.known.player;
    const cls = ['scell', `t-${ter}`,
      ui.mode && modeCells.has(`${x},${y}`) ? 'trapmode' : '',
      sight && !sight.has(`${x},${y}`) ? 'fog' : '',
      reach.has(`${x},${y}`) || baseSpots.has(`${x},${y}`) ? 'reach' : '',
      t && targets.has(t.id) ? 'target' : '',
      t ? (t.side === 'player' ? 'p' : 'c') : '',
      t && t === sel ? 'acting' : '',
      t && t.side === 'player' && t.acted && m.phase === 'player' ? 'done' : '',
      f ? `fortcell fort-${f.owner || 'none'}` : ''].filter(Boolean).join(' ');
    const title = t ? `${squadLabel(t.side, tokenSquad(t))}（${tokenKind(t)}）兵 ${tokenTroops(t)}人 / 移動 ${tokenMove(t)}`
      : f ? `${f.name}（${f.owner ? (f.owner === 'player' ? '自軍' : 'CPU軍') : '中立'}）` : ter;
    html += `<div class="${cls}" data-x="${x}" data-y="${y}" title="${title}"${hex ? ` style="${at(x, y)}"` : ''}>` +
      (f ? `<span class="fort ${f.owner ? 'own-' + f.owner : ''}">🏯</span>` : '') +
      (base ? `<span class="base own-${base}">陣</span>` : '') +
      (trapShown ? `<span class="trap ${tr.side === 'player' ? 'own' : 'foe'}">🪤</span>` : '') +
      (t ? `<span class="glyph">${tokenGlyph(t)}</span>` : '') +
      (t && targets.has(t.id) ? '<span class="tgt-mark">⚔</span>' : '') + `</div>`;
  }
  grid.innerHTML = html;
  applyZoom('smap');
  if (three) renderStrat3d();
  // 開いたときは、マップが真ん中に来るようにスクロールしておく
  if (!ui.scrolled && wrap.clientWidth) {
    wrap.scrollLeft = (wrap.scrollWidth - wrap.clientWidth) / 2;
    wrap.scrollTop = (wrap.scrollHeight - wrap.clientHeight) / 2;
    ui.scrolled = true;
    ui.justCentered = true;
  }
  const forts = side => m.forts.filter(f => f.owner === side).length;
  $('strat-label').textContent = `${m.w}×${m.h}　ターン ${m.turn}（${m.phase === 'setbase' ? '本陣を置く' : m.phase === 'player' ? '自軍の番' : m.phase === 'cpu' ? 'CPU軍の番' : '決着'}）　砦 自軍${forts('player')} / CPU${forts('cpu')} / 中立${m.forts.length - forts('player') - forts('cpu')}`;
  // 操作: 右上の箱（hud: 状況・ターン終了）と、選んだマスの近くに出る箱（info: 隊の操作・砦の説明。再編成は大きく中央に）
  let info = '', hud = '';
  ui.anchor = null;
  if (m.phase === 'setbase') {
    hud = `<div class="sub">自軍の本陣の位置を決めます。光っているマス（下の${BASE_ROWS}段）をタップすると、本陣と隊が移ります。</div>
      <div class="ap-buttons"><button id="sm-basego" class="go">この位置で開始</button></div>`;
  } else if (m.phase === 'over') {
    hud = `<div class="result">${A.cpu.defeated ? '🏆 自軍の勝利！' : '💀 自軍の敗北…'}</div><button id="sm-final">📊 結果を見る</button>`;
    if (!ui.finalClosed) { info = renderFinal(); ui.anchor = 'center'; }
  } else if (m.pending) {
    hud = `<div>戦闘の結果: <b>${m.pending.msg}</b></div><button id="sm-resolve">結果を反映する</button>`;
  } else if (m.battle) {
    hud = `<div>⚔ 戦闘中: ${nm(A.player.squads.find(q => q.id === m.battle.player)?.name)} vs ${squadLabel('cpu', A.cpu.squads.find(q => q.id === m.battle.cpu))}</div>
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
    info = `<div><b>${nm(q.name)}</b>（${tokenKind(sel)}）兵 ${tokenTroops(sel)}人 ／ 移動 ${tokenMove(sel)} ／ 視界 ${tokenVision(sel)}${sel.acted ? ' ／ 行動済み' : ''}</div>
      ${squadDetail(sel, ui.detailOpen)}
      <div class="sub">${sel.acted ? '' : ui.mode === 'trap' ? '黄色のマスをクリックして罠を仕掛けます（行動を使います）。' : ui.mode === 'disarm' ? '黄色のマスの罠をクリックして解除します（行動を使います）。' : sel.moved ? '点滅する赤枠（⚔）の敵をクリックで攻撃、または「待機」。' : '青いマスをクリックで移動。隣の点滅する赤枠（⚔）の敵をクリックで攻撃。'}</div>
      ${!sel.acted ? tokenTargets(sel).map(o => {
        const mine = battleGroup(sel, o).filter(x => x !== sel), theirs = battleGroup(o, sel).filter(x => x !== o && tokenVisibleTo('player', x));
        return mine.length || theirs.length ? `<div class="sub">🤝 ${squadLabel('cpu', tokenSquad(o))}を攻めると、${mine.length ? `味方の援軍: ${mine.map(x => nm(tokenSquad(x).name)).join('・')}` : ''}${mine.length && theirs.length ? '／' : ''}${theirs.length ? `敵の援軍: ${theirs.map(x => squadLabel('cpu', tokenSquad(x))).join('・')}` : ''}</div>` : '';
      }).join('') : ''}
      <div class="ap-buttons">
        ${!sel.acted ? '<button id="sm-wait">待機</button>' : ''}
        ${!sel.acted && hasScout(sel) ? `<button id="sm-trap" class="${ui.mode === 'trap' ? 'skill' : ''}" ${trapCells(sel).length ? '' : 'disabled'}>🪤 罠を仕掛ける（残り${trapsLeft('player')}）</button>` : ''}
        ${!sel.acted && disarmCells(sel).length ? `<button id="sm-disarm" class="${ui.mode === 'disarm' ? 'skill' : ''}">罠を解除</button>` : ''}
        ${!sel.acted && opts.length ? `<select id="sm-station"><option value="">副将を駐留させる…</option>${opts.map(g => `<option value="${g.id}">${g.name}</option>`).join('')}</select>` : ''}
        ${hub ? `<button id="sm-reorg">🏯 ${hub.name}で再編成</button>` : ''}
      </div>
      ${hub ? `<div class="sub">${hub.name}の近く（${HUB_RANGE}マス以内）にいるので、再編成できます${m.forts.some(f => f.owner === 'player' && sDist(f, sel) <= 1) ? `。戦闘になると砦の守り（DEF +${Math.round(FORT_DEF * 100)}%）` : ''}。</div>` : ''}`;
  } else if (ui.info && ui.info.startsWith('tok:')) {
    // 見えている敵の隊の詳細
    const e = liveTokens().find(o => o.id === ui.info.slice(4));
    if (e && tokenVisibleTo('player', e)) {
      const q = tokenSquad(e);
      info = `<div><b class="nm-c">${squadLabel('cpu', q)}</b>（CPU軍・${tokenKind(e)}）兵 ${tokenTroops(e)}人 ／ 移動 ${tokenMove(e)}</div>${squadDetail(e, true)}`;
      ui.anchor = [e.x, e.y];
    } else ui.info = null;
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
  on('sm-final', 'onclick', () => { ui.finalClosed = false; renderStrat(); });
  on('sm-final-close', 'onclick', () => { ui.finalClosed = true; renderStrat(); });
  const det = $('strat-info').querySelector('.tok-detail');
  if (det && sel) det.ontoggle = () => { ui.detailOpen = det.open; placeStratInfo(); };
  on('sm-basego', 'onclick', () => {
    m.phase = 'player';
    smapLog('--- ターン 1（自軍） ---', 'turn');
    saveCampaign();
    renderStrat();
  });
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

/**
 * 浮かぶ箱を、目印のマスの近くに置く。移動・攻撃できるマス（highlight）にはかぶらないよう、
 * それらをまとめた範囲の 右 → 左 → 下 → 上 に置き、どこにも入らなければ目印から遠い隅に置く
 */
function placeFloat(box, stage, cell, highlight) {
  const S = stage.getBoundingClientRect(), C = cell.getBoundingClientRect();
  const w = box.offsetWidth, h = box.offsetHeight, gap = 8;
  // 目印と光っているマスをまとめた範囲（ステージの座標）
  let [l, t, r, b] = [C.left, C.top, C.right, C.bottom];
  for (const el of highlight) { const R = el.getBoundingClientRect(); l = Math.min(l, R.left); t = Math.min(t, R.top); r = Math.max(r, R.right); b = Math.max(b, R.bottom); }
  [l, t, r, b] = [l - S.left, t - S.top, r - S.left, b - S.top];
  const cx = C.left - S.left + C.width / 2, cy = C.top - S.top + C.height / 2;
  const clampX = v => Math.max(gap, Math.min(S.width - w - gap, v)), clampY = v => Math.max(gap, Math.min(S.height - h - gap, v));
  const tries = [
    [r + gap, clampY(cy - h / 2), r + gap + w <= S.width - gap],
    [l - gap - w, clampY(cy - h / 2), l - gap - w >= gap],
    [clampX(cx - w / 2), b + gap, b + gap + h <= S.height - gap],
    [clampX(cx - w / 2), t - gap - h, t - gap - h >= gap],
  ];
  let [left, top] = (tries.find(x => x[2]) || [
    cx < S.width / 2 ? S.width - w - gap : gap,          // 入らなければ、目印と反対側の隅
    cy < S.height / 2 ? S.height - h - gap : gap,
  ]);
  box.style.left = `${Math.round(clampX(left))}px`;
  box.style.top = `${Math.round(clampY(top))}px`;
}

/** 戦域図の操作の箱を置く。マップのスクロール・拡大でも付いていく */
function placeStratInfo() {
  const box = $('strat-info'), stage = $('strat-stage');
  if (!box || box.classList.contains('hidden')) return;
  box.classList.toggle('center', ui.anchor === 'center');
  if (!Array.isArray(ui.anchor)) { box.style.left = box.style.top = ''; return; }
  let cell = document.querySelector(`#smap .scell[data-x="${ui.anchor[0]}"][data-y="${ui.anchor[1]}"]`);
  let marks = document.querySelectorAll('#smap .scell.reach, #smap .scell.target, #smap .scell.trapmode');
  const b = board3d('smap');
  if (b && cell) {   // 3D: マスの見えている場所を計算して渡す
    cell = b.anchor(ui.anchor[0], ui.anchor[1], true);
    marks = [...marks].map(el => b.anchor(Number(el.dataset.x), Number(el.dataset.y)));
  }
  if (cell) placeFloat(box, stage, cell, marks);
}

/** 隊の中身（隊長・配下の将・兵士の駒・位置）。open = 最初から開いておく */
function squadDetail(t, open) {
  const A = campaign.armies[t.side], q = tokenSquad(t);
  const lead = memberById(A, q.leader);
  const who = m => `${nm(m.name)}<span class="sub">（${m.kind || m.rank || m.type + '長'}）</span>`;
  const members = q.members.map(id => memberById(A, id)).filter(m => m && !(t.side === 'cpu' && m.kind === '暗殺者'));   // 敵の暗殺者は隠れているので出さない
  const hidden = t.side === 'cpu' && state.fog && !q.known;   // 局地戦で隊長を見るまで、敵の将の顔ぶれは分からない
  const pieces = q.pieces.map(p => `${p.type.replace('兵', '')}${p.size}`).join('　');
  return `<details class="tok-detail" ${open ? 'open' : ''}><summary>隊の中身</summary>
    <div>隊長: ${hidden ? '？（局地戦で姿を見るまで分からない）' : lead ? who(lead) : '—'}</div>
    ${hidden ? '' : `<div>配下: ${members.length ? members.map(who).join('・') : 'なし'}</div>`}
    <div>兵士の駒: ${pieces || 'なし'}</div>
    <div class="sub">位置 (${t.x},${t.y})　※座標は左上が (0,0)、右へ x・下へ y が増える</div></details>`;
}

/** 砦・本陣の説明 */
function placeInfo(key) {
  const m = smap();
  const f = m.forts.find(f => f.id === key);
  if (f) {
    const g = liveTokens().find(t => t.fort === f.id);
    const owner = f.owner ? (f.owner === 'player' ? '自軍' : 'CPU軍') : '中立';
    return `<div><b>🏯 ${f.name}</b>（${owner}）${g && tokenVisibleTo('player', g) ? ` 守備隊: ${squadLabel(g.side, tokenSquad(g))}` : ''}</div>
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
  if (m && m.phase === 'setbase') {
    if (baseCells().some(([cx, cy]) => cx === x && cy === y)) moveBase(x, y);
    return;
  }
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
  if (sel && !t && !sel.acted && !sel.moved && tokenReach(sel).some(([cx, cy]) => cx === x && cy === y)) {
    moveToken(sel, x, y);
    ui.moved = true;
    sel.moved = true;   // このターンはもう動けない（選び直しても）
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
  ui.info = !ui.selected && t && t.side === 'cpu' ? `tok:${t.id}` : !ui.selected ? (f ? f.id : m.bases.player.x === x && m.bases.player.y === y ? 'base-player' : cpuBaseShown() && m.bases.cpu.x === x && m.bases.cpu.y === y ? 'base-cpu' : null) : null;
  renderStrat();
}

function initStrategy() {
  $('smap').addEventListener('click', e => {
    const cell = e.target.closest('.scell');
    if (cell && cell.dataset.x != null) onSmapClick(Number(cell.dataset.x), Number(cell.dataset.y));   // マップの外のマスは無視
  });
  renderStrat();
  // 戦闘中にCPUの番だった（再読み込み）なら続きから
  const m = smap();
  if (m && m.phase === 'cpu' && !m.battle) setTimeout(cpuRun, 500);
}
