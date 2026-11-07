// Factorio Pilot 桌面界面: 只是一个窗口, 页面 (app/src) 直接连本机控制接口 http://127.0.0.1:4330 (src/play/control.ts)。
// 打开时 4330 没人听, 就自己在仓库目录起控制接口 (node --env-file-if-exists=.env src/play/control.ts, 和 npm run play:control 一样,
// 不弹黑窗口, 输出写进临时目录的 factorio-pilot-control.log); 关界面时把自己起的那个收掉, 别人起的不碰。
//。
// 控制接口连不上时的停班 (stop_run, 2026-11-05; backlog #294): 外壳按 <lab-data>/play/current-run.json 直接给在跑的那一班写 STOP 文件。
// 关界面 = 停班: 正常关窗口时同样写 STOP, run.ts 30 秒内存档收尾、大脑都停。界面被强行结束 (任务管理器) 时收不到这个事件。
// 发布版不弹黑色控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{Manager, RunEvent, WebviewWindowBuilder};

const PORT: u16 = 4330;

/// 界面起的控制接口 (child = None: 没起过, 或者打开时 4330 已经有人在听)
struct Control {
    child: Option<Child>,
    exit: Option<String>,
    error: Option<String>,
    log: PathBuf,
}

/// 给页面看的 (app/src/logic.ts ControlProc)
#[derive(Serialize)]
struct ControlProc {
    started: bool,
    running: bool,
    exit: Option<String>,
    error: Option<String>,
    log: String,
}

fn port_open() -> bool {
    TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], PORT)), Duration::from_millis(300)).is_ok()
}

/// 仓库目录: FP_REPO_DIR, 不然从界面程序所在目录往上找 (编出来在 <仓库>/app/src-tauri/target/release 下)
fn find_repo() -> Option<PathBuf> {
    let ok = |d: &std::path::Path| d.join("src").join("play").join("control.ts").is_file() && d.join("package.json").is_file();
    if let Some(d) = std::env::var_os("FP_REPO_DIR").map(PathBuf::from) {
        if ok(&d) {
            return Some(d);
        }
    }
    let exe = std::env::current_exe().ok()?;
    exe.ancestors().find(|d| ok(d)).map(|d| d.to_path_buf())
}

/// 看一眼自己起的那个还活着没有 (退了就记下退出码)
fn poll(c: &mut Control) {
    if let Some(ch) = c.child.as_mut() {
        if let Ok(Some(st)) = ch.try_wait() {
            c.exit = Some(match st.code() {
                Some(n) => format!("退出码 {n}"),
                None => "被结束".into(),
            });
        }
    }
}

fn start(c: &mut Control) {
    poll(c);
    let alive = c.child.is_some() && c.exit.is_none();
    if alive || port_open() {
        return; // 自己起的还在 (可能还在启动), 或者别人起的在听
    }
    let Some(repo) = find_repo() else {
        c.error = Some("找不到仓库目录: 界面程序要放在仓库的 app/src-tauri/target 下面, 或者设环境变量 FP_REPO_DIR".into());
        return;
    };
    let out = match std::fs::File::create(&c.log) {
        Ok(f) => f,
        Err(e) => {
            c.error = Some(format!("写不了日志 {}: {e}", c.log.display()));
            return;
        }
    };
    let err = match out.try_clone() {
        Ok(f) => f,
        Err(e) => {
            c.error = Some(format!("写不了日志: {e}"));
            return;
        }
    };
    let mut cmd = Command::new("node");
    cmd.args(["--env-file-if-exists=.env", "src/play/control.ts"])
        .current_dir(&repo)
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: 不弹黑窗口
    }
    match cmd.spawn() {
        Ok(ch) => {
            c.child = Some(ch);
            c.exit = None;
            c.error = None;
        }
        Err(e) => c.error = Some(format!("起不了 node ({e}): 装了 Node.js 24 以上、并且在 PATH 里吗?")),
    }
}

fn status(c: &mut Control) -> ControlProc {
    poll(c);
    ControlProc {
        started: c.child.is_some(),
        running: c.child.is_some() && c.exit.is_none(),
        exit: c.exit.clone(),
        error: c.error.clone(),
        log: c.log.display().to_string(),
    }
}

/// 停班结果 (页面 app/src/desktop.ts StopRun)
#[derive(Serialize)]
struct StopRun {
    ok: bool,
    run: Option<String>,
    error: Option<String>,
}

/// 仓库 .env 里的一个变量 (KEY=VALUE; 去掉两边的引号, 不解释 $; 没有就 None)。node 跑控制接口时 --env-file-if-exists 读的也是这个文件
fn env_file_var(repo: &std::path::Path, key: &str) -> Option<String> {
    let text = std::fs::read_to_string(repo.join(".env")).ok()?;
    text.lines().find_map(|line| {
        let l = line.trim();
        if l.starts_with('#') {
            return None;
        }
        let (k, v) = l.split_once('=')?;
        if k.trim() != key {
            return None;
        }
        let v = v.trim().trim_matches('"').trim_matches('\'');
        (!v.is_empty()).then(|| v.to_string())
    })
}

/// 本机数据目录: 和 src/lab/gamedir.ts labRoot 同一条规则 (环境变量 LAB_DATA_DIR → 仓库 .env 的 LAB_DATA_DIR → <仓库>/lab-data)
fn lab_root(repo: &std::path::Path) -> PathBuf {
    std::env::var_os("LAB_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| env_file_var(repo, "LAB_DATA_DIR").map(PathBuf::from))
        .unwrap_or_else(|| repo.join("lab-data"))
}

/// 控制接口连不上时的停班 (backlog #294):
/// 外壳按 run.ts 开班写的 <lab-data>/play/current-run.json 找到在跑的那一班, 直接写 STOP 文件 (run.ts 的监工 30 秒内看到就存档收尾, 换班程序不再开下一班)。
/// 只写 play/runs/ 下面的目录; 已经收尾的 (有 summary.json) 不写; 别的文件不碰。
fn stop_run_file(why: &str) -> StopRun {
    let fail = |e: String| StopRun { ok: false, run: None, error: Some(e) };
    let Some(repo) = find_repo() else {
        return fail("找不到仓库目录".into());
    };
    let play = lab_root(&repo).join("play");
    let cur = play.join("current-run.json");
    let text = match std::fs::read_to_string(&cur) {
        Ok(t) => t,
        Err(e) => return fail(format!("读不到 {} ({e}): 没有开过班, 或者记录目录不在这里", cur.display())),
    };
    let v: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => return fail(format!("current-run.json 不是 JSON: {e}")),
    };
    let Some(run_dir) = v.get("runDir").and_then(|x| x.as_str()).map(PathBuf::from) else {
        return fail("current-run.json 里没有 runDir".into());
    };
    let (Ok(runs), Ok(dir)) = (std::fs::canonicalize(play.join("runs")), std::fs::canonicalize(&run_dir)) else {
        return fail(format!("这一班的记录目录不在了: {}", run_dir.display()));
    };
    if !dir.starts_with(&runs) {
        return fail(format!("{} 不在 {} 下面, 不写", dir.display(), runs.display()));
    }
    let id = dir.file_name().map(|s| s.to_string_lossy().into_owned());
    if dir.join("summary.json").is_file() {
        return StopRun { ok: false, run: id, error: Some("这一班已经收尾了 (有 summary.json), 没有在跑的".into()) };
    }
    if dir.join("STOP").is_file() {
        return StopRun { ok: true, run: id, error: None }; // 已经在停了, 留着最早的原因
    }
    match std::fs::write(dir.join("STOP"), format!("{why}\n")) {
        Ok(()) => StopRun { ok: true, run: id, error: None },
        Err(e) => StopRun { ok: false, run: id, error: Some(format!("写不了 STOP 文件: {e}")) },
    }
}

/// 用户账号那一局 (mk-world.ts) 不走班次: 按 <lab-data>/play/mk-current.json 往 play/online/<班次>/ 放 STOP。没有在跑的局什么都不写
fn stop_mk_file(why: &str) {
    let Some(repo) = find_repo() else { return };
    let play = lab_root(&repo).join("play");
    let Ok(text) = std::fs::read_to_string(play.join("mk-current.json")) else { return };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return };
    if v.get("ended").is_some() {
        return;
    }
    let Some(dir) = v.get("runDir").and_then(|x| x.as_str()).map(PathBuf::from) else { return };
    let Some(online) = std::fs::canonicalize(&play).ok().map(|p| p.join("online")) else { return };
    let _ = std::fs::create_dir_all(&dir);
    let Ok(dir) = std::fs::canonicalize(&dir) else { return };
    if !dir.starts_with(&online) || dir.join("STOP").is_file() {
        return;
    }
    let _ = std::fs::write(dir.join("STOP"), format!("{why}\n"));
}

#[tauri::command]
fn stop_run() -> StopRun {
    stop_run_file("界面 (控制接口没在跑, 外壳直接写的)")
}

#[tauri::command]
fn control_status(state: tauri::State<Mutex<Control>>) -> ControlProc {
    status(&mut state.lock().unwrap())
}

#[tauri::command]
fn control_start(state: tauri::State<Mutex<Control>>) -> ControlProc {
    let mut c = state.lock().unwrap();
    start(&mut c);
    status(&mut c)
}

fn main() {
    let mut control = Control { child: None, exit: None, error: None, log: std::env::temp_dir().join("factorio-pilot-control.log") };
    start(&mut control);
    let app = tauri::Builder::default()
        .manage(Mutex::new(control))
        .invoke_handler(tauri::generate_handler![control_status, control_start, stop_run])
        .setup(|app| {
            // 窗口照 tauri.conf.json (那里 create: false), 在这里建, 好按需加 WebView2 启动参数。
            let cfg = app.config().app.windows.first().cloned().expect("tauri.conf.json 里要有一个窗口");
            // wry 默认的参数 (自己给参数就要自己带上)
            let mut args = String::from("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
            let mut builder = WebviewWindowBuilder::from_config(app.handle(), &cfg)?;
            // 冒烟检查 (app/scripts/smoke.mjs) 用: 设了 FP_GUI_DEBUG_PORT 才开调试端口, 并用单独的数据目录
            // (参数不同的 WebView2 不能共用数据目录; 也不弄脏平时的本地记录)。平时不开。
            if let Some(port) = std::env::var("FP_GUI_DEBUG_PORT").ok().and_then(|p| p.parse::<u16>().ok()) {
                args.push_str(&format!(" --remote-debugging-port={port}"));
                builder = builder.data_directory(std::env::temp_dir().join("factorio-pilot-gui-smoke"));
            }
            // 窗口在 tauri.conf.json 里是隐藏的, 页面画好后自己显示 (app/src/desktop.ts showWindow); 页面万一没起来, 4 秒后这里也显示
            let window = builder.additional_browser_args(&args).build()?;
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(4));
                if !window.is_visible().unwrap_or(true) {
                    let _ = window.show();
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("界面启动失败");
    app.run(|handle, event| {
        // 关界面: 在跑的那一班也停 (没有在跑的班时 stop_run_file 什么都不写), 再收掉自己起的控制接口
        // (界面被强行结束时收不到这个, 班和控制接口都会留着; 下次打开看到 4330 有人听就直接用)
        if let RunEvent::Exit = event {
            let _ = stop_run_file("界面关闭 (关界面 = 停班)");
            stop_mk_file("界面关闭 (关界面 = 停这一局)");
            if let Some(mut ch) = handle.state::<Mutex<Control>>().lock().unwrap().child.take() {
                let _ = ch.kill();
                let _ = ch.wait();
            }
        }
    });
}
