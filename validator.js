// Basalt Library submission gate.
//
// Philosophy:
//   HARD errors  = broken / unsafe / unusable (can't even queue safely)
//   WARNINGS     = unknown fields, new shapes, odd shaders — still submit;
//                  humans decide at review time.
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
})()
