import { app, auth, db } from "./firebase";
import { getMessaging, getToken, isSupported, onMessage } from "firebase/messaging";
import { arrayUnion, doc, serverTimestamp, setDoc } from "firebase/firestore";

export type PushScope = "courier" | "restaurant";

let foregroundListenerInited = false;

function getUserDocRef(scope: PushScope, uid: string) {
    return doc(db, scope === "courier" ? "couriers" : "restaurants", uid);
}

// Вызывай ТОЛЬКО из user gesture (onClick кнопки)
export async function enablePush(scope: PushScope): Promise<string> {
    const uid = auth.currentUser?.uid;
    if (!uid) throw new Error("Not authorized");

    const ok = await isSupported();
    if (!ok) throw new Error("Push is not supported in this browser (Safari/iOS often unsupported)");

    // важно: только из user gesture!
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("Notifications permission not granted");

    // service worker должен лежать в корне сайта: /firebase-messaging-sw.js
    const reg = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
    await navigator.serviceWorker.ready;

    const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY as string | undefined;
    if (!vapidKey) throw new Error("Missing VITE_FIREBASE_VAPID_KEY in web/.env");

    const messaging = getMessaging(app);

    const token = await getToken(messaging, {
        vapidKey,
        serviceWorkerRegistration: reg,
    });

    if (!token) throw new Error("Failed to get FCM token");

    // сохраняем token в профиле (массив)
    const userRef = getUserDocRef(scope, uid);
    await setDoc(
        userRef,
        {
            pushTokens: arrayUnion(token),
            pushUpdatedAt: serverTimestamp(),
        },
        { merge: true }
    );

    // Foreground handler (когда страница открыта).
    // Если вкладка скрыта — покажем системное уведомление.
    if (!foregroundListenerInited) {
        foregroundListenerInited = true;

        onMessage(messaging, (payload) => {
            try {
                const data: any = payload.data ?? {};
                const title = String(data.title ?? "Notification");
                const body = String(data.body ?? "");
                const link = String(data.link ?? "/");

                // Если юзер сейчас НЕ смотрит страницу — покажем notification
                if (Notification.permission === "granted" && document.visibilityState !== "visible") {
                    const n = new Notification(title, { body } as NotificationOptions);
                    n.onclick = () => {
                        try {
                            window.open(link, "_blank", "noopener,noreferrer");
                        } catch {}
                        try {
                            n.close();
                        } catch {}
                    };
                }
            } catch {}
        });
    }

    return token;
}
