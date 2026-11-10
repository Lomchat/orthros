// The display modes the machine reports: one list for every API that enumerates them (EnumDisplaySettings,
// DirectDraw EnumDisplayModes, IDirect3D8/9 GetAdapterModeCount/EnumAdapterModes). It is what a Windows PC with a normal
// monitor lists: the common 4:3, 5:4, 16:10 and 16:9 modes up to the player's screen, always including the mode in
// use and the game's own display (the manifest's), in ascending order.

/** Modes a Windows graphics driver lists for a monitor (the monitor's native size caps them). */
export const COMMON_MODES = [[640, 480], [800, 600], [1024, 768], [1152, 864], [1280, 720], [1280, 768], [1280, 800], [1280, 960], [1280, 1024], [1360, 768], [1366, 768], [1400, 1050], [1440, 900], [1600, 900], [1600, 1200], [1680, 1050], [1920, 1080], [1920, 1200], [2560, 1440], [2560, 1600], [3840, 2160]];

/**
 * @param {{ width: number, height: number, nominal?: number[], screenSize?: number[] | null }} d the host display: its
 *   current mode, the game's display from the manifest, the player's screen in pixels (unknown: up to 1920x1200)
 * @returns {number[][]} [width, height] pairs, ascending, no duplicates
 */
export function displayModes(d) {
  const [sw, sh] = d?.screenSize ?? [1920, 1200];
  const list = COMMON_MODES.filter(([w, h]) => w <= sw && h <= sh);
  for (const m of [d?.nominal, d && [d.width, d.height]]) if (m && m[0] > 0 && m[1] > 0 && !list.some(([w, h]) => w === m[0] && h === m[1])) list.push([m[0], m[1]]);
  return list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
