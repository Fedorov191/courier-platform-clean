import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import {
    PushNotifications,
    type Token,
    type PushNotificationSchema,
    type ActionPerformed,
} from "@capacitor/push-notifications";
import { auth, db } from "../lib/firebase";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";

export type PushScope = "courier" | "restaurant";

let listenersInitialized = false;
let listenerHandles: PluginListenerHandle[] = [];

// куда сохраняем токен
function tokenDocRef(scope: PushScope, uid: string, token: string) {
    const col = scope === "courier" ? "couriers" : "restaurants";
    // subcollection fcmTokens/{token}
    return doc(db, col, uid, "fcmTokens", token);
}

function isNative() {
    return Capacitor.isNativePlatform();
}

/**
 * Вешаем слушатели один раз на всё приложение.
 * Они нужны, чтобы:
 * - в foreground обрабатывать пуш (можешь бипнуть/показать toast)
 * - при клике по пушу открыть нужный экран (link)
 */
export async function initNativePushListeners() {
    if (!isNative()) return;
    if (listenersInitialized) return;
    listenersInitialized = true;

    // 1) пришёл пуш в foreground
    const h1 = await PushNotifications.addListener(
        "pushNotificationReceived",
        (_: PushNotificationSchema) => {
            // Здесь можно сделать:
            // - звуковой сигнал (у тебя уже есть beep в UI),
            // - или показать in-app alert/toast.
            // Системное уведомление в foreground Android часто НЕ показывает автоматически.
            // Но это не критично для MVP.
            // console.log("Push received (foreground):", notification);
        }
    );

    // 2) клик по пушу
    const h2 = await PushNotifications.addListener(
        "pushNotificationActionPerformed",
        (action: ActionPerformed) => {
            const data: any = action?.notification?.data ?? {};
            const link = typeof data.link === "string" ? data.link : "";

            if (link) {
                // в WebView можно просто сменить location
                try {
                    window.location.href = link;
                } catch {}
            }
        }
    );

    listenerHandles.push(h1, h2);
}

/**
 * Получить FCM token + сохранить в Firestore.
 * Вызывать ТОЛЬКО по user gesture (кнопка "Go online").
 */
export async function enableNativePush(scope: PushScope): Promise<string> {
    if (!isNative()) throw new Error("Not a native build (Capacitor).");

    const uid = auth.currentUser?.uid;
    if (!uid) throw new Error("Not authorized");

    // 1) permissions
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive !== "granted") {
        perm = await PushNotifications.requestPermissions();
    }
    if (perm.receive !== "granted") {
        throw new Error("Notifications permission not granted");
    }

    // 2) получаем token через registration event
    const token = await new Promise<string>(async (resolve, reject) => {
        let hReg: PluginListenerHandle | null = null;
        let hErr: PluginListenerHandle | null = null;

        const timeoutId = window.setTimeout(() => {
            reject(new Error("FCM token timeout"));
        }, 15000);

        try {
            hReg = await PushNotifications.addListener("registration", (t: Token) => {
                window.clearTimeout(timeoutId);
                resolve(t.value);
            });

            hErr = await PushNotifications.addListener("registrationError", (err: any) => {
                window.clearTimeout(timeoutId);
                reject(new Error(err?.error ?? "FCM registration error"));
            });

            await PushNotifications.register();
        } catch (e: any) {
            window.clearTimeout(timeoutId);
            reject(e);
        } finally {
            // IMPORTANT: remove handles correctly (они async)
            try {
                if (hReg) await hReg.remove();
            } catch {}
            try {
                if (hErr) await hErr.remove();
            } catch {}
        }
    });

    if (!token) throw new Error("Failed to get FCM token");

    // 3) сохраняем токен в Firestore (subcollection)
    await setDoc(
        tokenDocRef(scope, uid, token),
        {
            token,
            platform: Capacitor.getPlatform(), // "android" | "ios"
            updatedAt: serverTimestamp(),
        },
        { merge: true }
    );

    // 4) listeners (один раз)
    await initNativePushListeners();

    return token;
}

/**
 * По желанию: снять слушатели (например при logout).
 * Не обязательно для MVP.
 */
export async function disposeNativePushListeners() {
    for (const h of listenerHandles) {
        try {
            await h.remove();
        } catch {}
    }
    listenerHandles = [];
    listenersInitialized = false;
}
