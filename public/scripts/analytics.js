import { app, config } from './firebase-app.js';
import { initializeAnalytics, isSupported, logEvent } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-analytics.js';

// Analytics needs a GA4 web stream linked to this Firebase Web app.
// Keep advertising personalization off; no names, emails, or Auth IDs are sent.
let analytics = null;
if (config.measurementId && await isSupported()) {
    analytics = initializeAnalytics(app, {
        config: { allow_google_signals: false, allow_ad_personalization_signals: false }
    });
} else {
    console.info('Analytics disabled: enable Google Analytics for the Firebase Web app, or use a supported browser.');
}

export function trackEvent(name, parameters = {}) {
    if (!analytics) return false;
    // Opt in to DebugView locally with ?analytics_debug=1.
    const debug = new URLSearchParams(window.location.search).get('analytics_debug') === '1';
    logEvent(analytics, name, debug ? { ...parameters, debug_mode: true } : parameters);
    return true;
}
