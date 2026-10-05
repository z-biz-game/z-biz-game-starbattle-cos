#!/usr/bin/env node
// 帧率对拍 + 行为判据 harness。为什么要在仓里自带一把尺子：官方
// z-biz-game-lead/003_辅助能力/polish/script/cos_frame_probe.js 用 vm.runInContext 载入源码，
// 不认 ESM，对本仓直接 `SyntaxError: Cannot use import statement outside a module` ⇒
// 清单里的"帧率无关(dt)"这类判据在这条链路上无法复验。这里用 node 原生 import + 一套 DOM 桩
// 驱动**真实的 js/main.js**（不是副本），三档帧率喂 rAF，逐字段对拍。
//
//   node tools/frame-parity.mjs            三档帧率对拍（默认）
//   node tools/frame-parity.mjs checks     静音真停 / 重开复位 / 垃圾档解码 / 缩放命中 / 触摸回落
//   node tools/frame-parity.mjs selftest   阴性对照：把 accum += dt 钉成定值，必须判红
//
// 判据口径（两条，缺一都能被蒙过去）：
//  (a) 状态是"定步号"的纯函数 ⇒ 在最大公共步号上逐字段完全相等。任何残留的 `x += v*dt` 会在这里露出来。
//      注意只看这一条不够：定步长改造做完之后，把累加器改成定值也不会让它红（每步 dt 恒等）。
//  (b) 累加器跟得住墙钟 ⇒ 同一虚拟时长下三档步数差 ≤ 最慢档一帧的粒度（30Hz 一帧跨 2 个定步），
//      且 elapsedMs / 落子数 / 盘面指纹三档全等。§6 的阴性对照就钉在这条上。
//  静止快照检：1s 与 3s 的读数必须不同，否则"全等"只是因为盘面根本没跑起来。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = process.env.SB_REPO_ROOT ? path.resolve(process.env.SB_REPO_ROOT) : path.resolve(new URL('..', import.meta.url).pathname);
const MODE = process.argv[2] || 'parity';
const SIM_STEP = 1000 / 60; // 与 js/anim.js 的定步长一致
const HZS = [30, 60, 120];
const DUR_MS = 500; // 落在 PULSE_LIFE=42 步之内，脉冲 alpha 才是中间值

let vnow = 1000; // 沙箱时钟从 1000ms 起：从 0 起步会被 last===0 哨兵吃掉一帧，凭空造出假依赖
let rafSeq = 0;
let rafQueue = new Map();
let lcgState = 12345; // 固定种子，不碰 Math.random
const lcg = () => ((lcgState = (lcgState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (n) => Math.floor(lcg() * n) % n;

const listeners = new Map();
const elCache = new Map();
const store = new Map();

function makeCtx(canvas) {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return () => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') return () => grad;
      if (k === 'canvas') return canvas;
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return typeof k === 'string' ? () => undefined : undefined;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

function makeEl(tag = 'div', id = '') {
  const e = {
    tagName: tag.toUpperCase(), id, className: '', textContent: '', innerHTML: '',
    value: '', checked: false, hidden: false, width: 900, height: 900,
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
    dataset: {}, children: [], scrollTop: 0, offsetHeight: 600, clientHeight: 600, clientWidth: 900,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    attrs: new Map(),
    addEventListener(type, fn) {
      (this.__l || (this.__l = new Map()));
      if (!this.__l.has(type)) this.__l.set(type, []);
      this.__l.get(type).push(fn);
      const key = `${id}:${type}`;
      if (!listeners.has(key)) listeners.set(key, []);
      listeners.get(key).push(fn);
    },
    removeEventListener() {},
    dispatchEvent() { return true; },
    appendChild(c) { this.children.push(c); return c; },
    append(...c) { this.children.push(...c); },
    prepend(...c) { this.children.unshift(...c); },
    replaceChildren(...c) { this.children = c; },
    removeChild() {}, remove() {},
    querySelector(sel) { return makeEl('div', sel); },
    querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 900, right: 900, bottom: 900, x: 0, y: 0 }),
    setPointerCapture() {}, releasePointerCapture() {}, focus() {}, blur() {}, click() {},
    scrollIntoView() {}, animate: () => ({ finished: Promise.resolve(), cancel() {} }),
    setAttribute(k, v) { this.attrs.set(k, String(v)); },
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; },
    hasAttribute(k) { return this.attrs.has(k); },
    removeAttribute(k) { this.attrs.delete(k); },
    insertBefore(c) { this.children.unshift(c); return c; },
    contains() { return false; },
    cloneNode() { return makeEl(tag, id); },
    get parentElement() { return this._parent || (this._parent = makeEl('div', `${id}::parent`)); },
    getContext() { return this._ctx || (this._ctx = makeCtx(this)); },
  };
  return e;
}

const documentStub = {
  readyState: 'complete', hidden: false, visibilityState: 'visible', fullscreenElement: null,
  documentElement: makeEl('html', 'html'), body: makeEl('body', 'body'), head: makeEl('head', 'head'),
  querySelector(sel) { if (!elCache.has(sel)) elCache.set(sel, makeEl('div', sel)); return elCache.get(sel); },
  querySelectorAll() { return []; },
  getElementById(id) { return this.querySelector(`#${id}`); },
  createElement(tag) { return makeEl(tag, ''); },
  createDocumentFragment() { return makeEl('fragment', ''); },
  addEventListener(type, fn) { const k = `doc:${type}`; if (!listeners.has(k)) listeners.set(k, []); listeners.get(k).push(fn); },
  removeEventListener() {},
  fonts: { ready: Promise.resolve(), load: () => Promise.resolve() },
};

const audioCalls = { resume: 0, suspend: 0, oscillators: 0 };
const chain = (dest) => (dest && typeof dest.connect === 'function' ? dest : { connect: chain });
const param = (v) => ({ value: v, setValueAtTime() { return this; }, linearRampToValueAtTime() { return this; }, exponentialRampToValueAtTime() { return this; }, setTargetAtTime() { return this; }, cancelScheduledValues() { return this; } });
let lastAudioCtx = null;
class AudioCtxStub {
  constructor() { lastAudioCtx = this; this.state = 'running'; this.sampleRate = 48000; this.destination = { connect: chain }; }
  get currentTime() { return vnow / 1000; }
  createGain() { return { gain: param(1), connect: chain, disconnect() {} }; }
  createOscillator() { audioCalls.oscillators++; return { type: 'sine', frequency: param(440), detune: param(0), connect: chain, disconnect() {}, start() {}, stop() {} }; }
  createBiquadFilter() { return { type: 'lowpass', frequency: param(1000), Q: param(1), connect: chain }; }
  createBufferSource() { return { buffer: null, connect: chain, start() {}, stop() {} }; }
  createBuffer(ch, len) { return { length: len, getChannelData: () => new Float32Array(len) }; }
  resume() { audioCalls.resume++; this.state = 'running'; return Promise.resolve(); }
  suspend() { audioCalls.suspend++; this.state = 'suspended'; return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

function installGlobals() {
  const g = globalThis;
  const def = (k, v) => Object.defineProperty(g, k, { value: v, writable: true, configurable: true });
  g.window = g;
  g.document = documentStub;
  g.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
  };
  def('performance', { now: () => vnow });
  g.Date.now = () => vnow;
  g.devicePixelRatio = 2;
  g.innerWidth = 900; g.innerHeight = 1200;
  g.requestAnimationFrame = (cb) => { rafSeq += 1; rafQueue.set(rafSeq, cb); return rafSeq; };
  g.cancelAnimationFrame = (id) => rafQueue.delete(id);
  g.matchMedia = (q) => ({ media: q, matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  g.AudioContext = AudioCtxStub;
  g.webkitAudioContext = AudioCtxStub;
  g.addEventListener = (type, fn) => { const k = `win:${type}`; if (!listeners.has(k)) listeners.set(k, []); listeners.get(k).push(fn); };
  g.removeEventListener = () => {};
  def('navigator', { userAgent: 'node-frame-parity', maxTouchPoints: 5, clipboard: { writeText: () => Promise.resolve() } });
  g.location = { href: `file://${REPO}/index.html`, origin: 'null', protocol: 'file:' };
  g.PointerEvent = function () {};
  g.MouseEvent = function () {};
  g.TouchEvent = function () {};
  g.getComputedStyle = () => ({ getPropertyValue: () => '' });
  g.Image = class { constructor() { this.width = 0; this.height = 0; } };
  g.setTimeout = () => 0; // 虚拟时钟下不放行真实计时器，否则墙钟偷跑
  g.setInterval = () => 0;
  g.clearTimeout = () => {}; g.clearInterval = () => {};
}
installGlobals();

// 一帧 = 排空当前 rAF 队列（main.js 的开局生成本身也排在 rAF 上）
function stepFrame(dt) {
  vnow += dt;
  const cbs = [...rafQueue.values()];
  rafQueue.clear();
  for (const cb of cbs) cb(vnow);
}
function runFrames(n, dt) { for (let i = 0; i < n; i += 1) stepFrame(dt); }
function pumpUntil(pred, maxFrames = 600, dt = 20) {
  let f = 0;
  while (f < maxFrames && !pred()) { stepFrame(dt); f += 1; }
  return f;
}

if (MODE === 'selftest') {
  // §6：阴性对照要钉在"仍在吃帧 dt 的那一行"。这里把累加器 `accum += dt` 钉成定值，
  // 同一把尺子必须判红——判不红就是尺子空跑。副本用子进程跑，免得 import 缓存串味。
  const { spawnSync } = await import('node:child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-selftest-'));
  fs.cpSync(path.join(REPO, 'js'), path.join(tmp, 'js'), { recursive: true });
  const animPath = path.join(tmp, 'js', 'anim.js');
  const src = fs.readFileSync(animPath, 'utf8');
  const mutated = src.replace('accum += dt;', 'accum += SIM_STEP;');
  if (mutated === src) { console.error('selftest: 没找到 `accum += dt` 这行，变异不可表达（别当通过）'); process.exit(2); }
  fs.writeFileSync(animPath, mutated);
  const child = spawnSync(process.execPath, [path.join(REPO, 'tools', 'frame-parity.mjs'), 'parity'], {
    env: { ...process.env, SB_REPO_ROOT: tmp }, encoding: 'utf8',
  });
  const tail = child.stdout.trim().split('\n').slice(-4).join(' | ');
  console.log(`selftest 变异体（accum += SIM_STEP）输出: ${tail}`);
  console.log(`结论: ${child.status !== 0 ? '✅ 阴性对照判红（尺子有效）' : '❌ 变异体仍判绿（尺子空跑）'}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(child.status !== 0 ? 0 : 1);
}

await import(pathToFileURL(path.join(REPO, 'js/main.js')).href);
const sb = globalThis.window.starbattle;
const A = globalThis.window.starbattleAnim;
if (!sb || !A) { console.error('窗口面缺失（window.starbattle / window.starbattleAnim），判尺无法复验'); process.exit(1); }

const TIERSKEY = sb.engine.TIERS[0].key;
const FIXSEED = 'parity-fixed-seed-0001';

// 进关：换 seed 重开 → 等 game 真被替换 → 固定序列落子 → 点火脉冲/胜利相位 → 预热排掉首帧哨兵
function startRound(tag) {
  const prev = sb.game;
  sb.begin(TIERSKEY, { seed: `${FIXSEED}-${tag}` });
  pumpUntil(() => sb.game && sb.game !== prev);
  lcgState = 12345; // 同种子 ⇒ 三档喂到同一份落子序列
  const size = sb.game.w;
  const cells = size * size;
  for (let i = 0; i < 24; i += 1) sb.tap(pick(cells));
  for (let i = 0; i < 24; i += 1) sb.tap(pick(cells), 2);
  A.firePulse(pick(cells), '#fff', 'row');
  A.win(true); // 只推 Anim 内部 winStep 相位，棋局状态仍是 playing
  // 预热必须是确定性的 20ms×3：16.67ms 的帧在浮点上会差出一步，凭空判红
  runFrames(3, 20);
  A.firePulse(pick(cells), '#fff', 'row');
  return { steps0: A.steps, cells, size, ms0: sb.state().elapsedMs };
}

const inLevelOf = () => sb.view() === 'game' && sb.state() && sb.state().status === 'playing';
const inkOf = () => Array.from(sb.game.st.cell).reduce((acc, v, i) => (acc * 31 + v * (i + 7)) % 1000000007, 0);
const twkOf = () => [0, 1, 2, 3, 4].map((i) => +A.twinkleAt(i).toFixed(6)).join(',');
const J = (o) => JSON.stringify(o);

if (MODE === 'checks') {
  const out = [];
  const S = sb.engine.Sound;
  const Store = sb.engine.Store;

  startRound('checks');
  if (!inLevelOf()) { console.error('未进入关卡，判据作废'); process.exit(1); }

  // 1) 静音：必须真 suspend，且静音态不得再新建振荡器（只把 gain 设 0 = 假静音）
  S.setEnabled(true);
  audioCalls.oscillators = 0; audioCalls.suspend = 0; audioCalls.resume = 0;
  sb.tap(pick(sb.game.w * sb.game.w)); sb.tap(pick(sb.game.w * sb.game.w), 2);
  out.push(`静音[有声态] 新建振荡器=${audioCalls.oscillators} resume=${audioCalls.resume} suspend=${audioCalls.suspend}`);
  S.setEnabled(false);
  audioCalls.oscillators = 0;
  sb.tap(pick(sb.game.w * sb.game.w)); sb.tap(pick(sb.game.w * sb.game.w), 2);
  out.push(`静音[静音态] 新建振荡器=${audioCalls.oscillators} suspend=${audioCalls.suspend} ctx.state=${lastAudioCtx ? lastAudioCtx.state : 'n/a'} => ${audioCalls.oscillators === 0 && audioCalls.suspend >= 1 && lastAudioCtx && lastAudioCtx.state === 'suspended' ? '真静音' : '假静音'}`);
  S.setEnabled(true);

  // 2) 重开/再来一局：用时、落子、提示、盘面、脉冲、闪烁相位、暂停位一起复位
  runFrames(60, 20);
  A.firePulse(3, '#fff', 'row');
  A.win(true);
  runFrames(20, 20);
  sb.pause(true);
  runFrames(20, 20);
  const b = sb.state();
  const before = { elapsedMs: Math.round(b.elapsedMs), moves: b.moves, hints: b.hints, ink: inkOf(), paused: sb.paused(), pulseAlpha: +A.pulseAlpha.toFixed(4), winTwk: +A.twinkleAt(0).toFixed(4) };
  const prevGame = sb.game;
  sb.begin(TIERSKEY, { seed: `${FIXSEED}-restart` });
  pumpUntil(() => sb.game && sb.game !== prevGame);
  runFrames(20, 20);
  const a = sb.state();
  const after = { elapsedMs: Math.round(a.elapsedMs), moves: a.moves, hints: a.hints, ink: inkOf(), paused: sb.paused(), pulseAlpha: +A.pulseAlpha.toFixed(4), winTwk: +A.twinkleAt(0).toFixed(4) };
  const resetOk = after.moves === 0 && after.hints === 0 && after.ink !== before.ink && after.pulseAlpha === 0
    && after.winTwk === 0 && after.paused === false && after.elapsedMs < before.elapsedMs;
  out.push(`重开复位 前=${J(before)} 后=${J(after)} => ${resetOk ? '全复位' : '有残留'}`);

  // 3) 存档两段式解码：一条坏记录只丢那一条，不许把整局冻死
  let caseId = 0;
  const freshStore = async (raw) => {
    store.set(Store.KEY, raw);
    const mod = await import(`file://${REPO}/js/store.js?case=${caseId++}`);
    return mod.Store;
  };
  const cases = [
    ['null 覆盖', '{"settings":null,"best":null,"resume":null,"totals":null}'],
    ['缺字段', '{"settings":{"sound":true}}'],
    ['类型错', '{"settings":{"sound":"yes"},"best":{"trainee":"fast"},"totals":{"solved":"many","hints":null,"ms":"x"}}'],
    ['截断 JSON', '{"settings":{"sound":tr'],
    ['顶层数组', '[1,2,3]'],
    ['顶层字符串', '"hello"'],
    ['越界 rle', '{"resume":{"seed":"probe","tier":"trainee","cells":16,"ink":[0,3,99,99,1,2,-1,5,2,1],"elapsedMs":-5000,"hints":1e9,"moves":"nan"}}'],
  ];
  for (const [name, raw] of cases) {
    try {
      const St = await freshStore(raw);
      const res = St.resume();
      let note = '';
      if (name === '越界 rle' && res) note = ` 解码=[${Array.from(res.board).join(',')}] ⇒ 好 run(0x3,1x2,2x1) 保留、坏 run(99,99)(-1,5) 跳过`;
      out.push(`垃圾档[${name}] 不抛异常 sound=${J(St.setting('sound'))} resume=${res ? 'kept' : 'null'}${note}`);
    } catch (e) {
      out.push(`垃圾档[${name}] THROW ${e.message}`);
    }
  }

  // 4) 画布坐标按 CSS 缩放换算：把 rect 缩到 0.75×/1.6× 再派发真实 pointerdown，必须命中目标格
  const geo = sb.geometry().geo;
  const size = sb.game.w;
  const canvasEl = elCache.get('#board');
  const rectOld = canvasEl.getBoundingClientRect;
  const fire = (type, ev) => { const l = canvasEl.__l && canvasEl.__l.get(type); for (const fn of l || []) fn(ev); };
  const zoomHits = [];
  [1, 0.75, 1.6].forEach((z, i) => {
    const t = (2 + i * 2) * size + 5;
    const cx = geo.x + (t % size) * geo.cell + geo.cell / 2;
    const cy = geo.y + Math.floor(t / size) * geo.cell + geo.cell / 2;
    canvasEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: geo.w * z, height: geo.h * z, right: geo.w * z, bottom: geo.h * z, x: 0, y: 0 });
    const before2 = sb.game.st.cell[t];
    fire('pointerdown', { clientX: cx * z, clientY: cy * z, pointerId: 10 + i, preventDefault() {} });
    fire('pointerup', { pointerId: 10 + i, preventDefault() {} });
    const after2 = sb.game.st.cell[t];
    zoomHits.push(`zoom${z}: 格${t} ${before2}->${after2}${before2 !== after2 ? '✓' : '✗MISS'}`);
  });
  canvasEl.getBoundingClientRect = rectOld;
  out.push(`缩放命中 ${J(zoomHits)} => ${zoomHits.every((h) => h.endsWith('✓')) ? '按 CSS 缩放换算正确' : '点 A 打 B'}`);

  // 5) 暂停真冻结：暂停期间定步长一步不走、用时不涨、盘面输入被吞；恢复后不补跑暂停那段
  startRound('pause');
  runFrames(30, 20);
  const pSteps = A.steps;
  const pMs = Math.round(sb.state().elapsedMs);
  const pMoves = sb.state().moves;
  sb.pause(true);
  runFrames(60, 20); // 虚拟 1200ms
  const frozen = { steps: A.steps - pSteps, ms: Math.round(sb.state().elapsedMs) - pMs };
  const tapCell = 2 * sb.game.w + 2;
  const cvEl = elCache.get('#board');
  const pg = sb.geometry().geo;
  const fireP = (type, ev) => { const l = cvEl.__l && cvEl.__l.get(type); for (const fn of l || []) fn(ev); };
  fireP('pointerdown', { clientX: pg.x + 2 * pg.cell + pg.cell / 2, clientY: pg.y + 2 * pg.cell + pg.cell / 2, pointerId: 7, preventDefault() {} });
  fireP('pointerup', { pointerId: 7, preventDefault() {} });
  const blocked = sb.state().moves === pMoves && sb.game.st.cell[tapCell] === 0;
  sb.pause(false);
  runFrames(30, 20); // 恢复后虚拟 600ms ≈ 36 定步
  const resumed = { steps: A.steps - pSteps, ms: Math.round(sb.state().elapsedMs) - pMs };
  out.push(`暂停真冻结 暂停期60帧: 定步+${frozen.steps} 用时+${frozen.ms}ms 输入被吞=${blocked ? '是' : '否'}；恢复后600ms: 定步+${resumed.steps} 用时+${resumed.ms}ms => ${frozen.steps === 0 && frozen.ms === 0 && resumed.steps >= 30 && resumed.steps <= 40 && resumed.ms >= 600 && resumed.ms <= 700 ? '冻结且无补跑' : '未冻结或有补跑'}`);

  // 6) 无 PointerEvent 的回落通路：touchstart/mousedown 必须能落子
  delete globalThis.PointerEvent;
  const prevG = sb.game;
  await import(`file://${REPO}/js/main.js?legacy=1`);
  const legacy = globalThis.window.starbattle;
  legacy.begin(TIERSKEY, { seed: `${FIXSEED}-legacy` });
  pumpUntil(() => legacy.game && legacy.game !== prevG);
  const lg = legacy.geometry().geo;
  const lx = lg.x + 2 * lg.cell + lg.cell / 2;
  const ly = lg.y + 4 * lg.cell + lg.cell / 2;
  const m0 = legacy.state().moves;
  const hasTouch = !!(canvasEl.__l && canvasEl.__l.get('touchstart'));
  fire('touchstart', { touches: [{ clientX: lx, clientY: ly }], preventDefault() {} });
  fire('touchend', { changedTouches: [], preventDefault() {} });
  const m1 = legacy.state().moves;
  fire('mousedown', { clientX: lx, clientY: ly, preventDefault() {} });
  fire('mouseup', { clientX: lx, clientY: ly, preventDefault() {} });
  const m2 = legacy.state().moves;
  out.push(`触摸回落 touchstart 监听=${hasTouch} touch ${m0}->${m1} mouse ${m1}->${m2} => ${hasTouch && m1 > m0 && m2 > m1 ? '回落成立' : '回落失效'}`);

  console.log(out.join('\n'));
  process.exit(0);
}

// ---------------------------------------------------------------- parity
if (!inLevelOf()) {
  sb.begin(TIERSKEY, { seed: `${FIXSEED}-warm` });
  pumpUntil(() => !!sb.game);
}
console.log(`开局: view=${sb.view()} status=${sb.state()?.status} size=${sb.game?.w} 进关=${inLevelOf() ? 'YES' : 'NO'}`);
if (!inLevelOf()) { console.error('未进入关卡（标题态），判尺作废'); process.exit(1); }

const trajs = [];
for (const hz of HZS) {
  const r = startRound(`dur-${hz}`);
  const frames = Math.max(1, Math.round((DUR_MS / 1000) * hz));
  const map = new Map();
  for (let f = 0; f < frames; f += 1) {
    stepFrame(DUR_MS / frames);
    const k = A.steps - r.steps0;
    map.set(k, { pulseAlpha: +A.pulseAlpha.toFixed(6), twk: twkOf(), elapsedMs: Math.round(sb.state().elapsedMs - r.ms0) });
  }
  const last = map.get(A.steps - r.steps0);
  trajs.push({ hz, frames, map, steps: A.steps - r.steps0, elapsedMs: last.elapsedMs, moves: sb.state().moves, ink: inkOf() });
  console.log(`${hz}Hz: 喂帧=${frames} 定步=${trajs.at(-1).steps} 用时=+${last.elapsedMs}ms 落子=${trajs.at(-1).moves} 盘面指纹=${trajs.at(-1).ink}`);
}

const commonStep = Math.min(...trajs.map((t) => Math.max(...t.map.keys())));
const atStep = (t) => {
  let best = -1;
  for (const k of t.map.keys()) if (k <= commonStep && k > best) best = k;
  return { k: best, v: t.map.get(best) };
};
const fieldRows = ['pulseAlpha', 'twk'].map((f) => {
  const vals = trajs.map((t) => { const s = atStep(t); return `${s.v[f]}@${s.k}`; });
  return { f, vals, equal: new Set(vals.map((v) => v.split('@')[0])).size === 1 };
});
const stepSpread = Math.max(...trajs.map((t) => t.steps)) - Math.min(...trajs.map((t) => t.steps));
const granularity = Math.ceil((1000 / 30) / SIM_STEP); // 最慢档一帧跨几个定步
const pureByStep = fieldRows.every((r) => r.equal);
const timeAligned = stepSpread <= granularity
  && new Set(trajs.map((t) => t.elapsedMs)).size === 1
  && new Set(trajs.map((t) => `${t.moves}/${t.ink}`)).size === 1;

for (const r of fieldRows) console.log(`(a) 公共步号=${commonStep} ${r.f}: ${J(r.vals)} ${r.equal ? 'EQUAL' : 'DIFF'}`);
console.log(`(b) 同 ${DUR_MS}ms 虚长下步数=${J(trajs.map((t) => t.steps))} 差=${stepSpread}（最慢档一帧粒度=${granularity} 步）用时=${J(trajs.map((t) => t.elapsedMs))}`);

// 静止快照检：缩短虚拟时长，读数必须跟着变
const r0 = startRound('snapshot');
runFrames(60, 20);
const at1s = { steps: A.steps - r0.steps0, twk: twkOf(), elapsedMs: Math.round(sb.state().elapsedMs - r0.ms0) };
runFrames(120, 20);
const at3s = { steps: A.steps - r0.steps0, twk: twkOf(), elapsedMs: Math.round(sb.state().elapsedMs - r0.ms0) };
const advances = at1s.steps !== at3s.steps && at1s.elapsedMs !== at3s.elapsedMs && at1s.twk !== at3s.twk;
console.log(`(c) 时长敏感 1s=${J(at1s)} 3s=${J(at3s)} => ${advances ? '随虚拟时长推进' : '静止快照，全等不算通过'}`);

const verdict = pureByStep && timeAligned && advances;
console.log(`结论: ${verdict ? '✅ 帧率无关' : '❌ 有帧率依赖/证据不足'}（步号纯函数=${pureByStep} 等时长对齐=${timeAligned} 时长敏感=${advances}）`);
process.exit(verdict ? 0 : 1);
