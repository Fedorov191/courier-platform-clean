import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { collection, onSnapshot, orderBy, query, where, Timestamp } from "firebase/firestore";
import { auth, db } from "../lib/firebase";
import { useNavigate } from "react-router-dom";

type OrderStatus = "new" | "taken" | "picked_up" | "delivered" | "cancelled";
type PaymentMethod = "cash" | "card";

type OrderDoc = {
    id: string;
    restaurantId: string;

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
    createdAt?: Timestamp;
};

function formatDate(ts?: Timestamp) {
    if (!ts) return "—";
    return ts.toDate().toLocaleString();
}

function statusLabel(s: OrderStatus) {
    switch (s) {
        case "new": return "NEW";
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

    useEffect(() => {
        const unsub = onAuthStateChanged(auth, (u) => setUid(u?.uid ?? null));
        return () => unsub();
    }, []);

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

    const goNewOrder = () => navigate("/restaurant/app/orders/new");

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
                {orders.map((o) => {
                    const isCash = o.paymentType === "cash";

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
