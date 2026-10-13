/** Optional browser ports share the home screen, but execute in their own pages. */
export async function loadBrowserPorts(fetcher = fetch) {
  try {
    const response = await fetcher('/ports/api/manifests', { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return [];
    const items = await response.json();
    if (!Array.isArray(items)) return [];
    return items.filter(item => typeof item.name === 'string' && item.name.startsWith('port-') &&
      typeof item.gameId === 'string' && typeof item.title === 'string' &&
      typeof item.launchUrl === 'string' && /^\/ports\/[a-z0-9._-]+\/[a-z0-9._-]+\/[a-z0-9._-]+\/$/.test(item.launchUrl));
  } catch { return []; } // The original Windows library remains usable when the port service is offline.
}
