import { Link } from "react-router-dom";

export function HomePage() {
    return (
        <div style={{ padding: 24 }}>
            <h1>Courier Platform</h1>
            <p>Вход для ресторана</p>

            <div style={{ display: "flex", gap: 12 }}>
                <Link to="/login">Login</Link>
                <Link to="/signup">Sign up</Link>
            </div>
        </div>
    );
}
