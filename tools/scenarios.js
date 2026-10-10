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
      pointerId: 1,
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
  // Did the pulse ring actually land on *this cell's* box? `board.draw` strokes it on the cell rect
  // inset by 2 px (js/render/board.js:179-184, `roundRect(r.x + 2, r.y + 2, cell - 4, cell - 4, 6)`,
  // lineWidth `max(2.5, cell * 0.09)`), so the stroke's centre line is exactly `cell / 2 - 2` from the
  // cell centre on four straight edges. A rectangle is not a circle: sampling at a fixed *radius* along
  // a diagonal leaves the box, and a sub-pixel of slop at this line is the outer antialiased sliver of
  // a ~4.7 px stroke — so the samples below sit on the centre line itself and slide only *along* the
  // edge, staying inside the middle ±60% where the rounded corners cannot eat a hit. That separates
  // "a red box was painted on this cell" from "some red pixels happen to sit in this cell's square":
  // a star glyph reaches only 0.31 cell from the centre (`Cell.starScale / 2`), so it cannot fake one.
  const RING_EDGES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const RING_FRACTIONS = [-0.6, -0.3, 0, 0.3, 0.6];
  const RING_SAMPLES = RING_EDGES.length * RING_FRACTIONS.length;
  function ringOnCellRect(t, color, tol = 24) {
    const g = geo().geo;
    const inset = g.cell / 2 - 2;
    const want = hex(color);
    const cx = (t % g.size) * g.cell + g.x + g.cell / 2;
    const cy = (((t / g.size) | 0) * g.cell) + g.y + g.cell / 2;
    let hit = 0;
    for (const [nx, ny] of RING_EDGES) {
      for (const f of RING_FRACTIONS) {
        const d = f * inset;
        if (near(pixel(cx + nx * inset + ny * d, cy + ny * inset + nx * d), want, tol)) hit++;
      }
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

    // ---- DOM hooks: main.js queries 43 ids by name, so a rename that leaves one dangling has to
    // go red here rather than as a null-property error three screens later.
    const want = ['app', 'board', 'board-wrap', 'btn-again', 'btn-daily', 'btn-fullscreen', 'btn-hint', 'btn-menu', 'btn-menu-2', 'btn-mode-mark', 'btn-mode-star', 'btn-motion', 'btn-new', 'btn-prune', 'btn-reset', 'btn-resume', 'btn-sound', 'btn-undo', 'hint-count', 'hint-line', 'hint-rule', 'record-list', 'resume-card', 'resume-meta', 'resume-name', 'state-line', 'stat-conflicts', 'stat-hints', 'stat-marked', 'stat-moves', 'stat-name', 'stat-remaining', 'stat-score', 'stat-stars', 'stat-tier', 'stat-time', 'stat-units', 'tier-list', 'view-game', 'view-menu', 'win-meta', 'win-record', 'win-veil'];
    eq('手写名册有 43 个 id', want.length, 43);
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

  // ==================================================================== 2. gen
  //
  // 现场生成 = 这一轮唯一能断言"出货盘被证过"的地方：本仓没有 baked library（js/data 是空的，
  // CI 也没有 bake 步骤），所以 tapa 那条"题单每局都被穷举证过唯一解"在这里不成立；成立的是
  // "begin() 现画的这一盘，独立穷举器数到唯一、铅笔路径推得完、两个引擎逐格相同"。
  //
  // The five seeds below are pinned to their whole board (region string + solution string + the
  // exhaustive counter's node count), computed once on the node side with the same
  // js/engine/generate.js the page imports. That is the cross-engine determinism pin: rng.js is
  // xorshift32 over hash32 (integer ops only, no Math.random, no Date) and regions.js/generate.js
  // shuffle with Fisher-Yates on that stream, so a seed must draw the identical board in Chrome and
  // in node. A sort comparator that pulled randomness, or a Date.now() leaking into a selection key,
  // would go red here rather than ship two different games on the two engines.
  const GEN_CASES = [
    { tier: 'trainee', name: '初学', seed: 'trainee-gate', size: 8, score: 110, steps: 64, nodes: 123,
      region: '0000446600444466044516660555111125511711225517712223173322233333',
      stars: '0000101010100000000010101010000000000101010100000000010101010000' },
    { tier: 'apprentice', name: '上手', seed: 'apprentice-gate', size: 8, score: 226, steps: 64, nodes: 95,
      region: '0000011100031111222331116223775562237555666375553663554433334444',
      stars: '0101000000000101010100000000010110100000000010101010000000001010' },
    { tier: 'regular', name: '熟练', seed: 'regular-gate', size: 8, score: 291, steps: 64, nodes: 80,
      region: '3111104433111004331600043766666477222664777225647772255577225555',
      stars: '0000101010100000000010101010000000000101010100000000010101010000' },
    { tier: 'expert', name: '高阶', seed: 'expert-gate', size: 9, score: 325, steps: 81, nodes: 1314,
      region: '666660011666500011555553001255333011222233331772233311722444441777444888774444448',
      stars: '001000010100001000000100010010001000000100001100000100001010000000000101010010000' },
    { tier: 'master', name: '大师', seed: 'master-gate', size: 9, score: 362, steps: 81, nodes: 832,
      region: '611115222688155522668155522688115722118147777111144777133344700133330000113300000',
      stars: '000101000100000010001001000100000010001010000000000101010010000000000101010100000' },
  ];

  // The shipped star pattern of trainee-gate, as a 0/1 array — reused as a *witness* below: it is a
  // legal two-stars-per-row/column/region placement for the trainee partition, and because the
  // row-band partition's region constraint is the row constraint repeated, the same pattern is also
  // legal there. That is what makes the many-solutions control sample a real "多解" and not a
  // mislabelled "无解".
  const bitsOf = (s) => s.split('').map((c) => Number(c));

  // Hand-written tally, a third pair of eyes: two stars in every row, column and region, and no two
  // of them touching (eight directions). Deliberately not `legalStarSet` — the point is that a bug
  // shared between the two shipped implementations cannot also be a bug here.
  function tally(board, stars) {
    const bad = [];
    for (const u of board.units) {
      const k = u.cells.filter((t) => stars[t] === 1).length;
      if (k !== 2) bad.push(`${u.name} 里有 ${k} 颗`);
    }
    for (let t = 0; t < board.n; t++) {
      if (stars[t] !== 1) continue;
      for (const nb of board.neighbors[t]) if (nb > t && stars[nb] === 1) bad.push(`${board.cellName(t)}↔${board.cellName(nb)} 挨着`);
    }
    return bad;
  }

  const gen = async () => {
    const seen = [];
    for (const c of GEN_CASES) {
      const tag = `${c.name}/${c.tier}`;
      const g = await open(c.tier, c.seed);
      const b = g.board;
      const p = g.puzzle;
      const tier = E().tierFor(c.tier);

      eq(`${tag}：这一屏就是 ${c.seed} 现生成的盘`, `${p.originSeed},${p.seed},${p.tier}`, `${c.seed},${c.seed}#0,${c.tier}`);
      eq(`${tag}：尺寸写在 puzzle 与 board 两处`, `${p.size},${b.size},${g.w}`, `${c.size},${c.size},${c.size}`);
      eq(`${tag}：Chrome 画的划分与 node 侧同 seed 逐格相同`, Array.from(b.region).join(''), c.region);
      eq(`${tag}：Chrome 盘上的唯一解与 node 侧逐格相同`, Array.from(p.solution).join(''), c.stars);
      eq(`${tag}：划分里有 ${c.size} 个区域、每格有归属`, [new Set(Array.from(b.region)).size, b.region.length].join(','), `${c.size},${c.size * c.size}`);

      // —— 铅笔推得完：出题的验收条件，在页内重跑一遍
      const re = E().solve(b);
      eq(`${tag}：铅笔路径推得完（verify 报 0 条不满）`, re.ok, true);
      eq(`${tag}：重跑的分数与生成时同一个数`, re.score, c.score);
      eq(`${tag}：重跑的步数与生成时同一个数`, re.steps, c.steps);
      eq(`${tag}：${c.steps} 笔正好写了 ${c.size * c.size} 格各一次`, `${re.rows.length},${new Set(re.rows.map((r) => r.cell)).size}`, `${c.size * c.size},${c.size * c.size}`);
      eq(`${tag}：难度分落在这一档量出来的区间 ${tier.band.join('–')} 里`, re.score >= tier.band[0] && re.score <= tier.band[1], true);
      const wrongWay = re.rows.filter((r) => (r.value === E().STAR ? bitsOf(c.stars)[r.cell] !== 1 : bitsOf(c.stars)[r.cell] === 1));
      eq(`${tag}：没有一笔推导写在唯一解的反面`, wrongWay.map((r) => `${r.rule.key}@${b.cellName(r.cell)}`).join(' | '), '');
      const usedRules = Object.keys(re.breakdown).sort();
      ck(`${tag}：铅笔路径真的用到了多条规则（${usedRules.length} 条）`, usedRules.length >= 3, usedRules.join(','));
      eq(`${tag}：用的规则都在这六条里`, usedRules.filter((k) => !E().RULE_LIST.some((r) => r.name === k)).join(','), '');

      // —— 独立穷举复核：走穷，不是烧预算
      const cnt = E().countSolutions({ size: b.size, region: b.region }, { cap: 2, budget: 400000 });
      eq(`${tag}：count.js 独立数到唯一解`, cnt.status, E().UNIQUE);
      eq(`${tag}：判决是「恰好一个」而不是「至少一个」`, cnt.solutions, 1);
      eq(`${tag}：穷举节点数与 node 侧同 seed 一致`, cnt.nodes, c.nodes);
      ck(`${tag}：唯一解是走完搜索得出的（${cnt.nodes} < 预算 400000）`, cnt.nodes < 400000, `nodes=${cnt.nodes}`);
      eq(`${tag}：穷举器给的解与铅笔的解逐格相同`, Array.from(cnt.first).join(''), c.stars);
      eq(`${tag}：生成器种下的星集就是那个唯一解`, Array.from(p.stars, (v) => (v ? 1 : 0)).join(''), c.stars);
      eq(`${tag}：第三双眼睛 legalStarSet 认这个解`, E().legalStarSet({ size: b.size, region: b.region }, cnt.first), true);
      eq(`${tag}：场景自己数一遍——每行/列/区两颗、星不相邻`, tally(b, Array.from(cnt.first)).join(' | '), '');
      eq(`${tag}：星数正好 2N=${2 * c.size}`, Array.from(cnt.first).reduce((a, x) => a + x, 0), 2 * c.size);

      // —— 玩家看得见的那一屏确实是这盘
      eq(`${tag}：面板写着尺寸`, text('#stat-tier'), `${c.size}×${c.size}`);
      eq(`${tag}：面板写着档名`, text('#stat-name'), c.name);
      eq(`${tag}：面板写着实测难度`, text('#stat-score'), String(c.score));
      eq(`${tag}：目标是 2N 颗星、开局一颗没有`, text('#stat-stars'), `0/${2 * c.size}`);
      eq(`${tag}：单元是 3N 个、开局没凑满`, text('#stat-units'), `0/${3 * c.size}`);
      eq(`${tag}：未定格就是整盘`, text('#stat-remaining'), String(c.size * c.size));
      eq(`${tag}：开局没有冲突`, text('#stat-conflicts'), '0');
      eq(`${tag}：提示计数归零`, text('#stat-hints'), '0');
      eq(`${tag}：切到棋局屏了`, A().view(), 'game');
      eq(`${tag}：画布几何与盘面同尺寸`, geo().geo.size, c.size);
      eq(`${tag}：胜负遮罩没有挡着棋盘`, hitAt('#win-veil'), 'no-box');
      const line = text('#state-line');
      ck(`${tag}：状态行说清了这盘是怎么量的`, line.indexOf(String(c.steps)) >= 0 && line.indexOf(String(c.score)) >= 0, line);

      seen.push({ tier: c.tier, score: c.score, steps: c.steps, nodes: cnt.nodes, over: cnt.status === E().OVERBUDGET });
    }

    // —— 阶梯：五档现场出货的分数真的在上升（tools/balance.mjs 用 24 样本的中位数说同一句话，
    //    这里是浏览器这一侧、五个固定 seed 的现场读数）
    eq('五档现场出货的难度分严格上升', seen.map((x) => x.score).join('<'), '110<226<291<325<362');
    eq('五档现场出货的步数（8×8 是 64、9×9 是 81）', seen.map((x) => x.steps).join(','), '64,64,64,81,81');
    eq('出货盘里没有一盘超预算（0/5）', seen.filter((x) => x.over).length, 0);
    eq('举证最贵的一盘用了 1314 / 400000 个节点', Math.max(...seen.map((x) => x.nodes)), 1314);

    // ==================================================================== 反空样本对照组
    // A counter that always answered "UNIQUE" would pass every assertion above. These three arms
    // have to be judged *not* unique, by the same calls, on the same page:
    //   行带 / 列带  —— 有解（上面那个 witness 就是其一），所以是 MANY，且铅笔一格都推不出
    //   单格区域    —— 那一区放不下两颗互不相邻的星，所以是 NONE
    //   预算 1      —— 只许报告「超预算」，不许把没数完的盘当成唯一解硬答（tools/balance.mjs 把
    //                  M>0 叫作承诺破口，这一条就是钉住它的浏览器侧版本）
    const SIZE = 8;
    const rowBands = Array.from({ length: 64 }, (_, t) => (t / SIZE) | 0);
    const colBands = Array.from({ length: 64 }, (_, t) => t % SIZE);
    const oneCell = Array.from({ length: 64 }, (_, t) => (t === 0 ? 0 : ((t / SIZE) | 0) === 0 ? 1 : (t / SIZE) | 0));
    const witness = bitsOf(GEN_CASES[0].stars);
    const bandCases = [
      { name: '行带（区=行）', region: rowBands, want: E().MANY },
      { name: '列带（区=列）', region: colBands, want: E().MANY },
      { name: '有一个单格区域', region: oneCell, want: E().NONE },
    ];
    for (const k of bandCases) {
      const cbb = E().createBoard({ size: SIZE, region: k.region });
      const cn = E().countSolutions({ size: SIZE, region: cbb.region }, { cap: 2, budget: 400000 });
      eq(`对照样本「${k.name}」：穷举器给的不是唯一解`, cn.status !== E().UNIQUE, true);
      eq(`对照样本「${k.name}」：判决是 ${k.want}`, cn.status, k.want);
      const sv = E().solve(cbb);
      eq(`对照样本「${k.name}」：铅笔推不完这一盘`, sv.ok, false);
      const nf = E().nextForced(cbb, new Int8Array(64));
      eq(`对照样本「${k.name}」：forced 在空盘上一格都不认`, nf === null ? 'null' : nf.conflict ? 'conflict' : 'cell', k.want === E().MANY ? 'null' : 'conflict');
      eq(`对照样本「${k.name}」：推导脚本一笔都没有`, sv.rows.length, 0);
      if (k.want === E().MANY) {
        const tiny = E().countSolutions({ size: SIZE, region: cbb.region }, { cap: 2, budget: 1 });
        eq(`对照样本「${k.name}」：预算烧光时报告超预算而不是硬答`, tiny.status, E().OVERBUDGET);
        eq(`对照样本「${k.name}」：超预算时不交半截答案`, tiny.first, null);
      }
    }
    // The two MANY arms must not be "no solution" wearing a different label: the witness pattern is
    // legal on both, which is what makes 多解 a real verdict.
    eq('行带盘上那个 witness 星集合法（所以确实是多解而不是无解）', E().legalStarSet({ size: SIZE, region: rowBands }, witness), true);
    eq('列带盘上同一个 witness 星集也合法', E().legalStarSet({ size: SIZE, region: colBands }, witness), true);
    eq('单格区域盘上同一个 witness 被拒（那一区只有 1 格）', E().legalStarSet({ size: SIZE, region: oneCell }, witness), false);
    eq('场景自己数：witness 在行带盘上每行/列/区都正好两颗、互不相邻', tally(E().createBoard({ size: SIZE, region: rowBands }), witness).join(' | '), '');
    eq('场景自己数：单格区域盘上那一区数不出两颗星', tally(E().createBoard({ size: SIZE, region: oneCell }), witness).filter((s) => s.indexOf('第1区') >= 0).join(' | '), '第1区 里有 0 颗');
    // A partition that splits a region is refused where it is built, not silently played.
    const split = rowBands.map((g) => g);
    split[0] = 0;
    split[63] = 0;
    split[1] = 1;
    split[62] = 1;
    let splitMsg = 'no-throw';
    try {
      E().createBoard({ size: SIZE, region: split });
    } catch (e) {
      splitMsg = e.message;
    }
    ck('区域被切成两半时 createBoard 直接拒绝', splitMsg.indexOf('不连通') >= 0, splitMsg);
    eq('生成器给的划分里没有断开的区域（五盘都建得起 board）', seen.length, 5);
    eq('这一段没有报错', errors.join(' | '), '');
    return report({ boards: seen.length, tiers: seen.map((x) => `${x.tier}:${x.score}/${x.steps}步/${x.nodes}节点`).join(' ') });
  };

  // ==================================================================== 3. play
  // The commit path a finger takes: one gesture = one snapshot = one undo, and every number the
  // panel shows is the number `state()` holds. The board used is trainee-gate, whose 16 solution
  // cells are pinned in GEN_CASES, so "place the answer" is a hand-written list rather than a
  // whatever-the-engine-says loop — and a wrong-star detour stays red for the right reason.
  const FIELDS = ['moves', 'hints', 'hintCount', 'stars', 'marked', 'remaining', 'units', 'conflicts', 'score', 'undoDisabled'];
  const domOf = () => ({
    moves: text('#stat-moves'),
    hints: text('#stat-hints'),
    hintCount: text('#hint-count'),
    stars: text('#stat-stars'),
    marked: text('#stat-marked'),
    remaining: text('#stat-remaining'),
    units: text('#stat-units'),
    conflicts: text('#stat-conflicts'),
    score: text('#stat-score'),
    undoDisabled: String($('#btn-undo').disabled),
  });
  const mirror = (s) => ({
    moves: String(s.moves),
    hints: String(s.hints),
    hintCount: String(s.hints),
    stars: `${s.stars}/${s.target}`,
    marked: String(s.marked),
    remaining: String(s.remaining),
    units: `${s.satisfied}/${s.units}`,
    conflicts: String(s.conflicts),
    score: s.score == null ? '—' : String(s.score),
    undoDisabled: String(s.steps === 0),
  });
  // Panel readouts vs the state machine, one assertion per field so a drift names the field.
  function readouts(tag) {
    const s = A().state();
    const d = domOf();
    const m = mirror(s);
    for (const f of FIELDS) eq(`${tag}：#panel 的 ${f} 就是 state() 的读数`, d[f], m[f]);
    return s;
  }

  const play = async () => {
    const c = GEN_CASES[0];
    const g = await open(c.tier, c.seed);
    const b = g.board;
    const stars = bitsOf(c.stars);
    const starCells = [];
    const otherCells = [];
    for (let t = 0; t < stars.length; t++) (stars[t] ? starCells : otherCells).push(t);
    eq('这一盘是 16 个星格对 48 个非星格', `${starCells.length},${otherCells.length}`, '16,48');
    eq('开局一步没有', `${A().state().steps},${A().state().moves},${A().state().hints}`, '0,0,0');
    readouts('开局');

    // ---- 真实指针：按下去是预览，抬起来才是墨迹
    const t0 = starCells[0];
    const p0 = at(t0);
    pointer('pointerdown', p0.x, p0.y);
    await wait(24);
    eq('抬指之前那一格仍然空着（预览不是墨迹）', A().valueOf(t0), E().EMPTY);
    eq('抬指之前步数不动', A().state().moves, 0);
    pointer('pointerup', p0.x, p0.y);
    await wait(24);
    eq('抬指之后那一格才落星', A().valueOf(t0), E().STAR);
    eq('一次手势算一步', `${A().state().steps},${A().state().moves}`, '1,1');
    eq('面板同步显示 1/16 颗星', text('#stat-stars'), '1/16');
    ck('那一格确实画出了一颗星（琥珀色实心墨迹）', inkInCell(t0, TH().accent, 34) > 40, `ink=${inkInCell(t0, TH().accent, 34)}`);
    ck('没放星的格子里没有这颗星的墨（对照）', inkInCell(otherCells[0], TH().accent, 34) === 0, `ink=${inkInCell(otherCells[0], TH().accent, 34)}`);

    // 板外一指：hitCell 说不是格子，就不许多出第二步
    const box = geo().canvas;
    pointer('pointerdown', box.left + 3, box.top + 3);
    pointer('pointerup', box.left + 3, box.top + 3);
    await wait(24);
    eq('画布内边距上的一指不产生任何一步', A().state().steps, 1);
    eq('那一指也没有把第 1 行 1 列改动', A().valueOf(A().cellAt(0, 0)), E().EMPTY);
    readouts('一指之后');

    // 撤销走的是页面自己的按钮绑定
    $('#btn-undo').click();
    await wait(24);
    eq('点「撤销」把那颗星抬走了', A().valueOf(t0), E().EMPTY);
    eq('撤销之后步数归零', `${A().state().steps},${A().state().moves}`, '0,0');
    eq('撤销之后撤销键重新变灰', $('#btn-undo').disabled, true);

    // ---- 一笔拖过五格：五格墨迹、一步账
    $('#btn-mode-mark').click();
    await wait(20);
    eq('切到标灰工具', A().state().mode, E().OUT);
    eq('标灰键的按下态与模式同步', $('#btn-mode-mark').getAttribute('aria-pressed'), 'true');
    eq('放星键弹起', $('#btn-mode-star').getAttribute('aria-pressed'), 'false');
    const run = [0, 1, 2, 3, 4].map((x) => A().cellAt(x, 3));
    await gestureDrag(run[0], run[4]);
    eq('一笔拖过 5 格，5 格全成灰点', run.map((t) => A().valueOf(t)).join(','), '2,2,2,2,2');
    eq('一整笔只算一步（撤销是一次手势而不是一个格）', `${A().state().steps},${A().state().moves}`, '1,1');
    eq('灰点数就是 5', A().state().marked, 5);
    readouts('一笔五格之后');
    A().undo();
    await wait(20);
    eq('一次撤销把五格全部还原', run.map((t) => A().valueOf(t)).join(','), '0,0,0,0,0');
    eq('还原之后灰点归零、星数归零', `${A().state().marked},${A().state().stars}`, '0,0');

    // ---- 从自己的记号起笔就是擦（同一个手势家族的第二条规则）
    A().stroke([run[0], run[1]], E().OUT);
    eq('先把两格涂灰', [A().valueOf(run[0]), A().valueOf(run[1])].join(','), '2,2');
    await gestureDrag(run[0], run[1]);
    eq('从灰点起笔拖过去是擦掉，不是再涂一遍', [A().valueOf(run[0]), A().valueOf(run[1])].join(','), '0,0');
    eq('擦也算一步', A().state().steps, 2);
    A().undo();
    eq('撤销擦的那一笔，两格又灰了回来', [A().valueOf(run[0]), A().valueOf(run[1])].join(','), '2,2');
    A().undo();
    eq('两笔撤销回到空屏（步数、灰点、动作数一起归零）', `${A().state().steps},${A().state().marked},${A().state().moves}`, '0,0,0');

    // ---- 一键标灰：免费、不替玩家放星、整片一笔
    $('#btn-mode-star').click();
    A().tap(starCells[0]);
    A().tap(starCells[1]);
    const pre = A().state();
    A().prune();
    const post = A().state();
    const pr = A().game.steps[A().game.steps.length - 1];
    eq('落两颗星之后是一步两格', `${pre.moves},${pre.steps},${pre.stars}`, '2,2,2');
    eq('一键标灰记在标灰账上', post.prunes, 1);
    eq('一键标灰不动步数（它是免费的）', post.moves, pre.moves);
    eq('一键标灰不动提示数', post.hints, pre.hints);
    eq('这一笔写的每一格都是灰点', pr.writes.every((x) => x.to === E().OUT && x.from === E().EMPTY), true);
    eq('它一颗星也没替我放', pr.writes.filter((x) => stars[x.cell] === 1).length, 0);
    eq('它说写了多少格就是多少格，面板也这么写', `${pr.writes.length},${post.marked},${text('#stat-marked')}`, `${pr.writes.length},${pr.writes.length},${pr.writes.length}`);
    ck('两颗星的八邻域至少该有 8 格被标灰', pr.writes.length >= 8, `writes=${pr.writes.length}`);
    eq('提示框把这件事说成免费', text('#hint-rule'), '一键标灰（免费）');
    ck('提示框写的格数与这一笔一致', text('#hint-line').indexOf(`${pr.writes.length} 个灰点`) >= 0, text('#hint-line'));
    A().undo();
    await wait(20);
    eq('一整片灰点一次撤销就全回去', `${A().state().marked},${A().state().prunes}`, '0,0');
    eq('免费的动作撤销时不动步数', A().state().moves, 2);

    // ---- 满盘才判胜：先把 15 颗星放对
    for (let k = 2; k < 15; k++) A().tap(starCells[k]);
    const mid = readouts('十五颗星之后');
    eq('差一颗星不判胜', `${mid.status},${mid.stars}/${mid.target}`, 'playing,15/16');
    eq('十五颗星也没有冲突', `${mid.conflicts},${mid.adjacent}`, '0,0');
    eq('差的那一格还是空的', A().valueOf(starCells[15]), E().EMPTY);
    // 满盘墨迹 ≠ 下完。判胜看的是「每单元两颗、互不相邻」，不是还剩几个空格，所以这里分两步：
    // 先把 48 个非星格中的 47 个涂灰（留第 64 格这一个活口），再把那一格也涂死 —— 整盘 64 格
    // 全有墨、未定格 0，仍然不是胜。第二张对照的读数按 diagnose 的真实口径写：它只报「数得出来的
    // 矛盾」（第 7 行了 1 颗星但还剩 1 格可放，所以并不算 violated），不许伪造冲突。
    A().stroke(otherCells.slice(0, 47), E().OUT);
    const inked = A().state();
    eq('涂掉 47 个非星格之后还剩 2 格未定', `${inked.remaining},${inked.marked}`, '2,47');
    eq('整盘只差一颗星、两格没定，仍然没胜', `${inked.status},${inked.stars}/${inked.target}`, 'playing,15/16');
    eq('这一屏一个冲突也没有（不许把「没下完」报成「撞破规则」）', `${inked.conflicts},${inked.violated},${inked.adjacent}`, '0,0,0');
    ck('状态行还在报「还差几颗」而不是胜利', text('#state-line').indexOf('还差 1 颗星') >= 0, text('#state-line'));
    readouts('47 格涂灰之后');
    A().stroke([otherCells[47]], E().OUT);
    const dead = A().state();
    eq('最后一格也涂死：48 格全成灰点，棋盘只剩一个活口', `${dead.remaining},${dead.marked},${dead.stars}`, '1,48,15');
    eq('剩下的那一格就是缺的那颗星的位置', A().valueOf(starCells[15]), E().EMPTY);
    eq('满盘只剩一个活口也不判胜（判胜看单元，不看还剩几格）', `${dead.status},${dead.stars}/${dead.target}`, 'playing,15/16');
    eq('满盘错墨也不谎报矛盾（diagnose 只报它数得出来的）', `${dead.violated},${dead.conflicts},${dead.adjacent}`, '0,0,0');
    // 差的这一颗是格 59 = 第 8 行第 4 列：第 8 行（只有 57）、第 4 列（只有 43）、第 4 区（只有
    // 55）各只剩它一格可放，所以凑满的单元是 24 − 3 = 21。这三处是照 GEN_CASES[0] 那份解手数的。
    eq('凑满的单元数：三处各差一颗，21/24', `${dead.satisfied}/${dead.units}`, '21/24');
    eq('终局遮罩在没有胜的时候藏得干净', hitAt('#win-veil'), 'no-box');

    // ---- 第 16 颗落下
    A().tap(starCells[15]);
    const won = readouts('终局');
    eq('第 16 颗落下就是胜', `${won.status},${won.stars}/${won.target},${won.conflicts}`, 'won,16/16,0');
    eq('终局把 3N 个单元全数凑满', `${won.satisfied}/${won.units}`, '24/24');
    ck('胜利遮罩出来且命中盒在控件上', hitAt('#win-veil') === 'hit' && shown('#win-veil'), hitAt('#win-veil'));
    eq('状态行换成结论', `${text('#state-line')}|${$('#state-line').dataset.kind}`, '每一行、每一列、每一区都正好两颗，谁也不挨着。|good');
    const meta = text('#win-meta').split(' · ');
    eq('胜利卡：档名与尺寸', meta[0], '初学 8×8');
    ck('胜利卡：计时写成 mm:ss（值是墙钟，只钉形状）', /^\d{2}:\d{2}$/.test(meta[1]), meta[1]);
    eq('胜利卡：步数就是这一局的动作数', meta[2], '步数 18');
    eq('胜利卡：一次提示也没用', meta[3], '提示 0');
    eq('胜利卡：撤销掉的一键标灰不再记账', meta[4], '一键标灰 0 次');
    eq('胜利卡：复读这一盘的实测难度', meta[5], '实测难度 110');
    eq('终局那一格画成绿的（不再是琥珀）', inkInCell(starCells[15], TH().success, 34) > 40, true);
    eq('一键标灰按钮在终局是灰的', $('#btn-prune').disabled, true);
    ck('「再来一局」那颗按钮点得到', $('#btn-again').getBoundingClientRect().width > 40, String($('#btn-again').getBoundingClientRect().width));

    // 终局之后棋局本身冻住：星拿不掉、步数不再涨
    A().tap(starCells[0]);
    A().prune();
    A().stroke([otherCells[0]], E().STAR);
    eq('终局之后点格子改不动读数', `${A().state().steps},${A().state().stars}`, '18,16');
    eq('终局之后一键标灰不再写格子', A().valueOf(otherCells[0]), E().OUT);
    eq('这一段没有 console 报错与未捕获异常', errors.join(' | '), '');
    return report({ moves: won.moves, steps: won.steps, prunes: won.prunes, status: won.status });
  };

  // ---- hint ----------------------------------------------------------------------
  //
  // Every number in this block was measured by driving the shipped `Game` class in node (the hint
  // path touches no DOM, so node and Chrome run the identical object) on the same pinned trainee-gate
  // board `play` uses. That is deliberate: the sentence, the cell, the rule name and the charged
  // count are written down *before* looking at the browser, so a drift in either copy goes red
  // instead of being re-measured into the expectation.
  const hint = async () => {
    const c = GEN_CASES[0];
    const g = await open(c.tier, c.seed);
    const board = g.board;
    const stars = bitsOf(c.stars);
    const E_STAR = E().STAR;
    const E_OUT = E().OUT;
    eq('记号常量：空 0 / 星 1 / 灰 2（本场景里的 1、2 就是它）', [E().EMPTY, E_STAR, E_OUT].join(','), '0,1,2');

    // The first six presses, cell / rule / sentence pinned from node.
    const HINT_HEAD = [
      { press: 1, cell: 14, value: 2, rule: '摆不下', unit: '第7区', nf: true,
        why: '第2行7列 不在 第7区 任何一种合法摆法里（第7区 还差 2 颗星，谁跟它配都不行）——标灰' },
      { press: 2, cell: 37, value: 1, rule: '只剩这一对', unit: '第8区', nf: true,
        why: '第8区 还差 2 颗星，可放格有 4 个，但互不相邻的摆法只剩一种——第5行6列 必须在内' },
      { press: 3, cell: 53, value: 1, rule: '只剩这一对', unit: '第8区', nf: false,
        why: '第8区 还差 2 颗星，可放格有 4 个，但互不相邻的摆法只剩一种——第7行6列 必须在内' },
      { press: 4, cell: 45, value: 2, rule: '摆不下', unit: '第8区', nf: false,
        why: '第6行6列 不在 第8区 任何一种合法摆法里（第8区 还差 2 颗星，谁跟它配都不行）——标灰' },
      { press: 5, cell: 46, value: 2, rule: '摆不下', unit: '第8区', nf: false,
        why: '第6行7列 不在 第8区 任何一种合法摆法里（第8区 还差 2 颗星，谁跟它配都不行）——标灰' },
      { press: 6, cell: 28, value: 2, rule: '星的邻域', unit: null, nf: true,
        why: '第5行6列 放了星，它的八邻域（含斜角）都不能再放——第4行5列 标灰' },
    ];
    // The 62-press route, measured end to end in node.
    const WALK = {
      charged: 62, script: 64, stars: 16, marked: 46, remaining: 2,
      tally: '星的邻域=26,满额排除=14,只差这些=7,摆不下=6,只剩这一对=9,试放即死=0',
      weight: 108, score: 110, head: 40, inside: 21, outside: '29:摆不下@第7行2列',
    };
    const inkArr = () => Int8Array.from(Array.from({ length: board.n }, (_, t) => A().valueOf(t)));
    const inkList = () => Array.from({ length: board.n }, (_, t) => A().valueOf(t));

    eq('提示脚本的行数就是 gen 钉下的推导步数', A().state().script, WALK.script);
    eq('开局一次提示也没用', `${A().state().hints},${A().state().cursor},${A().state().steps}`, '0,0,0');
    eq('提示计数两处读数都从 0 起', `${text('#stat-hints')},${text('#hint-count')}`, '0,0');

    let headAgree = 0;
    let insideAgree = 0;
    const usedRule = {};
    const press = (row) => {
      // `nextForced` is the engine's own "what do the clues force right now" call. Where node says it
      // names the very cell this press writes, the button provably is not an answer reveal.
      if (row && row.nf) {
        const nf = E().nextForced(board, inkArr());
        eq(`第 ${row.press} 次提示点名的格与 nextForced 同源`, `${nf.cell},${nf.value},${nf.rule.name}`,
          `${row.cell},${row.value},${row.rule}`);
      }
      const sweep = E().propagate(board, inkArr());
      const cur = A().state().cursor;
      const scriptRow = A().game.script[cur];
      const before = inkList();
      $('#btn-hint').click();
      const k = before.length ? A().state().hints : 0;
      const served = `${scriptRow.cell},${scriptRow.value}`;
      const found = sweep.found || [];
      if (found.length && `${found[0].cell},${found[0].value}` === served) headAgree++;
      else if (found.some((f) => `${f.cell},${f.value}` === served)) insideAgree++;
      usedRule[text('#hint-rule')] = (usedRule[text('#hint-rule')] || 0) + 1;
      return { before, k, scriptRow };
    };

    // ---- the first six presses, in full detail
    for (const row of HINT_HEAD) {
      const { before } = press(row);
      const s = A().state();
      const k = row.press;
      eq(`第 ${k} 次提示只往前走一行脚本`, `${s.hints},${s.cursor},${s.steps}`, `${k},${k},${k}`);
      eq(`第 ${k} 次提示落的就是钉下的那一格`, A().valueOf(row.cell), row.value);
      const changed = [];
      for (let t = 0; t < board.n; t++) if (before[t] !== A().valueOf(t)) changed.push(t);
      eq(`第 ${k} 次提示只改这一格`, changed.join(','), String(row.cell));
      eq(`第 ${k} 次提示写的值与本盘唯一的解一致（提示不许撒谎）`, stars[row.cell], row.value === E_STAR ? 1 : 0);
      eq(`第 ${k} 次提示的规则名上屏`, text('#hint-rule'), row.rule);
      eq(`第 ${k} 次提示的句子就是那条规则自己的话`, text('#hint-line'), row.why);
      eq(`第 ${k} 次提示不动步数、不动标灰账`, `${s.moves},${s.prunes}`, '0,0');
      eq(`第 ${k} 次提示后面板两处计数同步`, `${text('#stat-hints')},${text('#hint-count')}`, `${k},${k}`);
      eq(`第 ${k} 次提示之后面板读数与 state() 同源`, A().state().stars + A().state().marked >= 0, true);
      readouts(`第 ${k} 次提示之后`);
    }
    const captions = [...document.querySelectorAll('.rules li b')].map((e) => e.textContent.trim());
    for (const row of HINT_HEAD) {
      ck(`规则「${row.rule}」写在首页六条里（带重量）`, captions.some((x) => x.startsWith(`${row.rule}（`)), captions.join(' '));
    }
    eq('提示句必点自己那一格（不许只报结论不报位置）', HINT_HEAD.every((r) => r.why.indexOf(board.cellName(r.cell)) >= 0), true);
    eq('六条规则的名字都各不相同', new Set(E().RULE_LIST.map((r) => r.name)).size, 6);

    // ---- the pulse ring is the hint colour, and only on the hinted cell
    const ringCell = HINT_HEAD[5].cell;
    const ring = inkInCell(ringCell, TH().hint, 24);
    const control = inkInCell(0, TH().hint, 24);
    ck(`提示那一格画了蓝环（Palette.hint ${TH().hint}）`, ring > 40, `ink=${ring}`);
    ck('没提示的格子里一像素蓝环也没有（对照）', control === 0, `ink=${control}`);
    ck('蓝环不是星墨的琥珀色（两种颜色不许互冒充）', inkInCell(ringCell, TH().accent, 20) === 0,
      `ink=${inkInCell(ringCell, TH().accent, 20)}`);

    // ---- walk the rest of the route: 一路提示能走完这局
    let presses = HINT_HEAD.length;
    let refused = 0;
    let stalled = 0;
    const outside = [];
    while (A().state().status !== 'won' && presses < 140) {
      const cur = A().state().cursor;
      const sweep = E().propagate(board, inkArr());
      const scriptRow = A().game.script[cur];
      $('#btn-hint').click();
      presses++;
      const s = A().state();
      if (text('#hint-rule') === '提示没有扣次数') { refused++; break; }
      if (text('#hint-rule') === '推完了') { stalled++; break; }
      const found = sweep.found || [];
      const served = `${scriptRow.cell},${scriptRow.value}`;
      if (found.length && `${found[0].cell},${found[0].value}` === served) headAgree++;
      else if (found.some((f) => `${f.cell},${f.value}` === served)) insideAgree++;
      else outside.push(`${s.hints}:${text('#hint-rule')}@${board.cellName(scriptRow.cell)}`);
      const ruleNow = text('#hint-rule');
      usedRule[ruleNow] = (usedRule[ruleNow] || 0) + 1;
      eq(`第 ${s.hints} 次提示只吃掉脚本的一行`, `${s.hints},${s.cursor},${s.moves},${s.prunes}`, `${presses},${presses},0,0`);
      eq(`第 ${s.hints} 次提示写的值仍与本盘的解一致`, stars[scriptRow.cell], scriptRow.value === E_STAR ? 1 : 0);
    }
    const won = A().state();
    eq('一路提示走完这局', won.status, 'won');
    eq('走完用的次数、提示数与脚本游标都是 node 钉的那个数',
      `${presses},${won.hints},${won.cursor}`, `${WALK.charged},${WALK.charged},${WALK.charged}`);
    eq('这一路没有一次拒绝、也没有一次「推完了」', `${refused},${stalled}`, '0,0');
    eq('提示替我放满 16 颗星、写下 46 个灰点、还剩 2 格没定',
      `${won.stars}/${won.target},${won.marked},${won.remaining}`, `${WALK.stars}/16,${WALK.marked},${WALK.remaining}`);
    eq('通关那一屏 24 个单元全凑满', `${won.satisfied}/${won.units}`, '24/24');
    eq('全程一步不记在玩家手上、也没用一键标灰', `${won.moves},${won.prunes}`, '0,0');
    eq('这一路每规则用了几次（难度分的分解）', E().RULE_LIST.map((r) => `${r.name}=${usedRule[r.name] || 0}`).join(','), WALK.tally);
    const weight = E().RULE_LIST.reduce((a, r) => a + (usedRule[r.name] || 0) * r.weight, 0);
    eq('用掉的六条折成重量是 108', weight, WALK.weight);
    eq('剩下的两行都是「星的邻域」，补上就是这盘的难度分 110', `${weight}+2=${weight + 2},${text('#stat-score')}`,
      `${weight}+2=${WALK.score},${c.score}`);
    // 提示赢下这一局之后遮罩与胜利卡该不该出现，是 `defects` 场景钉的事（那里是刻意的红）；
    // 本场景只钉数字这一侧：状态行换成结论、24 个单元凑满。
    eq('提示赢下这一局之后状态行换成结论', `${text('#state-line')}|${$('#state-line').dataset.kind}`,
      '每一行、每一列、每一区都正好两颗，谁也不挨着。|good');
    const agreeAt = headAgree;
    const insideAt = insideAgree;
    eq('与单遍扫描同源的比例：40 次报的是扫描头一格、21 次在同一次扫描里', `${agreeAt},${insideAt}`, `${WALK.head},${WALK.inside}`);
    eq('唯一一处单遍扫描不再复现的提示（脚本是从空盘走的那条路线，不是每步重扫）', outside.join(' | '), WALK.outside);
    let lied = [];
    let wrongGrey = [];
    for (let t = 0; t < board.n; t++) {
      const v = A().valueOf(t);
      if (v === E_STAR && stars[t] !== 1) lied.push(board.cellName(t));
      if (v === E_OUT && stars[t] !== 0) wrongGrey.push(board.cellName(t));
    }
    eq('这一路写的每一颗星都在唯一的解上', lied.join(','), '');
    eq('这一路涂灰的每一格都不在唯一的解上', wrongGrey.join(','), '');
    eq('终局那一屏没有 console 报错与未捕获异常', errors.join(' | '), '');

    // ---- 终局之后再点提示：main.js 先 return，一格也不许多写
    const line = text('#hint-line');
    $('#btn-hint').click();
    await wait(18);
    eq('终局之后提示是空操作', `${A().state().hints},${A().state().cursor},${text('#hint-line')}`,
      `${WALK.charged},${WALK.charged},${line}`);

    // ---- 撤销退还格子，但不退还求助
    await open(c.tier, c.seed);
    press(HINT_HEAD[0]);
    const hintCell = HINT_HEAD[0].cell;
    eq('第一次提示写的格子', A().valueOf(hintCell), E_OUT);
    $('#btn-undo').click();
    await wait(18);
    const us = A().state();
    eq('撤销把那格擦回空白', A().valueOf(hintCell), E().EMPTY);
    eq('撤销退掉那一笔，但提示数不退', `${us.steps},${us.hints},${us.moves}`, '0,1,0');
    eq('面板上提示数仍写着 1（退回去的帮助也是帮助过）', `${text('#stat-hints')},${text('#hint-count')}`, '1,1');
    eq('撤销顺手把蓝环收掉了（pulse=null）', inkInCell(hintCell, TH().hint, 24), 0);
    press();
    eq('再点提示走的是脚本下一行，不把刚退的那行重播', `${A().state().hints},${A().state().cursor}`, '2,2');
    eq('第二次提示落的还是钉下的那一格', A().valueOf(HINT_HEAD[1].cell), E_STAR);

    // ---- 反空样本：记号与线索矛盾时提示必须闭嘴，一次也不扣
    await open(c.tier, c.seed);
    A().tap(4);
    A().tap(3);
    await wait(18);
    eq('两枚相邻的星本身就是矛盾', `${A().state().adjacent},${A().state().conflicts}`, '1,1');
    const scriptHead = E().solve(board).rows[0].cell;
    $('#btn-hint').click();
    await wait(18);
    const cs = A().state();
    eq('矛盾盘面下提示拒绝推导', `${cs.hints},${cs.cursor},${cs.steps}`, '0,0,2');
    eq('拒绝时说的是「没扣次数」', text('#hint-rule'), '提示没有扣次数');
    eq('拒绝时的固定话术上屏', text('#hint-line'), '你的记号和线索推出来的结论冲突了：先看红框那一格。');
    eq('状态行报的是这一对相邻的星', `${text('#state-line')}|${$('#state-line').dataset.kind}`,
      '第1行4列 与 第1行5列 挨着——任何两颗星都不能相邻（含斜角） —— 记号和线索矛盾，先撤销那一笔。提示没有扣次数。|bad');
    eq('拒绝时一格也不许多写（脚本头一格仍然空着）', A().valueOf(scriptHead), E().EMPTY);
    eq('面板上的提示计数没有偷偷 +1', `${text('#stat-hints')},${text('#hint-count')}`, '0,0');
    const errRing = inkInCell(3, TH().error, 24);
    ck(`红框画在矛盾那一格上（Palette.error ${TH().error}）`, errRing > 40, `ink=${errRing}`);
    ck('红框只画在该画的那一格（对照格一像素也没有）', inkInCell(scriptHead, TH().error, 24) === 0,
      `ink=${inkInCell(scriptHead, TH().error, 24)}`);
    $('#btn-hint').click();
    await wait(18);
    eq('再按还是拒绝、还是不扣', `${A().state().hints},${text('#hint-rule')}`, '0,提示没有扣次数');
    A().undo();
    A().undo();
    await wait(18);
    eq('把那一笔撤销掉之后提示重新开口、并且开始计数', (() => { $('#btn-hint').click(); return `${A().state().hints}`; })(), '1');

    // ---- 每一行脚本都可反驳：把线索要写的那格先涂反，提示一律闭嘴
    const rows = E().solve(board).rows;
    const refusedAt = [];
    const chargedAt = [];
    for (let k = 0; k < 12; k++) {
      A().adopt(A().puzzle);
      for (let i = 0; i < k; i++) A().useHint();
      const s1 = A().state();
      const row = rows[s1.cursor];
      A().tap(row.cell, row.value === E_STAR ? E_OUT : E_STAR);
      const inkBefore = inkList().join('');
      A().useHint();
      const s2 = A().state();
      const inkAfter = inkList().join('');
      if (s2.hints === s1.hints && inkBefore === inkAfter) refusedAt.push(k);
      else chargedAt.push(`${k}->${s2.hints}`);
      eq(`位置 ${k}：提示闭嘴时面板话术指着那一格`, text('#hint-rule'), '提示没有扣次数');
    }
    eq('12 个位置各试一次：涂反线索要写的那格，提示一律拒绝且不扣次数', refusedAt.join(','), '0,1,2,3,4,5,6,7,8,9,10,11');
    eq('一个也没有被「将错就错」地补记一次提示', chargedAt.join(','), '');
    eq('最后一次拒绝之后盘面还停在原位', A().state().cursor, 11);
    eq('这一段没有 console 报错与未捕获异常', errors.join(' | '), '');
    return report({
      charged: WALK.charged, script: WALK.script, head: agreeAt, inside: insideAt,
      refused: refusedAt.length, weight,
    });
  };

  // ---- win -----------------------------------------------------------------------
  //
  // 收官这一侧的账，三条都是真实缺陷的回归钉（缺陷在 js 侧已修，这里只钉修好之后的正向事实）：
  //   1. 一路点「提示」点到收官必须真的结算胜利。`useHint()` 原先三个出口只调 syncAll()，既不过
  //      `afterStep()` 也不补 `onWin()`，于是 status 已经是 won 而遮罩不出现、#win-meta 是空的、
  //      `Store.recordBest/recordSolve` 一条都不写。用提示收官是正常玩法，不是调试路径。
  //   2. 赢完再撤销必须把局面退回未完成。`Game.undo()` 原先不重算 `checkWin()`，main.js 的 undo()
  //      也不收遮罩，结果是「status 写着 won、#stat-stars 读 15/16、状态行还说都正好两颗」这种
  //      自相矛盾的面板。
  //   3. `clash()` 的每一个出口都必须指出一格**画得出红框**的格子。它的第三枝原先给
  //      `cell: undefined`（该区域一颗星、一个灰点都没有时），而 board.draw 的 `pulse.cell != null`
  //      守卫会把整枝丢掉 —— 面板说着「先看红框那一格」，盘上一格红框也没有。
  //
  // 62 次提示收官、脚本 64 行、难度分 110 这三个数与 `hint` 场景同源：上一轮在 node 里驱动同一个
  // Game 类量出来的，不是照着浏览器输出回填的。遮罩、纪录与红框则全部读 DOM 和画布像素。
  const win = async () => {
    const c = GEN_CASES[0];
    // 本场景要看档上的纪录，所以它得先自己清一次盘：默认清单里 `play` 先赢过一局（0 提示、18 步），
    // 而 `recordBest` 优先「求助更少」，那条纪录会压住后面每一次收官 —— 不清盘的话下面几条断言测的
    // 是「上一个场景留下了什么」，不是「这一局的收官有没有记账」。
    $('#btn-reset').click();
    await wait(24);
    eq('清档之后初学档没有纪录', E().Store.best(c.tier), null);
    eq('清档之后通关总数是零', [E().Store.totals().solved, E().Store.totals().hints, E().Store.totals().ms].join(','), '0,0,0');
    eq('清档之后纪录表五档都空着', [...document.querySelectorAll('#record-list li i')].map((e) => e.textContent).join(','), '还没有纪录,还没有纪录,还没有纪录,还没有纪录,还没有纪录');
    const g = await open(c.tier, c.seed);
    const board = g.board;
    const HINTS_TO_WIN = 62;
    const t0 = E().Store.totals();
    const pressHint = async () => {
      $('#btn-hint').click();
      return wait(18);
    };
    eq('记号常量：空 0 / 星 1 / 灰 2（下面的驱动就用它）', [E().EMPTY, E().STAR, E().OUT].join(','), '0,1,2');
    eq('这一局开局没赢', A().state().status, 'playing');

    // ---- 1. 一路点提示点到收官：胜利必须真的发生
    await pressHint();
    await pressHint();
    await pressHint();
    const mid = E().Store.resume();
    eq('三次提示之后存档位上确实躺着这一盘未完成', `${A().state().hints},${!!mid},${mid && mid.seed},${mid && mid.hints},${mid && mid.moves}`, '3,true,trainee-gate,3,0');
    let presses = 3;
    while (A().state().status !== 'won' && presses < 140) {
      await pressHint();
      presses++;
    }
    const won = A().state();
    eq(`一路点到第 ${HINTS_TO_WIN} 次提示赢下这局`, `${presses},${won.status},${won.hints}`, `${HINTS_TO_WIN},won,${HINTS_TO_WIN}`);
    eq('提示收官也是满盘：16 颗星、24 个单元全凑满', `${won.stars}/${won.target},${won.satisfied}/${won.units}`, '16/16,24/24');
    ck('提示收官必须出现胜利遮罩，而且点得到（不是只换了一行状态文字）',
      shown('#win-veil') && hitAt('#win-veil') === 'hit', `shown=${shown('#win-veil')} hit=${hitAt('#win-veil')}`);
    eq('提示收官的状态行换成结论', `${text('#state-line')}|${$('#state-line').dataset.kind}`,
      '每一行、每一列、每一区都正好两颗，谁也不挨着。|good');
    const meta = text('#win-meta').split(' · ');
    eq('胜利卡：档名与尺寸（onWin 没跑过这里就是空串）', meta[0], '初学 8×8');
    ck('胜利卡：计时写成 mm:ss（值是墙钟，只钉形状）', /^\d{2}:\d{2}$/.test(meta[1] || ''), meta[1]);
    eq('胜利卡：一步也没记在玩家手上', meta[2], '步数 0');
    eq('胜利卡：写着这一局用掉的提示数', meta[3], '提示 62');
    eq('胜利卡：一次一键标灰也没用', meta[4], '一键标灰 0 次');
    eq('胜利卡：复读这一盘的实测难度', meta[5], '实测难度 110');
    const best1 = E().Store.best(c.tier);
    eq('档上的纪录写着这局求助 62 次、0 步、8×8', `${best1 && best1.hints},${best1 && best1.moves},${best1 && best1.size}`, '62,0,8');
    const t1 = E().Store.totals();
    eq('recordSolve 记下了这一次通关（次数 +1、提示 +62）', `${t1.solved - t0.solved},${t1.hints - t0.hints},${t1.ms > 0}`, '1,62,true');
    eq('通关之后不留残局存档', E().Store.resume(), null);
    $('#btn-menu').click();
    await wait(24);
    eq('回选档屏之后存档位仍是空的（回到菜单不许把赢下的局面又写回去）', E().Store.resume(), null);
    eq('菜单不再摆出一张可以继续的残局卡', shown('#resume-card'), false);
    const li = document.querySelectorAll('#record-list li')[0];
    eq('纪录表第一行是初学档', li.querySelector('span').textContent, '初学');
    ck('纪录表写着通关计时（mm:ss）', /^\d{2}:\d{2}$/.test(li.querySelector('b').textContent), li.querySelector('b').textContent);
    eq('纪录表写着提示 62 · 步数 0', li.querySelector('i').textContent, '提示 62 · 步数 0');
    const tierBest = document.querySelector('.tier[data-tier="trainee"] .tier-best').textContent;
    ck('档位卡上也写着同一个纪录（计时 + 提示 62）', /^\d{2}:\d{2} · 提示62$/.test(tierBest), tierBest);
    A().show('game');
    await wait(24);
    ck('回到棋盘，胜利遮罩还挂着', shown('#win-veil') && hitAt('#win-veil') === 'hit', hitAt('#win-veil'));

    // ---- 2. 赢完再撤销：局面必须退回未完成
    $('#btn-undo').click();
    await wait(24);
    const us = A().state();
    eq('赢后撤销一笔：status 回到 playing，星数读数一起改口',
      `${us.status},${us.stars}/${us.target},${text('#stat-stars')},${us.steps},${us.hints},${us.moves}`, 'playing,15/16,15/16,61,62,0');
    eq('遮罩跟着收回去，不再吞点击', `${shown('#win-veil')},${hitAt('#win-veil')}`, 'false,no-box');
    eq('状态行说的是「还差一颗」而不是结论（与 #stat-stars 同一件事）',
      `${text('#state-line')}|${$('#state-line').dataset.kind}`, '还差 1 颗星。3 格没定，21/24 个单元已经凑满。|info');
    readouts('赢后撤销');
    eq('一键标灰按钮重新可用（终局确实解除了）', $('#btn-prune').disabled, false);
    eq('撤销不掉求助：提示数不退账', us.hints, HINTS_TO_WIN);
    const back = E().Store.resume();
    eq('撤销之后是一盘没下完的棋，存档位上重新有了它', `${!!back},${back && back.seed},${back && back.hints},${back && back.moves}`, 'true,trainee-gate,62,0');
    const t2 = E().Store.totals();
    eq('撤销不追溯通关账（已经赢过的那一次不许被改回去）', `${t2.solved - t0.solved},${t2.hints - t0.hints}`, '1,62');
    const lastCell = A().game.lastHint.cell;
    eq('撤销抬走的就是第 62 次提示写下的那一格（第 8 行第 4 列）',
      `${A().valueOf(lastCell)},${lastCell}`, `${E().EMPTY},59`);
    A().tap(lastCell);
    await wait(24);
    const w2 = A().state();
    eq('自己把最后一颗星摆回去照样判胜（终局守卫已经解除）',
      `${w2.status},${w2.stars}/${w2.target},${w2.moves},${w2.hints}`, 'won,16/16,1,62');
    ck('第二次收官同样出现遮罩', shown('#win-veil') && hitAt('#win-veil') === 'hit', hitAt('#win-veil'));
    const m2 = text('#win-meta').split(' · ');
    eq('胜利卡改口：这一步记在玩家手上、提示仍是 62', `${m2[2]},${m2[3]}`, '步数 1,提示 62');
    const best2 = E().Store.best(c.tier);
    eq('档上的纪录仍是求助更少步数更省的那一局', `${best2.hints},${best2.moves}`, '62,0');
    const t3 = E().Store.totals();
    eq('两次通关都记进总数（+2 次、+124 提示）', `${t3.solved - t0.solved},${t3.hints - t0.hints}`, '2,124');
    eq('这一段没有 console 报错与未捕获异常', errors.join(' | '), '');

    // ---- 3. clash() 的每一个出口：指出的那一格必须画得出红框
    // 九个驱动覆盖 clash() 的全部 return：相邻枝、单元三星枝、凑不满枝的两个兜底出口、
    // 「没有合法摆法」枝的三个出口（有星 / 只有灰 / 星和灰都没有 —— 最后那个就是 cell: undefined），
    // 以及一个「什么都没破、只是把自己堵死」的 stuck 枝。cell/why 逐条在 node 里驱动同一个 Game 类量出来。
    const CLASH_CASES = [
      { tag: '两颗星挨着', unit: null, cell: 3, drive: [[4, E().STAR], [3, E().STAR]],
        why: '第1行4列 与 第1行5列 挨着——任何两颗星都不能相邻（含斜角）' },
      { tag: '一行三颗星', unit: 0, cell: 4, drive: [[0, E().STAR], [2, E().STAR], [4, E().STAR]],
        why: '第1行里有 3 颗星，每行只能 2 颗' },
      { tag: '一行全涂灰（一颗星没有）', unit: 0, cell: 0, drive: [0, 1, 2, 3, 4, 5, 6, 7].map((t) => [t, E().OUT]),
        why: '第1行 只剩 0 格没定，凑不满 2 颗（已有 0 颗）' },
      { tag: '一行一颗星加七格灰', unit: 0, cell: 0, drive: [[0, E().STAR]].concat([1, 2, 3, 4, 5, 6, 7].map((t) => [t, E().OUT])),
        why: '第1行 只剩 0 格没定，凑不满 2 颗（已有 1 颗）' },
      { tag: '第8区只剩相邻两格·有灰无星', unit: 23, cell: 37, drive: [[37, E().OUT], [46, E().OUT]],
        why: '第8区 已经没有合法摆法：没定的格两两相邻，放不下 2 颗不挨着的星' },
      { tag: '第8区里那颗星（记号 45）', unit: 23, cell: 45, drive: [[45, E().STAR]],
        why: '第8区 已经没有合法摆法：没定的格两两相邻，放不下 2 颗不挨着的星' },
      { tag: '第4区既没星也没灰（记号 52）', unit: 19, cell: 51, drive: [[52, E().STAR]],
        why: '第4区 已经没有合法摆法：没定的格两两相邻，放不下 2 颗不挨着的星' },
      { tag: '第7区既没星也没灰（记号 30）', unit: 22, cell: 6, drive: [[30, E().STAR]],
        why: '第7区 已经没有合法摆法：没定的格两两相邻，放不下 2 颗不挨着的星' },
      { tag: '没破规则但把自己堵死了（灰 8、9、10）', unit: null, cell: 10, drive: [[8, E().OUT], [9, E().OUT], [10, E().OUT]],
        why: '第2行3列 落下去之后线索就推不下去了：第2行 还差 2 颗星，可它的 2 个可放格配不出不挨着的一对' },
    ];
    const CONTROL = 63; // 上面九个格子里没有一格是它，也没有一颗破规则的星落在它上面
    const pointed = [];
    for (const k of CLASH_CASES) {
      A().adopt(A().puzzle);
      await wait(18);
      eq(`${k.tag}：先回到一张空盘`, `${A().state().steps},${A().state().hints},${A().state().status}`, '0,0,playing');
      for (const [t, v] of k.drive) A().tap(t, v);
      await wait(18);
      const cl = A().game.clash();
      ck(`${k.tag}：clash() 必须指出一格（不许是 undefined）`,
        !!cl && Number.isInteger(cl.cell) && cl.cell >= 0 && cl.cell < board.n, `cell=${cl && cl.cell}`);
      eq(`${k.tag}：指的就是钉下的那一格、那句话`, `${cl && cl.cell},${cl && cl.why}`, `${k.cell},${k.why}`);
      if (k.unit !== null) eq(`${k.tag}：指出的那一格属于这句话正在讲的单元`, board.units[k.unit].cells.indexOf(cl.cell) >= 0, true);
      await pressHint();
      const s = A().state();
      eq(`${k.tag}：提示闭嘴、一次也不扣、一格也不许多写`, `${s.hints},${s.cursor},${s.status}`, '0,0,playing');
      eq(`${k.tag}：面板说「提示没有扣次数」`, text('#hint-rule'), '提示没有扣次数');
      eq(`${k.tag}：面板让人先看红框那一格`, text('#hint-line'), '你的记号和线索推出来的结论冲突了：先看红框那一格。');
      eq(`${k.tag}：红框就画在这一格的 cellRect 上（${RING_SAMPLES} 个采样点全中）`, ringOnCellRect(cl.cell, TH().error), RING_SAMPLES);
      eq(`${k.tag}：对照格（记号 ${CONTROL}）画不出这个红框`, ringOnCellRect(CONTROL, TH().error), 0);
      pointed.push(cl.cell);
    }
    eq('九个出口各钉到一格（第三、四例都指第 1 行头一格，但走的是两个不同兜底出口）', pointed.join(','), '3,4,0,0,37,45,51,6,10');
    eq('这一段也没有 console 报错与未捕获异常', errors.join(' | '), '');
    return report({
      presses, undoStatus: us.status, wins: t3.solved - t0.solved, clashCells: pointed.join(','),
    });
  };

  w.__sc = { boot, gen, play, hint, win };

})(window);
