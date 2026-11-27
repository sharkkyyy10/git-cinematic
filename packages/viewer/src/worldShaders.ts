// GLSL 3 shaders for everything around the buildings: sky, ground, the outskirts, traffic,
// street lamps, aviation beacons and fire embers. Everything animated is driven by uClock, so a
// frozen clock always renders the same frame.

import { common, HISTORY_WIDTH } from "./shaders.js";

/** World-space point size to pixels: drawingBufferHeight / (2 tan(fov / 2)). Updated on resize. */
export const pointScale = { value: 800 };

const fog = /* glsl */ `
vec3 applyFog(vec3 color, vec3 world) {
  float dist = length(cameraPosition - world);
  float f = 1.0 - exp(-pow(uFogDensity * dist, 2.0));
  return mix(color, uFogColor, clamp(f, 0.0, 1.0));
}
`;

const history = /* glsl */ `
precision highp int;
precision highp usampler2D;
uniform usampler2D uHistory;
uniform float uTime;
uniform int uBuckets;

uvec2 historyAt(int index) {
  return texelFetch(uHistory, ivec2(index % ${HISTORY_WIDTH}, index / ${HISTORY_WIDTH}), 0).rg;
}
/** Height and heat of a file at the current time, interpolated like the buildings. */
vec2 fileState(int file) {
  float t = clamp(uTime, 0.0, float(uBuckets - 1));
  int b0 = int(floor(t));
  int b1 = min(b0 + 1, uBuckets - 1);
  float f = t - float(b0);
  uvec2 h0 = historyAt(file * uBuckets + b0);
  uvec2 h1 = historyAt(file * uBuckets + b1);
  float loc = mix(float(h0.r), float(h1.r), f);
  float heat = mix(float(h0.g), float(h1.g), f) / 65535.0;
  return vec2(loc < 0.5 ? 0.0 : 2.0 + 14.0 * log2(1.0 + loc), heat);
}
`;

// ---- sky ------------------------------------------------------------------------------------

export const skyVertex = /* glsl */ `
out vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // always at the far plane
}
`;

export const skyFragment = /* glsl */ `
precision highp float;
uniform float uClock;
uniform vec3 uHorizon;
in vec3 vDir;
layout(location = 0) out highp vec4 fragColor;
${common}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 zenith = vec3(0.0015, 0.002, 0.007);
  vec3 mid = vec3(0.006, 0.008, 0.024);
  vec3 col = mix(uHorizon, mid, smoothstep(0.0, 0.22, h));
  col = mix(col, zenith, smoothstep(0.22, 0.85, h));
  // Light pollution from the city, warm and low.
  col += vec3(0.05, 0.022, 0.012) * exp(-max(h, 0.0) * 14.0);

  // Stars, twinkling, thinning out towards the glow of the horizon.
  vec3 p = d * 420.0;
  vec3 id = floor(p);
  float r = hash13(id);
  if (r > 0.9965) {
    vec3 f = fract(p) - 0.5;
    float s = smoothstep(0.16, 0.0, length(f));
    float tw = 0.55 + 0.45 * sin(uClock * (1.5 + r * 3.0) + r * 517.0);
    col += s * tw * smoothstep(0.04, 0.35, h) * mix(vec3(0.7, 0.8, 1.0), vec3(1.0, 0.85, 0.7), fract(r * 91.0)) * 1.4;
  }

  // Moon with a soft halo.
  vec3 md = normalize(vec3(-0.55, 0.36, -0.75));
  float m = max(dot(d, md), 0.0);
  float disc = smoothstep(0.99935, 0.99965, m);
  float craters = 0.82 + 0.18 * fbm(vec3(d * 900.0));
  col += disc * craters * vec3(1.0, 0.95, 0.86) * 1.9;
  col += (pow(m, 600.0) * 0.18 + pow(m, 24.0) * 0.035) * vec3(0.55, 0.65, 1.0);

  // Aurora curtains drifting over the far side of the city.
  if (h > 0.02) {
    vec2 q = d.xz / (h + 0.35);
    float a = fbm(vec3(q * 1.6, uClock * 0.025));
    float curtain = smoothstep(0.52, 0.78, a) * (0.6 + 0.4 * sin(q.x * 9.0 + uClock * 0.2));
    float band = smoothstep(0.02, 0.14, h) * smoothstep(0.6, 0.2, h) * smoothstep(-0.2, 0.5, d.z);
    col += curtain * band * mix(vec3(0.02, 0.5, 0.32), vec3(0.32, 0.12, 0.65), smoothstep(0.08, 0.45, h)) * 0.22;
  }
  fragColor = vec4(col, 1.0);
}
`;

// ---- ground and outskirts -------------------------------------------------------------------

/** Road pitch of the procedural outskirts; outskirt blocks sit inside this grid. */
export const OUTSKIRT_PITCH = 48;
export const OUTSKIRT_ROAD = 9;

export const groundVertex = /* glsl */ `
out vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export const groundFragment = /* glsl */ `
precision highp float;
uniform float uClock;
uniform vec3 uFogColor;
uniform float uFogDensity;
in vec3 vWorld;
layout(location = 0) out highp vec4 fragColor;
${common}
${fog}
float aaLine(float d, float width) {
  float fw = max(fwidth(d), 1e-4);
  return 1.0 - smoothstep(width - fw, width + fw, d);
}
void main() {
  vec2 p = vWorld.xz;
  float pitch = ${OUTSKIRT_PITCH}.0;
  vec2 cell = p / pitch;
  vec2 g = abs(fract(cell + 0.5) - 0.5) * pitch; // distance to the nearest road centre line
  float road = aaLine(min(g.x, g.y), ${OUTSKIRT_ROAD}.0 * 0.5);
  float asphalt = 0.75 + 0.25 * hash12(floor(p * 0.5));
  vec3 col = vec3(0.004, 0.005, 0.009) * asphalt;
  col = mix(col, vec3(0.007, 0.008, 0.012), road);
  // Dashed centre lines.
  float dashX = step(0.5, fract(p.x / 6.0));
  float dashZ = step(0.5, fract(p.y / 6.0));
  col += vec3(0.08, 0.06, 0.02) * (aaLine(g.y, 0.18) * dashX + aaLine(g.x, 0.18) * dashZ) * 0.5;
  // Sodium street lamps along the kerbs, pooling light on the asphalt.
  vec2 lamp = abs(fract(p / 24.0) - 0.5) * 24.0;
  float kerb = min(abs(g.x - ${OUTSKIRT_ROAD}.0 * 0.5), abs(g.y - ${OUTSKIRT_ROAD}.0 * 0.5));
  float pool = exp(-(kerb * kerb + min(lamp.x, lamp.y) * min(lamp.x, lamp.y)) * 0.05);
  col += vec3(1.0, 0.5, 0.18) * pool * 0.09 * road;
  // A faint glow pooling under the city itself.
  col += vec3(0.03, 0.02, 0.05) * exp(-length(p) / 700.0);
  fragColor = vec4(applyFog(col, vWorld), 1.0);
}
`;

export const outskirtVertex = /* glsl */ `
in vec4 aBox;   // x, z, w, d
in vec2 aShape; // height, seed
out vec3 vWorld;
out vec3 vLocal;
out vec3 vNormal;
out float vSeed;
out float vHeight;
void main() {
  vec3 local = vec3(position.x * aBox.z, position.y * aShape.x, position.z * aBox.w);
  vWorld = vec3(aBox.x, 0.0, aBox.y) + local;
  vLocal = local;
  vNormal = normal;
  vSeed = aShape.y;
  vHeight = aShape.x;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

export const outskirtFragment = /* glsl */ `
precision highp float;
uniform float uClock;
uniform vec3 uFogColor;
uniform float uFogDensity;
in vec3 vWorld;
in vec3 vLocal;
in vec3 vNormal;
in float vSeed;
in float vHeight;
layout(location = 0) out highp vec4 fragColor;
${common}
${fog}
void main() {
  vec3 N = normalize(vNormal);
  vec3 col = vec3(0.003, 0.004, 0.008) * (0.6 + 0.6 * max(dot(N, normalize(vec3(0.45, 0.8, 0.3))), 0.0));
  if (abs(N.y) < 0.5) {
    float u = abs(N.x) > 0.5 ? vLocal.z : vLocal.x;
    vec2 cell = vec2(u / 2.4, vLocal.y / 3.2);
    vec2 fc = fract(cell);
    vec2 id = floor(cell);
    float frame = step(0.3, fc.x) * step(fc.x, 0.7) * step(0.32, fc.y) * step(fc.y, 0.76);
    float r = hash12(id + vSeed * 13.7);
    float slow = floor(uClock * 0.07 + r * 9.0);
    float lit = step(hash12(id * 1.7 + vec2(slow, vSeed)), 0.11) * step(1.0, id.y) * step(vLocal.y, vHeight - 1.0);
    vec3 tint = mix(vec3(1.0, 0.6, 0.26), vec3(0.6, 0.75, 1.0), step(0.75, r));
    col += frame * lit * tint * 0.22;
  } else if (N.y > 0.5 && vHeight > 30.0 && hash12(vec2(vSeed, 4.1)) < 0.25) {
    // A blinking red light on a few of the taller roofs.
    float d = length(vLocal.xz);
    col += vec3(1.0, 0.08, 0.04) * smoothstep(1.2, 0.0, d) * step(0.7, fract(uClock * 0.45 + vSeed * 0.37)) * 3.0;
  }
  fragColor = vec4(applyFog(col, vWorld), 1.0);
}
`;

// ---- traffic --------------------------------------------------------------------------------

export const carVertex = /* glsl */ `
uniform float uClock;
in vec4 aLoop; // min x, min z, width, depth of the lane loop
in vec4 aCar;  // phase, speed (units/s), deck height, kind
out vec3 vWorld;
out vec3 vPos;
out float vKind;
void main() {
  float w = aLoop.z;
  float d = aLoop.w;
  float P = 2.0 * (w + d);
  float s = fract(aCar.x + uClock * aCar.y / P) * P;
  vec2 pos;
  vec2 dir;
  if (s < w) { pos = vec2(aLoop.x + s, aLoop.y); dir = vec2(1.0, 0.0); }
  else if (s < w + d) { pos = vec2(aLoop.x + w, aLoop.y + s - w); dir = vec2(0.0, 1.0); }
  else if (s < 2.0 * w + d) { pos = vec2(aLoop.x + w - (s - w - d), aLoop.y + d); dir = vec2(-1.0, 0.0); }
  else { pos = vec2(aLoop.x, aLoop.y + d - (s - 2.0 * w - d)); dir = vec2(0.0, -1.0); }
  float big = step(0.86, aCar.w); // buses and trucks
  vec3 size = mix(vec3(2.4, 0.75, 1.05), vec3(5.0, 1.3, 1.25), big);
  vec3 lp = position * size;
  vec2 side = vec2(-dir.y, dir.x);
  vec2 xz = pos + dir * lp.x + side * lp.z;
  vWorld = vec3(xz.x, aCar.z + lp.y, xz.y);
  vPos = position;
  vKind = aCar.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

export const carFragment = /* glsl */ `
precision highp float;
uniform vec3 uFogColor;
uniform float uFogDensity;
in vec3 vWorld;
in vec3 vPos;
in float vKind;
layout(location = 0) out highp vec4 fragColor;
${fog}
void main() {
  vec3 paint = mix(vec3(0.02, 0.025, 0.04), vec3(0.06, 0.02, 0.02), step(0.5, fract(vKind * 7.0)));
  if (vKind > 0.86) paint = vec3(0.07, 0.05, 0.01);
  vec3 col = paint;
  if (vPos.x > 0.42) col = vec3(1.0, 0.92, 0.75) * 3.2;       // headlights
  else if (vPos.x < -0.42) col = vec3(1.0, 0.05, 0.03) * 2.4; // tail lights
  else if (vPos.y > 0.9) col += vec3(0.02, 0.03, 0.05);
  if (vKind > 0.97 && vPos.y > 0.9) col = vec3(0.1, 0.35, 1.0) * 2.0; // the odd police light bar
  fragColor = vec4(applyFog(col, vWorld), 1.0);
}
`;

// ---- glowing points: lamps, beacons, embers ---------------------------------------------------

const glowFragment = /* glsl */ `
precision highp float;
in vec3 vColor;
in float vAlpha;
layout(location = 0) out highp vec4 fragColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 10.0);
  float halo = exp(-r2 * 2.5) * 0.35;
  fragColor = vec4(vColor * (core + halo) * vAlpha, 1.0);
}
`;

export const lampVertex = /* glsl */ `
uniform float uPointScale;
uniform vec3 uFogColor;
uniform float uFogDensity;
in float aSeed;
out vec3 vColor;
out float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = -mv.z;
  gl_PointSize = clamp(5.5 * uPointScale / dist, 1.5, 48.0);
  float f = 1.0 - exp(-pow(uFogDensity * dist, 2.0));
  vColor = mix(vec3(1.0, 0.66, 0.32), vec3(0.75, 0.88, 1.0), step(0.82, aSeed)) * 1.6;
  vAlpha = 1.0 - f;
}
`;
export const lampFragment = glowFragment;

export const beaconVertex = /* glsl */ `
uniform float uPointScale;
uniform float uClock;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uBeaconMin;
${history}
in float aFile;
in float aSeed;
out vec3 vColor;
out float vAlpha;
void main() {
  vec2 st = fileState(int(aFile + 0.5));
  vec3 p = vec3(position.x, st.x + 1.2, position.z);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float on = step(0.78, fract(uClock * 0.5 + aSeed));
  float tall = step(uBeaconMin, st.x);
  gl_PointSize = tall * clamp(6.0 * uPointScale / -mv.z, 2.0, 40.0);
  vColor = vec3(1.0, 0.07, 0.04) * (0.25 + 2.6 * on);
  vAlpha = tall * (1.0 - exp(-pow(uFogDensity * -mv.z, 2.0)) * 0.8);
}
`;
export const beaconFragment = glowFragment;

export const emberVertex = /* glsl */ `
uniform float uPointScale;
uniform float uClock;
uniform float uFlicker;
${history}
in float aFile;
in vec4 aFoot; // x, z, w, d
in vec2 aSeed;
out vec3 vColor;
out float vAlpha;
void main() {
  vec2 st = fileState(int(aFile + 0.5));
  float heat = st.y;
  float burning = smoothstep(0.42, 0.6, heat) * step(0.5, st.x);
  float clock = uClock * uFlicker;
  float life = fract(aSeed.x + clock * (0.16 + 0.14 * aSeed.y));
  float rise = life * (14.0 + 34.0 * heat);
  float swirl = life * 6.2831 + aSeed.y * 40.0;
  vec2 jitter = (vec2(fract(aSeed.x * 31.7), fract(aSeed.y * 17.3)) - 0.5) * aFoot.zw * 0.8;
  vec2 xz = aFoot.xy + jitter + vec2(sin(swirl), cos(swirl)) * (1.0 + life * 3.0);
  vec4 mv = modelViewMatrix * vec4(xz.x, st.x + rise, xz.y, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = burning * clamp((1.2 + 2.6 * (1.0 - life)) * uPointScale / -mv.z, 0.0, 22.0);
  vColor = mix(vec3(1.0, 0.85, 0.35), vec3(1.0, 0.18, 0.03), life) * 2.4;
  vAlpha = burning * (1.0 - life) * smoothstep(0.0, 0.08, life);
}
`;
export const emberFragment = glowFragment;

// ---- cinematic grade ------------------------------------------------------------------------

/** Final pass after tone mapping: slight chromatic fringe, vignette and film grain. */
export const GradeShader = {
  name: "GradeShader",
  uniforms: {
    tDiffuse: { value: null },
    uClock: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uClock;
    varying vec2 vUv;
    float grain(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      vec3 col;
      col.r = texture2D(tDiffuse, vUv - c * 0.002).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv + c * 0.002).b;
      col *= mix(1.0, 0.55, smoothstep(0.12, 0.62, r2));
      col = mix(col, col * vec3(1.02, 1.0, 1.06), 0.5); // a touch of teal in the shadows
      col += (grain(gl_FragCoord.xy + fract(uClock * 13.0) * 517.0) - 0.5) * 0.022;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};
