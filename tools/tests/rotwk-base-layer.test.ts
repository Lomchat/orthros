import { describe, expect, test } from 'bun:test';

describe('Roi-Sorcier base-game layer', () => {
    test('mounts the base-game executable contract as a separate installation', async () => {
        const catalog = await Bun.file(new URL('../../public/games-catalog.json', import.meta.url)).json();
        const rotwk = catalog.find((game: { id?: string }) => game.id === 'rotwk');

        // A real installation shows the expansion the whole base directory: it
        // reads the base game's maps, AI bases, shaders and more through the
        // homonymous-archive fallback. Only the base INI archives stay out —
        // their definitions conflict with the expansion's own (the patch
        // archives #bt2dc… carry INI too).
        expect(rotwk?.romDependencies).toEqual([{
            url: '/apps/bfme2-109-multi.wgb',
            include: ['**'],
            exclude: ['ini.big', '#*.big', '##*.big', '###*.big'],
            mountPrefix: 'BFME2',
        }]);
    });
});
