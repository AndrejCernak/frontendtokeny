// lib/speakerRoute.ts
import { registerPlugin, Capacitor } from '@capacitor/core';

export interface SpeakerRoutePlugin {
  setAudioRoute(options: { route: 'speaker' | 'earpiece' }): Promise<{
    success: boolean;
    route: string;
  }>;

  enableProximity(options: { enabled: boolean }): Promise<{
    success: boolean;
    enabled: boolean;
  }>;

  ping(): Promise<{ success: boolean }>;
}

// plugin registrácia
export const SpeakerRoute = registerPlugin<SpeakerRoutePlugin>('SpeakerRoute');

// helper funkcie ak chceš volať jednoducho
export async function setAudioRoute(route: 'speaker' | 'earpiece') {
  if (!Capacitor.isNativePlatform()) {
    console.warn('[SpeakerRoute] Not native, skipping setAudioRoute');
    return { success: false, route };
  }
  return SpeakerRoute.setAudioRoute({ route });
}

export async function enableProximity(enabled: boolean) {
  if (!Capacitor.isNativePlatform()) {
    console.warn('[SpeakerRoute] Not native, skipping enableProximity');
    return { success: false, enabled };
  }
  return SpeakerRoute.enableProximity({ enabled });
}

export async function ping() {
  if (!Capacitor.isNativePlatform()) {
    console.warn('[SpeakerRoute] Not native, skipping ping');
    return { success: false };
  }
  return SpeakerRoute.ping();
}
