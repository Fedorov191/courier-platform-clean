import { OrderChat } from "../OrderChat";
import { useI18n } from "../../lib/i18n";
import {
    formatDropoffParts,
    getPickupToDropoffMeters,
    googleMapsUrl,
    haversineMeters,
    kmTextFromMeters,
    money,
    pillToneForOrderStatus,
    readyInText,
    shortId,
    wazeUrl,
    yandexMapsUrl,
} from "../../lib/courier.shared";

type Props = {
    orders: any[];
    max: number;
    nowMs: number;
    courier: { lat: number; lng: number } | null;

    userId: string;

    chatOpenByOrderId: Record<string, boolean>;
    unreadByChatId: Record<string, boolean>;

    busyOrderAction: "pickup" | "deliver" | null;

    onMarkPickedUp: (orderId: string) => Promise<void> | void;
    onMarkDelivered: (orderId: string) => Promise<void> | void;

    onChatButton: (args: {
        orderId: string;
        chatId: string;
        restaurantId: string;
        willOpen: boolean;
    }) => Promise<void> | void;
};

export function CourierActiveOrdersList({
                                            orders,
                                            max,
                                            nowMs,
                                            courier,
                                            userId,
                                            chatOpenByOrderId,
                                            unreadByChatId,
                                            busyOrderAction,
                                            onMarkPickedUp,
                                            onMarkDelivered,
                                            onChatButton,
                                        }: Props) {
    const { t } = useI18n();

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

    if (!orders || orders.length === 0) return null;

    return (
        <div className="stack">
            {orders.slice(0, max).map((ord: any) => {
                const st: string | undefined = ord?.status;
                const canPickup = st === "taken";
                const canDeliver = st === "picked_up";

                const readyText = readyInText(ord?.readyAtMs, nowMs);
                const readyPill =
                    readyText === "READY"
                        ? t("courierReadyNow")
                        : `${t("courierReadyInLabel")} ${readyText}`;

                const code =
                    typeof ord?.shortCode === "string" && ord.shortCode ? ord.shortCode : shortId(ord.id);

                const pickupMain = wazeUrl(ord?.pickupLat, ord?.pickupLng) ?? googleMapsUrl(ord?.pickupLat, ord?.pickupLng);
                const pickupYandex = yandexMapsUrl(ord?.pickupLat, ord?.pickupLng);

                const dropoffMain = wazeUrl(ord?.dropoffLat, ord?.dropoffLng) ?? googleMapsUrl(ord?.dropoffLat, ord?.dropoffLng);
                const dropoffYandex = yandexMapsUrl(ord?.dropoffLat, ord?.dropoffLng);

                const courierToPickupM =
                    courier && typeof ord?.pickupLat === "number" && typeof ord?.pickupLng === "number"
                        ? haversineMeters(courier.lat, courier.lng, ord.pickupLat, ord.pickupLng)
                        : null;

                const pickupToDropoffM = getPickupToDropoffMeters(ord);
                const totalTripM = (courierToPickupM ?? 0) + (pickupToDropoffM ?? 0);

                const drop = formatDropoffParts(ord);
                const extra = dropoffExtra(drop.apt, drop.ent);

                const chatId = `${ord.id}_${userId}`;
                const isChatOpen = !!chatOpenByOrderId[ord.id];
                const hasUnread = !!unreadByChatId[chatId] && !isChatOpen;

                return (
                    <div key={ord.id} className="card">
                        <div className="card__inner">
                            <div className="row row--between row--wrap">
                                <div className="row row--wrap">
                                    <div style={{ fontWeight: 950, fontSize: 16 }}>
                                        {t("courierActiveOrderTitle")} <span className="mono">#{code}</span>
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
                                    onClick={() => onMarkPickedUp(ord.id)}
                                    disabled={!canPickup || busyOrderAction !== null}
                                >
                                    {busyOrderAction === "pickup" ? t("courierSaving") : t("courierPickedUpAction")}
                                </button>

                                <button
                                    className="btn btn--success"
                                    onClick={() => onMarkDelivered(ord.id)}
                                    disabled={!canDeliver || busyOrderAction !== null}
                                >
                                    {busyOrderAction === "deliver" ? t("courierSaving") : t("courierDeliveredAction")}
                                </button>

                                {canPickup && pickupMain && (
                                    <a
                                        className="btn btn--ghost"
                                        href={pickupMain}
                                        target="_blank"
                                        rel="noreferrer"
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        {t("courierRouteToRestaurant")}
                                    </a>
                                )}
                                {canPickup && pickupYandex && (
                                    <a
                                        className="btn btn--ghost"
                                        href={pickupYandex}
                                        target="_blank"
                                        rel="noreferrer"
                                        onClick={(e) => e.stopPropagation()}
                                    >
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
                                        await onChatButton({
                                            orderId: ord.id,
                                            chatId,
                                            restaurantId: String(ord.restaurantId ?? ""),
                                            willOpen: !isChatOpen,
                                        });
                                    }}
                                >
                                    {isChatOpen ? t("courierHideChat") : t("courierChat")}
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

                            {isChatOpen && (
                                <OrderChat
                                    chatId={chatId}
                                    orderId={ord.id}
                                    restaurantId={String(ord.restaurantId ?? "")}
                                    courierId={userId}
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
    );
}
