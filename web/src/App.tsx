import { Navigate, Route, Routes } from "react-router-dom";
import { HomePage } from "./pages/HomePage";

// ---------- Restaurant ----------
import { LoginPage } from "./pages/LoginPage";
import { SignupPage } from "./pages/SignupPage";
import { AppLayout } from "./pages/AppLayout";
import { OrdersPage } from "./pages/OrdersPage";
import { NewOrderPage } from "./pages/NewOrderPage";

// ---------- Courier ----------
import CourierLoginPage from "./pages/CourierLoginPage";
import CourierSignupPage from "./pages/CourierSignupPage";
import CourierAppHome from "./pages/CourierAppHome";

// ---------- Guards ----------
import { RoleRoute } from "./components/RoleRoute";

export default function App() {
    return (
        <Routes>
            {/* =================== HOME =================== */}
            <Route path="/" element={<HomePage />} />

            {/* =================== RESTAURANT =================== */}
            <Route path="/restaurant/login" element={<LoginPage />} />
            <Route path="/restaurant/signup" element={<SignupPage />} />

            <Route element={<RoleRoute role="restaurant" />}>
                <Route path="/restaurant/app" element={<AppLayout />}>
                    <Route index element={<Navigate to="/restaurant/app/orders" replace />} />
                    <Route path="orders" element={<OrdersPage />} />
                    <Route path="orders/new" element={<NewOrderPage />} />
                </Route>
            </Route>

            {/* =================== COURIER =================== */}
            <Route path="/courier/login" element={<CourierLoginPage />} />
            <Route path="/courier/signup" element={<CourierSignupPage />} />

            <Route element={<RoleRoute role="courier" />}>
                <Route path="/courier/app" element={<CourierAppHome />} />
            </Route>

            {/* =================== LEGACY REDIRECTS (важно!) =================== */}
            {/* Старые пути направляем в ресторанную зону, чтобы текущий код (nav("/app")) не ломался */}
            <Route path="/login" element={<Navigate to="/restaurant/login" replace />} />
            <Route path="/signup" element={<Navigate to="/restaurant/signup" replace />} />
            <Route path="/app/*" element={<Navigate to="/restaurant/app" replace />} />

            {/* =================== FALLBACK =================== */}
            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
    );
}
