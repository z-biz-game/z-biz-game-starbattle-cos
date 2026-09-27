// Browser-side scenario suite, injected by tools/playtest.cjs and run against the real page.
//
// The rule for anything asserted here: read the DOM, the geometry and the canvas pixels, not an
// internal flag. `game.status === 'won'` says what the code intended; `#win-veil`'s box, a client
// rect and a pixel say what the player got. The interesting failures in this game are exactly the
// ones where the state is right and the picture or the click is wrong — a board whose cells fall
// under 44 CSS px, a hint that rings a different cell from the one its sentence names, a save that
// replays 64 cells onto an 81-cell board, a veil that stays hit-testable after it is "hidden".
//
// window.starbattle.engine is the shipped module graph (js/main.js:540), so a scenario that passes
// here has passed on the same solver the player's hints come from — not a second copy kept for
// testing.
//
// Two things this repo does *not* have, and the assertions follow: there is no baked puzzle library
// (js/data is empty and CI has no bake step), so "every entry in the book was proved unique" cannot
// be asserted here — what can is that a board generated live is proved unique by the rule-free
// counter in js/engine/count.js. And uniqueness alone is not the shipping bar either: the pencil
// path has to finish the board, which is the generator's own acceptance test.
//
// ck(name, condition, detail) is truthiness; eq(name, got, want) is equality. Every "must equal"
// below therefore goes through eq, because `ck('超预算的盘', 0)` reads as a failure to a human and a
// pass to a boolean. A scenario whose every assertion would pass whatever the page did is worse than
// no scenario, so each one carries at least one control sample (a cell that must *not* show the thing
// the tested cell shows).
//
// Nothing here may read Math.random() or Date.now() into an expected value: the same command run
// twice has to produce the same row count and the same verdicts.

((w) => {
  const rows = [];
  const ck = (test, cond, detail) => {
    rows.push({ test, pass: !!cond, detail: cond ? '' : String(detail === undefined ? '' : detail) });
  };
  const eq = (test, got, want) => ck(test, String(got) === String(want), `got ${got} / want ${want}`);
  const report = (extra) => {
    // rows is copied, not aliased: the array is cleared below, and a live reference would hand back
    // an empty report that still reads as "0 failed".
    const out = { rows: rows.slice(), fail: rows.filter((r) => !r.pass).length, ...extra };
    rows.length = 0;
    return out;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- console / exception trap, armed before any page script runs ----------------
  // playtest.cjs installs this file with Page.addScriptToEvaluateOnNewDocument, so these listeners
  // are on the page from the very first tick: a module that fails to fetch (the root-absolute-path
  // trap on Pages) shows up here as a requesterror/unhandledrejection, not as a missing assertion.
  const errors = [];
  w.addEventListener('error', (ev) => {
    errors.push(`error: ${ev.message || ev.type} @${ev.filename || ''}:${ev.lineno || 0}`);
  }, true);
  w.addEventListener('unhandledrejection', (ev) => {
    errors.push(`rejection: ${(ev.reason && (ev.reason.message || ev.reason.toString())) || String(ev.reason)}`);
  });
  const rawConsole = w.console;
  if (rawConsole && !rawConsole.__trapped) {
    const origError = rawConsole.error.bind(rawConsole);
    const origWarn = rawConsole.warn.bind(rawConsole);
    rawConsole.error = (...a) => {
      errors.push('console.error: ' + a.map((x) => (x && x.message) || String(x)).join(' '));
      origError(...a);
    };
    rawConsole.warn = (...a) => {
      errors.push('console.warn: ' + a.map((x) => (x && x.message) || String(x)).join(' '));
      origWarn(...a);
    };
    rawConsole.__trapped = true;
  }

  const A = () => w.starbattle;
  const E = () => w.starbattle.engine;
  const TH = () => E().theme;
  const $ = (sel) => document.querySelector(sel);
  const text = (sel) => (($.call(document, sel) || {}).textContent || '').trim();
  // A node is only "gone" if nothing can be hit through it: `[hidden]` alone does not clear a
  // `display:grid` rule, and a veil that keeps its box swallows the taps meant for the board.
  const shown = (sel) => {
    const e = $(sel);
    if (!e) return false;
    return getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
  };
  const hitAt = (sel) => {
    const e = $(sel);
    if (!e) return 'no-node';
    const r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return 'no-box';
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top === e || e.contains(top) ? 'hit' : `covered-by:${top ? top.id || top.tagName : 'null'}`;
  };
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const idRoster = () => [...document.querySelectorAll('[id]')].map((e) => e.id).sort();

  // ---- opening a board through the page's own entry point -------------------------
  //
  // `begin()` paints the generating veil and only *then* draws the board inside a requestAnimationFrame
  // (js/main.js:118-135), because a master-tier draw is synchronous CPU: measured on this machine at
  // p50 1568 ms / max 4369 ms (trainee is p50 47 ms). A fixed sleep would be too short on a cold page
  // and too long everywhere else, so the readiness predicate is "the puzzle this seed produced is the
  // board on screen", polled with a bounded loop counter — a count, not a wall clock, so two runs of
  // the same command assert the same number of rows.
  async function open(tier, seed, ticks = 1200, step = 25) {
    const before = A().game;
    A().begin(tier, { seed });
    for (let i = 0; i < ticks; i++) {
      await wait(step);
      const line = text('#state-line');
      if (line.indexOf('生成器重试了') >= 0) throw new Error(`生成器拒出这一档：${tier}/${seed} —— ${line}`);
      const g = A().game;
      const p = A().puzzle;
      if (g && g !== before && p && p.originSeed === seed && p.tier === tier) {
        await wait(step); // let syncAll() land in the DOM
        return g;
      }
    }
    throw new Error(`等 ${tier}/${seed} 的盘面超时（${ticks}×${step}ms），view=${A().view()}`);
  }

  // ---- gestures through the real pointer path ------------------------------------
  // These drive the page's own pointerdown/move/up listeners (js/main.js:270-318), so a scenario that
  // paints by dispatching events has exercised hitCell, the preview and the commit — not a
  // re-implementation of them.
  function pointer(type, x, y) {
    const ev = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 7,
      isPrimary: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
    });
    A().geometry(); // ensures board.geo is the geometry the click is computed against
    $('#board').dispatchEvent(ev);
    return ev;
  }
  const geo = () => A().geometry();
  // Client coordinates of a cell centre, computed from the *rendered* canvas box and the renderer's
  // own geo — the same pair of numbers hitCell() inverts.
  function at(t) {
    const { canvas, geo: g } = geo();
    return {
      x: canvas.left + g.x + (t % g.size) * g.cell + g.cell / 2,
      y: canvas.top + g.y + (((t / g.size) | 0) * g.cell) + g.cell / 2,
      size: g.cell,
    };
  }
  async function gestureTap(t) {
    const p = at(t);
    pointer('pointerdown', p.x, p.y);
    pointer('pointerup', p.x, p.y);
    return wait(24);
  }
  async function gestureDrag(from, to) {
    const a = at(from);
    const b = at(to);
    const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (a.size / 3)));
    pointer('pointerdown', a.x, a.y);
    for (let i = 1; i <= steps; i++) {
      pointer('pointermove', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
    }
    pointer('pointerup', b.x, b.y);
    return wait(24);
  }

  // ---- pixels --------------------------------------------------------------------
  const hex = (h) => {
    const m = String(h).replace('#', '');
    return m.length < 6 ? [-1, -1, -1] : [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
  };
  const near = (p, c, tol = 10) => p.length === 3 && p.every((v, i) => Math.abs(v - c[i]) <= tol);
  const ctxOf = () => {
    const c = $('#board');
    return c.getContext('2d', { willReadFrequently: true });
  };
  function pixel(x, y) {
    const g = geo().geo;
    const d = g.dpr;
    const p = ctxOf().getImageData(Math.round(x * d), Math.round(y * d), 1, 1).data;
    return [p[0], p[1], p[2]];
  }
  // The middle of a cell: the grid lines sit on the boundaries and the star/dot glyph is only a few
  // px wide, so a ring sampled at ~0.4 cell misses all of them and reads the pulse stroke alone.
  function onPulseRect(t, color, tol, n) {
    const g = geo().geo;
    const cell = g.cell;
    const cx = (t % g.size) * cell + g.x + cell / 2;
    const cy = (((t / g.size) | 0) * cell) + g.y + cell / 2;
    const want = hex(color);
    const rad = cell * 0.4;
    let hit = 0;
    for (let k = 0; k < n; k++) {
      const ang = (k / n) * Math.PI * 2;
      if (near(pixel(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad), want, tol)) hit++;
    }
    return hit;
  }
  // Bright ink of one colour anywhere in the cell's own square.
  function inkInCell(t, color, tol) {
    const g = geo().geo;
    const d = g.dpr;
    const cell = g.cell;
    const x0 = ((t % g.size) * cell + g.x) * d;
    const y0 = ((((t / g.size) | 0) * cell) + g.y) * d;
    const box = ctxOf().getImageData(Math.round(x0), Math.round(y0), Math.round(cell * d), Math.round(cell * d)).data;
    const want = hex(color);
    let hit = 0;
    for (let k = 0; k < box.length; k += 4) {
      if (box[k + 3] > 200 && near([box[k], box[k + 1], box[k + 2]], want, tol)) hit++;
    }
    return hit;
  }

  // ==================================================================== 1. boot
  // The page comes up, its test surface is attached, and the menu is the thing on screen — with
  // every copy line that quotes the engine actually matching the engine it quotes.
  const boot = async () => {
    ck('页面挂出了可测的面 window.starbattle', !!A());
    ck('版本号是三段数字', /^\d+\.\d+\.\d+$/.test(A().version), A().version);
    const surface = ['begin', 'adopt', 'useHint', 'undo', 'prune', 'setMode', 'tap', 'stroke', 'solveWithLogic', 'state', 'valueOf', 'cellAt', 'geometry', 'markName', 'daily', 'view', 'puzzle', 'engine', 'show'];
    const missing = surface.filter((k) => A()[k] === undefined);
    eq('面上一件事都没缺', missing.join(','), '');
    eq('面上一共挂这几件', Object.keys(A()).length, 22);
    eq('开局没有盘面（还没 begin）', A().game, null);
    eq('engine 也带上了独立穷举器', [typeof E().countSolutions, typeof E().legalStarSet, typeof E().makePuzzle, typeof E().nextForced].join(','), 'function,function,function,function');
    eq('引擎的三态常数', `${E().EMPTY},${E().STAR},${E().OUT}`, '0,1,2');
    eq('穷举器的四种判决', [E().UNIQUE, E().MANY, E().NONE, E().OVERBUDGET].join(','), 'UNIQUE,MANY,NONE,OVERBUDGET');

    // ---- what the player actually sees first
    eq('首屏是选档屏', A().view(), 'menu');
    eq('#app 的 data-view 与面一致', $('#app').dataset.view, 'menu');
    ck('选档屏可见', shown('#view-menu'));
    eq('棋局屏整块藏了', shown('#view-game'), false);
    eq('藏起来的棋局屏没有命中盒', hitAt('#view-game'), 'no-box');
    eq('棋盘画布不在菜单态的命中链上', hitAt('#board'), 'no-box');
    eq('胜利遮罩默认不挡住任何东西', hitAt('#win-veil'), 'no-box');
    eq('没有存档时不摆「继续」这张卡', shown('#resume-card'), false);
    ck('画布拿得到 2d 上下文', !!ctxOf());

    // ---- the tier ladder on screen vs the ladder in the engine
    eq('档位有五级', E().TIERS.length, 5);
    const cards = [...document.querySelectorAll('#tier-list button.tier')];
    eq('选档屏渲染了五张卡', cards.length, 5);
    eq('卡上的档名与引擎同源', cards.map((b) => b.dataset.tier).join(','), E().TIERS.map((t) => t.key).join(','));
    eq('卡面文案的档名与引擎一致', cards.map((b) => b.querySelector('.tier-name').textContent).join(','), E().TIERS.map((t) => t.name).join(','));
    // Hand-written from js/engine/generate.js:219 — the ladder is size + measured band, and the
    // 8×8 floor below it is MIN_SIZE (5×5/6×6 have no legal two-star placement at all).
    eq('五档的尺寸与区间写在卡上', cards.map((b) => b.querySelector('.tier-meta').textContent).join(' | '),
      '8×8 · 实测难度 110–170 | 8×8 · 实测难度 200–250 | 8×8 · 实测难度 270–320 | 9×9 · 实测难度 240–330 | 9×9 · 实测难度 330–460');
    eq('最小可玩尺寸是 8', E().MIN_SIZE, 8);
    // The ladder is two-axis, so the naive "every band starts above the last one's end" is false and
    // must not be asserted: 熟练 is 8×8 [270,320] while 高阶 is 9×9 [240,330] — the 9×9 numbers are
    // measured on their own board and the two windows overlap by construction (tools/balance.mjs is
    // what pins the ordering, on medians 122 < 243 < 276 < 312 < 355). What *is* required of the
    // table, and what a quiet edit could break, is that bands never invert inside one size, that a
    // neighbouring window may touch but not cross its own-size neighbour, and that the ladder never
    // shrinks the board on the way up.
    eq('盘的尺寸只升不降', E().TIERS.map((t) => t.size).join(','), '8,8,8,9,9');
    eq('收边界预算只加不减', E().TIERS.map((t) => t.tightenMoves).join(','), '24,24,30,48,60');
    const sameSizeProblems = [];
    for (let i = 1; i < E().TIERS.length; i++) {
      const a = E().TIERS[i - 1];
      const b = E().TIERS[i];
      if (a.size !== b.size) continue;
      if (!(b.band[0] > a.band[0] && b.band[1] > a.band[1])) sameSizeProblems.push(`${a.key}→${b.key} 同尺寸档的区间端点没有同时上移`);
      if (b.band[0] < a.band[1]) sameSizeProblems.push(`${a.key}→${b.key} 的区间倒挂进前一档（${b.band[0]} < ${a.band[1]}）`);
    }
    eq('同尺寸的相邻档不许倒挂（相接可以）', sameSizeProblems.join(' | '), '');
    eq('每一档的区间都是下界小于上界', E().TIERS.filter((t) => !(t.band[0] < t.band[1])).map((t) => t.key).join(','), '');
    eq('纪录表也是五档', document.querySelectorAll('#record-list li').length, 5);

    // ---- the six rules, as quoted on the menu, vs the engine's own table
    const li = [...document.querySelectorAll('.rules li b')].map((b) => b.textContent.trim());
    eq('首页写了六条规则', li.length, 6);
    eq('首页的规则名与重量就是 rules.js 那张表', li.join(' '),
      E().RULE_LIST.map((r) => `${r.name}（${r.weight}）`).join(' '));
    eq('代价序列按代价排的', E().RULE_LIST.map((r) => r.weight).join(','), '1,1,2,3,4,6');
    eq('六条规则的键', E().RULE_LIST.map((r) => r.key).join(','), 'adj,full,only,dead,pair,look');

    // ---- DOM hooks: main.js queries 42 ids by name, so a rename that leaves one dangling has to
    // go red here rather than as a null-property error three screens later.
    const want = ['app', 'board', 'board-wrap', 'btn-again', 'btn-daily', 'btn-hint', 'btn-menu', 'btn-menu-2', 'btn-mode-mark', 'btn-mode-star', 'btn-motion', 'btn-new', 'btn-prune', 'btn-reset', 'btn-resume', 'btn-sound', 'btn-undo', 'hint-count', 'hint-line', 'hint-rule', 'record-list', 'resume-card', 'resume-meta', 'resume-name', 'state-line', 'stat-conflicts', 'stat-hints', 'stat-marked', 'stat-moves', 'stat-name', 'stat-remaining', 'stat-score', 'stat-stars', 'stat-tier', 'stat-time', 'stat-units', 'tier-list', 'view-game', 'view-menu', 'win-meta', 'win-record', 'win-veil'];
    eq('手写名册有 42 个 id', want.length, 42);
    eq('页面上的 id 名册与手写的一致', idRoster().join(','), want.slice().sort().join(','));
    const dup = idRoster().filter((x, i, a) => i && a[i - 1] === x);
    eq('没有重复 id', dup.join(','), '');
    eq('名册里每个 id 都点得到', want.filter((x) => !document.getElementById(x)).join(','), '');

    // ---- visual tokens actually landed as custom properties (规则 6)
    eq('主题 token 写进了 CSS 变量', [cssVar('--bg-top'), cssVar('--accent'), cssVar('--success'), cssVar('--error'), cssVar('--hint')].join(','),
      `${TH().bgTop},${TH().accent},${TH().success},${TH().error},${TH().hint}`);
    eq('间距 token 20/16/12', [cssVar('--space-page'), cssVar('--space-card'), cssVar('--space-inner')].join(','), '20px,16px,12px');
    eq('圆角 token 20/12/8/6', [cssVar('--radius-card'), cssVar('--radius-button'), cssVar('--radius-chip'), cssVar('--radius-cell')].join(','), '20px,12px,8px,6px');
    eq('阴影三层都落了变量', [cssVar('--shadow-card'), cssVar('--shadow-pop'), cssVar('--shadow-inset')].every((v) => v.indexOf('rgba') >= 0), true);
    eq('格子下限 token 是 44（触底不让步）', TH().Cell.min, 44);
    eq('格子上限 token 是 62', TH().Cell.max, 62);
    eq('首屏没有 console 报错与未捕获异常', errors.join(' | '), '');
    return report({ version: A().version, tiers: E().TIERS.length, ids: want.length, rules: li.length });
  };

  w.__sc = { boot };
})(window);
