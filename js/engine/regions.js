// Region carving. The generator plants a legal star set first (js/engine/generate.js explains why
// the order cannot be reversed) and this file cuts the board into N connected regions that each
// hold exactly two of those planted stars — which is what makes the partition a *clue* rather
// than a decoration: it states a constraint the player can count against.
//
// Three moves live here:
//   plantSolution  — 2 per row, 2 per column, nothing touching, found by a small randomized DFS
//   carveRegions   — seed one region per planted star, then grow each one from its own frontier
//   tightenRegions — hand boundary cells between regions to make the partition bite harder
//
// Every function here is deterministic in its seed: the same seed must redraw the same board, or
// "resume from a save that only stores a seed" cannot work.

import { createBoard, isConnected, isArtPoint } from './board.js';

const IDX = (r, c, size) => r * size + c;

// ---------------------------------------------------------------- 1. plant the answer

// Two stars per row, two per column, no two of them adjacent (including diagonally). Placement is
// row by row, so a row's own pair only has to avoid being horizontally adjacent (b - a >= 2) and
// the row above's three-cell shadow does the rest of the adjacency work.
export function plantSolution(size, rng, { budget = 30000 } = {}) {
  const colLeft = new Array(size).fill(2);
  const stars = new Int8Array(size * size);
  let nodes = 0;

  function go(r, blocked) {
    if (r === size) {
      for (let c = 0; c < size; c++) if (colLeft[c] !== 0) return false;
      return true;
    }
    if (nodes++ > budget) return false;
    const pairs = [];
    for (let a = 0; a < size; a++) {
      if (colLeft[a] === 0 || blocked[a]) continue;
      for (let b = a + 2; b < size; b++) {
        if (colLeft[b] === 0 || blocked[b]) continue;
        pairs.push([a, b]);
      }
    }
    rng.shuffle(pairs);
    const rowsLeft = size - r - 1;
    for (const [a, b] of pairs) {
      colLeft[a]--;
      colLeft[b]--;
      let feasible = true;
      for (let c = 0; c < size; c++) if (colLeft[c] > rowsLeft || colLeft[c] < 0) feasible = false;
      if (feasible) {
        stars[IDX(r, a, size)] = 1;
        stars[IDX(r, b, size)] = 1;
        const next = new Array(size).fill(0);
        for (const c of [a - 1, a, a + 1, b - 1, b, b + 1]) if (c >= 0 && c < size) next[c] = 1;
        if (go(r + 1, next)) return true;
        stars[IDX(r, a, size)] = 0;
        stars[IDX(r, b, size)] = 0;
      }
      colLeft[a]++;
      colLeft[b]++;
    }
    return false;
  }

  if (!go(0, new Array(size).fill(0))) return null;
  return stars;
}

export const plantedStars = (size, stars) => {
  const out = [];
  for (let t = 0; t < stars.length; t++) if (stars[t]) out.push(t);
  void size;
  return out;
};

// ---------------------------------------------------------------- 2. grow the partition
//
// Each region starts from exactly **one** planted star and grows by eating frontier cells, so it
// is connected by construction — a region that begins from two far-apart seeds can grow into two
// blobs that never touch, and that was the first version's silent failure (caught by
// `createBoard`'s connectivity check, which is why the check is in the constructor and not in
// this file's good intentions).
//
// Rules of the growth:
//   * a region may never hold more than two stars, so an unclaimed star cell stays off-limits to
//     a region that already has its two — and a starved region grows first, which is what keeps
//     the pairing emergent instead of pre-decided;
//   * only unassigned cells are ever taken, so the planted star count per region is exact by
//     construction, and the sizes stay balanced because the smallest region always moves first;
//   * if nothing can move while cells remain, the layout grew a lake or sealed a star in a pocket:
//     report failure and let the caller redraw from the next seed.

export function carveRegions(size, stars, rng) {
  const list = plantedStars(size, stars);
  if (list.length !== 2 * size) return null;
  const n = size * size;
  const isStar = new Uint8Array(n);
  for (const t of list) isStar[t] = 1;
  rng.shuffle(list);
  const region = new Int8Array(n).fill(-1);
  const starsOf = new Array(size).fill(0);
  const sizeOf = new Array(size).fill(0);
  for (let g = 0; g < size; g++) {
    const seed = list[g];
    region[seed] = g;
    starsOf[g] = 1;
    sizeOf[g] = 1;
  }
  let left = n - size;
  let guard = 0;
  while (left > 0) {
    if (guard++ > n * 6) return null;
    const frontierOf = Array.from({ length: size }, () => []);
    for (let t = 0; t < n; t++) {
      const g = region[t];
      if (g < 0) continue;
      for (const nb of orthogonal(size, t)) {
        if (region[nb] !== -1) continue;
        if (isStar[nb] && starsOf[g] >= 2) continue; // this region already has its two stars
        if (!frontierOf[g].includes(nb)) frontierOf[g].push(nb);
      }
    }
    let pick = -1;
    for (let g = 0; g < size; g++) {
      if (!frontierOf[g].length) continue;
      if (pick === -1 || starvedFirst(g, pick, starsOf, sizeOf)) pick = g;
    }
    if (pick === -1) return null; // a lake, or a star nobody may reach: redraw
    const cell = frontierOf[pick][rng.int(frontierOf[pick].length)];
    region[cell] = pick;
    sizeOf[pick]++;
    if (isStar[cell]) starsOf[pick]++;
    left--;
  }
  for (let t = 0; t < n; t++) if (region[t] === -1) return null;
  for (let g = 0; g < size; g++) if (starsOf[g] !== 2) return null;
  return region;
}

// Regions still short of their two stars grow first; among equals, the smaller one moves first so
// the partition stays even-handed and no region becomes a 20-cell blob.
function starvedFirst(g, pick, starsOf, sizeOf) {
  const gStarved = starsOf[g] < 2 ? 0 : 1;
  const pStarved = starsOf[pick] < 2 ? 0 : 1;
  if (gStarved !== pStarved) return gStarved < pStarved;
  return sizeOf[g] < sizeOf[pick];
}

export function orthogonal(size, t) {
  const r = (t / size) | 0;
  const c = t % size;
  const out = [];
  if (r > 0) out.push(t - size);
  if (r < size - 1) out.push(t + size);
  if (c > 0) out.push(t - 1);
  if (c < size - 1) out.push(t + 1);
  return out;
}

// ---------------------------------------------------------------- 3. tighten the partition
//
// The one difficulty knob this game has that is not "how big is the board": how the regions bite.
// A transfer moves one non-star boundary cell from region A to an adjacent region B. It keeps
// every planted star count exact (stars never move), keeps B connected (the cell touches B), and
// has to be proven not to split A — that check is the whole risk, and `isArtPoint` is the one
// line that pays for it.
//
// Each proposal is judged by re-running the pencil solver: a partition the solver cannot finish is
// refused outright, so tightening can never trade "harder" for "unfair".

export function regionNeighbors(size, region) {
  const pairs = new Set();
  for (let t = 0; t < size * size; t++) {
    const r = (t / size) | 0;
    const c = t % size;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= size || nc >= size) continue;
      const k = nr * size + nc;
      if (region[t] === region[k]) continue;
      pairs.add(`${Math.min(region[t], region[k])},${Math.max(region[t], region[k])}`);
    }
  }
  return [...pairs].map((s) => s.split(',').map(Number));
}

// All legal single-cell transfers, in a seed-deterministic order.
export function transferMoves(size, region, stars) {
  const cellsOf = Array.from({ length: size }, () => []);
  for (let t = 0; t < region.length; t++) cellsOf[region[t]].push(t);
  const moves = [];
  for (let t = 0; t < region.length; t++) {
    if (stars[t]) continue; // a planted star never moves: each region keeps exactly two
    const from = region[t];
    const targets = new Set();
    const r = (t / size) | 0;
    const c = t % size;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= size || nc >= size) continue;
      const k = nr * size + nc;
      if (region[k] !== from) targets.add(region[k]);
    }
    for (const to of targets) {
      if (isArtPoint(cellsOf[from], size, t)) continue; // would split region `from`
      moves.push({ cell: t, from, to });
    }
  }
  return moves;
}

export function applyTransfer(region, move) {
  const next = Int8Array.from(region);
  next[move.cell] = move.to;
  return next;
}

// A partition is "tighter" the more the regions interlock; this is the shape measure the hill
// climb walks along with the solver verdict — reported, never used to pick a board (see DESIGN §8
// for why only deterministic quantities may enter a selection key).
export function interlockScore(size, region) {
  let shared = 0;
  for (let t = 0; t < size * size; t++) {
    const r = (t / size) | 0;
    const c = t % size;
    for (const [dr, dc] of [[-1, 0], [1, 0]]) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= size || nc >= size) continue;
      if (region[nr * size + nc] !== region[t]) shared++;
    }
  }
  return shared;
}

export function boardOf(size, region) {
  return createBoard({ size, region });
}

export function regionSizes(size, region) {
  const out = new Array(size).fill(0);
  for (let t = 0; t < region.length; t++) out[region[t]]++;
  return out;
}

export { isConnected };
