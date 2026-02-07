import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { auth, db } from "../lib/firebase";
import { enablePush } from "../lib/push";
import { Capacitor } from "@capacitor/core";
import { enableNativePush, initNativePushListeners } from "../lib/push.native";
import { Geolocation } from "@capacitor/geolocation";
import { CourierMapPanel } from "../components/courier/CourierMapPanel";

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

import type { Offer } from "../lib/courier.shared";
import {
    ensureNativeGeolocationPermission,
    haversineMeters,
    israelDateKey,
} from "../lib/courier.shared";

import { CourierActiveOrdersList } from "../components/courier/CourierActiveOrdersList";
import { CourierOffersList } from "../components/courier/CourierOffersList";
import { CourierCompletedOrdersList } from "../components/courier/CourierCompletedOrdersList";

const MAX_ACTIVE_ORDERS = 3;
const MAX_PENDING_OFFERS = 3;

const GEO_WRITE_MIN_MS = 60_000;
const GEO_MIN_MOVE_M = 150;

export default function CourierAppHome() {
    const nav = useNavigate();
    const user = auth.currentUser;
    const isNative = Capacitor.isNativePlatform();

    const { t } = useI18n();

    const watchId = useRef<string | number | null>(null);
    const heartbeatId = useRef<number | null>(null);

    const lastGeoWriteMsRef = useRef<number>(0);
    const lastGeoRef = useRef<{ lat: number; lng: number } | null>(null);

    const [lastGeo, setLastGeo] = useState<{ lat: number; lng: number } | null>(null);
    const lastGeoUiSetMsRef = useRef(0);

    const updateLastGeoUi = useCallback((lat: number, lng: number) => {
        lastGeoRef.current = { lat, lng };

        const now = Date.now();
        if (now - lastGeoUiSetMsRef.current < 1200) return; // UI throttling
        lastGeoUiSetMsRef.current = now;

        setLastGeo({ lat, lng });
    }, []);

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
    const [pushEnabled, setPushEnabled] = useState<boolean>(() => {
        if (isNative) return false;
        return typeof Notification !== "undefined" && Notification.permission === "granted";
    });

    const enableCourierPush = useCallback(async () => {
        setErr(null);
        setPushBusy(true);

        try {
            if (Capacitor.isNativePlatform()) {
                await enableNativePush("courier");
            } else {
                await enablePush("courier");
            }

            setPushEnabled(true);
        } catch (e: any) {
            setErr(e?.message ?? "Failed to enable notifications");
        } finally {
            setPushBusy(false);
        }
    }, []);

    const [offers, setOffers] = useState<Offer[]>([]);
    const [selectedOfferId, setSelectedOfferId] = useState<string | null>(null);

    useEffect(() => {
        if (offers.length === 0) {
            setSelectedOfferId(null);
            return;
        }
        if (selectedOfferId && offers.some((o) => o.id === selectedOfferId)) return;
        setSelectedOfferId(offers[0].id);
    }, [offers, selectedOfferId]);

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

    const toggleChat = useCallback((orderId: string) => {
        setChatOpenByOrderId((prev) => ({ ...prev, [orderId]: !prev[orderId] }));
    }, []);

    // =======================
    // AUDIO
    // =======================
    const audioCtxRef = useRef<AudioContext | null>(null);
    // ===== OFFER RINGTONE (wav loop) =====
    const offerAudioRef = useRef<HTMLAudioElement | null>(null);
    const offerShouldRingRef = useRef(false);

    function getOfferAudio() {
        if (!offerAudioRef.current) {
            // файл лежит в web/public/sounds/offer.wav
            const a = new Audio("/sounds/offer.wav");
            a.preload = "auto";
            a.volume = 1.0;

            // Не надеемся на a.loop в WebView — делаем повтор сами:
            a.loop = false;

            a.addEventListener("ended", () => {
                if (!offerShouldRingRef.current) return;
                try {
                    a.currentTime = 0;
                    void a.play();
                } catch {}
            });

            offerAudioRef.current = a;
        }
        return offerAudioRef.current;
    }

    async function startOfferRingtoneLoop() {
        try {
            const a = getOfferAudio();
            if (!a.paused) return;
            a.currentTime = 0;
            await a.play();
        } catch {}
    }

    function stopOfferRingtoneLoop() {
        const a = offerAudioRef.current;
        if (!a) return;
        try {
            a.pause();
            a.currentTime = 0;
        } catch {}
    }

    function primeAudio() {
        const A = window.AudioContext || (window as any).webkitAudioContext;
        if (!A) return;
        if (!audioCtxRef.current) audioCtxRef.current = new A();
        if (audioCtxRef.current.state === "suspended") {
            audioCtxRef.current.resume().catch(() => {});
        }
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
        const handler = () => {
            primeAudio();
            try {
                getOfferAudio().load();
            } catch {}
        };

        window.addEventListener("pointerdown", handler, { once: true });
        return () => window.removeEventListener("pointerdown", handler);
    }, []);

    useEffect(() => {
        // в нативной сборке повесим listeners один раз
        if (Capacitor.isNativePlatform()) {
            initNativePushListeners().catch(() => {});
        }
    }, []);

    // offers ringtone loop пока есть offers
    useEffect(() => {
        const hasOffers = isOnline && offers.length > 0;

        const sync = () => {
            const shouldRing = hasOffers && document.visibilityState === "visible";
            offerShouldRingRef.current = shouldRing;

            if (shouldRing) void startOfferRingtoneLoop();
            else stopOfferRingtoneLoop();
        };

        sync();
        document.addEventListener("visibilitychange", sync);

        return () => {
            document.removeEventListener("visibilitychange", sync);
            offerShouldRingRef.current = false;
            stopOfferRingtoneLoop();
        };
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

    const ensureChat = useCallback(
        async (chatId: string, orderId: string, restaurantId: string) => {
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
        },
        [user]
    );

    const handleChatButton = useCallback(
        async (args: { orderId: string; chatId: string; restaurantId: string; willOpen: boolean }) => {
            primeAudio();

            if (args.willOpen) {
                try {
                    await ensureChat(args.chatId, args.orderId, args.restaurantId);
                    await markChatRead(args.chatId);
                } catch (e: any) {
                    setErr(e?.message ?? t("courierErrorOpenChat"));
                    return;
                }
            }

            toggleChat(args.orderId);
        },
        [ensureChat, markChatRead, t, toggleChat]
    );

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

                    const readAtMs = (data.lastReadAtCourier ?? data.courierLastReadAt)?.toMillis?.() ?? 0;

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
            try {
                if (Capacitor.isNativePlatform()) {
                    await Geolocation.clearWatch({ id: String(watchId.current) });
                } else {
                    navigator.geolocation.clearWatch(Number(watchId.current));
                }
            } catch {}
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
            if (next) await startTracking();
        } catch (e: any) {
            setErr(e?.message ?? t("courierErrorUpdateStatus"));
        }
    }

    async function startTracking() {
        if (!courierPublicRef) return;

        const isNativeBuild = Capacitor.isNativePlatform();

        // cleanup
        if (heartbeatId.current !== null) {
            window.clearInterval(heartbeatId.current);
            heartbeatId.current = null;
        }

        if (watchId.current !== null) {
            try {
                if (isNativeBuild) {
                    await Geolocation.clearWatch({ id: String(watchId.current) });
                } else if (navigator.geolocation) {
                    navigator.geolocation.clearWatch(Number(watchId.current));
                }
            } catch {}
            watchId.current = null;
        }

        // Heartbeat
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

        if (isNativeBuild) {
            let perm = await Geolocation.checkPermissions();
            if (perm.location !== "granted") {
                perm = await Geolocation.requestPermissions({ permissions: ["location"] });
            }

            if (perm.location !== "granted") {
                setErr("Location permission is required. Enable it in Settings → Apps → Permissions → Location.");
                return;
            }

            try {
                const first = await Geolocation.getCurrentPosition({
                    enableHighAccuracy: true,
                    timeout: 10_000,
                    maximumAge: 10_000,
                });
                updateLastGeoUi(first.coords.latitude, first.coords.longitude);
            } catch (e: any) {
                setErr(e?.message ?? "Failed to get location. Turn on GPS / Location Services.");
                return;
            }

            const id = await Geolocation.watchPosition(
                { enableHighAccuracy: true, timeout: 10_000, maximumAge: 10_000 },
                async (pos, geoErr) => {
                    if (geoErr) {
                        setErr(geoErr.message ?? "Geolocation error");
                        return;
                    }
                    if (!pos) return;

                    const { latitude, longitude } = pos.coords;

                    const now = Date.now();
                    const prev = lastGeoRef.current;
                    const moved = prev ? haversineMeters(prev.lat, prev.lng, latitude, longitude) : Infinity;

                    updateLastGeoUi(latitude, longitude);

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
                }
            );

            watchId.current = id;
            return;
        }

        // WEB fallback
        if (!navigator.geolocation) {
            setErr(t("courierErrorGeoNotSupported"));
            return;
        }

        watchId.current = navigator.geolocation.watchPosition(
            async (pos) => {
                const { latitude, longitude } = pos.coords;

                const now = Date.now();
                const prev = lastGeoRef.current;
                const moved = prev ? haversineMeters(prev.lat, prev.lng, latitude, longitude) : Infinity;

                updateLastGeoUi(latitude, longitude);

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

                                        // 0) native geo permission
                                        if (Capacitor.isNativePlatform()) {
                                            const okGeo = await ensureNativeGeolocationPermission();
                                            if (!okGeo) {
                                                setErr("Geolocation is required. Please enable Location (GPS) and allow Location permission for the app.");
                                                return;
                                            }
                                        }

                                        // 1) native push
                                        try {
                                            if (Capacitor.isNativePlatform()) {
                                                await enableNativePush("courier");
                                                setPushEnabled(true);
                                            }
                                        } catch (e: any) {
                                            setErr(e?.message ?? "Failed to enable push notifications");
                                            return;
                                        }

                                        // 2) online
                                        await setOnline(true);
                                    }}
                                    disabled={isOnline}
                                >
                                    {t("courierGoOnline")}
                                </button>

                                <button className="btn" onClick={() => setOnline(false)} disabled={!isOnline || hasActive}>
                                    {t("courierGoOffline")}
                                </button>

                                {!isNative && (
                                    <button
                                        className={`btn ${pushEnabled ? "btn--ghost" : "btn--primary"}`}
                                        onClick={enableCourierPush}
                                        disabled={pushBusy || pushEnabled}
                                        title="Enable push notifications"
                                    >
                                        {pushBusy ? "..." : pushEnabled ? "Notifications enabled" : "Enable notifications"}
                                    </button>
                                )}

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
                                {t("courierCompletedTab")} <span className="pill pill--muted">{completedOrders.length}</span>
                            </button>
                        </div>
                    </div>
                </div>

                {/* ACTIVE TAB */}
                {tab === "active" && (
                    <>
                        <div style={{ height: 12 }} />

                        <CourierMapPanel
                            courier={lastGeo}
                            offers={offers}
                            activeOrders={activeOrders.slice(0, MAX_ACTIVE_ORDERS)}
                            selectedOfferId={selectedOfferId}
                            setSelectedOfferId={setSelectedOfferId}
                        />

                        <div style={{ height: 12 }} />

                        <CourierActiveOrdersList
                            orders={activeOrders}
                            max={MAX_ACTIVE_ORDERS}
                            nowMs={nowMs}
                            courier={lastGeo}
                            userId={user.uid}
                            chatOpenByOrderId={chatOpenByOrderId}
                            unreadByChatId={unreadByChatId}
                            busyOrderAction={busyOrderAction}
                            onMarkPickedUp={markPickedUp}
                            onMarkDelivered={markDelivered}
                            onChatButton={handleChatButton}
                        />

                        <div style={{ height: 12 }} />

                        <CourierOffersList
                            offers={offers}
                            selectedOfferId={selectedOfferId}
                            setSelectedOfferId={setSelectedOfferId}
                            busyOfferId={busyOfferId}
                            reachedMaxActive={reachedMaxActive}
                            activeCount={activeCount}
                            maxActive={MAX_ACTIVE_ORDERS}
                            nowMs={nowMs}
                            courier={lastGeo}
                            onAcceptOffer={acceptOffer}
                            onDeclineOffer={declineOffer}
                        />
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

                                <CourierCompletedOrdersList orders={completedOrders} />

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
