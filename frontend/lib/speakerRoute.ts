// lib/speakerRoute.ts
import { Capacitor, registerPlugin } from "@capacitor/core";

type Route = "speaker" | "earpiece";
type Result<T> = { ok: true; data: T } | { ok: false; error: string };

type SpeakerRoutePlugin = {
  setAudioRoute(options: { route: Route }): Promise<{ success: boolean; route?: Route }>;
  enableProximity(options: { enabled: boolean }): Promise<{ success: boolean; enabled: boolean }>;
};

// Pozn.: registerPlugin existuje aj na webe, ale volanie metód v browsri vyhodí „plugin not implemented“.
// Preto si to ošetríme.
const Native = Capacitor.isNativePlatform()
  ? registerPlugin<SpeakerRoutePlugin>("SpeakerRoute")
  : null;

export async function setAudioRoute(route: Route): Promise<Result<{ route?: Route }>> {
  try {
    if (!Capacitor.isNativePlatform()) {
      return { ok: false, error: "Not running in native app (web/PWA)" };
    }
    if (!Native) {
      return { ok: false, error: "Plugin object missing" };
    }
    const res = await Native.setAudioRoute({ route });
    return res?.success ? { ok: true, data: { route: res.route } } : { ok: false, error: "Native returned success=false" };
  } catch (e: any) {
    // typická hláška: "plugin not implemented"
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function enableProximity(enabled: boolean): Promise<Result<{ enabled: boolean }>> {
  try {
    if (!Capacitor.isNativePlatform()) {
      return { ok: false, error: "Not running in native app (web/PWA)" };
    }
    if (!Native) {
      return { ok: false, error: "Plugin object missing" };
    }
    const res = await Native.enableProximity({ enabled });
    return res?.success ? { ok: true, data: { enabled: !!res.enabled } } : { ok: false, error: "Native returned success=false" };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export function getCapInfo() {
  return {
    isNative: Capacitor.isNativePlatform(),
    platform: Capacitor.getPlatform?.() || "unknown",
  };
}
