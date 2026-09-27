// Engine unit tests, run in plain Node: `node tools/engine-test.mjs`.
//
// The risk in this repo is not arithmetic but soundness. One rule that wrote a cell the clues do
// not force, and every board would still ship, the hints would still be self-consistent, and
// "每一局都能推到底" would be a caption on a coin flip. So the expectations below are hand-derived
// from boards worked out on paper and written as literals — never read back off the solver. When
// the engine disagrees with a literal, the engine is wrong until the paper says otherwise.
//
// The paper, though, is exactly where a hand-derived literal goes wrong, and 38 of the literals
// this file shipped with did. So a literal is no longer accepted on its own handwriting: every
// "有解 / 唯一 / 无解 / 这一格在每一个解里都成立" claim below is first re-proved by
// `enumerate()`, a *third* implementation written into this file straight from the four lines of
// README (two stars per row, per column, per region; no two stars touching). It shares no code with
// js/engine/rules.js (pencil derivation) or js/engine/count.js (row-pair DFS) — it walks cells in
// row-major order and only counts, and it enumerates *all* solutions rather than answering a
// yes/no. That gives each premise of each test block a truth set, and `guard()` now checks every
// write against that truth set instead of against one hand-written pattern: a grey must not be a
// star in *any* solution, a placed star must be a star in *all* of them. A premise with an empty
// truth set makes that check vacuous, so `guard()` refuses it out loud — which is how three of the
// ② anchors turned out to be seeded on cells no solution of this board ever uses.
//
// Five groups, in the order the promises are stated in README:
//   0. 随机数与日期键 — determinism, which every promise below is paid in
//   1. 盘面几何 — the board, the units, the eight-neighbourhood
//   2. 铅笔规则族 — six hand anchors, one per rule, plus the full pencil path
//   3. 唯一解复核 — the pencil path and the rule-free counter, compared cell by cell
//   4. 尺寸下限 — why there is no 5×5 tier
//   5. 生成盘 — the two implementations forced to agree on boards nobody hand-worked

import {
  createBoard,
  EMPTY,
  STAR,
  OUT,
  ROW,
  COL,
  REGION,
  isConnected,
  isArtPoint,
  starSet,
  sameStars,
  regionName,
} from '../js/engine/board.js';
import {
  Rules,
  RULE_LIST,
  propagate,
  closure,
  solve,
  nextForced,
  exclusions,
  verify,
  complete,
  diagnose,
  stuckReason,
  reachable,
  createState,
  snapshot,
  undoState,
  setCell,
  resetInk,
  tappedValue,
  countStars,
  inkConflict,
  diesAfterPlacement,
  lookaheadSweep,
  stats,
  placeable,
  completions,
} from '../js/engine/rules.js';
import { countSolutions, legalStarSet, UNIQUE, MANY, NONE, OVERBUDGET } from '../js/engine/count.js';
import { makeRng, hash32, dateKey } from '../js/engine/rng.js';
import { drawOne, solutionOf, inBand, TIERS } from '../js/engine/generate.js';
import { regionSizes } from '../js/engine/regions.js';

let pass = 0;
let fail = 0;
function eq(name, got, want, note = '') {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name}\n       got  ${a}\n       want ${b}${note ? `\n       note ${note}` : ''}`);
  }
}
function ok(name, cond, detail = '') {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}
function throws(fn) {
  try {
    fn();
    return '';
  } catch (e) {
    return String(e.message);
  }
}

const S = (size, r, c) => r * size + c;
// A partition written as rows of digits, exactly as it is drawn on paper.
const grid = (rows) => rows.join(' ').split(/\s+/).map(Number);
function marks(n, list) {
  const st = new Int8Array(n);
  for (const [r, c, v] of list) st[S(8, r, c)] = v;
  return st;
}
// Build a star array (1 for star, 0 otherwise) from 0-indexed [row, col] pairs.
const starArr = (list) => {
  const st = new Uint8Array(64);
  for (const [r, c] of list) st[S(8, r, c)] = 1;
  return st;
};
// A pattern written as rows of digits, in the shape starSet() returns.
const pattern = (rows) => Uint8Array.from(grid(rows));
// The [row, col] triples of a pattern's stars. NOTE: a typed array's .map() coerces whatever the
// callback returns down to a number, so `PAT.map((v, t) => (v ? [r, c] : null))` hands back 0s
// instead of pairs, `.filter(Boolean)` then drops every one of them, and a whole section of
// silently empty expectations goes green doing nothing. `Array.from` first, always.
const starTriples = (pat) =>
  Array.from(pat)
    .map((v, t) => (v ? [Math.floor(t / 8), t % 8, STAR] : null))
    .filter(Boolean);
const countStarsArr = (pat) => Array.from(pat).reduce((a, b) => a + b, 0);
// One sweep's writes, in a comparable shape: rule@cell, sorted. Sorted because the order a sweep
// emits in is an implementation detail of its loops; which facts it wrote is not.
const fmt = (found) => found.map((f) => `${f.rule.key}@${board.cellName(f.cell)}`).sort().join(' ');

// ---------------------------------------------------------------- 第三份实现：从规则原文枚举全部解
//
// Nothing in here reads js/engine/. It restates the rules as literally as README says them, walks
// the cells in row-major order, and prunes only on counts that cannot come back later (a row that
// is over its two is over, and a row still needing k stars when fewer than k cells are left in it
// is done). That is deliberately the slowest, dumbest shape of the search: it is the referee, and a
// referee may not share a single line of code with either player.
//
// It answers the two questions a hand-derived anchor cannot answer for itself: how many solutions
// does this premise have at all, and is this cell a star in every one of them.
const PER_UNIT_LITERALLY = 2;
function enumerate(size, region, { must = [], mustNot = [], cap = 4096 } = {}) {
  const n = size * size;
  const reg = Array.from(region);
  const banned = new Uint8Array(n);
  for (const t of mustNot) banned[t] = 1;
  const forced = new Uint8Array(n);
  for (const t of must) forced[t] = 1;
  for (const t of must) if (banned[t]) throw new Error('must 与 mustNot 撞在同一格上');
  const cellsOf = Array.from({ length: size }, () => []);
  for (let t = 0; t < n; t++) cellsOf[reg[t]].push(t);
  const needRow = Array(size).fill(PER_UNIT_LITERALLY);
  const needCol = Array(size).fill(PER_UNIT_LITERALLY);
  const needReg = Array(size).fill(PER_UNIT_LITERALLY);
  const shadow = new Int16Array(n);
  const star = new Uint8Array(n);
  const nbr = Array.from({ length: n }, (_, t) => {
    const r = Math.floor(t / size);
    const c = t % size;
    const l = [];
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        l.push(rr * size + cc);
      }
    return l;
  });
  const put = (t) => {
    star[t] = 1;
    needRow[Math.floor(t / size)]--;
    needCol[t % size]--;
    needReg[reg[t]]--;
    for (const u of nbr[t]) shadow[u]++;
  };
  const take = (t) => {
    star[t] = 0;
    needRow[Math.floor(t / size)]++;
    needCol[t % size]++;
    needReg[reg[t]]++;
    for (const u of nbr[t]) shadow[u]--;
  };
  for (const t of must) put(t);
  const sols = [];
  let capped = false;
  const go = (t) => {
    while (t < n && forced[t]) t++;
    if (t === n) {
      if (needRow.every((v) => v === 0) && needCol.every((v) => v === 0) && needReg.every((v) => v === 0)) sols.push(Uint8Array.from(star));
      return;
    }
    if (sols.length >= cap) {
      capped = true;
      return;
    }
    const r = Math.floor(t / size);
    const c = t % size;
    const g = reg[t];
    if (needRow[r] < 0 || needCol[c] < 0 || needReg[g] < 0) return;
    if (needRow[r] > size - c) return;
    if (needCol[c] > size - r) return;
    let left = 0;
    for (const u of cellsOf[g]) if (u >= t) left++;
    if (needReg[g] > left) return;
    if (shadow[t] === 0 && !banned[t]) put(t);
    else {
      go(t + 1);
      return;
    }
    go(t + 1);
    take(t);
    go(t + 1);
  };
  go(0);
  const any = new Uint8Array(n);
  const all = new Uint8Array(n);
  for (let t = 0; t < n; t++) all[t] = sols.length ? 1 : 0;
  for (const s of sols) for (let t = 0; t < n; t++) if (s[t]) any[t] = 1; else all[t] = 0;
  return { sols, n: sols.length, capped, any, all };
}

// 每一笔都必须对得上这一盘在**所有**解里的样子：标灰的格不许在任何一个解里是星，放星的格必须
// 在每一个解里都是星。这一条断言就是"零猜测"的全部含义 —— 它一红，承诺就是空话。
// 前提本身若无解，这个检查是空话（从矛盾什么都能推），所以它先自报解数：0 就当场红。
function guard(tag, found, premise = {}) {
  const tr = enumerate(size, ANCHOR, premise);
  eq(`${tag}：前提本身有解（无解的前提上"没写错"不算证据）`, tr.n > 0, true);
  const bad = found.filter((f) => (f.value === OUT ? !!tr.any[f.cell] : f.value === STAR && !tr.all[f.cell]));
  eq(`${tag}：没有一笔写在解的反面`, bad.map((f) => `${f.rule.key}@${board.cellName(f.cell)}`), []);
}

// ---------------------------------------------------------------- 手推盘面

// 8×8 切 8 区。A 阵每区正好两颗星；B 阵在第5区落下四颗、第8区一颗也没有 → 这一盘的唯一解是
// A 阵，而"8×8 只有 A、B 两种星阵"由本文件第 4 节用两条不含引擎代码的枚举现场证明。
const ANCHOR = grid([
  '0 0 0 0 0 1 1 1',
  '2 2 2 2 0 1 1 1',
  '2 2 2 2 0 1 1 3',
  '4 4 4 4 3 3 3 3',
  '4 4 4 4 3 3 3 3',
  '4 4 4 4 5 5 5 5',
  '6 6 6 6 7 5 5 5',
  '6 6 6 6 7 7 7 7',
]);
// A 阵：第1、3行的星在 2、4 列；第2、4行在 6、8 列；第5、7行在 1、3 列；第6、8行在 5、7 列。
const A_ROWS = [
  '0 1 0 1 0 0 0 0',
  '0 0 0 0 0 1 0 1',
  '0 1 0 1 0 0 0 0',
  '0 0 0 0 0 1 0 1',
  '1 0 1 0 0 0 0 0',
  '0 0 0 0 1 0 1 0',
  '1 0 1 0 0 0 0 0',
  '0 0 0 0 1 0 1 0',
];
const PAT_A = pattern(A_ROWS);
const PAT_B = pattern([
  '0 0 0 0 1 0 1 0',
  '1 0 1 0 0 0 0 0',
  '0 0 0 0 1 0 1 0',
  '1 0 1 0 0 0 0 0',
  '0 0 0 0 0 1 0 1',
  '0 1 0 1 0 0 0 0',
  '0 0 0 0 0 1 0 1',
  '0 1 0 1 0 0 0 0',
]);
// 退化切法：区域 = 行。区域约束与行约束完全重合，解多到数不完。
const ROW_BANDS = grid([
  '0 0 0 0 0 0 0 0',
  '1 1 1 1 1 1 1 1',
  '2 2 2 2 2 2 2 2',
  '3 3 3 3 3 3 3 3',
  '4 4 4 4 4 4 4 4',
  '5 5 5 5 5 5 5 5',
  '6 6 6 6 6 6 6 6',
  '7 7 7 7 7 7 7 7',
]);
// 第1区只有上下相邻的两格：区域要两颗星，可这两格挨着 → 整盘无解。
const NARROW = grid([
  '0 1 1 1 1 2 2 2',
  '0 1 1 2 2 2 2 2',
  '3 1 1 3 3 3 3 3',
  '3 3 3 3 3 3 3 3',
  '4 4 4 4 5 5 5 5',
  '4 4 4 4 5 5 5 5',
  '6 6 6 6 6 6 6 5',
  '7 7 7 7 7 7 7 7',
]);

const size = 8;
const board = createBoard({ size, region: ANCHOR, title: '手推盘' });
const bands = createBoard({ size, region: ROW_BANDS });
const A_CELLS = starTriples(PAT_A);
const A_IDX = [];
for (let t = 0; t < 64; t++) if (PAT_A[t]) A_IDX.push(t);

// ---------------------------------------------------------------- 锚点先行：三个主张先被复证

{
  // 本文件后面每一个期望值都建在"锚点盘唯一解是 A 阵"上。三张盘的解数由第三份实现现场数出来，
  // 不许引用任何引擎结论 —— 它红了，后面所有 guard() 就都不算证据。
  const a = enumerate(8, ANCHOR, { cap: 8 });
  eq('独立枚举：锚点盘恰好一个解', a.n, 1);
  eq('独立枚举：那一个解逐格等于手写的 A 阵', sameStars(a.sols[0], PAT_A), true);
  eq('独立枚举：B 阵不是锚点盘的解', a.sols.some((s) => sameStars(s, PAT_B)), false);
  const rb = enumerate(8, ROW_BANDS, { cap: 8 });
  eq('独立枚举：区域=行的退化盘恰好两个解', rb.n, 2);
  eq('独立枚举：这两个解就是 A 阵与 B 阵', [rb.sols.some((s) => sameStars(s, PAT_A)), rb.sols.some((s) => sameStars(s, PAT_B))].join(','), 'true,true');
  eq('独立枚举：窄区域盘零个解', enumerate(8, NARROW, { cap: 8 }).n, 0);
}

// ---------------------------------------------------------------- 0. 随机数与日期键

// ---------------------------------------------------------------- 0. 随机数与日期键

{
  const a = makeRng('seed-1');
  const b = makeRng('seed-1');
  eq('同种子同序列', [a.int(100), a.int(100), a.next()].join(','), [b.int(100), b.int(100), b.next()].join(','));
  ok('换种子就换序列', makeRng('seed-2').int(1e6) !== makeRng('seed-1').int(1e6));
  eq('序列取到头也不撞墙', makeRng('s').next(), makeRng('s').next());
  const d = makeRng('d');
  ok('pick 落在数组里', [1, 2, 3, 4].includes(d.pick([1, 2, 3, 4])), '');
  const src = [1, 2, 3, 4, 5, 6];
  eq('shuffle 不丢元素', d.shuffle(src).slice().sort().join(''), '123456');
  // 本族的 shuffle 是原地洗牌并返回同一个数组（js/engine/regions.js 的 polish 就先 shuffle 再
  // slice(0, probes) 取前几个，靠的正是原地）。原来这条把它钉成了"不原地改"。
  eq('shuffle 原地洗、返回同一个数组', d.shuffle(src) === src, true);
  eq('同种子洗出同一序', makeRng('sh').shuffle([1, 2, 3, 4, 5, 6, 7]).join(''), makeRng('sh').shuffle([1, 2, 3, 4, 5, 6, 7]).join(''));
  eq('int(n) 是 [0,n) 单参数（传第二个参数是调用方的错，不许静默当成 range）', [d.int(1), d.int(2) >= 0 && d.int(2) < 2 ? 'in' : 'out'].join(','), '0,in');
  ok('int 永远在自己的区间内', [...Array(400).keys()].every(() => { const v = d.int(7); return Number.isInteger(v) && v >= 0 && v < 7; }));
  const rg = [...Array(400).keys()].map(() => d.range(3, 7));
  ok('range(min,max) 闭区间', rg.every((v) => Number.isInteger(v) && v >= 3 && v <= 7) && Math.min(...rg) === 3 && Math.max(...rg) === 7, `${Math.min(...rg)}..${Math.max(...rg)}`);
  eq('hash32 稳定', hash32('starbattle'), hash32('starbattle'));
  ok('hash32 分得开', hash32('starbattle') !== hash32('starbattle-'));
  // dateKey 交回的是 {key, epochDays} 一个对象（与同族 akari/shikaku 的 dateSeed 同形）。
  eq('dateKey 形状', [typeof dateKey(), Array.isArray(dateKey()), Object.keys(dateKey()).sort().join(',')].join('|'), 'object|false|epochDays,key');
  eq('dateKey 的键是 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(dateKey().key), true);
  eq('dateKey(0) 与本机同日', dateKey(0).key, dateKey().key);
  eq('dateKey 能倒退一天', Date.parse(dateKey(-1).key), Date.parse(dateKey(0).key) - 86400000);
  eq('epochDays 与键自洽', dateKey(0).epochDays, Math.floor(Date.parse(dateKey(0).key) / 86400000));
  eq('dateKey 也能前进一天', Date.parse(dateKey(1).key), Date.parse(dateKey(0).key) + 86400000);
  // 日课的键只由当天决定：这两条以前拿着整个对象去 Date.parse / hash32，被隐式转成
  // "[object Object]" 之后恰好通过 —— 形状改了也照样绿，是空断言。
  eq('日课的键与随机数无关（同一天永远同一局）', hash32(dateKey(0).key), hash32(dateKey().key));
  {
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    const hand = `${noon.getFullYear()}-${String(noon.getMonth() + 1).padStart(2, '0')}-${String(noon.getDate()).padStart(2, '0')}`;
    eq('键说的就是本机日历的那一天（正午锚定：过午夜也不换题）', dateKey().key, hand);
  }
}

// ---------------------------------------------------------------- 1. 盘面几何

{
  eq('区域数 = N', board.cellsOf.length, size);
  eq('单元数 = 行 + 列 + 区域 = 3N', board.units.length, 24);
  eq('区号顺序：先 8 行、再 8 列、再 8 区域', board.units.map((u) => u.kind).join(','), [...Array(8).fill(ROW), ...Array(8).fill(COL), ...Array(8).fill(REGION)].join(','));
  eq('要放的星数 = 2N', board.starTotal, 16);
  eq('每格同时被三条计数管着', board.cellUnits.every((l) => l.length === 3), true);
  eq('每格被自己的三个单元各收一次', board.cellUnits.every((l, t) => l.every((ui) => board.units[ui].cells.indexOf(t) >= 0)), true);
  eq('单元里的格子不重复', board.units.every((u) => new Set(u.cells).size === u.cells.length), true);
  eq('每格在单元内的序号', board.units[0].positions[S(8, 0, 5)], 5);
  eq('区域格数之和 = N²', board.cellsOf.reduce((a, b) => a + b.length, 0), 64);
  eq('区域格数（手工数过：7,8,8,9,12,7,8,5）', board.cellsOf.map((c) => c.length).join(','), '7,8,8,9,12,7,8,5');
  eq('手工切的盘每区都连通', board.cellsOf.every((cells) => isConnected(cells, size)), true);
  eq('区域名从 1 起', [regionName(0), regionName(7)].join(','), '第1区,第8区');
  eq('三种单元的名字', [board.unitName(0), board.unitName(8), board.unitName(16)].join(','), '第1行,第1列,第1区');
  eq('单元种类中文名', [board.unitKindName(0), board.unitKindName(8), board.unitKindName(16)].join(','), '行,列,区域');
  eq('角格三邻、边格五邻、心格八邻', [board.neighbors[S(8, 0, 0)].length, board.neighbors[S(8, 0, 4)].length, board.neighbors[S(8, 4, 4)].length].join(','), '3,5,8');
  eq('邻域含斜角', board.neighbors[S(8, 4, 4)].includes(S(8, 3, 3)), true);
  eq('邻域不含自己', board.neighbors[S(8, 4, 4)].includes(S(8, 4, 4)), false);
  eq('邻接对称', board.neighbors.every((l, t) => l.every((nb) => board.neighbors[nb].indexOf(t) >= 0)), true);
  eq('邻接不越界', board.neighbors.every((l, t) => l.every((nb) => Math.abs(board.rowOf(nb) - board.rowOf(t)) <= 1 && Math.abs(board.colOf(nb) - board.colOf(t)) <= 1)), true);
  eq('cellName 是玩家看得懂的话', board.cellName(S(8, 2, 4)), '第3行5列');
  eq('rowOf/colOf', [board.rowOf(20), board.colOf(20)].join(','), '2,4');
  eq('每区的行后缀表加到区大小', board.regionRows.every((rr, g) => rr.suffix[0] === board.cellsOf[g].length), true);
  // regionRows 是 [区域][行] 的表 —— "第3行在第5列上的格子数"这个问法读错了它的下标（那是
  // ANCHOR[2][4]，一个格子，不是一张计数表）。按它的真实语义把整张表手推出来钉住：
  //   第1区 行1..行3 各 5,1,1 格；第2区 3,3,2；第3区 4,4；第4区 1,4,4；第5区 4,4,4；
  //   第6区 4,3；第7区 4,4；第8区 1,4。每行的数字加起来就是上面手工数过的区大小。
  eq('行后缀表：每区在每行各占几格（整张手推）', board.regionRows.map((rr, g) => `${g}:${rr.perRow.join('')}`).join(' '), '0:51100000 1:33200000 2:04400000 3:00144000 4:00044400 5:00000430 6:00000044 7:00000014');
  eq('行后缀表：第8区在第7行 1 格、第8行 4 格', [board.regionRows[7].perRow[6], board.regionRows[7].perRow[7]].join(','), '1,4');
  // suffix 是 size+1 长的累加表，最后一格是 0 哨兵（suffix[r] = 该区在第 r 行往下的格数），
  // 这样 rules.js 取 suffix[r] 时不必为最后一行写特例。
  eq('行后缀表：后缀 = 该区在第 r 行往下的格数（末尾 0 是哨兵）', board.regionRows[0].suffix.join(','), '7,2,1,0,0,0,0,0,0');
  eq('行后缀表：第7区（第 7、8 行各 4 格）的后缀是 8,8,8,8,8,8,8,4,0', board.regionRows[6].suffix.join(','), '8,8,8,8,8,8,8,4,0');
  eq('行后缀表自洽：每一格都等于 perRow 从那一行往下的和', board.regionRows.every((rr) => rr.suffix.length === size + 1 && rr.suffix[size] === 0 && rr.suffix.every((v, r) => rr.perRow.slice(r).reduce((a, b) => a + b, 0) === v)), true);
  eq('星集只认星', [...starSet(board, marks(64, [[0, 1, STAR], [0, 3, STAR], [1, 5, OUT]]))].reduce((a, b) => a + b, 0), 2);
  eq('sameStars 只比星位、不比灰', sameStars(starSet(board, marks(64, [[0, 1, STAR], [0, 3, STAR]])), starSet(board, marks(64, [[0, 1, STAR], [0, 3, STAR], [5, 5, OUT]]))), true);
  eq('sameStars 认得出换了星', sameStars(starSet(board, marks(64, [[0, 1, STAR]])), starSet(board, marks(64, [[0, 3, STAR]]))), false);
  eq('EMPTY 与 0 同为空（哨兵不与合法值混）', [new Int8Array(4).every((v) => v === EMPTY), Int8Array.of(0, 0, 0, 0).every((v) => v === EMPTY)].join(','), 'true,true');
  eq('星与灰都不算空', [Int8Array.of(EMPTY, STAR).every((v) => v === EMPTY), Int8Array.of(EMPTY, OUT).every((v) => v === EMPTY)].join(','), 'false,false');
  eq('连通判定：直排连通', isConnected([0, 1, 2, 3], 4), true);
  eq('连通判定：L 形连通', isConnected([0, 1, 2, 5], 3), true);
  eq('连通判定：对角不连通', isConnected([0, 4], 3), false);
  eq('割点判定：直排中间那格是割点', isArtPoint([0, 1, 2, 3], 4, 1), true);
  eq('割点判定：端点不是割点', isArtPoint([0, 1, 2, 3], 4, 0), false);
  eq('单格区域没有割点', isArtPoint([7], 4, 7), false);
  eq('第1区靠 (1,4) 接上 (2,4) → 它是割点', isArtPoint(board.cellsOf[0], size, S(8, 1, 4)), true);
  // 第1区是一条 7 格的路：(0,0)(0,1)(0,2)(0,3)(0,4)-(1,4)-(2,4)。路上任何一格都不是端点的都不许
  // 被叫成割点 —— 原来这条把 (0,2) 钉成了"不是割点"，而它明明是路的中段。
  eq('第1区是 7 格的路：中段 (0,2) 是割点', isArtPoint(board.cellsOf[0], size, S(8, 0, 2)), true);
  eq('第1区的两个端点 (0,0) 与 (2,4) 不是割点', [isArtPoint(board.cellsOf[0], size, S(8, 0, 0)), isArtPoint(board.cellsOf[0], size, S(8, 2, 4))].join(','), 'false,false');
  eq('第1区 7 格里只有 5 个割点', board.cellsOf[0].filter((t) => isArtPoint(board.cellsOf[0], size, t)).length, 5);
}

// ---------------------------------------------------------------- 2. 铅笔规则族：六条手推锚点

{
  // B 阵的行/列/相邻自检用本文件自己的循环算，不借引擎的任何函数。
  const tally = (pat, idx) => {
    const rows = Array(8).fill(0);
    const cols = Array(8).fill(0);
    let adj = 0;
    for (let t = 0; t < 64; t++) {
      if (!pat[t]) continue;
      rows[Math.floor(t / 8)]++;
      cols[t % 8]++;
      for (let u = t + 1; u < 64; u++) if (pat[u] && Math.abs(Math.floor(u / 8) - Math.floor(t / 8)) <= 1 && Math.abs((u % 8) - (t % 8)) <= 1) adj++;
    }
    return { rows, cols, adj };
  };
  const bA = tally(PAT_B);
  const B_ROWS = bA.rows;
  const B_COLS = bA.cols;
  const B_ADJACENT = bA.adj;
  const aA = tally(PAT_A);
  // 锚点盘自己先得合法：A 阵每区两颗、B 阵在第5区四颗 —— 这一节全部期望值建在这两个手数的事实上。
  eq('A 阵每区正好两颗星', board.cellsOf.map((cells) => cells.filter((t) => PAT_A[t]).length).join(','), '2,2,2,2,2,2,2,2');
  eq('A 阵也是 16 星、每行每列两颗、零对相邻', [countStarsArr(PAT_A), aA.rows.join(''), aA.cols.join(''), aA.adj].join(' | '), '16 | 22222222 | 22222222 | 0');
  // B 阵的分区计数手推：第1~4区各 2 颗、第5区 4 颗（(2,7)(3,4)(3,7)(4,4)... 见下方 literal）、
  // 第6区 2 颗、第7区 2 颗、第8区 0 颗。原来写的 '2,2,2,2,4,0,2,0' 加起来只有 12 颗，而 B 阵
  // 是一个 16 星的星阵 —— 那个字串本身就凑不出 2N，引擎报的才是数出来的。
  eq('B 阵每行两颗、每列两颗、互不相邻（它就是 8×8 的第二种星阵）', [countStarsArr(PAT_B), B_ROWS.join(','), B_COLS.join(','), B_ADJACENT].join(' | '), '16 | 2,2,2,2,2,2,2,2 | 2,2,2,2,2,2,2,2 | 0');
  eq('B 阵在第5区落下四颗 → 它不是这一盘的解', board.cellsOf.map((cells) => cells.filter((t) => PAT_B[t]).length).join(','), '2,2,2,2,4,2,2,0');
  eq('B 阵的第8区一颗也没有（第5区四颗、第8区零颗，两处都违反区域计数）', [board.cellsOf[4].filter((t) => PAT_B[t]).length, board.cellsOf[7].filter((t) => PAT_B[t]).length].join(','), '4,0');
  eq('A 阵每行两颗', board.rows.every((row) => row.filter((t) => PAT_A[t]).length === 2), true);
  eq('A 阵每列两颗', board.cols.every((col) => col.filter((t) => PAT_A[t]).length === 2), true);
  eq('A 阵没有相邻的两颗', board.neighbors.every((l, t) => !PAT_A[t] || l.every((nb) => !PAT_A[nb])), true);
  eq('A 阵一共 2N 颗', A_IDX.length, 16);
  eq('A 阵的星位三元组非空（typed-array 的 .map 会把数组折成 0，这一条盯住它）', A_CELLS.length, 16);
}

{
  // ② 星的邻域 —— 一颗星把它八邻域里在场的格全标灰。
  // 手推三格数：角上 3、边上 5、心里 8（斜角也算挨着，这是本作的核心几何）。
  // 但 (0,0)(0,4)(4,4) 这三格里没有任何一格在锚点盘的解中：独立枚举说锚点盘只有一个解（就是
  // A 阵），而这三格都不在 A 阵里。于是"写下的每一格都对得上 A 阵"这个 guard 在这里根本无从
  // 谈起 —— 前提无解时什么都能"推"出来。原来那三条 guard 就是这么静默通过的。
  for (const [at, want, where] of [[[0, 0], 3, '角'], [[0, 4], 5, '上边'], [[4, 4], 8, '心']]) {
    const cell = S(8, at[0], at[1]);
    const st = marks(64, [[at[0], at[1], STAR]]);
    const s = propagate(board, st);
    const adj = s.found.filter((f) => f.rule === Rules.adj);
    eq(`② 星的邻域@${where}：标灰格数`, adj.length, want);
    eq(`② 星的邻域@${where}：这条规则一颗星也不放`, adj.filter((f) => f.value === STAR).length, 0);
    ok(`② 星的邻域@${where}：写的都是邻域格`, adj.every((f) => board.neighbors[cell].includes(f.cell)), fmt(s.found));
    eq(`② 星的邻域@${where}：邻域那一笔全是灰`, adj.every((f) => f.value === OUT), true);
    eq(`② 星的邻域@${where}：这颗星在锚点盘上根本放不进去（独立枚举的解数 = 0）`, enumerate(size, ANCHOR, { must: [cell], cap: 8 }).n, 0);
    // 放不进去的原因就在这条规则自己身上：它灰掉的那几格里有 A 阵非用不可的星。
    ok(`② 星的邻域@${where}：它灰掉了 A 阵要用的那一格（这才是这颗星放不进去的原因）`, adj.some((f) => PAT_A[f.cell]), fmt(s.found));
  }
  {
    // 前提可满足时才轮到 guard 上场：这颗星取 A 阵第1行的 (0,1)。
    const st = marks(64, [[0, 1, STAR]]);
    const s = propagate(board, st);
    guard('② 星的邻域@可放格（第1行2列）', s.found, { must: [S(8, 0, 1)] });
    eq('② 第1行2列 那颗星写出邻域五笔（外加空盘那一笔摆不下）', fmt(s.found), 'adj@第1行1列 adj@第1行3列 adj@第2行1列 adj@第2行2列 adj@第2行3列 dead@第2行7列');
    eq('② 提示词点名那颗星', s.found[0].rule.text(board, s.found[0]), '第1行2列 放了星，它的八邻域（含斜角）都不能再放——第1行1列 标灰');
    eq('② 这一盘在这种前提下只剩 A 阵一个解', enumerate(size, ANCHOR, { must: [S(8, 0, 1)], cap: 8 }).n, 1);
  }
  {
    // 铅笔规则不完备，所以"前提无解"这件事它并不总是当场报出来 —— 记下来，别当成报了什么。
    const corner = propagate(board, marks(64, [[0, 0, STAR]]));
    const edge = propagate(board, marks(64, [[0, 4, STAR]]));
    const heart = propagate(board, marks(64, [[4, 4, STAR]]));
    eq('② 无解前提 (0,0)：引擎不报矛盾（它推不出两步以外）', corner.conflict, undefined);
    eq('② 无解前提 (0,4)：引擎不报矛盾', edge.conflict, undefined);
    ok('② 无解前提 (4,4)：引擎两步内报出矛盾', !!heart.conflict, String(heart.conflict));
    ok('② 无解前提 (4,4)：于是它会替玩家落一颗 A 阵里没有的星（不完备的代价）', heart.found.some((f) => f.value === STAR && !PAT_A[f.cell]), fmt(heart.found));
    eq('② 三颗不可能的位置各自写下几笔（4 / 6 / 13，全表见下两条）', [corner.found.length, edge.found.length, heart.found.length].join(','), '4,6,13');
    eq('② 无解前提 (0,0) 写下的是哪几笔', fmt(corner.found), 'adj@第1行2列 adj@第2行1列 adj@第2行2列 dead@第2行7列');
    eq('② 无解前提 (0,4) 写下的是哪几笔', fmt(edge.found), 'adj@第1行4列 adj@第1行6列 adj@第2行4列 adj@第2行5列 adj@第2行6列 dead@第2行7列');
  }
  const st = marks(64, [[4, 4, STAR]]);
  propagate(board, st);
  eq('② 斜角那格确实不能放', placeable(board, st, stats(board, st), S(8, 3, 3)), false);
  eq('② 隔两格还能放', placeable(board, st, stats(board, st), S(8, 2, 4)), true);
}

{
  // ① 满额排除 —— 行 / 列 / 区域一旦有了两颗星，其余格子一 tap 全灰。
  // 手推：第1行放上 A 阵的两颗 (0,1)(0,3) →
  //   星的邻域 8 格：(0,0)(0,2)(0,4) 与 (1,0)(1,1)(1,2)(1,3)(1,4)
  //   第1行满 → 其余 3 格 (0,5)(0,6)(0,7)
  //   第1区满（两颗都在这一区）→ 它剩下的可放格只有 (2,4)
  //   第2行只剩 (1,5)(1,6)(1,7) 三格要两颗 → 不挨着的摆法只有 {(1,5),(1,7)} → 只剩这一对
  const st = marks(64, [[0, 1, STAR], [0, 3, STAR]]);
  const s = propagate(board, st);
  eq('① 这一轮共写 15 格', s.found.length, 15);
  eq('① 写了什么', fmt(s.found), 'adj@第1行1列 adj@第1行3列 adj@第1行5列 adj@第2行1列 adj@第2行2列 adj@第2行3列 adj@第2行4列 adj@第2行5列 dead@第2行7列 full@第1行6列 full@第1行7列 full@第1行8列 full@第3行5列 pair@第2行6列 pair@第2行8列');
  eq('① 满额排除写 4 格', s.found.filter((f) => f.rule === Rules.full).length, 4);
  eq('① 第1区满之后最后一格 (2,4) 也标灰', st[S(8, 2, 4)], OUT);
  eq('① 星数 = 玩家放的 2 + 强制出的 2', countStars(st), 4);
  eq('① 第1区 7 格里 2 星 5 灰', [board.cellsOf[0].filter((t) => st[t] === STAR).length, board.cellsOf[0].filter((t) => st[t] === OUT).length].join(','), '2,5');
  guard('① 满额排除', s.found, { must: [S(8, 0, 1), S(8, 0, 3)] });
  const fullText = s.found.find((f) => f.rule === Rules.full);
  eq('① 提示词数得对', fullText.rule.text(board, fullText), '第1行 的 2 颗星已经放满，其余 3 格都不能再放——第1行6列 标灰');
  // 列满了也一样：A 阵在第5列的两颗是 (5,4)(7,4)
  const col = marks(64, [[5, 4, STAR], [7, 4, STAR]]);
  propagate(board, col);
  eq('① 第5列满 → 其余六格全灰', board.cols[4].filter((t) => col[t] === OUT).length, 6);
  eq('① 第5列不多不少两颗', board.cols[4].filter((t) => col[t] === STAR).length, 2);
  eq('① 满额的单位名要么是行要么是列', s.found.filter((f) => f.rule === Rules.full).every((f) => /行|列|区/.test(f.unit)), true);
  eq('① 这两颗星确实是锚点盘唯一解里的两颗', enumerate(size, ANCHOR, { must: [S(8, 0, 1), S(8, 0, 3)], cap: 8 }).n, 1);
}

{
  // ③ 只差这些 —— 一个单元还差 k 颗星、只剩 k 格可放 → 这 k 格全是星。
  // 手推：第8区 = {(6,4),(7,4),(7,5),(7,6),(7,7)} 五格，把 (6,4)(7,5)(7,7) 标灰 →
  //   只剩 (7,4)(7,6) 两格、中间隔着一格不相邻 → 两颗都必须放（正是 A 阵在这一区的两颗）。
  //   连带：(7,4) 的斜邻域封掉 (6,3)，第7行只剩 (6,0)(6,1)(6,2) → 不挨着的一对只剩 {(6,0),(6,2)}。
  // 一轮 sweep 不是"推到底"：only / pair 放下的四颗星，它们的八邻域阴影要到**下一轮**才写
  // （propagate 的邻域相位在本轮开头，那时那四颗还不存在）。所以这里数得清三轮：
  //   第 1 轮 6 笔（dead×2、only×2、pair×2）→ 第 2 轮 12 笔（全是邻域阴影）→ 第 3 轮 0 笔（收敛）。
  //   3 笔玩家灰 + 6 + 12 = 21 格有了记号。
  const st = marks(64, [[6, 4, OUT], [7, 5, OUT], [7, 7, OUT]]);
  const s = propagate(board, st);
  eq('③ 只差这些 + 连带出的只剩这一对', fmt(s.found), 'dead@第2行7列 dead@第7行2列 only@第8行5列 only@第8行7列 pair@第7行1列 pair@第7行3列');
  eq('③ 只差这些写两颗（一格一笔）', s.found.filter((f) => f.rule === Rules.only).length, 2);
  eq('③ 第8区 的两颗落位', [st[S(8, 7, 4)], st[S(8, 7, 6)]].join(','), `${STAR},${STAR}`);
  guard('③ 只差这些', s.found, { mustNot: [S(8, 6, 4), S(8, 7, 5), S(8, 7, 7)] });
  const s2 = propagate(board, st);
  eq('③ 第二轮补的是那四颗星的邻域阴影，12 笔', fmt(s2.found), 'adj@第6行1列 adj@第6行2列 adj@第6行3列 adj@第6行4列 adj@第7行4列 adj@第7行6列 adj@第7行7列 adj@第7行8列 adj@第8行1列 adj@第8行2列 adj@第8行3列 adj@第8行4列');
  eq('③ 第二轮一笔不放星', s2.found.filter((f) => f.value === STAR).length, 0);
  guard('③ 第二轮的邻域阴影', s2.found, { mustNot: [S(8, 6, 4), S(8, 7, 5), S(8, 7, 7)] });
  eq('③ 第三轮推完就收敛', propagate(board, st).found.length, 0);
  eq('③ 盘上共 21 格有了记号', [...st].filter((v) => v !== EMPTY).length, 21);
  eq('③ 其中 4 星 17 灰', [countStars(st), [...st].filter((v) => v === OUT).length].join(','), '4,17');
  eq('③ 没定的格 = 64 - 21', [...st].filter((v) => v === EMPTY).length, 43);
  const onlyText = s.found.find((f) => f.rule === Rules.only);
  eq('③ 提示词点名区域', onlyText.rule.text(board, onlyText), '第8区 还差 2 颗星，而它只剩 2 格可放——这些格每一格都必须放星，第8行5列 在内');
  // 行也能用这条：第1行只剩 (0,1)(0,3) 两格可放
  const rowOnly = marks(64, [[0, 0, OUT], [0, 2, OUT], [0, 4, OUT], [0, 5, OUT], [0, 6, OUT], [0, 7, OUT]]);
  const rs = propagate(board, rowOnly);
  eq('③ 第1行只剩两格 → 只差这些两颗', rs.found.filter((f) => f.rule === Rules.only && board.rowOf(f.cell) === 0).length, 2);
  eq('③ 那一行两颗都放上了', [rowOnly[S(8, 0, 1)], rowOnly[S(8, 0, 3)]].join(','), `${STAR},${STAR}`);
  guard('③ 行的只差这些', rs.found, { mustNot: [S(8, 0, 0), S(8, 0, 2), S(8, 0, 4), S(8, 0, 5), S(8, 0, 6), S(8, 0, 7)] });
}

{
  // ④ 摆不下 —— 某个单元的合法摆法里根本没有这一格 → 标灰。空盘上这一盘只有一处，纯几何：
  // 第2区 = {(0,5)(0,6)(0,7)(1,5)(1,6)(1,7)(2,5)(2,6)}，(1,6) 与区内其余 7 格全部相邻（含斜角），
  // 谁跟它配都挨着 → 它不在任何一种摆法里。
  const empty = new Int8Array(64);
  const st = new Int8Array(64);
  const s = propagate(board, st);
  eq('④ 空盘这一轮只写一格', fmt(s.found), 'dead@第2行7列');
  eq('④ 那一格的规则名是 摆不下', s.found[0].rule.key, Rules.dead.key);
  ok('④ 文本点名了第2区', /第2区/.test(s.found[0].rule.text(board, s.found[0])), s.found[0].rule.text(board, s.found[0]));
  // completions 读的是**当前**盘面：上面那一笔已经把 (1,6) 灰掉了，可放格于是从 8 变 7。
  // 原来这条拿着写过之后的 st 去要"空盘的 8 格"，量的是两轮之后。
  const c0 = completions(board, empty, stats(board, empty), size * 2 + 1);
  eq('④ 第2区 空盘差两颗、八个可放格', `${c0.need},${c0.cand.length}`, '2,8');
  eq('④ 第2区 灰掉那一格之后差两颗、七个可放格', (() => { const c = completions(board, st, stats(board, st), size * 2 + 1); return `${c.need},${c.cand.length}`; })(), '2,7');
  ok('④ 没有任何一种摆法带着 (1,6)', !c0.sets.some((set) => set.includes(S(8, 1, 6))), JSON.stringify(c0.sets.map((x) => x.map((t) => board.cellName(t))).slice(0, 5)));
  // 第2区的八格自己两两数一遍（不借引擎）：不挨着的一对共 11 种，且没有一种用到 (1,6)。
  const R2 = [[0, 5], [0, 6], [0, 7], [1, 5], [1, 6], [1, 7], [2, 5], [2, 6]].map(([r, c]) => S(8, r, c));
  let hand = 0;
  for (let i = 0; i < R2.length; i++)
    for (let j = i + 1; j < R2.length; j++) {
      const a = R2[i];
      const b = R2[j];
      if (Math.abs(Math.floor(a / 8) - Math.floor(b / 8)) <= 1 && Math.abs((a % 8) - (b % 8)) <= 1) continue;
      hand++;
    }
  eq('④ 第2区不挨着的星对数（本文件两两数过）', hand, 11);
  eq('④ completions 数出同样的 11 种摆法', c0.sets.length, hand);
  eq('④ 这 11 种摆法里 (1,6) 一次也没出现', c0.sets.filter((x) => x.includes(S(8, 1, 6))).length, 0);
  eq('④ 摆法没被上限截断（结论不是"看不全"蒙出来的）', String(c0.capped), 'false');
  guard('④ 摆不下', s.found);
  eq('④ 空盘不强制任何一颗星', s.found.filter((f) => f.value === STAR).length, 0);
  // 宽区域不逼星：第5区 12 格，A 阵的两颗在里面，空盘上一笔不写
  const cw = completions(board, empty, stats(board, empty), size * 2 + 4);
  eq('④ 第5区 12 格', board.cellsOf[4].length, 12);
  ok('④ 12 格里能配出很多对 → 第5区一笔都不写', cw.sets.length > 20, String(cw.sets.length));
  eq('④ 第5区每个可放格都出现在某种摆法里', cw.cand.every((t) => cw.sets.some((set) => set.includes(t))), true);
  eq('④ 空盘上第5区一笔不写', s.found.filter((f) => f.unit === '第5区').length, 0);
  // 独立枚举复核：(1,6) 在锚点盘的唯一解里确实不是星
  eq('④ 独立枚举：(1,6) 在零个解里是星', enumerate(size, ANCHOR, {}).any[S(8, 1, 6)], 0);
}

{
  // ⑤ 只剩这一对 —— 可放格多于两颗，但互不相邻的摆法只剩一种。
  // 手推：第4区 = {(2,7),(3,4),(3,5),(3,6),(3,7),(4,4),(4,5),(4,6),(4,7)}，
  //   把 (2,7)(3,4)(4,4)(4,5)(4,6)(4,7) 标灰（这六格在 A 阵里都不是星）→
  //   剩 (3,5)(3,6)(3,7) 三格要两颗：(3,6) 与两边都挨着 → 唯一摆法 {(3,5),(3,7)}。
  const greyed = [[2, 7], [3, 4], [4, 4], [4, 5], [4, 6], [4, 7]];
  const st = marks(64, greyed.map(([r, c]) => [r, c, OUT]));
  const s = propagate(board, st);
  eq('⑤ 只剩这一对两颗 + 中间那格摆不下（外加空盘那一笔）', fmt(s.found), 'dead@第2行7列 dead@第4行7列 pair@第4行6列 pair@第4行8列');
  eq('⑤ 强制星恰好两颗', s.found.filter((f) => f.value === STAR).length, 2);
  eq('⑤ (3,5) 与 (3,7) 成了星', [st[S(8, 3, 5)], st[S(8, 3, 7)]].join(','), `${STAR},${STAR}`);
  eq('⑤ 中间那格成了灰', st[S(8, 3, 6)], OUT);
  guard('⑤ 只剩这一对', s.found, { mustNot: greyed.map(([r, c]) => S(8, r, c)) });
  const pairText = s.found.find((f) => f.rule === Rules.pair);
  eq('⑤ 提示词说清"三个可放格只剩一种摆法"', pairText.rule.text(board, pairText), '第4区 还差 2 颗星，可放格有 3 个，但互不相邻的摆法只剩一种——第4行6列 必须在内');
  eq('⑤ 这一盘的 只剩这一对 权重是 4', Rules.pair.weight, 4);
  eq('⑤ 独立枚举：这六格灰掉之后仍然只剩 A 阵一个解', enumerate(size, ANCHOR, { mustNot: greyed.map(([r, c]) => S(8, r, c)), cap: 8 }).n, 1);
}

{
  // ⑥ 试放即死 —— 放下去会在两步之内撞墙：简报里的第 ④ 条铅笔规则。
  // 手推链一（第2行4列）：若 (1,3) 有星 → 邻域封掉第1区的 (0,2)(0,3)(0,4)(1,4)(2,4)
  //   → 第1区只剩 (0,0)(0,1) 两格要两颗 → 只差这些把两格都写成星 → 这两格挨着 → 撞墙。
  // 手推链二（第2行2列）：若 (1,1) 有星 → 邻域封掉第1区的 (0,0)(0,1)(0,2)
  //   → 第1区的摆法只剩 {(0,3),(2,4)} 与 {(0,4),(2,4)} → (2,4) 每阵都在 → 只剩这一对写下 (2,4)
  //   → (2,4) 的邻域再把第3区仅剩的两个可放格 (1,3)(2,3) 封掉 → 第3区差一颗、可放格 0 个 → 撞墙。
  const st = new Int8Array(64);
  const r1 = diesAfterPlacement(board, st, S(8, 1, 3));
  ok('⑥ 链一判死', !!r1, String(r1));
  ok('⑥ 链一撞的是"两颗星相邻"', /挨着/.test(r1 || ''), r1);
  const r2 = diesAfterPlacement(board, st, S(8, 1, 1));
  ok('⑥ 链二判死', !!r2, String(r2));
  ok('⑥ 链二撞的是第3区配不出', /第3区/.test(r2 || ''), r2);
  eq('⑥ 探测不改玩家的盘面', [...st].filter((v) => v !== 0).length, 0);
  // 反方向必须同样成立：解里的每一格都不许被判死。手算的 A 阵有 16 颗，逐颗试。
  const wrong = A_IDX.filter((t) => diesAfterPlacement(board, st, t) !== null).map((t) => board.cellName(t));
  eq('⑥ A 阵的 16 颗星没有一颗被判死', wrong, []);
  const dead = [];
  for (let t = 0; t < 64; t++) if (diesAfterPlacement(board, st, t) !== null) dead.push(t);
  eq('⑥ 空盘逐格判死 11 格，逐格手推名单', dead.map((t) => board.cellName(t)).sort().join(' '), '第2行2列 第2行4列 第2行7列 第5行5列 第5行6列 第7行4列 第7行5列 第7行6列 第7行7列 第7行8列 第8行4列');
  eq('⑥ 判死的格没有一颗是解', dead.filter((t) => PAT_A[t]).length, 0);
  // lookaheadSweep 与逐格探测不是一回事：它一边扫一边把结论写回盘面，后面的格子看到的已经是
  // 灰了一半的盘 —— 于是它能多判死 12 格。原来的"同一批格"把带连锁的整盘扫当成逐格探测，
  // 量错了对象。两者的关系是超集，这条关系才是可证的：
  const sweep = new Int8Array(64);
  const writes = lookaheadSweep(board, sweep);
  eq('⑥ 整盘前瞻写出 23 格（带连锁：比逐格探测多 12 格）', writes.length, 23);
  eq('⑥ 整盘前瞻的名单', writes.map((w) => w.cell).sort((a, b) => a - b).join(','), '9,11,14,24,26,27,36,37,38,39,40,41,42,43,51,52,53,54,55,56,57,58,59');
  eq('⑥ 前瞻写的全是灰', [...sweep].filter((v) => v === OUT).length, 23);
  eq('⑥ 前瞻一颗星也不放', countStars(sweep), 0);
  ok('⑥ 逐格判死的 11 格全在前瞻名单里（前瞻 ⊇ 逐格）', dead.every((t) => writes.some((w) => w.cell === t)), '');
  eq('⑥ 前瞻多出来的 12 格（连锁的产物）', writes.map((w) => w.cell).filter((t) => !dead.includes(t)).sort((a, b) => a - b).join(','), '24,26,27,38,39,40,41,42,43,56,57,58');
  eq('⑥ 前瞻的 23 格里没有一颗是解', writes.filter((w) => enumerate(size, ANCHOR, {}).any[w.cell]).length, 0);
  eq('⑥ 逐格判死的 11 格里没有一颗是解（独立枚举复核）', dead.filter((t) => enumerate(size, ANCHOR, {}).any[t]).length, 0);
  ok('⑥ 提示词带上撞墙原因', /若放了星.*第3区/.test(Rules.look.text(board, { cell: S(8, 1, 1), reason: r2 })), Rules.look.text(board, { cell: S(8, 1, 1), reason: r2 }));
  eq('⑥ 六条规则的权重（难度货币；动了它要重新量带）', RULE_LIST.map((r) => r.weight).join(','), '1,1,2,3,4,6');
  eq('⑥ 规则表六条', RULE_LIST.length, 6);
}

{
  // 一整盘从空推到关：写的每一格都对得上独立枚举出来的那一个解。
  const s = solve(board);
  eq('锚点盘能纯铅笔推到关', s.ok, true);
  eq('推完是 2N 颗星', s.stars, 16);
  eq('推导出的星阵逐格等于手算的 A 阵', sameStars(starSet(board, s.derived), PAT_A), true);
  eq('推导脚本长度 = 步数', s.rows.length, s.steps);
  eq('这一盘的分数（回归钉：由权重表决定，动权重就会在这里红）', s.score, 303);
  eq('这一盘的推导笔数（回归钉）', s.steps, 64);
  // 锚点盘上六条只出场五条，而且是有原因的：空盘第一步的 43 格整盘前瞻已经把邻域阴影全灰完了，
  // 轮到 星的邻域 时无格可写。"邻域这条规则本身没问题"由 ① 那一节证明（它在那里写了 8 笔），
  // "六条规则在真实的盘上全部出场"由第 5 节在生成的盘上证明（每一张都过穷举器唯一解）。
  eq('这一盘的规则出场表（锚点盘上 星的邻域 被前瞻吃掉了）', Object.entries(s.breakdown).sort().map(([k, v]) => `${k}=${v}`).join(' '), '只剩这一对=2 只差这些=14 摆不下=2 满额排除=3 试放即死=43');
  eq('星的邻域 在这一盘一笔未下', s.breakdown[Rules.adj.name] || 0, 0);
  eq('出场最多的是试放即死（43 笔，比第二名的 14 笔多得多）', Math.max(...Object.values(s.breakdown)), s.breakdown[Rules.look.name]);
  eq('第二名是只差这些', Math.max(...Object.entries(s.breakdown).filter(([k]) => k !== Rules.look.name).map(([, v]) => v)), 14);
  eq('五种规则在这一盘出过场', Object.keys(s.breakdown).length, 5);
  eq('推完不留空格', [...s.derived].filter((v) => v === EMPTY).length, 0);
  eq('推导没有矛盾', s.conflict, undefined);
  guard('整盘推导', s.rows);
  const noLook = solve(board, { lookahead: false });
  eq('去掉第 ⑥ 条这盘就推不完（⑥ 是难度的一部分，不是作弊）', [noLook.ok, noLook.steps, noLook.score].join(','), 'false,1,3');
  eq('纯计数那一版只写了空盘的一笔', [...noLook.derived].filter((v) => v !== EMPTY).length, 1);
  eq('推不完时报的是"推不完"而不是矛盾', noLook.conflict, undefined);
  eq('脚本每一条都有规则名和格子', s.rows.every((f) => f.rule && f.rule.name && Number.isInteger(f.cell)), true);
  eq('脚本每一条都能说给人听', s.rows.every((f) => typeof f.rule.text(board, f) === 'string' && f.rule.text(board, f).length > 8), true);
  eq('脚本第一条就是空盘那一笔摆不下', [s.rows[0].rule.key, board.cellName(s.rows[0].cell)].join('@'), 'dead@第2行7列');
  const again = solve(board);
  eq('同一盘跑两次结论一模一样', again.rows.map((f) => `${f.rule.key}${f.cell}`).join(','), s.rows.map((f) => `${f.rule.key}${f.cell}`).join(','));
  eq('closure 与 no-look 走到同一个地方', closure(board, new Int8Array(64)), null);
  eq('closure 是静默版：不改记录数也不改盘', closure(board, new Int8Array(64)) === null && [...new Int8Array(64)].every((v) => v === 0), true);
}

{
  // 矛盾检测只读盘面，不读推导
  const touch = marks(64, [[3, 5, STAR], [3, 6, STAR]]);
  const ink = inkConflict(board, touch);
  ok('挨着的两颗星被当场指出', /挨着/.test(ink.text), ink && ink.text);
  eq('矛盾里点到的就是这两格', ink.cells.length, 2);
  // 超计数也得被当场指出。原来的三颗星选在 (0,1)(0,3)(1,0)：前两颗在第1区、第三颗在第3区，
  // 而且 (0,1) 与 (1,0) 斜角相邻 —— inkConflict 先报邻接是对的，那个前提根本测不到超计数分支。
  // 换成 (3,0)(3,2)(5,3)：三颗全在第5区、两两不相邻、任何一行都没有第三颗。
  const over = marks(64, [[3, 0, STAR], [3, 2, STAR], [5, 3, STAR]]);
  ok('一个区域三颗星被当场指出', /超过/.test(inkConflict(board, over).text), inkConflict(board, over) && inkConflict(board, over).text);
  eq('第5区三颗星', board.cellsOf[4].filter((t) => over[t] === STAR).length, 3);
  eq('这三颗两两不相邻（所以报的只能是超计数）', inkConflict(board, over).why, '超出两颗');
  eq('没有任何一行装着第三颗', board.rows.filter((row) => row.filter((t) => over[t] === STAR).length > 2).length, 0);
  eq('三颗星的分区计数', board.cellsOf.map((cells) => cells.filter((t) => over[t] === STAR).length).join(','), '0,0,0,0,3,0,0,0');
  eq('没有落子的盘不矛盾', inkConflict(board, new Int8Array(64)), null);
  eq('只有灰也不矛盾', inkConflict(board, marks(64, [[0, 0, OUT], [0, 1, OUT]])), null);
  eq('带矛盾的盘面一律不写', propagate(board, over).found.length, 0);
  ok('带矛盾的盘面报出矛盾', !!propagate(board, over).conflict, '');
  eq('单独一颗星本身不矛盾（要看两步才看得出来）', inkConflict(board, marks(64, [[1, 3, STAR]])), null);
}

{
  // 一键标灰 —— 这类纸笔游戏的标准动作，但它一颗星都不许替玩家放。
  // 手推：第1行两颗 (0,1)(0,3) →
  //   邻域：(0,0)(0,2)(0,4) + (1,0)(1,1)(1,2)(1,3)(1,4) = 8 格
  //   第1行满 → (0,5)(0,6)(0,7) = 3 格
  //   第1区满（两颗都在第1区）→ 第1区剩下没灰的只有 (2,4) = 1 格
  //   合计 12 格。(1,4) 同时是邻域格和第1区的格，只写一次；第2区没有任何一格被这两颗星照满，
  //   所以到此为止 —— 原来注释里那句"共 13 格"把 (1,4) 数了两遍。
  const st = marks(64, [[0, 1, STAR], [0, 3, STAR]]);
  const added = exclusions(board, st);
  eq('一键标灰只标灰', added.every((t) => st[t] === OUT), true);
  eq('一键标灰不动星', countStars(st), 2);
  eq('一键标灰写了 12 格', added.length, 12);
  eq('一键标灰的名单', added.slice().sort((a, b) => a - b).map((t) => board.cellName(t)).join(' '), '第1行1列 第1行3列 第1行5列 第1行6列 第1行7列 第1行8列 第2行1列 第2行2列 第2行3列 第2行4列 第2行5列 第3行5列');
  eq('第1行剩下的格全被标灰', [0, 2, 4, 5, 6, 7].every((c) => st[S(8, 0, c)] === OUT), true);
  eq('第1区最后一格 (2,4) 也灰了', st[S(8, 2, 4)], OUT);
  eq('它不替玩家放星：第2行那一对它不碰', [st[S(8, 1, 5)], st[S(8, 1, 7)]].join(','), `${EMPTY},${EMPTY}`);
  eq('同一盘面第二次什么都不加', exclusions(board, st).length, 0);
  eq('空盘上无灰可打', exclusions(board, new Int8Array(64)).length, 0);
  eq('它写的每一格都在解的反面（独立枚举复核）', added.filter((t) => enumerate(size, ANCHOR, { must: [S(8, 0, 1), S(8, 0, 3)], cap: 8 }).any[t]).length, 0);
  const full = marks(64, [[0, 1, STAR], [0, 3, STAR], [1, 5, STAR], [1, 7, STAR]]);
  const more = exclusions(board, full);
  ok('第2区满了就整区刷灰', board.cellsOf[1].every((t) => full[t] !== EMPTY), JSON.stringify(board.cellsOf[1].map((t) => full[t])));
  // 手推 16：邻域 12 格（上一盘的 8 格 + (0,4) 之外的 (1,4)(1,5)(1,6)(1,7) 与 (2,4)(2,5)(2,6)
  // 去掉重复）+ 第1行 3 格 + 第2行 1 格 + 第1区 1 格 —— 见下面的名单逐格点。
  eq('两行满 + 邻域：这次写 16 格', more.length, 16);
  // 手推这 16 格：四颗星（(0,1)(0,3)(1,5)(1,7)）的邻域并集正好 16 格 —— 第1行 6 格、第2行 6 格
  // （两颗星自己不算）、第3行 4 格；而第1行、第2行、第1区、第2区满了之后要灰的格全在这 16 格里，
  // 所以 满额排除 这一轮一笔也没多写。
  eq('这次的名单（四颗星的邻域并集：第1行 6 + 第2行 6 + 第3行 4）', more.slice().sort((a, b) => a - b).map((t) => board.cellName(t)).join(' '), '第1行1列 第1行3列 第1行5列 第1行6列 第1行7列 第1行8列 第2行1列 第2行2列 第2行3列 第2行4列 第2行5列 第2行7列 第3行5列 第3行6列 第3行7列 第3行8列');
  eq('仍然一颗星也没替玩家放', countStars(full), 4);
}

{
  // 提示 —— 下一个强制结论必须由同一条推导路径给出，它不是答案按钮。
  const st = marks(64, [[0, 1, STAR], [0, 3, STAR]]);
  const next = nextForced(board, st);
  ok('提示给的是具体一格加一条规则', !!next && Number.isInteger(next.cell) && !!next.rule.name, JSON.stringify(next && next.rule.key));
  eq('提示那一格落笔之前还是空的', st[next.cell], EMPTY);
  eq('提示一次只给一条', Array.isArray(next), false);
  const solved = solve(board);
  eq('从空盘出发，提示的第一条与推导脚本同源', nextForced(board, new Int8Array(64)).cell, solved.rows[0].cell);
  const broken = marks(64, [[3, 5, STAR], [3, 6, STAR]]);
  eq('墨迹自相矛盾时提示拒绝给结论（也不扣次数）', nextForced(board, broken), { conflict: inkConflict(board, broken).text });
  const solvedStars = starSet(board, marks(64, A_CELLS));
  eq('A 阵本身永远不"卡死"', stuckReason(board, solvedStars) === null, true);
  eq('A 阵走完 reachable 为真', reachable(board, solvedStars), true);
  eq('挨着的两颗星：卡死原因是一句人话', typeof stuckReason(board, broken), 'string');
  const moved = Int8Array.from(solvedStars);
  moved[S(8, 6, 2)] = 0;
  moved[S(8, 6, 3)] = 1;
  eq('把 A 阵挪错一格（(6,2)→(6,3)）→ 两步内就卡死', stuckReason(board, moved) !== null, true);
  eq('空盘不报卡死（它推得动）', stuckReason(board, new Int8Array(64)), null);
  {
    // 提示写的是灰笔还是星，判据不一样：灰 = 这格在**零个**解里是星，星 = 这格在**每一个**解里都是星。
    const tr = enumerate(size, ANCHOR, { must: [S(8, 0, 1), S(8, 0, 3)], cap: 8 });
    eq('提示那一格在解里站得住（灰笔→零个解用它，星→全部解用它）', next.value === STAR ? tr.all[next.cell] : 1 - tr.any[next.cell], 1);
  }
}

{
  // 验收只读盘面：推导写错了也骗不过它
  const good = starSet(board, marks(64, A_CELLS));
  eq('A 阵过验收', verify(board, good).length, 0);
  eq('complete 也同意', complete(board, good), true);
  eq('A 阵星数 2N', countStars(good), 16);
  const bStars = starSet(board, marks(64, starTriples(PAT_B)));
  ok('B 阵过不了验收（第5区四颗、第8区零颗）', verify(board, bStars).length === 2, JSON.stringify(verify(board, bStars)));
  eq('B 阵被报的两处正是第5区与第8区', verify(board, bStars).map((b) => `${b.name}:${b.why}${b.have}`).sort().join(' '), '第5区:超出两颗4 第8区:不足两颗0');
  const bad = Int8Array.from(good);
  bad[S(8, 6, 2)] = 0;
  bad[S(8, 6, 3)] = 1;
  ok('挪一颗就验收不过', verify(board, bad).length > 0, JSON.stringify(verify(board, bad).slice(0, 2)));
  const sparse = marks(64, [[0, 1, STAR]]);
  ok('只放一颗时验收说不足', verify(board, sparse).filter((b) => /不足/.test(b.why)).length > 0, JSON.stringify(verify(board, sparse).slice(0, 3)));
  eq('不足时 complete 为假', complete(board, sparse), false);
  const d = diagnose(board, marks(64, [[0, 1, STAR], [0, 3, STAR], [1, 6, OUT]]));
  eq('诊断：星数', d.stars, 2);
  eq('诊断：灰数', d.marked, 1);
  eq('诊断：目标是 2N=16 颗', d.target, 16);
  eq('诊断：单元总数 3N', d.units, 24);
  eq('诊断：格总数', d.total, 64);
  eq('诊断：第1行已满', d.satisfied.has(0), true);
  eq('诊断：挨着的星不在这里（(0,1) 与 (0,3) 隔一格）', d.adjacent.length, 0);
  eq('诊断：还能数出剩多少格没定', d.remaining, 64 - 2 - 1);
  const d2 = diagnose(board, marks(64, [[3, 5, STAR], [3, 6, STAR]]));
  eq('诊断：相邻的那一对被抓出来', d2.adjacent.length, 1);
  // 只有两颗相邻的星时，没有任何一个单元违反计数（每单元都还是"不足"而不是"越界"），
  // violated 为空是对的；原来那条把 violated 当成了"越界"的抓手，于是它数到 0。
  eq('诊断：纯相邻的两颗星不越任何单元的计数', d2.violated.size, 0);
  eq('诊断：冲突数 = 越界单元数 + 相邻对数', d2.conflicts, 1);
  const d3 = diagnose(board, marks(64, [[3, 0, STAR], [3, 2, STAR], [5, 3, STAR]]));
  ok('诊断：越界的单元被点名（第5区三颗星 → 单元 20）', d3.violated.has(20), [...d3.violated].join(','));
  eq('诊断：越界的那个单元就是第5区', board.units[[...d3.violated][0]].name, '第5区');
  eq('诊断：三颗越界的星全被点名', d3.badCells.size, 3);
}

{
  // 落子状态机：撤销、快照、两种模式互不污染
  const st = createState(board);
  eq('新建状态是空盘', [...st.cell].every((v) => v === EMPTY), true);
  eq('新建状态历史为空', st.history.length, 0);
  // tappedValue 是纯函数（渲染与提示都靠它预演，不许改盘），所以"再点一次擦掉"这一步
  // 必须先把上一笔真正落到盘上，否则两次点的是同一张空盘。
  const tap = (t, mode) => setCell(st, t, tappedValue(st.board, st.cell, t, mode));
  eq('✕ 模式下点空格 → 落灰', tappedValue(board, st.cell, S(8, 0, 0), OUT), OUT);
  tap(S(8, 0, 0), OUT);
  eq('那一格真的灰了', st.cell[S(8, 0, 0)], OUT);
  eq('再点一次 → 擦掉', tappedValue(board, st.cell, S(8, 0, 0), OUT), EMPTY);
  tap(S(8, 0, 0), OUT);
  eq('擦干净了', st.cell[S(8, 0, 0)], EMPTY);
  eq('★ 模式下点同一格 → 落星', tappedValue(board, st.cell, S(8, 0, 0), STAR), STAR);
  tap(S(8, 0, 0), STAR);
  eq('那颗星真的落下了', st.cell[S(8, 0, 0)], STAR);
  eq('再点一次 → 星也没了', tappedValue(board, st.cell, S(8, 0, 0), STAR), EMPTY);
  tap(S(8, 0, 0), STAR);
  eq('星确实擦了', st.cell[S(8, 0, 0)], EMPTY);
  eq('tappedValue 是纯的：预演不改盘面', tappedValue(board, st.cell, S(8, 5, 5), STAR), STAR);
  eq('点出界的格子什么也不做', tappedValue(board, st.cell, 64, STAR), null);
  eq('上面那些点按把历史堆到 4 条（每一笔都可撤销）', st.history.length, 4);
  resetInk(st);
  eq('resetInk 之后历史归零', st.history.length, 0);
  eq('setCell 拒收非法值', setCell(st, 0, 7), false);
  eq('setCell 同值不入历史', setCell(st, 0, EMPTY), false);
  eq('setCell 落子并留快照', setCell(st, 0, STAR), true);
  eq('历史一条', st.history.length, 1);
  setCell(st, S(8, 0, 1), OUT);
  eq('历史两条', st.history.length, 2);
  eq('撤销回到上一笔', undoState(st), true);
  eq('那一格擦掉了', st.cell[S(8, 0, 1)], EMPTY);
  eq('星还在', st.cell[0], STAR);
  resetInk(st);
  eq('清空盘面', [...st.cell].every((v) => v === EMPTY), true);
  eq('历史也清了', st.history.length, 0);
  eq('没有历史时撤销说没有', undoState(st), false);
  const big = createState(board);
  for (let t = 0; t < 64; t++) setCell(big, t, STAR);
  eq('64 格各一笔 → 历史 64 条（64 格盘上到不了上限，别拿它当上限）', big.history.length, 64);
  for (let k = 0; k < 800; k++) setCell(big, 0, k % 2 ? STAR : EMPTY);
  eq('历史有上限（不会无限涨内存）', big.history.length, 800);
  snapshot(big);
  eq('手动快照也在上限内', big.history.length, 800);
  eq('上限之下不丢最近的状态', big.cell[63], STAR);
  eq('丢的是最老的那一笔，不是最近那一笔', [...big.history[big.history.length - 1]].filter((v) => v === STAR).length, 64);
  eq('setCell 出界不动', setCell(big, 64, STAR), false);
}

// ---------------------------------------------------------------- 3. 唯一解：两套互不信任的代码逐格对账

{
  // 穷举器：不认识铅笔规则，只会逐行枚举列配对。
  const c = countSolutions({ size, region: ANCHOR }, { cap: 3 });
  eq('锚点盘唯一解', c.status, UNIQUE);
  eq('唯一解就是手算的 A 阵（逐格比）', sameStars(c.first, PAT_A), true);
  eq('A 阵被第三双眼睛认过', legalStarSet({ size, region: ANCHOR }, PAT_A), true);
  eq('B 阵被第三双眼睛拒掉（第5区四颗星）', legalStarSet({ size, region: ANCHOR }, PAT_B), false);
  const moved = Uint8Array.from(PAT_A, (v, t) => (t === S(8, 6, 2) ? 0 : t === S(8, 6, 3) ? 1 : v));
  eq('把 A 阵挪一格，第三双眼睛也拒', legalStarSet({ size, region: ANCHOR }, moved), false);
  // 铅笔路径与穷举器毫无共享代码，答案必须逐格相同
  const s = solve(board);
  eq('铅笔推出的星阵与穷举器逐格相同', sameStars(starSet(board, s.derived), c.first), true);
  eq('两者的星数都是 2N', [countStars(s.derived), [...c.first].reduce((a, b) => a + b, 0)].join(','), '16,16');
  ok('穷举走过的节点数少到能手验', c.nodes < 400, String(c.nodes));
  eq('cap=1 时只带一个解回来', (() => { const x = countSolutions({ size, region: ANCHOR }, { cap: 1 }); return `${x.status}/${x.solutions}`; })(), 'MANY/1');
  eq('cap=1 时那一个解仍是 A 阵', sameStars(countSolutions({ size, region: ANCHOR }, { cap: 1 }).first, PAT_A), true);
  eq('预算 1 时报告超预算而不是硬答', countSolutions({ size, region: ROW_BANDS }, { cap: 2, budget: 1 }).status, OVERBUDGET);
  eq('超预算时不给半截答案', countSolutions({ size, region: ROW_BANDS }, { cap: 2, budget: 1 }).first, null);
  eq("解数不等于'唯一'这件事：cap=3 时 solutions 是个数", c.solutions, 1);
  // 三份实现同时点头：铅笔推导、行列配对穷举、本文件的逐格枚举。
  eq('第三份实现与穷举器在锚点盘上给出同一个解', (() => { const tr = enumerate(size, ANCHOR, { cap: 4 }); return tr.n === 1 && sameStars(tr.sols[0], c.first); })(), true);
}

{
  // 区域 = 行的退化盘：区域约束与行约束重合，解多到数不完。
  const c = countSolutions({ size, region: ROW_BANDS }, { cap: 2 });
  eq('退化盘是多解', c.status, MANY);
  eq('多解时在 cap 处收手', c.solutions, 2);
  ok('穷举器给的第一盘合法', legalStarSet({ size, region: ROW_BANDS }, c.first), JSON.stringify(c.first));
  ok('第一盘确实每行两颗', [...Array(8).keys()].every((r) => c.first.slice(r * 8, r * 8 + 8).reduce((a, b) => a + b, 0) === 2), '');
  eq('铅笔规则推不完这盘（它只认区域与行列计数）', solve(bands).ok, false);
  eq('推不完时报的是"推不完"而不是矛盾', solve(bands).conflict, undefined);
  eq('退化盘上 ⑥ 也不误判：A 阵的星一颗都不许死', A_IDX.every((t) => diesAfterPlacement(bands, new Int8Array(64), t) === null), true);
  // 原来这条钉的是"穷举器给的第一盘不是 A 阵"。它是错的：区域=行时区域约束与行约束完全重合，
  // 于是这一盘的解集就是 8×8 的全部两种星阵 {A, B}（本文件第 4 节现场枚举过），A 阵当然是它的
  // 一个合法解 —— 穷举器按行序搜，第一个撞上的正好就是 A。这一盘要钉的是**重数**，不是身份。
  eq('穷举器给的第一盘确实是 A 阵（A 在退化划分下也合法）', sameStars(c.first, PAT_A), true);
  {
    const tr = enumerate(size, ROW_BANDS, { cap: 8 });
    eq('退化盘的解恰好两个（独立枚举）', tr.n, 2);
    eq('独立枚举的两个解 = A 阵与 B 阵', [tr.sols.some((p) => sameStars(p, PAT_A)), tr.sols.some((p) => sameStars(p, PAT_B))].join(','), 'true,true');
    eq('穷举器收回的第一解在独立枚举的那两个解里', tr.sols.some((p) => sameStars(p, c.first)), true);
    eq('退化盘上 A 阵的每一格都在"所有解里"当星（A、B 不相交）', A_IDX.every((t) => tr.all[t] === 0), true);
  }
  // 第1区只有相邻两格却要两颗星：整盘无解
  const narrow = countSolutions({ size, region: NARROW }, { cap: 2 });
  eq('相邻两格当区域 → 无解', narrow.status, NONE);
  eq('无解时不带盘面', narrow.first, null);
  eq('这一盘几何上合法（连通、全覆盖）', createBoard({ size, region: NARROW }).cellsOf.map((c) => c.length).join(','), '2,8,8,14,8,9,7,8');
  eq('独立枚举也说这一盘零解', enumerate(size, NARROW, { cap: 8 }).n, 0);
  eq('缺 region 时穷举器直接拒绝，不猜', (() => { try { countSolutions({ size: 8 }, { cap: 2 }); return 'no-throw'; } catch (e) { return /region/.test(e.message) ? 'refused' : e.message; } })(), 'refused');
  eq('缺 region 时复核器也拒绝', (() => { try { legalStarSet({ size: 8 }, PAT_A); return 'no-throw'; } catch (e) { return /region/.test(e.message) ? 'refused' : e.message; } })(), 'refused');
  eq('size 与 region 不匹配也拒绝', (() => { try { countSolutions({ size: 8, region: ROW_BANDS.slice(0, 60) }, { cap: 2 }); return 'no-throw'; } catch (e) { return /size²/.test(e.message) ? 'refused' : e.message; } })(), 'refused');
}

// ---------------------------------------------------------------- 4. 尺寸下限：为什么没有 5×5

// 每行两颗、每列两颗、谁也不挨着 —— 只数这三条，不含任何区域 —— 在 8×8 以下无解。
// 两条互不信任的枚举：A 逐行暴力枚举所有配对序列，B 记忆化 DP。两条都不读 js/engine/。
{
  const pairs = (n) => {
    const out = [];
    for (let a = 0; a < n; a++) for (let b = a + 2; b < n; b++) out.push([a, b]);
    return out;
  };
  const touches = (p, q) => p.some((c) => q.some((d) => Math.abs(c - d) <= 1));
  const brute = (n) => {
    const P = pairs(n);
    const colLeft = new Array(n).fill(2);
    const seq = [];
    let total = 0;
    const go = (r) => {
      if (r === n) {
        if (colLeft.every((v) => v === 0)) total++;
        return;
      }
      for (const p of P) {
        if (seq.length && touches(seq[seq.length - 1], p)) continue;
        let good = true;
        for (const c of p) if (--colLeft[c] < 0) good = false;
        if (good) {
          seq.push(p);
          go(r + 1);
          seq.pop();
        }
        for (const c of p) colLeft[c]++;
      }
    };
    go(0);
    return total;
  };
  const dp = (n) => {
    const P = pairs(n);
    const memo = new Map();
    const go = (r, prev, colLeft) => {
      if (r === n) return colLeft.every((v) => v === 0) ? 1 : 0;
      const key = `${r}|${prev.join(',')}|${colLeft.join('')}`;
      const hit = memo.get(key);
      if (hit !== undefined) return hit;
      let total = 0;
      for (const p of P) {
        if (r > 0 && touches(prev, p)) continue;
        let good = true;
        const next = colLeft.slice();
        for (const c of p) if (--next[c] < 0) good = false;
        if (good) total += go(r + 1, p, next);
      }
      memo.set(key, total);
      return total;
    };
    return go(0, [], new Array(n).fill(2));
  };
  const FLOOR = { 4: 0, 5: 0, 6: 0, 7: 0, 8: 2, 9: 664, 10: 146510 };
  for (const n of [4, 5, 6, 7, 8, 9, 10]) {
    eq(`${n}×${n} 的合法摆法数（暴力枚举）`, brute(n), FLOOR[n]);
    eq(`${n}×${n} 的合法摆法数（记忆化 DP）`, dp(n), FLOOR[n]);
  }
  eq('下限之下两条枚举一致', [4, 5, 6, 7].every((n) => brute(n) === dp(n) && dp(n) === 0), true);
  ok('8×8 起才有第一盘', brute(8) > 0 && dp(8) > 0);
  // "8×8 只有两种星阵"正是上面所有手推锚点的地基，所以把这两种现场复现出来：
  const both = (() => {
    const P = pairs(8);
    const colLeft = new Array(8).fill(2);
    const seq = [];
    const out = [];
    const go = (r) => {
      if (r === 8) {
        if (colLeft.every((v) => v === 0)) out.push(seq.map((p) => p.slice()));
        return;
      }
      for (const p of P) {
        if (seq.length && touches(seq[seq.length - 1], p)) continue;
        let good = true;
        for (const c of p) if (--colLeft[c] < 0) good = false;
        if (good) {
          seq.push(p);
          go(r + 1);
          seq.pop();
        }
        for (const c of p) colLeft[c]++;
      }
    };
    go(0);
    return out.map((s) => {
      const flat = new Uint8Array(64);
      s.forEach((p, r) => p.forEach((c) => (flat[r * 8 + c] = 1)));
      return flat;
    });
  })();
  eq('8×8 恰好两种星阵', both.length, 2);
  ok('第一种就是手写的 A 阵', both.some((p) => sameStars(p, PAT_A)), '');
  ok('第二种就是手写的 B 阵', both.some((p) => sameStars(p, PAT_B)), '');
  eq('两种星阵互不相干（同一格最多只有一种阵用它）', both[0].reduce((a, v, t) => a + (v && both[1][t] ? 1 : 0), 0), 0);
  eq('穷举器（第三份实现）也说锚点盘只有 A 阵这一解', countSolutions({ size, region: ANCHOR }, { cap: 5 }).solutions, 1);
  eq('B 阵在锚点划分下不合法', legalStarSet({ size, region: ANCHOR }, PAT_B), false);
  // 本文件的逐格枚举（又一份独立实现）在没有区域约束的退化划分下也必须数出 2，
  // 与上面两条枚举同数 —— 三套互不相干的代码在同一张表上点头，下限才算钉住。
  eq('逐格枚举：8×8 在"区域=行"的退化划分下也是两种星阵', enumerate(8, ROW_BANDS, { cap: 8 }).n, 2);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

// <<PREAMBLE>>

// ---------------------------------------------------------------- 5. 生成盘：两条实现必须同时点头
{
  const genSeeds = ['trainee-p0', 'apprentice-p2', 'regular-p0', 'expert-p0', 'master-p4'];
  for (const seed of genSeeds) {
    const tier = TIERS.find((t) => seed.startsWith(`${t.key}-`));
    const t0 = Date.now();
    const pz = drawOne({ size: tier.size, seed, band: tier.band, tightenMoves: tier.tightenMoves });
    ok(`生成盘 ${seed}：画得出（${Date.now() - t0}ms）`, !!pz);
    if (!pz) continue;
    const gb = createBoard({ size: tier.size, region: pz.region });
    const c = countSolutions({ size: tier.size, region: pz.region }, { cap: 2 });
    eq(`生成盘 ${seed}：穷举器说唯一解`, c.status, UNIQUE);
    eq(`生成盘 ${seed}：唯一解就是种下去的那一解`, sameStars(c.first, pz.stars), true);
    eq(`生成盘 ${seed}：种下的星集本身合法（第三双眼睛）`, legalStarSet({ size: tier.size, region: pz.region }, pz.stars), true);
    eq(`生成盘 ${seed}：种下的星数 = 2N`, countStarsArr(pz.stars), 2 * tier.size);
    eq(`生成盘 ${seed}：铅笔路径与穷举器逐格相同`, sameStars(solutionOf(gb, pz.pencil.derived), c.first), true);
    eq(`生成盘 ${seed}：分数落在这档的难度带里（${tier.band.join('~')}）`, inBand(pz.score, tier.band), true);
    const tr = enumerate(tier.size, pz.region);
    eq(`生成盘 ${seed}：独立枚举也说恰好一解`, tr.n, 1);
    eq(`生成盘 ${seed}：独立枚举的那一解与穷举器相同`, sameStars(tr.sols[0], c.first), true);
    const bad = pz.pencil.rows.filter((f) => (f.value === OUT ? tr.any[f.cell] : !tr.all[f.cell]));
    eq(`生成盘 ${seed}：${pz.pencil.steps} 笔推导没有一笔写在解的反面`, bad.map((f) => `${f.rule.key}@${gb.cellName(f.cell)}`), []);
    eq(`生成盘 ${seed}：解在每一区正好落下两颗（区域大小 ${regionSizes(tier.size, pz.region).join(',')}）`, gb.cellsOf.map((cells) => cells.filter((t) => c.first[t]).length).join(','), Array(tier.size).fill(2).join(','));
    eq(`生成盘 ${seed}：区域大小之和 = N²`, regionSizes(tier.size, pz.region).reduce((a, b) => a + b, 0), tier.size * tier.size);
  }
  const sixBoards = ['trainee-p3', 'apprentice-p2', 'regular-p0'];
  const seenAll = [];
  for (const seed of sixBoards) {
    const tier = TIERS.find((t) => seed.startsWith(`${t.key}-`));
    const pz = drawOne({ size: tier.size, seed, band: tier.band, tightenMoves: tier.tightenMoves });
    const missing = RULE_LIST.filter((r) => !(pz.pencil.breakdown[r.name] > 0)).map((r) => r.key);
    seenAll.push(`${seed}:${missing.length ? '缺' + missing.join('/') : '六条全出场'}`);
  }
  eq('生成的盘上六条铅笔规则真的全部出场（锚点盘上不出场的那条在这里出场）', seenAll, [
    'trainee-p3:六条全出场',
    'apprentice-p2:六条全出场',
    'regular-p0:六条全出场',
  ]);
}
