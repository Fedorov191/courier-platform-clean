import { Navigate } from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import { useEffect, useState } from "react";
import { auth } from "../lib/firebase";

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
    const [loading, setLoading] = useState(true);
    const [isAuthed, setIsAuthed] = useState(false);

    useEffect(() => {
        const unsub = onAuthStateChanged(auth, (user) => {
            setIsAuthed(!!user);
            setLoading(false);
        });
        return unsub;
    }, []);

    if (loading) return <div style={{ padding: 24 }}>Loading...</div>;
    if (!isAuthed) return <Navigate to="/login" replace />;

    return <>{children}</>;
}
