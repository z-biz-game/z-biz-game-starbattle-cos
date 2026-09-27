// Persistence. Everything lives under one key so a reset is one line, and a run in progress is
// stored as (origin seed, tier, the marks drawn so far, what the run has cost) rather than a copy
// of the partition or the solution — the generator is deterministic, so the board never has to
// travel through storage, and a finished 9×9 comes to well under a kilobyte.
//
// Three disciplines this file exists to keep, all of them asserted in tools/scenarios.js:
//   * one key. A second key is a second truth, and two readers disagreeing is exactly the bug
//     that makes a "resume" reopen a different board than the one the player left.
//   * dirty input is swallowed, never trusted: localStorage may hold a truncated JSON, a
//     getter that throws, or an ink list whose run lengths do not add up. The board still has to
//     open.
//   * reset really resets. Not "hide the resume card" — the saved object is replaced by
//     defaults() and written back, so a reload cannot resurrect it.

const KEY = 'starbattle.save.v1';

const defaults = () => ({
  settings: { sound: true, reduceMotion: false },
  best: {},
  resume: null,
  totals: { solved: 0, hints: 0, ms: 0 },
});

// Ink is 0 empty / 1 star / 2 grey, and early in a run the board is mostly 0s — run-length coding
// is why an 81-cell save is not an 81-entry JSON array. No offset needed: nothing here is negative.
function rleEncode(board) {
  const out = [];
  let run = board[0] ?? 0;
  let n = 1;
  for (let i = 1; i < board.length; i++) {
    if (board[i] === run && n < 255) n++;
    else {
      out.push(run, n);
      run = board[i];
      n = 1;
    }
  }
  out.push(run, n);
  return out;
}

// Decoding is where dirty data actually shows up, so it is written to *stop* rather than to
// match: a run length of 0, a non-numeric pair or a value outside 0..2 can only ever come from a
// hand-edited or truncated save, and each is skipped instead of throwing or overwriting the array.
function rleDecode(pairs, len) {
  const b = new Uint8Array(len);
  let i = 0;
  if (!Array.isArray(pairs)) return b;
  for (let p = 0; p + 1 < pairs.length; p += 2) {
    const v = pairs[p];
    const n = pairs[p + 1];
    if (!Number.isInteger(v) || v < 0 || v > 2 || !Number.isInteger(n) || n <= 0) continue;
    for (let k = 0; k < n && i < len; k++) b[i++] = v;
  }
  return b;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaults();
    const base = defaults();
    return {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...(parsed.settings || {}) },
      totals: { ...base.totals, ...(parsed.totals || {}) },
      best: parsed.best && typeof parsed.best === 'object' ? parsed.best : {},
    };
  } catch {
    return defaults();
  }
}

export const Store = {
  KEY,
  data: load(),

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* private mode / quota — the game is still playable, just forgetful */
    }
  },

  setting(name) {
    return this.data.settings[name];
  },
  setSetting(name, value) {
    this.data.settings[name] = value;
    this.save();
  },

  best(tier) {
    return this.data.best[tier] || null;
  },
  // Best time is decided by *least help taken* first: a record must mean "I worked this board out
  // myself", and a fast run built on six hints is not that.
  recordBest(tier, { ms, hints, moves, size }) {
    const cur = this.data.best[tier];
    const better =
      !cur ||
      hints < cur.hints ||
      (hints === cur.hints && (moves < cur.moves || (moves === cur.moves && ms < cur.ms)));
    if (better) this.data.best[tier] = { ms, hints, moves, size, at: Date.now() };
    this.save();
    return better;
  },

  recordSolve(ms, hints) {
    const t = this.data.totals;
    t.solved++;
    t.hints += hints;
    t.ms += ms;
    this.save();
  },

  totals() {
    return { ...this.data.totals };
  },

  saveResume(puzzle, state, elapsedMs, run) {
    this.data.resume = {
      // The generator derives an internal seed from what it is handed, so a resume has to store
      // the *origin* seed or the rebuilt board would not be the same one.
      seed: puzzle.originSeed || puzzle.seed,
      tier: puzzle.tier,
      elapsedMs,
      cells: puzzle.size * puzzle.size,
      ink: rleEncode(state),
      // The cost of the run travels with the board. Without it a player could take six hints,
      // close the tab, come back, and finish with a clean 提示 0 record — the number that decides
      // the best time is counted from actions, and actions are not saved.
      moves: run.moves,
      hints: run.hints,
      at: Date.now(),
    };
    this.save();
  },

  resume() {
    const r = this.data.resume;
    if (!r || typeof r.seed !== 'string' || typeof r.tier !== 'string') return null;
    const cells = Number.isInteger(r.cells) && r.cells > 0 ? r.cells : 0;
    if (!cells) return null;
    return { ...r, board: rleDecode(r.ink, cells) };
  },

  clearResume() {
    this.data.resume = null;
    this.save();
  },

  reset() {
    this.data = defaults();
    this.save();
  },
};
