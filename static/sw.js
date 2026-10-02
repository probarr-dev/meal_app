// Service worker: makes the app installable and shows push notifications.
// No fetch handler on purpose, so nothing is ever served from a stale cache.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  const opts = {
    body: d.body || "", tag: d.tag, icon: "/icon-192.png", badge: "/icon-192.png",
    data: { url: d.url || "/", requestId: d.requestId || null },
  };
  // A child's request: buttons where the platform supports them (Android, desktop).
  // iPhone ignores actions; tapping opens an Approve / Say no box in the app instead.
  if (d.requestId) opts.actions = [{ action: "approve", title: "Approve" }, { action: "deny", title: "Say no" }];
  e.waitUntil(self.registration.showNotification(d.title || "Meal Planner", opts));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const { url = "/", requestId } = e.notification.data || {};
  if (requestId && (e.action === "approve" || e.action === "deny")) {
    e.waitUntil(fetch("/api/extra-request/resolve", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: requestId, decision: e.action, resolver_id: 0 }),
    }).then((r) => r.json()).then((r) => self.registration.showNotification(
      r.ok ? (e.action === "approve" ? "Approved ✓" : "Said no") : "Couldn't do that",
      { body: r.ok ? "" : (r.error || "Open the app to try again."), tag: "resolved", icon: "/icon-192.png" }))
      .catch(() => self.clients.openWindow(url)));
    return;
  }
  // Plain tap: open the app there. "?req=" makes the app show the Approve / Say no box.
  const target = new URL(requestId ? `/?req=${requestId}${new URL(url, self.location.origin).hash}` : url,
    self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
    const w = wins.find((c) => c.url.startsWith(self.location.origin));
    if (w) { w.postMessage({ type: "open", url: target }); return w.focus(); }
    return self.clients.openWindow(target);
  }));
});
