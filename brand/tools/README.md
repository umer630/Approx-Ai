# Logo asset tools

The original artwork `brand/approx-ai-logo-1254.png` is an app-icon tile (dark rounded square). It is never modified.

* `make_light_mark.py <original> <out-mark.png> <preview.png>` — derives `brand/approx-ai-mark-light.png`: the "A" mark on a
  transparent background for the green + white UI. The dark tile, its rim and the black square corners are removed;
  the green/teal ribbon keeps its original pixels; the white stroke is mapped to the brand navy so it stays visible on white.
* `make_app_assets.py <repo-root> <mark.png>` — writes the in-app marks (`web/assets/logo-mark-*.png`,
  `android/res/drawable-xxhdpi/logo_mark.png`) and the icon tiles with transparent corners (favicon, PWA icons, Android
  launcher icons).

Run with `python3 -I` (Pillow + NumPy).
