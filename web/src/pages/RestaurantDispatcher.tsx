import { useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth, db } from "../lib/firebase";
import {
    collection,
    doc,
    onSnapshot,
    query,
    runTransaction,
    serverTimestamp,
    updateDoc,
    where,
    type Timestamp,
} from "firebase/firestore";

const OFFER_TIMEOUT_MS = 25_000;
// @ts-ignore
const REOFFER_SAME_COURIER_COOLDOWN_MS = 20_000; // пауза перед повтором тому же курьеру

const ONLINE_STALE_MS = 2 * 60_000;

const MAX_ACTIVE_ORDERS = 3;
const MAX_PENDING_OFFERS = 3;

type CourierPublic = {
    id: string;
    isOnline?: boolean;
    lat?: number;
    lng?: number;
    lastSeenAt?: Timestamp;

    // опционально (если ты позже начнёшь писать эти поля из courier app)
    activeOrdersCount?: number;
    pendingOffersCount?: number;
};

type OrderDoc = {
    id: string;
    restaurantId: string;
    status?: string;
    assignedCourierId?: string | null;

    pickupLat?: number;
    pickupLng?: number;
    pickupGeohash?: string;
    pickupAddressText?: string;

    customerName?: string;
    customerPhone?: string;
    customerAddress?: string;

    dropoffLat?: number;
    dropoffLng?: number;
    dropoffGeohash?: string;
    dropoffAddressText?: string;

    paymentType?: string;
    orderSubtotal?: number;
    deliveryFee?: number;
    orderTotal?: number;

    courierPaysAtPickup?: number;
    courierCollectsFromCustomer?: number;
    courierGetsFromRestaurantAtPickup?: number;

    lastOfferedCourierId?: string | null;

    lastOfferedAt?: Timestamp;
    offerExpiresAtMs?: number;
    currentOfferCourierId?: string | null;
    reofferAfterMs?: number;

};

type PendingOffer = {
    id: string;
    orderId: string;
    courierId: string;
    createdAt?: Timestamp;
};

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

function isFresh(ts?: Timestamp) {
    if (!ts) return true;
    return Date.now() - ts.toMillis() <= ONLINE_STALE_MS;
}

export function RestaurantDispatcher() {
    const [uid, setUid] = useState<string | null>(auth.currentUser?.uid ?? null);

    const [orders, setOrders] = useState<OrderDoc[]>([]);
    const [couriers, setCouriers] = useState<CourierPublic[]>([]);
    const [pendingOffers, setPendingOffers] = useState<PendingOffer[]>([]);

    const inFlightOrderIds = useRef<Set<string>>(new Set());
    const inFlightOfferIds = useRef<Set<string>>(new Set());
    const dispatchTickInFlightRef = useRef(false);


    useEffect(() => {
        const unsub = onAuthStateChanged(auth, (u) => setUid(u?.uid ?? null));
        return () => unsub();
    }, []);

    // 1) Все заказы текущего ресторана (диспетчеру нужно знать статус/assigned/cancelled)
    useEffect(() => {
        if (!uid) return;

        const q = query(collection(db, "orders"), where("restaurantId", "==", uid));
        const unsub = onSnapshot(q, (snap) => {
            const list: OrderDoc[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
            setOrders(list);
        });

        return () => unsub();
    }, [uid]);

    // 2) Pending offers этого ресторана (чтобы знать “какие заказы сейчас уже предложены”)
    useEffect(() => {
        if (!uid) return;

        const q = query(
            collection(db, "offers"),
            where("restaurantId", "==", uid),
            where("status", "==", "pending")
        );

        const unsub = onSnapshot(q, (snap) => {
            const list: PendingOffer[] = snap.docs.map((d) => {
                const data: any = d.data();
                return {
                    id: d.id,
                    orderId: String(data.orderId ?? ""),
                    courierId: String(data.courierId ?? ""),
                    createdAt: data.createdAt,
                };
            });

            setPendingOffers(list);
        });

        return () => unsub();
    }, [uid]);

    // 3) Курьеры онлайн
    useEffect(() => {
        if (!uid) return;

        const q = query(collection(db, "courierPublic"), where("isOnline", "==", true));
        const unsub = onSnapshot(q, (snap) => {
            const list: CourierPublic[] = snap.docs.map((d) => {
                const data: any = d.data();
                return {
                    id: d.id,
                    isOnline: !!data.isOnline,
                    lat: data.lat,
                    lng: data.lng,
                    lastSeenAt: data.lastSeenAt,
                    activeOrdersCount: Number(data.activeOrdersCount ?? 0),
                    pendingOffersCount: Number(data.pendingOffersCount ?? 0),
                };
            });
            setCouriers(list);
        });

        return () => unsub();
    }, [uid]);

    const orderById = useMemo(() => {
        const m = new Map<string, OrderDoc>();
        for (const o of orders) m.set(o.id, o);
        return m;
    }, [orders]);

    const pendingOfferByOrderId = useMemo(() => {
        const m = new Map<string, PendingOffer>();
        for (const off of pendingOffers) {
            if (!m.has(off.orderId)) m.set(off.orderId, off);
        }
        return m;
    }, [pendingOffers]);

    const usableCouriers = useMemo(() => {
        return couriers.filter((c) => {
            if (!c.isOnline) return false;
            if (typeof c.lat !== "number" || typeof c.lng !== "number") return false;
            if (!isFresh(c.lastSeenAt)) return false;

            // Эти поля появятся, если ты захочешь (не обязательно для MVP)
            if ((c.activeOrdersCount ?? 0) >= MAX_ACTIVE_ORDERS) return false;
            if ((c.pendingOffersCount ?? 0) >= MAX_PENDING_OFFERS) return false;

            return true;
        });
    }, [couriers]);

    function pickCourierId(order: OrderDoc, candidates: CourierPublic[]): string | null {
        const pickupLat = order.pickupLat;
        const pickupLng = order.pickupLng;
        if (typeof pickupLat !== "number" || typeof pickupLng !== "number") return null;

        const sortedIds = candidates
            .map((c) => ({
                id: c.id,
                dist: haversineMeters(pickupLat, pickupLng, c.lat as number, c.lng as number),
            }))
            .sort((a, b) => a.dist - b.dist)
            .map((x) => x.id);

        if (sortedIds.length === 0) return null;

        // “следующий после последнего” (циклом). Это даёт:
        // nearest → declined/timeout → next nearest → ... → обратно к nearest
        const last = order.lastOfferedCourierId ?? null;
        if (!last) return sortedIds[0];

        const idx = sortedIds.indexOf(last);
        if (idx === -1) return sortedIds[0];
        return sortedIds[(idx + 1) % sortedIds.length];
    }

    async function createOfferTx(restaurantId: string | null, orderId: string, courierId: string) {
        const orderRef = doc(db, "orders", orderId);
        const offerRef = doc(collection(db, "offers")); // auto id

        await runTransaction(db, async (tx) => {
            const snap = await tx.get(orderRef);
            if (!snap.exists()) return;

            const o: any = snap.data();

            // базовые проверки
            if (o.restaurantId !== restaurantId) return;
            if (o.assignedCourierId) return;
            if (!(o.status === "new" || o.status === "offered")) return;

            const nowMs = Date.now();

            // ✅ АНТИ-ДУБЛЬ: если мы уже предлагали оффер совсем недавно — НЕ создаём второй
            // (это защищает от гонки orders-snapshot vs offers-snapshot, StrictMode и т.п.)
            const lastOfferedAtMs = o.lastOfferedAt?.toMillis?.();
            if (typeof lastOfferedAtMs === "number" && nowMs - lastOfferedAtMs < OFFER_TIMEOUT_MS - 500) {
                return;
            }

            // ✅ Доп. защита (если ты когда-то включишь Cloud Functions, которые пишут offerExpiresAtMs)
            const expMs = typeof o.offerExpiresAtMs === "number" ? o.offerExpiresAtMs : null;
            if (expMs !== null && expMs > nowMs) {
                return;
            }

            const expiresAtMs = nowMs + OFFER_TIMEOUT_MS;

            tx.set(offerRef, {
                restaurantId,
                courierId,
                orderId: snap.id,

                pickupLat: o.pickupLat ?? null,
                pickupLng: o.pickupLng ?? null,
                pickupGeohash: o.pickupGeohash ?? null,
                pickupAddressText: o.pickupAddressText ?? null,

                customerName: o.customerName ?? null,
                customerPhone: o.customerPhone ?? null,
                customerAddress: o.customerAddress ?? null,

                dropoffLat: o.dropoffLat ?? null,
                dropoffLng: o.dropoffLng ?? null,
                dropoffGeohash: o.dropoffGeohash ?? null,
                dropoffAddressText: o.dropoffAddressText ?? null,

                paymentType: o.paymentType ?? null,
                orderSubtotal: o.orderSubtotal ?? null,
                deliveryFee: o.deliveryFee ?? null,
                orderTotal: o.orderTotal ?? null,

                courierPaysAtPickup: o.courierPaysAtPickup ?? null,
                courierCollectsFromCustomer: o.courierCollectsFromCustomer ?? null,
                courierGetsFromRestaurantAtPickup: o.courierGetsFromRestaurantAtPickup ?? null,

                status: "pending",
                expiresAtMs, // удобно для дебага (и если захочешь фильтровать/чистить)
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
            });

            tx.update(orderRef, {
                status: "offered",
                lastOfferedCourierId: courierId,
                lastOfferedAt: serverTimestamp(),

                // доп. поля-лок (чтобы разные “диспетчеры” не дублировали)
                currentOfferCourierId: courierId,
                offerExpiresAtMs: expiresAtMs,
                reofferAfterMs: null,
                updatedAt: serverTimestamp(),


            });
        });
    }

    // A) Каждые ~2 сек:
    //    - если заказ cancelled/уже взят → cancel pending offer
    //    - если offer > 25 сек → expired
    useEffect(() => {
        if (!uid) return;

        const timer = window.setInterval(async () => {
            for (const off of pendingOffers) {
                const ord = orderById.get(off.orderId);
                if (!ord) continue;

                // если заказ отменён или уже назначен — pending оффер не должен висеть
                const isAssigned = !!ord.assignedCourierId;
                if (ord.status === "cancelled" || isAssigned) {
                    if (inFlightOfferIds.current.has(off.id)) continue;
                    inFlightOfferIds.current.add(off.id);
                    try {
                        await updateDoc(doc(db, "offers", off.id), {
                            status: "cancelled",
                            updatedAt: serverTimestamp(),
                        });
                    } catch {}
                    finally {
                        inFlightOfferIds.current.delete(off.id);
                    }
                    continue;
                }

                const createdMs = off.createdAt?.toMillis?.();
                if (!createdMs) continue;

                // маленький буфер, чтобы не стучаться в rules раньше времени
                if (Date.now() - createdMs < OFFER_TIMEOUT_MS + 1000) continue;

                if (inFlightOfferIds.current.has(off.id)) continue;
                inFlightOfferIds.current.add(off.id);
                try {
                    await updateDoc(doc(db, "offers", off.id), {
                        status: "expired",
                        updatedAt: serverTimestamp(),
                    });
                } catch {}
                finally {
                    inFlightOfferIds.current.delete(off.id);
                }
            }
        }, 2000);

        return () => window.clearInterval(timer);
    }, [uid, pendingOffers, orderById]);

    // B) Создаём офферы там, где “нет pending оффера”
    useEffect(() => {
        if (!uid) return;

        let cancelled = false;

        async function dispatchOnce() {
            if (cancelled) return;
            if (dispatchTickInFlightRef.current) return;

            dispatchTickInFlightRef.current = true;
            try {
                const openOrders = orders.filter((o) => {
                    const isOpen = o.status === "new" || o.status === "offered";
                    const unassigned = !o.assignedCourierId;
                    const notCancelled = o.status !== "cancelled";
                    return isOpen && unassigned && notCancelled;
                });

                for (const ord of openOrders) {
                    if (pendingOfferByOrderId.has(ord.id)) continue;

                    const courierId = pickCourierId(ord, usableCouriers);

                    // нет курьеров онлайн — просто ждём
                    if (!courierId) {
                        if (ord.status === "offered") {
                            try {
                                await updateDoc(doc(db, "orders", ord.id), {
                                    status: "new",
                                    updatedAt: serverTimestamp(),
                                });
                            } catch {}
                        }
                        continue;
                    }

                    if (inFlightOrderIds.current.has(ord.id)) continue;
                    inFlightOrderIds.current.add(ord.id);

                    try {
                        await createOfferTx(uid, ord.id, courierId);
                    } catch {}
                    finally {
                        inFlightOrderIds.current.delete(ord.id);
                    }
                }
            } finally {
                dispatchTickInFlightRef.current = false;
            }
        }

        dispatchOnce(); // сразу
        const id = window.setInterval(dispatchOnce, 2000);

        return () => {
            cancelled = true;
            window.clearInterval(id);
        };
    }, [uid, orders, pendingOfferByOrderId, usableCouriers]);


    return null;
}
