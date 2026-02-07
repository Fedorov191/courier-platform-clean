import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { onDocumentCreated, onDocumentUpdated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";

// ✅ PUSH функции живут в отдельном файле functions/src/push.ts
// ✅ Здесь только re-export (верхний уровень)
export { notifyOfferCreated, notifyChatMessageCreated } from "./push";

// ----------------------------
// INIT
// ----------------------------
if (!admin.apps.length) {
    admin.initializeApp();
}
const db = admin.firestore();

// ----------------------------
// CONFIG
// ----------------------------

// ⚠️ offer timeout (логика оффера)
const OFFER_TIMEOUT_MS = 55_000;

// courier online freshness
const ONLINE_STALE_MS = 2 * 60_000;

// offer retention (TTL уже включил в Firestore)
const OFFER_RETENTION_DAYS = 7;
const OFFER_RETENTION_MS = OFFER_RETENTION_DAYS * 24 * 60 * 60 * 1000;

// лимиты (пока софт-логика, можно усилить позже)
const MAX_ACTIVE_ORDERS = 3;
const MAX_PENDING_OFFERS = 3;

// сколько курьеров максимум читаем за раз (MVP)
const COURIERS_LIMIT = 200;

// сколько документов обрабатываем за тик
const TICK_LIMIT = 200;
const ACTIVE_ORDER_STATUSES = ["taken", "picked_up"] as const;

// TTL field name (ВАЖНО: это имя ты выбираешь в Firestore TTL настройке)
const TTL_FIELD = "cleanupAt"; // ✅ так и оставляем

// ----------------------------
// HELPERS
// ----------------------------
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

function isOpenOrderStatus(s?: string) {
    return s === "new" || s === "offered";
}

type CourierPublic = {
    id: string;
    isOnline?: boolean;
    lat?: number;
    lng?: number;
    lastSeenAt?: Timestamp;
    activeOrdersCount?: number;
    pendingOffersCount?: number;
};
// ----------------------------
// COUNTERS: activeOrdersCount / pendingOffersCount
// ----------------------------

async function setCourierPublicCounters(
    courierId: string,
    patch: Record<string, any>
): Promise<void> {
    if (!courierId) return;
    await db
        .collection("courierPublic")
        .doc(courierId)
        .set(
            {
                ...patch,
                countersUpdatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
        );
}

async function recountPendingOffersCount(courierId: string): Promise<void> {
    if (!courierId) return;

    const nowMs = Date.now();

    // ⚠️ без range-фильтра по expiresAtMs, чтобы не требовать новый индекс.
    // (courierId + status индекс у нас уже есть)
    const snap = await db
        .collection("offers")
        .where("courierId", "==", courierId)
        .where("status", "==", "pending")
        .limit(50)
        .get();

    let count = 0;
    for (const d of snap.docs) {
        const off: any = d.data();
        const exp = Number(off.expiresAtMs ?? 0);
        if (exp > nowMs) {
            count++;
            if (count >= MAX_PENDING_OFFERS + 5) break; // порог важнее точности
        }
    }

    await setCourierPublicCounters(courierId, { pendingOffersCount: count });
}

async function recountActiveOrdersCount(courierId: string): Promise<void> {
    if (!courierId) return;

    const snap = await db
        .collection("orders")
        .where("assignedCourierId", "==", courierId)
        .where("status", "in", Array.from(ACTIVE_ORDER_STATUSES))
        .limit(50)
        .get();

    const count = Math.min(snap.size, MAX_ACTIVE_ORDERS + 5);
    await setCourierPublicCounters(courierId, { activeOrdersCount: count });
}

function pickCourierId(order: any, candidates: CourierPublic[]): string | null {
    const pickupLat = order?.pickupLat;
    const pickupLng = order?.pickupLng;
    if (typeof pickupLat !== "number" || typeof pickupLng !== "number") return null;

    const sorted = candidates
        .map((c) => ({
            id: c.id,
            dist: haversineMeters(pickupLat, pickupLng, c.lat as number, c.lng as number),
        }))
        .sort((a, b) => a.dist - b.dist)
        .map((x) => x.id);

    if (sorted.length === 0) return null;

    const last = order?.lastOfferedCourierId ?? null;
    if (!last) return sorted[0];

    const idx = sorted.indexOf(last);
    if (idx === -1) return sorted[0];
    return sorted[(idx + 1) % sorted.length];
}

// ----------------------------
// ROUTES API QUOTE
// ----------------------------
const GOOGLE_MAPS_API_KEY = defineSecret("GOOGLE_MAPS_API_KEY");

type LatLng = { lat: number; lng: number };

function calcDeliveryFee(distanceMeters: number) {
    const km = distanceMeters / 1000;
    const base = 17;
    const perKm = 3.5;

    const extraKm = Math.max(0, km - 3);
    const raw = base + extraKm * perKm;

    // чтобы не словить 17.699999999 из-за float
    const fee = Math.round((raw + Number.EPSILON) * 100) / 100;

    return { km, fee };
}

export const getRouteQuote = onCall(
    {
        region: "europe-west1",
        secrets: [GOOGLE_MAPS_API_KEY],
    },
    async (req) => {
        if (!req.auth) throw new HttpsError("unauthenticated", "Login required");

        const { origin, destination } = (req.data ?? {}) as {
            origin?: LatLng;
            destination?: LatLng;
        };

        const ok =
            origin &&
            destination &&
            typeof origin.lat === "number" &&
            typeof origin.lng === "number" &&
            typeof destination.lat === "number" &&
            typeof destination.lng === "number";

        if (!ok) {
            throw new HttpsError("invalid-argument", "origin/destination {lat,lng} required");
        }

        const key = GOOGLE_MAPS_API_KEY.value();
        const url = "https://routes.googleapis.com/directions/v2:computeRoutes";

        const body = {
            origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
            destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
            travelMode: "DRIVE",
            routingPreference: "TRAFFIC_AWARE",
            computeAlternativeRoutes: false,
            languageCode: "en-US",
            units: "METRIC",
        };

        const resp = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Goog-Api-Key": key,
                "X-Goog-FieldMask": "routes.distanceMeters,routes.duration",
            },
            body: JSON.stringify(body),
        });

        if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            logger.warn("Routes API error", { status: resp.status, text });
            throw new HttpsError("internal", "Failed to compute route");
        }

        const json: any = await resp.json();
        const r0 = json?.routes?.[0];

        const distanceMeters = Number(r0?.distanceMeters ?? NaN);

        // duration приходит строкой вида "123s"
        const durationStr = String(r0?.duration ?? "0s");
        const m = durationStr.match(/^(\d+(?:\.\d+)?)s$/);
        const durationSeconds = m ? Number(m[1]) : 0;

        if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
            throw new HttpsError("internal", "Route distance missing");
        }

        const { km, fee } = calcDeliveryFee(distanceMeters);

        return {
            distanceMeters,
            distanceKm: km,
            durationSeconds,
            deliveryFee: fee,
            currency: "ILS",
            pricingVersion: "v1_routes_api_2026_01",
        };
    }
);
// ----------------------------
// ROUTES API: OFFER ROUTE (polyline)
// ----------------------------
// Для courier map-first: рисуем линию маршрута ТОЛЬКО на экране pending offer.
// Routes API key остаётся в SecretManager (GOOGLE_MAPS_API_KEY).

type RoutePolylineResult = {
    polyline: string;
    distanceMeters: number;
    durationSeconds: number;
};

function parseDurationSeconds(duration: any): number {
    // Routes API duration приходит строкой вида "123s" (иногда "123.4s")
    const durationStr = String(duration ?? "0s");
    const m = durationStr.match(/^(\d+(?:\.\d+)?)s$/);
    return m ? Number(m[1]) : 0;
}

async function computeRoutePolyline(origin: LatLng, destination: LatLng): Promise<RoutePolylineResult> {
    const key = GOOGLE_MAPS_API_KEY.value();
    const url = "https://routes.googleapis.com/directions/v2:computeRoutes";

    const body = {
        origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
        destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
        computeAlternativeRoutes: false,
        languageCode: "en-US",
        units: "METRIC",
    };

    const resp = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": key,
            // Важно: просим полилинию + distance + duration
            "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline",
        },
        body: JSON.stringify(body),
    });

    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        logger.warn("Routes API error (polyline)", { status: resp.status, text });
        throw new HttpsError("internal", "Failed to compute route polyline");
    }

    const json: any = await resp.json();
    const r0 = json?.routes?.[0];

    const distanceMeters = Number(r0?.distanceMeters ?? NaN);
    const durationSeconds = parseDurationSeconds(r0?.duration);
    const polyline = String(r0?.polyline?.encodedPolyline ?? "");

    if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
        throw new HttpsError("internal", "Route distance missing");
    }
    if (!polyline || polyline.length < 10) {
        throw new HttpsError("internal", "Route polyline missing");
    }

    return { polyline, distanceMeters, durationSeconds };
}

export const getOfferRoute = onCall(
    {
        region: "europe-west1",
        secrets: [GOOGLE_MAPS_API_KEY],
    },
    async (req) => {
        if (!req.auth) throw new HttpsError("unauthenticated", "Login required");

        const { courier, pickup, dropoff } = (req.data ?? {}) as {
            courier?: LatLng | null;
            pickup?: LatLng;
            dropoff?: LatLng;
        };

        const okPickup = pickup && typeof pickup.lat === "number" && typeof pickup.lng === "number";
        const okDropoff = dropoff && typeof dropoff.lat === "number" && typeof dropoff.lng === "number";
        const okCourier = !courier || (typeof courier.lat === "number" && typeof courier.lng === "number");

        if (!okPickup || !okDropoff || !okCourier) {
            throw new HttpsError(
                "invalid-argument",
                "courier?(lat,lng), pickup(lat,lng), dropoff(lat,lng) required"
            );
        }

        // pickup->dropoff (оплачиваемый)
        // courier->pickup (не оплачиваемый, но можем показать серым/другим цветом)
        const [pickupToDropoff, courierToPickup] = await Promise.all([
            computeRoutePolyline(pickup as LatLng, dropoff as LatLng),
            courier ? computeRoutePolyline(courier as LatLng, pickup as LatLng) : Promise.resolve(null),
        ]);

        return {
            pickupToDropoff,
            courierToPickup,
            currency: "ILS",
            pricingVersion: "v1_offer_route_2026_02",
        };
    }
);

/**
 * Главная функция: создать pending offer для order (если можно)
 * - защищена транзакцией
 * - не создаёт дубль, если уже есть активный offer (expiresAtMs > now)
 */
async function dispatchOrder(orderId: string, reason: string) {
    const nowMs = Date.now();
    const orderRef = db.collection("orders").doc(orderId);

    await db.runTransaction(async (tx) => {
        // --------------------
        // READS (ONLY) FIRST
        // --------------------
        const orderSnap = await tx.get(orderRef);
        if (!orderSnap.exists) return;

        const o: any = orderSnap.data();

        // базовые проверки
        if (!isOpenOrderStatus(o.status)) return;
        if (o.assignedCourierId) return;
        if (o.status === "cancelled" || o.status === "delivered") return;

        // ✅ HARD DEDUP: читаем офферы по orderId (ДО любых записей!)
        const offersSnap = await tx.get(db.collection("offers").where("orderId", "==", orderId).limit(50));

        const offers = offersSnap.docs.map((d) => ({
            id: d.id,
            ref: d.ref,
            data: d.data() as any,
        }));

        const pending = offers.filter((x) => String(x.data?.status ?? "") === "pending");
        const activePending = pending.find((x) => Number(x.data?.expiresAtMs ?? 0) > nowMs);

        // Если есть активный pending — “лечим” order и закрываем дубли
        if (activePending) {
            // --------------------
            // WRITES
            // --------------------
            for (const x of pending) {
                if (x.id === activePending.id) continue;
                tx.update(x.ref, {
                    status: "expired",
                    updatedAt: FieldValue.serverTimestamp(),
                    expiredBy: reason,
                });
            }

            tx.update(orderRef, {
                status: "offered",
                currentOfferId: activePending.id,
                currentOfferCourierId: activePending.data?.courierId ?? null,
                offerExpiresAtMs: Number(activePending.data?.expiresAtMs ?? null),
                updatedAt: FieldValue.serverTimestamp(),
            });

            return;
        }

        // ✅ Нет активного pending — значит можно создавать новый.
        // Но сначала читаем курьеров (всё ещё READS!)
        const couriersSnap = await tx.get(
            db.collection("courierPublic").where("isOnline", "==", true).limit(COURIERS_LIMIT)
        );

        const candidates: CourierPublic[] = couriersSnap.docs
            .map((d) => {
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
            })
            .filter((c) => {
                if (!c.isOnline) return false;
                if (typeof c.lat !== "number" || typeof c.lng !== "number") return false;
                if (!isFresh(c.lastSeenAt)) return false;
                if ((c.activeOrdersCount ?? 0) >= MAX_ACTIVE_ORDERS) return false;
                if ((c.pendingOffersCount ?? 0) >= MAX_PENDING_OFFERS) return false;
                return true;
            });

        const courierId = pickCourierId(o, candidates);

        // --------------------
        // WRITES
        // --------------------

        // закрываем ВСЕ pending (они уже не активны)
        for (const x of pending) {
            tx.update(x.ref, {
                status: "expired",
                updatedAt: FieldValue.serverTimestamp(),
                expiredBy: reason,
            });
        }

        if (!courierId) {
            tx.update(orderRef, {
                status: "new",
                currentOfferId: null,
                currentOfferCourierId: null,
                offerExpiresAtMs: null,
                updatedAt: FieldValue.serverTimestamp(),
            });
            return;
        }

        const offerRef = db.collection("offers").doc();
        const expiresAtMs = nowMs + OFFER_TIMEOUT_MS;
        const cleanupAt = Timestamp.fromMillis(nowMs + OFFER_RETENTION_MS);

        // ✅ distance aliases (чтобы курьер всегда видел pickup->dropoff)
        const deliveryDistanceMeters =
            typeof o.deliveryDistanceMeters === "number"
                ? o.deliveryDistanceMeters
                : typeof o.routeDistanceMeters === "number"
                    ? o.routeDistanceMeters
                    : null;

        const deliveryDistanceKm =
            typeof o.deliveryDistanceKm === "number"
                ? o.deliveryDistanceKm
                : typeof deliveryDistanceMeters === "number"
                    ? deliveryDistanceMeters / 1000
                    : null;

        // ✅ prep aliases
        const prepMinutes =
            typeof o.prepMinutes === "number"
                ? o.prepMinutes
                : typeof o.prepTimeMin === "number"
                    ? o.prepTimeMin
                    : null;

        const createdAtMs = typeof o.createdAt?.toMillis === "function" ? o.createdAt.toMillis() : null;

        const readyAtMs =
            typeof o.readyAtMs === "number"
                ? o.readyAtMs
                : typeof o.readyAt?.toMillis === "function"
                    ? o.readyAt.toMillis()
                    : createdAtMs !== null && typeof prepMinutes === "number"
                        ? createdAtMs + prepMinutes * 60_000
                        : null;

        const readyAt =
            typeof o.readyAt?.toMillis === "function"
                ? o.readyAt
                : typeof readyAtMs === "number"
                    ? Timestamp.fromMillis(readyAtMs)
                    : null;

        tx.set(offerRef, {
            restaurantId: o.restaurantId ?? null,
            courierId,
            orderId,

            shortCode: o.shortCode ?? null,
            publicCode: o.publicCode ?? null,
            codeDateKey: o.codeDateKey ?? null,

            pickupLat: o.pickupLat ?? null,
            pickupLng: o.pickupLng ?? null,
            pickupGeohash: o.pickupGeohash ?? null,
            pickupAddressText: o.pickupAddressText ?? null,
            pickupPlaceId: o.pickupPlaceId ?? null,

            customerName: o.customerName ?? null,
            customerPhone: o.customerPhone ?? null,
            customerAddress: o.customerAddress ?? null,

            dropoffLat: o.dropoffLat ?? null,
            dropoffLng: o.dropoffLng ?? null,
            dropoffGeohash: o.dropoffGeohash ?? null,
            dropoffAddressText: o.dropoffAddressText ?? null,
            dropoffPlaceId: o.dropoffPlaceId ?? null,

            // ✅ structured dropoff fields (F)
            dropoffStreet: o.dropoffStreet ?? null,
            dropoffHouseNumber: o.dropoffHouseNumber ?? null,
            dropoffApartment: o.dropoffApartment ?? null,
            dropoffEntrance: o.dropoffEntrance ?? null,
            dropoffComment: o.dropoffComment ?? null,

            paymentType: o.paymentType ?? null,
            orderSubtotal: o.orderSubtotal ?? null,
            deliveryFee: o.deliveryFee ?? null,
            orderTotal: o.orderTotal ?? null,

            courierPaysAtPickup: o.courierPaysAtPickup ?? null,
            courierCollectsFromCustomer: o.courierCollectsFromCustomer ?? null,
            courierGetsFromRestaurantAtPickup: o.courierGetsFromRestaurantAtPickup ?? null,

            status: "pending",
            expiresAtMs,

            [TTL_FIELD]: cleanupAt,

            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),

            // ✅ prep time fields (B)
            prepTimeMin: typeof o.prepTimeMin === "number" ? o.prepTimeMin : prepMinutes ?? null,
            readyAtMs: typeof readyAtMs === "number" ? readyAtMs : null,

            prepMinutes: prepMinutes ?? null,
            readyAt: readyAt ?? null,

            // ✅ distance fields (A)
            routeDistanceMeters: typeof o.routeDistanceMeters === "number" ? o.routeDistanceMeters : null,
            routeDurationSeconds: typeof o.routeDurationSeconds === "number" ? o.routeDurationSeconds : null,

            deliveryDistanceMeters,
            deliveryDistanceKm,

            pricingVersion: o.pricingVersion ?? null,
        });

        tx.update(orderRef, {
            status: "offered",
            lastOfferedCourierId: courierId,
            lastOfferedAt: FieldValue.serverTimestamp(),

            currentOfferId: offerRef.id,
            currentOfferCourierId: courierId,
            offerExpiresAtMs: expiresAtMs,

            updatedAt: FieldValue.serverTimestamp(),
        });

        logger.info("dispatchOrder: offer created", {
            orderId,
            offerId: offerRef.id,
            courierId,
            reason,
        });
    });
}

// ----------------------------
// TRIGGERS
// ----------------------------
// -------------------------------------
// COUNTERS TRIGGERS
// -------------------------------------

export const syncPendingOffersCountOnOfferCreate = onDocumentCreated(
    "offers/{offerId}",
    async (event) => {
        const offer: any = event.data?.data();
        const courierId = String(offer?.courierId ?? "");
        if (!courierId) return;
        await recountPendingOffersCount(courierId);
    }
);

export const syncPendingOffersCountOnOfferUpdate = onDocumentUpdated(
    "offers/{offerId}",
    async (event) => {
        const before: any = event.data?.before.data();
        const after: any = event.data?.after.data();
        if (!before || !after) return;

        const beforeCourierId = String(before.courierId ?? "");
        const afterCourierId = String(after.courierId ?? "");

        const statusChanged = String(before.status ?? "") !== String(after.status ?? "");
        const expChanged = Number(before.expiresAtMs ?? 0) !== Number(after.expiresAtMs ?? 0);
        const courierChanged = beforeCourierId !== afterCourierId;

        if (!statusChanged && !expChanged && !courierChanged) return;

        if (beforeCourierId) await recountPendingOffersCount(beforeCourierId);
        if (afterCourierId && afterCourierId !== beforeCourierId) {
            await recountPendingOffersCount(afterCourierId);
        }
    }
);

export const syncActiveOrdersCountOnOrderUpdate = onDocumentUpdated(
    "orders/{orderId}",
    async (event) => {
        const before: any = event.data?.before.data();
        const after: any = event.data?.after.data();
        if (!before || !after) return;

        const beforeCourierId = String(before.assignedCourierId ?? "");
        const afterCourierId = String(after.assignedCourierId ?? "");
        const statusChanged = String(before.status ?? "") !== String(after.status ?? "");
        const courierChanged = beforeCourierId !== afterCourierId;

        if (!statusChanged && !courierChanged) return;

        if (beforeCourierId) await recountActiveOrdersCount(beforeCourierId);
        if (afterCourierId && afterCourierId !== beforeCourierId) {
            await recountActiveOrdersCount(afterCourierId);
        }
    }
);

// 1) Новый заказ → сразу пробуем оффер
export const dispatchOnOrderCreate = onDocumentCreated("orders/{orderId}", async (event) => {
    const orderId = event.params.orderId;
    const data = event.data?.data() as any;
    if (!data) return;

    if (!isOpenOrderStatus(data.status ?? "new")) return;
    if (data.assignedCourierId) return;

    await dispatchOrder(orderId, "order_create");
});

// 2) Courier declined → сразу re-offer
export const reofferOnDeclined = onDocumentUpdated("offers/{offerId}", async (event) => {
    const offerId = event.params.offerId;
    const before = event.data?.before.data() as any;
    const after = event.data?.after.data() as any;
    if (!before || !after) return;

    const beforeStatus = String(before.status ?? "");
    const afterStatus = String(after.status ?? "");

    if (!(beforeStatus === "pending" && afterStatus === "declined")) return;

    const orderId = String(after.orderId ?? "");
    if (!orderId) return;

    const orderRef = db.collection("orders").doc(orderId);

    let shouldDispatch = false;
    await db.runTransaction(async (tx) => {
        const os = await tx.get(orderRef);
        if (!os.exists) return;
        const o: any = os.data();

        if (o.assignedCourierId) return;
        if (!isOpenOrderStatus(o.status)) return;
        if (o.currentOfferId !== offerId) return;

        tx.update(orderRef, {
            status: "new",
            currentOfferId: null,
            currentOfferCourierId: null,
            offerExpiresAtMs: null,
            updatedAt: FieldValue.serverTimestamp(),
        });
        shouldDispatch = true;
    });

    if (shouldDispatch) {
        await dispatchOrder(orderId, "offer_declined");
    }
});

// 3) Если заказ отменили/взяли → отменяем активный pending offer
export const cancelOfferOnOrderClose = onDocumentUpdated("orders/{orderId}", async (event) => {
    const before = event.data?.before.data() as any;
    const after = event.data?.after.data() as any;
    if (!before || !after) return;

    const orderId = event.params.orderId;

    const wasAssigned = !!before.assignedCourierId;
    const isAssigned = !!after.assignedCourierId;

    const beforeStatus = String(before.status ?? "");
    const afterStatus = String(after.status ?? "");

    const becameClosed =
        (beforeStatus !== "cancelled" && afterStatus === "cancelled") ||
        (beforeStatus !== "delivered" && afterStatus === "delivered") ||
        (!wasAssigned && isAssigned);

    if (!becameClosed) return;

    const currentOfferId = typeof after.currentOfferId === "string" ? after.currentOfferId : null;
    if (!currentOfferId) return;

    const offerRef = db.collection("offers").doc(currentOfferId);

    try {
        const offerSnap = await offerRef.get();
        if (offerSnap.exists) {
            const st = String((offerSnap.data() as any)?.status ?? "");
            if (st === "pending") {
                await offerRef.update({
                    status: "cancelled",
                    updatedAt: FieldValue.serverTimestamp(),
                });
            }
        }
    } catch {}

    try {
        await db.collection("orders").doc(orderId).update({
            currentOfferId: null,
            currentOfferCourierId: null,
            offerExpiresAtMs: null,
            updatedAt: FieldValue.serverTimestamp(),
        });
    } catch {}
});

// 4) Scheduler: раз в минуту
export const dispatchTick = onSchedule(
    { schedule: "every 1 minutes", timeZone: "Asia/Jerusalem" },
    async () => {
        const nowMs = Date.now();

        // 4.1) expire pending offers
        try {
            const expiredSnap = await db
                .collection("offers")
                .where("status", "==", "pending")
                .where("expiresAtMs", "<=", nowMs)
                .orderBy("expiresAtMs", "asc")
                .limit(TICK_LIMIT)
                .get();

            const toReoffer = new Set<string>();

            for (const docSnap of expiredSnap.docs) {
                const offerId = docSnap.id;
                const offer: any = docSnap.data();

                if (String(offer.status ?? "") !== "pending") continue;

                const orderId = String(offer.orderId ?? "");
                if (!orderId) continue;

                const offerRef = db.collection("offers").doc(offerId);
                const orderRef = db.collection("orders").doc(orderId);

                await db.runTransaction(async (tx) => {
                    const off = await tx.get(offerRef);
                    if (!off.exists) return;

                    const offData: any = off.data();
                    if (String(offData.status ?? "") !== "pending") return;

                    const exp = Number(offData.expiresAtMs ?? 0);
                    if (exp > nowMs) return;

                    tx.update(offerRef, {
                        status: "expired",
                        updatedAt: FieldValue.serverTimestamp(),
                    });

                    const os = await tx.get(orderRef);
                    if (!os.exists) return;

                    const o: any = os.data();

                    if (
                        o.currentOfferId === offerId &&
                        !o.assignedCourierId &&
                        isOpenOrderStatus(String(o.status ?? ""))
                    ) {
                        tx.update(orderRef, {
                            status: "new",
                            currentOfferId: null,
                            currentOfferCourierId: null,
                            offerExpiresAtMs: null,
                            updatedAt: FieldValue.serverTimestamp(),
                        });
                    }
                });

                toReoffer.add(orderId);
            }

            for (const orderId of toReoffer) {
                await dispatchOrder(orderId, "offer_timeout_tick");
            }
        } catch (e: any) {
            logger.warn("dispatchTick: expire offers failed", {
                error: e?.message ?? String(e),
            });
            return;
        }

        // 4.2) try dispatch open orders without active offer
        const openOrderIds: string[] = [];

        try {
            const q1 = await db
                .collection("orders")
                .where("assignedCourierId", "==", null)
                .where("status", "==", "new")
                .limit(TICK_LIMIT)
                .get();
            for (const d of q1.docs) openOrderIds.push(d.id);

            const q2 = await db
                .collection("orders")
                .where("assignedCourierId", "==", null)
                .where("status", "==", "offered")
                .limit(TICK_LIMIT)
                .get();
            for (const d of q2.docs) openOrderIds.push(d.id);
        } catch (e: any) {
            logger.warn("dispatchTick: open orders query failed", { error: e?.message ?? String(e) });
        }

        const uniq = Array.from(new Set(openOrderIds)).slice(0, TICK_LIMIT);

        for (const orderId of uniq) {
            await dispatchOrder(orderId, "open_orders_tick");
        }
    }
);
