import { useEffect, useMemo, useState } from "react";
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
    Timestamp,
} from "firebase/firestore";

type Role = "courier" | "restaurant";

type Props = {
    chatId: string;
    orderId: string;
    restaurantId: string;
    courierId: string;
    myRole: Role;
    disabled?: boolean;
};

type Msg = {
    id: string;
    text: string;
    senderId: string;
    senderRole: Role;
    createdAt?: Timestamp | null;
};

function fmt(ts?: Timestamp | null) {
    if (!ts) return "";
    return ts.toDate().toLocaleString();
}

export function OrderChat(props: Props) {
    const { chatId, orderId, restaurantId, courierId, myRole, disabled } = props;

    const me = auth.currentUser?.uid ?? null;

    const [text, setText] = useState("");
    const [sending, setSending] = useState(false);
    const [err, setErr] = useState<string>("");
    const [messages, setMessages] = useState<Msg[]>([]);
    const [chatReady, setChatReady] = useState(false);

    const chatRef = useMemo(() => doc(db, "chats", chatId), [chatId]);
    const msgsCol = useMemo(() => collection(db, "chats", chatId, "messages"), [chatId]);

    // 1) ENSURE chat doc exists FIRST (иначе messages listener может упасть с PERMISSION_DENIED)
    useEffect(() => {
        let cancelled = false;

        async function ensureChat() {
            setErr("");
            setChatReady(false);

            if (!me) return;

            try {
                await setDoc(
                    chatRef,
                    {
                        orderId,
                        restaurantId,
                        courierId,
                        updatedAt: serverTimestamp(),
                        createdAt: serverTimestamp(),

                        ...(myRole === "restaurant"
                            ? { lastReadAtRestaurant: serverTimestamp() }
                            : {
                                lastReadAtCourier: serverTimestamp(),
                                // совместимость, если где-то оставалось старое поле
                                courierLastReadAt: serverTimestamp(),
                            }),
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
    }, [chatRef, me, orderId, restaurantId, courierId, myRole]);

    // 2) realtime messages (только когда chatReady = true)
    useEffect(() => {
        if (!chatReady) return;

        setErr("");

        const q = query(msgsCol, orderBy("createdAt", "asc"), limit(200));

        const unsub = onSnapshot(
            q,
            (snap) => {
                const list: Msg[] = snap.docs.map((d) => {
                    const data: any = d.data();
                    return {
                        id: d.id,
                        text: String(data.text ?? ""),
                        senderId: String(data.senderId ?? ""),
                        senderRole: (data.senderRole ?? "courier") as Role,
                        createdAt: data.createdAt ?? null,
                    };
                });
                setMessages(list);
            },
            (e) => setErr(e?.message ?? "Chat load error")
        );

        return () => unsub();
    }, [chatReady, msgsCol]);

    async function send() {
        if (disabled) return;
        if (!me) {
            setErr("Not authorized");
            return;
        }

        const t = text.trim();
        if (!t) return;

        setSending(true);
        setErr("");

        try {
            // (на всякий) ensure chat doc
            await setDoc(
                chatRef,
                {
                    orderId,
                    restaurantId,
                    courierId,
                    updatedAt: serverTimestamp(),
                    createdAt: serverTimestamp(),
                },
                { merge: true }
            );

            // add message
            await addDoc(msgsCol, {
                text: t,
                senderId: me,
                senderRole: myRole,
                createdAt: serverTimestamp(),
            });

            // update chat meta => для badges/beeps
            await setDoc(
                chatRef,
                {
                    lastMessageAt: serverTimestamp(),
                    lastMessageSenderId: me,
                    lastMessageSenderRole: myRole,
                    updatedAt: serverTimestamp(),

                    ...(myRole === "restaurant"
                        ? { lastReadAtRestaurant: serverTimestamp() }
                        : {
                            lastReadAtCourier: serverTimestamp(),
                            courierLastReadAt: serverTimestamp(),
                        }),
                },
                { merge: true }
            );

            setText("");
        } catch (e: any) {
            setErr(e?.message ?? "Failed to send message");
        } finally {
            setSending(false);
        }
    }

    return (
        <div className="subcard" style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>Chat</div>

            {err && (
                <div className="alert alert--danger" style={{ marginBottom: 10 }}>
                    {err}
                </div>
            )}

            <div className="stack" style={{ gap: 8 }}>
                {messages.length === 0 && <div className="muted">No messages yet.</div>}

                {messages.map((m) => (
                    <div key={m.id} className="subcard">
                        <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                            {m.senderRole} · {fmt(m.createdAt)}
                        </div>
                        <div>{m.text}</div>
                    </div>
                ))}
            </div>

            <div style={{ height: 10 }} />

            <div className="row row--wrap row--mobile-stack">
                <input
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="Type message..."
                    disabled={disabled || sending}
                    style={{ flex: 1, minWidth: 240 }}
                />

                <button className="btn btn--primary" onClick={send} disabled={disabled || sending || !text.trim()}>
                    {sending ? "Sending..." : "Send"}
                </button>
            </div>

            <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                Sound/NEW badge works when the other side sends a message and chat is closed.
            </div>
        </div>
    );
}
