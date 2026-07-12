import React from "react";
import type { SettingsDrawerProps } from "./types";
import { SettingsRow, SettingsSection, Toggle } from "./SettingsRow";
import rs from "../ui/Row/Row.module.css";

export default function SettingsAudioSection({ uiSettings, onUiChange }: SettingsDrawerProps): React.ReactElement {
  const pct = Math.round(uiSettings.masterVolume * 100);
  return (
    <SettingsSection>
      <SettingsRow title="Master volume" hint="Overall output level for every game sound.">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          <input
            type="range"
            className={rs["range"]}
            min={0}
            max={100}
            value={pct}
            disabled={uiSettings.muted}
            onChange={(e) => onUiChange({ masterVolume: Number(e.target.value) / 100 })}
          />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)", width: 38, textAlign: "right" }}>
            {uiSettings.muted ? "—" : `${pct}%`}
          </span>
        </span>
      </SettingsRow>
      <SettingsRow title="Mute" hint="Silence all output without losing the volume level.">
        <Toggle checked={uiSettings.muted} onChange={(v) => onUiChange({ muted: v })} />
      </SettingsRow>
    </SettingsSection>
  );
}
