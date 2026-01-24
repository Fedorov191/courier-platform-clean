import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth, db } from "../lib/firebase";
import { useI18n, type Lang } from "../lib/i18n";

import { doc, onSnapshot, setDoc, serverTimestamp } from "firebase/firestore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

function normalizeLang(x: unknown): Lang | null {
    return x === "en" || x === "ru" || x === "he" ? x : null;
}

export function AppLayout() {
    const nav = useNavigate();
    const { lang, setLang, t } = useI18n();

    const [uid, setUid] = useState<string | null>(auth.currentUser?.uid ?? null);

    // следим за auth (важно после refresh)
    useEffect(() => {
        const unsub = onAuthStateChanged(auth, (u) => setUid(u?.uid ?? null));
        return () => unsub();
    }, []);

    // чтобы не пересоздавать подписку из-за lang в deps
    const langRef = useRef<Lang>(lang);
    useEffect(() => {
        langRef.current = lang;
    }, [lang]);

    // 1) Подтягиваем язык из профиля ресторана
    useEffect(() => {
        if (!uid) return;

        const ref = doc(db, "restaurants", uid);

        const unsub = onSnapshot(
            ref,
            (snap) => {
                const data: any = snap.data();
                const remoteLang = normalizeLang(data?.lang);
                if (remoteLang && remoteLang !== langRef.current) {
                    setLang(remoteLang);
                }
            },
            () => {}
        );

        return () => unsub();
    }, [uid, setLang]);

    // 2) Сохраняем язык в профиль ресторана при переключении
    const setLangAndPersist = useCallback(
        async (next: Lang) => {
            setLang(next);

            if (!uid) return;
            try {
                await setDoc(
                    doc(db, "restaurants", uid),
                    {
                        lang: next,
                        updatedAt: serverTimestamp(),
                    },
                    { merge: true }
                );
            } catch {
                // не ломаем UI, язык уже переключили локально
            }
        },
        [uid, setLang]
    );

    const logout = useCallback(async () => {
        await signOut(auth);
        nav("/restaurant/login");
    }, [nav]);

    const linkClass = useCallback(
        ({ isActive }: { isActive: boolean }) => `navlink ${isActive ? "is-active" : ""}`,
        []
    );

    const langs = useMemo(
        () =>
            [
                { code: "en" as const, label: "EN" },
                { code: "ru" as const, label: "RU" },
                { code: "he" as const, label: "HE" },
            ] as const,
        []
    );

    return (
        <div className="page">
            <div className="container">
                <header className="card">
                    <div className="card__inner">
                        <div className="topnav">
                            <div className="row row--wrap" style={{ alignItems: "center", gap: 12 }}>
                                <div className="brand">{t("restaurantConsole")}</div>

                                <nav className="navlinks">
                                    <NavLink to="/restaurant/app/orders" className={linkClass}>
                                        {t("orders")}
                                    </NavLink>

                                    <NavLink to="/restaurant/app/orders/new" className={linkClass}>
                                        {t("newOrder")}
                                    </NavLink>

                                    <NavLink to="/restaurant/app/reports" className={linkClass}>
                                        {t("reports")}
                                    </NavLink>
                                </nav>

                                {/* Language switch */}
                                <div className="row row--wrap" style={{ gap: 6 }}>
                                    {langs.map((l) => (
                                        <button
                                            key={l.code}
                                            type="button"
                                            className={`btn ${lang === l.code ? "btn--primary" : "btn--ghost"}`}
                                            onClick={() => setLangAndPersist(l.code)}
                                            title={t("language")}
                                        >
                                            {l.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <button className="btn btn--ghost" onClick={logout}>
                                {t("logout")}
                            </button>
                        </div>
                    </div>
                </header>

                <div style={{ height: 12 }} />
                <Outlet />
            </div>
        </div>
    );
}
