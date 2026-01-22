import { useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth, db, functions } from "../lib/firebase";
import {
    collection,
    doc,
    getDoc,
    runTransaction,
    serverTimestamp,
    setDoc,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { Link, useNavigate } from "react-router-dom";
import { geohashForLocation } from "geofire-common";
import { AddressAutocomplete } from "../components/AddressAutocomplete";
import type { AddressSuggestion } from "../components/AddressAutocomplete";

type PaymentType = "cash" | "card";
type PrepTimeMin = 20 | 30 | 40;

type FormState = {
    customerName: string;
    customerPhone: string;
    customerAddress: string;

    orderSubtotal: string;
    paymentType: PaymentType;

    // один комментарий только по доставке (домофон/подъезд/оставить у двери)
    notes: string;
};

type Errors =
    Partial<Record<keyof FormState, string>> & {
    customerAddressPick?: string;
    quote?: string;
};

type RouteQuote = {
    distanceMeters: number;
    distanceKm: number;
    durationSeconds: number;
    deliveryFee: number;
    currency?: string;
    pricingVersion?: string;
};

function onlyDigits(s: string) {
    return s.replace(/\D/g, "");
}

function israelDateKey(d = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Jerusalem",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(d);

    const y = parts.find((p) => p.type === "year")?.value ?? "0000";
    const m = parts.find((p) => p.type === "month")?.value ?? "00";
    const day = parts.find((p) => p.type === "day")?.value ?? "00";
    return `${y}-${m}-${day}`; // YYYY-MM-DD
}

function toNumber(s: string) {
    const n = Number(String(s).replace(",", "."));
    return Number.isFinite(n) ? n : NaN;
}

function money(n?: number) {
    const x = typeof n === "number" && Number.isFinite(n) ? n : 0;
    return `₪${x.toFixed(2)}`;
}

export function NewOrderPage() {
    const navigate = useNavigate();

    const [uid, setUid] = useState<string | null>(auth.currentUser?.uid ?? null);
    const [authLoading, setAuthLoading] = useState(true);

    const [loading, setLoading] = useState(false);
    const [submitError, setSubmitError] = useState("");
    const [wasSubmitted, setWasSubmitted] = useState(false);

    const [prepTimeMin, setPrepTimeMin] = useState<PrepTimeMin>(20);

    const [dropoff, setDropoff] = useState<{
        lat: number | null;
        lng: number | null;
        geohash: string | null;
        label: string | null;
    }>({ lat: null, lng: null, geohash: null, label: null });

    const [pickup, setPickup] = useState<{
        lat: number | null;
        lng: number | null;
        geohash: string | null;
        label: string | null;
    }>({ lat: null, lng: null, geohash: null, label: null });

    const [pickupLoaded, setPickupLoaded] = useState(false);
    const [pickupSaving, setPickupSaving] = useState(false);
    const [pickupSaveError, setPickupSaveError] = useState<string>("");

    const [form, setForm] = useState<FormState>({
        customerName: "",
        customerPhone: "",
        customerAddress: "",
        orderSubtotal: "",
        paymentType: "cash",
        notes: "",
    });

    // =========================
    // Route quote (fee by route)
    // =========================
    const [quote, setQuote] = useState<RouteQuote | null>(null);
    const [quoteLoading, setQuoteLoading] = useState(false);
    const [quoteError, setQuoteError] = useState("");

    const quoteReqIdRef = useRef(0);

    useEffect(() => {
        const unsub = onAuthStateChanged(auth, (u) => {
            setUid(u?.uid ?? null);
            setAuthLoading(false);
        });
        return () => unsub();
    }, []);

    // load restaurant pickup location
    useEffect(() => {
        let cancelled = false;

        async function loadPickup() {
            if (!uid) return;

            try {
                const snap = await getDoc(doc(db, "restaurants", uid));
                const data: any = snap.exists() ? snap.data() : null;

                const lat = data?.pickupLat ?? null;
                const lng = data?.pickupLng ?? null;
                const geohash =
                    data?.pickupGeohash ??
                    (typeof lat === "number" && typeof lng === "number"
                        ? geohashForLocation([lat, lng])
                        : null);

                const label = data?.pickupAddressText ?? data?.address ?? null;

                if (!cancelled) {
                    setPickup({ lat, lng, geohash, label });
                    setPickupLoaded(true);
                }
            } catch (e: any) {
                if (!cancelled) {
                    setPickupLoaded(true);
                    setPickupSaveError(e?.message ?? "Failed to load restaurant pickup location");
                }
            }
        }

        loadPickup();
        return () => {
            cancelled = true;
        };
    }, [uid]);

    // Re-calc quote when we have both coords
    useEffect(() => {
        let cancelled = false;

        async function run() {
            setQuoteError("");

            const hasPickup = typeof pickup.lat === "number" && typeof pickup.lng === "number";
            const hasDropoff = typeof dropoff.lat === "number" && typeof dropoff.lng === "number";

            if (!hasPickup || !hasDropoff) {
                setQuote(null);
                return;
            }

            const reqId = ++quoteReqIdRef.current;
            setQuoteLoading(true);

            try {
                const fn = httpsCallable(functions, "getRouteQuote");
                const res: any = await fn({
                    origin: { lat: pickup.lat, lng: pickup.lng },
                    destination: { lat: dropoff.lat, lng: dropoff.lng },
                });

                if (cancelled) return;
                if (reqId !== quoteReqIdRef.current) return;

                setQuote(res.data as RouteQuote);
            } catch (e: any) {
                if (cancelled) return;
                setQuote(null);
                setQuoteError(e?.message ?? "Failed to calculate route / delivery fee");
            } finally {
                if (!cancelled) setQuoteLoading(false);
            }
        }

        run();
        return () => {
            cancelled = true;
        };
    }, [pickup.lat, pickup.lng, dropoff.lat, dropoff.lng]);

    const update = (key: keyof FormState, value: any) => {
        setForm((prev) => ({ ...prev, [key]: value }));
    };

    const subtotal = toNumber(form.orderSubtotal);
    const fee = typeof quote?.deliveryFee === "number" ? quote.deliveryFee : NaN;

    const errors: Errors = useMemo(() => {
        const e: Errors = {};

        if (form.customerName.trim().length < 2) e.customerName = "Укажи имя клиента.";

        const phoneDigits = onlyDigits(form.customerPhone);
        if (phoneDigits.length < 9) e.customerPhone = "Телефон должен содержать минимум 9 цифр (обычно 10).";

        if (form.customerAddress.trim().length < 5) e.customerAddress = "Начни вводить адрес доставки.";
        if (!(dropoff.lat && dropoff.lng && dropoff.geohash)) {
            e.customerAddressPick = "Выбери адрес из подсказок (чтобы были координаты).";
        }

        if (!Number.isFinite(subtotal) || subtotal <= 0) {
            e.orderSubtotal = "Стоимость заказа должна быть > 0 (например 100).";
        }

        // quote обязателен, если адрес выбран
        const hasPickup = typeof pickup.lat === "number" && typeof pickup.lng === "number";
        const hasDropoff = typeof dropoff.lat === "number" && typeof dropoff.lng === "number";
        if (hasPickup && hasDropoff && !quoteLoading) {
            if (!quote || !Number.isFinite(fee) || fee < 0) {
                e.quote = quoteError || "Не удалось рассчитать доставку по маршруту.";
            }
        }

        return e;
    }, [
        form.customerName,
        form.customerPhone,
        form.customerAddress,
        form.orderSubtotal,
        dropoff.lat,
        dropoff.lng,
        dropoff.geohash,
        pickup.lat,
        pickup.lng,
        quote,
        quoteLoading,
        quoteError,
        subtotal,
        fee,
    ]);

    const canSubmit =
        Object.keys(errors).length === 0 &&
        !quoteLoading &&
        !!quote &&
        Number.isFinite(subtotal) &&
        subtotal > 0 &&
        Number.isFinite(fee) &&
        fee >= 0;

    const orderTotal =
        (Number.isFinite(subtotal) ? subtotal : 0) +
        (Number.isFinite(fee) ? fee : 0);

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

    const onSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitError("");
        setWasSubmitted(true);

        if (!uid) {
            setSubmitError("Нет авторизации. Перелогинься.");
            return;
        }

        if (!canSubmit) return;

        if (!(typeof pickup.lat === "number" && typeof pickup.lng === "number" && pickup.geohash)) {
            setSubmitError("Сначала укажи pickup-адрес ресторана (из подсказок), чтобы были координаты.");
            return;
        }
        if (!(typeof dropoff.lat === "number" && typeof dropoff.lng === "number" && dropoff.geohash)) {
            setSubmitError("Выбери адрес доставки из подсказок, чтобы были координаты.");
            return;
        }
        if (!quote || !Number.isFinite(fee)) {
            setSubmitError("Не удалось рассчитать delivery fee. Проверь адрес и попробуй ещё раз.");
            return;
        }

        setLoading(true);

        try {
            // фиксируем readyAtMs при создании
            const readyAtMs = Date.now() + prepTimeMin * 60_000;

            const orderDoc: any = {
                // pickup
                pickupLat: pickup.lat,
                pickupLng: pickup.lng,
                pickupGeohash: pickup.geohash,
                pickupAddressText: pickup.label ?? "",

                // owner
                restaurantId: uid,

                // customer
                customerName: form.customerName.trim(),
                customerPhone: form.customerPhone.trim(),
                customerAddress: form.customerAddress.trim(),

                // comment (delivery only)
                notes: form.notes.trim(),

                // dropoff
                dropoffLat: dropoff.lat,
                dropoffLng: dropoff.lng,
                dropoffGeohash: dropoff.geohash,
                dropoffAddressText: dropoff.label ?? form.customerAddress.trim(),

                // payment
                paymentType: form.paymentType,
                orderSubtotal: subtotal,
                deliveryFee: fee,
                orderTotal,

                // money flow
                courierPaysAtPickup: moneyFlow.courierPaysAtPickup,
                courierCollectsFromCustomer: moneyFlow.courierCollectsFromCustomer,
                courierGetsFromRestaurantAtPickup: moneyFlow.courierGetsFromRestaurantAtPickup,

                // route info (from Google Routes)
                routeDistanceMeters: quote.distanceMeters,
                routeDurationSeconds: quote.durationSeconds,
                pricingVersion: quote.pricingVersion ?? "v1",

                // prep time
                prepTimeMin,
                readyAtMs,

                // assignment
                status: "new",
                assignedCourierId: null,
                triedCourierIds: [],

                // timestamps
                acceptedAt: null,
                pickedUpAt: null,
                deliveredAt: null,
                cancelledAt: null,

                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
            };

            // short code counter (per day)
            const dateKey = israelDateKey();
            const orderRef = doc(collection(db, "orders"));
            const counterRef = doc(db, "restaurants", uid, "dayCounters", dateKey);

            await runTransaction(db, async (tx) => {
                const counterSnap = await tx.get(counterRef);
                const lastSeq = counterSnap.exists()
                    ? Number((counterSnap.data() as any)?.lastSeq ?? 0)
                    : 0;

                const nextSeq = lastSeq + 1;
                if (nextSeq > 999) throw new Error("Daily order limit reached (999).");

                const shortCode = String(nextSeq).padStart(3, "0");
                const publicCode = `${dateKey}-${shortCode}`;

                tx.set(
                    counterRef,
                    { lastSeq: nextSeq, updatedAt: serverTimestamp() },
                    { merge: true }
                );

                tx.set(orderRef, {
                    ...orderDoc,
                    shortCode,
                    codeDateKey: dateKey,
                    publicCode,
                });
            });

            navigate("/restaurant/app/orders");
        } catch (err: any) {
            setSubmitError(err?.message ?? "Failed to create order");
        } finally {
            setLoading(false);
        }
    };

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

    function onPickupPick(s: AddressSuggestion) {
        const gh = geohashForLocation([s.lat, s.lng]);
        setPickup({ lat: s.lat, lng: s.lng, geohash: gh, label: s.label });
        setPickupSaveError("");
    }

    function onPickupTextChange(v: string) {
        setPickup({ lat: null, lng: null, geohash: null, label: v });
        setPickupSaveError("");
    }

    async function savePickupToRestaurantProfile() {
        if (!uid) return;

        if (!(pickup.lat && pickup.lng && pickup.geohash)) {
            setPickupSaveError("Выбери адрес ресторана из подсказок (нужны координаты).");
            return;
        }

        setPickupSaving(true);
        setPickupSaveError("");

        try {
            await setDoc(
                doc(db, "restaurants", uid),
                {
                    pickupLat: pickup.lat,
                    pickupLng: pickup.lng,
                    pickupGeohash: pickup.geohash,
                    pickupAddressText: pickup.label ?? "",
                    updatedAt: serverTimestamp(),
                },
                { merge: true }
            );
        } catch (e: any) {
            setPickupSaveError(e?.message ?? "Failed to save pickup location");
        } finally {
            setPickupSaving(false);
        }
    }

    function onDropoffTextChange(v: string) {
        setDropoff({ lat: null, lng: null, geohash: null, label: null });
        update("customerAddress", v);
    }

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
                {/* Restaurant pickup */}
                <div style={{ padding: 12, border: "1px solid #333", borderRadius: 12 }}>
                    <div style={{ fontSize: 12, color: "#aaa", marginBottom: 6 }}>
                        Restaurant pickup location
                    </div>

                    {!pickupLoaded ? (
                        <div style={{ color: "#888", fontSize: 13 }}>Loading pickup…</div>
                    ) : pickup.lat && pickup.lng && pickup.geohash ? (
                        <div style={{ fontSize: 13 }}>
                            Saved: <b>{pickup.label ?? "—"}</b>
                        </div>
                    ) : (
                        <>
                            <AddressAutocomplete
                                placeholder="Pickup address (restaurant) — start typing..."
                                value={pickup.label ?? ""}
                                onChangeText={onPickupTextChange}
                                onPick={onPickupPick}
                                disabled={loading || pickupSaving}
                            />

                            <div style={{ height: 8 }} />

                            <button
                                type="button"
                                onClick={savePickupToRestaurantProfile}
                                disabled={pickupSaving}
                                style={{
                                    padding: "8px 12px",
                                    borderRadius: 10,
                                    border: "1px solid #333",
                                    cursor: pickupSaving ? "not-allowed" : "pointer",
                                }}
                            >
                                {pickupSaving ? "Saving…" : "Save pickup location"}
                            </button>

                            {pickupSaveError && (
                                <div style={{ color: "crimson", marginTop: 8, fontSize: 12 }}>
                                    {pickupSaveError}
                                </div>
                            )}

                            <div style={{ color: "#888", marginTop: 8, fontSize: 12 }}>
                                Нужно для расчёта маршрута и выбора ближайшего курьера.
                            </div>
                        </>
                    )}
                </div>

                {/* Customer */}
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

                {/* Delivery address */}
                <div>
                    <AddressAutocomplete
                        placeholder="Delivery address (start typing...)"
                        value={form.customerAddress}
                        onChangeText={onDropoffTextChange}
                        onPick={onDropoffPick}
                        disabled={loading}
                    />
                    <FieldError text={showErrors ? errors.customerAddress : undefined} />
                    <FieldError text={showErrors ? errors.customerAddressPick : undefined} />
                    <Hint text="Важно: выбери адрес из подсказок — так мы получим координаты для навигатора курьера." />
                </div>

                {/* Delivery comment right under address */}
                <div>
          <textarea
              placeholder="Delivery comment (домофон/подъезд/этаж/оставить у двери)"
              value={form.notes}
              onChange={(e) => update("notes", e.target.value)}
              style={{
                  width: "100%",
                  padding: 10,
                  borderRadius: 8,
                  border: "1px solid #333",
                  outline: "none",
                  minHeight: 80,
                  resize: "vertical",
              }}
          />
                    <Hint text="Один комментарий только по доставке." />
                </div>

                <hr />

                {/* Prep time */}
                <div style={{ padding: 12, border: "1px solid #333", borderRadius: 12 }}>
                    <div style={{ fontSize: 12, color: "#aaa", marginBottom: 8 }}>
                        Order ready time
                    </div>

                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                        {[20, 30, 40].map((m) => {
                            const mm = m as PrepTimeMin;
                            const active = prepTimeMin === mm;
                            return (
                                <button
                                    key={m}
                                    type="button"
                                    onClick={() => setPrepTimeMin(mm)}
                                    style={{
                                        padding: "8px 12px",
                                        borderRadius: 10,
                                        border: active ? "1px solid #4ade80" : "1px solid #333",
                                        background: active ? "rgba(74,222,128,0.12)" : "transparent",
                                        cursor: "pointer",
                                        fontWeight: active ? 800 : 600,
                                    }}
                                >
                                    {m} min
                                </button>
                            );
                        })}
                    </div>

                    <div style={{ marginTop: 10, fontSize: 12, color: "#888" }}>
                        Курьер увидит таймер “готово через …” в оффере и в активном заказе.
                    </div>
                </div>

                {/* Payment type */}
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

                    <Hint text="Cash: курьер берёт деньги у клиента. Card: клиент оплатил ресторану, курьер денег у клиента не берёт, delivery fee получает в ресторане." />
                </div>

                {/* Subtotal */}
                <div>
                    <input
                        placeholder="Order subtotal (₪) — стоимость еды"
                        value={form.orderSubtotal}
                        onChange={(e) => update("orderSubtotal", e.target.value)}
                        style={inputStyle(showErrors && !!errors.orderSubtotal)}
                    />
                    <FieldError text={showErrors ? errors.orderSubtotal : undefined} />
                </div>

                {/* Quote / delivery fee */}
                <div style={{ padding: 12, border: "1px solid #333", borderRadius: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                        <span style={{ color: "#aaa" }}>Delivery fee (auto)</span>
                        <b>{quoteLoading ? "Calculating…" : money(quote?.deliveryFee)}</b>
                    </div>

                    <div style={{ marginTop: 8, fontSize: 13, color: "#ddd" }}>
                        {quote ? (
                            <>
                                <div>Distance (route): <b>{quote.distanceKm.toFixed(2)} km</b></div>
                                <div>ETA (route): <b>{Math.round(quote.durationSeconds / 60)} min</b></div>
                            </>
                        ) : (
                            <div style={{ color: "#888" }}>
                                Выбери адрес доставки из подсказок, чтобы рассчитать маршрут.
                            </div>
                        )}
                    </div>

                    {quoteError && (
                        <div style={{ marginTop: 8, color: "crimson", fontSize: 12 }}>
                            {quoteError}
                        </div>
                    )}

                    <FieldError text={showErrors ? errors.quote : undefined} />
                </div>

                {/* Totals / money flow */}
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
                                <div>Курьер берет с клиента: <b>₪0.00</b></div>
                                <div>
                                    Ресторан выдает курьеру (доставка):{" "}
                                    <b>₪{moneyFlow.courierGetsFromRestaurantAtPickup.toFixed(2)}</b>
                                </div>
                            </>
                        )}
                    </div>
                </div>

                <button
                    disabled={loading || quoteLoading || !canSubmit}
                    style={{
                        padding: 12,
                        borderRadius: 10,
                        border: "1px solid #333",
                        cursor: loading || quoteLoading || !canSubmit ? "not-allowed" : "pointer",
                        opacity: loading || quoteLoading || !canSubmit ? 0.7 : 1,
                    }}
                >
                    {loading ? "Creating…" : "Create order"}
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
