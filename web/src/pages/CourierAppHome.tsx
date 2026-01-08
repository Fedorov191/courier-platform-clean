import { useEffect, useMemo, useRef, useState } from "react";
import { auth, db } from "../lib/firebase";
import {
    collection,
    doc,
    onSnapshot,
    query,
    runTransaction,
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

    // snapshot поля (чтобы курьер видел данные без чтения orders)
    customerName?: string;
    customerPhone?: string;
    customerAddress?: string;

    dropoffLat?: number;
    dropoffLng?: number;
    dropoffGeohash?: string;
    dropoffAddressText?: string;

    paymentType?: string;
    orderSubtotal?: number;
    deliveryFee?: number;
    orderTotal?: number;

    courierPaysAtPickup?: number;
    courierCollectsFromCustomer?: number;
    courierGetsFromRestaurantAtPickup?: number;
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
    const [activeOrder, setActiveOrder] = useState<any | null>(null);

    // --- ensure courier docs ---
    useEffect(() => {
        let cancelled = false;

        async function ensureDocs() {
            if (!user || !courierPrivateRef || !courierPublicRef) return;

            try {
                await setDoc(
                    courierPrivateRef,
                    { updatedAt: serverTimestamp() },
                    { merge: true }
                );

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

    // --- subscribe to pending offers ---
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

                        dropoffLat: data.dropoffLat,
                        dropoffLng: data.dropoffLng,
                        dropoffGeohash: data.dropoffGeohash,
                        dropoffAddressText: data.dropoffAddressText,

                        paymentType: data.paymentType,
                        orderSubtotal: data.orderSubtotal,
                        deliveryFee: data.deliveryFee,
                        orderTotal: data.orderTotal,

                        courierPaysAtPickup: data.courierPaysAtPickup,
                        courierCollectsFromCustomer: data.courierCollectsFromCustomer,
                        courierGetsFromRestaurantAtPickup: data.courierGetsFromRestaurantAtPickup,
                    };
                });

                setOffers(list);
            },
            (e: any) => setErr(e?.message ?? "Failed to load offers")
        );

        return () => unsub();
    }, [user]);

    // --- subscribe to active order (taken / picked_up) ---
    useEffect(() => {
        if (!user) return;

        const q = query(
            collection(db, "orders"),
            where("assignedCourierId", "==", user.uid),
            where("status", "in", ["taken", "picked_up"])
        );

        const unsub = onSnapshot(
            q,
            (snap) => {
                if (snap.empty) {
                    setActiveOrder(null);
                    return;
                }
                const d = snap.docs[0];
                setActiveOrder({ id: d.id, ...d.data() });
            },
            (e: any) => setErr(e?.message ?? "Failed to load active order")
        );

        return () => unsub();
    }, [user]);

    async function setOnline(next: boolean) {
        if (!user || !courierPrivateRef || !courierPublicRef) return;
        setErr(null);

        // stop tracking
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

    // ✅ Вариант A: первый, кто нажал Accept — забирает заказ
    async function acceptOffer(offer: Offer) {
        if (!auth.currentUser) return;

        const uid = auth.currentUser.uid;
        const offerRef = doc(db, "offers", offer.id);
        const orderRef = doc(db, "orders", offer.orderId);

        setErr(null);

        try {
            await runTransaction(db, async (tx) => {
                const orderSnap = await tx.get(orderRef);
                if (!orderSnap.exists()) throw new Error("Order not found");

                const orderData: any = orderSnap.data();

                // уже взял другой курьер
                if (orderData.assignedCourierId && orderData.assignedCourierId !== uid) {
                    tx.update(offerRef, { status: "declined", updatedAt: serverTimestamp() });
                    throw new Error("Order already taken by another courier");
                }

                // если свободен — назначаем себя
                if (!orderData.assignedCourierId) {
                    tx.update(orderRef, {
                        assignedCourierId: uid,
                        status: "taken",
                        acceptedAt: serverTimestamp(),
                        updatedAt: serverTimestamp(),
                    });
                }

                // помечаем offer accepted
                tx.update(offerRef, { status: "accepted", updatedAt: serverTimestamp() });
            });
        } catch (e: any) {
            setErr(e?.message ?? "Failed to accept offer");
        }
    }

    async function declineOffer(offerId: string) {
        await updateDoc(doc(db, "offers", offerId), {
            status: "declined",
            updatedAt: serverTimestamp(),
        });
    }
    async function markPickedUp(orderId: string) {
        await updateDoc(doc(db, "orders", orderId), {
            status: "picked_up",
            pickedUpAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
        });
    }

    async function markDelivered(orderId: string) {
        await updateDoc(doc(db, "orders", orderId), {
            status: "delivered",
            deliveredAt: serverTimestamp(),
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

            {activeOrder && (
                <div
                    style={{
                        border: "1px solid #333",
                        borderRadius: 10,
                        padding: 12,
                        marginBottom: 12,
                    }}
                >
                    <h3 style={{ marginTop: 0 }}>Active order</h3>
                    <div>
                        Order: <b>{activeOrder.id}</b>
                    </div>
                    <div>
                        Customer: <b>{activeOrder.customerName ?? "—"}</b>
                    </div>
                    <div>
                        Phone: <b>{activeOrder.customerPhone ?? "—"}</b>
                    </div>
                    <div>
                        Address:{" "}
                        <b>
                            {activeOrder.dropoffAddressText ??
                                activeOrder.customerAddress ??
                                "—"}
                        </b>
                    </div>
                    <div style={{ marginTop: 6, color: "#666" }}>
                        Total: <b>{activeOrder.orderTotal ?? "—"}</b> | Fee:{" "}
                        <b>{activeOrder.deliveryFee ?? "—"}</b> | Pay:{" "}
                        <b>{activeOrder.paymentType ?? "—"}</b>
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                        <button onClick={() => markPickedUp(activeOrder.id)}>
                            Picked up
                        </button>

                        <button onClick={() => markDelivered(activeOrder.id)}>
                            Delivered
                        </button>
                    </div>

                </div>

            )}

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
                            Address:{" "}
                            <b>{o.dropoffAddressText ?? o.customerAddress ?? "—"}</b>
                        </div>

                        <div style={{ marginTop: 6, color: "#666" }}>
                            Total: <b>{o.orderTotal ?? "—"}</b> | Fee:{" "}
                            <b>{o.deliveryFee ?? "—"}</b> | Pay: <b>{o.paymentType ?? "—"}</b>
                        </div>
                    </div>

                    <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                        <button onClick={() => acceptOffer(o)}>Accept</button>
                        <button onClick={() => declineOffer(o.id)}>Decline</button>
                    </div>
                </div>
            ))}
        </div>
    );
}
