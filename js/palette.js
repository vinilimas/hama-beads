/*
 * palette.js
 * --------------------------------------------------------------------------
 * Paleta de cores das miçangas (hama beads). Vem pré-preenchida com as 24
 * cores do kit do usuário. O app permite:
 *   - editar o hex de cada cor (a foto deu valores aproximados);
 *   - ligar/desligar cada cor (o matching só considera as ativas);
 *   - salvar/restaurar a paleta no navegador (localStorage).
 *
 * Cada cor guarda um cache do seu valor em CIELAB para o matching ser rápido.
 * --------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  // Paleta inicial fornecida pelo usuário (códigos do kit + hex aproximados).
  const DEFAULT_PALETTE = [
    { code: 'B3', name: 'verde grama', hex: '#4CAF50' },
    { code: 'B5', name: 'verde claro', hex: '#6FBF4A' },
    { code: 'B8', name: 'verde limão', hex: '#8BC34A' },
    { code: 'C3', name: 'ciano claro', hex: '#6FD3E0' },
    { code: 'C5', name: 'turquesa/teal', hex: '#2EA8C0' },
    { code: 'C8', name: 'azul royal', hex: '#2C6FBE' },
    { code: 'D9', name: 'lavanda', hex: '#C9A8E0' },
    { code: 'D6', name: 'roxo médio', hex: '#9B6FC9' },
    { code: 'D7', name: 'violeta escuro', hex: '#6A3FA0' },
    { code: 'E2', name: 'rosa claro', hex: '#F4A8C8' },
    { code: 'E4', name: 'rosa pink', hex: '#E8568A' },
    { code: 'F5', name: 'vermelho', hex: '#D8322F' },
    { code: 'G1', name: 'bege/tan', hex: '#D9B38C' },
    { code: 'G5', name: 'mostarda/dourado', hex: '#C8862E' },
    { code: 'G7', name: 'marrom', hex: '#7A4A2A' },
    { code: 'A4', name: 'amarelo', hex: '#F4D03F' },
    { code: 'A6', name: 'âmbar/dourado', hex: '#E8A030' },
    { code: 'A7', name: 'laranja', hex: '#E8722E' },
    { code: 'H1', name: 'branco translúcido', hex: '#F2F0EA' },
    { code: 'H2', name: 'branco', hex: '#FFFFFF' },
    { code: 'H3', name: 'cinza', hex: '#9E9E9E' },
    { code: 'H4', name: 'cinza escuro', hex: '#5E5E5E' },
    { code: 'H5', name: 'grafite', hex: '#383838' },
    { code: 'H7', name: 'preto', hex: '#1A1A1A' },

    // Cartão de referência "2" do kit (hex aproximados extraídos da foto).
    { code: 'B12', name: 'verde-petróleo escuro', hex: '#3F5E5E' },
    { code: 'C11', name: 'teal acinzentado', hex: '#6E9494' },
    { code: 'C10', name: 'azul-acinzentado', hex: '#7BA0AD' },
    { code: 'C02', name: 'azul-gelo claro', hex: '#A7C8CE' },
    { code: 'D03', name: 'azul-índigo', hex: '#4A5A8C' },
    { code: 'C07', name: 'azul-ardósia', hex: '#5E7E96' },
    { code: 'C06', name: 'azul-aço', hex: '#7196AE' },
    { code: 'C13', name: 'azul-aço claro', hex: '#AAC4D2' },
    { code: 'D15', name: 'azul-marinho/índigo', hex: '#38406E' },
    { code: 'D21', name: 'vinho/bordô', hex: '#834C5C' },
    { code: 'D18', name: 'malva empoeirado', hex: '#9C7480' },
    { code: 'D19', name: 'rosa empoeirado', hex: '#C99FAC' },
    { code: 'E07', name: 'vermelho-marsala', hex: '#8E3B48' },
    { code: 'D13', name: 'rosa-vinho', hex: '#973F50' },
    { code: 'E03', name: 'malva-acinzentado', hex: '#B89BA0' },
    { code: 'E08', name: 'rosa-pêssego claro', hex: '#E2B7AE' },
    { code: 'F08', name: 'tijolo/ferrugem', hex: '#A04A3C' },
    { code: 'F13', name: 'terracota', hex: '#B06A3E' },
    { code: 'A10', name: 'laranja-ocre', hex: '#CE8A3C' },
    { code: 'A13', name: 'mostarda dourado', hex: '#D8A842' },
    { code: 'G08', name: 'cinza-carvão', hex: '#4C4C46' },
    { code: 'G13', name: 'cinza-taupe', hex: '#8B897B' },
    { code: 'G09', name: 'caramelo/tan', hex: '#C7A06C' },
    { code: 'A11', name: 'dourado-tan', hex: '#D7B36A' },
  ];

  const STORAGE_KEY = 'hama-beads-palette-v1';

  /** Recalcula r,g,b e Lab a partir do hex de uma cor. */
  function refreshColor(c) {
    const rgb = HBColors.hexToRgb(c.hex);
    c.r = rgb.r;
    c.g = rgb.g;
    c.b = rgb.b;
    c.lab = HBColors.rgbToLab(rgb.r, rgb.g, rgb.b);
    return c;
  }

  /** Cria uma cópia "viva" da paleta padrão, com campos derivados calculados. */
  function makeDefault() {
    return DEFAULT_PALETTE.map((c) =>
      refreshColor({ code: c.code, name: c.name, hex: c.hex, enabled: true })
    );
  }

  /** Carrega a paleta salva (se houver) ou retorna a padrão. */
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return makeDefault();
      const saved = JSON.parse(raw);
      if (!Array.isArray(saved) || saved.length === 0) return makeDefault();
      return saved.map((c) =>
        refreshColor({
          code: c.code,
          name: c.name || '',
          hex: c.hex || '#000000',
          enabled: c.enabled !== false,
        })
      );
    } catch (e) {
      return makeDefault();
    }
  }

  /** Persiste a paleta atual no navegador. */
  function save(palette) {
    try {
      const slim = palette.map((c) => ({
        code: c.code,
        name: c.name,
        hex: c.hex,
        enabled: c.enabled,
      }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
    } catch (e) {
      /* localStorage pode estar indisponível — ignorar silenciosamente. */
    }
  }

  /** Apaga a paleta salva. */
  function clearSaved() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {}
  }

  /** Lista só as cores ativas (usadas no matching). */
  function activeColors(palette) {
    return palette.filter((c) => c.enabled);
  }

  global.HBPalette = {
    DEFAULT_PALETTE,
    makeDefault,
    load,
    save,
    clearSaved,
    refreshColor,
    activeColors,
  };
})(window);
