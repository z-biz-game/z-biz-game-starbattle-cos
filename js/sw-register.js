'use strict';
// 注册 service worker：只在 http(s) 下做，file:// 与旧 Safari/无痕都拿不到，
// 那不是玩家的错，注册失败要静默吞掉，绝不能在控制台抛红（也不该有未捕获异常）。
if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js').catch(function () {});
  });
}
