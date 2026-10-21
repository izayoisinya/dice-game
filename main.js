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
// 射程以外の比例拡大するステータス。INT（知力）は魔法の威力・抵抗用（今は INT を持つ兵種はいない。表にない兵種は 0）
const STAT_KEYS = ['hp', 'atk', 'def', 'spd', 'act', 'int'];

/** 射程に払うコスト（RNG1=10, 2=40, 3=70, 4=100, 5=130） */
function rngCost(rng) {
  return (rng * 3 - 2) * 10;
}

// ステータス値 → ゲーム内の値への換算
const HP_SCALE = 3;           // 実HP = HP値 × 3
const MOVE_DIV = 40;          // 移動力 = 階級補正後SPD ÷ 40（切り上げ）+ MOVE_BONUS
const MOVE_BONUS = 1;         // テンポのため全員 +1（盾 3 / 槍・弓・将 3〜4 / 剣 4 / 騎 5）
const ACT_PER_ATTACK = 50;    // 行動ゲージがこの値たまるごとに1回攻撃できる
const ACT_GAUGE_MAX = 100;    // ゲージの上限（ため込みすぎ防止）
const DAMAGE_DIE_SCALE = 10;  // （旧方式の名残。今は使わない）
const DEF_K = 100;            // ダメージ = ATK × DEF_K ÷ (DEF_K + DEF) × …（比率型。DEF が高くても 0 にはならず、割合で減る）
const DMG_SCALE = 1.3;        // ダメージの全体の大きさ（兵士どうしで旧方式と同じくらいの値になるように）
const MIN_DAMAGE = 10;        // 最低ダメージ（固定値）
const MIN_DAMAGE_RATE = 0.15; // 最低でも ATK のこの割合は通る（DEF が高すぎて削れない状態を防ぐ）
// 駒の人数（雑兵の駒だけ。将は人数で数えない個人の駒）
//   今の雑兵のステータスは BASE_TROOPS 人の駒の強さ。HP は人数に比例し、攻撃を受けると人数が減る。
//   1回の威力と手数（行動ゲージのたまり方）はそれぞれ √(人数比) 倍 → 総火力は人数に比例。
//   人数が多いほど心強く DEF が上がる（倍になるごとに +SIZE_DEF_BONUS、上下限あり）。
const BASE_TROOPS = 50;
const MIN_TROOPS = 10;        // 駒が残る最低人数（戦闘で減ってもこれ以上なら残る）
const MIN_PIECE = 100;        // 新しく駒を作る（編成・再編成で足す）ときの最低人数
const SIZE_DEF_BONUS = 0.05;
const SIZE_DEF_CAP = 0.1;
const FORT_DEF = 0.2;          // 戦域図の砦の守り: 自軍の砦の上か隣で戦う隊は DEF +20%
const SERGEANT_SPD = 10;      // 兵長は兵士より SPD +10（隊を率いて一歩先に動く。回避も少し上がる）
const SERGEANT_SPARE = 1;    // 兵長の SPD/ACT 割り戻しの残りのうち HP/ATK に振る割合（全部振ると副将並みになるため半分）
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
  cover:  { name: '庇う',   cost: 0 },
  spear:  { name: '突き・薙ぎ払い', cost: 0 },   // 槍兵の範囲攻撃
  guard:  { name: '受け流し',   cost: 0 },   // 盾兵: 受けるダメージを減らす
  aim:    { name: '狙い撃ち', cost: 0 }, // 弓兵: 動かずに撃つと命中が上がる
  pursuit: { name: '追撃',  cost: 0 },   // 剣兵: 敵を倒すと行動ゲージがたまる   // 敵と味方の間（同じ縦・横の直線上）にいると、その攻撃を代わりに受ける
  charge: { name: '突撃',   cost: 20 },  // 一直線に走ってそのまま攻撃すると、走ったマス数に応じて威力が上がる
  scout:  { name: '索敵',   cost: 100 }, // 視界が広い。隠密の敵も2マスまで見つけられる
  stealth: { name: '隠密',  cost: 50 },  // 敵からは2マス（斥候は3マス）まで近づかないと見えない（攻撃すると次の自分の行動まで姿が見える）
  assassin: { name: '暗殺', cost: 0 },
  dual:   { name: '二刀流', cost: 0 },       // 二刀流剣士: 1回の攻撃で2回斬る
  dash:   { name: 'すれ違い斬り', cost: 0 }, // 二刀流剣士: 隣の敵の向こうへ駆け抜けながら斬る
  deflect: { name: '剣弾き', cost: 0 },      // 二刀流剣士: 攻撃を剣で弾く   // 将（兵長以上）への攻撃が強く、兵士の駒への攻撃は弱い
};
const ASSASSIN_VS_GENERAL = 1.6;   // 暗殺者 → 将（兵長・副将・総大将）の威力倍率
const ASSASSIN_VS_TROOPS = 0.5;    // 暗殺者 → 兵士の駒・斥候の威力倍率

// 視界（戦場の霧）: 味方の誰かの視界に入っている敵だけが見え、狙える（視界は軍全体で共有）
const VISION_DEFAULT = 4;
const SCOUT_KEEP = 5;              // 斥候（オート）が最も近い敵と保つ距離
// 槍兵の範囲攻撃（攻撃1回分を使う）
// 兵種の固有能力の強さ。[兵士の駒, 兵長] の順（兵長の方が少し強い）
const DEFLECT_CUT = [0.2, 0.3];                // 矢払い（剣兵）: 3マス以上離れたところからの攻撃のダメージを減らす（兵士の駒 / 兵長）
const VOLLEY_TAKEN = 0.3;                        // 長柄の弱み（槍兵）: 3マス以上離れたところからの攻撃（矢）のダメージ +30%
const DUAL_MULT = 0.6;                           // 二刀流: 1回の攻撃で2回斬る（それぞれ ATK ×0.6）
const DEFLECT_CHANCE = 35;                       // 剣弾き: 攻撃が当たったとき弾いてダメージ 0 にする確率（%）
const DEFLECT_CHARGE = 100;   // 突撃（一直線に走ってくる勢いのある一撃）は、素早さで見切って必ず弾く
const DEFLECT_BLADE = 45;     // 刀・剣の太刀筋は剣技で見切りやすい（刀の将・剣兵・二刀流からの攻撃）
const BLADE_TYPES = ['将', '剣兵', '二刀将'];
const BRACE_TARGETS = ['剣兵', '騎兵', '将', '騎将'];   // 迎え突きが効く相手（剣・騎兵と、刀・馬の将。盾兵は盾で受けるので効かない）
const BRACE_MULT = [0.3, 0.4];                  // 迎え突き（槍兵）: 隣に踏み込んできた敵への一撃の威力（兵士の駒 / 兵長）
const THRUST_MULT = [[0.8, 0.5], [0.9, 0.6]];   // 突き: 縦に並んだ敵2体（手前 / 奥）
const SWEEP_MULT = { 2: [0.55, 0.6], 3: [0.4, 0.5] };   // 薙ぎ払い: 周り3マスの弧の中の敵（2体ならそれぞれ55%、3体なら40%。兵長は 60% / 50%）
const CHARGE_BONUS_LV = [0.3, 0.4];             // 突撃: 直進1マスあたりの威力上昇（初撃のみ）
const PARRY_CHANCE = [35, 45];                   // 受け流し（盾兵）: 攻撃が当たったとき、盾で受け流す確率（%）
const PARRY_CUT = 0.6;                           // 受け流し: 受け流したときのダメージの軽減
const PARRY_EXPOSE = 5;                          // 受け流し: 盾で受ける分、避けはしない（狙われると当たりやすい +%）
const CHARGE_HIT = 10;                           // 突撃: 奇襲の一撃は当たりやすい（命中 +%、相手の回避を無視）
const AIM_HIT = [5, 10];                        // 狙い撃ち: 移動しなかった行動の命中 +%
const PURSUIT_GAUGE = [25, 50];                 // 追撃: 敵を倒したときに行動ゲージがたまる量（攻撃1回 = 50）
/** 固有能力の段階: 兵長なら 1、兵士の駒なら 0 */
function lv(u) { return u.rank === '兵長' ? 1 : 0; }
const pct = v => Math.round(v * 100);
const TRAIT_HELP = {
  zoc: '上下左右に隣接したマスに入った敵は、そこで移動が止まる',
  spear: `長柄の弱み: 3マス以上離れたところからの攻撃（矢）のダメージ +${pct(VOLLEY_TAKEN)}%。迎え突き: 隣のマスに踏み込んできた剣兵・騎兵（刀・馬の将も）に先に一撃（威力${pct(BRACE_MULT[0])}%／兵長 ${pct(BRACE_MULT[1])}%、反撃なし）。突き: 自分から見て一直線に並んだ敵2体（隣と、その奥）を同時に攻撃（手前${pct(THRUST_MULT[0][0])}%・奥${pct(THRUST_MULT[0][1])}%／兵長 ${pct(THRUST_MULT[1][0])}%・${pct(THRUST_MULT[1][1])}%）。薙ぎ払い: 周りの8マスのうち、ひと続きの3マス（例: 左・左斜め前・前）に敵が2体以上いれば、まとめて攻撃（2体ならそれぞれ${pct(SWEEP_MULT[2][0])}%・3体なら${pct(SWEEP_MULT[3][0])}%／兵長 ${pct(SWEEP_MULT[2][1])}%・${pct(SWEEP_MULT[3][1])}%）。どちらも攻撃1回分`,
  guard: `攻撃が当たったとき ${PARRY_CHANCE[0]}%（兵長 ${PARRY_CHANCE[1]}%）の確率で盾で受け流し、ダメージ −${pct(PARRY_CUT)}%。その分、避けはせず当たりやすい（命中 +${PARRY_EXPOSE}%）`,
  aim: `その行動で移動しなかったら命中 +${AIM_HIT[0]}%（兵長 +${AIM_HIT[1]}%）。動かずに構えて撃つほど当たる（反撃にも効く）`,
  pursuit: `矢払い: 3マス以上離れたところからの攻撃のダメージ −${pct(DEFLECT_CUT[0])}%（兵長 −${pct(DEFLECT_CUT[1])}%）。追撃: 敵を倒すと行動ゲージが ${PURSUIT_GAUGE[0]}（兵長 ${PURSUIT_GAUGE[1]}）たまり（攻撃1回分 = ${ACT_PER_ATTACK}）、移動力の半分だけ次の敵へ踏み込める。弱った敵を続けて仕留める`,
  cover: '敵と味方の間（同じ縦・横の直線上）にいると、その味方への攻撃を代わりに受ける',
  charge: `上下左右のどれか一方向へ曲がらずに2マス以上まっすぐ走り、その先にいる敵を攻撃すると、走ったマス数×${pct(CHARGE_BONUS_LV[0])}%（兵長 ×${pct(CHARGE_BONUS_LV[1])}%）だけ初撃の威力が上がる。奇襲の一撃なので相手の回避を無視し、命中 +${CHARGE_HIT}%（曲がると突撃にならない）。突撃になる移動先はオレンジ色で表示`,
  dual: `1回の攻撃で2回斬る（それぞれ ATK ×${pct(DUAL_MULT)}%、別々に命中判定）`,
  dash: '隣の敵の向こう側（2マス先）へ駆け抜けながら、その敵を斬る（攻撃1回分・1行動に1回）。囲みを抜けたり、後ろの敵に回り込んだりできる',
  deflect: `攻撃が当たったとき ${DEFLECT_CHANCE}% の確率で剣で弾いてダメージ 0（刀・剣の攻撃は太刀筋を読んで ${DEFLECT_BLADE}%、突撃は素早さで見切って必ず弾く）。相手が自分の間合いにいれば反撃もする`,
  scout: '視界が広い。隠密の敵も2マスまで見つけられる',
  stealth: '敵からは2マス以内（斥候からは3マス以内）まで近づかないと見えない（攻撃すると次の自分の行動まで見える）',
  assassin: '将（兵長以上）への攻撃 ×1.6、兵士の駒への攻撃 ×0.5',
};
const CHARGE_MIN = 2;         // 突撃になる最低直進マス数

// 兵種の相性（剣・槍・弓の三すくみ）。攻撃側 → 防御側 のダメージ倍率。書いていない組み合わせは ×1.0
//   槍 → 剣: リーチで制す / 剣 → 弓: 詰め寄って斬る / 弓 → 槍: 鈍重な槍兵を射る
// 兵種の相性倍率は使わない（三すくみは兵種の性能と固有能力で作る:
//   槍 → 剣: 迎え突き（踏み込んできた前衛に先に一撃）／ 剣 → 弓: 矢払い（遠くからの攻撃を軽減）・追撃 ／ 弓 → 槍: 長柄の弱み（矢に弱い））
// 将来、世界観ごとに特別な相性を足すときのために枠だけ残す
const MATCHUP = {};

// 兵種: 雑兵（コスト500）のステータスプリセット
//   HP / ATK / DEF / SPD / ACT + RNG（rngCost で換算）+ 固有能力のコスト = 500
// HIT = 基本命中率(%)
// falloff[距離] = { hit: 命中倍率, pow: 威力倍率 }。best = 最も性能を発揮する距離
// rear = 後衛（前衛より前に出ない）
const TYPES = {
  // 近距離特化、足と手数が速い
  '剣兵': { stats: { hp: 120, atk: 90, def: 90, spd: 100, act: 90 }, rng: 1, hit: 85, best: 1, traits: ['pursuit'],
            falloff: { 1: { hit: 1.0, pow: 1.0 } } },
  // 射程2の火力役（突き・薙ぎ払い）。攻撃速度はやや遅い
  '槍兵': { stats: { hp: 140, atk: 110, def: 70, spd: 80, act: 60 }, rng: 2, hit: 80, best: 2, traits: ['spear'],
            falloff: { 1: { hit: 0.9, pow: 0.9 }, 2: { hit: 0.85, pow: 1.0 } } },
  // 遠距離攻撃の代わりに脆い。
  // 平面（マンハッタン距離）向け: 斜め方向は距離が長く数えられ、前衛越しに撃つと距離3〜4になるため
  // 最適帯を2〜3に広げ、射程を5にしている
  '弓兵': { stats: { hp: 70, atk: 110, def: 40, spd: 80, act: 70 }, rng: 5, hit: 80, best: 3, rear: true, traits: ['aim'],
            falloff: { 1: { hit: 0.5, pow: 0.5 },    // 近すぎると狙いにくく、弓を引ききれず威力も落ちる（剣に詰め寄られると弱い）
                       2: { hit: 1.0, pow: 1.0 },    // 最大性能
                       3: { hit: 1.0, pow: 1.0 },    // 最大性能（前衛越しの基本距離）
                       4: { hit: 0.9, pow: 0.9 },    // 準最大
                       5: { hit: 0.7, pow: 0.7 } } },// 最低
  // 被ダメも与ダメも低い壁役。足止め（ZOC）で敵の進軍を止める
  '盾兵': { stats: { hp: 140, atk: 70, def: 140, spd: 50, act: 50 }, rng: 1, hit: 80, best: 1, traits: ['zoc', 'cover', 'guard'],
            falloff: { 1: { hit: 1.0, pow: 1.0 } } },
  // 移動速度重視。一直線に走り込んでの突撃が武器
  '騎兵': { stats: { hp: 100, atk: 110, def: 80, spd: 130, act: 50 }, rng: 1, hit: 80, best: 1, traits: ['charge'],
            falloff: { 1: { hit: 1.0, pow: 1.0 } } },
  // 斥候（兵士クラスの単独の駒・人数なし）: 視界が広く足が速いが、戦う力は弱い
  '斥候': { stats: { hp: 60, atk: 50, def: 50, spd: 170, act: 60 }, rng: 1, hit: 80, best: 1, vision: 7,
            traits: ['scout'], solo: true, special: true,
            falloff: { 1: { hit: 1.0, pow: 1.0 } } },
  // 暗殺者（兵長クラスの単独の駒）: 隠密で近づき、将を狙う。兵士の駒には弱い
  '暗殺者': { stats: { hp: 70, atk: 120, def: 50, spd: 140, act: 60 }, rng: 1, hit: 90, best: 1, vision: 4,
            traits: ['stealth', 'assassin'], solo: true, special: true,
            falloff: { 1: { hit: 1.0, pow: 1.0 } } },
  // 総大将専用。三すくみの相性を持たず（与える側も受ける側も ×1.0）、総大将の強さは振り分けで決まる。
  // stats は固定枠（SPD / ACT）の基準値として使う。HP / ATK / DEF は振り分けで上書きされる
  '将':   { stats: { hp: 120, atk: 110, def: 100, spd: 90, act: 70 }, rng: 1, hit: 85, best: 1, commanderOnly: true,
            falloff: { 1: { hit: 1.0, pow: 1.0 }, 2: { hit: 0.9, pow: 0.9 } } },
  // 弓を持った将（総大将・副将の武器で選ぶ）。射程が長い分、固定枠が高く（自由枠が減り）脆い。後衛として前衛の後ろから撃つ
  '弓将': { stats: { hp: 70, atk: 100, def: 70, spd: 90, act: 70 }, rng: 4, hit: 85, best: 3, rear: true, commanderOnly: true, traits: ['aim'],
            weaponDiscount: 35,   // 射程4の分のコストを軽く（全額だと刀の副将に勝率2〜10%。45で32〜42%、60で65%）
            falloff: { 1: { hit: 0.6, pow: 1.0 }, 2: { hit: 1.0, pow: 1.0 }, 3: { hit: 1.0, pow: 1.0 },
                       4: { hit: 0.9, pow: 0.9 }, 5: { hit: 0.75, pow: 0.75 }, 6: { hit: 0.6, pow: 0.6 } } },
  // 槍を持った将: 射程2、突き・薙ぎ払いが使える
  '槍将': { stats: { hp: 110, atk: 100, def: 90, spd: 90, act: 70 }, rng: 2, hit: 85, best: 2, commanderOnly: true, traits: ['spear'],
            weaponDiscount: -40,   // 範囲攻撃・迎え突きの分、少し高く（副将どうし: −10 で 65%、−15 で約50%、−20 で 43%）
            falloff: { 1: { hit: 1.0, pow: 0.9 }, 2: { hit: 0.9, pow: 1.0 }, 3: { hit: 0.8, pow: 0.8 } } },
  // 盾を持った将: 受けるダメージを減らす（堅守）。庇うは持たない（将が味方の身代わりになって倒れると負けるので）
  '盾将': { stats: { hp: 120, atk: 110, def: 100, spd: 90, act: 70 }, rng: 1, hit: 85, best: 1, commanderOnly: true, traits: ['guard'],
            weaponDiscount: -25,   // 堅守の分、少し高く（割引なしだと勝率 63〜71%、−10 で 57%）
            falloff: { 1: { hit: 1.0, pow: 1.0 }, 2: { hit: 0.9, pow: 0.9 } } },
  // 馬に乗った将: 足が速く（SPD が高い分、固定枠も高い）、一直線に走り込んで突撃できる
  '騎将': { stats: { hp: 100, atk: 90, def: 80, spd: 130, act: 70 }, rng: 1, hit: 85, best: 1, commanderOnly: true, traits: ['charge'],
            weaponDiscount: 20,    // 足の分を軽く（割引なしだと勝率 5%、+40 で 35%、+45 で 43%、+80 で 88%）
            falloff: { 1: { hit: 1.0, pow: 1.0 }, 2: { hit: 0.9, pow: 0.9 } } },
  // レアな副将「二刀流剣士」専用。耐久を削ぎ落とし、足と手数で斬り込む。選べるスキルは持たず、固有能力だけで戦う
  '二刀将': { stats: { hp: 60, atk: 120, def: 40, spd: 130, act: 140 }, rng: 1, hit: 90, best: 1, commanderOnly: true, rare: true,
            traits: ['dual', 'dash', 'deflect'], weaponDiscount: -40,   // 1対1で通常の副将に勝率約84%、剣兵350人前後と五分（将のSPD/ACTの値段を下げたので 40 → −40）
            falloff: { 1: { hit: 1.0, pow: 1.0 } } },
};

/** レアな将（固定の型。振り分け・スキル選択はできない） */
const RARE_GENERALS = {
  '二刀流剣士': { chance: 20, build: { hp: 2, atk: 5, def: 3, buy: {}, weapon: '二刀', skills: [], ldr: 3 },   // 統率は最低（LDR_BASE）。一匹狼
    desc: '耐久を削ぎ落とした二刀流の剣士。足が速く手数が多い。二刀流・すれ違い斬り・剣弾きの固有能力だけで戦う（スキルは選べない）' },
};

/** 将の武器。三すくみの相性は持たない（将の兵種はどれも相性 ×1.0） */
const WEAPONS = {
  '刀': { type: '将', icon: '⚔', label: '刀（近接・射程1）' },
  '槍': { type: '槍将', icon: '🔱', label: '槍（射程2・突き/薙ぎ払い）' },
  '弓': { type: '弓将', icon: '🏹', label: '弓（遠距離・射程4・後衛）' },
  '盾': { type: '盾将', icon: '🛡', label: '盾（堅守: 受けるダメージ減）' },
  '馬': { type: '騎将', icon: '🐎', label: '馬（騎乗・突撃・足が速い）' },
  '二刀': { type: '二刀将', icon: '⚔⚔', label: '二刀（レア: 二刀流剣士専用）', rare: true },
};
function weaponOf(build) {
  return WEAPONS[build?.weapon] ? build.weapon : '刀';
}

/** 兵種の固有能力のコスト合計 */
function traitCost(t) {
  return (t.traits || []).reduce((s, k) => s + TRAITS[k].cost, 0);
}

/**
 * 雑兵プリセットを階級のコストまで比例拡大する。射程の値はそのまま（コストは比率分払う）。
 * 端数で合計がずれた分は、いちばん大きいステータスで調整する。
 */
/** 兵長のステータス: SPD / ACT の割り戻しで浮いたコストから SPD+SERGEANT_SPD の分を引き、残りの SERGEANT_SPARE を HP / ATK に足す */
function sergeantStats(st, f) {
  const spare = Math.max(0, Math.round(((st.spd + st.act) * (1 - 1 / f) - SERGEANT_SPD * f) * SERGEANT_SPARE));
  const hp = Math.round(spare * st.hp / (st.hp + st.atk));
  return { ...st, hp: st.hp + hp, atk: st.atk + spare - hp, spare };
}

function scaleStats(type, cost) {
  const t = TYPES[type];
  const budget = cost - (rngCost(t.rng) + traitCost(t)) * cost / BASE_COST;
  const baseSum = STAT_KEYS.reduce((s, k) => s + (t.stats[k] || 0), 0);
  const out = {};
  for (const k of STAT_KEYS) out[k] = Math.round((t.stats[k] || 0) * budget / baseSum);
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
// 将の SPD / ACT（兵士と同じ物差しの値）に払う階級の倍率の重さ。1 = 階級の倍率どおり、0 = 兵士と同じ値段。
// 兵長と同じく、階級で伸ばさないテンポ系に階級の値段を払わせない（射程・固有能力は階級の倍率どおり払う）
const GENERAL_TEMPO_RATE = 0;
const LDR_BASE = 3;
const LDR_COST = 40;
const LDR_COST_COMMANDER = 20;   // 総大将は統率力が安い（統率力あってこその総大将）
const LDR_MAX = 15;
const UPGRADE_CAP = { spd: 100, act: 100 };
const UPGRADE_STEPS = Array.from({ length: UPGRADE_CAP.spd / 10 + 1 }, (_, i) => i * 10);   // 強化の選択肢 +0〜+100
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
  '騎乗型':     { hp: 4, atk: 3, def: 3, buy: { spd: 40 }, skills: ['一撃離脱'] },
  '弓将型':     { hp: 4, atk: 3.5, def: 2.5, weapon: '弓', skills: ['遠隔狙撃'] },   // 弓を持って後ろから撃つ（射程4）  // 騎乗して足を買う（移動力 3→4）分、他が薄い
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
  '鉄壁の構え': { cost: 200, cooldown: 3, desc: '次の自分の行動まで DEF +100%。その行動では移動しない。周り2マス以内の味方も、それぞれ次の行動まで DEF +40%（守りの陣を敷く）' },
  '一斉指揮':   { cost: 300, cooldown: 4, desc: '自分と周囲3マスの味方の ATK +30% / DEF +15%（各自の行動2回分）' },
  '一撃離脱':   { cost: 250, cooldown: 2, desc: '攻撃の前に使う。この行動の攻撃は反撃を受けず、攻撃の後に移動力いっぱい動ける（移動 → 攻撃 → 移動）' },
  '遠隔狙撃':   { cost: 250, cooldown: 3, desc: 'この行動だけ射程 +1' },
};
const SMASH_MULT = 1.15;      // 強撃の ATK 倍率
const COMMAND_RANGE = 3;      // 一斉指揮の範囲

// 士気: 総大将の周囲 MORALE_RANGE マス以内の味方は、スキルとは別に常に ATK / DEF が少し上がる
const MORALE_RANGE = 3;
const MORALE_BONUS = 0.05;
const MORALE_PER_LDR = 0.005;   // 総大将の器: 総大将の統率力が基本値より1高いごとに、士気の効果 +0.5%（統率12なら 5% → 9.5%）

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
/** 将の兵種: 武器で決まる（刀 = 将 / 槍 = 槍将 / 弓 = 弓将 / 盾 = 盾将 / 馬 = 騎将） */
function generalType(build, type = COMMANDER_TYPE) {
  const b = typeof build === 'string' ? COMMANDER_BUILDS[build] : build;
  return b && TYPES[type]?.commanderOnly ? WEAPONS[weaponOf(b)].type : type;
}

function commanderStats(type, cost, build, slots = SKILL_SLOTS['総大将']) {
  // 型の名前、または { hp, atk, def, buy, skills } の振り分け（手動プレイで使う）
  const b = typeof build === 'string' ? COMMANDER_BUILDS[build] : build;
  type = generalType(b, type);
  const t = TYPES[type];
  const f = cost / BASE_COST;
  const buy = { spd: 0, act: 0, rng: 0, ...b.buy };
  for (const k of Object.keys(UPGRADE_CAP)) buy[k] = Math.min(buy[k], UPGRADE_CAP[k]);
  const rng = Math.min(t.rng + buy.rng, maxRng(type));
  // weaponDiscount: 武器（弓など）の射程の分のコストを軽くする（将の武器は単体の殴り合いより用途の違いなので）
  const fixedCost = (t.stats.spd + t.stats.act) * (1 + (f - 1) * GENERAL_TEMPO_RATE) + (rngCost(t.rng) - (t.weaponDiscount || 0) + traitCost(t)) * f;
  // SPD / ACT の強化も基本の値と同じ値段（GENERAL_TEMPO_RATE）。射程の強化は階級の倍率どおり
  const upgradeCost = ((buy.spd + buy.act) * (1 + (f - 1) * GENERAL_TEMPO_RATE) + (rngCost(rng) - rngCost(t.rng)) * f) * UPGRADE_MULT;
  const skills = [...new Set(b.skills || [])].slice(0, slots);
  const skillCost = skills.slice(1).reduce((s, k) => s + SKILLS[k].cost, 0);   // 1つ目は無料
  const ldr = Math.max(LDR_BASE, Math.min(LDR_MAX, b.ldr ?? LDR_BASE));
  const ldrCost = (ldr - LDR_BASE) * (cost === RANKS['総大将'].cost ? LDR_COST_COMMANDER : LDR_COST);
  const free = cost - fixedCost - upgradeCost - skillCost - ldrCost;
  const share = clampShares({ hp: b.hp, atk: b.atk, def: b.def });
  const atk = Math.round(free * share.atk);
  const def = Math.round(free * share.def);
  const stats = { hp: free - atk - def, atk, def, spd: t.stats.spd + buy.spd, act: t.stats.act + buy.act };
  return { stats, rng, fixedCost, upgradeCost, skillCost, ldrCost, free, skills, ldr };
}

// 起動時にプリセットの合計がコストと一致しているか確認する
for (const [name, t] of Object.entries(TYPES)) {
  const sum = STAT_KEYS.reduce((s, k) => s + (t.stats[k] || 0), 0) + rngCost(t.rng) + traitCost(t);
  if (sum !== BASE_COST) console.warn(`${name} のステータス合計が ${sum}（${BASE_COST} であるべき）`);
}

const HIT_SPREAD = 5;   // 命中率の個体差 ±5%
const HIT_BONUS = 8;    // 全員の命中率の底上げ（回避込みで近接でも70%台が多く、2〜3回続けて外れることが多かったため）
// 回避: 狙われた側の SPD が基準（100）より高いほど当たりにくく、低いほど当たりやすい
// （SPD 10 ごとに 1.5%。避ける側は最大 −10%、鈍くて当たりやすい側は最大 +5%。盾兵が弓に弱くなりすぎないように）
const EVADE_BASE_SPD = 100;
const EVADE_PER_SPD = 0.15;
const EVADE_CAP = 10;
const EXPOSE_CAP = 5;
/** 回避による命中率の増減（マイナス = 避けられやすい） */
function evadeMod(defender) {
  return Math.max(-EVADE_CAP, Math.min(EXPOSE_CAP, Math.round((EVADE_BASE_SPD - defender.spd) * EVADE_PER_SPD)))
    + (defender.traits.includes('guard') ? PARRY_EXPOSE : 0);   // 盾は避けずに受ける
}
// 兵として編成される兵種（総大将専用の「将」は除く）
const TYPE_NAMES = Object.keys(TYPES).filter(k => !TYPES[k].commanderOnly && !TYPES[k].special);
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
    if (rank === '総大将' || rank === '副将') type = generalType(build, type);   // 弓を持った将は「弓将」
    const t = TYPES[type];
    // 総大将・副将は固定枠 + 自由振り分け、それ以外は雑兵プリセットの拡大
    const isGeneral = rank === '総大将' || rank === '副将';
    const cs = isGeneral ? commanderStats(type, r.cost, build, SKILL_SLOTS[rank]) : null;
    let st = cs ? cs.stats : scaleStats(type, r.cost);
    // テンポ系（移動・攻撃頻度）は階級で伸びすぎないよう、雑兵基準に割り戻して使う
    // （総大将の SPD / ACT は最初から雑兵基準の固定値なので割り戻さない）
    const tempoDiv = cs ? 1 : r.cost / BASE_COST;
    // 兵長: 割り戻した SPD / ACT の分のうち、SPD+SERGEANT_SPD に使った残りを HP / ATK に（プリセットの比で）振る
    if (rank === '兵長' && !t.special) st = sergeantStats(st, tempoDiv);
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
    this.troops = rank === '雑兵' && !t.solo ? Math.max(MIN_TROOPS, troops) : null;
    this.maxHp = this.troops ? Math.round(st.hp * HP_SCALE * this.troops / BASE_TROOPS) : st.hp * HP_SCALE;
    this.hp = this.maxHp;
    this.atk = st.atk;
    // DEF は階級の倍率を掛けない（兵士の駒と同じ物差し）。HP と ATK だけが階級で伸びる。
    // DEF まで伸ばすと「HP × ATK × DEF」で強さが階級の3乗になり、同じコストの兵士の駒が太刀打ちできなくなるため
    this.def = Math.round(st.def / (r.cost / BASE_COST));
    this.int = Math.round(st.int || 0);    // 知力（魔法の威力・抵抗。今は INT を持つ兵種・将はいない）
    // SPD・ACT は兵士の駒と同じ物差し（階級の倍率を割り戻した値）で持つ。行動順・回避・表示はこの値
    // 兵長は割り戻した SPD/ACT のコストの一部で、兵士より少し速い（+SERGEANT_SPD）。残りは固有能力の強化（兵長の値）に使う扱い
    this.spd = Math.round(st.spd / tempoDiv) + (rank === '兵長' && !t.special ? SERGEANT_SPD : 0) + (d(3) - 1) * 10;   // 行動順。個体差 +0〜20
    this.rng = cs ? cs.rng : t.rng;
    this.act = Math.round(st.act / tempoDiv);
    this.move = Math.max(1, Math.ceil(st.spd / tempoDiv / MOVE_DIV)) + MOVE_BONUS;
    this.actRate = st.act / tempoDiv;      // 1行動ごとに行動ゲージにたまる量
    this.gauge = (d(5) - 1) * 10;          // 初期ゲージ 0〜40（全員が同じタイミングで動かないようずらす）
    this.hit = t.hit + HIT_BONUS + d(HIT_SPREAD * 2 + 1) - HIT_SPREAD - 1;   // 個体差 ±HIT_SPREAD
    this.best = t.best;
    this.falloff = t.falloff;
    this.rear = !!t.rear;
    this.special = !!t.special;            // 斥候・暗殺者（単独の駒）
    this.vision = t.vision ?? VISION_DEFAULT;
    this.revealed = false;                 // 隠密の駒が攻撃して姿を見せている
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
  // 斥候 0〜2人、暗殺者は 1d6 で6が出たときだけ1人
  for (let i = 1; i <= d(3) - 1; i++) troops.push(new Unit(side, '雑兵', '斥候', `${label}斥候${i}`, 0, 0));
  if (d(6) === 6) troops.push(new Unit(side, '兵長', '暗殺者', `${label}暗殺者1`, 0, 0));
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
  fog: true,         // 視界（戦場の霧）を使うか
  logBuffer: null,   // 見えない敵の行動ログを一時的にためる
  intel: null,       // 索敵の記憶（updateIntel）
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
  const troops = state[side].units.filter(u => !isLeader(u) && !u.special);
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

/** その陣営から敵ユニット e が見えているか（味方の誰かの視界に入っているか） */
const STEALTH_SPOT = { base: 2, scout: 3 };   // 隠密の敵が見える距離（ふつう / 斥候）。以前は 1 / 2 で、隣にいないと気づかなかった
function visibleTo(side, e) {
  if (!state.fog || e.revealed) return true;
  const stealth = e.traits.includes('stealth');
  return state[side].units.some(o => o.alive &&
    distance(o, e) <= (stealth ? (o.traits.includes('scout') ? STEALTH_SPOT.scout : STEALTH_SPOT.base) : (o.vision ?? VISION_DEFAULT)));
}

/** 見えている敵（狙える敵） */
function seenEnemies(unit) {
  return enemiesOf(unit).filter(e => visibleTo(unit.side, e));
}

const SWEEP_STALE = 6;   // 見回ったマスを「もう見た」とみなすターン数（過ぎたらまた探しに行く）

/**
 * 陣営ごとの索敵の記憶: 最後に敵を見た場所（seen）と、見回ったマスとそのターン（swept）。
 * 見えている敵の位置を覚え、その場所が見えるところまで来て敵がいなければ忘れる
 */
function updateIntel(side) {
  state.intel ||= {};
  const intel = (state.intel[side] ||= { seen: {}, swept: {} });
  const eyes = state[side].units.filter(o => o.alive);
  const sees = p => eyes.some(o => distance(o, p) <= (o.vision ?? VISION_DEFAULT));
  for (const e of state[side === 'player' ? 'cpu' : 'player'].units) {
    if (!e.alive) delete intel.seen[e.id];
    else if (visibleTo(side, e)) intel.seen[e.id] = { x: e.x, y: e.y, leader: isLeader(e), gen: e.rank === '副将' || e.rank === '総大将' };
    else if (intel.seen[e.id] && sees(intel.seen[e.id])) delete intel.seen[e.id];   // 来てみたが、もういない
  }
  for (let y = 0; y < state.map.h; y++) for (let x = 0; x < state.map.w; x++) {
    if (sees({ x, y })) intel.swept[`${x},${y}`] = state.turn;
  }
  return intel;
}

/**
 * 敵が見えないときに向かう地点。
 * ① 最後に敵を見た場所（大将を優先）→ ② まだ見回っていないマス（敵の本陣寄り・隊ごとに少しずつばらける）→ ③ 敵の本陣
 */
function searchPoint(unit) {
  const home = { x: Math.floor(state.map.w / 2), y: unit.side === 'player' ? 0 : state.map.h - 1 };
  if (!state.fog) return home;
  const intel = updateIntel(unit.side);
  const seen = Object.values(intel.seen);
  if (seen.length) {
    const score = p => distance(unit, p) - (p.leader ? 4 : 0);
    return seen.reduce((a, b) => (score(b) < score(a) ? b : a));
  }
  let best = null, bestScore = Infinity;
  const jitter = unit.id % 5;
  for (let y = 0; y < state.map.h; y++) for (let x = 0; x < state.map.w; x++) {
    const t = intel.swept[`${x},${y}`];
    const age = t === undefined ? SWEEP_STALE * 3 : state.turn - t;   // 長く見ていないマスほど優先
    if (age < SWEEP_STALE) continue;
    const sc = distance(unit, { x, y }) + distance({ x, y }, home) * 0.8 - Math.min(age, SWEEP_STALE * 3) * 1.5 + ((x * 3 + y * 5 + jitter) % 5) * 0.4;
    if (sc < bestScore) { bestScore = sc; best = { x, y }; }
  }
  return best || home;
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
  return Math.min(...seenEnemies(unit).map(e => distance(p, e)));
}

/**
 * 最も近い見えている敵。ただし斥候・暗殺者は、射程内にいるとき以外は後回しにする
 * （足の速い斥候を延々と追いかけ回さないように）
 */
function nearestEnemy(unit) {
  const score = e => distance(unit, e) + (e.special && distance(unit, e) > effRng(unit) ? 8 : 0);
  let best = null;
  for (const e of seenEnemies(unit)) {
    if (!best || score(e) < score(best) || (score(e) === score(best) && e.hp < best.hp)) best = e;
  }
  return best;
}

/** 大将が本陣で待つか（斥候・暗殺者は数えない。配下の兵が残っている間は待つ） */
function isHolding(unit) {
  return isLeader(unit) && alliesOf(unit).some(a => !a.special) && troopRatio(unit.side) >= advanceRatio(unit.side)
    && !leaderThreatened(unit);
}

/**
 * 大将が狙われているか: 見えている敵のうち、大将を攻撃できる間合い（射程 + 1マス）にいる者がいる。
 * 狙われたら本陣で待つのをやめて自分から戦う（距離を取って一方的に撃たれ続けないように）
 */
function leaderThreatened(unit) {
  return seenEnemies(unit).some(e => !e.special && distance(e, unit) <= effRng(e) + 1);
}

/** その戦局の大将の士気範囲内にいるか（大将自身は対象外） */
/** 士気の効果の大きさ（大将が総大将なら、統率力が高いほど大きい） */
function moraleBonus(side) {
  const cmd = leaderOf(state[side]);
  return MORALE_BONUS + (cmd?.isCommander && cmd.ldr ? Math.max(0, cmd.ldr - LDR_BASE) * MORALE_PER_LDR : 0);
}

function inMorale(u) {
  if (isLeader(u)) return false;
  const cmd = leaderOf(state[u.side]);
  if (!cmd.alive) return false;
  return !!cmd && distance(u, cmd) <= MORALE_RANGE;
}

/** バフと士気を合わせた能力の倍率 */
function statMult(u, stat) {
  const buff = u.buffs.filter(b => b.stat === stat).reduce((s, b) => s + b.value, 0);
  return 1 + buff + (inMorale(u) ? moraleBonus(u.side) : 0) + (hasSergeant(u) ? SERGEANT_BUFF : 0)
    + (stat === 'def' && state.campaignBattle?.fortBonus?.[u.side] ? FORT_DEF : 0);
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

const IRON_WALL_RANGE = 2;     // 鉄壁の構え: 味方にも効く範囲（マス）
const IRON_WALL_ALLY = 0.4;    // 鉄壁の構え: 味方の DEF +40%

/** 鉄壁の構え: 自分は DEF +100%・移動しない。周りの味方は DEF +40%（それぞれ次の行動まで） */
function ironWall(unit) {
  unit.buffs.push({ stat: 'def', value: 1.0, turns: 1 });
  unit.rooted = true;
  const near = alliesOf(unit).filter(a => distance(a, unit) <= IRON_WALL_RANGE);
  for (const a of near) a.buffs.push({ stat: 'def', value: IRON_WALL_ALLY, turns: 1 });
  if (near.length) log(`🛡 ${unit.name} の鉄壁の構え！ 周りの ${near.length}体（${near.map(a => a.name).join('・')}）も DEF +${IRON_WALL_ALLY * 100}%`, unit.side);
}

/** 自分の行動の始めにたまる行動ゲージ。手数が少ない駒・兵が減った駒でも、毎ターン最低1回は攻撃できる */
function chargedGauge(u) {
  return Math.max(ACT_PER_ATTACK, Math.min(gaugeCap(u), u.gauge + actGain(u)));
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
  log(`✨ ${u.name} の「${name}」！ ${SKILLS[name].desc}`, u.side);
}

/** 自分の行動の始めに、スキルの待ち時間とバフの残りを1つ進める */
function tickUnit(u) {
  for (const k of Object.keys(u.cooldowns)) if (u.cooldowns[k] > 0) u.cooldowns[k]--;
  u.buffs = u.buffs.filter(b => --b.turns > 0);
  u.rooted = false;
  u.rngBonus = 0;
  u.counteredBy = [];
  u.hitAndRun = false;
  u.revealed = false;
  u.moved = false;   // この行動で移動したか（狙い撃ち）
  u.pursuitMove = 0; // 追撃: 敵を倒したあとに踏み込めるマス数
  u.dashed = false;  // すれ違い斬りをこの行動で使ったか
}

/** 攻撃対象に上下左右で隣接している、攻撃側の味方の数（攻撃者自身は除く） */
function surroundCount(attacker, defender) {
  return alliesOf(attacker).filter(a => Math.abs(a.x - defender.x) + Math.abs(a.y - defender.y) === 1).length;
}

/**
 * 攻撃判定:
 *   命中率 = HIT × 距離の命中倍率 ＋ 回避（相手の SPD で ±10%）。1d100 が命中率以下なら命中
 *   基本値   = ATK × 100 ÷ (100 + DEF) × (0.7 + 1d6×0.1) × DMG_SCALE（比率型。DEF は割合で効く）
 *   ダメージ = max(10, 基本値 × 距離の威力倍率 × 人数 × 突撃 × 包囲 × 能力)  ※四捨五入
 *   包囲     = 1 + 0.1 × 攻撃対象に隣接する味方の数
 *   1d6 の出目6はクリティカルで ATK × 1.5 として計算
 */
function calcAttack(attacker, defender, bonus = 1, atkMult = 1) {
  // 射程を伸ばした総大将など、表にない距離はいちばん遠い距離の値を使う
  const dist = distance(attacker, defender);
  const f = attacker.falloff[dist] ?? attacker.falloff[Math.max(...Object.keys(attacker.falloff).map(Number))];
  const aim = attacker.traits.includes('aim') && !attacker.moved ? AIM_HIT[lv(attacker)] : 0;
  // 突撃（bonus > 1）は奇襲の一撃: 相手の回避を無視し、命中も上がる
  const charging = bonus > 1;
  const evade = charging ? Math.max(0, evadeMod(defender)) : evadeMod(defender);
  const hitRate = Math.max(5, Math.min(99, Math.round(attacker.hit * f.hit) + aim + evade + (charging ? CHARGE_HIT : 0)));
  const hitRoll = d(100);
  if (hitRoll > hitRate) return { hit: false, hitRate, hitRoll, evade };
  const die = d(6);
  const crit = die === 6;
  const baseAtk = effAtk(attacker) * atkMult;
  const atk = crit ? Math.floor(baseAtk * 1.5) : baseAtk;
  const surround = surroundCount(attacker, defender);
  const mult = f.pow * (MATCHUP[attacker.type]?.[defender.type] ?? 1) * bonus * (1 + SURROUND_BONUS * surround)
    * Math.sqrt(sizeRatio(attacker))    // 人数が多い駒ほど1回の威力も大きい
    * (attacker.traits.includes('assassin') ? (defender.rank === '雑兵' ? ASSASSIN_VS_TROOPS : ASSASSIN_VS_GENERAL) : 1)
    * (defender.traits.includes('pursuit') && dist >= 3 ? 1 - DEFLECT_CUT[lv(defender)] : 1)   // 剣兵の矢払い
    * (defender.traits.includes('spear') && dist >= 3 ? 1 + VOLLEY_TAKEN : 1);                 // 槍兵は矢に弱い
  // 比率型: DEF は割合で効く。ダイスは ×0.8〜1.2（6 はクリティカルで ATK ×1.5）
  const base = atk * DEF_K / (DEF_K + effDef(defender)) * (0.7 + die * 0.1) * DMG_SCALE;
  // 受け流し（盾）: 一定の確率でダメージを大きく減らす
  const parry = defender.traits.includes('guard') && d(100) <= PARRY_CHANCE[lv(defender)];
  // 剣弾き（二刀流剣士）: 一定の確率で攻撃を剣で弾き、ダメージ 0
  if (defender.traits.includes('deflect') && d(100) <= (bonus > 1 ? DEFLECT_CHARGE : BLADE_TYPES.includes(attacker.type) ? DEFLECT_BLADE : DEFLECT_CHANCE)) return { hit: true, hitRate, hitRoll, evade, dmg: 0, die, crit: false, surround, deflected: true };
  const dmg = Math.max(MIN_DAMAGE, Math.round(base * mult * (parry ? 1 - PARRY_CUT : 1)));
  return { hit: true, hitRate, hitRoll, evade, dmg, die, crit, surround, parry };
}

/** ログ用: 回避で命中率が変わっていれば添える */
function evText(r) {
  return r.evade ? `（${r.evade < 0 ? '素早くて回避' : '鈍くて被弾'}${r.evade > 0 ? '+' : ''}${r.evade}）` : '';
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
  const front = alliesOf(unit).filter(a => !a.rear && !isLeader(a) && !a.special);
  if (front.length === 0) return true;
  // プレイヤーは y が小さいほど前、CPU は y が大きいほど前
  return unit.side === 'player'
    ? p.y >= Math.min(...front.map(a => a.y))
    : p.y <= Math.max(...front.map(a => a.y));
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];   // 上下左右の4方向

/** 地点 (x,y) が、unit から見て敵の足止め（ZOC）範囲（上下左右に隣接）か */
function inEnemyZoc(unit, x, y, known = false) {
  return enemiesOf(unit).some(e => e.traits.includes('zoc') && Math.abs(e.x - x) + Math.abs(e.y - y) === 1 && knownFoe(unit, e, known));
}
/** known: false = すべての敵 / true = 今見えている敵 / Set = その id の敵（移動前に見えていた敵） */
function knownFoe(unit, e, known) {
  return !known || (known instanceof Set ? known.has(e.id) : visibleTo(unit.side, e));
}
/** そのマスの敵。known = true なら見えている敵だけ（手動プレイの表示用。見えない敵の位置が漏れないように） */
function enemyAt(unit, x, y, known = false) {
  const o = unitAt(x, y);
  return o && o.side !== unit.side && knownFoe(unit, o, known) ? o : null;
}

/**
 * 最大 steps マス以内で止まれるマスの一覧（幅優先探索の順）。
 * 4方向に1マスずつ進む。味方のいるマスは通過できるが止まれない。
 * 敵のいるマスは通過も不可。敵の足止め（ZOC）範囲に入ったらそこで止まる。マップの外には出られない。
 */
function reachableCells(unit, steps, known = false) {
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
        const foe = enemyAt(unit, nx, ny, known);
        if (foe) continue;                                 // 敵は通り抜け不可
        let other = unitAt(nx, ny);
        if (other && other.side !== unit.side) other = null; // （known のとき）見えない敵はいないものとして扱う
        seen.add(key);
        if (!inEnemyZoc(unit, nx, ny, known)) next.push([nx, ny]);   // ZOC 内からは先へ進めない
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
        if (!visibleTo(unit.side, other)) break;   // 見えない敵には突撃できない
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
        if (k >= CHARGE_MIN && ahead && ahead.side !== unit.side && visibleTo(unit.side, ahead) && (!best || k > best.run)) {
          best = { run: k, x, y, target: ahead };
        }
        break;
      }
    }
  }
  return best;
}

/** すれ違い斬りの候補: 上下左右の隣の敵（見えている）と、その向こう側の空いたマス。{ target, to: [x, y], dir } の配列 */
function dashOptions(unit) {
  if (!unit.traits.includes('dash') || unit.dashed || unit.rooted) return [];
  const opts = [];
  for (const [dx, dy] of DIRS) {
    const e = enemyAt(unit, unit.x + dx, unit.y + dy, true);
    const tx = unit.x + 2 * dx, ty = unit.y + 2 * dy;
    if (!e || tx < 0 || ty < 0 || tx >= state.map.w || ty >= state.map.h || unitAt(tx, ty)) continue;
    opts.push({ target: e, to: [tx, ty], dir: [dx, dy] });
  }
  return opts;
}

/** すれ違い斬り: 敵の向こうへ駆け抜けながら斬る（攻撃1回分）。決着したら true */
function performDash(unit, opt) {
  const before = unit.posText;
  [unit.x, unit.y] = opt.to;
  unit.dashed = true;
  unit.moved = true;
  log(`💨 ${unit.name} のすれ違い斬り！ ${before} → ${unit.posText}`, unit.side);
  return performAttack(unit, opt.target);
}

/**
 * 槍兵の範囲攻撃の候補。
 *   突き = 上下左右の向きで、隣の敵とその奥の敵（2体とも見えている）
 *   薙ぎ払い = 周りの8マスのうち、ひと続きの3マス（例: 左・左斜め前・前）の弧に敵が2体以上（見えている）
 * を探す。{ kind, name, hits: [{ u, mult }], dir } の配列
 */
const RING = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];   // 周りの8マス（時計回り）
function spearOptions(unit) {
  if (!unit.traits.includes('spear')) return [];
  const foe = (x, y) => { const o = unitAt(x, y); return o && o.side !== unit.side && visibleTo(unit.side, o) ? o : null; };
  const opts = [];
  for (const [dx, dy] of DIRS) {
    const front = foe(unit.x + dx, unit.y + dy);
    const back = front && foe(unit.x + 2 * dx, unit.y + 2 * dy);
    if (back && effRng(unit) >= 2) {
      const m = THRUST_MULT[lv(unit)];
      opts.push({ kind: 'thrust', name: '突き', dir: [dx, dy], hits: [{ u: front, mult: m[0] }, { u: back, mult: m[1] }] });
    }
  }
  const seen = new Set();
  for (let i = 0; i < RING.length; i++) {
    const arc = [RING[(i + 7) % 8], RING[i], RING[(i + 1) % 8]];
    const us = arc.map(([dx, dy]) => foe(unit.x + dx, unit.y + dy)).filter(Boolean);
    if (us.length < 2) continue;
    const key = us.map(u => u.id).sort().join(',');
    if (seen.has(key)) continue;   // 同じ顔ぶれになる弧は1つだけ
    seen.add(key);
    // 反撃してくるのは弧の真ん中（いなければ上下左右で隣の敵）
    const mid = foe(unit.x + RING[i][0], unit.y + RING[i][1]);
    const main = mid || us.find(u => distance(unit, u) === 1) || us[0];
    const mult = SWEEP_MULT[us.length][lv(unit)];
    opts.push({ kind: 'sweep', name: '薙ぎ払い', dir: RING[i], main, hits: us.map(u => ({ u, mult })) });
  }
  return opts;
}

const SPEAR_SPOT_MIN = 1.2;   // オートの槍兵が回り込むのは、技の見込みがふつうの攻撃の 1.2 倍以上のとき

/** オートの槍兵が突き・薙ぎ払いを使える、移動できる範囲でいちばん見込みの大きいマス（今の位置で使えるなら null） */
function spearSpot(unit) {
  const value = () => Math.max(0, ...spearOptions(unit).map(o => spearValue(unit, o)));
  const [ox, oy] = [unit.x, unit.y];
  const here = value();
  // ふつうの攻撃（いちばん近い敵への相性）よりはっきり得なときだけ回り込む（敵の隣に出て反撃を受けるので）
  const t = nearestEnemy(unit);
  const normal = t ? (MATCHUP[unit.type]?.[t.type] ?? 1) : 1;
  let best = null, bestV = Math.max(SPEAR_SPOT_MIN * normal, here + 0.01);
  for (const [x, y] of reachableCells(unit, unit.move)) {
    [unit.x, unit.y] = [x, y];
    const v = value();
    if (v >= bestV) { bestV = v; best = [x, y]; }
  }
  [unit.x, unit.y] = [ox, oy];
  return best;
}

/**
 * 迎え突き: 敵が槍兵の隣のマスに踏み込んできたら、槍兵が先に一撃を入れる（反撃なし・ゲージを使わない）。
 * 槍の間合いに飛び込む剣兵・騎兵などの前衛が苦しむ。踏み込んだ側が倒れたら true
 */
function braceStrike(unit, fromX, fromY) {
  for (const e of enemiesOf(unit)) {
    if (!unit.alive) break;
    if (!e.traits.includes('spear') || !BRACE_TARGETS.includes(unit.type) || distance(e, unit) !== 1 || distance(e, { x: fromX, y: fromY }) <= 1) continue;
    const r = calcAttack(e, unit, BRACE_MULT[lv(e)]);
    if (!r.hit) { log(`🔱 ${e.name} の迎え突き！ [命中${r.hitRate}%${evText(r)} 🎲${r.hitRoll}] ${unit.name} にかわされた！`, e.side); continue; }
    unit.hp = Math.max(0, unit.hp - r.dmg);
    log(`🔱 ${e.name} の迎え突き！ ${unit.name} に${r.parry ? '（🛡受け流し）' : r.deflected ? '（⚔弾いた！）' : ''} ${r.dmg} のダメージ！ (残HP ${unit.hp}/${unit.maxHp})`, e.side);
    if (!unit.alive) { log(`☠ ${unit.name} は倒れた！`, 'death'); checkVictory(); return true; }
  }
  return !unit.alive;
}

/** 技の向き（ボタンの表示用） */
function dirName(unit, opt) {
  const [dx, dy] = opt.dir;
  return { '0,-1': '↑', '1,-1': '↗', '1,0': '→', '1,1': '↘', '0,1': '↓', '-1,1': '↙', '-1,0': '←', '-1,-1': '↖' }[`${dx},${dy}`] || '';
}

/** 範囲攻撃の見込み（倍率 × 相性の合計）。オートで普通の攻撃と比べる */
function spearValue(unit, opt) {
  return opt.hits.reduce((a, h) => a + h.mult * (MATCHUP[unit.type]?.[h.u.type] ?? 1), 0);
}

/** 範囲攻撃を行う。反撃は真ん中（突きは手前）の相手からだけ。決着したら true */
function performSpear(unit, opt, atkMult = 1) {
  log(`🔱 ${unit.name} の${opt.name}！（${opt.hits.map(h => `${h.u.name} ${Math.round(h.mult * 100)}%`).join('・')}）`, unit.side);
  for (const h of opt.hits) {
    if (!h.u.alive) continue;
    const r = calcAttack(unit, h.u, h.mult, atkMult);
    if (!r.hit) { log(`　${h.u.name} にかわされた！ [命中${r.hitRate}%${evText(r)} 🎲${r.hitRoll}]`, unit.side); continue; }
    h.u.hp = Math.max(0, h.u.hp - r.dmg);
    log(`　${h.u.name} に${r.parry ? '（🛡受け流し）' : r.deflected ? '（⚔弾いた！）' : ''} ${r.dmg} のダメージ！${r.crit ? ' 会心！' : ''} (残HP ${h.u.hp}/${h.u.maxHp})`, unit.side);
    if (!h.u.alive) {
      log(`☠ ${h.u.name} は倒れた！`, 'death');
      if (checkVictory()) return true;
    }
  }
  const main = opt.kind === 'sweep' ? opt.main : opt.hits[0].u;
  return counterAttack(main, unit);
}

/**
 * 庇う（盾兵）: 攻撃する側と狙われた側が同じ縦・横の直線上にいて、その間に狙われた側の味方の盾兵がいれば、
 * 盾兵が代わりに攻撃を受ける（いちばん攻撃側に近い盾兵）。隣接した相手への攻撃には間がないので起きない
 */
function coverFor(attacker, target) {
  if (attacker.x !== target.x && attacker.y !== target.y) return target;
  const between = u => u.alive && u.side === target.side && u !== target && u.traits.includes('cover') &&
    (attacker.x === target.x
      ? u.x === target.x && (u.y - attacker.y) * (u.y - target.y) < 0
      : u.y === target.y && (u.x - attacker.x) * (u.x - target.x) < 0);
  const guards = allUnits().filter(between).sort((a, b) => distance(a, attacker) - distance(b, attacker));
  if (!guards.length) return target;
  log(`🛡 ${guards[0].name} が ${target.name} を庇った！`, guards[0].side);
  return guards[0];
}

/**
 * 1回の攻撃を行い、ログを出す。決着したら true を返す。
 * bonus = 突撃などの威力倍率、atkMult = 強撃などの ATK 倍率
 */
function performAttack(unit, target, bonus = 1, atkMult = 1) {
  if (!unit.traits.includes('dual')) return performAttackOnce(unit, target, bonus, atkMult, true);
  // 二刀流: 2回斬る（それぞれ ATK ×DUAL_MULT）。反撃は2回目のあとに1回だけ
  log(`⚔⚔ ${unit.name} の二刀流！`, unit.side);
  if (performAttackOnce(unit, target, bonus * DUAL_MULT, atkMult, false)) return true;
  if (!target.alive || !unit.alive) return false;
  return performAttackOnce(unit, target, bonus * DUAL_MULT, atkMult, true);
}

function performAttackOnce(unit, target, bonus = 1, atkMult = 1, counter = true) {
  target = coverFor(unit, target);
  const dist = distance(unit, target);
  if (unit.traits.includes('stealth')) unit.revealed = true;
  const r = calcAttack(unit, target, bonus, atkMult);
  if (!r.hit) {
    log(`${unit.name} の攻撃！ [距離${dist} 命中${r.hitRate}%${evText(r)} 🎲${r.hitRoll}] ${target.name} にかわされた！`, unit.side);
    return false;
  }
  target.hp = Math.max(0, target.hp - r.dmg);
  log(`${unit.name} の攻撃！ [距離${dist} 命中${r.hitRate}%${evText(r)} 🎲${r.hitRoll}] 命中！ [🎲${r.die}]${r.crit ? ' 会心の一撃！' : ''}${bonus > 1 ? ` 突撃×${bonus.toFixed(2)}` : ''}${atkMult > 1 ? ` 強撃×${atkMult}` : ''}${r.surround ? ` 包囲×${(1 + SURROUND_BONUS * r.surround).toFixed(1)}` : ''} ${target.name} に${r.parry ? '（🛡受け流し）' : r.deflected ? '（⚔弾いた！）' : ''} ${r.dmg} のダメージ！ (残HP ${target.hp}/${target.maxHp})`, unit.side);
  if (!target.alive) {
    log(`☠ ${target.name} は倒れた！`, 'death');
    if (checkVictory()) return true;
    if (unit.traits.includes('pursuit')) {
      unit.gauge = Math.min(gaugeCap(unit), unit.gauge + PURSUIT_GAUGE[lv(unit)]);
      unit.pursuitMove = unit.rooted ? 0 : Math.ceil(unit.move / 2);
      log(`⚔ ${unit.name} の追撃の構え！（行動ゲージ +${PURSUIT_GAUGE[lv(unit)]}${unit.pursuitMove ? `・${unit.pursuitMove}マス踏み込める` : ''}）`, unit.side);
    }
    return false;
  }
  return counter ? counterAttack(target, unit) : false;
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
  const victim = coverFor(defender, attacker);
  if (victim !== attacker) {
    // 反撃も盾兵が庇う
    const r = calcAttack(defender, victim, COUNTER_MULT);
    if (!r.hit) { log(`↩ ${defender.name} の反撃！ ${victim.name} にかわされた！`, defender.side); return false; }
    victim.hp = Math.max(0, victim.hp - r.dmg);
    log(`↩ ${defender.name} の反撃！ ${victim.name} に ${r.dmg} のダメージ！ (残HP ${victim.hp}/${victim.maxHp})`, defender.side);
    if (!victim.alive) { log(`☠ ${victim.name} は倒れた！`, 'death'); return checkVictory(); }
    return false;
  }
  const r = calcAttack(defender, attacker, COUNTER_MULT);
  if (!r.hit) {
    log(`↩ ${defender.name} の反撃！ [命中${r.hitRate}%${evText(r)} 🎲${r.hitRoll}] ${attacker.name} にかわされた！`, defender.side);
    return false;
  }
  attacker.hp = Math.max(0, attacker.hp - r.dmg);
  log(`↩ ${defender.name} の反撃！ [命中${r.hitRate}%${evText(r)} 🎲${r.hitRoll}] 命中！ [🎲${r.die}]${r.crit ? ' 会心の一撃！' : ''} ${attacker.name} に${r.parry ? '（🛡受け流し）' : r.deflected ? '（⚔弾いた！）' : ''} ${r.dmg} のダメージ！ (残HP ${attacker.hp}/${attacker.maxHp})`, defender.side);
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
/** 距離 d での攻撃の強さ（命中倍率 × 威力倍率）。届かなければ 0 */
function reachPower(u, d) {
  if (d > effRng(u)) return 0;
  const f = u.falloff[d] ?? u.falloff[Math.max(...Object.keys(u.falloff).map(Number))];
  return f.hit * f.pow;
}

/**
 * この相手と戦うのにいちばん得な距離: 自分の強さ ÷ 相手の（反撃の）強さ が最大の距離。
 * 例: 槍が弓を相手にするときは、弓が引ききれない隣（1マス）に詰める。弓は槍の届かない3マス
 */
function bestVs(unit, target) {
  if (!target) return unit.best;
  let best = unit.best, bestScore = -1;
  for (let d = 1; d <= effRng(unit); d++) {
    const mine = reachPower(unit, d);
    if (!mine) continue;
    const theirs = reachPower(target, d);
    const score = (theirs ? mine / theirs : 100 + mine) - Math.abs(d - unit.best) * 0.001;   // 同じなら元の得意な距離
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

function advanceScorer(unit, target) {
  const enemies = seenEnemies(unit);
  const free = (x, y) => {
    if (x < 0 || y < 0 || x >= state.map.w || y >= state.map.h) return false;
    const o = unitAt(x, y);
    return !o || o === unit;
  };
  // 攻撃位置の候補: 各敵からちょうど best マスのリング上で、空いていて、他の敵にそれより近くないマス
  const ideal = [];
  const seen = new Set();
  const b = bestVs(unit, target);
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
function actUnit(unit, ticked = false) {
  if (!ticked) tickUnit(unit);   // 手動からオートに切り替えたときは、手動の番の始めにもう進めてある
  if (unit.traits.includes('scout')) return scoutAct(unit);
  if (unit.traits.includes('assassin')) return assassinAct(unit);
  let target = nearestEnemy(unit);
  if (!target) return searchMove(unit);

  // 一斉指揮: 周囲に味方がいて、敵が近づいてきたら使う
  if (skillReady(unit, '一斉指揮')) {
    const near = alliesOf(unit).filter(a => distance(a, unit) <= COMMAND_RANGE);
    if (near.length >= 1 && distance(unit, target) <= 6) {
      useSkill(unit, '一斉指揮');
      for (const a of [unit, ...near]) a.buffs.push({ stat: 'atk', value: 0.3, turns: 3 }, { stat: 'def', value: 0.15, turns: 3 });
      log(`　→ 周囲${COMMAND_RANGE}マスの ${near.length + 1}体（${[unit, ...near].map(x => x.name).join('・')}）に効果`, unit.side);
    }
  }

  // 最適距離より遠い → 前進（射程外なら必ず、射程内でも最適距離まで詰める）
  // 総大将は配下が残っている間は本陣から動かない（射程内に敵がいれば攻撃はする）
  const holding = isHolding(unit);
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
    const close = seenEnemies(unit).filter(e => distance(e, unit) <= 2).length;
    const guarded = alliesOf(unit).filter(a => distance(a, unit) <= IRON_WALL_RANGE).length;
    if (close >= 2 || (close >= 1 && guarded >= 2) || (unit.hp < unit.maxHp * 0.5 && distance(unit, target) <= 3)) {
      useSkill(unit, '鉄壁の構え');
      ironWall(unit);
    }
  }
  // 突撃（騎兵など）: 一直線に走り込める敵がいれば優先する
  let charge = null;
  let movedBefore = false;   // 攻撃の前に移動したか（移動は1行動に1回。攻撃の後に回すこともできる）
  if (!holding && !unit.rooted && unit.traits.includes('charge')) {
    charge = findCharge(unit);
    if (charge) {
      const before = unit.posText, [fx, fy] = [unit.x, unit.y];
      [unit.x, unit.y] = [charge.x, charge.y];
      movedBefore = true;
      unit.moved = true;
      log(`🐎 ${unit.name} の突撃！ ${before} → ${unit.posText}（${charge.run}マス直進）`, unit.side);
      if (braceStrike(unit, fx, fy) || state.over) return;
      target = charge.target;
    }
  }
  // 槍兵: 突き・薙ぎ払いで複数の敵をまとめて狙える位置があれば、そこへ回り込む
  if (!charge && !holding && !unit.rooted && unit.traits.includes('spear')) {
    const spot = spearSpot(unit);
    if (spot) {
      const before = unit.posText, [fx, fy] = [unit.x, unit.y];
      [unit.x, unit.y] = spot;
      movedBefore = true;
      unit.moved = true;
      log(`🔱 ${unit.name} は敵の並びを狙える位置へ回り込んだ。${before} → ${unit.posText}`, unit.side);
      if (braceStrike(unit, fx, fy) || state.over) return;
      target = nearestEnemy(unit);
    }
  }
  if (!charge && !movedBefore && !holding && !unit.rooted && distance(unit, target) > bestVs(unit, target)) {
    const before = unit.posText, [fx, fy] = [unit.x, unit.y];
    // 「敵を最適距離で攻撃できる空きマス」（側面・背後を含む）に近づく。後衛は前衛より前に出ない
    const moved = moveUnit(unit, unit.move, advanceScorer(unit, target));
    if (moved) {
      movedBefore = true;
      unit.moved = true;
      log(`${unit.name} は前進した。${before} → ${unit.posText}`, unit.side);
      if (braceStrike(unit, fx, fy) || state.over) return;
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
  if (!unit.rooted && unit.rng > target.rng && distance(unit, target) < unit.best && !spearOptions(unit).length) {
    const before = unit.posText;
    if (moveUnit(unit, unit.retreat, p =>
          withinFrontLine(unit, p) ? Math.abs(nearestEnemyDist(unit, p) - unit.best) : Infinity)) {
      movedBefore = true;
      unit.moved = true;
      log(`${unit.name} は間合いを取った。${before} → ${unit.posText}`, unit.side);
    }
    target = nearestEnemy(unit);
  }

  // 射程内 → 行動ゲージが ACT_PER_ATTACK たまっている分だけ攻撃
  unit.gauge = chargedGauge(unit);
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
    // 追撃: 敵を倒して届く敵がいなくなったら、次の敵へ踏み込む（移動力の半分）
    if ((!target || distance(unit, target) > effRng(unit)) && unit.pursuitMove > 0) {
      const near = nearestEnemy(unit), before = unit.posText, [fx, fy] = [unit.x, unit.y];
      if (near && moveUnit(unit, unit.pursuitMove, advanceScorer(unit, near))) {
        log(`⚔ ${unit.name} は追撃で踏み込んだ。${before} → ${unit.posText}`, unit.side);
        if (braceStrike(unit, fx, fy) || state.over) return;
      }
      unit.pursuitMove = 0;
      target = nearestEnemy(unit);
    }
    if (!target || distance(unit, target) > effRng(unit)) break;
    unit.gauge -= ACT_PER_ATTACK;
    attacked++;
    // 二刀流剣士: すれ違い斬りで、狙う敵の向こうへ抜けながら斬る（囲まれていれば抜け出す）
    const dash = dashOptions(unit).find(o => o.target === target);
    if (dash && (alliesOf(unit).length === 0 || seenEnemies(unit).filter(e => distance(e, unit) === 1).length >= 2 || Math.random() < 0.5)) {
      if (performDash(unit, dash)) return;
      if (!unit.alive) return;
      first = false;
      continue;
    }
    // 突撃ボーナスは初撃のみ
    const bonus = charge && first ? 1 + CHARGE_BONUS_LV[lv(unit)] * charge.run : 1;
    // 強撃: 攻撃できるときに初撃へ乗せる
    let atkMult = 1;
    if (first && skillReady(unit, '強撃')) {
      useSkill(unit, '強撃');
      atkMult = SMASH_MULT;
    }
    first = false;
    // 槍兵: 突き・薙ぎ払いの方が見込みが大きければそちらを使う
    const sp = spearOptions(unit).sort((a, b) => spearValue(unit, b) - spearValue(unit, a))[0];
    if (sp && spearValue(unit, sp) > (MATCHUP[unit.type]?.[target.type] ?? 1)) {
      if (performSpear(unit, sp, atkMult)) return;
      if (!unit.alive) return;
      continue;
    }
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

  // 一撃離脱（移動 → 攻撃 → 移動）: 攻撃の後に離れる。ただし視界の外まで逃げ去らず、
  // 敵が見える間合い（視界 − 1 マス）に留まって次の攻撃を狙う（逃げ回って戦いが終わらないのを防ぐ）
  if (unit.hitAndRun && attacked > 0 && seenEnemies(unit).length) {
    const before = unit.posText;
    const keep = Math.max(2, (unit.vision ?? VISION_DEFAULT) - 1);
    if (moveUnit(unit, unit.move, p => { const d = nearestEnemyDist(unit, p); return (d < keep ? (keep - d) * 10 : (d - keep) * 3) + Math.random() * 0.1; })) {
      log(`${unit.name} は離脱した。${before} → ${unit.posText}`, unit.side);
    }
  }
}

/** 敵が1体も見えないとき: 大将は本陣で待ち、ほかは敵の本陣の方へ進む（後衛は前衛より前に出ない） */
function searchMove(unit) {
  const holding = isHolding(unit);
  if (holding || unit.rooted) {
    if (holding) log(`${unit.name} は本陣で戦況を見守っている。`, unit.side);
    return;
  }
  const goal = searchPoint(unit);
  const before = unit.posText;
  if (moveUnit(unit, unit.move, p => (withinFrontLine(unit, p) ? distance(p, goal) + Math.random() * 0.5 : Infinity))) {
    log(`${unit.name} は敵を探して進んだ。${before} → ${unit.posText}`, unit.side);
  }
}

/** 斥候（オート）: 戦わずに、最も近い見えている敵から SCOUT_KEEP マスの距離を保つ。敵が見えなければ前へ */
function scoutAct(unit) {
  const before = unit.posText;
  const seen = seenEnemies(unit).length > 0;
  const goal = searchPoint(unit);
  const score = seen
    ? p => Math.abs(nearestEnemyDist(unit, p) - SCOUT_KEEP) * 10 + (nearestEnemyDist(unit, p) < SCOUT_KEEP ? 5 : 0) + Math.random()
    : p => distance(p, goal) + Math.random() * 0.5;
  if (moveUnit(unit, unit.move, score)) log(`${unit.name} は${seen ? '敵の様子をうかがっている' : '偵察に出た'}。${before} → ${unit.posText}`, unit.side);
}

/** 暗殺者（オート）: 見えている将（大将を優先）に忍び寄って攻撃する。将が見えなければ敵の本陣の方へ */
function assassinAct(unit) {
  const isGeneral = e => e.rank === '副将' || e.rank === '総大将';
  const prey = () => {
    const gs = seenEnemies(unit).filter(isGeneral);
    return gs.find(isLeader) || gs.sort((a, b) => distance(unit, a) - distance(unit, b))[0] || null;
  };
  // 兵長以下には近づかない（見つからない間合い = 見える距離 + 1 以上を保つ）
  const exposure = p => seenEnemies(unit).filter(e => !isGeneral(e))
    .reduce((sum, e) => sum + Math.max(0, (e.traits.includes('scout') ? STEALTH_SPOT.scout : STEALTH_SPOT.base) + 1 - distance(p, e)), 0);
  let target = prey();
  if (!target || distance(unit, target) > effRng(unit)) {
    // 将が見えなければ、最後に将を見た場所 → ふつうの索敵の地点
    const lastGen = !target && Object.values(updateIntel(unit.side).seen).filter(s => s.gen)
      .sort((a, b) => (b.leader - a.leader) || distance(unit, a) - distance(unit, b))[0];
    const goal = target || lastGen || searchPoint(unit);
    const before = unit.posText, [fx, fy] = [unit.x, unit.y];
    if (moveUnit(unit, unit.move, p => distance(p, goal) + exposure(p) * 3 + Math.random() * 0.1)) {
      log(`${unit.name} は忍び寄った。${before} → ${unit.posText}`, unit.side);
      if (braceStrike(unit, fx, fy) || state.over) return;
    }
    target = prey();
  }
  unit.gauge = chargedGauge(unit);
  // 狙うのは副将以上だけ（兵長以下は相手にしない）
  while (unit.gauge >= ACT_PER_ATTACK && target && target.alive && distance(unit, target) <= effRng(unit)) {
    unit.gauge -= ACT_PER_ATTACK;
    if (performAttack(unit, target)) return;
    if (!unit.alive) return;
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
    // 霧ありのとき、見えていない敵は行動順に出さない（数や顔ぶれが分からないように。オートでも同じ）
    const shown = q.filter(u => !(state.fog && u.side === 'cpu' && !visibleTo('player', u)));
    log(`--- ターン ${state.turn} --- 行動順: ${shown.map(u => `${u.name}(${u.spd})`).join(' > ')}${shown.length < q.length ? ' ＋ 霧の中の敵' : ''}`, 'turn');
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
  // 霧ありのとき、見えない敵の動き（位置）はログに出さない（オートでも同じ）
  const fogLog = state.fog && unit.side === 'cpu';
  if (fogLog) state.logBuffer = [];
  actUnit(unit);
  if (fogLog) {
    const buf = state.logBuffer;
    state.logBuffer = null;
    const seen = !unit.alive || visibleTo('player', unit);
    for (const l of buf) if (seen || !/→|待機|阻まれ|見守|✨/.test(l.text)) log(l.text, l.cls);
  }
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
    unit.gauge = chargedGauge(unit);
    state.manual.gaugeAdded = true;
  }
  state.phase = 'attack';
}

/** 今のフェーズで止まれるマス */
/** 手動プレイで動けるマス。known = true なら見えている敵だけを考える（表示・クリック用） */
function manualReach(unit, known = false) {
  // 追撃: 敵を倒したあとは、移動力の半分だけ踏み込める（攻撃はそのまま続けられる）
  if (state.phase === 'attack' && unit.pursuitMove > 0) return reachableCells(unit, unit.pursuitMove, known);
  if (state.phase === 'move' && !unit.rooted) return reachableCells(unit, unit.move, known);
  if (state.phase === 'retreat') return reachableCells(unit, unit.move, known);
  // 一撃離脱中は、攻撃した後に移動力いっぱい動ける
  if (state.phase === 'attack' && unit.hitAndRun && state.manual.attacked > 0) return reachableCells(unit, unit.move, known);
  // 移動せずに攻撃した後は、移動力の半分まで動いて間合いを取れる
  if (state.phase === 'attack' && !state.manual.moved && state.manual.attacked > 0 && !unit.rooted) {
    return reachableCells(unit, unit.retreat, known);
  }
  return [];
}

/** 今攻撃できる敵 */
function manualTargets(unit) {
  if (state.phase !== 'move' && state.phase !== 'attack') return [];
  const gauge = state.manual.gaugeAdded ? unit.gauge : chargedGauge(unit);
  if (gauge < ACT_PER_ATTACK) return [];
  return seenEnemies(unit).filter(e => distance(unit, e) <= effRng(unit));
}

/**
 * 手動で移動したときの突撃判定。出発点から一直線に CHARGE_MIN マス以上走り、
 * その先の隣に敵がいれば突撃になる（途中に敵や敵の ZOC がないこと）。
 */
function manualCharge(unit, fromX, fromY, known = false) {
  if (!unit.traits.includes('charge')) return null;
  const dx = Math.sign(unit.x - fromX), dy = Math.sign(unit.y - fromY);
  if (dx !== 0 && dy !== 0) return null;
  const run = Math.abs(unit.x - fromX) + Math.abs(unit.y - fromY);
  if (run < CHARGE_MIN) return null;
  for (let k = 1; k < run; k++) {
    const x = fromX + dx * k, y = fromY + dy * k;
    if (enemyAt(unit, x, y, known) || inEnemyZoc(unit, x, y, known)) return null;
  }
  const ahead = enemyAt(unit, unit.x + dx, unit.y + dy, known);
  return ahead ? { run, target: ahead.id } : null;
}

function onCellClick(x, y) {
  if (deployMode()) return onDeployClick(x, y);
  const unit = currentUnit();
  if (!unit || state.over) return;
  ui2.spear = null;   // マスを押したら槍の技の表示はやめる
  const other = enemyAt(unit, x, y, true);   // 見えない敵はいないものとして扱う

  // 敵をクリック → 攻撃
  if (other) {
    if (!manualTargets(unit).includes(other)) return;
    if (state.phase === 'move') enterAttack(unit);
    manualAttack(unit, other);
    return;
  }
  // 空きマスをクリック → 移動 / 離脱（見えている範囲で選ぶ）
  if (!manualReach(unit, true).some(([cx, cy]) => cx === x && cy === y)) return;
  const before = unit.posText, fromX = unit.x, fromY = unit.y;
  // 霧の中の敵に阻まれて行けないときは、本当に行けるマスのうち目的地にいちばん近いところで止まる
  const truth = manualReach(unit);
  if (!truth.some(([cx, cy]) => cx === x && cy === y)) {
    const stop = [[unit.x, unit.y], ...truth].sort((a, b) =>
      distance({ x: a[0], y: a[1] }, { x, y }) - distance({ x: b[0], y: b[1] }, { x, y }) ||
      distance({ x: a[0], y: a[1] }, unit) - distance({ x: b[0], y: b[1] }, unit))[0];
    [x, y] = stop;
    log(`🌫 ${unit.name} は霧の中の敵に行く手を阻まれた！`, unit.side);
  }
  [unit.x, unit.y] = [x, y];
  // 槍兵の隣に踏み込んだら迎え突きを受ける（移動のログの後に出す。倒れたら行動終了）
  const braced = () => {
    if (!braceStrike(unit, fromX, fromY) && !state.over) return false;
    if (!state.over) endManual(); else render(unit);
    saveGame();
    return true;
  };
  if (state.phase === 'retreat') {
    log(`${unit.name} は離脱した。${before} → ${unit.posText}`, unit.side);
    if (braced()) return;
    endManual();
    return;
  }
  if (state.phase === 'attack' && unit.pursuitMove > 0) {
    log(`⚔ ${unit.name} は追撃で踏み込んだ。${before} → ${unit.posText}`, unit.side);
    unit.pursuitMove = 0;
    if (braced()) return;
    render(unit);
    saveGame();
    return;
  }
  if (state.phase === 'attack') {
    log(unit.hitAndRun ? `${unit.name} は離脱した。${before} → ${unit.posText}`
                       : `${unit.name} は攻撃してから間合いを取った。${before} → ${unit.posText}`, unit.side);
    if (braced()) return;
    endManual();
    return;
  }
  state.manual.moved = true;
  unit.moved = true;
  const charge = manualCharge(unit, fromX, fromY);
  if (charge) {
    state.manual.charge = charge;
    log(`🐎 ${unit.name} の突撃！ ${before} → ${unit.posText}（${charge.run}マス直進）`, unit.side);
  } else {
    log(`${unit.name} は移動した。${before} → ${unit.posText}`, unit.side);
  }
  if (braced()) return;
  enterAttack(unit);
  render(unit);
  saveGame();
}

function manualDash(unit, opt) {
  if (state.phase === 'move') enterAttack(unit);
  if (unit.gauge < ACT_PER_ATTACK) return;
  unit.gauge -= ACT_PER_ATTACK;
  state.manual.attacked++;
  state.manual.moved = true;
  if (performDash(unit, opt)) return;
  if (!unit.alive) { endManual(); return; }
  render(unit);
  saveGame();
}

function manualSpear(unit, opt) {
  ui2.spear = null;
  if (state.phase === 'move') enterAttack(unit);
  if (unit.gauge < ACT_PER_ATTACK) return;
  unit.gauge -= ACT_PER_ATTACK;
  const m = state.manual;
  const atkMult = m.smash ? SMASH_MULT : 1;
  m.smash = false;
  m.attacked++;
  if (performSpear(unit, opt, atkMult)) return;
  if (!unit.alive) { endManual(); return; }
  render(unit);
  saveGame();
}

function manualAttack(unit, target) {
  unit.gauge -= ACT_PER_ATTACK;
  const m = state.manual;
  const bonus = m.charge && m.attacked === 0 && m.charge.target === target.id ? 1 + CHARGE_BONUS_LV[lv(unit)] * m.charge.run : 1;
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
    ironWall(unit);
    enterAttack(unit);
  } else if (name === '一斉指揮') {
    const near = alliesOf(unit).filter(a => distance(a, unit) <= COMMAND_RANGE);
    for (const a of [unit, ...near]) a.buffs.push({ stat: 'atk', value: 0.3, turns: 3 }, { stat: 'def', value: 0.15, turns: 3 });
    log(`　→ 周囲${COMMAND_RANGE}マスの ${near.length + 1}体（${[unit, ...near].map(x => x.name).join('・')}）に効果`, unit.side);
    ui2.preview = null;
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
  ui2.spear = null;
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
    campaignBattle: state.campaignBattle, fog: state.fog,
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
    campaignBattle: data.campaignBattle || null, fog: data.fog ?? false, intel: null,
  });
  $('fog').checked = state.fog;
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
  if (state.logBuffer) { state.logBuffer.push({ text, cls }); return; }
  state.logs.push({ text, cls });
  if (state.logs.length > LOG_KEEP) state.logs.splice(0, state.logs.length - LOG_KEEP);
  const div = document.createElement('div');
  div.className = cls;
  div.innerHTML = fmtLog(text);
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
  const tbody = document.createElement('tbody');   // 作り終えてから差し替える（途中で表が空になってスクロールが戻らないように）
  const hidden = u => side === 'cpu' && state.fog && u.alive && !visibleTo('player', u);
  for (const u of army.units) {
    if (hidden(u)) continue;
    const tr = document.createElement('tr');
    tr.className = `rank-${u.rank}` + (u.alive ? '' : ' dead') + (u === acting ? ' acting' : '');
    const ratio = u.hp / u.maxHp;
    const color = ratio > 0.5 ? '#5c5' : ratio > 0.25 ? '#dc5' : '#d55';
    tr.innerHTML = `
      <td>${nm(u.name)}${u.troops ? `<small class="sub">(${u.troopsNow}人)</small>` : ''}</td><td>${rankName(u.rank)}</td><td>${u.type}</td>
      <td class="hp"><span class="hpbar"><div style="width:${ratio * 100}%;background:${color}"></div></span>${u.hp}/${u.maxHp}</td>
      <td>${u.atk}</td><td>${u.def}</td><td>${u.spd}</td><td>${u.rng}</td><td>${u.act}<small class="sub">(${(u.actRate / ACT_PER_ATTACK).toFixed(1)}回)</small></td><td>${u.hit}%</td><td>${u.posText}</td>`;
    tbody.appendChild(tr);
  }
  const fogged = army.units.filter(hidden).length;
  if (fogged) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="11" class="sub">🌫 霧の中に見えない敵がいる</td>`;
    tbody.appendChild(tr);
  }
  $(`${side}-units`).replaceChildren(...tbody.childNodes);
  const known = army.units.filter(u => !hidden(u));
  const alive = known.filter(u => u.alive);
  const cost = known.reduce((s, u) => s + u.cost, 0);
  const count = r => known.filter(u => u.rank === r && !u.special).length;
  const specials = k => known.filter(u => u.type === k).length;
  const troops = known.filter(u => u.troops).reduce((s, u) => s + (u.alive ? u.troopsNow : 0), 0);
  $(`${side}-summary`).textContent = !known.length ? '🌫 敵の姿は見えない' :
    [...['総大将', '副将', '兵長', '雑兵'].filter(r => count(r)).map(r => `${r === '雑兵' ? '兵士の駒' : r}${count(r)}`),
     ...['斥候', '暗殺者'].filter(specials).map(k => `${k}${specials(k)}`)].join(' / ') +
    `　兵 ${troops}人　生存 ${alive.length}/${known.length}${fogged ? '（ほかに見えない敵）' : ''}　総コスト ${cost}`;
  // 戦役の局地戦: 隊の名前と隊長。敵の隊長は姿を見るまで「？」（見えたら隊ごと覚える）
  const sq = state.campaignBattle && campaign.armies?.[side]?.squads.find(x => x.id === state.campaignBattle[side]);
  if (sq && side === 'cpu' && !sq.known) {
    const lead = memberById(campaign.armies.cpu, sq.leader);
    if (!state.fog || (lead && army.units.some(u => u.name === lead.name && visibleTo('player', u)))) {
      sq.known = true;
      const pq = campaign.armies.player.squads.find(x => x.id === state.campaignBattle.player);
      $('battle-title').textContent = `⚔ ${nm(pq?.name ?? '')} vs ${squadLabel('cpu', sq)}`;
    }
  }
  $(`${side}-dice`).textContent = sq
    ? `【${squadLabel(side, sq)}（隊長 ${side === 'cpu' && state.fog && !sq.known ? '？' : nm(memberById(campaign.armies[side], sq.leader)?.name ?? '—')}）】`
    : army.squadName
    ? `【${army.squadName}】`
    : `3d6: [${army.dice.dice.join('][')}] = ${army.dice.total}`;
}

const ui2 = { preview: null, deploySel: null, helpOpen: false, spear: null };   // spear = 範囲を表示中の槍の技（spearOptions の番号）   // preview = 範囲を表示するスキル、deploySel = 布陣で選んだ駒

/** その駒にかかっているバフの説明（例: ATK+30%・残2回） */
function buffText(u) {
  const parts = u.buffs.map(b => `${b.stat.toUpperCase()}+${Math.round(b.value * 100)}%（残${b.turns}回）`);
  if (u.rooted) parts.push('鉄壁の構え中（移動不可）');
  if (u.hitAndRun) parts.push('一撃離脱中');
  if (u.rngBonus) parts.push(`射程+${u.rngBonus}`);
  return parts.join(' / ');
}

/** 手動で (x,y) へ移動したら突撃になるか */
function chargeFrom(unit, x, y) {
  // 表示用: 動く前に見えていた敵だけ（仮に動かした先で隠れた敵が見えてしまわないように）
  const seen = new Set(enemiesOf(unit).filter(e => visibleTo(unit.side, e)).map(e => e.id));
  const [ox, oy] = [unit.x, unit.y];
  [unit.x, unit.y] = [x, y];
  const c = manualCharge(unit, ox, oy, seen);
  [unit.x, unit.y] = [ox, oy];
  return c;
}

/** 布陣の手直し中か（手動プレイで、開戦前） */
function deployMode() {
  return state.mode === 'manual' && state.player && state.cmdReady && !state.running && !state.over && state.turn === 0;
}

function inDeployZone(x, y) {
  return y >= state.map.h - DEPLOY_ROWS && y < state.map.h && x >= 0 && x < state.map.w;
}

/** 布陣の手直し: 自軍の駒を選び、自陣の空いたマスへ移す（自軍の駒をクリックすると入れ替え） */
function onDeployClick(x, y) {
  const other = unitAt(x, y);
  const sel = ui2.deploySel != null ? unitById(ui2.deploySel) : null;
  if (other && other.side === 'player' && (!sel || other === sel)) {
    ui2.deploySel = other === sel ? null : other.id;
  } else if (sel && inDeployZone(x, y)) {
    if (other && other.side === 'player') [other.x, other.y] = [sel.x, sel.y];
    if (!other || other.side === 'player') [sel.x, sel.y] = [x, y];
    ui2.deploySel = null;
    saveGame();
  } else {
    ui2.deploySel = null;
  }
  render();
}

function renderField(acting) {
  const { w, h, type, wd, hd } = state.map;
  const field = $('field');
  // 新しいマスは別の入れ物に作ってから一度に差し替える（途中で空になると、スクロール位置が先頭に戻されるため）
  const cells = document.createDocumentFragment();
  const short = u => (u.isCommander ? '★' : u.rank === '副将' ? '☆' : u.rank === '兵長' ? '◆' : '') + u.type[0];
  // 突撃になる移動先（騎兵など）と、一斉指揮の範囲
  const curU = currentUnit();
  const chargeSet = new Set(curU && state.phase === 'move' && curU.traits.includes('charge')
    ? manualReach(curU, true).filter(([x, y]) => chargeFrom(curU, x, y)).map(([x, y]) => `${x},${y}`) : []);
  const spOpt = curU && ui2.spear != null ? spearOptions(curU)[ui2.spear] : null;
  const spearCells = new Set(spOpt ? spOpt.hits.map(h => `${h.u.x},${h.u.y}`) : []);
  const cmdRange = curU && skillReady(curU, '一斉指揮') && canUseSkill(curU, '一斉指揮') && ui2.preview === '一斉指揮';
  const deploy = deployMode();
  const cur = currentUnit();
  const reach = new Set(cur ? manualReach(cur, true).map(([x, y]) => `${x},${y}`) : []);
  const targets = new Set(cur ? manualTargets(cur).map(u => u.id) : []);
  // 攻撃範囲: 今の位置と移動できるマスから届くマス（移動できるマスは青のまま、その外側を点線＋対角線で示す）
  const atkRange = new Set();
  if (cur && (state.phase === 'move' || state.phase === 'attack')
    && (state.manual.gaugeAdded ? cur.gauge : chargedGauge(cur)) >= ACT_PER_ATTACK) {
    const rng = effRng(cur);
    for (const [ox, oy] of [[cur.x, cur.y], ...reach].map(k => typeof k === 'string' ? k.split(',').map(Number) : k)) {
      for (let dx = -rng; dx <= rng; dx++) for (let dy = -(rng - Math.abs(dx)); dy <= rng - Math.abs(dx); dy++) {
        const x = ox + dx, y = oy + dy;
        if (x >= 0 && y >= 0 && x < w && y < h && !(dx === 0 && dy === 0 && ox === cur.x && oy === cur.y)) atkRange.add(`${x},${y}`);
      }
    }
    for (const k of reach) atkRange.delete(k);
    atkRange.delete(`${cur.x},${cur.y}`);
  }
  // プレイヤー軍の視界。霧ありなら、見えない敵は手動でもオートでも描かない
  const eyes = state.player.units.filter(u => u.alive);
  const inSight = (x, y) => !state.fog || eyes.some(o => Math.abs(o.x - x) + Math.abs(o.y - y) <= (o.vision ?? VISION_DEFAULT));
  // マップの外側も描いて、画面いっぱいに続いているように見せる（入れない）。戦域図と同じ
  const fw = $('field-wrap');
  const fit = Math.min((fw.clientWidth - 12) / (w + 2), (fw.clientHeight - 12) / (h + 2));
  const oldPad = `${fieldPad.x},${fieldPad.y}`;
  fieldPad.x = fw.clientWidth && fit > 0 ? Math.max(1, Math.ceil(((fw.clientWidth - 12) / fit - w) / 2) + 1) : 0;
  fieldPad.y = fw.clientWidth && fit > 0 ? Math.max(1, Math.ceil(((fw.clientHeight - 12) / fit - h) / 2) + 1) : 0;
  if (oldPad !== `${fieldPad.x},${fieldPad.y}`) fieldCentered = null;   // 外側の段数が変わったら（画面の大きさが変わった）真ん中に合わせ直す
  field.style.gridTemplateColumns = `repeat(${w + fieldPad.x * 2}, minmax(0, 1fr))`;
  for (let y = -fieldPad.y; y < h + fieldPad.y; y++) {
    for (let x = -fieldPad.x; x < w + fieldPad.x; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) {
        const oob = document.createElement('div');
        oob.className = 'cell oob';
        const far = Math.min(6, Math.max(-x, -y, x - w + 1, y - h + 1));
        const k = 0.5 - far * 0.05;   // 離れるほど暗い（filter を使うと 2.5D 表示で描き崩れるので色で付ける）
        oob.style.background = `rgb(${Math.round(42 * k)}, ${Math.round(51 * k)}, ${Math.round(38 * k)})`;
        cells.appendChild(oob);
        continue;
      }
      let u = unitAt(x, y);
      const ghost = u && u.side === 'cpu' && !visibleTo('player', u);
      if (ghost) u = null;   // 霧の中の敵はオートでも描かない（オートで見て手動に戻す抜け道をふさぐ）
      const cell = document.createElement('div');
      cell.className = 'cell' + (u ? ` ${u.side === 'player' ? 'p' : 'c'}` : '') +
        (u && u === acting ? ' acting' : '') +
        (reach.has(`${x},${y}`) ? ' reach' : '') +
        (atkRange.has(`${x},${y}`) && !(u && u.side === 'player') ? ' atkrange' : '') +   // 味方のいるマスには出さない
        (u && targets.has(u.id) ? ' target' : '') +
        (inSight(x, y) ? '' : ' fog') + (u && ghost ? ' ghost' : '') +
        (chargeSet.has(`${x},${y}`) ? ' charge' : '') +
        (cmdRange && Math.abs(curU.x - x) + Math.abs(curU.y - y) <= COMMAND_RANGE ? ' skillrange' : '') +
        (spearCells.has(`${x},${y}`) ? ' spearhit' : '') +
        (deploy && inDeployZone(x, y) ? ' deployzone' : '') + (deploy && u && u.id === ui2.deploySel ? ' acting' : '') +
        (u && u.buffs.length ? ' buffed' : '');
      cell.dataset.x = x;
      cell.dataset.y = y;
      if (chargeSet.has(`${x},${y}`)) cell.title = '🐎 ここへ一直線に走ると突撃（初撃の威力アップ）';
      if (u) {
        cell.title = `${nm(u.name)} HP ${u.hp}/${u.maxHp}` + (u.buffs.length ? ` / ${buffText(u)}` : '');
        cell.innerHTML = `<span class="glyph"><b>${short(u)}</b></span><span class="mini-hp" style="width:${u.hp / u.maxHp * 100}%"></span>` +
          (targets.has(u.id) ? '<span class="tgt-mark">⚔</span>' : '');
      }
      cells.appendChild(cell);
    }
  }
  field.replaceChildren(cells);
  applyZoom('field');
  // 新しい戦場を開いたときは、マップが真ん中に来るようにスクロールしておく
  if (fieldCentered !== state.map && fw.clientWidth) {
    fw.scrollLeft = (fw.scrollWidth - fw.clientWidth) / 2;
    fw.scrollTop = (fw.scrollHeight - fw.clientHeight) / 2;
    fieldCentered = state.map;
    fieldJustCentered = true;
  }
  $('field-legend').innerHTML = '★将=総大将 ☆将=副将 ◆兵長<br>剣 槍 弓 盾 騎 斥=斥候 暗=暗殺者<br>青=プレイヤー 赤=CPU<br>点滅する赤枠⚔=攻撃できる敵<br>点線＋斜線=移動して攻撃が届く範囲' +
    (state.fog ? '<br>暗いマス=視界の外' : '');
  const legend = '';
  $('turn-label').textContent =
    `${type} ${w}×${h}（幅 ${MAP_MIN_W}+🎲[${wd.dice.join('][')}] / 高さ ${MAP_MIN_H}+🎲[${hd.dice.join('][')}]）` +
    (state.turn ? `　ターン ${state.turn}` : '') + legend;
}

/** 手動プレイの操作パネル */
function renderActionPanel() {
  const panel = $('action-panel');
  const unit = currentUnit();
  if (deployMode()) {
    panel.classList.remove('hidden');
    const sel = ui2.deploySel != null ? unitById(ui2.deploySel) : null;
    panel.innerHTML = `<div class="ap-head"><b>布陣</b>（開戦前に駒の位置を変えられます）</div>
      <div class="ap-hint">自軍の駒をクリック → 黄色の自陣のマスをクリックで移動（自軍の駒をクリックすると入れ替え）。終わったら上の「⚔ 戦闘開始」。
      ${sel ? `<br>選択中: <b>${sel.name}</b>（${sel.type}・移動${sel.move}・射程${sel.rng}）` : ''}</div>`;
    return;
  }
  if (!unit || state.over) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const gauge = state.manual.gaugeAdded ? unit.gauge : chargedGauge(unit);
  const hint = {
    move: '青いマスをクリックで移動（移動しないで攻撃も可）。点滅する赤枠（⚔）の敵をクリックで攻撃。',
    attack: unit.pursuitMove > 0
      ? `⚔ 追撃: 青いマスへ${unit.pursuitMove}マスまで踏み込める（攻撃は続けられる）。点滅する赤枠（⚔）の敵をクリックで攻撃。`
      : state.manual && unit.hitAndRun && state.manual.attacked > 0
      ? '点滅する赤枠（⚔）の敵をクリックで攻撃。青いマスをクリックで離脱して終了（移動力いっぱい）。'
      : state.manual && !state.manual.moved && state.manual.attacked > 0
      ? '点滅する赤枠（⚔）の敵をクリックで攻撃。青いマスをクリックで間合いを取って終了（移動力の半分まで）。'
      : '点滅する赤枠（⚔）の敵をクリックで攻撃。終わったら「行動終了」。',
    retreat: '一撃離脱: 青いマスをクリックで離脱先を選ぶ。',
  }[state.phase] || '';
  const skills = unit.skills.map(name => {
    const ready = skillReady(unit, name);
    const ok = ready && canUseSkill(unit, name);
    const wait = ready ? '' : `（あと${unit.cooldowns[name]}）`;
    return `<button class="skill" data-skill="${name}" ${ok ? '' : 'disabled'} title="${SKILLS[name].desc}">✨${name}${wait}</button>`;
  }).join('');
  // スキルの説明（スマホでは title が見えないので常に表示）と、今かかっている効果
  const skillHelp = unit.skills.map(name => `<div>✨<b>${name}</b>: ${SKILLS[name].desc}（使うと自分の行動${SKILLS[name].cooldown}回分は使えない）${
    name === '一斉指揮' ? ' <button class="small" data-preview="一斉指揮">範囲を表示</button>' : ''}</div>`).join('');
  const traitHelp = unit.traits.map(k => `<div>◇<b>${TRAITS[k].name}</b>: ${TRAIT_HELP[k] || ''}</div>`).join('');
  const nowBuff = buffText(unit);
  // 槍兵の範囲攻撃（攻撃できる回数が残っていれば）
  const canHit = (state.phase === 'move' || state.phase === 'attack') && gauge >= ACT_PER_ATTACK;
  const spOpts = canHit ? spearOptions(unit) : [];
  const dashOpts = canHit ? dashOptions(unit) : [];
  const dashBtns = dashOpts.map((o, i) => `<button class="skill" data-dash="${i}">💨すれ違い斬り${{ '0,-1': '↑', '1,0': '→', '0,1': '↓', '-1,0': '←' }[o.dir.join(',')]}（${o.target.name}）</button>`).join('');
  // 1回目のタップで盤面に当たる敵を表示、2回目（「実行」）で攻撃する
  if (ui2.spear != null && !spOpts[ui2.spear]) ui2.spear = null;
  const spearBtns = spOpts.map((o, i) => `<button class="skill ${ui2.spear === i ? 'armed' : ''}" data-spear="${i}">🔱${o.name}${dirName(unit, o)}${ui2.spear === i ? ' ▶ 実行' : ''}（${o.hits.map(h => `${h.u.name} ${Math.round(h.mult * 100)}%`).join('・')}）</button>`).join('');
  const spearHint = unit.traits.includes('spear') && canHit
    ? `<div class="ap-hint">🔱 ${spOpts.length ? '技のボタンを押すと当たる敵が黄色で光ります。もう一度押すと実行。' : ''}ふつうの攻撃は射程${effRng(unit)}の敵1体。<b>突き</b>は隣の敵の真後ろにも敵がいるとき（2体）、<b>薙ぎ払い</b>は周りのひと続きの3マス（角を含む）に敵が2体以上いるときに使えます。</div>` : '';
  panel.innerHTML = `
    <div class="ap-head"><b class="nm-${unit.side === 'player' ? 'p' : 'c'}">${nm(unit.name)}</b>（${rankName(unit.rank)}・${unit.type}）HP ${unit.hp}/${unit.maxHp}
      ／ 移動 ${unit.rooted ? '不可' : unit.move} ／ 射程 ${effRng(unit)} ／ 攻撃できる回数 ${Math.floor(gauge / ACT_PER_ATTACK)}
      ${state.manual.smash ? ' ／ 強撃 準備中' : ''}${unit.hitAndRun ? ' ／ 一撃離脱中（反撃なし・攻撃後に移動可）' : ''}${state.manual.charge ? ` ／ 突撃 ${state.manual.charge.run}マス` : ''}</div>
    <div class="ap-hint">${hint}</div>
    ${spearHint}
    ${nowBuff ? `<div class="ap-buff">効果中: ${nowBuff}</div>` : ''}
    ${skillHelp || traitHelp ? `<details class="ap-help" ${ui2.helpOpen ? 'open' : ''}><summary>スキル・能力の説明</summary>${skillHelp}${traitHelp}</details>` : ''}
    <div class="ap-buttons">
      ${state.phase === 'move' ? '<button id="ap-stay">移動しない</button>' : ''}
      ${spearBtns}
      ${dashBtns}
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
  for (const b of panel.querySelectorAll('[data-dash]')) b.onclick = () => manualDash(unit, dashOpts[+b.dataset.dash]);
  for (const b of panel.querySelectorAll('[data-spear]')) b.onclick = () => {
    const i = +b.dataset.spear;
    if (ui2.spear === i) manualSpear(unit, spOpts[i]);
    else { ui2.spear = i; render(unit); }
  };
  const help = panel.querySelector('.ap-help');
  if (help) help.ontoggle = () => { ui2.helpOpen = help.open; };
  for (const b of panel.querySelectorAll('[data-preview]')) b.onclick = () => { ui2.preview = ui2.preview ? null : b.dataset.preview; render(unit); };
}

function render(acting = null) {
  if (!state.player) return;
  const cur = currentUnit();
  if (cur) acting = cur;
  // 描き直しの途中で中身が一瞬空になり、スクロール位置が先頭に戻されるので、覚えておいて戻す
  const scrollers = [...document.querySelectorAll('#field-wrap, #log')];
  const pos = scrollers.map(el => [el.scrollTop, el.scrollLeft]);
  fieldJustCentered = false;
  renderArmy(state.player, 'player', acting);
  renderArmy(state.cpu, 'cpu', acting);
  fitArmies();
  renderField(acting);
  renderActionPanel();
  if (!fieldJustCentered) scrollers.forEach((el, i) => { el.scrollTop = pos[i][0]; el.scrollLeft = pos[i][1]; });
  placeActionPanel();
}

/** 操作パネルを、行動中の駒の近く（移動・攻撃できるマスにかぶらない所）に置く。布陣のときは右上 */
function placeActionPanel() {
  const panel = $('action-panel');
  if (!panel || panel.classList.contains('hidden')) return;
  const cur = currentUnit();
  const cell = cur && !deployMode() ? document.querySelector(`#field .cell[data-x="${cur.x}"][data-y="${cur.y}"]`) : null;
  panel.classList.toggle('corner', !cell);
  if (!cell) { panel.style.left = panel.style.top = ''; return; }
  placeFloat(panel, $('battle-stage'), cell, document.querySelectorAll('#field .cell.reach, #field .cell.target, #field .cell.charge'));
}

// ------------------------------------------------------------
// 画面の切り替え: 編成 / 戦域図（タブ）、戦闘（戦域図の上に重ねて開く）
// ------------------------------------------------------------

// ------------------------------------------------------------
// 拡大・縮小（戦場と戦域図）: 1 = 全体が収まる大きさ。ボタン・Ctrl+ホイール・2本指のピンチで変える
// ------------------------------------------------------------

const zoom = { field: 1, smap: 1 };
const fieldPad = { x: 0, y: 0 };   // 局地戦のマップの外側に描く段数（戦域図は ui.pad）
let fieldCentered = null;          // 真ん中に合わせ済みの戦場
let fieldJustCentered = false;     // この描き直しで真ん中に合わせた（スクロールを戻さない）
const ZOOM_MIN = 1, ZOOM_MAX = 4;

function applyZoom(kind) {
  const el = $(kind), wrap = $(`${kind}-wrap`);
  const map = kind === 'field' ? state.map : campaign.smap;
  if (!el || !wrap || !map || !wrap.clientWidth) return;
  // 戦域図の枠は中身に合わせて伸びる（max-height だけ決まっている）ので、今の高さではなく上限の高さに合わせる
  const maxH = parseFloat(getComputedStyle(wrap).maxHeight);
  const availH = Math.max(160, Number.isFinite(maxH) ? maxH : (wrap.clientHeight || window.innerHeight * 0.6));
  const edge = 2;   // マップの外側1段も入れて収める
  const fit = Math.min((wrap.clientWidth - 12) / (map.w + edge), (availH - 12) / (map.h + edge));   // 全体が収まるマスの大きさ
  const cell = Math.max(8, fit * zoom[kind]);
  const pad = kind === 'smap' ? (typeof ui !== 'undefined' && ui.pad) : fieldPad;
  const cols = map.w + (pad ? pad.x * 2 : 0);   // マップの外側の分も
  el.style.width = `${Math.floor(cell * cols)}px`;
  el.style.maxWidth = 'none';
  el.style.setProperty('--cell', `${cell}px`);
}

/** 拡大率を変える。(cx, cy) = 拡大の中心（画面上の座標）。省略すると表示の中央 */
function setZoom(kind, z, cx, cy) {
  const wrap = $(`${kind}-wrap`);
  if (!wrap) return;
  const r = wrap.getBoundingClientRect();
  const px = (cx ?? r.left + r.width / 2) - r.left, py = (cy ?? r.top + r.height / 2) - r.top;
  const fx = (wrap.scrollLeft + px) / (wrap.scrollWidth || 1), fy = (wrap.scrollTop + py) / (wrap.scrollHeight || 1);
  zoom[kind] = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  applyZoom(kind);
  wrap.scrollLeft = fx * wrap.scrollWidth - px;
  wrap.scrollTop = fy * wrap.scrollHeight - py;
}

function initZoom(kind) {
  const wrap = $(`${kind}-wrap`);
  if (!wrap) return;
  wrap.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;   // Ctrl（トラックパッドのピンチ）+ ホイール
    e.preventDefault();
    setZoom(kind, zoom[kind] * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);   // 指の動きの量に合わせてなめらかに
  }, { passive: false });
  // Safari のトラックパッドのピンチ（gesture イベント）。タッチのピンチは下の pointer で扱うので、そのときは使わない
  let gz = null;
  wrap.addEventListener('gesturestart', e => { e.preventDefault(); gz = pts.size >= 2 ? null : zoom[kind]; }, { passive: false });
  wrap.addEventListener('gesturechange', e => { e.preventDefault(); if (gz != null && pts.size < 2) setZoom(kind, gz * e.scale, e.clientX, e.clientY); }, { passive: false });
  wrap.addEventListener('gestureend', e => { e.preventDefault(); gz = null; }, { passive: false });
  // 指の操作は自前で扱う（touch-action: none）。1本指 = スクロール、2本指 = ピンチで拡大縮小しながら移動。
  // ブラウザのスクロールに任せると、2本目の指を置いた時点でブラウザがスクロールを始めてピンチが途切れるため
  const pts = new Map();          // pointerId → 直前の位置
  let pinch = null, dragged = 0, flick = null;
  // 端まで来てそれ以上動かせない分は、外側（ページ・局地戦の右の列など）をスクロールする
  const outer = () => { let el = wrap.parentElement; while (el && el !== document.body) { const o = getComputedStyle(el).overflowY; if ((o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight) return el; el = el.parentElement; } return null; };
  const scrollBy = (dx, dy) => {
    const [l, t] = [wrap.scrollLeft, wrap.scrollTop];
    wrap.scrollLeft -= dx; wrap.scrollTop -= dy;
    const restY = dy - (t - wrap.scrollTop);
    if (Math.abs(restY) > 0.5) { const o = outer(); if (o) o.scrollTop -= restY; else window.scrollBy(0, -restY); }
    return [l - wrap.scrollLeft, t - wrap.scrollTop];
  };
  wrap.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    if (flick) { cancelAnimationFrame(flick); flick = null; }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp, vx: 0, vy: 0 });
    if (pts.size === 1) dragged = 0;
    pinch = null;
  });
  wrap.addEventListener('pointermove', e => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y, dt = Math.max(1, e.timeStamp - p.t);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp, vx: dx / dt, vy: dy / dt });
    dragged += Math.abs(dx) + Math.abs(dy);
    if (pts.size === 1) { scrollBy(dx, dy); return; }
    if (pts.size !== 2) return;
    const [a, b] = [...pts.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    if (!pinch) { pinch = { dist, z: zoom[kind], cx, cy }; return; }
    setZoom(kind, pinch.z * dist / pinch.dist, cx, cy);
    wrap.scrollLeft -= cx - pinch.cx; wrap.scrollTop -= cy - pinch.cy;   // 2本指のまま動かすと移動も
    pinch.cx = cx; pinch.cy = cy;
  });
  const end = e => {
    const p = pts.get(e.pointerId);
    pts.delete(e.pointerId);
    pinch = null;
    // 1本指で払ったら、少しだけ慣性で流す
    if (p && !pts.size && e.type === 'pointerup' && e.timeStamp - p.t < 80 && Math.hypot(p.vx, p.vy) > 0.3) {
      let vx = p.vx * 16, vy = p.vy * 16;
      const step = () => { const [mx, my] = scrollBy(vx, vy); vx *= 0.92; vy *= 0.92; flick = (Math.hypot(vx, vy) > 0.5 && (mx || my)) ? requestAnimationFrame(step) : null; };
      flick = requestAnimationFrame(step);
    }
  };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);
  // 指で動かした後に指を離したときのクリック（マスの選択）は無視する
  wrap.addEventListener('click', e => { if (dragged > 12) { e.stopPropagation(); e.preventDefault(); dragged = 0; } }, true);
  document.querySelectorAll(`[data-zoom-for="${kind}"] button`).forEach(b => b.addEventListener('click', () => {
    const d = b.dataset.zoom;
    setZoom(kind, d === '0' ? 1 : zoom[kind] * (d === '+' ? 1.5 : 1 / 1.5));
  }));
}

function showView(v) {
  const same = !$(`view-${v}`).classList.contains('hidden');   // 同じ画面のまま（局地戦から戻ったときなど）ならスクロール位置はそのまま
  for (const id of ['title', 'form', 'map']) $(`view-${id}`).classList.toggle('hidden', id !== v);
  if (v === 'title') $('btn-continue').classList.toggle('hidden', !campaign.armies && !campaign.setup);
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  if (!same) window.scrollTo(0, 0);
  if (v === 'map') requestAnimationFrame(() => (campaign.smap ? renderStrat() : applyZoom('smap')));   // 戦域図は画面の大きさでマップの外側の段数が決まるので描き直す
}

function setBattleOpen(open) {
  $('battle').classList.toggle('hidden', !open);
  document.body.classList.toggle('battle-open', open);
  updateButtons();
  if (open) { fitTopbar(); requestAnimationFrame(() => (state.player ? render() : applyZoom('field'))); }   // 画面の大きさでマップの外側の段数が決まるので描き直す
}

/** 局地戦の画面の「戻る」ボタン: 決着後は結果を戦域図に反映して閉じる。戦闘中はマップを見るだけ */
function onBattleClose() {
  if (campaign.smap?.pending) resolvePending();
  setBattleOpen(false);
  showView(campaign.smap ? 'map' : 'form');
  renderStrat();
}

function updateButtons() {
  const close = $('btn-battle-close');
  close.classList.toggle('hidden', !state.player);
  close.textContent = state.over ? '🗺 戦域図に戻る' : '🗺 マップを見る';
  $('btn-start').disabled = !state.player || state.running || state.over || (state.mode === 'manual' && !state.cmdReady);
  $('mode').disabled = false;   // 戦闘中でも切り替えられる（onModeChange）
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
    const upOpts = UPGRADE_STEPS.map(n => `<option value="${n}">+${n}</option>`).join('');
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
//   編成した隊どうしを局地戦で戦わせ、損害（兵の人数・倒れた将）を持ち帰る。
// ============================================================

const TROOP_DICE = { sides: 20, unit: 100 };            // 各兵種の総数 = 1d20 × 100（100〜2000人）
const GENERAL_DICE = { n: 2, sides: 4, plus: 2 };       // 副将の人数 2d4+2（4〜10人）
const SERGEANT_DICE = { n: 1, sides: 3, plus: 1 };      // 兵長の人数（兵種ごと）1d3+1（2〜4人）
const SERGEANT_LDR_DICE = { n: 1, sides: 5, plus: 1 };  // 兵長の統率力 1d5+1（2〜6）
const SCOUT_DICE = { n: 1, sides: 4, plus: 0 };         // 斥候の人数 1d4（1〜4人）
const ASSASSIN_DICE = { n: 1, sides: 4, plus: -1 };     // 暗殺者の人数 1d4−1（0〜3人。勝負をひっくり返しすぎないよう少なめ）
const PIECE_DEFAULT = 100;                               // 兵士の駒を追加するときの初期人数
const AUTO_PIECE = 100;                                  // おまかせ編成の1駒の目安の人数
const CAMPAIGN_KEY = 'dice-senki-campaign-v1';

const campaign = { armies: null, editing: null, smap: null, setup: null };   // setup = ゲーム開始の手順（setup.js）   // smap = 戦域図（strategy.js）

function rollExpr(e) {
  const r = roll(e.n, e.sides);
  return { dice: r.dice, total: r.total + e.plus };
}

function defaultBuild(ldr) {
  const b = COMMANDER_BUILDS[AUTO_BUILD];
  return { hp: b.hp, atk: b.atk, def: b.def, buy: { ...(b.buy || {}) }, skills: [...b.skills], ldr };
}

/** ダイスで新しい軍を作る（本隊だけがある状態） */
function newArmy(side, pre = null) {
  // pre = ゲーム開始の画面で振ったダイス（setup.js の rolls）。なければここで振る
  const label = side === 'player' ? 'P' : 'C';
  const totals = {}, troopDice = {}, sergeantDice = {};
  for (const t of TYPE_NAMES) {
    troopDice[t] = pre ? pre[`troop-${t}`].total : d(TROOP_DICE.sides);
    totals[t] = troopDice[t] * TROOP_DICE.unit;
  }
  const generalRoll = pre ? pre.generals : rollExpr(GENERAL_DICE);
  const generals = [{ id: `${side}-G0`, rank: '総大将', name: `${label}総大将`, build: defaultBuild(LDR_BASE + 4) }];
  let rareLeft = 1;   // レアな将は1つの軍に1人まで
  for (let i = 1; i <= generalRoll.total; i++) {
    const rare = rareLeft > 0 && Object.entries(RARE_GENERALS).find(([, r]) => d(r.chance) === 1);
    if (rare) {
      rareLeft--;
      generals.push({ id: `${side}-G${i}`, rank: '副将', name: `${label}${rare[0]}`, rare: rare[0], build: structuredClone(rare[1].build), buildName: `★${rare[0]}` });
    } else generals.push({ id: `${side}-G${i}`, rank: '副将', name: `${label}副将${i}`, build: defaultBuild(LDR_BASE + 2) });
  }
  const sergeants = [];
  for (const t of TYPE_NAMES) {
    sergeantDice[t] = pre ? pre[`sg-${t}`] : rollExpr(SERGEANT_DICE);
    for (let i = 1; i <= sergeantDice[t].total; i++) {
      sergeants.push({ id: `${side}-S${t}${i}`, type: t, name: `${label}${t}長${i}`, ldr: rollExpr(SERGEANT_LDR_DICE).total });
    }
  }
  const specials = [];
  const scoutRoll = pre ? pre.scouts : rollExpr(SCOUT_DICE), assassinRoll = pre ? pre.assassins : rollExpr(ASSASSIN_DICE);
  for (let i = 1; i <= scoutRoll.total; i++) specials.push({ id: `${side}-X斥候${i}`, kind: '斥候', name: `${label}斥候${i}` });
  for (let i = 1; i <= assassinRoll.total; i++) specials.push({ id: `${side}-X暗殺者${i}`, kind: '暗殺者', name: `${label}暗殺者${i}` });
  return {
    side, totals, troopDice, generalRoll, sergeantDice, generals, sergeants, specials, scoutRoll, assassinRoll, seq: 1, defeated: false,
    squads: [{ id: `${side}-Q0`, name: '本隊', leader: `${side}-G0`, members: [], pieces: [] }],
  };
}

function memberById(army, id) {
  return army.generals.find(g => g.id === id) || army.sergeants.find(s => s.id === id) || army.specials.find(s => s.id === id);
}

/** 将の統率力（総大将・副将は振り分け、兵長はダイス） */
function memberLdr(m) {
  if (!m || m.kind) return 0;
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

/**
 * 統率力で決まる2つの上限:
 *   率いる人数（指揮量）= 統率力 × LDR_MEN（200）人分。兵士は1人 = 1、配下の兵長 = 100人分・副将 = 150人分（階級のコストで換算: 兵長 1000 / 副将 1500 ÷ 兵士1人 10）。
 *     斥候・暗殺者は単独で動く者なので 0
 *   駒の数 = 統率力（細かく分けすぎないように）
 */
const LDR_MEN = 200;   // 統率1あたり率いられる人数（兵士の数を 1d20×100 に増やしたので 100 → 200）
const MEMBER_MEN = { '兵長': 100, '副将': 150 };
function memberUse(m) {
  if (!m || m.kind) return 0;
  return MEMBER_MEN[m.rank || '兵長'] ?? MEMBER_MEN['副将'];
}
function squadUsed(army, q) {
  return squadTroops(q) + q.members.reduce((a, id) => a + memberUse(memberById(army, id)), 0);
}
function squadMenCap(army, q) {
  return squadCap(army, q) * LDR_MEN;
}
/** 隊にあと率いられる人数分 */
function squadRoom(army, q) {
  return squadMenCap(army, q) - squadUsed(army, q);
}
/** 統率オーバー（人数か駒の数が上限を超えている） */
function overCommand(army, q) {
  return squadUsed(army, q) > squadMenCap(army, q) || q.pieces.length > squadCap(army, q);
}
/** 兵士の駒（size 人）を足せるか。足せなければ理由 */
function pieceBlock(army, q, size) {
  if (q.pieces.length >= squadCap(army, q)) return `${q.name}は駒の数が隊長の統率力（${squadCap(army, q)}）の上限です。`;
  if (size > squadRoom(army, q)) return `${q.name}が率いられるのはあと${Math.max(0, squadRoom(army, q))}人分です（隊長の統率力 × ${LDR_MEN}人）。`;
  return null;
}

/**
 * 隊の駒の数の上限 = 隊長の統率力（配下の将の統率力は足さない）。率いる人数の上限はこれ × LDR_MEN。
 * 隊長が倒れて統率力の低い将が継ぐと上限を超えることがある（統率オーバー。戦域図では移動が遅くなる予定）
 */
function squadCap(army, q) {
  return memberLdr(memberById(army, q.leader));
}

function squadKind(army, q) {
  if (q.name === '本隊') return '本隊';
  if (q.garrison) return '守備隊';
  if (q.solo) return '単独';
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
  const k = Math.max(1, Math.min(Math.round(n / target), Math.floor(n / MIN_PIECE)));   // 1駒が MIN_PIECE を割らない数に
  const base = Math.floor(n / k / 10) * 10;
  let rest = n - base * k;
  const pieces = [];
  for (let i = 0; i < k; i++) {
    const extra = Math.min(rest, Math.ceil(rest / (k - i) / 10) * 10);
    rest -= extra;
    pieces.push({ type, size: base + extra });
  }
  return pieces.filter(p => p.size >= MIN_PIECE);
}

/** おまかせ編成: 副将の半分を分隊長にして隊を作り直し、自動配置する */
function autoForm(army) {
  const main = army.squads.find(q => q.name === '本隊');
  army.squads = [main];
  // 本隊に残す副将は1人まで（統率力に余裕があるときだけ）。ほかの副将はそれぞれ分隊を率いる
  const subs = shuffled(army.generals.filter(g => g.rank === '副将'));
  const keep = squadCap(army, main) >= 7 ? 1 : 0;
  for (const g of subs.slice(keep)) {
    army.squads.push({ id: `${army.side}-Q${army.seq++}`, name: `${g.name}隊`, leader: g.id, members: [], pieces: [] });
  }
  autoFill(army);
  // 率いきれずに余った兵士は、予備の兵長が小隊を組んで率いる（同じ兵種の兵長を優先。最大 AUTO_SMALL_SQUADS 隊）
  for (let n = 0; n < AUTO_SMALL_SQUADS; n++) {
    const free = army.sergeants.filter(sg => !squadOf(army, sg.id));
    const types = TYPE_NAMES.filter(t => poolLeft(army, t) >= MIN_PIECE).sort((a, b) => poolLeft(army, b) - poolLeft(army, a));
    if (!free.length || !types.length) break;
    const sg = free.find(x => x.type === types[0]) || free.sort((a, b) => b.ldr - a.ldr)[0];
    const q = { id: `${army.side}-Q${army.seq++}`, name: `${sg.name}隊`, leader: sg.id, members: [], pieces: [] };
    army.squads.push(q);
    for (const t of [sg.type, ...types.filter(x => x !== sg.type)]) {
      const size = Math.floor(Math.min(poolLeft(army, t), squadRoom(army, q)) / 10) * 10;
      if (size >= MIN_PIECE && !pieceBlock(army, q, size)) q.pieces.push({ type: t, size });
    }
    if (!q.pieces.length) { army.squads.pop(); break; }
  }
}
const AUTO_SMALL_SQUADS = 3;
const AUTO_TROOP_SHARE = 0.75;   // おまかせ: 率いる人数のうち兵士に使う割合の目安（残りで兵長・副将を連れる）
function autoFill(army) {
  const main = army.squads.find(q => q.name === '本隊');
  for (const q of army.squads) { q.members = []; q.pieces = []; }
  const leaders = new Set(army.squads.map(q => q.leader));
  const focus = new Map();
  for (const q of army.squads) {
    const lead = memberById(army, q.leader);
    if (q === main) focus.set(q, TYPE_NAMES);
    else if (lead.rank) focus.set(q, shuffled(TYPE_NAMES).slice(0, Math.min(1 + d(3), squadCap(army, q))));
    else focus.set(q, [lead.type, ...shuffled(TYPE_NAMES.filter(t => t !== lead.type)).slice(0, Math.min(d(2), squadCap(army, q)) - 1)]);
  }
  // ① 兵士を配る目安（本隊 2 : 分隊 1 : 小隊 0.5）。率いる人数の AUTO_TROOP_SHARE までに抑える
  const weight = q => (q === main ? 2 : memberById(army, q.leader).rank ? 1 : 0.5);
  const share = new Map(army.squads.map(q => [q, {}]));
  for (const t of TYPE_NAMES) {
    const takers = army.squads.filter(q => focus.get(q).includes(t));
    const W = takers.reduce((a, q) => a + weight(q), 0);
    for (const q of takers) share.get(q)[t] = Math.floor(army.totals[t] * weight(q) / W / 10) * 10;
  }
  for (const q of army.squads) {
    const sh = share.get(q), sum = Object.values(sh).reduce((a, n) => a + n, 0);
    const limit = Math.floor(squadMenCap(army, q) * AUTO_TROOP_SHARE);
    if (sum > limit) for (const t of Object.keys(sh)) sh[t] = Math.floor(sh[t] * limit / sum / 10) * 10;
    for (const t of Object.keys(sh)) if (sh[t] < MIN_PIECE) delete sh[t];   // 1駒に満たない端数は配らず予備に（③で他の隊に回す）
  }
  const planned = q => Object.values(share.get(q)).reduce((a, n) => a + n, 0);
  const fits = (q, m) => squadMenCap(army, q) - planned(q) - q.members.reduce((a, id) => a + memberUse(memberById(army, id)), 0) >= memberUse(m);
  // ② 余った人数分に配下の将（本隊に副将、兵種の合う兵長）
  for (const g of army.generals) if (g.rank === '副将' && !leaders.has(g.id) && fits(main, g)) main.members.push(g.id);
  const freeSergeants = army.sergeants.filter(sg => !leaders.has(sg.id));
  for (const q of army.squads) {
    const lead = memberById(army, q.leader);
    for (const t of focus.get(q)) {
      if (!lead.rank && lead.type === t) continue;   // 小隊の隊長がすでにその兵種の兵長
      const i = freeSergeants.findIndex(sg => sg.type === t);
      if (i >= 0 && fits(q, freeSergeants[i])) q.members.push(freeSergeants.splice(i, 1)[0].id);
    }
  }
  army.specials.filter(x => x.kind === '斥候').forEach((x, i) => { if (i < army.squads.length) army.squads[i].members.push(x.id); });
  const hideouts = army.squads.length > 1 ? army.squads.filter(q => q !== main) : army.squads;
  army.specials.filter(x => x.kind === '暗殺者').forEach((x, i) => hideouts[i % hideouts.length].members.push(x.id));
  // ③ まだ人数分が余っていれば、予備の兵士を足す（本隊から）
  const left = Object.fromEntries(TYPE_NAMES.map(t => [t, army.totals[t] - army.squads.reduce((a, q) => a + (share.get(q)[t] || 0), 0)]));
  for (const q of [main, ...army.squads.filter(x => x !== main)]) {
    for (const t of focus.get(q)) {
      const room = squadMenCap(army, q) - planned(q) - q.members.reduce((a, id) => a + memberUse(memberById(army, id)), 0);
      const add = Math.floor(Math.min(room, left[t]) / 10) * 10;
      if (add > 0 && (share.get(q)[t] || 0) + add >= MIN_PIECE) { share.get(q)[t] = (share.get(q)[t] || 0) + add; left[t] -= add; }
    }
  }
  // ④ 駒に分ける（駒の数は統率力まで。収まらなければ駒を大きくする）
  for (const q of army.squads) {
    const cap = Math.max(1, squadCap(army, q));
    for (let target = AUTO_PIECE; ; target += 50) {
      q.pieces = Object.entries(share.get(q)).filter(([, n]) => n >= MIN_PIECE).flatMap(([t, n]) => splitPieces(t, n, target));
      if (q.pieces.length <= cap || target > 5000) break;
    }
  }
}

/** 将が倒れたときの処理（隊長が倒れた分隊は、配下の副将か兵長が継ぎ、誰もいなければ解散して兵は予備に戻る） */
function removeMember(army, id) {
  const q = squadOf(army, id);
  army.generals = army.generals.filter(g => g.id !== id);
  army.sergeants = army.sergeants.filter(s => s.id !== id);
  army.specials = army.specials.filter(s => s.id !== id);
  if (!q) return;
  if (q.leader === id) {
    if (q.name === '本隊') { army.defeated = true; return; }
    if (q.members.length) {
      // 配下の副将がいればその副将が、いなければ兵長が隊長を継ぐ
      const next = q.members.find(m => memberById(army, m)?.rank) || q.members.find(m => !memberById(army, m)?.kind);
      if (next) {
        q.members = q.members.filter(m => m !== next);
        q.leader = next;
        q.name = `${memberById(army, q.leader).name}隊`;
        return;
      }
    }
    army.squads = army.squads.filter(x => x !== q);   // 継げる将がいなければ解散（配下は予備に戻る）
  } else {
    q.members = q.members.filter(x => x !== id);
  }
}

// ------------------------------------------------------------
// 隊 → 局地戦の駒
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
  const leader = lead.rank ? new Unit(side, lead.rank, COMMANDER_TYPE, lead.name, cx, back, lead.build)
    : lead.kind ? new Unit(side, lead.kind === '暗殺者' ? '兵長' : '雑兵', lead.kind, lead.name, cx, back)
    : new Unit(side, '兵長', lead.type, lead.name, cx, back);
  leader.ref = { kind: 'member', id: lead.id };
  units.push(leader);
  const troops = [];
  for (const id of q.members) {
    const m = memberById(army, id);
    const u = m.rank ? new Unit(side, m.rank, COMMANDER_TYPE, m.name, 0, 0, m.build)
      : m.kind ? new Unit(side, m.kind === '暗殺者' ? '兵長' : '雑兵', m.kind, m.name, 0, 0)
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
  log(`⚔ 出陣: ${nm(pq.name)} vs CPU ${squadLabel('cpu', cq)}（マップ ${state.map.type} ${state.map.w}×${state.map.h}）`, 'turn');
  log('「戦闘開始」で開戦します。', 'sys');
  render();
  renderEditor();
  updateButtons();
  saveGame();
  $('battle-title').textContent = `⚔ ${nm(pq.name)} vs ${squadLabel('cpu', cq)}`;
  setBattleOpen(true);
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
  if (campaign.smap) onMapBattleEnd(msg);
}

// ------------------------------------------------------------
// 保存
// ------------------------------------------------------------

function saveCampaign() {
  const data = { v: 2, armies: campaign.armies, smap: campaign.smap, setup: campaign.setup };
  try { localStorage.setItem(CAMPAIGN_KEY, JSON.stringify(data)); } catch (e) { /* 保存できない環境では何もしない */ }
}

function loadCampaign() {
  try {
    const data = JSON.parse(localStorage.getItem(CAMPAIGN_KEY));
    // v1 は軍だけを保存していた
    const a = data && data.v === 2 ? data.armies : data;
    if (data && data.v === 2) campaign.setup = data.setup || null;
    if (!a || !a.player || !a.cpu) return;
    campaign.smap = data.v === 2 ? data.smap : null;
    // 旧版では隊の配下を sergeants と呼んでいた
    for (const army of [a.player, a.cpu]) {
      army.specials = army.specials || [];   // 斥候・暗殺者の追加前の保存データ
      for (const q of army.squads) q.members = q.members || q.sergeants || [];
    }
    campaign.armies = a;
  } catch (e) { /* 同上 */ }
}

// ------------------------------------------------------------
// 画面
// ------------------------------------------------------------

/** 自軍の画面では名前の頭の「P」を省く（CPU軍と並ぶ戦闘のログ・盤面では残す） */
function nm(name) {
  return String(name).replace(/^[PC](?=[^\sA-Za-z])/, '');
}

/**
 * 隊の表示名。霧ありのとき、敵の隊は局地戦で隊長の姿を見るまで「敵分隊イ」のような仮の名前にする
 * （隊の名前は隊長の名前なので、そのままだと誰が率いているか分かってしまう）
 */
const ALIAS_KANA = 'イロハニホヘトチリヌルヲワカヨタレソツネナラム';
function squadLabel(side, q) {
  if (!q) return '';
  if (side !== 'cpu' || !state.fog || q.known) return nm(q.name);
  if (!q.alias) {
    const A = campaign.armies.cpu, used = A.squads.filter(x => x.alias).length;
    q.alias = `敵${squadKind(A, q)}${ALIAS_KANA[used % ALIAS_KANA.length]}`;
  }
  return q.alias;
}

/** 表示用の階級名（内部の「雑兵」は「兵士」と表示する） */
function rankName(r) {
  return r === '雑兵' ? '兵士' : r;
}

/**
 * ログの1行を表示用の HTML にする。文章は同じ色で、駒・隊の名前だけ敵味方の色にする
 * （名前の頭の P / C は省き、色で見分ける）
 */
function fmtLog(text) {
  return String(text).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
    .replace(/(^|[^A-Za-z])([PC])([一-龯々ぁ-んァ-ヶー]+[0-9]*(?:隊)?)/g,
      (all, pre, side, name) => `${pre}<span class="nm-${side === 'P' ? 'p' : 'c'}">${name}</span>`);
}

let sideOpen = false;
const squadOpen = new Set();   // 広げている隊（編成の詳細を表で見る）

/** 駒を追加するときの人数の初期値: 100人。予備かあと率いられる人数がそれより少なければ、その最大 */
function pieceDefault(P, q, type) {
  const n = Math.floor(Math.min(PIECE_DEFAULT, poolLeft(P, type), Math.max(0, squadRoom(P, q))) / 10) * 10;
  return Math.max(MIN_PIECE, n);
}   // 縦向きの画面で、将・兵長の一覧を開いているか

/**
 * 隊のカードを2列に並べる。カードは左右の列に交互に入れ、列ごとに縦に積む（開いたカードの隣に空きを作らない）。
 * 1列の画面では order で元の順に戻す
 */
function squadGrid(cards) {
  const col = r => `<div class="sq-col">${cards.map((c, i) => i % 2 === r ? `<div class="sq-item" style="order:${i}">${c}</div>` : '').join('')}</div>`;
  return `<div class="squad-grid">${col(0)}${col(1)}</div>`;
}

function renderCampaign() {
  const box = $('campaign');
  if (campaign.setup && campaign.setup.step < 3) return renderSetup();
  const A = campaign.armies;
  if (!A) {
    box.innerHTML = `<div class="cp-head"><span class="sub">「🏠 タイトル」の「▶ 新しく始める」で、兵種ごとの総数・副将・兵長・斥候・暗殺者をダイスで決めます。
      そのあと本隊と分隊に割り振り（おまかせ編成も可）、「出陣」で戦域図に出ます。</span></div>`;
    return;
  }
  const P = A.player;
  const over = P.defeated || A.cpu.defeated;
  if (campaign.smap) return renderCampaignLocked();
  const usedBy = id => nm(squadOf(P, id)?.name || '予備');
  const pool = TYPE_NAMES.map(t => `<span class="chip">${t} 🎲${P.troopDice[t]} <b>${poolLeft(P, t)}</b>/${P.totals[t]}人</span>`).join('');
  const generals = P.generals.map(g => `<tr class="tap" data-act="info" data-id="${g.id}"><td>${nm(g.name)}${weaponOf(g.build) !== '刀' && !g.rare ? ` <span class="gen-weapon bow">${WEAPONS[weaponOf(g.build)].icon}${weaponOf(g.build)}</span>` : ''}</td><td>${memberLdr(g)}</td><td>${usedBy(g.id)}</td>
      <td><button class="small" data-act="edit" data-id="${g.id}">${g.rare ? '詳細' : '振り分け'}</button></td></tr>`).join('');
  const sergeants = P.sergeants.map(sg => `<tr class="tap" data-act="info" data-id="${sg.id}"><td>${nm(sg.name)}</td><td>${sg.type}</td><td>${sg.ldr}</td><td>${usedBy(sg.id)}</td></tr>`).join('');
  const specials = P.specials.map(x => `<tr class="tap" data-act="info" data-id="${x.id}"><td>${nm(x.name)}</td><td>${x.kind}</td><td>${usedBy(x.id)}</td></tr>`).join('')
    || '<tr><td colspan="3" class="sub">なし</td></tr>';
  // 隊に入れられる将（副将・兵長）と斥候・暗殺者。隊長にできるのは副将・兵長だけ
  const freeMembers = (filter, withSpecials = false) => [...P.generals.filter(g => g.rank === '副将'), ...P.sergeants, ...(withSpecials ? P.specials : [])]
    .filter(m => !squadOf(P, m.id) && filter(m));
  const squads = P.squads.map(q => {
    const lead = memberById(P, q.leader);
    const cap = squadCap(P, q);
    // 副将は、総大将か副将が率いる隊にだけ入れる（兵長が率いる小隊には兵長だけ）
    const desc = m => m.kind ? `${nm(m.name)}（${m.kind}）` : `${nm(m.name)}（${m.rank || m.type + '長'}・統率${memberLdr(m)}${memberUse(m) ? `・${memberUse(m)}人分` : ''}）`;
    const sgOpts = freeMembers(m => (!m.rank || lead?.rank) && memberUse(m) <= squadRoom(P, q), true).map(m => `<option value="${m.id}">${desc(m)}</option>`).join('');
    const star = p => P.sergeants.some(s => s.type === p.type && q.members.includes(s.id)) || (lead && !lead.rank && lead.type === p.type);
    const open = squadOpen.has(q.id);
    const head = `<div class="sq-head" data-act="sqtoggle" data-q="${q.id}"><span class="sq-arrow">${open ? '▼' : '▶'}</span>
        <b>${nm(q.name)}</b>（${squadKind(P, q)}）隊長 ${lead ? nm(lead.name) : 'なし'}
        <span class="sq-stats">率いる人数 ${squadUsed(P, q)}/${squadMenCap(P, q)}人分 ／ 駒 ${q.pieces.length}/${cap} ／ 兵 ${squadTroops(q)}人</span>
        ${overCommand(P, q) ? '<span class="warn">（統率オーバー）</span>' : ''}</div>`;
    if (!open) {
      // たたんだ状態: 中身を1行ずつ（タップで広げて編集）
      const who = q.members.map(id => nm(memberById(P, id).name)).join('・') || 'なし';
      const troops = q.pieces.map(p => `${p.type.replace('兵', '')}${p.size}${star(p) ? '★' : ''}`).join('　') || 'なし';
      return `<div class="squad closed" data-act="sqtoggle" data-q="${q.id}">${head}
        <div class="sq-sum"><span class="sub">配下の将</span> ${who}</div>
        <div class="sq-sum"><span class="sub">兵士の駒</span> ${troops}</div></div>`;
    }
    // 広げた状態: 配下の将と兵士の駒を表で（追加・外すもここで）
    const memberRows = q.members.map(id => { const m = memberById(P, id); return `<tr class="tap" data-act="info" data-id="${id}"><td>${nm(m.name)}</td><td>${m.kind || m.rank || m.type + '長'}</td>
        <td>${m.kind ? '—' : memberLdr(m)}</td><td>${memberUse(m) || '—'}</td>
        <td><button class="small x" data-act="rmsg" data-q="${q.id}" data-id="${id}">外す</button></td></tr>`; }).join('')
      || '<tr><td colspan="5" class="sub">なし</td></tr>';
    const pieceRows = q.pieces.map((p, i) => `<tr class="tap" data-act="info" data-q="${q.id}" data-i="${i}"><td>${p.type}${star(p) ? ' ★' : ''}</td><td>${p.size}人</td>
        <td><button class="small x" data-act="rmpiece" data-q="${q.id}" data-i="${i}">外す</button></td></tr>`).join('')
      || '<tr><td colspan="3" class="sub">なし</td></tr>';
    const firstType = TYPE_NAMES.find(t => poolLeft(P, t) > 0) || TYPE_NAMES[0];
    return `<div class="squad open">${head}
      ${q.name !== '本隊' ? `<div><button class="small" data-act="disband" data-q="${q.id}">この隊を解散</button></div>` : ''}
      <div class="sq-detail">
        <div><h4>配下の将</h4><table class="sq-table"><thead><tr><th>名前</th><th>役</th><th>統率</th><th>人数分</th><th></th></tr></thead><tbody>${memberRows}</tbody></table>
          ${sgOpts ? `<select data-role="sg" data-q="${q.id}"><option value="">＋ ${lead?.rank ? '副将・兵長' : '兵長'}・斥候・暗殺者を追加…</option>${sgOpts}</select>` : ''}</div>
        <div><h4>兵士の駒</h4><table class="sq-table"><thead><tr><th>兵種</th><th>人数</th><th></th></tr></thead><tbody>${pieceRows}</tbody></table>
          <div class="sq-add">
            <select data-role="ptype" data-q="${q.id}">${TYPE_NAMES.map(t => `<option ${t === firstType ? 'selected' : ''}>${t}</option>`).join('')}</select>
            <input type="number" data-role="psize" data-q="${q.id}" min="${MIN_PIECE}" step="10" value="${pieceDefault(P, q, firstType)}">人
            <button class="small" data-act="addpiece" data-q="${q.id}" ${pieceBlock(P, q, MIN_PIECE) ? 'disabled' : ''}>＋ 駒を追加</button>
          </div></div>
      </div>
      <div class="sub">★=同じ兵種の兵長がこの隊にいる駒（戦闘中その兵長が生きている間 ATK/DEF+${SERGEANT_BUFF * 100}%）。率いる人数 = 統率力×${LDR_MEN}人分（兵士1人 = 1・兵長 ${MEMBER_MEN['兵長']}・副将 ${MEMBER_MEN['副将']}・斥候/暗殺者 0）、駒は統率力の数まで</div>
    </div>`;
  });
  const actions = `<button class="small" data-act="auto">おまかせ編成</button>
      <button class="small" data-act="fill" title="今の隊の数と隊長はそのままに、将・斥候・暗殺者・兵士を配り直します">自動配置</button>
      <button class="small go" data-act="sortie" ${over ? 'disabled' : ''} title="この編成で戦域図へ。どの隊にも入っていない斥候・暗殺者は単独で出ます">🗺 出陣</button>`;
  const leaderOpts = freeMembers(() => true).map(m => `<option value="${m.id}">${nm(m.name)}（${m.rank || m.type + '長'}・統率${memberLdr(m)}）</option>`).join('');
  box.innerHTML = `
    ${campaign.setup ? setupSteps(3, actions) : `<div class="cp-head">${actions}</div>`}
    ${over ? `<div class="cp-over">${P.defeated ? '<b class="warn">💀 自軍は敗北しました。</b>' : '<b>🏆 CPU軍に勝利しました！</b>'}
      この軍での戦いは終わりです。「🏠 タイトル」の「▶ 新しく始める」で次の戦いへ。</div>` : ''}
    <div class="cp-pool">兵力（予備 / 総数）: ${pool}
      <span class="sub">副将 🎲[${P.generalRoll.dice.join('][')}]+${GENERAL_DICE.plus} = ${P.generalRoll.total}人 ／ 兵長 ${P.sergeants.length}人
        ／ 斥候 🎲[${P.scoutRoll?.dice.join('][') ?? ''}] = ${P.specials.filter(x => x.kind === '斥候').length}人
        ／ 暗殺者 🎲[${P.assassinRoll?.dice.join('][') ?? ''}]−1 = ${P.specials.filter(x => x.kind === '暗殺者').length}人</span></div>
    <button class="side-toggle" data-act="side">👥<br>将<br>兵長</button>
    <div class="cp-main">
    <aside class="cp-side ${sideOpen ? 'open' : ''}">
    <button class="side-close small" data-act="side">✕ 閉じる</button>
    <div class="cp-cols">
      <div><h3>将</h3><table><thead><tr><th>名前</th><th>統率</th><th>所属</th><th></th></tr></thead><tbody>${generals}</tbody></table></div>
      <div><h3>兵長</h3><table><thead><tr><th>名前</th><th>兵種</th><th>統率</th><th>所属</th></tr></thead><tbody>${sergeants}</tbody></table></div>
      <div><h3>斥候・暗殺者</h3><table><thead><tr><th>名前</th><th>役職</th><th>所属</th></tr></thead><tbody>${specials}</tbody></table></div>
    </div>
    </aside>
    <div class="cp-body">
    <h3>隊</h3>
    ${squadGrid(squads)}
    <div class="sq-new">${leaderOpts ? `新しい隊（副将 → 分隊 / 兵長 → 小隊）: <select data-role="newleader"><option value="">隊長を選ぶ…</option>${leaderOpts}</select>` : '<span class="sub">隊長にできる将が残っていません</span>'}</div>
    ${state.fog
      // 視界（霧）ありでは、敵の編成は出陣前には分からない（戦域図で見つけて確かめる）
      ? '<div class="sub">CPU軍の編成は分かりません（戦域図で敵の隊を見つけると、隊の兵数が分かります）。設定で視界をオフにすると表示されます</div>'
      : `<details class="cp-cpu"><summary>CPU軍の編成（視界オフ）</summary>
      ${A.cpu.squads.map(q => `<div>${nm(q.name)}（${squadKind(A.cpu, q)}）: 配下の将${q.members.length} / ${q.pieces.map(p => `${p.type}${p.size}`).join('・')}</div>`).join('')}
    </details>`}
    </div></div>`;
  fitPool();
  if (campaign.editing) renderGeneralEditor();
}

/** 上部に貼り付く兵力の欄の高さ（サイドメニューをその下に貼り付けるため） */
function fitPool() {
  const pool = document.querySelector('#campaign .cp-pool');
  if (pool) document.documentElement.style.setProperty('--pool-h', `${pool.offsetHeight + 16}px`);
}

/** 戦域図に出たあとの編成（見るだけ） */
function renderCampaignLocked() {
  const A = campaign.armies, P = A.player;
  const tok = q => campaign.smap?.tokens.find(t => t.id === q.id);
  const cards = P.squads.map(q => {
    const lead = memberById(P, q.leader), open = squadOpen.has(q.id), t = tok(q);
    const head = `<div class="sq-head" data-act="sqtoggle" data-q="${q.id}"><span class="sq-arrow">${open ? '▼' : '▶'}</span>
      <b>${nm(q.name)}</b>（${squadKind(P, q)}）隊長 ${lead ? nm(lead.name) : 'なし'}
      <span class="sq-stats">兵 ${squadTroops(q)}人 ／ 駒 ${q.pieces.length}${t ? ` ／ 戦域図 (${t.x},${t.y})${t.acted ? '・行動済み' : ''}` : ''}</span></div>`;
    if (!open) {
      return `<div class="squad closed" data-act="sqtoggle" data-q="${q.id}">${head}
        <div class="sq-sum"><span class="sub">配下の将</span> ${q.members.map(id => nm(memberById(P, id).name)).join('・') || 'なし'}</div>
        <div class="sq-sum"><span class="sub">兵士の駒</span> ${q.pieces.map(p => `${p.type.replace('兵', '')}${p.size}`).join('　') || 'なし'}</div></div>`;
    }
    // 広げた状態: 行をタップすると、その将・駒の今の状態（人数・ステータス）を表示
    const memberRows = [q.leader, ...q.members].map(id => { const m = memberById(P, id); return `<tr class="tap" data-act="info" data-id="${id}"><td>${nm(m.name)}${id === q.leader ? ' <span class="sub">隊長</span>' : ''}</td><td>${m.kind || m.rank || m.type + '長'}</td><td>${m.kind ? '—' : memberLdr(m)}</td></tr>`; }).join('');
    const pieceRows = q.pieces.map((p, i) => `<tr class="tap" data-act="info" data-q="${q.id}" data-i="${i}"><td>${p.type}</td><td>${p.size}人</td></tr>`).join('')
      || '<tr><td colspan="2" class="sub">なし</td></tr>';
    return `<div class="squad open">${head}
      <div class="sq-detail">
        <div><h4>将</h4><table class="sq-table"><thead><tr><th>名前</th><th>役</th><th>統率</th></tr></thead><tbody>${memberRows}</tbody></table></div>
        <div><h4>兵士の駒</h4><table class="sq-table"><thead><tr><th>兵種</th><th>人数</th></tr></thead><tbody>${pieceRows}</tbody></table></div>
      </div><div class="sub">行をタップすると、今の状態を表示します</div></div>`;
  });
  $('campaign').innerHTML = `
    <div class="cp-head"><span class="sub">出陣中はここでは編成を変えられません。戦域図で自軍の砦・本陣の上か隣にいる隊を選ぶと「再編成」できます。隊をタップで開き、将・駒をタップで今の状態を確認できます。</span>
      ${P.defeated ? '<b class="warn">自軍は敗北しました</b>' : ''}${A.cpu.defeated ? '<b>🏆 CPU軍に勝利しました</b>' : ''}</div>
    <div class="cp-pool">兵力（残り）: ${TYPE_NAMES.map(t => `<span class="chip">${t} ${P.totals[t]}人</span>`).join('')}</div>
    ${squadGrid(cards)}`;
}

/**
 * 将の振り分け（ポップアップ）。1行 = 項目 / 振り分け / バー / 実際の値
 */
function renderGeneralEditor() {
  const P = campaign.armies.player;
  const g = P.generals.find(x => x.id === campaign.editing);
  const box = $('modal-body');
  if (!g || !box) return closeModal();
  const b = g.build;
  const slots = SKILL_SLOTS[g.rank];
  const skillOpts = sel => Object.entries(SKILLS).map(([k, sk]) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${k}（${sk.cost}）</option>`).join('');
  const upOpts = sel => UPGRADE_STEPS.map(n => `<option value="${n}" ${sel === n ? 'selected' : ''}>+${n}</option>`).join('');
  // bar が空なら、振り分けの欄（選択肢）をバーの欄まで広げる
  const row = (label, alloc, bar, real) => `<div class="ge-row"><div class="ge-label">${label}</div>${
    bar === '' && alloc.includes('<select') ? `<div class="ge-alloc wide">${alloc}</div>` : `<div class="ge-alloc">${alloc}</div><div class="ge-bar">${bar}</div>`}<div class="ge-real">${real}</div></div>`;
  box.innerHTML = `
    <h3>${nm(g.name)}（${g.rank}）の振り分け</h3>
    <div class="ge-head">${row('項目', '振り分け', '', '実際の値')}</div>
    ${row('HP', '<span data-v="hp"></span>', `<input type="range" data-g="hp" min="1" max="10" step="0.5" value="${b.hp}">`, '<b data-r="hp"></b>')}
    ${row('ATK', '<span data-v="atk"></span>', `<input type="range" data-g="atk" min="1" max="10" step="0.5" value="${b.atk}">`, '<b data-r="atk"></b>')}
    ${row('DEF', '<span data-v="def"></span>', `<input type="range" data-g="def" min="1" max="10" step="0.5" value="${b.def}">`, '<b data-r="def"></b>')}
    ${row('統率力', '<span data-v="ldr"></span>', `<input type="range" data-g="ldr" min="${LDR_BASE}" max="${LDR_MAX}" step="1" value="${b.ldr}">`, '<span data-r="ldr"></span>')}
    ${row('SPD 強化<div class="sub">素早さ：行動の順番・移動力</div>', `<select data-g="spd">${upOpts(b.buy?.spd || 0)}</select>`, '', '<span data-r="spd"></span>')}
    ${row('ACT 強化<div class="sub">手数：1ターンの攻撃回数</div>', `<select data-g="act">${upOpts(b.buy?.act || 0)}</select>`, '', '<span data-r="act"></span>')}
    ${row('武器', `<select data-g="weapon">${Object.entries(WEAPONS).filter(([, w]) => !w.rare).map(([k, w]) => `<option value="${k}" ${weaponOf(b) === k ? 'selected' : ''}>${w.icon} ${w.label}</option>`).join('')}</select>`, '', '<span class="sub" data-r="weapon"></span>')}
    ${row('射程 強化', `<select data-g="rng"></select>`, '', '<span data-r="rng"></span>')}
    ${row('スキル1', `<select data-g="s1">${skillOpts(b.skills[0])}</select>`, '', '<span class="sub" data-r="s1"></span>')}
    ${slots > 1 ? row('スキル2', `<select data-g="s2"><option value="">なし</option>${skillOpts(b.skills[1])}</select>`, '', '<span class="sub" data-r="s2"></span>') : ''}
    <div class="ed-preview" data-g="preview"></div>
    <div class="ed-buttons"><button data-act="edok">決定</button><button data-act="edcancel" class="off">閉じる</button></div>`;
  const v = k => box.querySelector(`[data-g="${k}"]`);
  const out = (k, html) => { const el = box.querySelector(`[data-r="${k}"]`); if (el) el.innerHTML = html; };
  const read = () => ({
    hp: +v('hp').value, atk: +v('atk').value, def: +v('def').value, ldr: +v('ldr').value,
    buy: { spd: +v('spd').value, act: +v('act').value, rng: +v('rng').value || 0 },
    weapon: v('weapon').value,
    skills: [v('s1').value, v('s2')?.value].filter(Boolean),
  });
  // 射程強化の選択肢は武器で変わる（兵種の基本値の1.5倍まで）
  const fillRng = (keep) => {
    const ty = generalType({ weapon: v('weapon').value });
    const n = maxRng(ty) - TYPES[ty].rng;
    v('rng').innerHTML = Array.from({ length: n + 1 }, (_, i) => `<option value="${i}" ${Math.min(keep, n) === i ? 'selected' : ''}>+${i}</option>`).join('');
  };
  fillRng(b.buy?.rng || 0);
  v('weapon').addEventListener('change', () => fillRng(+v('rng').value || 0));
  const preview = () => {
    const nb = read();
    const cs = commanderStats(COMMANDER_TYPE, RANKS[g.rank].cost, nb, slots);
    const share = clampShares({ hp: nb.hp, atk: nb.atk, def: nb.def });
    const tmp = new Unit('player', g.rank, COMMANDER_TYPE, '', 0, 0, nb);
    unitSeq--;
    for (const k of ['hp', 'atk', 'def']) box.querySelector(`[data-v="${k}"]`).textContent = `${Math.round(share[k] * 100)}%`;
    box.querySelector('[data-v="ldr"]').textContent = nb.ldr;
    out('hp', tmp.maxHp);
    out('atk', tmp.atk);
    out('def', tmp.def);
    out('ldr', `率いる人数 ${cs.ldr * LDR_MEN}人分・駒 ${cs.ldr}つまで${g.rank === '総大将' ? `／士気 +${Math.round((MORALE_BONUS + (cs.ldr - LDR_BASE) * MORALE_PER_LDR) * 1000) / 10}%` : ''}`);
    out('rng', `射程 ${tmp.rng}`);
    const wDiff = cs.fixedCost - commanderStats(COMMANDER_TYPE, RANKS[g.rank].cost, { ...nb, weapon: '刀' }, slots).fixedCost;
    const wTraits = (TYPES[generalType(nb)].traits || []).map(k => TRAITS[k].name).join('・');
    out('weapon', weaponOf(nb) === '刀' ? '' : `固定枠 ${wDiff >= 0 ? '+' : ''}${Math.round(wDiff)}${wTraits ? `／能力: ${wTraits}` : ''}`);
    // 強化なしの場合と並べて、強化で何が変わるかを見せる
    const base = k => { const u = new Unit('player', g.rank, COMMANDER_TYPE, '', 0, 0, { ...nb, buy: { ...nb.buy, [k]: 0 } }); unitSeq--; return u; };
    const b0 = base('spd'), a0 = base('act'), per = u => (u.actRate / ACT_PER_ATTACK).toFixed(1);
    // SPD は個体差（戦闘で +0〜20）を入れない基本値で見せる。移動力は SPD ${MOVE_DIV} ごとに +1
    const spdOf = b => commanderStats(COMMANDER_TYPE, RANKS[g.rank].cost, b, slots).stats.spd;
    const s0 = spdOf({ ...nb, buy: { ...nb.buy, spd: 0 } }), s1 = spdOf(nb);
    const mv = sp => Math.max(1, Math.ceil(sp / MOVE_DIV)) + MOVE_BONUS;
    const nextMove = Math.ceil(s1 / MOVE_DIV) * MOVE_DIV + 1 - s1;   // あといくつで移動 +1
    out('spd', `SPD ${s0} → <b>${s1}</b>／移動 ${mv(s0)} → <b>${mv(s1)}</b>
      <div class="sub">移動は SPD ${MOVE_DIV} ごとに +1（あと SPD ${nextMove} で移動 ${mv(s1) + 1}）。SPD が高いほど先に動け、攻撃を避けやすい。戦闘では個体差 +0〜20</div>`);
    out('act', `攻撃 ${per(a0)} → <b>${per(tmp)}</b> 回/ターン<div class="sub">ACT ${a0.act} → ${tmp.act}</div>`);
    out('s1', SKILLS[v('s1').value]?.desc || '');
    if (v('s2')) out('s2', SKILLS[v('s2').value]?.desc || '');
    box.querySelector('[data-g="preview"]').innerHTML =
      `コスト ${RANKS[g.rank].cost} − 固定枠 ${cs.fixedCost} − 強化 ${cs.upgradeCost} − スキル ${cs.skillCost} − 統率 ${cs.ldrCost} = <b>自由枠 ${cs.free}</b>
       <span class="sub">（HP / ATK / DEF はそれぞれ自由枠の ${ALLOC_MIN * 100}〜${ALLOC_MAX * 100}%）</span>
       ${cs.free > 0 ? '' : '<br><span class="warn">自由枠が足りません</span>'}`;
    box.querySelector('[data-act="edok"]').disabled = cs.free <= 0;
  };
  box.querySelectorAll('input, select').forEach(el => el.addEventListener('input', preview));
  box.querySelector('[data-act="edok"]').onclick = () => {
    g.build = read();
    g.buildName = 'カスタム';
    campaign.editing = null;
    closeModal();
    saveCampaign();
    renderCampaign();
  };
  box.querySelector('[data-act="edcancel"]').onclick = () => { campaign.editing = null; closeModal(); };
  $('modal').classList.remove('hidden');
  preview();
}

/** 詳細表示用の駒（個体差はちょうど真ん中の値にする） */
function sampleUnit(rank, type, build, troops) {
  const roll = d;
  d = sides => Math.ceil(sides / 2);
  try { const u = new Unit('player', rank, type, '', 0, 0, build, troops); unitSeq--; return u; } finally { d = roll; }
}

/** 編成画面: 駒・将をタップしたときの詳細（ポップアップ） */
function showUnitInfo(kind, P, a) {
  let u, title, rows = [];
  const q = a.q && P.squads.find(x => x.id === a.q);
  if (kind === 'piece') {
    const p = q.pieces[+a.i];
    u = sampleUnit('雑兵', p.type, AUTO_BUILD, p.size);
    title = `${p.type}の駒（兵士 ${p.size}人）`;
    rows.push(['所属', nm(q.name)]);
    const lead = memberById(P, q.leader);
    if (P.sergeants.some(s => s.type === p.type && q.members.includes(s.id)) || (lead && !lead.rank && lead.type === p.type)) rows.push(['★', `同じ兵種の兵長がいる（ATK/DEF+${SERGEANT_BUFF * 100}%）`]);
  } else {
    const m = memberById(P, a.id);
    const sq = squadOf(P, m.id);
    if (m.kind) { u = sampleUnit(m.kind === '暗殺者' ? '兵長' : '雑兵', m.kind); title = `${nm(m.name)}（${m.kind}）`; }
    else if (m.rank) {
      u = sampleUnit(m.rank, COMMANDER_TYPE, m.build);
      title = `${nm(m.name)}（${m.rank}${m.rare ? '・★レア' : ''}）`;
      if (m.rare) rows.push(['★レア', RARE_GENERALS[m.rare].desc]);
      rows.push(['武器', `${WEAPONS[weaponOf(m.build)].icon} ${WEAPONS[weaponOf(m.build)].label}`], ['型', m.buildName || '標準']);
    } else { u = sampleUnit('兵長', m.type); title = `${nm(m.name)}（${m.type}長）`; }
    if (!m.kind) rows.push(['統率', `${memberLdr(m)}（率いる人数 ${memberLdr(m) * LDR_MEN}人分・駒 ${memberLdr(m)}つまで）`]);
    rows.push(['所属', sq ? `${nm(sq.name)}${sq.leader === m.id ? '（隊長）' : ''}` : '予備']);
    if (memberUse(m)) rows.push(['隊で使う人数分', `${memberUse(m)}人分`]);
  }
  const per = (u.actRate / ACT_PER_ATTACK).toFixed(1);
  const stats = [['HP', u.maxHp], ['ATK', u.atk], ['DEF', u.def], ['INT', u.int || '—'], ['SPD', `${u.spd}（戦闘では個体差 ±10）`], ['移動', u.move],
    ['射程', u.rng], ['攻撃', `${per}回/ターン（ACT ${u.act}）`], ['命中', `${u.hit}%`], ['視界', `${u.vision ?? VISION_DEFAULT}マス`]];
  const skills = (u.skills || []).map(k => `<div>✨<b>${k}</b>: ${SKILLS[k].desc}</div>`).join('');
  const traits = (u.traits || []).map(k => `<div>◇<b>${TRAITS[k].name}</b>: ${TRAIT_HELP[k] || ''}</div>`).join('');
  $('modal-body').innerHTML = `<h3>${title}</h3>
    <table class="info-table">${[...rows, ...stats].map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>
    ${skills || traits ? `<div class="info-skills">${skills}${traits}</div>` : ''}
    <div class="ed-buttons"><button data-act="infoclose" class="off">閉じる</button></div>`;
  $('modal-body').querySelector('[data-act="infoclose"]').onclick = closeModal;
  $('modal').classList.remove('hidden');
}

function closeModal() {
  $('modal').classList.add('hidden');
  $('modal-body').innerHTML = '';
}

function onCampaignClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el || el.closest('#modal')) return;
  const A = campaign.armies;
  const P = A && A.player;
  const q = P && P.squads.find(x => x.id === el.dataset.q);
  switch (el.dataset.act) {
    case 'auto': autoForm(P); break;
    case 'fill': autoFill(P); break;
    case 'edit':
      if (memberById(P, el.dataset.id)?.rare) { showUnitInfo('member', P, { id: el.dataset.id }); return; }   // レアな将は振り分けできない
      campaign.editing = el.dataset.id; break;
    case 'disband': P.squads = P.squads.filter(x => x !== q); break;
    case 'rmpiece': q.pieces.splice(+el.dataset.i, 1); break;
    case 'rmsg': q.members = q.members.filter(id => id !== el.dataset.id); break;
    case 'addpiece': {
      const type = $('campaign').querySelector(`[data-role="ptype"][data-q="${q.id}"]`).value;
      const size = Math.floor(+$('campaign').querySelector(`[data-role="psize"][data-q="${q.id}"]`).value / 10) * 10;
      if (size < MIN_PIECE) return alert(`新しい駒は${MIN_PIECE}人以上です。`);
      if (size > poolLeft(P, type)) return alert(`${type}の予備は${poolLeft(P, type)}人しかいません。`);
      const why = pieceBlock(P, q, size);
      if (why) return alert(why);
      q.pieces.push({ type, size });
      break;
    }
    case 'sortie': startMapStage(); return;
    case 'info': showUnitInfo(el.dataset.i != null ? 'piece' : 'member', P, el.dataset); return;
    case 'sqtoggle':
      if (squadOpen.has(el.dataset.q)) squadOpen.delete(el.dataset.q); else squadOpen.add(el.dataset.q);
      renderCampaign();
      return;
    case 'side':   // 縦向き: 将・兵長の一覧（サイドメニュー）を出し入れする
      sideOpen = !sideOpen;
      document.querySelector('#campaign .cp-side')?.classList.toggle('open', sideOpen);
      return;
    default: return;
  }
  saveCampaign();
  renderCampaign();
}

function onCampaignChange(e) {
  const el = e.target;
  const P = campaign.armies && campaign.armies.player;
  if (!P || !el.dataset.role) return;
  if (el.dataset.role === 'ptype') {   // 兵種を変えたら、人数の初期値もその兵種の予備に合わせる
    const q = P.squads.find(x => x.id === el.dataset.q);
    const size = $('campaign').querySelector(`[data-role="psize"][data-q="${q.id}"]`);
    if (size) size.value = pieceDefault(P, q, el.value);
    return;
  }
  if (el.dataset.role === 'sg' && el.value) {
    const q = P.squads.find(x => x.id === el.dataset.q);
    if (memberUse(memberById(P, el.value)) > squadRoom(P, q)) { alert(`${q.name}が率いられるのはあと${Math.max(0, squadRoom(P, q))}人分です。`); renderCampaign(); return; }
    q.members.push(el.value);
  } else if (el.dataset.role === 'newleader' && el.value) {
    const m = memberById(P, el.value);
    const id = `player-Q${P.seq++}`;
    P.squads.push({ id, name: `${m.name}隊`, leader: m.id, members: [], pieces: [] });
    squadOpen.add(id);   // 作った隊は広げて見せる
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
$('mode').addEventListener('change', onModeChange);
// 局地戦の 2.5D 表示（試作）。オン・オフは覚えておく
{
  const apply = on => { $('battle').classList.toggle('tilt', on); $('tilt').checked = on; };
  let saved = null;
  try { saved = localStorage.getItem('battleTilt'); } catch {}
  apply(saved == null ? true : saved === '1');
  $('tilt').addEventListener('change', () => {
    apply($('tilt').checked);
    try { localStorage.setItem('battleTilt', $('tilt').checked ? '1' : '0'); } catch {}
    if (state.player) render();
  });
}

/**
 * 戦闘中のモード切り替え。手動 → オート: 手番の駒はそのまま AI が動かし、以後オート。
 * オート → 手動: 次の自軍の駒の番から手動（CPU の駒は動き続け、自軍の番で止まる）
 */
function onModeChange() {
  const mode = $('mode').value;
  if (!state.player || state.over || !state.running || state.mode === mode) { if (!state.running) state.mode = mode; return; }
  state.mode = mode;
  log(mode === 'auto' ? '⚙ オート観戦に切り替えた。' : '⚙ 手動プレイに切り替えた（次の自軍の駒の番から）。', 'turn');
  const unit = currentUnit();
  if (mode === 'auto' && unit) {
    const fresh = state.manual && !state.manual.moved && !state.manual.attacked && !state.manual.gaugeAdded && state.phase === 'move';
    ui2.spear = null;
    state.current = null; state.phase = null; state.manual = null;
    if (fresh) actUnit(unit, true);   // まだ何もしていなければ、その駒の行動を AI に任せる
    render(unit);
    saveGame();
    if (!state.over) schedule(delay());
    return;
  }
  render();
  saveGame();
}

$('btn-start').addEventListener('click', () => {
  if (!state.player || state.running || state.over) return;
  state.running = true;
  updateButtons();
  log('⚔ 開戦！', 'turn');
  saveGame();
  step();
});

$('btn-battle-close').addEventListener('click', onBattleClose);
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => {
  if (!$('battle').classList.contains('hidden')) setBattleOpen(false);   // 戦闘中にタブを押したら、局地戦の画面を下げて見る
  showView(b.dataset.view);
}));
// 局地戦の画面は上部バーの下に重ねる（上部バーの高さは画面幅で変わる）
function fitTopbar() {
  document.documentElement.style.setProperty('--topbar-h', `${document.querySelector('.topbar').offsetHeight}px`);
}
// スマホ・タブレットではスクロールのたびにアドレスバーが出入りして高さだけが変わる。
// そのたびにマップの大きさを変えると表示がずれて上に戻されるので、幅が変わったとき（回転など）だけ合わせ直す
let lastW = window.innerWidth;
// マップ（戦域図・局地戦）は画面の大きさでマップの外側の段数が決まるので、高さだけ変わったときも描き直す。
// 別のアプリから戻ったとき（一時的に大きさが変わることがある）も描き直す
let mapRefresh = null;
function refreshMaps() {
  clearTimeout(mapRefresh);
  mapRefresh = setTimeout(() => {
    if (state.player && !$('battle').classList.contains('hidden')) render();
    else if (campaign.smap && !$('view-map').classList.contains('hidden')) renderStrat();
  }, 150);
}
window.addEventListener('resize', refreshMaps);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshMaps(); });
window.addEventListener('pageshow', refreshMaps);
window.addEventListener('resize', () => {
  fitTopbar();
  if (window.innerWidth === lastW) return;
  lastW = window.innerWidth;
  fitPool();
  applyZoom('field');
  if (campaign.smap && !$('view-map').classList.contains('hidden')) renderStrat(); else applyZoom('smap');
  if (state.player && !$('battle').classList.contains('hidden')) render();
  if (typeof placeStratInfo === 'function') placeStratInfo();
});
if (typeof ResizeObserver === 'function') new ResizeObserver(fitTopbar).observe(document.querySelector('.topbar'));
fitTopbar();
initZoom('field');
initZoom('smap');
// 画面全体の拡大を止める（マップの外でのピンチ・Ctrl+ホイール・Safari のジェスチャー）。マップの上ではマップの拡大になる
document.addEventListener('wheel', e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, e => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
{ // 戦域図のログの出し入れ（開け閉めは覚えておく）
  const box = $('smap-logbox'), tab = $('smap-logtab');
  const set = closed => { box.classList.toggle('closed', closed); tab.textContent = closed ? '▶ ログ' : '◀ ログ'; };
  let saved = null;
  try { saved = localStorage.getItem('smapLogClosed'); } catch {}
  set(saved == null ? window.innerWidth < 600 : saved === '1');   // スマホ縦では最初は閉じておく
  tab.onclick = () => { const c = !box.classList.contains('closed'); set(c); try { localStorage.setItem('smapLogClosed', c ? '1' : '0'); } catch {} };
}
$('smap-wrap').addEventListener('scroll', () => { if (typeof placeStratInfo === 'function') placeStratInfo(); }, { passive: true });   // 操作の箱を選んだマスに付いていかせる

$('field').addEventListener('click', e => {
  const cell = e.target.closest('.cell');
  if (cell && cell.dataset.x != null) onCellClick(Number(cell.dataset.x), Number(cell.dataset.y));   // マップの外のマスは無視
});
$('field-wrap').addEventListener('scroll', placeActionPanel, { passive: true });
// 局地戦のログ・部隊の一覧の出し入れ（開け閉めは覚えておく）
for (const [boxId, tabId, key, label, closedDefault, openArrow, closedArrow] of [
  ['battle-logbox', 'battle-logtab', 'battleLogClosed', 'ログ', window.innerWidth < 600, '◀', '▶'],   // スマホ縦では最初は閉じておく
  ['armies-box', 'armies-tab', 'armiesClosed', '部隊', true, '▶', '◀'],
]) {
  const box = $(boxId), tab = $(tabId);
  const set = closed => { box.classList.toggle('closed', closed); tab.textContent = `${closed ? closedArrow : openArrow} ${label}`; };
  let saved = null;
  try { saved = localStorage.getItem(key); } catch {}
  set(saved == null ? closedDefault : saved === '1');
  tab.onclick = () => { const c = !box.classList.contains('closed'); set(c); try { localStorage.setItem(key, c ? '1' : '0'); } catch {} };
}
// 部隊の一覧の幅: ふだんは HP の列まで、「全部見る」で表が全部収まる幅
function fitArmies() {
  const box = $('armies-box'), body = box.querySelector('.armies-body'), th = body.querySelector('th.hp');
  $('armies-wide').textContent = box.classList.contains('wide') ? '⇤ HPまで' : '⇔ 全部見る';
  if (box.classList.contains('wide') || !th) { body.style.width = ''; return; }
  body.style.width = '';
  const right = th.getBoundingClientRect().right - body.getBoundingClientRect().left + body.scrollLeft;
  body.style.width = `${Math.ceil(right + 12)}px`;
}
try { $('armies-box').classList.toggle('wide', localStorage.getItem('armiesWide') === '1'); } catch {}
$('armies-wide').onclick = () => {
  const w = !$('armies-box').classList.contains('wide');
  $('armies-box').classList.toggle('wide', w);
  try { localStorage.setItem('armiesWide', w ? '1' : '0'); } catch {}
  fitArmies();
};

for (const id of ['advance-player', 'advance-cpu']) $(id).addEventListener('change', saveGame);
$('fog').addEventListener('change', () => {
  state.fog = $('fog').checked;
  render();
  renderStrat();
  renderCampaign();
  saveGame();
});

function reset() {
  clearTimeout(state.timer);
  Object.assign(state, {
    map: null, player: null, cpu: null, turn: 0, queue: [], running: false, over: false, result: null, timer: null,
    logs: [], cmdReady: false, current: null, phase: null, manual: null, campaignBattle: null,
    fog: $('fog').checked, logBuffer: null, intel: null,
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
  if ($('battle')) setBattleOpen(false);
  log(campaign.smap ? '戦域図で敵の隊に攻撃すると、ここで戦闘になります。' : campaign.armies ? '編成して「🗺 出陣（戦域図へ）」で戦域図に出ます。' : '「🏠 タイトル」の「▶ 新しく始める」から始めてください。');
  updateButtons();
}

// 起動時: 保存があれば続きから、なければ初期状態
loadCampaign();
renderCampaign();
if (typeof initStrategy === 'function') initStrategy();
if (typeof initSetup === 'function') initSetup();
showView(campaign.smap ? 'map' : campaign.armies || campaign.setup ? 'form' : 'title');
// 設定のパネルは、外側をタップ・クリックしたら閉じる
document.addEventListener('click', e => {
  const st = document.querySelector('.settings');
  if (st && st.open && !st.contains(e.target)) st.open = false;
});
if (loadGame()) {
  showResult();
  render();
  renderEditor();
  updateButtons();
  // 戦闘中か、結果をまだ戦域図に反映していなければ局地戦の画面を開く
  if (!state.over || campaign.smap?.pending) setBattleOpen(true);
  // 戦闘中なら自動で再開する（プレイヤーの入力待ちならそのまま待つ）
  if (state.running && !state.over && state.current == null) schedule(500);
} else {
  reset();
}
