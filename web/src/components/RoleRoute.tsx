import { Navigate, Outlet } from "react-router-dom";
import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../lib/firebase";

type Role = "restaurant" | "courier";

export function RoleRoute({ role }: { role: Role }) {
    const [state, setState] = useState<"loading" | "ok" | "no-auth" | "no-role">("loading");

    useEffect(() => {
        const u = auth.currentUser;
        if (!u) {
            setState("no-auth");
            return;

        }

        const col = role === "restaurant" ? "restaurants" : "couriers";

        getDoc(doc(db, col, u.uid))
            .then((snap) => setState(snap.exists() ? "ok" : "no-role"))
            .catch(() => setState("no-role"));
    }, [role]);

    if (state === "loading") return <div style={{ padding: 16 }}>Loading...</div>;

    if (state === "no-auth") {
        return <Navigate to={role === "restaurant" ? "/restaurant/login" : "/courier/login"} replace />;
    }

    if (state === "no-role") {
        // Вошёл, но не той роли -> не пускаем в чужую зону
        return <Navigate to={role === "restaurant" ? "/restaurant/login" : "/courier/login"} replace />;
    }

    return <Outlet />;
}
