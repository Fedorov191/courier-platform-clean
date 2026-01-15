import { useEffect, useMemo, useRef, useState } from "react";
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
    Timestamp,
} from "firebase/firestore";
import { auth, db } from "../lib/firebase";

type Role = "courier" | "restaurant";

type ChatMessage = {
    id: string;
    text: string;
    senderId: string;
    senderRole: Role;
    createdAt?: Timestamp;
};

function formatTime(ts?: Timestamp) {
    if (!ts) return "";
    try {
        return ts.toDate().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
        return "";
    }
}

export function OrderChat(props: {
    chatId: string;
    orderId: string;
    restaurantId: string;
    courierId: string;
    myRole: Role;
    disabled?: boolean;
}) {
    const { chatId, orderId, restaurantId, courierId, myRole, disabled } = props;

    const me = auth.currentUser;

    const [chatReady, setChatReady] = useState(false);

    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [text, setText] = useState("");
    const [sending, setSending] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const bottomRef = useRef<HTMLDivElement | null>(null);

    const canUse = useMemo(() => {
        if (!me) return false;
        if (disabled) return false;
        if (!chatReady) return false;
        return true;
    }, [me, disabled, chatReady]);

    // 1) Ensure chat doc exists
    useEffect(() => {
        let cancelled = false;

        async function ensureChat() {
            if (!me) return;
            if (!chatId) return;

            // каждый раз при смене chatId заново “готовим” чат
            setChatReady(false);
            setErr(null);

            try {
                await setDoc(
                    doc(db, "chats", chatId),
                    {
                        chatId,
                        orderId,
                        restaurantId,
                        courierId,
                        createdAt: serverTimestamp(),
                        updatedAt: serverTimestamp(),
                    },
                    { merge: true }
                );

                if (!cancelled) setChatReady(true);
            } catch (e: any) {
                if (!cancelled) {
                    setErr(e?.message ?? "Failed to init chat");
                    setChatReady(false);
                }
            }
        }

        ensureChat();
        return () => {
            cancelled = true;
        };
    }, [chatId, orderId, restaurantId, courierId, me]);

    // 2) Subscribe to messages (ТОЛЬКО когда chatReady = true)
    useEffect(() => {
        if (!me) return;
        if (!chatId) return;
        if (!chatReady) return;

        const q = query(
            collection(db, "chats", chatId, "messages"),
            orderBy("createdAt", "asc"),
            limit(60)
        );

        const unsub = onSnapshot(
            q,
            (snap) => {
                const list: ChatMessage[] = snap.docs.map((d) => {
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

                // scroll down
                setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 0);
            },
            (e: any) => setErr(e?.message ?? "Failed to load chat")
        );

        return () => unsub();
    }, [chatId, me, chatReady]);

    async function send() {
        if (!me) return;
        if (!chatId) return;

        if (!chatReady) {
            setErr("Chat is initializing… try again in a second.");
            return;
        }

        if (disabled) return;

        const t = text.trim();
        if (!t) return;

        setErr(null);
        setSending(true);

        try {
            await addDoc(collection(db, "chats", chatId, "messages"), {
                text: t,
                senderId: me.uid,
                senderRole: myRole,
                createdAt: serverTimestamp(),
            });

            // meta update (удобно для будущего списка чатов)
            await setDoc(
                doc(db, "chats", chatId),
                {
                    lastMessageText: t,
                    lastMessageAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                },
                { merge: true }
            );

            setText("");
        } catch (e: any) {
            setErr(e?.message ?? "Failed to send");
        } finally {
            setSending(false);
        }
    }

    if (!me) return null;

    return (
        <div className="subcard" style={{ marginTop: 12 }}>
            <div className="row row--between row--wrap">
                <div style={{ fontWeight: 900 }}>Chat</div>

                {!chatReady && (
                    <span className="pill pill--muted" style={{ fontSize: 12 }}>
            initializing…
          </span>
                )}

                {!canUse && chatReady && (
                    <span className="pill pill--muted" style={{ fontSize: 12 }}>
            read-only
          </span>
                )}
            </div>

            <div style={{ height: 8 }} />

            <div
                style={{
                    border: "1px solid #333",
                    borderRadius: 12,
                    padding: 10,
                    maxHeight: 180,
                    overflow: "auto",
                }}
            >
                {messages.length === 0 ? (
                    <div className="muted" style={{ fontSize: 13 }}>
                        No messages yet
                    </div>
                ) : (
                    <div style={{ display: "grid", gap: 8 }}>
                        {messages.map((m) => {
                            const mine = m.senderId === me.uid;
                            const who = m.senderRole === "restaurant" ? "Restaurant" : "Courier";

                            return (
                                <div
                                    key={m.id}
                                    style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start" }}
                                >
                                    <div
                                        style={{
                                            maxWidth: "85%",
                                            border: "1px solid #333",
                                            borderRadius: 12,
                                            padding: "8px 10px",
                                            fontSize: 13,
                                            lineHeight: 1.25,
                                        }}
                                    >
                                        <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 4 }}>
                                            {mine ? "You" : who} {m.createdAt ? `· ${formatTime(m.createdAt)}` : ""}
                                        </div>
                                        <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
                                    </div>
                                </div>
                            );
                        })}
                        <div ref={bottomRef} />
                    </div>
                )}
            </div>

            <div style={{ height: 10 }} />

            <div className="row row--wrap row--mobile-stack">
                <input
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={canUse ? "Type a message…" : !chatReady ? "Chat initializing…" : "Chat disabled"}
                    disabled={!canUse || sending}
                    style={{
                        flex: 1,
                        minWidth: 220,
                        padding: 10,
                        borderRadius: 10,
                        border: "1px solid #333",
                        outline: "none",
                    }}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            send();
                        }
                    }}
                />

                <button className="btn btn--primary" onClick={send} disabled={!canUse || sending || text.trim().length === 0}>
                    {sending ? "Sending…" : "Send"}
                </button>
            </div>

            {err && (
                <div className="alert alert--danger" style={{ marginTop: 10 }}>
                    {err}
                </div>
            )}
        </div>
    );
}
