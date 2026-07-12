import React from "react";
import { SettingsSection } from "./SettingsRow";
import StorageManagerBody from "../storage/StorageManagerBody";

export default function SettingsStorageSection({ active }: { active: boolean }): React.ReactElement {
  return (
    <SettingsSection>
      <StorageManagerBody active={active} />
    </SettingsSection>
  );
}
