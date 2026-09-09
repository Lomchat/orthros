import { describe, expect, test } from 'bun:test';

describe('Roi-Sorcier base-game layer', () => {
    test('mounts the base-game executable contract as a separate installation', async () => {
        const catalog = await Bun.file(new URL('../../public/games-catalog.json', import.meta.url)).json();
        const rotwk = catalog.find((game: { id?: string }) => game.id === 'rotwk');

        // The base maps are part of the contract: the expansion enumerates the
        // base game's campaign and living-world maps through the homonymous
        // maps.big fallback and quits without a frame when they are absent.
        expect(rotwk?.romDependencies).toEqual([{
            url: '/apps/bfme2-109-multi.wgb',
            include: ['lotrbfme2.exe', 'lotrbfme2.lcf', 'game.dat', 'eauninstall.exe', 'filelist.txt', 'window.big', 'maps.big', '_wsmaps.big', 'bases.big', 'shaders.big'],
            mountPrefix: 'BFME2',
        }]);
    });
});
