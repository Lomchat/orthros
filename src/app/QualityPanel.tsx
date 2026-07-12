import React from "react";
import type { QualityConfig } from "../worker/core/quality-config";
import s from "./QualityPanel.module.css";

type QualityPanelProps = {
  quality: QualityConfig;
  onChange: (patch: Partial<QualityConfig>) => void;
};

const ANISO_OPTIONS = [1, 2, 4, 8, 16] as const;
const SAMPLE_OPTIONS = [1, 2, 4] as const;

function SliderRow(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}): React.ReactElement {
  const { label, value, min, max, step, onChange } = props;
  return (
    <label className={s["settings-row"]}>
      <span>{label}</span>
      <span className={s["quality-slider"]}>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className={s["quality-slider__value"]}>{value.toFixed(2)}</span>
      </span>
    </label>
  );
}

export default function QualityPanel({ quality, onChange }: QualityPanelProps): React.ReactElement {
  return (
    <div>
      {/* --- Filtering --- */}
      <h3 className={s["settings-subhead"]}>Filtering</h3>
      <div className={s["settings-grid"]}>
        <label className={s["settings-row"]}>
          <span>Anisotropic filtering</span>
          <select
            value={quality.anisotropy}
            onChange={(e) => onChange({ anisotropy: Number(e.target.value) })}
          >
            {ANISO_OPTIONS.map((a) => (
              <option key={a} value={a}>{a === 1 ? "Off" : `${a}×`}</option>
            ))}
          </select>
        </label>
        <label className={s["settings-row"]}>
          <span>Force trilinear</span>
          <input
            type="checkbox"
            checked={quality.forceTrilinear}
            onChange={(e) => onChange({ forceTrilinear: e.target.checked })}
          />
        </label>
      </div>

      {/* --- Color --- */}
      <h3 className={s["settings-subhead"]}>Color</h3>
      <div className={s["settings-grid"]}>
        <SliderRow label="Brightness" value={quality.brightness} min={0} max={4} step={0.05}
          onChange={(v) => onChange({ brightness: v })} />
        <SliderRow label="Contrast" value={quality.contrast} min={0} max={4} step={0.05}
          onChange={(v) => onChange({ contrast: v })} />
        <SliderRow label="Saturation" value={quality.saturation} min={0} max={4} step={0.05}
          onChange={(v) => onChange({ saturation: v })} />
        <label className={s["settings-row"]}>
          <span>Tonemap</span>
          <select
            value={quality.tonemap}
            onChange={(e) => onChange({ tonemap: e.target.value as QualityConfig["tonemap"] })}
          >
            <option value="off">Off</option>
            <option value="aces">ACES (filmic)</option>
          </select>
        </label>
        <SliderRow label="Vignette" value={quality.vignette} min={0} max={1} step={0.02}
          onChange={(v) => onChange({ vignette: v })} />
        <label className={s["settings-row"]}>
          <span>Post AA</span>
          <select
            value={quality.postAA}
            onChange={(e) => onChange({ postAA: e.target.value as QualityConfig["postAA"] })}
          >
            <option value="off">Off</option>
            <option value="fxaa">FXAA</option>
          </select>
        </label>
      </div>

      {/* --- Display --- */}
      <h3 className={s["settings-subhead"]}>Display</h3>
      <div className={s["settings-grid"]}>
        <label className={s["settings-row"]}>
          <span>Aspect mode</span>
          <select
            value={quality.aspectMode}
            onChange={(e) => onChange({ aspectMode: e.target.value as QualityConfig["aspectMode"] })}
          >
            <option value="stretch">Stretch (fill)</option>
            <option value="pillarbox">Pillarbox (preserve AR)</option>
            <option value="integer">Integer (pixel-perfect)</option>
          </select>
        </label>
        <label className={s["settings-row"]}>
          <span>Integer scaling</span>
          <input
            type="checkbox"
            checked={quality.integerScale}
            onChange={(e) => onChange({ integerScale: e.target.checked })}
          />
        </label>
      </div>

      {/* --- Effects --- */}
      <h3 className={s["settings-subhead"]}>Effects</h3>
      <div className={s["settings-grid"]}>
        <label className={s["settings-row"]}>
          <span>Scanlines</span>
          <input
            type="checkbox"
            checked={quality.scanlines}
            onChange={(e) => onChange({ scanlines: e.target.checked })}
          />
        </label>
        <label className={s["settings-row"]}>
          <span>CRT</span>
          <input
            type="checkbox"
            checked={quality.crt}
            onChange={(e) => onChange({ crt: e.target.checked })}
          />
        </label>
      </div>

      {/* --- Advanced / experimental --- */}
      <h3 className={s["settings-subhead"]}>Advanced / experimental</h3>
      <div className={s["settings-grid"]}>
        <label className={s["settings-row"]}>
          <span>MSAA (experimental)</span>
          <select
            value={quality.msaa}
            onChange={(e) => onChange({ msaa: Number(e.target.value) })}
          >
            {SAMPLE_OPTIONS.map((n) => (
              <option key={n} value={n}>{n === 1 ? "Off" : `${n}×`}</option>
            ))}
          </select>
        </label>
        <label className={s["settings-row"]}>
          <span>Internal scale (experimental)</span>
          <select
            value={quality.internalScale}
            onChange={(e) => onChange({ internalScale: Number(e.target.value) })}
          >
            {SAMPLE_OPTIONS.map((n) => (
              <option key={n} value={n}>{n === 1 ? "Native" : `${n}×`}</option>
            ))}
          </select>
        </label>
        <label className={s["settings-row"]}>
          <span>Auto mipmap (experimental)</span>
          <input
            type="checkbox"
            checked={quality.autoMipmap}
            onChange={(e) => onChange({ autoMipmap: e.target.checked })}
          />
        </label>
      </div>
    </div>
  );
}
