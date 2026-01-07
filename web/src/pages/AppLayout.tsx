import { Link, Outlet, useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "../lib/firebase";

export function AppLayout() {
    const nav = useNavigate();

    async function logout() {
        await signOut(auth);
        nav("/restaurant/login"); // было /login
    }

    return (
        <div style={{ padding: 24 }}>
            <header style={{ display: "flex", gap: 12, marginBottom: 16 }}>
                <Link to="/restaurant/app/orders">Orders</Link>       {/* было /app/orders */}
                <Link to="/restaurant/app/orders/new">New order</Link> {/* было /app/orders/new */}
                <button onClick={logout}>Logout</button>
            </header>

            <Outlet />
        </div>
    );
}
