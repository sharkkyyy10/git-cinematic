// GLSL 3 shaders for the city. Heights and heat are read from the history texture on the GPU,
// so scrubbing the timeline only changes the uTime uniform.

export const HISTORY_WIDTH = 2048;

const common = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x), u.y),
    mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x), u.y),
    u.z);
}
float fbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise3(p);
    p = p * 2.03 + vec3(17.0, 3.0, 11.0);
    a *= 0.5;
  }
  return v;
}
`;

export const buildingVertex = /* glsl */ `
precision highp float;
precision highp int;
precision highp usampler2D;

in vec4 aFootprint; // x, z, w, d
in float aFile;
in vec2 aStatic;    // centrality, authors

uniform usampler2D uHistory;
uniform float uTime;
uniform int uBuckets;
uniform float uSelected;
uniform float uHovered;

out vec3 vWorld;
out vec3 vNormal;
out vec3 vLocal;
out float vHeat;
out float vCentrality;
out float vHeight;
out float vSelect;
out float vSeed;

uvec2 historyAt(int index) {
  return texelFetch(uHistory, ivec2(index % ${HISTORY_WIDTH}, index / ${HISTORY_WIDTH}), 0).rg;
}

void main() {
  int file = int(aFile + 0.5);
  float t = clamp(uTime, 0.0, float(uBuckets - 1));
  int b0 = int(floor(t));
  int b1 = min(b0 + 1, uBuckets - 1);
  float f = t - float(b0);
  uvec2 h0 = historyAt(file * uBuckets + b0);
  uvec2 h1 = historyAt(file * uBuckets + b1);
  float loc = mix(float(h0.r), float(h1.r), f);
  float heat = mix(float(h0.g), float(h1.g), f) / 65535.0;
  float h = loc < 0.5 ? 0.0 : 2.0 + 14.0 * log2(1.0 + loc);

  vec3 local = vec3(position.x * aFootprint.z, position.y * h, position.z * aFootprint.w);
  vec3 world = vec3(aFootprint.x, 0.0, aFootprint.y) + local;
  if (h == 0.0) world = vec3(aFootprint.x, 0.0, aFootprint.y); // collapse to zero scale

  vWorld = (modelMatrix * vec4(world, 1.0)).xyz;
  vNormal = normal;
  vLocal = local;
  vHeat = heat;
  vCentrality = aStatic.x;
  vHeight = h;
  vSeed = aFile;
  vSelect = abs(aFile - uSelected) < 0.5 ? 1.0 : (abs(aFile - uHovered) < 0.5 ? 0.5 : 0.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

export const buildingFragment = /* glsl */ `
precision highp float;

uniform float uClock;
uniform float uFlicker;
uniform vec3 uFogColor;
uniform float uFogDensity;

layout(location = 0) out highp vec4 fragColor;

in vec3 vWorld;
in vec3 vNormal;
in vec3 vLocal;
in float vHeat;
in float vCentrality;
in float vHeight;
in float vSelect;
in float vSeed;

${common}

// Inferno colour map, polynomial fit.
vec3 inferno(float t) {
  const vec3 c0 = vec3(0.0002189403691192265, 0.001651004631001012, -0.01948089843709184);
  const vec3 c1 = vec3(0.1065134194856116, 0.5639564367884091, 3.932712388889277);
  const vec3 c2 = vec3(11.60249308247187, -3.972853965665698, -15.9423941062914);
  const vec3 c3 = vec3(-41.70399613139459, 17.43639888205313, 44.35414519872813);
  const vec3 c4 = vec3(77.162935699427, -33.40235894210092, -81.80730925738993);
  const vec3 c5 = vec3(-71.31942824499214, 32.62606426397723, 73.20951985803202);
  const vec3 c6 = vec3(25.13112622477341, -12.24266895238567, -23.07032500287172);
  t = clamp(t, 0.0, 1.0);
  return c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6)))));
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(vec3(0.45, 0.8, 0.3));
  float up = N.y;

  vec3 base = mix(vec3(0.004, 0.006, 0.012), vec3(0.008, 0.011, 0.022), clamp(vLocal.y / 150.0, 0.0, 1.0));
  if (up > 0.5) base = vec3(0.012, 0.016, 0.03);
  float diffuse = max(dot(N, L), 0.0);
  vec3 sky = mix(vec3(0.0005, 0.0008, 0.0016), vec3(0.004, 0.007, 0.015), up * 0.5 + 0.5);
  vec3 color = base * (0.4 + 1.2 * diffuse) + sky;

  // Procedural window grid on the walls; more lit windows on central files.
  if (abs(up) < 0.5) {
    float u = abs(N.x) > 0.5 ? vLocal.z : vLocal.x;
    vec2 cell = vec2(u / 2.2, vLocal.y / 3.0);
    vec2 fc = fract(cell);
    vec2 id = floor(cell);
    float frame = step(0.28, fc.x) * step(fc.x, 0.72) * step(0.3, fc.y) * step(fc.y, 0.78);
    float notGround = step(1.0, id.y) * step(vLocal.y, vHeight - 1.5);
    float lit = step(hash12(id + vec2(vSeed * 1.37, vSeed * 0.71)), 0.02 + 0.55 * vCentrality * vCentrality);
    float glow = 0.08 + 0.5 * vCentrality;
    color += frame * notGround * lit * glow * vec3(1.0, 0.62, 0.25) * 0.6;
    color += frame * notGround * vec3(0.002, 0.003, 0.006);
  }

  // Heat: inferno emissive, flickering and blooming when the building is on fire.
  if (vHeat > 0.015) {
    float rise = 0.55 + 0.45 * clamp(vLocal.y / max(vHeight, 1.0), 0.0, 1.0);
    vec3 fire = inferno(0.12 + 0.56 * vHeat) * vHeat * rise;
    if (vHeat > 0.6) {
      float flick = uFlicker > 0.5 ? fbm(vec3(vWorld.xz * 0.09, uClock * 1.6 - vWorld.y * 0.05)) : 0.5;
      fire *= 0.6 + 1.6 * flick * flick;
    } else {
      fire *= 0.45;
    }
    color += fire;
  }

  // Calm monoliths: central, cool, untouched by fixes.
  if (vCentrality > 0.7 && vHeat < 0.1) {
    float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    color += vec3(0.12, 0.42, 1.0) * rim * 1.1 + vec3(0.004, 0.012, 0.03);
  }

  color += vSelect * vec3(0.2, 0.55, 1.0) * (0.35 + 0.35 * step(0.9, vSelect));

  float dist = length(cameraPosition - vWorld);
  float fog = 1.0 - exp(-pow(uFogDensity * dist, 2.0));
  color = mix(color, uFogColor, clamp(fog, 0.0, 1.0));
  fragColor = vec4(color, 1.0);
}
`;
