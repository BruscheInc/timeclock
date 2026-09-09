// Time Clock service worker — cache the shell; /api/* always hits the network (live punches/data).
const CACHE="timeclock-v3";
const SHELL=["./","./index.html","./manifest.webmanifest"];
self.addEventListener("install",(e)=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()).catch(()=>{}));});
self.addEventListener("activate",(e)=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener("fetch",(e)=>{const url=new URL(e.request.url);if(e.request.method!=="GET"||url.pathname.startsWith("/api/"))return;e.respondWith(caches.match(e.request).then(hit=>hit||fetch(e.request).then(resp=>{const cp=resp.clone();caches.open(CACHE).then(c=>c.put(e.request,cp)).catch(()=>{});return resp;}).catch(()=>caches.match("./index.html"))));});
