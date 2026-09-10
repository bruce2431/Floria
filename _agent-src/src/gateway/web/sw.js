/* 遥测 · 会话查看器 — Service Worker（静态资源缓存 + 离线兜底） */
/* 2026-08-28 CORE 改绝对路径：SPA 路径路由（/session/<hash>）下 SW scope=/，相对路径等价但显式绝对防歧义 */
const CACHE = 'floria-v287'
const CORE = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.json', '/icon.ico',
  '/char/1.jpg', '/char/2.jpg', '/char/3.jpg', '/char/4.jpg',
  '/gate/state-token.webp', '/gate/state-newchat.webp', '/gate/transition.webm', '/gate/transition.mp4']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

// 网络优先，失败回退缓存（静态）；API 不缓存
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (url.origin !== location.origin) return
  if (url.pathname.startsWith('/gateway/')) return
  // /preview/、/default-preview/ 不缓存：入口带网关 token（?token=），避免带凭据的响应进缓存残留，且预览页始终实时
  if (url.pathname.startsWith('/preview/')) return
  if (url.pathname.startsWith('/default-preview/')) return

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(e.request, copy))
        return res
      })
      .catch(() => caches.match(e.request).then((m) => m || caches.match('/'))),
  )
})
