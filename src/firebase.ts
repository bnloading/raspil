import { initializeApp, getApps, deleteApp } from "firebase/app";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  initializeAuth,
  inMemoryPersistence,
} from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// Firebase's public web config (apiKey etc.) is not a secret — it's safe to ship to the browser
// and access is actually controlled by firestore.rules — but it's still read from env vars per
// the project's env-var convention, with the existing values as a fallback so the current Vercel
// deployment doesn't break if the env vars aren't set there yet. See .env.example.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyAeR4IdG4Ckt4sgh_OyH3jpVt9XNQCKXt4",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "flagman-7df3c.firebaseapp.com",
  databaseURL:
    import.meta.env.VITE_FIREBASE_DATABASE_URL ||
    "https://flagman-7df3c-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "flagman-7df3c",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "flagman-7df3c.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "320580390512",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:320580390512:web:a0a347782064872ff96eb5",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || "G-RCQW741LH0",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Сессияны сақтау — қайта кірмес үшін
setPersistence(auth, browserLocalPersistence);

/**
 * Admin's "create staff/customer account" action must not sign the admin out. The Firebase client
 * SDK's createUserWithEmailAndPassword always signs in as the newly created user on the app
 * instance it's called on, so we run it on a disposable secondary app instance (in-memory
 * persistence, torn down immediately after) instead of the primary `auth`.
 */
export async function createUserWithoutSigningIn(
  email: string,
  password: string,
): Promise<string> {
  const name = `secondary-${Date.now()}`;
  const secondaryApp = initializeApp(firebaseConfig, name);
  try {
    const secondaryAuth = initializeAuth(secondaryApp, { persistence: inMemoryPersistence });
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    return cred.user.uid;
  } finally {
    const existing = getApps().find((a) => a.name === name);
    if (existing) await deleteApp(existing);
  }
}

