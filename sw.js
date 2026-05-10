/**
 * Service Worker — 博客离线缓存
 * 策略：
 *   Cache First  — CSS / JS / 字体
 *   Stale While Revalidate — 图片
 *   Network First — HTML 页面（保证内容最新）
 */

const CACHE_NAME = 'mgw-blog-v2';
const STATIC_ASSETS = [
  '/',
  '/offline.html',
  '/assets/css/blog.css',
  '/assets/css/syntax.css',
  '/assets/js/theme.js',
  '/assets/js/search.js',
  '/assets/js/particles.js',
  '/assets/img/avatar.svg'
];

// 安装：预缓存核心静态资源
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// 激活：清理旧版本缓存
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// 请求拦截
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // 只处理同源请求（跳过 CDN 字体等跨域请求的复杂处理）
  if (url.origin !== self.location.origin) {
    // 跨域字体/CDN：网络优先，失败则跳过缓存
    event.respondWith(fetch(request).catch(() => caches.match(request)));
    return;
  }

  // HTML 页面：Network First，失败时回退到离线页
  if (request.headers.get('accept') && request.headers.get('accept').includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request).then(cached => cached || caches.match('/offline.html')))
    );
    return;
  }

  // 图片：Stale While Revalidate
  if (request.destination === 'image') {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(request).then(cached => {
          const network = fetch(request).then(response => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          });
          return cached || network;
        })
      )
    );
    return;
  }

  // CSS / JS / 字体：Cache First
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});
