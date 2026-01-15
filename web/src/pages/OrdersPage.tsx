import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { OrderChat } from "../components/OrderChat";

import {
    collection,
    onSnapshot,
    orderBy,
    query,
    where,
    Timestamp,
    doc,
    updateDoc,
    serverTimestamp,
} from "firebase/firestore";

import { auth, db } from "../lib/firebase";
import { useNavigate } from "react-router-dom";

type OrderStatus = "new" | "offered" | "taken" | "picked_up" | "delivered" | "cancelled";
type PaymentMethod = "cash" | "card";

type OrderDoc = {
    id: string;
    restaurantId: string;

    pickupLat?: number;
    pickupLng?: number;
    pickupGeohash?: string;
    pickupAddressText?: string;

    dropoffLat?: number;
    dropoffLng?: number;
    dropoffGeohash?: string;
    dropoffAddressText?: string;

    triedCourierIds?: string[];

    customerName: string;
    customerAddress: string;
    customerPhone?: string;
    notes?: string;

    paymentType: PaymentMethod;

    orderSubtotal: number;
    deliveryFee: number;
    orderTotal: number;

    courierPaysAtPickup: number;
    courierCollectsFromCustomer: number;
    courierGetsFromRestaurantAtPickup: number;

    status: OrderStatus;
    assignedCourierId?: string | null;

    createdAt?: Timestamp;
};

function formatDate(ts?: Timestamp) {
    if (!ts) return "—";
    return ts.toDate().toLocaleString();
}

function statusLabel(s: OrderStatus) {
    switch (s) {
        case "new": return "NEW";
        case "offered": return "OFFERED";
        case "taken": return "TAKEN";
        case "picked_up": return "PICKED UP";
        case "delivered": return "DELIVERED";
        case "cancelled": return "CANCELLED";
        default: return s;
    }
}

function statusTone(s: OrderStatus) {
    switch (s) {
        case "new": return "info";
        case "offered": return "info";
        case "taken": return "warning";
        case "picked_up": return "info";
        case "delivered": return "success";
        case "cancelled": return "danger";
        default: return "muted";
    }
}

function paymentLabel(p: PaymentMethod) {
    return p === "cash" ? "CASH" : "CARD";
}

function paymentTone(p: PaymentMethod) {
    return p === "cash" ? "muted" : "info";
}

function money(n: number) {
    const x = Number.isFinite(n) ? n : 0;
    return `₪${x.toFixed(2)}`;
}

export function OrdersPage() {
    const navigate = useNavigate();

    const [uid, setUid] = useState<string | null>(auth.currentUser?.uid ?? null);
    const [loading, setLoading] = useState(true);

    const [orders, setOrders] = useState<OrderDoc[]>([]);
    const [error, setError] = useState<string>("");
    const [tab, setTab] = useState<"active" | "completed" | "cancelled">("active");
    const [busyAction, setBusyAction] = useState<string | null>(null);
    const [chatOpenByOrderId, setChatOpenByOrderId] = useState<Record<string, boolean>>({});

    function toggleChat(orderId: string) {
        setChatOpenByOrderId((prev) => ({ ...prev, [orderId]: !prev[orderId] }));
    }

    useEffect(() => {
        const unsub = onAuthStateChanged(auth, (u) => setUid(u?.uid ?? null));
        return () => unsub();
    }, []);

    // ✅ только UI подписка на заказы ресторана
    useEffect(() => {
        setError("");
        setOrders([]);

        if (!uid) {
            setLoading(false);
            return;
        }

        setLoading(true);

        const q = query(
            collection(db, "orders"),
            where("restaurantId", "==", uid),
            orderBy("createdAt", "desc")
        );

        const unsub = onSnapshot(
            q,
            (snap) => {
                const list: OrderDoc[] = snap.docs.map((d) => {
                    const data = d.data() as any;
                    return {
                        id: d.id,
                        restaurantId: data.restaurantId,

                        pickupLat: data.pickupLat,
                        pickupLng: data.pickupLng,
                        pickupGeohash: data.pickupGeohash,
                        pickupAddressText: data.pickupAddressText,

                        dropoffLat: data.dropoffLat,
                        dropoffLng: data.dropoffLng,
                        dropoffGeohash: data.dropoffGeohash,
                        dropoffAddressText: data.dropoffAddressText,

                        triedCourierIds: Array.isArray(data.triedCourierIds) ? data.triedCourierIds : [],

                        customerName: data.customerName ?? "",
                        customerAddress: data.customerAddress ?? "",
                        customerPhone: data.customerPhone ?? "",
                        notes: data.notes ?? "",

                        paymentType: (data.paymentType ?? "cash") as PaymentMethod,

                        orderSubtotal: Number(data.orderSubtotal ?? 0),
                        deliveryFee: Number(data.deliveryFee ?? 0),
                        orderTotal: Number(data.orderTotal ?? 0),

                        courierPaysAtPickup: Number(data.courierPaysAtPickup ?? 0),
                        courierCollectsFromCustomer: Number(data.courierCollectsFromCustomer ?? 0),
                        courierGetsFromRestaurantAtPickup: Number(data.courierGetsFromRestaurantAtPickup ?? 0),

                        status: (data.status ?? "new") as OrderStatus,
                        assignedCourierId: (data.assignedCourierId ?? null) as string | null,
                        createdAt: data.createdAt,
                    };
                });

                setOrders(list);
                setLoading(false);
            },
            (e) => {
                setError(e.message ?? "Firestore error");
                setLoading(false);
            }
        );

        return () => unsub();
    }, [uid]);

    const stats = useMemo(() => {
        const total = orders.length;
        const byStatus = orders.reduce((acc, o) => {
            acc[o.status] = (acc[o.status] ?? 0) + 1;
            return acc;
        }, {} as Record<OrderStatus, number>);
        return { total, byStatus };
    }, [orders]);

    const filteredOrders = useMemo(() => {
        if (tab === "active") {
            return orders.filter(
                (o) =>
                    o.status === "new" ||
                    o.status === "offered" ||
                    o.status === "taken" ||
                    o.status === "picked_up"
            );
        }
        if (tab === "completed") {
            return orders.filter((o) => o.status === "delivered");
        }
        return orders.filter((o) => o.status === "cancelled");
    }, [orders, tab]);

    const counts = useMemo(() => {
        const active =
            (stats.byStatus.new ?? 0) +
            (stats.byStatus.offered ?? 0) +
            (stats.byStatus.taken ?? 0) +
            (stats.byStatus.picked_up ?? 0);

        const completed = stats.byStatus.delivered ?? 0;
        const cancelled = stats.byStatus.cancelled ?? 0;

        return { active, completed, cancelled };
    }, [stats]);

    const goNewOrder = () => navigate("/restaurant/app/orders/new");

    async function cancelOrder(orderId: string) {
        if (!window.confirm("Cancel this order?")) return;

        setBusyAction(`cancel:${orderId}`);
        try {
            await updateDoc(doc(db, "orders", orderId), {
                status: "cancelled",
                cancelledAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
            });
        } catch (e: any) {
            setError(e?.message ?? "Failed to cancel order");
        } finally {
            setBusyAction(null);
        }
    }

    async function removeCourier(orderId: string, assignedCourierId?: string | null) {
        if (!assignedCourierId) return;
        if (!window.confirm("Remove courier from this order and reassign?")) return;

        setBusyAction(`remove:${orderId}`);
        try {
            await updateDoc(doc(db, "orders", orderId), {
                assignedCourierId: null,
                status: "new",
                updatedAt: serverTimestamp(),
            });
        } catch (e: any) {
            setError(e?.message ?? "Failed to remove courier");
        } finally {
            setBusyAction(null);
        }
    }

    if (!uid) {
        return (
            <div className="card">
                <div className="card__inner">
                    <h2 style={{ margin: 0 }}>Orders</h2>
                    <div className="alert alert--danger" style={{ marginTop: 12 }}>
                        No auth session. Please login.
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="stack">
            <div className="row row--between row--wrap row--mobile-stack">
                <div>
                    <h2 style={{ margin: 0 }}>Orders</h2>
                    <div className="row row--wrap" style={{ marginTop: 8 }}>
                        <div className="row row--wrap" style={{ marginTop: 10 }}>
                            <button
                                className={`btn ${tab === "active" ? "btn--primary" : "btn--ghost"}`}
                                onClick={() => setTab("active")}
                            >
                                Active ({counts.active})
                            </button>

                            <button
                                className={`btn ${tab === "completed" ? "btn--primary" : "btn--ghost"}`}
                                onClick={() => setTab("completed")}
                            >
                                Completed ({counts.completed})
                            </button>

                            <button
                                className={`btn ${tab === "cancelled" ? "btn--primary" : "btn--ghost"}`}
                                onClick={() => setTab("cancelled")}
                            >
                                Cancelled ({counts.cancelled})
                            </button>
                        </div>

                        <span className="pill pill--muted">Total {stats.total}</span>
                        <span className="pill pill--info">NEW {stats.byStatus.new ?? 0}</span>
                        <span className="pill pill--warning">TAKEN {stats.byStatus.taken ?? 0}</span>
                        <span className="pill pill--success">DELIVERED {stats.byStatus.delivered ?? 0}</span>
                    </div>
                </div>

                <button className="btn btn--primary" onClick={goNewOrder}>
                    + New order
                </button>
            </div>

            {loading && <div className="muted">Loading…</div>}
            {error && <div className="alert alert--danger">{error}</div>}

            {!loading && !error && orders.length === 0 && (
                <div className="muted">
                    No orders yet. Click <b>+ New order</b>.
                </div>
            )}

            <div className="stack">
                {filteredOrders.map((o) => {
                    const isCash = o.paymentType === "cash";
                    const chatId = o.assignedCourierId ? `${o.id}_${o.assignedCourierId}` : null;

                    return (
                        <div key={o.id} className="card">
                            <div className="card__inner">
                                <div className="row row--between row--wrap">
                                    <div style={{ fontWeight: 950 }}>
                                        Order <span className="mono">#{o.id.slice(0, 6).toUpperCase()}</span>
                                    </div>

                                    <div className="row row--wrap">
                    <span className={`pill pill--${paymentTone(o.paymentType)}`}>
                      {paymentLabel(o.paymentType)}
                    </span>
                                        <span className={`pill pill--${statusTone(o.status)}`}>
                      {statusLabel(o.status)}
                    </span>
                                    </div>
                                </div>

                                <div className="hr" />

                                <div className="subcard">
                                    <div className="kv">
                                        <div className="line">
                                            <span>Customer</span>
                                            <b>{o.customerName || "—"}</b>
                                        </div>

                                        <div className="line" style={{ alignItems: "baseline" }}>
                                            <span>Address</span>
                                            <b style={{ textAlign: "right" }}>{o.customerAddress || "—"}</b>
                                        </div>

                                        {o.customerPhone && (
                                            <div className="line">
                                                <span>Phone</span>
                                                <b>{o.customerPhone}</b>
                                            </div>
                                        )}

                                        <div className="line">
                                            <span>Subtotal</span>
                                            <b>{money(o.orderSubtotal)}</b>
                                        </div>

                                        <div className="line">
                                            <span>Delivery fee</span>
                                            <b>{money(o.deliveryFee)}</b>
                                        </div>

                                        <div className="line">
                                            <span>Total</span>
                                            <b>{money(o.orderTotal)}</b>
                                        </div>

                                        <div className="hr" />

                                        {isCash ? (
                                            <>
                                                <div className="line">
                                                    <span>Courier pays restaurant</span>
                                                    <b>{money(o.courierPaysAtPickup)}</b>
                                                </div>
                                                <div className="line">
                                                    <span>Courier collects from customer</span>
                                                    <b>{money(o.courierCollectsFromCustomer)}</b>
                                                </div>
                                            </>
                                        ) : (
                                            <>
                                                <div className="line">
                                                    <span>Courier collects from customer</span>
                                                    <b>₪0.00</b>
                                                </div>
                                                <div className="line">
                                                    <span>Restaurant pays courier</span>
                                                    <b>{money(o.courierGetsFromRestaurantAtPickup)}</b>
                                                </div>
                                            </>
                                        )}
                                    </div>
                                </div>

                                {tab === "active" && (
                                    <div className="row row--wrap row--mobile-stack" style={{ marginTop: 12 }}>
                                        {o.status !== "delivered" && o.status !== "cancelled" && (
                                            <button
                                                className="btn btn--danger"
                                                onClick={() => cancelOrder(o.id)}
                                                disabled={busyAction === `cancel:${o.id}`}
                                            >
                                                {busyAction === `cancel:${o.id}` ? "Cancelling…" : "Cancel order"}
                                            </button>
                                        )}

                                        {o.status === "taken" && o.assignedCourierId && (
                                            <button
                                                className="btn"
                                                onClick={() => removeCourier(o.id, o.assignedCourierId)}
                                                disabled={busyAction === `remove:${o.id}`}
                                            >
                                                {busyAction === `remove:${o.id}` ? "Removing…" : "Remove courier"}
                                            </button>
                                        )}
                                        {chatId && (
                                            <button className="btn btn--ghost" onClick={() => toggleChat(o.id)}>
                                                {chatOpenByOrderId[o.id] ? "Hide chat" : "Chat"}
                                            </button>
                                        )}
                                        {chatId && chatOpenByOrderId[o.id] && (
                                            <OrderChat
                                                chatId={chatId}
                                                orderId={o.id}
                                                restaurantId={uid}
                                                courierId={o.assignedCourierId!}
                                                myRole="restaurant"
                                                disabled={o.status === "cancelled" || !o.assignedCourierId}
                                            />
                                        )}

                                        {o.assignedCourierId && (
                                            <span className="pill pill--muted">
                        Courier: {(o.assignedCourierId || "").slice(0, 6).toUpperCase()}
                      </span>
                                        )}
                                    </div>
                                )}

                                <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
                                    Created: <b>{formatDate(o.createdAt)}</b>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
