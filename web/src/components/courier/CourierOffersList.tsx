import { useI18n } from "../../lib/i18n";
import type { Offer } from "../../lib/courier.shared";
import {
    formatDropoffParts,
    getPickupToDropoffMeters,
    googleMapsUrl,
    haversineMeters,
    kmTextFromMeters,
    money,
    readyInText,
    shortId,
    wazeUrl,
    yandexMapsUrl,
} from "../../lib/courier.shared";

type Props = {
    offers: Offer[];

    selectedOfferId: string | null;
    setSelectedOfferId: (id: string | null) => void;

    busyOfferId: string | null;

    reachedMaxActive: boolean;
    activeCount: number;
    maxActive: number;

    nowMs: number;
    courier: { lat: number; lng: number } | null;

    onAcceptOffer: (offer: Offer) => Promise<void> | void;
    onDeclineOffer: (offerId: string) => Promise<void> | void;
};

export function CourierOffersList({
                                      offers,
                                      selectedOfferId,
                                      setSelectedOfferId,
                                      busyOfferId,
                                      reachedMaxActive,
                                      activeCount,
                                      maxActive,
                                      nowMs,
                                      courier,
                                      onAcceptOffer,
                                      onDeclineOffer,
                                  }: Props) {
    const { t } = useI18n();

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

    return (
        <div className="card">
            <div className="card__inner">
                <div className="row row--between row--wrap">
                    <div className="row row--wrap">
                        <h3 style={{ margin: 0 }}>{t("courierNewOffersTitle")}</h3>
                        <span className="pill pill--muted">{offers.length}</span>
                    </div>

                    <span className="pill pill--muted">
            {t("courierActiveCountLabel")} {activeCount}/{maxActive}
          </span>

                    {reachedMaxActive && (
                        <span className="pill pill--warning">
              {t("courierMaxActiveReached")} {maxActive}
            </span>
                    )}
                </div>

                <div className="hr" />

                {offers.length === 0 && <div className="muted">{t("courierNoNewOffers")}</div>}

                <div className="stack">
                    {offers.map((o) => {
                        const pickupMain = wazeUrl(o.pickupLat, o.pickupLng) ?? googleMapsUrl(o.pickupLat, o.pickupLng);
                        const pickupYandex = yandexMapsUrl(o.pickupLat, o.pickupLng);

                        const isBusy = busyOfferId === o.id;

                        const offerCode =
                            typeof o.shortCode === "string" && o.shortCode ? o.shortCode : shortId(o.orderId);

                        const readyText = readyInText(o.readyAtMs, nowMs);
                        const readyPill =
                            readyText === "READY"
                                ? t("courierReadyNow")
                                : `${t("courierReadyInLabel")} ${readyText}`;

                        const courierToPickupM =
                            courier && typeof o?.pickupLat === "number" && typeof o?.pickupLng === "number"
                                ? haversineMeters(courier.lat, courier.lng, o.pickupLat, o.pickupLng)
                                : null;

                        const pickupToDropoffM = getPickupToDropoffMeters(o);
                        const totalTripM = (courierToPickupM ?? 0) + (pickupToDropoffM ?? 0);

                        const drop = formatDropoffParts(o);
                        const extra = dropoffExtra(drop.apt, drop.ent);

                        const selected = o.id === selectedOfferId;

                        return (
                            <div
                                key={o.id}
                                className="subcard"
                                onClick={() => setSelectedOfferId(o.id)}
                                style={{
                                    cursor: "pointer",
                                    outline: selected ? "2px solid #111" : "1px solid transparent",
                                    outlineOffset: 2,
                                }}
                            >
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
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setSelectedOfferId(o.id); // чтобы карта/выбор совпали
                                            onAcceptOffer(o);
                                        }}
                                        disabled={isBusy || reachedMaxActive}
                                    >
                                        {isBusy ? t("courierWorking") : t("courierAccept")}
                                    </button>

                                    <button
                                        className="btn btn--danger"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onDeclineOffer(o.id);
                                        }}
                                        disabled={isBusy}
                                    >
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
    );
}
