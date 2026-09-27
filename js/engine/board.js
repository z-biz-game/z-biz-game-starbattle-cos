// The model: an N×N grid cut into N regions, plus the three kinds of unit a player counts —
// rows, columns, regions. That is the whole geometry of Star Battle, and everything else in this
// file exists so the rules, the renderer and the counter can read it from one place.
//
// A cell wears one of three states. Note that EMPTY is 0 and that is *also* a state a save file
// has to round-trip; the sentinel-vs-legitimate-value trap that bites this family (see DESIGN §2)
// is why the mark state gets its own constant instead of "anything not a star".

export const EMPTY = 0;
export const STAR = 1;
export const OUT = 2; // 铅笔排除标记：这格放不了星
export const LAST_STATE = OUT;

// Exactly two stars per row, per column, per region. One constant, because every rule that counts
// reads the same number and a rule that hardcoded "2" would drift the moment it became three.
export const UNITS_PER = 2;

// The eight directions, written here for the solver's use. js/engine/count.js writes its own
// copy on purpose — see DESIGN §3.
export const NEIGHBOR_OFFSETS = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

export const ROW = 'row';
export const COL = 'col';
export const REGION = 'region';

export const rc = (t, size) => [(t / size) | 0, t % size];
export const index = (r, c, size) => r * size + c;

// Are these cells one connected blob? Region growth keeps this true by construction; the transfer
// step that tightens a partition has to re-check it after every move, and a region that splits in
// two is the nastiest bug this generator could quietly ship.
export function isConnected(cells, size) {
  if (cells.length <= 1) return true;
  const set = new Set(cells);
  const seen = new Set([cells[0]]);
  const stack = [cells[0]];
  while (stack.length) {
    const t = stack.pop();
    const [r, c] = rc(t, size);
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= size || nc >= size) continue;
      const k = index(nr, nc, size);
      if (!set.has(k) || seen.has(k)) continue;
      seen.add(k);
      stack.push(k);
    }
  }
  return seen.size === set.size;
}

// Would removing this cell break the region apart? Used by the partition tightening step so it
// never performs a move that silently splits a region.
export function isArtPoint(cells, size, t) {
  const rest = cells.filter((x) => x !== t);
  if (rest.length === 0) return false;
  return !isConnected(rest, size);
}

export const regionName = (id) => `第${id + 1}区`;
export const unitLabel = (u) => u.name;

// Build the playable board from a region grid (one id per cell). Everything a rule needs is
// precomputed here: unit cell lists, the cell→units index, the 8-neighbour lists.
export function createBoard({ size, region, title = '' }) {
  if (!(size >= 2)) throw new Error('盘面太小：至少 2×2');
  const n = size * size;
  if (!region || region.length !== n) throw new Error(`区域划分需要 ${n} 个格子，收到 ${region ? region.length : 0} 个`);
  const ids = new Set();
  const cellsOf = Array.from({ length: size }, () => []);
  for (let t = 0; t < n; t++) {
    const g = region[t];
    if (!(g >= 0 && g < size)) throw new Error(`第${(t / size) | 0}行${(t % size) + 1}列 的区域号是 ${g}，只能取 0..${size - 1}`);
    ids.add(g);
    cellsOf[g].push(t);
  }
  if (ids.size !== size) throw new Error(`盘上要切出 ${size} 个区域，只找到 ${ids.size} 个`);
  for (let g = 0; g < size; g++) {
    if (!isConnected(cellsOf[g], size)) throw new Error(`${regionName(g)} 不连通（${cellsOf[g].length} 格）`);
  }

  const rows = [];
  const cols = [];
  for (let r = 0; r < size; r++) {
    const row = [];
    const col = [];
    for (let c = 0; c < size; c++) {
      row.push(index(r, c, size));
      col.push(index(c, r, size));
    }
    rows.push(row);
    cols.push(col);
  }

  const units = [];
  for (let r = 0; r < size; r++) units.push({ kind: ROW, index: r, cells: rows[r], name: `第${r + 1}行` });
  for (let c = 0; c < size; c++) units.push({ kind: COL, index: c, cells: cols[c], name: `第${c + 1}列` });
  for (let g = 0; g < size; g++) units.push({ kind: REGION, index: g, cells: cellsOf[g], name: regionName(g) });

  // which units each cell belongs to, plus where it sits inside each unit (a rule text can then
  // say "第 5 格" without searching), and which cells touch it squarely or diagonally
  const cellUnits = Array.from({ length: n }, () => []);
  units.forEach((u, ui) => {
    u.positions = {};
    u.cells.forEach((t, k) => {
      u.positions[t] = k;
      cellUnits[t].push(ui);
    });
  });

  const neighbors = [];
  for (let t = 0; t < n; t++) {
    const [r, c] = rc(t, size);
    const list = [];
    for (const [dr, dc] of NEIGHBOR_OFFSETS) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= size || nc >= size) continue;
      list.push(index(nr, nc, size));
    }
    neighbors.push(list);
  }

  // cells of each region that live in row r or later — the exhaustive counter uses this to prune
  // "this region cannot possibly fit its remaining stars" without scanning the grid every node
  const regionRows = cellsOf.map((cells) => {
    const perRow = new Array(size).fill(0);
    for (const t of cells) perRow[(t / size) | 0]++;
    const suffix = new Array(size + 1).fill(0);
    for (let r = size - 1; r >= 0; r--) suffix[r] = suffix[r + 1] + perRow[r];
    return { perRow, suffix };
  });

  return {
    size,
    n,
    region: Int8Array.from(region),
    cellsOf,
    rows,
    cols,
    units,
    cellUnits,
    neighbors,
    regionRows,
    title,
    starTotal: UNITS_PER * size,
    cellName: (t) => `第${((t / size) | 0) + 1}行${(t % size) + 1}列`,
    rowOf: (t) => (t / size) | 0,
    colOf: (t) => t % size,
    unitName: (ui) => units[ui].name,
    unitKindName: (ui) => (units[ui].kind === ROW ? '行' : units[ui].kind === COL ? '列' : '区域'),
  };
}

// A star set as a flat array — the shape both engines compare when they check each other.
export function starSet(board, state) {
  const out = new Uint8Array(board.n);
  for (let t = 0; t < board.n; t++) if (state[t] === STAR) out[t] = 1;
  return out;
}

export const sameStars = (a, b) => {
  if (!a || !b) return false;
  for (let t = 0; t < a.length; t++) if ((a[t] ? 1 : 0) !== (b[t] ? 1 : 0)) return false;
  return true;
};
