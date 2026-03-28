let _cache = null;

export function themeColors() {
  if (_cache) return _cache;
  const s = getComputedStyle(document.documentElement);
  const v = (name) => s.getPropertyValue(name).trim();
  _cache = {
    void: v('--void'),
    voidPanel: v('--void-panel'),
    accent: v('--nerv-orange'),
    accentHot: v('--nerv-orange-hot'),
    wire: v('--wire-cyan'),
    wireDim: v('--wire-cyan-dim'),
    thermal: v('--thermal-yellow'),
    dataGreen: v('--data-green'),
  };
  return _cache;
}

export function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function invalidateThemeCache() { _cache = null; }
