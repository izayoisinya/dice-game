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
//   雑兵のプリセット（合計500）を基準に、上の階級はコスト比で拡大する（兵長 ×2、総大将 ×4）。
//   射程の値は階級で変わらないが、払うコストも同じ比率で上がるので兵種間の比率は保たれる。
// ------------------------------------------------------------

// 階級の序列（大きいほど上）。戦局の決着は「お互いの最も階級が上の者」を倒したとき
const RANK_ORDER = { '雑兵': 0, '兵長': 1, '副将': 2, '総大将': 3 };

// 階級: コスト = ステータス合計の予算
const RANKS = {
  '雑兵':   { cost: 500 },
  '兵長': { cost: 1000 },
  '副将': { cost: 1500 },
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
// 駒の人数（雑兵の駒だけ。将は人数で数えない個人の駒）
//   今の雑兵のステータスは BASE_TROOPS 人の駒の強さ。HP は人数に比例し、攻撃を受けると人数が減る。
//   1回の威力と手数（行動ゲージのたまり方）はそれぞれ √(人数比) 倍 → 総火力は人数に比例。
//   人数が多いほど心強く DEF が上がる（倍になるごとに +SIZE_DEF_BONUS、上下限あり）。
const BASE_TROOPS = 50;
const MIN_TROOPS = 10;
const SIZE_DEF_BONUS = 0.05;
const SIZE_DEF_CAP = 0.1;
const SERGEANT_BUFF = 0.1;    // 兵長が隊長になっている兵士の駒（同じ兵種）は ATK / DEF +10%
const COUNTER_MULT = 1.0;     // 反撃の威力倍率（攻撃された側が、相手が自分の射程内なら1回だけ撃ち返す）
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
  '剣兵': { stats: { hp: 110, atk: 100, def: 90, spd: 100, act: 90 }, rng: 1, hit: 85, best: 1,
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
const UPGRADE_MULT = 1.0;
// 統率力（総大将・副将は振り分けで買う）: 基本値は無料、1上げるごとに LDR_COST ポイント。隊に入れられる兵士の駒の上限になる
const LDR_BASE = 3;
const LDR_COST = 40;
const LDR_MAX = 15;
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
  '一撃離脱':   { cost: 250, cooldown: 2, desc: '攻撃の前に使う。この行動の攻撃は反撃を受けず、攻撃の後に移動力いっぱい動ける（移動 → 攻撃 → 移動）' },
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
function commanderStats(type, cost, build, slots = SKILL_SLOTS['総大将']) {
  const t = TYPES[type];
  // 型の名前、または { hp, atk, def, buy, skills } の振り分け（手動プレイで使う）
  const b = typeof build === 'string' ? COMMANDER_BUILDS[build] : build;
  const f = cost / BASE_COST;
  const buy = { spd: 0, act: 0, rng: 0, ...b.buy };
  for (const k of Object.keys(UPGRADE_CAP)) buy[k] = Math.min(buy[k], UPGRADE_CAP[k]);
  const rng = Math.min(t.rng + buy.rng, maxRng(type));
  const fixedCost = (t.stats.spd + t.stats.act + rngCost(t.rng) + traitCost(t)) * f;
  const upgradeCost = (buy.spd + buy.act + rngCost(rng) - rngCost(t.rng)) * UPGRADE_MULT * f;
  const skills = [...new Set(b.skills || [])].slice(0, slots);
  const skillCost = skills.slice(1).reduce((s, k) => s + SKILLS[k].cost, 0);   // 1つ目は無料
  const ldr = Math.max(LDR_BASE, Math.min(LDR_MAX, b.ldr ?? LDR_BASE));
  const ldrCost = (ldr - LDR_BASE) * LDR_COST;
  const free = cost - fixedCost - upgradeCost - skillCost - ldrCost;
  const share = clampShares({ hp: b.hp, atk: b.atk, def: b.def });
  const atk = Math.round(free * share.atk);
  const def = Math.round(free * share.def);
  const stats = { hp: free - atk - def, atk, def, spd: t.stats.spd + buy.spd, act: t.stats.act + buy.act };
  return { stats, rng, fixedCost, upgradeCost, skillCost, ldrCost, free, skills, ldr };
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
  constructor(side, rank, type, name, x, y, build = 'バランス型', troops = BASE_TROOPS) {
    const r = RANKS[rank];
    const t = TYPES[type];
    // 総大将・副将は固定枠 + 自由振り分け、それ以外は雑兵プリセットの拡大
    const isGeneral = rank === '総大将' || rank === '副将';
    const cs = isGeneral ? commanderStats(type, r.cost, build, SKILL_SLOTS[rank]) : null;
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
    this.build = cs ? (typeof build === 'string' ? build : 'カスタム') : null;
    this.ldr = cs ? cs.ldr : null;          // 統率力（総大将・副将。兵長は編成側で持つ）
    this.stats = st;                       // コスト制のステータス値（合計 = cost）
    // 雑兵の駒は人数を持つ（HP は人数に比例）。将は人数なし
    this.troops = rank === '雑兵' ? Math.max(MIN_TROOPS, troops) : null;
    this.maxHp = this.troops ? Math.round(st.hp * HP_SCALE * this.troops / BASE_TROOPS) : st.hp * HP_SCALE;
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
    this.counteredBy = [];                 // この行動中にすでに反撃してきた敵の id（反撃は1行動につき1体1回）
    this.hitAndRun = false;                // この行動では一撃離脱中（反撃を受けず、攻撃後に移動できる）
    this.x = x;
    this.y = y;
  }

  get alive() { return this.hp > 0; }
  /** 今の人数（HP の減り具合から計算。将は null） */
  get troopsNow() { return this.troops ? Math.ceil(this.hp / (this.maxHp / this.troops)) : null; }
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
 * 出目合計 N = 兵長 + 雑兵 の総数。兵長は N/6 人（最低1人）、残りが雑兵。
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
    troops.push(new Unit(side, '兵長', type, `${label}${type}長${i}`, 0, 0));
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
  mode: 'auto',      // 'auto' = 両軍オート / 'manual' = プレイヤー軍を手動で操作
  map: null,
  player: null,
  cpu: null,
  turn: 0,
  queue: [],         // このターンにまだ行動していないユニットの id（行動順）
  running: false,
  over: false,
  result: null,
  timer: null,
  logs: [],          // 保存用のログ（直近 LOG_KEEP 件）
  cmdReady: false,   // 手動プレイ: 総大将の振り分けを決定したか
  current: null,     // 手動プレイ: 入力待ちのユニット id
  phase: null,       // 手動プレイ: 'move' | 'attack' | 'retreat'
  manual: null,      // 手動プレイ: この行動の途中経過
  campaignBattle: null, // 軍の編成から出陣した戦闘なら { player: 隊id, cpu: 隊id, before: {...} }
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
  const troops = state[side].units.filter(u => !isLeader(u));
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

/** その戦局の大将の士気範囲内にいるか（大将自身は対象外） */
function inMorale(u) {
  if (isLeader(u)) return false;
  const cmd = leaderOf(state[u.side]);
  if (!cmd.alive) return false;
  return !!cmd && distance(u, cmd) <= MORALE_RANGE;
}

/** バフと士気を合わせた能力の倍率 */
function statMult(u, stat) {
  const buff = u.buffs.filter(b => b.stat === stat).reduce((s, b) => s + b.value, 0);
  return 1 + buff + (inMorale(u) ? MORALE_BONUS : 0) + (hasSergeant(u) ? SERGEANT_BUFF : 0);
}

/** 兵士の駒に、同じ兵種の兵長（隊長）が同じ戦場で健在か */
function hasSergeant(u) {
  return u.rank === '雑兵' && alliesOf(u).some(a => a.rank === '兵長' && a.type === u.type);
}

function effAtk(u) { return u.atk * statMult(u, 'atk'); }
function effDef(u) { return u.def * statMult(u, 'def') * (1 + sizeDefBonus(u)); }

/** 今の人数 ÷ 基準人数（将は 1） */
function sizeRatio(u) {
  return u.troops ? u.troopsNow / BASE_TROOPS : 1;
}

/** 人数が多いほど心強い: 倍になるごとに DEF +5%（半分になるごとに −5%）、±10% まで */
function sizeDefBonus(u) {
  if (!u.troops) return 0;
  const b = SIZE_DEF_BONUS * Math.log2(Math.max(sizeRatio(u), 1e-6));
  return Math.max(-SIZE_DEF_CAP, Math.min(SIZE_DEF_CAP, b));
}

/** 1回の行動でたまる行動ゲージ（人数が多いほど手数が増える） */
function actGain(u) {
  return u.actRate * Math.sqrt(sizeRatio(u));
}

/** 行動ゲージの上限（手数が多い駒はため込める量も多い） */
function gaugeCap(u) {
  return ACT_GAUGE_MAX * Math.max(1, Math.sqrt(sizeRatio(u)));
}
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
  u.counteredBy = [];
  u.hitAndRun = false;
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
  const mult = f.pow * (MATCHUP[attacker.type]?.[defender.type] ?? 1) * bonus * (1 + SURROUND_BONUS * surround)
    * Math.sqrt(sizeRatio(attacker));   // 人数が多い駒ほど1回の威力も大きい
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
  const front = alliesOf(unit).filter(a => !a.rear && !isLeader(a));
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
 * 最大 steps マス以内で止まれるマスの一覧（幅優先探索の順）。
 * 4方向に1マスずつ進む。味方のいるマスは通過できるが止まれない。
 * 敵のいるマスは通過も不可。敵の足止め（ZOC）範囲に入ったらそこで止まる。マップの外には出られない。
 */
function reachableCells(unit, steps) {
  const { w, h } = state.map;
  const seen = new Set([`${unit.x},${unit.y}`]);
  const cells = [];
  let frontier = [[unit.x, unit.y]];
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
        cells.push([nx, ny]);
      }
    }
    frontier = next;
  }
  return cells;
}

/**
 * 最大 steps マス以内で到達できるマスのうち、score が最小のマスへ移動する。
 * 4方向に1マスずつ進む（幅優先探索）。味方のいるマスは通過できるが止まれない。
 * 敵のいるマスは通過も不可。敵の足止め（ZOC）範囲に入ったらそこで止まる。マップの外には出られない。
 * 今の位置より良いマスがなければ動かない。動いたら true を返す。
 */
function moveUnit(unit, steps, score) {
  let best = [unit.x, unit.y];
  let bestScore = score({ x: unit.x, y: unit.y });
  for (const [x, y] of reachableCells(unit, steps)) {
    const sc = score({ x, y });
    if (sc < bestScore) { bestScore = sc; best = [x, y]; }
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

/**
 * 1回の攻撃を行い、ログを出す。決着したら true を返す。
 * bonus = 突撃などの威力倍率、atkMult = 強撃などの ATK 倍率
 */
function performAttack(unit, target, bonus = 1, atkMult = 1) {
  const dist = distance(unit, target);
  const r = calcAttack(unit, target, bonus, atkMult);
  if (!r.hit) {
    log(`${unit.name} の攻撃！ [距離${dist} 命中${r.hitRate}% 🎲${r.hitRoll}] ${target.name} にかわされた！`, unit.side);
    return false;
  }
  target.hp = Math.max(0, target.hp - r.dmg);
  log(`${unit.name} の攻撃！ [距離${dist} 命中${r.hitRate}% 🎲${r.hitRoll}] 命中！ [🎲${r.die}]${r.crit ? ' 会心の一撃！' : ''}${bonus > 1 ? ` 突撃×${bonus.toFixed(2)}` : ''}${atkMult > 1 ? ` 強撃×${atkMult}` : ''}${r.surround ? ` 包囲×${(1 + SURROUND_BONUS * r.surround).toFixed(1)}` : ''} ${target.name} に ${r.dmg} のダメージ！ (残HP ${target.hp}/${target.maxHp})`, unit.side);
  if (!target.alive) {
    log(`☠ ${target.name} は倒れた！`, 'death');
    if (checkVictory()) return true;
    return false;
  }
  return counterAttack(target, unit);
}

/**
 * 反撃: 攻撃された側は、攻撃してきた相手が自分の射程内にいれば撃ち返す。
 * 相手の1回の行動につき1回まで。行動ゲージは消費しない。決着したら true を返す。
 * （射程4の弓兵が射程4未満の敵を撃った場合などは、届かないので反撃されない）
 */
function counterAttack(defender, attacker) {
  if (!defender.alive || !attacker.alive) return false;
  if (distance(defender, attacker) > defender.rng) return false;
  if (attacker.counteredBy.includes(defender.id)) return false;
  if (attacker.hitAndRun) return false;   // 一撃離脱中は反撃を受けない
  attacker.counteredBy.push(defender.id);
  const r = calcAttack(defender, attacker, COUNTER_MULT);
  if (!r.hit) {
    log(`↩ ${defender.name} の反撃！ [命中${r.hitRate}% 🎲${r.hitRoll}] ${attacker.name} にかわされた！`, defender.side);
    return false;
  }
  attacker.hp = Math.max(0, attacker.hp - r.dmg);
  log(`↩ ${defender.name} の反撃！ [命中${r.hitRate}% 🎲${r.hitRoll}] 命中！ [🎲${r.die}]${r.crit ? ' 会心の一撃！' : ''} ${attacker.name} に ${r.dmg} のダメージ！ (残HP ${attacker.hp}/${attacker.maxHp})`, defender.side);
  if (!attacker.alive) {
    log(`☠ ${attacker.name} は倒れた！`, 'death');
    return checkVictory();
  }
  return false;
}

/**
 * 前進先の評価関数を作る（小さいほど良い）。
 * 「空いていて、最も近い敵との距離がちょうど最適距離になるマス」を攻撃位置とみなし、
 * いちばん近い攻撃位置への距離で評価する。正面が味方で埋まっていても、側面や背後の
 * 空いた攻撃位置へ回り込むようになる（以前は最も近い敵との距離だけを見ていたため、
 * 味方の後ろに縦一列に並びやすかった）。
 * さらに、すでに味方が張り付いている敵を囲みに行く位置を少し優先し、
 * 同じ評価のマスは少しランダムに選ぶ（毎回同じ向きに寄って列がそろうのを防ぐ）。
 */
function advanceScorer(unit, target) {
  const enemies = enemiesOf(unit);
  const free = (x, y) => {
    if (x < 0 || y < 0 || x >= state.map.w || y >= state.map.h) return false;
    const o = unitAt(x, y);
    return !o || o === unit;
  };
  // 攻撃位置の候補: 各敵からちょうど best マスのリング上で、空いていて、他の敵にそれより近くないマス
  const ideal = [];
  const seen = new Set();
  const b = unit.best;
  for (const e of enemies) {
    for (let dx = -b; dx <= b; dx++) {
      const r = b - Math.abs(dx);
      for (const dy of r === 0 ? [0] : [-r, r]) {
        const x = e.x + dx, y = e.y + dy, key = `${x},${y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!free(x, y)) continue;
        const p = { x, y };
        if (enemies.some(o => distance(p, o) < b)) continue;
        // 囲み度: この位置から狙える敵に、すでに張り付いている味方の数
        const gang = Math.max(...enemies.filter(o => distance(p, o) === b)
          .map(o => alliesOf(unit).filter(a => distance(a, o) <= a.best).length));
        ideal.push({ x, y, gang });
      }
    }
  }
  return p => {
    if (!withinFrontLine(unit, p)) return Infinity;
    const jitter = Math.random() * 0.02;
    if (ideal.length === 0) {
      const m = nearestEnemyDist(unit, p);
      return Math.abs(m - b) * 10 + (m < b ? 5 : 0) + distance(p, target) * 0.01 + jitter;
    }
    let bestD = Infinity, gang = 0;
    for (const q of ideal) {
      const dq = distance(p, q);
      if (dq < bestD || (dq === bestD && q.gang > gang)) { bestD = dq; gang = q.gang; }
    }
    return bestD * 10 - (bestD === 0 ? Math.min(gang, 3) * 0.5 : 0) + distance(p, target) * 0.01 + jitter;
  };
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
  const holding = isLeader(unit) && alliesOf(unit).length > 0 && troopRatio(unit.side) >= advanceRatio(unit.side);
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
  let movedBefore = false;   // 攻撃の前に移動したか（移動は1行動に1回。攻撃の後に回すこともできる）
  if (!holding && !unit.rooted && unit.traits.includes('charge')) {
    charge = findCharge(unit);
    if (charge) {
      const before = unit.posText;
      [unit.x, unit.y] = [charge.x, charge.y];
      movedBefore = true;
      log(`🐎 ${unit.name} の突撃！ ${before} → ${unit.posText}（${charge.run}マス直進）`, unit.side);
      target = charge.target;
    }
  }
  if (!charge && !holding && !unit.rooted && distance(unit, target) > unit.best) {
    const before = unit.posText;
    // 「敵を最適距離で攻撃できる空きマス」（側面・背後を含む）に近づく。後衛は前衛より前に出ない
    const moved = moveUnit(unit, unit.move, advanceScorer(unit, target));
    if (moved) {
      movedBefore = true;
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
      movedBefore = true;
      log(`${unit.name} は間合いを取った。${before} → ${unit.posText}`, unit.side);
    }
    target = nearestEnemy(unit);
  }

  // 射程内 → 行動ゲージが ACT_PER_ATTACK たまっている分だけ攻撃
  unit.gauge = Math.min(gaugeCap(unit), unit.gauge + actGain(unit));
  // 一撃離脱: 攻撃できるなら攻撃の前に使う（反撃を受けず、攻撃後に離脱する）
  if (!unit.rooted && skillReady(unit, '一撃離脱') && unit.gauge >= ACT_PER_ATTACK &&
      target && distance(unit, target) <= effRng(unit)) {
    useSkill(unit, '一撃離脱');
    unit.hitAndRun = true;
  }
  let first = true;
  let attacked = 0;
  while (unit.gauge >= ACT_PER_ATTACK) {
    // 突撃した相手が生きていれば、まずその相手を攻撃する
    target = charge && charge.target.alive ? charge.target : nearestEnemy(unit);
    if (!target || distance(unit, target) > effRng(unit)) break;
    unit.gauge -= ACT_PER_ATTACK;
    attacked++;
    // 突撃ボーナスは初撃のみ
    const bonus = charge && first ? 1 + CHARGE_BONUS * charge.run : 1;
    // 強撃: 攻撃できるときに初撃へ乗せる
    let atkMult = 1;
    if (first && skillReady(unit, '強撃')) {
      useSkill(unit, '強撃');
      atkMult = SMASH_MULT;
    }
    first = false;
    if (performAttack(unit, target, bonus, atkMult)) return;
    if (!unit.alive) return;   // 反撃で倒れた
  }

  // 攻撃してから間合いを取る: まだ移動していない、射程で勝っている兵は、撃った後に下がる（移動力の半分まで）
  const near = nearestEnemy(unit);
  if (attacked > 0 && !movedBefore && !unit.hitAndRun && !unit.rooted && near && unit.rng > near.rng && distance(unit, near) <= near.rng + 1) {
    const before = unit.posText;
    if (moveUnit(unit, unit.retreat, p =>
          withinFrontLine(unit, p) ? Math.abs(nearestEnemyDist(unit, p) - unit.best) : Infinity)) {
      log(`${unit.name} は撃ってから間合いを取った。${before} → ${unit.posText}`, unit.side);
    }
    return;
  }

  // 一撃離脱（移動 → 攻撃 → 移動）: 攻撃の後に移動力いっぱい離れる
  if (unit.hitAndRun && attacked > 0 && enemiesOf(unit).length) {
    const before = unit.posText;
    if (moveUnit(unit, unit.move, p => -nearestEnemyDist(unit, p))) {
      log(`${unit.name} は離脱した。${before} → ${unit.posText}`, unit.side);
    }
  }
}

/** 勝利判定。決着したら true を返す */
/** その戦局でその陣営の最も階級が上のユニット（戦闘開始時点。決着・撤退の対象） */
function leaderOf(army) {
  return army.units.reduce((a, u) => (RANK_ORDER[u.rank] > RANK_ORDER[a.rank] ? u : a), army.units[0]);
}

/** その戦局の大将か（本陣待機・士気・最後列の布陣などの対象） */
function isLeader(u) {
  return u === leaderOf(state[u.side]);
}

/** 勝利判定: その戦局でお互いの最も階級が上の者を倒すか、全滅させたら決着。決着したら true */
function checkVictory() {
  const lost = army => !leaderOf(army).alive || army.units.every(u => !u.alive);
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
  state.result = msg;
  state.current = null;
  state.phase = null;
  clearTimeout(state.timer);
  log(`=== ${msg} (${state.turn}ターン) ===`, 'turn');
  if (state.campaignBattle) applyBattleResult(msg);
  showResult();
  updateButtons();
  render();
  saveGame();
}

// ============================================================
// バトル進行
//   ターン開始時に SPD 順の行動キューを作り、先頭から1体ずつ行動させる。
//   手動プレイでは、プレイヤー軍のユニットの番が来たら入力を待つ。
// ============================================================

function unitById(id) {
  return allUnits().find(u => u.id === id);
}

function delay() {
  return Number($('speed').value);
}

function schedule(ms) {
  clearTimeout(state.timer);
  state.timer = setTimeout(step, ms);
}

function step() {
  state.timer = null;
  if (state.over || !state.running) return;

  if (state.queue.length === 0) {
    if (state.turn >= MAX_TURNS) {
      endGame('時間切れ… 引き分け');
      return;
    }
    state.turn++;
    const q = buildQueue();
    state.queue = q.map(u => u.id);
    log(`--- ターン ${state.turn} --- 行動順: ${q.map(u => `${u.name}(${u.spd})`).join(' > ')}`, 'turn');
  }

  const unit = unitById(state.queue.shift());
  if (!unit || !unit.alive) {
    schedule(0);
    return;
  }
  if (state.mode === 'manual' && unit.side === 'player') {
    beginManual(unit);
    return;
  }
  actUnit(unit);
  render(unit);
  saveGame();
  if (!state.over) schedule(delay());
}

// ------------------------------------------------------------
// 手動プレイ: 1体分の行動
//   移動（任意）→ 攻撃（行動ゲージの分だけ）→ 行動終了。スキルはボタンで使う。
// ------------------------------------------------------------

function currentUnit() {
  return state.current == null ? null : unitById(state.current);
}

function beginManual(unit) {
  tickUnit(unit);
  state.current = unit.id;
  state.phase = 'move';
  state.manual = { attacked: 0, smash: false, gaugeAdded: false, charge: null, moved: false };
  log(`▶ ${unit.name} の番です（マスをクリックして移動、敵をクリックして攻撃）`, 'player');
  render(unit);
  saveGame();
}

/** 攻撃フェーズへ。行動ゲージはこの行動で1回だけたまる */
function enterAttack(unit) {
  if (!state.manual.gaugeAdded) {
    unit.gauge = Math.min(gaugeCap(unit), unit.gauge + actGain(unit));
    state.manual.gaugeAdded = true;
  }
  state.phase = 'attack';
}

/** 今のフェーズで止まれるマス */
function manualReach(unit) {
  if (state.phase === 'move' && !unit.rooted) return reachableCells(unit, unit.move);
  if (state.phase === 'retreat') return reachableCells(unit, unit.move);
  // 一撃離脱中は、攻撃した後に移動力いっぱい動ける
  if (state.phase === 'attack' && unit.hitAndRun && state.manual.attacked > 0) return reachableCells(unit, unit.move);
  // 移動せずに攻撃した後は、移動力の半分まで動いて間合いを取れる
  if (state.phase === 'attack' && !state.manual.moved && state.manual.attacked > 0 && !unit.rooted) {
    return reachableCells(unit, unit.retreat);
  }
  return [];
}

/** 今攻撃できる敵 */
function manualTargets(unit) {
  if (state.phase !== 'move' && state.phase !== 'attack') return [];
  const gauge = state.manual.gaugeAdded ? unit.gauge : Math.min(gaugeCap(unit), unit.gauge + actGain(unit));
  if (gauge < ACT_PER_ATTACK) return [];
  return enemiesOf(unit).filter(e => distance(unit, e) <= effRng(unit));
}

/**
 * 手動で移動したときの突撃判定。出発点から一直線に CHARGE_MIN マス以上走り、
 * その先の隣に敵がいれば突撃になる（途中に敵や敵の ZOC がないこと）。
 */
function manualCharge(unit, fromX, fromY) {
  if (!unit.traits.includes('charge')) return null;
  const dx = Math.sign(unit.x - fromX), dy = Math.sign(unit.y - fromY);
  if (dx !== 0 && dy !== 0) return null;
  const run = Math.abs(unit.x - fromX) + Math.abs(unit.y - fromY);
  if (run < CHARGE_MIN) return null;
  for (let k = 1; k < run; k++) {
    const x = fromX + dx * k, y = fromY + dy * k;
    const o = unitAt(x, y);
    if ((o && o.side !== unit.side) || inEnemyZoc(unit, x, y)) return null;
  }
  const ahead = unitAt(unit.x + dx, unit.y + dy);
  return ahead && ahead.side !== unit.side ? { run, target: ahead.id } : null;
}

function onCellClick(x, y) {
  const unit = currentUnit();
  if (!unit || state.over) return;
  const other = unitAt(x, y);

  // 敵をクリック → 攻撃
  if (other && other.side !== unit.side) {
    if (!manualTargets(unit).includes(other)) return;
    if (state.phase === 'move') enterAttack(unit);
    manualAttack(unit, other);
    return;
  }
  // 空きマスをクリック → 移動 / 離脱
  if (!manualReach(unit).some(([cx, cy]) => cx === x && cy === y)) return;
  const before = unit.posText, fromX = unit.x, fromY = unit.y;
  [unit.x, unit.y] = [x, y];
  if (state.phase === 'retreat') {
    log(`${unit.name} は離脱した。${before} → ${unit.posText}`, unit.side);
    endManual();
    return;
  }
  if (state.phase === 'attack') {
    log(unit.hitAndRun ? `${unit.name} は離脱した。${before} → ${unit.posText}`
                       : `${unit.name} は攻撃してから間合いを取った。${before} → ${unit.posText}`, unit.side);
    endManual();
    return;
  }
  state.manual.moved = true;
  const charge = manualCharge(unit, fromX, fromY);
  if (charge) {
    state.manual.charge = charge;
    log(`🐎 ${unit.name} の突撃！ ${before} → ${unit.posText}（${charge.run}マス直進）`, unit.side);
  } else {
    log(`${unit.name} は移動した。${before} → ${unit.posText}`, unit.side);
  }
  enterAttack(unit);
  render(unit);
  saveGame();
}

function manualAttack(unit, target) {
  unit.gauge -= ACT_PER_ATTACK;
  const m = state.manual;
  const bonus = m.charge && m.attacked === 0 && m.charge.target === target.id ? 1 + CHARGE_BONUS * m.charge.run : 1;
  const atkMult = m.smash ? SMASH_MULT : 1;
  m.smash = false;
  m.attacked++;
  if (performAttack(unit, target, bonus, atkMult)) return;
  if (!unit.alive) { endManual(); return; }   // 反撃で倒れた
  render(unit);
  saveGame();
}

/** スキルボタン */
function onSkill(name) {
  const unit = currentUnit();
  if (!unit || !skillReady(unit, name) || !canUseSkill(unit, name)) return;
  useSkill(unit, name);
  if (name === '鉄壁の構え') {
    unit.buffs.push({ stat: 'def', value: 1.0, turns: 1 });
    unit.rooted = true;
    enterAttack(unit);
  } else if (name === '一斉指揮') {
    const near = alliesOf(unit).filter(a => distance(a, unit) <= COMMAND_RANGE);
    for (const a of [unit, ...near]) a.buffs.push({ stat: 'atk', value: 0.3, turns: 3 }, { stat: 'def', value: 0.15, turns: 3 });
  } else if (name === '遠隔狙撃') {
    unit.rngBonus = 1;
  } else if (name === '強撃') {
    state.manual.smash = true;
  } else if (name === '一撃離脱') {
    unit.hitAndRun = true;
  }
  render(unit);
  saveGame();
}

/** そのスキルを今のフェーズで使えるか */
function canUseSkill(unit, name) {
  const p = state.phase;
  switch (name) {
    case '鉄壁の構え': return p === 'move';
    case '一斉指揮': return p === 'move' || p === 'attack';
    case '遠隔狙撃': return (p === 'move' || p === 'attack') && unit.rngBonus === 0;
    case '強撃': return (p === 'move' || p === 'attack') && !state.manual.smash;
    case '一撃離脱': return (p === 'move' || p === 'attack') && state.manual.attacked === 0 && !unit.rooted;
  }
  return false;
}

/**
 * 撤退: その戦局の大将（最も階級が上のユニット）だけが選べる。
 * 総大将の撤退は、その時点で自軍の敗北。（副将などの撤退は、戦略レイヤーができたら「その部隊が戦場から退く」扱いにする）
 */
function onWithdraw(unit) {
  const msg = unit.isCommander
    ? `${unit.name} を撤退させますか？\n総大将の撤退は、その時点で自軍の敗北になります。`
    : `${unit.name} を撤退させますか？\nこの戦局は敗北になります。`;
  if (typeof confirm === 'function' && !confirm(msg)) return;
  log(`🏳 ${unit.name} は撤退した。`, unit.side);
  endGame(unit.isCommander ? '🏳 総大将が撤退… プレイヤー軍の敗北' : '🏳 撤退… この戦局はプレイヤー軍の敗北');
}

function endManual() {
  const unit = currentUnit();
  state.current = null;
  state.phase = null;
  state.manual = null;
  render(unit);
  saveGame();
  if (!state.over) schedule(delay());
}

// ============================================================
// セーブ / ロード（ブラウザの localStorage に自動保存。タスクキルしても続きから）
// ============================================================

const SAVE_KEY = 'dice-senki-save-v1';
const LOG_KEEP = 400;

function saveGame() {
  if (!state.player) return;
  const data = {
    v: 1, unitSeq,
    mode: state.mode, map: state.map, player: state.player, cpu: state.cpu,
    turn: state.turn, queue: state.queue, running: state.running, over: state.over, result: state.result,
    logs: state.logs, cmdReady: state.cmdReady, current: state.current, phase: state.phase, manual: state.manual,
    campaignBattle: state.campaignBattle,
    advance: { player: $('advance-player').value, cpu: $('advance-cpu').value },
  };
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch (e) { /* 保存できない環境では何もしない */ }
}

function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* 同上 */ }
}

/** 保存があれば復元して true を返す */
function loadGame() {
  let data;
  try { data = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (e) { return false; }
  if (!data || data.v !== 1 || !data.player) return false;
  // 旧版の保存データでは「兵長」を「部隊長」と呼んでいたので読み替える
  const revive = army => ({ ...army, units: army.units.map(u =>
    Object.assign(Object.create(Unit.prototype), u, u.rank === '部隊長' ? { rank: '兵長' } : {})) });
  Object.assign(state, {
    mode: data.mode, map: data.map, player: revive(data.player), cpu: revive(data.cpu),
    turn: data.turn, queue: data.queue, running: data.running, over: data.over, result: data.result,
    logs: [], cmdReady: data.cmdReady, current: data.current, phase: data.phase, manual: data.manual, timer: null,
    campaignBattle: data.campaignBattle || null,
  });
  unitSeq = data.unitSeq;
  $('mode').value = state.mode;
  if (data.advance) { $('advance-player').value = data.advance.player; $('advance-cpu').value = data.advance.cpu; }
  $('log').innerHTML = '';
  for (const l of data.logs || []) log(l.text, l.cls);
  log('💾 保存されていた状態から再開しました。', 'sys');
  return true;
}

// ============================================================
// UI
// ============================================================

const $ = id => document.getElementById(id);

function log(text, cls = 'sys') {
  state.logs.push({ text, cls });
  if (state.logs.length > LOG_KEEP) state.logs.splice(0, state.logs.length - LOG_KEEP);
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  const box = $('log');
  box.appendChild(div);
  while (box.childElementCount > LOG_KEEP) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function showResult() {
  const el = $('result');
  if (state.over && state.result) {
    el.textContent = state.result;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
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
      <td>${u.name}${u.troops ? `<small class="sub">(${u.troopsNow}人)</small>` : ''}</td><td>${u.rank}${u.build ? `<small class="sub">(${u.build}${u.skills.length ? '・' + u.skills.join('/') : ''})</small>` : ''}</td><td>${u.type}</td>
      <td><span class="hpbar"><div style="width:${ratio * 100}%;background:${color}"></div></span>${u.hp}/${u.maxHp}</td>
      <td>${u.atk}</td><td>${u.def}</td><td>${u.spd}</td><td>${u.rng}</td><td>${u.act}<small class="sub">(${(u.actRate / ACT_PER_ATTACK).toFixed(1)}回)</small></td><td>${u.hit}%</td><td>${u.posText}</td>`;
    tbody.appendChild(tr);
  }
  const alive = army.units.filter(u => u.alive);
  const cost = army.units.reduce((s, u) => s + u.cost, 0);
  const count = r => army.units.filter(u => u.rank === r).length;
  const troops = army.units.filter(u => u.troops).reduce((s, u) => s + (u.alive ? u.troopsNow : 0), 0);
  $(`${side}-summary`).textContent =
    ['総大将', '副将', '兵長', '雑兵'].filter(r => count(r)).map(r => `${r === '雑兵' ? '兵士の駒' : r}${count(r)}`).join(' / ') +
    `　兵 ${troops}人　生存 ${alive.length}/${army.units.length}　総コスト ${cost}`;
  $(`${side}-dice`).textContent = army.squadName
    ? `【${army.squadName}】`
    : `3d6: [${army.dice.dice.join('][')}] = ${army.dice.total}`;
}

function renderField(acting) {
  const { w, h, type, wd, hd } = state.map;
  const field = $('field');
  field.innerHTML = '';
  field.style.gridTemplateColumns = `repeat(${w}, minmax(0, 1fr))`;
  const short = u => (u.isCommander ? '★' : u.rank === '副将' ? '☆' : u.rank === '兵長' ? '◆' : '') + u.type[0];
  const cur = currentUnit();
  const reach = new Set(cur ? manualReach(cur).map(([x, y]) => `${x},${y}`) : []);
  const targets = new Set(cur ? manualTargets(cur).map(u => u.id) : []);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = unitAt(x, y);
      const cell = document.createElement('div');
      cell.className = 'cell' + (u ? ` ${u.side === 'player' ? 'p' : 'c'}` : '') +
        (u && u === acting ? ' acting' : '') +
        (reach.has(`${x},${y}`) ? ' reach' : '') +
        (u && targets.has(u.id) ? ' target' : '');
      cell.dataset.x = x;
      cell.dataset.y = y;
      if (u) {
        cell.title = `${u.name} HP ${u.hp}/${u.maxHp}`;
        cell.innerHTML = `<span class="glyph">${short(u)}</span><span class="mini-hp" style="width:${u.hp / u.maxHp * 100}%"></span>`;
      }
      field.appendChild(cell);
    }
  }
  const legend = '★将=総大将 ☆将=副将 ◆兵長 / 剣 槍 弓 盾 騎 = 兵種 / 青=プレイヤー 赤=CPU';
  $('turn-label').textContent =
    `${type} ${w}×${h}（幅 ${MAP_MIN_W}+🎲[${wd.dice.join('][')}] / 高さ ${MAP_MIN_H}+🎲[${hd.dice.join('][')}]）` +
    (state.turn ? `　ターン ${state.turn}` : '') + `　${legend}`;
}

/** 手動プレイの操作パネル */
function renderActionPanel() {
  const panel = $('action-panel');
  const unit = currentUnit();
  if (!unit || state.over) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const gauge = state.manual.gaugeAdded ? unit.gauge : Math.min(gaugeCap(unit), unit.gauge + actGain(unit));
  const hint = {
    move: '青いマスをクリックで移動（移動しないで攻撃も可）。赤枠の敵をクリックで攻撃。',
    attack: state.manual && unit.hitAndRun && state.manual.attacked > 0
      ? '赤枠の敵をクリックで攻撃。青いマスをクリックで離脱して終了（移動力いっぱい）。'
      : state.manual && !state.manual.moved && state.manual.attacked > 0
      ? '赤枠の敵をクリックで攻撃。青いマスをクリックで間合いを取って終了（移動力の半分まで）。'
      : '赤枠の敵をクリックで攻撃。終わったら「行動終了」。',
    retreat: '一撃離脱: 青いマスをクリックで離脱先を選ぶ。',
  }[state.phase] || '';
  const skills = unit.skills.map(name => {
    const ready = skillReady(unit, name);
    const ok = ready && canUseSkill(unit, name);
    const wait = ready ? '' : `（あと${unit.cooldowns[name]}）`;
    return `<button class="skill" data-skill="${name}" ${ok ? '' : 'disabled'} title="${SKILLS[name].desc}">✨${name}${wait}</button>`;
  }).join('');
  panel.innerHTML = `
    <div class="ap-head"><b>${unit.name}</b>（${unit.rank}・${unit.type}）HP ${unit.hp}/${unit.maxHp}
      ／ 移動 ${unit.rooted ? '不可' : unit.move} ／ 射程 ${effRng(unit)} ／ 攻撃できる回数 ${Math.floor(gauge / ACT_PER_ATTACK)}
      ${state.manual.smash ? ' ／ 強撃 準備中' : ''}${unit.hitAndRun ? ' ／ 一撃離脱中（反撃なし・攻撃後に移動可）' : ''}${state.manual.charge ? ` ／ 突撃 ${state.manual.charge.run}マス` : ''}</div>
    <div class="ap-hint">${hint}</div>
    <div class="ap-buttons">
      ${state.phase === 'move' ? '<button id="ap-stay">移動しない</button>' : ''}
      ${skills}
      ${state.phase !== 'retreat' ? '<button id="ap-end">行動終了</button>' : '<button id="ap-noretreat">離脱しない</button>'}
      ${unit === leaderOf(state.player) ? '<button id="ap-withdraw" class="danger">撤退</button>' : ''}
    </div>`;
  const stay = $('ap-stay');
  if (stay) stay.onclick = () => { enterAttack(unit); render(unit); saveGame(); };
  const end = $('ap-end');
  if (end) end.onclick = endManual;
  const nr = $('ap-noretreat');
  if (nr) nr.onclick = endManual;
  const wd = $('ap-withdraw');
  if (wd) wd.onclick = () => onWithdraw(unit);
  for (const b of panel.querySelectorAll('button.skill')) b.onclick = () => onSkill(b.dataset.skill);
}

function render(acting = null) {
  if (!state.player) return;
  const cur = currentUnit();
  if (cur) acting = cur;
  renderArmy(state.player, 'player', acting);
  renderArmy(state.cpu, 'cpu', acting);
  renderField(acting);
  renderActionPanel();
}

function updateButtons() {
  $('btn-form').disabled = state.running;
  $('btn-start').disabled = !state.player || state.running || state.over || (state.mode === 'manual' && !state.cmdReady);
  $('mode').disabled = state.running;
}

// ------------------------------------------------------------
// 総大将の振り分け（手動プレイの編成）
// ------------------------------------------------------------

function editorBuild() {
  const v = id => Number($(id).value);
  const skills = [$('ed-skill1').value, $('ed-skill2').value].filter(Boolean);
  return {
    hp: v('ed-hp'), atk: v('ed-atk'), def: v('ed-def'),
    buy: { spd: v('ed-spd'), act: v('ed-act'), rng: $('ed-rng').checked ? 1 : 0 },
    skills,
  };
}

function renderEditor() {
  const ed = $('cmd-editor');
  const show = state.mode === 'manual' && state.player && !state.cmdReady && !state.running;
  ed.classList.toggle('hidden', !show);
  if (!show) return;
  if (!ed.dataset.built) {
    const skillOpts = Object.entries(SKILLS).map(([k, s]) => `<option value="${k}">${k}（${s.cost}）</option>`).join('');
    const upOpts = [0, 10, 20, 30, 40, 50].map(n => `<option value="${n}">+${n}</option>`).join('');
    ed.innerHTML = `
      <h2>総大将の振り分け</h2>
      <div class="ed-grid">
        <label>HP <input type="range" id="ed-hp" min="1" max="10" step="0.5" value="4"><span id="ed-hp-v"></span></label>
        <label>ATK <input type="range" id="ed-atk" min="1" max="10" step="0.5" value="3"><span id="ed-atk-v"></span></label>
        <label>DEF <input type="range" id="ed-def" min="1" max="10" step="0.5" value="3"><span id="ed-def-v"></span></label>
        <label>SPD 強化 <select id="ed-spd">${upOpts}</select></label>
        <label>ACT 強化 <select id="ed-act">${upOpts}</select></label>
        <label>射程 +1 <input type="checkbox" id="ed-rng"></label>
        <label>スキル1（無料） <select id="ed-skill1">${skillOpts}</select></label>
        <label>スキル2（有料） <select id="ed-skill2"><option value="">なし</option>${skillOpts}</select></label>
      </div>
      <div id="ed-preview" class="ed-preview"></div>
      <div class="ed-buttons">
        <select id="ed-preset"><option value="">型から読み込む…</option>${Object.keys(COMMANDER_BUILDS).map(k => `<option>${k}</option>`).join('')}</select>
        <button id="ed-ok">この振り分けで決定</button>
      </div>`;
    ed.dataset.built = '1';
    for (const el of ed.querySelectorAll('input, select')) el.addEventListener('input', renderEditorPreview);
    $('ed-preset').addEventListener('change', () => {
      const b = COMMANDER_BUILDS[$('ed-preset').value];
      if (!b) return;
      $('ed-hp').value = b.hp; $('ed-atk').value = b.atk; $('ed-def').value = b.def;
      $('ed-spd').value = b.buy?.spd || 0; $('ed-act').value = b.buy?.act || 0; $('ed-rng').checked = !!b.buy?.rng;
      $('ed-skill1').value = b.skills?.[0] || Object.keys(SKILLS)[0];
      $('ed-skill2').value = b.skills?.[1] || '';
      renderEditorPreview();
    });
    $('ed-ok').addEventListener('click', confirmEditor);
  }
  renderEditorPreview();
}

function renderEditorPreview() {
  const b = editorBuild();
  const cs = commanderStats(COMMANDER_TYPE, RANKS['総大将'].cost, b);
  const share = clampShares({ hp: b.hp, atk: b.atk, def: b.def });
  for (const k of ['hp', 'atk', 'def']) $(`ed-${k}-v`).textContent = ` ${Math.round(share[k] * 100)}%`;
  const tmp = new Unit('player', '総大将', COMMANDER_TYPE, '', 0, 0, b);
  unitSeq--;   // プレビュー用に採番した分を戻す
  const ok = cs.free > 0 && $('ed-skill1').value !== $('ed-skill2').value;
  $('ed-preview').innerHTML = `
    コスト ${RANKS['総大将'].cost} − 固定枠 ${cs.fixedCost} − 強化 ${cs.upgradeCost} − スキル ${cs.skillCost} = <b>自由枠 ${cs.free}</b>
    （HP / ATK / DEF はそれぞれ自由枠の ${ALLOC_MIN * 100}〜${ALLOC_MAX * 100}%）<br>
    → 実HP <b>${tmp.maxHp}</b> / ATK <b>${tmp.atk}</b> / DEF <b>${tmp.def}</b> / SPD ${tmp.spd} / 移動 ${tmp.move} / 射程 ${tmp.rng}
    / 攻撃 ${(tmp.actRate / ACT_PER_ATTACK).toFixed(1)}回 / スキル ${cs.skills.join('・') || 'なし'}
    ${ok ? '' : '<br><span class="warn">自由枠が足りないか、スキルが重複しています。</span>'}`;
  $('ed-ok').disabled = !ok;
}

function confirmEditor() {
  const b = editorBuild();
  const old = state.player.units.find(u => u.isCommander);
  const cmd = new Unit('player', '総大将', COMMANDER_TYPE, old.name, old.x, old.y, b);
  state.player.units[state.player.units.indexOf(old)] = cmd;
  state.cmdReady = true;
  log(`👑 ${cmd.name} の振り分けを決定: 実HP ${cmd.maxHp} / ATK ${cmd.atk} / DEF ${cmd.def} / 移動 ${cmd.move} / スキル ${cmd.skills.join('・')}`, 'player');
  renderEditor();
  render();
  updateButtons();
  saveGame();
}


// ============================================================
// 軍の編成（戦略レイヤーの第一歩）
//   ダイスで兵種ごとの総数・副将・兵長を決め、本隊と分隊（小隊）に将と兵士を割り振る。
//   編成した隊どうしを戦術戦闘で戦わせ、損害（兵の人数・倒れた将）を持ち帰る。
// ============================================================

const TROOP_DICE = { sides: 10, unit: 100 };            // 各兵種の総数 = 1d10 × 100（100〜1000人）
const GENERAL_DICE = { n: 2, sides: 4, plus: 2 };       // 副将の人数 2d4+2（4〜10人）
const SERGEANT_DICE = { n: 1, sides: 3, plus: 1 };      // 兵長の人数（兵種ごと）1d3+1（2〜4人）
const SERGEANT_LDR_DICE = { n: 1, sides: 5, plus: 1 };  // 兵長の統率力 1d5+1（2〜6）
const PIECE_DEFAULT = 100;                               // 兵士の駒を追加するときの初期人数
const AUTO_PIECE = 100;                                  // おまかせ編成の1駒の目安の人数
const CAMPAIGN_KEY = 'dice-senki-campaign-v1';

const campaign = { armies: null, editing: null };

function rollExpr(e) {
  const r = roll(e.n, e.sides);
  return { dice: r.dice, total: r.total + e.plus };
}

function defaultBuild(ldr) {
  const b = COMMANDER_BUILDS[AUTO_BUILD];
  return { hp: b.hp, atk: b.atk, def: b.def, buy: { ...(b.buy || {}) }, skills: [...b.skills], ldr };
}

/** ダイスで新しい軍を作る（本隊だけがある状態） */
function newArmy(side) {
  const label = side === 'player' ? 'P' : 'C';
  const totals = {}, troopDice = {}, sergeantDice = {};
  for (const t of TYPE_NAMES) {
    troopDice[t] = d(TROOP_DICE.sides);
    totals[t] = troopDice[t] * TROOP_DICE.unit;
  }
  const generalRoll = rollExpr(GENERAL_DICE);
  const generals = [{ id: `${side}-G0`, rank: '総大将', name: `${label}総大将`, build: defaultBuild(LDR_BASE + 4) }];
  for (let i = 1; i <= generalRoll.total; i++) {
    generals.push({ id: `${side}-G${i}`, rank: '副将', name: `${label}副将${i}`, build: defaultBuild(LDR_BASE + 2) });
  }
  const sergeants = [];
  for (const t of TYPE_NAMES) {
    sergeantDice[t] = rollExpr(SERGEANT_DICE);
    for (let i = 1; i <= sergeantDice[t].total; i++) {
      sergeants.push({ id: `${side}-S${t}${i}`, type: t, name: `${label}${t}長${i}`, ldr: rollExpr(SERGEANT_LDR_DICE).total });
    }
  }
  return {
    side, totals, troopDice, generalRoll, sergeantDice, generals, sergeants, seq: 1, defeated: false,
    squads: [{ id: `${side}-Q0`, name: '本隊', leader: `${side}-G0`, members: [], pieces: [] }],
  };
}

function memberById(army, id) {
  return army.generals.find(g => g.id === id) || army.sergeants.find(s => s.id === id);
}

/** 将の統率力（総大将・副将は振り分け、兵長はダイス） */
function memberLdr(m) {
  if (!m) return 0;
  return m.rank ? commanderStats(COMMANDER_TYPE, RANKS[m.rank].cost, m.build, SKILL_SLOTS[m.rank]).ldr : m.ldr;
}

/** その将が所属している隊 */
function squadOf(army, id) {
  return army.squads.find(q => q.leader === id || q.members.includes(id));
}

function assignedTroops(army, type) {
  return army.squads.reduce((s, q) => s + q.pieces.filter(p => p.type === type).reduce((a, p) => a + p.size, 0), 0);
}

function poolLeft(army, type) {
  return army.totals[type] - assignedTroops(army, type);
}

/** 隊に入れられる兵士の駒の上限 = 隊長の統率力 + 隊にいる兵長の統率力 */
function squadCap(army, q) {
  return memberLdr(memberById(army, q.leader)) + q.members.reduce((s, id) => s + memberLdr(memberById(army, id)), 0);
}

function squadKind(army, q) {
  if (q.name === '本隊') return '本隊';
  return memberById(army, q.leader)?.rank === '副将' ? '分隊' : '小隊';
}

function squadTroops(q) {
  return q.pieces.reduce((s, p) => s + p.size, 0);
}

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 兵の人数を、目安 target 人前後の駒に分ける（10人単位） */
function splitPieces(type, n, target) {
  const k = Math.max(1, Math.round(n / target));
  const base = Math.floor(n / k / 10) * 10;
  let rest = n - base * k;
  const pieces = [];
  for (let i = 0; i < k; i++) {
    const extra = Math.min(rest, Math.ceil(rest / (k - i) / 10) * 10);
    rest -= extra;
    pieces.push({ type, size: base + extra });
  }
  return pieces.filter(p => p.size >= MIN_TROOPS);
}

/**
 * おまかせ編成:
 *   - 副将の半分が分隊を率い、残りは本隊に残る
 *   - 分隊は得意な兵種を2〜4つ選ぶ（全兵種をそろえるとは限らない）。本隊は全兵種
 *   - 兵長は、各隊の兵種に1人ずつ（本隊から）。余った兵長は予備に残る
 *   - 兵士は本隊 2 : 分隊 1 の割合で配り、100人前後の駒にする（統率力に収まらなければ駒を大きくする）
 */
function autoForm(army) {
  const main = army.squads.find(q => q.name === '本隊');
  main.members = [];
  main.pieces = [];
  army.squads = [main];
  const subs = shuffled(army.generals.filter(g => g.rank === '副将'));
  const nSquads = Math.floor(subs.length / 2);
  for (const g of subs.slice(nSquads)) main.members.push(g.id);
  const focus = new Map([[main, TYPE_NAMES]]);
  for (const g of subs.slice(0, nSquads)) {
    const q = { id: `${army.side}-Q${army.seq++}`, name: `${g.name}隊`, leader: g.id, members: [], pieces: [] };
    army.squads.push(q);
    focus.set(q, shuffled(TYPE_NAMES).slice(0, 1 + d(3)));
  }
  const freeSergeants = [...army.sergeants];
  for (const q of army.squads) {
    for (const t of focus.get(q)) {
      const i = freeSergeants.findIndex(sg => sg.type === t);
      if (i >= 0) q.members.push(freeSergeants.splice(i, 1)[0].id);
    }
  }
  const share = new Map(army.squads.map(q => [q, {}]));
  for (const t of TYPE_NAMES) {
    const takers = army.squads.filter(q => focus.get(q).includes(t));
    const weight = q => (q === main ? 2 : 1);
    const W = takers.reduce((a, q) => a + weight(q), 0);
    let rest = army.totals[t];
    for (const q of takers.filter(q => q !== main)) {
      const n = Math.floor(army.totals[t] * weight(q) / W / 10) * 10;
      share.get(q)[t] = n;
      rest -= n;
    }
    share.get(main)[t] = rest;
  }
  for (const q of army.squads) {
    const cap = squadCap(army, q);
    for (let target = AUTO_PIECE; ; target += 50) {
      q.pieces = Object.entries(share.get(q)).flatMap(([t, n]) => splitPieces(t, n, target));
      if (q.pieces.length <= cap) break;
    }
  }
}

/** 将が倒れたときの処理（隊長が倒れた分隊は、配下の副将か兵長が継ぎ、誰もいなければ解散して兵は予備に戻る） */
function removeMember(army, id) {
  const q = squadOf(army, id);
  army.generals = army.generals.filter(g => g.id !== id);
  army.sergeants = army.sergeants.filter(s => s.id !== id);
  if (!q) return;
  if (q.leader === id) {
    if (q.name === '本隊') { army.defeated = true; return; }
    if (q.members.length) {
      // 配下の副将がいればその副将が、いなければ兵長が隊長を継ぐ
      const next = q.members.find(m => memberById(army, m)?.rank) || q.members[0];
      q.members = q.members.filter(m => m !== next);
      q.leader = next;
      q.name = `${memberById(army, q.leader).name}隊`;
    } else {
      army.squads = army.squads.filter(x => x !== q);
    }
  } else {
    q.members = q.members.filter(x => x !== id);
  }
}

// ------------------------------------------------------------
// 隊 → 戦術戦闘の駒
// ------------------------------------------------------------

function buildBattleArmy(side, army, q, map) {
  const back = side === 'player' ? map.h - 1 : 0;
  const dir = side === 'player' ? -1 : 1;
  const cx = Math.floor(map.w / 2);
  const cells = [];
  for (let r = 0; r < DEPLOY_ROWS; r++) {
    for (let x = 0; x < map.w; x++) {
      if (r === 0 && x === cx) continue;
      cells.push([x, back + dir * r]);
    }
  }
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  cells.sort((a, b) => Math.abs(b[1] - back) - Math.abs(a[1] - back));

  const units = [];
  const lead = memberById(army, q.leader);
  const leader = lead.rank
    ? new Unit(side, lead.rank, COMMANDER_TYPE, lead.name, cx, back, lead.build)
    : new Unit(side, '兵長', lead.type, lead.name, cx, back);
  leader.ref = { kind: 'member', id: lead.id };
  units.push(leader);
  const troops = [];
  for (const id of q.members) {
    const m = memberById(army, id);
    const u = m.rank
      ? new Unit(side, m.rank, COMMANDER_TYPE, m.name, 0, 0, m.build)
      : new Unit(side, '兵長', m.type, m.name, 0, 0);
    u.ref = { kind: 'member', id };
    troops.push(u);
  }
  const seq = {};
  q.pieces.forEach((p, i) => {
    seq[p.type] = (seq[p.type] || 0) + 1;
    const u = new Unit(side, '雑兵', p.type, `${side === 'player' ? 'P' : 'C'}${p.type}${seq[p.type]}`, 0, 0, AUTO_BUILD, p.size);
    u.ref = { kind: 'piece', index: i };
    troops.push(u);
  });
  // 前衛は前の列から、後衛は後ろの列から。入りきらない駒は出陣できない
  let front = 0, rear = cells.length - 1;
  const benched = [];
  for (const u of troops) {
    if (front > rear) { if (u.ref.kind === 'piece') benched.push(u.ref.index); continue; }
    [u.x, u.y] = u.rear ? cells[rear--] : cells[front++];
    units.push(u);
  }
  return { units, benched, leaders: 0, soldiers: 0, dice: { dice: [], total: 0 }, squadName: `${q.name}（隊長 ${lead.name}）` };
}

function startCampaignBattle(pid, cid) {
  const A = campaign.armies;
  const pq = A.player.squads.find(q => q.id === pid);
  const cq = A.cpu.squads.find(q => q.id === cid);
  if (!pq || !cq || state.running) return;
  reset();
  state.mode = $('mode').value;
  state.map = formMap();
  state.player = buildBattleArmy('player', A.player, pq, state.map);
  state.cpu = buildBattleArmy('cpu', A.cpu, cq, state.map);
  state.cmdReady = true;
  const before = side => {
    const o = {};
    for (const u of state[side].units) if (u.troops) o[u.type] = (o[u.type] || 0) + u.troops;
    return o;
  };
  state.campaignBattle = { player: pid, cpu: cid, before: { player: before('player'), cpu: before('cpu') } };
  log(`⚔ 出陣: ${pq.name} vs CPU ${cq.name}（マップ ${state.map.type} ${state.map.w}×${state.map.h}）`, 'turn');
  log('「戦闘開始」で開戦します。', 'sys');
  render();
  renderEditor();
  updateButtons();
  saveGame();
  $('field').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 戦闘の結果を軍に持ち帰る: 兵士の駒は残った人数、倒れた将は軍から外れる */
function applyBattleResult(msg) {
  const cb = state.campaignBattle;
  const A = campaign.armies;
  if (!cb || cb.applied || !A) return;
  for (const side of ['player', 'cpu']) {
    const army = A[side];
    const q = army.squads.find(x => x.id === cb[side]);
    if (!q) continue;
    const units = state[side].units;
    // 布陣しきれず出陣しなかった駒はそのまま残る
    q.pieces = [
      ...(state[side].benched || []).map(i => q.pieces[i]),
      ...units.filter(u => u.ref?.kind === 'piece' && u.alive).map(u => ({ type: u.type, size: u.troopsNow })),
    ];
    const after = {};
    for (const u of units) if (u.ref?.kind === 'piece' && u.alive) after[u.type] = (after[u.type] || 0) + u.troopsNow;
    const losses = [];
    for (const [t, n] of Object.entries(cb.before[side])) {
      const lost = n - (after[t] || 0);
      army.totals[t] -= lost;
      if (lost) losses.push(`${t}${lost}人`);
    }
    const fallen = units.filter(u => u.ref?.kind === 'member' && !u.alive);
    for (const u of fallen) removeMember(army, u.ref.id);
    log(`📜 ${side === 'player' ? '自軍' : 'CPU軍'}の損害: ${losses.join('・') || 'なし'}${fallen.length ? ` / 討ち死に: ${fallen.map(u => u.name).join('・')}` : ''}`, side);
  }
  if (/総大将が撤退/.test(msg)) A.player.defeated = true;
  if (A.player.defeated) log('💀 総大将を失い、自軍は敗北した。', 'death');
  if (A.cpu.defeated) log('🏆 CPU軍の総大将を討ち取った！ 自軍の勝利！', 'turn');
  cb.applied = true;
  saveCampaign();
  renderCampaign();
}

// ------------------------------------------------------------
// 保存
// ------------------------------------------------------------

function saveCampaign() {
  try { localStorage.setItem(CAMPAIGN_KEY, JSON.stringify(campaign.armies)); } catch (e) { /* 保存できない環境では何もしない */ }
}

function loadCampaign() {
  try {
    const a = JSON.parse(localStorage.getItem(CAMPAIGN_KEY));
    if (!a || !a.player || !a.cpu) return;
    // 旧版では隊の配下を sergeants と呼んでいた
    for (const army of [a.player, a.cpu]) for (const q of army.squads) q.members = q.members || q.sergeants || [];
    campaign.armies = a;
  } catch (e) { /* 同上 */ }
}

// ------------------------------------------------------------
// 画面
// ------------------------------------------------------------

function renderCampaign() {
  const box = $('campaign');
  const A = campaign.armies;
  if (!A) {
    box.innerHTML = `<div class="cp-head"><button data-act="new">🎲 新しい軍を作る</button>
      <span class="sub">兵種ごとの総数・副将・兵長をダイスで決め、本隊と分隊に割り振って出陣します。</span></div>`;
    return;
  }
  const P = A.player;
  const over = P.defeated || A.cpu.defeated;
  const usedBy = id => squadOf(P, id)?.name || '予備';
  const pool = TYPE_NAMES.map(t => `<span class="chip">${t} 🎲${P.troopDice[t]} <b>${poolLeft(P, t)}</b>/${P.totals[t]}人</span>`).join('');
  const generals = P.generals.map(g => `<tr><td>${g.name}</td><td>${g.rank}</td><td>${memberLdr(g)}</td><td>${usedBy(g.id)}</td>
      <td><button class="small" data-act="edit" data-id="${g.id}">振り分け</button></td></tr>`).join('');
  const sergeants = P.sergeants.map(sg => `<tr><td>${sg.name}</td><td>${sg.type}</td><td>${sg.ldr}</td><td>${usedBy(sg.id)}</td></tr>`).join('');
  const freeMembers = (filter) => [...P.generals.filter(g => g.rank === '副将'), ...P.sergeants]
    .filter(m => !squadOf(P, m.id) && filter(m));
  const cpuSquads = A.cpu.squads.map(q => `<option value="${q.id}">${q.name}（${q.pieces.length}駒・${squadTroops(q)}人）</option>`).join('');
  const squads = P.squads.map(q => {
    const lead = memberById(P, q.leader);
    const cap = squadCap(P, q);
    // 副将は、総大将か副将が率いる隊にだけ入れる（兵長が率いる小隊には兵長だけ）
    const desc = m => `${m.name}（${m.rank || m.type + '長'}・統率${memberLdr(m)}）`;
    const sgOpts = freeMembers(m => !m.rank || lead?.rank).map(m => `<option value="${m.id}">${desc(m)}</option>`).join('');
    const pieces = q.pieces.map((p, i) => `<span class="chip">${p.type} ${p.size}人${P.sergeants.some(s => s.type === p.type && q.members.includes(s.id)) || (lead && !lead.rank && lead.type === p.type) ? '★' : ''}
        <button class="x" data-act="rmpiece" data-q="${q.id}" data-i="${i}">×</button></span>`).join('') || '<span class="sub">なし</span>';
    const sgs = q.members.map(id => `<span class="chip">${desc(memberById(P, id))}
        <button class="x" data-act="rmsg" data-q="${q.id}" data-id="${id}">×</button></span>`).join('') || '<span class="sub">なし</span>';
    return `<div class="squad">
      <div class="sq-head"><b>${q.name}</b>（${squadKind(P, q)}）隊長 ${lead ? lead.name : 'なし'} ／ 駒 ${q.pieces.length}/${cap} ／ 兵 ${squadTroops(q)}人
        ${q.name !== '本隊' ? `<button class="small" data-act="disband" data-q="${q.id}">解散</button>` : ''}</div>
      <div>配下の将: ${sgs} ${sgOpts ? `<select data-role="sg" data-q="${q.id}"><option value="">${lead?.rank ? '副将・兵長' : '兵長'}を追加…</option>${sgOpts}</select>` : ''}</div>
      <div>兵士の駒: ${pieces}</div>
      <div class="sq-add">
        <select data-role="ptype" data-q="${q.id}">${TYPE_NAMES.map(t => `<option>${t}</option>`).join('')}</select>
        <input type="number" data-role="psize" data-q="${q.id}" min="${MIN_TROOPS}" step="10" value="${PIECE_DEFAULT}">人
        <button class="small" data-act="addpiece" data-q="${q.id}" ${q.pieces.length >= cap ? 'disabled' : ''}>駒を追加</button>
        <span class="sub">（★=兵長が隊長、ATK/DEF+${SERGEANT_BUFF * 100}%）</span>
      </div>
      <div class="sq-go">相手: <select data-role="foe" data-q="${q.id}">${cpuSquads}</select>
        <button data-act="sortie" data-q="${q.id}" ${(q.pieces.length || q.members.length) && !over ? '' : 'disabled'}>出陣</button></div>
    </div>`;
  }).join('');
  const leaderOpts = freeMembers(() => true).map(m => `<option value="${m.id}">${m.name}（${m.rank || m.type + '長'}・統率${memberLdr(m)}）</option>`).join('');
  box.innerHTML = `
    <div class="cp-head">
      <button data-act="new">🎲 新しい軍を作る</button>
      <button data-act="auto">おまかせ編成</button>
      ${P.defeated ? '<b class="warn">自軍は敗北しました</b>' : ''}${A.cpu.defeated ? '<b>🏆 CPU軍に勝利しました</b>' : ''}
    </div>
    <div class="cp-pool">兵力（予備 / 総数）: ${pool}
      <span class="sub">副将 🎲[${P.generalRoll.dice.join('][')}]+${GENERAL_DICE.plus} = ${P.generalRoll.total}人 ／ 兵長 ${P.sergeants.length}人</span></div>
    <div class="cp-cols">
      <div><h3>将</h3><table><thead><tr><th>名前</th><th>階級</th><th>統率</th><th>所属</th><th></th></tr></thead><tbody>${generals}</tbody></table></div>
      <div><h3>兵長</h3><table><thead><tr><th>名前</th><th>兵種</th><th>統率</th><th>所属</th></tr></thead><tbody>${sergeants}</tbody></table></div>
    </div>
    <div id="gen-editor"></div>
    <h3>隊</h3>
    ${squads}
    <div class="sq-new">${leaderOpts ? `新しい隊（副将 → 分隊 / 兵長 → 小隊）: <select data-role="newleader"><option value="">隊長を選ぶ…</option>${leaderOpts}</select>` : '<span class="sub">隊長にできる将が残っていません</span>'}</div>
    <details class="cp-cpu"><summary>CPU軍の編成</summary>
      ${A.cpu.squads.map(q => `<div>${q.name}（${squadKind(A.cpu, q)}）: 配下の将${q.members.length} / ${q.pieces.map(p => `${p.type}${p.size}`).join('・')}</div>`).join('')}
    </details>`;
  if (campaign.editing) renderGeneralEditor();
}

function renderGeneralEditor() {
  const P = campaign.armies.player;
  const g = P.generals.find(x => x.id === campaign.editing);
  const box = $('gen-editor');
  if (!g || !box) return;
  const b = g.build;
  const slots = SKILL_SLOTS[g.rank];
  const skillOpts = sel => Object.entries(SKILLS).map(([k, sk]) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${k}（${sk.cost}）</option>`).join('');
  const upOpts = sel => [0, 10, 20, 30, 40, 50].map(n => `<option value="${n}" ${sel === n ? 'selected' : ''}>+${n}</option>`).join('');
  box.innerHTML = `<div class="panel">
    <h3>${g.name}（${g.rank}）の振り分け</h3>
    <div class="ed-grid">
      <label>HP <input type="range" data-g="hp" min="1" max="10" step="0.5" value="${b.hp}"></label>
      <label>ATK <input type="range" data-g="atk" min="1" max="10" step="0.5" value="${b.atk}"></label>
      <label>DEF <input type="range" data-g="def" min="1" max="10" step="0.5" value="${b.def}"></label>
      <label>統率力 <input type="range" data-g="ldr" min="${LDR_BASE}" max="${LDR_MAX}" step="1" value="${b.ldr}"><span data-g="ldrv">${b.ldr}</span></label>
      <label>SPD 強化 <select data-g="spd">${upOpts(b.buy?.spd || 0)}</select></label>
      <label>ACT 強化 <select data-g="act">${upOpts(b.buy?.act || 0)}</select></label>
      <label>スキル1 <select data-g="s1">${skillOpts(b.skills[0])}</select></label>
      ${slots > 1 ? `<label>スキル2 <select data-g="s2"><option value="">なし</option>${skillOpts(b.skills[1])}</select></label>` : ''}
    </div>
    <div class="ed-preview" data-g="preview"></div>
    <div class="ed-buttons"><button data-act="edok">決定</button><button data-act="edcancel">閉じる</button></div>
  </div>`;
  const read = () => {
    const v = k => box.querySelector(`[data-g="${k}"]`);
    return {
      hp: +v('hp').value, atk: +v('atk').value, def: +v('def').value, ldr: +v('ldr').value,
      buy: { spd: +v('spd').value, act: +v('act').value },
      skills: [v('s1').value, v('s2')?.value].filter(Boolean),
    };
  };
  const preview = () => {
    const nb = read();
    const cs = commanderStats(COMMANDER_TYPE, RANKS[g.rank].cost, nb, slots);
    const tmp = new Unit('player', g.rank, COMMANDER_TYPE, '', 0, 0, nb);
    unitSeq--;
    box.querySelector('[data-g="ldrv"]').textContent = nb.ldr;
    box.querySelector('[data-g="preview"]').innerHTML =
      `コスト ${RANKS[g.rank].cost} − 固定枠 ${cs.fixedCost} − 強化 ${cs.upgradeCost} − スキル ${cs.skillCost} − 統率 ${cs.ldrCost} = <b>自由枠 ${cs.free}</b><br>
       → 実HP <b>${tmp.maxHp}</b> / ATK <b>${tmp.atk}</b> / DEF <b>${tmp.def}</b> / 移動 ${tmp.move} / 統率 <b>${cs.ldr}</b>（兵士の駒 ${cs.ldr}つまで）/ スキル ${cs.skills.join('・')}
       ${cs.free > 0 ? '' : '<br><span class="warn">自由枠が足りません</span>'}`;
    box.querySelector('[data-act="edok"]').disabled = cs.free <= 0;
  };
  box.querySelectorAll('input, select').forEach(el => el.addEventListener('input', preview));
  box.querySelector('[data-act="edok"]').onclick = () => {
    g.build = read();
    campaign.editing = null;
    saveCampaign();
    renderCampaign();
  };
  box.querySelector('[data-act="edcancel"]').onclick = () => { campaign.editing = null; renderCampaign(); };
  preview();
}

function onCampaignClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el || el.closest('#gen-editor')) return;
  const A = campaign.armies;
  const P = A && A.player;
  const q = P && P.squads.find(x => x.id === el.dataset.q);
  switch (el.dataset.act) {
    case 'new':
      if (A && !confirm('今の軍を破棄して、新しい軍を作りますか？')) return;
      campaign.armies = { player: newArmy('player'), cpu: newArmy('cpu') };
      autoForm(campaign.armies.cpu);
      break;
    case 'auto': autoForm(P); break;
    case 'edit': campaign.editing = el.dataset.id; break;
    case 'disband': P.squads = P.squads.filter(x => x !== q); break;
    case 'rmpiece': q.pieces.splice(+el.dataset.i, 1); break;
    case 'rmsg': q.members = q.members.filter(id => id !== el.dataset.id); break;
    case 'addpiece': {
      const type = $('campaign').querySelector(`[data-role="ptype"][data-q="${q.id}"]`).value;
      const size = Math.floor(+$('campaign').querySelector(`[data-role="psize"][data-q="${q.id}"]`).value / 10) * 10;
      if (size < MIN_TROOPS) return alert(`1駒は${MIN_TROOPS}人以上です。`);
      if (size > poolLeft(P, type)) return alert(`${type}の予備は${poolLeft(P, type)}人しかいません。`);
      if (q.pieces.length >= squadCap(P, q)) return alert('統率力の上限です。兵長を加えるか、統率力を上げてください。');
      q.pieces.push({ type, size });
      break;
    }
    case 'sortie': {
      const foe = $('campaign').querySelector(`[data-role="foe"][data-q="${q.id}"]`).value;
      startCampaignBattle(q.id, foe);
      return;
    }
    default: return;
  }
  saveCampaign();
  renderCampaign();
}

function onCampaignChange(e) {
  const el = e.target;
  const P = campaign.armies && campaign.armies.player;
  if (!P || !el.dataset.role) return;
  if (el.dataset.role === 'sg' && el.value) {
    const q = P.squads.find(x => x.id === el.dataset.q);
    q.members.push(el.value);
  } else if (el.dataset.role === 'newleader' && el.value) {
    const m = memberById(P, el.value);
    P.squads.push({ id: `player-Q${P.seq++}`, name: `${m.name}隊`, leader: m.id, members: [], pieces: [] });
  } else {
    return;
  }
  saveCampaign();
  renderCampaign();
}

// ============================================================
// イベント
// ============================================================

$('campaign').addEventListener('click', onCampaignClick);
$('campaign').addEventListener('change', onCampaignChange);

$('btn-form').addEventListener('click', () => {
  reset();
  state.mode = $('mode').value;
  state.map = formMap();
  state.player = formArmy('player', state.map);
  state.cpu = formArmy('cpu', state.map);
  log(`🎲 マップ: ${state.map.type} 幅 ${MAP_MIN_W}+[${state.map.wd.dice.join(', ')}] = ${state.map.w} / 高さ ${MAP_MIN_H}+[${state.map.hd.dice.join(', ')}] = ${state.map.h}`);
  log(`🎲 プレイヤー軍 3d6 = [${state.player.dice.dice.join(', ')}] → 部隊数 ${state.player.dice.total}（兵長${state.player.leaders} / 雑兵${state.player.soldiers}）`, 'player');
  log(`🎲 CPU軍 3d6 = [${state.cpu.dice.dice.join(', ')}] → 部隊数 ${state.cpu.dice.total}（兵長${state.cpu.leaders} / 雑兵${state.cpu.soldiers}）`, 'cpu');
  log(state.mode === 'manual'
    ? '編成完了。総大将の振り分けを決めてから「戦闘開始」で開戦します。'
    : '編成完了。「戦闘開始」で開戦します。');
  render();
  renderEditor();
  updateButtons();
  saveGame();
});

$('btn-start').addEventListener('click', () => {
  if (!state.player || state.running || state.over) return;
  state.running = true;
  updateButtons();
  log('⚔ 開戦！', 'turn');
  saveGame();
  step();
});

$('btn-reset').addEventListener('click', () => {
  clearSave();
  reset();
});

$('field').addEventListener('click', e => {
  const cell = e.target.closest('.cell');
  if (cell) onCellClick(Number(cell.dataset.x), Number(cell.dataset.y));
});

for (const id of ['advance-player', 'advance-cpu']) $(id).addEventListener('change', saveGame);

function reset() {
  clearTimeout(state.timer);
  Object.assign(state, {
    map: null, player: null, cpu: null, turn: 0, queue: [], running: false, over: false, result: null, timer: null,
    logs: [], cmdReady: false, current: null, phase: null, manual: null, campaignBattle: null,
  });
  unitSeq = 0;
  $('log').innerHTML = '';
  showResult();
  for (const side of ['player', 'cpu']) {
    $(`${side}-units`).innerHTML = '';
    $(`${side}-summary`).textContent = '';
    $(`${side}-dice`).textContent = '';
  }
  $('field').innerHTML = '';
  $('turn-label').textContent = '';
  $('action-panel').classList.add('hidden');
  $('cmd-editor').classList.add('hidden');
  log('「編成」ボタンでダイスを振り、両軍を編成してください。');
  updateButtons();
}

// 起動時: 保存があれば続きから、なければ初期状態
loadCampaign();
renderCampaign();
if (loadGame()) {
  showResult();
  render();
  renderEditor();
  updateButtons();
  // 戦闘中なら自動で再開する（プレイヤーの入力待ちならそのまま待つ）
  if (state.running && !state.over && state.current == null) schedule(500);
} else {
  reset();
}
