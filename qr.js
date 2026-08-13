/* ============================================================
   QR Code — gerador mínimo, modo byte, correção de erro nível M,
   versões 1 a 10. Suficiente para a URL de uma OS (~45 caracteres).

   Existe aqui porque a etiqueta que vai amarrada na peça sai com QR
   desde o primeiro dia (imprimir é barato agora; ler com a câmera
   entra depois, sem trocar etiqueta). Sem dependência externa —
   o worker não busca nada na rede para imprimir uma etiqueta.
   ============================================================ */

// Total de codewords de dados por versão (nível M) e blocos de ECC.
// [ecPorBloco, blocosG1, dadosG1, blocosG2, dadosG2]
const BLOCOS_M = {
  1:  [10, 1, 16, 0, 0],
  2:  [16, 1, 28, 0, 0],
  3:  [26, 1, 44, 0, 0],
  4:  [18, 2, 32, 0, 0],
  5:  [24, 2, 43, 0, 0],
  6:  [16, 4, 27, 0, 0],
  7:  [18, 4, 31, 0, 0],
  8:  [22, 2, 38, 2, 39],
  9:  [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};

// Posições dos padrões de alinhamento por versão.
const ALINHAMENTO = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

// Informação de formato já calculada (nível M, máscaras 0..7).
const FORMATO_M = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];

// Informação de versão (só existe da versão 7 em diante).
const INFO_VERSAO = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };

/* ---------- campo de Galois GF(256) para Reed-Solomon ---------- */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function tabelas() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// Devolve os coeficientes do maior grau para o menor: [1, c1, c2, ...].
// A ordem importa — invertida, a correção de erro sai errada e o código
// fica bonito na tela e ilegível no leitor.
function polinomioGerador(grau) {
  let poly = [1];
  for (let i = 0; i < grau; i++) {
    const novo = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      novo[j] ^= poly[j];                    // termo em x
      novo[j + 1] ^= mul(poly[j], EXP[i]);   // termo constante α^i
    }
    poly = novo;
  }
  return poly;
}

function corrigirErro(dados, ecCount) {
  const gen = polinomioGerador(ecCount);
  const resto = new Array(ecCount).fill(0);
  for (const byte of dados) {
    const fator = byte ^ resto[0];
    resto.shift();
    resto.push(0);
    if (fator !== 0) {
      for (let i = 0; i < ecCount; i++) resto[i] ^= mul(gen[i + 1], fator);
    }
  }
  return resto;
}

/* ---------- escolha de versão e montagem dos codewords ---------- */
function capacidade(versao) {
  const [ec, b1, d1, b2, d2] = BLOCOS_M[versao];
  const totalDados = b1 * d1 + b2 * d2;
  const bitsCabecalho = versao >= 10 ? 4 + 16 : 4 + 8;
  return Math.floor((totalDados * 8 - bitsCabecalho) / 8);
}

function montarCodewords(bytes, versao) {
  const [ecCount, b1, d1, b2, d2] = BLOCOS_M[versao];
  const totalDados = b1 * d1 + b2 * d2;

  // 1. bitstream: modo byte (0100) + contagem + dados + terminador
  const bits = [];
  const push = (valor, tamanho) => {
    for (let i = tamanho - 1; i >= 0; i--) bits.push((valor >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, versao >= 10 ? 16 : 8);
  for (const b of bytes) push(b, 8);

  const capacidadeBits = totalDados * 8;
  for (let i = 0; i < 4 && bits.length < capacidadeBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const dados = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    dados.push(byte);
  }
  const enchimento = [0xec, 0x11];
  let k = 0;
  while (dados.length < totalDados) dados.push(enchimento[k++ % 2]);

  // 2. quebra em blocos, ECC por bloco
  const blocosDados = [];
  const blocosEc = [];
  let pos = 0;
  for (let i = 0; i < b1 + b2; i++) {
    const tamanho = i < b1 ? d1 : d2;
    const bloco = dados.slice(pos, pos + tamanho);
    pos += tamanho;
    blocosDados.push(bloco);
    blocosEc.push(corrigirErro(bloco, ecCount));
  }

  // 3. intercalação
  const saida = [];
  const maiorDado = Math.max(d1, d2);
  for (let i = 0; i < maiorDado; i++) {
    for (const bloco of blocosDados) if (i < bloco.length) saida.push(bloco[i]);
  }
  for (let i = 0; i < ecCount; i++) {
    for (const bloco of blocosEc) saida.push(bloco[i]);
  }
  return saida;
}

/* ---------- desenho da matriz ---------- */
function novaMatriz(tamanho) {
  const m = [];
  for (let i = 0; i < tamanho; i++) m.push(new Array(tamanho).fill(null));
  return m;
}

function desenharFuncoes(m, versao) {
  const n = m.length;
  const finder = (linha, coluna) => {
    for (let i = -1; i <= 7; i++) {
      for (let j = -1; j <= 7; j++) {
        const l = linha + i, c = coluna + j;
        if (l < 0 || l >= n || c < 0 || c >= n) continue;
        // a moldura de fora (i ou j valendo -1 ou 7) é o separador branco
        const dentro = i >= 0 && i <= 6 && j >= 0 && j <= 6;
        if (!dentro) { m[l][c] = 0; continue; }
        const borda = i === 0 || i === 6 || j === 0 || j === 6;
        const miolo = i >= 2 && i <= 4 && j >= 2 && j <= 4;
        m[l][c] = borda || miolo ? 1 : 0;
      }
    }
  };
  finder(0, 0);
  finder(0, n - 7);
  finder(n - 7, 0);

  // linhas de tempo
  for (let i = 8; i < n - 8; i++) {
    m[6][i] = i % 2 === 0 ? 1 : 0;
    m[i][6] = i % 2 === 0 ? 1 : 0;
  }

  // padrões de alinhamento
  const pos = ALINHAMENTO[versao];
  const ultimo = pos.length ? pos[pos.length - 1] : 0;
  for (const l of pos) {
    for (const c of pos) {
      // só os três cantos ocupados pelos finders ficam de fora;
      // sobre a linha de tempo o alinhamento é desenhado normalmente
      if ((l === 6 && c === 6) || (l === 6 && c === ultimo) || (l === ultimo && c === 6)) continue;
      for (let i = -2; i <= 2; i++) {
        for (let j = -2; j <= 2; j++) {
          const borda = Math.abs(i) === 2 || Math.abs(j) === 2;
          m[l + i][c + j] = borda || (i === 0 && j === 0) ? 1 : 0;
        }
      }
    }
  }

  // módulo escuro fixo
  m[n - 8][8] = 1;

  // reserva das áreas de formato (preenchidas depois)
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) m[8][i] = 0;
    if (m[i][8] === null) m[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][n - 1 - i] === null) m[8][n - 1 - i] = 0;
    if (m[n - 1 - i][8] === null) m[n - 1 - i][8] = 0;
  }

  // reserva da informação de versão
  if (versao >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        m[i][n - 11 + j] = 0;
        m[n - 11 + j][i] = 0;
      }
    }
  }
}

// Marca quais posições são de função (não recebem dado nem máscara).
function mapaFuncoes(versao, tamanho) {
  const m = novaMatriz(tamanho);
  desenharFuncoes(m, versao);
  return m.map(linha => linha.map(v => v !== null));
}

function colocarDados(m, funcoes, codewords) {
  const n = m.length;
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  const proximoBit = () => {
    if (bitIndex >= totalBits) return 0;
    const byte = codewords[bitIndex >> 3];
    const bit = (byte >> (7 - (bitIndex & 7))) & 1;
    bitIndex++;
    return bit;
  };

  let subindo = true;
  for (let colunaDir = n - 1; colunaDir > 0; colunaDir -= 2) {
    if (colunaDir === 6) colunaDir--; // pula a linha de tempo vertical
    for (let passo = 0; passo < n; passo++) {
      const linha = subindo ? n - 1 - passo : passo;
      for (let d = 0; d < 2; d++) {
        const coluna = colunaDir - d;
        if (funcoes[linha][coluna]) continue;
        m[linha][coluna] = proximoBit();
      }
    }
    subindo = !subindo;
  }
}

const MASCARAS = [
  (l, c) => (l + c) % 2 === 0,
  (l) => l % 2 === 0,
  (l, c) => c % 3 === 0,
  (l, c) => (l + c) % 3 === 0,
  (l, c) => (Math.floor(l / 2) + Math.floor(c / 3)) % 2 === 0,
  (l, c) => ((l * c) % 2) + ((l * c) % 3) === 0,
  (l, c) => (((l * c) % 2) + ((l * c) % 3)) % 2 === 0,
  (l, c) => (((l + c) % 2) + ((l * c) % 3)) % 2 === 0,
];

function penalidade(m) {
  const n = m.length;
  let total = 0;

  // regra 1: sequências de 5+ do mesmo tom
  const linhaOuColuna = (get) => {
    for (let i = 0; i < n; i++) {
      let corrida = 1;
      for (let j = 1; j < n; j++) {
        if (get(i, j) === get(i, j - 1)) {
          corrida++;
        } else {
          if (corrida >= 5) total += 3 + (corrida - 5);
          corrida = 1;
        }
      }
      if (corrida >= 5) total += 3 + (corrida - 5);
    }
  };
  linhaOuColuna((i, j) => m[i][j]);
  linhaOuColuna((i, j) => m[j][i]);

  // regra 2: blocos 2x2 do mesmo tom
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      const v = m[i][j];
      if (v === m[i][j + 1] && v === m[i + 1][j] && v === m[i + 1][j + 1]) total += 3;
    }
  }

  // regra 3: padrão 1:1:3:1:1 com área clara ao lado
  const alvo1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const alvo2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const casa = (get, i, j, alvo) => {
    for (let k = 0; k < 11; k++) if (get(i, j + k) !== alvo[k]) return false;
    return true;
  };
  for (let i = 0; i < n; i++) {
    for (let j = 0; j + 11 <= n; j++) {
      if (casa((a, b) => m[a][b], i, j, alvo1)) total += 40;
      if (casa((a, b) => m[a][b], i, j, alvo2)) total += 40;
      if (casa((a, b) => m[b][a], i, j, alvo1)) total += 40;
      if (casa((a, b) => m[b][a], i, j, alvo2)) total += 40;
    }
  }

  // regra 4: desequilíbrio entre claro e escuro
  let escuros = 0;
  for (const linha of m) for (const v of linha) escuros += v;
  const proporcao = (escuros * 100) / (n * n);
  total += Math.floor(Math.abs(proporcao - 50) / 5) * 10;

  return total;
}

function aplicarFormato(m, mascara) {
  const n = m.length;
  const bits = FORMATO_M[mascara];
  for (let i = 0; i < 15; i++) {
    const bit = (bits >> i) & 1;
    // cópia 1 — desce pela coluna 8 e segue pela linha 8 até a esquerda
    if (i < 6) m[i][8] = bit;
    else if (i === 6) m[7][8] = bit;
    else if (i === 7) m[8][8] = bit;
    else if (i === 8) m[8][7] = bit;
    else m[8][14 - i] = bit;
    // cópia 2 — linha 8 pela direita e coluna 8 por baixo
    if (i < 8) m[8][n - 1 - i] = bit;
    else m[n - 15 + i][8] = bit;
  }
  m[n - 8][8] = 1;
}

function aplicarVersao(m, versao) {
  if (versao < 7) return;
  const n = m.length;
  const bits = INFO_VERSAO[versao];
  for (let i = 0; i < 18; i++) {
    const bit = (bits >> i) & 1;
    const linha = Math.floor(i / 3);
    const coluna = i % 3;
    m[linha][n - 11 + coluna] = bit;
    m[n - 11 + coluna][linha] = bit;
  }
}

// Exposto só para os testes conferirem contra os vetores conhecidos da
// especificação — nada no worker usa isto.
export const _interno = { corrigirErro, montarCodewords, capacidade, polinomioGerador };

/**
 * Gera a matriz do QR. Devolve array de arrays de 0/1.
 */
export function gerarMatriz(texto) {
  const bytes = Array.from(new TextEncoder().encode(texto));

  let versao = 0;
  for (let v = 1; v <= 10; v++) {
    if (bytes.length <= capacidade(v)) { versao = v; break; }
  }
  if (!versao) throw new Error("texto longo demais para QR versão 10");

  const tamanho = versao * 4 + 17;
  const codewords = montarCodewords(bytes, versao);
  const funcoes = mapaFuncoes(versao, tamanho);

  const base = novaMatriz(tamanho);
  desenharFuncoes(base, versao);
  colocarDados(base, funcoes, codewords);
  aplicarVersao(base, versao);

  // escolhe a máscara de menor penalidade
  let melhor = null;
  let melhorNota = Infinity;
  for (let mascara = 0; mascara < 8; mascara++) {
    const teste = base.map(l => l.slice());
    for (let i = 0; i < tamanho; i++) {
      for (let j = 0; j < tamanho; j++) {
        if (!funcoes[i][j] && MASCARAS[mascara](i, j)) teste[i][j] ^= 1;
      }
    }
    aplicarFormato(teste, mascara);
    const nota = penalidade(teste);
    if (nota < melhorNota) { melhorNota = nota; melhor = teste; }
  }
  return melhor;
}

/**
 * QR pronto como SVG — é o que a etiqueta imprime.
 */
export function gerarSvg(texto, lado = 160, margem = 4) {
  const m = gerarMatriz(texto);
  const n = m.length;
  const total = n + margem * 2;
  let caminho = "";
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (m[i][j]) caminho += `M${j + margem} ${i + margem}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lado}" height="${lado}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#fff"/><path d="${caminho}" fill="#000"/></svg>`;
}
