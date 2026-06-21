/*
 * render.js
 * --------------------------------------------------------------------------
 * Desenha o grid em um <canvas>, em dois modos:
 *   - 'color': preview colorido com as cores reais das miçangas.
 *   - 'code' : molde "colorir por código" — cada célula com um leve tom da cor
 *              e o CÓDIGO escrito (B3, C5...), pronto para imprimir.
 *
 * Recursos comuns: linhas finas a cada célula, linhas-guia grossas a cada
 * `guideEvery` células (padrão 10, estilo ponto-cruz) e numeração dos eixos
 * para facilitar a contagem na montagem.
 * --------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  /** Escolhe texto preto ou branco conforme a luminância do fundo. */
  function contrastInk(r, g, b) {
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return lum > 140 ? '#111' : '#fff';
  }

  /** Mistura uma cor com branco (t=0 -> cor cheia, t=1 -> branco). */
  function tintToWhite(r, g, b, t) {
    return {
      r: Math.round(r + (255 - r) * t),
      g: Math.round(g + (255 - g) * t),
      b: Math.round(b + (255 - b) * t),
    };
  }

  /**
   * Desenha o grid no canvas.
   * @param {HTMLCanvasElement} canvas
   * @param grid resultado de HBPipeline.buildGrid
   * @param opts {
   *   mode:'color'|'code',
   *   cellSize:number,        // px por célula
   *   showGrid:boolean,       // linhas finas por célula
   *   guideEvery:number,      // linhas-guia grossas (0 = nenhuma)
   *   showAxes:boolean,       // numeração nas bordas
   *   tint:number             // (modo code) 0..1 de tom da cor; padrão 0.82
   * }
   */
  function drawGrid(canvas, grid, opts) {
    opts = opts || {};
    const mode = opts.mode || 'color';
    const cell = Math.max(2, opts.cellSize || 14);
    const showGrid = opts.showGrid !== false;
    const guideEvery = opts.guideEvery == null ? 10 : opts.guideEvery;
    const showAxes = !!opts.showAxes && mode === 'code';
    const tint = opts.tint == null ? 0.82 : opts.tint;

    const { w, h, colors, assign } = grid;
    const margin = showAxes ? Math.max(16, Math.round(cell * 1.4)) : 0;

    canvas.width = w * cell + margin;
    canvas.height = h * cell + margin;
    const ctx = canvas.getContext('2d');

    // Fundo branco (importante para impressão).
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const ox = margin; // deslocamento por causa dos eixos
    const oy = margin;

    // Células
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = assign[y * w + x];
        const px = ox + x * cell;
        const py = oy + y * cell;
        if (a < 0) continue; // célula vazia: fica branca

        const c = colors[a];
        if (mode === 'color') {
          ctx.fillStyle = c.hex;
          ctx.fillRect(px, py, cell, cell);
        } else {
          // modo código: leve tom + texto
          const t = tintToWhite(c.r, c.g, c.b, tint);
          ctx.fillStyle = 'rgb(' + t.r + ',' + t.g + ',' + t.b + ')';
          ctx.fillRect(px, py, cell, cell);

          if (cell >= 10) {
            ctx.fillStyle = '#1a1a1a';
            ctx.font =
              Math.max(6, Math.floor(cell * 0.42)) +
              'px ui-monospace, Menlo, Consolas, monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(c.code, px + cell / 2, py + cell / 2 + 0.5);
          }
        }
      }
    }

    // ===== Camada de MONTAGEM (foco de cor, linha atual, células feitas) =====
    // Tudo opcional; só roda quando o modo montagem passa essas opções.
    const focusIndex = opts.focusIndex;
    const activeRow = opts.activeRow;
    const progress = opts.progress;
    if (focusIndex != null || activeRow != null || progress) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      for (let y = 0; y < h; y++) {
        const rowMuted = activeRow != null && y !== activeRow;
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const a = assign[i];
          const px = ox + x * cell;
          const py = oy + y * cell;

          // Esmaece o que não é o foco (cor focada / linha atual).
          let muted = rowMuted;
          if (focusIndex != null && a !== focusIndex) muted = true;
          if (muted) {
            ctx.fillStyle = 'rgba(18,18,24,0.72)';
            ctx.fillRect(px, py, cell, cell);
          }

          // Marca células já colocadas (check) sobre um leve escurecido.
          if (progress && progress[i] && a >= 0) {
            ctx.fillStyle = 'rgba(0,0,0,0.42)';
            ctx.fillRect(px, py, cell, cell);
            if (cell >= 8) {
              ctx.fillStyle = 'rgba(120,235,120,0.95)';
              ctx.font = 'bold ' + Math.max(7, Math.floor(cell * 0.55)) + 'px sans-serif';
              ctx.fillText('✓', px + 1, py);
            }
          }
        }
      }
    }

    // Linhas finas por célula
    if (showGrid && cell >= 4) {
      ctx.strokeStyle = mode === 'code' ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= w; x++) {
        const px = Math.floor(ox + x * cell) + 0.5;
        ctx.moveTo(px, oy);
        ctx.lineTo(px, oy + h * cell);
      }
      for (let y = 0; y <= h; y++) {
        const py = Math.floor(oy + y * cell) + 0.5;
        ctx.moveTo(ox, py);
        ctx.lineTo(ox + w * cell, py);
      }
      ctx.stroke();
    }

    // Linhas-guia grossas a cada guideEvery células
    if (guideEvery > 0) {
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let x = 0; x <= w; x += guideEvery) {
        const px = Math.floor(ox + x * cell) + 0.5;
        ctx.moveTo(px, oy);
        ctx.lineTo(px, oy + h * cell);
      }
      for (let y = 0; y <= h; y += guideEvery) {
        const py = Math.floor(oy + y * cell) + 0.5;
        ctx.moveTo(ox, py);
        ctx.lineTo(ox + w * cell, py);
      }
      // Bordas externas sempre fechadas
      ctx.moveTo(ox + 0.5, oy + 0.5);
      ctx.lineTo(ox + w * cell + 0.5, oy + 0.5);
      ctx.lineTo(ox + w * cell + 0.5, oy + h * cell + 0.5);
      ctx.lineTo(ox + 0.5, oy + h * cell + 0.5);
      ctx.lineTo(ox + 0.5, oy + 0.5);
      ctx.stroke();
    }

    // Círculo de referência da bandeja física (guia gravado na placa real).
    // É só visual: marca a área circular central de `trayDiameter` pinos.
    if (opts.trayDiameter && opts.trayDiameter > 0) {
      const d = opts.trayDiameter;
      const cx = ox + (w / 2) * cell;
      const cy = oy + (h / 2) * cell;
      const r = (d / 2) * cell;
      ctx.save();
      ctx.lineWidth = Math.max(2, cell * 0.16);
      ctx.setLineDash([Math.max(3, cell * 0.6), Math.max(2, cell * 0.45)]);
      // Halo branco por baixo para destacar sobre qualquer cor.
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      // Linha vermelha por cima.
      ctx.lineDashOffset = Math.max(3, cell * 0.6);
      ctx.strokeStyle = 'rgba(220,40,40,0.95)';
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Numeração dos eixos (modo código)
    if (showAxes) {
      ctx.fillStyle = '#444';
      ctx.font = Math.max(8, Math.floor(margin * 0.5)) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let x = 0; x < w; x += guideEvery || 10) {
        ctx.fillText(String(x), ox + x * cell + cell / 2, oy / 2);
      }
      ctx.textAlign = 'center';
      for (let y = 0; y < h; y += guideEvery || 10) {
        ctx.fillText(String(y), ox / 2, oy + y * cell + cell / 2);
      }
    }

    return canvas;
  }

  global.HBRender = {
    drawGrid,
    contrastInk,
  };
})(window);
