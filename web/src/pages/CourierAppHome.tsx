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

    customerName?: string;
    customerPhone?: string;
    customerAddress?: string;

    dropoffLat?: number;
    dropoffLng?: number;
    dropoffGeohash?: string;
    dropoffAddressText?: string;

    pickupLat?: number;
    pickupLng?: number;
    pickupGeohash?: string;
    pickupAddressText?: string;

    paymentType?: string;
    orderSubtotal?: number;
    deliveryFee?: number;
    orderTotal?: number;

    courierPaysAtPickup?: number;
    courierCollectsFromCustomer?: number;
    courierGetsFromRestaurantAtPickup?: number;
};

function shortId(id: string) {
    return (id || "").slice(0, 6).toUpperCase();
}

function money(n?: number) {
    const x = typeof n === "number" && Number.isFinite(n) ? n : 0;
    return `₪${x.toFixed(2)}`;
}

function wazeUrl(lat?: number, lng?: number) {
    if (typeof lat !== "number" || typeof lng !== "number") return null;
    return `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
}

function yandexMapsUrl(lat?: number, lng?: number) {
    if (typeof lat !== "number" || typeof lng !== "number") return null;
    return `https://yandex.com/maps/?pt=${lng},${lat}&z=17&l=map`;
}

function googleMapsUrl(lat?: number, lng?: number) {
    if (typeof lat !== "number" || typeof lng !== "number") return null;
    return `https://www.google.com/maps?q=${lat},${lng}`;
}

const MAX_ACTIVE_ORDERS = 3;
const MAX_PENDING_OFFERS = 3;

const GEO_WRITE_MIN_MS = 60_000; // пишем в Firestore не чаще 1 раза/мин
const GEO_MIN_MOVE_M = 150; // или если сдвиг > 150 метров

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function pillToneForOrderStatus(status?: string) {
    switch (status) {
        case "new":
            return "info";
        case "taken":
            return "warning";
        case "picked_up":
            return "info";
        case "delivered":
            return "success";
        case "cancelled":
            return "danger";
        default:
            return "muted";
    }
}

function labelForOrderStatus(status?: string) {
    switch (status) {
        case "taken":
            return "TAKEN";
        case "picked_up":
            return "PICKED UP";
        case "delivered":
            return "DELIVERED";
        case "new":
            return "NEW";
        default:
            return (status || "—").toUpperCase();
    }
}

export default function CourierAppHome() {
    const nav = useNavigate();
    const user = auth.currentUser;

    const watchId = useRef<number | null>(null);
    const heartbeatId = useRef<number | null>(null);

    const lastGeoWriteMsRef = useRef<number>(0);
    const lastGeoRef = useRef<{ lat: number; lng: number } | null>(null);
    const geoWriteInFlightRef = useRef(false);

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
    const [activeOrders, setActiveOrders] = useState<any[]>([]);

    const [tab, setTab] = useState<"active" | "completed">("active");
    const [completedOrders, setCompletedOrders] = useState<any[]>([]);

    const [busyOfferId, setBusyOfferId] = useState<string | null>(null);
    const [busyOrderAction, setBusyOrderAction] = useState<"pickup" | "deliver" | null>(null);

    // ensure courier docs
    useEffect(() => {
        let cancelled = false;

        async function ensureDocs() {
            if (!user || !courierPrivateRef || !courierPublicRef) return;

            try {
                await setDoc(courierPrivateRef, { updatedAt: serverTimestamp() }, { merge: true });
                await setDoc(courierPublicRef, { courierId: user.uid, updatedAt: serverTimestamp() }, { merge: true });
            } catch (e: any) {
                if (!cancelled) setErr(e?.message ?? "Failed to init courier docs");
            }
        }

        ensureDocs();
        return () => {
            cancelled = true;
        };
    }, [user, courierPrivateRef, courierPublicRef]);

    // subscribe to pending offers
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

                        pickupLat: data.pickupLat,
                        pickupLng: data.pickupLng,
                        pickupGeohash: data.pickupGeohash,
                        pickupAddressText: data.pickupAddressText,

                        paymentType: data.paymentType,
                        orderSubtotal: data.orderSubtotal,
                        deliveryFee: data.deliveryFee,
                        orderTotal: data.orderTotal,

                        courierPaysAtPickup: data.courierPaysAtPickup,
                        courierCollectsFromCustomer: data.courierCollectsFromCustomer,
                        courierGetsFromRestaurantAtPickup: data.courierGetsFromRestaurantAtPickup,
                    };
                });

                // UI-лимит (по ТЗ максимум офферов)
                setOffers(list.slice(0, MAX_PENDING_OFFERS));
            },
            (e: any) => setErr(e?.message ?? "Failed to load offers")
        );

        return () => unsub();
    }, [user]);

    // subscribe to active orders
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
                const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
                setActiveOrders(list);
            },
            (e: any) => setErr(e?.message ?? "Failed to load active orders")
        );

        return () => unsub();
    }, [user]);

    // subscribe to completed (delivered) orders
    useEffect(() => {
        if (!user) return;

        const q = query(
            collection(db, "orders"),
            where("assignedCourierId", "==", user.uid),
            where("status", "==", "delivered")
        );

        const unsub = onSnapshot(
            q,
            (snap) => {
                const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

                // сортировка по deliveredAt (если есть), чтобы новые были сверху
                list.sort((a: any, b: any) => {
                    const ta = a?.deliveredAt?.seconds ?? 0;
                    const tb = b?.deliveredAt?.seconds ?? 0;
                    return tb - ta;
                });

                setCompletedOrders(list);
            },
            (e: any) => setErr(e?.message ?? "Failed to load completed orders")
        );

        return () => unsub();
    }, [user]);

    async function setOnline(next: boolean) {
        if (!user || !courierPrivateRef || !courierPublicRef) return;
        setErr(null);

        if (!next && activeOrders.length > 0) {
            setErr("You can't go OFFLINE while you have active orders.");
            return;
        }

        if (!next && watchId.current !== null) {
            navigator.geolocation.clearWatch(watchId.current);
            watchId.current = null;
        }
        if (!next && heartbeatId.current !== null) {
            window.clearInterval(heartbeatId.current);
            heartbeatId.current = null;
        }

        try {
            await setDoc(
                courierPrivateRef,
                { isOnline: next, lastSeenAt: serverTimestamp(), updatedAt: serverTimestamp() },
                { merge: true }
            );

            await setDoc(
                courierPublicRef,
                { courierId: user.uid, isOnline: next, lastSeenAt: serverTimestamp(), updatedAt: serverTimestamp() },
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

        // Heartbeat: обновляем lastSeenAt раз в минуту даже если позиция не меняется
        if (heartbeatId.current !== null) {
            window.clearInterval(heartbeatId.current);
        }

        heartbeatId.current = window.setInterval(async () => {
            try {
                const now = Date.now();
                const elapsed = now - lastGeoWriteMsRef.current;
                if (elapsed < GEO_WRITE_MIN_MS) return;

                const last = lastGeoRef.current;
                if (!last) return;

                if (geoWriteInFlightRef.current) return;
                geoWriteInFlightRef.current = true;

                const geohash = geohashForLocation([last.lat, last.lng]);

                await setDoc(
                    courierPublicRef,
                    { lat: last.lat, lng: last.lng, geohash, lastSeenAt: serverTimestamp(), updatedAt: serverTimestamp() },
                    { merge: true }
                );

                lastGeoWriteMsRef.current = now;
            } catch {
                // heartbeat не должен ломать UI ошибками
            } finally {
                geoWriteInFlightRef.current = false;
            }
        }, GEO_WRITE_MIN_MS);

        watchId.current = navigator.geolocation.watchPosition(
            async (pos) => {
                const { latitude, longitude } = pos.coords;

                const now = Date.now();
                const prev = lastGeoRef.current;
                const moved = prev ? haversineMeters(prev.lat, prev.lng, latitude, longitude) : Infinity;

                // сохраняем последнюю позицию всегда
                lastGeoRef.current = { lat: latitude, lng: longitude };

                const elapsed = now - lastGeoWriteMsRef.current;
                const shouldWrite = elapsed >= GEO_WRITE_MIN_MS || moved >= GEO_MIN_MOVE_M;
                if (!shouldWrite) return;

                if (geoWriteInFlightRef.current) return;
                geoWriteInFlightRef.current = true;

                try {
                    const geohash = geohashForLocation([latitude, longitude]);

                    await setDoc(
                        courierPublicRef,
                        { lat: latitude, lng: longitude, geohash, lastSeenAt: serverTimestamp(), updatedAt: serverTimestamp() },
                        { merge: true }
                    );

                    lastGeoWriteMsRef.current = now;
                } catch (e: any) {
                    setErr(e?.message ?? "Failed to update location");
                } finally {
                    geoWriteInFlightRef.current = false;
                }
            },
            (error) => setErr(error.message),
            { enableHighAccuracy: true, maximumAge: 10_000, timeout: 10_000 }
        );
    }

    // Accept offer (first courier wins)
    async function acceptOffer(offer: Offer) {
        if (!auth.currentUser) return;

        const uid = auth.currentUser.uid;
        const offerRef = doc(db, "offers", offer.id);
        const orderRef = doc(db, "orders", offer.orderId);

        setErr(null);
        setBusyOfferId(offer.id);

        try {
            await runTransaction(db, async (tx) => {
                const orderSnap = await tx.get(orderRef);
                if (!orderSnap.exists()) throw new Error("Order not found");

                const orderData: any = orderSnap.data();
                if (orderData.status === "cancelled" || orderData.status === "delivered") {
                    tx.update(offerRef, { status: "declined", updatedAt: serverTimestamp() });
                    throw new Error("Order is no longer available");
                }

                if (orderData.assignedCourierId && orderData.assignedCourierId !== uid) {
                    tx.update(offerRef, { status: "declined", updatedAt: serverTimestamp() });
                    throw new Error("Order already taken by another courier");
                }

                if (!orderData.assignedCourierId) {
                    tx.update(orderRef, {
                        assignedCourierId: uid,
                        status: "taken",
                        acceptedAt: serverTimestamp(),
                        updatedAt: serverTimestamp(),
                    });
                }

                tx.update(offerRef, { status: "accepted", updatedAt: serverTimestamp() });
            });
        } catch (e: any) {
            setErr(e?.message ?? "Failed to accept offer");
        } finally {
            setBusyOfferId(null);
        }
    }

    async function declineOffer(offerId: string) {
        setBusyOfferId(offerId);
        try {
            await updateDoc(doc(db, "offers", offerId), {
                status: "declined",
                updatedAt: serverTimestamp(),
            });
        } finally {
            setBusyOfferId(null);
        }
    }

    async function markPickedUp(orderId: string) {
        setBusyOrderAction("pickup");
        try {
            await updateDoc(doc(db, "orders", orderId), {
                status: "picked_up",
                pickedUpAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
            });
        } finally {
            setBusyOrderAction(null);
        }
    }

    async function markDelivered(orderId: string) {
        setBusyOrderAction("deliver");
        try {
            await updateDoc(doc(db, "orders", orderId), {
                status: "delivered",
                deliveredAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
            });
        } finally {
            setBusyOrderAction(null);
        }
    }

    async function logout() {
        if (activeOrders.length > 0) {
            setErr("You can't logout while you have active orders. Finish delivery or ask restaurant to remove you.");
            return;
        }

        try {
            if (isOnline) await setOnline(false);
        } catch {}
        await signOut(auth);
        nav("/courier/login");
    }

    if (!user) {
        return (
            <div className="page">
                <div className="container container--mid">Not authorized</div>
            </div>
        );
    }

    const activeCount = activeOrders.length;
    const hasActive = activeCount > 0;
    const reachedMaxActive = activeCount >= MAX_ACTIVE_ORDERS;

    return (
        <div className="page">
            <div className="container container--mid">
                {/* Header */}
                <div className="card">
                    <div className="card__inner">
                        <div className="row row--between row--wrap row--mobile-stack">
                            <div>
                                <div className="brand" style={{ fontSize: 22 }}>
                                    Courier Console
                                </div>
                                <div className="muted" style={{ marginTop: 6 }}>
                                    Your work dashboard — offers, active order, delivery steps.
                                </div>
                            </div>

                            <div className="row row--wrap row--mobile-stack" style={{ justifyContent: "flex-end" }}>
                <span className={`pill ${isOnline ? "pill--success" : "pill--muted"}`}>
                  {isOnline ? "● ONLINE" : "● OFFLINE"}
                </span>

                                <button className="btn btn--success" onClick={() => setOnline(true)} disabled={isOnline}>
                                    Go online
                                </button>

                                <button className="btn" onClick={() => setOnline(false)} disabled={!isOnline || hasActive}>
                                    Go offline
                                </button>

                                <button className="btn btn--ghost" onClick={logout} disabled={hasActive}>
                                    Logout
                                </button>
                            </div>
                        </div>

                        {err && (
                            <div className="alert alert--danger" style={{ marginTop: 12 }}>
                                {err}
                            </div>
                        )}
                    </div>
                </div>

                {/* Tabs */}
                <div style={{ height: 12 }} />
                <div className="card">
                    <div className="card__inner">
                        <div className="row row--wrap">
                            <button
                                className={`btn ${tab === "active" ? "btn--primary" : "btn--ghost"}`}
                                onClick={() => setTab("active")}
                            >
                                Активные
                            </button>

                            <button
                                className={`btn ${tab === "completed" ? "btn--primary" : "btn--ghost"}`}
                                onClick={() => setTab("completed")}
                            >
                                Выполненные <span className="pill pill--muted">{completedOrders.length}</span>
                            </button>
                        </div>
                    </div>
                </div>

                {/* ACTIVE TAB */}
                {tab === "active" && (
                    <>
                        {/* Active orders */}
                        <div style={{ height: 12 }} />

                        {activeOrders.length > 0 && (
                            <div className="stack">
                                {activeOrders.slice(0, MAX_ACTIVE_ORDERS).map((ord: any) => {
                                    const st: string | undefined = ord?.status;
                                    const canPickup = st === "taken";
                                    const canDeliver = st === "picked_up";

                                    const pickupMain =
                                        wazeUrl(ord?.pickupLat, ord?.pickupLng) ??
                                        googleMapsUrl(ord?.pickupLat, ord?.pickupLng);
                                    const pickupYandex = yandexMapsUrl(ord?.pickupLat, ord?.pickupLng);

                                    const dropoffMain =
                                        wazeUrl(ord?.dropoffLat, ord?.dropoffLng) ??
                                        googleMapsUrl(ord?.dropoffLat, ord?.dropoffLng);
                                    const dropoffYandex = yandexMapsUrl(ord?.dropoffLat, ord?.dropoffLng);

                                    return (
                                        <div key={ord.id} className="card">
                                            <div className="card__inner">
                                                <div className="row row--between row--wrap">
                                                    <div className="row row--wrap">
                                                        <div style={{ fontWeight: 950, fontSize: 16 }}>
                                                            Active order <span className="mono">#{shortId(ord.id)}</span>
                                                        </div>
                                                        <span className={`pill pill--${pillToneForOrderStatus(ord.status)}`}>
                              {labelForOrderStatus(ord.status)}
                            </span>
                                                    </div>

                                                    <div className="row row--wrap">
                            <span className={`pill ${st === "taken" ? "pill--warning" : "pill--success"}`}>
                              1 · TAKEN
                            </span>
                                                        <span className={`pill ${st === "picked_up" ? "pill--info" : "pill--muted"}`}>
                              2 · PICKED UP
                            </span>
                                                        <span className="pill pill--muted">3 · DELIVERED</span>
                                                    </div>
                                                </div>

                                                <div className="hr" />

                                                <div className="subcard">
                                                    <div className="kv">
                                                        <div className="line">
                                                            <span>Customer</span>
                                                            <b>{ord.customerName ?? "—"}</b>
                                                        </div>

                                                        <div className="line">
                                                            <span>Phone</span>
                                                            <b>
                                                                {ord.customerPhone ? (
                                                                    <a href={`tel:${ord.customerPhone}`} style={{ textDecoration: "none" }}>
                                                                        {ord.customerPhone}
                                                                    </a>
                                                                ) : (
                                                                    "—"
                                                                )}
                                                            </b>
                                                        </div>

                                                        <div className="line" style={{ alignItems: "baseline" }}>
                                                            <span>Address</span>
                                                            <b style={{ textAlign: "right" }}>
                                                                {ord.dropoffAddressText ?? ord.customerAddress ?? "—"}
                                                            </b>
                                                        </div>

                                                        <div className="line">
                                                            <span>Total</span>
                                                            <b>{money(ord.orderTotal)}</b>
                                                        </div>

                                                        <div className="line">
                                                            <span>Your fee</span>
                                                            <b>{money(ord.deliveryFee)}</b>
                                                        </div>

                                                        <div className="line">
                                                            <span>Pay</span>
                                                            <b>{ord.paymentType ?? "—"}</b>
                                                        </div>
                                                    </div>
                                                </div>

                                                <div style={{ height: 12 }} />

                                                <div className="row row--wrap row--mobile-stack">
                                                    <button
                                                        className="btn btn--primary"
                                                        onClick={() => markPickedUp(ord.id)}
                                                        disabled={!canPickup || busyOrderAction !== null}
                                                    >
                                                        {busyOrderAction === "pickup" ? "Saving…" : "Забрал заказ"}
                                                    </button>

                                                    <button
                                                        className="btn btn--success"
                                                        onClick={() => markDelivered(ord.id)}
                                                        disabled={!canDeliver || busyOrderAction !== null}
                                                    >
                                                        {busyOrderAction === "deliver" ? "Saving…" : "Доставлено"}
                                                    </button>

                                                    {/* До pickup (taken) показываем маршрут в ресторан */}
                                                    {canPickup && pickupMain && (
                                                        <a className="btn btn--ghost" href={pickupMain} target="_blank" rel="noreferrer">
                                                            Маршрут в ресторан
                                                        </a>
                                                    )}
                                                    {canPickup && pickupYandex && (
                                                        <a className="btn btn--ghost" href={pickupYandex} target="_blank" rel="noreferrer">
                                                            Яндекс
                                                        </a>
                                                    )}

                                                    {/* После pickup (picked_up) показываем маршрут к клиенту */}
                                                    {canDeliver && dropoffMain && (
                                                        <a className="btn btn--ghost" href={dropoffMain} target="_blank" rel="noreferrer">
                                                            Маршрут к клиенту
                                                        </a>
                                                    )}
                                                    {canDeliver && dropoffYandex && (
                                                        <a className="btn btn--ghost" href={dropoffYandex} target="_blank" rel="noreferrer">
                                                            Яндекс
                                                        </a>
                                                    )}
                                                </div>

                                                {!canDeliver && (
                                                    <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>
                                                        Tip: “Доставлено” станет доступно после “Забрал заказ”.
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {/* Offers */}
                        <div style={{ height: 12 }} />

                        <div className="card">
                            <div className="card__inner">
                                <div className="row row--between row--wrap">
                                    <div className="row row--wrap">
                                        <h3 style={{ margin: 0 }}>New offers</h3>
                                        <span className="pill pill--muted">{offers.length}</span>
                                    </div>

                                    <span className="pill pill--muted">
                    Active {activeCount}/{MAX_ACTIVE_ORDERS}
                  </span>

                                    {reachedMaxActive && (
                                        <span className="pill pill--warning">
                      Max {MAX_ACTIVE_ORDERS} active orders reached
                    </span>
                                    )}
                                </div>

                                <div className="hr" />

                                {offers.length === 0 && <div className="muted">No new offers</div>}

                                <div className="stack">
                                    {offers.map((o) => {
                                        const pickupMain =
                                            wazeUrl(o.pickupLat, o.pickupLng) ??
                                            googleMapsUrl(o.pickupLat, o.pickupLng);
                                        const pickupYandex = yandexMapsUrl(o.pickupLat, o.pickupLng);

                                        const isBusy = busyOfferId === o.id;

                                        return (
                                            <div key={o.id} className="subcard">
                                                <div className="row row--between row--wrap">
                                                    <div className="row row--wrap">
                                                        <div style={{ fontWeight: 950 }}>
                                                            Order <span className="mono">#{shortId(o.orderId)}</span>
                                                        </div>

                                                        <span className={`pill ${o.paymentType === "cash" ? "pill--muted" : "pill--info"}`}>
                              {(o.paymentType ?? "—").toUpperCase()}
                            </span>

                                                        <span className="pill pill--success">Fee {money(o.deliveryFee)}</span>
                                                    </div>

                                                    {pickupMain && (
                                                        <a className="btn btn--ghost" href={pickupMain} target="_blank" rel="noreferrer">
                                                            Маршрут в ресторан
                                                        </a>
                                                    )}
                                                    {pickupYandex && (
                                                        <a className="btn btn--ghost" href={pickupYandex} target="_blank" rel="noreferrer">
                                                            Яндекс
                                                        </a>
                                                    )}
                                                </div>

                                                <div style={{ height: 10 }} />

                                                <div className="kv">
                                                    <div className="line">
                                                        <span>Customer</span>
                                                        <b>{o.customerName ?? "—"}</b>
                                                    </div>

                                                    <div className="line">
                                                        <span>Phone</span>
                                                        <b>
                                                            {o.customerPhone ? (
                                                                <a href={`tel:${o.customerPhone}`} style={{ textDecoration: "none" }}>
                                                                    {o.customerPhone}
                                                                </a>
                                                            ) : (
                                                                "—"
                                                            )}
                                                        </b>
                                                    </div>

                                                    <div className="line" style={{ alignItems: "baseline" }}>
                                                        <span>Address</span>
                                                        <b style={{ textAlign: "right" }}>
                                                            {o.dropoffAddressText ?? o.customerAddress ?? "—"}
                                                        </b>
                                                    </div>

                                                    <div className="line">
                                                        <span>Total</span>
                                                        <b>{money(o.orderTotal)}</b>
                                                    </div>
                                                </div>

                                                <div style={{ height: 12 }} />

                                                <div className="row row--wrap row--mobile-stack">
                                                    <button
                                                        className="btn btn--success"
                                                        onClick={() => acceptOffer(o)}
                                                        disabled={isBusy || reachedMaxActive}
                                                    >
                                                        {isBusy ? "Working…" : "Accept"}
                                                    </button>

                                                    <button
                                                        className="btn btn--danger"
                                                        onClick={() => declineOffer(o.id)}
                                                        disabled={isBusy}
                                                    >
                                                        {isBusy ? "Working…" : "Decline"}
                                                    </button>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>

                                <div className="muted" style={{ marginTop: 12, fontSize: 12 }}>
                                    Presence updates while the app is open.
                                </div>
                            </div>
                        </div>
                    </>
                )}

                {/* COMPLETED TAB */}
                {tab === "completed" && (
                    <>
                        <div style={{ height: 12 }} />

                        <div className="card">
                            <div className="card__inner">
                                <div className="row row--between row--wrap">
                                    <h3 style={{ margin: 0 }}>Выполненные заказы</h3>
                                    <span className="pill pill--muted">{completedOrders.length}</span>
                                </div>

                                <div className="hr" />

                                {completedOrders.length === 0 && (
                                    <div className="muted">Пока нет выполненных заказов</div>
                                )}

                                <div className="stack">
                                    {completedOrders.map((o: any) => (
                                        <div key={o.id} className="subcard">
                                            <div className="row row--between row--wrap">
                                                <div style={{ fontWeight: 950 }}>
                                                    Order <span className="mono">#{shortId(o.id)}</span>
                                                </div>
                                                <span className="pill pill--success">DELIVERED</span>
                                            </div>

                                            <div style={{ height: 10 }} />

                                            <div className="kv">
                                                <div className="line">
                                                    <span>Customer</span>
                                                    <b>{o.customerName ?? "—"}</b>
                                                </div>

                                                <div className="line" style={{ alignItems: "baseline" }}>
                                                    <span>Address</span>
                                                    <b style={{ textAlign: "right" }}>
                                                        {o.dropoffAddressText ?? o.customerAddress ?? "—"}
                                                    </b>
                                                </div>

                                                <div className="line">
                                                    <span>Total</span>
                                                    <b>{money(o.orderTotal)}</b>
                                                </div>

                                                <div className="line">
                                                    <span>Your fee</span>
                                                    <b>{money(o.deliveryFee)}</b>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                <div className="muted" style={{ marginTop: 12, fontSize: 12 }}>
                                    Delivered orders are shown here.
                                </div>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
