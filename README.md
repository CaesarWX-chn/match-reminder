# ☁️ 云端观赛提醒（GitHub Actions 版）

**彻底解决"电脑关机就收不到推送"的问题**：赛程抓取、提醒计算、手机推送全部在 GitHub 云端完成，与你的电脑无关。电脑关机、睡眠都不影响手机收提醒。

## 功能

- 🏁 MotoGP（GP 组别）：22 站全环节（FP1/练习/FP2/排位/冲刺/热身/正赛）
- ⚽ 曼城：英超 + 足总杯 + 联赛杯 + 欧冠
- 提醒：**赛前一天**（北京日历日）+ **开赛前 1 小时**，推送 Bark / ntfy
- 每 15 分钟自动运行一次；已提醒的自动去重，不会重复推送

## 需要你做的（一次性，约 15 分钟）

### 第 1 步：创建仓库（Public）

1. 打开加速工具（Watt Toolkit）→ 启用 GitHub 加速；
2. 登录 github.com → 右上角 + → **New repository**；
3. Repository name 填 `match-reminder`；**选 Public**（公共仓库的 Actions 免费且不限分钟数）；
   如果选 Private（私有），每月免费 2000 分钟，请把 `reminder.yml` 里的 cron 改为每小时（`0 * * * *`）；
4. 不要勾选任何初始化选项 → **Create repository**。

### 第 2 步：上传代码

在你电脑上打开 PowerShell（或 Git Bash），依次执行（把 `你的用户名` 换成你的 GitHub 用户名）：

```powershell
cd F:\harness\match-reminder\cloud
git init
git add .
git commit -m "init"
git branch -M main
git remote add origin https://github.com/你的用户名/match-reminder.git
git push -u origin main
```

### 第 3 步：配置密钥（Bark key）

1. 打开仓库页面 → **Settings** → 左侧 **Secrets and variables** → **Actions**；
2. **New repository secret**：
   - Name：`BARK_KEY`
   - Value：你的 Bark key（如 `uHDzbHuVWT8p4FCnGGnCGe`，只填 key 部分即可）
3. （可选）再加一个 `NTFY_TOPIC`（ntfy 话题名），两个渠道会同时推送；
4. （可选）仓库 → Settings → **Actions → General → Workflow permissions** → 选 **Read and write permissions**（如果首次运行后状态没提交成功就检查这里）。

### 第 4 步：启动并验证

1. 打开仓库 → **Actions** 页，应该能看到 `观赛提醒（云端）` 工作流；
2. 点进工作流 → 右侧 **Run workflow** → 手动跑一次；
3. 等 1-2 分钟，**你的手机应收到一条"✅ 云端观赛提醒已启用"推送**——收到即全部成功；
4. 之后它每 15 分钟自动运行，无需任何操作。

## 本地测试（可选）

```powershell
cd F:\harness\match-reminder\cloud
$env:DRY_RUN = "1"; node src/reminder.mjs
```
DRY_RUN 模式只打印将要发送的提醒，不会真发推送。

## 关闭本地重复推送（重要）

云端启用并验证成功后，把本地 `F:\harness\match-reminder\data\config.json` 里 `phonePush.enabled` 改为 `false`（避免同一场比赛收到两次推送）。本地的桌面通知、网页查看、每日检查仍正常。

## 修改提醒策略

- 练习赛/热身也想提醒：仓库 → Settings → **Variables** → New repository variable → Name `NOTIFY_ALL_SESSIONS`，Value `1`；
- 想改提前小时数：编辑 `src/reminder.mjs` 中 `minsLeft <= 75`（分钟）。
