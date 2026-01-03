import { useMemo, useRef, useState } from "react";
import { createUserWithEmailAndPassword } from "firebase/auth";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { auth, db } from "../lib/firebase";
import { Link, useNavigate } from "react-router-dom";

type FormState = {
    restaurantName: string;
    email: string;
    password: string;
    address: string;
    phone: string;

    bankName: string;
    bankNumber: string;
    branchNumber: string;
    accountNumber: string;
    accountHolder: string;
};

type Errors = Partial<Record<keyof FormState, string>>;

function onlyDigits(s: string) {
    return s.replace(/\D/g, "");
}

function isEmailLike(s: string) {
    return /^\S+@\S+\.\S+$/.test(s.trim());
}

export function SignupPage() {
    const navigate = useNavigate();

    const [loading, setLoading] = useState(false);
    const [submitError, setSubmitError] = useState<string>("");

    // Это флаг: пользователь уже нажал Create Account хотя бы раз
    // Если да — показываем красные ошибки
    const [wasSubmitted, setWasSubmitted] = useState(false);

    const [form, setForm] = useState<FormState>({
        restaurantName: "",
        email: "",
        password: "",
        address: "",
        phone: "",

        bankName: "",
        bankNumber: "",
        branchNumber: "",
        accountNumber: "",
        accountHolder: "",
    });

    const refs = {
        restaurantName: useRef<HTMLInputElement | null>(null),
        email: useRef<HTMLInputElement | null>(null),
        password: useRef<HTMLInputElement | null>(null),
        address: useRef<HTMLInputElement | null>(null),
        phone: useRef<HTMLInputElement | null>(null),

        bankName: useRef<HTMLInputElement | null>(null),
        bankNumber: useRef<HTMLInputElement | null>(null),
        branchNumber: useRef<HTMLInputElement | null>(null),
        accountNumber: useRef<HTMLInputElement | null>(null),
        accountHolder: useRef<HTMLInputElement | null>(null),
    };

    const update = (key: keyof FormState, value: string) => {
        setForm((prev) => ({ ...prev, [key]: value }));
    };

    // Валидация + ошибки по полям
    const errors: Errors = useMemo(() => {
        const e: Errors = {};

        if (form.restaurantName.trim().length < 2) {
            e.restaurantName = "Укажи название ресторана (минимум 2 символа).";
        }

        if (!isEmailLike(form.email)) {
            e.email = "Введи корректный email (пример: name@gmail.com).";
        }

        if (form.password.length < 8) {
            e.password = "Пароль должен быть минимум 8 символов.";
        }

        if (form.address.trim().length < 5) {
            e.address = "Укажи полный адрес (улица, дом, город).";
        }

        const phoneDigits = onlyDigits(form.phone);
        if (phoneDigits.length < 9) {
            e.phone = "Телефон должен содержать минимум 9 цифр (обычно 10 в Израиле).";
        }

        if (form.bankName.trim().length < 2) {
            e.bankName = "Укажи название банка (например: Hapoalim / Leumi / Discount).";
        }

        const bankDigits = onlyDigits(form.bankNumber);
        if (bankDigits.length < 2) {
            e.bankNumber = "Bank number должен быть минимум 2 цифры (пример: 12).";
        }

        const branchDigits = onlyDigits(form.branchNumber);
        if (branchDigits.length < 3) {
            e.branchNumber = "Branch/Snif обычно 3 цифры (пример: 123).";
        }

        const accDigits = onlyDigits(form.accountNumber);
        if (accDigits.length < 5) {
            e.accountNumber = "Account number должен быть минимум 5 цифр.";
        }

        if (form.accountHolder.trim().length < 2) {
            e.accountHolder = "Укажи имя владельца счёта / компанию (как в банке).";
        }

        return e;
    }, [form]);

    const canSubmit = Object.keys(errors).length === 0;

    function inputStyle(hasError: boolean) {
        return {
            width: "100%",
            padding: 10,
            borderRadius: 8,
            border: hasError ? "1px solid crimson" : "1px solid #333",
            outline: "none",
        } as const;
    }

    const Hint = ({ text }: { text: string }) => (
        <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>{text}</div>
    );

    const FieldError = ({ text }: { text?: string }) => {
        if (!text) return null;
        return <div style={{ fontSize: 12, color: "crimson", marginTop: 4 }}>{text}</div>;
    };

    const scrollToFirstError = () => {
        const order: (keyof FormState)[] = [
            "restaurantName",
            "email",
            "password",
            "address",
            "phone",
            "bankName",
            "bankNumber",
            "branchNumber",
            "accountNumber",
            "accountHolder",
        ];

        for (const k of order) {
            if (errors[k]) {
                const el = refs[k].current;
                if (el) {
                    el.scrollIntoView({ behavior: "smooth", block: "center" });
                    el.focus();
                }
                break;
            }
        }
    };

    const onSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitError("");
        setWasSubmitted(true);

        if (!canSubmit) {
            scrollToFirstError();
            return;
        }

        setLoading(true);

        try {
            const cred = await createUserWithEmailAndPassword(
                auth,
                form.email.trim(),
                form.password
            );

            await setDoc(doc(db, "restaurants", cred.user.uid), {
                uid: cred.user.uid,
                email: form.email.trim().toLowerCase(),

                restaurantName: form.restaurantName.trim(),
                address: form.address.trim(),
                phone: form.phone.trim(),

                billing: {
                    bankName: form.bankName.trim(),
                    bankNumber: onlyDigits(form.bankNumber),
                    branchNumber: onlyDigits(form.branchNumber),
                    accountNumber: onlyDigits(form.accountNumber),
                    accountHolder: form.accountHolder.trim(),
                },

                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
            });

            navigate("/app/orders");
        } catch (err: any) {
            setSubmitError(err?.message ?? "Signup failed");
        } finally {
            setLoading(false);
        }
    };

    // показываем ошибки только после попытки отправки
    const showErrors = wasSubmitted;

    return (
        <div style={{ padding: 24, maxWidth: 560, margin: "0 auto" }}>
            <h2>Sign up (restaurant)</h2>

            <form onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
                <h4 style={{ margin: "8px 0 0" }}>Basic</h4>

                <div>
                    <input
                        ref={refs.restaurantName}
                        placeholder="Restaurant name"
                        value={form.restaurantName}
                        onChange={(e) => update("restaurantName", e.target.value)}
                        style={inputStyle(showErrors && !!errors.restaurantName)}
                    />
                    <Hint text="Например: Pizza Haifa" />
                    <FieldError text={showErrors ? errors.restaurantName : undefined} />
                </div>

                <div>
                    <input
                        ref={refs.email}
                        placeholder="Email"
                        type="email"
                        value={form.email}
                        onChange={(e) => update("email", e.target.value)}
                        style={inputStyle(showErrors && !!errors.email)}
                    />
                    <Hint text="Email будет логином." />
                    <FieldError text={showErrors ? errors.email : undefined} />
                </div>

                <div>
                    <input
                        ref={refs.password}
                        placeholder="Password (min 8 chars)"
                        type="password"
                        value={form.password}
                        onChange={(e) => update("password", e.target.value)}
                        style={inputStyle(showErrors && !!errors.password)}
                    />
                    <Hint text="Минимум 8 символов." />
                    <FieldError text={showErrors ? errors.password : undefined} />
                </div>

                <div>
                    <input
                        ref={refs.address}
                        placeholder="Restaurant address (full)"
                        value={form.address}
                        onChange={(e) => update("address", e.target.value)}
                        style={inputStyle(showErrors && !!errors.address)}
                    />
                    <Hint text="Улица, дом, город (+ этаж/вход если надо)." />
                    <FieldError text={showErrors ? errors.address : undefined} />
                </div>

                <div>
                    <input
                        ref={refs.phone}
                        placeholder="Phone (e.g. 052-1234567)"
                        value={form.phone}
                        onChange={(e) => update("phone", e.target.value)}
                        style={inputStyle(showErrors && !!errors.phone)}
                    />
                    <Hint text="Можно с тире/пробелами, мы сами возьмём цифры." />
                    <FieldError text={showErrors ? errors.phone : undefined} />
                </div>

                <hr />

                <h4 style={{ margin: 0 }}>Banking details (Israel)</h4>

                <div>
                    <input
                        ref={refs.bankName}
                        placeholder="Bank name (Hapoalim / Leumi / Discount)"
                        value={form.bankName}
                        onChange={(e) => update("bankName", e.target.value)}
                        style={inputStyle(showErrors && !!errors.bankName)}
                    />
                    <Hint text="Название банка — можно текстом." />
                    <FieldError text={showErrors ? errors.bankName : undefined} />
                </div>

                <div style={{ display: "flex", gap: 12 }}>
                    <div style={{ flex: 1 }}>
                        <input
                            ref={refs.bankNumber}
                            placeholder="Bank number (מס׳ בנק)"
                            value={form.bankNumber}
                            onChange={(e) => update("bankNumber", e.target.value)}
                            style={inputStyle(showErrors && !!errors.bankNumber)}
                        />
                        <Hint text="Только цифры (например: 12)." />
                        <FieldError text={showErrors ? errors.bankNumber : undefined} />
                    </div>

                    <div style={{ flex: 1 }}>
                        <input
                            ref={refs.branchNumber}
                            placeholder="Branch / Snif (מס׳ סניף)"
                            value={form.branchNumber}
                            onChange={(e) => update("branchNumber", e.target.value)}
                            style={inputStyle(showErrors && !!errors.branchNumber)}
                        />
                        <Hint text="Обычно 3 цифры (например: 123)." />
                        <FieldError text={showErrors ? errors.branchNumber : undefined} />
                    </div>
                </div>

                <div>
                    <input
                        ref={refs.accountNumber}
                        placeholder="Account number (מס׳ חשבון)"
                        value={form.accountNumber}
                        onChange={(e) => update("accountNumber", e.target.value)}
                        style={inputStyle(showErrors && !!errors.accountNumber)}
                    />
                    <Hint text="Только цифры." />
                    <FieldError text={showErrors ? errors.accountNumber : undefined} />
                </div>

                <div>
                    <input
                        ref={refs.accountHolder}
                        placeholder="Account holder (שם בעל החשבון)"
                        value={form.accountHolder}
                        onChange={(e) => update("accountHolder", e.target.value)}
                        style={inputStyle(showErrors && !!errors.accountHolder)}
                    />
                    <Hint text="Имя/компания как в банке." />
                    <FieldError text={showErrors ? errors.accountHolder : undefined} />
                </div>

                <button
                    disabled={loading}
                    style={{
                        padding: 12,
                        borderRadius: 10,
                        border: "1px solid #333",
                        cursor: loading ? "not-allowed" : "pointer",
                    }}
                >
                    {loading ? "Creating…" : "Create account"}
                </button>

                {!canSubmit && showErrors && (
                    <div style={{ fontSize: 12, color: "crimson" }}>
                        Исправь поля, подсвеченные красным.
                    </div>
                )}

                {submitError && <div style={{ color: "crimson" }}>{submitError}</div>}
            </form>

            <div style={{ marginTop: 12 }}>
                <Link to="/login">Already have an account?</Link>
            </div>
        </div>
    );
}
