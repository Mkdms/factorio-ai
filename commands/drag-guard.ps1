param([int]$ProcessId)
# Keep the game running while the user drags its window. Started by src/io/drag-guard.ts.
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less script in the system code page, so non-ASCII text can break it.
#
# Dragging a title bar puts the window's thread in the system move loop; Factorio's clock stops there (measured 2026-11-07:
# 0 ticks per second for the whole drag, then a catch-up at 170-430). Nothing is injected into the game: from outside we hear
# "move started", cancel the loop at once, and move the window with the mouse from this process (measured: steady 60 ticks per
# second during the drag, loop gone in 0-32 ms).
# A transparent full-screen layer stays on top during the drag so the game gets no mouse events; a held left button entering
# the game view would count as a click. Title bar only: resizing by the borders is left to the system.
Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class DragGuard {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }
  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO { public int cbSize; public uint flags; public IntPtr hwndActive; public IntPtr hwndFocus; public IntPtr hwndCapture; public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize; public IntPtr hwndCaret; public RECT rcCaret; }
  public delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObj, int idChild, uint thread, uint time);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowExW(uint ex, string cls, string title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);

  const uint EVENT_SYSTEM_MOVESIZESTART = 0x000A, WM_CANCELMODE = 0x001F, WM_LBUTTONUP = 0x0202, GUI_INMOVESIZE = 2;
  const uint SWP_NOSIZE = 1, SWP_NOZORDER = 4, SWP_NOACTIVATE = 0x10, SWP_ASYNCWINDOWPOS = 0x4000;
  static WinEventProc keep;
  static IntPtr overlay;
  static int dragging;

  static bool InLoop(uint thread) {
    var g = new GUITHREADINFO(); g.cbSize = Marshal.SizeOf(g);
    return GetGUIThreadInfo(thread, ref g) && (g.flags & GUI_INMOVESIZE) != 0;
  }
  static void Say(string s) { Console.WriteLine(s); Console.Out.Flush(); }

  static void Follow(IntPtr hwnd, uint thread, int dx, int dy) {
    var t0 = Environment.TickCount;
    try {
      PostMessage(hwnd, WM_CANCELMODE, IntPtr.Zero, IntPtr.Zero);
      for (int i = 0; i < 5 && InLoop(thread); i++) Thread.Sleep(10);
      if (InLoop(thread)) {
        // The loop also ends on a left button release. Never send Esc here: if the loop has just ended it reaches the game and opens the menu.
        POINT c; GetCursorPos(out c); ScreenToClient(hwnd, ref c);
        PostMessage(hwnd, WM_LBUTTONUP, IntPtr.Zero, (IntPtr)((c.Y << 16) | (c.X & 0xFFFF)));
        for (int i = 0; i < 10 && InLoop(thread); i++) Thread.Sleep(10);
      }
      if (InLoop(thread)) { Say("stuck: move loop did not end, leaving the drag to the system"); return; }
      while ((GetAsyncKeyState(0x01) & 0x8000) != 0) {
        POINT p; GetCursorPos(out p);
        SetWindowPos(hwnd, IntPtr.Zero, p.X - dx, p.Y - dy, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
        Thread.Sleep(10);
      }
      Say("drag: " + (Environment.TickCount - t0) + " ms");
    } finally {
      ShowWindow(overlay, 0);
      Interlocked.Exchange(ref dragging, 0);
    }
  }

  static void OnEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObj, int idChild, uint thread, uint time) {
    if (ev != EVENT_SYSTEM_MOVESIZESTART || idObj != 0) return;
    POINT p; GetCursorPos(out p);
    RECT r; GetWindowRect(hwnd, out r);
    POINT c = new POINT(); ClientToScreen(hwnd, ref c);
    bool caption = p.Y < c.Y && p.Y >= r.Top + 6 && p.X > r.Left + 8 && p.X < r.Right - 8 && (GetAsyncKeyState(0x01) & 0x8000) != 0;
    if (!caption) return;
    if (Interlocked.CompareExchange(ref dragging, 1, 0) != 0) return;
    ShowWindow(overlay, 4); // SW_SHOWNOACTIVATE: focus stays where it was
    int dx = p.X - r.Left, dy = p.Y - r.Top;
    new Thread(() => Follow(hwnd, thread, dx, dy)) { IsBackground = true }.Start();
  }

  public static void Run(int pid) {
    SetProcessDPIAware();
    Process game;
    try { game = Process.GetProcessById(pid); } catch (ArgumentException) { Say("fail: no process " + pid); return; }
    // WS_EX_LAYERED | TOPMOST | TOOLWINDOW | NOACTIVATE; WS_POPUP | SS_NOTIFY (a plain STATIC is transparent to the mouse)
    overlay = CreateWindowExW(0x00080000 | 0x00000008 | 0x00000080 | 0x08000000, "STATIC", "", 0x80000000 | 0x00000100, GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79), IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
    if (overlay == IntPtr.Zero) { Say("fail: no overlay window"); return; }
    SetLayeredWindowAttributes(overlay, 0, 1, 2); // alpha 1/255: invisible but still catches the mouse (0 lets it through)
    keep = OnEvent;
    var hook = SetWinEventHook(EVENT_SYSTEM_MOVESIZESTART, EVENT_SYSTEM_MOVESIZESTART, IntPtr.Zero, keep, (uint)pid, 0, 0);
    if (hook == IntPtr.Zero) { Say("fail: no event hook"); return; }
    // Never outlive the game
    new Thread(() => { game.WaitForExit(); Environment.Exit(0); }) { IsBackground = true }.Start();
    Say("up");
    MSG m;
    while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref m); DispatchMessage(ref m); }
  }
}
"@
[DragGuard]::Run($ProcessId)
