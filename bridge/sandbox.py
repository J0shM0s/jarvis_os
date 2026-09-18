"""
Jarvis Sandbox — voll isolierter Hidden-Desktop via Win32 CreateDesktop
Erlaubt OS-Steuerung ohne den echten Desktop zu blockieren.
Wenn CreateDesktop fehlschlägt (Rechte), Fallback auf Virtual-Desktop (Win+Ctrl+D).
"""
import ctypes
from ctypes import wintypes
import time

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

DESKTOP_CREATEWINDOW = 0x0002
DESKTOP_CREATEMENU = 0x0004
DESKTOP_HOOKCONTROL = 0x0008
DESKTOP_JOURNALRECORD = 0x0010
DESKTOP_JOURNALPLAYBACK = 0x0020
DESKTOP_ENUMERATE = 0x0040
DESKTOP_WRITEOBJECTS = 0x0080
DESKTOP_SWITCHDESKTOP = 0x0100
DESKTOP_READOBJECTS = 0x0001
DESKTOP_ALL = 0x01FF

GENERIC_ALL = 0x10000000

_is_sandbox = False
_hdesk = None
_hdesk_old = None

def _get_thread_desktop():
    return user32.GetThreadDesktop(kernel32.GetCurrentThreadId())

def create_sandbox(name="JarvisSandbox"):
    global _hdesk, _hdesk_old, _is_sandbox
    if _hdesk:
        return _hdesk
    try:
        # Versuche Hidden Desktop zu erstellen
        hdesk = user32.CreateDesktopW(
            name, None, None, 0,
            DESKTOP_CREATEWINDOW | DESKTOP_CREATEMENU | DESKTOP_HOOKCONTROL |
            DESKTOP_JOURNALRECORD | DESKTOP_JOURNALPLAYBACK | DESKTOP_ENUMERATE |
            DESKTOP_WRITEOBJECTS | DESKTOP_SWITCHDESKTOP | DESKTOP_READOBJECTS,
            None
        )
        if not hdesk:
            # Fallback: Virtual Desktop via Win+Ctrl+D
            try:
                import pyautogui
                pyautogui.hotkey('win', 'ctrl', 'd')
                time.sleep(0.5)
                _is_sandbox = True
                return "virtual"
            except:
                return None
        _hdesk = hdesk
        _is_sandbox = True
        # Starte Explorer in Sandbox für Taskleiste
        try:
            # STARTUPINFO mit lpDesktop
            class STARTUPINFO(ctypes.Structure):
                _fields_ = [
                    ("cb", wintypes.DWORD),
                    ("lpReserved", wintypes.LPWSTR),
                    ("lpDesktop", wintypes.LPWSTR),
                    ("lpTitle", wintypes.LPWSTR),
                    ("dwX", wintypes.DWORD),
                    ("dwY", wintypes.DWORD),
                    ("dwXSize", wintypes.DWORD),
                    ("dwYSize", wintypes.DWORD),
                    ("dwXCountChars", wintypes.DWORD),
                    ("dwYCountChars", wintypes.DWORD),
                    ("dwFillAttribute", wintypes.DWORD),
                    ("dwFlags", wintypes.DWORD),
                    ("wShowWindow", wintypes.WORD),
                    ("cbReserved2", wintypes.WORD),
                    ("lpReserved2", ctypes.c_void_p),
                    ("hStdInput", wintypes.HANDLE),
                    ("hStdOutput", wintypes.HANDLE),
                    ("hStdError", wintypes.HANDLE),
                ]
            class PROCESS_INFORMATION(ctypes.Structure):
                _fields_ = [
                    ("hProcess", wintypes.HANDLE),
                    ("hThread", wintypes.HANDLE),
                    ("dwProcessId", wintypes.DWORD),
                    ("dwThreadId", wintypes.DWORD),
                ]
            si = STARTUPINFO()
            si.cb = ctypes.sizeof(STARTUPINFO)
            si.lpDesktop = name
            si.dwFlags = 0x1
            si.wShowWindow = 1
            pi = PROCESS_INFORMATION()
            # Starte explorer in Sandbox (hat eigene Taskleiste)
            # Nicht kritisch wenn fehlschlägt — Desktop existiert trotzdem
            try:
                kernel32.CreateProcessW(None, ctypes.c_wchar_p("explorer.exe"), None, None, False, 0, None, None, ctypes.byref(si), ctypes.byref(pi))
            except:
                pass
        except:
            pass
        return hdesk
    except Exception as e:
        print(f"sandbox create failed: {e}")
        return None

def enter_sandbox():
    global _hdesk_old
    if not _is_sandbox:
        create_sandbox()
    if _hdesk and _hdesk != "virtual":
        try:
            _hdesk_old = _get_thread_desktop()
            # SetThreadDesktop muss vor SwitchDesktop
            user32.SetThreadDesktop(_hdesk)
            # Nicht SwitchDesktop — das würde sichtbaren Desktop wechseln und User blockieren!
            # Wir bleiben auf altem sichtbaren Desktop, aber Thread-Input geht in Sandbox
            return True
        except Exception as e:
            print(f"enter_sandbox failed: {e}")
            return False
    elif _hdesk == "virtual":
        # Virtual Desktop: Switch via Win+Ctrl+D ist bereits sichtbar — User sieht kurz Wechsel
        # Für voll isoliert ohne Flicker müsste man CreateDesktop nutzen, daher Fallback
        return True
    return False

def leave_sandbox():
    global _hdesk_old
    if _hdesk_old:
        try:
            user32.SetThreadDesktop(_hdesk_old)
            _hdesk_old = None
        except:
            pass

def destroy_sandbox():
    global _hdesk, _is_sandbox
    if _hdesk and _hdesk != "virtual":
        try:
            user32.CloseDesktop(_hdesk)
        except:
            pass
    elif _hdesk == "virtual":
        try:
            import pyautogui
            pyautogui.hotkey('win', 'ctrl', 'F4')  # schließe Virtual Desktop
        except:
            pass
    _hdesk = None
    _is_sandbox = False

def is_sandbox_active():
    return _is_sandbox

# Für direkten Test
if __name__ == "__main__":
    print("create", create_sandbox())
    print("enter", enter_sandbox())
    import time
    time.sleep(1)
    print("leave", leave_sandbox())
    destroy_sandbox()
    print("done")
