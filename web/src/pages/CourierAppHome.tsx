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
    courierId: string;
    status: string;

    customerName?: string;
    customerPhone?: string;
    customerAddress?: string;

    paymentType?: string;
    orderSubtotal?: number;
    deliveryFee?: number;
    orderTotal?: number;

    dropoffAddressText?: string;
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

    // гарантируем документы курьера
    useEffect(() => {
        let cancelled = false;

        async function ensureDocs() {
            if (!user || !courierPrivateRef || !courierPublicRef) return;

            try {
                await setDoc(courierPrivateRef, { updatedAt: serverTimestamp() }, { merge: true });

                await setDoc(
                    courierPublicRef,
                    { courierId: user.uid, updatedAt: serverTimestamp() },
                    { merge: true }
                );
            } catch (e: any) {
                if (!cancelled) setErr(e?.message ?? "Failed to init courier docs");
            }
        }

        ensureDocs();
        return () => {
            cancelled = true;
        };
    }, [user, courierPrivateRef, courierPublicRef]);

    // подписка на offers (pending)
    useEffect(() => {
        if (!user) return;

        const q = query(
            collection(db, "offers"),
            where("courierId", "==", user.uid),
            where("status", "==", "pending")
        );

        const unsub = onSnapshot(
            q,
            (snap) => {
                const list: Offer[] = snap.docs.map((d) => {
                    const data: any = d.data();
                    return {
                        id: d.id,
                        orderId: String(data.orderId ?? ""),
                        restaurantId: String(data.restaurantId ?? ""),
                        courierId: String(data.courierId ?? ""),
                        status: String(data.status ?? "pending"),

                        customerName: data.customerName,
                        customerPhone: data.customerPhone,
                        customerAddress: data.customerAddress,

                        paymentType: data.paymentType,
                        orderSubtotal: data.orderSubtotal,
                        deliveryFee: data.deliveryFee,
                        orderTotal: data.orderTotal,

                        dropoffAddressText: data.dropoffAddressText,
                    };
                });
                setOffers(list);
            },
            (e: any) => setErr(e?.message ?? "Failed to load offers")
        );

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
        if (!courierPublicRef) return;
        if (!navigator.geolocation) {
            setErr("Geolocation not supported");
            return;
        }

        watchId.current = navigator.geolocation.watchPosition(
            async (pos) => {
                try {
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
                } catch (e: any) {
                    setErr(e?.message ?? "Failed to update location");
                }
            },
            (error) => setErr(error.message),
            { enableHighAccuracy: true, maximumAge: 10_000, timeout: 10_000 }
        );
    }

    async function acceptOffer(offerId: string) {
        await updateDoc(doc(db, "offers", offerId), {
            status: "accepted",
            updatedAt: serverTimestamp(),
        });
    }

    async function declineOffer(offerId: string) {
        await updateDoc(doc(db, "offers", offerId), {
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

            {offers.length === 0 && <p style={{ color: "#888" }}>Нет новых заказов</p>}

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
                    <div>
                        Order: <b>{o.orderId}</b>
                    </div>

                    <div style={{ marginTop: 8, fontSize: 13 }}>
                        <div>
                            Customer: <b>{o.customerName ?? "—"}</b>
                        </div>
                        <div>
                            Phone: <b>{o.customerPhone ?? "—"}</b>
                        </div>
                        <div>
                            Address: <b>{o.dropoffAddressText ?? o.customerAddress ?? "—"}</b>
                        </div>
                        <div style={{ marginTop: 6, color: "#666" }}>
                            Total: <b>{o.orderTotal ?? "—"}</b> | Fee: <b>{o.deliveryFee ?? "—"}</b> | Pay:{" "}
                            <b>{o.paymentType ?? "—"}</b>
                        </div>
                    </div>

                    <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                        <button onClick={() => acceptOffer(o.id)}>Accept</button>
                        <button onClick={() => declineOffer(o.id)}>Decline</button>
                    </div>
                </div>
            ))}
        </div>
    );
}
