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

    const [busyOfferId, setBusyOfferId] = useState<string | null>(null);
    const [busyOrderAction, setBusyOrderAction] = useState<"pickup" | "deliver" | null>(null);

    // ensure courier docs
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

    // subscribe to active order
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

        if (!next && watchId.current !== null) {
            navigator.geolocation.clearWatch(watchId.current);
            watchId.current = null;
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

        watchId.current = navigator.geolocation.watchPosition(
            async (pos) => {
                try {
                    const { latitude, longitude } = pos.coords;
                    const geohash = geohashForLocation([latitude, longitude]);

                    await setDoc(
                        courierPublicRef,
                        { lat: latitude, lng: longitude, geohash, lastSeenAt: serverTimestamp(), updatedAt: serverTimestamp() },
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
        try {
            if (isOnline) await setOnline(false);
        } catch {}
        await signOut(auth);
        nav("/courier/login");
    }

    if (!user) return <div className="page"><div className="container container--mid">Not authorized</div></div>;

    const hasActive = !!activeOrder;
    const activeStatus: string | undefined = activeOrder?.status;

    const canPickup = activeStatus === "taken";
    const canDeliver = activeStatus === "picked_up";

    const activeMapUrl =
        activeOrder?.dropoffLat && activeOrder?.dropoffLng
            ? `https://www.google.com/maps?q=${activeOrder.dropoffLat},${activeOrder.dropoffLng}`
            : null;

    return (
        <div className="page">
            <div className="container container--mid">
                {/* Header */}
                <div className="card">
                    <div className="card__inner">
                        <div className="row row--between row--wrap row--mobile-stack">
                            <div>
                                <div className="brand" style={{ fontSize: 22 }}>Courier Console</div>
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

                                <button className="btn" onClick={() => setOnline(false)} disabled={!isOnline}>
                                    Go offline
                                </button>

                                <button className="btn btn--ghost" onClick={logout}>
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

                {/* Active order */}
                <div style={{ height: 12 }} />

                {activeOrder && (
                    <div className="card">
                        <div className="card__inner">
                            <div className="row row--between row--wrap">
                                <div className="row row--wrap">
                                    <div style={{ fontWeight: 950, fontSize: 16 }}>
                                        Active order <span className="mono">#{shortId(activeOrder.id)}</span>
                                    </div>
                                    <span className={`pill pill--${pillToneForOrderStatus(activeOrder.status)}`}>
                    {labelForOrderStatus(activeOrder.status)}
                  </span>
                                </div>

                                <div className="row row--wrap">
                                    {/* step pills */}
                                    <span className={`pill ${activeStatus === "taken" ? "pill--warning" : "pill--success"}`}>
                    1 · TAKEN
                  </span>
                                    <span className={`pill ${activeStatus === "picked_up" ? "pill--info" : "pill--muted"}`}>
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
                                        <b>{activeOrder.customerName ?? "—"}</b>
                                    </div>

                                    <div className="line">
                                        <span>Phone</span>
                                        <b>
                                            {activeOrder.customerPhone ? (
                                                <a href={`tel:${activeOrder.customerPhone}`} style={{ textDecoration: "none" }}>
                                                    {activeOrder.customerPhone}
                                                </a>
                                            ) : (
                                                "—"
                                            )}
                                        </b>
                                    </div>

                                    <div className="line" style={{ alignItems: "baseline" }}>
                                        <span>Address</span>
                                        <b style={{ textAlign: "right" }}>
                                            {activeOrder.dropoffAddressText ?? activeOrder.customerAddress ?? "—"}
                                        </b>
                                    </div>

                                    <div className="line">
                                        <span>Total</span>
                                        <b>{money(activeOrder.orderTotal)}</b>
                                    </div>

                                    <div className="line">
                                        <span>Your fee</span>
                                        <b>{money(activeOrder.deliveryFee)}</b>
                                    </div>

                                    <div className="line">
                                        <span>Pay</span>
                                        <b>{activeOrder.paymentType ?? "—"}</b>
                                    </div>
                                </div>
                            </div>

                            <div style={{ height: 12 }} />

                            <div className="row row--wrap row--mobile-stack">
                                <button
                                    className="btn btn--primary"
                                    onClick={() => markPickedUp(activeOrder.id)}
                                    disabled={!canPickup || busyOrderAction !== null}
                                >
                                    {busyOrderAction === "pickup" ? "Saving…" : "Picked up"}
                                </button>

                                <button
                                    className="btn btn--success"
                                    onClick={() => markDelivered(activeOrder.id)}
                                    disabled={!canDeliver || busyOrderAction !== null}
                                >
                                    {busyOrderAction === "deliver" ? "Saving…" : "Delivered"}
                                </button>

                                {activeMapUrl && (
                                    <a className="btn btn--ghost" href={activeMapUrl} target="_blank" rel="noreferrer">
                                        Open map
                                    </a>
                                )}
                            </div>

                            {!canDeliver && (
                                <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>
                                    Tip: “Delivered” becomes available after “Picked up”.
                                </div>
                            )}
                        </div>
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

                            {hasActive && (
                                <span className="pill pill--warning">
                  Finish active order to accept new ones
                </span>
                            )}
                        </div>

                        <div className="hr" />

                        {offers.length === 0 && <div className="muted">No new offers</div>}

                        <div className="stack">
                            {offers.map((o) => {
                                const offerMapUrl =
                                    o.dropoffLat && o.dropoffLng
                                        ? `https://www.google.com/maps?q=${o.dropoffLat},${o.dropoffLng}`
                                        : null;

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

                                            {offerMapUrl && (
                                                <a className="btn btn--ghost" href={offerMapUrl} target="_blank" rel="noreferrer">
                                                    Map
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
                                                disabled={isBusy || hasActive}
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
            </div>
        </div>
    );
}
