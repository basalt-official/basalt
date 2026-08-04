/**
 * Shared PostHog for Basalt web pages (marketplace, dashboard, submit, …).
 * Loads posthog-js from CDN, autocapture + pageviews on, feature flags with web_* keys.
 */
import { POSTHOG_API_KEY, POSTHOG_HOST } from './config.js';

const DEV_WARN =
  'POSTHOG_API_KEY variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once POSTHOG_API_KEY is configured';

let ready = false;
let readyPromise = null;

function pageKey() {
  const path = (location.pathname || '').split('/').pop() || 'index.html';
  const base = path.replace(/\.html$/i, '') || 'index';
  return base.replace(/\s*\(\d+\)$/, '').replace(/_+\d+$/, '');
}

export function initPostHog() {
  if (readyPromise) return readyPromise;
  readyPromise = new Promise((resolve) => {
    if (!POSTHOG_API_KEY) {
      if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') {
        console.warn('[basalt]', DEV_WARN);
      }
      resolve(null);
      return;
    }

    // Official snippet-compatible loader
    !(function (t, e) {
      var o, n, p, r;
      if (!e.__SV) {
        window.posthog = e;
        e._i = [];
        e.init = function (i, s, a) {
          function g(t, e) {
            var o = e.split('.');
            if (2 == o.length) {
              t = t[o[0]];
              e = o[1];
            }
            t[e] = function () {
              t.push([e].concat(Array.prototype.slice.call(arguments, 0)));
            };
          }
          (p = t.createElement('script')).type = 'text/javascript';
          p.crossOrigin = 'anonymous';
          p.async = true;
          p.src = s.api_host.replace('.i.posthog.com', '-assets.i.posthog.com') + '/static/array.js';
          (r = t.getElementsByTagName('script')[0]).parentNode.insertBefore(p, r);
          var u = e;
          for (
            void 0 !== a ? (u = e[a] = []) : (a = 'posthog'),
              u.people = u.people || [],
              u.toString = function (t) {
                var e = 'posthog';
                return 'posthog' !== a && (e += '.' + a), t || (e += ' (stub)'), e;
              },
              u.people.toString = function () {
                return u.toString(1) + '.people (stub)';
              },
              o =
                'init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug'.split(
                  ' '
                ),
              n = 0;
            n < o.length;
            n++
          )
            g(u, o[n]);
          e._i.push([i, s, a]);
        };
        e.__SV = 1;
      }
    })(document, window.posthog || []);

    window.posthog.init(POSTHOG_API_KEY, {
      api_host: POSTHOG_HOST || 'https://us.i.posthog.com',
      defaults: '2026-05-30',
      person_profiles: 'identified_only',
      capture_pageview: true,
      capture_pageleave: true,
      loaded: function (ph) {
        ready = true;
        const key = pageKey();
        ph.register({
          surface: 'web',
          web_page: key,
        });
        ph.capture('web_page_viewed', {
          web_page: key,
          path: location.pathname,
        });
        applyWebFlags(ph);
        resolve(ph);
      },
    });
  });
  return readyPromise;
}

/** Apply web_* feature flags as <html data-web-*> attributes for CSS/JS hooks. */
function applyWebFlags(ph) {
  if (!ph || typeof ph.onFeatureFlags !== 'function') return;
  const paint = () => {
    try {
      const flags = (typeof ph.getFeatureFlags === 'function' && ph.getFeatureFlags()) || {};
      document.documentElement.dataset.phReady = '1';
      Object.keys(flags).forEach((k) => {
        if (!k.startsWith('web_')) return;
        const on = !!ph.isFeatureEnabled(k);
        document.documentElement.setAttribute('data-' + k.replace(/_/g, '-'), on ? 'true' : 'false');
      });
      window.dispatchEvent(new CustomEvent('basalt:web-flags', { detail: flags }));
    } catch (_) {
      /* never break the page */
    }
  };
  ph.onFeatureFlags(paint);
  paint();
}

export function identifyWebUser(user) {
  if (!user || !user.id) return;
  initPostHog().then((ph) => {
    if (!ph) return;
    const props = {};
    if (user.email) props.email = user.email;
    const name = user.user_metadata && (user.user_metadata.full_name || user.user_metadata.name);
    if (name) props.name = name;
    ph.identify(user.id, props);
  });
}

export function resetWebUser() {
  initPostHog().then((ph) => {
    if (!ph) return;
    ph.reset();
  });
}

export function captureWeb(event, props) {
  initPostHog().then((ph) => {
    if (!ph) return;
    ph.capture(event, { web_page: pageKey(), ...(props || {}) });
  });
}

export function isWebFlagEnabled(key) {
  const ph = window.posthog;
  if (!ph || typeof ph.isFeatureEnabled !== 'function') return true; // fail open — don't break buy/UI
  // If flags haven't arrived yet, don't treat as off
  if (document.documentElement.dataset.phReady !== '1') return true;
  return !!ph.isFeatureEnabled(key);
}

// Auto-init on import; expose for classic (non-module) pages
initPostHog();
window.BasaltPH = {
  init: initPostHog,
  identify: identifyWebUser,
  reset: resetWebUser,
  capture: captureWeb,
  isEnabled: isWebFlagEnabled,
};
