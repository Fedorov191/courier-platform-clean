import { useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import {
    addDoc,
    collection,
    doc,
    getDoc,
    getDocs,
    limit,
    onSnapshot,
    orderBy,
    query,
    serverTimestamp,
    Timestamp,
    updateDoc,
    where,
} from "firebase/firestore";
import { auth, db } from "../lib/firebase";
import { useNavigate } from "react-router-dom";

type OrderStatus = "new" | "offered" | "taken" | "delivered" | "cancelled";
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
    assignedCourierId: string | null;

    // офферы
    activeOfferId: string | null;
    offerCourierId: string | null;
    offerExpiresAt: Timestamp | null;

    createdAt?: Timestamp;
};

function formatDate(ts?: Timestamp) {
    if (!ts) return "—";
    return ts.toDate().toLocaleString();
}

function statusLabel(s: OrderStatus) {
    return s.toUpperCase();
}

function paymentLabel(p: PaymentMethod) {
    return p === "cash" ? "CASH" : "CARD";
}

function money(n: number) {
    const x = Number.isFinite(n) ? n : 0;
    return `₪${x.toFixed(2)}`;
}

async function pickOnlineCourierId(excludeCourierId?: string | null): Promise<string | null> {
    let qy = query(collection(db, "courierPublic"), where("isOnline", "==", true), limit(10));
    const snap = await getDocs(qy);
    const ids = snap.docs.map((d) => d.id).filter((id) => id !== excludeCourierId);
    return ids[0] ?? null;
}

async function hasPendingOffer(orderId: string): Promise<boolean> {
    const qy = query(
        collection(db, "offers"),
        where("orderId", "==", orderId),
        where("status", "==", "pending"),
        limit(1)
    );
    const snap = await getDocs(qy);
    return !snap.empty;
}

export function OrdersPage() {
    const navigate = useNavigate();

    const [uid, setUid] = useState<string | null>(auth.currentUser?.uid ?? null);
    const [loading, setLoading] = useState(true);
    const [orders, setOrders] = useState<OrderDoc[]>([]);
    const [error, setError] = useState<string>("");

    // чтобы не стрелять переоффером по одному заказу много раз параллельно
    const inFlight = useRef<Record<string, boolean>>({});

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

        const qy = query(
            collection(db, "orders"),
            where("restaurantId", "==", uid),
            orderBy("createdAt", "desc")
        );

        const unsub = onSnapshot(
            qy,
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
                        assignedCourierId: data.assignedCourierId ?? null,

                        activeOfferId: data.activeOfferId ?? null,
                        offerCourierId: data.offerCourierId ?? null,
                        offerExpiresAt: data.offerExpiresAt ?? null,

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

    // ✅ Авто-переоффер (работает, пока открыта вкладка ресторана)
    useEffect(() => {
        if (!uid) return;
        const now = Date.now();

        const candidates = orders.filter((o) => {
            if (o.assignedCourierId) return false;
            if (!(o.status === "new" || o.status === "offered")) return false;

            // если нет активного оффера — надо предложить
            if (!o.activeOfferId || !o.offerExpiresAt) return true;

            // если истёк — надо предложить заново
            return (o.offerExpiresAt?.toMillis?.() ?? 0) <= now;
        });

        candidates.forEach((o) => {
            if (inFlight.current[o.id]) return;
            inFlight.current[o.id] = true;

            (async () => {
                try {
                    // 1) анти-дубль: если уже есть pending offer — ничего не делаем
                    const pendingExists = await hasPendingOffer(o.id);
                    if (pendingExists) return;

                    // 2) берём курьера online (не того же самого, кому только что предлагали — по возможности)
                    const courierId = await pickOnlineCourierId(o.offerCourierId);
                    if (!courierId) return; // нет online — останется “waiting”, проверим позже

                    // 3) читаем заказ свежий (на случай гонок)
                    const orderRef = doc(db, "orders", o.id);
                    const fresh = await getDoc(orderRef);
                    if (!fresh.exists()) return;
                    const ord = fresh.data() as any;
                    if (ord.assignedCourierId) return;

                    // 4) создаём offer
                    const expiresAt = Timestamp.fromMillis(Date.now() + 25_000);

                    const offerRef = await addDoc(collection(db, "offers"), {
                        orderId: o.id,
                        restaurantId: uid,
                        courierId,
                        status: "pending",
                        createdAt: serverTimestamp(),
                        updatedAt: serverTimestamp(),
                        expiresAt,

                        dropoffAddressText: ord.dropoffAddressText ?? o.customerAddress ?? "",
                        dropoffLat: Number(ord.dropoffLat ?? 0),
                        dropoffLng: Number(ord.dropoffLng ?? 0),

                        paymentType: ord.paymentType ?? o.paymentType,
                        orderSubtotal: Number(ord.orderSubtotal ?? o.orderSubtotal),
                        deliveryFee: Number(ord.deliveryFee ?? o.deliveryFee),
                        orderTotal: Number(ord.orderTotal ?? o.orderTotal),

                        courierPaysAtPickup: Number(ord.courierPaysAtPickup ?? o.courierPaysAtPickup),
                        courierCollectsFromCustomer: Number(ord.courierCollectsFromCustomer ?? o.courierCollectsFromCustomer),
                        courierGetsFromRestaurantAtPickup: Number(ord.courierGetsFromRestaurantAtPickup ?? o.courierGetsFromRestaurantAtPickup),

                        customerName: ord.customerName ?? o.customerName,
                        customerPhone: ord.customerPhone ?? o.customerPhone ?? "",
                        notes: ord.notes ?? o.notes ?? "",
                    });

                    // 5) обновляем заказ
                    await updateDoc(orderRef, {
                        status: "offered",
                        activeOfferId: offerRef.id,
                        offerCourierId: courierId,
                        offerExpiresAt: expiresAt,
                        updatedAt: serverTimestamp(),
                    } as any);
                } finally {
                    inFlight.current[o.id] = false;
                }
            })().catch(() => {
                inFlight.current[o.id] = false;
            });
        });
    }, [orders, uid]);

    const stats = useMemo(() => {
        const total = orders.length;
        const byStatus = orders.reduce((acc, o) => {
            acc[o.status] = (acc[o.status] ?? 0) + 1;
            return acc;
        }, {} as Record<OrderStatus, number>);
        return { total, byStatus };
    }, [orders]);

    const goNewOrder = () => {
        navigate("/restaurant/app/orders/new");
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
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
                <div>
                    <h2 style={{ margin: 0 }}>Orders</h2>
                    <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>
                        Total: {stats.total} · NEW: {stats.byStatus.new ?? 0} · OFFERED: {stats.byStatus.offered ?? 0} · TAKEN:{" "}
                        {stats.byStatus.taken ?? 0}
                    </div>
                </div>

                <button
                    onClick={goNewOrder}
                    style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #333", cursor: "pointer" }}
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
                    const isCash = o.paymentType === "cash";

                    return (
                        <div key={o.id} style={{ border: "1px solid #333", borderRadius: 12, padding: 14, display: "grid", gap: 8 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                                <div style={{ fontWeight: 700 }}>Order #{o.id.slice(0, 6).toUpperCase()}</div>

                                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                    <div style={{ fontSize: 12, padding: "4px 8px", borderRadius: 999, border: "1px solid #555" }}>
                                        {paymentLabel(o.paymentType)}
                                    </div>
                                    <div style={{ fontSize: 12, padding: "4px 8px", borderRadius: 999, border: "1px solid #555" }}>
                                        {statusLabel(o.status)}
                                    </div>
                                </div>
                            </div>

                            <div style={{ fontSize: 14 }}>
                                <b>Customer:</b> {o.customerName || "—"}
                            </div>

                            <div style={{ fontSize: 14 }}>
                                <b>Address:</b> {o.customerAddress || "—"}
                            </div>

                            {o.customerPhone && (
                                <div style={{ fontSize: 14 }}>
                                    <b>Phone:</b> {o.customerPhone}
                                </div>
                            )}

                            {o.notes && (
                                <div style={{ fontSize: 13, color: "#aaa" }}>
                                    <b>Note:</b> {o.notes}
                                </div>
                            )}

                            <div style={{ padding: 12, border: "1px dashed #555", borderRadius: 12, display: "grid", gap: 6 }}>
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

                                <hr style={{ borderColor: "#333", width: "100%" }} />

                                {isCash ? (
                                    <>
                                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                                            <span style={{ color: "#aaa" }}>Courier pays restaurant at pickup</span>
                                            <b>{money(o.courierPaysAtPickup)}</b>
                                        </div>

                                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                                            <span style={{ color: "#aaa" }}>Courier collects from customer</span>
                                            <b>{money(o.courierCollectsFromCustomer)}</b>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                                            <span style={{ color: "#aaa" }}>Courier collects from customer</span>
                                            <b>₪0.00</b>
                                        </div>

                                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                                            <span style={{ color: "#aaa" }}>Restaurant pays courier at pickup</span>
                                            <b>{money(o.courierGetsFromRestaurantAtPickup)}</b>
                                        </div>
                                    </>
                                )}
                            </div>

                            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2, color: "#aaa", fontSize: 12 }}>
                                <div>
                                    <b>Created:</b> {formatDate(o.createdAt)}
                                </div>
                                <div>
                                    <b>Offer expires:</b>{" "}
                                    {o.offerExpiresAt ? o.offerExpiresAt.toDate().toLocaleTimeString() : "—"}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
