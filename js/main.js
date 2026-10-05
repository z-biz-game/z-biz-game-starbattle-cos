// Wiring: DOM, pointer gestures, the clock, storage, and the `window.starbattle` surface the
// verification harness drives. Nothing in here decides anything about the puzzle: every verdict
// (a conflict, a satisfied unit, a solved board, the next forced cell) comes from js/engine/, and
// the harness commits through the same `tap`/`stroke` paths a pointer release does — so a scenario
// that passes here has driven the real state machine rather than a copy of it.

import { applyThemeVars, Palette, Space, Radius, Motion, setReduceMotion, prefersReducedMotion, Cell } from './theme.js';
import { Store } from './store.js';
import { Game, MODES, markName, STAR, OUT, EMPTY } from './ui/game.js';
import { BoardView, layoutFor } from './render/board.js';
import { Sound } from './audio/synth.js';
import { Anim } from './anim.js';
import * as Rules from './engine/rules.js';
import { createBoard, EMPTY as E0, STAR as S0, OUT as O0 } from './engine/board.js';
import { countSolutions, legalStarSet, UNIQUE, MANY, NONE, OVERBUDGET } from './engine/count.js';
import { makePuzzle, generate, drawOne, solutionOf, TIERS, tierFor, MIN_SIZE } from './engine/generate.js';
import { plantSolution, carveRegions, regionSizes } from './engine/regions.js';
import { makeRng, hash32, dateKey } from './engine/rng.js';

const VERSION = '1.0.0';
const $ = (s) => document.querySelector(s);
const el = {
  app: $('#app'),
  viewMenu: $('#view-menu'),
  viewGame: $('#view-game'),
  tierList: $('#tier-list'),
  recordList: $('#record-list'),
  canvas: $('#board'),
  wrap: $('#board-wrap'),
  name: $('#stat-name'),
  tier: $('#stat-tier'),
  time: $('#stat-time'),
  line: $('#state-line'),
  veil: $('#win-veil'),
  winMeta: $('#win-meta'),
  winRecord: $('#win-record'),
  hintRule: $('#hint-rule'),
  hintLine: $('#hint-line'),
  hintCount: $('#hint-count'),
  resume: $('#resume-card'),
  resumeName: $('#resume-name'),
  resumeMeta: $('#resume-meta'),
};

const view = { name: 'menu', generating: false };
let game = null;
let startedAt = 0;
let pausedMs = 0;
let paused = false; // 真暂停：时钟不再累加、定步长一步不走，不是盖一层遮罩
let preview = null;
let drag = null;
const board = new BoardView(el.canvas);

// ---------------------------------------------------------------- clock

const clock = () => {
  if (!game || !startedAt) return pausedMs;
  return pausedMs + (paused ? 0 : Math.max(0, Date.now() - startedAt));
};
const fmtTime = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// ---------------------------------------------------------------- views

function show(name) {
  view.name = name;
  el.app.dataset.view = name;
  el.viewMenu.hidden = name !== 'menu';
  el.viewGame.hidden = name !== 'game';
  draw();
  return name;
}

// ---------------------------------------------------------------- the menu

function renderMenu() {
  el.tierList.innerHTML = '';
  for (const t of TIERS) {
    const best = Store.best(t.key);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tier';
    b.dataset.tier = t.key;
    b.innerHTML = `<span class="tier-name">${t.name}</span>
      <span class="tier-meta">${t.size}×${t.size} · 实测难度 ${t.band[0]}–${t.band[1]}</span>
      <span class="tier-best mono">${best ? fmtTime(best.ms) + (best.hints ? ` · 提示${best.hints}` : '') : '未通关'}</span>`;
    b.addEventListener('click', () => begin(t.key));
    el.tierList.appendChild(b);
  }
  el.recordList.innerHTML = '';
  for (const t of TIERS) {
    const best = Store.best(t.key);
    const li = document.createElement('li');
    li.innerHTML = `<span>${t.name}</span><b class="mono">${best ? fmtTime(best.ms) : '—'}</b><i>${best ? `提示 ${best.hints} · 步数 ${best.moves}` : '还没有纪录'}</i>`;
    el.recordList.appendChild(li);
  }
  renderResumeCard();
}

function renderResumeCard() {
  const r = Store.resume();
  if (!r) {
    el.resume.hidden = true;
    return;
  }
  const tier = tierFor(r.tier);
  el.resume.hidden = false;
  el.resumeName.textContent = `未完成的 ${tier.name}`;
  el.resumeMeta.textContent = `${tier.size}×${tier.size} · 已用 ${fmtTime(r.elapsedMs)} · 提示 ${r.hints}`;
}

// ---------------------------------------------------------------- starting a board

// Generation is synchronous and, at 9×9, takes a second or two of real CPU. The paint has to
// happen before that block or the page looks frozen, so `generating` is set, one frame is given
// back to the browser, and the board is drawn when it lands.
function begin(tierKey, { seed = null, daily = false } = {}) {
  const tier = tierFor(tierKey);
  view.generating = true;
  show('game');
  el.veil.hidden = true;
  setLine(`正在画第 ${tier.size}×${tier.size} 的分割——每一局都要现证明确定唯一解，稍等。`);
  requestAnimationFrame(() => {
    const origin = seed || (daily ? `daily:${dateKey().key}:${tier.key}` : `${tier.key}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`);
    const puzzle = makePuzzle(origin, tier.key);
    view.generating = false;
    if (!puzzle) {
      setLine(`这一档暂时抽不出「唯一解且纯铅笔可推到底」的盘面——生成器重试了 40 次都失败。换一档试试。`);
      return;
    }
    adopt(puzzle, { daily });
  });
}

function adopt(puzzle, { daily = false } = {}) {
  game = new Game(puzzle);
  game.daily = daily;
  startedAt = Date.now();
  pausedMs = 0;
  paused = false;
  Anim.setPaused(false);
  Anim.clearPulse();
  Anim.win(false);
  preview = null;
  drag = null;
  el.name.textContent = daily ? `日课 · ${dateKey().key}` : puzzle.tierName;
  el.tier.textContent = `${puzzle.size}×${puzzle.size}`;
  el.hintCount.textContent = '0';
  el.veil.hidden = true;
  show('game');
  sizeCanvas();
  syncAll();
  setLine(rulesLine(puzzle));
}

function resumeSaved() {
  const r = Store.resume();
  if (!r) return false;
  const puzzle = makePuzzle(r.seed, r.tier);
  if (!puzzle) return false;
  adopt(puzzle);
  game.load(r.board);
  game.moves = Number.isInteger(r.moves) ? r.moves : 0;
  game.hints = Number.isInteger(r.hints) ? r.hints : 0;
  game.recompute();
  pausedMs = Number.isInteger(r.elapsedMs) ? r.elapsedMs : 0;
  startedAt = Date.now();
  syncAll();
  setLine('接上次的盘面继续。每一笔都可以撤销。');
  return true;
}

function flushResume() {
  if (!game || game.status === 'won' || view.name !== 'game') return;
  Store.saveResume(game.puzzle, game.st.cell, clock(), { moves: game.moves, hints: game.hints });
}

function rulesLine(puzzle) {
  return `这一盘的难度是量出来的：铅笔路径走了 ${puzzle.steps} 步、分数 ${puzzle.score}，落在这档的 ${puzzle.tier ? tierFor(puzzle.tier).band.join('–') : ''} 区间里。`;
}

// ---------------------------------------------------------------- the panel readout

function syncAll() {
  if (!game) return;
  syncPauseUI();
  const s = game.state();
  el.time.textContent = fmtTime(clock());
  $('#stat-moves').textContent = s.moves;
  $('#stat-hints').textContent = s.hints;
  el.hintCount.textContent = s.hints;
  $('#stat-stars').textContent = `${s.stars}/${s.target}`;
  $('#stat-marked').textContent = s.marked;
  $('#stat-remaining').textContent = s.remaining;
  $('#stat-units').textContent = `${s.satisfied}/${s.units}`;
  const cf = $('#stat-conflicts');
  cf.textContent = s.conflicts;
  // The number and the sentence under the board are the same verdict from the same function; only
  // its colour is a UI choice.
  cf.parentElement.classList.toggle('bad', s.conflicts > 0);
  $('#stat-score').textContent = s.score == null ? '—' : s.score;
  $('#btn-undo').disabled = !game.steps.length;
  $('#btn-prune').disabled = s.status === 'won';
  draw();
}

function setLine(text, kind = '') {
  el.line.textContent = text;
  el.line.dataset.kind = kind;
}

// The live sentence under the board. It reports the engine's *conflict* verdicts (`diagnose()`),
// never `verify()`'s list: verify() is the final check and flags every unit that does not yet hold
// two stars, which on a half-finished board is all 3N of them. Painting that in red would tell a
// player who is making normal progress that they have broken the rules — the one thing this line
// must never do.
const kindWord = (kind) => (kind === 'row' ? '行' : kind === 'col' ? '列' : '区域');

function unitProblem(ui) {
  const u = game.board.units[ui];
  const st = game.st.cell;
  const stars = u.cells.filter((t) => st[t] === STAR).length;
  const free = u.cells.filter((t) => st[t] === EMPTY).length;
  if (stars > 2) return `${u.name}里有 ${stars} 颗星，每${kindWord(u.kind)}只能 2 颗`;
  if (stars + free < 2) return `${u.name} 只剩 ${free} 格还没定，凑不满 2 颗（已有 ${stars} 颗）`;
  return `${u.name} 已经没有合法摆法：剩下没定的格两两相邻，放不下 2 颗不挨着的星`;
}

function readLine() {
  if (!game) return;
  const d = game.diag;
  if (game.status === 'won') {
    setLine('每一行、每一列、每一区都正好两颗，谁也不挨着。', 'good');
    return;
  }
  if (d.adjacent.length) {
    const pair = d.adjacent[0];
    setLine(`${game.board.cellName(pair[0])} 与 ${game.board.cellName(pair[1])} 挨着——任何两颗星都不能相邻（含斜角）。`, 'bad');
    return;
  }
  if (d.violated.size) {
    setLine(unitProblem([...d.violated][0]), 'bad');
    return;
  }
  if (game.stuck) {
    setLine('这些记号已经把自己堵死了——引擎只从线索计数出发，报出的矛盾是真的。', 'bad');
    return;
  }
  const s = game.state();
  setLine(`还差 ${s.target - s.stars} 颗星。${s.remaining} 格没定，${s.satisfied}/${s.units} 个单元已经凑满。`, 'info');
}

// ---------------------------------------------------------------- drawing

function sizeCanvas() {
  if (!game) return;
  const narrow = window.innerWidth <= 900;
  const availW = narrow ? window.innerWidth - 40 : el.wrap.clientWidth - 8;
  const availH = narrow ? Math.min(window.innerHeight * 0.55, 520) : window.innerHeight - 250;
  board.resize(game, availW, availH);
}

function draw() {
  if (!game || view.name !== 'game') return;
  board.draw(game, { pulse: Anim.pulseState(), preview, ghost: drag ? null : undefined, twinkle: Anim.twinkleAt });
}

// ---------------------------------------------------------------- pointer

// One gesture = one step: pointerdown on an empty cell paints in the current mode and *keeps*
// painting as the finger moves (a stroke that crosses several cells is still one undo), and a
// gesture that starts on a mark of this mode's kind erases instead. There is no drag-to-swap here:
// in a two-stars-per-row puzzle an accidental swap is the worst possible outcome.
el.canvas.addEventListener('pointerdown', (ev) => {
  if (!game || game.status === 'won' || paused) return;
  const t = board.hitCell(ev.clientX, ev.clientY);
  if (t < 0) return;
  el.canvas.setPointerCapture(ev.pointerId);
  const from = game.valueOf(t);
  drag = { cells: [t], seen: new Set([t]), mode: game.mode, erase: from === game.mode, moved: false };
  preview = { cells: [t] };
  ev.preventDefault();
  draw();
});

el.canvas.addEventListener('pointermove', (ev) => {
  if (!drag) return;
  const t = board.hitCell(ev.clientX, ev.clientY);
  if (t < 0 || drag.seen.has(t)) return;
  drag.seen.add(t);
  drag.cells.push(t);
  drag.moved = true;
  preview = { cells: drag.cells.slice() };
  draw();
});

function endDrag() {
  if (!drag || !game) {
    drag = null;
    preview = null;
    return;
  }
  const d = drag;
  drag = null;
  preview = null;
  const value = d.erase ? EMPTY : d.mode;
  if (d.moved) {
    const step = game.stroke(d.cells, value);
    afterStep(step, step && step.writes.length > 1 ? (d.erase ? 'erase' : 'place') : null);
  } else {
    const step = game.tap(d.cells[0], d.mode);
    afterStep(step, step && step.writes[0].to === OUT ? 'mark' : step && step.writes[0].to === EMPTY ? 'erase' : 'place');
  }
}

el.canvas.addEventListener('pointerup', endDrag);
el.canvas.addEventListener('pointercancel', () => {
  drag = null;
  preview = null;
  draw();
});
el.canvas.addEventListener('lostpointercapture', endDrag);

// ---------------------------------------------------------------- actions

function afterStep(step, soundHint) {
  if (!step) return;
  syncAll();
  readLine();
  const kind = soundHint || (step.value === OUT ? 'mark' : step.value === EMPTY ? 'erase' : 'place');
  if (Sound[kind]) Sound[kind]();
  if (game.status === 'won') onWin();
  else if (game.violated.length || game.stuck) Sound.conflict();
  flushResume();
}

function useHint() {
  if (!game || game.status === 'won' || paused) return;
  const h = game.hint();
  if (!h) return;
  if (h.conflict) {
    setLine(h.conflict, 'bad');
    Sound.conflict();
    Anim.firePulse(h.cell, Palette.error);
    el.hintRule.textContent = '提示没有扣次数';
    el.hintLine.textContent = '你的记号和线索推出来的结论冲突了：先看红框那一格。';
    syncAll();
    return;
  }
  if (h.stalled) {
    setLine(h.text, 'info');
    el.hintRule.textContent = '推完了';
    el.hintLine.textContent = h.text;
    syncAll();
    return;
  }
  Anim.firePulse(h.cell, Palette.hint, h.unit || null);
  el.hintRule.textContent = h.rule;
  el.hintLine.textContent = h.why;
  Sound.hint();
  syncAll();
  readLine();
  // 提示收官也是收官：`game.hint()` 里 commit 已经判过胜，status 此刻就是 won，但胜利结算只有
  // onWin() 一处 —— 不走它就没有遮罩、没有胜利卡，档上的 best/solve 一条也不写。用提示走完一局是
  // 正常玩法，不能是这条链上唯一没接上的一环。（afterStep 走的是同一个 if，flushResume 在 won 时
  // 自己早退，所以这里两句都保留原样。）
  if (game.status === 'won') onWin();
  flushResume();
}

function undo() {
  if (!game || paused) return;
  const step = game.undo();
  Anim.clearPulse();
  if (!step) {
    setLine('没有可撤销的一笔了。', 'info');
    return;
  }
  // 撤销能把赢下的局面退回未完成（Game.undo() 会重算 checkWin），遮罩就得跟着收起来，否则胜利卡压在
  // 一盘还有空格的棋盘上，而 #stat-stars 已经不再写着 16/16。
  if (game.status !== 'won') { el.veil.hidden = true; Anim.win(false); }
  Sound.undo();
  syncAll();
  readLine();
  flushResume();
}

function prune() {
  if (!game || game.status === 'won' || paused) return;
  const step = game.prune();
  if (!step) {
    setLine('现在还没有能白送的灰点：要么没有满额的单元，要么邻域早就灰了。', 'info');
    return;
  }
  Sound.prune();
  const n = step.writes.length;
  el.hintRule.textContent = '一键标灰（免费）';
  el.hintLine.textContent = `只靠"星的邻域"和"满额排除"两条，替你写下 ${n} 个灰点。它一颗星也不替你放。`;
  syncAll();
  readLine();
  flushResume();
}

function setMode(mode) {
  if (!game) return;
  if (!MODES.includes(mode)) return game.mode;
  game.mode = mode;
  $('#btn-mode-star').setAttribute('aria-pressed', String(mode === STAR));
  $('#btn-mode-mark').setAttribute('aria-pressed', String(mode === OUT));
  draw();
}

function onWin() {
  const ms = clock();
  const s = game.state();
  const isRecord = Store.recordBest(game.puzzle.tier, { ms, hints: s.hints, moves: s.moves, size: s.size });
  Store.recordSolve(ms, s.hints);
  Store.clearResume();
  el.veil.hidden = false;
  el.winMeta.textContent = `${game.daily ? '日课' : game.puzzle.tierName} ${s.size}×${s.size} · ${fmtTime(ms)} · 步数 ${s.moves} · 提示 ${s.hints} · 一键标灰 ${s.prunes} 次 · 实测难度 ${s.score}`;
  el.winRecord.textContent = isRecord ? '这是这一档的新纪录。' : '';
  Anim.win(true);
  Sound.win();
  setLine('每一行、每一列、每一区都正好两颗，谁也不挨着。', 'good');
  syncAll();
}

// ---------------------------------------------------------------- settings

function applySettings() {
  Sound.setEnabled(Store.setting('sound') !== false);
  setReduceMotion(Store.setting('reduceMotion') === true);
  Anim.setReduced(prefersReducedMotion());
  $('#btn-sound').textContent = `音效 ${Sound.enabled() ? '开' : '关'}`;
  $('#btn-sound').setAttribute('aria-pressed', String(Sound.enabled()));
  $('#btn-motion').textContent = `动效 ${prefersReducedMotion() ? '简' : '全'}`;
  $('#btn-motion').setAttribute('aria-pressed', String(!prefersReducedMotion()));
  document.documentElement.dataset.motion = prefersReducedMotion() ? 'reduced' : 'full';
  syncFullscreenLabel();
}

// ---------------------------------------------------------------- fullscreen

// 全屏是真进 Full Screen API，不是把容器 CSS 撑满：requestFullscreen 失败（iframe 没 allow、
// 旧浏览器、非安全上下文）时静默兜底，绝不抛红——玩家按了没反应，也比控制台一片红好。
function toggleFullscreen() {
  const root = document.documentElement;
  if (document.fullscreenElement) {
    if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
  } else if (root.requestFullscreen) {
    root.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  }
}
function syncFullscreenLabel() {
  const btn = $('#btn-fullscreen');
  if (!btn) return;
  const on = !!document.fullscreenElement;
  btn.textContent = on ? '退出全屏' : '全屏';
  btn.setAttribute('aria-pressed', String(on));
}
document.addEventListener('fullscreenchange', () => { syncFullscreenLabel(); draw(); });

// ---------------------------------------------------------------- pause

// 暂停要同时冻住三样：定步长仿真（Anim）、用时读数（clock）、以及盘面输入。
// 只盖一层半透明皮、时钟照跑，是这条判据最容易的假绿。
function syncPauseUI() {
  const b = $('#btn-pause');
  if (b) {
    b.textContent = paused ? '继续' : '暂停';
    b.setAttribute('aria-pressed', String(paused));
    b.disabled = !game || game.status === 'won';
  }
  el.app.dataset.paused = paused ? '1' : '0';
}

function togglePause(force) {
  if (!game || game.status === 'won') return false;
  const next = force === undefined ? !paused : !!force;
  if (next === paused) return false;
  if (next) pausedMs = clock();      // 先结算跑到这一刻的用时，再翻标志：clock() 认 paused，反过来会把用时抹成 0
  paused = next;
  if (paused) {
    flushResume();           // 暂停即落盘：这一局关掉标签也不会丢
  } else {
    startedAt = Date.now();  // 恢复后从这里重新起算，暂停的那几分钟不计入
  }
  Anim.setPaused(paused);
  syncPauseUI();
  setLine(paused ? '已暂停 · 按 P 或空格继续' : '继续推这一盘', paused ? 'paused' : '');
  syncAll();                 // 面板上的用时此刻读的是冻结值
  return true;
}

// ---------------------------------------------------------------- bindings

$('#btn-new').addEventListener('click', () => begin(game ? game.puzzle.tier : TIERS[1].key));
$('#btn-menu').addEventListener('click', () => {
  flushResume();
  renderMenu();
  show('menu');
});
$('#btn-menu-2').addEventListener('click', () => {
  renderMenu();
  show('menu');
});
$('#btn-again').addEventListener('click', () => begin(game.puzzle.tier));
$('#btn-pause').addEventListener('click', () => togglePause());
$('#btn-resume').addEventListener('click', () => {
  if (!resumeSaved()) {
    setLine('存档里的盘面重新生成失败，换一个。');
    begin(TIERS[1].key);
  }
});
$('#btn-daily').addEventListener('click', () => begin(TIERS[1].key, { daily: true }));
$('#btn-hint').addEventListener('click', useHint);
$('#btn-prune').addEventListener('click', prune);
$('#btn-undo').addEventListener('click', undo);
$('#btn-mode-star').addEventListener('click', () => setMode(STAR));
$('#btn-mode-mark').addEventListener('click', () => setMode(OUT));
$('#btn-sound').addEventListener('click', () => {
  Store.setSetting('sound', Sound.enabled() ? false : true);
  applySettings();
});
$('#btn-motion').addEventListener('click', () => {
  Store.setSetting('reduceMotion', prefersReducedMotion() ? false : true);
  applySettings();
});
$('#btn-fullscreen').addEventListener('click', toggleFullscreen);
$('#btn-reset').addEventListener('click', () => {
  Store.reset();
  applySettings();
  game = null;
  renderMenu();
  show('menu');
});

// 键盘面：Enter/空格 开局、P 或 空格 暂停、R 重开、M 静音、F 全屏、? 去玩法说明，
// 再加这一盘自己的 h 提示 / z 撤销 / g 一键标灰 / 1·s 放星 / 2·x 标灰。
// 'm' 原先在两种笔之间切换，现在让给静音（放星与标灰本来就有 1/s 与 2/x 直达），换笔改用 t。
window.addEventListener('keydown', (ev) => {
  const tag = ev.target && ev.target.tagName ? String(ev.target.tagName).toLowerCase() : '';
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  const k = String(ev.key || '').toLowerCase();
  // 焦点落在按钮上时，Enter/空格 是浏览器自己的"点击这个按钮"语义；这里再动一次就成一键两事。
  if (tag === 'button' && (k === 'enter' || k === ' ' || ev.code === 'Space')) return;
  if (k === ' ' || ev.code === 'Space') {
    ev.preventDefault();
    if (view.name === 'game' && game) togglePause();
    else begin(game ? game.puzzle.tier : TIERS[1].key);
  } else if (k === 'enter') {
    if (view.name !== 'game') begin(TIERS[1].key);
  } else if (k === 'p') {
    togglePause();
  } else if (k === 'r') {
    begin(game ? game.puzzle.tier : TIERS[1].key);
  } else if (k === 'h') useHint();
  else if (k === 'z') undo();
  else if (k === 'g') prune();
  else if (k === 't' && game) setMode(game.mode === STAR ? OUT : STAR);
  else if (k === '1' || k === 's') setMode(STAR);
  else if (k === '2' || k === 'x') setMode(OUT);
  else if (k === 'm') {
    Store.setSetting('sound', Sound.enabled() ? false : true);
    applySettings();
  } else if (k === 'f') toggleFullscreen();
  else if (k === '?') {
    flushResume();          // 回选档前先把这一盘落盘，玩家能从"继续"接回来
    renderMenu();
    show('menu');
  }
});

window.addEventListener('resize', () => {
  sizeCanvas();
  draw();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushResume();
});
window.addEventListener('pagehide', flushResume);
setInterval(() => {
  if (game && view.name === 'game' && game.status !== 'won') el.time.textContent = fmtTime(clock());
}, 1000);

applyThemeVars();
applySettings();
renderMenu();
Anim.start(() => draw());

// ---------------------------------------------------------------- the harness surface

window.starbattle = {
  version: VERSION,
  view: () => view.name,
  get game() {
    return game;
  },
  get puzzle() {
    return game ? game.puzzle : null;
  },
  show,
  begin,
  adopt,
  useHint,
  undo,
  prune,
  setMode,
  pause: (v) => togglePause(v),
  paused: () => paused,
  daily: () => begin(TIERS[1].key, { daily: true }),
  // The harness commits through the same paths a pointer release does.
  tap(t, mode) {
    if (!game) return null;
    const step = mode === undefined ? game.tap(t) : game.tap(t, mode);
    if (step) afterStep(step);
    return step;
  },
  stroke(cells, value) {
    if (!game) return null;
    const step = game.stroke(cells, value === undefined ? game.mode : value);
    if (step) afterStep(step);
    return step;
  },
  solveWithLogic() {
    if (!game) return null;
    const r = game.solveWithLogic();
    syncAll();
    if (game.status === 'won') onWin();
    return r;
  },
  elapsed: clock,
  state: () => (game ? { ...game.state(), elapsedMs: clock(), view: view.name } : null),
  cellAt: (x, y) => (game ? game.cellAt(x, y) : -1),
  valueOf: (t) => (game ? game.valueOf(t) : EMPTY),
  markName,
  geometry: () => (game ? { geo: board.geo, layout: layoutFor(game.board.size, board.geo.w, board.geo.h), canvas: el.canvas.getBoundingClientRect() } : null),
  engine: {
    ...Rules,
    createBoard,
    countSolutions,
    legalStarSet,
    UNIQUE,
    MANY,
    NONE,
    OVERBUDGET,
    makePuzzle,
    generate,
    drawOne,
    solutionOf,
    plantSolution,
    carveRegions,
    regionSizes,
    TIERS,
    tierFor,
    MIN_SIZE,
    Game,
    Store,
    Sound,
    theme: { ...Palette, Cell, Space, Radius, Motion },
    rng: { makeRng, hash32, dateKey },
    EMPTY: E0,
    STAR: S0,
    OUT: O0,
  },
};

// 帧率探针/自建对拍靠 window.starbattleAnim 读"动画是否随帧率漂移"：它暴露 update()（探针据此认
// 这是可推进的游戏）与一组纯由定步数推出的数值字段（steps/elapsed/ambient/pulseAlpha）——
// 同一虚拟时长下 30/60/120Hz 恒等，就是"帧率无关"的证据。老 window.starbattle 一个字段没改，CI 不受牵连。
window.starbattleAnim = Anim;
