// Host-side UI / presentation preferences. Shared by App.tsx (owns the state + effects
// that apply them) and SettingsDrawer.tsx (renders the controls). These are the *real*,
// wired settings — distinct from the per-game manifest and from QualityConfig (the
// HLE→WebGPU quality knobs, persisted separately under its own key).

export type MouseCoordinateMode = "guest" | "render";
export type FullscreenAspectPreset = "4:3" | "16:9" | "16:10";
export type CanvasFilteringMode = "smooth" | "pixelated";

// Display pacing policy for sub-refresh guests (D2 ~25 fps on a 60 Hz screen).
//   off    — present ASAP (lowest latency; default).
//   vsync  — pin each present to a vsync edge (experimental; the browser compositor
//            already vsync-aligns, so this rarely helps and can add jitter).
//   smooth — hold each present a steady integer #vsyncs (flat cadence, caps at a divisor rate).
//   blend  — phase-blend the two newest frames at full refresh (smoothest; ~1 frame latency).
export type PresentMode = "off" | "vsync" | "smooth" | "blend";
export const PRESENT_MODES: PresentMode[] = ["off", "vsync", "smooth", "blend"];

export type UiSettings = {
  lockFullscreenAspect: boolean;
  fullscreenAspectPreset: FullscreenAspectPreset;
  integerScaling: boolean;
  canvasFiltering: CanvasFilteringMode;
  mouseCoordinateMode: MouseCoordinateMode;
  presentMode: PresentMode;
  /** Master output volume, linear 0..1 (applied at the AudioEngine master gain). */
  masterVolume: number;
  /** Mute master output (independent of volume so the slider position is retained). */
  muted: boolean;
};

export const UI_SETTINGS_STORAGE_KEY = "bottleship_ui_settings_v1";

export const DEFAULT_UI_SETTINGS: UiSettings = {
  lockFullscreenAspect: true,
  fullscreenAspectPreset: "4:3",
  integerScaling: false,
  canvasFiltering: "smooth",
  mouseCoordinateMode: "guest",
  presentMode: "off",
  masterVolume: 1,
  muted: false,
};

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1);

export function loadUiSettings(): UiSettings {
  if (typeof window === "undefined") return DEFAULT_UI_SETTINGS;

  try {
    const raw = localStorage.getItem(UI_SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_UI_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<UiSettings>;

    const lockFullscreenAspect = parsed.lockFullscreenAspect ?? DEFAULT_UI_SETTINGS.lockFullscreenAspect;
    const fullscreenAspectPreset: FullscreenAspectPreset =
      parsed.fullscreenAspectPreset === "16:9" || parsed.fullscreenAspectPreset === "16:10" || parsed.fullscreenAspectPreset === "4:3"
        ? parsed.fullscreenAspectPreset
        : DEFAULT_UI_SETTINGS.fullscreenAspectPreset;
    const integerScaling = parsed.integerScaling ?? DEFAULT_UI_SETTINGS.integerScaling;
    const canvasFiltering: CanvasFilteringMode =
      parsed.canvasFiltering === "pixelated" || parsed.canvasFiltering === "smooth"
        ? parsed.canvasFiltering
        : DEFAULT_UI_SETTINGS.canvasFiltering;
    const mouseCoordinateMode: MouseCoordinateMode =
      parsed.mouseCoordinateMode === "render" || parsed.mouseCoordinateMode === "guest"
        ? parsed.mouseCoordinateMode
        : DEFAULT_UI_SETTINGS.mouseCoordinateMode;
    const presentMode: PresentMode =
      parsed.presentMode && PRESENT_MODES.includes(parsed.presentMode)
        ? parsed.presentMode
        : DEFAULT_UI_SETTINGS.presentMode;
    const masterVolume = typeof parsed.masterVolume === "number" ? clamp01(parsed.masterVolume) : DEFAULT_UI_SETTINGS.masterVolume;
    const muted = parsed.muted ?? DEFAULT_UI_SETTINGS.muted;

    return {
      lockFullscreenAspect,
      fullscreenAspectPreset,
      integerScaling,
      canvasFiltering,
      mouseCoordinateMode,
      presentMode,
      masterVolume,
      muted,
    };
  } catch {
    return DEFAULT_UI_SETTINGS;
  }
}
