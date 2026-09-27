// 难度是量出来的吗？这个文件就是那把尺 —— 也是那台量具。
//
// 跑法：
//   node tools/balance.mjs                 # 每档抽 8 题（默认，开发用）
//   SAMPLES=24 node tools/balance.mjs      # 门禁口径（CI 里就是这个数）
//   TIER=expert node tools/balance.mjs     # 只量一档（调试用，不参与门禁）
//   SIZES=0 node tools/balance.mjs         # 跳过「尺寸声明复核」那一段
//
// 做四件事，任何一件不成立就 exit 1：
//   ① 每档现场出题，打出分位表：分数 / 步数 / 规则命中 / 区域与格数 / 生成墙钟（p50 与 p95）
//   ② 阶梯门禁：五档中位数严格递增 + 每一题都落在自己档的 band 里（档间重叠只提醒，不算失败）
//   ③ 出货门禁：每一张出货盘的唯一解都必须在 count.js 的穷举预算内**证完**（超预算 M 必须为 0），
//      并且穷举器给的那个解要和铅笔求解器给的解**逐格**相同
//   ④ 复核 generate.js 里那两句关于盘尺寸的声明（MIN_SIZE=8、10×10 不可出货）—— 自己跑，不照抄
//
// 独立口径（这是承诺的本体）：本文件 **不 import** js/engine/rules.js 的规则表
// （`Rules` / `RULE_LIST`），只用它那个铅笔求解器 `solve()` 再走一遍路径。分数是铅笔路径自己
// 打出来的数，不是 balance 拿权重表重算出来的数 —— 拿同一张权重表验收同一张权重表量出的分数，
// 就是自证。唯一解这件事由 count.js（自己重写了几何、不含任何铅笔规则）与铅笔路径各看一遍。
//
// 禁止为了跑绿去放宽 band、改中位数口径、把超预算那一行从输出里抹掉。红了就把实测分布打出来，
// 修的是穷举器与预算，不是判据。

import { TIERS, MIN_SIZE, makePuzzle, drawOne, polish, solutionOf } from '../js/engine/generate.js';
import { createBoard, starSet, sameStars, EMPTY, STAR } from '../js/engine/board.js';
import { countSolutions, legalStarSet, UNIQUE, MANY, NONE, OVERBUDGET } from '../js/engine/count.js';
import { solve } from '../js/engine/rules.js';
import { plantSolution, carveRegions } from '../js/engine/regions.js';
import { makeRng } from '../js/engine/rng.js';

const SAMPLES = Number(process.env.SAMPLES || 8);
const TIER = process.env.TIER || null;
const AUDIT = Number(process.env.AUDIT || 8); // 每档抽题期候选审计抽多少张候选
const SIZES = process.env.SIZES !== '0';
// 穷举预算：只许往大调（BUDGET=8000000），不许往小调 —— 预算用完就是「唯一解没证完」。
const DEFAULT_BUDGET = 400000;
const BUDGET = Number(process.env.BUDGET || DEFAULT_BUDGET);
if (!(BUDGET >= DEFAULT_BUDGET)) {
  console.log(`✗ BUDGET=${BUDGET} 比默认预算 ${DEFAULT_BUDGET} 还小：那会把没证完唯一解的盘当成合格货。`);
  process.exit(1);
}
if (!(Number.isInteger(SAMPLES) && SAMPLES >= 2)) {
  console.log(`✗ SAMPLES=${process.env.SAMPLES} 不是一个 ≥2 的整数`);
  process.exit(1);
}

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`  ✗ ${msg}`);
};
const pass = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  · ${msg}`);

const pct = (sorted, q) => {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[i];
};
const fmt = (x) => (typeof x === 'number' && Number.isFinite(x) ? (Number.isInteger(x) ? String(x) : x.toFixed(1)) : String(x));
const q = (a) => `${fmt(pct(a, 0))} / ${fmt(pct(a, 0.25))} / ${fmt(pct(a, 0.5))} / ${fmt(pct(a, 0.75))} / ${fmt(pct(a, 1))}`;
const asc = (a) => [...a].sort((x, y) => x - y);

// ---------------------------------------------------------------- 出货盘的独立复核

// 一张盘要过四道独立的眼睛：
//   铅笔路径（rules.js 的 solve，balance 自己从头再走一遍，不采信生成器缓存的那份）
//   穷举器（count.js 的 countSolutions，几何是它自己重写的，不含铅笔规则）
//   第三双眼睛（count.js 的 legalStarSet，按游戏规则直接数行列区，两份实现都不信）
//   逐格比对（铅笔的星集 === 穷举的星集 === 生成器种下的星集 === 生成器缓存的解）
function auditPuzzle(T, i, made) {
  const label = `${T.name} #${i + 1}`;
  const board = made.board;
  const { size } = board;
  const n = board.n;

  // —— 铅笔路径：从零再走一遍
  const pencil = solve(board);
  if (!pencil.ok) {
    fail(`${label} 铅笔推不完：${pencil.conflict || '停在半路'}`);
    return null;
  }
  let undecided = 0;
  for (let t = 0; t < n; t++) if (pencil.derived[t] === EMPTY) undecided++;
  if (undecided) fail(`${label} 铅笔说 ok 却还剩 ${undecided} 格未定`);
  const fromPencil = starSet(board, pencil.derived);

  // —— 分数必须是铅笔路径自己打出来的那份，balance 不拿权重表重算
  if (Math.abs(pencil.score - made.score) > 1e-9) {
    fail(`${label} 生成器记的分数 ${made.score} ≠ 铅笔路径重跑的 ${pencil.score}（同一条路径应当给同一个数）`);
  }
  if (pencil.steps !== made.steps) fail(`${label} 步数 ${made.steps} ≠ 重跑的 ${pencil.steps}`);

  // —— 穷举器：数解，并且要在预算内数完
  const cnt = countSolutions({ size, region: board.region }, { cap: 2, budget: BUDGET });
  const over = cnt.status === OVERBUDGET ? 1 : 0;
  if (over) {
    fail(`${label} 穷举超预算：${cnt.nodes} 个节点用完还没数完解，唯一解没证完 —— 这一档不能出货`);
  } else if (cnt.status === MANY) {
    fail(`${label} 穷举找到 ≥2 个解，这根本不唯一（status=${MANY}）`);
  } else if (cnt.status === NONE) {
    fail(`${label} 穷举一个解都找不到，可铅笔却推完了 —— 两套实现至少错一套`);
  }
  const fromCount = cnt.first ? Uint8Array.from(cnt.first) : null;

  // —— 第三双眼睛：按游戏规则本身数一遍
  if (!fromCount || !legalStarSet({ size, region: board.region }, fromCount)) {
    fail(`${label} 穷举器给的那个解过不了 legalStarSet（每行每列每区两颗、互不相邻）`);
  }
  if (!legalStarSet({ size, region: board.region }, fromPencil)) fail(`${label} 铅笔的解过不了 legalStarSet`);

  // —— 逐格比对
  const planted = Uint8Array.from(made.stars, (v) => (v ? 1 : 0));
  if (!sameStars(fromPencil, fromCount)) fail(`${label} 铅笔的解与穷举的解逐格不一致`);
  if (!sameStars(fromPencil, solutionOf(board, pencil.derived))) fail(`${label} starSet 与 solutionOf 不一致（同一份 derived）`);
  if (!sameStars(fromPencil, made.solution)) fail(`${label} 重跑铅笔的解与生成器缓存的解逐格不一致`);
  if (!sameStars(fromPencil, planted)) fail(`${label} 求出的解与种下的答案不是同一组星`);

  if (made.score < T.band[0] || made.score > T.band[1]) {
    fail(`${label} 分数 ${made.score} 落在 band ${JSON.stringify(T.band)} 之外`);
  }
  if (board.units.length !== 3 * size) fail(`${label} 单元数 ${board.units.length} ≠ 行+列+区 = ${3 * size}`);
  const sizes = board.cellsOf.map((c) => c.length);
  for (const s of sizes) if (s < 2) fail(`${label} 有一个区域只有 ${s} 格，装不下两颗星`);

  const proven = cnt.status === UNIQUE ? 1 : 0;
  if (!proven && !over) fail(`${label} 穷举器说这不是唯一解（status=${cnt.status}），铅笔却推完了 —— 两套实现至少错一套`);

  return {
    score: made.score,
    proven,
    steps: made.steps,
    // 每一次「命中」都写掉一格，所以命中总数恒等于步数；这两件事分开列是为了让读者看得见它们
    // 本来就是一件事，而不是两个互相印证的口径。真正的分布信息在下面那行按规则名拆开的表里。
    hits: pencil.rows.length,
    starWrites: pencil.rows.filter((r) => r.value === STAR).length,
    greyWrites: pencil.rows.filter((r) => r.value !== STAR).length,
    rulesUsed: Object.keys(pencil.breakdown).length,
    breakdown: pencil.breakdown,
    regionCount: sizes.length,
    minRegion: Math.min(...sizes),
    maxRegion: Math.max(...sizes),
    stars: countOnes(fromPencil),
    units: board.units.length,
    over,
    nodes: cnt.nodes,
  };
}

function countOnes(a) {
  let k = 0;
  for (let t = 0; t < a.length; t++) k += a[t] ? 1 : 0;
  return k;
}

// ---------------------------------------------------------------- 每档抽样

function sampleTier(T, n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const seed = `balance-${T.key}-${i}`;
    let draws = 0;
    let discards = 0;
    const report = (r) => {
      if (r.score === null) discards++;
      else draws++;
    };
    const t0 = Date.now();
    const made = makePuzzle(seed, T.key, { report });
    const ms = Date.now() - t0;
    if (!made) {
      fail(`${T.name} #${i + 1}（seed ${seed}）出不了货：这一档的抽题预算内没有找到既纯逻辑推到底、又落在带里的盘`);
      continue;
    }
    rows.push({ seed, ms, made, draws, discards });
  }
  return rows;
}

// 抽题期候选审计：生成器选盘时**不**跑穷举（它只信「铅笔推完 ⟹ 唯一」这条可靠性论证）。
// 这一列回答的是「如果每张候选都要在预算内把唯一举证完，会丢掉几张」。
// 这里按 drawOne 的同一步骤重走一遍，并把失败发生在哪一步分开记（种植 / 切分 / 铅笔推不完），
// 因为「丢弃了多少张」不写清楚丢在哪一步，就只是一个数字。
function auditCandidates(T, n) {
  let planted = 0;
  let carved = 0;
  let candidates = 0;
  let over = 0;
  let worst = 0;
  let maxNodesShipped = 0;
  for (let i = 0; i < n; i++) {
    const rng = makeRng(`audit-${T.key}-${i}`);
    const stars = plantSolution(T.size, rng);
    if (!stars) continue;
    planted++;
    let region = null;
    for (let k = 0; k < 24 && !region; k++) region = carveRegions(T.size, stars, rng);
    if (!region) continue;
    carved++;
    const t = polish({ size: T.size, region, stars, band: T.band, rng, maxSteps: T.tightenMoves, probes: 14, lookahead: true, rounds: 2 });
    if (!t.ok) continue;
    candidates++;
    const cnt = countSolutions({ size: T.size, region: t.region }, { cap: 2, budget: BUDGET });
    worst = Math.max(worst, cnt.nodes);
    if (cnt.status === OVERBUDGET) over++;
    else maxNodesShipped = Math.max(maxNodesShipped, cnt.nodes);
  }
  return { tries: n, planted, carved, candidates, over, worst, maxNodesShipped };
}

function table(T, rows) {
  const score = asc(rows.map((r) => r.made.score));
  const steps = asc(rows.map((r) => r.audited.steps));
  const hits = asc(rows.map((r) => r.audited.hits));
  const starW = asc(rows.map((r) => r.audited.starWrites));
  const greyW = asc(rows.map((r) => r.audited.greyWrites));
  const rulesUsed = asc(rows.map((r) => r.audited.rulesUsed));
  const minRegion = asc(rows.map((r) => r.audited.minRegion));
  const maxRegion = asc(rows.map((r) => r.audited.maxRegion));
  const regionCount = asc(rows.map((r) => r.audited.regionCount));
  const gen = asc(rows.map((r) => r.ms));
  const nodes = asc(rows.map((r) => r.audited.nodes));

  // 每档的规则命中表：键是铅笔路径自己吐出来的规则名，balance 不查任何权重表
  const names = [...new Set(rows.flatMap((r) => Object.keys(r.audited.breakdown)))].sort();
  const perRule = (nm) => {
    const s = asc(rows.map((r) => r.audited.breakdown[nm] || 0));
    return `${nm} ${fmt(pct(s, 0.5))}/${fmt(s[s.length - 1])}`;
  };
  const over = rows.filter((r) => r.audited.over).length;
  const proven = rows.filter((r) => r.audited.proven).length;
  const worstNodes = Math.max(...rows.map((r) => r.audited.nodes));
  const against = (v) => `${((v / BUDGET) * 100).toFixed(v / BUDGET < 0.01 ? 3 : 1)}%`;

  console.log(`\n【${T.name}】${T.size}×${T.size} band ${JSON.stringify(T.band)} tightenMoves ${T.tightenMoves}  n=${rows.length}`);
  console.log(`  分数      min/p25/p50/p75/max  ${q(score)}`);
  console.log(`  步数      min/p25/p50/p75/max  ${q(steps)}   用到几种规则 ${q(rulesUsed)}`);
  console.log(`  规则命中  min/p25/p50/p75/max  ${q(hits)}（命中总数≡步数：一次命中写掉一格，这两个不是互相印证的两个口径）`);
  console.log(`            放星 ${q(starW)}   标灰 ${q(greyW)}`);
  console.log(`  按规则拆开 p50/max  ${names.map(perRule).join('   ')}`);
  console.log(`  线索=分区图  每盘 ${fmt(pct(regionCount, 0.5))} 个区域（恒等于盘边长）｜最小区格数 ${q(minRegion)}｜最大区格数 ${q(maxRegion)}｜单元(行+列+区) ${rows[0].audited.units}｜星 ${rows[0].audited.stars}`);
  console.log(`  生成墙钟 ms  p50 ${fmt(pct(gen, 0.5))} / p95 ${fmt(pct(gen, 0.95))} / max ${fmt(gen[gen.length - 1])}（墙钟双峰，基线取尾巴 p95，绝对值每次都打）`);
  console.log(
    `  穷举举证  唯一解在预算内证完 ${proven}/${rows.length} 张｜节点 max ${worstNodes}/${BUDGET}=${against(worstNodes)}（样本 p50 ${fmt(pct(nodes, 0.5))}）｜超预算 ${over}/${rows.length} 张出货盘没证完`,
  );
  if (over) fail(`${T.name} 有 ${over} 局的唯一解没在预算内证完 —— 这一档不能出货`);
  const draws = rows.reduce((s, r) => s + r.draws, 0);
  const discards = rows.reduce((s, r) => s + r.discards, 0);
  const ca = auditCandidates(T, AUDIT);
  console.log(
    `  抽题  出货 ${rows.length} 局共看 ${draws + discards} 张候选：${draws} 张合式、${discards} 张掉在种星/切区/铅笔推不完这三步`,
  );
  console.log(
    `        候选审计 ${ca.tries} 张：种出星 ${ca.planted}、切出区 ${ca.carved}、铅笔推得完 ${ca.candidates}｜` +
      `其中穷举超预算 ${ca.over} 张｜穷举节点最多 ${ca.worst}/${BUDGET}=${against(ca.worst)}`,
  );
  if (ca.over) fail(`${T.name} 抽题期有 ${ca.over}/${ca.candidates} 张候选的唯一解在预算内证不完 —— 只能靠加预算或收紧该档盘子解决，不许改判据`);
  return { name: T.name, median: pct(score, 0.5), min: pct(score, 0), max: pct(score, 1), over, worstNodes, caOver: ca.over, gen95: pct(gen, 0.95), genMax: gen[gen.length - 1] };
}

function ladder(summaries) {
  console.log('\n【阶梯门禁】');
  let bad = 0;
  for (let i = 1; i < summaries.length; i++) {
    const a = summaries[i - 1];
    const b = summaries[i];
    if (!(b.median > a.median)) {
      bad++;
      fail(`${b.name} 中位数 ${fmt(b.median)} 没有高于 ${a.name} 的 ${fmt(a.median)}`);
    }
    if (b.min <= a.max) {
      warn(`提醒：${b.name} 最轻的一题（${fmt(b.min)}）落进 ${a.name} 的分布区间（${fmt(a.min)}~${fmt(a.max)}）—— 档间有重叠，是量出来的现实，不算失败`);
    }
  }
  if (!bad) pass(`五档中位数严格递增：${summaries.map((s) => fmt(s.median)).join(' < ')}`);
  return bad;
}

// ---------------------------------------------------------------- ④ 尺寸声明复核

// 这两段自己算，不 import 引擎的求解器与穷举器：只数「每行两颗、每列两颗、互不相邻」的摆法。
// (a) 逐行枚举列对的暴力 DFS；(b) 以「列已用几颗」为状态的记忆化 DP。两者不共享代码。
function placementsBrute(n) {
  let total = 0;
  const colLeft = new Array(n).fill(2);
  const pairs = [];
  for (let a = 0; a < n; a++) for (let b = a + 2; b < n; b++) pairs.push([a, b]);
  const go = (r, blocked) => {
    if (r === n) {
      for (let c = 0; c < n; c++) if (colLeft[c] !== 0) return;
      total++;
      return;
    }
    for (const [a, b] of pairs) {
      if (blocked[a] || blocked[b] || colLeft[a] === 0 || colLeft[b] === 0) continue;
      colLeft[a]--;
      colLeft[b]--;
      let ok = true;
      for (let c = 0; c < n; c++) if (colLeft[c] > n - r - 1 || colLeft[c] < 0) ok = false;
      if (ok) {
        const next = new Array(n).fill(0);
        for (const c of [a - 1, a, a + 1, b - 1, b, b + 1]) if (c >= 0 && c < n) next[c] = 1;
        go(r + 1, next);
      }
      colLeft[a]++;
      colLeft[b]++;
    }
  };
  go(0, new Array(n).fill(0));
  return total;
}

function placementsDP(n) {
  // 状态：每一列还差几颗星（0..2）+ 上一行挡住的列集合。自底向上会爆状态，这里用记忆化递归。
  const key = (usage, blocked) => `${usage.join('')}|${blocked.join('')}`;
  const memo = new Map();
  const go = (r, usage, blocked) => {
    if (r === n) return usage.every((u) => u === 2) ? 1 : 0;
    const k = `${r}|${key(usage, blocked)}`;
    const hit = memo.get(k);
    if (hit !== undefined) return hit;
    let total = 0;
    for (let a = 0; a < n; a++) {
      if (blocked[a] || usage[a] >= 2) continue;
      for (let b = a + 2; b < n; b++) {
        if (blocked[b] || usage[b] >= 2) continue;
        const usage2 = usage.slice();
        usage2[a]++;
        usage2[b]++;
        let ok = true;
        for (let c = 0; c < n; c++) if (2 - usage2[c] > n - r - 1) ok = false;
        if (!ok) continue;
        const next = new Array(n).fill(0);
        for (const c of [a - 1, a, a + 1, b - 1, b, b + 1]) if (c >= 0 && c < n) next[c] = 1;
        total += go(r + 1, usage2, next);
      }
    }
    memo.set(k, total);
    return total;
  };
  return go(0, new Array(n).fill(0), new Array(n).fill(0));
}

// 「10×10 不可出货」的复核：随机切完有多少张能纯逻辑推到底、剩下的格中位数是多少、
// 局部搜索（也就是 polish 的那条腿）能不能救回来。同一个口径也跑 9×9 当对照。
// 分母要分开记：attempt 20 次里可能只有 16 次真切出了盘，「0/20」和「0/16」不是一句话。
function sizeClaim(size, attempts, searches, maxSteps) {
  const remaining = [];
  let completable = 0;
  let planted = 0;
  let carved = 0;
  let searchOk = 0;
  for (let i = 0; i < attempts; i++) {
    const rng = makeRng(`claim-${size}-${i}`);
    const stars = plantSolution(size, rng);
    if (!stars) continue;
    planted++;
    let region = null;
    for (let k = 0; k < 24 && !region; k++) region = carveRegions(size, stars, rng);
    if (!region) continue;
    carved++;
    let board = null;
    try {
      board = createBoard({ size, region });
    } catch {
      continue;
    }
    const p = solve(board);
    if (p.ok) completable++;
    let left = 0;
    for (let t = 0; t < board.n; t++) if (p.derived[t] === EMPTY) left++;
    remaining.push(left);
  }
  // 局部搜索：走 drawOne 的同一条「先搬到可推完、再搬进带」的路，看搬不搬得动
  for (let i = 0; i < searches; i++) {
    const r = drawOne({ size, seed: `claimsearch-${size}-${i}`, band: null, tightenMoves: maxSteps });
    if (r) searchOk++;
  }
  const sorted = asc(remaining);
  return {
    size,
    attempts,
    planted,
    carved,
    cuts: remaining.length,
    completable,
    median: pct(sorted, 0.5),
    p95: pct(sorted, 0.95),
    max: sorted.length ? sorted[sorted.length - 1] : null,
    cells: size * size,
    searches,
    searchOk,
  };
}

function sizeClaims() {
  console.log('\n【尺寸声明复核】generate.js 表头那两句话，自己跑一遍');
  const floor = [];
  for (const n of [4, 5, 6, 7, 8, 9, 10]) {
    const a = placementsBrute(n);
    const b = placementsDP(n);
    floor.push({ n, a, b });
    console.log(`  ${n}×${n} 的合法星集摆法（每行每列两颗、互不相邻）：暴力 ${a} ／ 记忆化 DP ${b}${a === b ? '' : '   ← 两条路线不一致！'}`);
    if (a !== b) fail(`${n}×${n}：两种算法给的摆法数不一致（${a} vs ${b}），这个数本身就没量准`);
  }
  const below = floor.filter((f) => f.n < MIN_SIZE);
  const at = floor.find((f) => f.n === MIN_SIZE);
  if (below.every((f) => f.a === 0)) pass(`MIN_SIZE=${MIN_SIZE} 成立：${below.map((f) => `${f.n}×${f.n} ${f.a}`).join('、')}，下限之下根本没有合法摆法`);
  else fail(`MIN_SIZE=${MIN_SIZE} 不成立：${below.filter((f) => f.a > 0).map((f) => `${f.n}×${f.n} 有 ${f.a} 个摆法`).join('、')}`);
  if (at && at.a > 0) pass(`${MIN_SIZE}×${MIN_SIZE} 有 ${at.a} 个摆法，阶梯从这一档起跳`);
  else fail(`${MIN_SIZE}×${MIN_SIZE} 摆法数为 ${at ? at.a : '未测'}，阶梯没有起跳点`);
  const measured = floor.map((f) => `${f.n}:${f.a}`).join(' ');
  const claimed = { 4: 0, 5: 0, 6: 0, 7: 0, 8: 2, 9: 664, 10: 146510 };
  const drift = floor.filter((f) => f.a !== claimed[f.n]).map((f) => `${f.n}×${f.n} 注释写 ${claimed[f.n]}、实测 ${f.a}`);
  warn(`注释那张摆法数表（4..7 全 0，8/9/10 为 2 / 664 / 146510）今天实测：${measured}${drift.length ? `  —— 对不上：${drift.join('、')}` : '  —— 逐位对上'}`);
  if (drift.length) fail(`MIN_SIZE 那段注释里的摆法数表和实测不一致：${drift.join('、')}`);

  const big = sizeClaim(10, 20, 6, 60);
  const mid = sizeClaim(9, 20, 6, 48);
  for (const c of [mid, big]) {
    console.log(
      `  ${c.size}×${c.size}：试切 ${c.attempts} 次 → 种出星 ${c.planted}、切出连通分区 ${c.carved}，其中铅笔推得完 ${c.completable} 次；` +
        `未定格数 中位 ${fmt(c.median)}/${c.cells}（p95 ${fmt(c.p95)}，最多 ${c.max}）｜局部搜索 ${c.searchOk}/${c.searches} 次搬到可推完`,
    );
  }
  const allOpen = (c) => (c.carved ? c.completable / c.carved : 1);
  if (big.completable === 0 && big.searchOk === 0) {
    pass(
      `「10×10 不可出货」今天仍然成立：随机切 ${big.completable}/${big.carved}（试了 ${big.attempts} 次）可推完、` +
        `局部搜索 ${big.searchOk}/${big.searches}，未定格中位数 ${fmt(big.median)}/${big.cells} 格。` +
        `对照 9×9：${mid.completable}/${mid.carved} 可推完、中位数 ${fmt(mid.median)} 格未定（比例 ${((allOpen(mid) * 100) | 0)}% vs 10×10 的 ${((allOpen(big) * 100) | 0)}%）`,
    );
  } else {
    warn(
      `提醒：10×10 的「不可出货」这句已经跑到事实前面了 —— 实测随机切 ${big.completable}/${big.carved} 可推完、` +
        `局部搜索 ${big.searchOk}/${big.searches} 可推完。它仍然不在阶梯上，但 generate.js 表头那句得改`,
    );
  }
  return { floor, big, mid };
}

// ---------------------------------------------------------------- main

async function main() {
  console.log(`双星 Battle · 难度标定   SAMPLES=${SAMPLES} AUDIT=${AUDIT} BUDGET=${BUDGET}   node ${process.version}`);
  console.log('独立口径：分数是铅笔路径（rules.js 的 solve）自己吐出来的，本文件不 import 规则表；' +
    '唯一解由 count.js 的穷举器（几何自己重写、不含任何铅笔规则）独立再数一遍，两套实现的解逐格比对。');
  const tiers = TIERS.map((t, idx) => ({ ...t, idx })).filter((t) => TIER === null || t.key === TIER);
  if (!tiers.length) {
    console.log(`✗ TIER=${TIER} 不在五档里：${TIERS.map((t) => t.key).join(', ')}`);
    process.exit(1);
  }
  if (SIZES) sizeClaims();

  const summaries = [];
  for (const T of tiers) {
    const rows = sampleTier(T, SAMPLES);
    console.log(`\n（${T.name} 抽 ${rows.length} 题用了 ${(rows.reduce((s, r) => s + r.ms, 0) / 1000).toFixed(1)} 秒（逐题墙钟合计））`);
    rows.forEach((r, i) => {
      const a = auditPuzzle(T, i, r.made);
      if (a) r.audited = a;
    });
    const kept = rows.filter((r) => r.audited);
    if (!kept.length) {
      fail(`${T.name} 没有一道题量得出来`);
      continue;
    }
    summaries.push({ ...table(T, kept), tier: T.key });
  }
  if (summaries.length >= 2) ladder(summaries);

  console.log('');
  if (failures) {
    console.log(`✗ balance 失败 ${failures} 项`);
    process.exit(1);
  }
  const over = summaries.reduce((s, x) => s + x.over, 0);
  const caOver = summaries.reduce((s, x) => s + x.caOver, 0);
  const worst = Math.max(...summaries.map((x) => x.worstNodes));
  const gmax = Math.max(...summaries.map((x) => x.genMax));
  console.log(
    `✓ balance 全绿：${summaries.length} 档阶梯递增且全部入带，出货超预算 ${over} 局、候选审计超预算 ${caOver} 张，` +
      `穷举节点最多 ${worst}/${BUDGET}，单题生成墙钟最大 ${gmax} ms`,
  );
}

await main();
