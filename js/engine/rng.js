// Seeded, reproducible randomness. Every board in this game is addressed by a seed string, so
// the daily puzzle, the baked campaign and the verifier can all agree on what "that board" is
// without anyone storing a board.
//
// The generator's *selection* keys must never include wall-clock time: a save stores only the
// seed, and resuming has to redraw the very same board. A slow machine must not be able to
// change which board a seed means.

export function hash32(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// xorshift32 with a nonzero, well-spread state. `int` / `pick` / `shuffle` cover everything the
// generator and the region carver need; adding a second stream is how a board stops being
// reproducible from its seed.
export function makeRng(seed) {
  let a = hash32(String(seed)) || 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    range: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
  };
}

// Local calendar day, noon-anchored so a session that starts at 23:50 does not change the
// daily board mid-play.
export function dateKey(offsetDays = 0) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { key, epochDays: Math.floor(d.getTime() / 86400000) };
}
