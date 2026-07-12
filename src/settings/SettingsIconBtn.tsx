import React from "react";
import type { LucideIcon } from "lucide-react";
import { IconButton } from "../ui/IconButton";

export function downloadBlob(data: BlobPart, filename: string, type = "application/octet-stream"): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

export function SettingsIconBtn({
  icon: Icon,
  title,
  danger = false,
  disabled = false,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <IconButton
      size="sm"
      danger={danger}
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={16} strokeWidth={1.8} aria-hidden />
    </IconButton>
  );
}
