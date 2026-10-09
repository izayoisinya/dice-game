'use strict';

// ============================================================
// 定数・マスターデータ
// ============================================================

const MAX_TURNS = 100;        // 決着がつかない場合の打ち切りターン

// マップの広さ: 最低値 + 1d6 で決定（幅 9〜14 × 高さ 10〜15）
// 幅の最低値は、最大編成（3d6=18体）が自陣3列に収まるよう 9 にしている
const MAP_MIN_W = 8;
const MAP_MIN_H = 9;
const DEPLOY_ROWS = 3;        // 自陣として布陣できる列数（後方から）

// マップタイプ（今は平野のみ。市街戦・山間部などは地形ギミックと合わせて今後追加）
const MAP_TYPES = ['平野'];

// 階級: コストとステータス倍率
const RANKS = {
  '雑兵':   { cost: 50,  hp: 1.0, atk: 1.0, def: 1.0, spd: 0 },
  '部隊長': { cost: 100, hp: 1.6, atk: 1.4, def: 1.4, spd: 1 },
  '総大将': { cost: 200, hp: 3.0, atk: 1.8, def: 1.8, spd: 2 },
};

// 兵種: 基礎ステータス
// RNG = 攻撃射程, ACT = 攻撃速度（1回の行動で攻撃する回数）, HIT = 基本命中率(%)
// falloff[距離] = { hit: 命中倍率, pow: 威力倍率 }。best = 最も性能を発揮する距離
// rear = 後衛（前衛より前に出ない）
const TYPES = {
  '剣兵': { hp: 30, atk: 10, def: 6, spd: 6, rng: 1, act: 2, hit: 85, best: 1,
            falloff: { 1: { hit: 1.0, pow: 1.0 } } },
  '槍兵': { hp: 28, atk: 16, def: 7, spd: 5, rng: 2, act: 1, hit: 80, best: 2,
            falloff: { 1: { hit: 0.9, pow: 0.9 }, 2: { hit: 1.0, pow: 1.0 } } },
  // 平面（マンハッタン距離）向け: 斜め方向は距離が長く数えられ、前衛越しに撃つと距離3〜4になるため
  // 最適帯を2〜3に広げ、射程を5に延長している
  '弓兵': { hp: 20, atk: 9,  def: 3, spd: 7, rng: 5, act: 2, hit: 80, best: 3, rear: true,
            falloff: { 1: { hit: 0.6, pow: 1.0 },    // 近すぎて狙いにくいが威力はある
                       2: { hit: 1.0, pow: 1.0 },    // 最大性能
                       3: { hit: 1.0, pow: 1.0 },    // 最大性能（前衛越しの基本距離）
                       4: { hit: 0.9, pow: 0.9 },    // 準最大
                       5: { hit: 0.7, pow: 0.7 } } },// 最低
};
const HIT_SPREAD = 5;   // 命中率の個体差 ±5%
const TYPE_NAMES = Object.keys(TYPES);

// ============================================================
// ダイス
// ============================================================

function d(sides) {
  return Math.floor(Math.random() * sides) + 1;
}

/** nDs を振り、出目の配列と合計を返す */
function roll(n, sides) {
  const dice = Array.from({ length: n }, () => d(sides));
  return { dice, total: dice.reduce((a, b) => a + b, 0) };
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ============================================================
// ユニット
// ============================================================

let unitSeq = 0;

class Unit {
  constructor(side, rank, type, name, x, y) {
    const r = RANKS[rank];
    const t = TYPES[type];
    this.id = ++unitSeq;
    this.side = side;           // 'player' | 'cpu'
    this.name = name;
    this.rank = rank;
    this.type = type;
    this.cost = r.cost;
    this.maxHp = Math.round(t.hp * r.hp);
    this.hp = this.maxHp;
    this.atk = Math.round(t.atk * r.atk);
    this.def = Math.round(t.def * r.def);
    this.spd = t.spd + r.spd + d(3) - 1;   // 個体差 +0〜2
    this.rng = t.rng;
    this.act = t.act;
    this.hit = t.hit + d(HIT_SPREAD * 2 + 1) - HIT_SPREAD - 1;   // 個体差 ±HIT_SPREAD
    this.best = t.best;
    this.falloff = t.falloff;
    this.rear = !!t.rear;
    this.x = x;
    this.y = y;
  }

  get alive() { return this.hp > 0; }
  get isCommander() { return this.rank === '総大将'; }
  get posText() { return `(${this.x},${this.y})`; }
  /** 1回の行動で移動できるマス数（SPDが高いほど多い） */
  get move() { return Math.max(1, Math.ceil(this.spd / 3)); }
  /** 後退できるマス数（移動力の半分・端数切り上げ） */
  get retreat() { return Math.ceil(this.move / 2); }
}

// ============================================================
// 編成フェーズ
// ============================================================

/**
 * 3d6 で配下の部隊数を決め、1軍を生成する。
 * 出目合計 N = 部隊長 + 雑兵 の総数。部隊長は N/6 人（最低1人）、残りが雑兵。
 * これとは別に総大将が1人つく。
 */
function formArmy(side, map) {
  const r = roll(3, 6);
  const n = r.total;
  const leaders = Math.max(1, Math.floor(n / 6));
  const soldiers = n - leaders;

  const label = side === 'player' ? 'P' : 'C';
  // プレイヤーは下端、CPUは上端に布陣。総大将は最後列の中央。
  const back = side === 'player' ? map.h - 1 : 0;
  const dir = side === 'player' ? -1 : 1;
  const cx = Math.floor(map.w / 2);

  // 自陣（後方 DEPLOY_ROWS 列）の空きマスをシャッフルして配下を置く
  const cells = [];
  for (let r = 0; r < DEPLOY_ROWS; r++) {
    for (let x = 0; x < map.w; x++) {
      if (r === 0 && x === cx) continue;
      cells.push([x, back + dir * r]);
    }
  }
  // シャッフルしてから前の列優先で並べる（前列から埋まる）
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  cells.sort((a, b) => Math.abs(b[1] - back) - Math.abs(a[1] - back));

  const units = [];
  units.push(new Unit(side, '総大将', pick(TYPE_NAMES), `${label}総大将`, cx, back));
  let c = 0;
  for (let i = 1; i <= leaders; i++) {
    const type = pick(TYPE_NAMES);
    units.push(new Unit(side, '部隊長', type, `${label}${type}長${i}`, ...cells[c++]));
  }
  for (let i = 1; i <= soldiers; i++) {
    const type = pick(TYPE_NAMES);
    units.push(new Unit(side, '雑兵', type, `${label}${type}${i}`, ...cells[c++]));
  }
  return { dice: r, units, leaders, soldiers };
}

/** マップの広さとタイプをダイスで決める */
function formMap() {
  const wd = d(6), hd = d(6);
  return { type: pick(MAP_TYPES), w: MAP_MIN_W + wd, h: MAP_MIN_H + hd, wd, hd };
}

// ============================================================
// バトルフェーズ
// ============================================================

const state = {
  map: null,
  player: null,
  cpu: null,
  turn: 0,
  running: false,
  over: false,
  timer: null,
};

function allUnits() {
  return [...state.player.units, ...state.cpu.units];
}

function enemiesOf(unit) {
  const army = unit.side === 'player' ? state.cpu : state.player;
  return army.units.filter(u => u.alive);
}

function alliesOf(unit) {
  const army = unit.side === 'player' ? state.player : state.cpu;
  return army.units.filter(u => u.alive && u !== unit);
}

/** マンハッタン距離（4方向移動なので斜めは距離2） */
function distance(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function unitAt(x, y) {
  return allUnits().find(u => u.alive && u.x === x && u.y === y);
}

/** 地点 p から最も近い敵までの距離 */
function nearestEnemyDist(unit, p) {
  return Math.min(...enemiesOf(unit).map(e => distance(p, e)));
}

function nearestEnemy(unit) {
  let best = null;
  for (const e of enemiesOf(unit)) {
    if (!best || distance(unit, e) < distance(unit, best) ||
        (distance(unit, e) === distance(unit, best) && e.hp < best.hp)) {
      best = e;
    }
  }
  return best;
}

/**
 * 攻撃判定:
 *   命中率 = HIT × 距離の命中倍率。1d100 が命中率以下なら命中
 *   ダメージ = max(1, (ATK + 1d6 − DEF) × 距離の威力倍率)  ※四捨五入
 *   1d6 の出目6はクリティカルで ATK × 1.5 として計算
 */
function calcAttack(attacker, defender) {
  const f = attacker.falloff[distance(attacker, defender)];
  const hitRate = Math.round(attacker.hit * f.hit);
  const hitRoll = d(100);
  if (hitRoll > hitRate) return { hit: false, hitRate, hitRoll };
  const die = d(6);
  const crit = die === 6;
  const atk = crit ? Math.floor(attacker.atk * 1.5) : attacker.atk;
  const dmg = Math.max(1, Math.round((atk + die - defender.def) * f.pow));
  return { hit: true, hitRate, hitRoll, dmg, die, crit };
}

/** SPD 降順で行動キューを作る（同値はランダム） */
function buildQueue() {
  return allUnits()
    .filter(u => u.alive)
    .map(u => ({ u, tie: Math.random() }))
    .sort((a, b) => b.u.spd - a.u.spd || a.tie - b.tie)
    .map(x => x.u);
}

/**
 * 後衛が地点 p に立ってよいか。
 * 味方の前衛（総大将以外の後衛でないユニット）のうち最も前にいる者より前には出ない。
 * 前衛が残っていなければ制限なし。
 */
function withinFrontLine(unit, p) {
  if (!unit.rear) return true;
  const front = alliesOf(unit).filter(a => !a.rear && !a.isCommander);
  if (front.length === 0) return true;
  // プレイヤーは y が小さいほど前、CPU は y が大きいほど前
  return unit.side === 'player'
    ? p.y >= Math.min(...front.map(a => a.y))
    : p.y <= Math.max(...front.map(a => a.y));
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];   // 上下左右の4方向

/**
 * 最大 steps マス以内で到達できるマスのうち、score が最小のマスへ移動する。
 * 4方向に1マスずつ進む（幅優先探索）。味方のいるマスは通過できるが止まれない。
 * 敵のいるマスは通過も不可。マップの外には出られない。
 * 今の位置より良いマスがなければ動かない。動いたら true を返す。
 */
function moveUnit(unit, steps, score) {
  const { w, h } = state.map;
  const seen = new Set([`${unit.x},${unit.y}`]);
  let frontier = [[unit.x, unit.y]];
  let best = [unit.x, unit.y];
  let bestScore = score({ x: unit.x, y: unit.y });
  for (let s = 0; s < steps; s++) {
    const next = [];
    for (const [x, y] of frontier) {
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy, key = `${nx},${ny}`;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen.has(key)) continue;
        const other = unitAt(nx, ny);
        if (other && other.side !== unit.side) continue;   // 敵は通り抜け不可
        seen.add(key);
        next.push([nx, ny]);
        if (other) continue;                               // 味方のマスには止まれない
        const sc = score({ x: nx, y: ny });
        if (sc < bestScore) { bestScore = sc; best = [nx, ny]; }
      }
    }
    frontier = next;
  }
  if (best[0] === unit.x && best[1] === unit.y) return false;
  [unit.x, unit.y] = best;
  return true;
}

/** 1ユニット分の行動（AI） */
function actUnit(unit) {
  let target = nearestEnemy(unit);
  if (!target) return;

  // 最適距離より遠い → 前進（射程外なら必ず、射程内でも最適距離まで詰める）
  // 総大将は配下が残っている間は本陣から動かない（射程内に敵がいれば攻撃はする）
  const holding = unit.isCommander && alliesOf(unit).length > 0;
  if (holding && distance(unit, target) > unit.rng) {
    log(`${unit.name} は本陣で戦況を見守っている。`, unit.side);
    return;
  }
  if (!holding && distance(unit, target) > unit.best) {
    const before = unit.posText;
    // 最も近い敵との距離が最適距離にできるだけ近いマスへ（近すぎるマスは避ける）
    // 後衛は前衛より前のマスには止まらない
    const moved = moveUnit(unit, unit.move, p => {
      if (!withinFrontLine(unit, p)) return Infinity;
      const m = nearestEnemyDist(unit, p);
      return Math.abs(m - unit.best) * 10 + (m < unit.best ? 5 : 0) + distance(p, target) * 0.01;
    });
    if (moved) {
      log(`${unit.name} は前進した。${before} → ${unit.posText}`, unit.side);
    } else {
      log(unit.rear ? `${unit.name} は前衛の後ろで待機している。` : `${unit.name} は進路を阻まれて前進できない。`, unit.side);
    }
    // 前進後に射程内に入っていなければ行動終了
    target = nearestEnemy(unit);
    if (!target || distance(unit, target) > unit.rng) return;
  }

  // 射程で勝っていて敵が最適距離より近い → 最適距離に向けて後退（引き撃ち、移動力の半分まで）
  if (unit.rng > target.rng && distance(unit, target) < unit.best) {
    const before = unit.posText;
    if (moveUnit(unit, unit.retreat, p =>
          withinFrontLine(unit, p) ? Math.abs(nearestEnemyDist(unit, p) - unit.best) : Infinity)) {
      log(`${unit.name} は間合いを取った。${before} → ${unit.posText}`, unit.side);
    }
    target = nearestEnemy(unit);
  }

  // 射程内 → ACT 回攻撃
  for (let i = 0; i < unit.act; i++) {
    target = nearestEnemy(unit);
    if (!target || distance(unit, target) > unit.rng) break;
    const dist = distance(unit, target);
    const r = calcAttack(unit, target);
    if (!r.hit) {
      log(`${unit.name} の攻撃！ [距離${dist} 命中${r.hitRate}% 🎲${r.hitRoll}] ${target.name} にかわされた！`, unit.side);
      continue;
    }
    target.hp = Math.max(0, target.hp - r.dmg);
    log(`${unit.name} の攻撃！ [距離${dist} 命中${r.hitRate}% 🎲${r.hitRoll}] 命中！ [🎲${r.die}]${r.crit ? ' 会心の一撃！' : ''} ${target.name} に ${r.dmg} のダメージ！ (残HP ${target.hp}/${target.maxHp})`, unit.side);
    if (!target.alive) {
      log(`☠ ${target.name} は倒れた！`, 'death');
      if (checkVictory()) return;
    }
  }
}

/** 勝利判定。決着したら true を返す */
function checkVictory() {
  const lost = army => {
    const cmd = army.units.find(u => u.isCommander);
    return !cmd.alive || army.units.every(u => !u.alive);
  };
  const pLost = lost(state.player);
  const cLost = lost(state.cpu);
  if (!pLost && !cLost) return false;

  let msg;
  if (pLost && cLost) msg = '引き分け！';
  else if (cLost) msg = '🏆 プレイヤー軍の勝利！';
  else msg = '💀 プレイヤー軍の敗北…';
  endGame(msg);
  return true;
}

function endGame(msg) {
  state.over = true;
  state.running = false;
  clearTimeout(state.timer);
  log(`=== ${msg} (${state.turn}ターン) ===`, 'turn');
  const el = document.getElementById('result');
  el.textContent = msg;
  el.classList.remove('hidden');
  updateButtons();
  render();
}

/**
 * バトル進行。1ユニットの行動ごとに delay ミリ秒待つ。
 * ターン開始時にキューを作り、先頭から順に行動させる。
 */
function runBattle() {
  let queue = [];
  const delay = () => Number(document.getElementById('speed').value);

  const step = () => {
    if (state.over) return;

    if (queue.length === 0) {
      if (state.turn >= MAX_TURNS) {
        endGame('時間切れ… 引き分け');
        return;
      }
      state.turn++;
      queue = buildQueue();
      log(`--- ターン ${state.turn} --- 行動順: ${queue.map(u => `${u.name}(${u.spd})`).join(' > ')}`, 'turn');
    }

    const unit = queue.shift();
    if (unit.alive) {
      actUnit(unit);
      render(unit);
    }

    if (!state.over) {
      // 「一瞬」設定のときは生存ユニットの行動でなくても間を空けずに進める
      state.timer = setTimeout(step, unit.alive ? delay() : 0);
    }
  };
  step();
}

// ============================================================
// UI
// ============================================================

const $ = id => document.getElementById(id);

function log(text, cls = 'sys') {
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  const box = $('log');
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function renderArmy(army, side, acting) {
  const tbody = $(`${side}-units`);
  tbody.innerHTML = '';
  for (const u of army.units) {
    const tr = document.createElement('tr');
    tr.className = `rank-${u.rank}` + (u.alive ? '' : ' dead') + (u === acting ? ' acting' : '');
    const ratio = u.hp / u.maxHp;
    const color = ratio > 0.5 ? '#5c5' : ratio > 0.25 ? '#dc5' : '#d55';
    tr.innerHTML = `
      <td>${u.name}</td><td>${u.rank}</td><td>${u.type}</td>
      <td><span class="hpbar"><div style="width:${ratio * 100}%;background:${color}"></div></span>${u.hp}/${u.maxHp}</td>
      <td>${u.atk}</td><td>${u.def}</td><td>${u.spd}</td><td>${u.rng}</td><td>${u.act}</td><td>${u.hit}%</td><td>${u.posText}</td>`;
    tbody.appendChild(tr);
  }
  const alive = army.units.filter(u => u.alive);
  const cost = army.units.reduce((s, u) => s + u.cost, 0);
  $(`${side}-summary`).textContent =
    `総大将1 / 部隊長${army.leaders} / 雑兵${army.soldiers}　生存 ${alive.length}/${army.units.length}　総コスト ${cost}`;
  $(`${side}-dice`).textContent =
    `3d6: [${army.dice.dice.join('][')}] = ${army.dice.total}`;
}

function renderField(acting) {
  const { w, h, type, wd, hd } = state.map;
  const field = $('field');
  field.innerHTML = '';
  field.style.gridTemplateColumns = `repeat(${w}, minmax(0, 1fr))`;
  const short = u => (u.isCommander ? '★' : u.rank === '部隊長' ? '◆' : '') + u.type[0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = unitAt(x, y);
      const cell = document.createElement('div');
      cell.className = 'cell' + (u ? ` ${u.side === 'player' ? 'p' : 'c'}` : '') + (u && u === acting ? ' acting' : '');
      if (u) {
        cell.title = `${u.name} HP ${u.hp}/${u.maxHp}`;
        cell.innerHTML = `<span class="glyph">${short(u)}</span><span class="mini-hp" style="width:${u.hp / u.maxHp * 100}%"></span>`;
      }
      field.appendChild(cell);
    }
  }
  const legend = '★総大将 ◆部隊長 / 剣=剣兵 槍=槍兵 弓=弓兵 / 青=プレイヤー 赤=CPU';
  $('turn-label').textContent =
    `${type} ${w}×${h}（幅 ${MAP_MIN_W}+🎲${wd} / 高さ ${MAP_MIN_H}+🎲${hd}）` +
    (state.turn ? `　ターン ${state.turn}` : '') + `　${legend}`;
}

function render(acting = null) {
  if (!state.player) return;
  renderArmy(state.player, 'player', acting);
  renderArmy(state.cpu, 'cpu', acting);
  renderField(acting);
}

function updateButtons() {
  $('btn-form').disabled = state.running;
  $('btn-start').disabled = !state.player || state.running || state.over;
}

// ============================================================
// イベント
// ============================================================

$('btn-form').addEventListener('click', () => {
  reset();
  state.map = formMap();
  state.player = formArmy('player', state.map);
  state.cpu = formArmy('cpu', state.map);
  log(`🎲 マップ: ${state.map.type} 幅 ${MAP_MIN_W}+${state.map.wd} = ${state.map.w} / 高さ ${MAP_MIN_H}+${state.map.hd} = ${state.map.h}`);
  log(`🎲 プレイヤー軍 3d6 = [${state.player.dice.dice.join(', ')}] → 部隊数 ${state.player.dice.total}（部隊長${state.player.leaders} / 雑兵${state.player.soldiers}）`, 'player');
  log(`🎲 CPU軍 3d6 = [${state.cpu.dice.dice.join(', ')}] → 部隊数 ${state.cpu.dice.total}（部隊長${state.cpu.leaders} / 雑兵${state.cpu.soldiers}）`, 'cpu');
  log('編成完了。「戦闘開始」で開戦します。');
  render();
  updateButtons();
});

$('btn-start').addEventListener('click', () => {
  if (!state.player || state.running || state.over) return;
  state.running = true;
  updateButtons();
  log('⚔ 開戦！', 'turn');
  runBattle();
});

$('btn-reset').addEventListener('click', reset);

function reset() {
  clearTimeout(state.timer);
  Object.assign(state, { map: null, player: null, cpu: null, turn: 0, running: false, over: false, timer: null });
  unitSeq = 0;
  $('log').innerHTML = '';
  $('result').classList.add('hidden');
  for (const side of ['player', 'cpu']) {
    $(`${side}-units`).innerHTML = '';
    $(`${side}-summary`).textContent = '';
    $(`${side}-dice`).textContent = '';
  }
  $('field').innerHTML = '';
  $('turn-label').textContent = '';
  log('「編成」ボタンでダイスを振り、両軍を編成してください。');
  updateButtons();
}

reset();
