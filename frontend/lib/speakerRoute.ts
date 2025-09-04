import { registerPlugin, Capacitor } from '@capacitor/core';

type AudioRoutePlugin = {
  setRoute(options: { route: 'speaker' | 'earpiece' }): Promise<{ ok: boolean }>;
  enableProximity(options: { enable: boolean }): Promise<{ ok: boolean; enabled: boolean }>;
};

// registrácia pluginu
const AudioRoute = registerPlugin<AudioRoutePlugin>('AudioRoute');

// sprístupnenie do Safari konzoly (Develop → iPhone → App)
if (typeof window !== 'undefined') {
  (window as any).AudioRoute = AudioRoute;
}

const isIOS = Capacitor.getPlatform?.() === 'ios';

// helper na prepnutie audio routingu
export async function setAudioRoute(route: 'speaker' | 'earpiece') {
  if (!isIOS) return { ok: false as const };
  return AudioRoute.setRoute({ route });
}

// helper na zapnutie / vypnutie proximity senzora
export async function enableProximity(enable: boolean) {
  if (!isIOS) return { ok: false as const, enabled: false };
  return AudioRoute.enableProximity({ enable });
}

// helper na debug info
export function getCapInfo() {
  return {
    isNative: Capacitor.isNativePlatform?.(),
    platform: Capacitor.getPlatform?.(),
  };
}

// voliteľný export pre použitie priamo
export { AudioRoute };
