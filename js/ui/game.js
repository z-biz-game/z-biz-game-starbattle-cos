// The playable state machine: what a tap does, what a drag commits, what 一键标灰 writes, when a
// board counts as solved, and what a hint is allowed to say.
//
// Two deliberate bindings to js/engine/rules.js:
//   * the ink lives in the engine's own `st.cell` array and the win check is the engine's
//     independent `verify()` — written straight from the rules of the game rather than from this
//     file's bookkeeping — so "the UI said I won" cannot disagree with "每行每列每区两颗、谁也不挨着".
//   * hints are read out of a script the *clues* produced (`solve()` on the empty board), never
//     out of the player's own marks. A wrong star therefore cannot make the hints agree with the
//     mistake: the engine keeps saying what the partition actually forces, and when the player's
//     mark contradicts it, `hint()` refuses and charges nothing.
//
// One gesture = one snapshot. That is what makes 撤销 an exact reverse instead of a re-derivation,
// and it is why a drag that greys nine cells goes back as one step.

import {
  createState,
  setCell,
  snapshot,
  undoState,
  solve,
  verify,
  complete,
  stuckReason,
  diagnose,
  exclusions,
  tappedValue,
  countStars,
  Rules,
  EMPTY,
  STAR,
  OUT,
} from '../engine/rules.js';

export { EMPTY, STAR, OUT };

export const MODES = [STAR, OUT];

export class Game {
  constructor(puzzle) {
    this.puzzle = puzzle;
    this.board = puzzle.board;
    this.w = this.board.size;
    this.h = this.board.size;
    this.st = createState(this.board);
    this.steps = [];
    // The whole hint script is computed once, from the partition alone. `solve()` is the same
    // function the generator used to accept this board, so a hint can never be a fact the clues
    // do not force — and it is the *route*, which is why the panel can show the rule name.
    this.script = solve(this.board).rows;
    this.cursor = 0;
    this.moves = 0;
    this.hints = 0;
    this.prunes = 0;
    this.status = 'playing';
    this.mode = STAR;
    this.lastHint = null;
    this.recompute();
  }

  recompute() {
    this.diag = diagnose(this.board, this.st.cell);
    this.violated = verify(this.board, this.st.cell);
    // `stuckReason` runs the same propagation `reachable()` would and *also* returns the sentence
    // the engine itself reached the contradiction with — so the panel can quote the reason instead
    // of inventing one, at the cost of nothing extra.
    this.stuckText = stuckReason(this.board, this.st.cell);
    this.stuck = this.stuckText !== null;
    return this.diag;
  }

  cellAt(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
    return y * this.w + x;
  }

  valueOf(t) {
    return t >= 0 && t < this.board.n ? this.st.cell[t] : EMPTY;
  }

  // Every gesture consumes exactly one engine snapshot and records the cells it changed with
  // their prior values, so 撤销 is an exact reverse rather than a re-derivation.
  commit(kind, info) {
    this.steps.push({ kind, ...info });
    if (kind === 'hint') this.hints++;
    else if (kind === 'prune') this.prunes++;
    else this.moves++;
    this.recompute();
    this.checkWin();
    return this.steps[this.steps.length - 1];
  }

  // One predictable rule for both modes: tapping the mark this mode makes erases it, anything
  // else puts it there. `tappedValue` is the engine's own pure preview, so the finger and the
  // renderer can never disagree about what the tap will do.
  tap(t, mode = this.mode) {
    // A tap has two outcomes and no third: put this mode's mark down, or lift it. `stroke` is the
    // one allowed to write EMPTY (an erasing drag), because a gesture that starts on your own mark
    // erases everything it crosses.
    if (this.status === 'won' || t < 0 || t >= this.board.n || !MODES.includes(mode)) return null;
    const want = tappedValue(this.board, this.st.cell, t, mode);
    if (want === null || want === this.st.cell[t]) return null;
    const from = this.st.cell[t];
    if (!setCell(this.st, t, want)) return null;
    return this.commit('tap', { writes: [{ cell: t, from, to: want }], value: want });
  }

  // A drag paints one value, never toggling — sweeping back over your own stars must not eat them.
  // The whole gesture is one step, so 撤销 undoes a stroke rather than a cell of it.
  stroke(cells, value) {
    if (this.status === 'won') return null;
    const writes = [];
    const seen = new Set();
    for (const t of cells) {
      if (t < 0 || t >= this.board.n || seen.has(t)) continue;
      seen.add(t);
      if (this.st.cell[t] === value) continue;
      writes.push({ cell: t, from: this.st.cell[t], to: value });
    }
    if (!writes.length) return null;
    snapshot(this.st);
    for (const w of writes) this.st.cell[w.cell] = w.to;
    return this.commit('stroke', { writes, value });
  }

  // 一键标灰. The only free action in the game: it writes greys that two rules alone justify (a
  // star's eight neighbourhood, a full unit's leftovers), it never places a star, and it costs
  // neither a move nor a hint — so all 2N stars still have to be found by the player. One
  // snapshot wraps the whole sweep, which is what makes it undo as one gesture.
  prune() {
    if (this.status === 'won') return null;
    const before = Array.from(this.st.cell);
    const added = exclusions(this.board, this.st.cell);
    if (!added.length) return null;
    snapshot(this.st);
    const writes = added.map((t) => ({ cell: t, from: before[t], to: OUT }));
    return this.commit('prune', { writes, value: OUT });
  }

  load(cells) {
    for (let t = 0; t < this.board.n; t++) {
      const v = cells[t];
      this.st.cell[t] = v === STAR || v === OUT ? v : EMPTY;
    }
    this.recompute();
    this.checkWin();
    return this;
  }

  undo() {
    const step = this.steps.pop();
    if (!step) return null;
    undoState(this.st);
    for (const w of step.writes || []) this.st.cell[w.cell] = w.from;
    // A hint taken back is still a hint that was taken: records rank runs by help used, so
    // refunding the counter would let a player undo their way to a clean 提示 0.
    if (step.kind === 'prune') this.prunes = Math.max(0, this.prunes - 1);
    else if (step.kind !== 'hint') this.moves = Math.max(0, this.moves - 1);
    this.recompute();
    // 撤销之后局面可能已经不再是「赢下的那一张」，所以判胜要重算一次。少了这一句，「赢 → 撤销」
    // 会留下一张 status 仍是 won、星数却读 0/16 的自相矛盾的面板：tap / stroke / prune / hint 都在
    // 终局时早退，玩家唯一能把棋盘改回未完成状态的动作就是这个漏了判胜的撤销。
    this.checkWin();
    return step;
  }

  // Where to point when the ink is already wrong, and what to say about it. null = nothing clashes.
  // Adjacency is checked before unit counts because "these two stars touch" is the one a player can
  // act on without reading a sentence. The stuck case breaks no rule at all — nothing on the board
  // is illegal, the clues simply have no completion left — so the last cell written is named,
  // because that is the one an undo takes back.
  clash() {
    const d = this.diag;
    const name = (t) => this.board.cellName(t);
    if (d.adjacent.length) {
      const [a, b] = d.adjacent[0];
      return { cell: a, why: `${name(a)} 与 ${name(b)} 挨着——任何两颗星都不能相邻（含斜角）` };
    }
    if (d.violated.size) {
      const ui = [...d.violated][0];
      const u = this.board.units[ui];
      const st = this.st.cell;
      const stars = u.cells.filter((t) => st[t] === STAR);
      const free = u.cells.filter((t) => st[t] === EMPTY);
      if (stars.length > 2) return { cell: stars[2], why: `${u.name}里有 ${stars.length} 颗星，每${kindWord(u.kind)}只能 2 颗` };
      if (stars.length + free.length < 2) {
        return { cell: stars[0] != null ? stars[0] : u.cells[0], why: `${u.name} 只剩 ${free.length} 格没定，凑不满 2 颗（已有 ${stars.length} 颗）` };
      }
      const grey = u.cells.find((t) => st[t] === OUT);
      // 这一枝也必须指出一格**画得出红框**的格子。该区域可能一颗星、一个灰点都没有（只剩几个
      // 两两相邻的空格），那时 `stars[0]` 和 `grey` 都是 undefined，而 board.draw 的
      // `pulse.cell != null` 守卫会把整枝丢掉 —— 面板说着「先看红框那一格」，盘上一格红框也没有。
      // 区域自己至少有一格，拿它兜底，指的就是这句话正在讲的那个单元。
      const point = stars[0] != null ? stars[0] : grey != null ? grey : u.cells[0];
      return { cell: point, why: `${u.name} 已经没有合法摆法：没定的格两两相邻，放不下 2 颗不挨着的星` };
    }
    if (this.stuck) {
      const last = this.steps[this.steps.length - 1];
      if (last && last.writes && last.writes.length) {
        const t = last.writes[last.writes.length - 1].cell;
        return { cell: t, why: `${name(t)} 落下去之后线索就推不下去了：${this.stuckText}` };
      }
      const s = Array.from(this.st.cell).findIndex((v) => v === STAR);
      if (s >= 0) return { cell: s, why: `${name(s)} 之后线索就推不下去了：${this.stuckText}` };
    }
    return null;
  }

  // The next fact the clues force that the player has not marked yet. Everything before it in the
  // script is already on the board, so a hint is always one step of real progress — and when the
  // script runs out the board is finished, so "nothing to say" cannot be charged for.
  hint() {
    if (this.status === 'won') return null;
    // A position that is already contradictory gets no new deduction. The rows further down the
    // script are still true *of the clues*, but spending a hint on one of them while the player's
    // own marks have made the board undeliverable is exactly the "hint as answer button" this
    // branch exists to prevent — so name the clash, point at it, charge nothing.
    const clash = this.clash();
    if (clash) {
      return {
        conflict: `${clash.why} —— 记号和线索矛盾，先撤销那一笔。提示没有扣次数。`,
        cell: clash.cell,
        charged: false,
      };
    }
    while (this.cursor < this.script.length) {
      const row = this.script[this.cursor];
      if (this.st.cell[row.cell] === row.value) {
        this.cursor++;
        continue;
      }
      if (this.st.cell[row.cell] !== EMPTY && this.st.cell[row.cell] !== row.value) {
        // The player's own mark contradicts what the clues force: say so, point at it, and
        // charge nothing. This is the branch that keeps 提示 from being an answer button.
        return {
          conflict: `${this.board.cellName(row.cell)} 与线索矛盾：这里必须是${markName(row.value)}。`,
          cell: row.cell,
          charged: false,
        };
      }
      const from = this.st.cell[row.cell];
      setCell(this.st, row.cell, row.value);
      this.cursor++;
      this.commit('hint', { writes: [{ cell: row.cell, from, to: row.value }], value: row.value, rule: row.rule.name });
      const info = {
        rule: row.rule.name,
        ruleKey: row.rule.key,
        cell: row.cell,
        value: row.value,
        unit: row.unit || null,
        why: row.rule.text(this.board, row),
        charged: true,
      };
      this.lastHint = info;
      return info;
    }
    return { stalled: true, text: '线索能推的都已经推完了：剩下的格只能自己收尾。' };
  }

  checkWin() {
    this.status = complete(this.board, this.st.cell) ? 'won' : 'playing';
    return this.status === 'won';
  }

  // Only used by the verification harness and the "show me the whole route" path: play the
  // clue-derived script to the end. Every cell it writes is one the pencil rules justify.
  solveWithLogic({ cap = 4000 } = {}) {
    let k = 0;
    while (this.status !== 'won' && k++ < cap) {
      const before = this.steps.length;
      const h = this.hint();
      if (!h || h.stalled || h.conflict) break;
      if (this.steps.length === before) break;
    }
    return { status: this.status, steps: k };
  }

  state() {
    const g = this.diag;
    return {
      tier: this.puzzle.tier,
      name: this.puzzle.tierName,
      seed: this.puzzle.seed,
      originSeed: this.puzzle.originSeed,
      size: this.w,
      moves: this.moves,
      hints: this.hints,
      prunes: this.prunes,
      status: this.status,
      stars: g.stars,
      target: g.target,
      marked: g.marked,
      total: g.total,
      remaining: g.remaining,
      units: g.units,
      satisfied: g.satisfied.size,
      violated: g.violated.size,
      adjacent: g.adjacent.length,
      conflicts: g.conflicts,
      stuck: this.stuck,
      problems: this.violated.length,
      script: this.script.length,
      cursor: this.cursor,
      score: this.puzzle.score,
      steps: this.steps.length,
      mode: this.mode,
    };
  }
}

export function markName(value) {
  return value === STAR ? '星' : value === OUT ? '灰点' : '空';
}

const kindWord = (kind) => (kind === 'row' ? '行' : kind === 'col' ? '列' : '区域');

export { Rules };
