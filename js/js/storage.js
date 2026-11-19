/**
 * FocusGuard AI 本地历史学习档案模块（v3.0 新增）
 * 基于浏览器 localStorage 持久化最近 12 次学习记录，纯本地存储保护隐私。
 */

const STORAGE_KEY = 'focusguard_history_v3';
const MAX_RECORDS = 12;

export function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveHistoryRecord(report) {
  const list = loadHistory();
  const topIssue = [...report.breakdown].sort((a, b) => b.count - a.count)[0];
  const record = {
    id: Date.now(),
    time: report.generatedAt,
    duration: report.durationText,
    avgScore: report.avgScore,
    focusRate: report.focusRate,
    alertCount: report.alertCount,
    topIssue: topIssue && topIssue.count > 0 ? topIssue.label : '无明显异常',
    mode: report.modeLabel,
  };
  list.unshift(record);
  const trimmed = list.slice(0, MAX_RECORDS);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // 存储空间不足时静默忽略
  }
  return trimmed;
}

export function clearHistory() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 忽略
  }
  return [];
}
