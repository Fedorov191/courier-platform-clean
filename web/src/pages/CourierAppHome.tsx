import { useEffect, useRef, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import {
    collection,
    doc,
    onSnapshot,
    query,
    serverTimestamp,
    setDoc,
    updateDoc,
    where,
    runTransaction,
    Timestamp,
} from "firebase/firestore";
import { auth, db } from "../lib/firebase";

type OfferStatus = "pending" | "accepted" | "declined" | "expired";

type OfferDoc = {
    id: string;
    orderId: string;
    restaurantId: string;
    courierId: string;
    status: OfferStatus;
    createdAt?: Timestamp;
    expiresAtMs?: number;

    dropoffAddressText: string;
    dropoffLat: number;
    dropoffLng: number;

    paymentType: "cash" | "card";
    orderSubtotal: number;
    deliveryFee: number;
    orderTotal: number;

    courierPaysAtPickup: number;
    courierCollectsFromCustomer: number;
    courierGetsFromRestaurantAtPickup: number;

    customerName: string;
    customerPhone: string;
    notes: string;
};

function money(n: number) {
    const x = Number.isFinite(n) ? n : 0;
    return `₪${x.toFixed(2)}`;
}

function wazeUrl(lat: number, lng: number) {
    return `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
}

function googleUrl(lat: number, lng: number) {
    return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

export default function CourierAppHome() {
    const [uid, setUid] = useState<string | null>(auth.currentUser?.uid ?? null);
    const [loading, setLoading] = useState(true);

    const [isOnline, setIsOnline] = useState(false);
    const [offers, setOffers] = useState<OfferDoc[]>([]);
    const [err, setErr] = useState<string>("");
    const [activeOrderId, setActiveOrderId] = useState<string | null>(null);

    const heartbeatRef = useRef<number | null>(null);
    const expireTimersRef = useRef<Record<string, number>>({});

    useEffect(() => {
        const unsub = onAuthStateChanged(auth, (u) => {
            setUid(u?.uid ?? null);
            setLoading(false);
        });
        return () => unsub();
    }, []);

    // Heartbeat: пока ONLINE — каждые 10s обновляем lastSeenAt
    useEffect(() => {
        async function startHeartbeat() {
            if (!uid || !isOnline) return;

            // сразу пинганём
            await setDoc(
                doc(db, "courierPublic", uid),
                { courierId: uid, isOnline: true, lastSeenAt: serverTimestamp() },
                { merge: true }
            );

            if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
            heartbeatRef.current = window.setInterval(async () => {
                try {
                    await setDoc(
                        doc(db, "courierPublic", uid),
                        { isOnline: true, lastSeenAt: serverTimestamp() },
                        { merge: true }
                    );
                } catch {
                    // игнор
                }
            }, 10_000);
        }

        function stopHeartbeat() {
            if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
            heartbeatRef.current = null;
        }

        startHeartbeat();

        return () => {
            stopHeartbeat();
        };
    }, [uid, isOnline]);

    // Подписка на offers: только когда ONLINE
    useEffect(() => {
        setErr("");
        setOffers([]);

        // если оффлайн — не слушаем
        if (!uid || !isOnline) return;

        const qy = query(
            collection(db, "offers"),
            where("courierId", "==", uid),
            where("status", "==", "pending")
        );

        const unsub = onSnapshot(
            qy,
            (snap) => {
                const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as OfferDoc[];
                list.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
                setOffers(list);
            },
            (e) => setErr(e.message ?? "offers error")
        );

        return () => unsub();
    }, [uid, isOnline]);

    // Авто-expire офферов по expiresAtMs
    useEffect(() => {
        // чистим старые таймеры
        for (const key of Object.keys(expireTimersRef.current)) {
            const stillExists = offers.some((o) => o.id === key);
            if (!stillExists) {
                window.clearTimeout(expireTimersRef.current[key]);
                delete expireTimersRef.current[key];
            }
        }

        // ставим таймеры на новые офферы
        for (const o of offers) {
            if (!o.expiresAtMs) continue;
            if (expireTimersRef.current[o.id]) continue;

            const msLeft = o.expiresAtMs - Date.now();
            const safeMs = Math.max(0, msLeft);

            expireTimersRef.current[o.id] = window.setTimeout(async () => {
                try {
                    // ещё раз проверим, что оффер всё ещё pending
                    await updateDoc(doc(db, "offers", o.id), {
                        status: "expired",
                        updatedAt: serverTimestamp(),
                    } as any);
                } catch {
                    // если уже приняли/отклонили — просто игнор
                }
            }, safeMs);
        }
    }, [offers]);

    async function toggleOnline() {
        if (!uid) return;
        const next = !isOnline;
        setIsOnline(next);

        await setDoc(
            doc(db, "courierPublic", uid),
            {
                courierId: uid,
                isOnline: next,
                lastSeenAt: serverTimestamp(),
            },
            { merge: true }
        );
    }

    async function declineOffer(offerId: string) {
        await updateDoc(doc(db, "offers", offerId), {
            status: "declined",
            updatedAt: serverTimestamp(),
        } as any);
    }

    async function acceptOffer(o: OfferDoc) {
        if (!uid) return;

        try {
            await runTransaction(db, async (tx) => {
                const orderRef = doc(db, "orders", o.orderId);
                const offerRef = doc(db, "offers", o.id);

                const orderSnap = await tx.get(orderRef);
                if (!orderSnap.exists()) throw new Error("Order not found");

                const order = orderSnap.data() as any;

                if (order.assignedCourierId) throw new Error("Order already assigned");
                if (order.status !== "new" && order.status !== "offered") throw new Error("Order not available");

                tx.update(orderRef, {
                    assignedCourierId: uid,
                    status: "taken",
                    acceptedAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                });

                tx.update(offerRef, {
                    status: "accepted",
                    acceptedAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                });
            });

            setActiveOrderId(o.orderId);
        } catch (e: any) {
            alert(e?.message ?? "Accept failed");
        }
    }

    if (loading) return <div style={{ padding: 16 }}>Loading…</div>;
    if (!uid) return <div style={{ padding: 16, color: "crimson" }}>Нет авторизации курьера.</div>;

    return (
        <div style={{ padding: 16, maxWidth: 720 }}>
            <h2 style={{ marginTop: 0 }}>Courier App</h2>

            <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14 }}>
        <span>
          Status: <b style={{ color: isOnline ? "limegreen" : "#aaa" }}>{isOnline ? "ONLINE" : "OFFLINE"}</b>
        </span>
                <button
                    onClick={toggleOnline}
                    style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #333", cursor: "pointer" }}
                >
                    Toggle
                </button>
            </div>

            {activeOrderId && (
                <div style={{ padding: 12, border: "1px solid #333", borderRadius: 12, marginBottom: 14 }}>
                    Active order: <b>{activeOrderId}</b>
                </div>
            )}

            {err && <div style={{ color: "crimson", marginBottom: 12 }}>{err}</div>}

            <h3 style={{ margin: "12px 0" }}>Offers</h3>

            {!isOnline ? (
                <div style={{ color: "#888" }}>Ты OFFLINE. Включи ONLINE, чтобы получать заказы.</div>
            ) : offers.length === 0 ? (
                <div style={{ color: "#888" }}>Пока нет предложений. Жди.</div>
            ) : (
                <div style={{ display: "grid", gap: 12 }}>
                    {offers.map((o) => (
                        <div
                            key={o.id}
                            style={{ border: "1px solid #333", borderRadius: 12, padding: 12, display: "grid", gap: 8 }}
                        >
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                                <b>Offer for order #{o.orderId.slice(0, 6).toUpperCase()}</b>
                                <span style={{ fontSize: 12, color: "#aaa" }}>
                  {o.paymentType.toUpperCase()} · expires in{" "}
                                    {o.expiresAtMs ? Math.max(0, Math.ceil((o.expiresAtMs - Date.now()) / 1000)) : "—"}s
                </span>
                            </div>

                            <div>
                                <b>Dropoff:</b> {o.dropoffAddressText}
                            </div>

                            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                                <a href={wazeUrl(o.dropoffLat, o.dropoffLng)} target="_blank" rel="noreferrer">
                                    Open in Waze
                                </a>
                                <a href={googleUrl(o.dropoffLat, o.dropoffLng)} target="_blank" rel="noreferrer">
                                    Open in Google Maps
                                </a>
                            </div>

                            <div style={{ padding: 10, border: "1px dashed #555", borderRadius: 12 }}>
                                <div style={{ display: "flex", justifyContent: "space-between" }}>
                                    <span style={{ color: "#aaa" }}>Subtotal</span>
                                    <b>{money(o.orderSubtotal)}</b>
                                </div>
                                <div style={{ display: "flex", justifyContent: "space-between" }}>
                                    <span style={{ color: "#aaa" }}>Delivery fee</span>
                                    <b>{money(o.deliveryFee)}</b>
                                </div>
                                <div style={{ display: "flex", justifyContent: "space-between" }}>
                                    <span style={{ color: "#aaa" }}>Total</span>
                                    <b>{money(o.orderTotal)}</b>
                                </div>

                                <hr style={{ borderColor: "#333" }} />

                                {o.paymentType === "cash" ? (
                                    <>
                                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                                            <span style={{ color: "#aaa" }}>Courier pays at pickup</span>
                                            <b>{money(o.courierPaysAtPickup)}</b>
                                        </div>
                                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                                            <span style={{ color: "#aaa" }}>Collects from customer</span>
                                            <b>{money(o.courierCollectsFromCustomer)}</b>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                                            <span style={{ color: "#aaa" }}>Collects from customer</span>
                                            <b>₪0.00</b>
                                        </div>
                                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                                            <span style={{ color: "#aaa" }}>Gets from restaurant</span>
                                            <b>{money(o.courierGetsFromRestaurantAtPickup)}</b>
                                        </div>
                                    </>
                                )}
                            </div>

                            <div style={{ display: "flex", gap: 10 }}>
                                <button
                                    onClick={() => acceptOffer(o)}
                                    style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #333", cursor: "pointer" }}
                                >
                                    Accept
                                </button>
                                <button
                                    onClick={() => declineOffer(o.id)}
                                    style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #333", cursor: "pointer" }}
                                >
                                    Decline
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
