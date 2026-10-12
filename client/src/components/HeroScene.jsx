// HeroScene — 3D hero wrapper (anime theme, Stage 4).
//
// Rules this component enforces:
//  - three.js / React Three Fiber / drei are code-split (React.lazy) so the
//    public homepage renders its content BEFORE any 3D code loads.
//  - No character model is bundled. A licensed .glb is supplied at
//    client/public/models/gojo.glb or via VITE_HERO_MODEL_URL — see
//    client/public/models/README.md. Until then the scene shows an abstract
//    placeholder ring, never an AI-generated character.
//  - WebGL-unavailable browsers, model-load failures and
//    prefers-reduced-motion all degrade to a static, fully usable page.
//  - The canvas never intercepts pointer events, so it can never block
//    page interaction.
import { lazy, Suspense, useEffect, useState } from 'react';
import { Icon } from '../ui.jsx';

const HeroCanvas = lazy(() => import('./HeroCanvas.jsx'));

// Configurable model path — no model ships with this repository.
const MODEL_URL = import.meta.env.VITE_HERO_MODEL_URL || '/models/gojo.glb';

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch {
    return false;
  }
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function SceneLoading() {
  return (
    <div className="scene-loading" role="status">
      <svg className="spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" opacity="0.25" />
        <path d="M21 12a9 9 0 0 0-9-9" />
      </svg>
      Loading 3D scene…
    </div>
  );
}

// Neutral abstract placeholder art — deliberately NOT a character.
function PlaceholderArt() {
  return (
    <svg width="120" height="120" viewBox="0 0 120 120" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="pg1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#10b981" />
          <stop offset="100%" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
      <circle cx="60" cy="60" r="44" stroke="url(#pg1)" strokeWidth="1.5" opacity="0.8" />
      <circle cx="60" cy="60" r="30" stroke="#8b5cf6" strokeWidth="1" opacity="0.6" strokeDasharray="4 6" />
      <circle cx="60" cy="60" r="5" fill="#22d3ee" />
    </svg>
  );
}

function ScenePlaceholder({ label }) {
  return (
    <div className="scene-placeholder">
      <PlaceholderArt />
      <span style={{ fontSize: '0.85rem', maxWidth: 280, lineHeight: 1.5 }}>{label}</span>
    </div>
  );
}

export default function HeroScene() {
  const [canGL, setCanGL] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const gl = webglAvailable();
    setCanGL(gl);
    // Default to 3D only when WebGL exists and the user has not asked for
    // reduced motion; the toggle lets anyone opt in or out at any time.
    setEnabled(gl && !prefersReducedMotion());
  }, []);

  return (
    <div className="hero3d">
      <div className="hero3d-frame">
        {enabled && canGL ? (
          <Suspense fallback={<SceneLoading />}>
            <HeroCanvas modelUrl={MODEL_URL} onError={() => setFailed(true)} />
          </Suspense>
        ) : (
          <ScenePlaceholder label={
            failed
              ? '3D character unavailable — everything on this page works without it.'
              : canGL
                ? '3D effects are off — enable them any time with the toggle.'
                : 'This browser does not support WebGL — the site works fully without the 3D scene.'
          } />
        )}
        <button
          type="button"
          className="scene-toggle"
          aria-pressed={enabled}
          aria-label="Toggle 3D effects"
          title="Toggle 3D effects"
          onClick={() => setEnabled((v) => !v)}
        >
          <Icon name={enabled ? 'eyeOff' : 'eye'} size={14} />
          <span>{enabled ? 'Disable 3D' : 'Enable 3D'}</span>
        </button>
      </div>
      <p className="scene-caption">
        {failed
          ? 'The 3D scene could not load. Everything on this page still works.'
          : 'Interactive 3D scene. Use the toggle above to turn it on or off.'}
      </p>
    </div>
  );
}
