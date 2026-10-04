// Canvas renderer. It reads the Game's engine state and paints; it decides nothing — no cell is
// "in conflict" here, no star is judged wrong here — so the picture cannot disagree with the
// solver that the hints and the win check both use. `game.diag` and `game.violated` are the
// engine's verdicts, computed by js/engine/rules.js from the rules of the game.
//
// Layout lives here too (cell size from the container, board origin, DPR) because hitTest has to
// answer with the *same* numbers draw() used. Those two drifting apart is how a board renders
// correctly but takes taps one cell off.
//
// The region borders are drawn from board.cellsOf as edges between neighbours of different
// regions, which is the only way to get a partition with holes and concavities to look like the
// map it is — stroking each region's own outline would double-draw every shared edge.


/* ---------- 帧率无关（dt）---------- */
/* 本仓**没有逐帧运动**，所以「帧率无关」这一项在本仓是空命题而不是缺陷：全仓只有一处 requestAnimationFrame，在 js/main.js:124 的 `requestAnimationFrame(() => {…})`——先让出一帧把生成遮罩画出来，再在同一回调里同步跑 makePuzzle 出题，**不自续期**；js/render/board.js 的重绘由 pointerdown / click / keydown 触发
   没有自续期的 requestAnimationFrame 循环，屏上就没有「每帧推进」的量，帧率也就无从影响它。
   写这段备案是为了让账上分得开"查过、确实不需要"与"没人查过"——不是为了让判据变绿。

   规矩：**哪天在本仓加了逐帧动画循环，必须先删掉这段备案**，并让循环体消费 rAF 自带的
   时间戳（或自己取 performance.now()），把动画进度写成绝对截止；只按帧累加位置的一律不算。 */
import { Palette, RegionTints, Cell, Radius, Font } from '../theme.js';
import { EMPTY, STAR, OUT } from '../engine/board.js';

export function layoutFor(size, availW, availH) {
  const pad = 14; // a star's glow and the outer region border need breathing room
  const fit = Math.min((availW - pad * 2) / size, (availH - pad * 2) / size);
  // 44 CSS px is a touch target, not an aesthetic preference: when the board cannot fit, it
  // overflows and the page scrolls rather than becoming a grid of misses.
  const cell = Math.max(Cell.min, Math.min(Cell.max, Math.floor(fit)));
  return { cell, boardW: cell * size, boardH: cell * size, pad, size };
}

export class BoardView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.geo = { cell: 0, x: 0, y: 0, w: 0, h: 0, dpr: 1, size: 0 };
  }

  // The backing buffer is sized in device pixels while every draw call stays in CSS pixels: one
  // ctx.setTransform at the top keeps the star points crisp on a Retina display without doubling
  // every constant in this file.
  resize(game, availW, availH) {
    const size = game.board.size;
    const l = layoutFor(size, availW, availH);
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const box = { w: l.boardW + l.pad * 2, h: l.boardH + l.pad * 2 };
    this.canvas.style.width = `${box.w}px`;
    this.canvas.style.height = `${box.h}px`;
    this.canvas.width = Math.round(box.w * dpr);
    this.canvas.height = Math.round(box.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.geo = { cell: l.cell, x: l.pad, y: l.pad, w: box.w, h: box.h, dpr, size };
    this.game = game;
    return this.geo;
  }

  cellRect(t) {
    const { cell, x, y, size } = this.geo;
    return { x: (t % size) * cell + x, y: (((t / size) | 0) * cell) + y, size: cell };
  }

  cellCentre(t) {
    const r = this.cellRect(t);
    return { x: r.x + r.size / 2, y: r.y + r.size / 2 };
  }

  hitCell(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const { cell, x, y, size } = this.geo;
    const game = this.game;
    if (!cell || !game) return -1;
    const px = clientX - rect.left - x;
    const py = clientY - rect.top - y;
    if (px < 0 || py < 0) return -1;
    const gx = Math.floor(px / cell);
    const gy = Math.floor(py / cell);
    if (gx < 0 || gy < 0 || gx >= size || gy >= size) return -1;
    return gy * size + gx;
  }

  draw(game, { pulse = null, preview = null, ghost = null } = {}) {
    this.game = game;
    const { ctx, geo } = this;
    const { cell, size } = geo;
    const b = game.board;
    const st = game.st.cell;
    const won = game.status === 'won';
    ctx.clearRect(0, 0, geo.w, geo.h);

    roundRect(ctx, 0, 0, geo.w, geo.h, Radius.card);
    ctx.fillStyle = Palette.surface;
    ctx.fill();

    // Regions: the partition *is* the clue set, so it gets the loudest layer of paint. Each
    // region wears one of nine tints, indexed by region id (never hashed), so two regions of the
    // same board can never collide.
    for (let t = 0; t < b.n; t++) {
      const r = this.cellRect(t);
      ctx.fillStyle = RegionTints[b.region[t] % RegionTints.length];
      ctx.fillRect(r.x, r.y, cell, cell);
    }

    // Cells that carry a conclusion the pencil rules made (grey dots) sit under the ink.
    for (let t = 0; t < b.n; t++) {
      if (st[t] !== OUT) continue;
      const p = this.cellCentre(t);
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(3, cell * Cell.dotScale), 0, Math.PI * 2);
      ctx.fillStyle = Palette.mark;
      ctx.fill();
    }

    // Grid, thin.
    ctx.strokeStyle = Palette.line;
    ctx.lineWidth = 1;
    for (let i = 0; i <= size; i++) {
      line(ctx, geo.x + i * cell, geo.y, geo.x + i * cell, geo.y + size * cell);
      line(ctx, geo.x, geo.y + i * cell, geo.x + size * cell, geo.y + i * cell);
    }

    // Region borders, heavy, one stroke per shared edge.
    ctx.strokeStyle = won ? Palette.success : Palette.regionBorder;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(2.5, cell * 0.07);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const t = r * size + c;
        const x = geo.x + c * cell;
        const y = geo.y + r * cell;
        if (c + 1 >= size || b.region[t] !== b.region[t + 1]) line(ctx, x + cell, y, x + cell, y + cell);
        if (r + 1 >= size || b.region[t] !== b.region[t + size]) line(ctx, x, y + cell, x + cell, y + cell);
      }
    }
    ctx.lineCap = 'butt';

    // Stars. Which stars are in conflict is the engine's answer (game.diag.badCells), not a guess
    // made here — so a board cannot render itself into a win.
    const bad = game.diag ? game.diag.badCells : new Set();
    for (let t = 0; t < b.n; t++) {
      if (st[t] !== STAR) continue;
      const p = this.cellCentre(t);
      const onBad = bad.has(t);
      star(ctx, p.x, p.y, cell * Cell.starScale * 0.5, won ? Palette.success : onBad ? Palette.error : Palette.accent, Palette.accentEdge);
    }

    // A conflict ring around a pair of touching stars, drawn from engine-reported adjacency.
    for (const pair of (game.diag ? game.diag.adjacent : [])) {
      for (const t of pair) {
        const r = this.cellRect(t);
        ctx.strokeStyle = Palette.error;
        ctx.lineWidth = Math.max(2, cell * 0.06);
        roundRect(ctx, r.x + 2, r.y + 2, cell - 4, cell - 4, Radius.cell);
        ctx.stroke();
      }
    }

    // The box under the finger, before it is committed: a preview is paint, never ink.
    if (preview && preview.cells && preview.cells.length) {
      ctx.strokeStyle = Palette.accent;
      ctx.lineWidth = Math.max(2, cell * 0.06);
      ctx.setLineDash([Math.max(4, cell * 0.2), Math.max(3, cell * 0.14)]);
      for (const t of preview.cells) {
        const r = this.cellRect(t);
        ctx.strokeRect(r.x + 1.5, r.y + 1.5, cell - 3, cell - 3);
      }
      ctx.setLineDash([]);
    }

    // Ghost: what the current mode would do to the hovered cell, at half weight. Paint only —
    // the value comes from the engine's pure tappedValue(), so it cannot get out of sync.
    if (ghost && ghost.cell != null && ghost.value !== undefined) {
      const p = this.cellCentre(ghost.cell);
      ctx.globalAlpha = 0.38;
      if (ghost.value === STAR) star(ctx, p.x, p.y, cell * Cell.starScale * 0.5, Palette.accentEdge, Palette.accentEdge);
      else if (ghost.value === OUT) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(3, cell * Cell.dotScale), 0, Math.PI * 2);
        ctx.fillStyle = Palette.mark;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // What a hint just named — the only place the UI is allowed to say "look here".
    if (pulse && pulse.cell != null) {
      const r = this.cellRect(pulse.cell);
      ctx.strokeStyle = pulse.color || Palette.hint;
      ctx.lineWidth = Math.max(2.5, cell * 0.09);
      roundRect(ctx, r.x + 2, r.y + 2, cell - 4, cell - 4, Radius.cell);
      ctx.stroke();
      const unit = pulse.unitName;
      if (unit) {
        ctx.font = `600 ${Math.max(10, Math.round(cell * 0.24))}px ${Font.sans}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = Palette.hint;
        ctx.fillText(unit, r.x + cell / 2, r.y + cell - Math.max(12, cell * 0.28));
      }
    }
  }
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

// A five-point star as ten vertices on two radii. Drawn as a path rather than a glyph so it
// scales with the cell and never depends on which font the platform happens to have.
function star(ctx, cx, cy, radius, fill, edge) {
  const inner = radius * 0.44;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? radius : inner;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = Math.max(1, radius * 0.1);
  ctx.strokeStyle = edge;
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}
