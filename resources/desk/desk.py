"""Ember's computer-use daemon: Claude driving the Windows desktop.

Started by Ember (src/main/desk.ts), never by hand, with the port, the token and the
bridge in its environment. Keeps pyautogui / pywinauto / mss loaded so every `desk`
command from a shell is a thin TCP call. Reports each action to the bridge so Ember can
draw Claude's cursor and show what it is doing in the sidebar.

  python desk.py --serve      run (needs EMBER_DESK_PORT, EMBER_DESK_TOKEN)
  python desk.py --check      exit 0 if the libraries are installed, else print NEED_DEPS

Protocol: one JSON line per connection: {"argv": [...], "token": "...", "tab": "..."}
          reply {"ok": bool, "out": "..."}.

What it may do is Ember's to say, not the shell's. The first line on stdin, written by
Ember as it starts the daemon, is {"control": "...", "mode": "off|show|act", "halted": bool};
afterwards Ember sends the same shape over the socket whenever the setting or Stop changes.
The control token never reaches a shell, so a session holding the shell token can ask for
work but cannot change what work is allowed. Until Ember says otherwise the mode is "off".
"""
import argparse, contextlib, ctypes, ctypes.wintypes as wt, hmac, io, json, math, os, re, shlex, shutil, socket, subprocess, sys, threading, time, traceback

DEPS = ("pyautogui", "pywinauto", "mss", "PIL", "pyperclip")
PORT = int(os.environ.get("EMBER_DESK_PORT", "0") or 0)
TOKEN = os.environ.get("EMBER_DESK_TOKEN", "")
BRIDGE = os.environ.get("EMBER_BRIDGE_URL", "")
BRIDGE_TOKEN = os.environ.get("EMBER_BRIDGE_TOKEN", "")
HOME = os.environ.get("EMBER_HOME") or os.path.join(os.path.expanduser("~"), ".ember")
HALT = os.path.join(HOME, "desk.halt")
SHOT_DIR = os.path.join(os.environ.get("TEMP", "."), "ember-desk-shots")
GLIDE = float(os.environ.get("EMBER_DESK_GLIDE", "1"))   # 0 turns the wait for the drawn cursor off; anything else = on
SNAP_TTL = 0.7          # seconds a window's cached UI Automation tree stays good for a lookup
READ_AHEAD_MAX_MS = 300  # windows whose tree takes longer than this to read are not read ahead
FIND_TIMEOUT = float(os.environ.get("EMBER_DESK_FIND_TIMEOUT", "2"))   # how long a control may take to appear

HELP = """desk - Claude drives the desktop (screenshots, mouse, keys, UI Automation). Part of Ember.

  desk do "focus X; press #4; type hi"                   many steps in ONE call (';' or one per line);
                                                          ends with what is on screen now, numbered
      in a do, also:  wait "Save As" [5s] | wait [Button] "Save" | wait gone "Saving" | wait title "x"
                      expect <condition> [2s]   (not met: the plan stops, says why, shows the screen)
                      if <condition> then <step> [else <step>]
                      press [Button] "Save" [in "Save As"] | settext [Edit] "File name:" "a.txt" | click "OK"
  desk recipe list | show NAME | run NAME [ARGS] | save NAME   replay a plan that worked ($1.. = ARGS)
  desk shot [--window T|--full] [--scale 0.5] [--png]     screenshot -> image path (default: foreground window)
  desk windows                                            visible top-level windows (* = foreground)
  desk focus TITLE                                        bring a window to front (substring or ^exact$)
  desk wait TITLE [--timeout S]                           wait for a window to appear
  desk run CMD [ARGS...]                                  launch a program
  desk click X Y | desk click #N [--right] [--double]     click at screen coords, or on a numbered control
  desk move X Y | desk drag X1 Y1 X2 Y2 | desk scroll N [X Y]
  desk type TEXT                                          type (long text is pasted)
  desk key COMBO [COMBO...]                               ctrl+s  alt+f4  enter  win+r
  desk tree TITLE [--depth N] [--all]                     the window's controls, numbered: #N [Type] 'name' (x,y)
  desk find TITLE NAME [--type Button]                    one control -> centre + rect
  desk press TITLE NAME [--type Button] | desk press #N   click a control by name or by its number
  desk settext TITLE NAME TEXT | desk settext #N TEXT     fill an edit control
  desk read TITLE [NAME]                                  visible text of a window / control
  desk clip [TEXT]                                        clipboard get / set
  desk point TITLE NAME [--say TEXT] | desk point --xy X Y [--say TEXT]   show where something is (never clicks)
  desk bench                                              time the read-only paths (no mouse, no keys)
  desk sleep S                                            pause inside a batch
  desk halt | desk status                                 the same Stop button Ember shows in its sidebar
                                                          (only you can lift it, with Resume in Ember)
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

EMBER_PID = int(os.environ.get("EMBER_PID", "0") or 0)
_k32 = ctypes.windll.kernel32

def _pid_of(h):
    pid = wt.DWORD(0); _u32.GetWindowThreadProcessId(ctypes.c_void_p(h), ctypes.byref(pid)); return pid.value

def _ember_chrome(h):
    """Ember's own see-through windows (the pointer overlay and the step-aside card it
    carries): never activatable, owned by Ember. Left out of every list, so the session
    never reads, finds or targets them."""
    if not EMBER_PID or _pid_of(h) != EMBER_PID: return False
    return bool(_u32.GetWindowLongW(ctypes.c_void_p(h), -20) & 0x08000000)   # WS_EX_NOACTIVATE

_exe_cache = {}
def _exe(h):
    pid = _pid_of(h)
    if pid in _exe_cache: return _exe_cache[pid]
    name = ""
    hp = _k32.OpenProcess(0x1000, False, pid)   # PROCESS_QUERY_LIMITED_INFORMATION
    if hp:
        buf = ctypes.create_unicode_buffer(520); n = wt.DWORD(520)
        if _k32.QueryFullProcessImageNameW(hp, 0, buf, ctypes.byref(n)): name = os.path.basename(buf.value)
        _k32.CloseHandle(hp)
    _exe_cache[pid] = name
    return name

def _app_of(h):
    """Which app a window belongs to, in words: 'Notepad' for 'Untitled - Notepad', and a
    dialog's owner for the dialog ('Save As' in Notepad is Notepad's)."""
    if not h: return {}
    try:
        owner = _u32.GetWindow(ctypes.c_void_p(h), 4)   # GW_OWNER
        top = owner or h
        title = _title(top)
        app = title.rsplit(" - ", 1)[-1] if " - " in title else (title or os.path.splitext(_exe(top))[0])
        return {"app": app[:40], "exe": _exe(top), "win": _title(h)[:80], "own": bool(EMBER_PID) and _pid_of(top) == EMBER_PID}
    except Exception:
        return {}

_reports = None
def _report(action, x=None, y=None, label="", h=None):
    """Tell Ember what is happening: drawn cursor + sidebar indicator + which app it is in.
    Fire and forget, but in order: one worker drains a queue, so the strip's last label is
    the last action. h: the window acted on (default: the one in front)."""
    global _reports
    if not BRIDGE: return
    info = _app_of(h or _u32.GetForegroundWindow())
    body = json.dumps({"action": action, "x": x, "y": y, "label": label[:120], "tab": _current_tab, "at": time.time(), **info}).encode()
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

# Ember draws its pointer gliding to each point; the real click must land when it arrives,
# not before. Both sides compute the glide from the same formula (distance in physical
# pixels -> 140..480 ms, Fitts-like), so no handshake is needed: the daemon just waits that long.
_last_xy = None
_last_at = 0.0
def _glide_ms(x, y):
    global _last_xy, _last_at
    now = time.time()
    if _last_xy is None or now - _last_at > 20: dist = 160.0   # appearing: a short glide in
    else: dist = math.hypot(x - _last_xy[0], y - _last_xy[1])
    _last_xy = (x, y); _last_at = now
    if dist < 2: return 0.0
    return max(140.0, min(480.0, 140.0 + 75.0 * math.log2(1.0 + dist / 60.0)))

def _mark(x, y, action="move", label="", wait=0.0, h=None):
    ms = _glide_ms(int(x), int(y))
    _report(action, int(x), int(y), label, h)
    if wait and GLIDE and ms: time.sleep(ms / 1000.0 + 0.02)

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
        if _u32.IsWindowVisible(h) and not _cloaked(h) and not _ember_chrome(h):
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

# Set by Ember (see the header): the control token, the Hands setting, the Stop switch.
CONTROL = ""
MODE = "off"
HALTED = False

def _halted():
    # The file is a mirror for anyone looking from outside; what Ember told this process is
    # the authority, so deleting the file lifts nothing.
    return HALTED or os.path.exists(HALT)

# What 'show' allows: looking, and Ember's own pointer. Nothing that moves the real mouse,
# presses a key, changes a window or the clipboard, or starts a program.
_LOOKS = {"shot", "windows", "wait", "sleep", "tree", "find", "read", "point", "bench"}

def _is_look(argv):
    if not argv: return True
    if argv[0] == "clip": return len(argv) == 1   # reading the clipboard is a look; setting it is not
    if argv[0] == "recipe": return argv[1:2] in (["list"], ["show"])   # running one acts
    return argv[0] in _LOOKS

def _check_allowed(argv):
    if _halted(): raise SystemExit("HALTED: the Stop button in Ember was pressed. Only the person at the machine can lift it, with Resume in Ember.")
    if MODE == "off": raise SystemExit("Computer use is off in Ember (Ctrl+K -> Computer use).")
    if MODE != "act" and not _is_look(argv):
        raise SystemExit(f"Computer use is set to Show in Ember: pointing and looking only, no {argv[0]}. Clicking and typing need it set to Act (Ctrl+K -> Computer use).")

def _take_control(req):
    """A settings change from Ember. Ignored unless it carries the control token."""
    global MODE, HALTED
    if not CONTROL or not hmac.compare_digest(str(req.get("control", "")).encode(), CONTROL.encode()): return False
    m = req.get("mode")
    if m in ("off", "show", "act"): MODE = m
    if "halted" in req: HALTED = bool(req.get("halted"))
    return True

def _read_control():
    """The first line on stdin, from Ember. Nothing there (started by hand) leaves it off."""
    try:
        line = sys.stdin.readline() if sys.stdin else ""
        req = json.loads(line) if line.strip() else {}
    except Exception:
        req = {}
    global CONTROL
    CONTROL = str(req.get("control", ""))
    _take_control(req)

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
    l, t, r, b = _rect(h); _report("focus", (l + r) // 2, t + 20, f"focus {_title(h)}", h)
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
    h = None
    if _is_ref(a.x):
        h, _, cx, cy, name, _ = _ref(a.x)
        if h and _u32.GetForegroundWindow() != h: _u32.SetForegroundWindow(h)
        a.x, a.y = cx, cy
    else:
        try: a.x, a.y = int(a.x), int(a.y)
        except (TypeError, ValueError): raise SystemExit("click: X Y, or #N")
    _mark(a.x, a.y, "move", f"click at {a.x},{a.y}", wait=GLIDE, h=h)
    with _UserMouse() as m:
        pg = m.pg; pg.moveTo(a.x, a.y)
        if a.double: pg.doubleClick(a.x, a.y)
        else: pg.click(a.x, a.y, button="right" if a.right else "left")
    _mark(a.x, a.y, "click", f"click at {a.x},{a.y}", h=h)
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
    if (r.right > r.left and r.bottom > r.top) and (show_all or ctype in _ACTIONABLE or (name and ctype in ("Text", "Document", "Window", "Pane"))):
        n = len(_refs) + 1
        _refs[n] = (None, el, (r.left+r.right)//2, (r.top+r.bottom)//2, name, ctype)
        out.append(_ref_line(n, depth, ctype, name, r))
    if depth < max_depth:
        try:
            for c in el.children(): _walk(c, depth + 1, max_depth, show_all, out)
        except Exception:
            pass

# The controls of the last list read (tree, or the "now" after a batch): #N -> one of them.
_refs = {}

def _ref_line(n, depth, ctype, name, r, value=None):
    line = f"{' '*depth}#{n} [{ctype}] {name!r} ({(r.left+r.right)//2},{(r.top+r.bottom)//2})"
    if value: line += f" = {str(value)[:160]!r}"
    return line

def _dump(h, max_depth, show_all, out, numbered=True):
    """The control tree of window h in ONE cross-process call (a cache request over the whole
    subtree), where walking children() node by node cost a COM round trip per node -- seconds
    on a web page. Same line format as _walk."""
    ui = _iuia(); dll = ui.UIA_dll
    cr = ui.iuia.CreateCacheRequest()
    for pid in (dll.UIA_NamePropertyId, dll.UIA_ControlTypePropertyId, dll.UIA_BoundingRectanglePropertyId, dll.UIA_ValueValuePropertyId): cr.AddProperty(pid)
    cr.TreeScope = ui.tree_scope["subtree"]
    cr.TreeFilter = ui.iuia.ControlViewCondition
    t0 = time.time()
    root = ui.iuia.ElementFromHandle(h).BuildUpdatedCache(cr)
    _snap_ms[h] = (time.time() - t0) * 1000
    if numbered: _refs.clear()
    def walk(e, depth):
        try:
            name = e.CachedName or ""; ctype = _ctype_name(e.CachedControlType); r = e.CachedBoundingRectangle
        except Exception:
            return
        # Nothing to see (no size) is nothing to act on: left out, its children still walked.
        sized = r.right > r.left and r.bottom > r.top
        if sized and (show_all or ctype in _ACTIONABLE or (name and ctype in ("Text", "Document", "Window", "Pane", "Group", "Image", "Custom"))):
            v = None
            if ctype in ("Edit", "ComboBox", "Document"):
                try:
                    v = e.GetCachedPropertyValue(dll.UIA_ValueValuePropertyId)
                    if v == name: v = None
                except Exception:
                    v = None
            n = len(_refs) + 1
            _refs[n] = (h, e, (r.left+r.right)//2, (r.top+r.bottom)//2, name, ctype)
            out.append(_ref_line(n, depth, ctype, name, r, v))
        if depth < max_depth:
            try: kids = e.GetCachedChildren(); n = kids.Length
            except Exception: return   # a leaf: NULL pointer, no .Length
            for i in range(n): walk(kids.GetElement(i), depth + 1)
    walk(root, 0)

# A window's control tree, read once over one cross-process call, kept for SNAP_TTL and
# dropped by any action. find/press search it in-process instead of asking UIA again, and
# after each action the foreground window is read ahead so the next lookup is already warm.
_snap = {}      # hwnd -> (taken_at, cached_root)
_snap_ms = {}   # hwnd -> how long its last read took (ms)
def _snap_request(ui, dll):
    cr = ui.iuia.CreateCacheRequest()
    for pid in (dll.UIA_NamePropertyId, dll.UIA_ControlTypePropertyId, dll.UIA_BoundingRectanglePropertyId,
                dll.UIA_IsOffscreenPropertyId, dll.UIA_ValueValuePropertyId):
        cr.AddProperty(pid)
    cr.TreeScope = ui.tree_scope["subtree"]
    cr.TreeFilter = ui.iuia.ControlViewCondition
    return cr

def _snapshot(h, build=False):
    got = _snap.get(h)
    if got and time.time() - got[0] < SNAP_TTL: return got[1]
    if not build: return None
    ui = _iuia(); dll = ui.UIA_dll
    t0 = time.time()
    root = ui.iuia.ElementFromHandle(h).BuildUpdatedCache(_snap_request(ui, dll))
    _snap_ms[h] = (time.time() - t0) * 1000
    _snap[h] = (time.time(), root)
    return root

def _invalidate():
    _snap.clear()

def _find_cached(root, name, ctype):
    """Matches in a cached tree: no cross-process calls at all."""
    ui = _iuia()
    exact = name.startswith("^") and name.endswith("$") and not _META.search(name[1:-1])
    pat = None if exact else re.compile(name if name.startswith("^") else f".*{name}.*")
    tid = ui.known_control_types.get(ctype) if ctype else None
    out = []
    def walk(e):
        try:
            nm = e.CachedName or ""
            if (tid is None or e.CachedControlType == tid) and ((nm == name[1:-1]) if exact else bool(pat.match(nm))):
                out.append(e)
            kids = e.GetCachedChildren(); n = kids.Length
        except Exception:
            return
        for i in range(n): walk(kids.GetElement(i))
    walk(root)
    return out

def _read_ahead():
    """After an action, while nobody is waiting: read the foreground window's tree so the next
    find/press resolves from memory. Skipped for windows whose tree is slow to read."""
    try:
        time.sleep(0.08)   # let the UI settle after the action
        h = _u32.GetForegroundWindow()
        if not h or _snap_ms.get(h, 0) > READ_AHEAD_MAX_MS: return
        _snapshot(h, build=True)
    except Exception:
        pass

def _tree_lines(title, depth, show_all):
    h = _hwnd(title); out = []
    try: _dump(h, depth, show_all, out)
    except Exception:
        out = []; _refs.clear(); _walk(_win(title).wrapper_object(), 0, depth, show_all, out)
    return out

def _ref(tok):
    """'#12' -> (hwnd, wrapper, cx, cy, name, type) from the last list read."""
    try: n = int(str(tok).lstrip("#"))
    except ValueError: raise SystemExit(f"not a control number: {tok!r}")
    got = _refs.get(n)
    if not got: raise SystemExit(f"no control #{n} in the last list -- read it again with look / `desk tree`")
    h, e, cx, cy, name, ctype = got
    w = e if h is None else _wrap(e)
    return h, w, cx, cy, name, ctype

def _is_ref(tok):
    return isinstance(tok, str) and tok.startswith("#") and tok[1:].isdigit()

def cmd_tree(a):
    _report("look", label=f"read {a.title}")
    print("\n".join(_tree_lines(a.title, a.depth, a.all)))

_META = re.compile(r"[.*+?\[\](){}|\\]")
def _find_all(h, name, ctype):
    """Every descendant of window h whose name matches, in one cross-process call: the name
    (when it is a plain ^literal$) and the control type go into the UIA condition, and the
    rest of the filtering runs on cached properties, so a web page with thousands of nodes
    costs one round trip instead of one per node."""
    snap = _snapshot(h)
    if snap is not None:
        hit = _find_cached(snap, name, ctype)
        if hit: return hit
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
    if not name: raise SystemExit("which control? give TITLE NAME, or a number from the list: #N")
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
    if _is_ref(a.title):
        h, c, cx, cy, name, ctype = _ref(a.title); r = c.rectangle()
        print(json.dumps({"name": name, "type": ctype, "center": [(r.left+r.right)//2, (r.top+r.bottom)//2], "rect": [r.left, r.top, r.right, r.bottom]}))
        return
    _, c = _ctrl(a); r = c.rectangle()
    print(json.dumps({"name": c.window_text(), "type": c.element_info.control_type,
                      "center": [(r.left+r.right)//2, (r.top+r.bottom)//2], "rect": [r.left, r.top, r.right, r.bottom]}))

def cmd_press(a):
    if _is_ref(a.title):
        h, c, _, _, name, _ = _ref(a.title)
        if h and _u32.GetForegroundWindow() != h:
            if _u32.IsIconic(h): _u32.ShowWindow(h, 9)
            _u32.SetForegroundWindow(h)
        label = f"press {name or a.title}" + (f" in {_title(h)}" if h else "")
        a.name = name
    else:
        w, c = _ctrl(a)
        h = _hwnd(a.title)
        if _u32.GetForegroundWindow() != h: w.set_focus()
        label = f"press {c.window_text() or a.name} in {_title(h)}"
    r = c.rectangle(); cx, cy = (r.left+r.right)//2, (r.top+r.bottom)//2
    _mark(cx, cy, "move", label, wait=GLIDE, h=h)
    try: c.invoke()
    except Exception:
        with _UserMouse(): c.click_input()
    _mark(cx, cy, "click", label, h=h)
    print("pressed:", c.window_text() or a.name or "")

def cmd_settext(a):
    if _is_ref(a.title):
        h, c, _, _, rname, _ = _ref(a.title)
        a.text = [a.name] + list(a.text or [])
        if h and _u32.GetForegroundWindow() != h: _u32.SetForegroundWindow(h)
        try: c.set_focus()
        except Exception: pass
        r = c.rectangle(); _mark((r.left+r.right)//2, (r.top+r.bottom)//2, "type", f"fill {rname or c.window_text() or a.title}", h=h)
        try: c.set_edit_text(" ".join(a.text))
        except Exception:
            with _UserMouse(): c.click_input()
            _pg().hotkey("ctrl", "a"); _pg().write(" ".join(a.text))
        print("set:", " ".join(a.text)); return
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

def cmd_point(a):
    """Show where something is: Ember's pointer glides there with a callout. Never clicks."""
    say = (a.say or "").strip()
    rect = None; found = ""
    if a.xy:
        x, y = a.xy
    else:
        if not a.title or not a.name: raise SystemExit("point: give TITLE NAME, or --xy X Y")
        _, c = _ctrl(a)
        r = c.rectangle(); x, y = (r.left + r.right) // 2, (r.top + r.bottom) // 2
        rect = [r.left, r.top, r.right, r.bottom]; found = c.window_text()
    _glide_ms(int(x), int(y))
    _report("point", int(x), int(y), (say or found or "here")[:120])
    print(json.dumps({"x": x, "y": y, "found": found, "rect": rect, "say": say}))

def cmd_bench(a):
    """The read-only paths, timed. Nothing here moves the mouse or presses a key."""
    rows = []
    def t(label, f):
        t0 = time.time()
        try: f(); ok = "ok"
        except SystemExit as e: ok = str(e.code)[:60]
        except Exception as e: ok = type(e).__name__
        rows.append((label, (time.time() - t0) * 1000, ok))
    fg = _u32.GetForegroundWindow()
    t("windows (enumerate)", _enum_windows)
    if fg:
        _invalidate()
        t(f"tree depth 3 ({_title(fg)[:30]})", lambda: _dump(fg, 3, False, []))
        _invalidate()
        t("snapshot read (cold)", lambda: _snapshot(fg, build=True))
        t("find a Button (warm, from snapshot)", lambda: _find_cached(_snapshot(fg), ".", "Button"))
        _invalidate()
        t("find a Button (cold, one UIA call)", lambda: _find_all(fg, ".", "Button"))
        def resolve():
            cands = _find_all(fg, ".", "Button")
            if cands: _pick(cands, fg)
        t("press resolve, no invoke (cold)", resolve)
        _snapshot(fg, build=True)
        t("press resolve, no invoke (warm)", resolve)
    note = [h for h, n in _enum_windows() if "notepad" in n.lower()]
    if note:
        _invalidate()
        t("find MenuItem in Notepad (cold)", lambda: _find_all(note[0], "File", "MenuItem"))
        _snapshot(note[0], build=True)
        t("find MenuItem in Notepad (warm)", lambda: _find_all(note[0], "File", "MenuItem"))
    w = max(len(r[0]) for r in rows)
    for label, ms, ok in rows: print(f"{label:<{w}}  {ms:8.1f} ms  {ok}")

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
    x = s.add_parser("click"); x.add_argument("x"); x.add_argument("y", nargs="?"); x.add_argument("--right", action="store_true"); x.add_argument("--double", action="store_true"); x.set_defaults(f=cmd_click)
    x = s.add_parser("move"); x.add_argument("x", type=int); x.add_argument("y", type=int); x.set_defaults(f=cmd_move)
    x = s.add_parser("drag"); [x.add_argument(n, type=int) for n in ("x1", "y1", "x2", "y2")]; x.set_defaults(f=cmd_drag)
    x = s.add_parser("scroll"); x.add_argument("n", type=int); x.add_argument("x", type=int, nargs="?"); x.add_argument("y", type=int, nargs="?"); x.set_defaults(f=cmd_scroll)
    x = s.add_parser("type"); x.add_argument("text", nargs="+"); x.set_defaults(f=cmd_type)
    x = s.add_parser("key"); x.add_argument("combo", nargs="+"); x.set_defaults(f=cmd_key)
    x = s.add_parser("tree"); x.add_argument("title"); x.add_argument("--depth", type=int, default=8); x.add_argument("--all", action="store_true"); x.set_defaults(f=cmd_tree)
    for n, f in (("find", cmd_find), ("press", cmd_press)):
        x = s.add_parser(n); x.add_argument("title"); x.add_argument("name", nargs="?"); x.add_argument("--type"); x.set_defaults(f=f)
    x = s.add_parser("settext"); x.add_argument("title"); x.add_argument("name"); x.add_argument("text", nargs="*"); x.add_argument("--type", default="Edit"); x.set_defaults(f=cmd_settext)
    x = s.add_parser("read"); x.add_argument("title"); x.add_argument("name", nargs="?"); x.set_defaults(f=cmd_read)
    x = s.add_parser("clip"); x.add_argument("text", nargs="*"); x.set_defaults(f=cmd_clip)
    x = s.add_parser("point"); x.add_argument("title", nargs="?"); x.add_argument("name", nargs="?"); x.add_argument("--xy", nargs=2, type=int)
    x.add_argument("--type"); x.add_argument("--say"); x.set_defaults(f=cmd_point)
    s.add_parser("bench").set_defaults(f=cmd_bench)
    x = s.add_parser("recipe"); x.add_argument("op", choices=("list", "show", "run", "save")); x.add_argument("name", nargs="*"); x.set_defaults(f=cmd_recipe)
    return p

# Commands that change what is on screen: they drop the cached trees, and after the reply
# is sent the foreground window is read ahead.
_ACTIONS = {"click", "press", "type", "key", "settext", "focus", "run", "drag", "scroll"}
_acted = False
_timings = []

_parser = None
def dispatch(argv):
    global _parser, _acted
    if _parser is None: _parser = build_parser()
    if argv[:1] and argv[0] in _ACTIONS: _invalidate(); _acted = True
    t0 = time.time()
    buf = io.StringIO(); ok = True
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        try:
            _check_allowed(argv); _check_locked()
            a = _parser.parse_args(argv); a.f(a)
        except SystemExit as e:
            ok = e.code in (0, None)
            if not ok and not isinstance(e.code, int): print(e.code)
        except Exception:
            ok = False; traceback.print_exc()
    _timings.append({"cmd": argv[0] if argv else "", "ms": round((time.time() - t0) * 1000, 1)})
    if argv[:1] and argv[0] in _ACTIONS: _invalidate()
    return ok, buf.getvalue()

def _split_steps(script):
    """Steps separated by ';' or by line breaks (a script written one command per line)."""
    if not isinstance(script, str): script = " ".join(shlex.quote(t) if t != ";" else ";" for t in script)
    steps = []
    for line in script.splitlines():
        if not line.strip() or line.lstrip().startswith("#!"): continue
        cur = []
        for t in shlex.split(line, posix=True):
            if t == ";": steps.append(cur); cur = []
            elif t.endswith(";") and len(t) > 1: cur.append(t[:-1]); steps.append(cur); cur = []
            else: cur.append(t)
        if cur: steps.append(cur)
    return [st for st in steps if st]

NOW_MAX = 70   # lines of "what is on screen now" after a batch

def _now():
    """The foreground window after a batch, numbered, so the next step needs no look."""
    try:
        time.sleep(0.12)   # let the UI settle after the last action
        h = _u32.GetForegroundWindow()
        if not h: return ""
        out = []
        _dump(h, 12, False, out)
        head = f"-- now: {_title(h)!r}" + (f" ({len(out)} controls, first {NOW_MAX})" if len(out) > NOW_MAX else "")
        return head + "\n" + "\n".join(out[:NOW_MAX])
    except Exception:
        return ""

# ----------------------------------------------------------------------------- plans
#
# One `do` call can carry a whole checked sequence, run here without going back to the
# model after each step: waits that poll UI Automation until something is true, expects
# that stop the plan with the reason and the screen, if/then/else, and controls targeted
# by what they are called rather than by a number that changes between reads.
#
#   wait "Save As" [5s]                 a window whose title has it (bare text = a window)
#   wait [Button] "Save" | wait control "Save" | wait gone "Saving" | wait title "report"
#   wait value [Edit] "File name:" = "report.txt"
#   expect <condition> [2s]             not met (within half a second, or the time given): stop here
#   if <condition> [2s] then <step> [else <step>]
#   press "Save" | press [Button] "Save" [in "Save As"] | click [ListItem] "report.txt"
#   settext "File name:" "report.txt" | settext [Edit] "File name:" "report.txt" [in "Save As"]
#
# Names: exact (any case) wins over starts-with over contains; the window is the one in
# front unless `in "Title"` says otherwise. Any condition can be negated with `not`.

POLL = 0.06            # seconds between checks while waiting
WAIT_DEFAULT = 10.0    # how long a wait waits when the step does not say
EXPECT_SETTLE = 0.5    # an expect allows the UI this long to catch up with the last action
_TYPE_TOK = re.compile(r"^\[([A-Za-z]+)\]$")
_DUR = re.compile(r"^(\d+(?:\.\d+)?)(ms|s)?$")

class PlanFail(Exception):
    """A step's condition was not met, or its target is not there. The message says why."""

def _say(toks):
    """Steps back to text that _split_steps reads the same way (quoted where it must be)."""
    def q(t):
        if t and not re.search(r"[\s;\\\"'#$]", t): return t
        return '"' + t.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return " ".join(q(t) for t in toks)

def _norm_type(ctype):
    if not ctype: return None
    known = _iuia().known_control_types
    if ctype in known: return ctype
    for k in known:
        if k.lower() == ctype.lower(): return k
    raise PlanFail(f"unknown control type [{ctype}]; try [Button], [Edit], [MenuItem], [ListItem], [Text], [Window]")

def _target(toks):
    """[Type] name -> (type, name). Either may be missing, not both."""
    toks = list(toks); ctype = None
    m = _TYPE_TOK.match(toks[0]) if toks else None
    if m: ctype = m.group(1); toks = toks[1:]
    name = " ".join(toks)
    if not name and not ctype: raise PlanFail('which control? write [Type] "name", e.g. [Button] "Save"')
    return _norm_type(ctype), name

def _split_scope(toks):
    toks = list(toks)
    if len(toks) >= 3 and toks[-2].lower() == "in": return toks[:-2], toks[-1]
    return toks, None

def _split_timeout(toks, default):
    toks = list(toks)
    if len(toks) >= 3 and toks[-2] in ("--timeout", "timeout"):
        try: return toks[:-2], float(toks[-1])
        except ValueError: pass
    if len(toks) >= 2:
        m = _DUR.match(toks[-1])
        if m: return toks[:-1], float(m.group(1)) / (1000.0 if m.group(2) == "ms" else 1.0)
    return toks, default

def _parse_cond(toks):
    toks = list(toks); neg = False
    while toks and toks[0].lower() in ("not", "no"): neg = not neg; toks = toks[1:]
    if not toks: raise PlanFail('a condition is missing: "Window title", title "text", [Type] "name", gone "name", value [Type] "name" = "text"')
    toks, scope = _split_scope(toks)
    kind = toks[0].lower()
    if kind in ("window", "title"):
        if len(toks) < 2: raise PlanFail(f"{kind}: which title?")
        return {"kind": kind, "text": " ".join(toks[1:]), "neg": neg, "scope": scope}
    if kind == "value":
        rest = toks[1:]
        i = next((k for k, t in enumerate(rest) if t in ("=", "==", "is")), None)
        if i is None: raise PlanFail('value: write value [Type] "name" = "text"')
        ctype, name = _target(rest[:i])
        return {"kind": "value", "ctype": ctype, "name": name, "text": " ".join(rest[i + 1:]), "neg": neg, "scope": scope}
    if kind == "gone": neg = not neg; toks = toks[1:]
    elif kind == "control": toks = toks[1:]
    elif not _TYPE_TOK.match(toks[0]):
        # Bare text is a window, as `wait TITLE` always was.
        return {"kind": "window", "text": " ".join(toks), "neg": neg, "scope": scope}
    ctype, name = _target(toks)
    return {"kind": "control", "ctype": ctype, "name": name, "neg": neg, "scope": scope}

def _tdesc(ctype, name):
    return (f"[{ctype}] " if ctype else "") + (repr(name) if name else "(any)")

def _cdesc(c):
    k = c["kind"]; neg = c["neg"]
    if k == "window": d = f"{'no ' if neg else ''}window {c['text']!r}"
    elif k == "title": d = f"title {'without' if neg else 'with'} {c['text']!r}"
    elif k == "value": d = f"{_tdesc(c['ctype'], c['name'])} {'not ' if neg else ''}= {c['text']!r}"
    else: d = ("no " if neg else "") + _tdesc(c["ctype"], c["name"])
    if c.get("scope"): d += f" in {c['scope']!r}"
    return d

def _windows_matching(text):
    t = text.lower(); exact = t.startswith("^") and t.endswith("$")
    return [h for h, n in _enum_windows() if ((t[1:-1] == n.lower()) if exact else (t in n.lower()))]

def _scope_h(scope):
    if not scope: return _u32.GetForegroundWindow()
    hs = _windows_matching(scope)
    return hs[0] if hs else None

def _find_named(h, name, ctype):
    """Controls of window h by visible name, best first: exact (any case), then starts-with,
    then contains; among equals, one on screen. Names are text, not patterns, unless they
    are written ^like this$."""
    if name.startswith("^"):
        cands = _find_all(h, name, ctype)
    else:
        cands = _find_all(h, re.escape(name), ctype) if name else _find_all(h, "", ctype)
        if not cands and name:
            nf = name.casefold()
            cands = [e for e in _find_all(h, "", ctype) if nf in (e.CachedName or "").casefold()]
    if len(cands) <= 1 or not name or name.startswith("^"): return cands
    nf = name.casefold().strip()
    def rank(e):
        n = (e.CachedName or "").casefold().strip()
        return 0 if n == nf else 1 if n.startswith(nf) else 2
    cands.sort(key=rank)
    best = [e for e in cands if rank(e) == rank(cands[0])]
    first = _pick(best, h)
    return [first] + [e for e in cands if e is not first]

def _value_of(e):
    try:
        v = e.GetCurrentPropertyValue(_iuia().UIA_dll.UIA_ValueValuePropertyId)
        if v not in (None, ""): return str(v)
    except Exception:
        pass
    try: return e.CurrentName or ""
    except Exception: return ""

def _text_has(want, got):
    if want.startswith("^") and want.endswith("$"): return want[1:-1].casefold() == (got or "").casefold()
    return want.casefold() in (got or "").casefold()

def _check(c):
    """(met, what is there) for one condition, read fresh. `met` ignores `not`."""
    k = c["kind"]
    if k == "window":
        hs = _windows_matching(c["text"])
        return bool(hs), (f"window {_title(hs[0])!r} is open" if hs else f"no open window has {c['text']!r} in its title")
    h = _scope_h(c["scope"])
    if not h: return False, f"no open window has {c['scope']!r} in its title"
    if k == "title":
        t = _title(h); return _text_has(c["text"], t), f"the window in front is {t!r}"
    _invalidate()
    hits = _find_named(h, c["name"], c["ctype"])
    if k == "control":
        return bool(hits), (f"{_tdesc(c['ctype'], c['name'])} is there" if hits else f"no {_tdesc(c['ctype'], c['name'])} in {_title(h)!r}")
    if not hits: return False, f"no {_tdesc(c['ctype'], c['name'])} in {_title(h)!r}"
    v = _value_of(hits[0])
    return v.strip() == c["text"].strip(), f"{_tdesc(c['ctype'], c['name'])} is {v!r}"

def _poll(c, timeout):
    """Check until the condition holds or the time is up. Returns (ok, what is there, ms)."""
    t0 = time.time(); beat = t0
    while True:
        met, why = _check(c)
        if met != c["neg"]: return True, why, (time.time() - t0) * 1000
        now = time.time()
        if now - t0 >= timeout: return False, why, (now - t0) * 1000
        if _halted(): raise SystemExit("HALTED: the Stop button in Ember was pressed.")
        if now - beat > 1.5: _report("tick"); beat = now   # still working: keeps Ember's card up
        time.sleep(POLL)

def _gate():
    _check_allowed(["wait"]); _check_locked()

def _step_wait(toks):
    _gate()
    toks, timeout = _split_timeout(toks, WAIT_DEFAULT)
    c = _parse_cond(toks)
    _report("wait", label=f"wait for {_cdesc(c)}", h=_scope_h(c["scope"]) if c["scope"] else None)
    ok, why, ms = _poll(c, timeout)
    if not ok: raise PlanFail(f"waited {timeout:g}s for {_cdesc(c)}: {why}")
    print(f"waited {ms:.0f} ms: {why}")

def _step_expect(toks):
    _gate()
    toks, timeout = _split_timeout(toks, EXPECT_SETTLE)
    c = _parse_cond(toks)
    _report("check", label=f"check {_cdesc(c)}")
    ok, why, _ = _poll(c, timeout)
    if not ok: raise PlanFail(f"expected {_cdesc(c)}: {why}")
    print(f"ok: {why}")

def _step_if(toks, depth):
    _gate()
    low = [t.lower() for t in toks]
    if "then" not in low: raise PlanFail("if: write if <condition> then <step> [else <step>]")
    i = low.index("then")
    j = next((k for k in range(i + 1, len(low)) if low[k] == "else"), None)
    then = toks[i + 1:j] if j is not None else toks[i + 1:]
    other = toks[j + 1:] if j is not None else []
    if not then: raise PlanFail("if: nothing after then")
    ctoks, timeout = _split_timeout(toks[:i], 0.0)
    c = _parse_cond(ctoks)
    ok, why, _ = _poll(c, timeout)
    branch = then if ok else other
    head = f"if {_cdesc(c)}: {'yes' if ok else 'no'} ({why})" + (f" -> {_say(branch)}" if branch else "")
    if not branch: return True, head
    bok, bout = _run_step(branch, depth + 1)
    return bok, head + "\n" + bout

def _resolve(verb, ctype, name, scope):
    """Find a control by name now, waiting up to FIND_TIMEOUT for it to appear (the window
    in front can change under a plan: a dialog opening). Leaves it as #0."""
    deadline = time.time() + FIND_TIMEOUT
    tries = (ctype,) if ctype else (("Edit", "ComboBox", None) if verb == "settext" else (None,))
    while True:
        h = _scope_h(scope)
        if h:
            for t in tries:
                hits = _find_named(h, name, t)
                if hits:
                    e = hits[0]; r = e.CachedBoundingRectangle
                    try: ct = _ctype_name(e.CurrentControlType)
                    except Exception: ct = t or ""
                    _refs[0] = (h, e, (r.left + r.right) // 2, (r.top + r.bottom) // 2, e.CachedName or name, ct)
                    return h
        if time.time() > deadline:
            where = _title(h) if h else (scope or "the window in front")
            raise PlanFail(f"no {_tdesc(ctype, name)} in {where!r}")
        time.sleep(POLL); _invalidate()

def _named(st):
    """press/click/settext by name -> the same step on #0. Old forms pass through unchanged:
    press #N, press TITLE NAME, click X Y, settext #N TEXT, settext TITLE NAME TEXT."""
    verb = st[0].lower()
    flags = [t for t in st[1:] if t in ("--right", "--double")]
    pos = []; ctype = None; k = 1
    while k < len(st):
        t = st[k]
        if t == "--type" and k + 1 < len(st): ctype = st[k + 1]; k += 2; continue
        if not t.startswith("--"): pos.append(t)
        k += 1
    if not pos or _is_ref(pos[0]): return st
    pos, scope = _split_scope(pos)
    typed = bool(_TYPE_TOK.match(pos[0]))
    if typed: ctype = _TYPE_TOK.match(pos[0]).group(1); pos = pos[1:]
    if verb == "click" and not typed and not scope and re.fullmatch(r"-?\d+", pos[0]): return st     # click X Y
    if verb == "press" and not typed and not scope and len(pos) == 2: return st                      # press TITLE NAME
    if verb == "settext" and not typed and not scope and len(pos) != 2: return st                    # settext TITLE NAME TEXT
    if not pos: raise PlanFail(f'{verb}: which control? e.g. {verb} [Button] "Save"')
    name = pos[0]; rest = pos[1:]
    if verb == "settext" and not rest: raise PlanFail('settext: what text? settext [Edit] "name" "text"')
    _resolve(verb, _norm_type(ctype), name, scope)
    return [verb, "#0"] + (rest if verb == "settext" else []) + flags

def _capture(f, toks):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf): f(toks)
    return True, buf.getvalue()

def _run_step(st, depth=0):
    if depth > 4: return False, "if: nested too deep"
    try:
        verb = st[0].lower()
        if verb == "wait": return _capture(_step_wait, st[1:])
        if verb == "expect": return _capture(_step_expect, st[1:])
        if verb == "if": return _step_if(st[1:], depth)
        if verb in ("press", "click", "settext"): st = _named(st)
        return dispatch(st)
    except PlanFail as e:
        return False, str(e)
    except SystemExit as e:
        return False, str(e.code)
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"

def _windows_line():
    names = [n for _, n in _enum_windows() if n.strip()][:12]
    return "-- open windows: " + ", ".join(repr(n[:40]) for n in names)

_last_plan = {"script": "", "h": None}

def run_batch(script):
    steps = _split_steps(script)
    outs = []; ok = True; acted = False; t0 = time.time(); fail = ""
    for i, st in enumerate(steps, 1):
        ok, out = _run_step(st)
        if st[0].lower() in _ACTIONS or st[0].lower() == "if": acted = True
        lines = out.strip().splitlines()
        if not ok:
            why = lines[-1] if lines else "failed"
            if lines[:-1]: outs.append("\n".join(lines[:-1]))
            fail = f"FAILED at step {i} of {len(steps)}: {_say(st)}\n  why: {why}"
            break
        if lines: outs.append("\n".join(lines))
    ms = (time.time() - t0) * 1000
    if ok:
        _last_plan["script"] = script if isinstance(script, str) else _say(script)
        _last_plan["h"] = _u32.GetForegroundWindow()
        outs.append(f"-- {len(steps)} step{'s' if len(steps) != 1 else ''} in {ms:.0f} ms")
    if (acted or not ok) and not _halted():
        outs.append(_now())
        if not ok: outs.append(_windows_line())
    body = "\n".join(o for o in outs if o)
    return ok, (fail + "\n" + body) if fail else body

# ----------------------------------------------------------------------------- recipes
#
# A plan that worked, kept under a name and replayed here without the model:
#   ~/.ember/recipes/<app>/<name>.txt -- a header (# app / # exe / # window / # saved) and the
#   plan, one step per line. $1..$9 in the plan are the arguments of `recipe run NAME ARGS...`.

RECIPES = os.path.join(HOME, "recipes")
_SLUG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.-]{0,60}$")

def _recipe_files():
    out = []
    if not os.path.isdir(RECIPES): return out
    for app in sorted(os.listdir(RECIPES)):
        d = os.path.join(RECIPES, app)
        if not os.path.isdir(d): continue
        for f in sorted(os.listdir(d)):
            if f.endswith(".txt"): out.append((app, f[:-4], os.path.join(d, f)))
    return out

def _recipe_read(path):
    meta = {}; body = []
    with open(path, encoding="utf-8") as fh:
        for line in fh.read().splitlines():
            m = re.match(r"^#\s*(app|exe|window|saved):\s*(.*)$", line)
            if m: meta[m.group(1)] = m.group(2).strip(); continue
            if line.lstrip().startswith("# "): continue
            body.append(line)
    return meta, "\n".join(body).strip()

def cmd_recipe(a):
    op = a.op
    if op == "list":
        rows = _recipe_files()
        if not rows: print('no recipes yet: run a plan with act, then save it (act with save "name", or desk recipe save NAME)'); return
        for app, name, path in rows:
            meta, body = _recipe_read(path)
            n = len(_split_steps(body)) if body else 0
            args = sorted(set(re.findall(r"\$[1-9]", body)))
            print(f"{name}  ({meta.get('app') or app}, {n} steps{', args ' + ' '.join(args) if args else ''})")
        return
    if not a.name: raise SystemExit(f"recipe {op}: which name?")
    name = a.name[0].strip()
    if op == "save":
        script = _last_plan["script"]
        if not script: raise SystemExit("recipe save: no plan has succeeded yet; run it with act first")
        if not _SLUG.match(name): raise SystemExit("recipe save: a name is letters, digits, space, - _ .")
        h = _last_plan["h"]; info = _app_of(h) if h else {}
        app = re.sub(r"[^a-z0-9_.-]", "", os.path.splitext(info.get("exe", "") or "desktop")[0].lower()) or "desktop"
        os.makedirs(os.path.join(RECIPES, app), exist_ok=True)
        path = os.path.join(RECIPES, app, name + ".txt")
        steps = _split_steps(script)
        # recipe save NAME VALUE1 VALUE2: those values become the recipe's $1 $2, so the
        # next run can pass others (another file name, another text).
        vals = sorted(((k, v) for k, v in enumerate(a.name[1:], 1) if v), key=lambda kv: -len(kv[1]))
        if vals:
            def param(t):
                for k, v in vals: t = t.replace(v, f"${k}")
                return t
            steps = [[param(t) for t in st] for st in steps]
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(f"# app: {info.get('app', '')}\n# exe: {info.get('exe', '')}\n# window: {info.get('win', '')}\n# saved: {time.strftime('%Y-%m-%d %H:%M')}\n")
            for st in steps: fh.write(_say(st) + "\n")
        print(f"saved recipe {name!r} ({len(steps)} steps) -> {path}")
        if any(_is_ref(t) for st in steps for t in st):
            print("note: it uses control numbers (#N), which change between runs -- name the controls instead so it replays")
        return
    rows = [r for r in _recipe_files() if r[1].lower() == name.lower()]
    if not rows: raise SystemExit(f"no recipe {name!r} -- `recipe list` shows them")
    if len(rows) > 1:
        # One name for two apps: the app in front wins.
        fg = os.path.splitext(_exe(_u32.GetForegroundWindow()).lower())[0]
        rows = [r for r in rows if r[0] == fg] or rows
    meta, body = _recipe_read(rows[0][2])
    if op == "show": print(f"# {rows[0][1]} ({meta.get('app') or rows[0][0]})\n{body}"); return
    args = a.name[1:]
    def sub(m):
        k = int(m.group(1))
        if k > len(args): raise SystemExit(f"recipe {name!r} needs argument ${k}")
        return args[k - 1].replace("\\", "\\\\").replace('"', '\\"')
    ok, out = run_batch(re.sub(r"\$([1-9])", sub, body))
    print(out)
    if not ok: raise SystemExit(1)

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
    _read_control()
    # Exclusive: if anything else already holds this port, fail here and say so, rather than
    # share it (SO_REUSEADDR on Windows lets a second socket bind the same port) and leave
    # shells talking to whichever socket Windows picks. Ember then moves to another port.
    srv = socket.socket()
    excl = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)
    if excl is not None: srv.setsockopt(socket.SOL_SOCKET, excl, 1)
    try:
        srv.bind(("127.0.0.1", PORT)); srv.listen(5)
    except OSError as e:
        print(f"PORT_IN_USE {PORT}: {e}", flush=True); sys.exit(4)
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
            if "control" in req:
                ok = _take_control(req)
                conn.sendall(b'{"ok":true}\n' if ok else b'{"ok":false}\n'); continue
            if not hmac.compare_digest(str(req.get("token", "")).encode(), TOKEN.encode()):
                conn.sendall(b'ERR\ndesk only works inside an Ember shell\n' if raw else b'{"ok":false,"out":"desk only works inside an Ember shell"}\n'); continue
            argv = req.get("argv", []); _current_tab = str(req.get("tab", ""))
            global _acted
            _acted = False; _timings.clear(); t_req = time.time()
            if argv[:1] == ["__ping__"]: ok, out = True, "pong"
            elif argv[:1] == ["__quit__"]:
                conn.sendall(b'{"ok":true,"out":"bye"}\n'); conn.close(); break
            elif argv[:1] == ["do"]: ok, out = run_batch(argv[1] if len(argv) == 2 else argv[1:])
            elif argv[:1] in (["-h"], ["--help"], ["help"], []): ok, out = True, HELP
            else: ok, out = dispatch(argv)
            ms = round((time.time() - t_req) * 1000, 1)
            if raw: conn.sendall((("OK" if ok else "ERR") + "\n" + out.rstrip() + "\n").encode("utf-8"))
            else: conn.sendall((json.dumps({"ok": ok, "out": out, "ms": ms, "steps": list(_timings)}) + "\n").encode("utf-8"))
            # The reply is out; read ahead before the next request comes in.
            if _acted:
                try: conn.close()
                except Exception: pass
                _read_ahead()
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
