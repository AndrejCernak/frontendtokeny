"use client";

import { useUser, SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { requestFcmToken } from "@/lib/firebase";
import { connectWS, sendWS } from "@/lib/wsClient";
import { createPeerConnection } from "@/lib/webrtc";

type IncomingCall = { from: string; callerName: string };

function formatSeconds(s: number) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m} min ${sec}s`;
}

function isFridayInBratislava(d = new Date()) {
  const local = new Date(d.toLocaleString("en-US", { timeZone: "Europe/Bratislava" }));
  return local.getDay() === 5; // 0=Sun ... 5=Fri
}

export default function HomePage() {
  const { user, isSignedIn } = useUser();
  const role = (user?.publicMetadata.role as string) || "client";

  // ——— Call state
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [pc, setPc] = useState<RTCPeerConnection | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const [hasNotifications, setHasNotifications] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return (
      Notification.permission === "granted" ||
      localStorage.getItem("fcm-enabled") === "1"
    );
  });
  const [isMuted, setIsMuted] = useState(false);
  const [inCall, setInCall] = useState(false);

  // ——— Balances
  const [fridayMinutesRemaining, setFridayMinutesRemaining] = useState<number>(0); // Friday tokens credit (minutes)
  const isFriday = useMemo(() => isFridayInBratislava(), []);

  // ——— Media/WS helpers
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const callTimerRef = useRef<NodeJS.Timeout | null>(null);
  const peerIdRef = useRef<string | null>(null);

  const [pendingOffer, setPendingOffer] = useState<{ offer: RTCSessionDescriptionInit; from: string } | null>(null);

  // ===== Backend helpers =====
  const backend = process.env.NEXT_PUBLIC_BACKEND_URL!;
  const adminId = process.env.NEXT_PUBLIC_ADMIN_ID as string; // nastav vo Verceli

  const fetchFridayBalance = useCallback(async () => {
    if (!user) return 0;
    const res = await fetch(`${backend}/friday/balance/${user.id}`);
    const data = await res.json();
    const m = data?.totalMinutes ?? 0;
    setFridayMinutesRemaining(m);
    return m;
  }, [backend, user]);

  const startLocalStream = useCallback(async () => {
    try {
      localStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.error("❌ Mikrofón:", err);
      alert("Nepodarilo sa získať prístup k mikrofónu.");
    }
  }, []);

  const toggleMute = useCallback(() => {
    const track = localStreamRef.current?.getAudioTracks?.()[0];
    if (track) {
      track.enabled = !track.enabled;
      setIsMuted(!track.enabled ? true : false);
    }
  }, []);

  const attachRemoteStream = useCallback((stream: MediaStream) => {
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = stream;
      remoteAudioRef.current.play().catch(() => {});
    }
  }, []);

  const clearCallTimer = () => {
    if (callTimerRef.current) {
      clearInterval(callTimerRef.current);
      callTimerRef.current = null;
    }
  };



  const stopCall = useCallback(
  async (targetId?: string) => {
    try {
      const id = targetId ?? peerIdRef.current ?? undefined;
      if (id) {
        // pošli info druhej strane skôr, než zrušíš lokálne zdroje
        sendWS({ type: "end-call", targetId: id });
      }

      if (pcRef.current) {
        pcRef.current.getSenders().forEach(s => s.track && s.track.stop());
        pcRef.current.close();
      }
      pcRef.current = null;
      setPc(null);

      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;

      clearCallTimer();
      setInCall(false);
      setIsMuted(false);
      setIncomingCall(null);            // 👈 skry "niekto volá"
      setPendingOffer(null);            // (voliteľné) zruš pending SDP
    } finally {
      peerIdRef.current = null;
      await fetchFridayBalance();
    }
  },
  [fetchFridayBalance]
);


// ===== Accept / Call =====
const handleAccept = useCallback(
  async (targetId: string) => {
    setIncomingCall(null);              // 👈 skry kartu s "Prichádzajúci hovor"
    if (!localStreamRef.current) await startLocalStream();

    const newPc = createPeerConnection(localStreamRef.current!, targetId, attachRemoteStream);
    setPc(newPc);
    pcRef.current = newPc;   // 🔑
    peerIdRef.current = targetId;

    if (pendingOffer && pendingOffer.from === targetId) {
      await newPc.setRemoteDescription(new RTCSessionDescription(pendingOffer.offer));
      const answer = await newPc.createAnswer();
      await newPc.setLocalDescription(answer);
      sendWS({ type: "webrtc-answer", targetId, answer });
      setPendingOffer(null);
      try { remoteAudioRef.current?.play?.(); } catch {}
    } else {
      // app bola zavretá → vypýtaj si čerstvý offer
      sendWS({ type: "request-offer", targetId });
    }

    setInCall(true);
  },
  [startLocalStream, pendingOffer, attachRemoteStream]
);

const handleCall = useCallback(async () => {
  if (!user) return;

  if (isFriday) {
  const m = await fetchFridayBalance();
  if (m <= 0) {
    alert("V piatok môžeš volať iba s piatkovými tokenmi. Skús kúpiť token alebo burzu.");
    window.location.href = "/burza-tokenov";
    return;
  }
}
// mimo piatku: žiadna kontrola, volanie je zadarmo


  if (!localStreamRef.current) await startLocalStream();

  const targetId = adminId;
  const newPc = createPeerConnection(localStreamRef.current!, targetId, attachRemoteStream);
  setPc(newPc);
  pcRef.current = newPc;   // 🔑
  peerIdRef.current = targetId;

  const offer = await newPc.createOffer();
  await newPc.setLocalDescription(offer);

  sendWS({ type: "call-request", targetId, callerName: user?.fullName || "Neznámy" });
  sendWS({ type: "webrtc-offer", targetId, offer, callerId: user?.id });

  setInCall(true);
}, [user, isFriday, fetchFridayBalance, startLocalStream, attachRemoteStream, adminId]);


  const sendNewOffer = useCallback(
  async (targetId: string) => {
    // 1) uisti sa, že máme lokálny audio stream
    if (!localStreamRef.current) {
      await startLocalStream();
    }

    // 2) použij existujúci PC, alebo vytvor nový
    let pcToUse = pc;
    if (!pcToUse) {
      const newPc = createPeerConnection(localStreamRef.current!, targetId, attachRemoteStream);
      setPc(newPc);
      peerIdRef.current = targetId;
      pcToUse = newPc;
    }

    // 3) vygeneruj nový offer (s istotou ICE reštartu) a odošli ho
    const offer = await pcToUse.createOffer({ iceRestart: true });
    await pcToUse.setLocalDescription(offer);

    sendWS({
      type: "webrtc-offer",
      targetId,
      offer,
      callerId: user?.id,
    });
  },
  [pc, startLocalStream, attachRemoteStream, user]
);

  useEffect(() => {
  if (isSignedIn && user) {
    // hneď načítaj oba zostatky
    fetchFridayBalance();

    connectWS(user.id, role, async (msg) => {
      if (msg.type === "incoming-call") {
        setIncomingCall({ from: msg.callerId as string, callerName: msg.callerName as string });
      }

      if (msg.type === "insufficient-friday-tokens") {
        alert("V piatok môžeš volať iba s piatkovými tokenmi. Skús kúpiť token alebo burzu.");
        setInCall(false);
        clearCallTimer();
        window.location.href = "/burza-tokenov";
      }

      if (msg.type === "call-started") {
          setIncomingCall(null);                // 👈 po nabehnutí hovoru neukazuj "niekto volá"
        setInCall(true);
      }

      if (msg.type === "end-call") {
          setIncomingCall(null);                // 👈 skry prichádzajúci hovor

        await stopCall(msg.from as string | undefined);
      }

      if (msg.type === "webrtc-offer") {
        const pcLocal = pcRef.current;
        if (!pcLocal) {
          setPendingOffer({ offer: msg.offer as RTCSessionDescriptionInit, from: msg.callerId as string });
        } else {
          await pcLocal.setRemoteDescription(new RTCSessionDescription(msg.offer as RTCSessionDescriptionInit));
          const answer = await pcLocal.createAnswer();
          await pcLocal.setLocalDescription(answer);
          sendWS({ type: "webrtc-answer", targetId: msg.callerId, answer });
          try { remoteAudioRef.current?.play?.(); } catch {}
        }
      }


     if (msg.type === "webrtc-answer") {
      if (!localStreamRef.current) await startLocalStream();

      let pcLocal = pcRef.current;
      if (!pcLocal) {
        const newPc = createPeerConnection(localStreamRef.current!, msg.callerId as string, attachRemoteStream);
        setPc(newPc);
        pcRef.current = newPc; // 🔑
        peerIdRef.current = msg.callerId as string;
        pcLocal = newPc;
      }

      await pcLocal.setRemoteDescription(new RTCSessionDescription(msg.answer as RTCSessionDescriptionInit));
      try { remoteAudioRef.current?.play?.(); } catch {}
    }


      if (msg.type === "webrtc-candidate") {
        const pcLocal = pcRef.current;
        if (pcLocal) {
          await pcLocal.addIceCandidate(new RTCIceCandidate(msg.candidate as RTCIceCandidateInit));
        }
      }


      // 🔁 NOVÉ: admin žiada nový offer po “prebudení” PWA
      if (msg.type === "request-offer") {
        const adminId = msg.from as string;
        await sendNewOffer(adminId);
      }

      // live updates
      if (msg.type === "friday-balance-update") {
        setFridayMinutesRemaining(msg.minutesRemaining as number);
      }
    });
  }

  return () => {
    clearCallTimer();
  };
}, [
  isSignedIn,
  user,
  role,
  startLocalStream,
  attachRemoteStream,
  fetchFridayBalance,
  stopCall,
  sendNewOffer 
]);

useEffect(() => {
  (async () => {
    if (pendingOffer && pcRef.current) {
      try {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(pendingOffer.offer));
        const answer = await pcRef.current.createAnswer();
        await pcRef.current.setLocalDescription(answer);
        sendWS({ type: "webrtc-answer", targetId: pendingOffer.from, answer });
        setPendingOffer(null);
        try { remoteAudioRef.current?.play?.(); } catch {}
      } catch (e) {
        console.error("auto-accept pendingOffer failed:", e);
      }
    }
  })();
}, [pendingOffer]);


  // ===== Auto-register push on app start when already granted =====
  useEffect(() => {
    const autoRegisterPush = async () => {
      if (!isSignedIn || !user) return;
      if (Notification.permission !== "granted") return;
      try {
        const token = await requestFcmToken();
        if (!token) return;
        const role = (user.publicMetadata.role as string) || "client";
        await fetch(`${backend}/register-fcm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: user.id, fcmToken: token, role }),
        });
        setHasNotifications(true);
        if (typeof window !== "undefined") localStorage.setItem("fcm-enabled", "1");
      } catch (_) {
      }
    };
    autoRegisterPush();
  }, [isSignedIn, user, backend]);

  const handleEnableNotifications = useCallback(async () => {
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        alert("Notifikácie neboli povolené.");
        return;
      }
      const token = await requestFcmToken();
      if (!token || !user) {
        alert("Nepodarilo sa získať FCM token.");
        return;
      }
      const role = (user.publicMetadata.role as string) || "client";
      const res = await fetch(`${backend}/register-fcm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, fcmToken: token, role }),
      });
      if (res.ok) {
        setHasNotifications(true);
        if (typeof window !== "undefined") localStorage.setItem("fcm-enabled", "1");
        alert("Notifikácie boli povolené ✅");
      } else {
        alert("Chyba pri registrácii tokenu.");
      }
    } catch (err) {
      console.error("FCM chyba:", err);
      alert("Nastala chyba pri nastavovaní notifikácií.");
    }
  }, [backend, user]);

  return (
    <main className="min-h-screen bg-gradient-to-br from-stone-100 via-emerald-50 to-amber-50 text-stone-800">
      <div className="max-w-3xl mx-auto p-6">
        <header className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-emerald-600/10 flex items-center justify-center shadow-inner">
              <span className="text-emerald-700 font-bold">🔊</span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">Audio hovory</h1>
          </div>
          <div className="flex items-center gap-3">
            <SignedOut>
              <SignInButton />
            </SignedOut>
            <SignedIn>
              <UserButton />
            </SignedIn>
          </div>
        </header>

        <SignedIn>
          <section className="rounded-2xl bg-white/80 backdrop-blur shadow-sm border border-stone-200 p-5 mb-5">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <p className="text-sm text-stone-500">Prihlásený používateľ</p>
                <p className="font-medium">{user?.fullName}</p>
                <p className="text-sm text-stone-600 mt-1">
                  Piatkové minúty: <span className="font-semibold">{fridayMinutesRemaining} min</span>
                </p>
              </div>

              <div className="flex items-center gap-2">
                {!hasNotifications && (
                  <button
                    className="px-4 py-2 rounded-xl bg-emerald-600 text-white shadow hover:bg-emerald-700 transition"
                    onClick={handleEnableNotifications}
                  >
                    Povoliť notifikácie
                  </button>
                )}
                {role !== "admin" && (
                  <button
                    onClick={() => (window.location.href = "/burza-tokenov")}
                    className="px-4 py-2 rounded-xl bg-amber-500 text-white shadow hover:bg-amber-600 transition"
                  >
                    Burza piatkových tokenov
                  </button>
                )}
              </div>
            </div>
          </section>

          <section className="rounded-2xl bg-white/80 backdrop-blur shadow-sm border border-stone-200 p-6">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex-1">
                <h2 className="text-lg font-semibold mb-1">Stav hovoru</h2>
                <p className="text-stone-600 text-sm">
                  {incomingCall
                    ? `Prichádzajúci hovor od: ${incomingCall.callerName}`
                    : inCall
                    ? "Prebieha hovor"
                    : "Pripravený na hovor"}
                </p>
                <p className="text-xs text-stone-500 mt-1">
                  {isFriday ? "Piatok: volanie len s piatkovými tokenmi." : "Mimo piatku: volanie je zadarmo."}
                </p>
              </div>

              {user?.publicMetadata.role === "client" && (
                <button
                  disabled={(isFriday ? fridayMinutesRemaining <= 0 : false) || inCall}
                  className={`px-5 py-3 rounded-xl font-medium shadow transition
                    ${
                      (isFriday ? fridayMinutesRemaining <= 0 : false) || inCall
                        ? "bg-stone-300 text-stone-500 cursor-not-allowed"
                        : "bg-emerald-600 text-white hover:bg-emerald-700"
                    }`}
                  onClick={handleCall}
                >
                  Zavolať
                </button>
              )}


              {user?.publicMetadata.role === "admin" && incomingCall && (
                <div className="flex items-center gap-3">
                  <div className="px-3 py-2 rounded-xl bg-amber-100 text-amber-800 font-medium">
                    📞 Volá: {incomingCall.callerName}
                  </div>
                  <button
                    className="px-5 py-3 rounded-xl bg-emerald-600 text-white font-medium shadow hover:bg-emerald-700 transition"
                    onClick={() => handleAccept(incomingCall.from)}
                  >
                    Prijať
                  </button>
                </div>
              )}

              <div className="flex items-center gap-2">
                <button
                  className="px-4 py-2 rounded-xl bg-emerald-600 text-white shadow hover:bg-emerald-700 transition"
                  onClick={toggleMute}
                  disabled={!inCall}
                >
                  {isMuted ? "Unmute" : "Mute"}
                </button>
                <button
                  className="px-4 py-2 rounded-xl bg-stone-700 text-white shadow hover:bg-stone-800 transition disabled:opacity-50"
                  onClick={() => stopCall()}             // 👈 bez parametra
                  disabled={!inCall}
                >
                  Ukončiť hovor
                </button>
              </div>
            </div>

            {/* 🔈 remote audio */}
            <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
          </section>

          

          <p className="text-xs text-stone-500 mt-4">
            Tip: Ak nič nepočuť, skontroluj povolenia mikrofónu v prehliadači a systémové nastavenia výstupného zvuku.
          </p>
        </SignedIn>
      </div>
    </main>
  );
}
