// HeroCanvas — the React Three Fiber scene for the homepage hero. Lazy-loaded by
// HeroScene so this module (and three.js) is a separate, on-demand chunk.
//
// Shows the InstaSMM "Digital Growth Core" product model (GLB). Visitors can drag
// horizontally to turn it; vertical drags still scroll the page (touch-action: pan-y).
import { Component, Suspense, useEffect, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Center, Sparkles, useGLTF } from '@react-three/drei';
import { PMREMGenerator } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const reducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// A missing, corrupt or unreachable model must never break the page. The boundary
// reports the failure; HeroScene then swaps in its static emblem.
class SceneBoundary extends Component {
  constructor(props) { super(props); this.state = { error: false }; }
  static getDerivedStateFromError() { return { error: true }; }
  componentDidCatch() { this.props.onError?.(); }
  render() { return this.state.error ? null : this.props.children; }
}

// Soft studio reflections so the brushed-metal rings and glass shell read as
// premium surfaces. Generated locally (no HDR download, no network request).
function StudioEnvironment() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pmrem = new PMREMGenerator(gl);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    return () => {
      scene.environment = null;
      env.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);
  return null;
}

// The product model, rendered exactly as exported. A slow idle turn runs unless
// reduced motion is requested; a drag adds to the turn and stays where released.
function Product({ url, dragRef, still }) {
  const { scene } = useGLTF(url);
  const spin = useRef();
  useFrame((_, dt) => {
    const d = dragRef.current;
    if (!still) d.idle += dt * 0.16;
    if (spin.current) spin.current.rotation.y = d.idle + d.yaw;
  });
  return (
    <group ref={spin}>
      <Center>
        <primitive object={scene} />
      </Center>
    </group>
  );
}

// Gentle camera drift + desktop pointer parallax (fine-pointer devices only).
function CameraRig({ still }) {
  const target = useRef({ x: 0, y: 0 });
  const cur = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (still || !window.matchMedia('(pointer: fine)').matches) return undefined;
    const onMove = (e) => {
      target.current.x = (e.clientX / window.innerWidth - 0.5) * 0.3;
      target.current.y = (e.clientY / window.innerHeight - 0.5) * 0.16;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [still]);

  useFrame((state, dt) => {
    const k = Math.min(1, dt * 2.5);
    cur.current.x += (target.current.x - cur.current.x) * k;
    cur.current.y += (target.current.y - cur.current.y) * k;
    state.camera.position.x = cur.current.x;
    state.camera.position.y = 0.3 + cur.current.y;
    state.camera.lookAt(0, 0, 0);
  });
  return null;
}

export default function HeroCanvas({ modelUrl, onError }) {
  const still = reducedMotion();
  const dragRef = useRef({ active: false, lastX: 0, yaw: 0, idle: 0 });

  const onPointerDown = (e) => {
    const d = dragRef.current;
    d.active = true;
    d.lastX = e.clientX;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d.active) return;
    d.yaw += (e.clientX - d.lastX) * 0.008;
    d.lastX = e.clientX;
  };
  const onPointerUp = (e) => {
    dragRef.current.active = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  return (
    <div
      className="hero3d-stage"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <Canvas
        dpr={[1, 1.5]}
        frameloop={still ? 'demand' : 'always'}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        camera={{ position: [0, 0.3, 5.4], fov: 30 }}
      >
        <StudioEnvironment />
        <SceneBoundary onError={onError}>
          <Suspense fallback={null}>
            <Product url={modelUrl} dragRef={dragRef} still={still} />
          </Suspense>
        </SceneBoundary>
        {/* Cool key light and emerald/violet rims: light only, the model's materials are untouched. */}
        <hemisphereLight args={['#e0faf2', '#05070a', 0.5]} />
        <directionalLight position={[3, 5, 4]} intensity={1.1} color="#a7f3d0" />
        <directionalLight position={[-4, 2, -3]} intensity={0.9} color="#67e8f9" />
        <pointLight position={[0, -1.2, 1.6]} intensity={0.6} color="#10b981" distance={6} />
        <CameraRig still={still} />
        {!still && <Sparkles count={14} scale={[3.2, 2.4, 2.4]} size={1.6} speed={0.18} color="#34d399" opacity={0.45} />}
      </Canvas>
    </div>
  );
}
