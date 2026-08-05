// Basalt Library submission gate.
//
// Philosophy:
//   HARD errors  = broken / unsafe / unusable (can't even queue safely)
//   WARNINGS     = unknown fields, new shapes, odd shaders — still submit;
//                  humans decide at review time.
//
// File types: allowlist only. Reject React/source/design-tool files at the gate —
// Apply is manifest + assets, not freeform .tsx in someone's app.
//
// Do NOT hardcode today's entire texture schema as the only allowed future.
// Known renderers get typed checks when fields look familiar; anything else
// is flagged, not rejected.

(function () {
  const KNOWN_RENDERERS = ['shader', 'gradient', 'faceted', 'traveling-border']
  const KNOWN_TARGETS = ['button', 'panel']
  const KNOWN_INPUTS = ['time', 'touch', 'deviceTilt', 'none']
  const MAX_SHADER_CHARS = 20000
  const MAX_JSON_CHARS = 250 * 1024
  const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/
  const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{8}$/
  const RGBA_COLOR_PATTERN =
    /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*[\d.]+\s*)?\)$/i
  const MAIN_FN_PATTERN = /half4\s+main\s*\(\s*float2\s+\w+\s*\)/
  const SUSPICIOUS_PATTERNS = [
    /<script/i,
    /javascript:/i,
    /\bdocument\./i,
    /\bwindow\./i,
    /XMLHttpRequest/i,
    /\bfetch\s*\(/i,
    /\brequire\s*\(/i,
    /base64,/i,
  ]

  /** Primary skin/component upload — raw SkSL is normalized to a JSON pack before storage. */
  const ALLOWED_COMPONENT_EXTS = ['.json', '.texture.json', '.sksl']
  /** Thumbnail only. */
  const ALLOWED_PREVIEW_EXTS = ['.png', '.jpg', '.jpeg', '.webp']
  /** Clear rejects with tailored copy. */
  const REJECTED_CODE_EXTS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.vue', '.svelte']
  const REJECTED_DESIGN_EXTS = ['.fig', '.blend', '.psd', '.ai', '.sketch', '.xd']
  /** Named for later: not Apply-ready yet — hard reject with roadmap message. */
  const FUTURE_ASSET_EXTS = ['.riv', '.svg', '.lottie']

  /** File picker accept= for the component dropzone. */
  const COMPONENT_FILE_ACCEPT = '.json,.texture.json,.sksl,application/json,text/plain'
  const PREVIEW_FILE_ACCEPT = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp'

  function fileBasename(name) {
    return String(name || '').trim().split(/[/\\]/).pop() || ''
  }

  function fileExtLower(name) {
    var base = fileBasename(name).toLowerCase()
    if (base.endsWith('.texture.json')) return '.texture.json'
    var i = base.lastIndexOf('.')
    return i >= 0 ? base.slice(i) : ''
  }

  /**
   * Hard gate before reading file contents.
   * @returns {{ ok: boolean, errors: string[], warnings: string[], kind?: string }}
   */
  function validateSubmissionFileName(fileName) {
    var errors = []
    var warnings = []
    var ext = fileExtLower(fileName)
    var base = fileBasename(fileName)

    if (!base) {
      return { ok: false, errors: ['Choose a component file.'], warnings: [] }
    }

    if (REJECTED_CODE_EXTS.indexOf(ext) >= 0) {
      return {
        ok: false,
        errors: [
          '"' +
            base +
            '" is app source code (' +
            ext +
            '). Basalt skins are texture / shader JSON packs — not React components. Export a .texture.json (or .json) instead of uploading .tsx/.ts/.jsx/.js.',
        ],
        warnings: [],
      }
    }

    if (REJECTED_DESIGN_EXTS.indexOf(ext) >= 0) {
      return {
        ok: false,
        errors: [
          '"' +
            base +
            '" is a design-tool source file. Export PNG/WebP textures and a Basalt .texture.json from Figma/Blender/etc. — we do not ingest .fig/.blend/.psd directly.',
        ],
        warnings: [],
      }
    }

    if (FUTURE_ASSET_EXTS.indexOf(ext) >= 0) {
      var tip =
        ext === '.riv' || ext === '.svg'
          ? 'Rive/SVG apply is planned — for now submit a .texture.json skin pack.'
          : 'This format is not accepted for Apply yet — use a .texture.json pack.'
      return {
        ok: false,
        errors: ['"' + base + '" (' + ext + ') is not accepted on submit yet. ' + tip],
        warnings: [],
      }
    }

    if (ALLOWED_COMPONENT_EXTS.indexOf(ext) < 0) {
      return {
        ok: false,
        errors: [
          '"' +
            base +
            '" is not an allowed component type. Upload .sksl or a Basalt .json/.texture.json pack. Not accepted: app source code, zips, or design-tool originals.',
        ],
        warnings: [],
      }
    }

    if (ext === '.sksl') {
      return {
        ok: true,
        errors: [],
        warnings: [
          'Raw SkSL will be validated and packaged into an installable .texture.json automatically.'
        ],
        kind: 'sksl',
      }
    }

    if (!base.toLowerCase().endsWith('.texture.json') && ext === '.json') {
      warnings.push(
        'Prefer naming skins "*.texture.json" so Library install maps cleanly — plain .json still works if the schema is valid.'
      )
    }

    return { ok: true, errors: [], warnings: warnings, kind: 'texture-json' }
  }

  function stripSkSLComments(source) {
    return String(source || '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
  }

  function collectSkSLUniforms(source) {
    var code = stripSkSLComments(source)
    var found = []
    var pattern = /\buniform\s+([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*;/g
    var match
    while ((match = pattern.exec(code))) {
      found.push({ type: match[1], name: match[2] })
    }
    return found
  }

  function skslTypeAllowed(actual, allowed) {
    return allowed.indexOf(actual) >= 0
  }

  /**
   * Validate the subset of SkSL that Basalt's current RuntimeEffect hosts can bind.
   * This is deliberately strict: accepting an unknown uniform would create a pack
   * that installs successfully but cannot render reliably.
   */
  function validateSubmissionSkSL(rawText) {
    var errors = []
    var warnings = []
    var source = typeof rawText === 'string' ? rawText : ''
    var code = stripSkSLComments(source)

    if (!source.trim()) {
      return { valid: false, errors: ['Shader file is empty.'], warnings: [] }
    }
    if (source.length > MAX_SHADER_CHARS) {
      return {
        valid: false,
        errors: [
          'Shader is ' + source.length + ' characters — over the ' + MAX_SHADER_CHARS + ' character cap.'
        ],
        warnings: [],
      }
    }
    if (!MAIN_FN_PATTERN.test(code)) {
      errors.push('SkSL must define `half4 main(float2 xy)` (the parameter name may differ).')
    }

    var shadertoyTokens = []
    ;[
      ['mainImage', /\bmainImage\s*\(/],
      ['iResolution', /\biResolution\b/],
      ['iTime', /\biTime\b/],
      ['iMouse', /\biMouse\b/],
      ['iChannel', /\biChannel\d*\b/],
      ['sampler2D', /\bsampler2D\b/],
      ['gl_FragColor', /\bgl_FragColor\b/],
    ].forEach(function (entry) {
      if (entry[1].test(code)) shadertoyTokens.push(entry[0])
    })
    if (shadertoyTokens.length) {
      errors.push(
        'This still contains Shadertoy/GLSL names (' +
          shadertoyTokens.join(', ') +
          '). Port them to Basalt SkSL before submitting.'
      )
    }

    var uniforms = collectSkSLUniforms(source)
    var seen = Object.create(null)
    uniforms.forEach(function (uniform) {
      if (seen[uniform.name]) errors.push('Uniform "' + uniform.name + '" is declared more than once.')
      seen[uniform.name] = true
    })

    var childShaders = uniforms.filter(function (uniform) { return uniform.type === 'shader' })
    var optical = childShaders.length > 0
    childShaders.forEach(function (uniform) {
      if (uniform.name !== 'image') {
        errors.push(
          'Child shader "' + uniform.name + '" is unsupported. The optical panel host provides one child named `image`.'
        )
      }
    })
    if (childShaders.length > 1) {
      errors.push('Only one child shader is supported by the current optical panel host.')
    }

    var regularUniforms = {
      resolution: ['float2', 'half2'],
      time: ['float', 'half'],
      touch: ['float2', 'half2'],
      tiltX: ['float', 'half'],
      tiltY: ['float', 'half'],
    }
    var opticalUniforms = {
      image: ['shader'],
      resolution: ['float2', 'half2'],
      cornerRadius: ['float', 'half'],
      thickness: ['float', 'half'],
      refractiveIndex: ['float', 'half'],
      baseDepth: ['float', 'half'],
      maxRefraction: ['float', 'half'],
      dispersion: ['float', 'half'],
      tint: ['float3', 'half3'],
      tintStrength: ['float', 'half'],
      highlightStrength: ['float', 'half'],
    }
    var contract = optical ? opticalUniforms : regularUniforms
    uniforms.forEach(function (uniform) {
      var allowed = contract[uniform.name]
      if (!allowed) {
        errors.push(
          'Uniform "' + uniform.name + '" is not supplied by Basalt\'s ' +
            (optical ? 'optical panel' : 'button/panel shader') + ' host.'
        )
      } else if (!skslTypeAllowed(uniform.type, allowed)) {
        errors.push(
          'Uniform "' + uniform.name + '" uses ' + uniform.type +
            '; expected ' + allowed.join(' or ') + '.'
        )
      }
    })

    if (optical && !seen.image) {
      errors.push('Optical shaders must declare `uniform shader image`.')
    }
    if (!seen.resolution) {
      warnings.push('No `resolution` uniform was found. This is valid only if the effect is size-independent.')
    }
    if (/\bdFdx\s*\(|\bdFdy\s*\(/.test(code)) {
      warnings.push('Screen derivatives may not be portable across every React Native Skia backend.')
    }
    if (/\bfor\s*\(|\bwhile\s*\(/.test(code)) {
      warnings.push('Contains a loop — reviewers should verify it has a fixed, bounded iteration count.')
    }
    scanSuspicious(source, warnings, 'Shader source')

    var inputs = []
    if (!optical) {
      if (seen.time) inputs.push('time')
      if (seen.touch) inputs.push('touch')
      if (seen.tiltX || seen.tiltY) inputs.push('deviceTilt')
      if (!inputs.length) inputs.push('none')
    }
    return {
      valid: errors.length === 0,
      errors: errors,
      warnings: warnings,
      kind: optical ? 'optical' : 'procedural',
      inputs: inputs,
    }
  }

  function slugifySubmissionId(value) {
    var slug = String(value || '')
      .toLowerCase()
      .replace(/\.sksl$/i, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '')
    return slug || 'shader-effect'
  }

  var TRANSPARENT_PANEL_SHADER =
    'uniform float2 resolution;\n' +
    'half4 main(float2 xy) {\n' +
    '  return half4(0.0, 0.0, 0.0, 0.0);\n' +
    '}\n'

  /** Convert one raw .sksl upload into the JSON artifact consumed by Install/Apply. */
  function buildTextureJsonFromSkSL(rawText, options) {
    var check = validateSubmissionSkSL(rawText)
    if (!check.valid) return check
    var opts = options && typeof options === 'object' ? options : {}
    var id = slugifySubmissionId(opts.id || opts.fileName)
    var requestedTarget = KNOWN_TARGETS.indexOf(opts.target) >= 0 ? opts.target : 'button'
    var target = check.kind === 'optical' ? 'panel' : requestedTarget
    var manifest = {
      id: id,
      renderer: 'shader',
      target: target,
      inputs: check.kind === 'optical' ? ['none'] : check.inputs,
      fallback: {
        material: check.kind === 'optical' ? 'glass' : 'paint',
        backgroundColor: check.kind === 'optical'
          ? 'rgba(255,255,255,0.055)'
          : 'rgba(0,0,0,0)',
        highlightColor: 'rgba(255,255,255,0.26)',
        lowlightColor: 'rgba(0,0,0,0.12)',
        borderColor: 'rgba(255,255,255,0.42)',
      },
      shaderSource: check.kind === 'optical' ? TRANSPARENT_PANEL_SHADER : String(rawText),
    }

    if (target === 'panel') {
      manifest.blurAmount = check.kind === 'optical' ? 12 : 0
      manifest.blurFill = check.kind === 'optical'
        ? 'rgba(255,255,255,0.045)'
        : 'rgba(0,0,0,0)'
      manifest.strokeColor = 'rgba(255,255,255,0.42)'
      manifest.strokeWidth = 1
    }
    if (check.kind === 'optical') {
      manifest.opticalBackdrop = {
        blurAmount: 7,
        thickness: 14,
        refractiveIndex: 1.5,
        baseDepth: 56,
        maxRefraction: 18,
        dispersion: 0.9,
        tint: [1, 1, 1],
        tintStrength: 0,
        highlightStrength: 0.5,
        shaderSource: String(rawText),
      }
      if (requestedTarget !== 'panel') {
        check.warnings.push(
          'This shader samples `uniform shader image`, so Basalt set its target to panel automatically.'
        )
      }
    }

    return {
      valid: true,
      errors: [],
      warnings: check.warnings,
      kind: check.kind,
      manifest: manifest,
      json: JSON.stringify(manifest, null, 2) + '\n',
      fileName: id + '.texture.json',
    }
  }

  function validatePreviewFileName(fileName) {
    var ext = fileExtLower(fileName)
    var base = fileBasename(fileName)
    if (!base) return { ok: true, errors: [], warnings: [] }
    if (ALLOWED_PREVIEW_EXTS.indexOf(ext) < 0) {
      return {
        ok: false,
        errors: [
          'Thumbnail must be PNG, JPG, or WebP — not "' + base + '".',
        ],
        warnings: [],
      }
    }
    return { ok: true, errors: [], warnings: [] }
  }

  // Fields we already understand in Basalt. Presence is fine; unknown keys = warn.
  const KNOWN_KEYS = new Set([
    'id',
    'renderer',
    'labelColor',
    'target',
    'inputs',
    'shaderSource',
    'blurAmount',
    'blurFill',
    'strokeColor',
    'strokeWidth',
    'glow',
    'colors',
    'positions',
    'angleDeg',
    'border',
    'depthTop',
    'depthBase',
    'seamColor',
    'facets',
    'seams',
    'depthOverlay',
    'specular',
    'backgroundGradient',
    'fallback',
    'webEffect',
    'opticalBackdrop',
  ])

  function isColor(v) {
    return typeof v === 'string' && (HEX_COLOR_PATTERN.test(v) || RGBA_COLOR_PATTERN.test(v.trim()))
  }

  function scanSuspicious(text, warnings, label) {
    if (typeof text !== 'string' || !text) return
    SUSPICIOUS_PATTERNS.forEach(function (p) {
      if (p.test(text)) warnings.push(label + ' matches a suspicious pattern (' + p + ').')
    })
  }

  function softCheckGlow(glow, warnings, path) {
    if (glow == null) return
    if (typeof glow !== 'object' || Array.isArray(glow)) {
      warnings.push('"' + path + '" looks malformed — expected { color, opacity?, radius? }.')
      return
    }
    if (glow.color != null && !isColor(glow.color)) {
      warnings.push('"' + path + '.color" is not a recognized hex/rgba color.')
    }
  }

  function validateSubmissionJson(rawText) {
    var errors = []
    var warnings = []

    // ── Hard: size + JSON ──────────────────────────────────────────
    if (typeof rawText === 'string' && rawText.length > MAX_JSON_CHARS) {
      return {
        valid: false,
        errors: ['File is ' + (rawText.length / 1024).toFixed(1) + ' KB — over the 250KB cap.'],
        warnings: [],
      }
    }

    var data
    try {
      data = JSON.parse(rawText)
    } catch (e) {
      return { valid: false, errors: ['Not valid JSON: ' + e.message], warnings: [] }
    }

    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return {
        valid: false,
        errors: ['Top level of the file must be a JSON object.'],
        warnings: [],
      }
    }

    // ── Hard: identity ─────────────────────────────────────────────
    if (typeof data.id !== 'string' || !ID_PATTERN.test(data.id) || data.id.length > 60) {
      errors.push(
        '"id" must be lowercase kebab-case (letters, numbers, hyphens), 60 characters or fewer.'
      )
    }
    if (typeof data.renderer !== 'string' || !data.renderer.trim()) {
      errors.push('"renderer" is required (e.g. shader, gradient, faceted, traveling-border, or your own).')
    }

    // ── Soft: unknown / future fields ──────────────────────────────
    Object.keys(data).forEach(function (k) {
      if (!KNOWN_KEYS.has(k)) {
        warnings.push(
          'Unknown field "' +
            k +
            '" — Basalt may not use it yet. Submission still allowed; reviewer will check.'
        )
      }
    })

    if (data.renderer && !KNOWN_RENDERERS.includes(data.renderer)) {
      warnings.push(
        'Unknown renderer "' +
          data.renderer +
          '" — not one of the built-in types (' +
          KNOWN_RENDERERS.join(', ') +
          '). Queue it for review; runtime may need an update before publish.'
      )
    }

    if (data.target != null && !KNOWN_TARGETS.includes(data.target)) {
      warnings.push('Unknown "target" "' + data.target + '" — expected button or panel.')
    }

    if (data.labelColor != null && !isColor(data.labelColor)) {
      warnings.push('"labelColor" is not a recognized hex/rgba color.')
    }

    softCheckGlow(data.glow, warnings, 'glow')

    // ── Soft typed hints for known renderers (never invent hard walls) ──
    if (data.renderer === 'shader' || typeof data.shaderSource === 'string') {
      if (typeof data.shaderSource === 'string') {
        if (data.shaderSource.length === 0) {
          errors.push('"shaderSource" is empty.')
        } else if (data.shaderSource.length > MAX_SHADER_CHARS) {
          errors.push(
            '"shaderSource" is ' +
              data.shaderSource.length +
              ' characters — over the ' +
              MAX_SHADER_CHARS +
              ' cap.'
          )
        } else {
          if (!MAIN_FN_PATTERN.test(data.shaderSource)) {
            warnings.push(
              'No recognizable `half4 main(float2 ...)` entry point — may not run in Skia until fixed.'
            )
          }
          if (/\bfor\s*\(|\bwhile\s*\(/.test(data.shaderSource)) {
            warnings.push(
              'Contains a loop — verify fixed iteration count (unbounded loops can hang the GPU).'
            )
          }
          var longestLine = Math.max.apply(
            null,
            data.shaderSource.split('\n').map(function (l) {
              return l.length
            })
          )
          if (longestLine > 600) {
            warnings.push(
              'Contains a ' + longestLine + '-character line — worth a closer read before publish.'
            )
          }
          scanSuspicious(data.shaderSource, warnings, 'Shader source')
        }
      } else if (data.renderer === 'shader') {
        warnings.push('renderer is "shader" but no "shaderSource" string — may be incomplete.')
      }

      if (data.inputs != null) {
        if (!Array.isArray(data.inputs) || !data.inputs.every(function (i) { return typeof i === 'string' })) {
          warnings.push('"inputs" should be an array of strings.')
        } else {
          data.inputs.forEach(function (i) {
            if (!KNOWN_INPUTS.includes(i)) {
              warnings.push(
                'Unknown input "' + i + '" — Basalt may ignore it until support is added.'
              )
            }
          })
        }
      }

      if (data.blurAmount != null && (typeof data.blurAmount !== 'number' || data.blurAmount < 0 || data.blurAmount > 80)) {
        warnings.push('"blurAmount" should be a number 0–80.')
      }
      if (data.blurFill != null && !isColor(data.blurFill)) {
        warnings.push('"blurFill" is not a recognized hex/rgba color.')
      }
      if (data.strokeColor != null && !isColor(data.strokeColor)) {
        warnings.push('"strokeColor" is not a recognized hex/rgba color.')
      }
    }

    if (data.renderer === 'gradient') {
      if (!Array.isArray(data.colors) || data.colors.length < 2) {
        warnings.push('Gradient textures usually need "colors" (2+ stops).')
      } else if (!data.colors.every(isColor)) {
        warnings.push('Some "colors" entries are not recognized hex/rgba values.')
      }
    }

    if (data.renderer === 'faceted') {
      ;['depthBase', 'facets'].forEach(function (k) {
        if (!(k in data)) warnings.push('Faceted textures usually include "' + k + '".')
      })
    }

    if (data.renderer === 'traveling-border' && !data.border) {
      warnings.push('traveling-border textures usually include a "border" object.')
    }

    // Scan all string fields for junk (not just shaderSource).
    Object.keys(data).forEach(function (k) {
      if (typeof data[k] === 'string' && k !== 'shaderSource') {
        scanSuspicious(data[k], warnings, 'Field "' + k + '"')
      }
    })

    return { valid: errors.length === 0, errors: errors, warnings: warnings }
  }

  window.validateSubmissionJson = validateSubmissionJson
  window.validateSubmissionSkSL = validateSubmissionSkSL
  window.buildTextureJsonFromSkSL = buildTextureJsonFromSkSL
  window.validateSubmissionFileName = validateSubmissionFileName
  window.validatePreviewFileName = validatePreviewFileName
  window.BASALT_COMPONENT_FILE_ACCEPT = COMPONENT_FILE_ACCEPT
  window.BASALT_PREVIEW_FILE_ACCEPT = PREVIEW_FILE_ACCEPT
  window.BASALT_ALLOWED_COMPONENT_EXTS = ALLOWED_COMPONENT_EXTS.slice()
})()
