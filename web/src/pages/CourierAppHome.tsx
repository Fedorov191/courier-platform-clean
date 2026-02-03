import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { auth, db } from "../lib/firebase";
import { OrderChat } from "../components/OrderChat";
import { enablePush } from "../lib/push";

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
import { useI18n } from "../lib/i18n";

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

    shortCode?: string;

    prepTimeMin?: number;
    readyAtMs?: number;

    // route / distance (server calculated)
    routeDistanceMeters?: number;
    routeDurationSeconds?: number;

    // optional aliases (if order stores these)
    deliveryDistanceMeters?: number;
    deliveryDistanceKm?: number;

    // structured dropoff fields (F)
    dropoffStreet?: string;
    dropoffHouseNumber?: string;
    dropoffApartment?: string;
    dropoffEntrance?: string;
    dropoffComment?: string;
};

function shortId(id: string) {
    return (id || "").slice(0, 6).toUpperCase();
}

// Israel TZ keys for reports
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

    return {
        deliveredDateKey: `${y}-${m}-${day}`,
        deliveredMonthKey: `${y}-${m}`,
        deliveredYearKey: `${y}`,
    };
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

const GEO_WRITE_MIN_MS = 60_000;
const GEO_MIN_MOVE_M = 150;

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
        case "taken":
            return "warning";
        case "picked_up":
            return "info";
        case "delivered":
            return "success";
        case "cancelled":
            return "danger";
        case "new":
            return "info";
        default:
            return "muted";
    }
}

function readyInText(readyAtMs?: number, nowMs?: number) {
    if (typeof readyAtMs !== "number" || !Number.isFinite(readyAtMs)) return "—";
    const diff = readyAtMs - (typeof nowMs === "number" ? nowMs : Date.now());
    if (diff <= 0) return "READY";
    const totalSec = Math.ceil(diff / 1000);
    const mm = Math.floor(totalSec / 60);
    const ss = totalSec % 60;
    return `${mm}:${String(ss).padStart(2, "0")}`;
}

function kmTextFromMeters(m?: number, digits = 1) {
    if (typeof m !== "number" || !Number.isFinite(m) || m <= 0) return "—";
    return `${(m / 1000).toFixed(digits)} km`;
}

function getPickupToDropoffMeters(x: any): number | null {
    const a = x?.routeDistanceMeters;
    if (typeof a === "number" && Number.isFinite(a) && a > 0) return a;

    const b = x?.deliveryDistanceMeters;
    if (typeof b === "number" && Number.isFinite(b) && b > 0) return b;

    const km = x?.deliveryDistanceKm;
    if (typeof km === "number" && Number.isFinite(km) && km > 0) return km * 1000;

    return null;
}

// Возвращаем “части”, а не готовые “Apt/Entrance” (чтобы локализовать в UI)
function formatDropoffParts(o: any) {
    const street = String(o?.dropoffStreet ?? "").trim();
    const house = String(o?.dropoffHouseNumber ?? "").trim();
    const apt = String(o?.dropoffApartment ?? "").trim();
    const ent = String(o?.dropoffEntrance ?? "").trim();
    const comment = String(o?.dropoffComment ?? o?.notes ?? "").trim();

    const main =
        [street, house].filter(Boolean).join(" ").trim() ||
        String(o?.dropoffAddressText ?? o?.customerAddress ?? "").trim() ||
        "—";

    return { main, apt, ent, comment };
}

export default function CourierAppHome() {
    const nav = useNavigate();
    const user = auth.currentUser;
    const { t } = useI18n();

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
    const [pushBusy, setPushBusy] = useState(false);
    const [pushEnabled, setPushEnabled] = useState(() => Notification.permission === "granted");

    const enableCourierPush = useCallback(async () => {
        setErr(null);
        setPushBusy(true);
        try {
            await enablePush("courier");
            setPushEnabled(true);
        } catch (e: any) {
            setErr(e?.message ?? "Failed to enable notifications");
        } finally {
            setPushBusy(false);
        }
    }, []);

    const [offers, setOffers] = useState<Offer[]>([]);
    const [activeOrders, setActiveOrders] = useState<any[]>([]);
    const [completedOrders, setCompletedOrders] = useState<any[]>([]);
    const [tab, setTab] = useState<"active" | "completed">("active");

    const [busyOfferId, setBusyOfferId] = useState<string | null>(null);
    const [busyOrderAction, setBusyOrderAction] = useState<"pickup" | "deliver" | null>(null);

    // chat open per orderId
    const [chatOpenByOrderId, setChatOpenByOrderId] = useState<Record<string, boolean>>({});

    // unread per chatId
    const [unreadByChatId, setUnreadByChatId] = useState<Record<string, boolean>>({});
    const chatLastMsgAtByChatIdRef = useRef<Record<string, number>>({});

    const chatOpenRef = useRef(chatOpenByOrderId);
    useEffect(() => {
        chatOpenRef.current = chatOpenByOrderId;
    }, [chatOpenByOrderId]);

    const [nowMs, setNowMs] = useState(() => Date.now());
    useEffect(() => {
        const id = window.setInterval(() => setNowMs(Date.now()), 1000);
        return () => window.clearInterval(id);
    }, []);

    function toggleChat(orderId: string) {
        setChatOpenByOrderId((prev) => ({ ...prev, [orderId]: !prev[orderId] }));
    }

    function statusLabel(status?: string) {
        switch (status) {
            case "new":
                return t("courierStatusNew");
            case "taken":
                return t("courierStatusTaken");
            case "picked_up":
                return t("courierStatusPickedUp");
            case "delivered":
                return t("courierStatusDelivered");
            case "cancelled":
                return t("courierStatusCancelled");
            default:
                return (status || "—").toUpperCase();
        }
    }

    function paymentLabel(pt?: string) {
        if (pt === "cash") return t("courierPaymentCash");
        if (pt === "card") return t("courierPaymentCard");
        return "—";
    }

    function dropoffExtra(apt?: string, ent?: string) {
        const parts: string[] = [];
        if (apt) parts.push(`${t("courierAptShort")} ${apt}`);
        if (ent) parts.push(`${t("courierEntranceShort")} ${ent}`);
        return parts.join(", ");
    }

    // =======================
    // AUDIO
    // =======================
    const audioCtxRef = useRef<AudioContext | null>(null);

    function primeAudio() {
        const A = window.AudioContext || (window as any).webkitAudioContext;
        if (!A) return;
        if (!audioCtxRef.current) audioCtxRef.current = new A();
        if (audioCtxRef.current.state === "suspended") {
            audioCtxRef.current.resume().catch(() => {});
        }
    }

    function playOfferBeep() {
        const ctx = audioCtxRef.current;
        if (!ctx) return;
        if (ctx.state === "suspended") return;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = 880;
        gain.gain.value = 0.05;

        osc.connect(gain);
        gain.connect(ctx.destination);

        const t0 = ctx.currentTime;
        osc.start(t0);
        osc.stop(t0 + 0.08);
    }

    function playChatBeep() {
        const ctx = audioCtxRef.current;
        if (!ctx) return;
        if (ctx.state === "suspended") return;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = 660;
        gain.gain.value = 0.06;

        osc.connect(gain);
        gain.connect(ctx.destination);

        const t0 = ctx.currentTime;
        osc.start(t0);
        osc.stop(t0 + 0.06);
    }

    // первый user gesture
    useEffect(() => {
        const handler = () => primeAudio();
        window.addEventListener("pointerdown", handler, { once: true });
        return () => window.removeEventListener("pointerdown", handler);
    }, []);

    // offers beep каждую секунду пока есть offers
    useEffect(() => {
        if (!isOnline) return;
        if (offers.length === 0) return;

        playOfferBeep();
        const id = window.setInterval(() => playOfferBeep(), 1000);
        return () => window.clearInterval(id);
    }, [isOnline, offers.length]);

    const markChatRead = useCallback(
        async (chatId: string) => {
            if (!user) return;
            try {
                await updateDoc(doc(db, "chats", chatId), {
                    lastReadAtCourier: serverTimestamp(),
                    courierLastReadAt: serverTimestamp(), // совместимость
                    updatedAt: serverTimestamp(),
                });
            } catch {}
        },
        [user]
    );

    async function ensureChat(chatId: string, orderId: string, restaurantId: string) {
        if (!user) return;

        await setDoc(
            doc(db, "chats", chatId),
            {
                orderId,
                restaurantId,
                courierId: user.uid,
                updatedAt: serverTimestamp(),

                lastReadAtCourier: serverTimestamp(),
                courierLastReadAt: serverTimestamp(),
            },
            { merge: true }
        );
    }


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
                if (!cancelled) setErr(e?.message ?? t("courierErrorInitDocs"));
            }
        }

        ensureDocs();
        return () => {
            cancelled = true;
        };
    }, [user, courierPrivateRef, courierPublicRef, t]);

    // subscribe offers
    useEffect(() => {
        if (!user) return;

        const qOffers = query(
            collection(db, "offers"),
            where("courierId", "==", user.uid),
            where("status", "==", "pending")
        );

        const unsub = onSnapshot(
            qOffers,
            (snap) => {
                const list: Offer[] = snap.docs.map((d) => {
                    const data: any = d.data();
                    return {
                        id: d.id,
                        orderId: String(data.orderId ?? ""),
                        restaurantId: String(data.restaurantId ?? ""),
                        courierId: String(data.courierId ?? ""),
                        status: String(data.status ?? "pending"),

                        shortCode: data.shortCode,

                        customerName: data.customerName,
                        customerPhone: data.customerPhone,
                        customerAddress: data.customerAddress,

                        dropoffLat: data.dropoffLat,
                        dropoffLng: data.dropoffLng,
                        dropoffGeohash: data.dropoffGeohash,
                        dropoffAddressText: data.dropoffAddressText ?? data.customerAddress ?? "",

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

                        prepTimeMin: data.prepTimeMin,
                        readyAtMs: data.readyAtMs,

                        routeDistanceMeters: data.routeDistanceMeters,
                        routeDurationSeconds: data.routeDurationSeconds,

                        deliveryDistanceMeters: data.deliveryDistanceMeters,
                        deliveryDistanceKm: data.deliveryDistanceKm,

                        dropoffStreet: data.dropoffStreet ?? "",
                        dropoffHouseNumber: data.dropoffHouseNumber ?? "",
                        dropoffApartment: data.dropoffApartment ?? "",
                        dropoffEntrance: data.dropoffEntrance ?? "",
                        dropoffComment: data.dropoffComment ?? data.notes ?? "",
                    };
                });

                setOffers(list.slice(0, MAX_PENDING_OFFERS));
            },
            (e: any) => setErr(e?.message ?? t("courierErrorLoadOffers"))
        );

        return () => unsub();
    }, [user, t]);

    // active orders
    useEffect(() => {
        if (!user) return;

        const qActive = query(
            collection(db, "orders"),
            where("assignedCourierId", "==", user.uid),
            where("status", "in", ["taken", "picked_up"])
        );

        const unsub = onSnapshot(
            qActive,
            (snap) => setActiveOrders(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
            (e: any) => setErr(e?.message ?? t("courierErrorLoadActiveOrders"))
        );

        return () => unsub();
    }, [user, t]);

    // completed orders
    useEffect(() => {
        if (!user) return;

        const qCompleted = query(
            collection(db, "orders"),
            where("assignedCourierId", "==", user.uid),
            where("status", "==", "delivered")
        );

        const unsub = onSnapshot(
            qCompleted,
            (snap) => {
                const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
                list.sort((a: any, b: any) => {
                    const ta = a?.deliveredAt?.seconds ?? 0;
                    const tb = b?.deliveredAt?.seconds ?? 0;
                    return tb - ta;
                });
                setCompletedOrders(list);
            },
            (e: any) => setErr(e?.message ?? t("courierErrorLoadCompletedOrders"))
        );

        return () => unsub();
    }, [user, t]);

    // chats (courier) => unread + beep
    useEffect(() => {
        if (!user) return;

        const qChats = query(collection(db, "chats"), where("courierId", "==", user.uid));

        const unsub = onSnapshot(
            qChats,
            (snap) => {
                const nextUnread: Record<string, boolean> = {};

                for (const d of snap.docs) {
                    const data: any = d.data();
                    const chatId = d.id;

                    const orderId = String(data.orderId ?? "");
                    if (!orderId) continue;

                    const lastAtMs = data.lastMessageAt?.toMillis?.() ?? 0;
                    const lastSenderId = String(data.lastMessageSenderId ?? "");

                    const readAtMs =
                        (data.lastReadAtCourier ?? data.courierLastReadAt)?.toMillis?.() ?? 0;

                    const isUnread = lastAtMs > readAtMs && lastSenderId && lastSenderId !== user.uid;
                    nextUnread[chatId] = !!isUnread;

                    const prevMs = chatLastMsgAtByChatIdRef.current[chatId];

                    // первый снапшот — не бипаем
                    if (typeof prevMs !== "number") {
                        chatLastMsgAtByChatIdRef.current[chatId] = lastAtMs;
                        continue;
                    }

                    // новое сообщение
                    if (lastAtMs > prevMs) {
                        chatLastMsgAtByChatIdRef.current[chatId] = lastAtMs;

                        const isChatOpen = !!chatOpenRef.current[orderId];

                        if (lastSenderId && lastSenderId !== user.uid) {
                            if (!isChatOpen) {
                                playChatBeep();
                            } else {
                                // чат открыт — сразу считаем прочитанным
                                markChatRead(chatId);
                            }
                        }
                    }
                }

                setUnreadByChatId(nextUnread);
            },
            () => {}
        );

        return () => unsub();
    }, [user, markChatRead]);

    async function setOnline(next: boolean) {
        if (!user || !courierPrivateRef || !courierPublicRef) return;
        setErr(null);

        if (!next && activeOrders.length > 0) {
            setErr(t("courierErrorCannotOfflineActive"));
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
                {
                    courierId: user.uid,
                    isOnline: next,
                    lastSeenAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                },
                { merge: true }
            );

            setIsOnline(next);
            if (next) startTracking();
        } catch (e: any) {
            setErr(e?.message ?? t("courierErrorUpdateStatus"));
        }
    }

    function startTracking() {
        if (!courierPublicRef) return;
        if (!navigator.geolocation) {
            setErr(t("courierErrorGeoNotSupported"));
            return;
        }

        if (heartbeatId.current !== null) window.clearInterval(heartbeatId.current);

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
                    {
                        lat: last.lat,
                        lng: last.lng,
                        geohash,
                        lastSeenAt: serverTimestamp(),
                        updatedAt: serverTimestamp(),
                    },
                    { merge: true }
                );

                lastGeoWriteMsRef.current = now;
            } catch {
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
                        {
                            lat: latitude,
                            lng: longitude,
                            geohash,
                            lastSeenAt: serverTimestamp(),
                            updatedAt: serverTimestamp(),
                        },
                        { merge: true }
                    );

                    lastGeoWriteMsRef.current = now;
                } catch (e: any) {
                    setErr(e?.message ?? t("courierErrorUpdateLocation"));
                } finally {
                    geoWriteInFlightRef.current = false;
                }
            },
            (error) => setErr(error.message),
            { enableHighAccuracy: true, maximumAge: 10_000, timeout: 10_000 }
        );
    }

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
                if (!orderSnap.exists()) throw new Error(t("courierErrorOrderNotFound"));
                const orderData: any = orderSnap.data();

                // safety: cannot take чужой заказ
                if (String(orderData.currentOfferCourierId ?? "") !== uid) {
                    tx.update(offerRef, { status: "declined", updatedAt: serverTimestamp() });
                    throw new Error(t("courierErrorOfferNotForYou"));
                }

                if (orderData.status === "cancelled" || orderData.status === "delivered") {
                    tx.update(offerRef, { status: "declined", updatedAt: serverTimestamp() });
                    throw new Error(t("courierErrorOrderNotAvailable"));
                }

                if (orderData.assignedCourierId && orderData.assignedCourierId !== uid) {
                    tx.update(offerRef, { status: "declined", updatedAt: serverTimestamp() });
                    throw new Error(t("courierErrorOrderTaken"));
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
            setErr(e?.message ?? t("courierErrorAcceptOffer"));
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
        setErr(null);

        try {
            const keys = israelDateKey();
            await updateDoc(doc(db, "orders", orderId), {
                status: "delivered",
                deliveredAt: serverTimestamp(),
                ...keys,
                updatedAt: serverTimestamp(),
            });
        } catch (e: any) {
            setErr(e?.message ?? "Failed to mark delivered");
        } finally {
            setBusyOrderAction(null);
        }
    }

    async function logout() {
        if (activeOrders.length > 0) {
            setErr(t("courierErrorLogoutActive"));
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
                <div className="container container--mid">
                    <div className="card">
                        <div className="card__inner">{t("courierNotAuthorized")}</div>
                    </div>
                </div>
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
                                    {t("courierConsoleTitle")}
                                </div>
                                <div className="muted" style={{ marginTop: 6 }}>
                                    {t("courierConsoleSubtitle")}
                                </div>
                            </div>

                            <div className="row row--wrap row--mobile-stack" style={{ justifyContent: "flex-end" }}>
                <span className={`pill ${isOnline ? "pill--success" : "pill--muted"}`}>
                  {isOnline ? `● ${t("courierOnline")}` : `● ${t("courierOffline")}`}
                </span>

                                <button
                                    className="btn btn--success"
                                    onClick={async () => {
                                        primeAudio();

                                        // ✅ тут просим разрешение (user gesture) + сохраняем token
                                        try {
                                            await enablePush("courier");
                                        } catch (e: any) {
                                            // не блокируем онлайн — просто покажем ошибку (или console.warn)
                                            setErr(e?.message ?? "Failed to enable notifications");
                                        }

                                        setOnline(true);
                                    }}
                                    disabled={isOnline}
                                >
                                    {t("courierGoOnline")}
                                </button>


                                <button className="btn" onClick={() => setOnline(false)} disabled={!isOnline || hasActive}>
                                    {t("courierGoOffline")}
                                </button>
                                <button
                                    className={`btn ${pushEnabled ? "btn--ghost" : "btn--primary"}`}
                                    onClick={enableCourierPush}
                                    disabled={pushBusy || pushEnabled}
                                    title="Enable push notifications"
                                >
                                    {pushBusy ? "..." : pushEnabled ? "Notifications enabled" : "Enable notifications"}
                                </button>

                                <button className="btn btn--ghost" onClick={() => nav("/courier/app/reports")}>
                                    {t("reports")}
                                </button>

                                <button className="btn btn--ghost" onClick={logout} disabled={hasActive}>
                                    {t("logout")}
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
                                {t("courierActiveTab")}
                            </button>

                            <button
                                className={`btn ${tab === "completed" ? "btn--primary" : "btn--ghost"}`}
                                onClick={() => setTab("completed")}
                            >
                                {t("courierCompletedTab")}{" "}
                                <span className="pill pill--muted">{completedOrders.length}</span>
                            </button>
                        </div>
                    </div>
                </div>

                {/* ACTIVE TAB */}
                {tab === "active" && (
                    <>
                        <div style={{ height: 12 }} />

                        {/* Active orders */}
                        {activeOrders.length > 0 && (
                            <div className="stack">
                                {activeOrders.slice(0, MAX_ACTIVE_ORDERS).map((ord: any) => {
                                    const st: string | undefined = ord?.status;
                                    const canPickup = st === "taken";
                                    const canDeliver = st === "picked_up";
                                    const readyText = readyInText(ord?.readyAtMs, nowMs);
                                    const readyPill =
                                        readyText === "READY"
                                            ? t("courierReadyNow")
                                            : `${t("courierReadyInLabel")} ${readyText}`;

                                    const code =
                                        typeof ord?.shortCode === "string" && ord.shortCode
                                            ? ord.shortCode
                                            : shortId(ord.id);

                                    const pickupMain =
                                        wazeUrl(ord?.pickupLat, ord?.pickupLng) ??
                                        googleMapsUrl(ord?.pickupLat, ord?.pickupLng);
                                    const pickupYandex = yandexMapsUrl(ord?.pickupLat, ord?.pickupLng);

                                    const dropoffMain =
                                        wazeUrl(ord?.dropoffLat, ord?.dropoffLng) ??
                                        googleMapsUrl(ord?.dropoffLat, ord?.dropoffLng);
                                    const dropoffYandex = yandexMapsUrl(ord?.dropoffLat, ord?.dropoffLng);

                                    const courierLoc = lastGeoRef.current;
                                    const courierToPickupM =
                                        courierLoc && typeof ord?.pickupLat === "number" && typeof ord?.pickupLng === "number"
                                            ? haversineMeters(courierLoc.lat, courierLoc.lng, ord.pickupLat, ord.pickupLng)
                                            : null;

                                    const pickupToDropoffM = getPickupToDropoffMeters(ord);
                                    const totalTripM = (courierToPickupM ?? 0) + (pickupToDropoffM ?? 0);

                                    const drop = formatDropoffParts(ord);
                                    const extra = dropoffExtra(drop.apt, drop.ent);

                                    const chatId = `${ord.id}_${user.uid}`;
                                    const hasUnread = !!unreadByChatId[chatId] && !chatOpenByOrderId[ord.id];

                                    return (
                                        <div key={ord.id} className="card">
                                            <div className="card__inner">
                                                <div className="row row--between row--wrap">
                                                    <div className="row row--wrap">
                                                        <div style={{ fontWeight: 950, fontSize: 16 }}>
                                                            {t("courierActiveOrderTitle")}{" "}
                                                            <span className="mono">#{code}</span>
                                                        </div>

                                                        <span className={`pill pill--${pillToneForOrderStatus(ord.status)}`}>
                              {statusLabel(ord.status)}
                            </span>
                                                    </div>

                                                    <div className="row row--wrap">
                            <span className={`pill ${st === "taken" ? "pill--warning" : "pill--success"}`}>
                              1 · {t("courierStatusTaken")}
                            </span>
                                                        <span className={`pill ${st === "picked_up" ? "pill--info" : "pill--muted"}`}>
                              2 · {t("courierStatusPickedUp")}
                            </span>
                                                        <span className="pill pill--muted">3 · {t("courierStatusDelivered")}</span>

                                                        <span className={`pill ${readyText === "READY" ? "pill--success" : "pill--muted"}`}>
                              {readyPill}
                            </span>
                                                    </div>
                                                </div>

                                                <div className="hr" />

                                                <div className="subcard">
                                                    <div className="kv">
                                                        <div className="line">
                                                            <span>{t("courierCustomerLabel")}</span>
                                                            <b>{ord.customerName ?? "—"}</b>
                                                        </div>

                                                        <div className="line">
                                                            <span>{t("courierPhoneLabel")}</span>
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
                                                            <span>{t("courierAddressLabel")}</span>
                                                            <div style={{ textAlign: "right", fontWeight: 800 }}>
                                                                <div>{drop.main}</div>
                                                                {extra && <div className="muted" style={{ fontWeight: 600 }}>{extra}</div>}
                                                                {drop.comment && <div className="muted" style={{ fontWeight: 600 }}>{drop.comment}</div>}
                                                            </div>
                                                        </div>

                                                        <div className="line">
                                                            <span>{t("courierToRestaurantLabel")}</span>
                                                            <b>{courierToPickupM ? kmTextFromMeters(courierToPickupM) : "—"}</b>
                                                        </div>

                                                        <div className="line">
                                                            <span>{t("courierPickupToDropoffLabel")}</span>
                                                            <b>{pickupToDropoffM ? kmTextFromMeters(pickupToDropoffM) : "—"}</b>
                                                        </div>

                                                        <div className="line">
                                                            <span>{t("courierTotalTripLabel")}</span>
                                                            <b>{courierToPickupM || pickupToDropoffM ? kmTextFromMeters(totalTripM) : "—"}</b>
                                                        </div>

                                                        <div className="line">
                                                            <span>{t("courierTotalLabel")}</span>
                                                            <b>{money(ord.orderTotal)}</b>
                                                        </div>

                                                        <div className="line">
                                                            <span>{t("courierYourFeeLabel")}</span>
                                                            <b>{money(ord.deliveryFee)}</b>
                                                        </div>

                                                        <div className="line">
                                                            <span>{t("courierPayLabel")}</span>
                                                            <b>{paymentLabel(ord.paymentType)}</b>
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
                                                        {busyOrderAction === "pickup" ? t("courierSaving") : t("courierPickedUpAction")}
                                                    </button>

                                                    <button
                                                        className="btn btn--success"
                                                        onClick={() => markDelivered(ord.id)}
                                                        disabled={!canDeliver || busyOrderAction !== null}
                                                    >
                                                        {busyOrderAction === "deliver" ? t("courierSaving") : t("courierDeliveredAction")}
                                                    </button>

                                                    {canPickup && pickupMain && (
                                                        <a className="btn btn--ghost" href={pickupMain} target="_blank" rel="noreferrer">
                                                            {t("courierRouteToRestaurant")}
                                                        </a>
                                                    )}
                                                    {canPickup && pickupYandex && (
                                                        <a className="btn btn--ghost" href={pickupYandex} target="_blank" rel="noreferrer">
                                                            {t("courierYandex")}
                                                        </a>
                                                    )}

                                                    {canDeliver && dropoffMain && (
                                                        <a className="btn btn--ghost" href={dropoffMain} target="_blank" rel="noreferrer">
                                                            {t("courierRouteToCustomer")}
                                                        </a>
                                                    )}
                                                    {canDeliver && dropoffYandex && (
                                                        <a className="btn btn--ghost" href={dropoffYandex} target="_blank" rel="noreferrer">
                                                            {t("courierYandex")}
                                                        </a>
                                                    )}

                                                    <button
                                                        className="btn btn--ghost"
                                                        onClick={async () => {
                                                            primeAudio();
                                                            const willOpen = !chatOpenByOrderId[ord.id];

                                                            if (willOpen) {
                                                                try {
                                                                    await ensureChat(chatId, ord.id, String(ord.restaurantId ?? ""));
                                                                    await markChatRead(chatId);
                                                                } catch (e: any) {
                                                                    setErr(e?.message ?? t("courierErrorOpenChat"));
                                                                    return;
                                                                }
                                                            }

                                                            toggleChat(ord.id);
                                                        }}
                                                    >
                                                        {chatOpenByOrderId[ord.id] ? t("courierHideChat") : t("courierChat")}
                                                        {hasUnread && (
                                                            <span
                                                                style={{
                                                                    display: "inline-block",
                                                                    width: 8,
                                                                    height: 8,
                                                                    borderRadius: 999,
                                                                    marginLeft: 8,
                                                                    background: "crimson",
                                                                }}
                                                            />
                                                        )}
                                                    </button>
                                                </div>

                                                {chatOpenByOrderId[ord.id] && (
                                                    <OrderChat
                                                        chatId={chatId}
                                                        orderId={ord.id}
                                                        restaurantId={String(ord.restaurantId ?? "")}
                                                        courierId={user.uid}
                                                        myRole="courier"
                                                        disabled={ord.status === "cancelled"}
                                                    />
                                                )}

                                                {!canDeliver && (
                                                    <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>
                                                        {t("courierTipDeliveredAfterPickup")}
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
                                        <h3 style={{ margin: 0 }}>{t("courierNewOffersTitle")}</h3>
                                        <span className="pill pill--muted">{offers.length}</span>
                                    </div>

                                    <span className="pill pill--muted">
                    {t("courierActiveCountLabel")} {activeCount}/{MAX_ACTIVE_ORDERS}
                  </span>

                                    {reachedMaxActive && (
                                        <span className="pill pill--warning">
                      {t("courierMaxActiveReached")} {MAX_ACTIVE_ORDERS}
                    </span>
                                    )}
                                </div>

                                <div className="hr" />

                                {offers.length === 0 && <div className="muted">{t("courierNoNewOffers")}</div>}

                                <div className="stack">
                                    {offers.map((o) => {
                                        const pickupMain =
                                            wazeUrl(o.pickupLat, o.pickupLng) ?? googleMapsUrl(o.pickupLat, o.pickupLng);
                                        const pickupYandex = yandexMapsUrl(o.pickupLat, o.pickupLng);

                                        const isBusy = busyOfferId === o.id;
                                        const offerCode =
                                            typeof o.shortCode === "string" && o.shortCode ? o.shortCode : shortId(o.orderId);

                                        const readyText = readyInText(o.readyAtMs, nowMs);
                                        const readyPill =
                                            readyText === "READY"
                                                ? t("courierReadyNow")
                                                : `${t("courierReadyInLabel")} ${readyText}`;

                                        const courierLoc = lastGeoRef.current;
                                        const courierToPickupM =
                                            courierLoc && typeof o?.pickupLat === "number" && typeof o?.pickupLng === "number"
                                                ? haversineMeters(courierLoc.lat, courierLoc.lng, o.pickupLat, o.pickupLng)
                                                : null;

                                        const pickupToDropoffM = getPickupToDropoffMeters(o);
                                        const totalTripM = (courierToPickupM ?? 0) + (pickupToDropoffM ?? 0);

                                        const drop = formatDropoffParts(o);
                                        const extra = dropoffExtra(drop.apt, drop.ent);

                                        return (
                                            <div key={o.id} className="subcard">
                                                <div className="row row--between row--wrap">
                                                    <div className="row row--wrap">
                                                        <div style={{ fontWeight: 950 }}>
                                                            {t("courierOrderLabel")} <span className="mono">#{offerCode}</span>
                                                        </div>

                                                        <span className={`pill ${o.paymentType === "cash" ? "pill--muted" : "pill--info"}`}>
                              {paymentLabel(o.paymentType)}
                            </span>

                                                        <span className="pill pill--success">
                              {t("courierFeeLabel")} {money(o.deliveryFee)}
                            </span>

                                                        <span className={`pill ${readyText === "READY" ? "pill--success" : "pill--muted"}`}>
                              {readyPill}
                            </span>
                                                    </div>

                                                    {pickupMain && (
                                                        <a className="btn btn--ghost" href={pickupMain} target="_blank" rel="noreferrer">
                                                            {t("courierRouteToRestaurant")}
                                                        </a>
                                                    )}
                                                    {pickupYandex && (
                                                        <a className="btn btn--ghost" href={pickupYandex} target="_blank" rel="noreferrer">
                                                            {t("courierYandex")}
                                                        </a>
                                                    )}
                                                </div>

                                                <div style={{ height: 10 }} />

                                                <div className="kv">
                                                    <div className="line">
                                                        <span>{t("courierCustomerLabel")}</span>
                                                        <b>{o.customerName ?? "—"}</b>
                                                    </div>

                                                    <div className="line">
                                                        <span>{t("courierPhoneLabel")}</span>
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
                                                        <span>{t("courierAddressLabel")}</span>
                                                        <div style={{ textAlign: "right", fontWeight: 800 }}>
                                                            <div>{drop.main}</div>
                                                            {extra && <div className="muted" style={{ fontWeight: 600 }}>{extra}</div>}
                                                            {drop.comment && <div className="muted" style={{ fontWeight: 600 }}>{drop.comment}</div>}
                                                        </div>
                                                    </div>

                                                    <div className="line">
                                                        <span>{t("courierToRestaurantLabel")}</span>
                                                        <b>{courierToPickupM ? kmTextFromMeters(courierToPickupM) : "—"}</b>
                                                    </div>

                                                    <div className="line">
                                                        <span>{t("courierPickupToDropoffLabel")}</span>
                                                        <b>{pickupToDropoffM ? kmTextFromMeters(pickupToDropoffM) : "—"}</b>
                                                    </div>

                                                    <div className="line">
                                                        <span>{t("courierTotalTripLabel")}</span>
                                                        <b>{courierToPickupM || pickupToDropoffM ? kmTextFromMeters(totalTripM) : "—"}</b>
                                                    </div>

                                                    <div className="line">
                                                        <span>{t("courierTotalLabel")}</span>
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
                                                        {isBusy ? t("courierWorking") : t("courierAccept")}
                                                    </button>

                                                    <button className="btn btn--danger" onClick={() => declineOffer(o.id)} disabled={isBusy}>
                                                        {isBusy ? t("courierWorking") : t("courierDecline")}
                                                    </button>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>

                                <div className="muted" style={{ marginTop: 12, fontSize: 12 }}>
                                    {t("courierPresenceHint")}
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
                                    <h3 style={{ margin: 0 }}>{t("courierCompletedOrdersTitle")}</h3>
                                    <span className="pill pill--muted">{completedOrders.length}</span>
                                </div>

                                <div className="hr" />

                                {completedOrders.length === 0 && <div className="muted">{t("courierNoCompletedOrders")}</div>}

                                <div className="stack">
                                    {completedOrders.map((o: any) => {
                                        const code =
                                            typeof o?.shortCode === "string" && o.shortCode ? o.shortCode : shortId(o.id);

                                        const drop = formatDropoffParts(o);
                                        const extra = dropoffExtra(drop.apt, drop.ent);

                                        return (
                                            <div key={o.id} className="subcard">
                                                <div className="row row--between row--wrap">
                                                    <div style={{ fontWeight: 950 }}>
                                                        {t("courierOrderLabel")} <span className="mono">#{code}</span>
                                                    </div>
                                                    <span className="pill pill--success">{t("courierStatusDelivered")}</span>
                                                </div>

                                                <div style={{ height: 10 }} />

                                                <div className="kv">
                                                    <div className="line">
                                                        <span>{t("courierCustomerLabel")}</span>
                                                        <b>{o.customerName ?? "—"}</b>
                                                    </div>

                                                    <div className="line" style={{ alignItems: "baseline" }}>
                                                        <span>{t("courierAddressLabel")}</span>
                                                        <div style={{ textAlign: "right", fontWeight: 800 }}>
                                                            <div>{drop.main}</div>
                                                            {extra && <div className="muted" style={{ fontWeight: 600 }}>{extra}</div>}
                                                            {drop.comment && <div className="muted" style={{ fontWeight: 600 }}>{drop.comment}</div>}
                                                        </div>
                                                    </div>

                                                    <div className="line">
                                                        <span>{t("courierTotalLabel")}</span>
                                                        <b>{money(o.orderTotal)}</b>
                                                    </div>

                                                    <div className="line">
                                                        <span>{t("courierYourFeeLabel")}</span>
                                                        <b>{money(o.deliveryFee)}</b>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>

                                <div className="muted" style={{ marginTop: 12, fontSize: 12 }}>
                                    {t("courierDeliveredOrdersShownHint")}
                                </div>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
