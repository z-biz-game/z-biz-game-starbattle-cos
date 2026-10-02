'use strict';
// Star Battle 离线服务：network-first。
// 为什么不是 cache-first：手工写死版本号 + cache-first 会把 js/css 永久钉在旧版，
// 出新 HTML 配旧 JS 的鬼状态（踩过）。所以同源 GET 一律先走网络，命中就顺手回填缓存，
// 断网时才回落到上次成功抓取的资源；导航请求额外回落到缓存里的 index.html，让离线能开。
// 缓存名带版本号：改这套逻辑时把 v1 抬成 v2，activate 里清掉旧桶。
var CACHE = 'starbattle-v1';
var SHELL = ['./', './index.html', './manifest.webmanifest', './css/game.css',
  './js/main.js', './assets/textures/starfield.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error());
      });
    })
  );
});
