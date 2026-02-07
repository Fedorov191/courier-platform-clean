import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";
import type { LatLng, OfferRouteData } from "../components/courier/CourierMap.tsx";

type OfferRouteRequest = {
    courier?: LatLng | null;
    pickup: LatLng;
    dropoff: LatLng;
};

const callGetOfferRoute = httpsCallable<OfferRouteRequest, any>(functions, "getOfferRoute");

export async function fetchOfferRoute(req: OfferRouteRequest): Promise<OfferRouteData> {
    const res = await callGetOfferRoute(req);
    return res.data as OfferRouteData;
}
