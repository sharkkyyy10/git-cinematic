import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  FogExp2,
  GridHelper,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector2,
  type Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

export const CITY_EXTENT = 1000;
export const BACKGROUND = new Color(0x04060c);
export const FOG_DENSITY = 0.00042;

/** Bloom at half the canvas resolution, per the performance budget. */
class HalfResBloomPass extends UnrealBloomPass {
  override setSize(width: number, height: number): void {
    super.setSize(Math.max(1, Math.round(width / 2)), Math.max(1, Math.round(height / 2)));
  }
}

export class Stage {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly composer: EffectComposer;
  readonly bloom: HalfResBloomPass;

  constructor(readonly canvas: HTMLCanvasElement) {
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    } catch {
      throw new Error("WebGL2 is not available");
    }
    if (!renderer.capabilities.isWebGL2) throw new Error("WebGL2 is not available");
    this.renderer = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;

    this.scene.background = BACKGROUND;
    this.scene.fog = new FogExp2(BACKGROUND.getHex(), FOG_DENSITY);
    this.scene.add(new HemisphereLight(0x3a5a8c, 0x05060a, 0.9));
    const sun = new DirectionalLight(0x9db4ff, 0.7);
    sun.position.set(400, 800, 300);
    this.scene.add(sun);

    const ground = new Mesh(new PlaneGeometry(12000, 12000), new MeshLambertMaterial({ color: 0x070b14 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.7;
    this.scene.add(ground);
    const grid = new GridHelper(4000, 160, 0x1a2848, 0x0d1528);
    grid.position.y = -0.65;
    const gridMat = grid.material as { transparent: boolean; opacity: number };
    gridMat.transparent = true;
    gridMat.opacity = 0.6;
    this.scene.add(grid);

    this.camera = new PerspectiveCamera(45, 1, 1, 20000);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.04; // never under the ground
    this.controls.minDistance = 15;
    this.controls.maxDistance = CITY_EXTENT * 3;
    this.controls.screenSpacePanning = false;
    this.home();

    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new HalfResBloomPass(new Vector2(256, 256), 0.7, 0.4, 0.55);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.resize();
  }

  home(): void {
    this.camera.position.set(720, 560, 820);
    this.controls.target.set(0, 0, 40);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }

  resize(): void {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Keep the orbit target above ground and inside the city's neighbourhood. */
  clampTarget(): void {
    const t = this.controls.target;
    const lim = CITY_EXTENT * 1.5;
    t.set(Math.min(Math.max(t.x, -lim), lim), Math.max(t.y, 0), Math.min(Math.max(t.z, -lim), lim));
    if (this.camera.position.y < 2) this.camera.position.y = 2;
  }

  render(): void {
    this.composer.render();
  }

  project(point: Vector3): { x: number; y: number } {
    const p = point.clone().project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
  }
}
