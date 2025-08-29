import { initializeApp } from "firebase/app";
import { getMessaging, getToken } from "firebase/messaging";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);

/**
 * Bezpečne vytvorí messaging len ak bežíme v prehliadači,
 * a len ak daná platforma podporuje service workers + push.
 */
function createMessaging() {
  if (typeof window === "undefined") return null;

  const isIos = /iP(hone|ad|od)/.test(navigator.userAgent);
  const isStandalone =
    window.matchMedia?.("(display-mode: standalone)")?.matches ||
    (navigator as any).standalone === true;

  // iOS podporuje web push len ak je to PWA (standalone)
  if (isIos && !isStandalone) return null;

  // ostatné browsery: musí existovať serviceWorker a PushManager
  if (!("serviceWorker" in navigator) || !(window as any).PushManager) {
    return null;
  }

  try {
    return getMessaging(app);
  } catch (err) {
    console.warn("Firebase messaging init error:", err);
    return null;
  }
}

export const messaging = createMessaging();

export const requestFcmToken = async () => {
  if (!messaging) return null;
  try {
    return await getToken(messaging, {
      vapidKey: process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY,
    });
  } catch (error) {
    console.error("FCM token error:", error);
    return null;
  }
};
