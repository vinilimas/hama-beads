/*
 * export.js
 * --------------------------------------------------------------------------
 * Exportação do molde:
 *   - PNG: baixa qualquer canvas como imagem.
 *   - PDF / impressão: abre uma janela com layout paginado em A4 e dispara a
 *     impressão do navegador (o usuário escolhe "Salvar como PDF"). Pode dividir
 *     a grade em quadrantes/páginas para imprimir grande e legível.
 *
 * Tudo offline: as imagens vão embutidas como data URL, sem rede.
 * --------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  /** Baixa um canvas como PNG. */
  function downloadCanvasPNG(canvas, filename) {
    canvas.toBlob(function (blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'molde.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  }

  function tintToWhite(r, g, b, t) {
    return {
      r: Math.round(r + (255 - r) * t),
      g: Math.round(g + (255 - g) * t),
      b: Math.round(b + (255 - b) * t),
    };
  }

  /**
   * Desenha uma REGIÃO do grid (modo código) num canvas próprio, com numeração
   * absoluta nos eixos e linhas-guia alinhadas a múltiplos de guideEvery.
   * Usado para montar as páginas/quadrantes de impressão.
   */
  function drawGridRegion(grid, x0, y0, x1, y1, cellSize, guideEvery, tint) {
    const { colors, assign, w } = grid;
    const cols = x1 - x0;
    const rows = y1 - y0;
    const cell = cellSize;
    const margin = Math.max(18, Math.round(cell * 1.2));
    tint = tint == null ? 0.82 : tint;

    const canvas = document.createElement('canvas');
    canvas.width = cols * cell + margin;
    canvas.height = rows * cell + margin;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const ox = margin, oy = margin;

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const a = assign[y * w + x];
        const px = ox + (x - x0) * cell;
        const py = oy + (y - y0) * cell;
        if (a < 0) continue;
        const c = colors[a];
        const t = tintToWhite(c.r, c.g, c.b, tint);
        ctx.fillStyle = 'rgb(' + t.r + ',' + t.g + ',' + t.b + ')';
        ctx.fillRect(px, py, cell, cell);
        ctx.fillStyle = '#1a1a1a';
        ctx.font =
          Math.max(7, Math.floor(cell * 0.42)) + 'px ui-monospace, Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(c.code, px + cell / 2, py + cell / 2 + 0.5);
      }
    }

    // Linhas finas
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= cols; x++) {
      const px = Math.floor(ox + x * cell) + 0.5;
      ctx.moveTo(px, oy); ctx.lineTo(px, oy + rows * cell);
    }
    for (let y = 0; y <= rows; y++) {
      const py = Math.floor(oy + y * cell) + 0.5;
      ctx.moveTo(ox, py); ctx.lineTo(ox + cols * cell, py);
    }
    ctx.stroke();

    // Linhas-guia (alinhadas ao grid absoluto)
    if (guideEvery > 0) {
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let x = x0; x <= x1; x++) {
        if (x % guideEvery !== 0 && x !== x0 && x !== x1) continue;
        const px = Math.floor(ox + (x - x0) * cell) + 0.5;
        ctx.moveTo(px, oy); ctx.lineTo(px, oy + rows * cell);
      }
      for (let y = y0; y <= y1; y++) {
        if (y % guideEvery !== 0 && y !== y0 && y !== y1) continue;
        const py = Math.floor(oy + (y - y0) * cell) + 0.5;
        ctx.moveTo(ox, py); ctx.lineTo(ox + cols * cell, py);
      }
      ctx.stroke();
    }

    // Numeração absoluta dos eixos
    ctx.fillStyle = '#333';
    ctx.font = Math.max(9, Math.floor(margin * 0.5)) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let x = x0; x < x1; x++) {
      if (x % guideEvery === 0 || x === x0) {
        ctx.fillText(String(x), ox + (x - x0) * cell + cell / 2, oy / 2);
      }
    }
    for (let y = y0; y < y1; y++) {
      if (y % guideEvery === 0 || y === y0) {
        ctx.fillText(String(y), ox / 2, oy + (y - y0) * cell + cell / 2);
      }
    }

    return canvas;
  }

  /**
   * Monta e abre a janela de impressão paginada.
   * @param grid
   * @param statsObj  resultado de HBPipeline.colorStats (para a legenda)
   * @param opts {
   *   title:string,
   *   split:'single'|'tiles',
   *   cellsPerPage:number,         // tamanho do quadrante (modo 'tiles')
   *   guideEvery:number,
   *   colorPreviewCanvas:canvas,   // opcional: página de preview colorido
   *   includeLegend:boolean
   * }
   */
  function openPrintable(grid, statsObj, opts) {
    opts = opts || {};
    const guideEvery = opts.guideEvery == null ? 10 : opts.guideEvery;
    const pages = [];

    // Página 1 (opcional): preview colorido.
    if (opts.colorPreviewCanvas) {
      pages.push(
        '<section class="page"><h2>Preview colorido</h2>' +
        '<img class="fit" src="' + opts.colorPreviewCanvas.toDataURL('image/png') + '"></section>'
      );
    }

    // Legenda.
    if (opts.includeLegend !== false && statsObj) {
      let rows = '';
      statsObj.stats.forEach(function (s) {
        rows +=
          '<tr><td><span class="sw" style="background:' + s.color.hex + '"></span></td>' +
          '<td class="code">' + s.color.code + '</td>' +
          '<td>' + (s.color.name || '') + '</td>' +
          '<td class="num">' + s.count + '</td></tr>';
      });
      pages.push(
        '<section class="page"><h2>Legenda — miçangas por cor</h2>' +
        '<p>Total de miçangas: <b>' + statsObj.total + '</b> &middot; Cores: <b>' +
        statsObj.stats.length + '</b></p>' +
        '<table class="legend"><thead><tr><th></th><th>Código</th><th>Cor</th>' +
        '<th class="num">Qtd.</th></tr></thead><tbody>' + rows +
        '</tbody></table></section>'
      );
    }

    // Páginas do molde por código.
    const cell = 26; // px por célula na impressão (legível)
    if (opts.split === 'tiles') {
      const tile = Math.max(10, opts.cellsPerPage || 26);
      for (let y0 = 0; y0 < grid.h; y0 += tile) {
        for (let x0 = 0; x0 < grid.w; x0 += tile) {
          const x1 = Math.min(grid.w, x0 + tile);
          const y1 = Math.min(grid.h, y0 + tile);
          const cv = drawGridRegion(grid, x0, y0, x1, y1, cell, guideEvery);
          pages.push(
            '<section class="page"><h2>Molde — colunas ' + x0 + '–' + (x1 - 1) +
            ', linhas ' + y0 + '–' + (y1 - 1) + '</h2>' +
            '<img class="fit" src="' + cv.toDataURL('image/png') + '"></section>'
          );
        }
      }
    } else {
      const cv = drawGridRegion(grid, 0, 0, grid.w, grid.h, cell, guideEvery);
      pages.push(
        '<section class="page"><h2>Molde por código</h2>' +
        '<img class="fit" src="' + cv.toDataURL('image/png') + '"></section>'
      );
    }

    const html =
      '<!doctype html><html lang="pt-br"><head><meta charset="utf-8">' +
      '<title>' + (opts.title || 'Molde Hama Beads') + '</title><style>' +
      '@page{size:A4;margin:10mm;}' +
      '*{box-sizing:border-box;}' +
      'body{font-family:system-ui,Arial,sans-serif;color:#111;margin:0;}' +
      '.page{page-break-after:always;padding:0 0 8mm;}' +
      '.page:last-child{page-break-after:auto;}' +
      'h2{font-size:14pt;margin:0 0 6px;}' +
      'img.fit{width:100%;height:auto;border:1px solid #ccc;}' +
      'table.legend{border-collapse:collapse;width:100%;font-size:11pt;}' +
      'table.legend th,table.legend td{border:1px solid #ddd;padding:4px 8px;text-align:left;}' +
      'table.legend td.code{font-family:monospace;font-weight:bold;}' +
      'table.legend .num{text-align:right;}' +
      '.sw{display:inline-block;width:18px;height:18px;border:1px solid #999;vertical-align:middle;}' +
      '.hint{padding:10px;background:#f3f3f3;font-size:10pt;}' +
      '@media print{.hint{display:none;}}' +
      '</style></head><body>' +
      '<div class="hint">Use o diálogo de impressão e escolha <b>Salvar como PDF</b>. ' +
      'Esta dica não aparece no PDF.</div>' +
      pages.join('') +
      '<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},300);});<\/script>' +
      '</body></html>';

    const win = window.open('', '_blank');
    if (!win) {
      alert('Permita pop-ups para gerar o PDF/impressão.');
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
  }

  global.HBExport = {
    downloadCanvasPNG,
    openPrintable,
    drawGridRegion,
  };
})(window);
