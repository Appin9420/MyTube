// MyTubeTray - single-exe tray wrapper for the MyTube headless backend.
// Compiled with the in-box .NET Framework compiler (no extra dependencies):
//   %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:winexe
//     /out:MyTubeTray.exe /win32icon:mytube-tray.ico
//     /r:System.Windows.Forms.dll /r:System.Drawing.dll MyTubeTray.cs
// Tray icon + menu + backend supervision, same semantics as the PowerShell
// tray this replaces (single-instance mutex, port guard, supervision with
// rate-limited restart, handover with the desktop app via the scheduled task).

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

namespace MyTubeTray
{
    static class Program
    {
        // Fallback locations for the desktop-bundled backend. Override by
        // placing a MyTubeTray.ini next to the exe:
        //   DesktopRes=D:\MyTube\desktop\release\win-unpacked\resources
        //   MyTubeHome=C:\Users\<you>\AppData\Roaming\MyTube\server-home
        static string DesktopRes = @"D:\MyTube\desktop\release\win-unpacked\resources";
        static string MyTubeHome = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "MyTube", "server-home");
        const int Port = 5551;
        const int RestartDelayMs = 15000;
        const string MutexName = "Global\\MyTubeHeadlessTray";

        static Mutex mutex;
        static NotifyIcon trayIcon;
        static ContextMenuStrip menu;
        static ToolStripMenuItem itemStatus;
        static Icon iconGreen, iconGray;
        static Process backend;
        static bool desiredRunning = true;
        static long lastStartTicks = 0;
        static readonly object logLock = new object();

        [STAThread]
        static void Main()
        {
            LoadConfig();

            bool acquired = false;
            mutex = new Mutex(false, MutexName);
            try { acquired = mutex.WaitOne(0); }
            catch (AbandonedMutexException) { acquired = true; } // previous holder died
            if (!acquired) return;

            if (!Directory.Exists(MyTubeHome))
                Directory.CreateDirectory(MyTubeHome);

            try { iconGreen = IconFromB64(IconGreenB64); } catch { }
            try { iconGray = IconFromB64(IconGrayB64); } catch { }
            if (iconGreen == null || iconGray == null)
            {
                MessageBox.Show("托盘图标加载失败。");
                return;
            }

            Application.EnableVisualStyles();

            trayIcon = new NotifyIcon();
            trayIcon.Icon = iconGray;
            trayIcon.Text = "MyTube";
            trayIcon.Visible = true;
            BuildMenu();

            if (TestPortBusy())
            {
                Balloon("端口已被桌面版占用，托盘进入待机。");
            }
            else
            {
                StartBackend();
                Balloon("MyTube 服务已启动（右键图标可操作）。");
            }

            var timer = new System.Windows.Forms.Timer { Interval = 3000 };
            timer.Tick += Tick;
            timer.Start();

            Application.Run();

            trayIcon.Visible = false;
            if (!desiredRunning) StopBackend();
            try { mutex.ReleaseMutex(); } catch { }
        }

        static void LoadConfig()
        {
            try
            {
                string ini = Path.Combine(
                    Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location),
                    "MyTubeTray.ini");
                if (!File.Exists(ini)) return;
                foreach (string line in File.ReadAllLines(ini))
                {
                    string l = line.Trim();
                    if (l.Length == 0 || l.StartsWith(";") || l.StartsWith("#")) continue;
                    int i = l.IndexOf('=');
                    if (i <= 0) continue;
                    string k = l.Substring(0, i).Trim();
                    string v = l.Substring(i + 1).Trim();
                    if (k == "DesktopRes") DesktopRes = v;
                    else if (k == "MyTubeHome") MyTubeHome = v;
                }
            }
            catch { }
        }

        static Icon IconFromB64(string b64)
        {
            using (var ms = new MemoryStream(Convert.FromBase64String(b64)))
            using (var bmp = new Bitmap(ms))
            {
                IntPtr h = bmp.GetHicon();
                return (Icon)Icon.FromHandle(h).Clone();
            }
        }

        static void BuildMenu()
        {
            menu = new ContextMenuStrip();
            var itemOpen = new ToolStripMenuItem("打开 MyTube（浏览器）");
            itemOpen.Click += delegate { try { Process.Start("http://localhost:" + Port); } catch { } };
            menu.Items.Add(itemOpen);
            menu.Items.Add(new ToolStripSeparator());
            itemStatus = new ToolStripMenuItem("服务状态：启动中…");
            itemStatus.Enabled = false;
            menu.Items.Add(itemStatus);
            var itemRestart = new ToolStripMenuItem("重启服务");
            itemRestart.Click += delegate { AppendLog("[tray-exe] manual restart requested"); StopBackend(); };
            menu.Items.Add(itemRestart);
            menu.Items.Add(new ToolStripSeparator());
            var itemExit = new ToolStripMenuItem("停止服务并退出");
            itemExit.Click += delegate
            {
                AppendLog("[tray-exe] exit requested from menu");
                desiredRunning = false;
                StopBackend();
                trayIcon.Visible = false;
                Application.Exit();
            };
            menu.Items.Add(itemExit);
            trayIcon.ContextMenuStrip = menu;
        }

        static bool TestPortBusy()
        {
            using (var client = new System.Net.Sockets.TcpClient())
            {
                try { client.Connect("127.0.0.1", Port); return client.Connected; }
                catch { return false; }
            }
        }

        static void StartBackend()
        {
            var psi = new ProcessStartInfo();
            psi.FileName = Path.Combine(DesktopRes, "bin", "node.exe");
            psi.Arguments = "\"" + Path.Combine(DesktopRes, "server", "dist", "src", "server.js") + "\"";
            psi.WorkingDirectory = MyTubeHome;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;

            Environment.SetEnvironmentVariable("NODE_ENV", "production");
            Environment.SetEnvironmentVariable("MYTUBE_ADMIN_TRUST_LEVEL", "application");
            Environment.SetEnvironmentVariable("YT_DLP_PATH",
                Path.Combine(DesktopRes, "bin", "yt-dlp.exe"));
            Environment.SetEnvironmentVariable("YT_DLP_JS_RUNTIME", "node");
            Environment.SetEnvironmentVariable("PATH",
                Path.Combine(DesktopRes, "bin") + ";" + Environment.GetEnvironmentVariable("PATH"));
            string jwt = Path.Combine(MyTubeHome, ".jwt-secret");
            if (File.Exists(jwt))
                Environment.SetEnvironmentVariable("JWT_SECRET", File.ReadAllText(jwt).Trim());

            backend = Process.Start(psi);
            backend.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
            {
                if (e.Data != null) AppendLog(e.Data);
            };
            backend.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
            {
                if (e.Data != null) AppendLog("[stderr] " + e.Data);
            };
            backend.BeginOutputReadLine();
            backend.BeginErrorReadLine();
            lastStartTicks = DateTime.UtcNow.Ticks;
            AppendLog("backend started (pid " + backend.Id + ")");
        }

        static void StopBackend()
        {
            if (backend != null && !backend.HasExited)
            {
                try { backend.Kill(); } catch { }
            }
            backend = null;
        }

        static void AppendLog(string text)
        {
            lock (logLock)
            {
                try
                {
                    System.IO.File.AppendAllText(
                        Path.Combine(MyTubeHome, "backend.log"),
                        "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] [tray-exe] " + text + Environment.NewLine);
                }
                catch { }
            }
        }

        static void Tick(object sender, EventArgs e)
        {
            try
            {
                // Our backend alive: leave it alone, whether booting or serving.
                // Never key off the port here - the backend binds ~60s after
                // start and killing on "port busy" would murder it.
                bool alive = backend != null && !backend.HasExited;
                if (alive)
                {
                    trayIcon.Icon = iconGreen;
                    itemStatus.Text = "服务状态：运行中";
                    trayIcon.Text = "MyTube - 运行中";
                    return;
                }

                if (!desiredRunning)
                {
                    trayIcon.Icon = iconGray;
                    itemStatus.Text = "服务状态：已停止";
                    trayIcon.Text = "MyTube - 已停止";
                    return;
                }

                if (TestPortBusy())
                {
                    // Nothing of ours running, port served by the desktop app.
                    trayIcon.Icon = iconGray;
                    itemStatus.Text = "服务状态：由桌面版运行中";
                    trayIcon.Text = "MyTube - 由桌面版运行";
                    return;
                }

                long now = DateTime.UtcNow.Ticks;
                if ((now - lastStartTicks) < RestartDelayMs * 10000) return;
                AppendLog("[tray-exe] supervision: backend not running, restarting");
                StartBackend();
                trayIcon.Icon = iconGreen;
                itemStatus.Text = "服务状态：启动中…";
            }
            catch (Exception ex)
            {
                AppendLog("[tray-exe] tick error: " + ex.Message);
            }
        }

        static void Balloon(string text)
        {
            try { trayIcon.ShowBalloonTip(4000, "MyTube", text, ToolTipIcon.Info); } catch { }
        }

        // base64 tray icons injected at build time (tray-color.png / tray-gray.png)
        const string IconGreenB64 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAABAAAAAQBPJcTWAAAFfklEQVR4nMWXa2xURRTHfzN3dre0pcWFFhRBwEKhkkYFkUAIBvCLQCKRiCRAQqKBKKFCAxGrX2jwRVBjgPgkhsT4yZAYIDEGeaQYJdEvWkihtFpCCoVd6NNu9947Zu7d2+62u7QoCSfZzJ29M+f/P/9z5nGF1pr7aeq+ojNSAhqB1hIpnOGHgqOxLIEr/O7/JiAMPGJ4cH8wKIE3VoMYjoQagT9NV2Isf8WeZkbpCcIqcacJ3Q6RYzGWLh7Dr+PDxIYjoe4I72qFFEnqGqv59rddvPXcEqaPO4njhJDSHuAItkYpSfL0bRau+Zlj22fzzr4yahzzvyB59wQcx/JVtGDRrP1cbinnyPFqdm44iWVlODThWSmQ96+ybf4Ujrw6mQOmL/1lZuVKocoJbln+hM7OUQgdY928l9j2wXkOH32bNUv30NUTRUqHvAJchGUp4vuaqYnfZuYf86kwResm5CgZUf/4LHVWEmqo7K4Pfvr0fGprd1Bf/yTJ5AOEQja2rfjmk93sKH4dJynJLyL5ysfo/CK0a7sv9onoa2HanXO09rkoyxK3KBn9u1pctlc+Ev0lGwmVNfKjR5ewcuWPRsGsCrX1Rr2gYnFu3+zCLQyDk6RQCjq7KHYQSAEyooq5fXMKjTefL1r/1LPh6SU/4WorfTmrDMeW5XptdfVHHriUSbSrWL9BsGABhMP+OK+uXVBh8iufQauwkdirBSVA9CVJXLlF+/k2TQSbpBPqPXn5w4enlzyOFD7GEAKuawBdLlx4lEsXH0sRCnH8B1i2zB9j6smAp8xsDwW93f7/gZnn/FIKn5hIXmVcXP6uPqSlhWjvm10S75kWieY3eZua8ImotIm+57a2sWhT+sDOnT74qVOweTNcvQpSphExrT+0XxnXRU+cCJ99TsGihYyZN4mmuhaskGX19tjjIlGa0sNQQ/LrOAMhLl/ut6tXQyzGSE10tKNfWAVX/mb0jFK6z7WihTB7xYDvnARE2piiIqiv98GVMuQyIvXMsvx+8C7478YNb64un0unsnCROKYyhyWgc+yaBiCQ3oAfOgR1dX5rzKQmINVPRnuHQqelcIXEHioAd38ceytAQ0UFbNwIq1bB9u1w6dLAu3TeAjpSBBxxLwgE1t3ltytW+D9TrCdO+PKbQkydEoZAp1I4GQTEPSCgQn7b2Ag1NXDmjN8P0mBMDyhgCNgpAgG5/0YgkLi3Fw4ehKoqsO3M90GkpjbJpkBaHAy2wWOCiEyRpRfi2rUQj6e8qEwSwVjHxZGBAla/AncmoNOeTZTl5X5ejcNUfj0z4AbY9M27wHkAHgrBtKnYCehQYS96c0aMQAEx8Hz2LMyZA/v3w5YtmWvdmG2TsbEbS4EnP/2CyNhSLjR2c0MqIpYYZh8Qwo89Gu3or5M9e/xlZrbhdeugudmPsF8tjUz0ZObdKDJ1KpFx47ne43CgySUZCZli1AVh2T5YZzWEwMyZDTw4oYXWa5Npa3OZO9fyqnzhQsjLywB3VIjzM+Zhm80wcGm2ggT82ZzgQJPD9aR0hJJyQp5omVJoXUyJnIOAbSsiEZs3dtVSVfWld5Vqa/MrPc2CZdQZzmfV4YvcHFNK2O7DFeYCjdf2asEoUzMhrFgC3ixTu8MS19wRLYGdvQaUsr2jcuvWr7z+e+/uoPVamUcki2nXJRaK0B4O4d1A0u4vpusInIciurF2ltz78iRxSINMBx9KwFfC7SexadPXNDSUEY8X47oi2GpF6kIyWoX5vmIMfcpcPhWpA92TSAp0VNFenk9jRJpvFY/TkJpV2SLzSATpqKxsyDomNXkRw9tg2YcnMJAO0f/LYY7Mmh3PjE6m4HKBezA5Z3sehNH7jp9WueFHZvf96/hf8ktBAb+deMkAAAAASUVORK5CYII=";
        const string IconGrayB64 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAAAAABWESUoAAAACXBIWXMAAAABAAAAAQBPJcTWAAACGUlEQVR4nL1SO2gUURS9980nMzuZ7AaNuiEShAU/KLFQdguRLSwkIImIvXam1VJsrCKWKZJCDIhVCosUdiIWgoRo/BBEGyW4Me46sklWd/bz7pX3dmbNDiSlt3jzZu7h3HPOHWTYu0z4j4Cwko1fWl9GUkkAic8vLx8ioa/f5ibP6+s/AAPkNl5N6o8ClvOnAHsZEEMoPHpxhoRN4vXmNdGOqfWT8f3CmkR+1i+dcYd+Dz1lMXD8QBdAYuk2W38IRSDdXy4ZW4zWVqk4zNgBCPkQUzRx1AFkY9QAhtbPr0b7bVbpMNWA76U+cXcssqhG2rkjz7Fa8xk7gKpsXB/7MBsgg1KPvG/q5LEVs+7HIkmaZxvT6x4BCFIzf0w/GFmRBB0GAGAjVSlnSKAMPSTATGVjP3NPUMxIjM1bq4umQ0BIUb8bNeqjffhCYX7N0lJIxZvYJmMo8/k7S65qJRh0IZtG6fGqzcDA6tgBYDWDRXNxvtqPjAhAiWUxIHPf/bKdloqKezUgN7Ju3SXY9IAQRN0dau7UgKLxMTc1FwJjW9tJ3fDftUztTQN8ExcKF4tl1ZQMSAe97WUDnIhBwPBgENy8csJlBMwIBqh9elMDPx0zkH31XjqYsZQW65ylDLVNrBfN7v/Al+hJYGv1JA2lzkCveFrH2xEJE+Pr21o2DghlGJ1BoycHtkajxJIVBxVluSsg3udegF3qL+n52KCGmY63AAAAAElFTkSuQmCC";
    }
}
