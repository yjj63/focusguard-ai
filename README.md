# FocusGuard AI · 浏览器端实时专注度与坐姿健康监测助手

> 浙江工商大学《人工智能基础与应用》课程设计作品（v4.0 正式版 · 真机标定与眼动融合优化）

## 1. 在线访问（GitHub Pages）
- **在线演示地址**：https://yjj63.github.io/focusguard-ai/
- **GitHub 仓库地址**：https://github.com/yjj63/focusguard-ai
- **隐私说明**：本项目所有 AI 深度学习推理（478 维人脸关键点、三维头部姿态矩阵与面部 Blendshapes）均在用户浏览器本地通过 **WebAssembly** 运行，视频流零上传，不依赖后端服务器，也不需要任何 API Key。

## 2. 核心功能亮点
1. **本地化深度学习视觉推理**：集成 Google MediaPipe `FaceLandmarker`（同源部署 `face_landmarker.task` 模型与 WASM 运行时，国内打开即可秒加载，自动适配 GPU/CPU 推理）。
2. **多维度坐姿与专注度检测**：
   - **坐姿健康**：支持“一键校准个人标准坐姿”，实时检测低头驼背（Pitch）、明显歪头（Roll）、离屏过近（人脸缩放比例 Scale）。
   - **专注与疲劳**：实时检测持续闭眼打瞌睡（Eye Blink）、打哈欠（Jaw Open）、左右走神（Yaw）及离开座位。
3. **实时数据可视化看板**：内置纯原生 Canvas 绘制的最近 60 秒专注度趋势折线图与 6 类异常事件分布统计条。
4. **可解释的 AI 灵敏度调节**：提供“宽松 / 标准 / 严格”三档预设，并支持低头角度、前倾距离、闭眼时长实时滑块微调。
5. **多模态提醒与学习报告导出**：支持中文语音播报（Web Speech API）、轻柔提示音与静音三种模式；支持一键生成本次学习健康报告并导出 **高清 PNG 报告图** 或 **TXT 报告**。
6. **无摄像头模拟演示模式**：内置 5 种预设场景（标准专注、低头驼背、离屏过近、疲劳闭眼、左右走神），确保无摄像头评阅环境也可完整体验系统功能。
7. **完整学习健康闭环（v3.0 新增）**：集成视频窗右下角 **3D 头部姿态方位仪 HUD**、**番茄专注时钟（25/15/5 分钟）**、**20-20-20 护眼与颈椎放松引导**、基于 `localStorage` 的**本地历史学习档案**以及**深浅双主题一键切换**。

## 3. 项目目录结构
```text
ai-focus-posture-guard/
├── index.html                    # 主页面入口
├── css/
│   └── style.css                 # 响应式深浅双主题仪表盘样式
├── js/
│   ├── app.js                    # 主控制器（模型加载、3D姿态仪HUD、番茄钟、语音与弹窗）
│   ├── analyzer.js               # AI 姿态欧拉角解析、防抖状态机与健康评分引擎
│   ├── demo.js                   # 无摄像头模拟演示渲染引擎
│   ├── charts.js                 # 纯 Canvas 实时趋势折线图与 PNG 报告图导出
│   └── storage.js                # 本地历史学习档案持久化模块（localStorage）
├── assets/
│   ├── mediapipe/                # 同源本地化 MediaPipe JS 与 WASM 运行时
│   └── models/
│       └── face_landmarker.task  # 本地人脸关键点深度学习模型（3.58 MB）
├── docs/
│   └── iteration_log.md          # AI 协作关键迭代节点记录
└── README.md                     # 项目制作与运行说明
```

## 4. 本地运行说明
由于浏览器安全策略限制，ES Module 与 WebAssembly 需通过 HTTP 服务运行（请勿直接双击 `index.html` 打开）：

```bash
# 方式一：使用 Python 3 内置服务器（推荐）
cd D:\ai-focus-posture-guard
python -m http.server 8088
# 然后在浏览器访问 http://localhost:8088

# 方式二：使用 VS Code Live Server 插件右键 index.html -> Open with Live Server
```

## 5. GitHub Pages 部署步骤
1. 登录 GitHub，新建一个公开仓库（如 `focusguard-ai`）。
2. 将本项目全部文件（含 `assets/` 目录）上传至仓库 `main` 分支根目录。
3. 进入仓库的 **Settings → Pages**：
   - **Source** 选择 `Deploy from a branch`
   - **Branch** 选择 `main` / `/ (root)`，点击 **Save**。
4. 等待约 1–2 分钟，页面顶部会出现可公开访问的 HTTPS 链接（支持电脑与手机浏览器直接调用摄像头）。
