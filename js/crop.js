/*
 * crop.js
 * --------------------------------------------------------------------------
 * Enquadramento quadrado da imagem antes da conversão (a grade é quadrada).
 * Mostra a imagem ajustada ("contain") dentro de um palco e sobrepõe uma
 * seleção quadrada que pode ser arrastada e redimensionada — funciona com
 * mouse e com toque (Pointer Events).
 *
 * Saída: getCroppedCanvas(maxSize) devolve um canvas quadrado com a região
 * escolhida, na resolução de trabalho (limitada para manter o app rápido).
 * --------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function CropController(stage, opts) {
    this.stage = stage;
    this.opts = opts || {};
    this.onChange = this.opts.onChange || function () {};
    this.img = null;        // HTMLImageElement original
    this.natW = 0;
    this.natH = 0;
    this.sel = { x: 0, y: 0, size: 0 }; // em pixels naturais
    this.disp = { left: 0, top: 0, width: 0, height: 0, scale: 1 };

    this._build();
    this._bindEvents();

    window.addEventListener('resize', () => {
      if (this.img) {
        this._recomputeDisplay();
        this._render();
      }
    });
  }

  CropController.prototype._build = function () {
    this.stage.classList.add('crop-stage');
    this.stage.innerHTML = '';

    this.imgEl = document.createElement('img');
    this.imgEl.className = 'crop-img';
    this.imgEl.alt = 'imagem para recortar';
    this.stage.appendChild(this.imgEl);

    this.box = document.createElement('div');
    this.box.className = 'crop-box';
    ['nw', 'ne', 'sw', 'se'].forEach((pos) => {
      const hd = document.createElement('div');
      hd.className = 'crop-handle crop-handle-' + pos;
      hd.dataset.handle = pos;
      this.box.appendChild(hd);
    });
    this.stage.appendChild(this.box);
  };

  CropController.prototype.setImage = function (img) {
    this.img = img;
    this.natW = img.naturalWidth || img.width;
    this.natH = img.naturalHeight || img.height;
    this.imgEl.src = img.src;

    // Seleção inicial: imagem inteira (enquadramento livre, proporção qualquer).
    this.sel = { x: 0, y: 0, w: this.natW, h: this.natH };
    // Mede o palco e converte de forma síncrona. Ler clientWidth (dentro de
    // _recomputeDisplay) força o reflow, então a medição já é válida agora que
    // o painel está visível — não dependemos do requestAnimationFrame para a
    // primeira conversão (o rAF pode ficar pausado se a aba não estiver pintando).
    this._recomputeDisplay();
    this._render();
    this.onChange();
    // rAF apenas como refinamento, caso o layout ainda assente (fontes/scrollbar).
    var self = this;
    requestAnimationFrame(function () {
      self._recomputeDisplay();
      self._render();
    });
  };

  CropController.prototype._recomputeDisplay = function () {
    const sw = this.stage.clientWidth;
    const sh = this.stage.clientHeight;
    const scale = Math.min(sw / this.natW, sh / this.natH);
    const width = this.natW * scale;
    const height = this.natH * scale;
    this.disp = {
      scale,
      width,
      height,
      left: (sw - width) / 2,
      top: (sh - height) / 2,
    };
    Object.assign(this.imgEl.style, {
      position: 'absolute',
      left: this.disp.left + 'px',
      top: this.disp.top + 'px',
      width: width + 'px',
      height: height + 'px',
    });
  };

  CropController.prototype._render = function () {
    const s = this.disp.scale;
    Object.assign(this.box.style, {
      left: (this.disp.left + this.sel.x * s) + 'px',
      top: (this.disp.top + this.sel.y * s) + 'px',
      width: (this.sel.w * s) + 'px',
      height: (this.sel.h * s) + 'px',
    });
  };

  CropController.prototype._bindEvents = function () {
    const self = this;
    let mode = null;       // 'move' | 'nw' | 'ne' | 'sw' | 'se'
    let startPt = null;    // ponto inicial (px naturais)
    let startSel = null;

    const minSize = () => Math.max(4, Math.min(this.natW, this.natH) / 30);

    function toNatural(ev) {
      const rect = self.stage.getBoundingClientRect();
      const px = (ev.clientX - rect.left - self.disp.left) / self.disp.scale;
      const py = (ev.clientY - rect.top - self.disp.top) / self.disp.scale;
      return { x: px, y: py };
    }

    function onDown(ev) {
      if (!self.img) return;
      const handle = ev.target.dataset && ev.target.dataset.handle;
      mode = handle || 'move';
      startPt = toNatural(ev);
      startSel = Object.assign({}, self.sel);
      self.box.setPointerCapture && self.box.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    }

    function onMove(ev) {
      if (!mode) return;
      const p = toNatural(ev);
      const dx = p.x - startPt.x;
      const dy = p.y - startPt.y;

      if (mode === 'move') {
        self.sel.x = clamp(startSel.x + dx, 0, self.natW - startSel.w);
        self.sel.y = clamp(startSel.y + dy, 0, self.natH - startSel.h);
      } else {
        resize(mode, p);
      }
      self._render();
      ev.preventDefault();
    }

    // Redimensionamento LIVRE: largura e altura independentes. O canto oposto
    // ao arrastado permanece fixo.
    function resize(corner, p) {
      const min = minSize();
      const rx = startSel.x + startSel.w; // borda direita inicial
      const by = startSel.y + startSel.h; // borda inferior inicial
      let x, y, w, h;

      if (corner === 'se') {            // âncora: canto superior-esquerdo
        x = startSel.x; y = startSel.y;
        w = clamp(p.x - x, min, self.natW - x);
        h = clamp(p.y - y, min, self.natH - y);
      } else if (corner === 'nw') {     // âncora: canto inferior-direito
        x = clamp(p.x, 0, rx - min);
        y = clamp(p.y, 0, by - min);
        w = rx - x; h = by - y;
      } else if (corner === 'ne') {     // âncora: canto inferior-esquerdo
        const right = clamp(p.x, startSel.x + min, self.natW);
        x = startSel.x; y = clamp(p.y, 0, by - min);
        w = right - x; h = by - y;
      } else {                          // sw — âncora: canto superior-direito
        const left = clamp(p.x, 0, rx - min);
        x = left; y = startSel.y;
        w = rx - left; h = clamp(p.y - y, min, self.natH - y);
      }
      self.sel = { x, y, w, h };
    }

    function onUp(ev) {
      if (mode) {
        mode = null;
        self.onChange();
      }
    }

    this.box.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  /** Volta ao enquadramento da imagem inteira. */
  CropController.prototype.reset = function () {
    if (!this.img) return;
    this.sel = { x: 0, y: 0, w: this.natW, h: this.natH };
    this._render();
    this.onChange();
  };

  /**
   * Devolve um canvas com a região recortada, preservando a proporção do recorte
   * (não força quadrado). O lado maior fica limitado a `maxSize` px.
   */
  CropController.prototype.getCroppedCanvas = function (maxSize) {
    if (!this.img) return null;
    const sw = this.sel.w, sh = this.sel.h;
    const scale = Math.min(1, (maxSize || 512) / Math.max(sw, sh));
    const ow = Math.max(1, Math.round(sw * scale));
    const oh = Math.max(1, Math.round(sh * scale));
    const out = document.createElement('canvas');
    out.width = ow;
    out.height = oh;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.img, this.sel.x, this.sel.y, sw, sh, 0, 0, ow, oh);
    return out;
  };

  global.HBCrop = { CropController };
})(window);
