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

async function getPushTokens(scope: PushScope, uid: string): Promise<string[]> {
    if (!uid) return [];
    const snap = await userDocRef(scope, uid).get();
    if (!snap.exists) return [];

    const data: any = snap.data();
    const arr = Array.isArray(data?.pushTokens) ? data.pushTokens : [];
    const tokens = arr.filter((x: any) => typeof x === "string" && x.length > 10);
    return Array.from(new Set(tokens));
}

async function removeBadTokens(scope: PushScope, uid: string, bad: string[]) {
    if (!uid || bad.length === 0) return;

    const ref = userDocRef(scope, uid);

    // arrayRemove лучше делать чанками
    const chunkSize = 10;
    for (let i = 0; i < bad.length; i += chunkSize) {
        const part = bad.slice(i, i + chunkSize);
        await ref.set(
            {
                pushTokens: FieldValue.arrayRemove(...part),
                pushUpdatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
        );
    }
}

async function sendPushToUser(scope: PushScope, uid: string, data: Record<string, string>) {
    const tokens = await getPushTokens(scope, uid);
    if (tokens.length === 0) return;

    const resp = await admin.messaging().sendEachForMulticast({
        tokens,
        // ВАЖНО: только data, без notification (тогда SW стабильно обработает)
        data,
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

        // ✅ пуш только если курьер online (как ты просила)
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
        const link = `${APP_BASE_URL}/courier/app`;

        await sendPushToUser("courier", courierId, {
            type: "offer",
            title,
            body,
            link,
            offerId: String(offerId),
            orderId: String(orderId),
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
                    type: "chat",
                    title,
                    body,
                    link,
                    chatId: String(chatId),
                    orderId: String(orderId),
                });
            } else if (senderRole === "restaurant") {
                if (!courierId) return;
                const link = `${APP_BASE_URL}/courier/app`;
                await sendPushToUser("courier", courierId, {
                    type: "chat",
                    title,
                    body,
                    link,
                    chatId: String(chatId),
                    orderId: String(orderId),
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
