// lib/firebase.ts
import { initializeApp, type FirebaseApp } from "firebase/app";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

let app: FirebaseApp | null = null;
function getApp(): FirebaseApp {
  if (!app) app = initializeApp(firebaseConfig);
  return app!;
}

/** Zistí bezpečne podporu Web Push (iOS Safari v tabu = false, PWA na ploche = true). */
async function getMessagingIfSupported() {
  if (typeof window === "undefined") return null;

  try {
    const { isSupported, getMessaging } = await import("firebase/messaging");
    const supported = await isSupported();
    if (!supported) return null;
    if (!("Notification" in window)) return null;
    if (!("serviceWorker" in navigator)) return null;

    return getMessaging(getApp());
  } catch (err) {
    console.warn("Messaging not available:", err);
    return null;
  }
}

export const requestFcmToken = async () => {
  const messaging = await getMessagingIfSupported();
  if (!messaging) return null;

  try {
    const { getToken } = await import("firebase/messaging");
    const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;
    if (!vapidKey) return null;
    return await getToken(messaging, { vapidKey });
  } catch (error) {
    console.error("FCM token error:", error);
    return null;
  }
};
