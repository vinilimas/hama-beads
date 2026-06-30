/*
 * colors.js
 * --------------------------------------------------------------------------
 * Conversões de espaço de cor e distância perceptual (Delta-E CIEDE2000).
 *
 * Por que CIELAB + Delta-E 2000 em vez de distância RGB euclidiana?
 * Porque "qual miçanga é mais parecida com esta cor?" é uma pergunta sobre
 * percepção humana, e o espaço RGB não é perceptualmente uniforme. No RGB,
 * duas cores com distância pequena podem parecer muito diferentes aos olhos
 * (e vice-versa). O espaço CIELAB foi projetado para que a distância numérica
 * se aproxime da diferença percebida, e o Delta-E 2000 é o refinamento padrão
 * da indústria para isso.
 *
 * Tudo aqui é matemática pura e determinística — nenhuma chamada de rede,
 * nenhuma IA. Roda igual em qualquer navegador, offline.
 * --------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  // ----- Utilidades hex <-> rgb -------------------------------------------

  /** "#4CAF50" -> {r,g,b} (0..255). Aceita com ou sem '#', 3 ou 6 dígitos. */
  function hexToRgb(hex) {
    if (typeof hex !== 'string') return { r: 0, g: 0, b: 0 };
    let h = hex.trim().replace(/^#/, '');
    if (h.length === 3) {
      h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) {
      return { r: 0, g: 0, b: 0 };
    }
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  /** {r,g,b} (0..255) -> "#rrggbb" */
  function rgbToHex(r, g, b) {
    const c = (v) => {
      const n = Math.max(0, Math.min(255, Math.round(v)));
      return n.toString(16).padStart(2, '0');
    };
    return '#' + c(r) + c(g) + c(b);
  }

  // ----- sRGB -> CIELAB ----------------------------------------------------
  // Referência: D65, observador 2°.

  /** Converte um canal sRGB (0..1) para luz linear. */
  function srgbToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  /** RGB (0..255) -> XYZ (escala 0..100, branco D65). */
  function rgbToXyz(r, g, b) {
    const R = srgbToLinear(r / 255);
    const G = srgbToLinear(g / 255);
    const B = srgbToLinear(b / 255);
    // Matriz sRGB -> XYZ (D65), resultado em 0..100.
    return {
      x: (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) * 100,
      y: (R * 0.2126729 + G * 0.7151522 + B * 0.0721750) * 100,
      z: (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) * 100,
    };
  }

  // Ponto branco de referência D65.
  const REF_X = 95.047;
  const REF_Y = 100.0;
  const REF_Z = 108.883;

  function xyzToLab(x, y, z) {
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const fx = f(x / REF_X);
    const fy = f(y / REF_Y);
    const fz = f(z / REF_Z);
    return {
      L: 116 * fy - 16,
      a: 500 * (fx - fy),
      b: 200 * (fy - fz),
    };
  }

  /** Atalho RGB (0..255) -> {L,a,b}. */
  function rgbToLab(r, g, b) {
    const xyz = rgbToXyz(r, g, b);
    return xyzToLab(xyz.x, xyz.y, xyz.z);
  }

  // ----- Delta-E CIEDE2000 -------------------------------------------------
  // Implementação padrão (Sharma et al.). Recebe dois objetos {L,a,b}.

  function deltaE2000(lab1, lab2) {
    const L1 = lab1.L, a1 = lab1.a, b1 = lab1.b;
    const L2 = lab2.L, a2 = lab2.a, b2 = lab2.b;

    const kL = 1, kC = 1, kH = 1;
    const deg2rad = Math.PI / 180;
    const rad2deg = 180 / Math.PI;

    const C1 = Math.sqrt(a1 * a1 + b1 * b1);
    const C2 = Math.sqrt(a2 * a2 + b2 * b2);
    const avgC = (C1 + C2) / 2;

    const C7 = Math.pow(avgC, 7);
    const G = 0.5 * (1 - Math.sqrt(C7 / (C7 + 6103515625))); // 25^7 = 6103515625

    const a1p = a1 * (1 + G);
    const a2p = a2 * (1 + G);

    const C1p = Math.sqrt(a1p * a1p + b1 * b1);
    const C2p = Math.sqrt(a2p * a2p + b2 * b2);

    let h1p = Math.atan2(b1, a1p) * rad2deg;
    if (h1p < 0) h1p += 360;
    let h2p = Math.atan2(b2, a2p) * rad2deg;
    if (h2p < 0) h2p += 360;

    const dLp = L2 - L1;
    const dCp = C2p - C1p;

    let dhp;
    if (C1p * C2p === 0) {
      dhp = 0;
    } else if (Math.abs(h2p - h1p) <= 180) {
      dhp = h2p - h1p;
    } else if (h2p - h1p > 180) {
      dhp = h2p - h1p - 360;
    } else {
      dhp = h2p - h1p + 360;
    }
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * deg2rad) / 2);

    const avgLp = (L1 + L2) / 2;
    const avgCp = (C1p + C2p) / 2;

    let avghp;
    if (C1p * C2p === 0) {
      avghp = h1p + h2p;
    } else if (Math.abs(h1p - h2p) <= 180) {
      avghp = (h1p + h2p) / 2;
    } else if (h1p + h2p < 360) {
      avghp = (h1p + h2p + 360) / 2;
    } else {
      avghp = (h1p + h2p - 360) / 2;
    }

    const T =
      1 -
      0.17 * Math.cos((avghp - 30) * deg2rad) +
      0.24 * Math.cos(2 * avghp * deg2rad) +
      0.32 * Math.cos((3 * avghp + 6) * deg2rad) -
      0.20 * Math.cos((4 * avghp - 63) * deg2rad);

    const dTheta = 30 * Math.exp(-Math.pow((avghp - 275) / 25, 2));
    const avgCp7 = Math.pow(avgCp, 7);
    const RC = 2 * Math.sqrt(avgCp7 / (avgCp7 + 6103515625));
    const SL =
      1 + (0.015 * Math.pow(avgLp - 50, 2)) / Math.sqrt(20 + Math.pow(avgLp - 50, 2));
    const SC = 1 + 0.045 * avgCp;
    const SH = 1 + 0.015 * avgCp * T;
    const RT = -Math.sin(2 * dTheta * deg2rad) * RC;

    const termL = dLp / (kL * SL);
    const termC = dCp / (kC * SC);
    const termH = dHp / (kH * SH);

    return Math.sqrt(
      termL * termL + termC * termC + termH * termH + RT * termC * termH
    );
  }

  /**
   * Distância euclidiana ao quadrado entre dois pontos Lab.
   * Usada no agrupamento interno (k-means/median-cut), onde precisamos de uma
   * métrica rápida e estável — não da fidelidade perceptual fina do Delta-E
   * 2000. O casamento FINAL com a paleta de miçangas continua usando
   * deltaE2000 (perceptualmente correto). Como é só comparação relativa, o
   * quadrado evita a raiz e é suficiente.
   */
  function labDist2(lab1, lab2) {
    const dL = lab1.L - lab2.L;
    const da = lab1.a - lab2.a;
    const db = lab1.b - lab2.b;
    return dL * dL + da * da + db * db;
  }

  global.HBColors = {
    hexToRgb,
    rgbToHex,
    rgbToLab,
    deltaE2000,
    labDist2,
  };
})(window);
