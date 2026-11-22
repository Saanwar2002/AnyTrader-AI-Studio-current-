/* AnyTrader & AnyRoller Web Push Service Worker (FCM-Compatible, Zero External CDN Scripts) */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function sanitizeTargetPath(rawPath) {
  if (typeof rawPath !== "string") return "/notifications";
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return "/notifications";
  }
  return trimmed;
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    try {
      const text = event.data ? event.data.text() : "";
      payload = { notification: { title: "AnyTrader UK", body: text } };
    } catch {
      payload = {};
    }
  }

  const notif = payload.notification || {};
  const data = payload.data || {};
  const title = notif.title || data.title || "AnyTrader UK";
  const body = notif.body || data.body || "You have a new update.";

  let targetPath = data.link || "/notifications";
  if (!data.link) {
    if (data.conversationId) targetPath = `/chat/${data.conversationId}`;
    else if (data.jobId) targetPath = `/job/${data.jobId}`;
    else if (data.rideId) targetPath = "/rides";
  }

  const safePath = sanitizeTargetPath(targetPath);

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/pwa-192.jpg",
      badge: "/pwa-192.jpg",
      tag: data.conversationId || data.jobId || data.rideId || data.notificationId || "anytrader-alert",
      renotify: true,
      data: {
        url: safePath,
        type: data.type || "notification",
      },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetPath = sanitizeTargetPath(event.notification?.data?.url);
  const fullUrl = new URL(targetPath, self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
          client.navigate(fullUrl).catch(() => {});
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(fullUrl);
      }
      return undefined;
    })
  );
});
