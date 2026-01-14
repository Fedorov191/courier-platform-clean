import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "../lib/firebase";
import { RestaurantDispatcher } from "../pages/RestaurantDispatcher";

export function AppLayout() {
    const nav = useNavigate();

    async function logout() {
        await signOut(auth);
        nav("/restaurant/login");
    }

    const linkClass = ({ isActive }: { isActive: boolean }) =>
        `navlink ${isActive ? "is-active" : ""}`;

    return (
        <div className="page">
            <div className="container">
                <header className="card">
                    <div className="card__inner">
                        <div className="topnav">
                            <div className="row row--wrap">
                                <div className="brand">Restaurant Console</div>
                                <nav className="navlinks">
                                    <NavLink to="/restaurant/app/orders" className={linkClass}>
                                        Orders
                                    </NavLink>
                                    <NavLink to="/restaurant/app/orders/new" className={linkClass}>
                                        New order
                                    </NavLink>
                                </nav>
                            </div>

                            <button className="btn btn--ghost" onClick={logout}>
                                Logout
                            </button>
                        </div>
                    </div>
                </header>

                {/* ✅ Диспетчер офферов: работает пока открыт кабинет ресторана */}
                <RestaurantDispatcher />

                <div style={{ height: 12 }} />
                <Outlet />
            </div>
        </div>
    );
}
