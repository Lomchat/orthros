import React from "react";
import ms from "../ui/Modal/Modal.module.css";
import bm from "../ui/Button/Button.module.css";
import s from "./GameSettingsModal.module.css";
import FlagIcon from "./FlagIcon";
import {
    RESOLUTION_CHOICES,
    resolveLanguage,
    type GameLanguage,
    type GameProfile,
} from "../game-profile";

interface Props {
    isOpen: boolean;
    title: string;
    languages?: readonly GameLanguage[];
    defaultLanguage?: string;
    /** Bundle defaults, shown as the "as shipped" option. */
    bundleResolution?: { width: number; height: number };
    profile: GameProfile;
    onApply: (profile: GameProfile) => void;
    onClose: () => void;
}

export default function GameSettingsModal({
    isOpen,
    title,
    languages,
    defaultLanguage,
    bundleResolution,
    profile,
    onApply,
    onClose,
}: Props): React.ReactElement | null {
    const [draft, setDraft] = React.useState<GameProfile>(profile);

    // Reopening after a change elsewhere should show the stored values, not a stale draft.
    React.useEffect(() => {
        if (isOpen) setDraft(profile);
    }, [isOpen, profile]);

    if (!isOpen) return null;

    const language = resolveLanguage(languages, draft, defaultLanguage);
    const resolution =
        draft.width && draft.height
            ? `${draft.width}x${draft.height}`
            : bundleResolution
              ? `${bundleResolution.width}x${bundleResolution.height}`
              : "";

    return (
        <div className={ms["modal-overlay"]} onClick={onClose}>
            <div className={`${ms["modal-content"]} ${s["gs"]}`} onClick={(e) => e.stopPropagation()}>
                <div className={ms["modal-header"]}>
                    <h2>{title}</h2>
                    <button className={ms["modal-close"]} onClick={onClose}>×</button>
                </div>
                <div className={ms["modal-body"]}>
                    {languages && languages.length > 1 ? (
                        <section className={s["gs__row"]}>
                            <div className={s["gs__label"]}>
                                Language
                                <span className={s["gs__hint"]}>
                                    Each language is its own install, with its own saves.
                                </span>
                            </div>
                            <div className={s["gs__langs"]}>
                                {languages.map((l) => (
                                    <button
                                        key={l.code}
                                        className={`${s["gs__lang"]}${language?.code === l.code ? ` ${s["is-active"]}` : ""}`}
                                        onClick={() => setDraft((d) => ({ ...d, language: l.code }))}
                                    >
                                        <FlagIcon country={l.flag} className={s["gs__flag"]} />
                                        {l.label}
                                    </button>
                                ))}
                            </div>
                        </section>
                    ) : null}

                    <section className={s["gs__row"]}>
                        <div className={s["gs__label"]}>
                            Resolution
                            <span className={s["gs__hint"]}>
                                The game was designed for 4:3. Higher costs little on the GPU.
                            </span>
                        </div>
                        <select
                            className={s["gs__select"]}
                            value={resolution}
                            onChange={(e) => {
                                const [w, h] = e.target.value.split("x").map(Number);
                                setDraft((d) => ({ ...d, width: w, height: h }));
                            }}
                        >
                            {RESOLUTION_CHOICES.map((r) => (
                                <option key={r.label} value={`${r.width}x${r.height}`}>
                                    {r.label}
                                </option>
                            ))}
                        </select>
                    </section>

                    <section className={s["gs__row"]}>
                        <div className={s["gs__label"]}>
                            Intro videos
                            <span className={s["gs__hint"]}>
                                Campaign and tutorial cutscenes. Skipping them shortens startup.
                            </span>
                        </div>
                        <select
                            className={s["gs__select"]}
                            value={draft.skipVideo === false ? "play" : "skip"}
                            onChange={(e) => setDraft((d) => ({ ...d, skipVideo: e.target.value === "skip" }))}
                        >
                            <option value="skip">Skip</option>
                            <option value="play">Play</option>
                        </select>
                    </section>

                    <div className={s["gs__actions"]}>
                        <button className={`${bm["btn"]}`} onClick={onClose}>Cancel</button>
                        <button
                            className={`${bm["btn"]} ${bm["btn--primary"]}`}
                            onClick={() => {
                                onApply(draft);
                                onClose();
                            }}
                        >
                            Save
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
