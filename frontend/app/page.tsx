"use client";

import { useUser, SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
import { useCallback, useEffect, useRef, useState } from "react";
import { requestFcmToken } from "@/lib/firebase";
import { connectWS, sendWS } from "@/lib/wsClient";
import { createPeerConnection } from "@/lib/webrtc";

type IncomingCall = { from: string; callerName: string };
type Role = "client" | "admin";

function formatSeconds(s: number) {
  const m = Math.floor((s ?? 0) / 60);
  const sec = Math.max(0, (s ?? 0) % 60);
  return `${m} min ${sec.toString().padStart(2, "0")} s`;
}

export default function HomePage() {
  const { user, isSignedIn } = useUser();
  const [role, setRole] = useState<Role>("client");
  const [secondsRemaining, setSecondsRemaining] = useState<number>(0);

  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [pc, setPc] = useState<RTCPeerConnection | null>(null);
  const [inCall, setInCall] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [hasNotifications, setHasNotifications] = useState(false);

  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const callTimerRef = useRef<NodeJS.Timeout | null>(null);

  const [pendingOffer, setPendingOffer] = useState<{ offer: RTCSessionDescriptionInit; from: string } | null>(null);

  const ADMIN_ID = process.env.NEXT_PUBLIC_ADMIN_ID!;

  const fetchMe = useCallback(async () => {
    if (!user) return;
    try {
      const r = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/me/${user.id}`);
      const d = await r.json();
      setRole(d?.role === "admin" ? "admin" : "client");
      setSecondsRemaining(d?.secondsRemaining ?? 0);
    } catch {
      // ignore
    }
  }, [user]);

  const startLocalStream = useCallback(async () => {
    try {
      localStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.error("Mic error:", err);
      alert("Nepodarilo sa získať prístup k mikrofónu.");
    }
  }, []);

  const attachRemoteStream = useCallback((stream: MediaStream) => {
    const el = remoteAudioRef.current;
    if (el) {
      el.srcObject = stream;
      el.play().catch(() => {});
    }
  }, []);

  const clearCallTimer = () => {
    if (callTimerRef.current) {
      clearInterval(callTimerRef.current);
      callTimerRef.current = null;
    }
  };

  const startUiCountdown = useCallback(() => {
    clearCallTimer();
    callTimerRef.current = setInterval(() => {
      setSecondsRemaining((prev) => (role === "client" ? Math.max(0, prev - 1) : prev));
    }, 1000);
  }, [role]);

  const toggleMute = useCallback(() => {
    const track = localStreamRef.current?.getAudioTracks?.()[0];
    if (track) {
      track.enabled = !track.enabled;
      setIsMuted(!track.enabled ? true : false);
    }
  }, []);

  const stopCall = useCallback(
    async (targetId?: string) => {
      try {
        pc?.getSenders().forEach((s) => s.track && s.track.stop());
        pc?.close();
        setPc(null);
        localStreamRef.current?.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
        clearCallTimer();
        setInCall(false);
        setIsMuted(false);
        if (targetId) sendWS({ type: "end-call", targetId });
      } finally {
        await fetchMe(); // presný zostatok zo servera
      }
    },
    [pc, fetchMe]
  );

  const handleAccept = useCallback(
    async (targetId: string) => {
      if (!localStreamRef.current) await startLocalStream();
      const newPc = createPeerConnection(localStreamRef.current!, targetId, attachRemoteStream);
      setPc(newPc);

      if (pendingOffer && pendingOffer.from === targetId) {
        await newPc.setRemoteDescription(new RTCSessionDescription(pendingOffer.offer));
        const answer = await newPc.createAnswer();
        await newPc.setLocalDescription(answer);
        sendWS({ type: "webrtc-answer", targetId, answer });
        setPendingOffer(null);
      }

      setInCall(true);
      startUiCountdown();
    },
    [startLocalStream, pendingOffer, attachRemoteStream, startUiCountdown]
  );

  const handleCall = useCallback(async () => {
    await fetchMe(); // refresh role + zostatok
    if (role === "client" && secondsRemaining <= 0) {
      alert("Nemáš dostupné tokeny. Kúp si balík, aby si mohol volať.");
      return;
    }
    if (!localStreamRef.current) await startLocalStream();

    const targetId = ADMIN_ID; // poradca
    const newPc = createPeerConnection(localStreamRef.current!, targetId, attachRemoteStream);
    setPc(newPc);

    const offer = await newPc.createOffer();
    await newPc.setLocalDescription(offer);

    sendWS({ type: "call-request", targetId, callerName: user?.fullName || "Neznámy" });
    sendWS({ type: "webrtc-offer", targetId, offer, callerId: user?.id });

    setInCall(true);
    startUiCountdown();
  }, [fetchMe, role, secondsRemaining, startLocalStream, ADMIN_ID, user, attachRemoteStream, startUiCountdown]);

  const handlePurchaseMvp = useCallback(async () => {
    if (!user) return;
    try {
      // 30 min = 1800 s → 225 €
      const r = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/purchase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, amountEur: 225.0 }),
      });
      const d = await r.json();
      if (d?.success) {
        await fetchMe();
        alert("Kredit navýšený. Môžeš volať 👍");
      } else {
        alert("Nákup zlyhal.");
      }
    } catch {
      alert("Chyba pri nákupe.");
    }
  }, [user, fetchMe]);

  const handleEnableNotifications = useCallback(async () => {
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        alert("Notifikácie neboli povolené.");
        return;
      }
      if (!user) return;
      const token = await requestFcmToken();
      if (!token) {
        alert("Nepodarilo sa získať FCM token.");
        return;
      }
      const res = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/register-fcm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, fcmToken: token, role }),
      });
      if (res.ok) {
        setHasNotifications(true);
        alert("Notifikácie boli povolené ✅");
      } else {
        alert("Chyba pri registrácii tokenu.");
      }
    } catch (err) {
      console.error("FCM chyba:", err);
      alert("Nastala chyba pri nastavovaní notifikácií.");
    }
  }, [user, role]);

  // WS – registrácia a správy
  useEffect(() => {
    if (!isSignedIn || !user) return;
    (async () => {
      await fetchMe();

      connectWS(user.id, role, async (msg) => {
        if (msg.type === "incoming-call") {
          setIncomingCall({ from: msg.callerId as string, callerName: msg.callerName as string });
        }

        if (msg.type === "insufficient-tokens") {
          alert("Nemáš dostupné tokeny. Kúp si balík, aby si mohol volať.");
          setInCall(false);
          clearCallTimer();
        }

        if (msg.type === "call-started") {
          setInCall(true);
          startUiCountdown();
        }

        if (msg.type === "end-call") {
          await stopCall(msg.from as string | undefined);
        }

        if (msg.type === "balance-update") {
          // serverový tick (každých 10 s)
          setSecondsRemaining(msg.secondsRemaining as number);
        }

        if (msg.type === "webrtc-offer") {
          if (!pc) {
            setPendingOffer({ offer: msg.offer as RTCSessionDescriptionInit, from: msg.callerId as string });
          } else {
            await pc.setRemoteDescription(new RTCSessionDescription(msg.offer as RTCSessionDescriptionInit));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendWS({ type: "webrtc-answer", targetId: msg.callerId, answer });
          }
        }

        if (msg.type === "webrtc-answer") {
          if (!localStreamRef.current) await startLocalStream();
          if (!pc) {
            const newPc = createPeerConnection(localStreamRef.current!, msg.callerId as string, attachRemoteStream);
            setPc(newPc);
            await newPc.setRemoteDescription(new RTCSessionDescription(msg.answer as RTCSessionDescriptionInit));
          } else {
            await pc.setRemoteDescription(new RTCSessionDescription(msg.answer as RTCSessionDescriptionInit));
          }
        }

        if (msg.type === "webrtc-candidate") {
          await pc?.addIceCandidate(new RTCIceCandidate(msg.candidate as RTCIceCandidateInit));
        }
      });
    })();

    return () => {
      clearCallTimer();
    };
  }, [isSignedIn, user, role, pc, startLocalStream, attachRemoteStream, fetchMe, startUiCountdown, stopCall]);

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

                {role === "client" && (
                  <p className="text-sm text-stone-600 mt-1">
                    Zostatok: <span className="font-semibold">{formatSeconds(secondsRemaining)}</span>
                  </p>
                )}
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

                {role === "client" && (
                  <button
                    onClick={handlePurchaseMvp}
                    className="px-4 py-2 rounded-xl bg-amber-500 text-white shadow hover:bg-amber-600 transition"
                  >
                    Kúpiť 30 min (225 €)
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
              </div>

              {/* klient volá na admina */}
              {role === "client" && (
                <button
                  disabled={(role === "client" && secondsRemaining <= 0) || inCall}
                  className={`px-5 py-3 rounded-xl font-medium shadow transition
                    ${(role === "client" && secondsRemaining <= 0) || inCall
                      ? "bg-stone-300 text-stone-500 cursor-not-allowed"
                      : "bg-emerald-600 text-white hover:bg-emerald-700"}`}
                  onClick={handleCall}
                >
                  Zavolať
                </button>
              )}

              {/* admin prijíma */}
              {role === "admin" && incomingCall && (
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
                  onClick={() => stopCall(incomingCall?.from ?? ADMIN_ID)}
                  disabled={!inCall}
                >
                  Ukončiť hovor
                </button>
              </div>
            </div>

            {/* vzdialený audio stream */}
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
