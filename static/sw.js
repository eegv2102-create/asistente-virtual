self.addEventListener('install', event => {
    event.waitUntil(
        caches.open('v1').then(cache => {
            return cache.addAll([
                '/',
                '/static/css/style.css',
                '/static/js/script.js',
                '/static/img/favicon.ico',
                '/static/img/default-avatar.png',
                '/static/img/poo.png'  // Añade más assets si es necesario
            ]);
        })
    );
});

self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request).then(response => response || fetch(event.request))
    );
});