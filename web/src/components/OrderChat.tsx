import { useEffect, useMemo, useRef, useState } from "react";
import { auth, db } from "../lib/firebase";
import {
    addDoc,
    collection,
    doc,
    limit,
    onSnapshot,
    orderBy,
    query,
    serverTimestamp,
    setDoc,
    updateDoc,
} from "firebase/firestore";

type Role = "courier" | "restaurant";

type MessageDoc = {
    id: string;
    text: string;
    senderId: string;
    senderRole: Role;
    createdAt?: any; // Firestore Timestamp
};

type Props = {
    chatId: string;
    orderId: string;
    restaurantId: string;
    courierId: string;
    myRole: Role;
    disabled?: boolean;
};

export function OrderChat({
                              chatId,
                              orderId,
                              restaurantId,
                              courierId,
                              myRole,
                              disabled,
                          }: Props) {
    const user = auth.currentUser;

    const chatRef = useMemo(() => doc(db, "chats", chatId), [chatId]);
    const messagesCol = useMemo(() => collection(db, "chats", chatId, "messages"), [chatId]);

    const [messages, setMessages] = useState<MessageDoc[]>([]);
    const [text, setText] = useState("");
    const [sending, setSending] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    // чтобы не спамить lastReadAt на каждый снапшот
    const lastMarkedReadMsgIdRef = useRef<string | null>(null);

    const readField = myRole === "courier" ? "lastReadAtCourier" : "lastReadAtRestaurant";

    // 1) ensure chat doc exists (и содержит orderId/restaurantId/courierId)
    useEffect(() => {
        let cancelled = false;

        async function ensureChat() {
            if (!user) return;

            try {
                await setDoc(
                    chatRef,
                    {
                        orderId,
                        restaurantId,
                        courierId,
                        updatedAt: serverTimestamp(),

                        // мета (может быть null у старых чатов — ок)
                        lastMessageAt: null,
                        lastMessageSenderId: null,
                        lastReadAtCourier: null,
                        lastReadAtRestaurant: null,
                    },
                    { merge: true }
                );
            } catch (e: any) {
                if (!cancelled) setErr(e?.message ?? "Failed to init chat");
            }
        }

        ensureChat();
        return () => {
            cancelled = true;
        };
    }, [user, chatRef, orderId, restaurantId, courierId]);

    // 2) subscribe to messages
    useEffect(() => {
        if (!user) return;

        const q = query(messagesCol, orderBy("createdAt", "asc"), limit(200));

        const unsub = onSnapshot(
            q,
            (snap) => {
                const list: MessageDoc[] = snap.docs.map((d) => {
                    const data: any = d.data();
                    return {
                        id: d.id,
                        text: String(data.text ?? ""),
                        senderId: String(data.senderId ?? ""),
                        senderRole: (data.senderRole ?? "courier") as Role,
                        createdAt: data.createdAt,
                    };
                });
                setMessages(list);
            },
            (e: any) => setErr(e?.message ?? "Failed to load messages")
        );

        return () => unsub();
    }, [user, messagesCol]);

    // 3) mark as read when chat is open and last message is from the other side
    useEffect(() => {
        if (!user) return;
        if (messages.length === 0) return;

        const last = messages[messages.length - 1];
        if (!last) return;

        // если последнее сообщение моё — ничего не делаем
        if (last.senderId === user.uid) return;

        // анти-спам: если мы уже отмечали "прочитано" именно для этого msgId
        if (lastMarkedReadMsgIdRef.current === last.id) return;
        lastMarkedReadMsgIdRef.current = last.id;

        updateDoc(chatRef, {
            [readField]: serverTimestamp(),
            updatedAt: serverTimestamp(),
        }).catch(() => {});
    }, [messages, user, chatRef, readField]);

    async function send() {
        if (!user) return;
        if (disabled) return;

        const t = text.trim();
        if (!t) return;

        setErr(null);
        setSending(true);

        try {
            // messages правила: строго эти 4 поля
            await addDoc(messagesCol, {
                text: t,
                senderId: user.uid,
                senderRole: myRole,
                createdAt: serverTimestamp(),
            });

            // мета чата (для unread + звука)
            await updateDoc(chatRef, {
                lastMessageAt: serverTimestamp(),
                lastMessageSenderId: user.uid,
                updatedAt: serverTimestamp(),

                // отправитель точно прочитал своё сообщение
                [readField]: serverTimestamp(),
            });

            setText("");
        } catch (e: any) {
            setErr(e?.message ?? "Failed to send message");
        } finally {
            setSending(false);
        }
    }

    return (
        <div className="subcard" style={{ marginTop: 10 }}>
            <div className="row row--between row--wrap" style={{ alignItems: "baseline" }}>
                <b>Chat</b>
                <span className="muted" style={{ fontSize: 12 }}>
          {myRole.toUpperCase()}
        </span>
            </div>

            <div className="hr" />

            {err && <div className="alert alert--danger">{err}</div>}

            <div
                style={{
                    maxHeight: 220,
                    overflow: "auto",
                    display: "grid",
                    gap: 8,
                    padding: 6,
                }}
            >
                {messages.length === 0 && <div className="muted">No messages yet.</div>}

                {messages.map((m) => {
                    const mine = user && m.senderId === user.uid;

                    return (
                        <div
                            key={m.id}
                            style={{
                                justifySelf: mine ? "end" : "start",
                                maxWidth: "85%",
                                padding: "8px 10px",
                                borderRadius: 10,
                                border: "1px solid #333",
                                background: mine ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.15)",
                            }}
                        >
                            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 4 }}>
                                {mine ? "You" : m.senderRole}
                            </div>
                            <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
                        </div>
                    );
                })}
            </div>

            <div style={{ height: 10 }} />

            <div className="row row--wrap row--mobile-stack">
                <input
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={disabled ? "Chat disabled" : "Type a message…"}
                    disabled={!!disabled || sending}
                    style={{
                        flex: 1,
                        minWidth: 220,
                        padding: 10,
                        borderRadius: 10,
                        border: "1px solid #333",
                        outline: "none",
                    }}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            send();
                        }
                    }}
                />

                <button className="btn btn--primary" onClick={send} disabled={!!disabled || sending}>
                    {sending ? "Sending…" : "Send"}
                </button>
            </div>
        </div>
    );
}
