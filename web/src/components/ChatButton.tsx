import { useEffect, useRef, useState } from "react";
import { doc, onSnapshot, type Timestamp } from "firebase/firestore";
import { db } from "../lib/firebase";

type Role = "courier" | "restaurant";

let _audioCtx: AudioContext | null = null;

function getAudioCtx() {
    const A = window.AudioContext || (window as any).webkitAudioContext;
    if (!A) return null;
    if (!_audioCtx) _audioCtx = new A();
    return _audioCtx;
}

function primeAudio() {
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
}

function playBeep() {
    const ctx = getAudioCtx();
    if (!ctx) return;

    if (ctx.state === "suspended") {
        ctx.resume().catch(() => {});
        return;
    }

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = 0.05;

    osc.connect(gain);
    gain.connect(ctx.destination);

    const t0 = ctx.currentTime;
    osc.start(t0);
    osc.stop(t0 + 0.08);
}

function tsToMs(ts?: Timestamp) {
    // Firestore Timestamp has toMillis()
    // but если undefined/null — вернём 0
    // @ts-ignore
    return ts?.toMillis ? ts.toMillis() : 0;
}

export function ChatButton(props: {
    chatId: string;
    myUid: string;
    myRole: Role;
    isOpen: boolean;
    onToggle: () => void;
    disabled?: boolean;
}) {
    const { chatId, myUid, myRole, isOpen, onToggle, disabled } = props;

    const [hasUnread, setHasUnread] = useState(false);
    const lastBeepedAtRef = useRef<number>(0);

    useEffect(() => {
        if (!chatId) return;

        const chatRef = doc(db, "chats", chatId);

        const unsub = onSnapshot(
            chatRef,
            (snap) => {
                if (!snap.exists()) {
                    setHasUnread(false);
                    return;
                }

                const d: any = snap.data();

                const lastMessageAtMs = tsToMs(d.lastMessageAt);
                const lastSenderId = String(d.lastMessageSenderId ?? "");

                const myReadAtMs =
                    myRole === "courier"
                        ? tsToMs(d.courierLastReadAt)
                        : tsToMs(d.restaurantLastReadAt);

                const unread =
                    !!lastMessageAtMs &&
                    !!lastSenderId &&
                    lastSenderId !== myUid &&
                    lastMessageAtMs > (myReadAtMs || 0);

                setHasUnread(unread);

                // beep только если:
                // - чат закрыт
                // - действительно новый lastMessageAt (не тот же самый)
                // - есть unread
                if (!isOpen && unread && lastMessageAtMs > lastBeepedAtRef.current) {
                    playBeep();
                    lastBeepedAtRef.current = lastMessageAtMs;
                }

                // если чат открыт — не бипаем вообще
                if (isOpen) {
                    lastBeepedAtRef.current = lastMessageAtMs;
                }
            },
            () => {
                setHasUnread(false);
            }
        );

        return () => unsub();
    }, [chatId, myUid, myRole, isOpen]);

    return (
        <button
            className="btn btn--ghost"
            onClick={() => {
                primeAudio(); // ✅ user gesture → после этого звук работает
                onToggle();
            }}
            disabled={disabled}
            style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
        >
            {isOpen ? "Hide chat" : "Chat"}
            {!isOpen && hasUnread && <span className="pill pill--danger">NEW</span>}
        </button>
    );
}
