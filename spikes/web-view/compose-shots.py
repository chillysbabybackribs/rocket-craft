# Paste each view capture onto its shell capture at the right-side bounds main.mjs uses.
# Usage: python3 -I compose-shots.py <label>
import sys
from pathlib import Path
from PIL import Image
shots = Path(__file__).resolve().parent / 'shots'
label = sys.argv[1]
for app in ['photocraft', 'gridcraft', 'filmcraft']:
    shell = shots / f'{label}-window-{app}-shell.png'
    view = shots / f'{label}-window-{app}-view.png'
    if not shell.exists() or not view.exists():
        continue
    out = Image.open(shell).convert('RGB')
    out.paste(Image.open(view).convert('RGB'), (480, 32))
    out.save(shots / f'{label}-window-{app}.png')
    print('wrote', f'{label}-window-{app}.png')
