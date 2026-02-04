import { app, auth, db } from "./firebase";
import { arrayUnion, doc, serverTimestamp, setDoc } from "firebase/firestore";
import { Capacitor } from "@capacitor/core";

export type PushScope = "courier" | "restaurant";

let foregroundListenerInited = false;

function getUserDocRef(scope: PushScope, uid: string) {
    return doc(db, scope === "courier" ? "couriers" : "restaurants", uid);
}

/**
 * Web Push работает только в реальном браузере (Chrome/Edge и т.п.)
 * В Capacitor (Android/iOS WebView) Notification может отсутствовать -> будет падение.
 */
function canUseWebPush(): boolean {
    if (Capacitor.isNativePlatform()) return false;
    if (typeof window === "undefined") return false;
    if (typeof Notification === "undefined") return false;
    if (!("serviceWorker" in navigator)) return false;
    return true;
}

/**
 * Динамический импорт, чтобы Capacitor/WebView не падал на старте
 * из-за firebase/messaging и Notification.
 */
async function loadMessaging() {
    return await import("firebase/messaging");
}

/**
 * Включает WEB push (только для браузера).
 * В Capacitor НЕ использовать.
 *
 * Вызывать только по user gesture (кнопка), иначе браузер может заблокировать permission.
 */
export async function enablePush(scope: PushScope): Promise<string> {
    const uid = auth.currentUser?.uid;
    if (!uid) throw new Error("Not authorized");

    // В нативке web push не поддерживаем вообще
    if (!canUseWebPush()) {
        // Важно: не падаем, а даём понятную ошибку
        throw new Error("Web push is not available in Capacitor. Use native push instead.");
    }

    const { getMessaging, getToken, isSupported, onMessage } = await loadMessaging();

    const ok = await isSupported();
    if (!ok) throw new Error("Web push is not supported in this browser");

    // Notification гарантированно существует из-за canUseWebPush()
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("Notifications permission not granted");

    // SW должен лежать в web/public/firebase-messaging-sw.js
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

    // Foreground handler (когда вкладка открыта).
    // Если вкладка скрыта — показываем системное уведомление (в браузере).
    if (!foregroundListenerInited) {
        foregroundListenerInited = true;

        onMessage(messaging, (payload) => {
            // safety: если вдруг среда изменилась
            if (typeof Notification === "undefined") return;

            try {
                const data: any = payload.data ?? {};
                const title = String(data.title ?? "Notification");
                const body = String(data.body ?? "");
                const link = String(data.link ?? "/");

                if (Notification.permission === "granted" && document.visibilityState !== "visible") {
                    const n = new Notification(title, { body });
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
