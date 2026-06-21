/*
 * imaging.js
 * --------------------------------------------------------------------------
 * Pré-processamento clássico de imagem (tudo em Canvas/ImageData, sem IA).
 * Objetivo: deixar a foto mais "cartoon" e fácil de virar pixel art antes de
 * reduzir para a grade.
 *
 * Filtros disponíveis:
 *   - ajustes(brilho, contraste, saturação)
 *   - posterize(níveis)           -> reduz a quantidade de tons por canal
 *   - medianBlur(raio)            -> suaviza preservando bordas (estilo cartoon)
 *
 * Todos operam sobre ImageData (Uint8ClampedArray rgba) in-place ou retornando
 * um novo ImageData, conforme indicado.
 * --------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  function clamp255(v) {
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }

  /**
   * Ajusta brilho, contraste e saturação in-place.
   * @param {ImageData} img
   * @param {number} brightness  -100..100 (0 = neutro)
   * @param {number} contrast    -100..100 (0 = neutro)
   * @param {number} saturation  -100..100 (0 = neutro)
   */
  function adjust(img, brightness, contrast, saturation) {
    const d = img.data;
    const b = brightness;                       // deslocamento direto em 0..255
    // Fator de contraste padrão (curva em torno de 128).
    const c = contrast;
    const cf = (259 * (c + 255)) / (255 * (259 - c));
    const sat = 1 + saturation / 100;           // 0 = cinza, 1 = normal, 2 = vívido

    for (let i = 0; i < d.length; i += 4) {
      let r = d[i], g = d[i + 1], bl = d[i + 2];

      // brilho
      r += b; g += b; bl += b;

      // contraste
      r = cf * (r - 128) + 128;
      g = cf * (g - 128) + 128;
      bl = cf * (bl - 128) + 128;

      // saturação (mistura com a luminância)
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      r = lum + (r - lum) * sat;
      g = lum + (g - lum) * sat;
      bl = lum + (bl - lum) * sat;

      d[i] = clamp255(r);
      d[i + 1] = clamp255(g);
      d[i + 2] = clamp255(bl);
    }
    return img;
  }

  /**
   * Posterização: reduz cada canal a `levels` níveis. Quanto menor, mais
   * "achatada" e cartoon a imagem fica. levels=2..32; <=1 não faz nada.
   */
  function posterize(img, levels) {
    if (!levels || levels >= 256) return img;
    const d = img.data;
    const step = 255 / (levels - 1);
    // Tabela de lookup para velocidade.
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) {
      lut[v] = Math.round(Math.round(v / step) * step);
    }
    for (let i = 0; i < d.length; i += 4) {
      d[i] = lut[d[i]];
      d[i + 1] = lut[d[i + 1]];
      d[i + 2] = lut[d[i + 2]];
    }
    return img;
  }

  /**
   * Median blur quadrado de raio `radius`. Suaviza ruído preservando bordas,
   * dando aparência de desenho. Retorna um NOVO ImageData (não altera a fonte).
   * radius 0 = sem efeito. Mantém o canal alpha original.
   *
   * Implementação direta O(w*h*k^2). Como rodamos num canvas de trabalho de
   * resolução moderada (~512px), o custo é aceitável e o código fica simples.
   */
  function medianBlur(img, radius) {
    if (!radius || radius < 1) return img;
    const w = img.width, h = img.height;
    const src = img.data;
    const out = new ImageData(w, h);
    const dst = out.data;
    const win = (2 * radius + 1) * (2 * radius + 1);
    const half = win >> 1;
    const rArr = new Uint8Array(win);
    const gArr = new Uint8Array(win);
    const bArr = new Uint8Array(win);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let n = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = Math.min(w - 1, Math.max(0, x + dx));
            const idx = (yy * w + xx) * 4;
            rArr[n] = src[idx];
            gArr[n] = src[idx + 1];
            bArr[n] = src[idx + 2];
            n++;
          }
        }
        // Mediana via ordenação parcial (n pequeno).
        const oi = (y * w + x) * 4;
        dst[oi] = quickMedian(rArr, n, half);
        dst[oi + 1] = quickMedian(gArr, n, half);
        dst[oi + 2] = quickMedian(bArr, n, half);
        dst[oi + 3] = src[oi + 3];
      }
    }
    return out;
  }

  /** Mediana por ordenação simples de um array pequeno (cópia local). */
  function quickMedian(arr, n, half) {
    // n é pequeno (<= 81), insertion sort é rápido e sem alocação.
    const a = arr.slice(0, n);
    for (let i = 1; i < n; i++) {
      const v = a[i];
      let j = i - 1;
      while (j >= 0 && a[j] > v) {
        a[j + 1] = a[j];
        j--;
      }
      a[j + 1] = v;
    }
    return a[half];
  }

  global.HBImaging = {
    adjust,
    posterize,
    medianBlur,
  };
})(window);
