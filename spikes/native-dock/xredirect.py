# Test helper: python3 -I xredirect.py <wid> on|off  (Composite redirect, automatic mode)
import sys
from Xlib import display
from Xlib.ext import composite
d = display.Display()
w = d.create_resource_object('window', int(sys.argv[1]))
if sys.argv[2] == 'on':
    composite.redirect_window(w, composite.RedirectAutomatic)
else:
    composite.unredirect_window(w, composite.RedirectAutomatic)
d.sync()
print('ok', d.query_extension('Composite') is not None)
# Keep the connection: a redirect made by a client is undone when it disconnects.
if len(sys.argv) > 3:
    import time; time.sleep(float(sys.argv[3]))
