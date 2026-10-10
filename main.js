'use strict';

// ============================================================
// 定数・マスターデータ
// ============================================================

const MAX_TURNS = 100;        // 決着がつかない場合の打ち切りターン

// マップの広さ: 最低値 + 2d6 で決定（幅 14〜24 × 高さ 16〜26）
// 2d6 なので中くらいの広さが出やすい。幅の最低値は最大編成（3d6=18体）が自陣3列に余裕をもって収まる値
const MAP_MIN_W = 12;
const MAP_MIN_H = 14;
const MAP_DICE = 2;           // 広さに振るダイスの数（各 MAP_DICE d6）
const DEPLOY_ROWS = 3;        // 自陣として布陣できる列数（後方から）

// マップタイプ（今は平野のみ。市街戦・山間部などは地形ギミックと合わせて今後追加）
const MAP_TYPES = ['平野'];

// ------------------------------------------------------------
// コスト制ステータス
//   各ユニットは「ステータス値の合計 = 階級のコスト」になるよう作る。
//   射程は強力なので、RNG だけは 1 上げるごとに 30 ポイント払う（rngCost）。
//   雑兵のプリセット（合計500）を基準に、上の階級はコスト比で拡大する（部隊長 ×2、総大将 ×4）。
//   射程の値は階級で変わらないが、払うコストも同じ比率で上がるので兵種間の比率は保たれる。
// ------------------------------------------------------------

// 階級: コスト = ステータス合計の予算
const RANKS = {
  '雑兵':   { cost: 500 },
  '部隊長': { cost: 1000 },
  '総大将': { cost: 2000 },
};
const BASE_COST = RANKS['雑兵'].cost;
const STAT_KEYS = ['hp', 'atk', 'def', 'spd', 'act'];   // 射程以外の比例拡大するステータス

/** 射程に払うコスト（RNG1=10, 2=40, 3=70, 4=100, 5=130） */
function rngCost(rng) {
  return (rng * 3 - 2) * 10;
}

// ステータス値 → ゲーム内の値への換算
const HP_SCALE = 3;           // 実HP = HP値 × 3
const MOVE_DIV = 40;          // 移動力 = 階級補正後SPD ÷ 40（切り上げ）
const ACT_PER_ATTACK = 50;    // 行動ゲージがこの値たまるごとに1回攻撃できる
const ACT_GAUGE_MAX = 100;    // ゲージの上限（ため込みすぎ防止）
const DAMAGE_DIE_SCALE = 10;  // ダメージのダイス = 1d6 × 10（ステータスの桁に合わせる）
const MIN_DAMAGE = 10;        // 最低ダメージ（固定値）
const MIN_DAMAGE_RATE = 0.15; // 最低でも ATK のこの割合は通る（DEF が高すぎて削れない状態を防ぐ）
const SURROUND_BONUS = 0.1;   // 包囲ボーナス: 攻撃対象に隣接する味方1体ごとの威力上昇（攻撃者自身は数えない）

// 総大将が本陣を出て前に出るタイミング（配下の残存率がこの値を下回ったら出撃）。
// NPC 戦のモード（慎重・標準・好戦的など）の調整に使う想定
const ADVANCE_MODES = {
  hold: { name: '全滅まで待機',     ratio: 0 },
  r30:  { name: '残り30%で出撃',    ratio: 0.3 },
  r50:  { name: '残り50%で出撃',    ratio: 0.5 },
  now:  { name: '最初から出撃',     ratio: 1.01 },
};

// 固有能力: ステータスの予算からコストを払って持つ（階級が上がるとコストも同じ比率で上がる）
const TRAITS = {
  zoc:    { name: '足止め', cost: 40 },  // 隣接したマスに入った敵はそこで移動が止まる
  charge: { name: '突撃',   cost: 20 },  // 一直線に走ってそのまま攻撃すると、走ったマス数に応じて威力が上がる
};
const CHARGE_MIN = 2;         // 突撃になる最低直進マス数
const CHARGE_BONUS = 0.3;     // 直進1マスあたりの威力上昇（初撃のみ）

// 兵種の相性（剣・槍・弓の三すくみ）。攻撃側 → 防御側 のダメージ倍率。書いていない組み合わせは ×1.0
//   槍 → 剣: リーチで制す / 剣 → 弓: 詰め寄って斬る / 弓 → 槍: 鈍重な槍兵を射る
const MATCHUP = {
  '槍兵': { '剣兵': 1.35, '弓兵': 0.85 },
  '剣兵': { '弓兵': 1.3,  '槍兵': 0.75 },
  '弓兵': { '槍兵': 1.2,  '剣兵': 0.75 },
};

// 兵種: 雑兵（コスト500）のステータスプリセット
//   HP / ATK / DEF / SPD / ACT + RNG（rngCost で換算）+ 固有能力のコスト = 500
// HIT = 基本命中率(%)
// falloff[距離] = { hit: 命中倍率, pow: 威力倍率 }。best = 最も性能を発揮する距離
// rear = 後衛（前衛より前に出ない）
const TYPES = {
  // 近距離特化、足と手数が速い
  '剣兵': { stats: { hp: 120, atk: 100, def: 90, spd: 100, act: 80 }, rng: 1, hit: 85, best: 1,
            falloff: { 1: { hit: 1.0, pow: 1.0 } } },
  // 打たれ強く射程2、攻撃速度はやや遅い
  '槍兵': { stats: { hp: 120, atk: 100, def: 100, spd: 80, act: 60 }, rng: 2, hit: 80, best: 2,
            falloff: { 1: { hit: 0.9, pow: 0.9 }, 2: { hit: 0.85, pow: 1.0 } } },
  // 遠距離攻撃の代わりに脆い。
  // 平面（マンハッタン距離）向け: 斜め方向は距離が長く数えられ、前衛越しに撃つと距離3〜4になるため
  // 最適帯を2〜3に広げ、射程を5にしている
  '弓兵': { stats: { hp: 70, atk: 110, def: 40, spd: 80, act: 70 }, rng: 5, hit: 80, best: 3, rear: true,
            falloff: { 1: { hit: 0.6, pow: 1.0 },    // 近すぎて狙いにくいが威力はある
                       2: { hit: 1.0, pow: 1.0 },    // 最大性能
                       3: { hit: 1.0, pow: 1.0 },    // 最大性能（前衛越しの基本距離）
                       4: { hit: 0.9, pow: 0.9 },    // 準最大
                       5: { hit: 0.7, pow: 0.7 } } },// 最低
  // 被ダメも与ダメも低い壁役。足止め（ZOC）で敵の進軍を止める
  '盾兵': { stats: { hp: 140, atk: 70, def: 140, spd: 50, act: 50 }, rng: 1, hit: 80, best: 1, traits: ['zoc'],
            falloff: { 1: { hit: 1.0, pow: 1.0 } } },
  // 移動速度重視。一直線に走り込んでの突撃が武器
  '騎兵': { stats: { hp: 100, atk: 110, def: 80, spd: 130, act: 50 }, rng: 1, hit: 80, best: 1, traits: ['charge'],
            falloff: { 1: { hit: 1.0, pow: 1.0 } } },
  // 総大将専用。三すくみの相性を持たず（与える側も受ける側も ×1.0）、総大将の強さは振り分けで決まる。
  // stats は固定枠（SPD / ACT）の基準値として使う。HP / ATK / DEF は振り分けで上書きされる
  '将':   { stats: { hp: 120, atk: 110, def: 100, spd: 90, act: 70 }, rng: 1, hit: 85, best: 1, commanderOnly: true,
            falloff: { 1: { hit: 1.0, pow: 1.0 }, 2: { hit: 0.9, pow: 0.9 } } },
};

/** 兵種の固有能力のコスト合計 */
function traitCost(t) {
  return (t.traits || []).reduce((s, k) => s + TRAITS[k].cost, 0);
}

/**
 * 雑兵プリセットを階級のコストまで比例拡大する。射程の値はそのまま（コストは比率分払う）。
 * 端数で合計がずれた分は、いちばん大きいステータスで調整する。
 */
function scaleStats(type, cost) {
  const t = TYPES[type];
  const budget = cost - (rngCost(t.rng) + traitCost(t)) * cost / BASE_COST;
  const baseSum = STAT_KEYS.reduce((s, k) => s + t.stats[k], 0);
  const out = {};
  for (const k of STAT_KEYS) out[k] = Math.round(t.stats[k] * budget / baseSum);
  const diff = budget - STAT_KEYS.reduce((s, k) => s + out[k], 0);
  const top = STAT_KEYS.reduce((a, k) => (out[k] > out[a] ? k : a), STAT_KEYS[0]);
  out[top] += diff;
  return out;
}

// ------------------------------------------------------------
// 総大将のステータス振り分け
//   SPD / ACT / RNG / 固有能力は兵種ごとの固定値（雑兵プリセットと同じ値）。
//   固定枠の分は階級倍率分のコストを払い、残りを HP / ATK / DEF に自由に振り分ける。
//   固定枠を上げたいときは、通常の UPGRADE_MULT 倍のポイントが必要（上限 UPGRADE_CAP）。
//   射程の上限は兵種の基本値の RNG_CAP_RATE 倍（切り上げ）。弓より射程の長い剣などが生まれないようにする。
//   手動プレイではプレイヤーが振り分ける想定。下の「型」はその例。
//   ※型どうしのバランスは未解決（docs/design.md 参照）のため、オート時は全員 AUTO_BUILD を使う。
// ------------------------------------------------------------
const UPGRADE_MULT = 1.5;
const UPGRADE_CAP = { spd: 50, act: 50 };
const RNG_CAP_RATE = 1.5;     // 剣 1→2 / 槍 2→3 / 弓 5→8 まで

/** 兵種の射程の上限 */
function maxRng(type) {
  return Math.ceil(TYPES[type].rng * RNG_CAP_RATE);
}
const AUTO_BUILD = 'バランス型';
// 自由枠の各ステータス（HP / ATK / DEF）に振れる割合の下限・上限。HP 0 のような極端な振り方を防ぐ
const ALLOC_MIN = 0.2;
const ALLOC_MAX = 0.5;
const COMMANDER_BUILDS = {
  'バランス型': { hp: 4, atk: 3, def: 3, skills: ['一斉指揮'] },
  '攻撃型':     { hp: 3.5, atk: 3.5, def: 3, skills: ['強撃'] },
  '防御型':     { hp: 3.5, atk: 2.5, def: 4, skills: ['鉄壁の構え'] },
  '騎乗型':     { hp: 4, atk: 3, def: 3, buy: { spd: 40 }, skills: ['一撃離脱'] },  // 騎乗して足を買う（移動力 3→4）分、他が薄い
};

// ------------------------------------------------------------
// スキル
//   総大将は2つ、副将は1つまで持てる（SKILL_SLOTS）。1つ目は無料、2つ目以降は自由枠のポイントを払う。
//   いずれも「行動中に条件を満たしたら自動で使う」能動型。使うと cooldown（自分の行動回数）の間は使えない。
//   スキルの使用は行動を消費しない。
// ------------------------------------------------------------
const SKILL_SLOTS = { '総大将': 2, '副将': 1 };
const SKILLS = {
  '強撃':       { cost: 250, cooldown: 3, desc: '次の一撃の ATK ×1.15' },
  '鉄壁の構え': { cost: 200, cooldown: 3, desc: '次の自分の行動まで DEF +100%。その行動では移動しない' },
  '一斉指揮':   { cost: 300, cooldown: 4, desc: '自分と周囲3マスの味方の ATK +30% / DEF +15%（各自の行動2回分）' },
  '一撃離脱':   { cost: 250, cooldown: 2, desc: '攻撃した後、敵から離れる方向へ移動力の分だけ下がる' },
  '遠隔狙撃':   { cost: 250, cooldown: 3, desc: 'この行動だけ射程 +1' },
};
const SMASH_MULT = 1.15;      // 強撃の ATK 倍率
const COMMAND_RANGE = 3;      // 一斉指揮の範囲

// 士気: 総大将の周囲 MORALE_RANGE マス以内の味方は、スキルとは別に常に ATK / DEF が少し上がる
const MORALE_RANGE = 3;
const MORALE_BONUS = 0.05;

/**
 * HP / ATK / DEF の振り分け比を、合計1・各 ALLOC_MIN〜ALLOC_MAX に収める。
 * はみ出した分は、範囲内に残っているステータスへ比率どおりに配り直す。
 */
function clampShares(w) {
  const keys = Object.keys(w);
  const total = keys.reduce((s, k) => s + w[k], 0);
  const out = {};
  for (const k of keys) out[k] = w[k] / total;
  for (let i = 0; i < 10; i++) {
    let excess = 0;
    const free = [];
    for (const k of keys) {
      if (out[k] > ALLOC_MAX) { excess += out[k] - ALLOC_MAX; out[k] = ALLOC_MAX; }
      else if (out[k] < ALLOC_MIN) { excess -= ALLOC_MIN - out[k]; out[k] = ALLOC_MIN; }
      else free.push(k);
    }
    if (Math.abs(excess) < 1e-9 || free.length === 0) break;
    const freeSum = free.reduce((s, k) => s + out[k], 0);
    for (const k of free) out[k] += excess * out[k] / freeSum;
  }
  return out;
}

/** 総大将のステータスを、兵種の固定枠 + 型の振り分けで作る */
function commanderStats(type, cost, buildName) {
  const t = TYPES[type];
  const b = COMMANDER_BUILDS[buildName];
  const f = cost / BASE_COST;
  const buy = { spd: 0, act: 0, rng: 0, ...b.buy };
  for (const k of Object.keys(UPGRADE_CAP)) buy[k] = Math.min(buy[k], UPGRADE_CAP[k]);
  const rng = Math.min(t.rng + buy.rng, maxRng(type));
  const fixedCost = (t.stats.spd + t.stats.act + rngCost(t.rng) + traitCost(t)) * f;
  const upgradeCost = (buy.spd + buy.act + rngCost(rng) - rngCost(t.rng)) * UPGRADE_MULT * f;
  const skills = (b.skills || []).slice(0, SKILL_SLOTS['総大将']);
  const skillCost = skills.slice(1).reduce((s, k) => s + SKILLS[k].cost, 0);   // 1つ目は無料
  const free = cost - fixedCost - upgradeCost - skillCost;
  const share = clampShares({ hp: b.hp, atk: b.atk, def: b.def });
  const atk = Math.round(free * share.atk);
  const def = Math.round(free * share.def);
  const stats = { hp: free - atk - def, atk, def, spd: t.stats.spd + buy.spd, act: t.stats.act + buy.act };
  return { stats, rng, fixedCost, upgradeCost, skillCost, free, skills };
}

// 起動時にプリセットの合計がコストと一致しているか確認する
for (const [name, t] of Object.entries(TYPES)) {
  const sum = STAT_KEYS.reduce((s, k) => s + t.stats[k], 0) + rngCost(t.rng) + traitCost(t);
  if (sum !== BASE_COST) console.warn(`${name} のステータス合計が ${sum}（${BASE_COST} であるべき）`);
}

const HIT_SPREAD = 5;   // 命中率の個体差 ±5%
// 兵として編成される兵種（総大将専用の「将」は除く）
const TYPE_NAMES = Object.keys(TYPES).filter(k => !TYPES[k].commanderOnly);
const COMMANDER_TYPE = '将';

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
  constructor(side, rank, type, name, x, y, build = 'バランス型') {
    const r = RANKS[rank];
    const t = TYPES[type];
    const isCommander = rank === '総大将';
    // 総大将は固定枠 + 自由振り分け、それ以外は雑兵プリセットの拡大
    const cs = isCommander ? commanderStats(type, r.cost, build) : null;
    const st = cs ? cs.stats : scaleStats(type, r.cost);
    // テンポ系（移動・攻撃頻度）は階級で伸びすぎないよう、雑兵基準に割り戻して使う
    // （総大将の SPD / ACT は最初から雑兵基準の固定値なので割り戻さない）
    const tempoDiv = cs ? 1 : r.cost / BASE_COST;
    this.id = ++unitSeq;
    this.side = side;           // 'player' | 'cpu'
    this.name = name;
    this.rank = rank;
    this.type = type;
    this.cost = r.cost;
    this.build = cs ? build : null;
    this.stats = st;                       // コスト制のステータス値（合計 = cost）
    this.maxHp = st.hp * HP_SCALE;
    this.hp = this.maxHp;
    this.atk = st.atk;
    this.def = st.def;
    this.spd = st.spd + (d(3) - 1) * 10;   // 行動順。個体差 +0〜20
    this.rng = cs ? cs.rng : t.rng;
    this.act = st.act;
    this.move = Math.max(1, Math.ceil(st.spd / tempoDiv / MOVE_DIV));
    this.actRate = st.act / tempoDiv;      // 1行動ごとに行動ゲージにたまる量
    this.gauge = (d(5) - 1) * 10;          // 初期ゲージ 0〜40（全員が同じタイミングで動かないようずらす）
    this.hit = t.hit + d(HIT_SPREAD * 2 + 1) - HIT_SPREAD - 1;   // 個体差 ±HIT_SPREAD
    this.best = t.best;
    this.falloff = t.falloff;
    this.rear = !!t.rear;
    this.traits = t.traits || [];
    this.skills = cs ? cs.skills : [];
    this.cooldowns = {};                   // スキル名 → 残り行動回数
    this.buffs = [];                       // { stat: 'atk' | 'def', value: +割合, turns: 残り行動回数 }
    this.rooted = false;                   // この行動では移動しない（鉄壁の構え）
    this.rngBonus = 0;                     // この行動だけの射程ボーナス（遠隔狙撃）
    this.x = x;
    this.y = y;
  }

  get alive() { return this.hp > 0; }
  get isCommander() { return this.rank === '総大将'; }
  get posText() { return `(${this.x},${this.y})`; }
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
  // シャッフルしてから前の列優先で並べる
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  cells.sort((a, b) => Math.abs(b[1] - back) - Math.abs(a[1] - back));

  const units = [];
  units.push(new Unit(side, '総大将', COMMANDER_TYPE, `${label}総大将`, cx, back, AUTO_BUILD));
  const troops = [];
  for (let i = 1; i <= leaders; i++) {
    const type = pick(TYPE_NAMES);
    troops.push(new Unit(side, '部隊長', type, `${label}${type}長${i}`, 0, 0));
  }
  for (let i = 1; i <= soldiers; i++) {
    const type = pick(TYPE_NAMES);
    troops.push(new Unit(side, '雑兵', type, `${label}${type}${i}`, 0, 0));
  }
  // 前衛は前の列から、後衛（弓兵など）は後ろの列から埋める
  let front = 0, rear = cells.length - 1;
  for (const u of troops) {
    [u.x, u.y] = u.rear ? cells[rear--] : cells[front++];
    units.push(u);
  }
  return { dice: r, units, leaders, soldiers };
}

/** マップの広さとタイプをダイスで決める */
function formMap() {
  const wd = roll(MAP_DICE, 6), hd = roll(MAP_DICE, 6);
  return { type: pick(MAP_TYPES), w: MAP_MIN_W + wd.total, h: MAP_MIN_H + hd.total, wd, hd };
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

/** 総大将以外の配下のうち、生き残っている割合 */
function troopRatio(side) {
  const troops = state[side].units.filter(u => !u.isCommander);
  return troops.length ? troops.filter(u => u.alive).length / troops.length : 0;
}

/** その陣営の総大将が出撃する残存率（画面の設定。未設定なら全滅まで待機） */
function advanceRatio(side) {
  const el = typeof document !== 'undefined' && document.getElementById(`advance-${side}`);
  return ADVANCE_MODES[el && el.value]?.ratio ?? 0;
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

/** 総大将の士気範囲内にいるか（総大将自身は対象外） */
function inMorale(u) {
  if (u.isCommander) return false;
  const cmd = state[u.side].units.find(c => c.isCommander && c.alive);
  return !!cmd && distance(u, cmd) <= MORALE_RANGE;
}

/** バフと士気を合わせた能力の倍率 */
function statMult(u, stat) {
  const buff = u.buffs.filter(b => b.stat === stat).reduce((s, b) => s + b.value, 0);
  return 1 + buff + (inMorale(u) ? MORALE_BONUS : 0);
}

function effAtk(u) { return u.atk * statMult(u, 'atk'); }
function effDef(u) { return u.def * statMult(u, 'def'); }
function effRng(u) { return u.rng + u.rngBonus; }

function skillReady(u, name) {
  return u.skills.includes(name) && !(u.cooldowns[name] > 0);
}

function useSkill(u, name) {
  u.cooldowns[name] = SKILLS[name].cooldown;
  log(`✨ ${u.name} の「${name}」！`, u.side);
}

/** 自分の行動の始めに、スキルの待ち時間とバフの残りを1つ進める */
function tickUnit(u) {
  for (const k of Object.keys(u.cooldowns)) if (u.cooldowns[k] > 0) u.cooldowns[k]--;
  u.buffs = u.buffs.filter(b => --b.turns > 0);
  u.rooted = false;
  u.rngBonus = 0;
}

/** 攻撃対象に上下左右で隣接している、攻撃側の味方の数（攻撃者自身は除く） */
function surroundCount(attacker, defender) {
  return alliesOf(attacker).filter(a => Math.abs(a.x - defender.x) + Math.abs(a.y - defender.y) === 1).length;
}

/**
 * 攻撃判定:
 *   命中率 = HIT × 距離の命中倍率。1d100 が命中率以下なら命中
 *   基本値   = max(ATK × 0.25, ATK − DEF × 0.5 + 1d6×10)
 *   ダメージ = max(10, 基本値 × 距離の威力倍率 × 相性 × 突撃 × 包囲)  ※四捨五入
 *   包囲     = 1 + 0.1 × 攻撃対象に隣接する味方の数
 *   1d6 の出目6はクリティカルで ATK × 1.5 として計算
 */
function calcAttack(attacker, defender, bonus = 1, atkMult = 1) {
  // 射程を伸ばした総大将など、表にない距離はいちばん遠い距離の値を使う
  const dist = distance(attacker, defender);
  const f = attacker.falloff[dist] ?? attacker.falloff[Math.max(...Object.keys(attacker.falloff).map(Number))];
  const hitRate = Math.round(attacker.hit * f.hit);
  const hitRoll = d(100);
  if (hitRoll > hitRate) return { hit: false, hitRate, hitRoll };
  const die = d(6);
  const crit = die === 6;
  const baseAtk = effAtk(attacker) * atkMult;
  const atk = crit ? Math.floor(baseAtk * 1.5) : baseAtk;
  const surround = surroundCount(attacker, defender);
  const mult = f.pow * (MATCHUP[attacker.type]?.[defender.type] ?? 1) * bonus * (1 + SURROUND_BONUS * surround);
  const base = Math.max(atk * MIN_DAMAGE_RATE, atk - effDef(defender) * 0.5 + die * DAMAGE_DIE_SCALE);
  const dmg = Math.max(MIN_DAMAGE, Math.round(base * mult));
  return { hit: true, hitRate, hitRoll, dmg, die, crit, surround };
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

/** 地点 (x,y) が、unit から見て敵の足止め（ZOC）範囲（上下左右に隣接）か */
function inEnemyZoc(unit, x, y) {
  return enemiesOf(unit).some(e => e.traits.includes('zoc') && Math.abs(e.x - x) + Math.abs(e.y - y) === 1);
}

/**
 * 最大 steps マス以内で到達できるマスのうち、score が最小のマスへ移動する。
 * 4方向に1マスずつ進む（幅優先探索）。味方のいるマスは通過できるが止まれない。
 * 敵のいるマスは通過も不可。敵の足止め（ZOC）範囲に入ったらそこで止まる。マップの外には出られない。
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
        if (!inEnemyZoc(unit, nx, ny)) next.push([nx, ny]);   // ZOC 内からは先へ進めない
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

/**
 * 突撃できる経路を探す。上下左右いずれかに一直線に CHARGE_MIN マス以上走り、
 * 走った先の隣（同じ直線上）に敵がいれば突撃になる。最も長く走れる経路を返す。
 * 味方のマスは通過できるが止まれない。敵の ZOC 範囲に入ったらそこで止まる。
 */
function findCharge(unit) {
  const { w, h } = state.map;
  let best = null;
  for (const [dx, dy] of DIRS) {
    for (let k = 1; k <= unit.move + 1; k++) {
      const x = unit.x + dx * k, y = unit.y + dy * k;
      if (x < 0 || y < 0 || x >= w || y >= h) break;
      const other = unitAt(x, y);
      if (other && other.side !== unit.side) {
        const run = k - 1;   // 敵の手前まで走ったマス数
        const sx = x - dx, sy = y - dy;
        const stopFree = run === 0 || !unitAt(sx, sy);
        if (run >= CHARGE_MIN && stopFree && (!best || run > best.run)) {
          best = { run, x: sx, y: sy, target: other };
        }
        break;
      }
      if (k > unit.move) break;
      if (inEnemyZoc(unit, x, y)) {
        if (other) break;   // ZOC 内の味方マスには止まれず、先にも進めない
        // ZOC で止まる。止まったマスの隣（直線上）に敵がいれば突撃は成立する
        const nx = x + dx, ny = y + dy, ahead = unitAt(nx, ny);
        if (k >= CHARGE_MIN && ahead && ahead.side !== unit.side && (!best || k > best.run)) {
          best = { run: k, x, y, target: ahead };
        }
        break;
      }
    }
  }
  return best;
}

/** 1ユニット分の行動（AI） */
function actUnit(unit) {
  tickUnit(unit);
  let target = nearestEnemy(unit);
  if (!target) return;

  // 一斉指揮: 周囲に味方がいて、敵が近づいてきたら使う
  if (skillReady(unit, '一斉指揮')) {
    const near = alliesOf(unit).filter(a => distance(a, unit) <= COMMAND_RANGE);
    if (near.length >= 1 && distance(unit, target) <= 6) {
      useSkill(unit, '一斉指揮');
      for (const a of [unit, ...near]) a.buffs.push({ stat: 'atk', value: 0.3, turns: 3 }, { stat: 'def', value: 0.15, turns: 3 });
    }
  }

  // 最適距離より遠い → 前進（射程外なら必ず、射程内でも最適距離まで詰める）
  // 総大将は配下が残っている間は本陣から動かない（射程内に敵がいれば攻撃はする）
  const holding = unit.isCommander && alliesOf(unit).length > 0 && troopRatio(unit.side) >= advanceRatio(unit.side);
  // 遠隔狙撃: あと1マス届かない敵がいれば、その場から撃つ
  if (skillReady(unit, '遠隔狙撃') && distance(unit, target) === unit.rng + 1 && (holding || unit.rng > 1)) {
    useSkill(unit, '遠隔狙撃');
    unit.rngBonus = 1;
  }
  if (holding && distance(unit, target) > effRng(unit)) {
    log(`${unit.name} は本陣で戦況を見守っている。`, unit.side);
    return;
  }
  // 鉄壁の構え: 敵2体以上に迫られているか、弱っていて敵が近いときに守りを固める
  if (skillReady(unit, '鉄壁の構え')) {
    const close = enemiesOf(unit).filter(e => distance(e, unit) <= 2).length;
    if (close >= 2 || (unit.hp < unit.maxHp * 0.5 && distance(unit, target) <= 3)) {
      useSkill(unit, '鉄壁の構え');
      unit.buffs.push({ stat: 'def', value: 1.0, turns: 1 });
      unit.rooted = true;
    }
  }
  // 突撃（騎兵など）: 一直線に走り込める敵がいれば優先する
  let charge = null;
  if (!holding && !unit.rooted && unit.traits.includes('charge')) {
    charge = findCharge(unit);
    if (charge) {
      const before = unit.posText;
      [unit.x, unit.y] = [charge.x, charge.y];
      log(`🐎 ${unit.name} の突撃！ ${before} → ${unit.posText}（${charge.run}マス直進）`, unit.side);
      target = charge.target;
    }
  }
  if (!charge && !holding && !unit.rooted && distance(unit, target) > unit.best) {
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
    // 前進後に射程内に入っていなければ行動終了（あと1マスなら遠隔狙撃）
    target = nearestEnemy(unit);
    if (target && skillReady(unit, '遠隔狙撃') && distance(unit, target) === unit.rng + 1) {
      useSkill(unit, '遠隔狙撃');
      unit.rngBonus = 1;
    }
    if (!target || distance(unit, target) > effRng(unit)) return;
  }

  // 射程で勝っていて敵が最適距離より近い → 最適距離に向けて後退（引き撃ち、移動力の半分まで）
  if (!unit.rooted && unit.rng > target.rng && distance(unit, target) < unit.best) {
    const before = unit.posText;
    if (moveUnit(unit, unit.retreat, p =>
          withinFrontLine(unit, p) ? Math.abs(nearestEnemyDist(unit, p) - unit.best) : Infinity)) {
      log(`${unit.name} は間合いを取った。${before} → ${unit.posText}`, unit.side);
    }
    target = nearestEnemy(unit);
  }

  // 射程内 → 行動ゲージが ACT_PER_ATTACK たまっている分だけ攻撃
  unit.gauge = Math.min(ACT_GAUGE_MAX, unit.gauge + unit.actRate);
  let first = true;
  let attacked = 0;
  while (unit.gauge >= ACT_PER_ATTACK) {
    // 突撃した相手が生きていれば、まずその相手を攻撃する
    target = charge && charge.target.alive ? charge.target : nearestEnemy(unit);
    if (!target || distance(unit, target) > effRng(unit)) break;
    unit.gauge -= ACT_PER_ATTACK;
    attacked++;
    const dist = distance(unit, target);
    // 突撃ボーナスは初撃のみ
    const bonus = charge && first ? 1 + CHARGE_BONUS * charge.run : 1;
    // 強撃: 攻撃できるときに初撃へ乗せる
    let atkMult = 1;
    if (first && skillReady(unit, '強撃')) {
      useSkill(unit, '強撃');
      atkMult = SMASH_MULT;
    }
    first = false;
    const r = calcAttack(unit, target, bonus, atkMult);
    if (!r.hit) {
      log(`${unit.name} の攻撃！ [距離${dist} 命中${r.hitRate}% 🎲${r.hitRoll}] ${target.name} にかわされた！`, unit.side);
      continue;
    }
    target.hp = Math.max(0, target.hp - r.dmg);
    log(`${unit.name} の攻撃！ [距離${dist} 命中${r.hitRate}% 🎲${r.hitRoll}] 命中！ [🎲${r.die}]${r.crit ? ' 会心の一撃！' : ''}${bonus > 1 ? ` 突撃×${bonus.toFixed(2)}` : ''}${r.surround ? ` 包囲×${(1 + SURROUND_BONUS * r.surround).toFixed(1)}` : ''} ${target.name} に ${r.dmg} のダメージ！ (残HP ${target.hp}/${target.maxHp})`, unit.side);
    if (!target.alive) {
      log(`☠ ${target.name} は倒れた！`, 'death');
      if (checkVictory()) return;
    }
  }

  // 一撃離脱: 攻撃した後、敵からできるだけ離れる
  if (attacked > 0 && !unit.rooted && skillReady(unit, '一撃離脱') && enemiesOf(unit).length) {
    const before = unit.posText;
    if (moveUnit(unit, unit.move, p => -nearestEnemyDist(unit, p))) {
      useSkill(unit, '一撃離脱');
      log(`${unit.name} は離脱した。${before} → ${unit.posText}`, unit.side);
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
      <td>${u.name}</td><td>${u.rank}${u.build ? `<small class="sub">(${u.build}${u.skills.length ? '・' + u.skills.join('/') : ''})</small>` : ''}</td><td>${u.type}</td>
      <td><span class="hpbar"><div style="width:${ratio * 100}%;background:${color}"></div></span>${u.hp}/${u.maxHp}</td>
      <td>${u.atk}</td><td>${u.def}</td><td>${u.spd}</td><td>${u.rng}</td><td>${u.act}<small class="sub">(${(u.actRate / ACT_PER_ATTACK).toFixed(1)}回)</small></td><td>${u.hit}%</td><td>${u.posText}</td>`;
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
  const legend = '★将=総大将 ◆部隊長 / 剣 槍 弓 盾 騎 = 兵種 / 青=プレイヤー 赤=CPU';
  $('turn-label').textContent =
    `${type} ${w}×${h}（幅 ${MAP_MIN_W}+🎲[${wd.dice.join('][')}] / 高さ ${MAP_MIN_H}+🎲[${hd.dice.join('][')}]）` +
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
  log(`🎲 マップ: ${state.map.type} 幅 ${MAP_MIN_W}+[${state.map.wd.dice.join(', ')}] = ${state.map.w} / 高さ ${MAP_MIN_H}+[${state.map.hd.dice.join(', ')}] = ${state.map.h}`);
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
