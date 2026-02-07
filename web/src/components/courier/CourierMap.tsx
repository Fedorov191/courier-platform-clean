import { useEffect, useMemo, useRef, useState } from "react";

export type LatLng = { lat: number; lng: number };

export type OfferRouteLeg = {
    polyline: string;
    distanceMeters: number;
    durationSeconds: number;
};

export type OfferRouteData = {
    pickupToDropoff: OfferRouteLeg;
    courierToPickup: OfferRouteLeg | null;
};

export type MapPoint = {
    id: string;
    kind: "courier" | "pickup" | "dropoff";
    position: LatLng;
    label?: string;
};

type Props = {
    courier: LatLng | null;
    // когда есть offer — показываем offer точки (и если есть offerRoute — линии)
    offerPoints: { pickup: LatLng; dropoff: LatLng } | null;
    offerRoute: OfferRouteData | null;
    // когда offer нет — показываем точки активных заказов
    idlePoints: MapPoint[];
    showOfferRoute: boolean;
};

const DEFAULT_CENTER: LatLng = { lat: 32.0853, lng: 34.7818 }; // Tel-Aviv дефолт

// ✅ анти-суперзум настройки
const DEFAULT_COURIER_ZOOM = 14; // нормальный "городской" масштаб
const MAX_AUTO_ZOOM = 16; // чтобы fitBounds не улетал слишком близко

// --- Script loader (без @googlemaps/js-api-loader) ---
let googleMapsPromise: Promise<void> | null = null;

function loadGoogleMaps(apiKey: string): Promise<void> {
    if (typeof window === "undefined") return Promise.reject(new Error("No window"));
    if ((window as any).google?.maps) return Promise.resolve();

    if (googleMapsPromise) return googleMapsPromise;

    googleMapsPromise = new Promise<void>((resolve, reject) => {
        const existing = document.querySelector<HTMLScriptElement>('script[data-google-maps="1"]');
        if (existing) {
            existing.addEventListener("load", () => resolve());
            existing.addEventListener("error", () => reject(new Error("Google Maps script failed")));
            return;
        }

        const script = document.createElement("script");
        script.async = true;
        script.defer = true;
        script.dataset.googleMaps = "1";

        // Важно: подключаем geometry для decodePath
        const params = new URLSearchParams({
            key: apiKey,
            v: "weekly",
            libraries: "geometry",
        });

        script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;

        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Google Maps script failed"));

        document.head.appendChild(script);
    });

    return googleMapsPromise;
}

export function CourierMap({ courier, offerPoints, offerRoute, idlePoints, showOfferRoute }: Props) {
    const divRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<any>(null);

    // Маркеры/линии держим и апдейтим без полного clear, чтобы было “плавно как в Wolt”
    const markersByIdRef = useRef<Map<string, any>>(new Map());
    const polylinesRef = useRef<any[]>([]);
    const mapsReadyRef = useRef(false);

    // Wolt‑поведение: если пользователь потрогал карту — выключаем авто‑камеру
    const autoFollowRef = useRef(true);
    const programmaticMoveRef = useRef(false); // чтобы не считать fitBounds как user gesture
    const [canRecenter, setCanRecenter] = useState(false);

    // ✅ чтобы не дергать камеру на каждое обновление координат
    const courierRef = useRef<LatLng | null>(null);
    useEffect(() => {
        courierRef.current = courier;
    }, [courier]);

    // ✅ чтобы режим "только courier" центрировался один раз, а не постоянно
    const didSoloCourierViewRef = useRef(false);

    const key = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY as string | undefined;

    const effectiveMode = useMemo(() => {
        return showOfferRoute && offerPoints ? "offer" : "idle";
    }, [showOfferRoute, offerPoints]);

    // ----------------------------
    // Helpers
    // ----------------------------
    function circleIcon(fillColor: string, scale = 7) {
        const g: any = (window as any).google;
        return {
            path: g.maps.SymbolPath.CIRCLE,
            fillColor,
            fillOpacity: 1,
            strokeColor: "#ffffff",
            strokeOpacity: 1,
            strokeWeight: 2,
            scale,
        };
    }

    function setProgrammatic(fn: () => void) {
        programmaticMoveRef.current = true;
        try {
            fn();
        } finally {
            // fitBounds/zoom может продолжаться асинхронно, но этого хватает, чтобы не ловить dragstart
            window.setTimeout(() => {
                programmaticMoveRef.current = false;
            }, 0);
        }
    }

    function markUserInteracted() {
        if (programmaticMoveRef.current) return;
        if (!autoFollowRef.current) return;

        autoFollowRef.current = false;
        setCanRecenter(true);
    }

    function clearPolylines() {
        for (const p of polylinesRef.current) {
            try {
                p.setMap(null);
            } catch {}
        }
        polylinesRef.current = [];
    }

    function applyViewport(points: LatLng[]) {
        const map = mapRef.current;
        const g: any = (window as any).google;
        if (!map || !g?.maps) return;

        if (points.length === 0) return;

        // ✅ 1 точка -> НЕ fitBounds (иначе супер‑зум)
        if (points.length === 1) {
            if (didSoloCourierViewRef.current) return;
            didSoloCourierViewRef.current = true;

            setProgrammatic(() => {
                map.setCenter(points[0]);
                map.setZoom(DEFAULT_COURIER_ZOOM);
            });
            return;
        }

        // если стало 2+ точки — снова разрешаем solo в будущем
        didSoloCourierViewRef.current = false;

        const bounds = new g.maps.LatLngBounds();
        for (const p of points) bounds.extend(p);

        setProgrammatic(() => {
            try {
                map.fitBounds(bounds, { top: 48, right: 48, bottom: 48, left: 48 });
            } catch {}
        });

        // ✅ clamp zoom после fitBounds
        window.setTimeout(() => {
            const z = map.getZoom();
            if (typeof z === "number" && z > MAX_AUTO_ZOOM) {
                setProgrammatic(() => map.setZoom(MAX_AUTO_ZOOM));
            }
        }, 0);
    }

    function computeSafePoints(): LatLng[] {
        const pts: LatLng[] = [];

        const c = courierRef.current;
        if (c) pts.push(c);

        if (effectiveMode === "offer" && showOfferRoute && offerPoints) {
            pts.push(offerPoints.pickup, offerPoints.dropoff);
        } else {
            for (const p of idlePoints ?? []) {
                if (p?.position) pts.push(p.position);
            }
        }

        return pts.filter((p) => p && typeof p.lat === "number" && typeof p.lng === "number");
    }

    function upsertMarker(id: string, kind: MapPoint["kind"], position: LatLng, label?: string) {
        const map = mapRef.current;
        const g: any = (window as any).google;
        if (!map || !g?.maps) return;

        const existing = markersByIdRef.current.get(id);

        // Wolt‑похоже: courier = “blue dot”
        const icon =
            kind === "courier"
                ? circleIcon("#1a73e8", 8)
                : kind === "pickup"
                    ? circleIcon("#1976d2", 7) // restaurant
                    : circleIcon("#2e7d32", 7); // customer

        if (existing) {
            try {
                existing.setPosition(position);
                existing.setTitle(label ?? kind);
                existing.setIcon(icon);
            } catch {}
            return;
        }

        const marker = new g.maps.Marker({
            position,
            map,
            title: label ?? kind,
            icon,
        });

        markersByIdRef.current.set(id, marker);
    }

    function removeMarkersNotIn(keepIds: Set<string>) {
        for (const [id, marker] of markersByIdRef.current.entries()) {
            if (keepIds.has(id)) continue;
            try {
                marker.setMap(null);
            } catch {}
            markersByIdRef.current.delete(id);
        }
    }

    // ----------------------------
    // Init map
    // ----------------------------
    useEffect(() => {
        if (!divRef.current) return;
        if (!key) {
            console.error("VITE_GOOGLE_MAPS_API_KEY is missing");
            return;
        }
        if (mapRef.current) return;

        let cancelled = false;

        (async () => {
            try {
                await loadGoogleMaps(key);
                if (cancelled) return;
                if (!divRef.current) return;

                const g: any = (window as any).google;

                mapRef.current = new g.maps.Map(divRef.current, {
                    center: courier ?? DEFAULT_CENTER,
                    zoom: DEFAULT_COURIER_ZOOM,
                    disableDefaultUI: true,
                    zoomControl: true,
                    clickableIcons: false,
                });

                mapsReadyRef.current = true;

                // ✅ user gesture hooks (как в Wolt: если сдвинул карту — перестаем авто-фитить)
                const map = mapRef.current;
                map.addListener("dragstart", markUserInteracted);
                map.addListener("zoom_changed", markUserInteracted);

                // первый viewport — только один раз (если авто‑follow включен)
                if (autoFollowRef.current) {
                    const pts = computeSafePoints();
                    applyViewport(pts);
                }
            } catch (e: unknown) {
                console.error("Google Maps load failed", e);
            }
        })();

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    // ----------------------------
    // Update markers + polylines
    // ----------------------------
    useEffect(() => {
        if (!mapsReadyRef.current) return;
        const map = mapRef.current;
        const g: any = (window as any).google;
        if (!map || !g?.maps) return;

        // 1) markers
        const keep = new Set<string>();

        if (courier) {
            keep.add("courier");
            upsertMarker("courier", "courier", courier, "You");
        }

        if (effectiveMode === "offer" && offerPoints) {
            keep.add("offer_pickup");
            keep.add("offer_dropoff");
            upsertMarker("offer_pickup", "pickup", offerPoints.pickup, "Pickup");
            upsertMarker("offer_dropoff", "dropoff", offerPoints.dropoff, "Dropoff");
        } else {
            for (const p of idlePoints ?? []) {
                if (!p?.id || !p?.position) continue;
                keep.add(p.id);
                upsertMarker(p.id, p.kind, p.position, p.label);
            }
        }

        removeMarkersNotIn(keep);

        // 2) polylines (только в offer режиме)
        clearPolylines();

        if (effectiveMode === "offer" && showOfferRoute && offerRoute) {
            const decode = g.maps.geometry?.encoding?.decodePath;
            if (typeof decode === "function") {
                // courier -> pickup (серый)
                if (offerRoute.courierToPickup?.polyline) {
                    const path = decode(offerRoute.courierToPickup.polyline);
                    const poly = new g.maps.Polyline({
                        path,
                        map,
                        strokeColor: "#9e9e9e",
                        strokeOpacity: 1,
                        strokeWeight: 4,
                    });
                    polylinesRef.current.push(poly);
                }

                // pickup -> dropoff (фиолетовый)
                if (offerRoute.pickupToDropoff?.polyline) {
                    const path = decode(offerRoute.pickupToDropoff.polyline);
                    const poly = new g.maps.Polyline({
                        path,
                        map,
                        strokeColor: "#7c4dff",
                        strokeOpacity: 1,
                        strokeWeight: 5,
                    });
                    polylinesRef.current.push(poly);
                }
            }
        }
    }, [courier, offerPoints, offerRoute, idlePoints, showOfferRoute, effectiveMode]);

    // ----------------------------
    // Auto viewport (Wolt-like)
    // - делаем авто-fit пока пользователь не трогал карту
    // - НЕ дергаем на каждое обновление courier координат
    // ----------------------------
    const hasCourier = !!courier; // важно: эффект сработает только на null->not null
    useEffect(() => {
        if (!mapsReadyRef.current) return;
        if (!autoFollowRef.current) return;

        const pts = computeSafePoints();
        applyViewport(pts);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [effectiveMode, showOfferRoute, offerPoints, offerRoute, idlePoints, hasCourier]);

    // ----------------------------
    // Recenter button handler (как в Wolt)
    // ----------------------------
    function recenter() {
        if (!mapsReadyRef.current) return;

        autoFollowRef.current = true;
        setCanRecenter(false);

        // разрешаем “solo courier” центрироваться снова
        didSoloCourierViewRef.current = false;

        const pts = computeSafePoints();
        applyViewport(pts);
    }

    return (
        <div style={{ position: "relative", width: "100%", height: "100%" }}>
            <div
                ref={divRef}
                style={{
                    width: "100%",
                    height: "100%",
                    borderRadius: 16,
                    overflow: "hidden",
                    background: "#f2f2f2",
                }}
            />

            {/* Wolt-like "recenter" кнопка */}
            {canRecenter && (
                <button
                    onClick={recenter}
                    title="Recenter"
                    style={{
                        position: "absolute",
                        right: 12,
                        bottom: 12,
                        width: 44,
                        height: 44,
                        borderRadius: 999,
                        border: "1px solid rgba(0,0,0,0.12)",
                        background: "#fff",
                        boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
                        fontSize: 18,
                        fontWeight: 900,
                        cursor: "pointer",
                        display: "grid",
                        placeItems: "center",
                        userSelect: "none",
                    }}
                >
                    ⌖
                </button>
            )}
        </div>
    );
}
