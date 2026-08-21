// Basalt Library shader preview.
//
// Procedural SkSL is compiled by the same Skia RuntimeEffect engine used by
// Basalt's native renderer. CanvasKit is loaded only after an artist selects a
// shader, so the rest of the submission form stays light. Non-shader packs and
// optical child shaders retain a deterministic 2D catalog fallback.
(function () {
  const SCREENSHOT_REQUIRED_MSG =
    "Upload a screenshot because Basalt couldn't build a safe preview from this file."
  const CANVASKIT_VERSION = '0.41.1'
  const CANVASKIT_LOCAL_BASE = 'vendor/canvaskit/'
  const CANVASKIT_CDN_BASE =
    'https://cdn.jsdelivr.net/npm/canvaskit-wasm@' + CANVASKIT_VERSION + '/bin/'
  const CANVASKIT_TIMEOUT_MS = 12000

  let canvasKitPromise = null
  let preferredCanvasKitBase = null
  let mounted = null
  let previewGeneration = 0
  const catalogRenderers = new Map()
  let catalogObserver = null
  let catalogFrameId = 0

  function color(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback
  }

  function messageFrom(error) {
    return error instanceof Error ? error.message : String(error || 'Unknown preview error')
  }

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  /** Catalog grid placeholder when a listing has no screenshot / texture thumb. */
  function buildPlaceholderPreview(name, type) {
    const label = esc((name || 'Skin').slice(0, 28))
    const t = String(type || 'component').toLowerCase()
    const accent = t === 'animation' ? '#9cb4ff' : t === 'style' ? '#c8a8ff' : '#ff6a3d'
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0%" stop-color="#1a1a1f"/><stop offset="100%" stop-color="#0a0a0a"/></linearGradient></defs>' +
      '<rect width="320" height="200" fill="url(#g)"/>' +
      '<rect x="24" y="24" width="272" height="152" rx="14" fill="' +
      accent +
      '" fill-opacity="0.18" stroke="' +
      accent +
      '" stroke-opacity="0.35"/>' +
      '<text x="160" y="108" text-anchor="middle" fill="#f2f2f0" font-family="system-ui,sans-serif" font-size="15" font-weight="600">' +
      label +
      '</text></svg>'
    return 'data:image/svg+xml,' + encodeURIComponent(svg)
  }

  function buildNeedsScreenshotPreview(name) {
    const label = esc((name || 'Listing').slice(0, 22))
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">' +
      '<rect width="320" height="200" fill="#121214"/>' +
      '<rect x="24" y="24" width="272" height="152" rx="8" fill="none" stroke="#ff6a3d" stroke-opacity="0.45" stroke-dasharray="6 5"/>' +
      '<text x="160" y="96" text-anchor="middle" fill="#f2f2f0" font-family="system-ui,sans-serif" font-size="14" font-weight="600">' +
      label +
      '</text>' +
      '<text x="160" y="120" text-anchor="middle" fill="#8a8a86" font-family="system-ui,sans-serif" font-size="12">' +
      'Screenshot required' +
      '</text></svg>'
    return 'data:image/svg+xml,' + encodeURIComponent(svg)
  }

  function extractColors(t) {
    const out = []
    if (Array.isArray(t.colors)) {
      t.colors.forEach(function (c) {
        if (typeof c === 'string') out.push(c)
        else if (c && typeof c.color === 'string') out.push(c.color)
      })
    }
    if (t.backgroundGradient && Array.isArray(t.backgroundGradient.colors)) {
      t.backgroundGradient.colors.forEach(function (c) {
        if (typeof c === 'string') out.push(c)
      })
    }
    ;['labelColor', 'depthBase', 'depthTop', 'blurFill', 'strokeColor', 'fill', 'background', 'tint'].forEach(
      function (k) {
        if (typeof t[k] === 'string' && t[k].trim()) out.push(t[k])
      }
    )
    if (t.glow && typeof t.glow.color === 'string') out.push(t.glow.color)
    if (t.border) {
      if (typeof t.border.color === 'string') out.push(t.border.color)
      if (typeof t.border.strokeColor === 'string') out.push(t.border.strokeColor)
    }
    return out.filter(Boolean)
  }

  /**
   * SYNC catalog/submit thumbnail helper (marketplace.html + submit gate).
   * Returns { ok:true, url } or { ok:false, reason }. Must stay sync — the catalog
   * does not await this. Codex briefly replaced this with an async CanvasKit path
   * and dropped previewForItem, which broke the marketplace grid contract.
   */
  function tryBuildPreviewFromTexture(jsonText, displayName) {
    try {
      const t = JSON.parse(jsonText)
      if (!t || typeof t !== 'object' || Array.isArray(t)) {
        return { ok: false, reason: 'not_object' }
      }
      if (typeof t.renderer !== 'string' || !t.renderer.trim()) {
        return { ok: false, reason: 'no_renderer' }
      }
      const colors = extractColors(t)
      if (!colors.length) {
        return { ok: false, reason: 'no_visual' }
      }

      const label = esc((displayName || t.id || 'skin').slice(0, 28))
      const c1 = colors[0] || '#3a3a3c'
      const c2 = colors[colors.length - 1] || '#0a0a0a'
      const accent = (typeof t.labelColor === 'string' && t.labelColor) || colors[0] || '#ff6a3d'
      const renderer = esc(t.renderer || 'texture')
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">' +
        '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0%" stop-color="' +
        esc(c1) +
        '"/>' +
        '<stop offset="100%" stop-color="' +
        esc(c2) +
        '"/></linearGradient></defs>' +
        '<rect width="320" height="200" fill="url(#g)"/>' +
        '<rect x="40" y="70" width="240" height="60" rx="12" fill="' +
        esc(accent) +
        '" fill-opacity="0.22" stroke="#fff" stroke-opacity="0.25"/>' +
        '<text x="160" y="92" text-anchor="middle" fill="#fff" fill-opacity="0.55" font-family="ui-monospace,monospace" font-size="10">' +
        renderer +
        '</text>' +
        '<text x="160" y="112" text-anchor="middle" fill="#f5f5f7" font-family="system-ui,sans-serif" font-size="14" font-weight="600">' +
        label +
        '</text></svg>'
      return { ok: true, url: 'data:image/svg+xml,' + encodeURIComponent(svg) }
    } catch (_) {
      return { ok: false, reason: 'invalid_json' }
    }
  }

  function buildPreviewFromTexture(jsonText, displayName) {
    const r = tryBuildPreviewFromTexture(jsonText, displayName)
    return r.ok ? r.url : null
  }

  function previewForItem(item) {
    if (item && item.preview_url) return item.preview_url
    if (item && item._texturePreview) return item._texturePreview
    if (item && item._needsScreenshot) return buildNeedsScreenshotPreview(item.name)
    return buildPlaceholderPreview(item && item.name, item && item.type)
  }

  function roundedRect(ctx, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2))
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + width, y, x + width, y + height, r)
    ctx.arcTo(x + width, y + height, x, y + height, r)
    ctx.arcTo(x, y + height, x, y, r)
    ctx.arcTo(x, y, x + width, y, r)
    ctx.closePath()
  }

  function parseTexture(rawText) {
    let texture
    try {
      texture = JSON.parse(rawText)
    } catch (error) {
      return { ok: false, error: messageFrom(error) }
    }
    if (!texture || typeof texture !== 'object' || Array.isArray(texture)) {
      return { ok: false, error: 'Texture must be a JSON object.' }
    }
    return { ok: true, texture }
  }

  function buildFallbackPreview(texture, itemName) {
    try {
      const canvas = document.createElement('canvas')
      canvas.width = 960
      canvas.height = 600
      const ctx = canvas.getContext('2d')
      if (!ctx) return { ok: false, error: 'Canvas is unavailable.' }

      const bg = ctx.createLinearGradient(0, 0, 960, 600)
      bg.addColorStop(0, '#07101f')
      bg.addColorStop(0.55, '#14213a')
      bg.addColorStop(1, '#05070c')
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, 960, 600)

      ctx.fillStyle = 'rgba(81,146,255,0.22)'
      ctx.beginPath()
      ctx.arc(760, 110, 190, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = 'rgba(182,112,255,0.18)'
      ctx.beginPath()
      ctx.arc(170, 520, 230, 0, Math.PI * 2)
      ctx.fill()

      const target = texture.target === 'panel' ? 'panel' : 'button'
      const x = target === 'panel' ? 150 : 245
      const y = target === 'panel' ? 125 : 205
      const width = target === 'panel' ? 660 : 470
      const height = target === 'panel' ? 350 : 190
      const radius = target === 'panel' ? 42 : 70
      roundedRect(ctx, x, y, width, height, radius)

      if (texture.renderer === 'gradient' && Array.isArray(texture.colors) && texture.colors.length >= 2) {
        const gradient = ctx.createLinearGradient(x, y, x + width, y + height)
        texture.colors.forEach(function (entry, index) {
          const position = Array.isArray(texture.positions) && Number.isFinite(texture.positions[index])
            ? Math.max(0, Math.min(1, texture.positions[index]))
            : index / Math.max(1, texture.colors.length - 1)
          gradient.addColorStop(position, color(entry, '#315b9f'))
        })
        ctx.fillStyle = gradient
      } else {
        const glass = ctx.createLinearGradient(x, y, x + width, y + height)
        glass.addColorStop(0, 'rgba(236,247,255,0.32)')
        glass.addColorStop(0.42, 'rgba(96,153,220,0.18)')
        glass.addColorStop(1, 'rgba(10,24,44,0.34)')
        ctx.fillStyle = glass
      }
      ctx.fill()

      ctx.lineWidth = Number(texture.strokeWidth || texture.border?.width || 2)
      ctx.strokeStyle = color(texture.strokeColor || texture.border?.color, 'rgba(226,240,255,0.72)')
      ctx.stroke()

      const title = String(itemName || texture.id || 'Basalt texture').trim().slice(0, 56)
      ctx.fillStyle = color(texture.labelColor, '#ffffff')
      ctx.font = '700 38px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(title, x + width / 2, y + height / 2 - 8, width - 70)
      ctx.fillStyle = 'rgba(232,241,255,0.72)'
      ctx.font = '500 20px ui-monospace, SFMono-Regular, monospace'
      ctx.fillText(String(texture.renderer || 'texture'), x + width / 2, y + height / 2 + 42)

      return { ok: true, url: canvas.toDataURL('image/png'), rendered: 'fallback' }
    } catch (error) {
      return { ok: false, error: messageFrom(error) }
    }
  }

  function canvasKitAssetUrl(base, name) {
    return new URL(name, new URL(base, document.baseURI)).href
  }

  function withTimeout(promise, milliseconds, message) {
    return new Promise(function (resolve, reject) {
      let settled = false
      const timer = setTimeout(function () {
        if (settled) return
        settled = true
        reject(new Error(message))
      }, milliseconds)
      Promise.resolve(promise).then(
        function (value) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        },
        function (error) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(error)
        }
      )
    })
  }

  function loadCanvasKitScript(base) {
    if (typeof window.CanvasKitInit === 'function') return Promise.resolve()
    const src = canvasKitAssetUrl(base, 'canvaskit.js')
    const existing = Array.from(document.querySelectorAll('script[data-basalt-canvaskit]'))
      .find(function (script) { return script.src === src })
    if (existing?.dataset.loaded === 'true') return Promise.resolve()

    const scriptPromise = new Promise(function (resolve, reject) {
      const script = existing || document.createElement('script')
      script.src = src
      script.async = true
      script.dataset.basaltCanvaskit = CANVASKIT_VERSION
      script.onload = function () {
        script.dataset.loaded = 'true'
        resolve()
      }
      script.onerror = function () {
        script.remove()
        reject(new Error('Could not download ' + src))
      }
      if (!existing) document.head.appendChild(script)
    })

    return withTimeout(
      scriptPromise,
      CANVASKIT_TIMEOUT_MS,
      'Timed out downloading ' + src
    )
  }

  async function initializeCanvasKit(base) {
    await loadCanvasKitScript(base)
    if (typeof window.CanvasKitInit !== 'function') {
      throw new Error('CanvasKit loaded without its initializer.')
    }
    const initPromise = window.CanvasKitInit({
      locateFile: function (name) { return canvasKitAssetUrl(base, name) },
    })
    return withTimeout(
      initPromise,
      CANVASKIT_TIMEOUT_MS,
      'Timed out starting CanvasKit from ' + new URL(base, document.baseURI).href
    )
  }

  function loadCanvasKit() {
    if (canvasKitPromise) return canvasKitPromise

    canvasKitPromise = (async function () {
      const bases = preferredCanvasKitBase
        ? [preferredCanvasKitBase]
        : [CANVASKIT_LOCAL_BASE, CANVASKIT_CDN_BASE]
      const failures = []

      for (const base of bases) {
        try {
          const CanvasKit = await initializeCanvasKit(base)
          preferredCanvasKitBase = base
          return CanvasKit
        } catch (error) {
          failures.push(messageFrom(error))
          if (base === CANVASKIT_LOCAL_BASE && bases.length > 1) {
            setLiveStatus('Local preview engine is unavailable. Trying the pinned online fallback…', 'loading')
          }
        }
      }

      throw new Error(
        'The Skia preview engine could not start. ' +
        'Deploy vendor/canvaskit/canvaskit.js and canvaskit.wasm, or check this browser\'s network access. ' +
        failures.join(' | ')
      )
    })().catch(function (error) {
      canvasKitPromise = null
      throw error
    })

    return canvasKitPromise
  }

  function shaderFromTexture(texture) {
    if (texture.opticalBackdrop?.shaderSource) {
      return {
        source: String(texture.opticalBackdrop.shaderSource),
        target: 'panel',
        optical: true,
      }
    }
    if (typeof texture.shaderSource === 'string') {
      return {
        source: texture.shaderSource,
        target: texture.target === 'panel' ? 'panel' : 'button',
        optical: /\buniform\s+shader\s+image\s*;/.test(texture.shaderSource),
      }
    }
    return null
  }

  function setLiveStatus(text, kind) {
    if (!mounted) return
    mounted.status.textContent = text
    mounted.status.dataset.kind = kind || 'idle'
  }

  function stopAnimation() {
    if (!mounted) return
    if (mounted.frameId) cancelAnimationFrame(mounted.frameId)
    mounted.frameId = 0
  }

  function disposeRenderer() {
    if (!mounted) return
    stopAnimation()
    ;['shader', 'paint', 'effect', 'surface'].forEach(function (key) {
      const resource = mounted[key]
      if (resource && typeof resource.delete === 'function') {
        try { resource.delete() } catch (_) {}
      } else if (resource && key === 'surface' && typeof resource.dispose === 'function') {
        try { resource.dispose() } catch (_) {}
      }
      mounted[key] = null
    })
  }

  function resetLivePreview() {
    previewGeneration += 1
    disposeRenderer()
    if (!mounted) return
    mounted.root.hidden = true
    mounted.canvas.hidden = true
    mounted.canvas.style.backgroundImage = 'none'
    mounted.empty.hidden = false
    mounted.empty.textContent = 'Choose a procedural .sksl or shader texture JSON to render it here.'
    mounted.playButton.textContent = 'Pause'
    mounted.retryButton.hidden = true
    mounted.lastPreview = null
    mounted.paused = false
    setLiveStatus('Waiting for a shader', 'idle')
  }

  function makeUniforms(effect, width, height, elapsed, touch) {
    const values = new Float32Array(effect.getUniformFloatCount())
    for (let index = 0; index < effect.getUniformCount(); index += 1) {
      const name = effect.getUniformName(index)
      const info = effect.getUniform(index)
      const slots = Math.max(1, Number(info.columns || 1) * Number(info.rows || 1))
      let supplied
      // Basalt's native convention plus ShaderToy-style aliases. These are
      // names in the SkSL source, not a GLSL compatibility layer.
      if (name === 'resolution' || name === 'uResolution' || name === 'iResolution') {
        supplied = [width, height, 1]
      } else if (name === 'time' || name === 'uTime' || name === 'iTime') {
        supplied = [elapsed]
      } else if (name === 'touch' || name === 'mouse' || name === 'uMouse' || name === 'iMouse') {
        supplied = [touch.x, touch.y, touch.x, touch.y]
      }
      // A catalog card has no device sensors. Sweep a small virtual tilt so
      // tilt-reactive materials still demonstrate their real highlight motion.
      else if (name === 'tiltX') supplied = [Math.sin(elapsed * 0.72) * 0.34]
      else if (name === 'tiltY') supplied = [Math.cos(elapsed * 0.61) * 0.24]
      else throw new Error('The web preview does not supply the uniform "' + name + '".')

      if (supplied.length < slots) {
        throw new Error('Uniform "' + name + '" expects ' + slots + ' values, not ' + supplied.length + '.')
      }
      supplied.slice(0, slots).forEach(function (value, offset) {
        values[Number(info.slot || 0) + offset] = value
      })
    }
    return values
  }

  // Marketplace cards use their own renderers so opening a card never steals
  // the submit page's live preview. Render only cards that are on-screen; the
  // image beneath the canvas remains a fast, reliable fallback while CanvasKit
  // starts (and for textures the website cannot execute).
  function disposeCatalogRenderer(state) {
    if (!state) return
    if (catalogObserver) {
      try {
        catalogObserver.unobserve(state.observeTarget || state.canvas)
      } catch (_) {}
    }
    ;['shader', 'paint', 'effect', 'surface'].forEach(function (key) {
      const resource = state[key]
      if (resource && typeof resource.delete === 'function') {
        try { resource.delete() } catch (_) {}
      } else if (resource && key === 'surface' && typeof resource.dispose === 'function') {
        try { resource.dispose() } catch (_) {}
      }
      state[key] = null
    })
    if (state.canvas) {
      state.canvas.hidden = true
      state.canvas.style.opacity = '0'
    }
  }

  function disposeCatalogPreview(canvas) {
    const state = catalogRenderers.get(canvas)
    if (!state) return
    catalogRenderers.delete(canvas)
    if (state.observeTarget && catalogObserveTargets) {
      catalogObserveTargets.delete(state.observeTarget)
    }
    disposeCatalogRenderer(state)
  }

  function setCatalogPreviewTouch(canvas, clientX, clientY) {
    const state = catalogRenderers.get(canvas)
    if (!state || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return false
    const bounds = canvas.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return false
    state.touch.x = Math.max(0, Math.min(state.canvas.width, ((clientX - bounds.left) / bounds.width) * state.canvas.width))
    state.touch.y = Math.max(0, Math.min(state.canvas.height, ((clientY - bounds.top) / bounds.height) * state.canvas.height))
    if (state.visible) scheduleCatalogFrame()
    return true
  }

  function drawCatalogFrame(state, now) {
    if (!state?.surface || !state.effect || !state.paint) return
    const elapsed = state.reduceMotion ? 1.4 : Math.max(0, (now - state.startedAt) / 1000)
    let shader = null
    try {
      const uniforms = makeUniforms(
        state.effect,
        state.canvas.width,
        state.canvas.height,
        elapsed,
        state.touch
      )
      shader = state.effect.makeShader(uniforms)
      state.paint.setShader(shader)
      const canvas = state.surface.getCanvas()
      canvas.clear(state.CanvasKit.TRANSPARENT)
      canvas.drawRect(
        state.CanvasKit.LTRBRect(0, 0, state.canvas.width, state.canvas.height),
        state.paint
      )
      state.surface.flush()
      if (state.shader && typeof state.shader.delete === 'function') state.shader.delete()
      state.shader = shader
      shader = null
    } finally {
      if (shader && typeof shader.delete === 'function') shader.delete()
    }
  }

  function scheduleCatalogFrame() {
    if (catalogFrameId || !catalogRenderers.size) return
    catalogFrameId = requestAnimationFrame(function (now) {
      catalogFrameId = 0
      let needsAnotherFrame = false
      catalogRenderers.forEach(function (state, canvas) {
        if (!canvas.isConnected) {
          disposeCatalogPreview(canvas)
          return
        }
        if (!state.visible || state.reduceMotion || !state.surface) return
        try {
          drawCatalogFrame(state, now)
          needsAnotherFrame = true
        } catch (_) {
          // Keep the already-loaded catalog image visible if a user supplied
          // shader cannot render in this browser.
          disposeCatalogPreview(canvas)
        }
      })
      if (needsAnotherFrame) scheduleCatalogFrame()
    })
  }

  // Observe the visible parent (swatch / preview host), never a `hidden` canvas —
  // IntersectionObserver ignores display:none nodes, which killed live card motion.
  const catalogObserveTargets = new Map()

  function ensureCatalogObserver() {
    if (catalogObserver || typeof IntersectionObserver !== 'function') return
    catalogObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        const canvas = catalogObserveTargets.get(entry.target)
        const state = canvas ? catalogRenderers.get(canvas) : null
        if (!state) return
        state.visible = entry.isIntersecting
        if (state.visible) {
          if (!state.initialized && !state.initializing) void startCatalogRenderer(state)
          scheduleCatalogFrame()
        }
      })
    }, { rootMargin: '160px 0px', threshold: 0.01 })
  }

  async function startCatalogRenderer(state) {
    if (!state || state.initializing || state.initialized || !state.visible) return
    state.initializing = true
    let CanvasKit
    try {
      CanvasKit = await loadCanvasKit()
      if (catalogRenderers.get(state.canvas) !== state || !state.visible) return

      let compileError = ''
      const effect = CanvasKit.RuntimeEffect.Make(state.source, function (error) {
        compileError = String(error || '')
      })
      if (!effect) throw new Error(compileError.trim() || 'Skia rejected this RuntimeEffect.')

      let surface = CanvasKit.MakeWebGLCanvasSurface(
        state.canvas,
        CanvasKit.ColorSpace?.SRGB,
        { antialias: 1, alpha: 1, premultipliedAlpha: 1, preserveDrawingBuffer: 1 }
      )
      if (!surface) surface = CanvasKit.MakeSWCanvasSurface(state.canvas)
      if (!surface) {
        effect.delete()
        throw new Error('Skia could not create a canvas surface.')
      }

      state.CanvasKit = CanvasKit
      state.effect = effect
      state.surface = surface
      state.paint = new CanvasKit.Paint()
      state.paint.setAntiAlias(true)
      state.touch = { x: state.canvas.width / 2, y: state.canvas.height / 2 }
      state.startedAt = performance.now()
      state.initialized = true
      state.canvas.hidden = false
      state.canvas.style.opacity = '1'
      drawCatalogFrame(state, state.startedAt + 1400)
      scheduleCatalogFrame()
    } catch (_) {
      if (catalogRenderers.get(state.canvas) === state) disposeCatalogPreview(state.canvas)
    } finally {
      if (catalogRenderers.get(state.canvas) === state) state.initializing = false
    }
  }

  const GLASS_DISTORT_FILTER_ID = 'basalt-market-glass-distort'
  const GLASS_DISTORT_DEFS_ID = 'basalt-market-glass-distort-defs'

  function clampNumber(value, min, max, fallback) {
    const n = Number(value)
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
  }

  /** Same SVG displacement trick as Basalt's web PremiumPanel — warps the backdrop. */
  function ensureGlassDistortFilter(scale) {
    if (typeof document === 'undefined') return
    const safeScale = Math.round(clampNumber(scale, 6, 28, 16) * 10) / 10
    let host = document.getElementById(GLASS_DISTORT_DEFS_ID)
    if (!host) {
      host = document.createElement('div')
      host.id = GLASS_DISTORT_DEFS_ID
      host.setAttribute('aria-hidden', 'true')
      host.style.cssText =
        'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;left:0;top:0'
      document.body.appendChild(host)
    }
    const prev = host.getAttribute('data-basalt-displace-scale')
    if (prev === String(safeScale) && host.querySelector('#' + GLASS_DISTORT_FILTER_ID)) return
    host.setAttribute('data-basalt-displace-scale', String(safeScale))
    host.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute">' +
      '<defs>' +
      '<filter id="' +
      GLASS_DISTORT_FILTER_ID +
      '" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.008 0.012" numOctaves="2" seed="7" result="noise"/>' +
      '<feDisplacementMap in="SourceGraphic" in2="noise" scale="' +
      safeScale +
      '" xChannelSelector="R" yChannelSelector="G"/>' +
      '</filter></defs></svg>'
  }

  /**
   * Optical liquid-glass packs cannot run CanvasKit with `uniform shader image` on
   * this page. Style the interactive Preview button/panel with the same CSS glass
   * Basalt uses on Expo web so the listing looks like the real material.
   */
  function styleInteractiveDemoHost(button, rawText) {
    if (!(button instanceof HTMLElement)) return { ok: false, kind: 'none' }
    button.classList.remove('is-liquid-glass', 'is-panel-host', 'is-shader-host')
    button.style.removeProperty('--basalt-glass-blur')
    button.style.removeProperty('--basalt-glass-sat')
    button.style.removeProperty('--basalt-glass-bri')
    button.style.removeProperty('--basalt-glass-surface')
    button.style.removeProperty('--basalt-glass-edge-light')
    button.style.removeProperty('--basalt-glass-edge-shadow')
    button.style.removeProperty('--basalt-glass-top')
    button.style.removeProperty('--basalt-glass-bottom')
    button.style.removeProperty('backdrop-filter')
    button.style.removeProperty('-webkit-backdrop-filter')
    button.style.removeProperty('background')
    button.style.removeProperty('background-image')
    button.style.removeProperty('box-shadow')
    button.style.removeProperty('border-color')

    const parsed = parseTexture(typeof rawText === 'string' ? rawText : '')
    if (!parsed.ok) return { ok: false, kind: 'none' }
    const texture = parsed.texture
    const webEffect =
      texture.webEffect && typeof texture.webEffect === 'object' ? texture.webEffect : null
    const fallback =
      texture.fallback && typeof texture.fallback === 'object' ? texture.fallback : null
    const isGlass =
      (webEffect && String(webEffect.type || '') === 'liquid-glass') ||
      !!(texture.opticalBackdrop && typeof texture.opticalBackdrop === 'object') ||
      (fallback && String(fallback.material || '') === 'glass')
    if (!isGlass) return { ok: false, kind: 'none' }

    const blurPx = clampNumber(
      webEffect?.blurAmount ?? texture.blurAmount ?? texture.opticalBackdrop?.blurAmount,
      10,
      28,
      14
    )
    const satPct = Math.round(clampNumber(webEffect?.saturation, 1.2, 2.2, 1.8) * 100)
    const bri = clampNumber(webEffect?.brightness, 0.95, 1.2, 1.04)
    const displace = clampNumber(webEffect?.displacementScale, 6, 28, 16)
    const surface = color(webEffect?.surfaceColor, 'rgba(255,255,255,0.028)')
    const edgeLight = color(webEffect?.edgeLightColor, 'rgba(255,255,255,0.88)')
    const edgeShadow = color(webEffect?.edgeShadowColor, 'rgba(7,16,28,0.48)')
    const topLight = color(webEffect?.topLightColor, 'rgba(255,255,255,0.38)')
    const bottomShade = color(webEffect?.bottomShadeColor, 'rgba(8,20,34,0.22)')
    const panel =
      texture.target === 'panel' ||
      texture.target === 'background' ||
      !!(texture.opticalBackdrop && typeof texture.opticalBackdrop === 'object')

    ensureGlassDistortFilter(displace)
    button.classList.add('is-liquid-glass')
    if (panel) button.classList.add('is-panel-host')
    button.style.setProperty('--basalt-glass-blur', blurPx + 'px')
    button.style.setProperty('--basalt-glass-sat', String(satPct) + '%')
    button.style.setProperty('--basalt-glass-bri', String(bri))
    button.style.setProperty('--basalt-glass-surface', surface)
    button.style.setProperty('--basalt-glass-edge-light', edgeLight)
    button.style.setProperty('--basalt-glass-edge-shadow', edgeShadow)
    button.style.setProperty('--basalt-glass-top', topLight)
    button.style.setProperty('--basalt-glass-bottom', bottomShade)
    const label = button.querySelector('[data-preview-demo-label]')
    if (label) label.textContent = panel ? 'Preview panel' : 'Preview button'
    else button.childNodes.forEach(function (node) {
      if (node.nodeType === 3) node.textContent = panel ? 'Preview panel' : 'Preview button'
    })
    return { ok: true, kind: 'liquid-glass', panel: panel }
  }

  function mountCatalogPreview(canvas, rawText) {
    if (!(canvas instanceof HTMLCanvasElement) || typeof rawText !== 'string') return false
    const parsed = parseTexture(rawText)
    if (!parsed.ok) return false
    const shader = shaderFromTexture(parsed.texture)
    if (!shader || shader.optical) return false

    disposeCatalogPreview(canvas)
    canvas.width = 640
    canvas.height = 400
    // Stay in layout so IntersectionObserver can see the parent swatch.
    canvas.hidden = false
    canvas.style.opacity = '0'
    const observeTarget =
      canvas.closest('.swatch, .drawer-preview, [data-interactive-preview], [data-preview-demo-button]') ||
      canvas
    const state = {
      canvas,
      observeTarget,
      source: shader.source,
      visible: typeof IntersectionObserver !== 'function',
      initializing: false,
      initialized: false,
      reduceMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
      CanvasKit: null,
      surface: null,
      effect: null,
      paint: null,
      shader: null,
      touch: { x: 320, y: 200 },
      startedAt: 0,
    }
    catalogRenderers.set(canvas, state)
    catalogObserveTargets.set(observeTarget, canvas)
    ensureCatalogObserver()
    if (catalogObserver) catalogObserver.observe(observeTarget)
    if (state.visible) void startCatalogRenderer(state)
    // If already on-screen, force a visibility check (parent may already intersect).
    if (catalogObserver && observeTarget.getBoundingClientRect) {
      const rect = observeTarget.getBoundingClientRect()
      const onScreen =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < (window.innerHeight || 0) + 160 &&
        rect.left < (window.innerWidth || 0)
      if (onScreen) {
        state.visible = true
        void startCatalogRenderer(state)
      }
    }
    return true
  }

  /**
   * Paint the shader ON the Preview button/panel host (not behind it).
   * Optical glass → CSS liquid-glass chrome. Procedural SkSL → CanvasKit on an
   * inner canvas clipped to the host.
   */
  function mountHostPreview(hostEl, rawText) {
    if (!(hostEl instanceof HTMLElement) || typeof rawText !== 'string') {
      return { ok: false, error: 'Host preview unavailable' }
    }
    const existing = hostEl.querySelector('canvas[data-basalt-host-preview]')
    if (existing) disposeCatalogPreview(existing)

    const glass = styleInteractiveDemoHost(hostEl, rawText)
    if (glass.ok) {
      hostEl.classList.add('is-shader-host')
      if (existing) existing.remove()
      return glass
    }

    const parsed = parseTexture(rawText)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const shader = shaderFromTexture(parsed.texture)
    if (!shader) return { ok: false, error: 'No shader in texture' }
    if (shader.optical) {
      // Optical without webEffect still gets glass chrome defaults.
      const forced = styleInteractiveDemoHost(
        hostEl,
        JSON.stringify({
          ...parsed.texture,
          webEffect: parsed.texture.webEffect || { type: 'liquid-glass' },
          opticalBackdrop: parsed.texture.opticalBackdrop || { preset: 'liquid-glass-lens' },
        })
      )
      return forced.ok ? forced : { ok: false, optical: true }
    }

    let canvas = hostEl.querySelector('canvas[data-basalt-host-preview]')
    if (!canvas) {
      canvas = document.createElement('canvas')
      canvas.setAttribute('data-basalt-host-preview', '')
      canvas.setAttribute('aria-hidden', 'true')
      hostEl.insertBefore(canvas, hostEl.firstChild)
    }
    const panel = shader.target === 'panel' || shader.target === 'background'
    hostEl.classList.add('is-shader-host')
    if (panel) hostEl.classList.add('is-panel-host')
    const label = hostEl.querySelector('[data-preview-demo-label]')
    if (label) label.textContent = panel ? 'Preview panel' : 'Preview button'

    const mountedOk = mountCatalogPreview(canvas, rawText)
    return mountedOk
      ? { ok: true, kind: 'shader', panel: panel }
      : { ok: false, error: 'Could not mount host shader' }
  }

  function disposeCatalogPreviews(root) {
    if (!root) return
    root
      .querySelectorAll('canvas[data-basalt-catalog-preview], canvas[data-basalt-host-preview]')
      .forEach(disposeCatalogPreview)
  }

  function drawFrame(now) {
    if (!mounted?.surface || !mounted.effect || !mounted.paint) return
    const elapsed = mounted.reduceMotion ? 1.4 : Math.max(0, (now - mounted.startedAt) / 1000)
    let shader = null
    try {
      const uniforms = makeUniforms(
        mounted.effect,
        mounted.canvas.width,
        mounted.canvas.height,
        elapsed,
        mounted.touch
      )
      shader = mounted.effect.makeShader(uniforms)
      mounted.paint.setShader(shader)
      const canvas = mounted.surface.getCanvas()
      canvas.clear(mounted.CanvasKit.TRANSPARENT)
      canvas.drawRect(
        mounted.CanvasKit.LTRBRect(0, 0, mounted.canvas.width, mounted.canvas.height),
        mounted.paint
      )
      mounted.surface.flush()
      if (mounted.shader && typeof mounted.shader.delete === 'function') mounted.shader.delete()
      mounted.shader = shader
      shader = null
    } finally {
      if (shader && typeof shader.delete === 'function') shader.delete()
    }
  }

  function scheduleFrame(generation) {
    if (!mounted || mounted.paused || mounted.reduceMotion || generation !== previewGeneration) return
    mounted.frameId = requestAnimationFrame(function (now) {
      if (!mounted || generation !== previewGeneration) return
      try {
        drawFrame(now)
        scheduleFrame(generation)
      } catch (error) {
        mounted.paused = true
        mounted.playButton.textContent = 'Play'
        setLiveStatus('Render stopped: ' + messageFrom(error), 'error')
      }
    })
  }

  function configureCanvas(target) {
    if (!mounted) return
    const panel = target === 'panel'
    mounted.canvas.width = 960
    mounted.canvas.height = panel ? 600 : 320
    mounted.stage.dataset.target = panel ? 'panel' : 'button'
  }

  async function renderProcedural(source, options) {
    if (!mounted) throw new Error('The live preview is not mounted.')
    const generation = ++previewGeneration
    mounted.lastPreview = { source: String(source), options: options || {} }
    disposeRenderer()
    mounted.root.hidden = false
    mounted.canvas.hidden = true
    mounted.canvas.style.backgroundImage = 'none'
    mounted.empty.hidden = false
    mounted.empty.textContent = 'Starting the Skia preview engine...'
    mounted.paused = false
    mounted.playButton.textContent = 'Pause'
    mounted.retryButton.hidden = true
    setLiveStatus('Loading CanvasKit ' + CANVASKIT_VERSION, 'loading')
    configureCanvas(options?.target)

    let CanvasKit
    try {
      CanvasKit = await loadCanvasKit()
    } catch (error) {
      if (generation !== previewGeneration) return { ok: false, cancelled: true }
      const detail = messageFrom(error)
      mounted.empty.textContent = 'Preview engine unavailable'
      mounted.retryButton.hidden = false
      setLiveStatus(detail, 'error')
      return { ok: false, error: detail, engineUnavailable: true }
    }
    if (generation !== previewGeneration) return { ok: false, cancelled: true }
    mounted.CanvasKit = CanvasKit
    let compileError = ''
    const effect = CanvasKit.RuntimeEffect.Make(String(source), function (error) {
      compileError = String(error || '')
    })
    if (!effect) {
      const detail = compileError.trim() || 'Skia rejected this RuntimeEffect.'
      mounted.empty.textContent = 'Shader did not compile'
      setLiveStatus(detail, 'error')
      return { ok: false, error: detail }
    }

    let surface = CanvasKit.MakeWebGLCanvasSurface(
      mounted.canvas,
      CanvasKit.ColorSpace?.SRGB,
      { antialias: 1, alpha: 1, premultipliedAlpha: 1, preserveDrawingBuffer: 1 }
    )
    if (!surface) surface = CanvasKit.MakeSWCanvasSurface(mounted.canvas)
    if (!surface) {
      effect.delete()
      const detail = 'Skia could not create a WebGL or software canvas surface.'
      mounted.empty.textContent = 'Preview surface unavailable'
      setLiveStatus(detail, 'error')
      return { ok: false, error: detail }
    }

    mounted.effect = effect
    mounted.surface = surface
    mounted.paint = new CanvasKit.Paint()
    mounted.paint.setAntiAlias(true)
    mounted.touch = { x: mounted.canvas.width / 2, y: mounted.canvas.height / 2 }
    mounted.startedAt = performance.now()
    mounted.canvas.hidden = false
    mounted.empty.hidden = true

    try {
      drawFrame(mounted.startedAt + 1400)
    } catch (error) {
      const detail = messageFrom(error)
      disposeRenderer()
      mounted.canvas.hidden = true
      mounted.empty.hidden = false
      mounted.empty.textContent = 'Shader could not render'
      setLiveStatus(detail, 'error')
      return { ok: false, error: detail }
    }
    setLiveStatus(
      mounted.reduceMotion
        ? 'Rendered by Skia. Motion is paused by your reduced-motion setting.'
        : 'Rendered by Skia. Move or press on the preview to drive touch uniforms.',
      'ready'
    )
    scheduleFrame(generation)
    return { ok: true, url: mounted.canvas.toDataURL('image/png'), rendered: 'skia' }
  }

  async function previewRawSkSL(source, options) {
    const optical = /\buniform\s+shader\s+image\s*;/.test(String(source))
    if (optical) {
      if (mounted) {
        previewGeneration += 1
        disposeRenderer()
        mounted.root.hidden = false
        mounted.canvas.hidden = true
        mounted.empty.hidden = false
        mounted.empty.textContent = 'Optical background required'
        setLiveStatus(
          'This shader samples live content through `uniform shader image`. The submission is valid, but the website preview cannot supply that background yet.',
          'notice'
        )
      }
      return { ok: false, optical: true, error: 'Optical child shaders need a live background texture.' }
    }
    return renderProcedural(source, options || {})
  }

  async function previewTexture(rawText, itemName) {
    const parsed = parseTexture(rawText)
    if (!parsed.ok) {
      if (mounted) {
        mounted.root.hidden = false
        mounted.empty.hidden = false
        mounted.canvas.hidden = true
        mounted.empty.textContent = 'Invalid texture JSON'
        setLiveStatus(parsed.error, 'error')
      }
      return parsed
    }
    const shader = shaderFromTexture(parsed.texture)
    if (!shader) {
      const fallback = buildFallbackPreview(parsed.texture, itemName)
      if (mounted) {
        previewGeneration += 1
        disposeRenderer()
        mounted.root.hidden = false
        mounted.empty.hidden = true
        mounted.canvas.hidden = false
        configureCanvas(parsed.texture.target)
        mounted.canvas.style.backgroundImage = 'url("' + fallback.url + '")'
        mounted.canvas.style.backgroundPosition = 'center'
        mounted.canvas.style.backgroundRepeat = 'no-repeat'
        mounted.canvas.style.backgroundSize = 'cover'
        setLiveStatus('This non-shader pack uses the static catalog preview.', 'notice')
      }
      return fallback
    }
    if (shader.optical) {
      const fallback = buildFallbackPreview(parsed.texture, itemName)
      await previewRawSkSL(shader.source, { target: shader.target })
      return fallback.ok ? fallback : { ok: false, error: 'Optical preview unavailable.' }
    }
    return renderProcedural(shader.source, { target: shader.target })
  }

  async function previewUpload(rawText, options) {
    if (options?.kind === 'sksl') {
      return previewRawSkSL(rawText, { target: options.target || 'button' })
    }
    return previewTexture(rawText, options?.itemName || '')
  }

  /** Async CanvasKit snapshot for the submit live stage — not used by the catalog grid. */
  async function tryBuildLivePreviewFromTexture(rawText, itemName) {
    const parsed = parseTexture(rawText)
    if (!parsed.ok) return parsed
    const shader = shaderFromTexture(parsed.texture)
    if (!shader || shader.optical) return buildFallbackPreview(parsed.texture, itemName)
    try {
      const rendered = await renderProcedural(shader.source, { target: shader.target })
      if (!rendered.ok) return rendered
      drawFrame(performance.now())
      return { ok: true, url: mounted.canvas.toDataURL('image/png'), rendered: 'skia' }
    } catch (error) {
      const detail = messageFrom(error)
      if (mounted) {
        mounted.empty.textContent = 'Preview could not be generated'
        mounted.empty.hidden = false
        mounted.canvas.hidden = true
        mounted.retryButton.hidden = false
        setLiveStatus(detail, 'error')
      }
      return { ok: false, error: detail }
    }
  }

  function mount(root) {
    if (!root) return null
    root.innerHTML =
      '<div class="shader-preview-head">' +
        '<div><strong>Live button / panel preview</strong><span>Move across it to test the shader before submitting</span></div>' +
        '<div>' +
          '<button type="button" class="shader-preview-control" data-preview-retry hidden>Retry preview</button>' +
          '<button type="button" class="shader-preview-control" data-preview-toggle>Pause</button>' +
        '</div>' +
      '</div>' +
      '<div class="shader-preview-stage" data-preview-stage data-target="button">' +
        '<canvas data-preview-canvas width="960" height="320" hidden></canvas>' +
        '<div class="shader-preview-empty" data-preview-empty>Choose a procedural .sksl or shader texture JSON to render it here.</div>' +
      '</div>' +
      '<div class="shader-preview-status" data-preview-status data-kind="idle">Waiting for a shader</div>'

    mounted = {
      root,
      stage: root.querySelector('[data-preview-stage]'),
      canvas: root.querySelector('[data-preview-canvas]'),
      empty: root.querySelector('[data-preview-empty]'),
      status: root.querySelector('[data-preview-status]'),
      playButton: root.querySelector('[data-preview-toggle]'),
      retryButton: root.querySelector('[data-preview-retry]'),
      reduceMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
      paused: false,
      frameId: 0,
      surface: null,
      effect: null,
      paint: null,
      shader: null,
      CanvasKit: null,
      touch: { x: 480, y: 160 },
      startedAt: 0,
      lastPreview: null,
    }

    mounted.retryButton.addEventListener('click', function () {
      if (!mounted?.lastPreview) return
      canvasKitPromise = null
      const lastPreview = mounted.lastPreview
      mounted.retryButton.hidden = true
      void renderProcedural(lastPreview.source, lastPreview.options)
    })

    mounted.playButton.addEventListener('click', function () {
      if (!mounted?.surface || mounted.reduceMotion) return
      mounted.paused = !mounted.paused
      mounted.playButton.textContent = mounted.paused ? 'Play' : 'Pause'
      if (mounted.paused) stopAnimation()
      else {
        mounted.startedAt = performance.now()
        scheduleFrame(previewGeneration)
      }
    })

    function updateTouch(event) {
      if (!mounted?.surface) return
      const bounds = mounted.canvas.getBoundingClientRect()
      if (!bounds.width || !bounds.height) return
      mounted.touch = {
        x: ((event.clientX - bounds.left) / bounds.width) * mounted.canvas.width,
        y: ((event.clientY - bounds.top) / bounds.height) * mounted.canvas.height,
      }
      if (mounted.paused || mounted.reduceMotion) drawFrame(performance.now())
    }
    mounted.stage.addEventListener('pointerdown', updateTouch)
    mounted.stage.addEventListener('pointermove', function (event) {
      if (event.buttons || event.pointerType === 'mouse') updateTouch(event)
    })
    resetLivePreview()
    return mounted
  }

  window.BasaltMarketPreview = {
    // Catalog grid API (must remain sync — marketplace.html does not await these)
    previewForItem,
    buildPlaceholderPreview,
    buildNeedsScreenshotPreview,
    buildPreviewFromTexture,
    tryBuildPreviewFromTexture,
    SCREENSHOT_REQUIRED_MSG,
    // Submit live SkSL stage (CanvasKit)
    CANVASKIT_VERSION,
    mount,
    reset: resetLivePreview,
    previewUpload,
    previewTexture,
    previewRawSkSL,
    tryBuildLivePreviewFromTexture,
    // Marketplace live cards (CanvasKit is shared; off-screen cards are paused).
    mountCatalogPreview,
    mountHostPreview,
    setCatalogPreviewTouch,
    disposeCatalogPreviews,
    styleInteractiveDemoHost,
  }
})()
