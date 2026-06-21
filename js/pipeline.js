/*
 * pipeline.js
 * --------------------------------------------------------------------------
 * Núcleo da conversão foto -> molde de hama beads. Trabalha em duas camadas:
 *
 *   ETAPA A (cara): sampleGrid()
 *     Recebe o canvas já cortado em quadrado e pré-processado, e reduz para a
 *     grade NxN tirando a média de cada região (1 célula = 1 miçanga).
 *     Guardamos a cor média (RGB) e o alpha de cada célula.
 *
 *   ETAPA B (barata): buildGrid()
 *     A partir das cores amostradas, mapeia cada célula para a miçanga mais
 *     próxima (Delta-E 2000), com dithering opcional, limite de cores e
 *     tratamento de fundo. Só esta etapa roda quando o usuário mexe na paleta,
 *     no dithering ou no limite de cores — por isso é rápido / tempo real.
 *
 * Resultado (objeto "grid"):
 *   { w, h, colors:[{code,hex,r,g,b,lab,...}], assign: Int16Array(w*h) }
 *   assign[i] = índice em colors[], ou -1 para célula vazia (fundo removido).
 * --------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  /**
   * ETAPA A — Reduz o canvas de origem para a grade, com média por célula.
   * Usa o downscale do próprio Canvas (imageSmoothing = média de área),
   * que é rápido e dá boa amostragem.
   * @returns {{w,h, rgb:Float32Array, alpha:Float32Array, lab:Array}}
   */
  function sampleGrid(srcCanvas, gridW, gridH, method) {
    if (method === 'dominant') return sampleGridDominant(srcCanvas, gridW, gridH);

    // Método 'average' (padrão): média de área via downscale do Canvas.
    // Bom para fotos e gradientes, onde a média representa bem a região.
    const off = document.createElement('canvas');
    off.width = gridW;
    off.height = gridH;
    const ctx = off.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, gridW, gridH);
    ctx.drawImage(srcCanvas, 0, 0, gridW, gridH);

    const data = ctx.getImageData(0, 0, gridW, gridH).data;
    const n = gridW * gridH;
    const rgb = new Float32Array(n * 3);
    const alpha = new Float32Array(n);
    const lab = new Array(n);

    for (let i = 0; i < n; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      rgb[i * 3] = r;
      rgb[i * 3 + 1] = g;
      rgb[i * 3 + 2] = b;
      alpha[i] = data[i * 4 + 3];
      lab[i] = HBColors.rgbToLab(r, g, b);
    }
    return { w: gridW, h: gridH, rgb, alpha, lab };
  }

  /**
   * Amostragem por COR DOMINANTE (modo/voto da maioria) de cada célula.
   *
   * Para arte chapada / pixel art (poucas cores planas), a média de área mistura
   * cores nas bordas e cria tons "sujos" intermediários — que viram cores extras
   * na paleta. Aqui, cada célula recebe a cor que MAIS aparece na sua região, em
   * vez da média. Resultado: bordas limpas e bem menos cores (o rosa continua
   * rosa, o contorno continua preto, e detalhes pequenos como o amarelo são
   * preservados se forem dominantes na sua célula).
   *
   * O modo é calculado em "baldes" de cor (quantização de 5 bits por canal) para
   * agrupar pixels quase iguais; a cor representativa do balde vencedor é a média
   * dos pixels reais dele (fica fiel à cor chapada original).
   */
  function sampleGridDominant(srcCanvas, gridW, gridH) {
    const sw = srcCanvas.width, sh = srcCanvas.height;
    const ctx = srcCanvas.getContext('2d', { willReadFrequently: true });
    const data = ctx.getImageData(0, 0, sw, sh).data;

    const n = gridW * gridH;
    const rgb = new Float32Array(n * 3);
    const alpha = new Float32Array(n);
    const lab = new Array(n);

    for (let gy = 0; gy < gridH; gy++) {
      const y0 = Math.floor((gy * sh) / gridH);
      const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * sh) / gridH));
      for (let gx = 0; gx < gridW; gx++) {
        const x0 = Math.floor((gx * sw) / gridW);
        const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * sw) / gridW));

        // Conta os baldes de cor dentro da célula; guarda soma p/ a média do balde.
        const sums = new Map(); // key -> [rSum, gSum, bSum, count]
        let aSum = 0, aN = 0;
        let bestKey = -1, bestCount = 0;

        for (let y = y0; y < y1; y++) {
          let idx = (y * sw + x0) * 4;
          for (let x = x0; x < x1; x++, idx += 4) {
            const r = data[idx], g = data[idx + 1], b = data[idx + 2];
            aSum += data[idx + 3]; aN++;
            const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
            let s = sums.get(key);
            if (!s) { s = [0, 0, 0, 0]; sums.set(key, s); }
            s[0] += r; s[1] += g; s[2] += b; s[3]++;
            if (s[3] > bestCount) { bestCount = s[3]; bestKey = key; }
          }
        }

        const i = gy * gridW + gx;
        let r = 0, g = 0, b = 0;
        if (bestKey >= 0) {
          const s = sums.get(bestKey);
          r = s[0] / s[3]; g = s[1] / s[3]; b = s[2] / s[3];
        }
        rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
        alpha[i] = aN ? aSum / aN : 0;
        lab[i] = HBColors.rgbToLab(r, g, b);
      }
    }
    return { w: gridW, h: gridH, rgb, alpha, lab };
  }

  /**
   * Encaixa um grid (a imagem convertida) CENTRALIZADO numa bandeja boardW×boardH,
   * deixando o resto vazio (-1). A bandeja é sempre 52×52; o que muda é o tamanho
   * da imagem dentro dela.
   */
  function embedGrid(srcGrid, boardW, boardH) {
    const offX = Math.floor((boardW - srcGrid.w) / 2);
    const offY = Math.floor((boardH - srcGrid.h) / 2);
    const assign = new Int16Array(boardW * boardH).fill(-1);
    for (let y = 0; y < srcGrid.h; y++) {
      const by = offY + y;
      if (by < 0 || by >= boardH) continue;
      for (let x = 0; x < srcGrid.w; x++) {
        const bx = offX + x;
        if (bx < 0 || bx >= boardW) continue;
        assign[by * boardW + bx] = srcGrid.assign[y * srcGrid.w + x];
      }
    }
    return { w: boardW, h: boardH, colors: srcGrid.colors, assign };
  }

  /** Índice da cor mais próxima (Delta-E 2000) dentro de `colors`. */
  function nearestColorIndex(lab, colors) {
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < colors.length; k++) {
      const d = HBColors.deltaE2000(lab, colors[k].lab);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best;
  }

  /**
   * Detecta o fundo por CONECTIVIDADE (flood fill a partir das bordas).
   *
   * Só é considerado fundo a área "parecida com o fundo" que está LIGADA à
   * borda da imagem. Isso resolve o caso clássico: um personagem branco sobre
   * fundo branco. O branco de dentro do desenho fica cercado pelo contorno
   * (cores diferentes), então o preenchimento que vem das bordas não o alcança
   * — e ele é mantido. Ou seja: usamos miçanga branca só onde o desenho precisa,
   * e a área de fundo fica vazia (sem miçanga).
   *
   * Uma célula é "parecida com o fundo" se for transparente (alpha baixo) ou se
   * estiver a no máximo `tolerance` (Delta-E) da cor de fundo (média dos cantos).
   *
   * @returns {Uint8Array} máscara (1 = fundo conectado à borda).
   */
  function detectBackgroundMask(sample, tolerance) {
    const { w, h, lab, alpha } = sample;
    const n = w * h;

    // Cor de fundo de referência = média Lab dos 4 cantos.
    const corners = [0, w - 1, (h - 1) * w, n - 1];
    let L = 0, a = 0, b = 0;
    for (const ci of corners) {
      L += lab[ci].L; a += lab[ci].a; b += lab[ci].b;
    }
    const bg = { L: L / 4, a: a / 4, b: b / 4 };

    function isBgLike(i) {
      if (alpha && alpha[i] <= 16) return true;            // transparente
      return HBColors.deltaE2000(lab[i], bg) <= tolerance; // cor de fundo
    }

    const mask = new Uint8Array(n);
    const visited = new Uint8Array(n);
    const stack = [];

    // Semeia o preenchimento por TODAS as células da borda.
    function seed(i) {
      if (visited[i]) return;
      visited[i] = 1;
      if (isBgLike(i)) { mask[i] = 1; stack.push(i); }
    }
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + (w - 1)); }

    // Expande para os 4 vizinhos enquanto continuarem parecidos com o fundo.
    while (stack.length) {
      const i = stack.pop();
      const x = i % w;
      const y = (i / w) | 0;
      if (x > 0) flood(i - 1);
      if (x < w - 1) flood(i + 1);
      if (y > 0) flood(i - w);
      if (y < h - 1) flood(i + w);
    }
    function flood(j) {
      if (visited[j]) return;
      visited[j] = 1;
      if (isBgLike(j)) { mask[j] = 1; stack.push(j); }
    }

    return mask;
  }

  /**
   * ETAPA B — Monta o grid final.
   * @param sample  resultado de sampleGrid()
   * @param activeColors  cores ativas da paleta (cada uma com .lab)
   * @param opts {
   *   dithering:boolean,
   *   maxColors:number|0,           // 0 = sem limite
   *   background:'keep'|'empty'|'color',
   *   backgroundTolerance:number,   // Delta-E
   *   backgroundColorCode:string,   // usado quando background==='color'
   *   alphaThreshold:number         // alpha <= isto vira célula vazia
   * }
   */
  function buildGrid(sample, activeColors, opts) {
    opts = opts || {};
    const { w, h } = sample;
    const n = w * h;
    const colors = activeColors;
    const assign = new Int16Array(n).fill(-1);

    if (colors.length === 0) {
      return { w, h, colors: [], assign };
    }

    // Máscara de fundo (por cor) — só se o tratamento estiver ligado.
    let bgMask = null;
    if (opts.background && opts.background !== 'keep') {
      bgMask = detectBackgroundMask(sample, opts.backgroundTolerance || 12);
    }
    const alphaThreshold = opts.alphaThreshold != null ? opts.alphaThreshold : 16;

    if (opts.dithering) {
      ditherFloydSteinberg(sample, colors, assign, bgMask, alphaThreshold);
    } else {
      for (let i = 0; i < n; i++) {
        if (sample.alpha[i] <= alphaThreshold) continue;           // transparente
        if (bgMask && bgMask[i]) continue;                          // fundo (trata depois)
        assign[i] = nearestColorIndex(sample.lab[i], colors);
      }
    }

    // Tratamento de fundo "pintar de uma cor": atribui um código fixo.
    if (opts.background === 'color' && bgMask) {
      const idx = colors.findIndex((c) => c.code === opts.backgroundColorCode);
      if (idx >= 0) {
        for (let i = 0; i < n; i++) if (bgMask[i]) assign[i] = idx;
      }
    }
    // 'empty' já fica como -1 (não atribuído).

    let grid = { w, h, colors: colors.slice(), assign };

    // Limite de número de cores.
    if (opts.maxColors && opts.maxColors > 0 && opts.maxColors < colors.length) {
      grid = limitColors(grid, opts.maxColors);
    }
    return grid;
  }

  /**
   * Dithering de Floyd–Steinberg. Distribui o erro de quantização para as
   * células vizinhas, criando a ilusão de mais cores com a paleta limitada.
   * O erro é calculado em RGB (suficiente para difusão), enquanto a escolha da
   * cor usa Delta-E em Lab.
   */
  function ditherFloydSteinberg(sample, colors, assign, bgMask, alphaThreshold) {
    const { w, h } = sample;
    // Cópia de trabalho dos valores RGB (vamos somar erro nela).
    const buf = Float32Array.from(sample.rgb);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (sample.alpha[i] <= alphaThreshold) continue;
        if (bgMask && bgMask[i]) continue;

        const r = buf[i * 3], g = buf[i * 3 + 1], b = buf[i * 3 + 2];
        const lab = HBColors.rgbToLab(
          Math.max(0, Math.min(255, r)),
          Math.max(0, Math.min(255, g)),
          Math.max(0, Math.min(255, b))
        );
        const k = nearestColorIndex(lab, colors);
        assign[i] = k;

        const er = r - colors[k].r;
        const eg = g - colors[k].g;
        const eb = b - colors[k].b;

        // Distribui o erro (pesos clássicos 7/16, 3/16, 5/16, 1/16).
        spread(buf, x + 1, y, w, h, er, eg, eb, 7 / 16);
        spread(buf, x - 1, y + 1, w, h, er, eg, eb, 3 / 16);
        spread(buf, x, y + 1, w, h, er, eg, eb, 5 / 16);
        spread(buf, x + 1, y + 1, w, h, er, eg, eb, 1 / 16);
      }
    }
  }

  function spread(buf, x, y, w, h, er, eg, eb, f) {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const j = (y * w + x) * 3;
    buf[j] += er * f;
    buf[j + 1] += eg * f;
    buf[j + 2] += eb * f;
  }

  /**
   * Reduz o molde a no máximo `maxColors` cores. Mantém as mais frequentes e
   * remapeia as demais para a cor mantida mais próxima (Delta-E). Reindexa o
   * grid para conter só as cores efetivamente usadas.
   */
  function limitColors(grid, maxColors) {
    const { w, h, colors, assign } = grid;
    const n = w * h;

    // Conta o uso de cada cor.
    const counts = new Array(colors.length).fill(0);
    for (let i = 0; i < n; i++) {
      const a = assign[i];
      if (a >= 0) counts[a]++;
    }

    // Ordena índices por frequência (desc) e mantém os top N usados.
    const used = [];
    for (let k = 0; k < colors.length; k++) if (counts[k] > 0) used.push(k);
    used.sort((p, q) => counts[q] - counts[p]);
    const keep = used.slice(0, maxColors);
    const keepSet = new Set(keep);

    // Para cada cor removida, acha a substituta mais próxima entre as mantidas.
    const remap = new Array(colors.length).fill(-1);
    keep.forEach((k, newIdx) => (remap[k] = newIdx));
    for (const k of used) {
      if (keepSet.has(k)) continue;
      let best = keep[0], bestD = Infinity;
      for (const m of keep) {
        const d = HBColors.deltaE2000(colors[k].lab, colors[m].lab);
        if (d < bestD) { bestD = d; best = m; }
      }
      remap[k] = remap[best];
    }

    const newColors = keep.map((k) => colors[k]);
    const newAssign = new Int16Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      const a = assign[i];
      if (a >= 0) newAssign[i] = remap[a];
    }
    return { w, h, colors: newColors, assign: newAssign };
  }

  /**
   * Substituição global de cor: troca todas as células de `fromCode` por
   * `toCode`. Opera sobre um grid já montado, reindexando se necessário.
   */
  function replaceColor(grid, fromCode, toCode) {
    const fromIdx = grid.colors.findIndex((c) => c.code === fromCode);
    if (fromIdx < 0) return grid;
    let toIdx = grid.colors.findIndex((c) => c.code === toCode);

    // Se a cor destino não está no grid, adiciona (precisa do objeto de cor).
    if (toIdx < 0) return grid; // destino precisa existir nas cores do grid
    const assign = Int16Array.from(grid.assign);
    for (let i = 0; i < assign.length; i++) {
      if (assign[i] === fromIdx) assign[i] = toIdx;
    }
    return { w: grid.w, h: grid.h, colors: grid.colors.slice(), assign };
  }

  /**
   * Simplificação inteligente: remove "ruído de cor" sem perder detalhes reais.
   *
   * Objetivo do projeto: usar o MENOR número de cores possível sem perder
   * fidelidade. As cores indesejadas costumam ser blends de borda (poucas
   * células, e perceptualmente PRÓXIMAS de uma cor dominante). Já um detalhe
   * legítimo (ex.: 2 células amarelas) é raro mas perceptualmente DISTANTE de
   * tudo. Então a regra para manter uma cor é:
   *   - é frequente (>= dominantFloor)  → mantém; OU
   *   - tem células suficientes (>= minDetail) E é distinta das já mantidas
   *     (Delta-E > distinct)            → mantém (é um detalhe de verdade); senão
   *   - mescla na cor mantida mais próxima.
   *
   * @param opts { minDetailPct, dominantPct, distinct }
   */
  function simplifyColors(grid, opts) {
    opts = opts || {};
    const { w, h, colors, assign } = grid;
    const n = w * h;

    const counts = new Array(colors.length).fill(0);
    let used = 0;
    for (let i = 0; i < n; i++) { const a = assign[i]; if (a >= 0) { counts[a]++; used++; } }
    if (used === 0) return grid;

    const minDetail = Math.max(5, Math.round(used * (opts.minDetailPct != null ? opts.minDetailPct : 0.005)));
    const dominantFloor = Math.max(minDetail * 2, used * (opts.dominantPct != null ? opts.dominantPct : 0.02));
    const distinct = opts.distinct != null ? opts.distinct : 20;

    const order = [];
    for (let k = 0; k < colors.length; k++) if (counts[k] > 0) order.push(k);
    order.sort((p, q) => counts[q] - counts[p]);

    const keep = [];
    for (const k of order) {
      if (keep.length === 0) { keep.push(k); continue; } // mantém a mais frequente
      const cnt = counts[k];
      if (cnt >= dominantFloor) { keep.push(k); continue; }
      if (cnt < minDetail) continue; // ruído → mesclar
      let minD = Infinity;
      for (const m of keep) {
        const d = HBColors.deltaE2000(colors[k].lab, colors[m].lab);
        if (d < minD) minD = d;
      }
      if (minD > distinct) keep.push(k); // detalhe distinto → manter
    }
    if (keep.length === order.length) return grid;

    const keepSet = new Set(keep);
    const remap = new Array(colors.length).fill(-1);
    keep.forEach((k, idx) => (remap[k] = idx));
    for (const k of order) {
      if (keepSet.has(k)) continue;
      let best = keep[0], bestD = Infinity;
      for (const m of keep) {
        const d = HBColors.deltaE2000(colors[k].lab, colors[m].lab);
        if (d < bestD) { bestD = d; best = m; }
      }
      remap[k] = remap[best];
    }

    const newColors = keep.map((k) => colors[k]);
    const newAssign = new Int16Array(n).fill(-1);
    for (let i = 0; i < n; i++) { const a = assign[i]; if (a >= 0) newAssign[i] = remap[a]; }
    return { w, h, colors: newColors, assign: newAssign };
  }

  /**
   * Estatística de uso por cor (para a legenda). Retorna lista
   * [{color, count}] ordenada por contagem desc, só de cores com count > 0.
   */
  function colorStats(grid) {
    const counts = new Array(grid.colors.length).fill(0);
    let total = 0;
    for (let i = 0; i < grid.assign.length; i++) {
      const a = grid.assign[i];
      if (a >= 0) { counts[a]++; total++; }
    }
    const stats = [];
    for (let k = 0; k < grid.colors.length; k++) {
      if (counts[k] > 0) stats.push({ color: grid.colors[k], count: counts[k] });
    }
    stats.sort((p, q) => q.count - p.count);
    return { stats, total };
  }

  /**
   * Detecta se o canvas é pixel art em escala (blocos de pixels idênticos repetidos).
   *
   * Funcionamento: para cada coluna x, conta em quantas linhas existe uma mudança
   * de cor entre x e x+1 — isso cria um "sinal de transição". Em pixel art escalonada
   * (ex.: cada célula = 8px) esse sinal tem picos periódicos nos limites das células.
   * Encontramos o período dominante (espacamento modal entre picos) e derivamos o
   * número de células originais.
   *
   * Deve ser chamada no canvas RAW, antes de aplicar filtros.
   *
   * @returns {{step:number, gridW:number, gridH:number}} ou null se não detectado.
   */
  function detectPixelArt(canvas) {
    var w = canvas.width, h = canvas.height;
    if (w < 6 || h < 6) return null;

    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var data = ctx.getImageData(0, 0, w, h).data;

    // hT[x] = nº de linhas com transição de cor entre a coluna x e x+1.
    var hT = new Uint32Array(w);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w - 1; x++) {
        var i = (y * w + x) * 4;
        var d = Math.abs(data[i] - data[i + 4]) +
                Math.abs(data[i + 1] - data[i + 5]) +
                Math.abs(data[i + 2] - data[i + 6]);
        if (d > 30) hT[x]++;
      }
    }

    // vT[y] = nº de colunas com transição entre a linha y e y+1.
    var vT = new Uint32Array(h);
    for (var x2 = 0; x2 < w; x2++) {
      for (var y2 = 0; y2 < h - 1; y2++) {
        var ii = (y2 * w + x2) * 4;
        var jj = ii + w * 4;
        var d2 = Math.abs(data[ii] - data[jj]) +
                 Math.abs(data[ii + 1] - data[jj + 1]) +
                 Math.abs(data[ii + 2] - data[jj + 2]);
        if (d2 > 30) vT[y2]++;
      }
    }

    // Encontra o período dominante: modo dos espaçamentos entre picos do sinal.
    function dominantPeriod(sig, len) {
      var maxVal = 0;
      for (var k = 0; k < len; k++) if (sig[k] > maxVal) maxVal = sig[k];
      if (!maxVal) return null;
      var thresh = maxVal * 0.35;

      var peaks = [];
      for (var k2 = 1; k2 < len - 1; k2++) {
        if (sig[k2] >= thresh && sig[k2] >= sig[k2 - 1] && sig[k2] >= sig[k2 + 1]) {
          peaks.push(k2);
        }
      }
      if (peaks.length < 2) return null;

      var cnt = {};
      for (var p = 1; p < peaks.length; p++) {
        var sp = peaks[p] - peaks[p - 1];
        if (sp < 2) continue;
        cnt[sp] = (cnt[sp] || 0) + 1;
      }

      var best = null, bestC = 0;
      for (var s in cnt) {
        if (cnt[s] > bestC || (cnt[s] === bestC && +s < best)) {
          bestC = cnt[s]; best = +s;
        }
      }
      return (best && bestC >= 2) ? best : null;
    }

    var hStep = dominantPeriod(hT, w);
    var vStep = dominantPeriod(vT, h);
    if (!hStep && !vStep) return null;

    var step = (hStep && vStep) ? Math.round((hStep + vStep) / 2) : (hStep || vStep);
    if (step < 2) return null;

    var gridW = Math.round(w / step);
    var gridH = Math.round(h / step);
    if (gridW < 4 || gridH < 4 || gridW > 200 || gridH > 200) return null;

    return { step: step, gridW: gridW, gridH: gridH };
  }

  global.HBPipeline = {
    sampleGrid,
    embedGrid,
    buildGrid,
    limitColors,
    simplifyColors,
    replaceColor,
    colorStats,
    nearestColorIndex,
    detectPixelArt,
  };
})(window);
