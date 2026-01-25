import * as admin from "firebase-admin";
import { onDocumentCreated } from "firebase-functions/v2/firestore";

admin.initializeApp();

export const onChatMessageCreate = onDocumentCreated(
    "chats/{chatId}/messages/{msgId}",
    async (event) => {
        const chatId = event.params.chatId;
        const snap = event.data;
        if (!snap) return;

        const msg: any = snap.data();

        const senderId = String(msg?.senderId ?? "");
        const senderRole = String(msg?.senderRole ?? "");
        const text = String(msg?.text ?? msg?.message ?? "");

        // createdAt обычно уже Timestamp (serverTimestamp resolved)
        const createdAt = msg?.createdAt ?? admin.firestore.FieldValue.serverTimestamp();

        await admin.firestore().doc(`chats/${chatId}`).set(
            {
                lastMessageAt: createdAt,
                lastMessageSenderId: senderId,
                lastMessageSenderRole: senderRole,
                lastMessageText: text.slice(0, 300),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
        );
    }
);
