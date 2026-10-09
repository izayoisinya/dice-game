'use strict';

// ============================================================
// 定数・マスターデータ
// ============================================================

const FIELD_SIZE = 21;        // 戦場の長さ（位置 0〜20 の一次元）
const MAX_TURNS = 100;        // 決着がつかない場合の打ち切りターン

// 階級: コストとステータス倍率
const RANKS = {
  '雑兵':   { cost: 50,  hp: 1.0, atk: 1.0, def: 1.0, spd: 0 },
  '部隊長': { cost: 100, hp: 1.6, atk: 1.4, def: 1.4, spd: 1 },
  '総大将': { cost: 200, hp: 3.0, atk: 1.8, def: 1.8, spd: 2 },
};

// 兵種: 基礎ステータス
// RNG = 攻撃射程, ACT = 攻撃速度（1回の行動で攻撃する回数）, HIT = 基本命中率(%)
// falloff[距離] = { hit: 命中倍率, pow: 威力倍率 }。best = 最も性能を発揮する距離
const TYPES = {
  '剣兵': { hp: 30, atk: 10, def: 6, spd: 6, rng: 1, act: 2, hit: 85, best: 1,
            falloff: { 1: { hit: 1.0, pow: 1.0 } } },
  '槍兵': { hp: 28, atk: 16, def: 7, spd: 5, rng: 2, act: 1, hit: 80, best: 2,
            falloff: { 1: { hit: 0.9, pow: 0.9 }, 2: { hit: 1.0, pow: 1.0 } } },
  '弓兵': { hp: 20, atk: 9,  def: 3, spd: 7, rng: 4, act: 2, hit: 80, best: 2,
            falloff: { 1: { hit: 0.6,  pow: 1.0 },    // 近すぎて狙いにくいが威力はある
                       2: { hit: 1.0,  pow: 1.0 },    // 最も性能を発揮
                       3: { hit: 0.85, pow: 0.85 },   // 命中・威力とも準最大
                       4: { hit: 0.6,  pow: 0.6 } } },// 命中・威力とも最低
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
  constructor(side, rank, type, name, pos) {
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
    this.pos = pos;
  }

  get alive() { return this.hp > 0; }
  get isCommander() { return this.rank === '総大将'; }
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
function formArmy(side) {
  const r = roll(3, 6);
  const n = r.total;
  const leaders = Math.max(1, Math.floor(n / 6));
  const soldiers = n - leaders;

  const label = side === 'player' ? 'P' : 'C';
  // プレイヤーは左端(0)側、CPUは右端(20)側に布陣。総大将は最後尾。
  const back = side === 'player' ? 0 : FIELD_SIZE - 1;
  const dir = side === 'player' ? 1 : -1;
  const frontPos = () => back + dir * (1 + Math.floor(Math.random() * 3)); // 最後尾から1〜3マス前

  const units = [];
  units.push(new Unit(side, '総大将', pick(TYPE_NAMES), `${label}総大将`, back));
  for (let i = 1; i <= leaders; i++) {
    const type = pick(TYPE_NAMES);
    units.push(new Unit(side, '部隊長', type, `${label}${type}長${i}`, frontPos()));
  }
  for (let i = 1; i <= soldiers; i++) {
    const type = pick(TYPE_NAMES);
    units.push(new Unit(side, '雑兵', type, `${label}${type}${i}`, frontPos()));
  }
  return { dice: r, units, leaders, soldiers };
}

// ============================================================
// バトルフェーズ
// ============================================================

const state = {
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

function distance(a, b) {
  return Math.abs(a.pos - b.pos);
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
 * dir 方向へ最大 steps マス、1マスずつ移動する。
 * 味方のいるマスは追い越せるが、敵のいるマスには入れない（通り抜け不可）。
 * 戦場の端でも止まる。実際に動いたマス数を返す。
 */
function moveUnit(unit, dir, steps) {
  let moved = 0;
  while (moved < steps) {
    const next = unit.pos + dir;
    if (next < 0 || next >= FIELD_SIZE) break;
    if (enemiesOf(unit).some(e => e.pos === next)) break;
    unit.pos = next;
    moved++;
  }
  return moved;
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
    const dir = Math.sign(target.pos - unit.pos);
    const before = unit.pos;
    // 最適距離に入るまで、最大 move マス進む
    const need = distance(unit, target) - unit.best;
    if (moveUnit(unit, dir, Math.min(unit.move, need)) > 0) {
      log(`${unit.name} は前進した。(位置 ${before} → ${unit.pos})`, unit.side);
    } else {
      log(`${unit.name} は敵に阻まれて前進できない。`, unit.side);
    }
    // 前進後に射程内に入っていなければ行動終了
    target = nearestEnemy(unit);
    if (!target || distance(unit, target) > unit.rng) return;
  }

  // 射程で勝っていて敵が最適距離より近い → 最適距離に向けて後退（引き撃ち、移動力の半分まで）
  if (unit.rng > target.rng && distance(unit, target) < unit.best) {
    const dir = Math.sign(unit.pos - target.pos) || (unit.side === 'player' ? -1 : 1);
    const before = unit.pos;
    if (moveUnit(unit, dir, Math.min(unit.retreat, unit.best - distance(unit, target))) > 0) {
      log(`${unit.name} は間合いを取った。(位置 ${before} → ${unit.pos})`, unit.side);
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
      <td>${u.atk}</td><td>${u.def}</td><td>${u.spd}</td><td>${u.rng}</td><td>${u.act}</td><td>${u.hit}%</td><td>${u.pos}</td>`;
    tbody.appendChild(tr);
  }
  const alive = army.units.filter(u => u.alive);
  const cost = army.units.reduce((s, u) => s + u.cost, 0);
  $(`${side}-summary`).textContent =
    `総大将1 / 部隊長${army.leaders} / 雑兵${army.soldiers}　生存 ${alive.length}/${army.units.length}　総コスト ${cost}`;
  $(`${side}-dice`).textContent =
    `3d6: [${army.dice.dice.join('][')}] = ${army.dice.total}`;
}

function renderField() {
  const field = $('field');
  field.innerHTML = '';
  const short = u => (u.isCommander ? '★' : u.rank === '部隊長' ? '◆' : '') + u.type[0];
  for (let x = 0; x < FIELD_SIZE; x++) {
    const here = allUnits().filter(u => u.alive && u.pos === x);
    const p = here.filter(u => u.side === 'player').map(short).join('');
    const c = here.filter(u => u.side === 'cpu').map(short).join('');
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.innerHTML = `<div class="idx">${x}</div><div class="p">${p}</div><div class="c">${c}</div>`;
    field.appendChild(cell);
  }
  $('turn-label').textContent = state.turn ? `ターン ${state.turn}　(★総大将 ◆部隊長 / 剣=剣兵 槍=槍兵 弓=弓兵)` : '(★総大将 ◆部隊長 / 剣=剣兵 槍=槍兵 弓=弓兵)';
}

function render(acting = null) {
  if (!state.player) return;
  renderArmy(state.player, 'player', acting);
  renderArmy(state.cpu, 'cpu', acting);
  renderField();
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
  state.player = formArmy('player');
  state.cpu = formArmy('cpu');
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
  Object.assign(state, { player: null, cpu: null, turn: 0, running: false, over: false, timer: null });
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
