import { Link, Outlet, useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "../lib/firebase";

export function AppLayout() {
    const nav = useNavigate();

    async function logout() {
        await signOut(auth);
        nav("/restaurant/login");
    }

    return (
        <div style={{ padding: 24 }}>
            <header style={{ display: "flex", gap: 12, marginBottom: 16 }}>
                <Link to="/restaurant/app/orders">Orders</Link>
                <Link to="/restaurant/app/orders/new">New order</Link>
                <button onClick={logout}>Logout</button>
            </header>

            <Outlet />
        </div>
    );
}
