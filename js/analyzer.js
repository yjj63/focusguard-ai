/**
 * FocusGuard AI 核心视觉姿态与专注度分析模块（v2.0）
 * 新增：可配置算法灵敏度阈值、分类异常统计、会话健康报告生成
 */

export const PRESET_THRESHOLDS = {
  relaxed: {
    label: '宽松',
    pitchDeg: 18,
    yawDeg: 20,
    rollDeg: 14,
    gazeTh: 0.62,
    scaleRatio: 1.36,
    drowsyMs: 1600,
    postureMs: 1600,
  },
  standard: {
    label: '标准',
    pitchDeg: 14,
    yawDeg: 15,
    rollDeg: 10,
    gazeTh: 0.48,
    scaleRatio: 1.28,
    drowsyMs: 1200,
    postureMs: 1000,
  },
  strict: {
    label: '严格',
    pitchDeg: 10,
    yawDeg: 11,
    rollDeg: 7,
    gazeTh: 0.36,
    scaleRatio: 1.2,
    drowsyMs: 900,
    postureMs: 800,
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

    this.baseline = {
      calibrated: false,
      pitch: 0,
      yaw: 0,
      roll: 0,
      faceScale: 0.28,
      faceCenterY: 0.48,
    };

    this.smooth = {
      pitch: 0,
      yaw: 0,
      roll: 0,
      blink: 0,
      yawn: 0,
      gazeSide: 0,
      faceScale: 0.28,
      faceCenterY: 0.48,
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

    this.lastTimestamp = null;
    this.lastRawFeatures = null;
    this.resetStats();
  }

  /** 更新灵敏度配置 */
  setConfig(partial) {
    this.config = { ...this.config, ...partial };
  }

  resetStats() {
    Object.keys(this.timers).forEach((k) => (this.timers[k] = 0));
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
    this.smooth.score = 95;
    this.lastTimestamp = null;
  }

  /** 记录一次已触发的冷却后告警 */
  recordAlert(code) {
    this.stats.alertCount += 1;
    if (code && this.stats.byType[code] !== undefined) {
      this.stats.byType[code] += 1;
    }
  }

  calibrateCurrent() {
    if (!this.lastRawFeatures) return false;
    this.baseline = {
      calibrated: true,
      pitch: this.smooth.pitch,
      yaw: this.smooth.yaw,
      roll: this.smooth.roll,
      faceScale: this.smooth.faceScale,
      faceCenterY: this.smooth.faceCenterY,
    };
    return true;
  }

  extractEulerFromMatrix(matrixData) {
    if (!matrixData || matrixData.length < 16) {
      return { pitch: 0, yaw: 0, roll: 0 };
    }
    const r00 = matrixData[0], r01 = matrixData[4], r02 = matrixData[8];
    const r10 = matrixData[1], r11 = matrixData[5], r12 = matrixData[9];
    const r20 = matrixData[2], r21 = matrixData[6], r22 = matrixData[10];

    const sy = Math.sqrt(r00 * r00 + r10 * r10);
    let pitchRad, yawRad, rollRad;

    if (sy > 1e-6) {
      pitchRad = Math.atan2(r21, r22);
      yawRad = Math.atan2(-r20, sy);
      rollRad = Math.atan2(r10, r00);
    } else {
      pitchRad = Math.atan2(-r12, r11);
      yawRad = Math.atan2(-r20, sy);
      rollRad = 0;
    }

    const rad2deg = 180 / Math.PI;
    return {
      pitch: -pitchRad * rad2deg,
      yaw: yawRad * rad2deg,
      roll: rollRad * rad2deg,
    };
  }

  extractFromMediaPipe(result) {
    if (!result || !result.faceLandmarks || result.faceLandmarks.length === 0) {
      return null;
    }
    const landmarks = result.faceLandmarks[0];
    let minY = 1, maxY = 0;
    for (let i = 0; i < landmarks.length; i++) {
      const y = landmarks[i].y;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const faceScale = Math.max(0.05, Math.min(0.95, maxY - minY));
    const faceCenterY = (minY + maxY) / 2;

    let euler = { pitch: 0, yaw: 0, roll: 0 };
    if (result.facialTransformationMatrixes && result.facialTransformationMatrixes.length > 0) {
      euler = this.extractEulerFromMatrix(result.facialTransformationMatrixes[0].data);
    }

    // 结合左右眼外眼角（33 / 263）连线计算 2D 歪头角，提升手机竖屏下 Roll 的稳定性
    let eyeRoll = euler.roll;
    if (landmarks[33] && landmarks[263]) {
      const dx = landmarks[263].x - landmarks[33].x;
      const dy = landmarks[263].y - landmarks[33].y;
      eyeRoll = Math.atan2(dy, dx) * (180 / Math.PI);
    }

    let eyeBlinkLeft = 0, eyeBlinkRight = 0, jawOpen = 0;
    let lookOutL = 0, lookInL = 0, lookOutR = 0, lookInR = 0;
    if (result.faceBlendshapes && result.faceBlendshapes.length > 0) {
      const categories = result.faceBlendshapes[0].categories;
      for (const c of categories) {
        if (c.categoryName === 'eyeBlinkLeft') eyeBlinkLeft = c.score;
        else if (c.categoryName === 'eyeBlinkRight') eyeBlinkRight = c.score;
        else if (c.categoryName === 'jawOpen') jawOpen = c.score;
        else if (c.categoryName === 'eyeLookOutLeft') lookOutL = c.score;
        else if (c.categoryName === 'eyeLookInLeft') lookInL = c.score;
        else if (c.categoryName === 'eyeLookOutRight') lookOutR = c.score;
        else if (c.categoryName === 'eyeLookInRight') lookInR = c.score;
      }
    }

    // 眼球左右斜视强度（融合双眼视线偏移，捕捉“头不动但眼斜视走神”）
    const gazeLeft = (lookOutL + lookInR) / 2;
    const gazeRight = (lookOutR + lookInL) / 2;
    const gazeSide = Math.max(gazeLeft, gazeRight);

    return {
      pitch: euler.pitch,
      yaw: euler.yaw,
      roll: (euler.roll + eyeRoll) / 2,
      blink: (eyeBlinkLeft + eyeBlinkRight) / 2,
      yawn: jawOpen,
      gazeSide,
      faceScale,
      faceCenterY,
    };
  }

  update(rawFeatures, timestampMs) {
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
        metrics: { ...this.smooth, scaleRatio: 1 },
        score: Math.round(this.smooth.score),
        level: isAbsent ? 'warn' : 'good',
        statusText: isAbsent ? '未检测到人脸（可能离开座位）' : '正在重新定位人脸…',
        alertCode: isAbsent ? 'ABSENT' : null,
        focusRate: this.getFocusRate(),
      };
    }

    this.timers.absentMs = 0;
    this.lastRawFeatures = rawFeatures;

    const alpha = 0.25;
    this.smooth.pitch = this.smooth.pitch * (1 - alpha) + rawFeatures.pitch * alpha;
    this.smooth.yaw = this.smooth.yaw * (1 - alpha) + rawFeatures.yaw * alpha;
    this.smooth.roll = this.smooth.roll * (1 - alpha) + rawFeatures.roll * alpha;
    this.smooth.blink = this.smooth.blink * 0.55 + rawFeatures.blink * 0.45;
    this.smooth.yawn = this.smooth.yawn * 0.65 + rawFeatures.yawn * 0.35;
    this.smooth.gazeSide = this.smooth.gazeSide * 0.6 + (rawFeatures.gazeSide || 0) * 0.4;
    this.smooth.faceScale = this.smooth.faceScale * (1 - alpha) + rawFeatures.faceScale * alpha;
    this.smooth.faceCenterY = this.smooth.faceCenterY * (1 - alpha) + rawFeatures.faceCenterY * alpha;

    const dPitch = this.smooth.pitch - this.baseline.pitch;
    const dYaw = Math.abs(this.smooth.yaw - this.baseline.yaw);
    const dRoll = Math.abs(this.smooth.roll - this.baseline.roll);
    const scaleRatio = this.smooth.faceScale / Math.max(0.1, this.baseline.faceScale);
    const dCenterY = this.smooth.faceCenterY - this.baseline.faceCenterY;

    const cfg = this.config;
    this.timers.drowsyMs = this.smooth.blink > 0.58 ? this.timers.drowsyMs + dt : Math.max(0, this.timers.drowsyMs - dt * 2);
    this.timers.yawnMs = this.smooth.yawn > 0.55 ? this.timers.yawnMs + dt : Math.max(0, this.timers.yawnMs - dt * 2);
    this.timers.slouchMs = (dPitch > cfg.pitchDeg || dCenterY > 0.11) ? this.timers.slouchMs + dt : Math.max(0, this.timers.slouchMs - dt * 2);
    this.timers.tooCloseMs = scaleRatio > cfg.scaleRatio ? this.timers.tooCloseMs + dt : Math.max(0, this.timers.tooCloseMs - dt * 2);
    this.timers.tiltMs = dRoll > cfg.rollDeg ? this.timers.tiltMs + dt : Math.max(0, this.timers.tiltMs - dt * 2);
    // 视线走神判定：头部偏航 OR 眼球明显斜视（头未大转但眼已离屏）
    const isGazeOff = dYaw > cfg.yawDeg || this.smooth.gazeSide > (cfg.gazeTh || 0.48);
    this.timers.distractedMs = isGazeOff ? this.timers.distractedMs + dt : Math.max(0, this.timers.distractedMs - dt * 2);

    let targetScore = 100;
    targetScore -= Math.max(0, dPitch - cfg.pitchDeg * 0.55) * 1.45;
    targetScore -= Math.max(0, dYaw - cfg.yawDeg * 0.55) * 1.3;
    targetScore -= Math.max(0, dRoll - cfg.rollDeg * 0.6) * 1.1;
    if (scaleRatio > cfg.scaleRatio - 0.12) targetScore -= (scaleRatio - (cfg.scaleRatio - 0.12)) * 95;
    if (this.smooth.blink > 0.5) targetScore -= (this.smooth.blink - 0.5) * 80;
    if (this.smooth.yawn > 0.45) targetScore -= (this.smooth.yawn - 0.45) * 45;
    targetScore = Math.max(15, Math.min(100, targetScore));

    this.smooth.score = this.smooth.score * 0.9 + targetScore * 0.1;
    this.stats.scoreSum += this.smooth.score;

    let level = 'good';
    let statusText = '专注良好 · 坐姿端正';
    let alertCode = null;

    if (this.timers.drowsyMs > cfg.drowsyMs) {
      level = 'danger';
      statusText = '检测到持续闭眼：疑似疲劳打瞌睡！';
      alertCode = 'DROWSY';
    } else if (this.timers.yawnMs > 1100) {
      level = 'warn';
      statusText = '检测到打哈欠：注意适当休息';
      alertCode = 'YAWN';
    } else if (this.timers.tooCloseMs > cfg.postureMs) {
      level = 'danger';
      statusText = '距离屏幕过近：请向后保持合理视距';
      alertCode = 'TOO_CLOSE';
    } else if (this.timers.slouchMs > cfg.postureMs) {
      level = 'warn';
      statusText = '检测到低头驼背：请抬头挺胸';
      alertCode = 'SLOUCH';
    } else if (this.timers.tiltMs > cfg.postureMs + 100) {
      level = 'warn';
      statusText = '检测到明显歪头：请摆正颈椎';
      alertCode = 'TILT';
    } else if (this.timers.distractedMs > cfg.postureMs + 100) {
      level = 'warn';
      statusText = '视线偏离屏幕：请保持学习专注';
      alertCode = 'DISTRACTED';
    }

    if (level === 'good') {
      this.stats.focusedFrames += 1;
    }

    return {
      hasFace: true,
      metrics: {
        pitch: dPitch,
        yaw: this.smooth.yaw - this.baseline.yaw,
        roll: this.smooth.roll - this.baseline.roll,
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
