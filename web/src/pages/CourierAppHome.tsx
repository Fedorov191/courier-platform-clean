import { useMemo, useRef, useState } from "react";
import { auth, db } from "../lib/firebase";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { signOut } from "firebase/auth";
import { useNavigate } from "react-router-dom";
import { geohashForLocation } from "geofire-common";

export default function CourierAppHome() {
    const nav = useNavigate();
    const user = auth.currentUser;
    const watchId = useRef<number | null>(null);

    const courierRef = useMemo(() => {
        if (!user) return null;
        return doc(db, "couriers", user.uid);
    }, [user]);

    const [isOnline, setIsOnline] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    async function setOnline(next: boolean) {
        if (!courierRef || !user) return;
        setErr(null);

        if (!next && watchId.current !== null) {
            navigator.geolocation.clearWatch(watchId.current);
            watchId.current = null;
        }

        try {
            await setDoc(
                courierRef,
                {
                    isOnline: next,
                    lastSeenAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                },
                { merge: true }
            );

            setIsOnline(next);

            if (next) startTracking();
        } catch (e: any) {
            setErr(e?.message ?? "Failed to update status");
        }
    }

    function startTracking() {
        if (!courierRef) return;
        if (!navigator.geolocation) {
            setErr("Geolocation not supported");
            return;
        }

        watchId.current = navigator.geolocation.watchPosition(
            async (pos) => {
                const { latitude, longitude } = pos.coords;
                const geohash = geohashForLocation([latitude, longitude]);

                await setDoc(
                    courierRef,
                    {
                        lat: latitude,
                        lng: longitude,
                        geohash,
                        lastSeenAt: serverTimestamp(),
                        updatedAt: serverTimestamp(),
                    },
                    { merge: true }
                );
            },
            (error) => {
                setErr(error.message);
            },
            {
                enableHighAccuracy: true,
                maximumAge: 10_000,
                timeout: 10_000,
            }
        );
    }

    async function logout() {
        try {
            if (isOnline) await setOnline(false);
        } catch {}
        await signOut(auth);
        nav("/courier/login");
    }

    if (!user) {
        return <div style={{ padding: 16 }}>Not authorized</div>;
    }

    return (
        <div style={{ padding: 16, maxWidth: 520 }}>
            <h2>Courier App</h2>

            <div style={{ display: "flex", gap: 12, margin: "16px 0" }}>
        <span>
          Status:{" "}
            <b style={{ color: isOnline ? "green" : "gray" }}>
            {isOnline ? "ONLINE" : "OFFLINE"}
          </b>
        </span>

                <button onClick={() => setOnline(true)} disabled={isOnline}>
                    Go online
                </button>
                <button onClick={() => setOnline(false)} disabled={!isOnline}>
                    Go offline
                </button>

                <button onClick={logout} style={{ marginLeft: "auto" }}>
                    Logout
                </button>
            </div>

            {err && <p style={{ color: "crimson" }}>{err}</p>}

            <p style={{ marginTop: 12 }}>
                Геопозиция обновляется, пока приложение открыто.
            </p>
        </div>
    );
}
