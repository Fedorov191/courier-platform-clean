import { useState } from "react";
import { createUserWithEmailAndPassword } from "firebase/auth";
import { auth, db } from "../lib/firebase";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { useNavigate, Link } from "react-router-dom";

export default function CourierSignupPage() {
    const nav = useNavigate();

    const [firstName, setFirstName] = useState("");
    const [lastName, setLastName] = useState("");
    const [phone, setPhone] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");

    const [err, setErr] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    async function onSubmit(e: React.FormEvent) {
        e.preventDefault();
        setErr(null);
        setSaving(true);

        try {
            const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
            const uid = cred.user.uid;

            await setDoc(
                doc(db, "couriers", uid),
                {
                    createdAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                    status: "active",
                    firstName: firstName.trim(),
                    lastName: lastName.trim(),
                    phone: phone.trim(),
                },
                { merge: true }
            );

            nav("/courier/app", { replace: true });
        } catch (e: any) {
            setErr(e?.message ?? "Signup failed");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div style={{ padding: 16, maxWidth: 420 }}>
            <h2>Courier Signup</h2>

            <form onSubmit={onSubmit}>
                <input placeholder="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
                <br />
                <input placeholder="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} />
                <br />
                <input placeholder="Phone (optional)" value={phone} onChange={(e) => setPhone(e.target.value)} />
                <br />
                <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
                <br />
                <input placeholder="Password (min 6)" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                <br />
                <button type="submit" disabled={saving}>{saving ? "Creating..." : "Create"}</button>
            </form>

            {err && <p style={{ color: "crimson" }}>{err}</p>}

            <p>
                <Link to="/courier/login">Back to login</Link>
            </p>
        </div>
    );
}
