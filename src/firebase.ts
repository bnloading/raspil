import { initializeApp } from "firebase/app";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
} from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAeR4IdG4Ckt4sgh_OyH3jpVt9XNQCKXt4",
  authDomain: "flagman-7df3c.firebaseapp.com",
  databaseURL:
    "https://flagman-7df3c-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "flagman-7df3c",
  storageBucket: "flagman-7df3c.firebasestorage.app",
  messagingSenderId: "320580390512",
  appId: "1:320580390512:web:a0a347782064872ff96eb5",
  measurementId: "G-RCQW741LH0",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Сессияны сақтау — қайта кірмес үшін
setPersistence(auth, browserLocalPersistence);
