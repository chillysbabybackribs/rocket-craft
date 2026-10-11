# Test helper: move/restack one window. python3 -I xmove.py <wid> <x> <y> [above|below] [w h]
import sys
from Xlib import X, display
d = display.Display()
w = d.create_resource_object('window', int(sys.argv[1]))
kw = {'x': int(sys.argv[2]), 'y': int(sys.argv[3])}
if len(sys.argv) > 4 and sys.argv[4] in ('above', 'below'):
    kw['stack_mode'] = X.Above if sys.argv[4] == 'above' else X.Below
if len(sys.argv) > 6:
    kw['width'], kw['height'] = int(sys.argv[5]), int(sys.argv[6])
w.configure(**kw)
d.sync()
