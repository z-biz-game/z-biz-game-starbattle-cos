// An exhaustive counter. It imports nothing from board.js or rules.js — the geometry (what a row
// is, what a region is, which eight cells touch a given one) is rebuilt here from the rules of
// the game, because the point of the second opinion is that a mistake in the first one cannot
// show up in both. It contains no pencil rule, no inference, no exclusion logic.
//
// It answers one question — how many completions does this region partition have? — and stops at
// `cap`, spending its node budget rather than lying about a board it could not finish counting.
//
// Shape of the search: rows in order, and each row's two stars are enumerated as a column *pair*.
// That is 2N stars placed in N steps of at most C(N,2) branches, and three counters
// (columns left, regions left, the previous row's blocking columns) cut most branches before they
// are ever entered. A per-cell binary search would be 4^N² instead.

export const UNIQUE = 'UNIQUE';
export const MANY = 'MANY';
export const NONE = 'NONE';
export const OVERBUDGET = 'OVERBUDGET';

const PER_UNIT = 2; // two stars per row, column and region — restated here on purpose

export function countSolutions(puzzle, { cap = 2, budget = 400000 } = {}) {
  const size = puzzle.size;
  const n = size * size;
  // Fail loud. A board without its partition is not "a board with no region constraint" — reading
  // it that way would quietly turn every puzzle into "many solutions" and the second opinion would
  // stop disagreeing with anything.
  if (!Number.isInteger(size) || size < 1 || !puzzle.region || puzzle.region.length !== n) {
    throw new TypeError(`穷举器需要 {size, region}，region 必须正好是 size² 格：收到 size=${size} region=${puzzle.region ? puzzle.region.length : String(puzzle.region)}`);
  }
  const regionOf = Array.from(puzzle.region);
  const cellsIn = (r, c) => r * size + c;

  // how many cells of each region sit in row r and below — the pruning bound for "this region can
  // no longer fit the stars it still needs"
  const regionSuffix = [];
  {
    const count = Array.from({ length: size }, () => new Array(size).fill(0));
    for (let t = 0; t < n; t++) count[regionOf[t]][(t / size) | 0]++;
    for (let g = 0; g < size; g++) {
      const suffix = new Array(size + 1).fill(0);
      for (let r = size - 1; r >= 0; r--) suffix[r] = suffix[r + 1] + count[g][r];
      regionSuffix.push(suffix);
    }
  }

  const colLeft = new Array(size).fill(PER_UNIT);
  const regLeft = new Array(size).fill(PER_UNIT);
  const chosen = new Int8Array(n); // this branch's star set
  let nodes = 0;
  let solutions = 0;
  let first = null;
  let over = false;

  function row(r, blockedFromPrev) {
    if (over) return;
    if (r === size) {
      for (let c = 0; c < size; c++) if (colLeft[c] !== 0) return;
      for (let g = 0; g < size; g++) if (regLeft[g] !== 0) return;
      solutions++;
      if (!first) first = Int8Array.from(chosen);
      return;
    }
    if (nodes++ > budget) {
      over = true;
      return;
    }
    const candidates = [];
    for (let c = 0; c < size; c++) {
      if (colLeft[c] === 0) continue;
      if (blockedFromPrev[c]) continue;
      const g = regionOf[cellsIn(r, c)];
      if (regLeft[g] === 0) continue;
      candidates.push(c);
    }
    const rowsLeft = size - r - 1;
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i];
        const b = candidates[j];
        if (b - a < 2) continue; // horizontally adjacent stars are illegal
        const ga = regionOf[cellsIn(r, a)];
        const gb = regionOf[cellsIn(r, b)];
        if (ga === gb && regLeft[ga] < 2) continue;
        colLeft[a]--;
        colLeft[b]--;
        regLeft[ga]--;
        regLeft[gb]--;
        chosen[cellsIn(r, a)] = 1;
        chosen[cellsIn(r, b)] = 1;
        // prune: no column may need more stars than the rows left, no region may need more cells
        // than it still has below this row
        let ok = true;
        for (let c = 0; c < size && ok; c++) if (colLeft[c] > rowsLeft || colLeft[c] < 0) ok = false;
        for (let g = 0; g < size && ok; g++) {
          if (regLeft[g] < 0 || regLeft[g] > regionSuffix[g][r + 1]) ok = false;
        }
        if (ok) {
          const next = new Array(size).fill(0);
          for (const c of [a - 1, a, a + 1, b - 1, b, b + 1]) if (c >= 0 && c < size) next[c] = 1;
          row(r + 1, next);
        }
        colLeft[a]++;
        colLeft[b]++;
        regLeft[ga]++;
        regLeft[gb]++;
        chosen[cellsIn(r, a)] = 0;
        chosen[cellsIn(r, b)] = 0;
        if (solutions >= cap || over) break;
      }
      if (solutions >= cap || over) break;
    }
  }

  row(0, new Array(size).fill(0));

  if (over) return { status: OVERBUDGET, solutions, nodes, first: null };
  return {
    status: solutions >= cap ? MANY : solutions === 1 ? UNIQUE : NONE,
    solutions,
    nodes,
    first: first ? starArray(first) : null,
  };
}

// The counter's answer in the same shape the rest of the repo compares: one byte per cell, 1 for a
// star and 0 for anything else.
function starArray(marks) {
  const out = new Int8Array(marks.length);
  for (let t = 0; t < marks.length; t++) out[t] = marks[t] ? 1 : 0;
  return out;
}

// Independent re-check that a given star set obeys the rules of the game. Written a second time,
// deliberately, so a generator bug cannot agree with itself: this is the function the baked
// campaign and the balance bench use to judge a board.
export function legalStarSet(puzzle, stars) {
  const size = puzzle.size;
  const n = size * size;
  if (!Number.isInteger(size) || size < 1 || !puzzle.region || puzzle.region.length !== n) {
    throw new TypeError(`复核器需要 {size, region}，region 必须正好是 size² 格：收到 size=${size} region=${puzzle.region ? puzzle.region.length : String(puzzle.region)}`);
  }
  const regionOf = Array.from(puzzle.region);
  const has = (t) => stars[t] === 1;
  for (let r = 0; r < size; r++) {
    let k = 0;
    for (let c = 0; c < size; c++) if (has(r * size + c)) k++;
    if (k !== PER_UNIT) return false;
  }
  for (let c = 0; c < size; c++) {
    let k = 0;
    for (let r = 0; r < size; r++) if (has(r * size + c)) k++;
    if (k !== PER_UNIT) return false;
  }
  const regCount = new Array(size).fill(0);
  for (let t = 0; t < n; t++) if (has(t)) regCount[regionOf[t]]++;
  for (let g = 0; g < size; g++) if (regCount[g] !== PER_UNIT) return false;
  const dr = [-1, -1, -1, 0, 0, 1, 1, 1];
  const dc = [-1, 0, 1, -1, 1, -1, 0, 1];
  for (let t = 0; t < n; t++) {
    if (!has(t)) continue;
    const r = (t / size) | 0;
    const c = t % size;
    for (let k = 0; k < 8; k++) {
      const nr = r + dr[k];
      const nc = c + dc[k];
      if (nr < 0 || nc < 0 || nr >= size || nc >= size) continue;
      if (has(nr * size + nc)) return false;
    }
  }
  return true;
}
