using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

class Program {
    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    static extern bool GetCursorInfo(ref CURSORINFO info);

    [DllImport("user32.dll")]
    static extern bool DrawIcon(IntPtr hdc, int x, int y, IntPtr hIcon);

    [StructLayout(LayoutKind.Sequential)]
    struct POINT {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct CURSORINFO {
        public int cbSize;
        public int flags;
        public IntPtr hCursor;
        public POINT ptScreenPos;
    }

    [STAThread]
    static int Main(string[] args) {
        try {
            SetProcessDPIAware();
            Rectangle bounds = Screen.PrimaryScreen.Bounds;
            if (args.Length > 0 && args[0] == "shot") {
                if (args.Length < 2) return 2;
                Rectangle box = bounds;
                if (args.Length >= 6) {
                    box = new Rectangle(int.Parse(args[2]), int.Parse(args[3]), int.Parse(args[4]), int.Parse(args[5]));
                }
                using (Bitmap raw = Capture(box)) {
                    using (Bitmap scaled = Fit(raw, 1080)) {
                        scaled.Save(args[1], ImageFormat.Png);
                        Console.WriteLine(scaled.Width + " " + scaled.Height);
                    }
                }
                return 0;
            }
            Stream stdout = Console.OpenStandardOutput();
            while (true) {
                using (Bitmap raw = Capture(bounds)) {
                    using (Bitmap scaled = FitWidth(raw, 1920)) {
                        byte[] jpeg = EncodeJpeg(scaled, 82L);
                        stdout.Write(jpeg, 0, jpeg.Length);
                        stdout.Flush();
                    }
                }
                Thread.Sleep(200);
            }
        } catch (Exception ex) {
            Console.Error.WriteLine(ex.Message);
            return 1;
        }
    }

    static Bitmap Capture(Rectangle box) {
        Bitmap bitmap = new Bitmap(Math.Max(1, box.Width), Math.Max(1, box.Height));
        using (Graphics graphics = Graphics.FromImage(bitmap)) {
            graphics.CopyFromScreen(box.X, box.Y, 0, 0, bitmap.Size);
            CURSORINFO info = new CURSORINFO();
            info.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
            if (GetCursorInfo(ref info) && info.flags == 1 && info.hCursor != IntPtr.Zero) {
                IntPtr dc = graphics.GetHdc();
                DrawIcon(dc, info.ptScreenPos.X - box.X, info.ptScreenPos.Y - box.Y, info.hCursor);
                graphics.ReleaseHdc(dc);
            }
        }
        return bitmap;
    }

    static Bitmap FitWidth(Bitmap source, int targetWidth) {
        double scale = Math.Min(1, targetWidth / (double)Math.Max(1, source.Width));
        int width = Even(Math.Max(2, (int)Math.Round(source.Width * scale)));
        int height = Even(Math.Max(2, (int)Math.Round(source.Height * scale)));
        return new Bitmap(source, new Size(width, height));
    }

    static Bitmap Fit(Bitmap source, int longest) {
        double scale = Math.Min(1, longest / (double)Math.Max(source.Width, source.Height));
        int width = Math.Max(1, (int)Math.Round(source.Width * scale));
        int height = Math.Max(1, (int)Math.Round(source.Height * scale));
        return new Bitmap(source, new Size(width, height));
    }

    static int Even(int value) {
        return value - (value % 2);
    }

    static byte[] EncodeJpeg(Bitmap bitmap, long quality) {
        ImageCodecInfo jpeg = null;
        ImageCodecInfo[] codecs = ImageCodecInfo.GetImageEncoders();
        for (int i = 0; i < codecs.Length; i++) {
            if (codecs[i].MimeType == "image/jpeg") jpeg = codecs[i];
        }
        if (jpeg == null) throw new InvalidOperationException("找不到 JPEG 编码器");
        using (EncoderParameters parameters = new EncoderParameters(1)) {
            parameters.Param[0] = new EncoderParameter(Encoder.Quality, quality);
            using (MemoryStream stream = new MemoryStream()) {
                bitmap.Save(stream, jpeg, parameters);
                return stream.ToArray();
            }
        }
    }
}
