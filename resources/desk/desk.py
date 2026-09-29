"""Ember's computer-use daemon: Claude driving the Windows desktop.

Started by Ember (src/main/desk.ts), never by hand, with the port, the token and the
bridge in its environment. Keeps pyautogui / pywinauto / mss loaded so every `desk`
command from a shell is a thin TCP call. Reports each action to the bridge so Ember can
draw Claude's cursor and show what it is doing in the sidebar.

  python desk.py --serve      run (needs EMBER_DESK_PORT, EMBER_DESK_TOKEN)
  python desk.py --check      exit 0 if the libraries are installed, else print NEED_DEPS

Protocol: one JSON line per connection: {"argv": [...], "token": "...", "tab": "..."}
          reply {"ok": bool, "out": "..."}.
"""
import argparse, contextlib, ctypes, ctypes.wintypes as wt, io, json, os, re, shlex, shutil, socket, subprocess, sys, threading, time, traceback

DEPS = ("pyautogui", "pywinauto", "mss", "PIL", "pyperclip")
PORT = int(os.environ.get("EMBER_DESK_PORT", "0") or 0)
TOKEN = os.environ.get("EMBER_DESK_TOKEN", "")
BRIDGE = os.environ.get("EMBER_BRIDGE_URL", "")
BRIDGE_TOKEN = os.environ.get("EMBER_BRIDGE_TOKEN", "")
HOME = os.environ.get("EMBER_HOME") or os.path.join(os.path.expanduser("~"), ".ember")
HALT = os.path.join(HOME, "desk.halt")
SHOT_DIR = os.path.join(os.environ.get("TEMP", "."), "ember-desk-shots")
GLIDE = float(os.environ.get("EMBER_DESK_GLIDE", "0.12"))   # seconds for the drawn cursor to arrive before a click lands
FIND_TIMEOUT = float(os.environ.get("EMBER_DESK_FIND_TIMEOUT", "2"))   # how long a control may take to appear

HELP = """desk - Claude drives the desktop (screenshots, mouse, keys, UI Automation). Part of Ember.

  desk do "focus X; press X ^OK$; shot"                  many steps in ONE call (';' separated)
  desk shot [--window T|--full] [--scale 0.5] [--png]     screenshot -> image path (default: foreground window)
  desk windows                                            visible top-level windows (* = foreground)
  desk focus TITLE                                        bring a window to front (substring or ^exact$)
  desk wait TITLE [--timeout S]                           wait for a window to appear
  desk run CMD [ARGS...]                                  launch a program
  desk click X Y [--right] [--double]                     click at screen coords (from a shot's origin+scale)
  desk move X Y | desk drag X1 Y1 X2 Y2 | desk scroll N [X Y]
  desk type TEXT                                          type (long text is pasted)
  desk key COMBO [COMBO...]                               ctrl+s  alt+f4  enter  win+r
  desk tree TITLE [--depth N] [--all]                     UI Automation control tree (names, types, centres)
  desk find TITLE NAME [--type Button]                    one control -> centre + rect
  desk press TITLE NAME [--type Button]                   click a control by name, no coordinates
  desk settext TITLE NAME TEXT                            fill an edit control
  desk read TITLE [NAME]                                  visible text of a window / control
  desk clip [TEXT]                                        clipboard get / set
  desk sleep S                                            pause inside a batch
  desk halt | desk resume | desk status                   the same Stop button Ember shows in its sidebar
"""

# ----------------------------------------------------------------------------- helpers

_u32 = ctypes.windll.user32
_dwm = ctypes.windll.dwmapi
_EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
_current_tab = ""

def _cloaked(h):
    """UWP apps leave visible-but-cloaked shells (a CoreWindow at 0,0; the frame of a suspended
    app). They match by title, have an empty UI Automation tree and swallow every timeout."""
    c = ctypes.c_int(0)
    return _dwm.DwmGetWindowAttribute(ctypes.c_void_p(h), 14, ctypes.byref(c), 4) == 0 and c.value != 0

def _check_locked():
    """A locked session (or a UAC prompt) has no input desktop: trees are empty, BitBlt fails,
    and every lookup would run to its timeout. Say so in a millisecond instead."""
    d = _u32.OpenInputDesktop(0, False, 0x0001)
    if not d: raise SystemExit("LOCKED: the Windows session is locked (or a secure desktop is up). Unlock the machine, then try again.")
    _u32.CloseDesktop(d)

_reports = None
def _report(action, x=None, y=None, label=""):
    """Tell Ember what is happening: drawn cursor + sidebar indicator. Fire and forget, but
    in order: one worker drains a queue, so the strip's last label is the last action."""
    global _reports
    if not BRIDGE: return
    body = json.dumps({"action": action, "x": x, "y": y, "label": label[:120], "tab": _current_tab, "at": time.time()}).encode()
    if _reports is None:
        import queue, urllib.request
        _reports = queue.Queue()
        def pump():
            while True:
                b = _reports.get()
                try:
                    req = urllib.request.Request(BRIDGE + "/desk/activity", data=b, method="POST",
                                                 headers={"content-type": "application/json", "x-ember-token": BRIDGE_TOKEN})
                    urllib.request.urlopen(req, timeout=2).read()
                except Exception:
                    pass
        threading.Thread(target=pump, daemon=True).start()
    _reports.put(body)

def _mark(x, y, action="move", label="", wait=0.0):
    _report(action, int(x), int(y), label)
    if wait: time.sleep(wait)

_pg_mod = None
def _pg():
    global _pg_mod
    if _pg_mod is None:
        import pyautogui
        pyautogui.FAILSAFE = False; pyautogui.PAUSE = 0
        _pg_mod = pyautogui
    return _pg_mod

class _UserMouse:
    """Borrow the real pointer for one action, then hand it back to the person."""
    def __enter__(self):
        self.pg = _pg(); self.pos = self.pg.position(); return self
    def __exit__(self, *a):
        self.pg.moveTo(*self.pos)

def _enum_windows():
    out = []
    def cb(h, _):
        if _u32.IsWindowVisible(h) and not _cloaked(h):
            n = _u32.GetWindowTextLengthW(h)
            if n:
                buf = ctypes.create_unicode_buffer(n + 1); _u32.GetWindowTextW(h, buf, n + 1)
                out.append((h, buf.value))
        return True
    _u32.EnumWindows(_EnumProc(cb), 0)
    return out

def _title(h):
    n = _u32.GetWindowTextLengthW(h); buf = ctypes.create_unicode_buffer(n + 1); _u32.GetWindowTextW(h, buf, n + 1); return buf.value

_handle_cache = {}
def _hwnd(title, timeout=3):
    t = title.lower(); exact = t.startswith("^") and t.endswith("$")
    h = _handle_cache.get(t)
    if h and _u32.IsWindow(h) and _u32.IsWindowVisible(h) and not _cloaked(h): return h
    deadline = time.time() + timeout
    while True:
        for h, name in _enum_windows():
            n = name.lower()
            if (t[1:-1] == n) if exact else (t in n):
                _handle_cache[t] = h; return h
        if time.time() > deadline: raise SystemExit(f"no window matching {title!r}")
        time.sleep(0.1)

_desktop = None
def _uia():
    global _desktop
    if _desktop is None:
        from pywinauto import Desktop, timings
        _desktop = Desktop(backend="uia")
        # pywinauto sleeps after every click/focus and retries a missing control for 5 s; we
        # batch actions and do our own (shorter) retrying, so its pauses only cost time.
        T = timings.Timings
        T.after_click_wait = T.after_clickinput_wait = T.after_setfocus_wait = 0.02
        T.window_find_timeout = 0.3; T.window_find_retry = 0.05; T.exists_timeout = 0.2; T.exists_retry = 0.05
    return _desktop

_iuia_obj = None
def _iuia():
    """The raw UI Automation client pywinauto wraps: for one-round-trip searches and cached trees."""
    global _iuia_obj
    if _iuia_obj is None:
        _uia()
        from pywinauto.uia_defines import IUIA
        _iuia_obj = IUIA()
    return _iuia_obj

_ctype_names = None
def _ctype_name(tid):
    global _ctype_names
    if _ctype_names is None: _ctype_names = {v: k for k, v in _iuia().known_control_types.items()}
    return _ctype_names.get(tid, str(tid))

def _wrap(raw):
    from pywinauto.uia_element_info import UIAElementInfo
    from pywinauto.controls.uiawrapper import UIAWrapper
    return UIAWrapper(UIAElementInfo(raw))

def _win(title, timeout=3):
    return _uia().window(handle=_hwnd(title, timeout))

def _rect(h):
    r = wt.RECT(); _u32.GetWindowRect(h, ctypes.byref(r)); return r.left, r.top, r.right, r.bottom

def _check_halt():
    if os.path.exists(HALT): raise SystemExit("HALTED: the Stop button in Ember was pressed. `desk resume` (or the Resume button) lifts it.")

# ----------------------------------------------------------------------------- commands

_sct = None
def cmd_shot(a):
    global _sct
    import mss
    from PIL import Image
    if _sct is None: _sct = mss.mss()
    if a.window: h = _hwnd(a.window)
    elif a.full: h = None
    else: h = _u32.GetForegroundWindow()
    mon = _sct.monitors[0]; region = mon
    if h:
        l, t, r, b = _rect(h)
        l, t = max(l, mon["left"]), max(t, mon["top"])
        r, b = min(r, mon["left"] + mon["width"]), min(b, mon["top"] + mon["height"])
        if r - l > 50 and b - t > 50: region = {"left": l, "top": t, "width": r - l, "height": b - t}
    _report("look", label=f"look at {_title(h) if h else 'the screen'}")
    raw = _sct.grab(region)
    img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
    sc = a.scale or 1
    if sc != 1: img = img.resize((max(1, int(img.width * sc)), max(1, int(img.height * sc))), Image.BOX)
    ext = "png" if a.png else "jpg"
    os.makedirs(SHOT_DIR, exist_ok=True)
    out = a.out or os.path.join(SHOT_DIR, time.strftime("%H%M%S") + f"-{int(time.time()*1000)%1000:03d}.{ext}")
    if ext == "jpg": img.save(out, quality=82)
    else: img.save(out)
    print(json.dumps({"path": out, "origin": [region["left"], region["top"]], "size": [img.width, img.height], "scale": sc}))

def cmd_windows(a):
    fg = _u32.GetForegroundWindow()
    for h, name in _enum_windows():
        l, t, r, b = _rect(h)
        if r - l <= 0 or b - t <= 0: continue
        print(f"{h:>9}  {l:>5},{t:>5} {r-l:>5}x{b-t:<5} {'*' if h == fg else ' '} {name}")

def cmd_focus(a):
    h = _hwnd(a.title)
    if _u32.IsIconic(h): _u32.ShowWindow(h, 9)
    _u32.SetForegroundWindow(h)
    if _u32.GetForegroundWindow() != h: _win(a.title).set_focus()
    l, t, r, b = _rect(h); _report("focus", (l + r) // 2, t + 20, f"focus {_title(h)}")
    print("focused:", _title(h))

def cmd_wait(a):
    _hwnd(a.title, timeout=a.timeout); print("found:", a.title)

def cmd_sleep(a):
    time.sleep(a.seconds)

def cmd_run(a):
    cmd = [c for c in a.cmd if c != "--"]
    if not cmd: raise SystemExit("run: what should start?")
    exe = shutil.which(cmd[0])
    if exe: subprocess.Popen([exe] + cmd[1:])
    else:
        # Not on PATH: let the shell resolve it the way the Start menu does (App Paths: chrome,
        # calc, ms-settings:, a document, a URL).
        subprocess.Popen('start "" ' + subprocess.list2cmdline(cmd), shell=True)
    _report("run", label=f"start {cmd[0]}")
    print("started:", " ".join(cmd))

def cmd_click(a):
    _mark(a.x, a.y, "move", f"click at {a.x},{a.y}", wait=GLIDE)
    with _UserMouse() as m:
        pg = m.pg; pg.moveTo(a.x, a.y)
        if a.double: pg.doubleClick(a.x, a.y)
        else: pg.click(a.x, a.y, button="right" if a.right else "left")
    _mark(a.x, a.y, "click", f"click at {a.x},{a.y}")
    print(f"clicked {a.x},{a.y}")

def cmd_move(a):
    _mark(a.x, a.y, "move", "move"); print(f"moved {a.x},{a.y}")

def cmd_drag(a):
    _mark(a.x1, a.y1, "move", "drag", wait=GLIDE); _mark(a.x1, a.y1, "drag", "drag")
    with _UserMouse() as m:
        m.pg.moveTo(a.x1, a.y1); _mark(a.x2, a.y2, "drag", "drag")
        m.pg.dragTo(a.x2, a.y2, duration=0.3, button="left")
    print(f"dragged {a.x1},{a.y1} -> {a.x2},{a.y2}")

def cmd_scroll(a):
    with _UserMouse() as m:
        if a.x is not None: _mark(a.x, a.y, "move", "scroll", wait=GLIDE); m.pg.moveTo(a.x, a.y)
        m.pg.scroll(a.n * 120)
    _report("scroll", label=f"scroll {'up' if a.n > 0 else 'down'}")
    print(f"scrolled {a.n}")

def cmd_type(a):
    pg = _pg(); text = " ".join(a.text)
    _report("type", label=f"type {len(text)} chars")
    if len(text) <= 24 and all(ord(c) < 128 for c in text):
        pg.write(text, interval=0)
    else:
        import pyperclip
        old = None
        try: old = pyperclip.paste()
        except Exception: pass
        pyperclip.copy(text); pg.hotkey("ctrl", "v"); time.sleep(0.05)
        if old is not None:
            try: pyperclip.copy(old)
            except Exception: pass
    print(f"typed {len(text)} chars")

def cmd_key(a):
    pg = _pg()
    _report("type", label="press " + " ".join(a.combo))
    for combo in a.combo:
        keys = [k.strip().lower() for k in combo.split("+")]
        pg.hotkey(*keys) if len(keys) > 1 else pg.press(keys[0])
    print("pressed:", " ".join(a.combo))

_ACTIONABLE = ("Button", "Edit", "ComboBox", "CheckBox", "MenuItem", "TabItem", "ListItem", "Hyperlink", "RadioButton", "TreeItem", "SplitButton", "Slider")
def _walk(el, depth, max_depth, show_all, out):
    try:
        r = el.rectangle(); name = el.window_text(); ctype = el.element_info.control_type
    except Exception:
        return
    if show_all or ctype in _ACTIONABLE or (name and ctype in ("Text", "Document", "Window", "Pane")):
        out.append(f"{'  '*depth}[{ctype}] {name!r}  @({r.left},{r.top},{r.right},{r.bottom}) c=({(r.left+r.right)//2},{(r.top+r.bottom)//2})")
    if depth < max_depth:
        try:
            for c in el.children(): _walk(c, depth + 1, max_depth, show_all, out)
        except Exception:
            pass

def _dump(h, max_depth, show_all, out):
    """The control tree of window h in ONE cross-process call (a cache request over the whole
    subtree), where walking children() node by node cost a COM round trip per node -- seconds
    on a web page. Same line format as _walk."""
    ui = _iuia(); dll = ui.UIA_dll
    cr = ui.iuia.CreateCacheRequest()
    for pid in (dll.UIA_NamePropertyId, dll.UIA_ControlTypePropertyId, dll.UIA_BoundingRectanglePropertyId, dll.UIA_ValueValuePropertyId): cr.AddProperty(pid)
    cr.TreeScope = ui.tree_scope["subtree"]
    cr.TreeFilter = ui.iuia.ControlViewCondition
    root = ui.iuia.ElementFromHandle(h).BuildUpdatedCache(cr)
    def walk(e, depth):
        try:
            name = e.CachedName or ""; ctype = _ctype_name(e.CachedControlType); r = e.CachedBoundingRectangle
        except Exception:
            return
        if show_all or ctype in _ACTIONABLE or (name and ctype in ("Text", "Document", "Window", "Pane", "Group", "Image", "Custom")):
            line = f"{'  '*depth}[{ctype}] {name!r}  @({r.left},{r.top},{r.right},{r.bottom}) c=({(r.left+r.right)//2},{(r.top+r.bottom)//2})"
            if ctype in ("Edit", "ComboBox", "Document"):
                try:
                    v = e.GetCachedPropertyValue(dll.UIA_ValueValuePropertyId)
                    if v and v != name: line += f"  = {str(v)[:200]!r}"
                except Exception:
                    pass
            out.append(line)
        if depth < max_depth:
            try: kids = e.GetCachedChildren(); n = kids.Length
            except Exception: return   # a leaf: NULL pointer, no .Length
            for i in range(n): walk(kids.GetElement(i), depth + 1)
    walk(root, 0)

def _tree_lines(title, depth, show_all):
    h = _hwnd(title); out = []
    try: _dump(h, depth, show_all, out)
    except Exception:
        out = []; _walk(_win(title).wrapper_object(), 0, depth, show_all, out)
    return out

def cmd_tree(a):
    _report("look", label=f"read {a.title}")
    print("\n".join(_tree_lines(a.title, a.depth, a.all)))

_META = re.compile(r"[.*+?\[\](){}|\\]")
def _find_all(h, name, ctype):
    """Every descendant of window h whose name matches, in one cross-process call: the name
    (when it is a plain ^literal$) and the control type go into the UIA condition, and the
    rest of the filtering runs on cached properties, so a web page with thousands of nodes
    costs one round trip instead of one per node."""
    ui = _iuia(); dll = ui.UIA_dll
    exact = name.startswith("^") and name.endswith("$") and not _META.search(name[1:-1])
    conds = []
    if exact: conds.append(ui.iuia.CreatePropertyCondition(dll.UIA_NamePropertyId, name[1:-1]))
    if ctype:
        tid = ui.known_control_types.get(ctype)
        if tid is None: raise SystemExit(f"unknown control type {ctype!r}; try Button, Edit, Hyperlink, ListItem, MenuItem, Text, ...")
        conds.append(ui.iuia.CreatePropertyCondition(dll.UIA_ControlTypePropertyId, tid))
    cond = ui.true_condition if not conds else conds[0] if len(conds) == 1 else ui.iuia.CreateAndCondition(conds[0], conds[1])
    cr = ui.iuia.CreateCacheRequest()
    for pid in (dll.UIA_NamePropertyId, dll.UIA_BoundingRectanglePropertyId, dll.UIA_IsOffscreenPropertyId): cr.AddProperty(pid)
    root = ui.iuia.ElementFromHandle(h)
    arr = root.FindAllBuildCache(ui.tree_scope["descendants"], cond, cr)
    pat = None if exact else re.compile(name if name.startswith("^") else f".*{name}.*")
    out = []
    for i in range(arr.Length):
        e = arr.GetElement(i)
        if pat is not None and not pat.match(e.CachedName or ""): continue
        out.append(e)
    return out

def _pick(cands, h):
    """Several controls share a name (web pages love that): prefer one that is on screen, inside the window."""
    if len(cands) == 1: return cands[0]
    wl, wt_, wr, wb = _rect(h)
    def onscreen(e):
        try:
            if e.CachedIsOffscreen: return False
            r = e.CachedBoundingRectangle
            return r.right > r.left and r.bottom > r.top and r.right > wl and r.left < wr and r.bottom > wt_ and r.top < wb
        except Exception:
            return False
    good = [e for e in cands if onscreen(e)]
    return (good or cands)[0]

def _ctrl(a, name=None, ctype=None):
    """One control of a window, resolved once. (A pywinauto WindowSpecification re-searches the
    whole tree on every attribute access, and waited a fixed 3 s when nothing matched.)"""
    name = a.name if name is None else name
    ctype = getattr(a, "type", None) if ctype is None else ctype
    w = _win(a.title); h = _hwnd(a.title)
    deadline = time.time() + FIND_TIMEOUT
    while True:
        try:
            cands = _find_all(h, name, ctype)
        except SystemExit:
            raise
        except Exception:
            # Raw UIA misbehaved: pywinauto's own search, once.
            kw = {"title_re": name if name.startswith("^") else f".*{name}.*"}
            if ctype: kw["control_type"] = ctype
            return w, w.child_window(**kw).wrapper_object()
        if cands: return w, _wrap(_pick(cands, h))
        if time.time() > deadline:
            raise SystemExit(f"no control matching {name!r}" + (f" of type {ctype}" if ctype else "") + f" in {_title(h)!r} -- `desk tree` shows what is there")
        time.sleep(0.1)

def cmd_find(a):
    _, c = _ctrl(a); r = c.rectangle()
    print(json.dumps({"name": c.window_text(), "type": c.element_info.control_type,
                      "center": [(r.left+r.right)//2, (r.top+r.bottom)//2], "rect": [r.left, r.top, r.right, r.bottom]}))

def cmd_press(a):
    w, c = _ctrl(a)
    h = _hwnd(a.title)
    if _u32.GetForegroundWindow() != h: w.set_focus()
    r = c.rectangle(); cx, cy = (r.left+r.right)//2, (r.top+r.bottom)//2
    label = f"press {c.window_text() or a.name} in {_title(h)}"
    _mark(cx, cy, "move", label, wait=GLIDE)
    try: c.invoke()
    except Exception:
        with _UserMouse(): c.click_input()
    _mark(cx, cy, "click", label)
    print("pressed:", c.window_text())

def cmd_settext(a):
    w, c = _ctrl(a); w.set_focus()
    r = c.rectangle(); _mark((r.left+r.right)//2, (r.top+r.bottom)//2, "type", f"fill {c.window_text() or a.name}")
    try: c.set_edit_text(" ".join(a.text))
    except Exception:
        with _UserMouse(): c.click_input()
        _pg().hotkey("ctrl", "a"); _pg().write(" ".join(a.text))
    print("set:", " ".join(a.text))

def cmd_read(a):
    _report("look", label=f"read {a.title}")
    if a.name:
        _, c = _ctrl(a, name=a.name, ctype="")
        try: v = c.get_value()
        except Exception: v = None
        print(v if v else c.window_text())
        return
    print("\n".join(l for l in _tree_lines(a.title, 25, True) if "''" not in l))

def cmd_clip(a):
    import pyperclip
    if a.text: pyperclip.copy(" ".join(a.text)); print("copied")
    else: print(pyperclip.paste())

# ----------------------------------------------------------------------------- parser / dispatch

def build_parser():
    p = argparse.ArgumentParser(prog="desk", add_help=False)
    s = p.add_subparsers(dest="cmd", required=True)
    x = s.add_parser("shot"); x.add_argument("--window"); x.add_argument("--full", action="store_true"); x.add_argument("--out"); x.add_argument("--scale", type=float, default=0.5); x.add_argument("--png", action="store_true"); x.set_defaults(f=cmd_shot)
    s.add_parser("windows").set_defaults(f=cmd_windows)
    x = s.add_parser("focus"); x.add_argument("title"); x.set_defaults(f=cmd_focus)
    x = s.add_parser("wait"); x.add_argument("title"); x.add_argument("--timeout", type=float, default=10); x.set_defaults(f=cmd_wait)
    x = s.add_parser("sleep"); x.add_argument("seconds", type=float); x.set_defaults(f=cmd_sleep)
    x = s.add_parser("run"); x.add_argument("cmd", nargs=argparse.REMAINDER); x.set_defaults(f=cmd_run)
    x = s.add_parser("click"); x.add_argument("x", type=int); x.add_argument("y", type=int); x.add_argument("--right", action="store_true"); x.add_argument("--double", action="store_true"); x.set_defaults(f=cmd_click)
    x = s.add_parser("move"); x.add_argument("x", type=int); x.add_argument("y", type=int); x.set_defaults(f=cmd_move)
    x = s.add_parser("drag"); [x.add_argument(n, type=int) for n in ("x1", "y1", "x2", "y2")]; x.set_defaults(f=cmd_drag)
    x = s.add_parser("scroll"); x.add_argument("n", type=int); x.add_argument("x", type=int, nargs="?"); x.add_argument("y", type=int, nargs="?"); x.set_defaults(f=cmd_scroll)
    x = s.add_parser("type"); x.add_argument("text", nargs="+"); x.set_defaults(f=cmd_type)
    x = s.add_parser("key"); x.add_argument("combo", nargs="+"); x.set_defaults(f=cmd_key)
    x = s.add_parser("tree"); x.add_argument("title"); x.add_argument("--depth", type=int, default=8); x.add_argument("--all", action="store_true"); x.set_defaults(f=cmd_tree)
    for n, f in (("find", cmd_find), ("press", cmd_press)):
        x = s.add_parser(n); x.add_argument("title"); x.add_argument("name"); x.add_argument("--type"); x.set_defaults(f=f)
    x = s.add_parser("settext"); x.add_argument("title"); x.add_argument("name"); x.add_argument("text", nargs="+"); x.add_argument("--type", default="Edit"); x.set_defaults(f=cmd_settext)
    x = s.add_parser("read"); x.add_argument("title"); x.add_argument("name", nargs="?"); x.set_defaults(f=cmd_read)
    x = s.add_parser("clip"); x.add_argument("text", nargs="*"); x.set_defaults(f=cmd_clip)
    return p

_parser = None
def dispatch(argv):
    global _parser
    if _parser is None: _parser = build_parser()
    buf = io.StringIO(); ok = True
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        try:
            _check_halt(); _check_locked()
            a = _parser.parse_args(argv); a.f(a)
        except SystemExit as e:
            ok = e.code in (0, None)
            if not ok and not isinstance(e.code, int): print(e.code)
        except Exception:
            ok = False; traceback.print_exc()
    return ok, buf.getvalue()

def run_batch(script):
    toks = shlex.split(script, posix=True) if isinstance(script, str) else list(script)
    steps, cur = [], []
    for t in toks:
        if t == ";": steps.append(cur); cur = []
        elif t.endswith(";") and len(t) > 1: cur.append(t[:-1]); steps.append(cur); cur = []
        else: cur.append(t)
    if cur: steps.append(cur)
    outs = []; ok = True
    for st in steps:
        if not st: continue
        ok, out = dispatch(st); outs.append(out.rstrip())
        if not ok: outs.append(f"!! batch stopped at: {' '.join(st)}"); break
    return ok, "\n".join(o for o in outs if o)

# ----------------------------------------------------------------------------- server

def _watch_parent():
    """Die with Ember. A killed parent leaves no signal on Windows, so poll its handle."""
    pid = int(os.environ.get("EMBER_PID", "0") or 0)
    if not pid: return
    h = ctypes.windll.kernel32.OpenProcess(0x100000, False, pid)  # SYNCHRONIZE
    if not h: return
    def go():
        ctypes.windll.kernel32.WaitForSingleObject(h, 0xFFFFFFFF)
        os._exit(0)
    threading.Thread(target=go, daemon=True).start()

def check_deps():
    missing = []
    for m in DEPS:
        try: __import__(m)
        except Exception: missing.append("pillow" if m == "PIL" else m)
    return missing

def serve():
    global _current_tab
    if not PORT or not TOKEN:
        print("desk.py is started by Ember; it needs EMBER_DESK_PORT and EMBER_DESK_TOKEN", file=sys.stderr); sys.exit(2)
    missing = check_deps()
    if missing:
        print("NEED_DEPS " + " ".join(missing), flush=True); sys.exit(3)
    try: ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception: pass
    _watch_parent()
    srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", PORT)); srv.listen(5)
    try: _pg(); _uia(); import mss, PIL.Image  # warm up
    except Exception: traceback.print_exc()
    print("READY", flush=True)
    while True:
        conn, _ = srv.accept()
        raw = False
        try:
            conn.settimeout(120)
            data = b""
            while not data.endswith(b"\n"):
                chunk = conn.recv(65536)
                if not chunk: break
                data += chunk
            if not data.strip(): continue   # a connection probe (the shell client checks before it talks)
            req = json.loads(data.decode("utf-8"))
            raw = bool(req.get("raw"))   # the shell client wants "OK|ERR\n" + text, not JSON
            if req.get("token") != TOKEN:
                conn.sendall(b'ERR\ndesk only works inside an Ember shell\n' if raw else b'{"ok":false,"out":"desk only works inside an Ember shell"}\n'); continue
            argv = req.get("argv", []); _current_tab = str(req.get("tab", ""))
            if argv[:1] == ["__ping__"]: ok, out = True, "pong"
            elif argv[:1] == ["__quit__"]:
                conn.sendall(b'{"ok":true,"out":"bye"}\n'); conn.close(); break
            elif argv[:1] == ["do"]: ok, out = run_batch(argv[1] if len(argv) == 2 else argv[1:])
            elif argv[:1] in (["-h"], ["--help"], ["help"], []): ok, out = True, HELP
            else: ok, out = dispatch(argv)
            if raw: conn.sendall((("OK" if ok else "ERR") + "\n" + out.rstrip() + "\n").encode("utf-8"))
            else: conn.sendall((json.dumps({"ok": ok, "out": out}) + "\n").encode("utf-8"))
        except Exception:
            traceback.print_exc()
            try: conn.sendall((("ERR\n" + traceback.format_exc()) if raw else (json.dumps({"ok": False, "out": traceback.format_exc()}) + "\n")).encode("utf-8"))
            except Exception: pass
        finally:
            try: conn.close()
            except Exception: pass

if __name__ == "__main__":
    if sys.argv[1:2] == ["--serve"]: serve()
    elif sys.argv[1:2] == ["--check"]:
        m = check_deps(); print("NEED_DEPS " + " ".join(m) if m else "OK"); sys.exit(3 if m else 0)
    else: print(HELP)
