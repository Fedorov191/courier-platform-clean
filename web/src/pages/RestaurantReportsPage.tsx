import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import {
    collection,
    getDocs,
    query,
    where,
    type Timestamp,
} from "firebase/firestore";
import { auth, db } from "../lib/firebase";

type Period = "day" | "month" | "year";

type OrderDoc = {
    id: string;
    restaurantId?: string;

    shortCode?: string;
    publicCode?: string;
    codeDateKey?: string;

    customerName?: string;
    customerPhone?: string;
    customerAddress?: string;
    dropoffAddressText?: string;
    pickupAddressText?: string;
    notes?: string;

    paymentType?: "cash" | "card";
    orderSubtotal?: number;
    deliveryFee?: number;
    orderTotal?: number;

    courierPaysAtPickup?: number;
    courierCollectsFromCustomer?: number;
    courierGetsFromRestaurantAtPickup?: number;

    assignedCourierId?: string | null;

    createdAt?: Timestamp;
    acceptedAt?: Timestamp;
    pickedUpAt?: Timestamp;
    deliveredAt?: Timestamp;

    deliveredDateKey?: string;
    deliveredMonthKey?: string;
    deliveredYearKey?: string;

    status?: string;
};

function israelNowKeys(d = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Jerusalem",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(d);

    const y = parts.find((p) => p.type === "year")?.value ?? "0000";
    const m = parts.find((p) => p.type === "month")?.value ?? "00";
    const day = parts.find((p) => p.type === "day")?.value ?? "00";

    return {
        dateKey: `${y}-${m}-${day}`,
        monthKey: `${y}-${m}`,
        yearKey: `${y}`,
    };
}

function money(n?: number) {
    const x = typeof n === "number" && Number.isFinite(n) ? n : 0;
    return `₪${x.toFixed(2)}`;
}

function tsToText(ts?: Timestamp) {
    if (!ts) return "—";
    return ts.toDate().toLocaleString();
}

export function RestaurantReportsPage() {
    const [uid, setUid] = useState<string | null>(auth.currentUser?.uid ?? null);

    const nowKeys = useMemo(() => israelNowKeys(new Date()), []);
    const [period, setPeriod] = useState<Period>("day");
    const [key, setKey] = useState<string>(nowKeys.dateKey);

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string>("");

    const [orders, setOrders] = useState<OrderDoc[]>([]);

    useEffect(() => {
        const unsub = onAuthStateChanged(auth, (u) => setUid(u?.uid ?? null));
        return () => unsub();
    }, []);

    // когда меняем period — подставляем “сегодня/этот месяц/этот год”
    useEffect(() => {
        if (period === "day") setKey(nowKeys.dateKey);
        if (period === "month") setKey(nowKeys.monthKey);
        if (period === "year") setKey(nowKeys.yearKey);
    }, [period, nowKeys.dateKey, nowKeys.monthKey, nowKeys.yearKey]);

    useEffect(() => {
        if (!uid) return;

        async function load() {
            setLoading(true);
            setError("");
            setOrders([]);

            try {
                const keyField =
                    period === "day"
                        ? "deliveredDateKey"
                        : period === "month"
                            ? "deliveredMonthKey"
                            : "deliveredYearKey";

                const q = query(
                    collection(db, "orders"),
                    where("restaurantId", "==", uid),
                    where("status", "==", "delivered"),
                    where(keyField, "==", key)
                );

                const snap = await getDocs(q);
                const list: OrderDoc[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));

                // сортируем на клиенте (чтобы меньше мучиться с индексами)
                list.sort((a, b) => (b.deliveredAt?.seconds ?? 0) - (a.deliveredAt?.seconds ?? 0));

                setOrders(list);
            } catch (e: any) {
                setError(e?.message ?? "Failed to load report");
            } finally {
                setLoading(false);
            }
        }

        load();
    }, [uid, period, key]);

    const totals = useMemo(() => {
        return orders.reduce(
            (acc, o) => {
                acc.count += 1;
                acc.subtotal += Number(o.orderSubtotal ?? 0);
                acc.fee += Number(o.deliveryFee ?? 0);
                acc.total += Number(o.orderTotal ?? 0);

                acc.cashCount += o.paymentType === "cash" ? 1 : 0;
                acc.cardCount += o.paymentType === "card" ? 1 : 0;

                acc.cashCourierPays += Number(o.courierPaysAtPickup ?? 0);
                acc.cashCourierCollects += Number(o.courierCollectsFromCustomer ?? 0);
                acc.cardRestaurantPaysCourier += Number(o.courierGetsFromRestaurantAtPickup ?? 0);
                return acc;
            },
            {
                count: 0,
                subtotal: 0,
                fee: 0,
                total: 0,
                cashCount: 0,
                cardCount: 0,
                cashCourierPays: 0,
                cashCourierCollects: 0,
                cardRestaurantPaysCourier: 0,
            }
        );
    }, [orders]);

    return (
        <div className="card">
            <div className="card__inner">
                <div className="row row--between row--wrap">
                    <h2 style={{ margin: 0 }}>Reports (Restaurant)</h2>
                    <span className="pill pill--muted">Delivered only</span>
                </div>

                <div className="hr" />

                <div className="row row--wrap row--mobile-stack" style={{ gap: 12 }}>
                    <label className="row row--wrap" style={{ gap: 8, alignItems: "center" }}>
                        <span className="muted">Period</span>
                        <select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
                            <option value="day">Day</option>
                            <option value="month">Month</option>
                            <option value="year">Year</option>
                        </select>
                    </label>

                    {period === "day" && (
                        <label className="row row--wrap" style={{ gap: 8, alignItems: "center" }}>
                            <span className="muted">Date</span>
                            <input type="date" value={key} onChange={(e) => setKey(e.target.value)} />
                        </label>
                    )}

                    {period === "month" && (
                        <label className="row row--wrap" style={{ gap: 8, alignItems: "center" }}>
                            <span className="muted">Month</span>
                            <input type="month" value={key} onChange={(e) => setKey(e.target.value)} />
                        </label>
                    )}

                    {period === "year" && (
                        <label className="row row--wrap" style={{ gap: 8, alignItems: "center" }}>
                            <span className="muted">Year</span>
                            <input
                                type="number"
                                value={key}
                                onChange={(e) => setKey(e.target.value)}
                                min={2000}
                                max={2100}
                                style={{ width: 120 }}
                            />
                        </label>
                    )}
                </div>

                <div style={{ height: 12 }} />

                {loading && <div className="muted">Loading report…</div>}
                {error && <div className="alert alert--danger">{error}</div>}

                {!loading && !error && (
                    <>
                        <div className="subcard">
                            <div className="kv">
                                <div className="line">
                                    <span>Orders delivered</span>
                                    <b>{totals.count}</b>
                                </div>
                                <div className="line">
                                    <span>Subtotal sum</span>
                                    <b>{money(totals.subtotal)}</b>
                                </div>
                                <div className="line">
                                    <span>Delivery fee sum</span>
                                    <b>{money(totals.fee)}</b>
                                </div>
                                <div className="line">
                                    <span>Total sum</span>
                                    <b>{money(totals.total)}</b>
                                </div>

                                <div className="hr" />

                                <div className="line">
                                    <span>Cash orders</span>
                                    <b>{totals.cashCount}</b>
                                </div>
                                <div className="line">
                                    <span>Card orders</span>
                                    <b>{totals.cardCount}</b>
                                </div>

                                <div className="hr" />

                                <div className="line">
                                    <span>(Cash) Courier pays restaurant</span>
                                    <b>{money(totals.cashCourierPays)}</b>
                                </div>
                                <div className="line">
                                    <span>(Cash) Courier collects from customer</span>
                                    <b>{money(totals.cashCourierCollects)}</b>
                                </div>
                                <div className="line">
                                    <span>(Card) Restaurant pays courier</span>
                                    <b>{money(totals.cardRestaurantPaysCourier)}</b>
                                </div>
                            </div>
                        </div>

                        <div style={{ height: 12 }} />

                        {orders.length === 0 ? (
                            <div className="muted">No delivered orders for выбранный период.</div>
                        ) : (
                            <div className="stack">
                                {orders.map((o) => {
                                    const code =
                                        typeof o.shortCode === "string" && o.shortCode ? o.shortCode : o.id.slice(0, 6).toUpperCase();

                                    return (
                                        <div key={o.id} className="subcard">
                                            <div className="row row--between row--wrap">
                                                <div style={{ fontWeight: 900 }}>
                                                    Order <span className="mono">#{code}</span>
                                                    {o.publicCode ? <span className="muted"> · {o.publicCode}</span> : null}
                                                </div>
                                                <span className={`pill ${o.paymentType === "cash" ? "pill--muted" : "pill--info"}`}>
                          {(o.paymentType ?? "—").toUpperCase()}
                        </span>
                                            </div>

                                            <div className="kv" style={{ marginTop: 10 }}>
                                                <div className="line">
                                                    <span>Delivered at</span>
                                                    <b>{tsToText(o.deliveredAt)}</b>
                                                </div>
                                                <div className="line">
                                                    <span>Customer</span>
                                                    <b>{o.customerName ?? "—"}</b>
                                                </div>
                                                <div className="line" style={{ alignItems: "baseline" }}>
                                                    <span>Address</span>
                                                    <b style={{ textAlign: "right" }}>{o.dropoffAddressText ?? o.customerAddress ?? "—"}</b>
                                                </div>
                                                <div className="line">
                                                    <span>Total</span>
                                                    <b>{money(o.orderTotal)}</b>
                                                </div>
                                                <div className="line">
                                                    <span>Fee</span>
                                                    <b>{money(o.deliveryFee)}</b>
                                                </div>
                                            </div>

                                            <details style={{ marginTop: 10 }}>
                                                <summary className="muted" style={{ cursor: "pointer" }}>All fields</summary>
                                                <div style={{ marginTop: 10 }} className="kv">
                                                    <div className="line"><span>Order ID</span><b className="mono">{o.id}</b></div>
                                                    <div className="line"><span>Courier</span><b className="mono">{(o.assignedCourierId ?? "—")}</b></div>
                                                    <div className="line"><span>Phone</span><b>{o.customerPhone ?? "—"}</b></div>
                                                    <div className="line"><span>Pickup</span><b style={{ textAlign: "right" }}>{o.pickupAddressText ?? "—"}</b></div>
                                                    <div className="line"><span>Notes</span><b style={{ textAlign: "right" }}>{o.notes ?? "—"}</b></div>

                                                    <div className="hr" />

                                                    <div className="line"><span>Subtotal</span><b>{money(o.orderSubtotal)}</b></div>
                                                    <div className="line"><span>Courier pays at pickup</span><b>{money(o.courierPaysAtPickup)}</b></div>
                                                    <div className="line"><span>Courier collects from customer</span><b>{money(o.courierCollectsFromCustomer)}</b></div>
                                                    <div className="line"><span>Courier gets from restaurant</span><b>{money(o.courierGetsFromRestaurantAtPickup)}</b></div>

                                                    <div className="hr" />

                                                    <div className="line"><span>Created at</span><b>{tsToText(o.createdAt)}</b></div>
                                                    <div className="line"><span>Accepted at</span><b>{tsToText(o.acceptedAt)}</b></div>
                                                    <div className="line"><span>Picked up at</span><b>{tsToText(o.pickedUpAt)}</b></div>
                                                </div>
                                            </details>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
