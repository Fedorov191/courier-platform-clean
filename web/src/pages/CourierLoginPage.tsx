import { useState } from "react";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "../lib/firebase";
import { useNavigate, Link } from "react-router-dom";

export default function CourierLoginPage() {
    const nav = useNavigate();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [err, setErr] = useState<string | null>(null);

    async function onSubmit(e: React.FormEvent) {
        e.preventDefault();
        setErr(null);
        try {
            await signInWithEmailAndPassword(auth, email.trim(), password);
            nav("/courier/app", { replace: true });
        } catch (e: any) {
            setErr(e?.message ?? "Login failed");
        }
    }

    return (
        <div style={{ padding: 16, maxWidth: 420 }}>
            <h2>Courier Login</h2>
            <form onSubmit={onSubmit}>
                <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
                <br />
                <input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                <br />
                <button type="submit">Login</button>
            </form>
            {err && <p style={{ color: "crimson" }}>{err}</p>}
            <p><Link to="/courier/signup">Create courier account</Link></p>
        </div>
    );
}
