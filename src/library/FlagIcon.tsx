import React from "react";

/**
 * Minimal country flags, drawn inline so they render identically everywhere — flag emoji
 * have no glyph in most Linux font stacks and would fall back to letter pairs.
 */
const FLAGS: Record<string, React.ReactElement> = {
    fr: (
        <>
            <rect width="9" height="18" fill="#0055a4" />
            <rect x="9" width="9" height="18" fill="#fff" />
            <rect x="18" width="9" height="18" fill="#ef4135" />
        </>
    ),
    gb: (
        <>
            <rect width="27" height="18" fill="#012169" />
            <path d="M0 0l27 18M27 0L0 18" stroke="#fff" strokeWidth="3.6" />
            <path d="M0 0l27 18M27 0L0 18" stroke="#c8102e" strokeWidth="2.2" />
            <path d="M13.5 0v18M0 9h27" stroke="#fff" strokeWidth="6" />
            <path d="M13.5 0v18M0 9h27" stroke="#c8102e" strokeWidth="3.6" />
        </>
    ),
};

export default function FlagIcon({
    country,
    className,
    title,
}: {
    country: string;
    className?: string;
    title?: string;
}): React.ReactElement | null {
    const shape = FLAGS[country.toLowerCase()];
    if (!shape) return null;
    // Without a title the flag is decorative — next to a visible label it would otherwise
    // duplicate it in the accessible name.
    if (!title) {
        return (
            <svg className={className} viewBox="0 0 27 18" aria-hidden focusable="false">
                {shape}
            </svg>
        );
    }
    return (
        <svg className={className} viewBox="0 0 27 18" role="img" aria-label={title}>
            {shape}
        </svg>
    );
}
