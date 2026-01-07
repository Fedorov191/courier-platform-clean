import { Link } from "react-router-dom";

export function HomePage() {
    return (
        <div style={{ padding: 24, maxWidth: 720, margin: "0 auto" }}>
            <h1>Courier Platform</h1>
            <p>Select portal:</p>

            <div style={{ display: "flex", gap: 16, marginTop: 20, flexWrap: "wrap" }}>
                <Link
                    to="/restaurant/login"
                    style={{
                        padding: 16,
                        border: "1px solid #ddd",
                        borderRadius: 12,
                        minWidth: 260,
                        textDecoration: "none",
                        color: "inherit",
                    }}
                >
                    <h3 style={{ margin: 0 }}>Restaurant</h3>
                    <p style={{ margin: "8px 0 0" }}>Login / Signup</p>
                </Link>

                <Link
                    to="/courier/login"
                    style={{
                        padding: 16,
                        border: "1px solid #ddd",
                        borderRadius: 12,
                        minWidth: 260,
                        textDecoration: "none",
                        color: "inherit",
                    }}
                >
                    <h3 style={{ margin: 0 }}>Courier</h3>
                    <p style={{ margin: "8px 0 0" }}>Login / Signup</p>
                </Link>
            </div>
        </div>
    );
}
