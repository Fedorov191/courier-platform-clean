import { useEffect, useRef } from "react";
import { importLibrary, setOptions } from "@googlemaps/js-api-loader";

export type PlacePick = {
    label: string;
    placeId: string;
    lat: number;
    lng: number;

    // structured fields (для F)
    street?: string;
    houseNumber?: string;
    apartment?: string; // subpremise
    city?: string;
    postalCode?: string;

    // raw components (если захочешь расширять)
    components?: google.maps.GeocoderAddressComponent[];
};

type Props = {
    value: string;
    placeholder?: string;
    disabled?: boolean;

    onChangeText: (v: string) => void;
    onPick: (p: PlacePick) => void;

    country?: string;   // default: "il"
    language?: string;  // optional
};

let placesInitPromise: Promise<void> | null = null;
let optionsWereSet = false;

function getComp(
    components: google.maps.GeocoderAddressComponent[] | undefined,
    type: string
) {
    return components?.find((c) => c.types?.includes(type))?.long_name;
}

async function ensurePlacesLoaded(language?: string) {
    if (!placesInitPromise) {
        const key = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY as string | undefined;
        if (!key) {
            throw new Error("Missing VITE_GOOGLE_MAPS_API_KEY in web/.env");
        }

        // setOptions должен быть вызван один раз (дальнейшие вызовы просто игнорируются/варнят)
        if (!optionsWereSet) {
            setOptions({
                key,                 // ✅ НЕ apiKey
                v: "weekly",
                libraries: ["places"], // можно не указывать, но пусть будет предзагрузка
                language,
            });
            optionsWereSet = true;
        }

        placesInitPromise = (async () => {
            await importLibrary("places");
        })();
    }

    return placesInitPromise;
}

export function GooglePlacesAutocomplete({
                                             value,
                                             placeholder,
                                             disabled,
                                             onChangeText,
                                             onPick,
                                             country = "il",
                                             language,
                                         }: Props) {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const listenerRef = useRef<google.maps.MapsEventListener | null>(null);

    // чтобы не пересоздавать listener из-за смены ссылок
    const onPickRef = useRef(onPick);
    useEffect(() => {
        onPickRef.current = onPick;
    }, [onPick]);

    useEffect(() => {
        let cancelled = false;

        (async () => {
            try {
                await ensurePlacesLoaded(language);
                if (cancelled) return;

                const el = inputRef.current;
                if (!el) return;

                // на всякий случай — если был старый listener
                if (listenerRef.current) {
                    listenerRef.current.remove();
                    listenerRef.current = null;
                }

                const ac = new google.maps.places.Autocomplete(el, {
                    // важно: иначе place будет “пустой”
                    fields: ["place_id", "geometry", "formatted_address", "address_components"],
                    componentRestrictions: country ? { country } : undefined,
                });

                listenerRef.current = ac.addListener("place_changed", () => {
                    const place = ac.getPlace();

                    const loc = place.geometry?.location;
                    const placeId = place.place_id;
                    const label = place.formatted_address;

                    if (!loc || !placeId || !label) return;

                    const components = place.address_components;

                    const pick: PlacePick = {
                        label,
                        placeId,
                        lat: loc.lat(),
                        lng: loc.lng(),

                        street: getComp(components, "route"),
                        houseNumber: getComp(components, "street_number"),
                        apartment: getComp(components, "subpremise"),
                        city: getComp(components, "locality"),
                        postalCode: getComp(components, "postal_code"),

                        components,
                    };

                    onPickRef.current(pick);
                });
            } catch (e) {
                // можно показать toast/err в UI — но пока просто в консоль
                console.error(e);
            }
        })();

        return () => {
            cancelled = true;
            if (listenerRef.current) {
                listenerRef.current.remove();
                listenerRef.current = null;
            }
        };
    }, [country, language]);

    return (
        <input
            ref={inputRef}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => onChangeText(e.target.value)}
            style={{
                width: "100%",
                padding: 10,
                borderRadius: 8,
                border: "1px solid #333",
                outline: "none",
            }}
        />
    );
}
