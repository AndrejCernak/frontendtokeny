import { registerPlugin } from "@capacitor/core";

type SpeakerRoutePlugin = {
  setAudioRoute(options: { route: "earpiece" | "speaker" }): Promise<{ success: boolean; route: string }>;
  enableProximity(options: { enabled: boolean }): Promise<{ success: boolean; enabled: boolean }>;
};

const plugin = registerPlugin<SpeakerRoutePlugin>("SpeakerRoute");

export async function setAudioRoute(route: "earpiece" | "speaker") {
  console.log("[FE] Calling setAudioRoute", route);
  try {
    const res = await plugin.setAudioRoute({ route });
    console.log("[FE] setAudioRoute result", res);
    return res;
  } catch (err) {
    console.error("[FE] setAudioRoute ERROR", err);
  }
}

export async function enableProximity(enabled: boolean) {
  console.log("[FE] Calling enableProximity", enabled);
  try {
    const res = await plugin.enableProximity({ enabled });
    console.log("[FE] enableProximity result", res);
    return res;
  } catch (err) {
    console.error("[FE] enableProximity ERROR", err);
  }
}
