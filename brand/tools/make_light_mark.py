import sys, numpy as np
from PIL import Image
src = Image.open(sys.argv[1]).convert('RGB')
a = np.asarray(src).astype(np.float32) / 255.0
mx = a.max(axis=2); mn = a.min(axis=2)
sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
# Foreground opacity from brightness: the tile + glow are dark (max channel < ~0.22); the mark is bright.
alpha = np.clip((mx - 0.20) / (0.42 - 0.20), 0, 1)
# Grey (unsaturated) pixels belong to the mark only if clearly bright: removes the tile's faint rim/edge highlight.
grey = np.clip((0.25 - sat) / 0.15, 0, 1)
alpha = alpha * (1 - grey) + np.clip((mx - 0.50) / 0.20, 0, 1) * alpha * grey
# Keep only the mark: it lies well inside the tile, so anything near the tile edge (rim, corners) is dropped.
H, W = alpha.shape
yy, xx = np.mgrid[0:H, 0:W]
inside = (xx > W * 0.09) & (xx < W * 0.93) & (yy > H * 0.13) & (yy < H * 0.80)
alpha = alpha * inside
# White/grey stroke: bright and unsaturated → map to brand navy, keeping its shading.
navy = np.array([0x0b, 0x1f, 0x4a], np.float32) / 255.0
whiteness = np.clip((0.35 - sat) / 0.20, 0, 1) * np.clip((mx - 0.55) / 0.25, 0, 1)
shade = (1.0 - mx)[..., None] * 0.6            # light-grey areas of the stroke become slightly lighter navy
stroke = np.clip(navy + shade * 0.5, 0, 1)
rgb = a * (1 - whiteness[..., None]) + stroke * whiteness[..., None]
# Un-premultiply the dark background out of semi-transparent edge pixels so edges don't look dirty on white.
out = np.dstack([rgb, alpha])
img = Image.fromarray((out * 255).round().astype(np.uint8), 'RGBA')
bbox = img.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
img = img.crop(bbox)
w, h = img.size; side = int(max(w, h) * 1.08)
canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0)); canvas.paste(img, ((side - w) // 2, (side - h) // 2)); 
canvas.save(sys.argv[2])
prev = Image.new('RGBA', canvas.size, (255, 255, 255, 255)); prev.alpha_composite(canvas); prev.convert('RGB').resize((400, 400)).save(sys.argv[3])
print('bbox', bbox, 'out', canvas.size)
