import { useEffect, useRef, useState } from "react";

export type AddressSuggestion = {
    label: string;
    lat: number;
    lng: number;
};

export function AddressAutocomplete(props: {
    placeholder?: string;
    value: string;
    onChangeText: (v: string) => void;
    onPick: (s: AddressSuggestion) => void;
    disabled?: boolean;
}) {
    const { placeholder, value, onChangeText, onPick, disabled } = props;

    const [items, setItems] = useState<AddressSuggestion[]>([]);
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const timer = useRef<number | null>(null);

    async function fetchSuggestions(q: string) {
        const qq = q.trim();
        if (qq.length < 3) {
            setItems([]);
            setErr(null);
            return;
        }

        setLoading(true);
        setErr(null);

        try {
            const url =
                "https://nominatim.openstreetmap.org/search" +
                `?format=json&addressdetails=1&limit=7&q=${encodeURIComponent(qq)}`;

            const r = await fetch(url, {
                headers: {
                    "Accept-Language": "en",
                },
            });

            if (!r.ok) throw new Error("Autocomplete request failed");

            const data = (await r.json()) as any[];

            const out: AddressSuggestion[] = data.map((x) => ({
                label: x.display_name,
                lat: Number(x.lat),
                lng: Number(x.lon),
            }));

            setItems(out);
        } catch (e: any) {
            setErr(e?.message ?? "Autocomplete failed");
            setItems([]);
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => fetchSuggestions(value), 350);

        return () => {
            if (timer.current) window.clearTimeout(timer.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);

    return (
        <div style={{ position: "relative" }}>
            <input
                placeholder={placeholder}
                value={value}
                disabled={disabled}
                onChange={(e) => {
                    onChangeText(e.target.value);
                    setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                style={{
                    width: "100%",
                    padding: 10,
                    borderRadius: 8,
                    border: "1px solid #333",
                    outline: "none",
                    opacity: disabled ? 0.6 : 1,
                }}
            />

            <div style={{ fontSize: 12, marginTop: 6, minHeight: 16, color: "#888" }}>
                {loading ? "Searching…" : err ? <span style={{ color: "crimson" }}>{err}</span> : null}
            </div>

            {open && items.length > 0 && !disabled && (
                <div
                    style={{
                        position: "absolute",
                        top: 56,
                        left: 0,
                        right: 0,
                        background: "white",
                        border: "1px solid #ddd",
                        borderRadius: 10,
                        overflow: "hidden",
                        zIndex: 20,
                        boxShadow: "0 10px 30px rgba(0,0,0,0.15)",
                    }}
                >
                    {items.map((it, idx) => (
                        <button
                            key={idx}
                            type="button"
                            onClick={() => {
                                onPick(it);
                                setOpen(false);
                            }}
                            style={{
                                width: "100%",
                                textAlign: "left",
                                padding: 10,
                                border: "none",
                                background: "white",
                                cursor: "pointer",
                            }}
                        >
                            {it.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
