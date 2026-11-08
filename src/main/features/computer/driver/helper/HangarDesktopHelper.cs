// Agent Hangar Desktop — the Windows helper of the computer workstation (src/main/features/computer).
// One process per workstation, JSON lines over stdin/stdout: {"id":1,"cmd":"capture","hwnd":123} ->
// {"id":1,"ok":true,...}. It only does what the main process asks after its checks (allowed app, window, keys);
// it never decides anything itself. Compiled on first use by the in-box C# 5 compiler of .NET Framework 4.x
// (csc.exe), so: no string interpolation, no ?., no expression-bodied members.
//
// Coordinates are physical screen pixels (the process is per-monitor DPI aware).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

namespace Hangar
{
    public static class Helper
    {
        // ------------------------------------------------------------------ Win32
        [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

        [StructLayout(LayoutKind.Sequential)]
        struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Explicit)]
        struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
        [StructLayout(LayoutKind.Sequential)]
        struct INPUT { public uint type; public INPUTUNION u; }

        delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder sb, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder sb, int max);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
        [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT r, int size);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int v, int size);
        [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
        [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
        [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
        [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
        [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
        [DllImport("user32.dll")] static extern short VkKeyScan(char c);
        [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern bool GetUserObjectInformation(IntPtr h, int index, StringBuilder sb, int len, out int needed);
        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder sb, ref int size);

        const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
        const uint MOUSEEVENTF_LEFTDOWN = 0x2, MOUSEEVENTF_LEFTUP = 0x4, MOUSEEVENTF_RIGHTDOWN = 0x8,
            MOUSEEVENTF_RIGHTUP = 0x10, MOUSEEVENTF_MIDDLEDOWN = 0x20, MOUSEEVENTF_MIDDLEUP = 0x40,
            MOUSEEVENTF_WHEEL = 0x800, MOUSEEVENTF_HWHEEL = 0x1000;
        const uint KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2, KEYEVENTF_UNICODE = 0x4;
        const int GWL_EXSTYLE = -20;
        const int WS_EX_TOOLWINDOW = 0x80, WS_EX_TOPMOST = 0x8, WS_EX_TRANSPARENT = 0x20, WS_EX_LAYERED = 0x80000;
        const uint GW_HWNDPREV = 3, GA_ROOTOWNER = 3, GA_ROOT = 2;
        const int DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14;

        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024 };
        static readonly object InjectLock = new object();
        static long lastInjectEnd = 0;  // Environment.TickCount (ms) of the end of our last injection

        public static void Main(string[] args)
        {
            try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch { } }
            Console.InputEncoding = new UTF8Encoding(false);
            var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            stdout.AutoFlush = true;
            var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            string line;
            while ((line = stdin.ReadLine()) != null)
            {
                if (line.Trim().Length == 0) continue;
                Dictionary<string, object> req = null;
                object id = null;
                Dictionary<string, object> res;
                try
                {
                    req = Json.Deserialize<Dictionary<string, object>>(line);
                    req.TryGetValue("id", out id);
                    res = Handle(req);
                    res["ok"] = true;
                }
                catch (Exception e)
                {
                    res = new Dictionary<string, object>();
                    res["ok"] = false;
                    res["error"] = e.Message;
                }
                res["id"] = id;
                stdout.WriteLine(Json.Serialize(res));
                if (req != null && Str(req, "cmd") == "exit") return;
            }
        }

        // ------------------------------------------------------------------ dispatch
        static Dictionary<string, object> Handle(Dictionary<string, object> r)
        {
            string cmd = Str(r, "cmd");
            switch (cmd)
            {
                case "hello": return Obj("pid", Process.GetCurrentProcess().Id, "version", 1);
                case "exit": return Obj();
                case "windows": return Obj("windows", ListWindows());
                case "foreground": return Obj("window", Describe(GetForegroundWindow()));
                case "window": return Obj("window", Describe(Hwnd(r)));
                case "focus": return Obj("window", Focus(Hwnd(r)));
                case "capture": return Capture(Hwnd(r), Int(r, "maxWidth", 1366), Ints(r, "allowedPids"), Ints(r, "ignoreHwnds"));
                case "elements": return Obj("elements", Elements(Hwnd(r), Int(r, "max", 150), Int(r, "timeoutMs", 1500)));
                case "focused": return Focused();
                case "hit": return Hit(Int(r, "x", 0), Int(r, "y", 0));
                case "click": return Click(Int(r, "x", 0), Int(r, "y", 0), Str(r, "button"), Bool(r, "double"));
                case "type": return TypeText(Str(r, "text"));
                case "key": return Key(Str(r, "key"), Strs(r, "modifiers"));
                case "scroll": return Scroll(Int(r, "x", 0), Int(r, "y", 0), Str(r, "direction"), Int(r, "amount", 3));
                case "release": return Release();
                case "idle": return Idle();
                case "watch_start": return WatchStart(Strs(r, "processes"), Int(r, "maxWidth", 1366), Ints(r, "ignoreHwnds"), Bool(r, "acceptInjected"));
                case "watch_poll": return WatchPoll();
                case "watch_stop": return WatchStop();
                default: throw new Exception("comando desconhecido: " + cmd);
            }
        }

        // ------------------------------------------------------------------ windows
        static List<object> ListWindows()
        {
            var list = new List<object>();
            EnumWindows(delegate (IntPtr h, IntPtr p)
            {
                if (!IsWindowVisible(h)) return true;
                int ex = GetWindowLong(h, GWL_EXSTYLE);
                if ((ex & WS_EX_TOOLWINDOW) != 0) return true;
                int cloaked;
                if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return true;
                var title = Title(h);
                if (title.Length == 0) return true;
                list.Add(Describe(h));
                return true;
            }, IntPtr.Zero);
            return list;
        }

        static string Title(IntPtr h)
        {
            var sb = new StringBuilder(512);
            GetWindowText(h, sb, sb.Capacity);
            return sb.ToString();
        }

        static Dictionary<string, object> Describe(IntPtr h)
        {
            if (h == IntPtr.Zero) return null;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            var cls = new StringBuilder(256);
            GetClassName(h, cls, cls.Capacity);
            RECT rc = Bounds(h);
            string exe = ExePath(pid);
            IntPtr owner = GetAncestor(h, GA_ROOTOWNER);
            uint ownerPid = pid;
            if (owner != IntPtr.Zero && owner != h) GetWindowThreadProcessId(owner, out ownerPid);
            return Obj("hwnd", h.ToInt64(), "title", Title(h), "className", cls.ToString(), "pid", (long)pid,
                "ownerPid", (long)ownerPid, "exe", exe, "elevated", exe.Length == 0 && pid != 0,
                "process", exe.Length > 0 ? Path.GetFileNameWithoutExtension(exe) : "",
                "rect", Obj("x", rc.Left, "y", rc.Top, "width", rc.Right - rc.Left, "height", rc.Bottom - rc.Top),
                "minimized", IsIconic(h), "foreground", GetForegroundWindow() == h);
        }

        static string ExePath(uint pid)
        {
            IntPtr hp = OpenProcess(0x1000 /* QUERY_LIMITED_INFORMATION */, false, pid);
            if (hp == IntPtr.Zero) return "";
            try
            {
                var sb = new StringBuilder(1024);
                int size = sb.Capacity;
                return QueryFullProcessImageName(hp, 0, sb, ref size) ? sb.ToString() : "";
            }
            finally { CloseHandle(hp); }
        }

        static RECT Bounds(IntPtr h)
        {
            RECT rc;
            if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out rc, Marshal.SizeOf(typeof(RECT))) != 0)
                GetWindowRect(h, out rc);
            return rc;
        }

        static Dictionary<string, object> Focus(IntPtr h)
        {
            if (IsIconic(h)) ShowWindow(h, 9 /* SW_RESTORE */);
            IntPtr fg = GetForegroundWindow();
            uint dummy;
            uint fgThread = GetWindowThreadProcessId(fg, out dummy);
            uint me = GetCurrentThreadId();
            bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
            try
            {
                BringWindowToTop(h);
                SetForegroundWindow(h);
            }
            finally { if (attached) AttachThreadInput(me, fgThread, false); }
            for (int i = 0; i < 20 && GetForegroundWindow() != h; i++) Thread.Sleep(25);
            return Describe(h);
        }

        // ------------------------------------------------------------------ capture
        // What is on screen in the window's rectangle (menus, tooltips and the app's own popups included). Windows of
        // processes not in allowedPids that lie above it are painted black: the model never sees another app. Our own
        // overlay is excluded from capture by the main process (setContentProtection).
        static Dictionary<string, object> Capture(IntPtr h, int maxWidth, HashSet<long> allowedPids, HashSet<long> ignore)
        {
            RECT rc = Bounds(h);
            int w = Math.Max(1, rc.Right - rc.Left), hgt = Math.Max(1, rc.Bottom - rc.Top);
            var masked = new List<object>();
            using (var bmp = new Bitmap(w, hgt, PixelFormat.Format24bppRgb))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.CopyFromScreen(rc.Left, rc.Top, 0, 0, new Size(w, hgt), CopyPixelOperation.SourceCopy);
                    if (allowedPids != null)
                    {
                        uint self = (uint)Process.GetCurrentProcess().Id;
                        for (IntPtr z = GetWindow(h, GW_HWNDPREV); z != IntPtr.Zero; z = GetWindow(z, GW_HWNDPREV))
                        {
                            if (!IsWindowVisible(z) || IsIconic(z)) continue;
                            if (ignore != null && ignore.Contains(z.ToInt64())) continue;
                            int cloaked;
                            if (DwmGetWindowAttribute(z, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) continue;
                            int ex = GetWindowLong(z, GWL_EXSTYLE);
                            if ((ex & WS_EX_TRANSPARENT) != 0 && (ex & WS_EX_LAYERED) != 0) continue; // click-through overlays
                            uint pid;
                            GetWindowThreadProcessId(z, out pid);
                            if (pid == self || allowedPids.Contains((long)pid)) continue;
                            RECT o = Bounds(z);
                            int x1 = Math.Max(o.Left, rc.Left), y1 = Math.Max(o.Top, rc.Top);
                            int x2 = Math.Min(o.Right, rc.Right), y2 = Math.Min(o.Bottom, rc.Bottom);
                            if (x2 <= x1 || y2 <= y1) continue;
                            g.FillRectangle(Brushes.Black, x1 - rc.Left, y1 - rc.Top, x2 - x1, y2 - y1);
                            masked.Add(Obj("pid", (long)pid, "x", x1, "y", y1, "width", x2 - x1, "height", y2 - y1));
                        }
                    }
                }
                double scale = w > maxWidth ? (double)maxWidth / w : 1.0;
                int sw = Math.Max(1, (int)Math.Round(w * scale)), sh = Math.Max(1, (int)Math.Round(hgt * scale));
                Bitmap outBmp = bmp;
                if (scale < 1.0)
                {
                    outBmp = new Bitmap(sw, sh, PixelFormat.Format24bppRgb);
                    using (var g2 = Graphics.FromImage(outBmp))
                    {
                        g2.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g2.DrawImage(bmp, 0, 0, sw, sh);
                    }
                }
                try
                {
                    using (var ms = new MemoryStream())
                    {
                        outBmp.Save(ms, ImageFormat.Png);
                        return Obj("png", Convert.ToBase64String(ms.ToArray()), "width", sw, "height", sh,
                            "scale", scale, "rect", Obj("x", rc.Left, "y", rc.Top, "width", w, "height", hgt),
                            "masked", masked, "window", Describe(h));
                    }
                }
                finally { if (outBmp != bmp) outBmp.Dispose(); }
            }
        }

        // ------------------------------------------------------------------ UI Automation
        static readonly HashSet<string> Interactive = new HashSet<string> {
            "button", "edit", "hyperlink", "menu item", "check box", "radio button", "combo box", "list item",
            "tab item", "tree item", "data item", "split button", "menu bar", "document", "slider", "spinner" };

        static List<object> Elements(IntPtr h, int max, int timeoutMs)
        {
            var list = new List<object>();
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            AutomationElement root;
            try { root = AutomationElement.FromHandle(h); } catch { return list; }
            var queue = new Queue<AutomationElement>();
            queue.Enqueue(root);
            var walker = TreeWalker.ControlViewWalker;
            int visited = 0;
            while (queue.Count > 0 && list.Count < max && DateTime.UtcNow < deadline && visited < 4000)
            {
                var el = queue.Dequeue();
                visited++;
                try
                {
                    var c = el.Current;
                    string type = c.LocalizedControlType ?? "";
                    string ctl = c.ControlType != null ? c.ControlType.ProgrammaticName.Replace("ControlType.", "").ToLowerInvariant() : "";
                    string kind = Interactive.Contains(type.ToLowerInvariant()) ? type.ToLowerInvariant() : MapType(ctl);
                    if (el != root && kind.Length > 0 && !c.IsOffscreen && c.IsEnabled)
                    {
                        var b = c.BoundingRectangle;
                        if (!b.IsEmpty && b.Width > 1 && b.Height > 1)
                            list.Add(Obj("name", (c.Name ?? "").Trim(), "type", kind, "password", c.IsPassword,
                                "x", (int)Math.Round(b.X), "y", (int)Math.Round(b.Y),
                                "width", (int)Math.Round(b.Width), "height", (int)Math.Round(b.Height),
                                "value", ValueOf(el, c.IsPassword)));
                    }
                    for (var ch = walker.GetFirstChild(el); ch != null; ch = walker.GetNextSibling(ch)) queue.Enqueue(ch);
                }
                catch { /* element went away */ }
            }
            return list;
        }

        static string MapType(string ctl)
        {
            switch (ctl)
            {
                case "button": case "splitbutton": return "button";
                case "edit": return "edit";
                case "hyperlink": return "link";
                case "menuitem": return "menu item";
                case "checkbox": return "check box";
                case "radiobutton": return "radio button";
                case "combobox": return "combo box";
                case "listitem": return "list item";
                case "tabitem": return "tab item";
                case "treeitem": return "tree item";
                case "dataitem": return "data item";
                case "document": return "document";
                default: return "";
            }
        }

        static string ValueOf(AutomationElement el, bool password)
        {
            if (password) return "";
            try
            {
                object p;
                if (el.TryGetCurrentPattern(ValuePattern.Pattern, out p))
                {
                    var v = ((ValuePattern)p).Current.Value ?? "";
                    return v.Length > 80 ? v.Substring(0, 80) + "…" : v;
                }
            }
            catch { }
            return "";
        }

        static Dictionary<string, object> Focused()
        {
            try
            {
                var el = AutomationElement.FocusedElement;
                if (el == null) return Obj("focused", null);
                var c = el.Current;
                return Obj("focused", Obj("name", c.Name ?? "", "type", c.LocalizedControlType ?? "", "password", c.IsPassword,
                    "pid", (long)c.ProcessId, "hwnd", (long)c.NativeWindowHandle));
            }
            catch (Exception e) { return Obj("focused", null, "detail", e.Message); }
        }

        // The top-level window under a point and its process (the main process checks it is allowed before clicking).
        static Dictionary<string, object> Hit(int x, int y)
        {
            var p = new POINT { X = x, Y = y };
            IntPtr w = WindowFromPoint(p);
            IntPtr top = w == IntPtr.Zero ? IntPtr.Zero : GetAncestor(w, GA_ROOT);
            return Obj("window", Describe(top));
        }

        // ------------------------------------------------------------------ input
        static void Send(List<INPUT> inputs)
        {
            lock (InjectLock)
            {
                var arr = inputs.ToArray();
                uint sent = SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
                lastInjectEnd = Environment.TickCount;
                if (sent != arr.Length) throw new Exception("o Windows recusou a entrada (janela de administrador ou tela bloqueada?)");
            }
        }

        static INPUT Mouse(uint flags, uint data)
        {
            var i = new INPUT { type = INPUT_MOUSE };
            i.u.mi = new MOUSEINPUT { dwFlags = flags, mouseData = data };
            return i;
        }

        static INPUT KeyIn(ushort vk, ushort scan, uint flags)
        {
            var i = new INPUT { type = INPUT_KEYBOARD };
            i.u.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags };
            return i;
        }

        static void MoveTo(int x, int y)
        {
            lock (InjectLock) { SetCursorPos(x, y); lastInjectEnd = Environment.TickCount; }
        }

        static Dictionary<string, object> Click(int x, int y, string button, bool dbl)
        {
            MoveTo(x, y);
            Thread.Sleep(30);
            uint down = MOUSEEVENTF_LEFTDOWN, up = MOUSEEVENTF_LEFTUP;
            if (button == "right") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; }
            else if (button == "middle") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; }
            var l = new List<INPUT> { Mouse(down, 0), Mouse(up, 0) };
            if (dbl) { l.Add(Mouse(down, 0)); l.Add(Mouse(up, 0)); }
            Send(l);
            return Obj();
        }

        static Dictionary<string, object> Scroll(int x, int y, string direction, int amount)
        {
            MoveTo(x, y);
            int n = Math.Max(1, Math.Min(amount, 20));
            bool horizontal = direction == "left" || direction == "right";
            int delta = (direction == "down" || direction == "left") ? -120 * n : 120 * n;
            if (direction == "left") delta = -120 * n;
            if (direction == "right") delta = 120 * n;
            Send(new List<INPUT> { Mouse(horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL, unchecked((uint)delta)) });
            return Obj();
        }

        static Dictionary<string, object> TypeText(string text)
        {
            foreach (char ch in text ?? "")
            {
                var l = new List<INPUT>();
                if (ch == '\n') { l.Add(KeyIn(0x0D, 0, 0)); l.Add(KeyIn(0x0D, 0, KEYEVENTF_KEYUP)); }
                else if (ch == '\r') continue;
                else if (ch == '\t') { l.Add(KeyIn(0x09, 0, 0)); l.Add(KeyIn(0x09, 0, KEYEVENTF_KEYUP)); }
                else { l.Add(KeyIn(0, ch, KEYEVENTF_UNICODE)); l.Add(KeyIn(0, ch, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)); }
                Send(l);
                Thread.Sleep(4);
            }
            return Obj("typed", (text ?? "").Replace("\r", "").Length);
        }

        static readonly Dictionary<string, ushort> Vk = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase) {
            {"return", 0x0D}, {"enter", 0x0D}, {"kp_enter", 0x0D}, {"tab", 0x09}, {"escape", 0x1B}, {"esc", 0x1B},
            {"backspace", 0x08}, {"delete", 0x2E}, {"del", 0x2E}, {"insert", 0x2D}, {"home", 0x24}, {"end", 0x23},
            {"pageup", 0x21}, {"page_up", 0x21}, {"prior", 0x21}, {"pagedown", 0x22}, {"page_down", 0x22}, {"next", 0x22},
            {"left", 0x25}, {"up", 0x26}, {"right", 0x27}, {"down", 0x28}, {"space", 0x20}, {"menu", 0x5D}, {"apps", 0x5D},
            {"ctrl", 0x11}, {"control", 0x11}, {"shift", 0x10}, {"alt", 0x12}, {"win", 0x5B}, {"super", 0x5B}, {"meta", 0x5B},
            {"cmd", 0x5B}, {"printscreen", 0x2C}, {"pause", 0x13}, {"capslock", 0x14}, {"numlock", 0x90}, {"scrolllock", 0x91}
        };
        static readonly HashSet<ushort> Extended = new HashSet<ushort> { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5D };

        static ushort VkOf(string name)
        {
            ushort v;
            if (Vk.TryGetValue(name, out v)) return v;
            if (name.Length > 1 && (name[0] == 'F' || name[0] == 'f'))
            {
                int n;
                if (int.TryParse(name.Substring(1), out n) && n >= 1 && n <= 24) return (ushort)(0x70 + n - 1);
            }
            if (name.Length == 1)
            {
                short s = VkKeyScan(name[0]);
                if (s != -1) return (ushort)(s & 0xFF);
            }
            throw new Exception("tecla desconhecida: " + name);
        }

        static Dictionary<string, object> Key(string key, List<string> mods)
        {
            var down = new List<INPUT>();
            var up = new List<INPUT>();
            var codes = new List<ushort>();
            foreach (var m in mods) codes.Add(VkOf(m));
            codes.Add(VkOf(key));
            foreach (var c in codes) down.Add(KeyIn(c, 0, Extended.Contains(c) ? KEYEVENTF_EXTENDEDKEY : 0));
            for (int i = codes.Count - 1; i >= 0; i--)
                up.Add(KeyIn(codes[i], 0, KEYEVENTF_KEYUP | (Extended.Contains(codes[i]) ? KEYEVENTF_EXTENDEDKEY : 0)));
            down.AddRange(up);
            Send(down);
            return Obj();
        }

        // Kill switch: every modifier and mouse button up, whatever state the last action left them in.
        static Dictionary<string, object> Release()
        {
            var l = new List<INPUT>();
            foreach (ushort c in new ushort[] { 0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5 })
                l.Add(KeyIn(c, 0, KEYEVENTF_KEYUP));
            l.Add(Mouse(MOUSEEVENTF_LEFTUP, 0));
            l.Add(Mouse(MOUSEEVENTF_RIGHTUP, 0));
            l.Add(Mouse(MOUSEEVENTF_MIDDLEUP, 0));
            try { Send(l); } catch { }
            return Obj();
        }

        // ------------------------------------------------------------------ watch (recording a task the person shows)
        // While the person records a task, what she does in the WATCHED apps (by process name) is registered:
        //  - each click: the point, the element under it (UI Automation) and a capture of the window at that moment;
        //  - each field she typed in: its final value, read from the field when it loses focus (never keystroke by
        //    keystroke); a password field (IsPassword) only says that a password was typed, never the value;
        //  - shortcuts with Ctrl/Alt/Win and Enter/Tab/Esc/F-keys (plain letters are never recorded);
        //  - the window in front when it changes.
        // Outside the watched apps only "another app" is noted, without title or content.
        delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
        [StructLayout(LayoutKind.Sequential)] struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData, flags, time; public IntPtr extra; }
        [StructLayout(LayoutKind.Sequential)] struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr extra; }
        [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; }
        [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr mod, uint thread);
        [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
        [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr hwnd, uint min, uint max);
        [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
        [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);

        static readonly object WatchLock = new object();
        static List<Dictionary<string, object>> watchEvents = new List<Dictionary<string, object>>();
        static HashSet<string> watchProcs;
        static HashSet<long> watchIgnore;
        static int watchMaxWidth = 1366;
        static Thread watchThread, watchWorker;
        static uint watchThreadId;
        static volatile bool watching, watchInjected;
        static HookProc mouseProc, keyProc;  // kept alive while hooked
        static IntPtr mouseHook, keyHook;
        static System.Collections.Concurrent.BlockingCollection<Dictionary<string, object>> watchClicks;
        static long watchStartTick;
        // the field in focus and its value when it got the focus (to emit what was typed when it loses it)
        static AutomationElement focusEl;
        static string focusName = "", focusValue = "", focusType = "", focusWindow = "";
        static bool focusPassword;
        static int keyCount, focusKeys; // keystrokes counted (never which keys) to know a password field was typed in
        static IntPtr lastFg = IntPtr.Zero;
        // a dialog often closes on the very click that answers it, before the click is resolved: its elements and
        // description are read when it comes to the front, and the click falls back to them
        static readonly Dictionary<long, List<object>> elCache = new Dictionary<long, List<object>>();
        static readonly Dictionary<long, Dictionary<string, object>> winCache = new Dictionary<long, Dictionary<string, object>>();

        static long Ms() { return Environment.TickCount - watchStartTick; }

        static void Emit(Dictionary<string, object> e)
        {
            e["t"] = Ms();
            lock (WatchLock) { if (watchEvents.Count < 5000) watchEvents.Add(e); }
        }

        static bool Watched(IntPtr hwnd, out Dictionary<string, object> info)
        {
            info = Describe(hwnd);
            if (info == null) return false;
            string proc = Convert.ToString(info["process"]).ToLowerInvariant();
            return proc.Length > 0 && watchProcs.Contains(proc);
        }

        static Dictionary<string, object> WatchStart(List<string> processes, int maxWidth, HashSet<long> ignore, bool acceptInjected)
        {
            watchInjected = acceptInjected; // only the automated tests ask for this: they click with SendInput
            if (watching) WatchStop();
            watchProcs = new HashSet<string>();
            foreach (var p in processes) watchProcs.Add(p.ToLowerInvariant().Replace(".exe", ""));
            if (watchProcs.Count == 0) throw new Exception("diga quais apps observar");
            watchIgnore = ignore ?? new HashSet<long>();
            watchMaxWidth = maxWidth;
            lock (WatchLock) { watchEvents = new List<Dictionary<string, object>>(); }
            watchStartTick = Environment.TickCount;
            focusEl = null; lastFg = IntPtr.Zero;
            watching = true;
            watchClicks = new System.Collections.Concurrent.BlockingCollection<Dictionary<string, object>>();
            watchWorker = new Thread(WatchWorker) { IsBackground = true };
            watchWorker.Start();
            var ready = new ManualResetEvent(false);
            watchThread = new Thread(delegate ()
            {
                watchThreadId = GetCurrentThreadId();
                mouseProc = MouseHook;
                keyProc = KeyHook;
                IntPtr mod = GetModuleHandle(null);
                mouseHook = SetWindowsHookEx(14 /* WH_MOUSE_LL */, mouseProc, mod, 0);
                keyHook = SetWindowsHookEx(13 /* WH_KEYBOARD_LL */, keyProc, mod, 0);
                ready.Set();
                MSG m;
                while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { }
                if (mouseHook != IntPtr.Zero) UnhookWindowsHookEx(mouseHook);
                if (keyHook != IntPtr.Zero) UnhookWindowsHookEx(keyHook);
                mouseHook = keyHook = IntPtr.Zero;
            }) { IsBackground = true };
            watchThread.Start();
            ready.WaitOne(3000);
            if (mouseHook == IntPtr.Zero) throw new Exception("o Windows não deixou observar o mouse");
            return Obj("watching", true);
        }

        static IntPtr MouseHook(int code, IntPtr w, IntPtr l)
        {
            if (code >= 0 && watching)
            {
                int msg = w.ToInt32();
                if (msg == 0x201 || msg == 0x204) // left / right button down
                {
                    var s = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(l, typeof(MSLLHOOKSTRUCT));
                    if ((s.flags & 1) == 0 || watchInjected) // a person, not SendInput (ours or anyone's)
                    {
                        // the window under the pointer NOW (cheap Win32): when the click is resolved a dialog may be gone
                        IntPtr under = WindowFromPoint(s.pt);
                        IntPtr top0 = under == IntPtr.Zero ? IntPtr.Zero : GetAncestor(under, GA_ROOT);
                        watchClicks.Add(Obj("x", s.pt.X, "y", s.pt.Y, "button", msg == 0x201 ? "left" : "right", "t0", Ms(),
                                            "top", top0.ToInt64()));
                    }
                }
            }
            return CallNextHookEx(IntPtr.Zero, code, w, l);
        }

        static readonly Dictionary<uint, string> KeyNames = new Dictionary<uint, string> {
            {0x0D, "Return"}, {0x09, "Tab"}, {0x1B, "Escape"}, {0x2E, "Delete"}, {0x70, "F1"}, {0x71, "F2"}, {0x72, "F3"},
            {0x73, "F4"}, {0x74, "F5"}, {0x75, "F6"}, {0x76, "F7"}, {0x77, "F8"}, {0x78, "F9"}, {0x79, "F10"}, {0x7A, "F11"},
            {0x7B, "F12"} };

        static IntPtr KeyHook(int code, IntPtr w, IntPtr l)
        {
            if (code >= 0 && watching)
            {
                int msg = w.ToInt32();
                if (msg == 0x100 || msg == 0x104) // key down / system key down
                {
                    var k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(l, typeof(KBDLLHOOKSTRUCT));
                    uint vk = k.vkCode;
                    if ((k.flags & 0x10) == 0 || watchInjected) keyCount++;
                    bool modifier = vk == 0x10 || vk == 0x11 || vk == 0x12 || vk == 0xA0 || vk == 0xA1 || vk == 0xA2 ||
                                    vk == 0xA3 || vk == 0xA4 || vk == 0xA5 || vk == 0x5B || vk == 0x5C;
                    bool ctrl = GetAsyncKeyState(0x11) < 0, alt = GetAsyncKeyState(0x12) < 0,
                         win = GetAsyncKeyState(0x5B) < 0 || GetAsyncKeyState(0x5C) < 0, shift = GetAsyncKeyState(0x10) < 0;
                    string name;
                    bool named = KeyNames.TryGetValue(vk, out name);
                    if (!modifier && ((k.flags & 0x10) == 0 || watchInjected) && (named || ctrl || alt || win))
                    {
                        if (!named)
                            name = (vk >= 0x30 && vk <= 0x5A) ? ((char)vk).ToString().ToLowerInvariant() : "vk" + vk;
                        var mods = new List<string>();
                        if (ctrl) mods.Add("ctrl");
                        if (alt) mods.Add("alt");
                        if (shift && (ctrl || alt || win)) mods.Add("shift");
                        if (win) mods.Add("win");
                        watchClicks.Add(Obj("kind", "key", "key", name, "modifiers", mods, "t0", Ms()));
                    }
                }
            }
            return CallNextHookEx(IntPtr.Zero, code, w, l);
        }

        // Off the hook thread (hooks must return fast): resolves clicks and keys, follows focus and the window in front.
        static void WatchWorker()
        {
            while (watching)
            {
                Dictionary<string, object> item;
                if (watchClicks.TryTake(out item, 300))
                {
                    try { Resolve(item); } catch { }
                }
                try { FollowFocus(); } catch { }
            }
        }

        static void Resolve(Dictionary<string, object> item)
        {
            IntPtr fg = GetForegroundWindow();
            if (item.ContainsKey("kind") && Convert.ToString(item["kind"]) == "key")
            {
                FlushField(); // Enter or a shortcut usually confirms what was typed
                Dictionary<string, object> fw;
                if (!Watched(fg, out fw)) return; // shortcuts in other apps are not recorded at all
                Emit(Obj("kind", "key", "key", item["key"], "modifiers", item["modifiers"], "window", fw["title"],
                         "process", fw["process"]));
                return;
            }
            var p = new POINT { X = Convert.ToInt32(item["x"]), Y = Convert.ToInt32(item["y"]) };
            IntPtr top = new IntPtr(Convert.ToInt64(item["top"]));
            if (top != IntPtr.Zero && watchIgnore.Contains(top.ToInt64())) return; // Agent Hangar's own windows
            Dictionary<string, object> info;
            bool gone = top != IntPtr.Zero && !IsWindow(top);
            if (gone && winCache.ContainsKey(top.ToInt64()))
            {
                info = winCache[top.ToInt64()]; // closed by this very click (a dialog's "Sim")
            }
            else if (!Watched(top, out info))
            {
                Emit(Obj("kind", "click", "outside", true));
                return;
            }
            FlushField();
            var ev = Obj("kind", "click", "button", item["button"], "x", p.X, "y", p.Y, "window", info["title"],
                         "process", info["process"], "hwnd", info["hwnd"]);
            if (!gone)
                try
                {
                    var el = AutomationElement.FromPoint(new System.Windows.Point(p.X, p.Y));
                    if (el != null)
                    {
                        var c = el.Current;
                        uint wpid;
                        GetWindowThreadProcessId(top, out wpid);
                        if ((uint)c.ProcessId == wpid) // not whatever window took its place
                            ev["element"] = Obj("name", (c.Name ?? "").Trim(), "type", MapType(c.ControlType != null ?
                                c.ControlType.ProgrammaticName.Replace("ControlType.", "").ToLowerInvariant() : ""), "password", c.IsPassword);
                    }
                }
                catch { }
            if (!ev.ContainsKey("element") || Convert.ToString(((Dictionary<string, object>)ev["element"])["name"]).Length == 0)
            {
                var hitEl = CachedAt(top.ToInt64(), p.X, p.Y);
                if (hitEl != null) ev["element"] = hitEl;
            }
            if (gone)
            {
                Emit(ev); // no capture of a window that no longer exists
                return;
            }
            try
            {
                var allowed = new HashSet<long>();
                uint pid;
                GetWindowThreadProcessId(top, out pid);
                allowed.Add(pid);
                var cap = Capture(top, watchMaxWidth, allowed, watchIgnore);
                ev["frame"] = cap["png"];
                ev["rect"] = cap["rect"];
                ev["scale"] = cap["scale"];
            }
            catch { }
            Emit(ev);
        }

        static void FlushField()
        {
            if (focusEl == null) return;
            try
            {
                if (focusPassword)
                {
                    // the value of a password field is never read: only that keys were pressed in it
                    if (keyCount != focusKeys)
                        Emit(Obj("kind", "type", "field", focusName, "fieldType", focusType, "password", true, "window", focusWindow));
                    focusKeys = keyCount;
                    return;
                }
                string now = ValueOf(focusEl, false);
                if (now != focusValue)
                {
                    Emit(Obj("kind", "type", "field", focusName, "fieldType", focusType, "value", now, "window", focusWindow));
                    focusValue = now;
                }
            }
            catch { }
        }

        static void FollowFocus()
        {
            IntPtr fg = GetForegroundWindow();
            if (fg != lastFg)
            {
                lastFg = fg;
                Dictionary<string, object> info;
                if (fg != IntPtr.Zero && !watchIgnore.Contains(fg.ToInt64()))
                {
                    if (Watched(fg, out info))
                    {
                        Emit(Obj("kind", "window", "window", info["title"], "process", info["process"]));
                        if (elCache.Count > 20) { elCache.Clear(); winCache.Clear(); }
                        winCache[fg.ToInt64()] = info;
                        try { elCache[fg.ToInt64()] = Elements(fg, 80, 800); } catch { }
                    }
                    else Emit(Obj("kind", "window", "outside", true));
                }
            }
            Dictionary<string, object> fw;
            if (!Watched(fg, out fw)) return;
            AutomationElement el;
            try { el = AutomationElement.FocusedElement; } catch { return; }
            if (el == null) return;
            bool same = false;
            try { same = focusEl != null && Automation.Compare(el, focusEl); } catch { }
            if (same) return;
            FlushField();
            try
            {
                var c = el.Current;
                string type = c.ControlType != null ? c.ControlType.ProgrammaticName.Replace("ControlType.", "").ToLowerInvariant() : "";
                if (type != "edit" && type != "document" && type != "combobox")
                {
                    focusEl = null;
                    return;
                }
                focusEl = el;
                focusName = (c.Name ?? "").Trim();
                focusType = MapType(type);
                focusPassword = c.IsPassword;
                focusWindow = Convert.ToString(fw["title"]);
                focusValue = ValueOf(el, focusPassword);
                focusKeys = keyCount;
            }
            catch { focusEl = null; }
        }

        // The smallest cached element of a window that contains the point (the window may be closed by now).
        static Dictionary<string, object> CachedAt(long hwnd, int x, int y)
        {
            List<object> els;
            if (!elCache.TryGetValue(hwnd, out els)) return null;
            Dictionary<string, object> best = null;
            long bestArea = long.MaxValue;
            foreach (Dictionary<string, object> e in els)
            {
                int ex = Convert.ToInt32(e["x"]), ey = Convert.ToInt32(e["y"]);
                int ew = Convert.ToInt32(e["width"]), eh = Convert.ToInt32(e["height"]);
                if (x < ex || y < ey || x >= ex + ew || y >= ey + eh) continue;
                long area = (long)ew * eh;
                if (area < bestArea) { bestArea = area; best = e; }
            }
            return best == null ? null : Obj("name", best["name"], "type", best["type"], "password", best["password"]);
        }

        static Dictionary<string, object> WatchPoll()
        {
            List<Dictionary<string, object>> out1;
            lock (WatchLock)
            {
                out1 = watchEvents;
                watchEvents = new List<Dictionary<string, object>>();
            }
            return Obj("events", out1, "watching", watching);
        }

        static Dictionary<string, object> WatchStop()
        {
            if (watching)
            {
                try { FlushField(); } catch { }
                watching = false;
                if (watchThreadId != 0) PostThreadMessage(watchThreadId, 0x12 /* WM_QUIT */, IntPtr.Zero, IntPtr.Zero);
                if (watchThread != null) watchThread.Join(2000);
                if (watchWorker != null) watchWorker.Join(2000);
            }
            return WatchPoll();
        }

        // ------------------------------------------------------------------ presence
        // The main process compares lastInput with lastInjectEnd (and the cursor with where we left it): input that is
        // not ours is the person using the computer.
        static Dictionary<string, object> Idle()
        {
            var info = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO)) };
            GetLastInputInfo(ref info);
            POINT p;
            GetCursorPos(out p);
            string desk = "";
            IntPtr d = OpenInputDesktop(0, false, 0x0001 /* DESKTOP_READOBJECTS */);
            if (d != IntPtr.Zero)
            {
                var sb = new StringBuilder(256);
                int needed;
                if (GetUserObjectInformation(d, 2 /* UOI_NAME */, sb, sb.Capacity * 2, out needed)) desk = sb.ToString();
                CloseDesktop(d);
            }
            long now = Environment.TickCount;
            long last = unchecked((int)info.dwTime);
            long inj;
            lock (InjectLock) { inj = lastInjectEnd; }
            return Obj("now", now, "lastInput", last, "lastInjectEnd", inj, "cursor", Obj("x", p.X, "y", p.Y),
                "desktop", desk, "locked", desk.Length == 0 || !desk.Equals("Default", StringComparison.OrdinalIgnoreCase));
        }

        // ------------------------------------------------------------------ helpers
        static Dictionary<string, object> Obj(params object[] kv)
        {
            var d = new Dictionary<string, object>();
            for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
            return d;
        }

        static string Str(Dictionary<string, object> r, string k)
        {
            object v;
            return r.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : "";
        }

        static int Int(Dictionary<string, object> r, string k, int dflt)
        {
            object v;
            if (!r.TryGetValue(k, out v) || v == null) return dflt;
            return (int)Math.Round(Convert.ToDouble(v));
        }

        static bool Bool(Dictionary<string, object> r, string k)
        {
            object v;
            return r.TryGetValue(k, out v) && v is bool && (bool)v;
        }

        static IntPtr Hwnd(Dictionary<string, object> r)
        {
            object v;
            if (!r.TryGetValue("hwnd", out v) || v == null) throw new Exception("hwnd ausente");
            return new IntPtr(Convert.ToInt64(v));
        }

        static List<string> Strs(Dictionary<string, object> r, string k)
        {
            var l = new List<string>();
            object v;
            if (r.TryGetValue(k, out v) && v is System.Collections.IEnumerable && !(v is string))
                foreach (var x in (System.Collections.IEnumerable)v) l.Add(Convert.ToString(x));
            return l;
        }

        static HashSet<long> Ints(Dictionary<string, object> r, string k)
        {
            object v;
            if (!r.TryGetValue(k, out v) || !(v is System.Collections.IEnumerable)) return null;
            var s = new HashSet<long>();
            foreach (var x in (System.Collections.IEnumerable)v) s.Add(Convert.ToInt64(x));
            return s;
        }
    }
}
