/*
 * app.js
 * --------------------------------------------------------------------------
 * Cola tudo: estado, controles, recorte, zoom/pan, editor de paleta, legenda
 * e exportação. Estratégia de recálculo em duas etapas (ver pipeline.js):
 *   - resample(): refaz a amostragem da grade (quando muda crop/filtros/grade).
 *   - remap():    só remapeia as cores (quando muda paleta/dithering/limite/fundo).
 * Ambas são "debounced" para manter a interface fluida.
 * --------------------------------------------------------------------------
 */
(function () {
  'use strict';

  // Resolução do canvas de trabalho onde os filtros rodam. Como o resultado
  // final é uma grade pequena, não precisamos da foto inteira — isto mantém
  // tudo rápido mesmo no celular.
  var WORK_MAX = 384;

  // Tamanho fixo (px) de cada célula no preview colorido. Ser constante faz o
  // tamanho na tela ser proporcional a N, o que deixa a alça de redimensionar
  // mapear o arrasto para N de forma linear.
  var COLOR_CELL = 12;
  var BOARD = 52;       // a bandeja é SEMPRE 52×52
  var IMG_MIN = 8;      // tamanho mínimo da imagem dentro da bandeja
  var IMG_MAX = 52;     // tamanho máximo (ocupa a bandeja inteira)

  var $ = function (id) { return document.getElementById(id); };

  function debounce(fn, ms) {
    var t;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  // Throttle: garante no máximo uma chamada a cada `ms` (com chamada final).
  function throttle(fn, ms) {
    var last = 0, timer = null;
    return function () {
      var now = Date.now();
      var rem = ms - (now - last);
      if (rem <= 0) {
        clearTimeout(timer); timer = null;
        last = now; fn();
      } else if (!timer) {
        timer = setTimeout(function () {
          timer = null; last = Date.now(); fn();
        }, rem);
      }
    };
  }

  // -------------------------------------------------------------- Estado ----
  var state = {
    palette: HBPalette.load(),
    image: null,
    croppedCanvas: null,
    sample: null,
    grid: null,
    replacements: [],
    params: {
      imageCells: 52,         // tamanho da imagem dentro da bandeja 52×52
      sampleMethod: 'dominant', // 'dominant' (arte chapada) | 'average' (foto)
      simplify: true,           // remove ruído de cor preservando detalhes
      trayCircle: true, trayDiameter: 28,
      brightness: 0, contrast: 0, saturation: 0,
      posterize: 8, blur: 1,
      dithering: false,
      maxColors: 0,
      bgMode: 'keep', bgColor: '', bgTol: 14,
      splitMode: 'single', cellsPerPage: 26,
      previewBg: '#ffffff',   // cor de fundo do preview na tela (não afeta o PNG/PDF)
    },
    // Proporção do recorte e dimensões resultantes da imagem na bandeja.
    cropAR: 1,   // largura/altura do recorte
    imgW: 52,    // largura da imagem em células (derivada do tamanho + proporção)
    imgH: 52,
    // Estado do modo montagem (não entra no recálculo do molde).
    progress: null, // Uint8Array(BOARD*BOARD): 1 = miçanga já colocada
    asm: {
      on: false,
      viewMode: 'whole', // 'whole' | 'rows'
      currentRow: 0,
      focusCode: '',     // código da cor focada ('' = todas)
      lock: false,
      wake: false,
    },
    // Estado do EDITOR de grade (pincel/borracha/balde/conta-gotas).
    edit: {
      on: false,
      tool: 'brush',     // 'brush' | 'erase' | 'fill' | 'pick'
      colorCode: '',     // código da cor ativa (pincel/balde)
      undo: [],          // pilha de snapshots (Int16Array de assign)
      redo: [],
      dirty: false,
    },
  };

  var crop = null;
  var panzoom = null;
  var activeTab = 'color';
  var wakeLock = null;

  // ====================================================================== //
  //  ZOOM / PAN                                                            //
  // ====================================================================== //
  function PanZoom(viewport, panEl) {
    this.vp = viewport;
    this.pan = panEl;
    this.scale = 1; this.tx = 0; this.ty = 0;
    this.pointers = new Map();
    this.pinch = null;
    this.locked = false;    // quando travado, ignora pan/zoom (mas o tap ainda marca)
    this.paintMode = false; // no editor: 1 dedo PINTA (não dá pan); 2 dedos = pinça
    var self = this;

    viewport.addEventListener('pointerdown', function (e) {
      if (self.locked) return;
      viewport.setPointerCapture(e.pointerId);
      self.pointers.set(e.pointerId, self._rel(e));
      if (self.pointers.size === 2) self._startPinch();
    });
    viewport.addEventListener('pointermove', function (e) {
      if (!self.pointers.has(e.pointerId)) return;
      var prev = self.pointers.get(e.pointerId);
      var p = self._rel(e);
      self.pointers.set(e.pointerId, p);
      if (self.pointers.size === 1) {
        // No modo de pintura, 1 dedo não dá pan (quem pinta é o editor); a pinça
        // de 2 dedos continua valendo (por isso seguimos registrando o ponteiro).
        if (!self.paintMode) {
          self.tx += p.x - prev.x; self.ty += p.y - prev.y; self._apply();
        }
      } else if (self.pointers.size === 2) {
        self._updatePinch();
      }
      e.preventDefault();
    });
    function end(e) {
      self.pointers.delete(e.pointerId);
      if (self.pointers.size < 2) self.pinch = null;
    }
    viewport.addEventListener('pointerup', end);
    viewport.addEventListener('pointercancel', end);

    viewport.addEventListener('wheel', function (e) {
      if (self.locked) return;
      e.preventDefault();
      var p = self._rel(e);
      var factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      self.zoomAround(self.scale * factor, p.x, p.y);
    }, { passive: false });
  }
  PanZoom.prototype._rel = function (e) {
    var r = this.vp.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  PanZoom.prototype._apply = function () {
    this.pan.style.transform =
      'translate(' + this.tx + 'px,' + this.ty + 'px) scale(' + this.scale + ')';
    if (this.onUpdate) this.onUpdate();
  };
  PanZoom.prototype.zoomAround = function (s, cx, cy) {
    s = Math.max(0.15, Math.min(10, s));
    var wx = (cx - this.tx) / this.scale;
    var wy = (cy - this.ty) / this.scale;
    this.scale = s;
    this.tx = cx - wx * s;
    this.ty = cy - wy * s;
    this._apply();
  };
  PanZoom.prototype._twoPointers = function () {
    var pts = Array.from(this.pointers.values());
    return pts;
  };
  PanZoom.prototype._startPinch = function () {
    var p = this._twoPointers();
    var dx = p[0].x - p[1].x, dy = p[0].y - p[1].y;
    this.pinch = {
      dist: Math.hypot(dx, dy),
      mid: { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 },
      scale: this.scale, tx: this.tx, ty: this.ty,
    };
  };
  PanZoom.prototype._updatePinch = function () {
    if (!this.pinch) { this._startPinch(); return; }
    var p = this._twoPointers();
    var dx = p[0].x - p[1].x, dy = p[0].y - p[1].y;
    var dist = Math.hypot(dx, dy);
    var mid = { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
    var factor = dist / (this.pinch.dist || 1);
    var newScale = Math.max(0.15, Math.min(10, this.pinch.scale * factor));
    // ponto de conteúdo sob o centro inicial dos dedos
    var wx = (this.pinch.mid.x - this.pinch.tx) / this.pinch.scale;
    var wy = (this.pinch.mid.y - this.pinch.ty) / this.pinch.scale;
    this.scale = newScale;
    this.tx = mid.x - wx * newScale;
    this.ty = mid.y - wy * newScale;
    this._apply();
  };
  PanZoom.prototype.fit = function (canvas) {
    if (!canvas || !canvas.width) return;
    var r = this.vp.getBoundingClientRect();
    var pad = 24;
    var s = Math.min((r.width - pad) / canvas.width, (r.height - pad) / canvas.height);
    s = Math.max(0.15, Math.min(10, s));
    this.scale = s;
    this.tx = (r.width - canvas.width * s) / 2;
    this.ty = (r.height - canvas.height * s) / 2;
    this._apply();
  };

  // ====================================================================== //
  //  RECÁLCULO                                                             //
  // ====================================================================== //

  /** ETAPA A — recorta, aplica filtros e amostra para a grade. */
  function resample() {
    if (state.edit.on) return; // edição congela a conversão (não apaga os traços)
    if (!crop || !state.image) return;
    var cropped = crop.getCroppedCanvas(WORK_MAX);
    if (!cropped) return;
    state.croppedCanvas = cropped;

    // Detecção de pixel art: roda no canvas RAW (antes dos filtros) para pegar
    // bordas nítidas. Só na primeira carga da imagem ou quando solicitado.
    if (state._pendingAutoDetect) {
      state._pendingAutoDetect = false;
      var detected = HBPipeline.detectPixelArt(cropped);
      state._detectedGrid = detected || null;
      // Usa a grade nativa (1 célula = 1 bloco) só se ela couber na bandeja.
      // Acima disso não há mapeamento 1:1; caímos no downscale normal.
      state._useDetectedGrid = !!(detected &&
        detected.gridW <= IMG_MAX && detected.gridH <= IMG_MAX);
      if (detected) {
        var natMax = Math.max(detected.gridW, detected.gridH);
        setImageCells(Math.min(natMax, IMG_MAX), false);
        // Pixel art não precisa de blur — desativa sem alterar o slider
        // (o usuário pode reativar manualmente se quiser).
        if (state.params.blur > 0) {
          state.params.blur = 0;
          $('blur').value = 0;
          $('blurOut').textContent = 0;
        }
      }
    }

    var p = state.params;
    var ctx = cropped.getContext('2d');
    var img = ctx.getImageData(0, 0, cropped.width, cropped.height);

    // Ordem: ajustes -> suavização -> posterização.
    HBImaging.adjust(img, p.brightness, p.contrast, p.saturation);
    ctx.putImageData(img, 0, 0);
    if (p.blur > 0) {
      var blurred = HBImaging.medianBlur(img, p.blur);
      ctx.putImageData(blurred, 0, 0);
      img = blurred;
    }
    HBImaging.posterize(img, p.posterize);
    ctx.putImageData(img, 0, 0);

    // Proporção do recorte → dimensões da imagem na bandeja (lado maior = S).
    state.cropAR = cropped.width / cropped.height;

    // Pixel art detectada e cabendo na bandeja: amostra na GRADE NATIVA, dividindo
    // exatamente a região de conteúdo (sem a moldura) — alinha as células aos
    // blocos. Caso contrário (foto, ou o usuário mexeu no tamanho): downscale normal.
    var region = null, wh;
    var dg = state._detectedGrid;
    if (dg && state._useDetectedGrid) {
      wh = { w: dg.gridW, h: dg.gridH };
      region = dg.content;
    } else {
      wh = computeWH(p.imageCells, state.cropAR);
    }
    state.imgW = wh.w; state.imgH = wh.h;
    state.sample = HBPipeline.sampleGrid(cropped, wh.w, wh.h, p.sampleMethod, region);
    remap();
  }

  /**
   * Converte o "tamanho" S (lado maior, em células) + a proporção do recorte
   * em dimensões W×H da imagem, ambas dentro da bandeja (≤ BOARD).
   */
  function computeWH(S, ar) {
    if (!ar || !isFinite(ar)) ar = 1;
    var w, h;
    if (ar >= 1) { w = S; h = Math.round(S / ar); }
    else { h = S; w = Math.round(S * ar); }
    w = Math.max(IMG_MIN, Math.min(BOARD, w));
    h = Math.max(IMG_MIN, Math.min(BOARD, h));
    return { w: w, h: h };
  }

  /** ETAPA B — mapeia para a paleta e renderiza. */
  function remap() {
    if (state.edit.on) return; // edição congela a conversão (não apaga os traços)
    if (!state.sample) return;
    var p = state.params;
    var active = HBPalette.activeColors(state.palette);

    var grid = HBPipeline.buildGrid(state.sample, active, {
      dithering: p.dithering,
      // Arte chapada / pixel art (modo "dominant"): quantização global de cor
      // (clusters → miçanga) em vez de casar cada célula isolada. Cores limpas
      // e consistentes. O dithering (modo foto) tem caminho próprio.
      quantize: p.sampleMethod === 'dominant' && !p.dithering,
      maxColors: p.maxColors,
      background: p.bgMode,
      backgroundTolerance: p.bgTol,
      backgroundColorCode: p.bgColor,
      alphaThreshold: 16,
    });

    // Simplifica cores (remove ruído de borda, preserva detalhes distintos).
    if (p.simplify) grid = HBPipeline.simplifyColors(grid, {});
    grid = applyReplacements(grid);
    // Encaixa a imagem (S×S) centralizada na bandeja fixa 52×52; resto fica vazio.
    grid = HBPipeline.embedGrid(grid, BOARD, BOARD);
    state.grid = grid;
    updateFocusOptions();
    renderAll();
    saveEditGrid(); // persiste a grade atual (recupera o trabalho ao recarregar)
  }

  /** Aplica as substituições globais de cor configuradas. */
  function applyReplacements(grid) {
    var g = grid;
    state.replacements.forEach(function (rep) {
      var fromIdx = g.colors.findIndex(function (c) { return c.code === rep.from; });
      if (fromIdx < 0) return;
      var colors = g.colors;
      var toIdx = g.colors.findIndex(function (c) { return c.code === rep.to; });
      if (toIdx < 0) {
        var tc = state.palette.find(function (c) { return c.code === rep.to; });
        if (!tc) return;
        colors = g.colors.slice();
        colors.push(tc);
        toIdx = colors.length - 1;
      }
      var assign = Int16Array.from(g.assign);
      for (var i = 0; i < assign.length; i++) {
        if (assign[i] === fromIdx) assign[i] = toIdx;
      }
      g = { w: g.w, h: g.h, colors: colors, assign: assign };
    });
    return g;
  }

  var scheduleResample = debounce(resample, 130);
  var scheduleRemap = debounce(remap, 60);
  var throttledResample = throttle(resample, 80); // usado durante o arrasto da alça

  // ====================================================================== //
  //  RENDER                                                                //
  // ====================================================================== //
  function renderAll() {
    if (!state.grid) return;
    $('placeholder').hidden = true;
    var g = state.grid;

    var tray = state.params.trayCircle ? state.params.trayDiameter : 0;

    // Overlays do modo montagem (foco de cor / linha atual / progresso).
    var ov = assemblyOverlay(g);

    HBRender.drawGrid($('colorCanvas'), g, {
      mode: 'color', cellSize: COLOR_CELL, showGrid: g.w <= 64, guideEvery: 10,
      trayDiameter: tray, bg: state.params.previewBg,
      focusIndex: ov.focusIndex, activeRow: ov.activeRow, progress: ov.progress,
    });
    HBRender.drawGrid($('codeCanvas'), g, {
      mode: 'code', cellSize: 24, showGrid: true, guideEvery: 10, showAxes: true,
      trayDiameter: tray,
      focusIndex: ov.focusIndex, activeRow: ov.activeRow, progress: ov.progress,
    });

    renderLegend();
    renderRowBreakdown();
    renderRowSummary();
    updateBadge();
    updateDetectNotice();
    updateProgressUI();
    // Ajusta o enquadramento na primeira renderização desta imagem.
    if (!state._fitted) {
      panzoom.fit(activeTab === 'color' ? $('colorCanvas') : $('codeCanvas'));
      state._fitted = true;
    }
    updateSizer();
  }

  /**
   * Demonstrativo por LINHA (tab Cores): para cada fileira com miçanga, lista
   * quantas de cada cor e o total. Visão geral de toda a peça.
   */
  function renderRowBreakdown() {
    var panel = $('rowBreakdownPanel');
    var box = $('rowBreakdown');
    if (!box) return;
    if (!state.grid) { if (panel) panel.hidden = true; box.innerHTML = ''; return; }
    var rows = HBPipeline.rowStats(state.grid);
    if (!rows.length) { if (panel) panel.hidden = true; box.innerHTML = ''; return; }
    if (panel) panel.hidden = false;
    var html = '';
    rows.forEach(function (r) {
      html += '<div class="rb-row"><span class="rb-label">L' + r.row + '</span>';
      r.items.forEach(function (it) {
        html += '<span class="rb-chip"><span class="sw" style="background:' + it.color.hex +
          '"></span><span class="lc">' + it.color.code + '</span>×' + it.count + '</span>';
      });
      html += '<span class="rb-total">' + r.total + '</span></div>';
    });
    box.innerHTML = html;
  }

  /**
   * Mini-resumo da linha ATUAL (modo montagem "linha por linha"): mostra acima
   * do preview quantas miçangas de cada cor a fileira em foco precisa.
   */
  function renderRowSummary() {
    var el = $('rowSummary');
    if (!el) return;
    if (!state.grid || !state.asm.on || state.asm.viewMode !== 'rows') {
      el.hidden = true;
      return;
    }
    // Sequência de colocação (run-length), na ordem da esquerda → direita.
    var rr = HBPipeline.rowRuns(state.grid, state.asm.currentRow);
    var html = '<span class="rs-head">Linha ' + state.asm.currentRow +
      (rr.total ? ' — ' + rr.total + ' miçangas' : '') + '</span>';
    if (!rr.total) {
      html += '<span class="muted">linha vazia</span>';
    } else {
      rr.segs.forEach(function (s) {
        if (s.idx < 0) {
          // Vazio no meio da linha (pular furos) — mantém a posição correta.
          html += '<span class="rb-chip rb-gap"><span class="sw"></span>vazio ×' + s.count + '</span>';
        } else {
          html += '<span class="rb-chip"><span class="sw" style="background:' + s.color.hex +
            '"></span><span class="lc">' + s.color.code + '</span> ×' + s.count + '</span>';
        }
      });
    }
    el.innerHTML = html;
    el.hidden = false;
  }

  /** Calcula as opções de overlay de montagem para o render atual. */
  function assemblyOverlay(g) {
    var asm = state.asm;
    if (!asm.on) return { focusIndex: null, activeRow: null, progress: null };
    var focusIndex = null;
    if (asm.focusCode) {
      var fi = g.colors.findIndex(function (c) { return c.code === asm.focusCode; });
      if (fi >= 0) focusIndex = fi;
    }
    var activeRow = asm.viewMode === 'rows' ? asm.currentRow : null;
    return { focusIndex: focusIndex, activeRow: activeRow, progress: state.progress };
  }

  /**
   * Badge: "imagem S×S · X beads (bandeja 52×52)". X é a contagem REAL de
   * miçangas usadas (células não vazias) — com o fundo removido, mostra só o que
   * você realmente vai montar.
   */
  function updateBadge() {
    var badge = $('gridBadge');
    badge.hidden = !state.grid;
    if (!state.grid) return;
    var used = 0;
    var a = state.grid.assign;
    for (var i = 0; i < a.length; i++) if (a[i] >= 0) used++;
    var detectedHint = '';
    if (state._detectedGrid) {
      detectedHint = ' <span class="cap" title="Grade original detectada automaticamente">✦ pixel art</span>';
    }
    badge.innerHTML =
      '<b>' + state.imgW + ' × ' + state.imgH + '</b> · <span class="beads">' +
      used.toLocaleString('pt-BR') + ' beads</span>' +
      ' <span class="cap">na bandeja ' + BOARD + '×' + BOARD + '</span>' +
      detectedHint;
  }

  /**
   * Aviso de grade detectada (pixel art). A detecção (HBPipeline.detectPixelArt)
   * lê o período das transições de cor e deriva a grade original; quando acha,
   * o tamanho já é aplicado automaticamente em resample(). Aqui só mostramos,
   * de forma clara e visível, qual grade foi lida.
   */
  function updateDetectNotice() {
    var el = $('detectNotice');
    if (!el) return;
    var d = state._detectedGrid;
    if (d) {
      el.innerHTML =
        '🔍 Detectei uma grade de <b>' + d.gridW + '×' + d.gridH +
        '</b> na imagem — ajustei o tamanho automaticamente. Mude no controle abaixo se quiser.';
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  /**
   * Posiciona a alça no canto inferior-direito da IMAGEM (bloco S×S centralizado
   * na bandeja 52×52). Calcula a partir do transform do PanZoom. Só na aba de cor.
   * Centro da bandeja = BOARD/2; canto da imagem = centro + S/2.
   */
  function updateSizer() {
    var handle = $('sizeHandle');
    // Esconde a alça fora da aba de cor, sem grade, ou durante a montagem/edição
    // (evita redimensionar sem querer ao tocar para marcar/pintar células).
    if (!state.grid || activeTab !== 'color' || state.asm.on || state.edit.on) {
      handle.hidden = true;
      return;
    }
    // Canto inferior-direito do bloco da imagem (W×H), centralizado na bandeja.
    var cornerX = BOARD / 2 + state.imgW / 2;
    var cornerY = BOARD / 2 + state.imgH / 2;
    var cellScreen = COLOR_CELL * panzoom.scale;
    handle.style.left = (panzoom.tx + cornerX * cellScreen) + 'px';
    handle.style.top = (panzoom.ty + cornerY * cellScreen) + 'px';
    handle.hidden = false;
  }

  /** Define o tamanho da imagem (lado maior S) dentro da bandeja. */
  function setImageCells(s, resampleNow) {
    s = Math.max(IMG_MIN, Math.min(IMG_MAX, Math.round(s)));
    if (s === state.params.imageCells) {
      if (resampleNow) resample();
      return false;
    }
    state.params.imageCells = s;
    $('gridSize').value = s;
    $('gridOut').textContent = s;
    // Atualiza W×H imediatamente (a alça/badge seguem o dedo antes do resample).
    var wh = computeWH(s, state.cropAR);
    state.imgW = wh.w; state.imgH = wh.h;
    updateBadge();
    if (resampleNow) resample();
    return true;
  }

  // ----- Cor de fundo do preview (branco <-> preto) -----------------------
  // Só afeta o canvas colorido na tela (o PNG/PDF continua branco). Útil para
  // distinguir miçangas brancas quando o fundo da arte também é branco.
  var PREVIEW_BG_LIGHT = '#ffffff';
  var PREVIEW_BG_DARK = '#16161a';

  function updateBgToggle() {
    var sw = $('bgSw');
    if (sw) sw.style.background = state.params.previewBg;
  }
  function setPreviewBg(color) {
    // Só estado de sessão (não persistido) — começa no padrão a cada visita.
    state.params.previewBg = color;
    updateBgToggle();
    if (state.grid) renderAll();
  }
  function togglePreviewBg() {
    var isLight = (state.params.previewBg || '').toLowerCase() === PREVIEW_BG_LIGHT;
    setPreviewBg(isLight ? PREVIEW_BG_DARK : PREVIEW_BG_LIGHT);
  }
  function loadPreviewBg() {
    try {
      var saved = localStorage.getItem('hama-preview-bg');
      if (saved) state.params.previewBg = saved;
    } catch (e) {}
    updateBgToggle();
  }

  function renderLegend() {
    var res = HBPipeline.colorStats(state.grid);
    var box = $('legend');
    box.innerHTML = '';
    var asmOn = state.asm.on;
    var p = state.progress;
    res.stats.forEach(function (s) {
      var el = document.createElement('div');
      el.className = 'legend-item';
      if (asmOn && state.asm.focusCode === s.color.code) el.classList.add('focused');
      var label = s.count;
      if (asmOn) {
        // quantas dessa cor faltam
        var fi = state.grid.colors.indexOf(s.color);
        var done = 0;
        for (var i = 0; i < state.grid.assign.length; i++) {
          if (state.grid.assign[i] === fi && p[i]) done++;
        }
        label = (s.count - done) + '/' + s.count;
      }
      el.innerHTML =
        '<span class="sw" style="background:' + s.color.hex + '"></span>' +
        '<span class="lc">' + s.color.code + '</span>' +
        '<span class="ln">' + label + '</span>';
      el.title = (s.color.name || '') + (asmOn ? ' — clique para focar' : '');
      el.style.cursor = 'pointer';
      el.addEventListener('click', function () { focusColorCode(s.color.code); });
      box.appendChild(el);
    });
    $('legendTotal').textContent =
      res.total + ' miçangas · ' + res.stats.length + ' cores';
  }

  // ====================================================================== //
  //  MODO MONTAGEM                                                         //
  // ====================================================================== //

  /** Liga/desliga o modo montagem e mostra/esconde os controles. */
  function setAssemblyOn(on) {
    if (on && state.edit.on) setEditOn(false); // não dá para montar e editar juntos
    state.asm.on = on;
    $('asmOn').checked = on;
    $('asmControls').hidden = !on;
    saveAsm();
    renderAll();
  }

  /** Alterna o formato de visualização: 'whole' (desenho todo) ou 'rows'. */
  function setViewMode(mode) {
    state.asm.viewMode = mode;
    $('viewWhole').classList.toggle('active', mode === 'whole');
    $('viewRows').classList.toggle('active', mode === 'rows');
    $('rowNav').hidden = mode !== 'rows';
    if (mode === 'rows') {
      // posiciona na primeira linha com miçanga
      var r = nextBeadRow(0, 1);
      state.asm.currentRow = r == null ? 0 : r;
      updateRowLabel();
    }
    saveAsm();
    renderAll();
  }

  function rowHasBead(y) {
    var a = state.grid.assign;
    for (var x = 0; x < BOARD; x++) if (a[y * BOARD + x] >= 0) return true;
    return false;
  }
  /** Próxima linha (na direção dir) que contém miçanga; null se não houver. */
  function nextBeadRow(from, dir) {
    if (!state.grid) return null;
    for (var y = from; y >= 0 && y < BOARD; y += dir) {
      if (rowHasBead(y)) return y;
    }
    return null;
  }

  /** Índice (em grid.colors) da cor focada na montagem, ou -1 se "todas". */
  function focusedColorIndex() {
    if (!state.asm.focusCode || !state.grid) return -1;
    return state.grid.colors.findIndex(function (c) { return c.code === state.asm.focusCode; });
  }
  /** Próxima linha (direção dir) que contém a cor `fi`; null se não houver. */
  function nextRowWithColor(from, dir, fi) {
    if (!state.grid) return null;
    var a = state.grid.assign;
    for (var y = from; y >= 0 && y < BOARD; y += dir) {
      for (var x = 0; x < BOARD; x++) if (a[y * BOARD + x] === fi) return y;
    }
    return null;
  }

  function gotoRow(dir) {
    var r = nextBeadRow(state.asm.currentRow + dir, dir);
    if (r == null) return;
    state.asm.currentRow = r;
    updateRowLabel();
    saveAsm();
    renderAll();
  }

  function updateRowLabel() {
    $('rowLabel').textContent = 'Linha ' + state.asm.currentRow;
  }

  /**
   * Marca a linha atual como feita e avança para a próxima linha.
   * Com foco de cor ligado, marca SÓ as miçangas da cor focada (e pula para a
   * próxima linha que ainda tenha essa cor). Sem foco, marca a linha inteira.
   */
  function markRowDone() {
    if (!state.grid) return;
    var y = state.asm.currentRow;
    var a = state.grid.assign;
    var fi = focusedColorIndex();
    for (var x = 0; x < BOARD; x++) {
      var i = y * BOARD + x;
      if (a[i] < 0) continue;
      if (fi >= 0 && a[i] !== fi) continue; // foco: ignora as outras cores
      state.progress[i] = 1;
    }
    var r = fi >= 0 ? nextRowWithColor(y + 1, 1, fi) : nextBeadRow(y + 1, 1);
    if (r != null) state.asm.currentRow = r;
    updateRowLabel();
    saveAsm();
    renderAll();
  }

  /** Define a cor focada (e sincroniza o select e a legenda). */
  function focusColorCode(code) {
    state.asm.focusCode = code || '';
    $('focusColor').value = state.asm.focusCode;
    $('colorDone').hidden = !state.asm.focusCode;
    saveAsm();
    renderAll();
  }

  /** Marca/desmarca todas as células da cor focada. */
  function toggleColorDone() {
    if (!state.grid || !state.asm.focusCode) return;
    var fi = state.grid.colors.findIndex(function (c) { return c.code === state.asm.focusCode; });
    if (fi < 0) return;
    var a = state.grid.assign, p = state.progress;
    // Se já estiver tudo feito, desmarca; senão marca tudo.
    var allDone = true;
    for (var i = 0; i < a.length; i++) { if (a[i] === fi && !p[i]) { allDone = false; break; } }
    for (i = 0; i < a.length; i++) { if (a[i] === fi) p[i] = allDone ? 0 : 1; }
    saveProgress();
    renderAll();
  }

  /** Repovoa o select de cor focada a partir das cores do molde atual. */
  function updateFocusOptions() {
    var sel = $('focusColor');
    if (!sel) return;
    var cur = state.asm.focusCode;
    var html = '<option value="">todas as cores</option>';
    if (state.grid) {
      state.grid.colors.forEach(function (c) {
        html += '<option value="' + c.code + '">' + c.code + ' · ' + (c.name || '') + '</option>';
      });
    }
    sel.innerHTML = html;
    if (cur && state.grid && state.grid.colors.some(function (c) { return c.code === cur; })) {
      sel.value = cur;
    } else {
      state.asm.focusCode = '';
      sel.value = '';
    }
    $('colorDone').hidden = !state.asm.focusCode;
  }

  /** Converte um ponto da tela na célula da bandeja (considera zoom/pan). */
  function viewportToCell(clientX, clientY) {
    if (!state.grid) return null;
    var r = $('viewport').getBoundingClientRect();
    var cx = (clientX - r.left - panzoom.tx) / panzoom.scale;
    var cy = (clientY - r.top - panzoom.ty) / panzoom.scale;
    var cell, margin;
    if (activeTab === 'color') { cell = COLOR_CELL; margin = 0; }
    else { cell = 24; margin = Math.max(16, Math.round(24 * 1.4)); }
    var gx = Math.floor((cx - margin) / cell);
    var gy = Math.floor((cy - margin) / cell);
    if (gx < 0 || gy < 0 || gx >= BOARD || gy >= BOARD) return null;
    return { x: gx, y: gy, i: gy * BOARD + gx };
  }

  /** Marca/desmarca uma célula (toque no preview). */
  function toggleCellDone(cell) {
    var a = state.grid.assign[cell.i];
    if (a < 0) return; // célula vazia: ignora
    state.progress[cell.i] = state.progress[cell.i] ? 0 : 1;
    saveProgress();
    renderAll();
  }

  /** Detecta TOQUE (sem arrasto) no preview para marcar células. */
  function setupAssemblyTap() {
    var vp = $('viewport');
    var sx = 0, sy = 0, st = 0, moved = false, pid = null, count = 0;
    vp.addEventListener('pointerdown', function (e) {
      count++;
      if (count > 1) { moved = true; return; } // multitoque = não é tap
      pid = e.pointerId; sx = e.clientX; sy = e.clientY; st = Date.now(); moved = false;
    });
    vp.addEventListener('pointermove', function (e) {
      if (e.pointerId !== pid) return;
      if (Math.abs(e.clientX - sx) > 6 || Math.abs(e.clientY - sy) > 6) moved = true;
    });
    function up(e) {
      count = Math.max(0, count - 1);
      if (e.pointerId !== pid) return;
      var isTap = !moved && (Date.now() - st) < 400;
      pid = null;
      if (isTap && state.asm.on && !state.edit.on && state.grid) {
        var cell = viewportToCell(e.clientX, e.clientY);
        if (cell) toggleCellDone(cell);
      }
    }
    vp.addEventListener('pointerup', up);
    vp.addEventListener('pointercancel', up);
  }

  /** Atualiza barra/texto de progresso (total e da cor focada). */
  function updateProgressUI() {
    if (!state.grid) return;
    var a = state.grid.assign, p = state.progress;
    var total = 0, done = 0;
    for (var i = 0; i < a.length; i++) { if (a[i] >= 0) { total++; if (p[i]) done++; } }
    var pct = total ? Math.round((done / total) * 100) : 0;
    $('progFill').style.width = pct + '%';
    var txt = pct + '% · ' + done + '/' + total;
    if (state.asm.focusCode) {
      var fi = state.grid.colors.findIndex(function (c) { return c.code === state.asm.focusCode; });
      if (fi >= 0) {
        var ft = 0, fd = 0;
        for (i = 0; i < a.length; i++) { if (a[i] === fi) { ft++; if (p[i]) fd++; } }
        txt += ' · faltam ' + (ft - fd) + ' ' + state.asm.focusCode;
      }
    }
    $('progText').textContent = txt;
    // Espelha na barra de progresso do rodapé (mobile).
    var fillM = $('progFillM'), textM = $('progTextM');
    if (fillM) fillM.style.width = pct + '%';
    if (textM) textM.textContent = txt;
  }

  function resetProgress() {
    if (state.progress) state.progress.fill(0);
    saveProgress();
    renderAll();
  }

  // ----- Tela: manter acesa / travar / tela cheia -------------------------
  function setWake(on) {
    state.asm.wake = on;
    $('wakeBtn').classList.toggle('on', on);
    if (on) {
      if (navigator.wakeLock && navigator.wakeLock.request) {
        navigator.wakeLock.request('screen').then(function (wl) {
          wakeLock = wl;
        }).catch(function () { /* sem suporte / sem gesto */ });
      }
    } else if (wakeLock) {
      try { wakeLock.release(); } catch (e) {}
      wakeLock = null;
    }
  }

  function setLock(on) {
    state.asm.lock = on;
    panzoom.locked = on;
    $('lockBtn').classList.toggle('on', on);
    $('viewport').classList.toggle('locked', on);
  }

  function toggleFullscreen() {
    var el = document.querySelector('.output');
    if (!document.fullscreenElement) {
      if (el.requestFullscreen) el.requestFullscreen();
    } else if (document.exitFullscreen) {
      document.exitFullscreen();
    }
  }

  // ----- Persistência do progresso ----------------------------------------
  function encodeProgress() {
    var p = state.progress, s = '';
    for (var i = 0; i < p.length; i++) s += String.fromCharCode(p[i] ? 1 : 0);
    return btoa(s);
  }
  function decodeProgress(b64) {
    try {
      var s = atob(b64);
      var p = new Uint8Array(BOARD * BOARD);
      for (var i = 0; i < p.length && i < s.length; i++) p[i] = s.charCodeAt(i) ? 1 : 0;
      return p;
    } catch (e) { return null; }
  }
  // Sessão nova a cada visita: o progresso de montagem vive só em memória
  // (state.progress / state.asm) durante a sessão e NÃO é persistido.
  function saveAsm() { /* sem persistência — ver decisão de sessão no init() */ }
  function saveProgress() { /* idem */ }

  function loadAsm() {
    try {
      var raw = localStorage.getItem('hama-assembly-v1');
      if (!raw) return;
      var d = JSON.parse(raw);
      var p = decodeProgress(d.progress);
      if (p) state.progress = p;
      state.asm.viewMode = d.viewMode === 'rows' ? 'rows' : 'whole';
      state.asm.focusCode = d.focusCode || '';
      state.asm.on = !!d.on;
      state.asm.currentRow = d.currentRow || 0;
    } catch (e) {}
  }

  /** Aplica o estado de montagem na interface (após carregar do storage). */
  function applyAsmUI() {
    $('asmOn').checked = state.asm.on;
    $('asmControls').hidden = !state.asm.on;
    $('viewWhole').classList.toggle('active', state.asm.viewMode === 'whole');
    $('viewRows').classList.toggle('active', state.asm.viewMode === 'rows');
    $('rowNav').hidden = state.asm.viewMode !== 'rows';
    updateRowLabel();
  }

  // ====================================================================== //
  //  EDITOR DE GRADE                                                       //
  //  Pincel / borracha / balde / conta-gotas. Opera direto em             //
  //  state.grid.assign (bandeja 52×52). Enquanto ligado, a conversão fica  //
  //  congelada (resample/remap retornam cedo) para não apagar os traços.   //
  // ====================================================================== //

  var editStrokeSnapped = false; // já tiramos snapshot deste gesto?

  /** Liga/desliga o modo edição. Exige uma grade já existente. */
  function setEditOn(on) {
    if (on && !state.grid) on = false; // nada para editar ainda
    state.edit.on = on;
    $('editOn').checked = on;
    $('editControls').hidden = !on;
    if (panzoom) panzoom.paintMode = on;
    if (on) {
      if (state.asm.on) setAssemblyOn(false); // edição e montagem não convivem
      if (!state.edit.colorCode) {
        var act = HBPalette.activeColors(state.palette);
        if (act.length) state.edit.colorCode = act[0].code;
      }
      buildEditColors();
      updateUndoRedo();
    }
    updateSizer();
    if (state.grid) renderAll();
  }

  /** Define a ferramenta ativa e destaca o botão. */
  function setTool(tool) {
    state.edit.tool = tool;
    [['brush', 'toolBrush'], ['erase', 'toolErase'],
     ['fill', 'toolFill'], ['pick', 'toolPick'], ['move', 'toolMove']].forEach(function (t) {
      var el = $(t[1]);
      if (el) el.classList.toggle('active', t[0] === tool);
    });
  }

  /** Monta a régua de cores (paleta ativa) para escolher a cor do pincel. */
  function buildEditColors() {
    var box = $('editColors');
    if (!box) return;
    box.innerHTML = '';
    HBPalette.activeColors(state.palette).forEach(function (c) {
      var b = document.createElement('button');
      b.className = 'ec-sw' + (c.code === state.edit.colorCode ? ' selected' : '');
      b.style.background = c.hex;
      b.title = c.code + ' · ' + (c.name || '');
      b.setAttribute('data-code', c.code);
      b.addEventListener('click', function () { selectEditColor(c.code); });
      box.appendChild(b);
    });
  }

  /** Escolhe a cor ativa (e, se estava no conta-gotas, volta ao pincel). */
  function selectEditColor(code) {
    state.edit.colorCode = code;
    if (state.edit.tool === 'pick') setTool('brush');
    var box = $('editColors');
    if (box) {
      Array.prototype.forEach.call(box.children, function (el) {
        el.classList.toggle('selected', el.getAttribute('data-code') === code);
      });
    }
  }

  /**
   * Índice (em state.grid.colors) da cor de código `code`. Se a cor ainda não
   * está na grade, adiciona (append-only: índices antigos seguem válidos, o que
   * mantém os snapshots de undo consistentes).
   */
  function ensureColorIndex(code) {
    var g = state.grid;
    var idx = g.colors.findIndex(function (c) { return c.code === code; });
    if (idx >= 0) return idx;
    var c = state.palette.find(function (p) { return p.code === code; });
    if (!c) return -1;
    g.colors.push(c);
    return g.colors.length - 1;
  }

  /** Snapshot do assign no início do gesto (uma vez por traço). */
  function pushUndoOnce() {
    if (editStrokeSnapped) return;
    editStrokeSnapped = true;
    state.edit.undo.push(Int16Array.from(state.grid.assign));
    if (state.edit.undo.length > 60) state.edit.undo.shift();
    state.edit.redo.length = 0;
  }

  /** Preenchimento por área (flood fill, 4 vizinhos) a partir da célula i. */
  function floodFill(start, toIdx) {
    var g = state.grid, a = g.assign, w = g.w, h = g.h;
    var target = a[start];
    if (target === toIdx) return;
    var stack = [start];
    while (stack.length) {
      var i = stack.pop();
      if (a[i] !== target) continue;
      a[i] = toIdx;
      var x = i % w, y = (i / w) | 0;
      if (x > 0) stack.push(i - 1);
      if (x < w - 1) stack.push(i + 1);
      if (y > 0) stack.push(i - w);
      if (y < h - 1) stack.push(i + w);
    }
  }

  /**
   * Desloca TODO o desenho por (dx,dy) células, sempre a partir de `base` (o
   * snapshot do início do gesto). Recalcular a partir da base a cada passo torna
   * o arrasto não-destrutivo: ir e voltar não perde conteúdo. O que sai da
   * bandeja durante ESTE gesto é recortado (vira vazio); ao soltar e começar
   * outro arrasto, o recorte se torna definitivo.
   */
  function shiftFromBase(base, dx, dy) {
    var g = state.grid, w = g.w, h = g.h, a = g.assign;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var sx = x - dx, sy = y - dy;
        a[y * w + x] = (sx >= 0 && sx < w && sy >= 0 && sy < h) ? base[sy * w + sx] : -1;
      }
    }
    state.edit.dirty = true;
    commitEdit();
  }

  /** Aplica a ferramenta ativa na célula. */
  function applyTool(cell) {
    var g = state.grid, i = cell.i, tool = state.edit.tool;

    if (tool === 'pick') {
      var a = g.assign[i];
      if (a >= 0) selectEditColor(g.colors[a].code);
      return;
    }
    if (tool === 'erase') {
      if (g.assign[i] === -1) return;
      pushUndoOnce();
      g.assign[i] = -1;
    } else if (tool === 'fill') {
      var fi = ensureColorIndex(state.edit.colorCode);
      if (fi < 0) return;
      if (g.assign[i] === fi) return;
      pushUndoOnce();
      floodFill(i, fi);
    } else { // brush
      var bi = ensureColorIndex(state.edit.colorCode);
      if (bi < 0) return;
      if (g.assign[i] === bi) return;
      pushUndoOnce();
      g.assign[i] = bi;
    }
    state.edit.dirty = true;
    commitEdit();
  }

  /** Re-renderiza, persiste e atualiza os botões de desfazer/refazer. */
  function commitEdit() {
    updateFocusOptions();
    renderAll();
    saveEditGrid();
    updateUndoRedo();
  }

  function doUndo() {
    var u = state.edit.undo;
    if (!u.length || !state.grid) return;
    state.edit.redo.push(Int16Array.from(state.grid.assign));
    state.grid.assign = u.pop();
    commitEdit();
  }
  function doRedo() {
    var r = state.edit.redo;
    if (!r.length || !state.grid) return;
    state.edit.undo.push(Int16Array.from(state.grid.assign));
    state.grid.assign = r.pop();
    commitEdit();
  }
  function updateUndoRedo() {
    var u = $('editUndo'), r = $('editRedo');
    if (u) u.disabled = !state.edit.undo.length;
    if (r) r.disabled = !state.edit.redo.length;
  }

  /**
   * Captura de toque para PINTAR: 1 dedo pinta/arrasta; ao surgir um 2º dedo o
   * traço é cancelado (vira pan/zoom no PanZoom). Roda em paralelo ao PanZoom,
   * que no paintMode ignora o pan de 1 dedo.
   */
  function setupEditPaint() {
    var vp = $('viewport');
    var active = false, pid = null, lastCell = -1, count = 0;
    // Estado do arrasto da ferramenta Mão.
    var moveBase = null, moveStart = null, lastDx = 0, lastDy = 0;

    function paintAt(cx, cy) {
      var cell = viewportToCell(cx, cy);
      if (!cell) return;
      if (state.edit.tool !== 'pick' && cell.i === lastCell) return;
      lastCell = cell.i;
      applyTool(cell);
    }

    function startMove(cx, cy) {
      moveBase = Int16Array.from(state.grid.assign);
      moveStart = { x: cx, y: cy };
      lastDx = 0; lastDy = 0;
    }
    function doMove(cx, cy) {
      if (!moveBase) return;
      // Converte o deslocamento em pixels da tela para células (snap inteiro).
      var cell = activeTab === 'color' ? COLOR_CELL : 24;
      var cs = cell * panzoom.scale;
      var dx = Math.round((cx - moveStart.x) / cs);
      var dy = Math.round((cy - moveStart.y) / cs);
      if (dx === lastDx && dy === lastDy) return; // ainda na mesma célula
      lastDx = dx; lastDy = dy;
      if (dx !== 0 || dy !== 0) pushUndoOnce(); // snapshot só quando de fato moveu
      shiftFromBase(moveBase, dx, dy);
    }

    vp.addEventListener('pointerdown', function (e) {
      count++;
      if (!state.edit.on || !state.grid) return;
      if (count > 1) { active = false; pid = null; moveBase = null; return; } // 2 dedos = pan/zoom
      pid = e.pointerId; active = true; lastCell = -1; editStrokeSnapped = false;
      if (state.edit.tool === 'move') startMove(e.clientX, e.clientY);
      else paintAt(e.clientX, e.clientY);
      e.preventDefault();
    });
    vp.addEventListener('pointermove', function (e) {
      if (!active || e.pointerId !== pid) return;
      if (state.edit.tool === 'move') doMove(e.clientX, e.clientY);
      else paintAt(e.clientX, e.clientY);
      e.preventDefault();
    });
    function end(e) {
      count = Math.max(0, count - 1);
      if (e.pointerId === pid) { active = false; pid = null; moveBase = null; }
    }
    vp.addEventListener('pointerup', end);
    vp.addEventListener('pointercancel', end);
  }

  function bindEdit() {
    $('editOn').addEventListener('change', function (e) { setEditOn(e.target.checked); });
    $('toolBrush').addEventListener('click', function () { setTool('brush'); });
    $('toolErase').addEventListener('click', function () { setTool('erase'); });
    $('toolFill').addEventListener('click', function () { setTool('fill'); });
    $('toolPick').addEventListener('click', function () { setTool('pick'); });
    $('toolMove').addEventListener('click', function () { setTool('move'); });
    $('editUndo').addEventListener('click', doUndo);
    $('editRedo').addEventListener('click', doRedo);
    setupEditPaint();
  }

  // ----- Persistência da grade (editada/convertida) -----------------------
  // Salva o assign + as cores como base64; restaura no reload. De quebra,
  // recupera a grade ao reabrir o app (antes o progresso era salvo, mas a
  // grade sumia).
  // Sessão nova a cada visita: a grade convertida/editada NÃO é mais persistida
  // (antes ia para 'hama-edit-v1'). Fica só em state.grid durante a sessão.
  function saveEditGrid() { /* sem persistência — ver decisão de sessão no init() */ }

  function loadEditGrid() {
    try {
      var raw = localStorage.getItem('hama-edit-v1');
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (!d || !d.assign || !Array.isArray(d.colors)) return null;
      var bin = atob(d.assign);
      if (bin.length % 2 !== 0) return null;
      var u8 = new Uint8Array(bin.length);
      for (var k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
      var assign = Int16Array.from(new Int16Array(u8.buffer));
      if (assign.length !== d.w * d.h) return null;
      var colors = d.colors.map(function (c) {
        return HBPalette.refreshColor({ code: c.code, name: c.name || '', hex: c.hex, enabled: true });
      });
      if (typeof d.imgW === 'number') state.imgW = d.imgW;
      if (typeof d.imgH === 'number') state.imgH = d.imgH;
      return { w: d.w, h: d.h, colors: colors, assign: assign };
    } catch (e) { return null; }
  }

  // ====================================================================== //
  //  CARREGAR IMAGEM                                                       //
  // ====================================================================== //
  function loadImage(src) {
    var img = new Image();
    img.onload = function () {
      state.image = img;
      state._fitted = false;
      state._pendingAutoDetect = true;  // detecta pixel art na primeira amostragem
      state._detectedGrid = null;
      // Nova imagem = novo molde: zera o progresso de montagem.
      if (state.progress) state.progress.fill(0);
      state.asm.currentRow = 0;
      saveProgress();
      $('cropPanel').hidden = false;
      var hint = $('cropEmptyHint');
      if (hint) hint.hidden = true;
      crop.setImage(img);
      // No mobile, avança automaticamente para o passo de enquadramento.
      if (window.matchMedia('(max-width: 919px)').matches) setMobileTab('enquadrar');
    };
    img.onerror = function () { alert('Não foi possível carregar a imagem.'); };
    img.src = src;
  }

  function makeSampleImage() {
    // Se houver imagem de exemplo embutida (js/sample-image.js), usa ela.
    if (window.HB_SAMPLE_IMAGE) {
      loadImage(window.HB_SAMPLE_IMAGE);
      return;
    }
    // Senão, cena sintética simples (céu, sol, grama, coração).
    var c = document.createElement('canvas');
    c.width = c.height = 200;
    var x = c.getContext('2d');
    x.fillStyle = '#7ec8f0'; x.fillRect(0, 0, 200, 200);            // céu
    x.fillStyle = '#f4d03f';                                          // sol
    x.beginPath(); x.arc(150, 50, 28, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#4caf50'; x.fillRect(0, 140, 200, 60);           // grama
    x.fillStyle = '#e8568a';                                          // coração
    x.beginPath();
    x.moveTo(100, 120);
    x.bezierCurveTo(60, 80, 60, 60, 100, 90);
    x.bezierCurveTo(140, 60, 140, 80, 100, 120);
    x.fill();
    x.fillStyle = '#7a4a2a'; x.fillRect(40, 110, 12, 40);          // tronco
    x.fillStyle = '#2e8b3d';                                          // copa
    x.beginPath(); x.arc(46, 100, 26, 0, Math.PI * 2); x.fill();
    loadImage(c.toDataURL('image/png'));
  }

  // ====================================================================== //
  //  PALETA (editor) + SELECTS                                            //
  // ====================================================================== //
  function buildPaletteEditor() {
    var box = $('paletteList');
    box.innerHTML = '';
    state.palette.forEach(function (c, i) {
      var row = document.createElement('div');
      row.className = 'pal-row' + (c.enabled ? '' : ' disabled');

      var chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = c.enabled;
      chk.addEventListener('change', function () {
        c.enabled = chk.checked;
        row.classList.toggle('disabled', !c.enabled);
        HBPalette.save(state.palette);
        refreshColorSelects();
        scheduleRemap();
      });

      var code = document.createElement('span');
      code.className = 'pal-code';
      code.textContent = c.code;

      var name = document.createElement('span');
      name.className = 'pal-name';
      name.textContent = c.name || '';

      var color = document.createElement('input');
      color.type = 'color';
      color.value = normalizeHex(c.hex);
      color.addEventListener('input', function () {
        c.hex = color.value;
        HBPalette.refreshColor(c);
        HBPalette.save(state.palette);
        scheduleRemap();
      });

      row.appendChild(chk);
      row.appendChild(code);
      row.appendChild(name);
      row.appendChild(color);
      box.appendChild(row);
    });
  }

  function normalizeHex(hex) {
    var rgb = HBColors.hexToRgb(hex);
    return HBColors.rgbToHex(rgb.r, rgb.g, rgb.b);
  }

  function refreshColorSelects() {
    var active = HBPalette.activeColors(state.palette);
    var optionsHtml = active
      .map(function (c) { return '<option value="' + c.code + '">' + c.code + ' · ' + (c.name || '') + '</option>'; })
      .join('');

    var bg = $('bgColor');
    var keepBg = state.params.bgColor;
    bg.innerHTML = optionsHtml;
    if (keepBg) bg.value = keepBg;
    state.params.bgColor = bg.value;

    $('replaceFrom').innerHTML = optionsHtml;
    $('replaceTo').innerHTML = optionsHtml;

    buildEditColors(); // mantém a régua de cores do editor em sincronia
  }

  function renderReplacements() {
    var ul = $('replaceList');
    ul.innerHTML = '';
    state.replacements.forEach(function (rep, idx) {
      var li = document.createElement('li');
      var span = document.createElement('span');
      span.textContent = rep.from + ' → ' + rep.to;
      var btn = document.createElement('button');
      btn.className = 'ghost';
      btn.textContent = 'remover';
      btn.addEventListener('click', function () {
        state.replacements.splice(idx, 1);
        renderReplacements();
        scheduleRemap();
      });
      li.appendChild(span);
      li.appendChild(btn);
      ul.appendChild(li);
    });
  }

  // ====================================================================== //
  //  BIND DOS CONTROLES                                                    //
  // ====================================================================== //
  function bindControls() {
    // Upload (galeria e câmera usam o mesmo tratamento)
    function handlePick(e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () { loadImage(reader.result); };
      reader.readAsDataURL(file);
    }
    $('fileInput').addEventListener('change', handlePick);
    $('cameraInput').addEventListener('change', handlePick);
    $('sampleBtn').addEventListener('click', makeSampleImage);
    $('cropResetBtn').addEventListener('click', function () { crop.reset(); });

    // Ajustes (resample)
    bindRange('gridSize', 'gridOut', function (v) {
      state._pendingAutoDetect = false; // usuário assumiu controle manual
      state._useDetectedGrid = false;   // tamanho manual desliga a grade nativa
      state.params.imageCells = v;
      var wh = computeWH(v, state.cropAR);
      state.imgW = wh.w; state.imgH = wh.h;
      updateBadge();
      updateSizer();
      scheduleResample();
    });
    $('sampleMethod').addEventListener('change', function (e) {
      state.params.sampleMethod = e.target.value;
      scheduleResample();
    });
    $('simplify').addEventListener('change', function (e) {
      state.params.simplify = e.target.checked;
      scheduleRemap();
    });
    // Círculo da bandeja (só visual — re-renderiza, não reamostra).
    $('trayCircle').addEventListener('change', function (e) {
      state.params.trayCircle = e.target.checked;
      $('trayDiameterField').style.display = e.target.checked ? '' : 'none';
      if (state.grid) renderAll();
    });
    bindRange('trayDiameter', 'trayOut', function (v) {
      state.params.trayDiameter = v;
      if (state.grid) renderAll();
    });
    bindRange('brightness', 'brightOut', function (v) { state.params.brightness = v; scheduleResample(); });
    bindRange('contrast', 'contrastOut', function (v) { state.params.contrast = v; scheduleResample(); });
    bindRange('saturation', 'satOut', function (v) { state.params.saturation = v; scheduleResample(); });
    bindRange('posterize', 'postOut', function (v) { state.params.posterize = v; scheduleResample(); });
    bindRange('blur', 'blurOut', function (v) { state.params.blur = v; scheduleResample(); });

    // Cores (remap)
    $('dithering').addEventListener('change', function (e) {
      state.params.dithering = e.target.checked; scheduleRemap();
    });
    bindRange('maxColors', 'maxColorsOut', function (v) {
      state.params.maxColors = v;
      $('maxColorsOut').textContent = v === 0 ? 'sem limite' : v;
      scheduleRemap();
    }, true);

    // Fundo (remap)
    $('bgMode').addEventListener('change', function (e) {
      state.params.bgMode = e.target.value;
      $('bgColorField').hidden = e.target.value !== 'color';
      scheduleRemap();
    });
    $('bgColor').addEventListener('change', function (e) {
      state.params.bgColor = e.target.value; scheduleRemap();
    });
    bindRange('bgTol', 'bgTolOut', function (v) { state.params.bgTol = v; scheduleRemap(); });

    // Substituição
    $('replaceAddBtn').addEventListener('click', function () {
      var from = $('replaceFrom').value, to = $('replaceTo').value;
      if (!from || !to || from === to) return;
      state.replacements.push({ from: from, to: to });
      renderReplacements();
      scheduleRemap();
    });

    // Paleta
    $('palAllBtn').addEventListener('click', function () { setAllEnabled(true); });
    $('palNoneBtn').addEventListener('click', function () { setAllEnabled(false); });
    $('palResetBtn').addEventListener('click', function () {
      state.palette = HBPalette.makeDefault();
      HBPalette.clearSaved();
      buildPaletteEditor();
      refreshColorSelects();
      scheduleRemap();
    });

    // Exportar
    $('pngColorBtn').addEventListener('click', exportColorPNG);
    $('pngCodeBtn').addEventListener('click', exportCodePNG);
    $('splitMode').addEventListener('change', function (e) {
      state.params.splitMode = e.target.value;
      $('tileField').hidden = e.target.value !== 'tiles';
    });
    bindRange('cellsPerPage', 'tileOut', function (v) { state.params.cellsPerPage = v; });
    $('printBtn').addEventListener('click', exportPrint);

    // Abas
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
      tab.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
          t.classList.remove('active');
        });
        tab.classList.add('active');
        activeTab = tab.dataset.tab;
        $('colorCanvas').hidden = activeTab !== 'color';
        $('codeCanvas').hidden = activeTab !== 'code';
        panzoom.fit(activeTab === 'color' ? $('colorCanvas') : $('codeCanvas'));
        updateSizer();
      });
    });

    // Arrastar a alça do canto do preview para mudar o tamanho da grade.
    bindSizeHandle();

    // Modo montagem
    bindAssembly();

    // Editor de grade
    bindEdit();

    // Zoom
    $('zoomIn').addEventListener('click', function () {
      var r = $('viewport').getBoundingClientRect();
      panzoom.zoomAround(panzoom.scale * 1.25, r.width / 2, r.height / 2);
    });
    $('zoomOut').addEventListener('click', function () {
      var r = $('viewport').getBoundingClientRect();
      panzoom.zoomAround(panzoom.scale / 1.25, r.width / 2, r.height / 2);
    });
    $('zoomReset').addEventListener('click', function () {
      panzoom.fit(activeTab === 'color' ? $('colorCanvas') : $('codeCanvas'));
    });

    // Cor de fundo do preview (branco <-> preto).
    $('bgToggle').addEventListener('click', togglePreviewBg);
  }

  function bindRange(id, outId, cb, custom) {
    var el = $(id);
    var out = $(outId);
    el.addEventListener('input', function () {
      var v = parseInt(el.value, 10);
      if (!custom && out) out.textContent = v;
      cb(v);
    });
  }

  /**
   * Arrasto da alça (canto inferior-direito da grade) para definir N×N.
   * Durante o arrasto, mantemos o transform do PanZoom fixo (a grade cresce a
   * partir do canto superior-esquerdo), então o N é obtido pela distância do
   * ponteiro até esse canto, dividida pelo tamanho de célula na tela.
   * stopPropagation evita que o PanZoom interprete isso como pan.
   */
  function bindSizeHandle() {
    var handle = $('sizeHandle');
    var dragging = false;

    // Converte a posição do ponteiro no tamanho de imagem S (centralizada).
    // Canto da imagem = centro(BOARD/2) + S/2  =>  S = (cantoCélula - BOARD/2) * 2.
    function pointerToS(ev) {
      var r = $('viewport').getBoundingClientRect();
      var px = ev.clientX - r.left;
      var py = ev.clientY - r.top;
      var cellScreen = COLOR_CELL * panzoom.scale;
      var bx = (px - panzoom.tx) / cellScreen;
      var by = (py - panzoom.ty) / cellScreen;
      var sx = (bx - BOARD / 2) * 2;
      var sy = (by - BOARD / 2) * 2;
      return Math.max(sx, sy); // arrastar em qualquer eixo aumenta a imagem
    }

    handle.addEventListener('pointerdown', function (ev) {
      if (!state.grid) return;
      dragging = true;
      handle.setPointerCapture(ev.pointerId);
      ev.preventDefault();
      ev.stopPropagation();
    });
    handle.addEventListener('pointermove', function (ev) {
      if (!dragging) return;
      state._pendingAutoDetect = false; // usuário assumiu controle manual
      state._useDetectedGrid = false;   // tamanho manual desliga a grade nativa
      var changed = setImageCells(pointerToS(ev), false);
      if (changed) {
        updateSizer();         // reposiciona a alça para o novo tamanho
        throttledResample();   // re-renderiza sem travar
      }
      ev.preventDefault();
      ev.stopPropagation();
    });
    function endDrag(ev) {
      if (!dragging) return;
      dragging = false;
      resample();                                  // render final exato
      panzoom.fit($('colorCanvas'));               // recentraliza
      ev && ev.stopPropagation();
    }
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
  }

  /** Liga todos os controles da barra de montagem. */
  function bindAssembly() {
    $('asmOn').addEventListener('change', function (e) { setAssemblyOn(e.target.checked); });
    $('viewWhole').addEventListener('click', function () { setViewMode('whole'); });
    $('viewRows').addEventListener('click', function () { setViewMode('rows'); });
    $('rowPrev').addEventListener('click', function () { gotoRow(-1); });
    $('rowNext').addEventListener('click', function () { gotoRow(1); });
    $('rowDone').addEventListener('click', markRowDone);
    $('focusColor').addEventListener('change', function (e) { focusColorCode(e.target.value); });
    $('colorDone').addEventListener('click', toggleColorDone);
    $('progReset').addEventListener('click', resetProgress);
    $('progResetM').addEventListener('click', resetProgress);
    // ⚙️ Configurações (mobile): abre/fecha o painel de ajustes da montagem.
    $('settingsBtn').addEventListener('click', function () {
      $('asmSettings').classList.toggle('open');
    });

    // Tela
    $('lockBtn').addEventListener('click', function () { setLock(!state.asm.lock); });
    $('wakeBtn').addEventListener('click', function () { setWake(!state.asm.wake); });
    $('fsBtn').addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', function () {
      $('fsBtn').classList.toggle('on', !!document.fullscreenElement);
    });
    // Reativa o wake lock ao voltar para a aba (o navegador o solta sozinho).
    document.addEventListener('visibilitychange', function () {
      if (state.asm.wake && document.visibilityState === 'visible' && !wakeLock) setWake(true);
    });

    // Toque no preview marca células (detecção de tap separada do pan/zoom).
    setupAssemblyTap();
  }

  function setAllEnabled(val) {
    state.palette.forEach(function (c) { c.enabled = val; });
    HBPalette.save(state.palette);
    buildPaletteEditor();
    refreshColorSelects();
    scheduleRemap();
  }

  // ====================================================================== //
  //  NAVEGAÇÃO MOBILE (abas no rodapé)                                     //
  // ====================================================================== //
  /** Liga as 4 abas do rodapé (só fazem efeito visual no mobile via CSS). */
  function initMobileTabs() {
    Array.prototype.forEach.call(document.querySelectorAll('.mtab'), function (btn) {
      btn.addEventListener('click', function () { setMobileTab(btn.dataset.mtab); });
    });
  }

  function setMobileTab(g) {
    $('layout').setAttribute('data-mtab', g);
    Array.prototype.forEach.call(document.querySelectorAll('.mtab'), function (b) {
      b.classList.toggle('active', b.dataset.mtab === g);
    });
    // Sair da aba "Editar" desliga o modo edição (descongela a conversão).
    if (g !== 'editar' && state.edit.on) setEditOn(false);
    Array.prototype.forEach.call(document.querySelectorAll('.ctl-group'), function (el) {
      el.classList.toggle('active', el.dataset.group === g);
    });
    // Ao entrar em "Montar", liga a montagem e garante o modo "linha por linha"
    // (fluxo principal no celular) na 1ª entrada da sessão. Fazemos isso mesmo
    // quando a montagem já vinha LIGADA do estado salvo — senão um PWA que
    // salvou viewMode='whole' (localStorage próprio, separado do Safari) abria
    // em "Desenho todo" e a linha em foco nunca aparecia. Só na 1ª vez para
    // respeitar uma troca manual para "Desenho todo" durante o uso.
    if (g === 'montar') {
      if (!state.asm.on) setAssemblyOn(true);
      if (!state._montarInit) {
        state._montarInit = true;
        if (state.asm.viewMode !== 'rows') setViewMode('rows');
      }
    }
    // Ao entrar em "Editar", liga o modo edição (precisa de uma grade pronta).
    if (g === 'editar') setEditOn(true);
    // Fecha o painel de configurações ao trocar de aba.
    var s = $('asmSettings');
    if (s) s.classList.remove('open');
    // A altura disponível muda ao trocar de aba: dispara um resize para o
    // recorte recalcular o palco (que cresce na aba "Recorte") e reencaixa o
    // molde no preview.
    setTimeout(function () {
      window.dispatchEvent(new Event('resize'));
      if (state.grid && panzoom) {
        panzoom.fit(activeTab === 'color' ? $('colorCanvas') : $('codeCanvas'));
      }
    }, 30);
  }

  // ====================================================================== //
  //  EXPORTAR                                                              //
  // ====================================================================== //
  function exportColorPNG() {
    if (!state.grid) return alert('Converta uma imagem primeiro.');
    var cv = document.createElement('canvas');
    HBRender.drawGrid(cv, state.grid, {
      mode: 'color', cellSize: 18, showGrid: true, guideEvery: 10,
      trayDiameter: state.params.trayCircle ? state.params.trayDiameter : 0,
    });
    HBExport.downloadCanvasPNG(cv, 'molde-colorido.png');
  }

  function exportCodePNG() {
    if (!state.grid) return alert('Converta uma imagem primeiro.');
    var cv = document.createElement('canvas');
    HBRender.drawGrid(cv, state.grid, {
      mode: 'code', cellSize: 28, showGrid: true, guideEvery: 10, showAxes: true,
      trayDiameter: state.params.trayCircle ? state.params.trayDiameter : 0,
    });
    HBExport.downloadCanvasPNG(cv, 'molde-codigo.png');
  }

  function exportPrint() {
    if (!state.grid) return alert('Converta uma imagem primeiro.');
    var preview = document.createElement('canvas');
    HBRender.drawGrid(preview, state.grid, {
      mode: 'color', cellSize: 12, showGrid: true, guideEvery: 10,
    });
    var stats = HBPipeline.colorStats(state.grid);
    HBExport.openPrintable(state.grid, stats, {
      title: 'Molde Hama Beads',
      split: state.params.splitMode,
      cellsPerPage: state.params.cellsPerPage,
      guideEvery: 10,
      colorPreviewCanvas: preview,
      includeLegend: true,
    });
  }

  // ====================================================================== //
  //  INIT                                                                  //
  // ====================================================================== //
  function init() {
    crop = new HBCrop.CropController($('cropStage'), {
      onChange: scheduleResample,
    });
    panzoom = new PanZoom($('viewport'), $('canvasPan'));
    panzoom.onUpdate = updateSizer; // reposiciona a alça ao dar zoom/pan

    // Progresso de montagem (bandeja fixa 52×52). Sessão nova a cada visita:
    // NÃO restauramos grade/progresso/preview salvos — só a paleta do kit
    // sobrevive entre visitas (ver palette.js). Isso mantém o app leve e sem
    // "estado fantasma" de moldes antigos ao reabrir.
    state.progress = new Uint8Array(BOARD * BOARD);
    applyAsmUI();

    buildPaletteEditor();
    refreshColorSelects();
    renderReplacements();
    bindControls();
    initMobileTabs();
    updateBgToggle();

    // Reflete valores iniciais nos outputs.
    $('maxColorsOut').textContent = 'sem limite';
  }

  document.addEventListener('DOMContentLoaded', init);
})();
