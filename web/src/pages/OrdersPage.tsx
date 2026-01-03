import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import {
    collection,
    onSnapshot,
    orderBy,
    query,
    where,
    Timestamp,
} from "firebase/firestore";
import { auth, db } from "../lib/firebase";
import { useNavigate } from "react-router-dom";

type OrderStatus = "new" | "taken" | "delivered" | "cancelled";
type PaymentMethod = "cash" | "card";

type OrderDoc = {
    id: string;
    restaurantId: string;

    customerName: string;
    deliveryAddress: string;
    phone?: string;
    note?: string;

    paymentMethod: PaymentMethod;

    itemsTotal: number;
    deliveryFee: number;
    orderTotal: number;

    // Денежная логика по твоим правилам:
    // CASH: collectFromCustomer = orderTotal, courierOwesRestaurant = itemsTotal, restaurantPaysCourier = 0
    // CARD: collectFromCustomer = 0, courierOwesRestaurant = 0, restaurantPaysCourier = deliveryFee
    collectFromCustomer: number;
    courierOwesRestaurant: number;
    restaurantPaysCourier: number;

    status: OrderStatus;
    createdAt?: Timestamp;
};

function formatDate(ts?: Timestamp) {
    if (!ts) return "—";
    const d = ts.toDate();
    return d.toLocaleString();
}

function statusLabel(s: OrderStatus) {
    switch (s) {
        case "new":
            return "NEW";
        case "taken":
            return "TAKEN";
        case "delivered":
            return "DELIVERED";
        case "cancelled":
            return "CANCELLED";
        default:
            return s;
    }
}

function paymentLabel(p: PaymentMethod) {
    return p === "cash" ? "CASH" : "CARD";
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
        const unsub = onAuthStateChanged(auth, (u) => {
            setUid(u?.uid ?? null);
        });
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
                        deliveryAddress: data.deliveryAddress ?? "",
                        phone: data.phone ?? "",
                        note: data.note ?? "",

                        paymentMethod: (data.paymentMethod ?? "cash") as PaymentMethod,

                        itemsTotal: Number(data.itemsTotal ?? 0),
                        deliveryFee: Number(data.deliveryFee ?? 0),
                        orderTotal: Number(data.orderTotal ?? 0),

                        collectFromCustomer: Number(data.collectFromCustomer ?? 0),
                        courierOwesRestaurant: Number(data.courierOwesRestaurant ?? 0),
                        restaurantPaysCourier: Number(data.restaurantPaysCourier ?? 0),

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
        const byStatus = orders.reduce(
            (acc, o) => {
                acc[o.status] = (acc[o.status] ?? 0) + 1;
                return acc;
            },
            {} as Record<OrderStatus, number>
        );
        return { total, byStatus };
    }, [orders]);

    const goNewOrder = () => {
        navigate("/app/orders/new");
    };

    if (!uid) {
        return (
            <div style={{ padding: 24 }}>
                <h2>Orders</h2>
                <div style={{ color: "crimson" }}>Нет авторизации. Перейди на логин.</div>
            </div>
        );
    }

    return (
        <div style={{ padding: 24, maxWidth: 980 }}>
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    marginBottom: 16,
                }}
            >
                <div>
                    <h2 style={{ margin: 0 }}>Orders</h2>
                    <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>
                        Total: {stats.total} · NEW: {stats.byStatus.new ?? 0} · TAKEN:{" "}
                        {stats.byStatus.taken ?? 0} · DELIVERED: {stats.byStatus.delivered ?? 0}
                    </div>
                </div>

                <button
                    onClick={goNewOrder}
                    style={{
                        padding: "10px 14px",
                        borderRadius: 10,
                        border: "1px solid #333",
                        cursor: "pointer",
                    }}
                >
                    + New order
                </button>
            </div>

            {loading && <div>Loading…</div>}
            {error && <div style={{ color: "crimson" }}>{error}</div>}

            {!loading && !error && orders.length === 0 && (
                <div style={{ color: "#888" }}>
                    Пока заказов нет. Нажми <b>+ New order</b>.
                </div>
            )}

            <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
                {orders.map((o) => {
                    const isCash = o.paymentMethod === "cash";

                    return (
                        <div
                            key={o.id}
                            style={{
                                border: "1px solid #333",
                                borderRadius: 12,
                                padding: 14,
                                display: "grid",
                                gap: 8,
                            }}
                        >
                            {/* Header */}
                            <div
                                style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "baseline",
                                    gap: 12,
                                }}
                            >
                                <div style={{ fontWeight: 700 }}>
                                    Order #{o.id.slice(0, 6).toUpperCase()}
                                </div>

                                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                    <div
                                        style={{
                                            fontSize: 12,
                                            padding: "4px 8px",
                                            borderRadius: 999,
                                            border: "1px solid #555",
                                        }}
                                    >
                                        {paymentLabel(o.paymentMethod)}
                                    </div>

                                    <div
                                        style={{
                                            fontSize: 12,
                                            padding: "4px 8px",
                                            borderRadius: 999,
                                            border: "1px solid #555",
                                        }}
                                    >
                                        {statusLabel(o.status)}
                                    </div>
                                </div>
                            </div>

                            {/* Customer */}
                            <div style={{ fontSize: 14 }}>
                                <b>Customer:</b> {o.customerName || "—"}
                            </div>

                            <div style={{ fontSize: 14 }}>
                                <b>Address:</b> {o.deliveryAddress || "—"}
                            </div>

                            {o.phone && (
                                <div style={{ fontSize: 14 }}>
                                    <b>Phone:</b> {o.phone}
                                </div>
                            )}

                            {o.note && (
                                <div style={{ fontSize: 13, color: "#aaa" }}>
                                    <b>Note:</b> {o.note}
                                </div>
                            )}

                            {/* Money block */}
                            <div
                                style={{
                                    padding: 12,
                                    border: "1px dashed #555",
                                    borderRadius: 12,
                                    display: "grid",
                                    gap: 6,
                                }}
                            >
                                <div style={{ display: "flex", justifyContent: "space-between" }}>
                                    <span style={{ color: "#aaa" }}>Items</span>
                                    <b>{money(o.itemsTotal)}</b>
                                </div>

                                <div style={{ display: "flex", justifyContent: "space-between" }}>
                                    <span style={{ color: "#aaa" }}>Delivery</span>
                                    <b>{money(o.deliveryFee)}</b>
                                </div>

                                <div style={{ display: "flex", justifyContent: "space-between" }}>
                                    <span style={{ color: "#aaa" }}>Total</span>
                                    <b>{money(o.orderTotal)}</b>
                                </div>

                                <hr style={{ borderColor: "#333", width: "100%" }} />

                                {isCash ? (
                                    <>
                                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                                            <span style={{ color: "#aaa" }}>Courier collects from customer</span>
                                            <b>{money(o.collectFromCustomer)}</b>
                                        </div>

                                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                                            <span style={{ color: "#aaa" }}>Courier pays restaurant (items)</span>
                                            <b>{money(o.courierOwesRestaurant)}</b>
                                        </div>

                                        <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>
                                            Rule: CASH → courier pays <b>items</b> to restaurant when picking up the order.
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                                            <span style={{ color: "#aaa" }}>Courier collects from customer</span>
                                            <b>{money(o.collectFromCustomer)}</b>
                                        </div>

                                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                                            <span style={{ color: "#aaa" }}>Restaurant pays courier (delivery)</span>
                                            <b>{money(o.restaurantPaysCourier)}</b>
                                        </div>

                                        <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>
                                            Rule: CARD → customer pays restaurant online, courier gets delivery fee from restaurant.
                                        </div>
                                    </>
                                )}
                            </div>

                            {/* Footer */}
                            <div
                                style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    marginTop: 2,
                                    color: "#aaa",
                                    fontSize: 12,
                                }}
                            >
                                <div>
                                    <b>Created:</b> {formatDate(o.createdAt)}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
