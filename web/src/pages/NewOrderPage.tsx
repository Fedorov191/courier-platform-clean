import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

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

import { GooglePlacesAutocomplete } from "../components/GooglePlacesAutocomplete";
import type { PlacePick } from "../components/GooglePlacesAutocomplete";
import { useI18n } from "../lib/i18n";

type PaymentType = "cash" | "card";

const PREP_OPTIONS = [20, 30, 40] as const;
type PrepTimeMin = (typeof PREP_OPTIONS)[number];

type FormState = {
    customerName: string;
    customerPhone: string;

    dropoffAddressText: string; // “красивая строка” (из Google)
    dropoffStreet: string;
    dropoffHouseNumber: string;
    dropoffApartment: string; // optional
    dropoffEntrance: string; // optional
    dropoffComment: string; // optional, но поле обязано быть в UI

    orderSubtotal: string;
    paymentType: PaymentType;
};

type Errors =
    Partial<Record<keyof FormState, string>> & {
    dropoffPick?: string;
    prepTimeMin?: string;
    quote?: string;
    pickupMissing?: string;
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
    return `${y}-${m}-${day}`;
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
    const { t } = useI18n();

    const [uid, setUid] = useState<string | null>(auth.currentUser?.uid ?? null);
    const [authLoading, setAuthLoading] = useState(true);

    const [loading, setLoading] = useState(false);
    const [submitError, setSubmitError] = useState("");
    const [wasSubmitted, setWasSubmitted] = useState(false);

    // ✅ время готовности обязательно выбирать
    const [prepTimeMin, setPrepTimeMin] = useState<PrepTimeMin | null>(null);

    // pickup (restaurant)
    const [pickup, setPickup] = useState<{
        lat: number | null;
        lng: number | null;
        geohash: string | null;
        label: string;
        placeId: string | null;
    }>({ lat: null, lng: null, geohash: null, label: "", placeId: null });

    const [pickupLoaded, setPickupLoaded] = useState(false);
    const [pickupSaving, setPickupSaving] = useState(false);
    const [pickupSaveError, setPickupSaveError] = useState<string>("");
    const [pickupEditMode, setPickupEditMode] = useState(true);

    // dropoff
    const [dropoff, setDropoff] = useState<{
        lat: number | null;
        lng: number | null;
        geohash: string | null;
        label: string;
        placeId: string | null;
    }>({ lat: null, lng: null, geohash: null, label: "", placeId: null });

    const [form, setForm] = useState<FormState>({
        customerName: "",
        customerPhone: "",

        dropoffAddressText: "",
        dropoffStreet: "",
        dropoffHouseNumber: "",
        dropoffApartment: "",
        dropoffEntrance: "",
        dropoffComment: "",

        orderSubtotal: "",
        paymentType: "cash",
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

                const label = String(data?.pickupAddressText ?? data?.address ?? "");
                const placeId = typeof data?.pickupPlaceId === "string" ? data.pickupPlaceId : null;

                if (!cancelled) {
                    setPickup({ lat, lng, geohash, label, placeId });
                    setPickupLoaded(true);

                    const hasSaved = typeof lat === "number" && typeof lng === "number" && !!geohash;
                    setPickupEditMode(!hasSaved);
                }
            } catch (e: any) {
                if (!cancelled) {
                    setPickupLoaded(true);
                    setPickupSaveError(t("errorLoadPickup"));
                }
            }
        }

        loadPickup();
        return () => {
            cancelled = true;
        };
    }, [uid, t]);

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
            } catch {
                if (cancelled) return;
                setQuote(null);
                setQuoteError(t("errorCalcRouteFee"));
            } finally {
                if (!cancelled) setQuoteLoading(false);
            }
        }

        run();
        return () => {
            cancelled = true;
        };
    }, [pickup.lat, pickup.lng, dropoff.lat, dropoff.lng, t]);

    const update = (key: keyof FormState, value: any) => {
        setForm((prev) => ({ ...prev, [key]: value }));
    };

    // ======== Dropoff handlers (Google Places) ========
    function onDropoffPick(p: PlacePick) {
        const gh = geohashForLocation([p.lat, p.lng]);
        setDropoff({ lat: p.lat, lng: p.lng, geohash: gh, label: p.label, placeId: p.placeId });

        update("dropoffAddressText", p.label);

        // ✅ автозаполняем street/house, но оставляем редактируемым
        if (p.street) update("dropoffStreet", p.street);
        if (p.houseNumber) update("dropoffHouseNumber", p.houseNumber);

        // subpremise если есть
        if (p.apartment && !form.dropoffApartment) update("dropoffApartment", p.apartment);
    }

    function onDropoffTextChange(v: string) {
        // если пользователь печатает вручную — сбрасываем координаты
        setDropoff({ lat: null, lng: null, geohash: null, label: v, placeId: null });
        update("dropoffAddressText", v);
    }

    // ======== Pickup handlers (Google Places) ========
    function onPickupPick(p: PlacePick) {
        const gh = geohashForLocation([p.lat, p.lng]);
        setPickup({ lat: p.lat, lng: p.lng, geohash: gh, label: p.label, placeId: p.placeId });
        setPickupSaveError("");
    }

    function onPickupTextChange(v: string) {
        setPickup({ lat: null, lng: null, geohash: null, label: v, placeId: null });
        setPickupSaveError("");
    }

    async function savePickupToRestaurantProfile() {
        if (!uid) return;

        if (!(typeof pickup.lat === "number" && typeof pickup.lng === "number" && pickup.geohash)) {
            setPickupSaveError(t("pickupPickFromSuggestionsError"));
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
                    pickupPlaceId: pickup.placeId ?? null,
                    updatedAt: serverTimestamp(),
                },
                { merge: true }
            );

            setPickupEditMode(false);
        } catch {
            setPickupSaveError(t("errorSavePickup"));
        } finally {
            setPickupSaving(false);
        }
    }

    // ======== Pricing ========
    const subtotal = toNumber(form.orderSubtotal);
    const fee = typeof quote?.deliveryFee === "number" ? quote.deliveryFee : NaN;

    const errors: Errors = useMemo(() => {
        const e: Errors = {};

        if (prepTimeMin === null) {
            e.prepTimeMin = t("errorPickPrepTime");
        }

        if (form.customerName.trim().length < 2) e.customerName = t("errorCustomerNameRequired");

        const phoneDigits = onlyDigits(form.customerPhone);
        if (phoneDigits.length < 9) {
            e.customerPhone = t("errorPhoneMinDigits");
        }

        // Dropoff must be picked (coords + placeId)
        if (form.dropoffAddressText.trim().length < 5) {
            e.dropoffAddressText = t("errorStartTypingAddress");
        }
        if (
            !(
                typeof dropoff.lat === "number" &&
                typeof dropoff.lng === "number" &&
                !!dropoff.geohash &&
                !!dropoff.placeId
            )
        ) {
            e.dropoffPick = t("errorPickAddressFromSuggestions");
        }

        // ✅ structured fields required
        if (form.dropoffStreet.trim().length < 2) e.dropoffStreet = t("errorStreetRequired");
        if (form.dropoffHouseNumber.trim().length < 1) e.dropoffHouseNumber = t("errorHouseRequired");

        if (!Number.isFinite(subtotal) || subtotal <= 0) {
            e.orderSubtotal = t("errorSubtotalPositive");
        }

        // pickup must exist (coords) to compute route
        const hasPickup = typeof pickup.lat === "number" && typeof pickup.lng === "number";
        if (!hasPickup) {
            e.pickupMissing = t("errorPickupMissing");
        }

        // quote required after both coords
        const hasDropoff = typeof dropoff.lat === "number" && typeof dropoff.lng === "number";
        if (hasPickup && hasDropoff && !quoteLoading) {
            if (!quote || !Number.isFinite(fee) || fee < 0) {
                e.quote = quoteError || t("errorQuoteMissing");
            }
        }

        return e;
    }, [
        prepTimeMin,
        form.customerName,
        form.customerPhone,
        form.dropoffAddressText,
        form.dropoffStreet,
        form.dropoffHouseNumber,
        form.orderSubtotal,
        pickup.lat,
        pickup.lng,
        dropoff.lat,
        dropoff.lng,
        dropoff.geohash,
        dropoff.placeId,
        quote,
        quoteLoading,
        quoteError,
        subtotal,
        fee,
        t,
    ]);

    const canSubmit =
        Object.keys(errors).length === 0 &&
        !quoteLoading &&
        !!quote &&
        Number.isFinite(subtotal) &&
        subtotal > 0 &&
        Number.isFinite(fee) &&
        fee >= 0;

    const orderTotal = (Number.isFinite(subtotal) ? subtotal : 0) + (Number.isFinite(fee) ? fee : 0);

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

    const onSubmit = async (e: FormEvent) => {
        e.preventDefault();
        setSubmitError("");
        setWasSubmitted(true);

        if (!uid) {
            setSubmitError(t("errorNoAuthRelogin"));
            return;
        }

        if (!canSubmit) return;
        if (prepTimeMin === null) return;

        if (!(typeof pickup.lat === "number" && typeof pickup.lng === "number" && pickup.geohash)) {
            setSubmitError(t("errorSetPickupFirst"));
            return;
        }
        if (
            !(
                typeof dropoff.lat === "number" &&
                typeof dropoff.lng === "number" &&
                !!dropoff.geohash &&
                !!dropoff.placeId
            )
        ) {
            setSubmitError(t("errorPickDropoffFromSuggestions"));
            return;
        }
        if (!quote || !Number.isFinite(fee)) {
            setSubmitError(t("errorDeliveryFeeNotCalculated"));
            return;
        }

        setLoading(true);

        try {
            const readyAtMs = Date.now() + prepTimeMin * 60_000;

            const orderDoc: any = {
                // owner
                restaurantId: uid,

                // pickup
                pickupLat: pickup.lat,
                pickupLng: pickup.lng,
                pickupGeohash: pickup.geohash,
                pickupAddressText: pickup.label ?? "",
                pickupPlaceId: pickup.placeId ?? null,

                // prep time
                prepTimeMin,
                readyAtMs,

                // customer
                customerName: form.customerName.trim(),
                customerPhone: form.customerPhone.trim(),

                // structured dropoff
                dropoffPlaceId: dropoff.placeId,
                dropoffLat: dropoff.lat,
                dropoffLng: dropoff.lng,
                dropoffGeohash: dropoff.geohash,
                dropoffAddressText: form.dropoffAddressText.trim(),

                dropoffStreet: form.dropoffStreet.trim(),
                dropoffHouseNumber: form.dropoffHouseNumber.trim(),
                dropoffApartment: form.dropoffApartment.trim() || null,
                dropoffEntrance: form.dropoffEntrance.trim() || null,
                dropoffComment: form.dropoffComment.trim() || null,

                // backward compatibility (старые поля)
                customerAddress: form.dropoffAddressText.trim(),
                notes: form.dropoffComment.trim(),

                // payment
                paymentType: form.paymentType,
                orderSubtotal: subtotal,
                deliveryFee: fee,
                orderTotal,

                // money flow
                courierPaysAtPickup: moneyFlow.courierPaysAtPickup,
                courierCollectsFromCustomer: moneyFlow.courierCollectsFromCustomer,
                courierGetsFromRestaurantAtPickup: moneyFlow.courierGetsFromRestaurantAtPickup,

                // route info (Routes API)
                routeDistanceMeters: quote.distanceMeters,
                routeDurationSeconds: quote.durationSeconds,
                pricingVersion: quote.pricingVersion ?? "v1",

                // (по промпту — можно хранить и “deliveryDistance…”)
                deliveryDistanceMeters: quote.distanceMeters,
                deliveryDistanceKm: quote.distanceKm,

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
                if (nextSeq > 999) throw new Error(t("errorDailyLimit"));

                const shortCode = String(nextSeq).padStart(3, "0");
                const publicCode = `${dateKey}-${shortCode}`;

                tx.set(counterRef, { lastSeq: nextSeq, updatedAt: serverTimestamp() }, { merge: true });

                tx.set(orderRef, {
                    ...orderDoc,
                    shortCode,
                    codeDateKey: dateKey,
                    publicCode,
                });
            });

            navigate("/restaurant/app/orders");
        } catch (err: any) {
            setSubmitError(err?.message ?? t("errorCreateOrder"));
        } finally {
            setLoading(false);
        }
    };

    const showErrors = wasSubmitted;

    function inputStyle(hasError: boolean) {
        return {
            width: "100%",
            padding: 10,
            borderRadius: 10,
            border: hasError ? "1px solid rgba(220, 38, 38, 0.55)" : "1px solid var(--border-2)",
            outline: "none",
            background: "var(--surface)",
            color: "var(--text)",
        } as const;
    }

    const Hint = ({ text }: { text: string }) => (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            {text}
        </div>
    );

    const FieldError = ({ text }: { text?: string }) => {
        if (!text) return null;
        return (
            <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 6 }}>
                {text}
            </div>
        );
    };

    if (authLoading) {
        return (
            <div className="card">
                <div className="card__inner">
                    <h2 style={{ margin: 0 }}>{t("newOrder")}</h2>
                    <div className="muted" style={{ marginTop: 8 }}>
                        {t("checkingSession")}
                    </div>
                </div>
            </div>
        );
    }

    if (!uid) {
        return (
            <div className="card">
                <div className="card__inner">
                    <h2 style={{ margin: 0 }}>{t("newOrder")}</h2>
                    <div className="alert alert--danger" style={{ marginTop: 12 }}>
                        {t("noAuthSession")}
                    </div>
                    <div style={{ marginTop: 12 }}>
                        <Link to="/restaurant/login">{t("goToLogin")}</Link>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="container--narrow">
            <div className="row row--between row--wrap row--mobile-stack" style={{ marginBottom: 12 }}>
                <h2 style={{ margin: 0 }}>{t("newOrder")}</h2>
                <button className="btn btn--ghost" type="button" onClick={() => navigate("/restaurant/app/orders")}>
                    {t("back")}
                </button>
            </div>

            <div className="card">
                <div className="card__inner">
                    <form onSubmit={onSubmit} className="stack">
                        {/* Restaurant pickup */}
                        <div className="subcard">
                            <div className="section-title">{t("pickupSectionTitle")}</div>
                            <div style={{ height: 10 }} />

                            {!pickupLoaded ? (
                                <div className="muted">{t("loadingPickup")}</div>
                            ) : (
                                <>
                                    {!pickupEditMode && pickup.lat && pickup.lng && pickup.geohash ? (
                                        <>
                                            <div style={{ fontSize: 14 }}>
                                                {t("saved")}: <b>{pickup.label || "—"}</b>
                                            </div>

                                            <div style={{ height: 10 }} />

                                            <button
                                                type="button"
                                                className="btn btn--ghost"
                                                onClick={() => setPickupEditMode(true)}
                                            >
                                                {t("changePickupLocation")}
                                            </button>
                                        </>
                                    ) : (
                                        <>
                                            <GooglePlacesAutocomplete
                                                placeholder={t("pickupPlaceholder")}
                                                value={pickup.label}
                                                onChangeText={onPickupTextChange}
                                                onPick={onPickupPick}
                                                disabled={loading || pickupSaving}
                                                country="il"
                                            />

                                            <div style={{ height: 10 }} />

                                            <button
                                                type="button"
                                                className="btn btn--primary"
                                                onClick={savePickupToRestaurantProfile}
                                                disabled={pickupSaving}
                                            >
                                                {pickupSaving ? t("saving") : t("savePickupLocation")}
                                            </button>

                                            {pickupSaveError && (
                                                <div style={{ marginTop: 10 }}>
                                                    <div className="alert alert--danger">{pickupSaveError}</div>
                                                </div>
                                            )}

                                            <Hint text={t("pickupNeedHint")} />
                                        </>
                                    )}

                                    {showErrors && errors.pickupMissing && <FieldError text={errors.pickupMissing} />}
                                </>
                            )}
                        </div>

                        {/* Customer */}
                        <div>
                            <input
                                placeholder={t("customerNamePlaceholder")}
                                value={form.customerName}
                                onChange={(e) => update("customerName", e.target.value)}
                                style={inputStyle(showErrors && !!errors.customerName)}
                            />
                            <FieldError text={showErrors ? errors.customerName : undefined} />
                        </div>

                        <div>
                            <input
                                placeholder={t("customerPhonePlaceholder")}
                                value={form.customerPhone}
                                onChange={(e) => update("customerPhone", e.target.value)}
                                style={inputStyle(showErrors && !!errors.customerPhone)}
                            />
                            <Hint text={t("phoneDigitsHint")} />
                            <FieldError text={showErrors ? errors.customerPhone : undefined} />
                        </div>

                        {/* Delivery address + structured */}
                        <div className="subcard">
                            <div className="section-title">{t("deliverySectionTitle")}</div>
                            <div style={{ height: 10 }} />

                            <GooglePlacesAutocomplete
                                placeholder={t("deliveryPlaceholder")}
                                value={form.dropoffAddressText}
                                onChangeText={onDropoffTextChange}
                                onPick={onDropoffPick}
                                disabled={loading}
                                country="il"
                            />

                            <FieldError text={showErrors ? errors.dropoffAddressText : undefined} />
                            <FieldError text={showErrors ? errors.dropoffPick : undefined} />

                            <Hint text={t("deliveryPickHint")} />

                            <div style={{ height: 12 }} />

                            <div className="row row--wrap" style={{ alignItems: "flex-start" }}>
                                <div style={{ flex: 1, minWidth: 220 }}>
                                    <input
                                        placeholder={t("streetPlaceholder")}
                                        value={form.dropoffStreet}
                                        onChange={(e) => update("dropoffStreet", e.target.value)}
                                        style={inputStyle(showErrors && !!errors.dropoffStreet)}
                                    />
                                    <FieldError text={showErrors ? errors.dropoffStreet : undefined} />
                                </div>

                                <div style={{ width: 160, minWidth: 140 }}>
                                    <input
                                        placeholder={t("housePlaceholder")}
                                        value={form.dropoffHouseNumber}
                                        onChange={(e) => update("dropoffHouseNumber", e.target.value)}
                                        style={inputStyle(showErrors && !!errors.dropoffHouseNumber)}
                                    />
                                    <FieldError text={showErrors ? errors.dropoffHouseNumber : undefined} />
                                </div>
                            </div>

                            <div style={{ height: 10 }} />

                            <div className="row row--wrap" style={{ alignItems: "flex-start" }}>
                                <div style={{ flex: 1, minWidth: 220 }}>
                                    <input
                                        placeholder={t("apartmentPlaceholder")}
                                        value={form.dropoffApartment}
                                        onChange={(e) => update("dropoffApartment", e.target.value)}
                                        style={inputStyle(false)}
                                    />
                                </div>

                                <div style={{ flex: 1, minWidth: 220 }}>
                                    <input
                                        placeholder={t("entrancePlaceholder")}
                                        value={form.dropoffEntrance}
                                        onChange={(e) => update("dropoffEntrance", e.target.value)}
                                        style={inputStyle(false)}
                                    />
                                </div>
                            </div>

                            <div style={{ height: 10 }} />

                            <textarea
                                placeholder={t("commentPlaceholder")}
                                value={form.dropoffComment}
                                onChange={(e) => update("dropoffComment", e.target.value)}
                                style={{
                                    width: "100%",
                                    padding: 10,
                                    borderRadius: 10,
                                    border: "1px solid var(--border-2)",
                                    outline: "none",
                                    minHeight: 90,
                                    resize: "vertical",
                                    background: "var(--surface)",
                                    color: "var(--text)",
                                }}
                            />
                            <Hint text={t("commentHint")} />
                        </div>

                        <div className="hr" />

                        {/* Prep time */}
                        <div className="subcard">
                            <div className="section-title">{t("prepTimeSectionTitle")}</div>
                            <div style={{ height: 10 }} />

                            <div className="row row--wrap">
                                {PREP_OPTIONS.map((m) => {
                                    const active = prepTimeMin === m;
                                    return (
                                        <button
                                            key={m}
                                            type="button"
                                            className={`btn ${active ? "btn--primary" : "btn--ghost"}`}
                                            onClick={() => setPrepTimeMin(m)}
                                        >
                                            {m} {t("minShort")}
                                        </button>
                                    );
                                })}
                            </div>

                            <FieldError text={showErrors ? errors.prepTimeMin : undefined} />
                            <Hint text={t("prepTimeHint")} />
                        </div>

                        {/* Payment type */}
                        <div className="subcard">
                            <div className="section-title">{t("paymentTypeLabel")}</div>
                            <div style={{ height: 10 }} />

                            <div className="row row--wrap">
                                <label className="row" style={{ gap: 8 }}>
                                    <input
                                        type="radio"
                                        name="pt"
                                        checked={form.paymentType === "cash"}
                                        onChange={() => update("paymentType", "cash")}
                                    />
                                    <span>{t("paymentCash")}</span>
                                </label>

                                <label className="row" style={{ gap: 8 }}>
                                    <input
                                        type="radio"
                                        name="pt"
                                        checked={form.paymentType === "card"}
                                        onChange={() => update("paymentType", "card")}
                                    />
                                    <span>{t("paymentCard")}</span>
                                </label>
                            </div>

                            <Hint text={t("paymentHint")} />
                        </div>

                        {/* Subtotal */}
                        <div>
                            <input
                                placeholder={t("subtotalPlaceholder")}
                                value={form.orderSubtotal}
                                onChange={(e) => update("orderSubtotal", e.target.value)}
                                style={inputStyle(showErrors && !!errors.orderSubtotal)}
                            />
                            <FieldError text={showErrors ? errors.orderSubtotal : undefined} />
                        </div>

                        {/* Quote / delivery fee */}
                        <div className="subcard">
                            <div className="row row--between row--wrap">
                                <span className="muted">{t("deliveryFeeAutoLabel")}</span>
                                <b>{quoteLoading ? t("calculating") : money(quote?.deliveryFee)}</b>
                            </div>

                            <div style={{ height: 10 }} />

                            {quote ? (
                                <div className="kv">
                                    <div className="line">
                                        <span>{t("distanceRouteLabel")}</span>
                                        <b>{quote.distanceKm.toFixed(2)} km</b>
                                    </div>
                                    <div className="line">
                                        <span>{t("etaRouteLabel")}</span>
                                        <b>
                                            {Math.round(quote.durationSeconds / 60)} {t("minShort")}
                                        </b>
                                    </div>
                                </div>
                            ) : (
                                <div className="muted">{t("routePickAddressToCalculate")}</div>
                            )}

                            {quoteError && (
                                <div style={{ marginTop: 10 }}>
                                    <div className="alert alert--danger">{quoteError}</div>
                                </div>
                            )}

                            <FieldError text={showErrors ? errors.quote : undefined} />
                        </div>

                        {/* Totals / money flow */}
                        <div className="subcard">
                            <div className="row row--between row--wrap">
                                <span className="muted">{t("orderTotalLabel")}</span>
                                <b>₪{Number.isFinite(orderTotal) ? orderTotal.toFixed(2) : "—"}</b>
                            </div>

                            <div style={{ height: 10 }} />

                            {form.paymentType === "cash" ? (
                                <div className="kv">
                                    <div className="line">
                                        <span>{t("cashCourierPaysRestaurant")}</span>
                                        <b>₪{moneyFlow.courierPaysAtPickup.toFixed(2)}</b>
                                    </div>
                                    <div className="line">
                                        <span>{t("cashCourierCollectsFromCustomer")}</span>
                                        <b>₪{moneyFlow.courierCollectsFromCustomer.toFixed(2)}</b>
                                    </div>
                                    <div className="line">
                                        <span>{t("courierKeepsDeliveryFee")}</span>
                                        <b>₪{Number.isFinite(fee) ? fee.toFixed(2) : "—"}</b>
                                    </div>
                                </div>
                            ) : (
                                <div className="kv">
                                    <div className="line">
                                        <span>{t("cashCourierCollectsFromCustomer")}</span>
                                        <b>₪0.00</b>
                                    </div>
                                    <div className="line">
                                        <span>{t("cardRestaurantPaysCourier")}</span>
                                        <b>₪{moneyFlow.courierGetsFromRestaurantAtPickup.toFixed(2)}</b>
                                    </div>
                                </div>
                            )}
                        </div>

                        <button className="btn btn--primary" disabled={loading || quoteLoading || !canSubmit}>
                            {loading ? t("creating") : t("createOrder")}
                        </button>

                        {!canSubmit && showErrors && (
                            <div style={{ fontSize: 12, color: "var(--danger)" }}>
                                {t("fixHighlightedFields")}
                            </div>
                        )}

                        {submitError && <div className="alert alert--danger">{submitError}</div>}
                    </form>
                </div>
            </div>
        </div>
    );
}
