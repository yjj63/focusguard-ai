/**
 * FocusGuard AI 主应用控制器（v4.0 正式版）
 * 核心工程稳健性改进：
 * 1. 仅在视频新帧到来（video.currentTime 变化）且严格递增整数时间戳下调用 detectForVideo，加 try/catch 永不假死
 * 2. 移动端自动优先使用稳定 CPU/WASM delegate 并调优置信度阈值（0.40），避免 iOS WebGL 上下文丢帧或摘眼镜丢脸
 * 3. 动态同步视频流真实分辨率与容器纵横比，保证手机竖屏/电脑横屏下关键点网格 100% 像素级对齐人脸
 * 4. 启动摄像头后前 10 帧稳定人脸自动静默校准，同时保留“校准标准坐姿”按钮随时手动重校
 */

import { FaceLandmarker, FilesetResolver } from '../assets/mediapipe/vision_bundle.mjs';
import { FocusPostureAnalyzer, PRESET_THRESHOLDS, ALERT_META } from './analyzer.js';
import { DemoSimulator } from './demo.js';
import { FocusTrendChart, downloadReportPng } from './charts.js';
import { loadHistory, saveHistoryRecord, clearHistory } from './storage.js';

const dom = {
  videoStage: document.querySelector('.video-stage'),
  video: document.getElementById('webcam'),
  canvas: document.getElementById('overlayCanvas'),
  modelStatus: document.getElementById('modelStatus'),
  fpsBadge: document.getElementById('fpsBadge'),
  liveStateBanner: document.getElementById('liveStateBanner'),
  liveStateText: document.getElementById('liveStateText'),
  emptyHint: document.getElementById('emptyHint'),
  btnStartCamHero: document.getElementById('btnStartCamHero'),
  btnStartDemoHero: document.getElementById('btnStartDemoHero'),
  btnToggleCam: document.getElementById('btnToggleCam'),
  btnToggleDemo: document.getElementById('btnToggleDemo'),
  btnCalibrate: document.getElementById('btnCalibrate'),
  btnSaveSession: document.getElementById('btnSaveSession'),
  btnResetSession: document.getElementById('btnResetSession'),
  demoScenarioBar: document.getElementById('demoScenarioBar'),
  toggleMesh: document.getElementById('toggleMesh'),
  toggleHud: document.getElementById('toggleHud'),
  alertVoiceMode: document.getElementById('alertVoiceMode'),
  sessionTimer: document.getElementById('sessionTimer'),
  scoreRing: document.getElementById('scoreRing'),
  focusScoreValue: document.getElementById('focusScoreValue'),
  statusLabel: document.getElementById('statusLabel'),
  calibLabel: document.getElementById('calibLabel'),
  alertCountValue: document.getElementById('alertCountValue'),
  focusRateValue: document.getElementById('focusRateValue'),
  valPitch: document.getElementById('valPitch'),
  valYaw: document.getElementById('valYaw'),
  valRoll: document.getElementById('valRoll'),
  valBlink: document.getElementById('valBlink'),
  valYawn: document.getElementById('valYawn'),
  valScale: document.getElementById('valScale'),
  barPitch: document.getElementById('barPitch'),
  barYaw: document.getElementById('barYaw'),
  barRoll: document.getElementById('barRoll'),
  barBlink: document.getElementById('barBlink'),
  barYawn: document.getElementById('barYawn'),
  barScale: document.getElementById('barScale'),
  eventLogList: document.getElementById('eventLogList'),
  btnClearLog: document.getElementById('btnClearLog'),
  trendChartCanvas: document.getElementById('trendChart'),
  breakdownList: document.getElementById('breakdownList'),
  topIssueHint: document.getElementById('topIssueHint'),
  sliderPitch: document.getElementById('sliderPitch'),
  sliderScale: document.getElementById('sliderScale'),
  sliderDrowsy: document.getElementById('sliderDrowsy'),
  lblPitchTh: document.getElementById('lblPitchTh'),
  lblScaleTh: document.getElementById('lblScaleTh'),
  lblDrowsyTh: document.getElementById('lblDrowsyTh'),
  btnThemeToggle: document.getElementById('btnThemeToggle'),
  btnEyeBreak: document.getElementById('btnEyeBreak'),
  btnOpenHistory: document.getElementById('btnOpenHistory'),
  btnOpenReport: document.getElementById('btnOpenReport'),
  reportModal: document.getElementById('reportModal'),
  reportBody: document.getElementById('reportBody'),
  btnCloseModal: document.getElementById('btnCloseModal'),
  btnSaveFromModal: document.getElementById('btnSaveFromModal'),
  btnDownloadTxt: document.getElementById('btnDownloadTxt'),
  btnDownloadPng: document.getElementById('btnDownloadPng'),
  historyModal: document.getElementById('historyModal'),
  historyBody: document.getElementById('historyBody'),
  btnCloseHistory: document.getElementById('btnCloseHistory'),
  btnCloseHistory2: document.getElementById('btnCloseHistory2'),
  btnClearHistory: document.getElementById('btnClearHistory'),
  eyeModal: document.getElementById('eyeModal'),
  eyeCountdown: document.getElementById('eyeCountdown'),
  btnCloseEye: document.getElementById('btnCloseEye'),
  btnRestartEye: document.getElementById('btnRestartEye'),
  btnDoneEye: document.getElementById('btnDoneEye'),
  pomoDisplay: document.getElementById('pomoDisplay'),
  btnPomoStart: document.getElementById('btnPomoStart'),
  btnPomoReset: document.getElementById('btnPomoReset'),
};

const ctx = dom.canvas.getContext('2d');
const analyzer = new FocusPostureAnalyzer();
const simulator = new DemoSimulator();
const trendChart = new FocusTrendChart(dom.trendChartCanvas);

let faceLandmarker = null;
let mode = 'idle'; // 'idle' | 'camera' | 'demo'
let stream = null;
let rafId = null;
let sessionStartMs = null;
let lastAlertTime = 0;
let lastAlertCode = null;
let lastChartSampleMs = 0;
let lastVideoTime = -1;
let lastDetectTs = 0;
let frameCount = 0;
let fpsLastTime = performance.now();
let audioCtx = null;
let latestReport = null;

// 番茄钟状态
let pomoMinutes = 25;
let pomoRemainingSec = 25 * 60;
let pomoInterval = null;

// 护眼倒计时状态
let eyeTimer = null;
let eyeSec = 20;

const isMobileDevice = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

/** 触发语音或蜂鸣提示 */
function triggerAlertAudio(alertCode, isDanger = false, customSpeech = null) {
  const voiceMode = dom.alertVoiceMode.value;
  if (voiceMode === 'mute') return;

  if (voiceMode === 'voice' && 'speechSynthesis' in window) {
    try {
      const text = customSpeech || ALERT_META[alertCode]?.speech || '请注意保持正确坐姿与专注';
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = 'zh-CN';
      utter.rate = 1.05;
      window.speechSynthesis.speak(utter);
      return;
    } catch {
      // 回退到提示音
    }
  }

  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = isDanger ? 660 : 520;
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.26);
  } catch {
    // 忽略自动播放限制
  }
}

/** 创建指定 delegate 的 FaceLandmarker 实例 */
async function createLandmarkerWithDelegate(filesetResolver, delegate) {
  return FaceLandmarker.createFromOptions(filesetResolver, {
    baseOptions: {
      modelAssetPath: './assets/models/face_landmarker.task',
      delegate,
    },
    runningMode: 'VIDEO',
    numFaces: 1,
    minFaceDetectionConfidence: 0.4,
    minFacePresenceConfidence: 0.4,
    minTrackingConfidence: 0.4,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: false,
  });
}

/** 初始化本地同源 MediaPipe FaceLandmarker（移动端优先稳定 CPU/WASM，桌面端优先 GPU 自动回退） */
async function initFaceLandmarker() {
  const order = isMobileDevice ? ['CPU', 'GPU'] : ['GPU', 'CPU'];
  dom.modelStatus.textContent = '正在加载本地 AI 模型…';

  let filesetResolver = null;
  try {
    filesetResolver = await FilesetResolver.forVisionTasks('./assets/mediapipe/wasm');
  } catch (err) {
    console.error('WASM 运行时加载失败:', err);
    dom.modelStatus.textContent = '模型加载失败（可用模拟演示）';
    dom.modelStatus.className = 'pill pill-error';
    return;
  }

  for (const delegate of order) {
    try {
      faceLandmarker = await createLandmarkerWithDelegate(filesetResolver, delegate);
      dom.modelStatus.textContent = `AI 模型就绪（本地 ${delegate}/WASM）`;
      dom.modelStatus.className = 'pill pill-ready';
      return;
    } catch (err) {
      console.warn(`${delegate} delegate 初始化失败，尝试回退:`, err);
    }
  }

  dom.modelStatus.textContent = '模型加载失败（可用模拟演示）';
  dom.modelStatus.className = 'pill pill-error';
}

/** 同步视频容器与 Canvas 尺寸，保证手机竖屏/电脑横屏下关键点精准贴合人脸 */
function syncVideoStageSize() {
  const vw = dom.video.videoWidth;
  const vh = dom.video.videoHeight;
  if (!vw || !vh) return;
  if (dom.canvas.width !== vw || dom.canvas.height !== vh) {
    dom.canvas.width = vw;
    dom.canvas.height = vh;
    dom.videoStage.style.aspectRatio = `${vw} / ${vh}`;
  }
}

function stopAll() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  dom.video.srcObject = null;
  dom.videoStage.style.aspectRatio = '';
  mode = 'idle';
  lastVideoTime = -1;
  dom.btnToggleCam.textContent = '开启摄像头';
  dom.btnToggleDemo.textContent = '模拟演示模式';
  dom.btnCalibrate.disabled = true;
  dom.demoScenarioBar.classList.add('hidden');
  dom.emptyHint.classList.remove('hidden');
  dom.liveStateBanner.className = 'state-banner state-idle';
  dom.liveStateText.textContent = '待机中：请开启摄像头或进入模拟演示模式';
  dom.fpsBadge.textContent = 'FPS: --';
  ctx.clearRect(0, 0, dom.canvas.width, dom.canvas.height);
}

function resetSessionData() {
  analyzer.resetStats();
  trendChart.reset();
  sessionStartMs = mode !== 'idle' ? performance.now() : null;
  dom.sessionTimer.textContent = '00:00';
  dom.alertCountValue.textContent = '0 次';
  dom.focusRateValue.textContent = '--%';
  renderBreakdown();
}

async function startCamera() {
  if (mode === 'camera') {
    stopAll();
    return;
  }
  stopAll();

  if (!faceLandmarker) {
    appendLog('AI 模型尚未就绪，请稍候或先使用模拟演示模式。', 'warn');
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    appendLog('当前浏览器不支持摄像头接口，请改用 Safari / Chrome 或体验模拟演示模式。', 'danger');
    return;
  }

  try {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'user' }, width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });
    }

    dom.video.muted = true;
    dom.video.setAttribute('playsinline', '');
    dom.video.setAttribute('webkit-playsinline', '');
    dom.video.srcObject = stream;

    await new Promise((resolve) => {
      if (dom.video.readyState >= 1) return resolve();
      dom.video.onloadedmetadata = () => resolve();
      setTimeout(resolve, 1500);
    });
    await dom.video.play();

    dom.canvas.width = dom.video.videoWidth || 640;
    dom.canvas.height = dom.video.videoHeight || 480;
    syncVideoStageSize();

    mode = 'camera';
    lastVideoTime = -1;
    // 每次开启真实摄像头时重置个人基准，等待前 10 帧稳定人脸自动校准
    analyzer.resetBaseline();
    resetSessionData();
    dom.calibLabel.textContent = '正在自动校准初始坐姿…';
    dom.emptyHint.classList.add('hidden');
    dom.btnToggleCam.textContent = '停止摄像头';
    dom.btnCalibrate.disabled = false;
    appendLog(`已启动实时摄像头监测（${dom.canvas.width}×${dom.canvas.height} 本地推理），请自然平视屏幕 1 秒完成自动校准。`, 'info');
    loop(performance.now());
  } catch (err) {
    console.error('摄像头启动失败:', err);
    stopAll();
    const detail = err ? `${err.name || 'Error'}: ${err.message || ''}` : '未知错误';
    appendLog(`摄像头启动失败（${detail}），建议用系统 Safari/Chrome 打开或使用模拟演示模式。`, 'danger');
  }
}

function startDemo() {
  if (mode === 'demo') {
    stopAll();
    return;
  }
  stopAll();

  dom.canvas.width = 960;
  dom.canvas.height = 600;
  dom.videoStage.style.aspectRatio = '16 / 10';
  mode = 'demo';
  analyzer.resetBaseline();
  analyzer.baseline.faceScale = 0.28;
  analyzer.baseline.faceCenterY = 0.48;
  resetSessionData();
  dom.calibLabel.textContent = '演示默认基准';
  simulator.setScenario('normal');
  dom.demoScenarioBar.querySelectorAll('.chip').forEach((b) => {
    b.classList.toggle('active', b.dataset.scenario === 'normal');
  });
  dom.emptyHint.classList.add('hidden');
  dom.demoScenarioBar.classList.remove('hidden');
  dom.btnToggleDemo.textContent = '退出演示模式';
  dom.btnCalibrate.disabled = false;
  appendLog('已进入无摄像头模拟演示模式，可切换下方 5 个场景测试 AI 监测效果。', 'info');
  loop(performance.now());
}

/** 叠加绘制镜像人脸关键点与人脸追踪框 */
function drawLandmarks(landmarks, level) {
  ctx.clearRect(0, 0, dom.canvas.width, dom.canvas.height);
  if (!dom.toggleMesh.checked || !landmarks) return;

  const w = dom.canvas.width;
  const h = dom.canvas.height;
  const color = level === 'danger' ? '#f87171' : level === 'warn' ? '#fbbf24' : '#34d399';

  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for (let i = 0; i < landmarks.length; i++) {
    const x = 1 - landmarks[i].x;
    const y = landmarks[i].y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, w / 360);
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(minX * w - 6, minY * h - 6, (maxX - minX) * w + 12, (maxY - minY) * h + 12);
  ctx.setLineDash([]);

  const dotSize = Math.max(2, w / 280);
  ctx.fillStyle = color;
  for (let i = 0; i < landmarks.length; i += 2) {
    const pt = landmarks[i];
    ctx.fillRect((1 - pt.x) * w - dotSize / 2, pt.y * h - dotSize / 2, dotSize, dotSize);
  }
}

/** 在视频右下角绘制 3D 头部姿态方位仪 HUD */
function drawAttitudeHud(analysis) {
  if (!dom.toggleHud.checked || !analysis.hasFace) return;

  const w = dom.canvas.width;
  const h = dom.canvas.height;
  const r = Math.max(34, Math.min(48, Math.min(w, h) * 0.11));
  const cx = w - r - 18;
  const cy = h - r - 22;
  const m = analysis.metrics;
  const color = analysis.level === 'danger' ? '#f87171' : analysis.level === 'warn' ? '#fbbf24' : '#34d399';

  ctx.save();
  ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.4)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = 'rgba(16, 185, 129, 0.45)';
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.45, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((m.roll * Math.PI) / 180);
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
  ctx.beginPath();
  ctx.moveTo(-r + 6, 0); ctx.lineTo(r - 6, 0);
  ctx.moveTo(0, -r + 6); ctx.lineTo(0, r - 6);
  ctx.stroke();
  ctx.restore();

  const dx = Math.max(-r + 8, Math.min(r - 8, (m.yaw / 35) * (r - 10)));
  const dy = Math.max(-r + 8, Math.min(r - 8, (m.pitch / 30) * (r - 10)));

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + dx, cy + dy);
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx + dx, cy + dy, 4.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#cbd5e1';
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('3D 姿态仪', cx, cy + r + 14);
  ctx.restore();
}

function renderBreakdown() {
  const keys = ['SLOUCH', 'TOO_CLOSE', 'TILT', 'DROWSY', 'YAWN', 'DISTRACTED'];
  const total = analyzer.stats.alertCount;

  let maxCount = 0;
  let topLabel = '暂无异常';

  dom.breakdownList.innerHTML = keys.map((k) => {
    const count = analyzer.stats.byType[k] || 0;
    const meta = ALERT_META[k];
    if (count > maxCount) {
      maxCount = count;
      topLabel = `高频项：${meta.label}`;
    }
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    return `
      <div class="dist-item">
        <div class="dist-head">
          <span>${meta.label}</span>
          <strong>${count} 次 (${pct}%)</strong>
        </div>
        <div class="bar">
          <div class="bar-fill" style="width:${pct}%; background:${meta.color};"></div>
        </div>
      </div>
    `;
  }).join('');

  dom.topIssueHint.textContent = topLabel;
}

function updateDashboard(analysis, nowMs) {
  if (analysis.justAutoCalibrated) {
    dom.calibLabel.textContent = '已自动校准（可随时重校）';
    appendLog('已完成初始坐姿与个人眼部基线自动校准，监测已进入精准模式。', 'info');
  }

  if (sessionStartMs) {
    const sec = Math.floor((nowMs - sessionStartMs) / 1000);
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    dom.sessionTimer.textContent = `${mm}:${ss}`;
  }

  dom.liveStateBanner.className = `state-banner state-${analysis.level}`;
  dom.liveStateText.textContent = analysis.statusText;
  dom.focusScoreValue.textContent = analysis.score;
  dom.scoreRing.className = `score-ring ring-${analysis.level}`;
  dom.statusLabel.textContent = analysis.level === 'good' ? '专注良好' : analysis.level === 'warn' ? '轻度异常' : '高风险提醒';
  dom.focusRateValue.textContent = `${analysis.focusRate}%`;

  if (nowMs - lastChartSampleMs >= 1000) {
    lastChartSampleMs = nowMs;
    trendChart.push(analysis.score, analysis.level);
  }

  if (analysis.hasFace) {
    const m = analysis.metrics;
    const cfg = analyzer.config;
    setMetric(dom.valPitch, dom.barPitch, `${m.pitch.toFixed(1)}°`, Math.min(100, (Math.abs(m.pitch) / 30) * 100), m.pitch > cfg.pitchDeg);
    setMetric(dom.valYaw, dom.barYaw, `${m.yaw.toFixed(1)}°`, Math.min(100, (Math.abs(m.yaw) / 35) * 100), Math.abs(m.yaw) > cfg.yawDeg);
    setMetric(dom.valRoll, dom.barRoll, `${m.roll.toFixed(1)}°`, Math.min(100, (Math.abs(m.roll) / 25) * 100), Math.abs(m.roll) > cfg.rollDeg);
    setMetric(dom.valBlink, dom.barBlink, `${Math.round(m.blink * 100)}%`, Math.min(100, m.blink * 100), m.blink > 0.45);
    setMetric(dom.valYawn, dom.barYawn, `${Math.round(m.yawn * 100)}%`, Math.min(100, m.yawn * 100), m.yawn > 0.55);
    setMetric(dom.valScale, dom.barScale, `${Math.round(m.scaleRatio * 100)}%`, Math.min(100, (m.scaleRatio / 1.5) * 100), m.scaleRatio > cfg.scaleRatio);
  }

  if (analysis.alertCode) {
    const cooldown = analysis.alertCode === lastAlertCode ? 5000 : 2500;
    if (nowMs - lastAlertTime > cooldown) {
      lastAlertTime = nowMs;
      lastAlertCode = analysis.alertCode;
      analyzer.recordAlert(analysis.alertCode);
      dom.alertCountValue.textContent = `${analyzer.stats.alertCount} 次`;
      renderBreakdown();
      appendLog(analysis.statusText, analysis.level === 'danger' ? 'danger' : 'warn');
      triggerAlertAudio(analysis.alertCode, analysis.level === 'danger');
    }
  }
}

function setMetric(valEl, barEl, text, percent, isAlert) {
  valEl.textContent = text;
  barEl.style.width = `${Math.max(4, Math.min(100, percent))}%`;
  barEl.style.backgroundColor = isAlert ? '#ef4444' : '#3b82f6';
}

function appendLog(message, type = 'warn') {
  const empty = dom.eventLogList.querySelector('.log-empty');
  if (empty) empty.remove();

  const li = document.createElement('li');
  if (type === 'danger') li.className = 'log-danger';
  else if (type === 'info') li.className = 'log-info';

  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  li.innerHTML = `<span>${message}</span><span class="mono">${time}</span>`;
  dom.eventLogList.prepend(li);

  while (dom.eventLogList.children.length > 35) {
    dom.eventLogList.lastElementChild.remove();
  }
}

function loop(nowMs) {
  if (mode === 'idle') return;

  if (mode === 'camera' && dom.video.readyState >= 2) {
    // 仅在新视频帧到达时执行 AI 推理，避免 120Hz 屏幕重复喂同一帧导致时间戳异常或卡顿
    const currentTime = dom.video.currentTime;
    if (currentTime !== lastVideoTime) {
      lastVideoTime = currentTime;
      syncVideoStageSize();

      frameCount += 1;
      if (nowMs - fpsLastTime >= 1000) {
        dom.fpsBadge.textContent = `FPS: ${frameCount}`;
        frameCount = 0;
        fpsLastTime = nowMs;
      }

      // MediaPipe VIDEO 模式要求严格单调递增的整数毫秒时间戳
      const detectTs = Math.max(lastDetectTs + 1, Math.round(nowMs));
      lastDetectTs = detectTs;

      try {
        const result = faceLandmarker.detectForVideo(dom.video, detectTs);
        const features = analyzer.extractFromMediaPipe(result, dom.canvas.width, dom.canvas.height);
        const analysis = analyzer.update(features, detectTs, true);
        const landmarks = result.faceLandmarks?.[0] || null;
        drawLandmarks(landmarks, analysis.level);
        drawAttitudeHud(analysis);
        updateDashboard(analysis, detectTs);
      } catch (err) {
        console.warn('单帧推理异常已自动跳过:', err);
      }
    }
  } else if (mode === 'demo') {
    frameCount += 1;
    if (nowMs - fpsLastTime >= 1000) {
      dom.fpsBadge.textContent = `FPS: ${frameCount}`;
      frameCount = 0;
      fpsLastTime = nowMs;
    }

    const features = simulator.step(nowMs);
    const analysis = analyzer.update(features, nowMs, false);
    simulator.render(ctx, dom.canvas.width, dom.canvas.height, features, dom.toggleMesh.checked, analysis.level);
    drawAttitudeHud(analysis);
    updateDashboard(analysis, nowMs);
  }

  rafId = requestAnimationFrame(loop);
}

function syncSlidersFromConfig() {
  const c = analyzer.config;
  dom.sliderPitch.value = c.pitchDeg;
  dom.lblPitchTh.textContent = `${c.pitchDeg}°`;
  dom.sliderScale.value = Math.round(c.scaleRatio * 100);
  dom.lblScaleTh.textContent = `${Math.round(c.scaleRatio * 100)}%`;
  dom.sliderDrowsy.value = c.drowsyMs;
  dom.lblDrowsyTh.textContent = `${(c.drowsyMs / 1000).toFixed(1)}s`;
}

function buildCurrentReport() {
  const modeLabel = mode === 'camera' ? '真实摄像头实时推理' : mode === 'demo' ? '无摄像头模拟演示' : '待机状态';
  return analyzer.buildReport(dom.sessionTimer.textContent, modeLabel);
}

function openReportModal() {
  latestReport = buildCurrentReport();
  dom.reportBody.innerHTML = `
    <div class="hint-text">生成时间：${latestReport.generatedAt} · 监测模式：${latestReport.modeLabel}</div>
    <div class="report-kpis">
      <div class="kpi-box"><span>监测时长</span><strong>${latestReport.durationText}</strong></div>
      <div class="kpi-box"><span>平均专注分</span><strong>${latestReport.avgScore}</strong></div>
      <div class="kpi-box"><span>专注保持率</span><strong>${latestReport.focusRate}%</strong></div>
      <div class="kpi-box"><span>异常提醒</span><strong>${latestReport.alertCount} 次</strong></div>
    </div>
    <div class="report-advice">
      <strong>AI 个性化护眼护颈建议：</strong>
      <ul>${latestReport.suggestions.map((s) => `<li>${s}</li>`).join('')}</ul>
    </div>
  `;
  dom.reportModal.classList.remove('hidden');
}

function downloadReportTxt() {
  if (!latestReport) return;
  const lines = [
    '================================================',
    '  FocusGuard AI v4.0 学习专注度与坐姿健康报告',
    '================================================',
    `生成时间：${latestReport.generatedAt}`,
    `监测模式：${latestReport.modeLabel}`,
    `监测时长：${latestReport.durationText}`,
    `平均专注评分：${latestReport.avgScore} / 100`,
    `专注保持率：${latestReport.focusRate}%`,
    `异常提醒总计：${latestReport.alertCount} 次`,
    '',
    '【异常分类统计】',
    ...latestReport.breakdown.map((b) => `- ${b.label}：${b.count} 次`),
    '',
    '【AI 健康建议】',
    ...latestReport.suggestions.map((s, i) => `${i + 1}. ${s}`),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `FocusGuard_学习健康报告_${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** 渲染并打开历史学习档案 */
function openHistoryModal() {
  const list = loadHistory();
  if (list.length === 0) {
    dom.historyBody.innerHTML = '<p class="hint-text" style="text-align:center;padding:24px 0;">暂无历史学习档案。完成监测后点击“保存至档案”即可永久记录在本地浏览器中。</p>';
  } else {
    dom.historyBody.innerHTML = `
      <table class="history-table">
        <thead>
          <tr>
            <th>记录时间</th>
            <th>时长</th>
            <th>平均分</th>
            <th>专注率</th>
            <th>提醒次数</th>
            <th>最高频问题</th>
          </tr>
        </thead>
        <tbody>
          ${list.map((r) => `
            <tr>
              <td>${r.time}</td>
              <td>${r.duration}</td>
              <td><strong>${r.avgScore}</strong></td>
              <td>${r.focusRate}%</td>
              <td>${r.alertCount} 次</td>
              <td>${r.topIssue}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }
  dom.historyModal.classList.remove('hidden');
}

/** 番茄专注时钟逻辑 */
function updatePomoDisplay() {
  const mm = String(Math.floor(pomoRemainingSec / 60)).padStart(2, '0');
  const ss = String(pomoRemainingSec % 60).padStart(2, '0');
  dom.pomoDisplay.textContent = `${mm}:${ss}`;
}

function togglePomodoro() {
  if (pomoInterval) {
    clearInterval(pomoInterval);
    pomoInterval = null;
    dom.btnPomoStart.textContent = '继续专注';
    return;
  }
  dom.btnPomoStart.textContent = '暂停';
  pomoInterval = setInterval(() => {
    pomoRemainingSec -= 1;
    updatePomoDisplay();
    if (pomoRemainingSec <= 0) {
      clearInterval(pomoInterval);
      pomoInterval = null;
      dom.btnPomoStart.textContent = '开始专注';
      pomoRemainingSec = pomoMinutes * 60;
      updatePomoDisplay();
      const rep = buildCurrentReport();
      saveHistoryRecord(rep);
      appendLog(`已完成 ${pomoMinutes} 分钟番茄专注！已自动存入历史档案。`, 'info');
      triggerAlertAudio(null, false, '恭喜完成本次番茄专注，建议眺望远方放松眼睛');
      openReportModal();
    }
  }, 1000);
}

/** 20-20-20 护眼引导倒计时 */
function startEyeBreak() {
  dom.eyeModal.classList.remove('hidden');
  clearInterval(eyeTimer);
  eyeSec = 20;
  dom.eyeCountdown.textContent = `${eyeSec}s`;
  eyeTimer = setInterval(() => {
    eyeSec -= 1;
    dom.eyeCountdown.textContent = `${Math.max(0, eyeSec)}s`;
    if (eyeSec <= 0) {
      clearInterval(eyeTimer);
      triggerAlertAudio(null, false, '护眼放松完成，欢迎继续保持高效学习');
    }
  }, 1000);
}

function closeEyeBreak() {
  clearInterval(eyeTimer);
  dom.eyeModal.classList.add('hidden');
}

// 绑定事件
dom.btnStartCamHero.addEventListener('click', startCamera);
dom.btnToggleCam.addEventListener('click', startCamera);
dom.btnStartDemoHero.addEventListener('click', startDemo);
dom.btnToggleDemo.addEventListener('click', startDemo);

dom.btnResetSession.addEventListener('click', () => {
  resetSessionData();
  appendLog('已重置本次监测统计与趋势图。', 'info');
});

dom.btnSaveSession.addEventListener('click', () => {
  const rep = buildCurrentReport();
  saveHistoryRecord(rep);
  appendLog(`已保存本次学习档案（平均分 ${rep.avgScore}，专注率 ${rep.focusRate}%）。`, 'info');
});

dom.btnCalibrate.addEventListener('click', () => {
  if (analyzer.calibrateCurrent()) {
    dom.calibLabel.textContent = '已手动校准个人标准坐姿';
    appendLog('已完成当前标准坐姿与眼部基线校准。', 'info');
  }
});

dom.btnClearLog.addEventListener('click', () => {
  dom.eventLogList.innerHTML = '<li class="log-empty">日志已清空。</li>';
});

dom.demoScenarioBar.querySelectorAll('.chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    dom.demoScenarioBar.querySelectorAll('.chip').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    simulator.setScenario(btn.dataset.scenario);
  });
});

// 番茄钟事件
document.querySelectorAll('[data-pomo]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-pomo]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    clearInterval(pomoInterval);
    pomoInterval = null;
    pomoMinutes = Number(btn.dataset.pomo);
    pomoRemainingSec = pomoMinutes * 60;
    dom.btnPomoStart.textContent = '开始专注';
    updatePomoDisplay();
  });
});

dom.btnPomoStart.addEventListener('click', togglePomodoro);
dom.btnPomoReset.addEventListener('click', () => {
  clearInterval(pomoInterval);
  pomoInterval = null;
  pomoRemainingSec = pomoMinutes * 60;
  dom.btnPomoStart.textContent = '开始专注';
  updatePomoDisplay();
});

// 灵敏度预设与滑块联动
document.querySelectorAll('.preset-group .chip-sm[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.preset-group .chip-sm[data-preset]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const preset = PRESET_THRESHOLDS[btn.dataset.preset];
    if (preset) {
      analyzer.setConfig(preset);
      syncSlidersFromConfig();
      appendLog(`已切换判定灵敏度为「${preset.label}」模式。`, 'info');
    }
  });
});

dom.sliderPitch.addEventListener('input', (e) => {
  const val = Number(e.target.value);
  analyzer.setConfig({ pitchDeg: val });
  dom.lblPitchTh.textContent = `${val}°`;
});

dom.sliderScale.addEventListener('input', (e) => {
  const val = Number(e.target.value);
  analyzer.setConfig({ scaleRatio: val / 100 });
  dom.lblScaleTh.textContent = `${val}%`;
});

dom.sliderDrowsy.addEventListener('input', (e) => {
  const val = Number(e.target.value);
  analyzer.setConfig({ drowsyMs: val });
  dom.lblDrowsyTh.textContent = `${(val / 1000).toFixed(1)}s`;
});

// 主题切换
dom.btnThemeToggle.addEventListener('click', () => {
  const root = document.documentElement;
  const isDark = root.getAttribute('data-theme') !== 'light';
  root.setAttribute('data-theme', isDark ? 'light' : 'dark');
  dom.btnThemeToggle.textContent = isDark ? '🌙 深色' : '☀ 浅色';
  trendChart.draw();
});

// 护眼弹窗
dom.btnEyeBreak.addEventListener('click', startEyeBreak);
dom.btnCloseEye.addEventListener('click', closeEyeBreak);
dom.btnDoneEye.addEventListener('click', closeEyeBreak);
dom.btnRestartEye.addEventListener('click', startEyeBreak);

// 报告弹窗
dom.btnOpenReport.addEventListener('click', openReportModal);
dom.btnCloseModal.addEventListener('click', () => dom.reportModal.classList.add('hidden'));
dom.reportModal.addEventListener('click', (e) => {
  if (e.target === dom.reportModal) dom.reportModal.classList.add('hidden');
});
dom.btnSaveFromModal.addEventListener('click', () => {
  if (latestReport) {
    saveHistoryRecord(latestReport);
    appendLog('已将本次报告存入本地历史学习档案。', 'info');
  }
});
dom.btnDownloadTxt.addEventListener('click', downloadReportTxt);
dom.btnDownloadPng.addEventListener('click', () => {
  if (latestReport) downloadReportPng(latestReport);
});

// 历史档案弹窗
dom.btnOpenHistory.addEventListener('click', openHistoryModal);
dom.btnCloseHistory.addEventListener('click', () => dom.historyModal.classList.add('hidden'));
dom.btnCloseHistory2.addEventListener('click', () => dom.historyModal.classList.add('hidden'));
dom.historyModal.addEventListener('click', (e) => {
  if (e.target === dom.historyModal) dom.historyModal.classList.add('hidden');
});
dom.btnClearHistory.addEventListener('click', () => {
  clearHistory();
  openHistoryModal();
});

window.addEventListener('resize', () => trendChart.draw());

// 初始化
renderBreakdown();
trendChart.draw();
syncSlidersFromConfig();
updatePomoDisplay();
initFaceLandmarker();
