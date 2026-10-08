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
      speed: 0.6, arms: 6, twist: 8, soft: 0.35, pulse: 0.3, dir: 1, cut: false,
      a: [0.56, 0.42, 1.0], b: [0.05, 0.03, 0.13]
    };
    this.loop = this.loop.bind(this);

    const gl = canvas.getContext('webgl', { antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
    if (!gl) return;
    this.gl = gl;

    const vs = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
    const fs = `
      precision mediump float;
      uniform vec2 uRes;
      uniform float uPhase, uPulseT, uPulse, uArms, uTwist, uSoft, uCut;
      uniform vec3 uA, uB;
      void main() {
        vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / min(uRes.x, uRes.y);
        float r = length(p);
        float a = atan(p.y, p.x);
        float k = 1.0 + uPulse * 0.35 * sin(uPulseT * 1.6);
        float phase = uArms * a / 6.2831853 + uTwist * r * k - uPhase;
        float w = sin(phase * 6.2831853);
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
    for (const n of ['uRes', 'uPhase', 'uPulseT', 'uPulse', 'uArms', 'uTwist', 'uSoft', 'uCut', 'uA', 'uB']) {
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
