/* Course Manager service worker: works offline, and shows reminders (pushed by the relay, or scheduled by the open app). */
const VERSION = "cm-1";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/badge-96.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== location.origin) return;
  /* the page itself: always try for the newest version, fall back to the saved copy offline */
  if (r.mode === "navigate" || u.pathname.endsWith("/index.html") || u.pathname.endsWith("/")) {
    e.respondWith(fetch(r).then(res => { const c = res.clone(); caches.open(VERSION).then(k => k.put("./index.html", c)); return res; })
      .catch(() => caches.match("./index.html").then(m => m || caches.match("./"))));
    return;
  }
  /* catalog data, icons and the like: answer from the saved copy right away, refresh it in the background */
  if (/\.(json|png|webmanifest|zip)$/.test(u.pathname)) {
    e.respondWith(caches.open(VERSION).then(async k => {
      const hit = await k.match(r);
      const net = fetch(r).then(res => { if (res.ok) k.put(r, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});

/* a reminder from the relay */
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: e.data ? e.data.text() : "Course Manager" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Course Manager", {
    body: d.body || "", tag: d.tag || undefined, renotify: !!d.tag, icon: "icons/icon-192.png", badge: "icons/badge-96.png",
    data: { url: d.url || "./#home" }, timestamp: d.at || Date.now()
  }));
});
/* tapping a reminder opens the app (or brings it forward) on the right page */
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const target = new URL(e.notification.data && e.notification.data.url || "./#home", self.registration.scope).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (new URL(target).origin === location.origin) {
      for (const c of all) if (c.url.startsWith(self.registration.scope)) { await c.focus(); try { await c.navigate(target); } catch { c.postMessage({ cmGo: target }); } return; }
    }
    await self.clients.openWindow(target);
  })());
});
