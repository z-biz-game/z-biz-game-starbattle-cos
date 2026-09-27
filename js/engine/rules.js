// The pencil rules — the ones a player also uses with a pencil on paper — plus the acceptance
// test and the conflict readout.
//
// `solve()` is the pencil path. It is three things at once: the route the player is shown, the
// generator's acceptance test, and the source of every hint. That is only honest if it never
// backtracks and never reads the player's ink, so it does neither. Search lives only in count.js,
// and the generator trusts neither implementation on its own.
//
// Soundness, which is what 零猜测 rests on. Every write below is a consequence of a count over
// one unit's own cells, or of a necessary-condition check over that unit's legal completions —
// sets that can only be *larger* than the true set of completions, so a cell found in all of them
// really is forced and a cell found in none really is dead. Therefore every cell the pencil path
// writes holds in *every* solution of the board, which gives the corollary the generator leans on:
// pencil-complete ⟹ the solution is unique. The converse is false, so uniqueness alone is never
// accepted as a shipping test.
//
// The consequence of that asymmetry, stated plainly: this repo refuses boards the pencil path
// cannot finish. Difficulty is capped by what these six rules can reach, and the ladder's top is
// "the hardest board these rules still finish", not "the hardest board that exists".

import { EMPTY, STAR, OUT, UNITS_PER, ROW, COL } from './board.js';

export { EMPTY, STAR, OUT, UNITS_PER };

// ---------------------------------------------------------------- the rule table

// Rule weights are the difficulty currency: `solve()` scores a board by Σ(applications × weight),
// and tools/balance.mjs measures the ladder with these numbers. They are ordered by what one
// application actually costs a player with a pencil — 星的邻域/满额排除 are one line of counting,
// 只差这些 needs the unit's free cells to be stared at, 摆不下/只剩这一对 need that unit's whole
// completion set enumerated, 试放即死 needs a mini-derivation per cell. The weights were set by
// measuring the spread they produce (DESIGN §8), not asserted.
export const Rules = {
  adj: {
    key: 'adj',
    name: '星的邻域',
    weight: 1,
    text: (b, d) => `${b.cellName(d.from)} 放了星，它的八邻域（含斜角）都不能再放——${b.cellName(d.cell)} 标灰`,
  },
  full: {
    key: 'full',
    name: '满额排除',
    weight: 1,
    text: (b, d) => `${d.unit} 的 ${UNITS_PER} 颗星已经放满，其余 ${d.open} 格都不能再放——${b.cellName(d.cell)} 标灰`,
  },
  only: {
    key: 'only',
    name: '只差这些',
    weight: 2,
    text: (b, d) => `${d.unit} 还差 ${d.need} 颗星，而它只剩 ${d.open} 格可放——这些格每一格都必须放星，${b.cellName(d.cell)} 在内`,
  },
  dead: {
    key: 'dead',
    name: '摆不下',
    weight: 3,
    text: (b, d) => `${b.cellName(d.cell)} 不在 ${d.unit} 任何一种合法摆法里（${d.unit} 还差 ${d.need} 颗星，谁跟它配都不行）——标灰`,
  },
  pair: {
    key: 'pair',
    name: '只剩这一对',
    weight: 4,
    text: (b, d) => `${d.unit} 还差 ${d.need} 颗星，可放格有 ${d.open} 个，但互不相邻的摆法只剩一种——${b.cellName(d.cell)} 必须在内`,
  },
  look: {
    key: 'look',
    name: '试放即死',
    weight: 6,
    text: (b, d) => `${b.cellName(d.cell)} 若放了星，${d.reason}——所以这格只能标灰`,
  },
};

// Ordered by cost, which is also the ①–⑥ numbering the tests, the docs and the hint copy use.
// `scoreOf` looks rules up by name so the order is not load-bearing for arithmetic — it is
// load-bearing for the claim "the weights climb", which a reader can only check by reading this
// line. `tools/engine-test.mjs` pins the sequence 1,1,2,3,4,6 here.
export const RULE_LIST = [Rules.adj, Rules.full, Rules.only, Rules.dead, Rules.pair, Rules.look];

const kindWord = (kind) => (kind === ROW ? '行' : kind === COL ? '列' : '区域');

// ---------------------------------------------------------------- the per-sweep statistics

// Star counts per unit and the shadow of every star, computed once per sweep. Both are pure
// functions of the state, so a stale value here would be a wrong verdict — nothing caches across
// sweeps.
export function stats(board, state) {
  const starCount = new Int16Array(board.units.length);
  const blocked = new Uint8Array(board.n);
  for (let t = 0; t < board.n; t++) {
    if (state[t] !== STAR) continue;
    for (const ui of board.cellUnits[t]) starCount[ui]++;
    for (const nb of board.neighbors[t]) blocked[nb] = 1;
  }
  return { starCount, blocked };
}

// Could a star legally sit here right now? Not a star yet, not touching one, and every unit this
// cell belongs to still has room. Necessary conditions only, which is what keeps the conclusions
// drawn from it sound.
export function placeable(board, state, st, t, skipUnit = -1) {
  if (state[t] !== EMPTY) return false;
  if (st.blocked[t]) return false;
  for (const ui of board.cellUnits[t]) {
    if (ui === skipUnit) continue;
    if (st.starCount[ui] >= UNITS_PER) return false;
  }
  return true;
}

const touching = (board, a, b) => board.neighbors[a].indexOf(b) >= 0;

// The cells of one unit that could still take this unit's remaining stars.
export function candidates(board, state, st, ui) {
  const u = board.units[ui];
  const out = [];
  for (const t of u.cells) if (placeable(board, state, st, t, ui)) out.push(t);
  return out;
}

// Every legal way to finish one unit: `need` cells out of its candidates, no two of them touching.
// Capped so a wide-open unit costs the same as a nearly-closed one; a capped answer is reported
// as such and the caller writes nothing it cannot justify.
export function completions(board, state, st, ui, { limit = 400 } = {}) {
  const u = board.units[ui];
  const need = UNITS_PER - st.starCount[ui];
  if (need < 0) return { need, sets: null, conflict: 'over' };
  const cand = candidates(board, state, st, ui);
  if (need === 0) return { need, sets: [[]], cand, capped: false };
  if (cand.length < need) return { need, sets: [], cand, capped: false, conflict: 'short' };
  const sets = [];
  let capped = false;
  if (need === 1) {
    for (const a of cand) {
      if (sets.length >= limit) {
        capped = true;
        break;
      }
      sets.push([a]);
    }
  } else {
    for (let i = 0; i < cand.length; i++) {
      for (let j = i + 1; j < cand.length; j++) {
        if (touching(board, cand[i], cand[j])) continue;
        if (sets.length >= limit) {
          capped = true;
          i = cand.length;
          break;
        }
        sets.push([cand[i], cand[j]]);
      }
    }
  }
  return { need, sets, cand, capped };
}

// Does this unit still have at least one way to place what it needs? The cheap, early-exiting
// form of `completions`, used inside the lookahead where the answer is all that is asked.
export function hasCompletion(board, state, st, ui) {
  const u = board.units[ui];
  const need = UNITS_PER - st.starCount[ui];
  if (need < 0) return false;
  const cand = candidates(board, state, st, ui);
  if (cand.length < need) return false;
  if (need <= 1) return true;
  for (let i = 0; i < cand.length; i++) {
    for (let j = i + 1; j < cand.length; j++) if (!touching(board, cand[i], cand[j])) return true;
  }
  return false;
}

// ---------------------------------------------------------------- contradiction

// Two stars touching, or a unit over its count: visible straight off the marks, no inference.
export function inkConflict(board, state) {
  for (let t = 0; t < board.n; t++) {
    if (state[t] !== STAR) continue;
    for (const nb of board.neighbors[t]) {
      if (nb > t && state[nb] === STAR) {
        return {
          why: '两颗星相邻',
          cells: [t, nb],
          text: `${board.cellName(t)} 与 ${board.cellName(nb)} 挨着——任何两颗星都不能相邻（含斜角）`,
        };
      }
    }
  }
  const st = stats(board, state);
  for (let ui = 0; ui < board.units.length; ui++) {
    if (st.starCount[ui] > UNITS_PER) {
      const u = board.units[ui];
      return {
        why: '超出两颗',
        cells: u.cells.filter((t) => state[t] === STAR),
        text: `${u.name} 里有 ${st.starCount[ui]} 颗星，超过每${kindWord(u.kind)} ${UNITS_PER} 颗`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------- one sweep

// One pass of the pencil rules over `derived`, writing what it proves. Returns the writes, whether
// anything changed, and a conflict if the premises themselves are impossible.
//
// Two disciplines in here are load-bearing, and both bit once:
//
//   * `changed` counts *writes*, not *records*. `record:false` is the silent form used by the
//     lookahead and `closure()`; if it also silenced `changed`, a caller would stop after one sweep
//     and call the state settled.
//   * every count is read from `derived` as it stands at that moment, never from a snapshot taken
//     before the writes. A star this sweep just wrote is already true for the two other units that
//     cell belongs to, and a stale "this unit still needs 2" against a fresh "2 cells are free"
//     writes a third star into a unit that only had room for one — which the next sweep then reports
//     as a contradiction, and the contradiction is a lie about a board that is perfectly solvable.
export function propagate(board, derived, { record = true } = {}) {
  const found = [];
  let writes = 0;
  const ink = inkConflict(board, derived);
  if (ink) return { found: [], changed: false, conflict: ink.text, cells: ink.cells };

  const emit = (cell, value, rule, extra) => {
    if (derived[cell] === value) return;
    derived[cell] = value;
    writes++;
    if (record) found.push({ cell, value, rule, ...extra });
  };

  const starsIn = (cells) => {
    let k = 0;
    for (const t of cells) if (derived[t] === STAR) k++;
    return k;
  };

  // 星的邻域
  for (let t = 0; t < board.n; t++) {
    if (derived[t] !== STAR) continue;
    for (const nb of board.neighbors[t]) if (derived[nb] === EMPTY) emit(nb, OUT, Rules.adj, { from: t });
  }

  // 满额排除 / 只差这些
  for (let ui = 0; ui < board.units.length; ui++) {
    const u = board.units[ui];
    const need = UNITS_PER - starsIn(u.cells);
    const free = u.cells.filter((t) => derived[t] === EMPTY);
    if (need < 0) {
      return {
        found,
        changed: writes > 0,
        conflict: `${u.name} 里有 ${starsIn(u.cells)} 颗星，超过每${kindWord(u.kind)} ${UNITS_PER} 颗`,
        unit: ui,
      };
    }
    if (free.length < need) {
      return {
        found,
        changed: writes > 0,
        conflict: `${u.name} 只剩 ${free.length} 格可放，凑不满还差的 ${need} 颗星`,
        unit: ui,
        cells: u.cells,
      };
    }
    if (need === 0) {
      for (const t of free) emit(t, OUT, Rules.full, { unit: u.name, open: free.length, need: 0 });
    } else if (need === free.length) {
      for (const t of free) emit(t, STAR, Rules.only, { unit: u.name, open: free.length, need });
    }
  }

  // 只剩这一对 / 摆不下：the unit's own completion set, intersected. The statistics are retaken for
  // every unit because the previous unit may just have placed a star into this one.
  for (let ui = 0; ui < board.units.length; ui++) {
    const u = board.units[ui];
    const st = stats(board, derived);
    const c = completions(board, derived, st, ui);
    if (c.conflict === 'over') {
      return {
        found,
        changed: writes > 0,
        conflict: `${u.name} 里有 ${st.starCount[ui]} 颗星，超过每${kindWord(u.kind)} ${UNITS_PER} 颗`,
        unit: ui,
      };
    }
    if (c.conflict === 'short' || (c.sets && c.sets.length === 0)) {
      const cand = c.cand || [];
      return {
        found,
        changed: writes > 0,
        conflict: `${u.name} 还差 ${c.need} 颗星，可它的 ${cand.length} 个可放格配不出不挨着的一${c.need === 1 ? '颗' : '对'}`,
        unit: ui,
        cells: u.cells,
      };
    }
    if (!c.sets || c.capped || c.need === 0) continue;
    const common = c.sets[0].filter((t) => c.sets.every((s) => s.indexOf(t) >= 0));
    const seen = new Set();
    for (const s of c.sets) for (const t of s) seen.add(t);
    for (const t of common) if (derived[t] !== STAR) emit(t, STAR, Rules.pair, { unit: u.name, open: c.cand.length, need: c.need });
    for (const t of c.cand) if (!seen.has(t) && derived[t] === EMPTY) emit(t, OUT, Rules.dead, { unit: u.name, open: c.cand.length, need: c.need });
  }

  return { found, changed: writes > 0 };
}

// Run the pencil rules to a fixpoint without recording anything; returns the contradiction text.
export function closure(board, derived, { maxRounds = 64 } = {}) {
  for (let round = 0; round < maxRounds; round++) {
    const sweep = propagate(board, derived, { record: false });
    if (sweep.conflict) return sweep.conflict;
    if (!sweep.changed) return null;
  }
  return '推导没有收敛（引擎缺陷）';
}

// ---------------------------------------------------------------- the lookahead rule
//
// "If a star sat here, the pencil rules would run into a wall a couple of steps later" — a proof by
// contradiction, so the exclusion it writes holds in every solution too.
//
// The inner run is *the same* `propagate()` the outer path uses, only unrecorded: one rule
// implementation means the lookahead cannot disagree with the game it is embedded in. An early
// version hand-copied a counting-only subset here and the copy was unsound — it read its own star
// counts stale after writing them, so it manufactured contradictions and greyed out cells that were
// the answer. `tools/engine-test.mjs` now asserts, board by board, that no exclusion ever lands on
// a solution cell and that no forced star ever leaves a unit over its two.
//
// The inner run is capped at `rounds` sweeps and never recurses: this is one step ahead, which is
// also exactly what a player with a pencil can afford to check.
export function diesAfterPlacement(board, derived, t, { rounds = 2 } = {}) {
  const probe = Int8Array.from(derived);
  probe[t] = STAR;
  for (let round = 0; round <= rounds; round++) {
    const sweep = propagate(board, probe, { record: false });
    if (sweep.conflict) return sweep.conflict;
    if (!sweep.changed) return null;
  }
  return null;
}

export function lookaheadSweep(board, derived, { rounds = 2 } = {}) {
  const writes = [];
  for (let t = 0; t < board.n; t++) {
    if (derived[t] !== EMPTY) continue;
    const reason = diesAfterPlacement(board, derived, t, { rounds });
    if (!reason) continue;
    derived[t] = OUT;
    writes.push({ cell: t, reason });
  }
  return writes;
}

// ---------------------------------------------------------------- the pencil path

// Empty board to finished board, one forced fact at a time. The returned `rows` list *is* the
// hint script: the order the clues forced their own consequences.
//
// Termination is structural rather than lucky: every write turns one EMPTY cell into a STAR or an
// OUT, so at most n writes can happen and the loop cannot spin.
export function solve(board, { lookahead = true, rounds = 2 } = {}) {
  const derived = new Int8Array(board.n);
  const script = [];
  const used = new Map();
  let budget = board.n * 4 + 8;
  for (;;) {
    if (budget-- <= 0) return { ok: false, conflict: '推导没有收敛（引擎缺陷）', derived, rows: script, steps: script.length, score: 0, breakdown: {} };
    const sweep = propagate(board, derived);
    if (sweep.conflict) {
      return {
        ok: false,
        conflict: sweep.conflict,
        cells: sweep.cells,
        derived,
        rows: script,
        steps: script.length,
        score: 0,
        breakdown: Object.fromEntries([...used].map(([k, v]) => [k, v])),
      };
    }
    if (sweep.changed) {
      for (const f of sweep.found) {
        bump(used, f.rule);
        script.push(f);
      }
      continue;
    }
    if (!lookahead) break;
    const tried = lookaheadSweep(board, derived, { rounds });
    if (!tried.length) break;
    for (const w of tried) {
      bump(used, Rules.look);
      script.push({ cell: w.cell, value: OUT, rule: Rules.look, reason: w.reason });
    }
  }
  const ok = verify(board, derived).length === 0;
  return {
    ok,
    derived,
    rows: script,
    steps: script.length,
    score: scoreOf(used),
    stars: countStars(derived),
    lookaheadUsed: used.get(Rules.look.name) || 0,
    breakdown: Object.fromEntries([...used].map(([k, v]) => [k, v])),
  };
}

export function countStars(state) {
  let k = 0;
  for (let t = 0; t < state.length; t++) if (state[t] === STAR) k++;
  return k;
}

function bump(map, rule) {
  map.set(rule.name, (map.get(rule.name) || 0) + 1);
}

function scoreOf(map) {
  let s = 0;
  for (const [name, n] of map) {
    const rule = RULE_LIST.find((r) => r.name === name);
    if (rule) s += n * rule.weight;
  }
  return Math.round(s * 10) / 10;
}

// The next thing the clues force that the player has not marked yet. Used by the tests to prove
// the hint script and the rules really are the same code path.
export function nextForced(board, state) {
  const probe = Int8Array.from(state);
  const sweep = propagate(board, probe);
  if (sweep.conflict) return { conflict: sweep.conflict };
  return sweep.found[0] || null;
}

// ---------------------------------------------------------------- 一键标灰
//
// The standard pencil-and-paper move of this genre: a unit that holds its two stars greys
// everything else in it, and a star greys its eight neighbours. Only those two rules, iterated to
// a fixpoint, and it never places a star — the player still has to find all 2N of them. That is
// why this can be a free action while a hint cannot.
//
// This is the *action*, so it writes into `state` and returns the cells it greyed; the UI wraps the
// call in one snapshot so the whole sweep undoes as one gesture. A read-only preview here was the
// original shape and it was wrong: the button greying nothing while still reporting a count is
// exactly the "caption on a coin flip" failure this file exists to prevent, and
// `tools/engine-test.mjs` now asserts `state[t] === OUT` for every cell it returns.
export function exclusions(board, state) {
  const added = [];
  for (;;) {
    let changed = false;
    for (let t = 0; t < board.n; t++) {
      if (state[t] !== STAR) continue;
      for (const nb of board.neighbors[t]) {
        if (state[nb] === EMPTY) {
          state[nb] = OUT;
          added.push(nb);
          changed = true;
        }
      }
    }
    for (const u of board.units) {
      let stars = 0;
      for (const t of u.cells) if (state[t] === STAR) stars++;
      if (stars !== UNITS_PER) continue;
      for (const t of u.cells) {
        if (state[t] === EMPTY) {
          state[t] = OUT;
          added.push(t);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return added;
}

// ---------------------------------------------------------------- is this ink still survivable?

// Every write the counting rules, the completion test and the one-step proof make is true in
// *every* solution, so if seeding the player's own stars and greys and then running those rules
// hits a contradiction, no completion of this board exists. That is the thing a player cannot see
// coming — one misplaced star leaves every row still countable — and it is worth saying out loud.
//
// The direction matters: a contradiction found here is real, so the warning never cries wolf. The
// rules are not complete, so *not* finding one never means "this is survivable" — the UI says
// "these marks already contradict", and never says "this placement is right".
export function stuckReason(board, state, { lookahead = true, rounds = 2 } = {}) {
  const derived = Int8Array.from(state);
  let budget = board.n * 3 + 8;
  for (;;) {
    if (budget-- <= 0) return '推导没有收敛（引擎缺陷）';
    const sweep = propagate(board, derived, { record: false });
    if (sweep.conflict) return sweep.conflict;
    if (sweep.changed) continue;
    if (!lookahead) return null;
    const tried = lookaheadSweep(board, derived, { rounds });
    if (!tried.length) return null;
  }
}

export function reachable(board, state, opts = {}) {
  return stuckReason(board, state, opts) === null;
}

// ---------------------------------------------------------------- readouts for the UI

// Judged straight from the rules of the game: every unit holds exactly two stars and no two stars
// touch. Nothing here reads the hint script or the marks, so a bug in the propagation cannot fake
// a win.
export function verify(board, state) {
  const bad = [];
  board.units.forEach((u, ui) => {
    const stars = u.cells.filter((t) => state[t] === STAR);
    if (stars.length !== UNITS_PER) {
      bad.push({
        why: stars.length > UNITS_PER ? '超出两颗' : '不足两颗',
        unit: ui,
        name: u.name,
        have: stars.length,
        want: UNITS_PER,
      });
    }
  });
  for (let t = 0; t < board.n; t++) {
    if (state[t] !== STAR) continue;
    for (const nb of board.neighbors[t]) {
      if (nb > t && state[nb] === STAR) bad.push({ why: '两颗星相邻', cells: [t, nb] });
    }
  }
  return bad;
}

export function complete(board, state) {
  return verify(board, state).length === 0;
}

export function diagnose(board, state) {
  const st = stats(board, state);
  let stars = 0;
  let marked = 0;
  for (let t = 0; t < board.n; t++) {
    if (state[t] === STAR) stars++;
    else if (state[t] === OUT) marked++;
  }
  const satisfied = new Set();
  const violated = new Set();
  const badCells = new Set();
  board.units.forEach((u, ui) => {
    const list = u.cells.filter((t) => state[t] === STAR);
    const free = u.cells.filter((t) => state[t] === EMPTY);
    if (list.length === UNITS_PER) satisfied.add(ui);
    else if (list.length > UNITS_PER || list.length + free.length < UNITS_PER || !hasCompletion(board, state, st, ui)) {
      violated.add(ui);
      for (const t of list) badCells.add(t);
    }
  });
  const adjacent = [];
  for (let t = 0; t < board.n; t++) {
    if (state[t] !== STAR) continue;
    for (const nb of board.neighbors[t]) {
      if (nb > t && state[nb] === STAR) {
        adjacent.push([t, nb]);
        badCells.add(t);
        badCells.add(nb);
      }
    }
  }
  return {
    stars,
    marked,
    total: board.n,
    remaining: board.n - stars - marked,
    target: board.starTotal,
    units: board.units.length,
    satisfied,
    violated,
    badCells,
    adjacent,
    conflicts: violated.size + adjacent.length,
  };
}

// ---------------------------------------------------------------- the player's own marks

export function createState(board) {
  return { board, cell: new Int8Array(board.n), history: [] };
}

export function snapshot(st) {
  st.history.push(Int8Array.from(st.cell));
  if (st.history.length > 800) st.history.shift();
  return st;
}

export function undoState(st) {
  const last = st.history.pop();
  if (!last) return false;
  st.cell.set(last);
  return true;
}

// What a tap in the current mode does to one cell: put or take the star, put or take the grey
// mark. Tapping a cell that already wears this mode's mark clears it — one predictable rule for
// both modes, and the one a player works out after two taps.
export function tappedValue(board, state, t, mode) {
  if (t < 0 || t >= board.n) return null;
  return state[t] === mode ? EMPTY : mode;
}

export function setCell(st, t, value) {
  if (t < 0 || t >= st.board.n) return false;
  if (value !== EMPTY && value !== STAR && value !== OUT) return false;
  if (st.cell[t] === value) return false;
  snapshot(st);
  st.cell[t] = value;
  return true;
}

export function resetInk(st) {
  st.cell.fill(EMPTY);
  st.history.length = 0;
  return st;
}
