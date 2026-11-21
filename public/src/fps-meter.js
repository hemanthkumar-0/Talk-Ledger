/**
 * Voice Khata — Dev-Only Live FPS & Long-Task Monitor (public/src/fps-meter.js)
 * Automatically hidden in production hosts (only runs on localhost / 127.0.0.1 / ?debug=1).
 * Tracks real-time FPS and Long Tasks (>50ms) during scrolling without causing layout thrashing.
 */

import { isLocalDebugMode } from './debug-log.js';

export function initDevFpsMeter() {
  if (!isLocalDebugMode() || typeof window === 'undefined' || typeof document === 'undefined') {
    return null;
  }

  const badge = document.createElement('div');
  badge.id = 'vkDevFpsBadge';
  badge.setAttribute('aria-hidden', 'true');
  badge.style.cssText = [
    'position:fixed',
    'bottom:14px',
    'right:14px',
    'z-index:9999',
    'padding:5px 10px',
    'border-radius:999px',
    'background:rgba(11,15,25,0.88)',
    'border:1px solid rgba(201,169,97,0.35)',
    'color:#E8D5A3',
    'font:600 11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace',
    'letter-spacing:0.03em',
    'pointer-events:none',
    'contain:layout paint style',
    'transform:translateZ(0)',
  ].join(';');
  badge.textContent = '60 FPS · 0 LT';
  document.body.appendChild(badge);

  let frames = 0;
  let lastSample = performance.now();
  let lastFrameTs = lastSample;
  let maxFrameMs = 0;
  let longTaskCount = 0;
  let currentFps = 60;
  let rafId = null;

  // Expose telemetry cleanly for automated Playwright / CDP performance checks
  const stats = {
    fps: 60,
    minFps: 60,
    maxFrameMs: 0,
    longTasks: 0,
    longTaskDetails: [],
  };
  window.__vkPerfStats = stats;

  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > 50) {
            longTaskCount += 1;
            stats.longTasks = longTaskCount;
            stats.longTaskDetails.push({
              name: entry.name,
              duration: Number(entry.duration.toFixed(1)),
              startTime: Number(entry.startTime.toFixed(1)),
            });
          }
        }
      });
      obs.observe({ entryTypes: ['longtask'] });
    } catch {
      // ignore unsupported browsers
    }
  }

  const tick = (now) => {
    const dt = now - lastFrameTs;
    lastFrameTs = now;
    if (dt > maxFrameMs && dt < 500) maxFrameMs = dt;
    frames += 1;

    if (now - lastSample >= 500) {
      currentFps = Math.min(120, Math.round((frames * 1000) / (now - lastSample)));
      stats.fps = currentFps;
      if (currentFps < stats.minFps) stats.minFps = currentFps;
      stats.maxFrameMs = Number(maxFrameMs.toFixed(1));
      badge.textContent = `${currentFps} FPS · ${longTaskCount} LT`;
      badge.style.color = currentFps >= 55 ? '#4ADE80' : currentFps >= 40 ? '#E8D5A3' : '#F87171';
      frames = 0;
      maxFrameMs = 0;
      lastSample = now;
    }

    if (!document.hidden) {
      rafId = window.requestAnimationFrame(tick);
    } else {
      rafId = null;
    }
  };

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && rafId === null) {
      lastSample = performance.now();
      lastFrameTs = lastSample;
      frames = 0;
      rafId = window.requestAnimationFrame(tick);
    }
  });

  rafId = window.requestAnimationFrame(tick);
  return stats;
}
