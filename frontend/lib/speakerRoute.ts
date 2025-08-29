import { Capacitor } from "@capacitor/core";

type Route = "earpiece" | "speaker";

/** Prepne zvuk v iOS appke – funguje iba v natívnej iOS Capacitor appke. */
export async function setAudioRoute(route: Route) {
  if (!Capacitor.isNativePlatform()) {
    // bežíš v prehliadači/PWA → nič sa nestane
    return { success: false, webFallback: true };
  }
  // @ts-ignore – vlastný Capacitor plugin
  return await (window as any).Capacitor.Plugins.SpeakerRoute.setRoute({ route });
}

/** Voliteľné: proximity senzor pri uchu (zhasne displej). */
export async function enableProximity(enabled: boolean) {
  if (!Capacitor.isNativePlatform()) return;
  // @ts-ignore
  return await (window as any).Capacitor.Plugins.SpeakerRoute.enableProximity({ enabled });
}
