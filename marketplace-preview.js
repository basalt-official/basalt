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
  const CANVASKIT_BASE = 'vendor/canvaskit/'

  let canvasKitPromise = null
  let mounted = null
  let previewGeneration = 0

  function color(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback
  }

  function messageFrom(error) {
    return error instanceof Error ? error.message : String(error || 'Unknown preview error')
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

  function assetUrl(name) {
    return new URL(CANVASKIT_BASE + name, document.baseURI).href
  }

  function loadCanvasKit() {
    if (canvasKitPromise) return canvasKitPromise
    canvasKitPromise = new Promise(function (resolve, reject) {
      function initialize() {
        if (typeof window.CanvasKitInit !== 'function') {
          reject(new Error('CanvasKit loaded without its initializer.'))
          return
        }
        window.CanvasKitInit({ locateFile: assetUrl })
          .then(resolve)
          .catch(function (error) {
            canvasKitPromise = null
            reject(error)
          })
      }

      if (typeof window.CanvasKitInit === 'function') {
        initialize()
        return
      }
      const script = document.createElement('script')
      script.src = assetUrl('canvaskit.js')
      script.async = true
      script.dataset.basaltCanvaskit = CANVASKIT_VERSION
      script.onload = initialize
      script.onerror = function () {
        canvasKitPromise = null
        reject(new Error('CanvasKit could not be loaded. Serve this page over http://127.0.0.1 instead of file://.'))
      }
      document.head.appendChild(script)
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
    if (texture.renderer === 'shader' && typeof texture.shaderSource === 'string') {
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
    mounted.paused = false
    setLiveStatus('Waiting for a shader', 'idle')
  }

  function makeUniforms(effect, width, height, elapsed, touch) {
    const values = new Float32Array(effect.getUniformFloatCount())
    for (let index = 0; index < effect.getUniformCount(); index += 1) {
      const name = effect.getUniformName(index)
      const info = effect.getUniform(index)
      let supplied
      if (name === 'resolution') supplied = [width, height]
      else if (name === 'time') supplied = [elapsed]
      else if (name === 'touch') supplied = [touch.x, touch.y]
      else if (name === 'tiltX' || name === 'tiltY') supplied = [0]
      else throw new Error('The web preview does not supply the uniform "' + name + '".')

      const slots = Math.max(1, Number(info.columns || 1) * Number(info.rows || 1))
      if (supplied.length !== slots) {
        throw new Error('Uniform "' + name + '" expects ' + slots + ' values, not ' + supplied.length + '.')
      }
      supplied.forEach(function (value, offset) {
        values[Number(info.slot || 0) + offset] = value
      })
    }
    return values
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
    disposeRenderer()
    mounted.root.hidden = false
    mounted.canvas.hidden = true
    mounted.canvas.style.backgroundImage = 'none'
    mounted.empty.hidden = false
    mounted.empty.textContent = 'Starting the Skia preview engine...'
    mounted.paused = false
    mounted.playButton.textContent = 'Pause'
    setLiveStatus('Loading CanvasKit ' + CANVASKIT_VERSION, 'loading')
    configureCanvas(options?.target)

    const CanvasKit = await loadCanvasKit()
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

  async function tryBuildPreviewFromTexture(rawText, itemName) {
    const parsed = parseTexture(rawText)
    if (!parsed.ok) return parsed
    const shader = shaderFromTexture(parsed.texture)
    if (!shader || shader.optical) return buildFallbackPreview(parsed.texture, itemName)
    const rendered = await renderProcedural(shader.source, { target: shader.target })
    if (!rendered.ok) return rendered
    drawFrame(performance.now())
    return { ok: true, url: mounted.canvas.toDataURL('image/png'), rendered: 'skia' }
  }

  function mount(root) {
    if (!root) return null
    root.innerHTML =
      '<div class="shader-preview-head">' +
        '<div><strong>Live SkSL preview</strong><span>Skia RuntimeEffect in your browser</span></div>' +
        '<button type="button" class="shader-preview-control" data-preview-toggle>Pause</button>' +
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
    }

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
    SCREENSHOT_REQUIRED_MSG,
    CANVASKIT_VERSION,
    mount,
    reset: resetLivePreview,
    previewUpload,
    previewTexture,
    previewRawSkSL,
    tryBuildPreviewFromTexture,
  }
})()
