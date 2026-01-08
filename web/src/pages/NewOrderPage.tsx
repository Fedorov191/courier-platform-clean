import { useEffect, useMemo, useState } from "react";
import {
    addDoc,
    collection,
    serverTimestamp,
    query,
    where,
    limit,
    getDocs,
} from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth";
import { auth, db } from "../lib/firebase";
import { Link, useNavigate } from "react-router-dom";
import { geohashForLocation } from "geofire-common";
import { AddressAutocomplete } from "../components/AddressAutocomplete";
import type { AddressSuggestion } from "../components/AddressAutocomplete";

type PaymentType = "cash" | "card";

type FormState = {
    customerName: string;
    customerPhone: string;
    customerAddress: string;

    orderSubtotal: string;
    deliveryFee: string;
    paymentType: PaymentType;

    notes: string;
};

type Errors =
    Partial<Record<keyof FormState, string>> & { customerAddressPick?: string };

function onlyDigits(s: string) {
    return s.replace(/\D/g, "");
}

function toNumber(s: string) {
    const n = Number(String(s).replace(",", "."));
    return Number.isFinite(n) ? n : NaN;
}

export function NewOrderPage() {
    const navigate = useNavigate();

    const [uid, setUid] = useState<string | null>(auth.currentUser?.uid ?? null);
    const [authLoading, setAuthLoading] = useState(true);

    const [loading, setLoading] = useState(false);
    const [submitError, setSubmitError] = useState("");
    const [wasSubmitted, setWasSubmitted] = useState(false);

    const [dropoff, setDropoff] = useState<{
        lat: number | null;
        lng: number | null;
        geohash: string | null;
        label: string | null;
    }>({ lat: null, lng: null, geohash: null, label: null });

    const [form, setForm] = useState<FormState>({
        customerName: "",
        customerPhone: "",
        customerAddress: "",

        orderSubtotal: "",
        deliveryFee: "",
        paymentType: "cash",

        notes: "",
    });

    useEffect(() => {
        const unsub = onAuthStateChanged(auth, (u) => {
            setUid(u?.uid ?? null);
            setAuthLoading(false);
        });
        return () => unsub();
    }, []);

    const update = (key: keyof FormState, value: any) => {
        setForm((prev) => ({ ...prev, [key]: value }));
    };

    const subtotal = toNumber(form.orderSubtotal);
    const fee = toNumber(form.deliveryFee);

    const errors: Errors = useMemo(() => {
        const e: Errors = {};

        if (form.customerName.trim().length < 2) e.customerName = "Укажи имя клиента.";

        const phoneDigits = onlyDigits(form.customerPhone);
        if (phoneDigits.length < 9) e.customerPhone = "Телефон должен содержать минимум 9 цифр (обычно 10).";

        if (form.customerAddress.trim().length < 5) e.customerAddress = "Начни вводить адрес доставки.";
        if (!(dropoff.lat && dropoff.lng && dropoff.geohash))
            e.customerAddressPick = "Выбери адрес из подсказок (чтобы были координаты).";

        if (!Number.isFinite(subtotal) || subtotal <= 0)
            e.orderSubtotal = "Стоимость заказа должна быть > 0 (например 100).";
        if (!Number.isFinite(fee) || fee < 0)
            e.deliveryFee = "Delivery fee должен быть числом (например 20).";

        return e;
    }, [form, subtotal, fee, dropoff.lat, dropoff.lng, dropoff.geohash]);

    const canSubmit = Object.keys(errors).length === 0;
    const orderTotal =
        (Number.isFinite(subtotal) ? subtotal : 0) + (Number.isFinite(fee) ? fee : 0);

    const moneyFlow = useMemo(() => {
        if (!Number.isFinite(subtotal) || !Number.isFinite(fee)) {
            return {
                courierPaysAtPickup: 0,
                courierCollectsFromCustomer: 0,
                courierGetsFromRestaurantAtPickup: 0,
            };
        }

        if (form.paymentType === "cash") {
            return {
                courierPaysAtPickup: subtotal,
                courierCollectsFromCustomer: subtotal + fee,
                courierGetsFromRestaurantAtPickup: 0,
            };
        }

        return {
            courierPaysAtPickup: 0,
            courierCollectsFromCustomer: 0,
            courierGetsFromRestaurantAtPickup: fee,
        };
    }, [form.paymentType, subtotal, fee]);

    async function pickAnyOnlineCourierId(): Promise<string | null> {
        // MVP: берём любого online курьера (без сортировки по расстоянию)
        const q = query(
            collection(db, "courierPublic"),
            where("isOnline", "==", true),
            limit(1)
        );

        const snap = await getDocs(q);
        if (snap.empty) return null;

        // id документа = courierId (мы так пишем в courierPublic/{uid})
        return snap.docs[0].id;
    }

    const onSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitError("");
        setWasSubmitted(true);

        if (!uid) {
            setSubmitError("Нет авторизации. Перелогинься.");
            return;
        }
        if (!canSubmit) return;

        setLoading(true);
        try {
            const orderDoc: any = {
                restaurantId: uid,

                customerName: form.customerName.trim(),
                customerPhone: form.customerPhone.trim(),
                customerAddress: form.customerAddress.trim(),
                notes: form.notes.trim(),

                dropoffLat: dropoff.lat,
                dropoffLng: dropoff.lng,
                dropoffGeohash: dropoff.geohash,
                dropoffAddressText: dropoff.label ?? form.customerAddress.trim(),

                paymentType: form.paymentType,
                orderSubtotal: subtotal,
                deliveryFee: fee,
                orderTotal,

                courierPaysAtPickup: moneyFlow.courierPaysAtPickup,
                courierCollectsFromCustomer: moneyFlow.courierCollectsFromCustomer,
                courierGetsFromRestaurantAtPickup: moneyFlow.courierGetsFromRestaurantAtPickup,

                status: "new",
                assignedCourierId: null,

                acceptedAt: null,
                pickedUpAt: null,
                deliveredAt: null,
                cancelledAt: null,

                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
            };

            // 1) Создаём заказ
            const orderRef = await addDoc(collection(db, "orders"), orderDoc);

            // 2) Ищем любого online курьера
            const courierId = await pickAnyOnlineCourierId();

            // 3) Если нашли — создаём offer
            if (courierId) {
                await addDoc(collection(db, "offers"), {
                    restaurantId: uid,
                    courierId,
                    orderId: orderRef.id,

                    // ✅ snapshot for courier UI (so courier doesn't need to read orders)
                    customerName: orderDoc.customerName,
                    customerPhone: orderDoc.customerPhone,
                    customerAddress: orderDoc.customerAddress,

                    dropoffLat: orderDoc.dropoffLat,
                    dropoffLng: orderDoc.dropoffLng,
                    dropoffGeohash: orderDoc.dropoffGeohash,
                    dropoffAddressText: orderDoc.dropoffAddressText,

                    paymentType: orderDoc.paymentType,
                    orderSubtotal: orderDoc.orderSubtotal,
                    deliveryFee: orderDoc.deliveryFee,
                    orderTotal: orderDoc.orderTotal,

                    courierPaysAtPickup: orderDoc.courierPaysAtPickup,
                    courierCollectsFromCustomer: orderDoc.courierCollectsFromCustomer,
                    courierGetsFromRestaurantAtPickup: orderDoc.courierGetsFromRestaurantAtPickup,

                    status: "pending",
                    createdAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                });

            }

            // 4) Возвращаемся к списку
            navigate("/restaurant/app/orders");
        } catch (err: any) {
            setSubmitError(err?.message ?? "Failed to create order");
        } finally {
            setLoading(false);
        }
    };

    if (authLoading) {
        return (
            <div style={{ padding: 24 }}>
                <h2>New order</h2>
                <div style={{ color: "#888" }}>Checking session…</div>
            </div>
        );
    }

    if (!uid) {
        return (
            <div style={{ padding: 24 }}>
                <h2>New order</h2>
                <div style={{ color: "crimson" }}>Нет авторизации.</div>
                <div style={{ marginTop: 12 }}>
                    <Link to="/restaurant/login">Go to login</Link>
                </div>
            </div>
        );
    }

    const showErrors = wasSubmitted;

    function inputStyle(hasError: boolean) {
        return {
            width: "100%",
            padding: 10,
            borderRadius: 8,
            border: hasError ? "1px solid crimson" : "1px solid #333",
            outline: "none",
        } as const;
    }

    const Hint = ({ text }: { text: string }) => (
        <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>{text}</div>
    );

    const FieldError = ({ text }: { text?: string }) => {
        if (!text) return null;
        return <div style={{ fontSize: 12, color: "crimson", marginTop: 4 }}>{text}</div>;
    };

    function onDropoffPick(s: AddressSuggestion) {
        const gh = geohashForLocation([s.lat, s.lng]);
        setDropoff({ lat: s.lat, lng: s.lng, geohash: gh, label: s.label });
        update("customerAddress", s.label);
    }

    function onDropoffTextChange(v: string) {
        setDropoff({ lat: null, lng: null, geohash: null, label: null });
        update("customerAddress", v);
    }

    return (
        <div style={{ padding: 24, maxWidth: 560, margin: "0 auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <h2 style={{ margin: 0 }}>New order</h2>
                <button
                    onClick={() => navigate("/restaurant/app/orders")}
                    style={{
                        padding: "8px 12px",
                        borderRadius: 10,
                        border: "1px solid #333",
                        cursor: "pointer",
                        height: 38,
                    }}
                >
                    Back
                </button>
            </div>

            <form onSubmit={onSubmit} style={{ display: "grid", gap: 12, marginTop: 16 }}>
                <div>
                    <input
                        placeholder="Customer name"
                        value={form.customerName}
                        onChange={(e) => update("customerName", e.target.value)}
                        style={inputStyle(showErrors && !!errors.customerName)}
                    />
                    <FieldError text={showErrors ? errors.customerName : undefined} />
                </div>

                <div>
                    <input
                        placeholder="Phone (e.g. 052-1234567)"
                        value={form.customerPhone}
                        onChange={(e) => update("customerPhone", e.target.value)}
                        style={inputStyle(showErrors && !!errors.customerPhone)}
                    />
                    <Hint text="Можно с тире/пробелами — проверяем по цифрам." />
                    <FieldError text={showErrors ? errors.customerPhone : undefined} />
                </div>

                <div>
                    <AddressAutocomplete
                        placeholder="Delivery address (start typing...)"
                        value={form.customerAddress}
                        onChangeText={onDropoffTextChange}
                        onPick={onDropoffPick}
                        disabled={loading}
                    />
                    <FieldError text={showErrors ? errors.customerAddress : undefined} />
                    <FieldError text={showErrors ? (errors as any).customerAddressPick : undefined} />
                    <Hint text="Важно: выбери адрес из подсказок — так мы получим координаты для навигатора курьера." />
                </div>

                <hr />

                <div>
                    <label style={{ fontSize: 12, color: "#aaa" }}>Payment type</label>
                    <div style={{ display: "flex", gap: 12, marginTop: 6 }}>
                        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <input
                                type="radio"
                                name="pt"
                                checked={form.paymentType === "cash"}
                                onChange={() => update("paymentType", "cash")}
                            />
                            Cash
                        </label>
                        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <input
                                type="radio"
                                name="pt"
                                checked={form.paymentType === "card"}
                                onChange={() => update("paymentType", "card")}
                            />
                            Card
                        </label>
                    </div>
                    <Hint text="Cash: курьер берёт деньги у клиента. Card: клиент оплатил ресторану, курьер денег у клиента не берёт, а получает deliveryFee в ресторане." />
                </div>

                <div>
                    <input
                        placeholder="Order subtotal (₪) — стоимость еды"
                        value={form.orderSubtotal}
                        onChange={(e) => update("orderSubtotal", e.target.value)}
                        style={inputStyle(showErrors && !!errors.orderSubtotal)}
                    />
                    <FieldError text={showErrors ? errors.orderSubtotal : undefined} />
                </div>

                <div>
                    <input
                        placeholder="Delivery fee (₪) — заработок курьера"
                        value={form.deliveryFee}
                        onChange={(e) => update("deliveryFee", e.target.value)}
                        style={inputStyle(showErrors && !!errors.deliveryFee)}
                    />
                    <FieldError text={showErrors ? errors.deliveryFee : undefined} />
                </div>

                <div style={{ padding: 12, border: "1px solid #333", borderRadius: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ color: "#aaa" }}>Order total</span>
                        <b>₪{Number.isFinite(orderTotal) ? orderTotal.toFixed(2) : "—"}</b>
                    </div>

                    <div style={{ marginTop: 8, fontSize: 13, color: "#ddd" }}>
                        {form.paymentType === "cash" ? (
                            <>
                                <div>
                                    Курьер отдает ресторану при выдаче:{" "}
                                    <b>₪{moneyFlow.courierPaysAtPickup.toFixed(2)}</b>
                                </div>
                                <div>
                                    Курьер берет с клиента:{" "}
                                    <b>₪{moneyFlow.courierCollectsFromCustomer.toFixed(2)}</b>
                                </div>
                                <div>
                                    Курьер оставляет себе (доставка):{" "}
                                    <b>₪{Number.isFinite(fee) ? fee.toFixed(2) : "—"}</b>
                                </div>
                            </>
                        ) : (
                            <>
                                <div>
                                    Курьер берет с клиента: <b>₪0.00</b>
                                </div>
                                <div>
                                    Ресторан выдает курьеру (доставка):{" "}
                                    <b>₪{moneyFlow.courierGetsFromRestaurantAtPickup.toFixed(2)}</b>
                                </div>
                            </>
                        )}
                    </div>
                </div>

                <div>
          <textarea
              placeholder="Notes for courier (optional)"
              value={form.notes}
              onChange={(e) => update("notes", e.target.value)}
              style={{
                  width: "100%",
                  padding: 10,
                  borderRadius: 8,
                  border: "1px solid #333",
                  outline: "none",
                  minHeight: 90,
                  resize: "vertical",
              }}
          />
                    <Hint text="Код домофона, вход, комментарии." />
                </div>

                <button
                    disabled={loading}
                    style={{
                        padding: 12,
                        borderRadius: 10,
                        border: "1px solid #333",
                        cursor: loading ? "not-allowed" : "pointer",
                    }}
                >
                    {loading ? "Creating…" : "Create order (and offer)"}
                </button>

                {!canSubmit && showErrors && (
                    <div style={{ fontSize: 12, color: "crimson" }}>
                        Исправь поля, подсвеченные красным.
                    </div>
                )}

                {submitError && <div style={{ color: "crimson" }}>{submitError}</div>}
            </form>
        </div>
    );
}
