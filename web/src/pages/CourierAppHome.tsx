import { useEffect, useMemo, useState } from "react";
import { auth, db } from "../lib/firebase";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { signOut } from "firebase/auth";
import { useNavigate } from "react-router-dom";

export default function CourierAppHome() {
    const nav = useNavigate();
    const user = auth.currentUser;

    const courierRef = useMemo(() => {
        if (!user) return null;
        return doc(db, "couriers", user.uid);
    }, [user]);

    const [isOnline, setIsOnline] = useState(false);
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    async function setOnline(next: boolean) {
        if (!courierRef || !user) return;
        setErr(null);
        setSaving(true);
        try {
            await setDoc(
                courierRef,
                {
                    updatedAt: serverTimestamp(),
                    lastSeenAt: serverTimestamp(),
                    isOnline: next,
                    status: "active", // на всякий, если нет
                },
                { merge: true }
            );
            setIsOnline(next);
        } catch (e: any) {
            setErr(e?.message ?? "Failed to update status");
        } finally {
            setSaving(false);
        }
    }

    // Пока курьер online — обновляем lastSeenAt каждые 20 секунд
    useEffect(() => {
        if (!isOnline) return;
        if (!courierRef) return;

        const id = setInterval(async () => {
            try {
                await setDoc(
                    courierRef,
                    { lastSeenAt: serverTimestamp(), updatedAt: serverTimestamp() },
                    { merge: true }
                );
            } catch {
                // молча: это только heartbeat
            }
        }, 20_000);

        return () => clearInterval(id);
    }, [isOnline, courierRef]);

    async function logout() {
        // При выходе выключаем online, чтобы не “висел” онлайн
        if (isOnline) {
            try {
                await setOnline(false);
            } catch {}
        }
        await signOut(auth);
        nav("/courier/login");
    }

    if (!user) {
        return (
            <div style={{ padding: 16 }}>
                <h2>Courier App</h2>
                <p>Not authorized</p>
            </div>
        );
    }

    return (
        <div style={{ padding: 16, maxWidth: 520 }}>
            <h2>Courier App</h2>

            <div style={{ display: "flex", gap: 12, alignItems: "center", margin: "16px 0" }}>
        <span>
          Status:{" "}
            <b style={{ color: isOnline ? "green" : "gray" }}>
            {isOnline ? "ONLINE" : "OFFLINE"}
          </b>
        </span>

                <button onClick={() => setOnline(true)} disabled={saving || isOnline}>
                    Go online
                </button>
                <button onClick={() => setOnline(false)} disabled={saving || !isOnline}>
                    Go offline
                </button>

                <button onClick={logout} style={{ marginLeft: "auto" }}>
                    Logout
                </button>
            </div>

            {err && <p style={{ color: "crimson" }}>{err}</p>}

            <p style={{ marginTop: 12 }}>
                Следующий шаг: добавим геопозицию (lat/lng/geohash) и затем offers.
            </p>
        </div>
    );
}
