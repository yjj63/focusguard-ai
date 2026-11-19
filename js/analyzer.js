/**
 * FocusGuard AI 核心视觉姿态与专注度分析模块（v4.0 正式版）
 * 核心特性：
 * 1. 基于 MediaPipe 478 维 3D 人脸关键点直接解算 Pitch / Yaw / Roll（无矩阵行列主序与符号歧义）
 * 2. 自动初始坐姿校准（兼容手机近距自拍与电脑桌面距离，防止未校准时误报“离屏过近”挡住其他提醒）
 * 3. 自适应个人睁眼基线 EAR + 深度网络 Blendshape 融合闭眼检测（戴镜/摘镜均稳定、不误报）
 * 4. 公平多异常仲裁机制（高危疲劳优先，其余异常按超标严重程度动态优先展示）
 */

export const PRESET_THRESHOLDS = {
  relaxed: {
    label: '宽松',
    pitchDeg: 18,
    yawDeg: 24,
    rollDeg: 15,
    scaleRatio: 1.35,
    drowsyMs: 1500,
    postureMs: 1500,
  },
  standard: {
    label: '标准',
    pitchDeg: 14,
    yawDeg: 18,
    rollDeg: 11,
    scaleRatio: 1.26,
    drowsyMs: 1200,
    postureMs: 1100,
  },
  strict: {
    label: '严格',
    pitchDeg: 10,
    yawDeg: 13,
    rollDeg: 8,
    scaleRatio: 1.18,
    drowsyMs: 900,
    postureMs: 850,
  },
};

export const ALERT_META = {
  SLOUCH: { label: '低头驼背', color: '#f59e0b', speech: '检测到低头驼背，请抬头挺胸' },
  TOO_CLOSE: { label: '离屏过近', color: '#ef4444', speech: '距离屏幕过近，请向后保持视距' },
  TILT: { label: '明显歪头', color: '#a78bfa', speech: '检测到歪头，请摆正颈椎' },
  DROWSY: { label: '疲劳闭眼', color: '#f43f5e', speech: '检测到疲劳闭眼，建议起身休息片刻' },
  YAWN: { label: '频繁哈欠', color: '#fb923c', speech: '检测到打哈欠，注意适当放松' },
  DISTRACTED: { label: '视线走神', color: '#38bdf8', speech: '视线偏离屏幕，请保持专注' },
  ABSENT: { label: '离开座位', color: '#94a3b8', speech: '未检测到人脸' },
};

export class FocusPostureAnalyzer {
  constructor() {
    this.config = { ...PRESET_THRESHOLDS.standard };
    this.resetBaseline();
    this.resetStats();
  }

  /** 重置个人基准与自动校准计数 */
  resetBaseline() {
    this.baseline = {
      calibrated: false,
      autoCalibrated: false,
      pitch: 0,
      yaw: 0,
      roll: 0,
      faceScale: 0.30,
      faceCenterY: 0.48,
      openEar: null, // 个人自然睁眼 EAR 基线（不硬编码，避免个体眼型/摘眼镜差异导致误报）
    };
    this.autoCalibSamples = [];
  }

  /** 更新灵敏度配置 */
  setConfig(partial) {
    this.config = { ...this.config, ...partial };
  }

  resetStats() {
    this.smooth = {
      pitch: 0,
      yaw: 0,
      roll: 0,
      blink: 0,
      yawn: 0,
      ear: 0.25,
      faceScale: this.baseline.faceScale,
      faceCenterY: this.baseline.faceCenterY,
      score: 95,
    };
    this.timers = {
      drowsyMs: 0,
      slouchMs: 0,
      tooCloseMs: 0,
      tiltMs: 0,
      distractedMs: 0,
      absentMs: 0,
      yawnMs: 0,
    };
    this.stats = {
      totalFrames: 0,
      focusedFrames: 0,
      scoreSum: 0,
      alertCount: 0,
      byType: {
        SLOUCH: 0,
        TOO_CLOSE: 0,
        TILT: 0,
        DROWSY: 0,
        YAWN: 0,
        DISTRACTED: 0,
        ABSENT: 0,
      },
    };
    this.lastTimestamp = null;
    this.lastRawFeatures = null;
    this.hasInitializedSmooth = false;
  }

  /** 记录一次已触发的冷却后告警 */
  recordAlert(code) {
    this.stats.alertCount += 1;
    if (code && this.stats.byType[code] !== undefined) {
      this.stats.byType[code] += 1;
    }
  }

  /** 手动将当前帧设为个人标准坐姿与睁眼基准 */
  calibrateCurrent() {
    if (!this.lastRawFeatures) return false;
    this.baseline = {
      calibrated: true,
      autoCalibrated: false,
      pitch: this.smooth.pitch,
      yaw: this.smooth.yaw,
      roll: this.smooth.roll,
      faceScale: Math.max(0.12, this.smooth.faceScale),
      faceCenterY: this.smooth.faceCenterY,
      openEar: this.smooth.ear > 0.08 ? this.smooth.ear : this.baseline.openEar,
    };
    this.autoCalibSamples = [];
    // 校准后清零所有异常累计时长，立即生效
    Object.keys(this.timers).forEach((k) => (this.timers[k] = 0));
    return true;
  }

  /**
   * 从 MediaPipe FaceLandmarker 478 维 3D 关键点与 Blendshapes 提取统一特征
   * 关键设计：
   * - Pitch：额头(10)→下巴(152)在 Y-Z 平面倾角（低头时额头前倾 z 减小、下巴后收 z 增大，严格为正）
   * - Yaw：右脸侧(234)→左脸侧(454)在 X-Z 平面倾角（与宽高比无关，左右转头严格对称）
   * - Roll：右外眼角(33)→左外眼角(263)在像素 X-Y 平面倾角（经画面宽高校正，手机竖屏不畸变）
   * - EAR：双眼前庭上下眼睑/眼宽几何比，仅用于相对个人睁眼基线对比，不硬编码绝对值
   */
  extractFromMediaPipe(result, frameWidth = 640, frameHeight = 480) {
    if (!result || !result.faceLandmarks || result.faceLandmarks.length === 0) {
      return null;
    }
    const lm = result.faceLandmarks[0];
    if (!lm || lm.length < 468) return null;

    const w = Math.max(1, Number(frameWidth) || 640);
    const h = Math.max(1, Number(frameHeight) || 480);

    // 1. 人脸垂直尺寸占比与中心 Y（衡量离屏距离与低头下沉）
    let minY = 1, maxY = 0;
    for (let i = 0; i < lm.length; i++) {
      const y = lm[i].y;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const faceScale = Math.max(0.08, Math.min(0.95, maxY - minY));
    const faceCenterY = (minY + maxY) / 2;

    // 2. 3D 关键点直接解算 Pitch / Yaw / Roll（MediaPipe 中 z 与 x 同尺度，统一乘 w 换算到像素单位）
    // 符号与镜像自拍视角完全一致：低头 Pitch>0，向右转头 Yaw>0，向右歪头 Roll>0
    const pTop = lm[10];
    const pChin = lm[152];
    const dyFace = Math.max(1e-4, (pChin.y - pTop.y) * h);
    const dzFace = (pChin.z - pTop.z) * w;
    const pitchDeg = Math.atan2(dzFace, dyFace) * (180 / Math.PI);

    const pRightCheek = lm[234];
    const pLeftCheek = lm[454];
    const dxCheek = Math.max(1e-4, (pLeftCheek.x - pRightCheek.x) * w);
    const dzCheek = (pRightCheek.z - pLeftCheek.z) * w;
    const yawDeg = Math.atan2(dzCheek, dxCheek) * (180 / Math.PI);

    const pRightEyeOut = lm[33];
    const pLeftEyeOut = lm[263];
    const dxEye = Math.max(1e-4, (pLeftEyeOut.x - pRightEyeOut.x) * w);
    const dyEye = (pRightEyeOut.y - pLeftEyeOut.y) * h;
    const rollDeg = Math.atan2(dyEye, dxEye) * (180 / Math.PI);

    // 3. 计算个人原始 EAR（像素坐标系下左右眼纵横比均值，供自适应基线对比）
    const distPx = (a, b) => Math.hypot((a.x - b.x) * w, (a.y - b.y) * h);
    const rightEar = distPx(lm[159], lm[145]) / Math.max(1e-4, distPx(lm[33], lm[133]));
    const leftEar = distPx(lm[386], lm[374]) / Math.max(1e-4, distPx(lm[362], lm[263]));
    const rawEar = (rightEar + leftEar) / 2;

    // 4. 提取 MediaPipe 原生深度学习 Blendshapes
    let eyeBlinkLeft = 0, eyeBlinkRight = 0, jawOpen = 0;
    let hasBlendshapes = false;
    if (result.faceBlendshapes && result.faceBlendshapes.length > 0 && result.faceBlendshapes[0].categories) {
      hasBlendshapes = true;
      for (const c of result.faceBlendshapes[0].categories) {
        if (c.categoryName === 'eyeBlinkLeft') eyeBlinkLeft = c.score;
        else if (c.categoryName === 'eyeBlinkRight') eyeBlinkRight = c.score;
        else if (c.categoryName === 'jawOpen') jawOpen = c.score;
      }
    }

    // 5. 若未提供 Blendshapes，通过上下唇距离近似兜底哈欠
    if (!hasBlendshapes && lm[13] && lm[14]) {
      const mouthOpen = distPx(lm[13], lm[14]) / Math.max(1e-4, distPx(lm[61], lm[291]));
      jawOpen = Math.max(0, Math.min(1, (mouthOpen - 0.15) / 0.45));
    }

    const blendBlink = (eyeBlinkLeft + eyeBlinkRight) / 2;

    if (!Number.isFinite(pitchDeg) || !Number.isFinite(yawDeg) || !Number.isFinite(rollDeg)) {
      return null;
    }

    return {
      pitch: pitchDeg,
      yaw: yawDeg,
      roll: rollDeg,
      blink: blendBlink,
      ear: Number.isFinite(rawEar) ? rawEar : 0.25,
      yawn: jawOpen,
      faceScale,
      faceCenterY,
      hasBlendshapes,
    };
  }

  /**
   * 更新一帧特征并返回完整分析状态
   * @param {object|null} rawFeatures - 无人脸时为 null
   * @param {number} timestampMs - 当前时间戳（毫秒）
   * @param {boolean} allowAutoCalibrate - 是否允许在启动初期自动采样校准（摄像头模式开启，演示模式关闭）
   */
  update(rawFeatures, timestampMs, allowAutoCalibrate = false) {
    const dt = this.lastTimestamp ? Math.min(250, Math.max(16, timestampMs - this.lastTimestamp)) : 33;
    this.lastTimestamp = timestampMs;
    this.stats.totalFrames += 1;

    if (!rawFeatures) {
      this.timers.absentMs += dt;
      this.smooth.score = this.smooth.score * 0.92 + 20 * 0.08;
      this.stats.scoreSum += this.smooth.score;
      const isAbsent = this.timers.absentMs > 1800;
      return {
        hasFace: false,
        justAutoCalibrated: false,
        metrics: {
          pitch: 0,
          yaw: 0,
          roll: 0,
          blink: 0,
          yawn: 0,
          scaleRatio: 1,
        },
        score: Math.round(this.smooth.score),
        level: isAbsent ? 'warn' : 'good',
        statusText: isAbsent ? '未检测到人脸（可能离开座位）' : '正在重新定位人脸…',
        alertCode: isAbsent ? 'ABSENT' : null,
        focusRate: this.getFocusRate(),
      };
    }

    this.timers.absentMs = 0;
    this.lastRawFeatures = rawFeatures;

    // 首帧直接赋值，避免从默认 0 缓慢爬升带来延迟
    const alpha = this.hasInitializedSmooth ? 0.30 : 1.0;
    const blinkAlpha = this.hasInitializedSmooth ? 0.50 : 1.0;
    this.hasInitializedSmooth = true;

    this.smooth.pitch = this.smooth.pitch * (1 - alpha) + rawFeatures.pitch * alpha;
    this.smooth.yaw = this.smooth.yaw * (1 - alpha) + rawFeatures.yaw * alpha;
    this.smooth.roll = this.smooth.roll * (1 - alpha) + rawFeatures.roll * alpha;
    this.smooth.yawn = this.smooth.yawn * (1 - 0.35) + rawFeatures.yawn * 0.35;
    this.smooth.faceScale = this.smooth.faceScale * (1 - alpha) + rawFeatures.faceScale * alpha;
    this.smooth.faceCenterY = this.smooth.faceCenterY * (1 - alpha) + rawFeatures.faceCenterY * alpha;
    if (typeof rawFeatures.ear === 'number' && Number.isFinite(rawFeatures.ear)) {
      this.smooth.ear = this.smooth.ear * (1 - blinkAlpha) + rawFeatures.ear * blinkAlpha;
    }

    // 启动前 12 帧稳定人脸自动静默校准（解决手机近距/电脑高角度默认基准不匹配问题）
    let justAutoCalibrated = false;
    if (allowAutoCalibrate && !this.baseline.calibrated) {
      // 只在睁眼状态采样，避免刚巧眨眼时采到闭眼 EAR
      if (rawFeatures.blink < 0.35) {
        this.autoCalibSamples.push({
          pitch: rawFeatures.pitch,
          yaw: rawFeatures.yaw,
          roll: rawFeatures.roll,
          faceScale: rawFeatures.faceScale,
          faceCenterY: rawFeatures.faceCenterY,
          ear: rawFeatures.ear,
        });
      }
      if (this.autoCalibSamples.length >= 10) {
        const n = this.autoCalibSamples.length;
        const avg = (key) => this.autoCalibSamples.reduce((s, x) => s + x[key], 0) / n;
        const earList = this.autoCalibSamples
          .map((x) => x.ear)
          .filter((v) => typeof v === 'number' && v > 0.08)
          .sort((a, b) => a - b);
        this.baseline = {
          calibrated: true,
          autoCalibrated: true,
          pitch: avg('pitch'),
          yaw: avg('yaw'),
          roll: avg('roll'),
          faceScale: Math.max(0.12, avg('faceScale')),
          faceCenterY: avg('faceCenterY'),
          // 取 70 分位作为个人自然睁眼 EAR 基线，避免混入半眨眼帧
          openEar: earList.length > 0 ? earList[Math.floor(earList.length * 0.7)] : null,
        };
        this.autoCalibSamples = [];
        justAutoCalibrated = true;
      }
    }

    // 若中途摘掉眼镜（近视镜片缩小效应消失导致睁眼 EAR 变大），在完全清醒睁眼帧缓慢上调个人睁眼基线
    if (this.baseline.openEar && rawFeatures.blink < 0.12 && typeof rawFeatures.ear === 'number' && rawFeatures.ear > this.baseline.openEar) {
      this.baseline.openEar = this.baseline.openEar * 0.96 + rawFeatures.ear * 0.04;
    }

    // 计算融合闭眼度：深度模型 Blendshape + 相对个人睁眼基线 EAR 降幅
    let effectiveBlink = rawFeatures.blink;
    if (this.baseline.openEar && typeof rawFeatures.ear === 'number' && rawFeatures.ear > 0) {
      const earRatio = rawFeatures.ear / this.baseline.openEar;
      // 仅当眼睑相对本人自然睁眼闭合超过 35%（earRatio < 0.65）才计入闭眼度，消除眼型/摘镜误报
      const relEarBlink = Math.max(0, Math.min(1, (0.65 - earRatio) / 0.30));
      if (rawFeatures.hasBlendshapes === false) {
        effectiveBlink = relEarBlink;
      } else {
        // 深度网络认可轻度闭眼（>0.18）或几何眼睑已明确闭合超过 55%（earRatio < 0.45）时启用融合补强
        effectiveBlink = (rawFeatures.blink > 0.18 || earRatio < 0.45)
          ? Math.max(rawFeatures.blink, relEarBlink)
          : rawFeatures.blink;
      }
    }
    this.smooth.blink = this.smooth.blink * (1 - blinkAlpha) + effectiveBlink * blinkAlpha;

    // 相对个人基准的偏移量
    const dPitch = this.smooth.pitch - this.baseline.pitch;
    const dYaw = this.smooth.yaw - this.baseline.yaw;
    const dRoll = this.smooth.roll - this.baseline.roll;
    const absYaw = Math.abs(dYaw);
    const absRoll = Math.abs(dRoll);
    const scaleRatio = this.smooth.faceScale / Math.max(0.12, this.baseline.faceScale);
    const dCenterY = this.smooth.faceCenterY - this.baseline.faceCenterY;

    const cfg = this.config;
    const isDrowsyNow = this.smooth.blink > 0.45;
    const isYawnNow = this.smooth.yawn > 0.55;
    const isSlouchNow = dPitch > cfg.pitchDeg || dCenterY > 0.12;
    const isTooCloseNow = scaleRatio > cfg.scaleRatio;
    const isTiltNow = absRoll > cfg.rollDeg;
    const isDistractedNow = absYaw > cfg.yawDeg;

    this.timers.drowsyMs = isDrowsyNow ? this.timers.drowsyMs + dt : Math.max(0, this.timers.drowsyMs - dt * 2.5);
    this.timers.yawnMs = isYawnNow ? this.timers.yawnMs + dt : Math.max(0, this.timers.yawnMs - dt * 2.5);
    this.timers.slouchMs = isSlouchNow ? this.timers.slouchMs + dt : Math.max(0, this.timers.slouchMs - dt * 2.5);
    this.timers.tooCloseMs = isTooCloseNow ? this.timers.tooCloseMs + dt : Math.max(0, this.timers.tooCloseMs - dt * 2.5);
    this.timers.tiltMs = isTiltNow ? this.timers.tiltMs + dt : Math.max(0, this.timers.tiltMs - dt * 2.5);
    this.timers.distractedMs = isDistractedNow ? this.timers.distractedMs + dt : Math.max(0, this.timers.distractedMs - dt * 2.5);

    // 综合评分计算
    let targetScore = 100;
    targetScore -= Math.max(0, dPitch - cfg.pitchDeg * 0.55) * 1.45;
    targetScore -= Math.max(0, absYaw - cfg.yawDeg * 0.55) * 1.3;
    targetScore -= Math.max(0, absRoll - cfg.rollDeg * 0.6) * 1.2;
    if (scaleRatio > cfg.scaleRatio - 0.10) targetScore -= (scaleRatio - (cfg.scaleRatio - 0.10)) * 95;
    if (this.smooth.blink > 0.45) targetScore -= (this.smooth.blink - 0.45) * 85;
    if (this.smooth.yawn > 0.45) targetScore -= (this.smooth.yawn - 0.45) * 45;
    targetScore = Math.max(15, Math.min(100, targetScore));

    this.smooth.score = this.smooth.score * 0.88 + targetScore * 0.12;
    this.stats.scoreSum += this.smooth.score;

    // 多异常公平仲裁：
    // 1. 高危疲劳闭眼最高优先；
    // 2. 其余已达持续时长的异常按“超出阈值的严重倍数”排序，避免轻微前倾长期压死明显的歪头/走神
    let level = 'good';
    let statusText = '专注良好 · 坐姿端正';
    let alertCode = null;

    if (this.timers.drowsyMs > cfg.drowsyMs) {
      level = 'danger';
      statusText = '检测到持续闭眼：疑似疲劳打瞌睡！';
      alertCode = 'DROWSY';
    } else {
      const candidates = [];
      if (this.timers.yawnMs > 1000) {
        candidates.push({
          code: 'YAWN',
          level: 'warn',
          text: '检测到打哈欠：注意适当休息',
          severity: this.smooth.yawn / 0.55,
        });
      }
      if (this.timers.tooCloseMs > cfg.postureMs) {
        candidates.push({
          code: 'TOO_CLOSE',
          level: 'danger',
          text: '距离屏幕过近：请向后保持合理视距',
          severity: (scaleRatio - 1) / Math.max(0.1, cfg.scaleRatio - 1),
        });
      }
      if (this.timers.slouchMs > cfg.postureMs) {
        candidates.push({
          code: 'SLOUCH',
          level: 'warn',
          text: '检测到低头驼背：请抬头挺胸',
          severity: Math.max(dPitch / cfg.pitchDeg, dCenterY / 0.12),
        });
      }
      if (this.timers.tiltMs > cfg.postureMs) {
        candidates.push({
          code: 'TILT',
          level: 'warn',
          text: '检测到明显歪头：请摆正颈椎',
          severity: absRoll / cfg.rollDeg,
        });
      }
      if (this.timers.distractedMs > cfg.postureMs) {
        candidates.push({
          code: 'DISTRACTED',
          level: 'warn',
          text: '视线偏离屏幕：请保持学习专注',
          severity: absYaw / cfg.yawDeg,
        });
      }

      if (candidates.length > 0) {
        candidates.sort((a, b) => b.severity - a.severity);
        const top = candidates[0];
        level = top.level;
        statusText = top.text;
        alertCode = top.code;
      }
    }

    if (level === 'good') {
      this.stats.focusedFrames += 1;
    }

    return {
      hasFace: true,
      justAutoCalibrated,
      metrics: {
        pitch: dPitch,
        yaw: dYaw,
        roll: dRoll,
        blink: this.smooth.blink,
        yawn: this.smooth.yawn,
        scaleRatio,
      },
      score: Math.round(this.smooth.score),
      level,
      statusText,
      alertCode,
      focusRate: this.getFocusRate(),
    };
  }

  getFocusRate() {
    if (this.stats.totalFrames === 0) return 100;
    return Math.round((this.stats.focusedFrames / this.stats.totalFrames) * 100);
  }

  getAvgScore() {
    if (this.stats.totalFrames === 0) return 0;
    return Math.round(this.stats.scoreSum / this.stats.totalFrames);
  }

  /** 汇总本次会话健康报告数据 */
  buildReport(durationText, modeLabel) {
    const breakdown = ['SLOUCH', 'TOO_CLOSE', 'TILT', 'DROWSY', 'YAWN', 'DISTRACTED'].map((code) => ({
      code,
      label: ALERT_META[code].label,
      color: ALERT_META[code].color,
      count: this.stats.byType[code] || 0,
    }));

    const topIssue = [...breakdown].sort((a, b) => b.count - a.count)[0];
    const suggestions = [];

    if (this.stats.alertCount === 0) {
      suggestions.push('本次监测期间体态与专注表现非常优秀，请继续保持每学习 45 分钟起身活动 5 分钟的习惯。');
    } else {
      if (topIssue && topIssue.count > 0) {
        suggestions.push(`本次最高频问题为「${topIssue.label}」（共 ${topIssue.count} 次），建议优先针对该项进行习惯纠正。`);
      }
      if (this.stats.byType.SLOUCH > 0 || this.stats.byType.TOO_CLOSE > 0) {
        suggestions.push('建议将笔记本垫高使屏幕顶端与视线平齐，保持眼睛距屏幕 50–70 cm，减轻颈椎负荷。');
      }
      if (this.stats.byType.TILT > 0) {
        suggestions.push('检测到多次歪头现象，建议调整座椅高度并避免单手托腮，防止颈椎左右受力不均。');
      }
      if (this.stats.byType.DROWSY > 0 || this.stats.byType.YAWN > 0) {
        suggestions.push('检测到明显用眼或精神疲劳，建议执行“20-20-20 护眼法则”并补充水分或短暂小憩。');
      }
      if (this.stats.byType.DISTRACTED > 0) {
        suggestions.push('存在视线频繁偏离情况，建议开启番茄钟（25 分钟专注）并将手机移出视线范围。');
      }
    }
    if (suggestions.length < 2) {
      suggestions.push('保持环境光线柔和均匀，避免屏幕强反光引起视觉疲劳与不自觉前倾。');
    }

    return {
      generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      durationText,
      modeLabel,
      avgScore: this.getAvgScore() || Math.round(this.smooth.score),
      focusRate: this.getFocusRate(),
      alertCount: this.stats.alertCount,
      breakdown,
      suggestions,
    };
  }
}
