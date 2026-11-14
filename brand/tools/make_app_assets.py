# Produces app assets from brand/approx-ai-logo-1254.png (the original stays untouched):
#  * logo-mark.png    — the "A" mark on a transparent background for light UI (in-app header / auth / greeting)
#  * icon tiles       — the original tile with its black square corners made transparent (launcher / PWA / favicon)
import sys, numpy as np
from PIL import Image, ImageDraw
root, mark_path = sys.argv[1], sys.argv[2]
src = Image.open(f'{root}/brand/approx-ai-logo-1254.png').convert('RGBA')
mark = Image.open(mark_path).convert('RGBA')

def tile(size):
    im = src.resize((size, size), Image.LANCZOS)
    # Rounded-rect mask matching the tile (corner radius ≈ 17.5% of the side), anti-aliased via supersampling.
    ss = 4; m = Image.new('L', (size * ss, size * ss), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size * ss - 1, size * ss - 1], radius=int(size * ss * 0.175), fill=255)
    im.putalpha(m.resize((size, size), Image.LANCZOS)); return im

def mk(size): return mark.resize((size, size), Image.LANCZOS)
out = {
  'web/assets/logo-mark-64.png': mk(64), 'web/assets/logo-mark-192.png': mk(192),
  'web/assets/logo-32.png': tile(32), 'web/assets/logo-64.png': tile(64), 'web/assets/logo-192.png': tile(192), 'web/assets/logo-512.png': tile(512),
  'web/favicon.png': tile(192),
  'android/res/drawable-xxhdpi/logo_mark.png': mk(288),
  'android/res/drawable-xxhdpi/logo.png': tile(288),
  'android/res/mipmap-mdpi/ic_launcher.png': tile(48), 'android/res/mipmap-hdpi/ic_launcher.png': tile(72),
  'android/res/mipmap-xhdpi/ic_launcher.png': tile(96), 'android/res/mipmap-xxhdpi/ic_launcher.png': tile(144),
  'android/res/mipmap-xxxhdpi/ic_launcher.png': tile(192),
}
for p, im in out.items():
    im.save(f'{root}/{p}', optimize=True); print(p, im.size, im.getpixel((0, 0)))
