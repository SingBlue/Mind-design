// GPU spiral renderer: one fragment shader, no per-frame JS drawing work.
class SpiralRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ok = false;
    this.running = false;
    this.fps = 60;
    this.scale = 1;
    this.phase = 0;
    this.pulseT = 0;
    this.last = 0;
    this.params = {
      mode: 0, speed: 0.6, arms: 6, twist: 8, soft: 0.35, pulse: 0.3, dir: 1, cut: false,
      a: [0.56, 0.42, 1.0], b: [0.05, 0.03, 0.13]
    };
    this.loop = this.loop.bind(this);

    const gl = canvas.getContext('webgl', { antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
    if (!gl) return;
    this.gl = gl;

    const vs = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
    const fs = `
      #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
      #else
      precision mediump float;
      #endif
      uniform vec2 uRes;
      uniform float uPhase, uPulseT, uPulse, uArms, uTwist, uSoft, uCut, uMode;
      uniform vec3 uA, uB;
      const float TAU = 6.2831853;
      void main() {
        vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / min(uRes.x, uRes.y);
        float r = length(p);
        float a = atan(p.y, p.x);
        float k = 1.0 + uPulse * 0.35 * sin(uPulseT * 1.6);
        float tw = uTwist * k;
        float w;
        if (uMode < 0.5) {
          // spiral
          w = sin((uArms * a / TAU + tw * r - uPhase) * TAU);
        } else if (uMode < 1.5) {
          // tunnel: rings rushing toward you
          float t = 0.12 / (r + 0.03);
          w = sin((t * tw * 1.1 - uPhase) * TAU);
        } else if (uMode < 2.5) {
          // checker tunnel: rings crossed with rays, slowly twisting
          float t = 0.12 / (r + 0.03);
          float ang = a / TAU * uArms * 2.0 + t * 0.5 + uPhase * 0.25;
          w = sin((t * tw * 1.1 - uPhase) * TAU) * sin(ang * TAU * 0.5) * 1.6;
        } else if (uMode < 3.5) {
          // concentric rings flowing outward
          w = sin((r * tw * 0.8 - uPhase) * TAU);
        } else if (uMode < 4.5) {
          // pinwheel: rays that bend and turn
          w = sin(uArms * a - uPhase * TAU + sin(r * tw * 0.5 + uPulseT * 0.7) * 1.5);
        } else if (uMode < 5.5) {
          // kaleidoscope mandala
          float seg = TAU / max(uArms, 1.0);
          float af = abs(mod(a + uPhase * 0.3, seg) - seg * 0.5);
          vec2 q = r * vec2(cos(af), sin(af));
          float f = tw * 0.35;
          w = sin((q.x * f + uPhase) * TAU) * sin((q.y * f - uPhase * 0.7) * TAU) * 1.6;
        } else if (uMode < 6.5) {
          // moire: two ring systems drifting past each other
          float an = uPhase * 0.6;
          vec2 c = 0.18 * vec2(cos(an), sin(an));
          float f = TAU * tw * 0.5;
          w = clamp(0.8 * (sin(length(p - c) * f) + sin(length(p + c) * f)), -1.0, 1.0);
        } else if (uMode < 7.5) {
          // plasma waves
          float f = tw * 1.8;
          float v = sin(p.x * f + uPhase * TAU) + sin(p.y * f * 1.1 - uPhase * TAU * 0.8)
                  + sin((p.x + p.y) * f * 0.7 + sin(p.x * 3.0 + uPulseT * 0.5) * 1.5)
                  + sin(r * f * 0.9 - uPhase * TAU * 0.6);
          w = clamp(v * 0.5, -1.0, 1.0);
        } else {
          // zooming squares
          vec2 q = p;
          float rot = uPulse * 0.6 * sin(uPulseT * 0.6) + uPhase * 0.05;
          q = mat2(cos(rot), -sin(rot), sin(rot), cos(rot)) * q;
          float d = max(abs(q.x), abs(q.y));
          w = sin((d * tw * 0.8 - uPhase) * TAU);
        }
        float soft = max(uSoft, 0.01);
        float s = smoothstep(-soft, soft, w);
        if (uCut > 0.5) {
          gl_FragColor = vec4(uA * s, s);
        } else {
          gl_FragColor = vec4(mix(uB, uA, s), 1.0);
        }
      }`;

    const prog = this.link(vs, fs);
    if (!prog) return;
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.u = {};
    for (const n of ['uRes', 'uPhase', 'uPulseT', 'uPulse', 'uArms', 'uTwist', 'uSoft', 'uCut', 'uMode', 'uA', 'uB']) {
      this.u[n] = gl.getUniformLocation(prog, n);
    }
    this.ok = true;
    this.resize();
  }

  link(vsSrc, fsSrc) {
    const gl = this.gl;
    const make = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.error(gl.getShaderInfoLog(s)); return null; }
      return s;
    };
    const v = make(gl.VERTEX_SHADER, vsSrc);
    const f = make(gl.FRAGMENT_SHADER, fsSrc);
    if (!v || !f) return null;
    const p = gl.createProgram();
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.error(gl.getProgramInfoLog(p)); return null; }
    return p;
  }

  resize() {
    if (!this.ok) return;
    const w = Math.max(2, Math.floor(this.canvas.clientWidth * this.scale));
    const h = Math.max(2, Math.floor(this.canvas.clientHeight * this.scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.draw();
  }

  draw() {
    if (!this.ok) return;
    const gl = this.gl, u = this.u, p = this.params;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.uPhase, this.phase);
    gl.uniform1f(u.uPulseT, this.pulseT);
    gl.uniform1f(u.uPulse, p.pulse);
    gl.uniform1f(u.uArms, p.arms);
    gl.uniform1f(u.uTwist, p.twist);
    gl.uniform1f(u.uSoft, p.soft);
    gl.uniform1f(u.uCut, p.cut ? 1 : 0);
    gl.uniform1f(u.uMode, p.mode || 0);
    gl.uniform3fv(u.uA, p.a);
    gl.uniform3fv(u.uB, p.b);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  start() {
    if (!this.ok || this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this.loop);
  }

  stop() { this.running = false; }

  loop(now) {
    if (!this.running) return;
    requestAnimationFrame(this.loop);
    const minDt = this.fps > 0 ? 1000 / this.fps : 0;
    if (now - this.last < minDt - 1) return;
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    this.phase += dt * this.params.speed * this.params.dir;
    this.pulseT += dt;
    this.draw();
  }
}
