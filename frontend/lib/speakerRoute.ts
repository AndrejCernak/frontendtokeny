import { registerPlugin, Capacitor } from "@capacitor/core";

type AudioRoutePlugin = {
  setRoute(options: { route: "speaker" | "earpiece" }): Promise<{ ok: boolean }>;
  enableProximity(options: { enable: boolean }): Promise<{ ok: boolean; enabled: boolean }>;
};

const AudioRoute = registerPlugin<AudioRoutePlugin>("AudioRoute");

export async function setAudioRoute(route: "speaker" | "earpiece") {
  if (!Capacitor.isNativePlatform()) return { ok: false as const };
  return AudioRoute.setRoute({ route });
}

export async function enableProximity(enable: boolean) {
  if (!Capacitor.isNativePlatform()) return { ok: false as const, enabled: false };
  return AudioRoute.enableProximity({ enable });
}

// voliteľné – info helper
export function getCapInfo() {
  return {
    isNative: Capacitor.isNativePlatform(),
    platform: (window as any).Capacitor?.getPlatform?.(),
  };
}
