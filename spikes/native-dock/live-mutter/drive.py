#!/usr/bin/env python3
# The live-mutter test sequence, run against the spike (main.js in this folder) over
# run/ctl.sock. Written to be run once on the user's real display (:1, GNOME Shell /
# mutter) after a rehearsal on a private Xvfb display running gnome-shell.
#
# Input is synthetic (XTEST) because the focus guard is about real pointer and key
# routing: XSendEvent clicks bypass passive grabs and focus, so they cannot test it.
# To keep that input on the spike's own windows only:
#   - before every press, the window under the pointer (XQueryPointer on the root, which
#     honours stacking and input shapes) must be the spike's own top-level frame;
#   - before every key, X input focus must be Electron's window or inside it, and
#     _NET_ACTIVE_WINDOW must be Electron;
#   - any failed check raises Abort, releases nothing held, and the caller restores the
#     pointer and quits the spike.
# Alt-Tab and Super are not pressed (they act on the whole desktop); what they would list
# is read from _NET_CLIENT_LIST, the list mutter's switcher and the dash are built from.
#
#   python3 -I drive.py <label>          (DISPLAY selects the display)
import json
import os
import socket
import subprocess
import sys
import time

from Xlib import X, XK, display, Xatom
from Xlib.ext import xtest

HERE = os.path.dirname(os.path.abspath(__file__))
RUN = os.path.join(HERE, 'run')
LABEL = sys.argv[1] if len(sys.argv) > 1 else 'rehearsal'
SHOTS = os.path.join(HERE, 'shots', LABEL)
os.makedirs(SHOTS, exist_ok=True)
OUT = os.path.join(RUN, f'drive-{LABEL}.json')

R = {'label': LABEL, 'display': os.environ.get('DISPLAY'), 'steps': []}
T_START = time.time()


def ms():
    return round((time.time() - T_START) * 1000)


def save():
    with open(OUT, 'w') as f:
        json.dump(R, f, indent=1)


def note(**kw):
    kw['atMs'] = ms()
    R['steps'].append(kw)
    print(json.dumps(kw)[:400], flush=True)
    save()


class Abort(Exception):
    pass


# ---- the spike's control socket ---------------------------------------------

sock = socket.socket(socket.AF_UNIX)
sock.connect(os.path.join(RUN, 'ctl.sock'))
sfile = sock.makefile('r')
seq = [0]


def ctl(op, **args):
    seq[0] += 1
    sock.sendall((json.dumps({'id': seq[0], 'op': op, **args}) + '\n').encode())
    while True:
        m = json.loads(sfile.readline())
        if m.get('id') == seq[0]:
            if not m['ok']:
                raise RuntimeError(m['error'][:500])
            return m['result']


def xop(op, **args):
    return ctl('x', req={'op': op, 'args': args})


def mcp(app, tool, args=None, timeout_ms=30000):
    # PhotoCraft drops an idle control connection after ~30 s; the first call after that
    # fails with "connection closed" and the next reconnects. Read-only calls retry once.
    r = ctl('mcp', app=app, tool=tool, args=args or {}, timeoutMs=timeout_ms)
    if r.get('isError') and 'connection closed' in (r.get('text') or '') and tool in (
            'ui_inspect', 'inspect_workbook', 'read_range', 'ui_screenshot', 'screenshot'):
        r = ctl('mcp', app=app, tool=tool, args=args or {}, timeoutMs=timeout_ms)
    r.pop('images', None)
    return r


def last_json(app):
    with open(os.path.join(RUN, f'last-mcp-{app}.txt')) as f:
        return json.load(f)


# ---- X side -------------------------------------------------------------------

d = display.Display()
root = d.screen().root
NET_ACTIVE = d.intern_atom('_NET_ACTIVE_WINDOW')

st = ctl('state')
E = st['electronXid']
OX = st['stageOnRoot']['rx'] - st['stage']['x']
OY = st['stageOnRoot']['ry'] - st['stage']['y']
TOP = xop('toplevel', wid=E)['top']
R['electron'] = {'xid': E, 'top': TOP, 'contentOrigin': [OX, OY], 'stage': st['stage']}


def active():
    p = root.get_full_property(NET_ACTIVE, Xatom.WINDOW)
    return int(p.value[0]) if p and len(p.value) else None


def focus_id():
    f = d.get_input_focus().focus
    return f.id if hasattr(f, 'id') else int(f)


def inside_electron(wid):
    w = d.create_resource_object('window', wid)
    for _ in range(50):
        if w.id == E:
            return True
        try:
            p = w.query_tree().parent
        except Exception:
            return False
        if not p or p.id == 0 or p.id == root.id:
            return False
        w = p
    return False


def check_pointer(rx, ry):
    q = root.query_pointer()
    child = q.child.id if hasattr(q.child, 'id') else int(q.child)
    if (q.root_x, q.root_y) != (rx, ry):
        raise Abort(f'pointer is at {q.root_x},{q.root_y}, expected {rx},{ry} (moved by someone?)')
    if child != TOP:
        raise Abort(f'window under the pointer is {child:#x}, not the spike ({TOP:#x})')


def move(x, y, settle=0.04):
    rx, ry = x + OX, y + OY
    xtest.fake_input(d, X.MotionNotify, x=rx, y=ry)
    d.sync()
    time.sleep(settle)
    check_pointer(rx, ry)


def click(x, y, button=1, settle=0.3):
    move(x, y)
    check_pointer(x + OX, y + OY)
    xtest.fake_input(d, X.ButtonPress, button)
    xtest.fake_input(d, X.ButtonRelease, button)
    d.sync()
    time.sleep(settle)


def wheel(x, y, button, n=5, delay=0.06):
    move(x, y)
    for _ in range(n):
        check_pointer(x + OX, y + OY)
        xtest.fake_input(d, X.ButtonPress, button)
        xtest.fake_input(d, X.ButtonRelease, button)
        d.sync()
        time.sleep(delay)


def drag(x0, y0, x1, y1, steps=12, delay=0.03):
    move(x0, y0)
    check_pointer(x0 + OX, y0 + OY)
    xtest.fake_input(d, X.ButtonPress, 1)
    d.sync()
    try:
        for i in range(1, steps + 1):
            rx = round(x0 + (x1 - x0) * i / steps) + OX
            ry = round(y0 + (y1 - y0) * i / steps) + OY
            xtest.fake_input(d, X.MotionNotify, x=rx, y=ry)
            d.sync()
            time.sleep(delay)
    finally:
        xtest.fake_input(d, X.ButtonRelease, 1)
        d.sync()
    time.sleep(0.3)


def check_keyboard():
    a, f = active(), focus_id()
    if a != E:
        raise Abort(f'_NET_ACTIVE_WINDOW is {a}, not the spike ({E})')
    if not inside_electron(f):
        raise Abort(f'X input focus is {f:#x}, outside the spike')


def keycode(ch):
    names = {'-': 'minus', '+': 'plus', ' ': 'space', '\n': 'Return'}
    ks = XK.string_to_keysym(names.get(ch, ch))
    kc = d.keysym_to_keycode(ks)
    if not kc:
        raise Abort(f'no keycode for {ch!r}')
    shift = d.keycode_to_keysym(kc, 0) != ks
    return kc, shift


SHIFT = d.keysym_to_keycode(XK.string_to_keysym('Shift_L'))
CTRL = d.keysym_to_keycode(XK.string_to_keysym('Control_L'))


def key(ch, ctrl=False):
    check_keyboard()
    kc, shift = keycode(ch)
    mods = ([CTRL] if ctrl else []) + ([SHIFT] if shift else [])
    for m in mods:
        xtest.fake_input(d, X.KeyPress, m)
    xtest.fake_input(d, X.KeyPress, kc)
    xtest.fake_input(d, X.KeyRelease, kc)
    for m in reversed(mods):
        xtest.fake_input(d, X.KeyRelease, m)
    d.sync()


def type_text(s, delay=0.15):
    for ch in s:
        key(ch)
        time.sleep(delay)


def shot(name):
    p = os.path.join(SHOTS, f'{name}.png')
    t0 = time.time()
    subprocess.run(['import', '-window', str(E), p], check=False)
    return {'shot': os.path.relpath(p, HERE), 'ms': round((time.time() - t0) * 1000)}


def chat_value():
    return ctl('eval', js='document.getElementById("chatInput").value')


def chat_clear():
    ctl('eval', js='document.getElementById("chatInput").value=""; 1')


def grid_scroll():
    out = subprocess.run(['python3', '-I', os.path.join(HERE, 'gridui.py'), '47712', 'scroll'],
                         capture_output=True, text=True, timeout=10).stdout.strip()
    return json.loads(out).get('scroll') if out else None


def grid_active():
    mcp('grid', 'inspect_workbook')
    j = last_json('grid')
    return j['activeCell'], j['selection']


def grid_cell(a1):
    mcp('grid', 'read_range', {'range': a1})
    return last_json('grid')['values'][0][0]


def photo_inspect():
    mcp('photo', 'ui_inspect')
    j = last_json('photo')
    doc = j.get('document') or {}
    gi = (((j.get('perf') or {}).get('timings') or {}).get('gpuInfo')) or {}
    return {'tool': j.get('tool'), 'history': doc.get('history'), 'gpu': gi}


def events_since(t_epoch_ms):
    return xop('events', since=t_epoch_ms)


def summarize_dock(evs, pid):
    # From the root watcher: was the app's top-level ever managed by mutter (framed, in
    # _NET_CLIENT_LIST), and for how long after it was created.
    c = next((e for e in evs if e['ev'] == 'create' and e.get('pid') == pid and e['w'] > 50), None)
    if not c:
        return {'note': 'no create event seen', 'events': evs[:30]}
    t0 = c['t']
    rel = lambda e: round(e['t'] - t0)
    out = {'created': c, 'framed': False, 'inClientList': False}
    for e in evs:
        if e['ev'] == 'frame-map':
            out['framed'] = True
            out.setdefault('frameMapAtMs', rel(e))
        if e['ev'] in ('frame-unmap', 'frame-destroy'):
            out.setdefault('frameGoneAtMs', rel(e))
        if e['ev'] == 'clientlist' and e['apps']:
            out['inClientList'] = True
            out.setdefault('clientListAddAtMs', rel(e))
        if e['ev'] == 'clientlist' and not e['apps'] and out.get('clientListAddAtMs') is not None:
            out.setdefault('clientListRemoveAtMs', rel(e))
        if e['ev'] == 'active':
            out.setdefault('activeChanges', []).append({'atMs': rel(e), 'wid': e['wid']})
    if 'frameMapAtMs' in out and 'frameGoneAtMs' in out:
        out['frameVisibleMs'] = out['frameGoneAtMs'] - out['frameMapAtMs']
    if 'clientListAddAtMs' in out and 'clientListRemoveAtMs' in out:
        out['clientListMs'] = out['clientListRemoveAtMs'] - out['clientListAddAtMs']
    out['events'] = [{**{k: v for k, v in e.items() if k != 't'}, 'atMs': rel(e)} for e in evs
                     if e['ev'] != 'xfocus'][:40]
    return out


def open_app(app, early):
    t = time.time() * 1000
    r = ctl('open', app=app, early=early)
    time.sleep(0.6)
    pid = ctl('state')['apps'][app]['pid']
    s = summarize_dock(events_since(t - 50), pid)
    note(step=f'open {app} early={early}', open={k: r.get(k) for k in ('windowMappedMs', 'dockedMs', 'fittedMs')},
         dock=r.get('dock'), mutter=s)
    return r


def gpu_rows(pids):
    out = subprocess.run(['nvidia-smi'], capture_output=True, text=True).stdout.splitlines()
    rows = {}
    for line in out:
        parts = line.split()
        for name, p in pids.items():
            if str(p) in parts:
                rows[name] = ' '.join(parts)
    comp = subprocess.run(['nvidia-smi', '--query-compute-apps=pid,used_memory', '--format=csv,noheader'],
                          capture_output=True, text=True).stdout.strip()
    return {'processTable': rows, 'computeApps': comp}


def cpu_usec(app):
    c = ctl('cgroup', app=app)
    return int(c['cpuStat'].split()[1]) if c.get('cpuStat') else None


def timed_screenshot(app):
    t0 = time.time()
    if app == 'photo':
        r = mcp('photo', 'ui_screenshot', {'max_side': 800}, 30000)
        img = os.path.join(RUN, 'last-mcp-photo-0.png')
        dst = os.path.join(SHOTS, 'photo-own-capture-while-parked.png')
        if os.path.exists(img):
            subprocess.run(['cp', img, dst])
    else:
        dst = os.path.join(SHOTS, 'grid-own-capture-while-parked.png')
        r = mcp('grid', 'screenshot', {'path': dst}, 30000)
    return {'ms': round((time.time() - t0) * 1000), 'ok': not r.get('isError') and not r.get('timeout'),
            'timeout': r.get('timeout'), 'text': (r.get('text') or '')[:160], 'file': os.path.relpath(dst, HERE)}


# Content coordinates (the spike's layout: chat 0-380, stage from x 380, y 32).
CHAT = (190, 120)
CHAT_AWAY = (190, 400)
GRID_OVER = (800, 500)
CELL_A = (740, 351)
CELL_B = (740, 415)
CELL_C = (587, 287)
CELL_D = (638, 287)
CANVAS = (890, 434)


def main():
    R['activeAtStart'] = active()
    R['spikeGotFocusOnMap'] = active() == E
    note(step='start', active=active(), electron=E, top=TOP, focus=focus_id())
    if active() != E:
        xop('activate', wid=E)
        for _ in range(40):
            if active() == E:
                break
            time.sleep(0.05)
    note(step='activated', active=active(), ok=active() == E)
    if active() != E:
        raise Abort('could not activate the spike window')

    # 1. Docking under mutter: baseline (managed first), then caught at CreateNotify.
    open_app('grid', 'none')
    note(step='shot', **shot('01-grid-docked-baseline'))
    open_app('photo', 'early')
    note(step='shot', **shot('02-photo-docked-early'))
    ctl('close', app='grid')
    open_app('grid', 'early')
    time.sleep(0.8)
    note(step='shot', **shot('03-grid-docked-early'))
    note(step='client list after docking', **xop('client_list'),
         gridWm=xop('wm_state', wid=ctl('state')['apps']['grid']['wid']),
         photoWm=xop('wm_state', wid=ctl('state')['apps']['photo']['wid']))

    # 2. Focus guard with GridCraft shown.
    t_focus = time.time() * 1000
    chat_clear()
    click(*CHAT)
    click(*CELL_A)
    c1 = grid_active()[0]
    move(*CHAT_AWAY)
    time.sleep(0.2)
    f1 = focus_id()
    type_text('to-app')
    key('\n')
    time.sleep(0.4)
    click(*CHAT)
    move(*GRID_OVER)
    time.sleep(0.2)
    f2 = focus_id()
    type_text('to-chat', 0.08)
    time.sleep(0.4)
    click(*CELL_B)
    c3 = grid_active()[0]
    move(*CHAT_AWAY)
    time.sleep(0.2)
    type_text('again')
    key('\n')
    time.sleep(0.4)
    click(*CHAT)
    move(*GRID_OVER)
    time.sleep(0.2)
    s0 = grid_scroll()
    wheel(*GRID_OVER, 5)
    time.sleep(0.5)
    s1 = grid_scroll()
    type_text('-wheel', 0.08)
    time.sleep(0.3)
    wheel(*GRID_OVER, 4)
    time.sleep(0.3)
    chat = chat_value()
    note(step='focus guard (grid)', focusAfterAppClick=hex(f1), appWid=hex(ctl('state')['apps']['grid']['wid']),
         focusAfterChatClick=hex(f2), electron=hex(E),
         cellA=c1, cellAValue=grid_cell(c1), cellB=c3, cellBValue=grid_cell(c3),
         chat=chat, chatExpected='to-chat-wheel', scroll=[s0, s1], activeEnd=active(),
         guardLog=xop('guard_log')[-12:])
    note(step='shot', **shot('04-grid-after-focus-test'))

    # Drag inside the app: a range selection C..B.
    click(*CHAT)
    drag(*CELL_C, *CELL_B)
    note(step='drag (grid)', selection=grid_active()[1])

    # Clipboard both ways (CLIPBOARD selection). A sentinel first, so a copy that fails
    # reads back the sentinel and never the user's own clipboard text.
    subprocess.run('printf lm-sentinel | xclip -i -selection clipboard', shell=True, timeout=5)
    time.sleep(0.2)
    click(*CELL_C)
    a = grid_active()[0]
    mcp('grid', 'write_range', {'range': a, 'values': [['copied-from-app']]})
    time.sleep(0.3)
    key('c', ctrl=True)
    time.sleep(0.4)
    clip1 = subprocess.run(['xclip', '-o', '-selection', 'clipboard'], capture_output=True, text=True, timeout=5).stdout
    chat_clear()
    click(*CHAT)
    key('v', ctrl=True)
    time.sleep(0.4)
    chat1 = chat_value()
    ctl('eval', js='document.getElementById("chatInput").value="pasted-into-app"; 1')
    key('a', ctrl=True)
    key('c', ctrl=True)
    time.sleep(0.4)
    clip2 = subprocess.run(['xclip', '-o', '-selection', 'clipboard'], capture_output=True, text=True, timeout=5).stdout
    click(*CELL_D)
    b = grid_active()[0]
    key('v', ctrl=True)
    time.sleep(0.6)
    key('\n')
    time.sleep(0.3)
    note(step='clipboard (grid)', appCell=a, clipboardAfterAppCopy=clip1, chatAfterPaste=chat1,
         clipboardAfterChatCopy=clip2, appCellB=b, appCellBValue=grid_cell(b))
    note(step='shot', **shot('05-grid-after-clipboard'))

    # PhotoCraft input: click gives it the keyboard, shortcuts, a brush drag, and keys
    # typed with the chat focused and the pointer over the canvas stay in the chat.
    ctl('open', app='photo')
    time.sleep(0.5)
    r = mcp('photo', 'command_run', {'id': 'file.new', 'params': {'width': 1200, 'height': 800, 'name': 'live'}})
    if r.get('isError'):
        time.sleep(0.3)
        if not (photo_inspect().get('history')):
            mcp('photo', 'command_run', {'id': 'file.new', 'params': {'width': 1200, 'height': 800, 'name': 'live'}})
    time.sleep(0.8)
    p0 = photo_inspect()
    click(*CHAT)
    click(*CANVAS)
    pf = focus_id()
    move(*CHAT_AWAY)
    key('e')
    time.sleep(0.4)
    p1 = photo_inspect()
    key('b')
    time.sleep(0.4)
    p2 = photo_inspect()
    drag(CANVAS[0] - 150, CANVAS[1] - 60, CANVAS[0] + 150, CANVAS[1] + 60, steps=20)
    p3 = photo_inspect()
    chat_clear()
    click(*CHAT)
    move(*CANVAS)
    time.sleep(0.2)
    key('m')
    time.sleep(0.4)
    p4 = photo_inspect()
    note(step='photo input', before=p0['tool'], focusAfterCanvasClick=hex(pf),
         appWid=hex(ctl('state')['apps']['photo']['wid']), toolAfterE=p1['tool'], toolAfterB=p2['tool'],
         historyAfterDrag=p3['history'], chatAfterM=chat_value(), toolAfterMTypedToChat=p4['tool'],
         gpuInfo=p0['gpu'])
    note(step='shot', **shot('06-photo-after-brush'))

    # 3. What Alt-Tab and the dash would list; focus changes over the whole run.
    allev = events_since(0)
    acts = [e for e in allev if e['ev'] == 'active']
    foc = [e for e in allev if e['ev'] == 'xfocus']
    apps = ctl('state')['apps']
    appw = {v['wid'] for v in apps.values()}
    note(step='alt-tab proxy', clientList=xop('client_list'), appWids=sorted(appw),
         appsEverInClientList=sorted({w for e in allev if e['ev'] == 'clientlist' for w in e['apps']}),
         activeValuesSeen=sorted({e['wid'] for e in acts if e['wid'] is not None}),
         activeChanges=len(acts),
         focusWindowsSeen=sorted({hex(e['wid']) for e in foc if e['wid']}))

    # 4 + 5. Parked: own screenshot through the control channel, idle CPU, GPU.
    pids = {k: v['pid'] for k, v in apps.items()}
    # The spike's Electron GPU process (its user-data dir is the scratch one).
    ud = os.environ.get('SPIKE_USERDATA', '/tmp/lm-home/electron-ud')
    for line in subprocess.run(['pgrep', '-af', ud], capture_output=True, text=True).stdout.splitlines():
        if '--type=gpu-process' in line:
            pids['electronGpu'] = int(line.split()[0])
    gshown = gpu_rows(pids)
    note(step='gpu: photo shown, grid parked', **gshown)
    shots_grid = [timed_screenshot('grid') for _ in range(2)]
    c0 = cpu_usec('grid')
    time.sleep(8)
    c1 = cpu_usec('grid')
    note(step='grid parked', screenshots=shots_grid, idleCpuUsecPer8s=(c1 - c0) if c0 is not None else None)
    ctl('open', app='grid')
    time.sleep(1.0)
    note(step='gpu: grid shown, photo parked', **gpu_rows(pids))
    shots_photo = [timed_screenshot('photo') for _ in range(2)]
    c0 = cpu_usec('photo')
    time.sleep(8)
    c1 = cpu_usec('photo')
    note(step='photo parked', screenshots=shots_photo, idleCpuUsecPer8s=(c1 - c0) if c0 is not None else None)
    note(step='shot', **shot('07-grid-shown-photo-parked'))


try:
    main()
    R['result'] = 'completed'
except Abort as e:
    R['result'] = f'aborted: {e}'
    print('ABORT', e, flush=True)
except Exception as e:
    R['result'] = f'error: {e!r}'
    print('ERROR', repr(e), flush=True)
finally:
    R['driveMs'] = ms()
    save()
