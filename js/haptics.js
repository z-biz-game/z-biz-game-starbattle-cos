/* org 003 §0 触觉通道 — 轻量触觉反馈垫片 (tactile shim).
 * 特性探测：仅在不支持 navigator.vibrate 的环境（如 iOS Safari）自动空操作。
 * 纯增量添附，不改任何游戏逻辑；被动监听 + 节流，避免拖拽时连续震动。 */
(function () {
  'use strict';
  var last = 0;
  function fire(pattern) {
    if (typeof navigator === 'undefined' || !navigator.vibrate) return;
    var now = Date.now();
    if (now - last < 90) return;            /* 节流：拖拽 / 连点不重复震动 */
    last = now;
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {}
  }
  function haptic(kind) {
    if (kind === 'win') fire(24);
    else if (kind === 'err') fire([18, 40, 18]);
    else fire(10);
    return true;
  }
  if (typeof window !== 'undefined') window.haptic = haptic;  /* 游戏可主动调用 window.haptic('win'|'err') */
  function bind(root) {
    if (!root || !root.querySelectorAll) return;
    var sel = 'button, [role="button"], .btn, a.button, canvas,'
            + ' [class*="cell"], [class*="tile"], [class*="key"],'
            + ' [class*="peg"], [class*="stone"], [class*="piece"], [class*="node"]';
    var els;
    try { els = root.querySelectorAll(sel); } catch (e) { return; }
    if (!els || !els.forEach) return;
    els.forEach(function (el) {
      if (el.__hapticBound) return;
      el.__hapticBound = true;
      el.addEventListener('pointerdown', function () { fire(10); }, { passive: true });
    });
  }
  if (typeof document === 'undefined') return;
  if (document.readyState !== 'loading') bind(document);
  else if (document.addEventListener) document.addEventListener('DOMContentLoaded', function () { bind(document); });
  if (typeof window !== 'undefined' && window.addEventListener)
    window.addEventListener('load', function () { bind(document); });
})();
