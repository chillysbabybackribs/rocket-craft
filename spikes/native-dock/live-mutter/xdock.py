#!/usr/bin/env python3
# The X11 hands of the spike: one long-lived Xlib connection that finds an app's
# window by _NET_WM_PID, reparents it into Electron's window, fits, parks and
# times frames. Electron's main process talks to it in JSON lines on stdin/stdout,
# so each operation is one round trip instead of a fresh xdotool process.
#
# Every X call used is named in the reply's "calls" list, so REPORT.md can quote
# exactly what worked.
#
# live-mutter copy: adds a root watcher (op_watch) that logs what the window manager
# does with an app's top-level (CreateNotify, frame, _NET_CLIENT_LIST, _NET_ACTIVE_WINDOW,
# X input focus) and can catch the app's window the moment it is created (XRes gives the
# creating client's pid, before _NET_WM_PID is set) to keep it from ever being managed.
import json
import sys
import time
import hashlib

import numpy as np
from Xlib import X, display, Xatom
from Xlib.ext import composite
from Xlib.protocol import event as xevent

d = display.Display()
root = d.screen().root
A = lambda name: d.intern_atom(name)
NET_WM_PID = A('_NET_WM_PID')
WM_STATE = A('WM_STATE')
MOTIF = A('_MOTIF_WM_HINTS')
NET_WM_STATE = A('_NET_WM_STATE')
ABOVE = A('_NET_WM_STATE_ABOVE')
SKIP_TB = A('_NET_WM_STATE_SKIP_TASKBAR')
SKIP_PG = A('_NET_WM_STATE_SKIP_PAGER')


def win(wid):
    return d.create_resource_object('window', int(wid))


def walk(w, depth=0):
    yield w, depth
    try:
        for c in w.query_tree().children:
            yield from walk(c, depth + 1)
    except Exception:
        return


def pid_of(w):
    try:
        p = w.get_full_property(NET_WM_PID, Xatom.CARDINAL)
        return int(p.value[0]) if p else None
    except Exception:
        return None


def candidates(pid):
    out = []
    for w, depth in walk(root):
        if pid_of(w) != pid:
            continue
        try:
            a = w.get_attributes()
            g = w.get_geometry()
        except Exception:
            continue
        if a.win_class != X.InputOutput:
            continue
        out.append({'wid': w.id, 'mapped': a.map_state == X.IsViewable, 'w': g.width,
                    'h': g.height, 'parent': w.query_tree().parent.id, 'depth': depth})
    return out


def op_find(pid, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        c = [x for x in candidates(pid) if x['mapped'] and x['w'] > 50]
        if c:
            c.sort(key=lambda x: -x['w'] * x['h'])
            return {'found': c[0], 'all': candidates(pid), 'ms': round((time.time() - t0) * 1000),
                    'calls': ['XQueryTree (recursive from root)', 'XGetWindowProperty _NET_WM_PID',
                              'XGetWindowAttributes (map_state == IsViewable)']}
        time.sleep(0.02)
    return {'found': None, 'all': candidates(pid)}


def op_dock(wid, parent, x, y, w, h):
    # A reparenting window manager owns a mapped top-level through its frame, so the
    # window is withdrawn first (unmap plus the ICCCM synthetic UnmapNotify), the WM is
    # given a moment to hand it back to the root, then it is reparented and mapped.
    calls = []
    cw = win(wid)
    # Already ours if the root watcher caught it at CreateNotify (parent == Electron).
    managed = cw.query_tree().parent.id not in (root.id, int(parent))
    if managed:
        cw.unmap()
        ev = xevent.UnmapNotify(window=cw, event=root, from_configure=False)
        root.send_event(ev, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
        d.sync()
        calls += ['XUnmapWindow(app)', 'XSendEvent(root, synthetic UnmapNotify) [ICCCM withdraw]']
        t0 = time.time()
        # mutter can take well over a second to unmanage on a loaded machine, and if the
        # window is reparented before it does, mutter's unmanage moves it back to the root
        # (seen on gnome-shell 46): wait for the hand-back itself, up to 5 s.
        while time.time() - t0 < 5.0:
            if cw.query_tree().parent.id == root.id:
                st = cw.get_full_property(WM_STATE, WM_STATE)
                if not st or st.value[0] == 0:
                    break
            time.sleep(0.01)
        calls.append('poll XQueryTree until parent == root and WM_STATE Withdrawn (%d ms)' % round((time.time() - t0) * 1000))
    # Keep the WM away from it for good: an override-redirect child is never managed.
    cw.change_attributes(override_redirect=True)
    cw.reparent(win(parent), x, y)
    cw.configure(x=x, y=y, width=w, height=h)
    cw.map()
    d.sync()
    calls += ['XChangeWindowAttributes(app, override_redirect=True)',
              'XReparentWindow(app, electron, x, y)', 'XMoveResizeWindow(app, x, y, w, h)',
              'XMapWindow(app)']
    return {'managedBefore': managed, 'parentNow': cw.query_tree().parent.id, 'calls': calls}


REDIRECTED = set()


def redirect(wid):
    # A window the X server reports as fully obscured stops painting (winit turns
    # VisibilityNotify into Occluded and eframe skips frames), so a parked app never
    # answers ui.screenshot. A Composite-redirected window has its own pixmap and is
    # never obscured, so it keeps drawing while out of view. The redirect belongs to
    # this connection and ends with it.
    if wid not in REDIRECTED:
        composite.redirect_window(win(wid), composite.RedirectAutomatic)
        REDIRECTED.add(wid)
        return ['XCompositeRedirectWindow(app, CompositeRedirectAutomatic)']
    return []


def unredirect(wid):
    if wid in REDIRECTED:
        composite.unredirect_window(win(wid), composite.RedirectAutomatic)
        REDIRECTED.discard(wid)
        return ['XCompositeUnredirectWindow(app, CompositeRedirectAutomatic)']
    return []


def op_fit(wid, x, y, w, h, redirect_mode='park'):
    calls = []
    if redirect_mode == 'park':
        calls += unredirect(wid)
    elif redirect_mode == 'always':
        calls += redirect(wid)
    win(wid).configure(x=x, y=y, width=w, height=h, stack_mode=X.Above)
    d.sync()
    return {'calls': calls + ['XConfigureWindow(app, x, y, w, h, stack_mode=Above)']}


def op_park(wid, w, redirect_mode='park'):
    # Out of the parent's bounds, still mapped: fully clipped, never unmapped.
    calls = redirect(wid) if redirect_mode in ('park', 'always') else []
    win(wid).configure(x=-(w + 200), y=0)
    d.sync()
    return {'calls': calls + ['XMoveWindow(app, -(w+200), 0)']}


def op_focus(wid):
    win(wid).set_input_focus(X.RevertToParent, X.CurrentTime)
    d.sync()
    return {'calls': ['XSetInputFocus(app, RevertToParent, CurrentTime)']}


def op_geom(wid):
    w = win(wid)
    g = w.get_geometry()
    t = w.translate_coords(root, 0, 0)
    a = w.get_attributes()
    return {'x': g.x, 'y': g.y, 'w': g.width, 'h': g.height, 'rootX': -t.x, 'rootY': -t.y,
            'parent': w.query_tree().parent.id, 'mapped': a.map_state, 'focus': d.get_input_focus().focus.id
            if hasattr(d.get_input_focus().focus, 'id') else str(d.get_input_focus().focus)}


def grab(rx, ry, w, h):
    # Read pixels off the root window: what is actually on screen, after clipping.
    raw = root.get_image(rx, ry, w, h, X.ZPixmap, 0xffffffff).data
    a = np.frombuffer(raw, dtype=np.uint8).reshape(h, w, 4)[:, :, :3]
    return a


def op_wait_frame(rx, ry, w, h, mode, ref=None, timeout=20, interval=0.01, tol=0.02):
    # mode 'drawn': region stops being one flat colour and has some detail.
    # mode 'change': region differs from its state at the call.
    # mode 'match': region matches a reference saved earlier with 'snap' (<= tol differing).
    t0 = time.time()
    first = grab(rx, ry, w, h)
    n = 0
    while time.time() - t0 < timeout:
        a = grab(rx, ry, w, h)
        n += 1
        if mode == 'drawn':
            sub = a[::8, ::8].reshape(-1, 3)
            if len(np.unique(sub, axis=0)) > 12:
                return {'ms': round((time.time() - t0) * 1000), 'polls': n}
        elif mode == 'drawn2':
            # A real frame, not a background fill: most of the region changed from the
            # base snapshot and it has the detail of an app's UI.
            changed = (np.any(a != SNAPS[ref], axis=2)).mean()
            sub = a[::8, ::8].reshape(-1, 3)
            if changed > 0.3 and len(np.unique(sub, axis=0)) > 20:
                return {'ms': round((time.time() - t0) * 1000), 'polls': n, 'changed': float(changed)}
        elif mode == 'change':
            if (np.any(a != first, axis=2)).mean() > 0.05:
                return {'ms': round((time.time() - t0) * 1000), 'polls': n}
        elif mode == 'match':
            r = SNAPS[ref]
            diff = (np.any(a != r, axis=2)).mean()
            if diff <= tol:
                return {'ms': round((time.time() - t0) * 1000), 'polls': n, 'diff': float(diff)}
        time.sleep(interval)
    return {'ms': None, 'timeout': True, 'polls': n}


SNAPS = {}


def op_snap(name, rx, ry, w, h):
    SNAPS[name] = grab(rx, ry, w, h)
    return {'md5': hashlib.md5(SNAPS[name].tobytes()).hexdigest()}


def op_diff(name, rx, ry, w, h):
    a = grab(rx, ry, w, h)
    return {'diff': float((np.any(a != SNAPS[name], axis=2)).mean())}


def op_overlay(wid, transient_for):
    # The fallback: leave the app a top-level, strip its decorations and keep it above.
    calls = []
    cw = win(wid)
    cw.change_property(MOTIF, MOTIF, 32, [2, 0, 0, 0, 0])
    cw.change_property(Xatom.WM_TRANSIENT_FOR, Xatom.WINDOW, 32, [int(transient_for)])
    calls += ['XChangeProperty _MOTIF_WM_HINTS decorations=0', 'XChangeProperty WM_TRANSIENT_FOR=electron']
    for atom in (ABOVE, SKIP_TB, SKIP_PG):
        ev = xevent.ClientMessage(window=cw, client_type=NET_WM_STATE, data=(32, [1, atom, 0, 1, 0]))
        root.send_event(ev, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
    calls.append('XSendEvent _NET_WM_STATE add ABOVE, SKIP_TASKBAR, SKIP_PAGER')
    d.sync()
    return {'calls': calls}


def op_overlay_fit(wid, rx, ry, w, h):
    win(wid).configure(x=rx, y=ry, width=w, height=h, stack_mode=X.Above)
    d.sync()
    return {'calls': ['XConfigureWindow(app, x, y, w, h, stack_mode=Above) in root coordinates']}


GUARD = {'started': False, 'apps': set(), 'pending': [], 'log': [], 'want': 'electron',
         'shown': None, 'top': None, 'shields': {}}


def guard_log(**kw):
    GUARD['log'].append(kw)
    del GUARD['log'][:-30]


def guard_loop():
    # Keyboard focus between Electron and the docked apps.
    #
    # X sends a key to the focus window, except that when the focus window is an
    # ancestor of the window under the pointer, the key goes to that inner window.
    # With Electron focused and the pointer resting over a docked app, the app would
    # get the chat's keys and drop them (it is not focused). So each app gets a
    # "shield": an InputOnly child of the app window, covering it, on which only this
    # client selects KeyPress/KeyRelease. While Electron should have the keyboard the
    # shield is mapped: keys under the pointer land on it, and are forwarded to
    # Electron with XSendEvent (Chromium accepts synthetic keys). Pointer events are
    # selected by nobody on the shield, so they propagate to the app: hover, wheel
    # and clicks keep working.
    #
    # A press on the shield (a synchronous passive grab this client owns) unmaps it,
    # focuses the app and replays the press, which reaches the app. The grab cannot
    # sit on Electron's window, where the window manager already holds it (openbox:
    # BadAccess). A press on Electron's DOM comes back through the renderer
    # (op_want_electron). The window manager re-focuses Electron after its own click
    # handling, so a FocusIn on Electron while an app should have the keyboard is
    # redirected to the app.
    import select
    gd = display.Display()
    top = gd.create_resource_object('window', GUARD['top'])
    top.change_attributes(event_mask=X.FocusChangeMask)
    gd.sync()
    shield_of = {}
    while True:
        while GUARD['pending']:
            app = GUARD['pending'].pop()
            sh_id = GUARD['shields'][app]
            sh = gd.create_resource_object('window', sh_id)
            sh.change_attributes(event_mask=X.KeyPressMask | X.KeyReleaseMask)
            sh.grab_button(X.AnyButton, X.AnyModifier, True, X.ButtonPressMask, X.GrabModeSync, X.GrabModeAsync, X.NONE, X.NONE)
            shield_of[sh_id] = app
            gd.sync()
        if not gd.pending_events():
            select.select([gd.fileno()], [], [], 0.05)
            if not gd.pending_events():
                continue
        ev = gd.next_event()
        if ev.type == X.ButtonPress and ev.window.id in shield_of and ev.detail >= 4:
            # The wheel (buttons 4-7) scrolls the app without taking the keyboard.
            gd.allow_events(X.ReplayPointer, ev.time)
            gd.sync()
        elif ev.type == X.ButtonPress and ev.window.id in shield_of:
            app = shield_of[ev.window.id]
            GUARD['want'] = 'app'
            gd.create_resource_object('window', app).set_input_focus(X.RevertToParent, ev.time)
            # Replay while the shield is still mapped: the press is redelivered to the
            # shield, which selects no pointer events, so it propagates to the app and
            # the app's implicit grab takes the drag. Unmapping first loses the press.
            gd.allow_events(X.ReplayPointer, ev.time)
            ev.window.unmap()
            gd.sync()
            guard_log(ev='press', app=app, button=ev.detail)
        elif ev.type in (X.KeyPress, X.KeyRelease) and ev.window.id in shield_of:
            cls = xevent.KeyPress if ev.type == X.KeyPress else xevent.KeyRelease
            fwd = cls(time=ev.time, root=ev.root, window=top, same_screen=1, child=X.NONE,
                      root_x=ev.root_x, root_y=ev.root_y, event_x=ev.root_x, event_y=ev.root_y,
                      state=ev.state, detail=ev.detail)
            top.send_event(fwd, event_mask=X.KeyPressMask if ev.type == X.KeyPress else X.KeyReleaseMask)
            gd.sync()
            if ev.type == X.KeyPress:
                guard_log(ev='key-forwarded', keycode=ev.detail)
        elif ev.type == X.FocusIn and ev.window.id == GUARD['top']:
            app = GUARD['shown']
            if GUARD['want'] == 'app' and app:
                gd.create_resource_object('window', app).set_input_focus(X.RevertToParent, X.CurrentTime)
                gd.sync()
                guard_log(ev='focusin-electron', detail=ev.detail, redirected=app)


def op_guard(top, apps):
    import threading
    new = []
    for a in apps:
        a = int(a)
        # A relaunched app can get the very same XID as the one that closed (X reuses a
        # departed client's resource range; seen with GridCraft under gnome-shell). Its old
        # shield died with the old window, so check it still exists before trusting it.
        if a in GUARD['apps']:
            try:
                win(GUARD['shields'][a]).get_geometry()
            except Exception:
                GUARD['apps'].discard(a)
        if a not in GUARD['apps']:
            GUARD['apps'].add(a)
            g = win(a).get_geometry()
            sh = win(a).create_window(0, 0, g.width, g.height, 0, 0, X.InputOnly, X.CopyFromParent)
            d.sync()
            GUARD['shields'][a] = sh.id
            new.append(a)
    GUARD['pending'].extend(new)
    if not GUARD['started']:
        GUARD['started'] = True
        GUARD['top'] = int(top)
        threading.Thread(target=guard_loop, daemon=True).start()
    return {'apps': list(GUARD['apps']), 'shields': GUARD['shields'], 'calls': [
        'XCreateWindow(parent=app, InputOnly, full size): the shield',
        'XSelectInput(shield, KeyPressMask|KeyReleaseMask) from the dock client only',
        'XGrabButton(AnyButton, AnyModifier, shield, owner_events=True, ButtonPressMask, GrabModeSync, GrabModeAsync)',
        'on ButtonPress 1-3: XSetInputFocus(app, RevertToParent, event.time); XAllowEvents(ReplayPointer, event.time); then XUnmapWindow(shield). Buttons 4-7 (wheel): XAllowEvents(ReplayPointer) only',
        'on KeyPress/KeyRelease on shield: XSendEvent(electron, KeyPress/KeyRelease)',
        'XSelectInput(electron, FocusChangeMask); on FocusIn while the app should have the keyboard: XSetInputFocus(app)',
        'DOM pointerdown -> XSetInputFocus(electron); XMapWindow(shield of shown app)']}


def op_shown(wid, x, y, w, h):
    # Which app is shown; its shield follows its size and the keyboard owner.
    GUARD['shown'] = int(wid) if wid else None
    for app, sh_id in GUARD['shields'].items():
        sh = win(sh_id)
        if app == GUARD['shown']:
            sh.configure(width=max(1, w), height=max(1, h), stack_mode=X.Above)
            if GUARD['want'] == 'electron':
                sh.map()
            else:
                sh.unmap()
    d.sync()
    return {'want': GUARD['want']}


def op_want_electron():
    GUARD['want'] = 'electron'
    if GUARD['top']:
        win(GUARD['top']).set_input_focus(X.RevertToParent, X.CurrentTime)
    sh_id = GUARD['shields'].get(GUARD['shown'])
    if sh_id:
        sh = win(sh_id)
        sh.configure(stack_mode=X.Above)
        sh.map()
    d.sync()
    guard_log(ev='want-electron')
    return {'calls': ['XSetInputFocus(electron)', 'XMapRaised(shield of shown app)']}


def op_guard_log():
    return GUARD['log']


# ---- live-mutter additions -------------------------------------------------

from Xlib.ext import res as xres

WATCH = {'started': False, 'expect': {}, 'events': [], 'electron': None, 'caught': {}}


def now_ms():
    return round(time.time() * 1000, 1)


def wlog(**kw):
    kw['t'] = now_ms()
    WATCH['events'].append(kw)
    del WATCH['events'][:-4000]


def watch_loop():
    import select
    wd = display.Display()
    wroot = wd.screen().root
    wroot.change_attributes(event_mask=X.SubstructureNotifyMask | X.PropertyChangeMask)
    wd.sync()
    CL = wd.intern_atom('_NET_CLIENT_LIST')
    ACT = wd.intern_atom('_NET_ACTIVE_WINDOW')
    PID = wd.intern_atom('_NET_WM_PID')
    st_atom = wd.intern_atom('_NET_WM_STATE')
    skip = [wd.intern_atom('_NET_WM_STATE_SKIP_TASKBAR'), wd.intern_atom('_NET_WM_STATE_SKIP_PAGER')]
    last_focus = None
    last_clients = None

    def prop(atom, typ):
        try:
            p = wroot.get_full_property(atom, typ)
            return [int(v) for v in p.value] if p else []
        except Exception:
            return []

    def client_pid(wid):
        try:
            r = wd.res_query_client_ids([{'client': wid, 'mask': xres.LocalClientPIDMask}])
            for i in r.ids:
                if i.value:
                    return int(i.value[0])
        except Exception:
            return None
        return None

    def ours():
        return {w for v in WATCH['caught'].values() for w in v}

    while True:
        # X input focus is not an event on the root; poll it with each wake-up.
        try:
            f = wd.get_input_focus().focus
            fid = f.id if hasattr(f, 'id') else int(f)
        except Exception:
            fid = None
        if fid != last_focus:
            wlog(ev='xfocus', wid=fid)
            last_focus = fid
        if not wd.pending_events():
            select.select([wd.fileno()], [], [], 0.02)
            if not wd.pending_events():
                continue
        ev = wd.next_event()
        if ev.type == X.CreateNotify and ev.parent.id == wroot.id:
            wid = ev.window.id
            pid = client_pid(wid)
            mode = WATCH['expect'].get(pid)
            if mode is None:
                continue
            tc = now_ms()
            info = {'ev': 'create', 'wid': wid, 'pid': pid, 'w': ev.width, 'h': ev.height,
                    'or': ev.override, 'mode': mode}
            big = not ev.override and ev.width > 50 and ev.height > 50
            WATCH['caught'].setdefault(pid, []).append(wid)
            if big and mode == 'early' and WATCH['electron']:
                # Before the app maps it: take it out of the root so a map never reaches
                # the window manager (no MapRequest, no frame, no taskbar entry).
                cw = wd.create_resource_object('window', wid)
                wd.grab_server()
                try:
                    a = cw.get_attributes()
                    info['mapStateAtCatch'] = a.map_state
                    cw.change_attributes(override_redirect=True)
                    cw.reparent(wd.create_resource_object('window', WATCH['electron']), -5000, 0)
                finally:
                    wd.ungrab_server()
                    wd.sync()
                info['caughtMs'] = round(now_ms() - tc, 1)
                info['action'] = 'override_redirect + XReparentWindow(electron, -5000, 0) under XGrabServer'
            elif big and mode == 'skip':
                cw = wd.create_resource_object('window', wid)
                try:
                    info['mapStateAtCatch'] = cw.get_attributes().map_state
                    cw.change_property(st_atom, Xatom.ATOM, 32, skip)
                    wd.sync()
                    info['action'] = '_NET_WM_STATE = SKIP_TASKBAR, SKIP_PAGER before map'
                except Exception as e:
                    info['error'] = repr(e)
            wlog(**info)
        elif ev.type in (X.MapNotify, X.UnmapNotify, X.DestroyNotify, X.ReparentNotify, X.MapRequest):
            wid = ev.window.id
            name = {X.MapNotify: 'map', X.UnmapNotify: 'unmap', X.DestroyNotify: 'destroy',
                    X.ReparentNotify: 'reparent', X.MapRequest: 'maprequest'}[ev.type]
            mine = ours()
            frames = WATCH.setdefault('frames', set())
            if wid in mine:
                kw = {'ev': name, 'wid': wid}
                if ev.type == X.ReparentNotify:
                    kw['parent'] = ev.parent.id
                    # Taken by the WM into a frame (a new root child that is not Electron's).
                    if ev.parent.id not in (wroot.id, WATCH['electron']):
                        frames.add(ev.parent.id)
                wlog(**kw)
            elif wid in frames:
                wlog(ev='frame-' + name, wid=wid)
        elif ev.type == X.PropertyNotify and ev.window.id == wroot.id:
            if ev.atom == CL:
                cl = prop(CL, Xatom.WINDOW)
                mine = ours()
                inl = sorted(w for w in cl if w in mine)
                if inl != last_clients:
                    wlog(ev='clientlist', apps=inl, n=len(cl))
                    last_clients = inl
            elif ev.atom == ACT:
                wlog(ev='active', wid=(prop(ACT, Xatom.WINDOW) or [None])[0])


def op_watch(electron):
    import threading
    WATCH['electron'] = int(electron)
    if not WATCH['started']:
        WATCH['started'] = True
        threading.Thread(target=watch_loop, daemon=True).start()
    return {'ok': True}


def op_expect(pid, mode):
    WATCH['expect'][int(pid)] = mode
    return {'ok': True}


def op_events(since=0):
    return [e for e in WATCH['events'] if e['t'] >= since]


def op_client_list():
    cl = root.get_full_property(A('_NET_CLIENT_LIST'), Xatom.WINDOW)
    act = root.get_full_property(A('_NET_ACTIVE_WINDOW'), Xatom.WINDOW)
    return {'clients': [int(v) for v in cl.value] if cl else [],
            'active': int(act.value[0]) if act else None}


def op_toplevel(wid):
    # The root child that holds wid (mutter's frame, or wid itself if unframed).
    w = win(wid)
    while True:
        p = w.query_tree().parent
        if p.id == root.id:
            return {'top': w.id}
        w = p


def op_activate(wid):
    # _NET_ACTIVE_WINDOW from a pager (source 2): the WM honours it without focus-stealing checks.
    ev = xevent.ClientMessage(window=win(wid), client_type=A('_NET_ACTIVE_WINDOW'),
                              data=(32, [2, X.CurrentTime, 0, 0, 0]))
    root.send_event(ev, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
    d.sync()
    return {'calls': ['XSendEvent(root, _NET_ACTIVE_WINDOW source=2)']}


def op_wm_state(wid):
    w = win(wid)
    st = w.get_full_property(WM_STATE, WM_STATE)
    ns = w.get_full_property(NET_WM_STATE, Xatom.ATOM)
    return {'parent': w.query_tree().parent.id, 'wmState': int(st.value[0]) if st else None,
            'netWmState': [d.get_atom_name(a) for a in ns.value] if ns else [],
            'override': bool(w.get_attributes().override_redirect)}


OPS = {'watch': op_watch, 'expect': op_expect, 'events': op_events, 'client_list': op_client_list,
       'toplevel': op_toplevel, 'activate': op_activate, 'wm_state': op_wm_state}
OPS.update({'shown': op_shown, 'want_electron': op_want_electron, 'guard': op_guard, 'guard_log': op_guard_log, 'find': op_find, 'dock': op_dock, 'fit': op_fit, 'park': op_park, 'focus': op_focus,
       'geom': op_geom, 'wait_frame': op_wait_frame, 'snap': op_snap, 'diff': op_diff,
       'overlay': op_overlay, 'overlay_fit': op_overlay_fit})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    rid = req.pop('id', None)
    op = req.pop('op')
    try:
        res = OPS[op](**req)
        out = {'id': rid, 'ok': True, 'result': res}
    except Exception as e:  # report and keep serving
        out = {'id': rid, 'ok': False, 'error': repr(e)}
    sys.stdout.write(json.dumps(out) + '\n')
    sys.stdout.flush()
