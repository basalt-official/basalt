/** Shared marketplace thumbnails — screenshot first, else SVG from texture JSON. */
(function (root) {
  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildPlaceholderPreview(name, type) {
    const label = esc((name || 'Skin').slice(0, 28));
    const t = String(type || 'component').toLowerCase();
    const accent = t === 'animation' ? '#9cb4ff' : t === 'style' ? '#c8a8ff' : '#ff6a3d';
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0%" stop-color="#1a1a1f"/><stop offset="100%" stop-color="#0a0a0a"/></linearGradient></defs>' +
      '<rect width="320" height="200" fill="url(#g)"/>' +
      '<rect x="24" y="24" width="272" height="152" rx="14" fill="' + accent + '" fill-opacity="0.18" stroke="' + accent + '" stroke-opacity="0.35"/>' +
      '<text x="160" y="108" text-anchor="middle" fill="#f2f2f0" font-family="system-ui,sans-serif" font-size="15" font-weight="600">' +
      label +
      '</text></svg>';
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  function buildNeedsScreenshotPreview(name) {
    const label = esc((name || 'Listing').slice(0, 22));
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">' +
      '<rect width="320" height="200" fill="#121214"/>' +
      '<rect x="24" y="24" width="272" height="152" rx="8" fill="none" stroke="#ff6a3d" stroke-opacity="0.45" stroke-dasharray="6 5"/>' +
      '<text x="160" y="96" text-anchor="middle" fill="#f2f2f0" font-family="system-ui,sans-serif" font-size="14" font-weight="600">' +
      label +
      '</text>' +
      '<text x="160" y="120" text-anchor="middle" fill="#8a8a86" font-family="system-ui,sans-serif" font-size="12">' +
      'Screenshot required' +
      '</text></svg>';
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  function extractColors(t) {
    const out = [];
    if (Array.isArray(t.colors)) {
      t.colors.forEach((c) => {
        if (typeof c === 'string') out.push(c);
        else if (c && typeof c.color === 'string') out.push(c.color);
      });
    }
    if (t.backgroundGradient && Array.isArray(t.backgroundGradient.colors)) {
      t.backgroundGradient.colors.forEach((c) => {
        if (typeof c === 'string') out.push(c);
      });
    }
    ['labelColor', 'depthBase', 'depthTop', 'blurFill', 'strokeColor', 'fill', 'background', 'tint'].forEach((k) => {
      if (typeof t[k] === 'string' && t[k].trim()) out.push(t[k]);
    });
    if (t.glow && typeof t.glow.color === 'string') out.push(t.glow.color);
    if (t.border) {
      if (typeof t.border.color === 'string') out.push(t.border.color);
      if (typeof t.border.strokeColor === 'string') out.push(t.border.strokeColor);
    }
    return out.filter(Boolean);
  }

  /** Returns { ok:true, url } or { ok:false, reason }. Never invents a fake “looks fine” thumb. */
  function tryBuildPreviewFromTexture(jsonText, displayName) {
    try {
      const t = JSON.parse(jsonText);
      if (!t || typeof t !== 'object' || Array.isArray(t)) {
        return { ok: false, reason: 'not_object' };
      }
      if (typeof t.renderer !== 'string' || !t.renderer.trim()) {
        return { ok: false, reason: 'no_renderer' };
      }
      const colors = extractColors(t);
      if (!colors.length) {
        return { ok: false, reason: 'no_visual' };
      }

      const label = esc((displayName || t.id || 'skin').slice(0, 28));
      const c1 = colors[0] || '#3a3a3c';
      const c2 = colors[colors.length - 1] || '#0a0a0a';
      const accent = (typeof t.labelColor === 'string' && t.labelColor) || colors[0] || '#ff6a3d';
      const renderer = esc(t.renderer || 'texture');
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">' +
        '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0%" stop-color="' + esc(c1) + '"/>' +
        '<stop offset="100%" stop-color="' + esc(c2) + '"/></linearGradient></defs>' +
        '<rect width="320" height="200" fill="url(#g)"/>' +
        '<rect x="40" y="70" width="240" height="60" rx="12" fill="' + esc(accent) + '" fill-opacity="0.22" stroke="#fff" stroke-opacity="0.25"/>' +
        '<text x="160" y="92" text-anchor="middle" fill="#fff" fill-opacity="0.55" font-family="ui-monospace,monospace" font-size="10">' +
        renderer +
        '</text>' +
        '<text x="160" y="112" text-anchor="middle" fill="#f5f5f7" font-family="system-ui,sans-serif" font-size="14" font-weight="600">' +
        label +
        '</text></svg>';
      return { ok: true, url: 'data:image/svg+xml,' + encodeURIComponent(svg) };
    } catch (_) {
      return { ok: false, reason: 'invalid_json' };
    }
  }

  /** @deprecated prefer tryBuildPreviewFromTexture — returns null when preview can't be built */
  function buildPreviewFromTexture(jsonText, displayName) {
    const r = tryBuildPreviewFromTexture(jsonText, displayName);
    return r.ok ? r.url : null;
  }

  function previewForItem(item) {
    if (item && item.preview_url) return item.preview_url;
    if (item && item._texturePreview) return item._texturePreview;
    if (item && item._needsScreenshot) return buildNeedsScreenshotPreview(item.name);
    return buildPlaceholderPreview(item && item.name, item && item.type);
  }

  const SCREENSHOT_REQUIRED_MSG =
    "We couldn't auto-generate a thumbnail from your .json (no colors / visual fields we can preview). Upload a screenshot PNG/JPG of the skin in Basalt, then submit again.";

  root.BasaltMarketPreview = {
    buildPlaceholderPreview,
    buildNeedsScreenshotPreview,
    buildPreviewFromTexture,
    tryBuildPreviewFromTexture,
    previewForItem,
    SCREENSHOT_REQUIRED_MSG,
  };
})(typeof window !== 'undefined' ? window : globalThis);
