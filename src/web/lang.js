// The page's language, shared by the home screen and the data window: the visitor's choice (flags, ?lang=), else the
// first language of the browser's list that the page speaks, else English.
export const UI_LANGS = ['fr', 'en'];
export const baseLang = (l) => String(l ?? '').toLowerCase().split(/[-_]/)[0];
/** The browser's languages, preferred first ('fr-CA' → 'fr'). */
export const browserLangs = () => (navigator.languages?.length ? [...navigator.languages] : [navigator.language]).map(baseLang).filter(Boolean);
/** The page language chosen by the visitor (?lang= or the flags, remembered), or null while nothing was chosen. */
export function explicitLang() {
  let saved = null; try { saved = localStorage.getItem('orthros.lang'); } catch { /* no storage */ }
  const l = baseLang(new URLSearchParams(location.search).get('lang') ?? saved);
  return UI_LANGS.includes(l) ? l : null;
}
export const pickLang = () => explicitLang() ?? browserLangs().find((l) => UI_LANGS.includes(l)) ?? 'en';
/** A language's name in that language ('fr' → 'Français'). */
export function endonym(code) {
  try { const n = new Intl.DisplayNames([code], { type: 'language' }).of(code); return n.charAt(0).toLocaleUpperCase(code) + n.slice(1); } catch { return code.toUpperCase(); }
}
