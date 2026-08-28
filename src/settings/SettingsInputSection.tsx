import React from "react";
import type { UiSettings } from "../ui-settings";
import type { SettingsDrawerProps } from "./types";
import GamepadSandbox from "./GamepadSandbox";
import { SettingsRow, SettingsSection } from "./SettingsRow";
import { SectionHeading, Hint } from "../ui";

export default function SettingsInputSection({
  uiSettings,
  onUiChange,
  active = false,
}: SettingsDrawerProps & { active?: boolean }): React.ReactElement {
  return (
    <SettingsSection>
      <SectionHeading>Mouse</SectionHeading>
      <SettingsRow
        title="Mouse coordinates"
        hint="How cursor positions are mapped into the guest. Guest resolution is correct for almost everything; render-target is a legacy fallback for games that misbehave."
      >
        <select
          style={{ width: 220, padding: 8 }}
          value={uiSettings.mouseCoordinateMode}
          onChange={(e) => onUiChange({ mouseCoordinateMode: e.target.value as UiSettings["mouseCoordinateMode"] })}
        >
          <option value="guest">Guest resolution (recommended)</option>
          <option value="render">Render target (legacy)</option>
        </select>
      </SettingsRow>
      <Hint style={{ marginTop: 4, marginBottom: 8 }}>
        Relative-look games capture the pointer when you click the canvas. In fullscreen,
        BFME sends the first <code>Esc</code> to the game and a quick second press releases
        the pointer; outside fullscreen, the browser releases it on the first press.
      </Hint>

      <SectionHeading style={{ marginTop: 12 }}>
        Gamepad
      </SectionHeading>
      <GamepadSandbox active={active} />
    </SettingsSection>
  );
}
