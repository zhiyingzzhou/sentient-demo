'use client';

import React, { useEffect, useMemo, useRef } from 'react';

const BASE_COLOR = '#131313';
const PLANE_Z = -100; // 仅用于语义，现实现不依赖 three 相机
const MOTION_WARP = 1.0;
const MOTION_DRIFT = 1.0;

type GlState = {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  buffer: WebGLBuffer;
  aPosition: number;
  uTime: WebGLUniformLocation | null;
  uResolution: WebGLUniformLocation | null;
  uMap: WebGLUniformLocation | null;
  uRepeat: WebGLUniformLocation | null;
  uOffset: WebGLUniformLocation | null;
  uWarp: WebGLUniformLocation | null;
  uDrift: WebGLUniformLocation | null;
  texture: WebGLTexture | null;
  imageWidth: number;
  imageHeight: number;
  ro: ResizeObserver;
  rafId: number;
  startMs: number;
  lastMs: number;
  dpr: number;
  lastAdjustMs: number;
  emaDt: number;
};

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

function computeCoverUv({
  viewWidth,
  viewHeight,
  imageWidth,
  imageHeight,
  alignX = 0.5,
  alignY = 0.5,
}: {
  viewWidth: number;
  viewHeight: number;
  imageWidth: number;
  imageHeight: number;
  alignX?: number;
  alignY?: number;
}) {
  const viewAspect = viewWidth / Math.max(1, viewHeight);
  const imageAspect = imageWidth / Math.max(1, imageHeight);

  let repeatX = 1;
  let repeatY = 1;

  if (viewAspect > imageAspect) {
    // 视口更宽：裁掉上下
    repeatY = imageAspect / viewAspect;
  } else {
    // 视口更窄：裁掉左右
    repeatX = viewAspect / imageAspect;
  }

  const offsetX = (1 - repeatX) * alignX;
  const offsetY = (1 - repeatY) * alignY;

  return { repeatX, repeatY, offsetX, offsetY };
}

const vertexShader = `
  attribute vec2 aPosition;
  varying vec2 vUv;

  void main() {
    vUv = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

// 基于 Figma 导出的背景切图（login-email.png）做“轻微流动”。
// 核心思路：不移动图片本身，而是每帧扭曲采样坐标 uv，让橙色区域像环境光一样呼吸/流动。
const fragmentShader = `
  precision highp float;

  uniform sampler2D uMap;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec2 uRepeat;
  uniform vec2 uOffset;
  uniform float uWarp;
  uniform float uDrift;

  varying vec2 vUv;

  float hash12(vec2 p) {
    float h = dot(p, vec2(127.1, 311.7));
    return fract(sin(h) * 43758.5453123);
  }

  float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);

    float a = hash12(i + vec2(0.0, 0.0));
    float b = hash12(i + vec2(1.0, 0.0));
    float c = hash12(i + vec2(0.0, 1.0));
    float d = hash12(i + vec2(1.0, 1.0));

    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  float fbm(vec2 p) {
    float f = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      f += a * noise2(p);
      p *= 2.0;
      a *= 0.5;
    }
    return f;
  }

  void main() {
    vec2 uv = vUv * uRepeat + uOffset;
    vec2 baseUv = uv;
    vec2 center = uOffset + uRepeat * 0.5;

    float t = uTime;

    // 让运动主要发生在左侧橙色区域（右侧保持更稳定）
    float mask = smoothstep(0.85, 0.05, baseUv.x);
    mask = pow(mask, 1.35);

    // 轻微“呼吸”缩放（让橙色团有生命感）
    float zoom = 1.0 + 0.045 * sin(t * 0.35) * mask;
    uv = (uv - center) / zoom + center;

    // 很小的旋转，避免静止感（幅度保持极低）
    float ang = 0.03 * sin(t * 0.22) * mask;
    mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
    uv = rot * (uv - center) + center;

    // 低频流场扰动：让渐变“流动”但不出现明显形状边界
    vec2 p = (uv - center) * 2.0;
    vec2 flow = vec2(
      fbm(p * 1.25 + vec2(0.0, t * 0.05)),
      fbm(p * 1.55 + vec2(t * 0.04, 0.0))
    ) - 0.5;
    uv += flow * (0.045 * uWarp) * mask;

    // 极慢漂移（优先上下，横向很小，保证橙色仍在最左侧）
    uv += vec2(0.006 * sin(t * 0.08), 0.012 * sin(t * 0.06)) * uDrift * mask;

    uv = clamp(uv, vec2(0.0), vec2(1.0));

    vec3 col = texture2D(uMap, uv).rgb;

    // 轻量噪点（替代 postprocessing 的 Noise）
    float grain = (hash12(gl_FragCoord.xy + uTime * 60.0) - 0.5) * 0.03;
    col += grain * 0.6;

    col = clamp(col, 0.0, 1.0);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function BlurGradientCanvas() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glRef = useRef<GlState | null>(null);

  const baseClearRgb = useMemo(() => {
    const raw = BASE_COLOR.replace('#', '');
    const parsed = Number.parseInt(raw, 16);
    const r = ((parsed >> 16) & 255) / 255;
    const g = ((parsed >> 8) & 255) / 255;
    const b = (parsed & 255) / 255;
    return [r, g, b] as const;
  }, []);

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
    const uMap = gl.getUniformLocation(program, 'uMap');
    const uRepeat = gl.getUniformLocation(program, 'uRepeat');
    const uOffset = gl.getUniformLocation(program, 'uOffset');
    const uWarp = gl.getUniformLocation(program, 'uWarp');
    const uDrift = gl.getUniformLocation(program, 'uDrift');

    const maxDpr = Math.min(2, window.devicePixelRatio || 1);
    const initialDpr = Math.min(1.5, maxDpr);

    const state: GlState = {
      gl,
      program,
      buffer,
      aPosition,
      uTime,
      uResolution,
      uMap,
      uRepeat,
      uOffset,
      uWarp,
      uDrift,
      texture: null,
      imageWidth: 3840,
      imageHeight: 2160,
      ro: new ResizeObserver(() => {}),
      rafId: 0,
      startMs: performance.now(),
      lastMs: performance.now(),
      dpr: initialDpr,
      lastAdjustMs: performance.now(),
      emaDt: 1 / 60,
    };

    gl.clearColor(baseClearRgb[0], baseClearRgb[1], baseClearRgb[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.uniform1f(uWarp, MOTION_WARP);
    gl.uniform1f(uDrift, MOTION_DRIFT);

    const setCoverUv = (cssW: number, cssH: number) => {
      const cover = computeCoverUv({
        viewWidth: cssW,
        viewHeight: cssH,
        imageWidth: state.imageWidth,
        imageHeight: state.imageHeight,
        alignX: 0, // 左对齐，保证橙色团在最左边
        alignY: 0.5,
      });
      gl.useProgram(program);
      gl.uniform2f(uRepeat, cover.repeatX, cover.repeatY);
      gl.uniform2f(uOffset, cover.offsetX, cover.offsetY);
    };

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const cssW = Math.max(1, rect.width);
      const cssH = Math.max(1, rect.height);
      const width = Math.max(1, Math.floor(cssW * state.dpr));
      const height = Math.max(1, Math.floor(cssH * state.dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
        gl.useProgram(program);
        gl.uniform2f(uResolution, width, height);
      }
      setCoverUv(cssW, cssH);
    };

    state.ro = new ResizeObserver(resize);
    state.ro.observe(container);

    glRef.current = state;
    resize();

    // texture load
    const img = new Image();
    img.decoding = 'async';
    img.src = '/figma/login-email.png';
    img.onload = () => {
      state.imageWidth = img.naturalWidth || state.imageWidth;
      state.imageHeight = img.naturalHeight || state.imageHeight;

      const tex = gl.createTexture();
      if (!tex) return;

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);

      state.texture = tex;

      gl.useProgram(program);
      gl.uniform1i(uMap, 0);
      resize();
    };

    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - state.lastMs) / 1000);
      state.lastMs = now;
      state.emaDt = state.emaDt * 0.95 + dt * 0.05;

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

      gl.useProgram(program);
      gl.uniform1f(uTime, (now - state.startMs) / 1000);

      if (state.texture) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, state.texture);
      }

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      state.rafId = requestAnimationFrame(tick);
    };

    state.rafId = requestAnimationFrame(tick);

    return () => {
      if (glRef.current) glRef.current = null;
      state.ro.disconnect();
      cancelAnimationFrame(state.rafId);
      if (state.texture) gl.deleteTexture(state.texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
  }, [baseClearRgb]);

  return (
    <div ref={containerRef} className="sentient-bg" aria-hidden="true">
      <canvas ref={canvasRef} style={{ transform: `translateZ(${PLANE_Z}px)` }} />
    </div>
  );
}
