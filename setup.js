// ============================================================
// ダイス戦記 - ゲーム開始の手順（タイトル → ① 戦力のダイス → ② 将の設定 → ③ 初期編成 → 出陣）
//   main.js より先に読み込む（関数の定義だけ。呼ばれるのは main.js の読み込み後）
// ============================================================

/** ① で振るダイスの一覧 */
function setupRows() {
  return [
    ...TYPE_NAMES.map(t => ({ key: `troop-${t}`, group: '兵士', label: `${t}`, expr: { n: 1, sides: TROOP_DICE.sides, plus: 0 },
      note: `1d${TROOP_DICE.sides} × ${TROOP_DICE.unit}人`, show: r => `${r.total * TROOP_DICE.unit}人` })),
    { key: 'generals', group: '将', label: '副将', expr: GENERAL_DICE, note: '2d4 + 2人', show: r => `${r.total}人` },
    ...TYPE_NAMES.map(t => ({ key: `sg-${t}`, group: '兵長', label: `${t}長`, expr: SERGEANT_DICE, note: '1d3 + 1人', show: r => `${r.total}人` })),
    { key: 'scouts', group: '特殊', label: '斥候', expr: SCOUT_DICE, note: '1d4人', show: r => `${r.total}人` },
    { key: 'assassins', group: '特殊', label: '暗殺者', expr: ASSASSIN_DICE, note: '1d4 − 1人', show: r => `${r.total}人` },
  ];
}

const GEN_MODES = {
  random: { name: '🎲 ランダム', desc: 'ステータスとスキルをダイスで決める（1人1回）' },
  preset: { name: '📚 プリセット', desc: '用意された型から選ぶ' },
  custom: { name: '✍ カスタム', desc: 'すべて手動で振り分ける' },
};

/** 新しい戦いを始める（今の軍・戦域図・戦闘は消える） */
function startNewGame() {
  if ((campaign.armies || campaign.setup) && !confirm('今の軍・戦域図を破棄して、新しく始めますか？')) return;
  Object.assign(campaign, { armies: null, editing: null, smap: null, setup: { step: 1, rolls: {}, genMode: 'random' } });
  clearSave();
  reset();
  saveCampaign();
  renderCampaign();
  renderStrat();
  showView('form');
}

function setupSteps(cur) {
  const steps = ['① 戦力のダイス', '② 将の設定', '③ 初期編成'];
  return `<div class="steps">${steps.map((s, i) => `<span class="step ${i + 1 === cur ? 'now' : i + 1 < cur ? 'done' : ''}">${s}</span>`).join('<span class="arrow">›</span>')}
    ${cur === 3 ? '<button class="small" data-su="back2">◀ 将の設定に戻る</button>' : ''}</div>`;
}

function diceText(r) {
  return `${r.dice.map(v => `<span class="die">${v}</span>`).join('')}`;
}

function renderSetup() {
  const su = campaign.setup, box = $('campaign');
  if (su.step === 1) {
    const rows = setupRows();
    const done = rows.filter(r => su.rolls[r.key]).length;
    // 2列: 左 = 兵士・将、右 = 兵長・特殊
    const table = list => {
      let group = '';
      return `<table class="setup-dice"><tbody>${list.map(r => {
        const head = r.group !== group ? `<tr class="grp"><td colspan="4">${(group = r.group)}</td></tr>` : '';
        const res = su.rolls[r.key];
        return head + `<tr data-row="${r.key}">
          <td>${r.label}</td><td class="sub">${r.note}</td>
          <td class="roll">${res ? `${diceText(res)} <b>→ ${r.show(res)}</b>` : ''}</td>
          <td>${res ? '' : `<button class="small" data-su="roll" data-key="${r.key}">🎲 振る</button>`}</td></tr>`;
      }).join('')}</tbody></table>`;
    };
    const body = `<div class="setup-cols">${table(rows.filter(r => ['兵士', '将'].includes(r.group)))}${table(rows.filter(r => !['兵士', '将'].includes(r.group)))}</div>`;
    box.innerHTML = `${setupSteps(1)}
      <div class="cp-head"><button data-su="rollall" ${done === rows.length ? 'disabled' : ''}>🎲 まとめて振る</button>
        <span class="sub">1つずつ振るときは各行の「🎲 振る」。振ったダイスはやり直せません（${done}/${rows.length}）</span></div>
      ${body}
      <div class="cp-head"><button class="go" data-su="next1" ${done === rows.length ? '' : 'disabled'}>次へ：将の設定 ▶</button></div>`;
    return;
  }
  // ② 将の設定
  const P = campaign.armies.player;
  const mode = su.genMode;
  const presetOpts = sel => Object.keys(COMMANDER_BUILDS).map(k => `<option ${sel === k ? 'selected' : ''}>${k}</option>`).join('');
  const cards = P.generals.map(g => {
    const tmp = new Unit('player', g.rank, COMMANDER_TYPE, '', 0, 0, g.build);
    unitSeq--;
    const cs = commanderStats(COMMANDER_TYPE, RANKS[g.rank].cost, g.build, SKILL_SLOTS[g.rank]);
    const ctrl = mode === 'random'
      ? (g.rolled ? '<span class="sub">振り済み</span>' : `<button class="small" data-su="rollgen" data-id="${g.id}">🎲 振る</button>`)
      : mode === 'preset'
      ? `<select data-su-preset="${g.id}">${presetOpts(g.buildName)}</select>`
      : `<button class="small" data-act="edit" data-id="${g.id}">振り分け</button>`;
    return `<div class="gen-card"><div><b>${g.name}</b>（${g.rank}）<span class="sub">${g.buildName || '標準'}</span></div>
      <div class="gen-weapon ${g.build?.weapon === '弓' ? 'bow' : ''}">${g.build?.weapon === '弓' ? '🏹 弓（遠距離）' : '⚔ 刀（近接）'} 射程 ${tmp.rng}</div>
      <div class="sub">HP ${tmp.maxHp} / ATK ${tmp.atk} / DEF ${tmp.def} / 移動 ${tmp.move} / 統率 ${cs.ldr} / スキル ${cs.skills.join('・')}</div>
      <div>${ctrl}</div></div>`;
  }).join('');
  box.innerHTML = `${setupSteps(2)}
    <div class="cp-head">${Object.entries(GEN_MODES).map(([k, m]) =>
      `<button class="${k === mode ? '' : 'off'}" data-su="mode" data-mode="${k}" title="${m.desc}">${m.name}</button>`).join('')}
      <span class="sub">${GEN_MODES[mode].desc}</span></div>
    ${mode === 'random' ? `<div class="cp-head"><button data-su="rollgenall">🎲 まだの将をまとめて振る</button></div>` : ''}
    ${mode === 'preset' ? `<div class="cp-head">全員に: <select data-su-preset="__all"><option value="">型を選ぶ…</option>${presetOpts('')}</select></div>` : ''}
    <div class="gen-cards">${cards}</div>
    <div class="cp-head"><button class="go" data-su="next2">次へ：初期編成 ▶</button></div>`;
  if (campaign.editing) renderGeneralEditor();
}

/** ダイスを転がす演出（数字がしばらく変わってから止まる）→ 結果を記録 */
function animateRolls(keys) {
  const su = campaign.setup, rows = setupRows().filter(r => keys.includes(r.key) && !su.rolls[r.key]);
  if (!rows.length) return;
  for (const r of rows) {
    const btn = $('campaign').querySelector(`[data-su="roll"][data-key="${r.key}"]`);
    if (btn) btn.disabled = true;
  }
  let n = 0;
  const timer = setInterval(() => {
    for (const r of rows) {
      const cell = $('campaign').querySelector(`tr[data-row="${r.key}"] .roll`);
      if (cell) cell.innerHTML = Array.from({ length: r.expr.n }, () => `<span class="die spin">${d(r.expr.sides)}</span>`).join('');
    }
    if (++n >= 8) {
      clearInterval(timer);
      for (const r of rows) su.rolls[r.key] = rollExpr(r.expr);
      saveCampaign();
      renderSetup();
    }
  }, 60);
}

/**
 * ランダムな将のステータス。HP・ATK・DEF の割合、強化、スキル、統率力をダイスで決める。
 * 強化やスキルにポイントを使いすぎて極端に弱くならないよう、自由枠が標準の型の 8割以上残る組み合わせが出るまで振り直す
 */
function randomBuild(rank) {
  const slots = SKILL_SLOTS[rank], cost = RANKS[rank].cost;
  const baseLdr = LDR_BASE + (rank === '総大将' ? 4 : 2);
  const std = commanderStats(COMMANDER_TYPE, cost, defaultBuild(baseLdr), slots).free;
  for (let i = 0; i < 200; i++) {
    const b = {
      hp: 1 + d(9), atk: 1 + d(9), def: 1 + d(9),
      buy: { spd: (d(3) - 1) * 10, act: (d(3) - 1) * 10 },
      skills: shuffled(Object.keys(SKILLS)).slice(0, slots > 1 && d(3) === 1 ? 2 : 1),
      ldr: baseLdr + d(5) - 3,   // 標準 ±2
      weapon: d(4) === 1 ? '弓' : '刀',   // 4人に1人くらいは弓
    };
    if (commanderStats(COMMANDER_TYPE, cost, b, slots).free >= std * 0.8) return b;
  }
  return defaultBuild(baseLdr);
}

function presetBuild(rank, name) {
  const b = COMMANDER_BUILDS[name];
  return { hp: b.hp, atk: b.atk, def: b.def, buy: { ...(b.buy || {}) }, weapon: b.weapon || '刀', skills: b.skills.slice(0, SKILL_SLOTS[rank]), ldr: LDR_BASE + (rank === '総大将' ? 4 : 2) };
}

function onSetupClick(e) {
  const el = e.target.closest('[data-su]');
  const su = campaign.setup;
  if (!el || !su) return;
  const P = campaign.armies?.player;
  switch (el.dataset.su) {
    case 'roll': animateRolls([el.dataset.key]); return;
    case 'rollall': animateRolls(setupRows().map(r => r.key)); return;
    case 'next1': {
      // 振ったダイスで自軍を作る。CPU軍はここで振って、おまかせ編成・ランダムな将にする
      campaign.armies = { player: newArmy('player', su.rolls), cpu: newArmy('cpu') };
      for (const g of campaign.armies.cpu.generals) { g.build = randomBuild(g.rank); g.buildName = 'ランダム'; }
      autoForm(campaign.armies.cpu);
      su.step = 2;
      break;
    }
    case 'mode': su.genMode = el.dataset.mode; campaign.editing = null; break;
    case 'rollgen': case 'rollgenall':
      for (const g of P.generals.filter(g => !g.rolled && (el.dataset.su === 'rollgenall' || g.id === el.dataset.id))) {
        g.build = randomBuild(g.rank);
        g.buildName = 'ランダム';
        g.rolled = true;
      }
      break;
    case 'next2':
      su.step = 3;
      campaign.editing = null;
      if (!P.squads.some(q => q.pieces.length)) autoForm(P);   // まだ何も編成していなければ、おまかせ編成から始める
      break;
    case 'back2': su.step = 2; break;
    default: return;
  }
  saveCampaign();
  renderCampaign();
}

function onSetupChange(e) {
  const el = e.target, id = el.dataset.suPreset;
  if (!id || !el.value || !campaign.setup) return;
  const P = campaign.armies.player;
  for (const g of P.generals.filter(g => id === '__all' || g.id === id)) {
    g.build = presetBuild(g.rank, el.value);
    g.buildName = el.value;
  }
  saveCampaign();
  renderCampaign();
}

function initSetup() {
  $('campaign').addEventListener('click', onSetupClick);
  $('campaign').addEventListener('change', onSetupChange);
  $('btn-new').addEventListener('click', startNewGame);
  $('btn-continue').addEventListener('click', () => showView(campaign.smap ? 'map' : 'form'));
  $('btn-title').addEventListener('click', () => showView('title'));
  // ポップアップの外側をタップしたら閉じる
  $('modal').addEventListener('click', e => { if (e.target.id === 'modal') { campaign.editing = null; closeModal(); } });
}
