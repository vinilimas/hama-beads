# 🧩 Hama Beads Creator

Conversor de imagens (JPEG/PNG) em **molde de pixel art para hama beads** (miçangas
de plástico encaixadas numa placa de pinos). O resultado é um molde estilo
"colorir por código": cada célula mostra o código da cor da miçanga, com legenda
e contagem por cor.

> **100% no navegador, offline, de graça e sem IA.** Toda a conversão usa
> algoritmos clássicos de processamento de imagem rodando localmente. Não há
> backend, não há chamadas de rede em runtime, não há API key, não há limites.

---

## Por que não usa IA?

A conversão precisa ser **determinística** (a mesma foto → o mesmo molde, sempre),
**instantânea** e **gratuita**. Mapear cada célula para a miçanga certa é um
problema clássico de processamento de imagem — não de IA generativa. O app faz isso
com:

- Conversão de cor para **CIELAB** e distância perceptual **Delta-E CIEDE2000**
  (acha a miçanga visualmente mais parecida, não só a mais próxima em RGB);
- Redução para a grade por **média de área**;
- **Dithering Floyd–Steinberg** opcional;
- Filtros clássicos (brilho/contraste/saturação, posterização, *median blur*).

---

## Como rodar localmente

### Opção 1 — abrir direto (mais simples)
Dê **duplo-clique** em `index.html`. O app foi escrito em JavaScript puro, sem
build e sem módulos ES, justamente para funcionar abrindo o arquivo direto no
navegador (`file://`).

### Opção 2 — servidor local (recomendado)
Alguns navegadores restringem recursos sob `file://`. Para evitar surpresas, sirva
a pasta com qualquer servidor estático:

```bash
# Python 3
python -m http.server 8000

# ou Node (npx, sem instalar nada global)
npx serve .
```

Depois acesse `http://localhost:8000`.

> Depois de carregado uma vez, funciona **offline** — não há dependências externas.

---

## Como usar

1. **Imagem** — escolha um JPEG/PNG, ou clique em *Usar imagem de exemplo* para
   validar.
2. **Enquadramento** — arraste o quadrado e use os cantos para enquadrar (a grade
   é quadrada). Funciona com toque no celular.
3. **Tamanho da imagem na bandeja** — a bandeja é **sempre 52×52** e o círculo
   **sempre 28×28**. O que você ajusta é o **tamanho da imagem dentro** dela
   (centralizada), pelo slider ou **arrastando a alça laranja** no preview. Um
   *badge* mostra `S × S` e a **quantidade real de miçangas** usadas.
4. **Círculo da bandeja** — guia visual (tracejado vermelho) que reproduz o círculo
   gravado no centro da sua bandeja física, para alinhar o digital com o real.
   Diâmetro configurável (padrão **28 pinos**). É só referência, não vira miçanga.
5. **Cores** — *Detecção de cor*:
   - **Arte chapada (cores limpas)** — usa a **cor dominante** de cada célula
     (voto da maioria). Ideal para personagens/logos/pixel art: bordas limpas e
     muito menos cores. É o padrão.
   - **Foto (gradientes)** — usa a média de área; melhor para fotos.

   **Simplificar cores** (ligado por padrão) remove o "ruído" de cores raras de
   borda, mas **mantém detalhes distintos** (ex.: um pequeno detalhe amarelo).
   Junto com a detecção por cor dominante, isso usa o **menor número de cores
   possível sem perder fidelidade**. Há ainda *dithering* e um *limite* rígido de
   cores, se quiser forçar ainda menos.
6. **Fundo** — *Remover fundo (deixar vazio)* usa **flood fill a partir das bordas**:
   só a área de fundo **conectada à borda** é removida, então áreas brancas *dentro*
   do desenho são mantidas (usa miçanga branca só onde o desenho precisa). Também dá
   para manter tudo ou pintar o fundo de uma cor.
7. **Substituir cor** — troque globalmente um código por outro (ex.: todo C5 → C3).
8. **Paleta** — ajuste o hex de cada cor e ative/desative cores. O matching só usa
   as cores **ativas**. A paleta é salva no navegador (localStorage).
9. **Exportar** — PNG colorido, PNG por código, ou **PDF/impressão** (página única
   ou dividido em quadrantes A4 para imprimir grande e legível).

No painel de resultado há **duas abas** (preview colorido e molde por código),
com **zoom e pan** (roda do mouse, pinça no celular, ou os botões).

### 🧩 Modo montagem (para montar na placa física)

Liga a barra **Modo montagem** acima do preview e vira um *companheiro de
montagem*:

- **Formato**: alterne entre **Desenho todo** e **Linha por linha** (realça só a
  linha atual; ◀ ▶ navegam e **✓ linha feita** marca a fileira e avança).
- **Montar por cor**: escolha uma cor (ou clique nela na legenda) e o molde
  **realça só as células dela**, esmaecendo o resto — você coloca todas de uma vez.
  **✓ cor feita** marca a cor inteira; a legenda mostra **quantas faltam**.
- **Check-off**: **toque numa célula** para marcar como colocada (✓). Uma **barra
  de progresso** mostra a % e quantas miçangas faltam. **↺** zera o progresso.
- **Salvar e retomar**: o progresso é **salvo automaticamente** no navegador —
  feche e reabra que continua de onde parou. Carregar uma nova imagem zera.
- **Tela** (ótimo no celular na mesa): **☀ manter a tela acesa** (Wake Lock),
  **🔒 travar** zoom/pan (evita toque acidental — o check-off continua funcionando)
  e **⛶ tela cheia**.

---

## Estrutura do projeto

```
.
├── index.html          # interface (mobile-first)
├── css/styles.css
├── js/
│   ├── colors.js       # RGB↔CIELAB e Delta-E CIEDE2000
│   ├── palette.js      # paleta padrão (24 cores) + persistência + editor
│   ├── imaging.js      # filtros: brilho/contraste/saturação, posterize, median blur
│   ├── pipeline.js     # amostragem da grade, matching, dithering, limite, fundo
│   ├── render.js       # desenho da grade (cor + código), linhas-guia, eixos
│   ├── crop.js         # enquadramento quadrado (mouse + toque)
│   ├── export.js       # PNG + impressão/PDF paginado A4
│   └── app.js          # estado, controles, recálculo, zoom/pan
└── README.md
```

### Pipeline de conversão

```
Upload → Crop quadrado → Pré-processo (filtros num canvas de ~384px)
      → Amostragem p/ a imagem S×S
          • cor dominante por célula (arte chapada) ou média de área (foto)
      → cada célula: RGB→LAB→miçanga mais próxima (Delta-E 2000)
      → simplificar cores (mescla ruído, mantém detalhes distintos)
      → dithering (opcional) → limite de cores (opcional) → fundo (flood fill)
      → encaixe da imagem S×S centralizada na bandeja 52×52
      → render (cor + código + legenda + círculo da bandeja) → export (PNG / PDF A4)
```

O recálculo é separado em duas etapas para a interface ficar fluida: mexer em
crop/filtros/grade refaz a amostragem; mexer em paleta/dithering/limite só remapeia
as cores já amostradas (rápido, quase tempo real).

---

## Paleta inicial (24 cores)

Já vem preenchida com os códigos do kit e hex aproximados (ajustáveis no editor):

| Código | Cor | Hex | | Código | Cor | Hex |
|--|--|--|--|--|--|--|
| B3 | verde grama | `#4CAF50` | | A4 | amarelo | `#F4D03F` |
| B5 | verde claro | `#6FBF4A` | | A6 | âmbar/dourado | `#E8A030` |
| B8 | verde limão | `#8BC34A` | | A7 | laranja | `#E8722E` |
| C3 | ciano claro | `#6FD3E0` | | G1 | bege/tan | `#D9B38C` |
| C5 | turquesa/teal | `#2EA8C0` | | G5 | mostarda | `#C8862E` |
| C8 | azul royal | `#2C6FBE` | | G7 | marrom | `#7A4A2A` |
| D9 | lavanda | `#C9A8E0` | | H1 | branco translúcido | `#F2F0EA` |
| D6 | roxo médio | `#9B6FC9` | | H2 | branco | `#FFFFFF` |
| D7 | violeta escuro | `#6A3FA0` | | H3 | cinza | `#9E9E9E` |
| E2 | rosa claro | `#F4A8C8` | | H4 | cinza escuro | `#5E5E5E` |
| E4 | rosa pink | `#E8568A` | | H5 | grafite | `#383838` |
| F5 | vermelho | `#D8322F` | | H7 | preto | `#1A1A1A` |

---

## Deploy estático

É um site estático — publique a pasta inteira em qualquer host gratuito:

- **GitHub Pages**: suba os arquivos num repositório e ative Pages na branch.
- **Netlify / Cloudflare Pages / Vercel**: arraste a pasta ou conecte o repo
  (sem build: o "build command" fica vazio e o "output directory" é a raiz).
- **Qualquer servidor**: basta copiar os arquivos para a pasta pública.

Nenhuma variável de ambiente, nenhuma chave, nenhum servidor necessário.

---

## Licença

Uso livre. Feito para montar hama beads sem dor de cabeça. 🎨
