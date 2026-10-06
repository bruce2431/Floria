/* 遥测 · 会话查看器 — Service Worker（静态资源缓存 + 离线兜底） */
/* 2026-08-28 CORE 改绝对路径：SPA 路径路由（/session/<hash>）下 SW scope=/，相对路径等价但显式绝对防歧义 */
const CACHE = 'floria-v467'
// /vendor/katex/*（2026-10-06 公式渲染）：js+css+woff2 字体一并预缓存，保证离线时公式仍可排版
const CORE = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.json', '/icon.ico',
  '/vendor/katex/katex.min.js', '/vendor/katex/katex.min.css',
  '/vendor/katex/fonts/KaTeX_AMS-Regular.woff2', '/vendor/katex/fonts/KaTeX_Caligraphic-Bold.woff2',
  '/vendor/katex/fonts/KaTeX_Caligraphic-Regular.woff2', '/vendor/katex/fonts/KaTeX_Fraktur-Bold.woff2',
  '/vendor/katex/fonts/KaTeX_Fraktur-Regular.woff2', '/vendor/katex/fonts/KaTeX_Main-Bold.woff2',
  '/vendor/katex/fonts/KaTeX_Main-BoldItalic.woff2', '/vendor/katex/fonts/KaTeX_Main-Italic.woff2',
  '/vendor/katex/fonts/KaTeX_Main-Regular.woff2', '/vendor/katex/fonts/KaTeX_Math-BoldItalic.woff2',
  '/vendor/katex/fonts/KaTeX_Math-Italic.woff2', '/vendor/katex/fonts/KaTeX_SansSerif-Bold.woff2',
  '/vendor/katex/fonts/KaTeX_SansSerif-Italic.woff2', '/vendor/katex/fonts/KaTeX_SansSerif-Regular.woff2',
  '/vendor/katex/fonts/KaTeX_Script-Regular.woff2', '/vendor/katex/fonts/KaTeX_Size1-Regular.woff2',
  '/vendor/katex/fonts/KaTeX_Size2-Regular.woff2', '/vendor/katex/fonts/KaTeX_Size3-Regular.woff2',
  '/vendor/katex/fonts/KaTeX_Size4-Regular.woff2', '/vendor/katex/fonts/KaTeX_Typewriter-Regular.woff2',
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

  // HTML 导航网络优先且不回退缓存（2026-09-18 根修）：离线兜底曾在网络抖动瞬间静默回喂缓存里的
  // 旧 index.html → 旧 app.js（v330 之前无自愈的旧代码永停旧版，「刷新了还在跑旧前端」实报的交付
  // 根因）。覆盖全部 SPA 路由导航（mode==='navigate' 含 /session/、/project/ 等路径刷新）——导航失败
  // 宁可报错由用户重试，绝不静默发旧；静态资产兜底保留。
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request))
    return
  }

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
