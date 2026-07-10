# Hug Rating Machine

People hug a physical mannequin. A CV pipeline measures the hug in real time,
scores it after they step back, and posts results to a leaderboard.
Full spec: `HUG_PROJECT_BRIEF.md` (see ~/Downloads).

## Build order

1. **Zone painter** — `hug-machine/frontend/zone-painter/` 
2. **Python CV backend** — `hug-machine/backend/` (MediaPipe Holistic → scoring → WebSocket) 
3. **Hug rater frontend** — `hug-machine/frontend/hug-rater/` (live heatmap, score reveal, leaderboard) 

## Running the demo — one double-click per laptop

**Earth laptop**: double-click **`hug-machine/Start Earth Kiosk.command`**.
It installs anything missing, starts the camera backend + kiosk UI, and opens
http://localhost:5200 (fullscreen it with ⌃⌘F on the big screen). First run:
macOS asks for camera access — click **Allow**. Ctrl+C in the Terminal window
stops everything. Rehearsal without a camera:
`PROXIMA_SYNTH=1 "./Start Earth Kiosk.command"`.

**Space laptop**: double-click **`hug-machine/Start Space Station.command`**.
It serves the astronaut UI and opens it in Chrome (Web Serial needs Chrome).
Plug in the robot, click the link icon top-right, pick its port — done.
Try the whole flow without hardware at http://localhost:5201/#demo.

One-time setup on Earth: aim the webcam at the mannequin (camera panel,
bottom-left), press **MARK MANNEQUIN**, click its neck then torso base.
Stick a colored sticker (default blue) on its chest as a FRONT marker so
orientation tracks as it's hugged from different angles. Then: type the
hugger's name, **START HUG**, hug, **END HUG & SCORE**, **UPLOAD HUG** —
and the space robot's face flips to “!”.

## Layout

```
hug-machine/
├── backend/                 # Python CV + scoring + WebSocket
├── frontend/
│   ├── zone-painter/        # One-time setup tool
│   └── hug-rater/           # Main rating + leaderboard app
└── data/
    ├── mannequin_zones.json # Export from zone painter — save it here
    └── leaderboard.db       # SQLite (created by backend)
```

## Zone painter

```sh
cd hug-machine/frontend/zone-painter
npm install
npm run dev
```

Paint the nine contact zones onto the mannequin, then export
`mannequin_zones.json` and move it into `hug-machine/data/`.

---

## 中文说明

拥抱一个真实的人体模特，摄像头实时计算机视觉分析拥抱过程，结束后给出评分，
并记录到排行榜。完整设计文档见 `HUG_PROJECT_BRIEF.md`（在 `~/Downloads`）。

### 三个组成部分

1. **区域画笔（Zone Painter）** — `hug-machine/frontend/zone-painter/` 
   一次性设置工具：在 3D 人体模特上"画"出九个接触区域（胸口、左右肩、左右上臂、
   左右前臂、上背、下背），导出为 `mannequin_zones.json`。
2. **Python 视觉后端** — `hug-machine/backend/`（MediaPipe Holistic → 打分 → WebSocket）
3. **拥抱打分前端** — `hug-machine/frontend/hug-rater/`（实时热力图、打分动画、排行榜）

### 如何进行一次拥抱打分

1. 在访达（Finder）中双击 `hug-machine/Start Hug Backend.command`。
   首次运行时 macOS 会弹出"终端想要访问相机"的提示，点击**允许**。
   （若没有摄像头可用，改为在终端运行
   `hug-machine/backend/.venv/bin/python hug-machine/backend/main.py --synthetic`
   使用模拟数据。）
2. 打开浏览器访问 http://localhost:5200 （若尚未启动，在
   `hug-machine/frontend/hug-rater` 目录下运行 `npm run dev`）。
3. 把摄像头对准人体模特（可在操作界面右下角的摄像头画面里确认位置），
   点击 **MARK MANNEQUIN**，然后依次点击模特的**颈部**和**躯干底部**两个位置——
   系统会据此锁定各区域的位置，并在重启后依然保留。
   建议在模特胸口贴一张彩色贴纸（默认识别蓝色）作为"正面"标记，
   这样无论从哪个角度拥抱，系统都能判断模特的朝向。
4. 输入拥抱者的名字，点击 **START HUG** 开始，拥抱结束后点击
   **END HUG & SCORE**，即可看到评分动画和排行榜更新。

### 评分维度

| 维度 | 说明 | 权重 |
|------|------|------|
| 力度（Strength） | 拥抱的紧实程度（手臂是否真正环绕、贴合模特躯干） | 30% |
| 风格（Style） | 拥抱姿势分类的稳定性（交叉式/搂颈式/搂腰式 等） | 25% |
| 覆盖（Coverage） | 实际接触到的区域占比，按区域重要性加权 | 25% |
| 温暖（Warmth） | 固定基准值（无热成像设备） | 20% |

最终得分为 0–10 分的加权平均，并附各维度明细。

### 常见问题

- **看不到摄像头画面 / 状态显示 "backend offline"**：确认已经通过
  `Start Hug Backend.command` 启动了后端，并且该终端窗口没有报错退出。
- **力度分数偏低**：系统会区分"手贴在胸口"和"手臂真正环绕模特"两种情况——
  只有手腕绕到模特躯干轴线的另一侧，才会被判定为真正的拥抱环绕。
- **换了摄像头角度或移动了模特**：需要重新点击 **RE-MARK MANNEQUIN**
  并重新点击颈部和躯干底部。
