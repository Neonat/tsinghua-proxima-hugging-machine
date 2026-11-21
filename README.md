# PROXIMA hug rating machine

A Tsinghua and PROXIMA interaction prototype that turns a hug around a physical mannequin into a live heatmap, dimension scores, and a local leaderboard. A webcam estimates the hugger's pose and contact, while an operator kiosk handles calibration and the session.

The project connects computer vision, a React and Three.js interface, local persistence, and separate robot experiments. Its scores are playful heuristics. Strength is inferred from movement, and warmth is a fixed baseline rather than a sensor reading.

[What is built](#what-is-built) · [Stack and architecture](#stack-and-architecture) · [Local setup](#local-setup) · [Run a session](#run-a-session) · [中文说明](#中文说明)

## What is built

| Component | Implemented scope |
| --- | --- |
| Zone painter | Paint nine named contact zones on a mannequin model and export their shared configuration. |
| CV backend | Estimate pose, wrap reach, and contact with MediaPipe Holistic and OpenCV. Stream signals and camera previews over WebSocket. |
| Hug kiosk | Mark the mannequin, view live meters and a heatmap, run a three-second countdown and ten-second session, then reveal scores and rank. |
| Local history | Store leaderboard rows in SQLite and each hug profile as JSON. Equal overall scores share a rank. |
| Telepresence experiment | Upload a recorded parameter stream to the configured Supabase project. Separate Arduino and browser-serial tools support robot experiments. |

The [project brief](HUG_PROJECT_BRIEF.md) records the original design. The current flow is defined by the source and setup guides below.

## Stack and architecture

| Technology | Role in this prototype |
| --- | --- |
| Python, OpenCV, and MediaPipe Holistic | Capture webcam or video input and turn pose landmarks into contact and squeeze estimates. |
| NumPy and rule-based scoring | Calculate session dimensions from signal history and the configured zone weights. |
| WebSocket | Stream live measurements to the kiosk and send session and calibration commands back to the local backend. |
| React, TypeScript, and Three.js | Manage kiosk phases and render the mannequin heatmap. The zone painter uses the same frontend stack. |
| SQLite and JSON | Retain leaderboard results and inspectable hug profiles without a local database service. |
| Supabase REST calls and an Arduino receiver | Support optional cloud recording and separate robot transmission experiments. |

The Python backend owns scoring and local session state. The kiosk consumes its messages and records the parameter stream for optional upload. The local rating flow does not require cloud storage or an Arduino.

## Local setup

Use Python 3.12, Node.js 24, and npm. Real tracking needs a webcam and mannequin. Synthetic mode provides simulated input without a camera.

```sh
git clone https://github.com/Neonat/tsinghua-proxima-hugging-machine.git
cd tsinghua-proxima-hugging-machine/hug-machine/backend
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python main.py
```

For simulated input, use this command instead:

```sh
.venv/bin/python main.py --synthetic
```

The backend listens at `ws://localhost:8765`. Allow camera access for the terminal app on macOS when using a webcam. The default zone configuration is committed in `hug-machine/data/mannequin_zones.json`.

In a second terminal, from the repository root:

```sh
cd hug-machine/frontend/hug-rater
npm ci
npm run dev -- --port 5200
```

Open [localhost:5200](http://localhost:5200). The kiosk's WebSocket URL is fixed to `localhost:8765`, so the browser and backend currently run on the same computer. The explicit frontend port above is a setup choice; Vite's unconfigured default differs.

After creating the Python environment, macOS users can also open [Start Hug Backend.command](hug-machine/Start%20Hug%20Backend.command). First-time installation through that launcher expects `/usr/local/bin/python3.12`. Use the manual commands if Python is installed elsewhere.

## Run a session

1. Aim the webcam at the mannequin. Click **mark** in the camera panel, then click the neck and torso base. The backend saves those anchors across restarts.
2. Place a coloured FRONT sticker on the chest. Blue is the default. The backend uses the sticker to estimate orientation and retains its last orientation when the sticker is hidden.
3. Enter a hugger name and click **START HUG**. Wait for the three-second countdown, hug during the ten-second recording, then step back for the score reveal.
4. Inspect the scores and leaderboard. Use cloud upload only when you intend to send the recorded parameters to the configured shared project.

When the mannequin or camera moves, use **re-mark** and set the anchors again. The [backend guide](hug-machine/backend/README.md) covers video-file input, sticker colours, WebSocket messages, calibration, and a session test client.

## Scoring

| Dimension | Current computation | Weight |
| --- | --- | --- |
| Strength | Average and peak estimated squeeze | 30% |
| Style | Stability of the rule-based hug classification | 25% |
| Coverage | Importance-weighted contact across reachable zones | 25% |
| Warmth | Fixed `9.0/10` baseline, with no thermal sensor | 20% |

The weighted overall result is between zero and ten. The classifier draws on the [HUG taxonomy paper](https://www.nature.com/articles/s41598-024-64825-8). This prototype does not claim that paper's validation results for the mannequin setup.

## Zone painter and source guide

From the repository root:

```sh
cd hug-machine/frontend/zone-painter
npm ci
npm run dev
```

Open the URL printed by Vite. Export `mannequin_zones.json` into `hug-machine/data/` to replace the default configuration. The [zone-painter guide](hug-machine/frontend/zone-painter/README.md) describes zone editing.

| Location | Responsibility |
| --- | --- |
| [hug-machine/backend/](hug-machine/backend/) | Capture, classification, scoring, session protocol, and storage |
| [hug-machine/frontend/hug-rater/](hug-machine/frontend/hug-rater/) | Operator kiosk and heatmap |
| [hug-machine/frontend/zone-painter/](hug-machine/frontend/zone-painter/) | Contact-zone authoring |
| [hug-machine/data/](hug-machine/data/) | Zone configuration and generated local anchors, leaderboard, and profiles |
| [hug-machine/arduino/](hug-machine/arduino/) | Receiver sketch and serial protocol |
| [serial test page](hug-machine/frontend/serial-test/index.html) | Independent browser serial experiment |

Cloud upload uses the original demo connection in [supabase.ts](hug-machine/frontend/hug-rater/src/supabase.ts) and the [SQL schema](hug-machine/supabase_schema.sql). Local setup does not provision an independent Supabase project or a complete robot receiver service.

## Checks and prototype boundaries

Run the storage regression tests from the repository root:

```sh
python3.12 -B -m unittest discover -s hug-machine/backend/tests -v
```

From either frontend directory, `npm run build` runs TypeScript and Vite, and `npm run lint` runs Oxlint. Storage tests exercise actual SQLite ranking, including ties. They do not validate camera tracking, robot movement, or cloud upload.

Camera angle, occlusion, clothing, and calibration affect the estimates. Contact and force are inferred. Scores do not measure a person's physiology or emotional state. The mannequin, camera, and robot are physical setup requirements and are not supplied by this repository.

The sample cloud policy is deliberately permissive for a demo. Configure a separate project and appropriate access rules before collecting other people's recordings. Local data includes names and hug profiles under `hug-machine/data/`.

## 中文说明

PROXIMA 是一个清华和 PROXIMA 互动原型。参与者拥抱实体模特，摄像头与 MediaPipe 估计姿态和接触区域，Python 后端计算分数，React 和 Three.js 页面显示热力图、评分动画和排行榜。完整设计见 [HUG_PROJECT_BRIEF.md](HUG_PROJECT_BRIEF.md)，其中部分流程已由当前实现更新。

### 安装与运行

使用 Python 3.12、Node.js 24 和 npm。按上方命令在 `hug-machine/backend/` 建立 `.venv`、安装 `requirements.txt` 并运行 `main.py`。没有摄像头时加 `--synthetic`。后端地址为 `ws://localhost:8765`，macOS 首次使用需允许终端访问摄像头。

另开终端，在 `hug-machine/frontend/hug-rater/` 运行 `npm ci` 和 `npm run dev -- --port 5200`，打开 [localhost:5200](http://localhost:5200)。前后端目前应在同一台电脑运行。已有 Python 环境后可双击 `Start Hug Backend.command`。首次自动安装要求 `/usr/local/bin/python3.12` 存在。

### 进行一次拥抱

1. 摄像头对准模特，点击 **mark**，依次点击颈部和躯干底部，定位会保存。
2. 在胸口贴彩色正面标记，默认识别蓝色。旋转时后端跟踪标记，遮挡时保留上一次方向。
3. 输入名字，点击 **START HUG**。倒数三秒后录制十秒，结束后自动评分并更新本地排行榜。
4. 摄像头或模特位置改变后点击 **re-mark**。只有需要把参数记录发到共享云端时才使用上传功能。

### 评分、工具与边界

力度占 30%，由姿态估计的 squeeze 平均值和峰值推算，不是力传感器读数。风格占 25%，取决于分类稳定性。覆盖占 25%，是可达区域的加权接触比例。温暖占 20%，固定为 `9.0/10`，没有热成像设备。最终为零到十分的加权平均，同分共享名次。

区域画笔在 `hug-machine/frontend/zone-painter/`。运行 `npm ci` 和 `npm run dev`，导出文件放入 `hug-machine/data/`。本地结果保存在 SQLite 和每次拥抱的 JSON 中。云上传使用原演示的 Supabase 配置。Arduino 接收端和串口测试属于独立的机器人实验。

若页面显示后端离线，检查 Python 终端、摄像头权限和 `localhost:8765`。力度偏低时检查手臂是否环绕模特，并参考[后端校准说明](hug-machine/backend/README.md)。遮挡和视角会影响估计，分数仅用于互动演示。演示云端规则较宽松，收集他人记录前需配置合适的访问控制。

## License

No project license is included. The HUG taxonomy paper is a research reference, not a validation of this implementation.
