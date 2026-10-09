using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

class Program {
    const uint LeftDown = 0x0002;
    const uint LeftUp = 0x0004;
    const uint RightDown = 0x0008;
    const uint RightUp = 0x0010;
    const uint MiddleDown = 0x0020;
    const uint MiddleUp = 0x0040;
    const uint Wheel = 0x0800;
    const uint KeyUp = 0x0002;
    const uint Unicode = 0x0004;

    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);

    [DllImport("user32.dll")]
    static extern uint SendInput(uint count, INPUT[] inputs, int size);

    delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumProc proc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int cmd);

    [DllImport("user32.dll")]
    static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT {
        public uint type;
        public INPUTUNION u;
    }

    [STAThread]
    static int Main(string[] args) {
        SetProcessDPIAware();
        if (args.Length > 0 && args[0] == "size") {
            System.Drawing.Rectangle bounds = Screen.PrimaryScreen.Bounds;
            Console.WriteLine("{\"width\":" + bounds.Width + ",\"height\":" + bounds.Height + ",\"x\":" + bounds.X + ",\"y\":" + bounds.Y + "}");
            return 0;
        }
        // 这个程序没有控制台窗口，设置 Console.InputEncoding 会因句柄无效直接退出。
        using (StreamReader reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false))) {
            string line;
            while ((line = reader.ReadLine()) != null) {
                try {
                    Handle(line);
                } catch (Exception ex) {
                    Console.Error.WriteLine(ex.Message);
                }
            }
        }
        return 0;
    }

    static void Handle(string line) {
        string kind = FieldString(line, "t");
        if (kind == null || kind == "ping") return;
        int x = (int)Math.Round(FieldNumber(line, "x"));
        int y = (int)Math.Round(FieldNumber(line, "y"));
        int button = (int)Math.Round(FieldNumber(line, "b"));
        if (kind == "move" || kind == "drag") {
            SetCursorPos(x, y);
            return;
        }
        if (kind == "down" || kind == "up") {
            SetCursorPos(x, y);
            mouse_event(MouseFlag(kind, button), 0, 0, 0, UIntPtr.Zero);
            return;
        }
        if (kind == "wheel") {
            SetCursorPos(x, y);
            int dy = (int)Math.Round(-FieldNumber(line, "dy"));
            int dx = (int)Math.Round(FieldNumber(line, "dx"));
            if (dy != 0) mouse_event(Wheel, 0, 0, unchecked((uint)dy), UIntPtr.Zero);
            if (dx != 0) mouse_event(0x01000, 0, 0, unchecked((uint)dx), UIntPtr.Zero);
            return;
        }
        if (kind == "text") {
            TypeText(FieldString(line, "text") ?? "");
            return;
        }
        if (kind == "key") {
            Tap(Vk(FieldString(line, "text") ?? ""));
            return;
        }
        if (kind == "hotkey") {
            string[] parts = (FieldString(line, "text") ?? "").Split('+');
            ushort[] keys = new ushort[parts.Length];
            int count = 0;
            for (int i = 0; i < parts.Length; i++) {
                ushort vk = Vk(parts[i].Trim());
                if (vk == 0) continue;
                keys[count++] = vk;
            }
            for (int i = 0; i < count; i++) Key(keys[i], true);
            for (int i = count - 1; i >= 0; i--) Key(keys[i], false);
            return;
        }
        if (kind == "focus") Focus(FieldString(line, "text") ?? "");
    }

    static void Focus(string needle) {
        string wanted = needle.Trim().ToLowerInvariant();
        IntPtr found = IntPtr.Zero;
        EnumProc callback = (hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            StringBuilder title = new StringBuilder(512);
            GetWindowText(hWnd, title, title.Capacity);
            string text = title.ToString();
            if (text.Length == 0) return true;
            if (wanted.Length == 0 || text.ToLowerInvariant().Contains(wanted)) {
                found = hWnd;
                return false;
            }
            return true;
        };
        EnumWindows(callback, IntPtr.Zero);
        if (found == IntPtr.Zero) return;
        ShowWindow(found, 9);
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        SetForegroundWindow(found);
        keybd_event(0x12, 0, 2, UIntPtr.Zero);
    }

    static uint MouseFlag(string kind, int button) {
        bool down = kind == "down";
        if (button == 1) return down ? RightDown : RightUp;
        if (button == 2) return down ? MiddleDown : MiddleUp;
        return down ? LeftDown : LeftUp;
    }

    static void TypeText(string text) {
        foreach (char ch in text) {
            KeyScan(ch, true);
            KeyScan(ch, false);
        }
    }

    static void KeyScan(char ch, bool down) {
        INPUT input = new INPUT();
        input.type = 1;
        input.u.ki.wScan = ch;
        input.u.ki.dwFlags = Unicode | (down ? 0 : KeyUp);
        SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT)));
    }

    static void Tap(ushort vk) {
        if (vk == 0) return;
        Key(vk, true);
        Key(vk, false);
    }

    static void Key(ushort vk, bool down) {
        INPUT input = new INPUT();
        input.type = 1;
        input.u.ki.wVk = vk;
        input.u.ki.dwFlags = down ? 0 : KeyUp;
        SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT)));
    }

    static ushort Vk(string name) {
        if (name == null) return 0;
        string key = name.Trim().ToLowerInvariant();
        switch (key) {
            case "enter":
            case "return": return 0x0D;
            case "escape":
            case "esc": return 0x1B;
            case "tab": return 0x09;
            case "space": return 0x20;
            case "backspace": return 0x08;
            case "delete": return 0x2E;
            case "up": return 0x26;
            case "down": return 0x28;
            case "left": return 0x25;
            case "right": return 0x27;
            case "home": return 0x24;
            case "end": return 0x23;
            case "pageup": return 0x21;
            case "pagedown": return 0x22;
            case "shift": return 0x10;
            case "control":
            case "ctrl":
            case "command":
            case "cmd": return 0x11;
            case "alt":
            case "option": return 0x12;
            case "win":
            case "meta": return 0x5B;
            case "f1": return 0x70;
            case "f2": return 0x71;
            case "f3": return 0x72;
            case "f4": return 0x73;
            case "f5": return 0x74;
            case "f6": return 0x75;
            case "f7": return 0x76;
            case "f8": return 0x77;
            case "f9": return 0x78;
            case "f10": return 0x79;
            case "f11": return 0x7A;
            case "f12": return 0x7B;
            default:
                if (key.Length != 1) return 0;
                char ch = char.ToUpperInvariant(key[0]);
                if ((ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')) return ch;
                return 0;
        }
    }

    static string FieldString(string json, string key) {
        string token = "\"" + key + "\"";
        int found = json.IndexOf(token, StringComparison.Ordinal);
        if (found < 0) return null;
        int colon = json.IndexOf(':', found + token.Length);
        if (colon < 0) return null;
        int quote = json.IndexOf('"', colon + 1);
        if (quote < 0) return null;
        StringBuilder value = new StringBuilder();
        for (int i = quote + 1; i < json.Length; i++) {
            char ch = json[i];
            if (ch == '\\' && i + 1 < json.Length) {
                char next = json[i + 1];
                if (next == 'n') value.Append('\n');
                else if (next == 'r') value.Append('\r');
                else if (next == 't') value.Append('\t');
                else if (next == 'u' && i + 5 < json.Length) {
                    value.Append((char)Convert.ToInt32(json.Substring(i + 2, 4), 16));
                    i += 5;
                    continue;
                } else value.Append(next);
                i++;
                continue;
            }
            if (ch == '"') return value.ToString();
            value.Append(ch);
        }
        return null;
    }

    static double FieldNumber(string json, string key) {
        string token = "\"" + key + "\"";
        int found = json.IndexOf(token, StringComparison.Ordinal);
        if (found < 0) return 0;
        int colon = json.IndexOf(':', found + token.Length);
        if (colon < 0) return 0;
        int i = colon + 1;
        while (i < json.Length && (json[i] == ' ' || json[i] == '\t')) i++;
        int start = i;
        while (i < json.Length && (char.IsDigit(json[i]) || json[i] == '-' || json[i] == '.' || json[i] == '+')) i++;
        double value;
        if (double.TryParse(json.Substring(start, Math.Max(0, i - start)), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out value)) return value;
        return 0;
    }
}
