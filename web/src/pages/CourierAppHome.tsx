import { useEffect, useMemo, useRef, useState } from "react";
import { auth, db } from "../lib/firebase";
import {
    collection,
    doc,
    onSnapshot,
    query,
    serverTimestamp,
    setDoc,
    updateDoc,
    where,
} from "firebase/firestore";
import { signOut } from "firebase/auth";
import { useNavigate } from "react-router-dom";
import { geohashForLocation } from "geofire-common";

type Offer = {
    id: string;
    orderId: string;
    restaurantId: string;
    status: "pending" | "accepted" | "declined";
};

export default function CourierAppHome() {
    const nav = useNavigate();
    const user = auth.currentUser;

    const watchId = useRef<number | null>(null);

    const courierPrivateRef = useMemo(() => {
        if (!user) return null;
        return doc(db, "couriers", user.uid);
    }, [user]);

    const courierPublicRef = useMemo(() => {
        if (!user) return null;
        return doc(db, "courierPublic", user.uid);
    }, [user]);

    const [isOnline, setIsOnline] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const [offers, setOffers] = useState<Offer[]>([]);

    // --- ensure courier docs ---
    useEffect(() => {
        if (!user || !courierPrivateRef || !courierPublicRef) return;

        setDoc(courierPrivateRef, { updatedAt: serverTimestamp() }, { merge: true });
        setDoc(
            courierPublicRef,
            { courierId: user.uid, updatedAt: serverTimestamp() },
            { merge: true }
        );
    }, [user, courierPrivateRef, courierPublicRef]);

    // --- subscribe to OFFERS ---
    useEffect(() => {
        if (!user) return;

        const q = query(
            collection(db, "offers"),
            where("courierId", "==", user.uid),
            where("status", "==", "pending")
        );

        const unsub = onSnapshot(q, (snap) => {
            const list: Offer[] = snap.docs.map((d) => ({
                id: d.id,
                orderId: d.data().orderId,
                restaurantId: d.data().restaurantId,
                status: d.data().status,
            }));
            setOffers(list);
        });

        return () => unsub();
    }, [user]);

    async function setOnline(next: boolean) {
        if (!user || !courierPrivateRef || !courierPublicRef) return;
        setErr(null);

        if (!next && watchId.current !== null) {
            navigator.geolocation.clearWatch(watchId.current);
            watchId.current = null;
        }

        try {
            await setDoc(
                courierPrivateRef,
                {
                    isOnline: next,
                    lastSeenAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                },
                { merge: true }
            );

            await setDoc(
                courierPublicRef,
                {
                    courierId: user.uid,
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
        if (!courierPublicRef || !navigator.geolocation) return;

        watchId.current = navigator.geolocation.watchPosition(async (pos) => {
            const { latitude, longitude } = pos.coords;
            const geohash = geohashForLocation([latitude, longitude]);

            await setDoc(
                courierPublicRef,
                {
                    lat: latitude,
                    lng: longitude,
                    geohash,
                    lastSeenAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                },
                { merge: true }
            );
        });
    }

    async function acceptOffer(offer: Offer) {
        await updateDoc(doc(db, "offers", offer.id), {
            status: "accepted",
            updatedAt: serverTimestamp(),
        });
    }

    async function declineOffer(offer: Offer) {
        await updateDoc(doc(db, "offers", offer.id), {
            status: "declined",
            updatedAt: serverTimestamp(),
        });
    }

    async function logout() {
        try {
            if (isOnline) await setOnline(false);
        } catch {}
        await signOut(auth);
        nav("/courier/login");
    }

    if (!user) return <div style={{ padding: 16 }}>Not authorized</div>;

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

            <hr />

            <h3>New offers</h3>

            {offers.length === 0 && (
                <p style={{ color: "#888" }}>Нет новых заказов</p>
            )}

            {offers.map((o) => (
                <div
                    key={o.id}
                    style={{
                        border: "1px solid #333",
                        borderRadius: 10,
                        padding: 12,
                        marginBottom: 10,
                    }}
                >
                    <div>Order: <b>{o.orderId}</b></div>

                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                        <button onClick={() => acceptOffer(o)}>
                            Accept
                        </button>
                        <button onClick={() => declineOffer(o)}>
                            Decline
                        </button>
                    </div>
                </div>
            ))}
        </div>
    );
}
