/**
 * 无摄像头模拟演示引擎
 * 用于在无摄像头设备（如台式机评阅环境）上完整展示 AI 视觉关键点、
 * 姿态几何变化、专注度评分与告警系统联动效果。
 */

const SCENARIOS = {
  normal: {
    label: '标准专注',
    pitch: 2,
    yaw: 0,
    roll: 0,
    blink: 0.08,
    yawn: 0.04,
    faceScale: 0.28,
    faceCenterY: 0.48,
  },
  slouch: {
    label: '低头驼背',
    pitch: 24,
    yaw: 2,
    roll: 4,
    blink: 0.14,
    yawn: 0.05,
    faceScale: 0.31,
    faceCenterY: 0.62,
  },
  too_close: {
    label: '离屏过近',
    pitch: 9,
    yaw: 0,
    roll: -2,
    blink: 0.1,
    yawn: 0.04,
    faceScale: 0.42,
    faceCenterY: 0.51,
  },
  drowsy: {
    label: '疲劳闭眼',
    pitch: 12,
    yaw: -3,
    roll: 6,
    blink: 0.85,
    yawn: 0.22,
    faceScale: 0.29,
    faceCenterY: 0.53,
  },
  distracted: {
    label: '左右走神',
    pitch: 3,
    yaw: 32,
    roll: -5,
    blink: 0.12,
    yawn: 0.05,
    faceScale: 0.27,
    faceCenterY: 0.49,
  },
};

export class DemoSimulator {
  constructor() {
    this.scenarioKey = 'normal';
    this.current = { ...SCENARIOS.normal };
  }

  setScenario(key) {
    if (SCENARIOS[key]) {
      this.scenarioKey = key;
    }
  }

  /** 生成带自然微动噪声的模拟特征帧 */
  step(timestampMs) {
    const target = SCENARIOS[this.scenarioKey];
    const t = timestampMs * 0.002;
    const lerp = 0.08;

    this.current.pitch += (target.pitch - this.current.pitch) * lerp;
    this.current.yaw += (target.yaw - this.current.yaw) * lerp;
    this.current.roll += (target.roll - this.current.roll) * lerp;
    this.current.blink += (target.blink - this.current.blink) * lerp;
    this.current.yawn += (target.yawn - this.current.yawn) * lerp;
    this.current.faceScale += (target.faceScale - this.current.faceScale) * lerp;
    this.current.faceCenterY += (target.faceCenterY - this.current.faceCenterY) * lerp;

    // 模拟自然呼吸微动与周期性眨眼
    const naturalBlink = Math.sin(t * 1.7) > 0.96 ? 0.45 : 0;

    return {
      pitch: this.current.pitch + Math.sin(t) * 1.1,
      yaw: this.current.yaw + Math.cos(t * 0.8) * 1.4,
      roll: this.current.roll + Math.sin(t * 0.6) * 0.8,
      blink: Math.min(1, this.current.blink + naturalBlink),
      yawn: this.current.yawn,
      faceScale: this.current.faceScale + Math.sin(t * 0.7) * 0.004,
      faceCenterY: this.current.faceCenterY + Math.sin(t * 0.7) * 0.004,
    };
  }

  /** 在画布上绘制科技感模拟人脸网格与关键点 */
  render(ctx, width, height, features, showMesh, level) {
    ctx.clearRect(0, 0, width, height);

    // 深色背景网格
    ctx.fillStyle = '#070d1c';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(59, 130, 246, 0.09)';
    ctx.lineWidth = 1;
    const step = 36;
    for (let x = 0; x < width; x += step) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let y = 0; y < height; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }

    const cx = width * 0.5 + (features.yaw / 45) * width * 0.08;
    const cy = height * features.faceCenterY;
    const radiusY = (height * features.faceScale) * 0.52;
    const radiusX = radiusY * 0.76;

    const accent = level === 'danger' ? '#ef4444' : level === 'warn' ? '#f59e0b' : '#10b981';

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((features.roll * Math.PI) / 180);

    // 头部轮廓
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.ellipse(0, 0, radiusX, radiusY, 0, 0, Math.PI * 2);
    ctx.stroke();

    // 3D 朝向偏移量
    const lookX = (features.yaw / 35) * radiusX * 0.35;
    const lookY = (features.pitch / 30) * radiusY * 0.28;

    // 绘制模拟面部网格线
    if (showMesh) {
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.32)';
      ctx.lineWidth = 1;
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(i * radiusX * 0.3 + lookX * 0.4, -radiusY * 0.85);
        ctx.quadraticCurveTo(i * radiusX * 0.36 + lookX, 0, i * radiusX * 0.25 + lookX * 0.4, radiusY * 0.85);
        ctx.stroke();
      }
      for (let j = -2; j <= 2; j++) {
        ctx.beginPath();
        ctx.moveTo(-radiusX * 0.85, j * radiusY * 0.3 + lookY * 0.4);
        ctx.quadraticCurveTo(0, j * radiusY * 0.34 + lookY, radiusX * 0.85, j * radiusY * 0.3 + lookY * 0.4);
        ctx.stroke();
      }
    }

    // 双眼（随 blink 闭合）
    const eyeOpen = Math.max(1.5, (1 - features.blink) * radiusY * 0.13);
    const eyeY = -radiusY * 0.16 + lookY;
    const eyeOffsetX = radiusX * 0.36;

    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 2.2;
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.ellipse(side * eyeOffsetX + lookX, eyeY, radiusX * 0.16, eyeOpen, 0, 0, Math.PI * 2);
      ctx.stroke();
    });

    // 鼻梁与方向向量
    ctx.strokeStyle = '#38bdf8';
    ctx.beginPath();
    ctx.moveTo(lookX * 0.8, eyeY);
    ctx.lineTo(lookX * 1.15, radiusY * 0.14 + lookY);
    ctx.stroke();

    // 嘴部（随 yawn 张开）
    const mouthH = Math.max(2, features.yawn * radiusY * 0.26);
    ctx.strokeStyle = '#f8fafc';
    ctx.beginPath();
    ctx.ellipse(lookX * 0.9, radiusY * 0.42 + lookY, radiusX * 0.24, mouthH, 0, 0, Math.PI * 2);
    ctx.stroke();

    // 关键点高亮
    if (showMesh) {
      ctx.fillStyle = accent;
      const pts = [
        [-eyeOffsetX + lookX, eyeY],
        [eyeOffsetX + lookX, eyeY],
        [lookX * 1.15, radiusY * 0.14 + lookY],
        [lookX * 0.9, radiusY * 0.42 + lookY],
        [0, -radiusY],
        [0, radiusY],
      ];
      pts.forEach(([px, py]) => {
        ctx.beginPath();
        ctx.arc(px, py, 3.2, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    ctx.restore();

    // 右下角演示水印
    ctx.fillStyle = 'rgba(148, 163, 184, 0.75)';
    ctx.font = '12px sans-serif';
    ctx.fillText(`模拟演示模式 · 当前预设：${SCENARIOS[this.scenarioKey].label}`, 16, height - 16);
  }
}
