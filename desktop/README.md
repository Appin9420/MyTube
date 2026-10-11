# MyTube 桌面版（Windows / Electron）

MyTube 桌面版不是把整个应用改写成桌面程序，而是给现有的「Express 后端 + React 前端」套一层 **Electron 壳**：

```
┌───────────────────────────── Electron (MyTube.exe) ─────────────────────────────┐
│  main.js                                                                        │
│   1. 准备可写的「服务家目录」<userData>/server-home（后端进程的 cwd）                │
│   2. 用捆绑的 node.exe 启动后端 resources/server/dist/src/server.js                │
│   3. 轮询端口就绪后打开 BrowserWindow 加载 http://127.0.0.1:<port>                 │
│   4. 窗口关闭时结束整个后端进程树（含 yt-dlp/ffmpeg 子进程）                         │
└─────────────────────────────────────────────────────────────────────────────────┘
```

后端同时托管 API 与前端静态资源（与 Docker 镜像相同的运行布局），所以壳本身不包含任何业务代码——升级只需重新打包，不改后端一行源码。

## 目录结构

```
desktop/
├── main.js                    # Electron 主进程（模式判定、后端生命周期、窗口管理）
├── package.json               # Electron 依赖 + electron-builder 配置
├── .npmrc                     # electron/electron-builder 二进制镜像（GitHub 直连不通时必需）
├── build-res/icon.png         # 应用图标（取自 frontend/public/favicon.png，512x512）
├── scripts/
│   └── prepare-resources.mjs  # 组装打包资源（见下文）
├── build/staging/             # 【构建产物】staging 目录（已 gitignore）
│   ├── app/                   #   Docker /app 等价布局：dist、frontend/dist、node_modules、drizzle…
│   └── bin/                   #   node.exe + yt-dlp.exe / ffmpeg.exe / cloudflared.exe（尽力下载）
└── release/                   # 【构建产物】electron-builder 输出（已 gitignore）
    ├── win-unpacked/MyTube.exe  # 免安装版（--dir 目标）
    └── MyTube-Setup-<版本>.exe   # NSIS 安装包（build 目标）
```

## 环境要求

- Node.js 20.19+ / 22.12+（打包脚本会把**当前运行的 node.exe** 一起捆绑，因此 better-sqlite3 的 ABI 永远匹配）
- Windows 10/11 x64
- 网络：需要访问 npm registry；若 GitHub 直连不通（国内网络常见），`desktop/.npmrc` 已配置 npmmirror 镜像供 electron/electron-builder 使用；外部二进制下载失败不阻塞打包

## 构建

```bash
# 在仓库根目录
npm run desktop:build:dir     # 免安装版（win-unpacked/MyTube.exe），本地验证用
npm run desktop:build         # NSIS 安装包 MyTube-Setup-<版本>.exe + 免安装版
```

`prepare-resources.mjs` 会依次：

1. 编译后端（tsc）与前端（vite build）；
2. 组装 `build/staging/app`（与 Docker `WORKDIR /app` 完全一致的布局）；
3. 在 staging 内 `npm ci --omit=dev`（跳过 puppeteer 的 Chromium 下载与 provider/ffmpeg 的 postinstall 副作用）；
4. 捆绑 node.exe，并尽力下载 `yt-dlp.exe`、`ffmpeg.exe`、`ffprobe.exe`、`cloudflared.exe`（多源回退：GitHub → `MYTUBE_GH_PROXY` 指定的代理前缀 → npmmirror 二进制镜像）。

## 日常开发

```bash
npm run desktop:dev   # = npm run dev（后端 nodemon + vite）+ Electron 壳
```

开发模式下壳不启动后端，只等待 5551（后端）与 5556（vite）就绪后加载 vite 页面，支持 HMR。

### 快速验证打包布局（不生成安装包）

```bash
cd desktop && npm run prepare:resources && npm start
# 壳自动检测 build/staging 存在时进入 staging 模式：用捆绑的 node.exe
# 以打包时的同款方式启动后端，行为与正式安装包一致
```

## 运行期行为

| 主题 | 说明 |
|---|---|
| 用户数据 | `<userData>/server-home`（默认 `%APPDATA%/MyTube/server-home`）：`data/`（SQLite 库、cookies.txt）、`uploads/`（视频、缩略图、字幕）。卸载不删除数据（`deleteAppDataOnUninstall: false`） |
| 数据库迁移 | `drizzle/` 由壳按版本号同步进家目录（`.desktop-synced-version` 标记，升级后自动刷新，用户数据不受影响） |
| 端口 | 默认 5551；被占用时自动改用随机空闲端口 |
| 单实例 | 重复启动会唤起已有窗口 |
| 外部链接 | 窗口内 `target=_blank` / 外站跳转交给系统默认浏览器 |
| yt-dlp | 优先用 `resources/bin/yt-dlp.exe`（通过 `YT_DLP_PATH`）；缺失时后端会在首次下载时尝试 pip 自动安装（需 Python），或手动把 `yt-dlp.exe` 放进 `bin` 目录 |
| JS 挑战运行时 | 捆绑了 `deno.exe` 用 deno，否则用捆绑的 node.exe（`YT_DLP_JS_RUNTIME=node`） |
| ffmpeg | 打包时捆绑；也会注入 PATH 供 yt-dlp 合流使用 |
| MissAV 下载器 | 不捆绑 Chromium；壳会探测系统 Chrome/Edge 并设置 `PUPPETEER_EXECUTABLE_PATH`，都没有则该功能不可用 |
| 内网穿透 | 捆绑了 `cloudflared.exe` 即可用内置的 Cloudflare Tunnel 功能 |
| 日志 | `<userData>/server-home/backend.log`；崩溃时弹出错误框并显示日志路径 |
| 退出 | `taskkill /T /F` 结束后端进程树；正在进行的下载会丢失暂停快照（与强制断电同等语义），.part 文件会在下次启动时被 yt-dlp 复用 |

## 启动密码锁

桌面版支持启动密码解锁（屏幕锁级别，防止他人随手打开查看你的视频库）：

- **首次启用**：未设置密码时，每次启动会出现「设置启动密码」界面，可设置后进入，也可点「暂不设置，直接进入」跳过；
- **解锁**：设置密码后，每次启动先出现解锁界面，输入正确密码才加载主界面（后端在锁屏期间已在后台启动，解锁后无需再等）；
- **存储**：scrypt 加盐哈希保存在 `%APPDATA%\MyTube\desktop-lock.json`，不存明文；**忘记密码** = 删除该文件，下次启动重新设置；
- **防爆破**：连续输错 5 次锁定 30 秒；
- **运行日志**：`%APPDATA%\MyTube\desktop.log` 记录启动、锁屏与解锁事件（不含密码）。

> 注意：这是屏幕锁，不是安全边界。解锁运行期间，本机浏览器访问 `127.0.0.1:5551`（或局域网设备）仍可直接使用服务——这与 Docker 部署的安全模型一致，敏感环境请配置后端鉴权。

## 启动自动补封面

每次启动应用时，壳会在后台自动运行 `scripts/backfill-thumbnails.cjs`（结果记录在 `desktop.log` 的 `thumbnail backfill` 行）：对库中没有封面的视频，优先按记录的 `thumbnail_url` 下载原版封面（fetch 失败自动换 curl），再不行就从视频文件抽帧，最后更新数据库。幂等可重跑，手动执行：

```bash
node desktop/scripts/backfill-thumbnails.cjs            # 直接修
node desktop/scripts/backfill-thumbnails.cjs --dry-run  # 只看清单
```

适用场景：断网/代理断开期间下载的视频缺封面，下次启动自动修复，无需手动处理。

## 环境变量（打包/调试用）

| 变量 | 作用 |
|---|---|
| `MYTUBE_GH_PROXY` | GitHub 下载代理前缀（如 `https://gh-proxy.com`），用于 yt-dlp/cloudflared/ffmpeg 的候选下载源 |
| `MYTUBE_HOME` | 覆盖后端家目录（默认 userData） |
| `MYTUBE_STAGING_DIR` | 覆盖 staging 目录位置（默认 `desktop/build/staging`） |
| `MYTUBE_FORCE_DEV=1` | 强制开发模式（跳过 staging 检测） |

## 已知限制

- 安装包未做代码签名，首次运行会有 SmartScreen 提示（「仍要运行」即可）。
- 单文件「绿色版」体积较大（后端 node_modules + 前端产物 + node.exe ≈ 300–400 MB），因为后端以普通 Node 进程运行，无法塞进单 exe。
- 后端进程被强杀时（任务管理器、关机）不会执行「暂停下载」的优雅关闭逻辑；这是 Windows 桌面化的固有取舍，yt-dlp 的 .part 断点续传可兜底。
