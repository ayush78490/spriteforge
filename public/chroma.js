// Chroma key shared by the server (Node) and the browser (live preview), so what you
// see in the tuner is exactly what gets exported.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Chroma = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const KEYS = {
    green: { hex: "#00FF00", rgb: [0, 255, 0] },
    magenta: { hex: "#FF00FF", rgb: [255, 0, 255] },
    blue: { hex: "#0000FF", rgb: [0, 0, 255] },
  };

  // "How much of the key colour is in this pixel" (0 = none), per key.
  function keyness(key, r, g, b) {
    if (key === "magenta") return Math.min(r, b) - g;
    if (key === "blue") return b - Math.max(r, g);
    return g - Math.max(r, b); // green
  }

  /**
   * Key a frame in place.
   * data: RGBA bytes (Uint8ClampedArray | Buffer), w/h: size
   * opts: { key, tolerance (0-255), softness (1-255), despill (0-1), cleanup (0-255 alpha floor) }
   */
  function keyFrame(data, w, h, opts = {}) {
    const key = opts.key || "green";
    const tol = opts.tolerance == null ? 40 : +opts.tolerance;
    const soft = Math.max(1, opts.softness == null ? 50 : +opts.softness);
    const despill = opts.despill == null ? 0.85 : +opts.despill;
    const floor = opts.cleanup == null ? 12 : +opts.cleanup;
    for (let i = 0, n = w * h * 4; i < n; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const k = keyness(key, r, g, b);
      let a = 1;
      if (k > tol) a = Math.max(0, 1 - (k - tol) / soft);
      // despill: pull the key channel(s) back toward the others on edges / reflections
      if (k > 0 && despill > 0) {
        const d = k * despill;
        if (key === "green") data[i + 1] = g - d;
        else if (key === "blue") data[i + 2] = b - d;
        else { data[i] = r - d; data[i + 2] = b - d; }
      }
      let alpha = Math.round(a * data[i + 3]);
      if (alpha < floor) alpha = 0;
      data[i + 3] = alpha;
    }
    return data;
  }

  /** Bounding box of pixels with alpha > thr, or null. */
  function alphaBBox(data, w, h, thr = 40) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      for (let x = 0; x < w; x++) {
        if (data[row + x * 4 + 3] > thr) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
  }

  return { KEYS, keyFrame, keyness, alphaBBox };
});
