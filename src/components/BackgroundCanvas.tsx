'use client';

import React, { useEffect, useMemo, useRef } from 'react';

const DEFAULT_THEME_COLOR = '#f7931a';
const DEFAULT_BASE_COLOR = '#ecedef';

type BackgroundCanvasProps = {
  themeColor?: string;
  baseColor?: string;
};

type GlState = {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  buffer: WebGLBuffer;
  aPosition: number;
  uTime: WebGLUniformLocation | null;
  uResolution: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
  uColor2: WebGLUniformLocation | null;
  ro: ResizeObserver;
  rafId: number;
  startMs: number;
  lastMs: number;
  dpr: number;
  lastAdjustMs: number;
  emaDt: number;
};

function hexToRgb01(hex: string): [number, number, number] {
  const raw = hex.trim().replace('#', '');
  const value =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw;
  const parsed = Number.parseInt(value, 16);
  const r = (parsed >> 16) & 255;
  const g = (parsed >> 8) & 255;
  const b = parsed & 255;
  return [r / 255, g / 255, b / 255];
}

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(
  gl: WebGLRenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

const vertexShader = `
  attribute vec2 aPosition;
  varying vec2 vUv;

  void main() {
    vUv = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

// 复刻 claim.sentient.xyz 的流体纹理：3D simplex noise + fbm domain-warped field。
// 同时在 shader 内做轻量“伪 Bloom + Film grain”，避免引入 three/postprocessing。
const fragmentShader = `
  precision highp float;

  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec3 uColor;
  uniform vec3 uColor2;

  varying vec2 vUv;

  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

  float snoise(vec3 v) {
    const vec2  C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);

    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);

    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);

    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;

    i = mod289(i);
    vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0)) +
      i.y + vec4(0.0, i1.y, i2.y, 1.0)) +
      i.x + vec4(0.0, i1.x, i2.x, 1.0));

    float n_ = 0.142857142857; // 1.0 / 7.0
    vec3  ns = n_ * D.wyz - D.xzx;

    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);

    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);

    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);

    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));

    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);

    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x;
    p1 *= norm.y;
    p2 *= norm.z;
    p3 *= norm.w;

    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
  }

  float storm(vec3 p) {
    float f = 0.0;
    float amp = 0.5;
    mat3 m = mat3(
      0.0, 0.8, 0.6,
      -0.8, 0.36, -0.48,
      -0.6, -0.48, 0.64
    );

    for (int i = 0; i < 5; i++) {
      f += amp * abs(snoise(p));
      p = m * p * 1.4 + vec3(1.7);
      amp *= 0.5;
    }
    return f;
  }

  float hash12(vec2 p) {
    float h = dot(p, vec2(127.1, 311.7));
    return fract(sin(h) * 43758.5453123);
  }

  void main() {
    vec2 uv = vUv;

    // 轻微按比例修正，避免屏幕比变化导致“拉伸”过强
    float aspect = uResolution.x / max(1.0, uResolution.y);
    vec2 suv = vec2(uv.x * aspect, uv.y);

    vec3 p = vec3(suv * 1.0, uTime * 0.3);
    p.xy += 0.4 * vec2(
      storm(vec3(p.xy * 1.3, p.z + 1.0)),
      storm(vec3(p.xy * 1.7, p.z + 2.0))
    );

    float n = storm(p);
    n = clamp(n, 0.0, 1.0);

    vec3 col = mix(uColor2, uColor, n);

    // 轻量“伪 Bloom”：把高亮部分再抬一层，接近 postprocessing 的 glow 感
    float glow = smoothstep(0.55, 1.0, n);
    col += col * col * (0.35 * glow);

    // Film grain
    float grain = (hash12(gl_FragCoord.xy + uTime * 60.0) - 0.5) * 0.025;
    col += grain;

    col = clamp(col, 0.0, 1.0);

    // 近似 sRGB 输出（避免发灰）
    col = pow(col, vec3(1.0 / 2.2));
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function BackgroundCanvas({
  themeColor = DEFAULT_THEME_COLOR,
  baseColor = DEFAULT_BASE_COLOR,
}: BackgroundCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glRef = useRef<GlState | null>(null);

  const themeRgb = useMemo(() => hexToRgb01(themeColor), [themeColor]);
  const baseRgb = useMemo(() => hexToRgb01(baseColor), [baseColor]);
  const themeRgbRef = useRef(themeRgb);
  const baseRgbRef = useRef(baseRgb);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'default',
      preserveDrawingBuffer: false,
    });
    if (!gl) return;

    const program = createProgram(gl, vertexShader, fragmentShader);
    if (!program) return;

    const buffer = gl.createBuffer();
    if (!buffer) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    // full-screen quad (triangle strip)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );

    gl.useProgram(program);

    const aPosition = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

    const uTime = gl.getUniformLocation(program, 'uTime');
    const uResolution = gl.getUniformLocation(program, 'uResolution');
    const uColor = gl.getUniformLocation(program, 'uColor');
    const uColor2 = gl.getUniformLocation(program, 'uColor2');

    const maxDpr = Math.min(2, window.devicePixelRatio || 1);
    const initialDpr = Math.min(1.5, maxDpr);

    const state: GlState = {
      gl,
      program,
      buffer,
      aPosition,
      uTime,
      uResolution,
      uColor,
      uColor2,
      ro: new ResizeObserver(() => {}),
      rafId: 0,
      startMs: performance.now(),
      lastMs: performance.now(),
      dpr: initialDpr,
      lastAdjustMs: performance.now(),
      emaDt: 1 / 60,
    };

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width * state.dpr));
      const height = Math.max(1, Math.floor(rect.height * state.dpr));
      if (canvas.width === width && canvas.height === height) return;
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
      gl.uniform2f(uResolution, width, height);
    };

    state.ro = new ResizeObserver(resize);
    state.ro.observe(container);

    glRef.current = state;

    // init uniforms
    resize();
    gl.uniform3f(
      uColor,
      themeRgbRef.current[0],
      themeRgbRef.current[1],
      themeRgbRef.current[2],
    );
    gl.uniform3f(
      uColor2,
      baseRgbRef.current[0],
      baseRgbRef.current[1],
      baseRgbRef.current[2],
    );

    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - state.lastMs) / 1000);
      state.lastMs = now;
      state.emaDt = state.emaDt * 0.95 + dt * 0.05;

      // 简单自适应 DPR：性能差就降，性能好就升（避免过重）
      const sinceAdjust = now - state.lastAdjustMs;
      if (sinceAdjust > 1400) {
        if (state.emaDt > 1 / 45 && state.dpr > 1) {
          state.dpr = Math.max(1, state.dpr * 0.9);
          state.lastAdjustMs = now;
          resize();
        } else if (state.emaDt < 1 / 58 && state.dpr < maxDpr) {
          state.dpr = Math.min(maxDpr, state.dpr * 1.06);
          state.lastAdjustMs = now;
          resize();
        }
      }

      const t = (now - state.startMs) / 1000;
      gl.useProgram(program);
      gl.uniform1f(uTime, t);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      state.rafId = requestAnimationFrame(tick);
    };

    state.rafId = requestAnimationFrame(tick);

    return () => {
      if (glRef.current) glRef.current = null;
      state.ro.disconnect();
      cancelAnimationFrame(state.rafId);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
  }, []);

  useEffect(() => {
    themeRgbRef.current = themeRgb;
    const state = glRef.current;
    if (!state) return;
    state.gl.useProgram(state.program);
    state.gl.uniform3f(state.uColor, themeRgb[0], themeRgb[1], themeRgb[2]);
  }, [themeRgb]);

  useEffect(() => {
    baseRgbRef.current = baseRgb;
    const state = glRef.current;
    if (!state) return;
    state.gl.useProgram(state.program);
    state.gl.uniform3f(state.uColor2, baseRgb[0], baseRgb[1], baseRgb[2]);
  }, [baseRgb]);

  return (
    <div ref={containerRef} className="sentient-bg">
      <canvas ref={canvasRef} />
    </div>
  );
}
