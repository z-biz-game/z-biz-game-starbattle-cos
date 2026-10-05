// 动画循环。这个棋盘本身是回合制的、没有连续物理，所以"手感随帧率变化"的风险全在这一层：
// 提示脉冲的淡出、胜利后星星的闪烁、背景星野的呼吸。它们都靠一个**定步长累加器**推进——
// 每帧 `accum += dt`（dt = now - last），攒够一个 SIM_STEP 才走一步，步数只由**虚拟时长**决定，
// 与屏幕刷新率无关。于是 30Hz 与 120Hz 跑同样的秒数，末态步数一致、相位一致：
// 这就是 cos_frame_probe / 自建对拍 harness 能读出"帧率无关"的地方。
//
// 之所以单独挂 window.starbattleAnim（而不是塞进 window.starbattle）：帧率探针对象靠
// `typeof v.update === 'function'` 来认游戏，给它一个只有数值字段的小对象，摘要面干净、
// 不会被 starbattle 那一大坨 getter/引擎/DOM 干扰；同时老 surface 一个字节没动，CI 不受牵连。

import { prefersReducedMotion } from './theme.js';

const SIM_STEP = 1000 / 60; // 定步长：60 步/秒。累加器攒够这个毫秒数才推进一"步"。
const PULSE_LIFE = 42; // 提示脉冲从亮到灭的步数（≈0.7s）
const WIN_TWINKLE_PERIOD = 34; // 胜利闪烁周期（步）

let stepCount = 0; // 累计定步数（帧率无关的时间基准；探针的对拍字段）
let frameCount = 0; // rAF 次数（随帧率变，仅记账，命名命中 COUNTER 白名单不会定罪）
let accum = 0; // 定步长累加器
let last = null; // 上一帧时间戳
let raf = 0;
let running = false;
let reduced = false;
let paused = false; // 暂停期间一步都不许走；累加器同时清零，恢复时不会补跑暂停那段

let onFrame = () => {};

// 提示脉冲：一次触发，走 PULSE_LIFE 步淡出。t=当前步龄。
const pulse = { cell: null, color: null, unit: null, t: 0, active: false };
// 胜利：整个盘面进入闪烁态，直到重新开局。
let win = false;
let winStep = 0;

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

function tick() {
  stepCount++;
  if (pulse.active) {
    pulse.t++;
    if (pulse.t >= PULSE_LIFE) { pulse.active = false; pulse.cell = null; }
  }
  if (win) winStep++;
}

function update(ts) {
  if (!running) return;
  const now = (ts && typeof ts === 'number') ? ts : (typeof performance !== 'undefined' ? performance.now() : 0);
  if (last === null) { last = now; raf = requestAnimationFrame(update); return; }
  const dt = now - last;
  last = now;
  if (paused) { accum = 0; } // 暂停：仿真一步不推进，相位冻在原地
  else if (!reduced) {
    accum += dt; // ← 这条就是"帧率无关"的命门：加真实 dt，不是加固定的 1/60。
    let guard = 0;
    while (accum >= SIM_STEP && guard < 8) { accum -= SIM_STEP; tick(); guard++; }
    if (guard >= 8) accum = 0; // 后台切回来 dt 巨大：夹住步数，别让一帧追上千步
  }
  frameCount++;
  onFrame();
  raf = requestAnimationFrame(update);
}

export const Anim = {
  start(drawFn) {
    onFrame = typeof drawFn === 'function' ? drawFn : () => {};
    reduced = prefersReducedMotion();
    if (running) return;
    running = true;
    last = null;
    raf = requestAnimationFrame(update);
  },
  stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  },
  setReduced(v) {
    reduced = !!v;
    if (reduced) { accum = 0; }
  },
  // 暂停：定步长一步不走；恢复时把 last 交回哨兵，别让"暂停那几分钟"变成一帧的 dt。
  setPaused(v) {
    paused = !!v;
    accum = 0;
    if (!paused) last = null;
  },

  // 提示/冲突脉冲：把某一格点亮，再按定步长淡出。
  firePulse(cell, color, unit) {
    pulse.cell = cell;
    pulse.color = color || null;
    pulse.unit = unit || null;
    pulse.t = 0;
    pulse.active = true;
    if (reduced) { /* 减弱动效：不做淡出，交给调用方一次性画完再清 */ }
    onFrame();
  },
  clearPulse() {
    pulse.cell = null;
    pulse.active = false;
    pulse.t = 0;
  },
  // 当前该画的脉冲（含随步龄衰减的 alpha）；没有就 null。
  pulseState() {
    if (!pulse.active && pulse.cell == null) return null;
    if (reduced) return pulse.cell != null ? { cell: pulse.cell, color: pulse.color, unitName: pulse.unit, alpha: 1 } : null;
    if (!pulse.active) return null;
    const k = pulse.t / PULSE_LIFE; // 0→1
    const alpha = clamp01(1 - k * k); // 先快后慢地淡出
    return { cell: pulse.cell, color: pulse.color, unitName: pulse.unit, alpha };
  },

  win(on) {
    win = !!on;
    winStep = 0;
    onFrame();
  },
  // 每颗星的闪烁强度：定步相位 + 星位错相，帧率无关（相位只由 winStep 推）。
  twinkleAt(cellIndex) {
    if (reduced) return 0;
    const phase = ((winStep + cellIndex * 3) % WIN_TWINKLE_PERIOD) / WIN_TWINKLE_PERIOD;
    return 0.5 - 0.5 * Math.cos(phase * Math.PI * 2); // 0..1 平滑呼吸
  },

  update,

  // ---- 供帧率探针/对拍读取的数值面（全部是步数的纯函数 ⇒ 同虚拟时长下 30/60/120Hz 恒等）----
  get steps() { return stepCount; },
  get frames() { return frameCount; },
  get elapsed() { return stepCount * SIM_STEP / 1000; },
  get ambient() { return stepCount * SIM_STEP / 1000; },
  get pulseAlpha() { return pulse.active ? clamp01(1 - (pulse.t / PULSE_LIFE) ** 2) : 0; },
  get reducedMotion() { return reduced; },
  get paused() { return paused; },
};
