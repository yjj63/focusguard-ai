/**
 * FocusGuard AI 数据可视化与报告导出模块（v2.0 新增）
 * 纯原生 Canvas 实现实时专注度趋势折线图与 PNG 学习健康报告卡片导出，零外部依赖。
 */

export class FocusTrendChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.maxPoints = 60; // 保留最近 60 个采样点（约 60 秒）
    this.points = [];
  }

  reset() {
    this.points = [];
    this.draw();
  }

  push(score, level) {
    this.points.push({ score, level });
    if (this.points.length > this.maxPoints) {
      this.points.shift();
    }
    this.draw();
  }

  draw() {
    const canvas = this.canvas;
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(260, Math.floor(rect.width));
    const h = Math.max(120, Math.floor(rect.height));

    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const pad = { top: 14, right: 12, bottom: 20, left: 32 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    // 水平参考线（100, 80, 60, 20）
    const guides = [
      { v: 100, color: 'rgba(148,163,184,0.16)' },
      { v: 80, color: 'rgba(16,185,129,0.22)' },
      { v: 60, color: 'rgba(245,158,11,0.28)' },
      { v: 20, color: 'rgba(148,163,184,0.12)' },
    ];

    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    guides.forEach((g) => {
      const y = pad.top + plotH * (1 - g.v / 100);
      ctx.strokeStyle = g.color;
      ctx.setLineDash(g.v === 60 || g.v === 80 ? [4, 4] : []);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();

      ctx.fillStyle = '#64748b';
      ctx.fillText(String(g.v), pad.left - 6, y);
    });
    ctx.setLineDash([]);

    if (this.points.length < 2) {
      ctx.fillStyle = '#64748b';
      ctx.textAlign = 'center';
      ctx.font = '12px sans-serif';
      ctx.fillText('开始监测后实时绘制 60 秒专注度趋势…', pad.left + plotW / 2, pad.top + plotH / 2);
      ctx.restore();
      return;
    }

    // 计算坐标
    const coords = this.points.map((p, idx) => {
      const x = pad.left + (idx / (this.maxPoints - 1)) * plotW;
      const y = pad.top + plotH * (1 - Math.max(0, Math.min(100, p.score)) / 100);
      return { x, y, ...p };
    });

    // 面积渐变填充
    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
    grad.addColorStop(0, 'rgba(59, 130, 246, 0.35)');
    grad.addColorStop(1, 'rgba(59, 130, 246, 0.02)');

    ctx.beginPath();
    ctx.moveTo(coords[0].x, pad.top + plotH);
    coords.forEach((c) => ctx.lineTo(c.x, c.y));
    ctx.lineTo(coords[coords.length - 1].x, pad.top + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // 折线主体
    ctx.beginPath();
    coords.forEach((c, i) => (i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y)));
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 最新点高亮
    const last = coords[coords.length - 1];
    ctx.fillStyle = last.level === 'danger' ? '#ef4444' : last.level === 'warn' ? '#f59e0b' : '#10b981';
    ctx.beginPath();
    ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
    ctx.fill();

    // 底部时间说明
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'left';
    ctx.fillText('-60s', pad.left, h - 6);
    ctx.textAlign = 'right';
    ctx.fillText('实时', w - pad.right, h - 6);

    ctx.restore();
  }
}

/** 将本次学习报告渲染为高清 PNG 图片并触发下载 */
export function downloadReportPng(report) {
  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = 620;
  const ctx = canvas.getContext('2d');

  // 背景
  const bg = ctx.createLinearGradient(0, 0, 900, 620);
  bg.addColorStop(0, '#0f172a');
  bg.addColorStop(1, '#1e293b');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 900, 620);

  // 顶部标题栏
  ctx.fillStyle = '#38bdf8';
  ctx.font = 'bold 28px "Microsoft YaHei", sans-serif';
  ctx.fillText('FocusGuard AI · 学习专注度与坐姿健康报告', 44, 64);

  ctx.fillStyle = '#94a3b8';
  ctx.font = '14px "Microsoft YaHei", sans-serif';
  ctx.fillText(`生成时间：${report.generatedAt}   |   监测模式：${report.modeLabel}`, 44, 94);

  // 核心数据 4 卡片
  const cards = [
    { label: '监测总时长', val: report.durationText, color: '#38bdf8' },
    { label: '平均专注评分', val: `${report.avgScore} 分`, color: '#34d399' },
    { label: '专注保持率', val: `${report.focusRate}%`, color: '#a78bfa' },
    { label: '异常提醒总计', val: `${report.alertCount} 次`, color: '#fbbf24' },
  ];

  cards.forEach((c, i) => {
    const x = 44 + i * 206;
    const y = 124;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, x, y, 192, 102, 12);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#94a3b8';
    ctx.font = '14px "Microsoft YaHei", sans-serif';
    ctx.fillText(c.label, x + 18, y + 34);

    ctx.fillStyle = c.color;
    ctx.font = 'bold 28px "Microsoft YaHei", sans-serif';
    ctx.fillText(c.val, x + 18, y + 76);
  });

  // 异常分布统计
  ctx.fillStyle = '#e2e8f0';
  ctx.font = 'bold 18px "Microsoft YaHei", sans-serif';
  ctx.fillText('异常事件分类统计', 44, 270);

  const items = report.breakdown;
  items.forEach((item, idx) => {
    const col = idx % 2;
    const row = Math.floor(idx / 2);
    const x = 44 + col * 415;
    const y = 294 + row * 48;

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '14px "Microsoft YaHei", sans-serif';
    ctx.fillText(`${item.label}：${item.count} 次`, x, y + 14);

    ctx.fillStyle = 'rgba(148, 163, 184, 0.18)';
    roundRect(ctx, x, y + 22, 370, 10, 5);
    ctx.fill();

    const ratio = report.alertCount > 0 ? item.count / report.alertCount : 0;
    ctx.fillStyle = item.color;
    if (ratio > 0) {
      roundRect(ctx, x, y + 22, Math.max(12, 370 * ratio), 10, 5);
      ctx.fill();
    }
  });

  // AI 健康建议
  ctx.fillStyle = 'rgba(16, 185, 129, 0.12)';
  ctx.strokeStyle = 'rgba(16, 185, 129, 0.4)';
  roundRect(ctx, 44, 456, 812, 114, 12);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#34d399';
  ctx.font = 'bold 16px "Microsoft YaHei", sans-serif';
  ctx.fillText('AI 个性化护眼护颈建议', 64, 486);

  ctx.fillStyle = '#e2e8f0';
  ctx.font = '14px "Microsoft YaHei", sans-serif';
  report.suggestions.slice(0, 3).forEach((line, i) => {
    ctx.fillText(`• ${line}`, 64, 514 + i * 22);
  });

  // 页脚
  ctx.fillStyle = '#64748b';
  ctx.font = '12px sans-serif';
  ctx.fillText('FocusGuard AI v4.0 · 纯浏览器端本地视觉深度学习（MediaPipe FaceLandmarker）', 44, 598);

  const link = document.createElement('a');
  link.download = `FocusGuard_学习健康报告_${Date.now()}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
