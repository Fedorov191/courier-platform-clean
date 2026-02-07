import { useI18n } from "../../lib/i18n";
import { formatDropoffParts, money, shortId } from "../../lib/courier.shared";

type Props = {
    orders: any[];
};

export function CourierCompletedOrdersList({ orders }: Props) {
    const { t } = useI18n();

    if (!orders || orders.length === 0) {
        return <div className="muted">{t("courierNoCompletedOrders")}</div>;
    }

    function dropoffExtra(apt?: string, ent?: string) {
        const parts: string[] = [];
        if (apt) parts.push(`${t("courierAptShort")} ${apt}`);
        if (ent) parts.push(`${t("courierEntranceShort")} ${ent}`);
        return parts.join(", ");
    }

    return (
        <div className="stack">
            {orders.map((o: any) => {
                const code = typeof o?.shortCode === "string" && o.shortCode ? o.shortCode : shortId(o.id);
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
    );
}
