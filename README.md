# PROXIMA — hug rating machine

A Tsinghua/PROXIMA interaction prototype in which a person hugs a physical mannequin, a webcam estimates pose and contact, and a local kiosk reveals a score and leaderboard. The operator marks the mannequin in the camera view, starts a session, then reviews the result. The scores are playful computer-vision heuristics; warmth is an assumed baseline and strength is inferred from movement rather than measured force.

## What is implemented

- **Zone painter:** a React/Three.js tool for painting nine named contact zones and exporting the shared zone configuration.
- **CV backend:** Python, MediaPipe Holistic and OpenCV estimate hug pose, wrap reach and contact zones, stream them over WebSocket, and save scores to SQLite and per-hug JSON.
- **Hug kiosk:** a React/Three.js heatmap, camera preview, manual mannequin marking, live meters, score reveal and leaderboard. The current UI runs a **3-second countdown and a 10-second recording**, then scores automatically.
- **Telepresence experiment:** the score screen can upload a recording to the configured Supabase project. An [Arduino receiver](hug-machine/arduino/README.md) and a [serial test page](hug-machine/frontend/serial-test/index.html) support separate robot experiments; they are not required for local rating.

The [project brief](HUG_PROJECT_BRIEF.md) records the original design. Use the source and guides below for the current kiosk flow.

## Local setup

Use **Python 3.12**, **Node.js 24** and npm. A webcam and mannequin are needed for real tracking; synthetic mode works without a camera.

```sh
git clone https://github.com/Neonat/tsinghua-proxima-hugging-machine.git
cd tsinghua-proxima-hugging-machine/hug-machine/backend
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python main.py
# For simulated input instead: .venv/bin/python main.py --synthetic
```

The backend listens at `ws://localhost:8765`. On macOS, allow camera access for the terminal app. A default `hug-machine/data/mannequin_zones.json` is already committed.

In a second terminal, from the repository root:

```sh
cd hug-machine/frontend/hug-rater
npm ci
npm run dev -- --port 5200
```

Open http://localhost:5200. The explicit port matches these instructions; Vite's unconfigured default is different. The kiosk currently connects to the backend on the **same computer** at `localhost:8765`.

After the Python environment exists, macOS users can also double-click [Start Hug Backend.command](hug-machine/Start%20Hug%20Backend.command). On a fresh machine that launcher expects Python at `/usr/local/bin/python3.12`; use the manual commands above if Python is installed elsewhere.

## Run a hug session

1. Aim the webcam at the mannequin. In the camera panel, click **mark**, then click its neck and torso base. The backend saves these anchors across restarts.
2. Place a coloured sticker on its chest as the FRONT marker; blue is the default. The backend uses this to estimate changing orientation.
3. Enter a hugger name and click **START HUG**. Wait for the countdown, hug during the 10-second recording, then step back for the automatic score reveal.
4. Review the dimension scores and leaderboard. Upload only if you intend to send that recording to the shared cloud project.

When the camera angle or mannequin position changes, use **re-mark** and set the anchors again. See [backend setup, protocol and calibration](hug-machine/backend/README.md) for video-file input, sticker colours, diagnostics and session testing.

| Score | Current computation | Weight |
| --- | --- | --- |
| Strength | Estimated squeeze, aggregated from average and peak | 30% |
| Style | Stability of the rule-based hug classification | 25% |
| Coverage | Importance-weighted contact across reachable zones | 25% |
| Warmth | Fixed **9.0/10** baseline; no thermal sensor | 20% |

The weighted overall score is 0–10. The classifier uses the [HUG taxonomy reference](https://www.nature.com/articles/s41598-024-64825-8); the prototype does not claim that paper's validation results for this setup.

## Zone painter and architecture

From the repository root:

```sh
cd hug-machine/frontend/zone-painter
npm ci
npm run dev
```

Open the URL printed by Vite. Paint/export `mannequin_zones.json` into `hug-machine/data/` to replace the default configuration. The [zone-painter guide](hug-machine/frontend/zone-painter/README.md) describes the tool.

```text
hug-machine/
├── backend/               Capture, classification, scoring and WebSocket server
├── frontend/zone-painter/ Contact-zone authoring tool
├── frontend/hug-rater/    Operator kiosk and heatmap
├── frontend/serial-test/  Separate browser serial experiment
├── arduino/               Robot receiver sketch and serial protocol
└── data/                  Zones, saved anchors, SQLite leaderboard and hug profiles
```

The local backend owns session state and scoring; the kiosk consumes its WebSocket messages. Cloud upload uses the project connection in [supabase.ts](hug-machine/frontend/hug-rater/src/supabase.ts) and the [SQL schema](hug-machine/supabase_schema.sql). That connection is specific to the original demo; local setup does not provision an independent cloud database or an end-to-end robot receiver service.

## Prototype limits

Camera angle, occlusion, clothing and calibration affect pose estimates. Contact and force are inferred; the score is not a physiological or emotional assessment. The sample cloud policy is deliberately permissive for a demo, so use a separately configured project and appropriate access rules before collecting other people's recordings. The mannequin, camera and robot are physical setup requirements, not assets included in this repository.

## 中文说明

PROXIMA 是一个实体模特拥抱评分原型：摄像头与 MediaPipe 估计姿态和接触区域，Python 后端计算分数，React/Three.js 页面显示热力图、评分动画和排行榜。完整设计说明见仓库内的 [HUG_PROJECT_BRIEF.md](HUG_PROJECT_BRIEF.md)，其中部分流程已由当前实现更新。

### 安装与运行

使用 Python 3.12、Node.js 24 和 npm。先按上方命令在 `hug-machine/backend/` 建立 `.venv`、安装 `requirements.txt` 并运行 `main.py`；没有摄像头时加 `--synthetic`。后端地址为 `ws://localhost:8765`，macOS 首次使用需允许终端访问摄像头。

另开终端，在 `hug-machine/frontend/hug-rater/` 运行 `npm ci` 和 `npm run dev -- --port 5200`，打开 http://localhost:5200。前后端目前应在同一台电脑运行。已有 Python 环境后可双击 `Start Hug Backend.command`；首次自动安装要求 `/usr/local/bin/python3.12` 存在。

### 进行一次拥抱

1. 摄像头对准模特，点击 **mark**，依次点击颈部和躯干底部；定位会保存。
2. 在胸口贴彩色正面标记，默认识别蓝色。旋转时后端会跟踪标记，遮挡时保留上一次方向。
3. 输入名字，点击 **START HUG**。倒数 **3 秒**后录制 **10 秒**，结束后自动评分并更新本地排行榜。
4. 摄像头或模特位置改变后点击 **re-mark** 重新定位。只有需要把记录发到共享云端时才使用上传功能。

### 评分、工具与边界

- **力度 30%**：由姿态估计的 squeeze 平均值和峰值推算，不是力传感器读数。
- **风格 25%**：拥抱分类在录制过程中的稳定性。
- **覆盖 25%**：实际可达区域的加权接触比例。
- **温暖 20%**：固定 **9.0/10**，没有热成像设备。

最终为 0–10 分的加权平均。区域画笔在 `hug-machine/frontend/zone-painter/`，运行 `npm ci`、`npm run dev`，导出文件放入 `hug-machine/data/`。本地结果保存在 SQLite 和每次拥抱的 JSON 中。云上传使用原演示的 Supabase 配置；Arduino 接收端和串口测试属于独立的机器人实验，并非运行本地评分的必要步骤。

若页面显示后端离线，检查 Python 终端、摄像头权限和 `localhost:8765`。力度偏低时检查手臂是否真正环绕模特，并参考[后端校准说明](hug-machine/backend/README.md)。遮挡和视角会影响估计；分数仅用于互动演示，不能代表生理或情感测量。演示云端规则较宽松，收集他人记录前需自行配置合适的访问控制。
