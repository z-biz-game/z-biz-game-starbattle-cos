// The generator: plant an answer, cut the board around it, then walk the cut until the pencil
// solver calls this difficulty.
//
// Why the order cannot be reversed. If you carve a partition first and then ask whether it has
// exactly one star placement, the honest answer for a random cut is almost always "no": a random
// N-way cut of an N×N board leaves the two-stars-per-region constraint wildly over- or under-determined,
// and the only way to fix it is a full constraint solver over partitions — a project of its own.
// Planting a legal star set first makes "solvable" a property of construction rather than hope:
// every region is seeded with two planted stars, so the planted set *is* a solution, and the
// generator's remaining job is the one it can actually check — is it the only one, and can the
// pencil rules reach it?
//
// Difficulty therefore has exactly two axes, and both are honest ones: how big the board is, and
// how the regions bite (`polish` below moves the boundary one cell at a time and re-runs the pencil
// path after every step). There are no numbers on this board to thin out — the partition *is* the
// clue set — so the pruning knob that the other games in this family reach for does not exist here.

import { makeRng } from './rng.js';
import { createBoard, EMPTY } from './board.js';
import { STAR, solve } from './rules.js';
import { plantSolution, carveRegions, transferMoves, applyTransfer, regionSizes } from './regions.js';

export const inBand = (score, band) => !!band && score >= band[0] && score <= band[1];

// One candidate partition, fully judged by the pencil path.
//
// `remaining` is what makes the whole generator work: it says how many cells the pencil path left
// undecided, so a partition that cannot be finished still has a *distance* to its nearest
// finishable neighbour. Without it the hill climb would have nothing to descend when it starts
// from a board that is not pencil-completable — which is the rare case at 9×9 (20 random cuts, 19
// of them carved, 2 of those finish) and the unreached one at 10×10 (0 of 16 carved cuts, median
// 92 of 100 cells left undecided). Those two lines are not folklore: `node tools/balance.mjs`
// reruns that experiment and prints today's numbers every time the gate runs.
//
// `createBoard` throws on a partition that split a region, which is why the walk never has to
// trust its own connectivity reasoning; a conflict from `solve` is counted as infinitely far,
// because after the soundness fixes a pencil conflict on a planted-solvable board is an engine bug
// and must not be allowed to look like progress.
export function evaluate(size, region, { lookahead = true, rounds = 2 } = {}) {
  let board = null;
  try {
    board = createBoard({ size, region });
  } catch (e) {
    return { ok: false, reason: e.message, remaining: Infinity, score: 0, board: null, pencil: null };
  }
  const p = solve(board, { lookahead, rounds });
  if (p.ok) return { ok: true, score: p.score, steps: p.steps, remaining: 0, board, pencil: p, reason: '' };
  let remaining = 0;
  for (let t = 0; t < board.n; t++) if (p.derived[t] === EMPTY) remaining++;
  if (p.conflict) remaining = Infinity;
  return { ok: false, score: 0, steps: p.steps, remaining, board, pencil: p, reason: p.conflict || '铅笔规则推不完这局' };
}

// Walk the partition: first toward *finishable* (descend `remaining`), then toward the band
// (move `score` toward it). Both legs re-run the pencil path on every proposed transfer, and both
// refuse any transfer that would leave the board unfinished — so this can trade "easier" for
// "harder" but never for "unguessable".
export function polish({ size, region, stars, band = null, rng, maxSteps = 24, probes = 14, lookahead = true, rounds = 2 }) {
  let cur = Int8Array.from(region);
  let best = evaluate(size, cur, { lookahead, rounds });
  let moves = 0;

  // leg 1 — become pencil-completable at all
  for (let step = 0; step < maxSteps && !best.ok; step++) {
    const options = transferMoves(size, cur, stars);
    rng.shuffle(options);
    let improved = null;
    for (const m of options.slice(0, probes)) {
      const next = applyTransfer(cur, m);
      const r = evaluate(size, next, { lookahead, rounds });
      if (r.remaining < best.remaining) {
        improved = { next, r };
        break;
      }
    }
    if (!improved) break;
    cur = improved.next;
    best = improved.r;
    moves++;
  }
  if (!best.ok) return { region: cur, moves, ...best };

  // leg 2 — become the requested difficulty
  for (let step = 0; step < maxSteps && band; step++) {
    const want = best.score < band[0] ? 1 : best.score > band[1] ? -1 : 0;
    if (want === 0) break;
    const edge = want > 0 ? band[1] : band[0];
    const options = transferMoves(size, cur, stars);
    rng.shuffle(options);
    let improved = null;
    for (const m of options.slice(0, probes)) {
      const next = applyTransfer(cur, m);
      const r = evaluate(size, next, { lookahead, rounds });
      if (!r.ok) continue;
      if (want > 0 ? r.score > best.score : r.score < best.score) {
        improved = { next, r };
        break;
      }
    }
    if (!improved) break;
    cur = improved.next;
    best = improved.r;
    moves++;
    if (inBand(best.score, band) || (want > 0 && best.score > edge) || (want < 0 && best.score < edge)) break;
  }
  return { region: cur, moves, ...best };
}

// One full attempt at `seed`. Returns null when the drawing is unusable so the caller can retry
// with the next derived seed — a retry is a *seeded* retry, never a timed-out one, so a slow
// machine cannot change which board a seed means.
export function drawOne({ size, seed, band = null, lookahead = true, tightenMoves = 24, probes = 14, rounds = 2 }) {
  const rng = makeRng(seed);
  const stars = plantSolution(size, rng);
  if (!stars) return null;
  let region = null;
  for (let k = 0; k < 24 && !region; k++) region = carveRegions(size, stars, rng);
  if (!region) return null;
  const t = polish({ size, region, stars, band, rng, maxSteps: tightenMoves, probes, lookahead, rounds });
  if (!t.ok) return null;
  return {
    seed,
    size,
    stars,
    region: Int8Array.from(t.region),
    moves: t.moves,
    score: t.score,
    steps: t.steps,
    board: t.board,
    pencil: t.pencil,
  };
}

// Draw `tries` boards and keep the one closest to the band. The distance is computed on measured
// quantities only (score), never on elapsed time.
export function generate(opts = {}) {
  const {
    size = 8,
    seed = 'plain',
    band = null,
    tries = 40,
    lookahead = true,
    tightenMoves = 24,
    probes = 14,
    rounds = 2,
    report = () => {},
  } = opts;
  let best = null;
  let drawn = 0;
  for (let k = 0; k < tries; k++) {
    const trial = `${seed}#${k}`;
    const r = drawOne({ size, seed: trial, band, lookahead, tightenMoves, probes, rounds });
    if (!r) {
      report({ k, score: null, reason: 'draw' });
      continue;
    }
    drawn++;
    const offBand = band ? Math.abs(r.score - clamp(r.score, band[0], band[1])) : 0;
    const cand = {
      ok: true,
      board: r.board,
      region: r.region,
      solution: solutionOf(r.board, r.pencil.derived),
      stars: r.stars,
      pencil: r.pencil,
      seed: trial,
      originSeed: seed,
      size,
      score: r.score,
      steps: r.steps,
      moves: r.moves,
      drawn,
      sizes: regionSizes(size, r.region),
      breakdown: r.pencil.breakdown,
      offBand,
      gen: k + 1,
    };
    report({ k, score: r.score, offBand });
    if (!best || cand.offBand < best.offBand || (cand.offBand === best.offBand && cand.gen < best.gen)) best = cand;
    if (band && cand.offBand === 0 && k >= 3) break;
  }
  if (!best) return { ok: false, board: null, reason: '没找到既能纯逻辑推到底、又落在难度区间里的盘面' };
  return best;
}

// The pencil path's star cells, in the flat shape the counter and the renderer both compare.
export function solutionOf(board, derived) {
  const out = new Uint8Array(board.n);
  for (let t = 0; t < board.n; t++) out[t] = derived[t] === STAR ? 1 : 0;
  return out;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------- the ladder

// The smallest board this game can *be*. Two stars per row and per column, none of them touching,
// has no legal placement at all below 8×8 — the region constraint is not even in the argument:
// enumerating placements alone gives 0 for N = 4,5,6,7 and then 2 / 664 / 146510 for N = 8 / 9 / 10.
// tools/engine-test.mjs recomputes that table by two methods that share no code with the solver or
// the counter, and goes red if the zero ever stops being zero; tools/balance.mjs recomputes it a
// third time and prints the whole table on every run. So the tiers the brief sketches at 5×5 and
// 6×6 have no legal board to sit in, and the ladder starts at 8×8 — a measured statement, not a
// caption.
export const MIN_SIZE = 8;

// Five tiers. Every `band` below is a *measured* interval: score is Σ(rule applications × weight)
// over the pencil path (js/engine/rules.js), the numbers came out of `npm run balance` runs on
// generated boards, and tools/balance.mjs goes red if a tier stops landing in its own band or if
// the medians stop increasing. `tightenMoves` is the boundary-walk budget.
//
// Two things the brief asked for are *not* in this table, and both are facts rather than choices:
// 5×5 and 6×6 have no legal board at all (see MIN_SIZE above), and 10×10 — the tournament size —
// is not shippable with the promised rule family. Today's measurement, printed by
// `node tools/balance.mjs` on every run rather than asserted here: of 20 random cuts at 10×10, 16
// produced a connected partition, 0 of those 16 were pencil-completable and 0 of 6 local-search
// runs got one there, with a median of 92 of the 100 cells left undecided. The 9×9 control in the
// same run is 2 of 19. The ladder stops at 9×9.
export const TIERS = [
  { key: 'trainee', name: '初学', size: 8, band: [110, 170], tightenMoves: 24 },
  { key: 'apprentice', name: '上手', size: 8, band: [200, 250], tightenMoves: 24 },
  { key: 'regular', name: '熟练', size: 8, band: [270, 320], tightenMoves: 30 },
  { key: 'expert', name: '高阶', size: 9, band: [240, 330], tightenMoves: 48 },
  { key: 'master', name: '大师', size: 9, band: [330, 460], tightenMoves: 60 },
];

export function tierFor(key) {
  return TIERS.find((t) => t.key === key) || TIERS[1];
}

export function makePuzzle(seed, tierKey, opts = {}) {
  const tier = tierFor(tierKey);
  const r = generate({ size: tier.size, seed, band: tier.band, tightenMoves: tier.tightenMoves, ...opts });
  if (!r.ok) return null;
  return {
    ...r,
    tier: tier.key,
    tierName: tier.name,
    originSeed: seed,
    size: tier.size,
    w: tier.size,
    h: tier.size,
  };
}
