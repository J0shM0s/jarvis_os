#!/usr/bin/env python3
"""
JARVIS OS Control — pyautogui + mss + Pillow
Erfüllt Spezifikation:
  capture_screen() -> Bild für LLM
  move_and_click(x,y)
  type_text(string)
  press_key(combination)
  upload_file(file_path)

Aufruf als CLI für bridge/os.mjs:
  python os_control.py capture [--output path]
  python os_control.py click --x 450 --y 320
  python os_control.py type --text "hello"
  python os_control.py key --combo "ctrl+v"
  python os_control.py upload --file "C:/path/file.pdf"
"""
import sys
import os
import json
import time
import base64
import argparse
import tempfile
from pathlib import Path

# pyautogui FAILSAFE aus, sonst blockiert Bewegung in Ecke
try:
    import pyautogui
    pyautogui.FAILSAFE = False
    pyautogui.PAUSE = 0.05
except Exception as e:
    print(json.dumps({"error": f"pyautogui import failed: {e}"}))
    sys.exit(1)

try:
    import mss
    HAS_MSS = True
except:
    HAS_MSS = False

from PIL import Image

def capture_screen(output=None, return_b64=True, sandbox=False):
    """Screenshot via mss (schnell) fallback pyautogui. Im Sandbox-Modus via Hidden-Desktop. Downsized auf 1280px für schnelles LLM."""
    use_sandbox = sandbox
    if use_sandbox:
        try:
            import sandbox as sb
            sb.enter_sandbox()
        except:
            pass
    try:
        if output is None:
            tmp = tempfile.gettempdir()
            output = os.path.join(tmp, f"jarvis_capture_{int(time.time()*1000)}.png")
        if HAS_MSS:
            with mss.mss() as sct:
                mon = sct.monitors[1]
                img = sct.grab(mon)
                pil = Image.frombytes("RGB", img.size, img.bgra, "raw", "BGRX")
                # Downscale für Vision-LLM (2880→1280 spart 70% Base64 + 50% LLM-Zeit)
                max_w = 1280
                if pil.width > max_w:
                    ratio = max_w / pil.width
                    pil = pil.resize((max_w, int(pil.height * ratio)), Image.LANCZOS)
                pil.save(output, "PNG", optimize=True)
        else:
            pil = pyautogui.screenshot()
            max_w = 1280
            if pil.width > max_w:
                ratio = max_w / pil.width
                pil = pil.resize((max_w, int(pil.height * ratio)), Image.LANCZOS)
            pil.save(output, "PNG", optimize=True)
        result = {"path": output, "width": 0, "height": 0}
        try:
            with Image.open(output) as im:
                result["width"], result["height"] = im.size
        except:
            pass
        if return_b64:
            with open(output, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("utf-8")
                result["base64"] = b64
                result["mime"] = "image/png"
        return result
    except Exception as e:
        return {"error": str(e)}
    finally:
        if use_sandbox:
            try:
                import sandbox as sb
                sb.leave_sandbox()
            except:
                pass

def _with_sandbox(sandbox, fn, *a, **kw):
    if sandbox:
        try:
            import sandbox as sb
            sb.enter_sandbox()
        except:
            pass
    try:
        return fn(*a, **kw)
    finally:
        if sandbox:
            try:
                import sandbox as sb
                sb.leave_sandbox()
            except:
                pass

def _move_and_click_inner(x, y, button="left", clicks=1):
    x, y = int(x), int(y)
    pyautogui.moveTo(x, y, duration=0.25)
    time.sleep(0.05)
    pyautogui.click(x, y, clicks=clicks, button=button)
    return {"ok": True, "x": x, "y": y}

def move_and_click(x, y, button="left", clicks=1, sandbox=False):
    try:
        return _with_sandbox(sandbox, _move_and_click_inner, x, y, button, clicks)
    except Exception as e:
        return {"error": str(e)}

def _type_inner(text):
    pyautogui.write(str(text), interval=0.02)
    return {"ok": True, "typed": text}

def type_text(text, sandbox=False):
    try:
        return _with_sandbox(sandbox, _type_inner, text)
    except Exception as e:
        return {"error": str(e)}

def _press_inner(combo):
    combo = combo.lower().strip()
    key_map = {"return": "enter", "esc": "escape"}
    parts = [key_map.get(p, p) for p in combo.replace("+", " ").replace(",", " ").split()]
    if len(parts) == 1:
        pyautogui.press(parts[0])
    else:
        pyautogui.hotkey(*parts)
    return {"ok": True, "combo": combo}

def press_key(combo, sandbox=False):
    try:
        return _with_sandbox(sandbox, _press_inner, combo)
    except Exception as e:
        return {"error": str(e)}

def _upload_inner(file_path):
    p = Path(file_path)
    if not p.exists():
        return {"error": f"File not found: {file_path}"}
    abs_path = str(p.resolve())
    time.sleep(0.3)
    pyautogui.write(abs_path, interval=0.01)
    time.sleep(0.2)
    pyautogui.press("enter")
    return {"ok": True, "file": abs_path}

def upload_file(file_path, sandbox=False):
    try:
        return _with_sandbox(sandbox, _upload_inner, file_path)
    except Exception as e:
        return {"error": str(e)}

def _launch_inner(target):
    # Direkter Launch ohne Tippen — robust für jede App
    import subprocess, os
    target = target.strip()
    # Wenn absoluter Pfad und existiert → direkt starten
    if os.path.exists(target):
        try:
            os.startfile(target)  # Windows
            return {"ok": True, "launched": target, "method": "startfile"}
        except:
            subprocess.Popen(target, shell=True)
            return {"ok": True, "launched": target, "method": "popen"}
    # Sonst: Win → tippen → Enter (Startmenü-Suche)
    # Auch für Apps wie "WhatsApp", "Rechner", "Spotify", "Chrome"
    pyautogui.press("win")
    time.sleep(0.7)
    pyautogui.write(target, interval=0.03)
    time.sleep(0.7)
    pyautogui.press("enter")
    return {"ok": True, "launched": target, "method": "win-search"}

def launch_app(target, sandbox=False):
    try:
        return _with_sandbox(sandbox, _launch_inner, target)
    except Exception as e:
        return {"error": str(e)}

def list_apps(sandbox=False):
    # Listet Startmenü-Apps (Name → Pfad) für LLM zum Auswählen
    def _inner():
        import glob
        apps = {}
        # Startmenü Pfade
        start_dirs = [
            os.path.join(os.environ.get("APPDATA", ""), "Microsoft\\Windows\\Start Menu\\Programs"),
            os.path.join(os.environ.get("PROGRAMDATA", ""), "Microsoft\\Windows\\Start Menu\\Programs"),
        ]
        for d in start_dirs:
            if not os.path.exists(d):
                continue
            for root, _, files in os.walk(d):
                for f in files:
                    if f.lower().endswith(".lnk"):
                        name = os.path.splitext(f)[0]
                        # nur erste 80, dedupliziert
                        if name.lower() not in apps and len(apps) < 80:
                            apps[name.lower()] = os.path.join(root, f)
        # Häufige Apps direkt
        for n in ["WhatsApp", "Spotify", "Chrome", "Edge", "Rechner", "Calculator", "Notepad", "Explorer", "Discord", "Teams", "Outlook", "Word", "Excel"]:
            if n.lower() not in apps:
                apps[n.lower()] = f"Startmenü-Suche: {n}"
        return {"apps": apps, "count": len(apps)}
    try:
        return _with_sandbox(sandbox, _inner)
    except Exception as e:
        return {"error": str(e)}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["capture", "click", "type", "key", "upload", "sandbox", "launch", "list"])
    parser.add_argument("--x", type=int, default=None)
    parser.add_argument("--y", type=int, default=None)
    parser.add_argument("--text", type=str, default=None)
    parser.add_argument("--combo", type=str, default=None)
    parser.add_argument("--file", type=str, default=None)
    parser.add_argument("--output", type=str, default=None)
    parser.add_argument("--sandbox", action="store_true", help="im isolierten Hidden-Desktop ausführen")
    # Für launch: nutze --text als App-Name/Pfad
    parser.add_argument("--app", type=str, default=None)
    args = parser.parse_args()

    if args.action == "capture":
        res = capture_screen(output=args.output, sandbox=args.sandbox)
        print(json.dumps(res))
    elif args.action == "click":
        if args.x is None or args.y is None:
            print(json.dumps({"error": "x/y required"})); sys.exit(1)
        res = move_and_click(args.x, args.y, sandbox=args.sandbox)
        print(json.dumps(res))
    elif args.action == "type":
        if args.text is None:
            print(json.dumps({"error": "text required"})); sys.exit(1)
        res = type_text(args.text, sandbox=args.sandbox)
        print(json.dumps(res))
    elif args.action == "key":
        if args.combo is None:
            print(json.dumps({"error": "combo required"})); sys.exit(1)
        res = press_key(args.combo, sandbox=args.sandbox)
        print(json.dumps(res))
    elif args.action == "upload":
        if args.file is None:
            print(json.dumps({"error": "file required"})); sys.exit(1)
        res = upload_file(args.file, sandbox=args.sandbox)
        print(json.dumps(res))
    elif args.action == "launch":
        target = args.app or args.text
        if not target:
            print(json.dumps({"error": "app required (--app or --text)"})); sys.exit(1)
        res = launch_app(target, sandbox=args.sandbox)
        print(json.dumps(res))
    elif args.action == "list":
        res = list_apps(sandbox=args.sandbox)
        print(json.dumps(res, ensure_ascii=False))
    elif args.action == "sandbox":
        import sandbox as sb
        if args.text == "create":
            h = sb.create_sandbox()
            print(json.dumps({"sandbox": str(h), "active": sb.is_sandbox_active()}))
        elif args.text == "destroy":
            sb.destroy_sandbox()
            print(json.dumps({"destroyed": True}))
        else:
            print(json.dumps({"active": sb.is_sandbox_active()}))

if __name__ == "__main__":
    main()
