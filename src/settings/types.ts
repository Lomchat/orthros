import type { QualityConfig } from "../worker/core/quality-config";
import type { UiSettings } from "../ui-settings";

export interface SettingsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  quality: QualityConfig;
  onChange: (patch: Partial<QualityConfig>) => void;
  uiSettings: UiSettings;
  onUiChange: (patch: Partial<UiSettings>) => void;
  statsOverlay: boolean;
  onToggleStatsOverlay: (enabled: boolean) => void;
  logStreaming: boolean;
  onToggleLogStreaming: (enabled: boolean) => void;
  onResetDefaults: () => void;
  guestResolution: { width: number; height: number };
  integerScale: number;
  onOpenDevConsole?: () => void;
}

export type SettingsSectionId = "graphics" | "audio" | "input" | "storage" | "advanced" | "about";
