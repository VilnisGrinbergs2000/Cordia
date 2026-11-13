// Shared by the settings card and the /insights page. The chart is 100 units
// wide whatever the window, so an index is a ratio and never a pixel count.
export function sparkPeak(series) {
  return Math.max(1, ...series.map((entry) => Number(entry.messages) || 0));
}

export function sparkX(series, index) {
  const step = series.length > 1 ? 100 / (series.length - 1) : 100;
  return (index * step).toFixed(1);
}

export function sparkY(series, index) {
  const value = Number(series[index]?.messages) || 0;
  return (27 - (value / sparkPeak(series)) * 25).toFixed(1);
}

export function sparkPoints(series) {
  return series.map((_, index) => `${sparkX(series, index)},${sparkY(series, index)}`).join(' ');
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function shortDay(day) {
  const [year, month, date] = String(day).split('-').map(Number);
  if (!year || !month || !date) return String(day);
  return `${SHORT_MONTHS[month - 1]} ${date}`;
}

export function sinceLabel(timestamp) {
  const minutes = Math.floor((Date.now() - Number(timestamp)) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function deltaLabel(now, before) {
  const diff = (Number(now) || 0) - (Number(before) || 0);
  if (diff === 0) return 'same as before';
  return `${diff > 0 ? '+' : '-'}${Math.abs(diff)} vs before`;
}
