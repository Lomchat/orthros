import React from "react";
import { RotateCcw } from "lucide-react";
import type { SettingsDrawerProps } from "./types";
import { SettingsRow, SettingsSection, Toggle } from "./SettingsRow";
import { Button } from "../ui";

export default function SettingsAdvancedSection({
  onOpenDevConsole,
  statsOverlay,
  onToggleStatsOverlay,
  logStreaming,
  onToggleLogStreaming,
  onResetDefaults,
}: SettingsDrawerProps): React.ReactElement {
  return (
    <SettingsSection>
      <SettingsRow
        title="Developer console"
        hint={
          <>
            Bare emulator + <code>window.loadApp()</code> / <code>window.dbg</code>.
          </>
        }
      >
        <Button onClick={() => onOpenDevConsole?.()}>
          Open ›
        </Button>
      </SettingsRow>
      <SettingsRow title="FPS / stats overlay" hint="Draw the live frame-rate and timing overlay on the canvas.">
        <Toggle checked={statsOverlay} onChange={onToggleStatsOverlay} />
      </SettingsRow>
      <SettingsRow title="Worker log streaming" hint="Stream worker logs to the dev log server (:3001). Off by default.">
        <Toggle checked={logStreaming} onChange={onToggleLogStreaming} />
      </SettingsRow>
      <SettingsRow title="Reset settings" hint="Restore all display, audio, input and quality settings to defaults.">
        <Button
          variant="danger"
          onClick={() => {
            if (confirm("Reset all settings to their defaults?")) onResetDefaults();
          }}
        >
          <RotateCcw size={14} strokeWidth={1.8} aria-hidden style={{ marginRight: 6, verticalAlign: "-2px" }} />
          Reset
        </Button>
      </SettingsRow>
    </SettingsSection>
  );
}
