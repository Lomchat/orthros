import React from "react";
import { ShieldCheck } from "@phosphor-icons/react";
import { SettingsSection } from "./SettingsRow";
import s from "./SettingsAboutSection.module.css";

function BottleMark({ className }: { className?: string }): React.ReactElement {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden>
      <g fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round">
        <path d="M26 6h12v8l4 4v6H22v-6l4-4z" />
        <rect x="14" y="24" width="36" height="34" rx="9" />
        <path d="M20 46c6-3 8-10 14-10s9 6 14 4" strokeOpacity=".5" />
      </g>
      <path d="M30 32l8 5-8 5z" fill="var(--amber)" stroke="none" />
    </svg>
  );
}

export default function SettingsAboutSection(): React.ReactElement {
  return (
    <SettingsSection>
      <div className={s["about"]}>
        <BottleMark className={s["about__bottle"]} />
        <div className={s["about__title"]}>
          Bottle<b>Ship</b>
        </div>
        <div className={s["about__lede"]}>
          Run the Windows games of 1996–2004 in your browser — no install, no VM, no upload.
        </div>
        <p className={s["about__story"]}>
          A ship in a bottle is preserved exactly as it sailed, sealed in glass. BottleShip keeps each
          game the same way: its files, its registry, its Windows — a self-contained <b>.wgb</b> package.
          The x86 runs under HLE in a Web Worker; legacy DirectDraw/Direct3D is translated live to
          WebGPU; storage is a copy-on-write OPFS filesystem so the original is never touched.
        </p>
        <div className={s["badges"]}>
          <span className={s["tech"]}>x86 HLE / v86</span>
          <span className={s["tech"]}>WebAssembly</span>
          <span className={s["tech"]}>WebGPU · WGSL</span>
          <span className={s["tech"]}>AudioWorklet</span>
          <span className={s["tech"]}>OPFS · CoW</span>
        </div>
        <div className={s["about__priv"]}>
          <ShieldCheck size={14} aria-hidden />
          Local only — your games never leave this machine.
        </div>
        <div className={s["about__ver"]}>v0.9.0 · build feat/per-game-containers-vfs · MIT</div>
      </div>
    </SettingsSection>
  );
}
