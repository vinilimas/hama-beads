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
  function sampleGrid(srcCanvas, gridW, gridH, method, region) {
    if (method === 'dominant') return sampleGridDominant(srcCanvas, gridW, gridH, region);

    // Método 'average' (padrão): média de área via downscale do Canvas.
    // Bom para fotos e gradientes, onde a média representa bem a região.
    const r = region || { x: 0, y: 0, w: srcCanvas.width, h: srcCanvas.height };
    const off = document.createElement('canvas');
    off.width = gridW;
    off.height = gridH;
    const ctx = off.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, gridW, gridH);
    // Desenha apenas a sub-região de conteúdo (region) esticada na grade. Sem
    // region, usa o canvas inteiro (comportamento padrão para fotos).
    ctx.drawImage(srcCanvas, r.x, r.y, r.w, r.h, 0, 0, gridW, gridH);

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
   *
   * (Uma tentativa anterior de favorecer o balde mais escuro em caso de contorno
   * fino foi revertida: ela engordava o contorno em TODA célula de borda —
   * mesmo em arte com contorno grosso/comum — e chegava a apagar por completo
   * preenchimentos finos (ex.: o branco do olho entre a pupila e o contorno).
   * Voto de maioria puro é mais previsível; ver [[board-and-color-rules]].)
   */
  function sampleGridDominant(srcCanvas, gridW, gridH, region) {
    const sw = srcCanvas.width, sh = srcCanvas.height;
    const ctx = srcCanvas.getContext('2d', { willReadFrequently: true });
    const data = ctx.getImageData(0, 0, sw, sh).data;

    // Sub-região de conteúdo (após auto-recorte da moldura na detecção). Sem
    // region, varre o canvas inteiro. Dividir exatamente ESTA região pela grade
    // nativa (gridW×gridH) faz cada célula cair dentro de um único bloco de pixel
    // art — é o que alinha a grade aos blocos e elimina cores "sujas" de borda.
    const rx = region ? region.x : 0;
    const ry = region ? region.y : 0;
    const rw = region ? region.w : sw;
    const rh = region ? region.h : sh;

    const n = gridW * gridH;
    const rgb = new Float32Array(n * 3);
    const alpha = new Float32Array(n);
    const lab = new Array(n);

    for (let gy = 0; gy < gridH; gy++) {
      const y0 = ry + Math.floor((gy * rh) / gridH);
      const y1 = Math.max(y0 + 1, ry + Math.floor(((gy + 1) * rh) / gridH));
      for (let gx = 0; gx < gridW; gx++) {
        const x0 = rx + Math.floor((gx * rw) / gridW);
        const x1 = Math.max(x0 + 1, rx + Math.floor(((gx + 1) * rw) / gridW));

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

  // ---- Quantização global de cor (clusterização em Lab) -------------------
  // Em vez de casar cada célula isolada com a miçanga mais próxima (que espalha
  // tons de borda em miçangas diferentes), agrupamos PRIMEIRO as cores da imagem
  // em poucos clusters perceptuais e só então mapeamos cada cluster para uma
  // miçanga. Resultado: cores consistentes e limpas (todo "verde" vira a mesma
  // miçanga). Median-cut dá os clusters iniciais; algumas iterações de k-means
  // (Lloyd) em Lab refinam. Tudo determinístico — sem aleatório, sem rede.

  /** Centróide Lab de um conjunto de índices. */
  function centroidLab(lab, idx) {
    let L = 0, a = 0, b = 0;
    for (let k = 0; k < idx.length; k++) { const c = lab[idx[k]]; L += c.L; a += c.a; b += c.b; }
    const n = idx.length || 1;
    return { L: L / n, a: a / n, b: b / n };
  }

  /** Caixa (box) do median-cut: índices + extensão em cada eixo Lab. */
  function makeBox(lab, idx) {
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < idx.length; k++) {
      const c = lab[idx[k]];
      if (c.L < lo[0]) lo[0] = c.L; if (c.L > hi[0]) hi[0] = c.L;
      if (c.a < lo[1]) lo[1] = c.a; if (c.a > hi[1]) hi[1] = c.a;
      if (c.b < lo[2]) lo[2] = c.b; if (c.b > hi[2]) hi[2] = c.b;
    }
    return {
      idx: idx,
      spanL: hi[0] - lo[0], spanA: hi[1] - lo[1], spanB: hi[2] - lo[2],
    };
  }

  /** Median-cut em Lab: divide recursivamente até K clusters; retorna centróides. */
  function medianCutLab(lab, idxs, K) {
    let boxes = [makeBox(lab, idxs)];
    while (boxes.length < K) {
      let bi = -1, bestSpan = -1;
      for (let k = 0; k < boxes.length; k++) {
        const b = boxes[k];
        if (b.idx.length < 2) continue;
        const span = Math.max(b.spanL, b.spanA, b.spanB);
        if (span > bestSpan) { bestSpan = span; bi = k; }
      }
      if (bi < 0) break;
      const b = boxes[bi];
      const axis = (b.spanA >= b.spanL && b.spanA >= b.spanB) ? 'a'
                 : (b.spanB >= b.spanL && b.spanB >= b.spanA) ? 'b' : 'L';
      const sorted = b.idx.slice().sort((p, q) => lab[p][axis] - lab[q][axis]);
      const mid = sorted.length >> 1;
      boxes.splice(bi, 1, makeBox(lab, sorted.slice(0, mid)), makeBox(lab, sorted.slice(mid)));
    }
    return boxes.filter((b) => b.idx.length).map((b) => centroidLab(lab, b.idx));
  }

  /** Cluster Lab mais próximo (distância euclidiana, rápida). */
  function nearestClusterLab(c, centroids) {
    let best = 0, bestD = Infinity;
    for (let k = 0; k < centroids.length; k++) {
      const d = HBColors.labDist2(c, centroids[k]);
      if (d < bestD) { bestD = d; best = k; }
    }
    return best;
  }

  /** Refino k-means (Lloyd) dos centróides, `iters` iterações. */
  function kmeansRefineLab(lab, idxs, centroids, iters) {
    let cs = centroids.map((c) => ({ L: c.L, a: c.a, b: c.b }));
    for (let it = 0; it < iters; it++) {
      const sL = new Float64Array(cs.length), sA = new Float64Array(cs.length),
            sB = new Float64Array(cs.length), cnt = new Int32Array(cs.length);
      for (let m = 0; m < idxs.length; m++) {
        const c = lab[idxs[m]];
        const k = nearestClusterLab(c, cs);
        sL[k] += c.L; sA[k] += c.a; sB[k] += c.b; cnt[k]++;
      }
      for (let k = 0; k < cs.length; k++) {
        if (cnt[k] > 0) cs[k] = { L: sL[k] / cnt[k], a: sA[k] / cnt[k], b: sB[k] / cnt[k] };
      }
    }
    return cs;
  }

  /**
   * Preenche `assign` mapeando cada célula visível à miçanga via quantização
   * global (clusters → miçanga). `assign[i]` é índice em `colors` (= activeColors),
   * o mesmo espaço do caminho "nearest por célula" — então o resto do buildGrid
   * (limite de cores, fundo) continua valendo.
   */
  function quantizeAssign(sample, colors, assign, bgMask, alphaThreshold, maxColors) {
    const { lab, alpha, w, h } = sample;
    const n = w * h;
    const idxs = [];
    for (let i = 0; i < n; i++) {
      if (alpha[i] <= alphaThreshold) continue;
      if (bgMask && bgMask[i]) continue;
      idxs.push(i);
    }
    if (!idxs.length) return;

    // Mais clusters que o limite final dá margem para o simplify/limite escolher.
    const K = (maxColors && maxColors > 0)
      ? Math.min(Math.max(maxColors * 2, 8), 24)
      : 16;
    let centroids = medianCutLab(lab, idxs, Math.min(K, idxs.length));
    centroids = kmeansRefineLab(lab, idxs, centroids, 3);

    const clusterBead = centroids.map((c) => nearestColorIndex(c, colors));
    for (let m = 0; m < idxs.length; m++) {
      const i = idxs[m];
      assign[i] = clusterBead[nearestClusterLab(lab[i], centroids)];
    }
  }

  /**
   * ETAPA B — Monta o grid final.
   * @param sample  resultado de sampleGrid()
   * @param activeColors  cores ativas da paleta (cada uma com .lab)
   * @param opts {
   *   dithering:boolean,
   *   quantize:boolean,             // quantização global (arte chapada/pixel art)
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
    } else if (opts.quantize) {
      quantizeAssign(sample, colors, assign, bgMask, alphaThreshold, opts.maxColors);
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
   * Período fundamental de um sinal 1D por AUTOCORRELAÇÃO.
   *
   * Mais estável que medir o espaçamento entre picos isolados: a autocorrelação
   * acumula a periodicidade do sinal inteiro. Removemos a média (DC), calculamos
   * a correlação para cada deslocamento (lag) e pegamos o PRIMEIRO pico forte
   * (>= 50% do pico global) — que corresponde ao período de uma célula (e não a
   * um múltiplo dele).
   *
   * @returns {number|null} tamanho da célula em pixels, ou null.
   */
  function autocorrPeriod(sig, len) {
    if (len < 6) return null;
    var mean = 0;
    for (var i = 0; i < len; i++) mean += sig[i];
    mean /= len;
    var a = new Float64Array(len);
    var norm0 = 0;
    for (var j = 0; j < len; j++) { a[j] = sig[j] - mean; norm0 += a[j] * a[j]; }
    if (norm0 <= 1e-9) return null;

    var maxLag = Math.floor(len / 2);
    var r = new Float64Array(maxLag + 1);
    for (var lag = 1; lag <= maxLag; lag++) {
      var s = 0;
      for (var x = 0; x + lag < len; x++) s += a[x] * a[x + lag];
      r[lag] = s / norm0;
    }

    var globalMax = 0;
    for (var l = 2; l <= maxLag; l++) if (r[l] > globalMax) globalMax = r[l];
    if (globalMax <= 0) return null;

    var thresh = globalMax * 0.5;
    for (var p = 2; p < maxLag; p++) {
      if (r[p] >= thresh && r[p] >= r[p - 1] && r[p] >= r[p + 1]) return p;
    }
    return null;
  }

  /**
   * Fração de células quase uniformes para a grade candidata (gridW×gridH dentro
   * de `region`). Pixel art chapada amostrada na grade certa tem células muito
   * uniformes (desvio baixo); foto/grade errada têm desvio alto. Serve de "gate":
   * só consideramos pixel art se a fração ficar acima de um limiar.
   */
  function blockUniformity(data, W, region, gridW, gridH) {
    var rx = region.x, ry = region.y, rw = region.w, rh = region.h;
    var uniform = 0, total = 0;
    for (var gy = 0; gy < gridH; gy++) {
      var y0 = ry + Math.floor((gy * rh) / gridH);
      var y1 = Math.max(y0 + 1, ry + Math.floor(((gy + 1) * rh) / gridH));
      for (var gx = 0; gx < gridW; gx++) {
        var x0 = rx + Math.floor((gx * rw) / gridW);
        var x1 = Math.max(x0 + 1, rx + Math.floor(((gx + 1) * rw) / gridW));
        var sr = 0, sg = 0, sb = 0, nn = 0;
        for (var y = y0; y < y1; y++) {
          var base = (y * W + x0) * 4;
          for (var x = x0; x < x1; x++, base += 4) {
            sr += data[base]; sg += data[base + 1]; sb += data[base + 2]; nn++;
          }
        }
        if (!nn) continue;
        var mr = sr / nn, mg = sg / nn, mb = sb / nn, dev = 0;
        for (var y2 = y0; y2 < y1; y2++) {
          var b2 = (y2 * W + x0) * 4;
          for (var x2 = x0; x2 < x1; x2++, b2 += 4) {
            dev += Math.abs(data[b2] - mr) + Math.abs(data[b2 + 1] - mg) + Math.abs(data[b2 + 2] - mb);
          }
        }
        dev /= nn;
        total++;
        if (dev <= 24) uniform++; // ~8 por canal
      }
    }
    return total ? uniform / total : 0;
  }

  /**
   * Detecta a resolução NATIVA de uma pixel art e devolve a grade para reamostrar
   * "sobre a grade verdadeira" (mesmo princípio de ferramentas como spritecook).
   *
   * IMPORTANTE: trabalha na imagem INTEIRA — NÃO recorta nada. Fundo e bordas são
   * conteúdo (o fundo o usuário remove manualmente; as bordas pretas dos desenhos
   * sempre ficam). A grade é a imagem dividida em gridW×gridH blocos iguais.
   *
   * Etapas:
   *   1. Mede o sinal de transição de cor por coluna/linha.
   *   2. Acha o período (tamanho da célula) por autocorrelação, por eixo.
   *   3. Verifica por uniformidade de bloco (gate anti-falso-positivo em foto).
   *
   * Deve ser chamada no canvas RAW (antes dos filtros), para bordas nítidas.
   *
   * @returns {{step,gridW,gridH}} ou null se não parecer pixel art.
   */
  function detectPixelArt(canvas) {
    var W = canvas.width, H = canvas.height;
    if (W < 6 || H < 6) return null;

    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var data = ctx.getImageData(0, 0, W, H).data;

    // 1) Sinais de transição de cor (imagem inteira).
    var hT = new Float64Array(W);
    for (var y = 0; y < H; y++) {
      var rowBase = (y * W) * 4;
      for (var x = 0; x < W - 1; x++) {
        var i = rowBase + x * 4;
        var d = Math.abs(data[i] - data[i + 4]) +
                Math.abs(data[i + 1] - data[i + 5]) +
                Math.abs(data[i + 2] - data[i + 6]);
        if (d > 30) hT[x]++;
      }
    }
    var vT = new Float64Array(H);
    for (var xx = 0; xx < W; xx++) {
      for (var yy = 0; yy < H - 1; yy++) {
        var ii = (yy * W + xx) * 4;
        var jj = ii + W * 4;
        var d2 = Math.abs(data[ii] - data[jj]) +
                 Math.abs(data[ii + 1] - data[jj + 1]) +
                 Math.abs(data[ii + 2] - data[jj + 2]);
        if (d2 > 30) vT[yy]++;
      }
    }

    // 2) Período por eixo. Se um eixo falhar, assume célula quadrada.
    var hStep = autocorrPeriod(hT, W);
    var vStep = autocorrPeriod(vT, H);
    if (!hStep && !vStep) return null;
    if (!hStep) hStep = vStep;
    if (!vStep) vStep = hStep;
    if (hStep < 2 || vStep < 2) return null;

    var gridW = Math.round(W / hStep);
    var gridH = Math.round(H / vStep);
    if (gridW < 4 || gridH < 4 || gridW > 200 || gridH > 200) return null;

    // 3) Gate por uniformidade de bloco — evita falso positivo em foto.
    var full = { x: 0, y: 0, w: W, h: H };
    var score = blockUniformity(data, W, full, gridW, gridH);
    if (score < 0.5) return null;

    return {
      step: (hStep + vStep) / 2,
      gridW: gridW,
      gridH: gridH,
    };
  }

  /**
   * Contagem de miçangas por LINHA. Para cada linha que tem ≥1 miçanga, retorna
   * a contagem por cor (ordenada por frequência desc) e o total. Útil para montar
   * fileira por fileira sabendo exatamente quantas de cada cor pegar.
   *
   * @returns {Array<{row, total, items:[{color, count}]}>}
   */
  function rowStats(grid) {
    const { w, h, colors, assign } = grid;
    const rows = [];
    for (let y = 0; y < h; y++) {
      const counts = new Array(colors.length).fill(0);
      let total = 0;
      for (let x = 0; x < w; x++) {
        const a = assign[y * w + x];
        if (a >= 0) { counts[a]++; total++; }
      }
      if (total === 0) continue;
      const items = [];
      for (let k = 0; k < colors.length; k++) {
        if (counts[k] > 0) items.push({ color: colors[k], count: counts[k] });
      }
      items.sort((p, q) => q.count - p.count);
      rows.push({ row: y, total, items });
    }
    return rows;
  }

  /**
   * Sequência de colocação de uma linha (run-length): varre da esquerda para a
   * direita e agrupa miçangas consecutivas da mesma cor — exatamente a ordem em
   * que você vai colocando na placa. Ex.: 2 brancas, 4 pretas, 2 brancas...
   *
   * Vazios (sem miçanga) das PONTAS são removidos; os do MEIO são mantidos como
   * segmentos (idx = -1) para a posição/contagem continuar exata.
   *
   * @returns {{row, total, segs:[{idx, color, count}]}}
   */
  function rowRuns(grid, y) {
    const { w, colors, assign } = grid;
    const segs = [];
    let total = 0;
    let i = 0;
    while (i < w) {
      const a = assign[y * w + i];
      let j = i + 1;
      while (j < w && assign[y * w + j] === a) j++;
      const count = j - i;
      segs.push({ idx: a, color: a >= 0 ? colors[a] : null, count });
      if (a >= 0) total += count;
      i = j;
    }
    while (segs.length && segs[0].idx < 0) segs.shift();
    while (segs.length && segs[segs.length - 1].idx < 0) segs.pop();
    return { row: y, total, segs };
  }

  /** Contagem por cor de uma ÚNICA linha (modo montagem). */
  function rowColorCounts(grid, y) {
    const { w, colors, assign } = grid;
    const counts = new Array(colors.length).fill(0);
    let total = 0;
    for (let x = 0; x < w; x++) {
      const a = assign[y * w + x];
      if (a >= 0) { counts[a]++; total++; }
    }
    const items = [];
    for (let k = 0; k < colors.length; k++) {
      if (counts[k] > 0) items.push({ color: colors[k], count: counts[k] });
    }
    items.sort((p, q) => q.count - p.count);
    return { row: y, total, items };
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
    rowStats,
    rowColorCounts,
    rowRuns,
  };
})(window);
