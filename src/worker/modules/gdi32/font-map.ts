/**
 * Windows → bundled-font name mapping for GDI text rendering. Maps common
 * Windows face names games request to the metric-compatible Liberation fonts
 * we ship (WINDOWS_FONT_MAP).
 */

const WINDOWS_FONT_MAP: Readonly<Record<string, string>> = {
    'arial':                'Liberation Sans',
    'helvetica':            'Liberation Sans',
    'ms sans serif':        'Liberation Sans',
    'microsoft sans serif': 'Liberation Sans',
    'tahoma':               'Liberation Sans',
    'verdana':              'Liberation Sans',
    'courier new':          'Liberation Mono',
    'courier':              'Liberation Mono',
    'times new roman':      'Liberation Serif',
    'times':                'Liberation Serif',
    'comic sans ms':        'Liberation Sans',
    'impact':               'Liberation Sans',
};

/** Map a requested Windows face name to a bundled font; unknown names pass through. */
export function resolveWindowsFontName(faceName: string): string {
    if (!faceName) return 'Liberation Sans';
    const mapped = WINDOWS_FONT_MAP[faceName.toLowerCase()];
    return mapped ?? faceName;
}
