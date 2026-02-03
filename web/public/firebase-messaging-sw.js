/* global firebase */
importScripts("https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.5/firebase-messaging-compat.js");

// Firebase Hosting даёт auto-init скрипт с конфигом проекта:
importScripts("/__/firebase/init.js");

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
    const data = payload.data || {};

    const title = data.title || "Notification";
    const body = data.body || "";
    const link = data.link || "/";

    const options = {
        body,
        data: { link },
        // можешь заменить на нормальную иконку (лучше 192x192)
        icon: "/vite.svg",
    };

    self.registration.showNotification(title, options);
});

self.addEventListener("notificationclick", (event) => {
    const link = (event.notification && event.notification.data && event.notification.data.link) || "/";
    event.notification.close();

    event.waitUntil(
        clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
            // если уже открыто — фокус + навигация
            for (const client of clientList) {
                if (client.url && "focus" in client) {
                    client.navigate(link);
                    return client.focus();
                }
            }
            // иначе открыть новое окно
            return clients.openWindow(link);
        })
    );
});
