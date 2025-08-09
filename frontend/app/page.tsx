"use client";

import { useUser, SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
import { useEffect, useRef, useState, useCallback } from "react";
import { requestFcmToken } from "@/lib/firebase";
import { connectWS, sendWS } from "@/lib/wsClient";
import { createPeerConnection } from "@/lib/webrtc";

type IncomingCall = {
  from: string;
  callerName: string;
};

export default function HomePage() {
  const { user, isSignedIn } = useUser();
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [pc, setPc] = useState<RTCPeerConnection | null>(null);
  const [hasNotifications, setHasNotifications] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  const [pendingOffer, setPendingOffer] = useState<{
    offer: RTCSessionDescriptionInit;
    from: string;
  } | null>(null);

const pendingCalls = new Map();
const PENDING_TTL_MS = 90 * 1000; // 90 sekúnd držíme info

  // 🎤 len audio (bez videa)
  const startLocalStream = useCallback(async () => {
    try {
      localStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true }); // ✅ iba mikrofón
      console.log("🎤 Local audio tracks:", localStreamRef.current?.getTracks());
    } catch (err) {
      console.error("❌ Chyba pri získavaní mikrofónu:", err);
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

      const res = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/register-fcm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, fcmToken: token, role }),
      });

      if (res.ok) {
        alert("Notifikácie boli povolené ✅");
        setHasNotifications(true);
      } else {
        alert("Chyba pri registrácii tokenu.");
      }
    } catch (err) {
      console.error("FCM chyba:", err);
      alert("Nastala chyba pri nastavovaní notifikácií.");
    }
  }, [user]);

  const attachRemoteStream = useCallback((stream: MediaStream) => {
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = stream;
      // prehrá sa po užívateľskej akcii (Prijať/Zavolať)
      remoteAudioRef.current.play().catch((e) => {
        console.warn("Audio play wait for user gesture:", e);
      });
    }
  }, []);

  const handleAccept = useCallback(
    async (targetId: string) => {
      if (!localStreamRef.current) await startLocalStream();

      const newPc = createPeerConnection(localStreamRef.current!, targetId, attachRemoteStream);
      setPc(newPc);

      // spracuj čakajúci offer, ak je na tohto volajúceho
      if (pendingOffer && pendingOffer.from === targetId) {
        await newPc.setRemoteDescription(new RTCSessionDescription(pendingOffer.offer));
        const answer = await newPc.createAnswer();
        await newPc.setLocalDescription(answer);
        sendWS({ type: "webrtc-answer", targetId, answer });
        setPendingOffer(null);
      }
    },
    [startLocalStream, pendingOffer, attachRemoteStream]
  );

  const handleCall = useCallback(async () => {
    if (!localStreamRef.current) await startLocalStream();

    const targetId = "user_30p94nuw9O2UHOEsXmDhV2SgP8N"; // nastav reálne admin ID
    const newPc = createPeerConnection(localStreamRef.current!, targetId, attachRemoteStream);
    setPc(newPc);

    const offer = await newPc.createOffer();
    await newPc.setLocalDescription(offer);

    sendWS({ type: "call-request", targetId, callerName: user?.fullName || "Neznámy" });
    sendWS({ type: "webrtc-offer", targetId, offer, callerId: user?.id });
  }, [startLocalStream, user, attachRemoteStream]);

  useEffect(() => {
    if (isSignedIn && user) {
      const role = (user.publicMetadata.role as string) || "client";

      connectWS(user.id, role, async (msg) => {
        if (msg.type === "incoming-call") {
          setIncomingCall({ from: msg.callerId as string, callerName: msg.callerName as string });
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
          console.log("📩 Dostali sme webrtc-answer:", msg);

          if (!localStreamRef.current) {
            await startLocalStream();
          }

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
    }
  }, [isSignedIn, user, pc, startLocalStream, attachRemoteStream]);

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
              </div>

              {!hasNotifications && (
                <button
                  className="px-4 py-2 rounded-xl bg-emerald-600 text-white shadow hover:bg-emerald-700 transition"
                  onClick={handleEnableNotifications}
                >
                  Povoliť notifikácie
                </button>
              )}
            </div>
          </section>

          <section className="rounded-2xl bg-white/80 backdrop-blur shadow-sm border border-stone-200 p-6">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex-1">
                <h2 className="text-lg font-semibold mb-1">Stav hovoru</h2>
                <p className="text-stone-600 text-sm">
                  {incomingCall
                    ? `Prichádzajúci hovor od: ${incomingCall.callerName}`
                    : "Pripravený na hovor"}
                </p>
              </div>

              {user?.publicMetadata.role === "client" && (
                <button
                  className="px-5 py-3 rounded-xl bg-emerald-600 text-white font-medium shadow hover:bg-emerald-700 transition"
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
              <button
                className="px-4 py-2 rounded-xl bg-emerald-600 text-white shadow hover:bg-emerald-700 transition"
                onClick={toggleMute}
              >
                {isMuted ? "Unmute" : "Mute"}
              </button>
            </div>

            {/* 🔈 vzdialený audio stream */}
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
