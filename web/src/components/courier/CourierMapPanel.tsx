import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../lib/i18n";
import { fetchOfferRoute } from "../../lib/offerRoute";
import { CourierMap, type LatLng, type MapPoint, type OfferRouteData } from "./CourierMap";

type OfferLite = {
    id: string;
    orderId?: string;
    shortCode?: string;
    pickupLat?: number;
    pickupLng?: number;
    dropoffLat?: number;
    dropoffLng?: number;
};

type Props = {
    courier: LatLng | null;
    offers: OfferLite[];
    activeOrders: any[];
    selectedOfferId: string | null;
    setSelectedOfferId: (id: string | null) => void;
};

function shortId(id: string) {
    return (id || "").slice(0, 6).toUpperCase();
}

function kmTextFromMeters(m?: number, digits = 1) {
    if (typeof m !== "number" || !Number.isFinite(m) || m <= 0) return "—";
    return `${(m / 1000).toFixed(digits)} km`;
}

export function CourierMapPanel({
                                    courier,
                                    offers,
                                    activeOrders,
                                    selectedOfferId,
                                    setSelectedOfferId,
                                }: Props) {
    const { t } = useI18n();

    // держим выбранный offer валидным
    useEffect(() => {
        if (offers.length === 0) {
            setSelectedOfferId(null);
            return;
        }
        if (selectedOfferId && offers.some((o) => o.id === selectedOfferId)) return;
        setSelectedOfferId(offers[0].id);
    }, [offers, selectedOfferId, setSelectedOfferId]);

    const selectedOffer = useMemo(() => {
        if (!selectedOfferId) return offers[0] ?? null;
        return offers.find((o) => o.id === selectedOfferId) ?? offers[0] ?? null;
    }, [offers, selectedOfferId]);

    const offerPoints = useMemo(() => {
        if (!selectedOffer) return null;
        const pickup = { lat: selectedOffer.pickupLat, lng: selectedOffer.pickupLng };
        const dropoff = { lat: selectedOffer.dropoffLat, lng: selectedOffer.dropoffLng };

        const ok =
            typeof pickup.lat === "number" &&
            typeof pickup.lng === "number" &&
            typeof dropoff.lat === "number" &&
            typeof dropoff.lng === "number";

        return ok ? { pickup: pickup as LatLng, dropoff: dropoff as LatLng } : null;
    }, [selectedOffer]);

    // idle points (без маршрута) — из activeOrders
    const idlePoints: MapPoint[] = useMemo(() => {
        const pts: MapPoint[] = [];
        for (const ord of (activeOrders ?? [])) {
            const id = String(ord?.id ?? "");
            if (typeof ord?.pickupLat === "number" && typeof ord?.pickupLng === "number") {
                pts.push({
                    id: `ord_${id}_pickup`,
                    kind: "pickup",
                    position: { lat: ord.pickupLat, lng: ord.pickupLng },
                    label: "Restaurant",
                });
            }
            if (typeof ord?.dropoffLat === "number" && typeof ord?.dropoffLng === "number") {
                pts.push({
                    id: `ord_${id}_dropoff`,
                    kind: "dropoff",
                    position: { lat: ord.dropoffLat, lng: ord.dropoffLng },
                    label: "Customer",
                });
            }
        }
        return pts;
    }, [activeOrders]);

    const showOfferRoute = offers.length > 0 && !!offerPoints;

    // route fetch + cache (не спамим)
    const cacheRef = useRef(new Map<string, OfferRouteData>());
    const [offerRoute, setOfferRoute] = useState<OfferRouteData | null>(null);
    const [routeLoading, setRouteLoading] = useState(false);

    useEffect(() => {
        let alive = true;

        async function run() {
            if (!showOfferRoute || !selectedOffer || !offerPoints) {
                setOfferRoute(null);
                return;
            }

            const offerId = selectedOffer.id;
            const cached = cacheRef.current.get(offerId);
            if (cached) {
                setOfferRoute(cached);
                return;
            }

            setRouteLoading(true);
            try {
                const data = await fetchOfferRoute({
                    courier: courier ?? null,
                    pickup: offerPoints.pickup,
                    dropoff: offerPoints.dropoff,
                });

                if (!alive) return;
                cacheRef.current.set(offerId, data);
                setOfferRoute(data);
            } catch (e) {
                if (!alive) return;
                console.warn("fetchOfferRoute failed", e);
                setOfferRoute(null);
            } finally {
                if (alive) setRouteLoading(false);
            }
        }

        run();
        return () => {
            alive = false;
        };
        // ВАЖНО: не завязываем на courier, чтобы не дергать Routes API каждую секунду.
    }, [showOfferRoute, selectedOfferId]); // eslint-disable-line react-hooks/exhaustive-deps

    const chipLabel = (o: OfferLite) => {
        const code =
            (typeof o.shortCode === "string" && o.shortCode.trim()) ||
            (o.orderId ? shortId(o.orderId) : shortId(o.id));
        return `#${code}`;
    };

    const courierToPickupKm = offerRoute?.courierToPickup?.distanceMeters
        ? kmTextFromMeters(offerRoute.courierToPickup.distanceMeters)
        : "—";
    const pickupToDropoffKm = offerRoute?.pickupToDropoff?.distanceMeters
        ? kmTextFromMeters(offerRoute.pickupToDropoff.distanceMeters)
        : "—";

    return (
        <div className="card">
            <div className="card__inner" style={{ padding: 10 }}>
                <div style={{ position: "relative", height: 360 }}>
                    <CourierMap
                        courier={courier}
                        offerPoints={showOfferRoute ? offerPoints : null}
                        offerRoute={showOfferRoute ? offerRoute : null}
                        idlePoints={idlePoints}
                        showOfferRoute={showOfferRoute}
                    />

                    {/* Offer selector chips (только если есть offers) */}
                    {offers.length > 0 && (
                        <div
                            style={{
                                position: "absolute",
                                left: 12,
                                right: 12,
                                top: 12,
                                display: "flex",
                                gap: 8,
                                overflowX: "auto",
                                paddingBottom: 2,
                            }}
                        >
                            {offers.map((o) => {
                                const selected = o.id === selectedOfferId;
                                return (
                                    <button
                                        key={o.id}
                                        onClick={() => setSelectedOfferId(o.id)}
                                        style={{
                                            padding: "8px 12px",
                                            borderRadius: 999,
                                            border: selected ? "2px solid #111" : "1px solid #ccc",
                                            background: selected ? "#fff" : "#f7f7f7",
                                            whiteSpace: "nowrap",
                                            fontWeight: 800,
                                            cursor: "pointer",
                                        }}
                                        title={t("courierNewOffersTitle")}
                                    >
                                        {chipLabel(o)}
                                    </button>
                                );
                            })}

                            {routeLoading && (
                                <span className="pill pill--muted" style={{ whiteSpace: "nowrap" }}>
                  Route…
                </span>
                            )}
                        </div>
                    )}
                </div>

                {/* мини-инфо под картой только когда есть offer */}
                {offers.length > 0 && (
                    <div style={{ marginTop: 10 }} className="row row--wrap">
            <span className="pill pill--muted">
              {t("courierToRestaurantLabel")}: <b>{courierToPickupKm}</b>
            </span>
                        <span className="pill pill--muted">
              {t("courierPickupToDropoffLabel")}: <b>{pickupToDropoffKm}</b>
            </span>
                    </div>
                )}
            </div>
        </div>
    );
}
