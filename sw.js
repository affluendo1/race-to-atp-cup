// Versioned shell only; canonical sporting data uses network-first retrieval.
const CACHE='atp-cup-shell-v1';
const FILES=['./','index.html','site.css','assets/icon.svg','src/app.js','src/admin.js','src/ui.js','src/store.js','src/config.js','src/scores.js','src/validation.js','src/derive.js','src/ratings.js','src/worker.js','src/prediction.js','data/events.json','manifest.webmanifest'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{if(e.request.method!=='GET'||new URL(e.request.url).origin!==location.origin)return;e.respondWith((async()=>{const c=await caches.open(CACHE);try{const r=await fetch(e.request);if(r.ok)await c.put(e.request,r.clone());return r;}catch{return await c.match(e.request)||(e.request.mode==='navigate'?await c.match('index.html'):new Response('Offline asset unavailable',{status:503}));}})());});
