// HeroCanvas — the React Three Fiber scene. Lazy-loaded by HeroScene so
// this module (and three.js) is a separate, on-demand chunk.
import { Component, Suspense, useEffect, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Center, Sparkles, useAnimations, useGLTF } from '@react-three/drei';

// Adjust per supplied model (see public/models/README.md).
const MODEL_SCALE = 1;

const reducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// A missing, corrupt or unauthorized model must never break the page: the
// boundary swaps in the abstract placeholder rig and reports the failure.
class SceneBoundary extends Component {
  constructor(props) { super(props); this.state = { error: false }; }
  static getDerivedStateFromError() { return { error: true }; }
  componentDidCatch() { this.props.onError?.(); }
  render() { return this.state.error ? <PlaceholderRig /> : this.props.children; }
}

// The licensed character, rendered exactly as authored — no repainting,
// restyling, face-swapping or skeleton changes. Plays the model's own first
// animation if it has one; otherwise only camera/lighting motion is used.
function Character({ url }) {
  const { scene, animations } = useGLTF(url);
  const ref = useRef();
  const { actions } = useAnimations(animations, ref);
  useEffect(() => {
    const first = animations?.[0];
    const action = first && actions[first.name];
    if (action) { action.reset().fadeIn(0.6).play(); return () => action.stop(); }
    return undefined;
  }, [actions, animations]);
  return (
    <group ref={ref}>
      <Center>
        <primitive object={scene} scale={MODEL_SCALE} />
      </Center>
    </group>
  );
}

// Abstract placeholder — clearly not a character. Shown until a licensed
// model is supplied, or permanently when the model fails to load.
function PlaceholderRig() {
  const ref = useRef();
  const still = reducedMotion();
  useFrame((state) => {
    if (still) return;
    ref.current.rotation.y = state.clock.elapsedTime * 0.15;
  });
  return (
    <group ref={ref}>
      <mesh>
        <torusGeometry args={[1.35, 0.02, 16, 128]} />
        <meshStandardMaterial color="#6366f1" emissive="#6366f1" emissiveIntensity={0.35} metalness={0.6} roughness={0.3} />
      </mesh>
      <mesh rotation={[Math.PI / 2.4, 0, 0]}>
        <torusGeometry args={[1.7, 0.012, 16, 128]} />
        <meshStandardMaterial color="#8b5cf6" emissive="#8b5cf6" emissiveIntensity={0.3} metalness={0.6} roughness={0.3} />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.05, 16, 16]} />
        <meshStandardMaterial color="#22d3ee" emissive="#22d3ee" emissiveIntensity={0.8} />
      </mesh>
    </group>
  );
}

// Gentle camera drift + desktop pointer parallax (fine-pointer devices
// only, progressive enhancement). Nothing here touches the model itself.
function CameraRig() {
  const target = useRef({ x: 0, y: 0 });
  const cur = useRef({ x: 0, y: 0 });
  const still = reducedMotion();

  useEffect(() => {
    if (still || !window.matchMedia('(pointer: fine)').matches) return;
    const onMove = (e) => {
      target.current.x = (e.clientX / window.innerWidth - 0.5) * 0.35;
      target.current.y = (e.clientY / window.innerHeight - 0.5) * 0.2;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [still]);

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;
    const k = Math.min(1, dt * 2.5);
    cur.current.x += (target.current.x - cur.current.x) * k;
    cur.current.y += (target.current.y - cur.current.y) * k;
    state.camera.position.x = cur.current.x + Math.sin(t * 0.4) * 0.12;
    state.camera.position.y = 0.5 + cur.current.y + Math.cos(t * 0.3) * 0.08;
    state.camera.lookAt(0, 0.4, 0);
  });
  return null;
}

export default function HeroCanvas({ modelUrl, onError }) {
  const still = reducedMotion();
  return (
    <Canvas
      dpr={[1, 1.75]}
      frameloop={still ? 'demand' : 'always'}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      camera={{ position: [0, 0.5, 5.2], fov: 32 }}
    >
      <SceneBoundary onError={onError}>
        <Suspense fallback={null}>
          <Character url={modelUrl} />
        </Suspense>
      </SceneBoundary>
      {/* Cool key light + violet/magenta rims — complements, never alters,
          the character's own textures. */}
      <ambientLight intensity={0.4} />
      <directionalLight position={[4, 6, 6]} intensity={1.0} color="#7dd3fc" />
      <directionalLight position={[-6, 3, -6]} intensity={1.3} color="#a78bfa" />
      <directionalLight position={[0, -4, -3]} intensity={0.45} color="#e879f9" />
      <CameraRig />
      {!still && <Sparkles count={42} scale={[9, 4.5, 3]} size={2.2} speed={0.22} color="#818cf8" opacity={0.55} />}
    </Canvas>
  );
}
