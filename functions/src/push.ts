import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onDocumentCreated } from "firebase-functions/v2/firestore";

// всегда безопасно инициализируем тут (re-export может грузиться до index.ts)
if (!admin.apps.length) {
    admin.initializeApp();
}
const db = admin.firestore();

const APP_BASE_URL = "https://courier-platform-mvp.web.app";

type PushScope = "courier" | "restaurant";

function userDocRef(scope: PushScope, uid: string) {
    return db.collection(scope === "courier" ? "couriers" : "restaurants").doc(uid);
}

/**
 * ✅ Собираем токены из двух источников:
 * 1) legacy web: userDoc.pushTokens: string[]
 * 2) native Capacitor: userDoc/fcmTokens/{token} (docId == token)
 */
async function getPushTokens(scope: PushScope, uid: string): Promise<string[]> {
    if (!uid) return [];

    const ref = userDocRef(scope, uid);

    const [snap, fcmSnap] = await Promise.all([
        ref.get(),
        // ограничим, чтобы не улететь по стоимости если вдруг накопится мусор
        ref.collection("fcmTokens").limit(250).get().catch(() => null),
    ]);

    const fromArray: string[] = [];
    if (snap.exists) {
        const data: any = snap.data();
        const arr = Array.isArray(data?.pushTokens) ? data.pushTokens : [];
        for (const x of arr) {
            if (typeof x === "string" && x.length > 10) fromArray.push(x);
        }
    }

    const fromSub: string[] = [];
    if (fcmSnap) {
        for (const d of fcmSnap.docs) {
            const token = d.id; // у вас docId == token
            if (typeof token === "string" && token.length > 10) fromSub.push(token);
        }
    }

    return Array.from(new Set([...fromArray, ...fromSub]));
}

/**
 * ✅ Удаляем плохие токены и из массива pushTokens[], и из subcollection fcmTokens/{token}
 */
async function removeBadTokens(scope: PushScope, uid: string, bad: string[]) {
    if (!uid || bad.length === 0) return;

    const ref = userDocRef(scope, uid);

    // arrayRemove лучше делать чанками
    const chunkSize = 10;
    for (let i = 0; i < bad.length; i += chunkSize) {
        const part = bad.slice(i, i + chunkSize);

        // 1) чистим массив pushTokens[]
        const p1 = ref.set(
            {
                pushTokens: FieldValue.arrayRemove(...part),
                pushUpdatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
        );

        // 2) удаляем документы из fcmTokens/{token}
        const batch = db.batch();
        for (const t of part) {
            batch.delete(ref.collection("fcmTokens").doc(t));
        }
        const p2 = batch.commit().catch(() => null);

        await Promise.all([p1, p2]);
    }
}

type MessageWithoutTokens = Omit<admin.messaging.MulticastMessage, "tokens">;

async function sendPushToUser(scope: PushScope, uid: string, message: MessageWithoutTokens) {
    const tokens = await getPushTokens(scope, uid);
    if (tokens.length === 0) return;

    const resp = await admin.messaging().sendEachForMulticast({
        tokens,
        ...message,
    });

    const bad: string[] = [];
    resp.responses.forEach((r, idx) => {
        if (r.success) return;
        const code = (r.error as any)?.code ?? "";
        if (
            code === "messaging/registration-token-not-registered" ||
            code === "messaging/invalid-registration-token"
        ) {
            bad.push(tokens[idx]);
        }
    });

    if (bad.length > 0) {
        await removeBadTokens(scope, uid, bad);
    }
}

// ============================
// 1) PUSH: новый offer курьеру
// ============================
export const notifyOfferCreated = onDocumentCreated(
    { document: "offers/{offerId}", region: "europe-west1" },
    async (event) => {
        const offerId = event.params.offerId;
        const offer: any = event.data?.data();
        if (!offer) return;

        if (String(offer.status ?? "") !== "pending") return;

        const courierId = String(offer.courierId ?? "");
        if (!courierId) return;

        // ✅ пуш только если курьер online
        const cpSnap = await db.collection("courierPublic").doc(courierId).get();
        const cp: any = cpSnap.exists ? cpSnap.data() : null;
        if (!cp || cp.isOnline !== true) return;

        const orderId = String(offer.orderId ?? "");
        const code =
            String(offer.shortCode ?? "").trim() ||
            (orderId ? orderId.slice(0, 6).toUpperCase() : "ORDER");

        const feeNum = typeof offer.deliveryFee === "number" ? offer.deliveryFee : null;
        const feeTxt = feeNum !== null ? `₪${feeNum.toFixed(2)}` : "";

        const title = "New offer";
        const body = feeTxt ? `#${code} • Fee ${feeTxt}` : `#${code}`;

        // ✅ для нативки лучше относительный путь
        const link = "/courier/app";

        await sendPushToUser("courier", courierId, {
            // ✅ оставляем data (не ломаем web/SW логику)
            data: {
                type: "offer",
                title,
                body,
                link,
                offerId: String(offerId),
                orderId: String(orderId),
            },

            // ✅ Android: high + channel offers + sound offer
            android: {
                priority: "high",
                notification: {
                    title,
                    body,
                    channelId: "offers",
                    sound: "offer",
                },
            },

            // ✅ web может работать параллельно
            webpush: {
                fcmOptions: { link: `${APP_BASE_URL}/courier/app` },
            },
        });
    }
);

// =========================================
// 2) CHAT: meta update + PUSH второй стороне
// =========================================
export const notifyChatMessageCreated = onDocumentCreated(
    { document: "chats/{chatId}/messages/{msgId}", region: "europe-west1" },
    async (event) => {
        const chatId = event.params.chatId;
        const msg: any = event.data?.data();
        if (!chatId || !msg) return;

        const text = typeof msg.text === "string" ? msg.text : "";
        const senderId = typeof msg.senderId === "string" ? msg.senderId : "";
        const senderRole = typeof msg.senderRole === "string" ? msg.senderRole : "";

        const createdAt =
            msg.createdAt instanceof Timestamp ? (msg.createdAt as Timestamp) : Timestamp.now();

        // 1) ✅ обновляем chat meta (так как rules запрещают клиенту это писать)
        await db.collection("chats").doc(chatId).set(
            {
                lastMessageAt: createdAt,
                lastMessageText: text.slice(0, 200),
                lastMessageSenderId: senderId || null,
                lastMessageSenderRole: senderRole || null,
                updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
        );

        // 2) ✅ пуш другой стороне
        try {
            const chatSnap = await db.collection("chats").doc(chatId).get();
            if (!chatSnap.exists) return;

            const chat: any = chatSnap.data();
            const restaurantId = String(chat.restaurantId ?? "");
            const courierId = String(chat.courierId ?? "");
            const orderId = String(chat.orderId ?? "");

            const title = "New message";
            const body = text.slice(0, 120) || "Open chat";

            if (senderRole === "courier") {
                if (!restaurantId) return;
                const link = `${APP_BASE_URL}/restaurant/app/orders`;
                await sendPushToUser("restaurant", restaurantId, {
                    data: {
                        type: "chat",
                        title,
                        body,
                        link,
                        chatId: String(chatId),
                        orderId: String(orderId),
                    },
                });
            } else if (senderRole === "restaurant") {
                if (!courierId) return;
                const link = `${APP_BASE_URL}/courier/app`;
                await sendPushToUser("courier", courierId, {
                    data: {
                        type: "chat",
                        title,
                        body,
                        link,
                        chatId: String(chatId),
                        orderId: String(orderId),
                    },
                });
            }
        } catch (e: any) {
            logger.warn("notifyChatMessageCreated push failed", {
                chatId,
                error: e?.message ?? String(e),
            });
        }
    }
);
