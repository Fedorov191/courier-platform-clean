import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator } from "firebase/functions";

const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app);

// ✅ Emulator mode switch
const USE_EMULATORS = import.meta.env.VITE_USE_EMULATORS === "true";

if (USE_EMULATORS) {
    // Auth
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });

    // Firestore
    connectFirestoreEmulator(db, "127.0.0.1", 8080);

    // Functions
    connectFunctionsEmulator(functions, "127.0.0.1", 5001);
}
