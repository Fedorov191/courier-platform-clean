import { Capacitor } from "@capacitor/core";
import { Geolocation } from "@capacitor/geolocation";

export type Offer = {
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

export function shortId(id: string) {
    return (id || "").slice(0, 6).toUpperCase();
}

// Israel TZ keys for reports
export function israelDateKey(d = new Date()) {
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

export function money(n?: number) {
    const x = typeof n === "number" && Number.isFinite(n) ? n : 0;
    return `₪${x.toFixed(2)}`;
}

export function wazeUrl(lat?: number, lng?: number) {
    if (typeof lat !== "number" || typeof lng !== "number") return null;
    return `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
}
export function yandexMapsUrl(lat?: number, lng?: number) {
    if (typeof lat !== "number" || typeof lng !== "number") return null;
    return `https://yandex.com/maps/?pt=${lng},${lat}&z=17&l=map`;
}
export function googleMapsUrl(lat?: number, lng?: number) {
    if (typeof lat !== "number" || typeof lng !== "number") return null;
    return `https://www.google.com/maps?q=${lat},${lng}`;
}

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
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

export async function ensureNativeGeolocationPermission(): Promise<boolean> {
    if (!Capacitor.isNativePlatform()) return true;

    try {
        let perm = await Geolocation.checkPermissions();

        // perm.location: 'prompt' | 'granted' | 'denied'
        if (perm.location !== "granted") {
            perm = await Geolocation.requestPermissions({ permissions: ["location"] });
        }

        return perm.location === "granted";
    } catch {
        // checkPermissions/requestPermissions могут бросить ошибку,
        // если system location services выключены (GPS off)
        return false;
    }
}

export function pillToneForOrderStatus(status?: string) {
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

export function readyInText(readyAtMs?: number, nowMs?: number) {
    if (typeof readyAtMs !== "number" || !Number.isFinite(readyAtMs)) return "—";
    const diff = readyAtMs - (typeof nowMs === "number" ? nowMs : Date.now());
    if (diff <= 0) return "READY";
    const totalSec = Math.ceil(diff / 1000);
    const mm = Math.floor(totalSec / 60);
    const ss = totalSec % 60;
    return `${mm}:${String(ss).padStart(2, "0")}`;
}

export function kmTextFromMeters(m?: number, digits = 1) {
    if (typeof m !== "number" || !Number.isFinite(m) || m <= 0) return "—";
    return `${(m / 1000).toFixed(digits)} km`;
}

export function getPickupToDropoffMeters(x: any): number | null {
    const a = x?.routeDistanceMeters;
    if (typeof a === "number" && Number.isFinite(a) && a > 0) return a;

    const b = x?.deliveryDistanceMeters;
    if (typeof b === "number" && Number.isFinite(b) && b > 0) return b;

    const km = x?.deliveryDistanceKm;
    if (typeof km === "number" && Number.isFinite(km) && km > 0) return km * 1000;

    return null;
}

// Возвращаем “части”, а не готовые “Apt/Entrance” (чтобы локализовать в UI)
export function formatDropoffParts(o: any) {
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
