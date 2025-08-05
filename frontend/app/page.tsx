"use client";

import { useUser, SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
import { useEffect, useRef, useState } from "react";
import { requestFcmToken } from "@/lib/firebase";
import { connectWS, sendWS } from "@/lib/wsClient";
import { createPeerConnection } from "@/lib/webrtc";

export default function HomePage() {
  const { user, isSignedIn } = useUser();
  const [incomingCall, setIncomingCall] = useState<{ from: string; callerName: string } | null>(null);
  const [pc, setPc] = useState<RTCPeerConnection | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (isSignedIn && user) {
      const role = (user.publicMetadata.role as string) || "client";

      connectWS(user.id, role, async (msg) => {
        if (msg.type === "incoming-call") {
          setIncomingCall({ from: msg.from, callerName: msg.callerName });
        }
        if (msg.type === "webrtc-offer") {
          await handleOffer(msg.offer, msg.from);
        }
        if (msg.type === "webrtc-answer") {
          await pc?.setRemoteDescription(new RTCSessionDescription(msg.answer));
        }
        if (msg.type === "webrtc-candidate") {
          await pc?.addIceCandidate(new RTCIceCandidate(msg.candidate));
        }
      });

      requestFcmToken().then(token => {
        if (token) {
          fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/register-fcm`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: user.id, fcmToken: token, role }),
          });
        }
      });
    }
  }, [isSignedIn, user]);

  const startLocalStream = async () => {
    localStreamRef.current = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    if (localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
      await localVideoRef.current.play();
    }
  };

  const handleCall = async () => {
    if (!localStreamRef.current) await startLocalStream();

    const targetId = "ADMIN_USER_ID"; // nastav reálne admin ID
    const newPc = createPeerConnection(localStreamRef.current!, targetId, (stream) => {
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = stream;
        remoteVideoRef.current.play();
      }
    });

    setPc(newPc);

    const offer = await newPc.createOffer();
    await newPc.setLocalDescription(offer);

    sendWS({ type: "call-request", targetId, callerName: user?.fullName || "Neznámy" });
    sendWS({ type: "webrtc-offer", targetId, offer });
  };

  const handleAccept = async () => {
    if (!localStreamRef.current) await startLocalStream();

    const newPc = createPeerConnection(localStreamRef.current!, incomingCall!.from, (stream) => {
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = stream;
        remoteVideoRef.current.play();
      }
    });

    setPc(newPc);
  };

  const handleOffer = async (offer: RTCSessionDescriptionInit, from: string) => {
    await handleAccept();
    await pc?.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc?.createAnswer();
    await pc?.setLocalDescription(answer!);
    sendWS({ type: "webrtc-answer", targetId: from, answer });
  };

  return (
    <main className="p-4">
      <SignedOut>
        <SignInButton />
      </SignedOut>
      <SignedIn>
        <UserButton />
        <h1>Hello {user?.firstName}</h1>

        <video ref={localVideoRef} autoPlay playsInline muted className="w-1/2 border" />
        <video ref={remoteVideoRef} autoPlay playsInline className="w-1/2 border" />

        {user?.publicMetadata.role === "client" && (
          <button className="bg-green-500 text-white px-4 py-2 rounded" onClick={handleCall}>
            Zavolať
          </button>
        )}

        {user?.publicMetadata.role === "admin" && incomingCall && (
          <div className="bg-yellow-200 p-4 rounded mt-4">
            📞 Volá ti: {incomingCall.callerName}
            <button className="bg-blue-500 text-white px-4 py-2 rounded ml-2" onClick={handleAccept}>
              Prijať
            </button>
          </div>
        )}
      </SignedIn>
    </main>
  );
}
