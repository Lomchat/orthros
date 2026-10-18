#!/usr/bin/env python3
"""The engine menu's banner titles (gfx/shell/head_*.tga: glowing orange words, drawn additively over the menu) in
another language — Orthros' own pictures, in the style of the engine release's English ones (460 x 80, black is
transparent once added). Usage: python3 -I banners.py <out dir> [code]   (code: fr)"""
import os, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

TITLES = {'fr': {
    'newgame': 'Nouvelle partie', 'config': 'Configuration', 'audio': 'Audio', 'video': 'Vidéo',
    'vidoptions': 'Options vidéo', 'vidmodes': 'Modes vidéo', 'controls': 'Commandes', 'advanced': 'Options avancées',
    'advoptions': 'Options avancées', 'gameopts': 'Options de jeu', 'gamepad': 'Manette', 'creategame': 'Créer une partie',
    'custom': 'Jeu personnalisé', 'customize': 'Personnaliser', 'inetgames': 'Parties Internet', 'lan': 'Réseau local',
    'load': 'Charger', 'save': 'Sauvegarder', 'saveload': 'Charger, sauvegarder', 'multi': 'Multijoueur',
    'touch': 'Tactile', 'touch_buttons': 'Boutons tactiles', 'touch_options': 'Options tactiles',
}}
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'

def banner(text):
    W, H = 460, 80
    size = 40
    while size > 22:
        font = ImageFont.truetype(FONT, size)
        if font.getbbox(text)[2] <= W - 24: break
        size -= 1
    mask = Image.new('L', (W, H), 0)
    ImageDraw.Draw(mask).text((10, 54), text, font=font, fill=255, anchor='ls')
    glow = mask.filter(ImageFilter.GaussianBlur(6)).point(lambda v: min(255, v * 2.6))
    core = mask.filter(ImageFilter.GaussianBlur(2.8))
    out = Image.new('RGB', (W, H))
    px, g, c = out.load(), glow.load(), core.load()
    for y in range(H):
        for x in range(W):
            a, b = g[x, y] / 255, c[x, y] / 255
            # (a red-orange halo, an amber core turning pale at its heart)
            r = min(255, int(235 * a + 255 * b)); gg = min(255, int(70 * a + 200 * b)); bb = min(255, int(10 * a + 60 * b * b))
            px[x, y] = (r, gg, bb)
    return out

def main():
    out, code = sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else 'fr'
    os.makedirs(out, exist_ok=True)
    for name, text in TITLES[code].items():
        banner(text).save(os.path.join(out, f'head_{name}.tga'))
    print(f'{len(TITLES[code])} banners in {out}')

if __name__ == '__main__':
    main()
