/* ============================================================
   Gera `seed-demo.sql` — a obra de mentira, cheia, que existe para
   mostrar o sistema funcionando.

   É script e não SQL escrito à mão por dois motivos:
   1. As senhas precisam de hash PBKDF2 com os MESMOS parâmetros do
      worker. Digitar hash à mão é como o login para de funcionar sem
      dizer por quê.
   2. Relatório vazio não vende nada. Consumo por frente, curva ABC e
      estoque parado só significam alguma coisa com 90 dias de histórico
      coerente atrás — e isso são milhares de linhas.

   O sorteio é semeado: rodar de novo dá exatamente o mesmo banco. Demo
   que muda de número a cada carga é demo em que ninguém confia.

   Uso:  node ferramentas/gerar-seed.mjs > seed-demo.sql
   ============================================================ */

import { webcrypto as crypto } from "node:crypto";

const PBKDF2_VOLTAS = 100000;
const b64 = (buf) => Buffer.from(new Uint8Array(buf)).toString("base64");

async function criarSenha(senha, salTexto) {
  // Sal derivado do nome de usuário: determinístico, para o arquivo gerado
  // ser sempre igual. Em produção o sal é aleatório (ver `criarSenha` no
  // worker) — aqui é banco de demonstração, sem dado de ninguém.
  const sal = new Uint8Array(16);
  for (let i = 0; i < 16; i++) sal[i] = salTexto.charCodeAt(i % salTexto.length) ^ (i * 7);
  const chave = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(senha), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: sal, iterations: PBKDF2_VOLTAS }, chave, 256);
  return { hash: b64(bits), sal: b64(sal) };
}

/* Unidade que não se parte. Ninguém tem 12,54 tubos nem 3,7 capacetes —
   número quebrado numa unidade contável é a primeira coisa que denuncia
   que os dados foram inventados, e o engenheiro repara. Quilo, metro,
   litro e metro cúbico continuam com casas decimais, porque é assim que
   areia, cabo e massa são medidos de verdade. */
const CONTAVEIS = new Set(["un", "par"]);
const arredondarPara = (unidade, q) =>
  CONTAVEIS.has(unidade) ? Math.round(q) : Math.round(q * 100) / 100;

/* Sorteio semeado (mulberry32). */
let semente = 20260813;
function sorte() {
  semente |= 0; semente = (semente + 0x6D2B79F5) | 0;
  let t = Math.imul(semente ^ (semente >>> 15), 1 | semente);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const entre = (a, b) => a + sorte() * (b - a);
const inteiro = (a, b) => Math.floor(entre(a, b + 1));
const umDe = (lista) => lista[Math.floor(sorte() * lista.length)];

const A = (s) => s === null || s === undefined ? "NULL" : `'${String(s).replace(/'/g, "''")}'`;
const linhas = [];
const sql = (s) => linhas.push(s);

const HOJE = new Date("2026-08-13T09:00:00Z");
const diaAtras = (d, hora = 9) => {
  const x = new Date(HOJE.getTime() - d * 864e5);
  x.setUTCHours(hora, inteiro(0, 59), inteiro(0, 59), 0);
  return x.toISOString().replace(/\.\d+Z$/, "Z");
};

/* ------------------------------------------------------------
   CATÁLOGO — material de obra de verdade.

   "Produto A / Produto B" numa demonstração entrega na hora que o
   sistema nunca viu um almoxarifado. Cada linha aqui é uma coisa que
   existe num canteiro, com a unidade em que ela é realmente medida.

   [codigo, nome, categoria, unidade, un.compra, fator, mínimo, ideal,
    local, custo, sinônimos, controla lote]
   ------------------------------------------------------------ */
const CATEGORIAS = [
  ["Cimento e agregados", "layers"], ["Aço e ferragem", "grid"], ["Elétrica", "zap"],
  ["Hidráulica", "droplet"], ["EPI e segurança", "shield"], ["Madeira e formas", "square"],
  ["Pintura e acabamento", "brush"], ["Fixação e adesivos", "wrench"], ["Ferramentas", "hammer"],
];

const FORNECEDORES = [
  ["Depósito Central Materiais", "Marcos", "(83) 3221-4400"],
  ["Aço Norte Distribuidora", "Cláudia", "(83) 3244-8100"],
  ["Elétrica Total", "Rangel", "(83) 99812-3344"],
  ["Casa do Construtor JP", "Bruno", "(83) 3031-7788"],
  ["Segurança Já EPI", "Denise", "(83) 3512-6600"],
  ["Tintas e Cia", "Iara", "(83) 3226-1190"],
];

const ITENS = [
  ["CIM-001", "Cimento CP-II 50kg", 1, "kg", "saco", 50, 2000, 8000, "Rua A · Pilha 1", 0.78, "cimento,cp2,cp-ii", 1],
  ["CIM-002", "Argamassa colante AC-II 20kg", 1, "kg", "saco", 20, 400, 1600, "Rua A · Pilha 2", 1.35, "argamassa,ac2,ac-ii,cola de piso", 1],
  ["CIM-003", "Areia média lavada", 1, "m³", null, 1, 20, 80, "Pátio · Baia 1", 95.0, "areia", 0],
  ["CIM-004", "Brita 1", 1, "m³", null, 1, 15, 60, "Pátio · Baia 2", 118.0, "brita,pedra", 0],
  ["CIM-005", "Cal hidratada CH-I 20kg", 1, "kg", "saco", 20, 300, 1200, "Rua A · Pilha 3", 0.92, "cal", 1],
  ["CIM-006", "Bloco cerâmico 9x19x39", 1, "un", "pallet", 240, 1500, 6000, "Pátio · Baia 3", 1.85, "bloco,tijolo,cerâmico", 0],
  ["CIM-007", "Bloco de concreto estrutural 14x19x39", 1, "un", "pallet", 120, 800, 3200, "Pátio · Baia 4", 4.20, "bloco estrutural", 0],

  ["ACO-001", "Vergalhão CA-50 10mm 12m", 2, "un", null, 1, 60, 240, "Rua B · Cavalete 1", 42.5, "ferro,vergalhao,barra,ca50,ca-50", 0],
  ["ACO-002", "Vergalhão CA-50 8mm 12m", 2, "un", null, 1, 80, 320, "Rua B · Cavalete 2", 27.9, "ferro,vergalhao,ca50", 0],
  ["ACO-003", "Vergalhão CA-60 5mm 12m", 2, "un", null, 1, 100, 400, "Rua B · Cavalete 3", 11.4, "ferro,vergalhao,ca60,estribo", 0],
  ["ACO-004", "Tela soldada Q-138 2,45x6m", 2, "un", null, 1, 20, 80, "Rua B · Prateleira 4", 189.0, "tela,malha,q138", 0],
  ["ACO-005", "Arame recozido nº 18", 2, "kg", "rolo", 5, 30, 120, "Rua B · Prateleira 5", 14.8, "arame,arame preto", 0],
  ["ACO-006", "Espaçador de armadura 25mm", 2, "un", "caixa", 500, 1000, 4000, "Rua B · Prateleira 6", 0.22, "espaçador,distanciador", 0],

  ["ELE-001", "Cabo flexível 2,5mm² 750V azul", 3, "m", "rolo", 100, 300, 1200, "Rua C · Gaveta 1", 2.85, "cabo,fio,2.5,flexível", 0],
  ["ELE-002", "Cabo flexível 4mm² 750V preto", 3, "m", "rolo", 100, 200, 800, "Rua C · Gaveta 2", 4.40, "cabo,fio,4mm", 0],
  ["ELE-003", "Cabo flexível 6mm² 750V verde", 3, "m", "rolo", 100, 150, 600, "Rua C · Gaveta 3", 6.60, "cabo,fio,terra", 0],
  ["ELE-004", "Eletroduto PVC 3/4\" 3m", 3, "un", null, 1, 100, 400, "Rua C · Cavalete 1", 8.90, "eletroduto,conduite,3/4", 0],
  ["ELE-005", "Eletroduto PVC 1\" 3m", 3, "un", null, 1, 60, 240, "Rua C · Cavalete 2", 13.20, "eletroduto,conduite", 0],
  ["ELE-006", "Caixa de luz 4x2 PVC", 3, "un", "caixa", 50, 200, 800, "Rua C · Gaveta 4", 1.95, "caixinha,caixa 4x2", 0],
  ["ELE-007", "Disjuntor monopolar 20A", 3, "un", null, 1, 40, 160, "Rua C · Gaveta 5", 12.50, "disjuntor,dj", 0],
  ["ELE-008", "Disjuntor bipolar 40A", 3, "un", null, 1, 20, 80, "Rua C · Gaveta 5", 38.90, "disjuntor,dj", 0],
  ["ELE-009", "Tomada 2P+T 10A com placa", 3, "un", "caixa", 20, 80, 320, "Rua C · Gaveta 6", 9.80, "tomada", 0],
  ["ELE-010", "Fita isolante 19mm x 20m", 3, "un", "caixa", 10, 40, 160, "Rua C · Gaveta 7", 6.30, "fita isolante,isolante", 0],

  ["HID-001", "Tubo PVC soldável 25mm 6m", 4, "un", null, 1, 60, 240, "Rua D · Cavalete 1", 22.40, "tubo,cano,pvc,25", 0],
  ["HID-002", "Tubo PVC esgoto 100mm 6m", 4, "un", null, 1, 40, 160, "Rua D · Cavalete 2", 68.00, "tubo,cano,esgoto,100", 0],
  ["HID-003", "Joelho 90° soldável 25mm", 4, "un", "caixa", 100, 200, 800, "Rua D · Gaveta 1", 1.20, "joelho,cotovelo", 0],
  ["HID-004", "Tê soldável 25mm", 4, "un", "caixa", 100, 150, 600, "Rua D · Gaveta 2", 1.85, "te,tê", 0],
  ["HID-005", "Adesivo plástico PVC 175g", 4, "un", null, 1, 20, 80, "Rua D · Gaveta 3", 18.90, "cola,cola de cano,adesivo", 1],
  ["HID-006", "Fita veda rosca 18mm x 50m", 4, "un", "caixa", 10, 30, 120, "Rua D · Gaveta 4", 4.20, "veda rosca,teflon", 0],
  ["HID-007", "Registro de gaveta 3/4\"", 4, "un", null, 1, 25, 100, "Rua D · Gaveta 5", 42.00, "registro", 0],
  ["HID-008", "Caixa sifonada 150x150x50", 4, "un", null, 1, 20, 80, "Rua D · Prateleira 1", 24.50, "sifonada,ralo", 0],

  ["EPI-001", "Capacete classe B branco", 5, "un", null, 1, 30, 120, "Almox · Armário 1", 28.90, "capacete", 1],
  ["EPI-002", "Luva de raspa cano curto", 5, "par", "pacote", 12, 60, 240, "Almox · Armário 1", 11.50, "luva,raspa", 0],
  ["EPI-003", "Luva nitrílica tamanho G", 5, "par", "caixa", 50, 100, 400, "Almox · Armário 1", 4.20, "luva,nitrilica", 0],
  ["EPI-004", "Óculos de proteção incolor", 5, "un", "caixa", 12, 40, 160, "Almox · Armário 2", 9.80, "óculos,oculos", 1],
  ["EPI-005", "Protetor auricular plug", 5, "par", "caixa", 100, 150, 600, "Almox · Armário 2", 1.90, "protetor,abafador,plug", 1],
  ["EPI-006", "Bota de segurança bico composite nº 41", 5, "par", null, 1, 10, 40, "Almox · Armário 3", 118.00, "bota,botina,calçado", 0],
  ["EPI-007", "Cinto paraquedista 5 pontos", 5, "un", null, 1, 8, 24, "Almox · Armário 3", 289.00, "cinto,talabarte,paraquedista", 1],
  ["EPI-008", "Máscara PFF2 sem válvula", 5, "un", "caixa", 50, 200, 800, "Almox · Armário 2", 2.40, "máscara,mascara,pff2,respirador", 1],
  ["EPI-009", "Colete refletivo laranja", 5, "un", null, 1, 25, 100, "Almox · Armário 1", 16.50, "colete,refletivo", 0],

  ["MAD-001", "Compensado plastificado 18mm 2,20x1,10", 6, "un", null, 1, 30, 120, "Rua E · Pilha 1", 168.00, "compensado,chapa,forma,plastificado", 0],
  ["MAD-002", "Sarrafo pinus 2,5x7cm 3m", 6, "un", null, 1, 100, 400, "Rua E · Pilha 2", 14.20, "sarrafo,madeira", 0],
  ["MAD-003", "Prego 17x27 com cabeça", 6, "kg", "caixa", 20, 40, 160, "Rua E · Gaveta 1", 12.80, "prego", 0],
  ["MAD-004", "Escora metálica regulável 3m", 6, "un", null, 1, 60, 240, "Rua E · Cavalete 1", 78.00, "escora,pontalete", 0],
  ["MAD-005", "Desmoldante para forma 20L", 6, "L", "balde", 20, 40, 160, "Rua E · Prateleira 1", 12.90, "desmoldante", 1],

  ["PIN-001", "Massa corrida PVA 18L", 7, "L", "balde", 18, 90, 360, "Rua F · Prateleira 1", 6.80, "massa,massa corrida,pva", 1],
  ["PIN-002", "Tinta acrílica fosca branca 18L", 7, "L", "lata", 18, 72, 288, "Rua F · Prateleira 2", 14.50, "tinta,acrílica,latex", 1],
  ["PIN-003", "Selador acrílico 18L", 7, "L", "lata", 18, 36, 144, "Rua F · Prateleira 3", 8.90, "selador", 1],
  ["PIN-004", "Rolo de lã 23cm com cabo", 7, "un", null, 1, 20, 80, "Rua F · Gaveta 1", 18.90, "rolo,rolo de pintura", 0],
  ["PIN-005", "Fita crepe 48mm x 50m", 7, "un", "caixa", 12, 30, 120, "Rua F · Gaveta 2", 9.40, "fita crepe,crepe", 0],
  ["PIN-006", "Lixa massa nº 120", 7, "un", "pacote", 50, 100, 400, "Rua F · Gaveta 3", 1.30, "lixa", 0],

  ["FIX-001", "Parafuso bucha 8mm com bucha", 8, "un", "caixa", 100, 400, 1600, "Almox · Gaveta 1", 0.65, "parafuso,bucha,s8", 0],
  ["FIX-002", "Parafuso autobrocante 4,2x25", 8, "un", "caixa", 500, 1000, 4000, "Almox · Gaveta 2", 0.18, "parafuso,autobrocante,gn25", 0],
  ["FIX-003", "Silicone acético incolor 280g", 8, "un", "caixa", 24, 40, 160, "Almox · Gaveta 3", 16.90, "silicone,vedante", 1],
  ["FIX-004", "Espuma expansiva 500ml", 8, "un", "caixa", 12, 20, 80, "Almox · Gaveta 3", 28.50, "espuma,pu,expansiva", 1],
  ["FIX-005", "Chumbador parabolt 3/8\"", 8, "un", "caixa", 50, 100, 400, "Almox · Gaveta 4", 3.80, "chumbador,parabolt", 0],
];

/* Ferramentas: cada UNIDADE física vira uma etiqueta e um responsável. */
const FERRAMENTAS = [
  ["FER-001", "Furadeira de impacto 1/2\" 750W", 9, 620.00, "furadeira,furadeira de impacto", 4],
  ["FER-002", "Martelete rompedor SDS-Max", 9, 3200.00, "martelete,rompedor", 2],
  ["FER-003", "Serra mármore 110mm", 9, 480.00, "serra,serra mármore,makita", 3],
  ["FER-004", "Esmerilhadeira angular 4.1/2\"", 9, 390.00, "esmerilhadeira,lixadeira,maquita", 4],
  ["FER-005", "Betoneira 400L", 9, 4100.00, "betoneira", 2],
  ["FER-006", "Vibrador de imersão 35mm", 9, 1850.00, "vibrador,mangote", 2],
  ["FER-007", "Nível a laser rotativo", 9, 2400.00, "nível,laser,nivel a laser", 1],
  ["FER-008", "Trena eletrônica 50m", 9, 320.00, "trena,trena a laser,medidor", 2],
];

const OBRAS = [
  ["OB-01", "Residencial Aurora", "Av. Epitácio Pessoa, 2100 — João Pessoa/PB", "Eng. Marcos Vinícius"],
  ["OB-02", "Edifício Corporativo Norte", "Rua Empresário João Rodrigues, 400 — João Pessoa/PB", "Eng. Marcos Vinícius"],
  ["OB-03", "Condomínio Vila Nova", "Rod. PB-008, km 4 — Cabedelo/PB", "Eng. Patrícia Alves"],
  ["OB-04", "Galpão Industrial Leste", "Distrito Industrial, Lote 22 — Bayeux/PB", "Eng. Patrícia Alves"],
];

const FRENTES_MODELO = [
  ["FUN", "Fundação"], ["EST", "Estrutura"], ["ALV", "Alvenaria"],
  ["ELE", "Instalações elétricas"], ["HID", "Instalações hidráulicas"],
  ["REV", "Revestimento"], ["ACA", "Acabamento"],
];

const PESSOAS = [
  "José Carlos da Silva", "Antônio Marcos Pereira", "Francisco de Assis Lima",
  "Genivaldo Souza", "Edilson Ramos", "Cícero Nunes", "Marcelo Barbosa",
  "Raimundo Nonato", "Josivaldo Ferreira", "Paulo Sérgio Moura",
];

/* ============================================================ */

const cabecalho = `-- ============================================================
--  DADOS DE DEMONSTRAÇÃO — "Construtora Modelo" (empresa \`demo\`)
--
--  GERADO por ferramentas/gerar-seed.mjs. Não edite à mão: rode o
--  script de novo. O sorteio é semeado, então o arquivo sai idêntico.
--
--  Esta é a obra de MENTIRA, cheia, que existe para mostrar o sistema.
--  A empresa do cliente é outra, nasce vazia, e nenhum teste roda nela.
--
--  Senha de todos os usuários da demonstração: demo
--  Logins: dono · engenheiro · almoxarife · encarregado
-- ============================================================

DELETE FROM fotos;           DELETE FROM eventos;
DELETE FROM inventario_itens;DELETE FROM inventarios;
DELETE FROM requisicao_itens;DELETE FROM requisicoes;
DELETE FROM ativo_movimentos;DELETE FROM ativos;
DELETE FROM movimentos;      DELETE FROM lotes;
DELETE FROM item_sinonimos;  DELETE FROM itens;
DELETE FROM frentes;         DELETE FROM depositos;    DELETE FROM obras;
DELETE FROM fornecedores;    DELETE FROM categorias;
DELETE FROM sessoes;         DELETE FROM usuarios;     DELETE FROM empresas;
DELETE FROM busca;
`;

async function gerar() {
  sql(cabecalho);

  /* ---------- empresa ---------- */
  sql(`-- A cor e o nome vêm do cadastro: é o que torna o produto branco.
INSERT INTO empresas(id, nome, cor, logo_texto, documento) VALUES
  ('demo', 'Construtora Modelo', '#b0805a', 'CM', '00.000.000/0001-00');
`);

  /* ---------- gente ---------- */
  const USUARIOS = [
    ["dono", "Roberto Vasconcelos", "admin", "1001", null],
    ["engenheiro", "Marcos Vinícius Andrade", "engenheiro", "1002", null],
    ["almoxarife", "Sebastião Ferreira", "almoxarife", "1003", 1],
    ["encarregado", "João Paulo Medeiros", "encarregado", "1004", 1],
  ];
  const partes = [];
  for (const [login, nome, papel, pin, obra] of USUARIOS) {
    const { hash, sal } = await criarSenha("demo", login);
    partes.push(`  ('demo', ${A(nome)}, ${A(login)}, ${A(hash)}, ${A(sal)}, ${A(papel)}, ${A(pin)}, ${obra || "NULL"})`);
  }
  sql(`-- Senha de todos: demo
INSERT INTO usuarios(empresa_id, nome, login, senha_hash, senha_sal, papel, pin, obra_id) VALUES
${partes.join(",\n")};
`);

  /* ---------- onde ---------- */
  sql(`INSERT INTO obras(empresa_id, codigo, nome, endereco, responsavel) VALUES
${OBRAS.map(([c, n, e, r]) => `  ('demo', ${A(c)}, ${A(n)}, ${A(e)}, ${A(r)})`).join(",\n")};
`);

  const depositos = [];
  depositos.push([null, "Almoxarifado Central"]);
  OBRAS.forEach((_, k) => depositos.push([k + 1, "Almoxarifado da obra"]));
  sql(`-- O central abastece as obras; cada obra tem o seu.
INSERT INTO depositos(empresa_id, obra_id, nome) VALUES
${depositos.map(([o, n]) => `  ('demo', ${o === null ? "NULL" : o}, ${A(n)})`).join(",\n")};
`);

  const frentes = [];
  OBRAS.forEach((_, k) => {
    for (const [cod, nome] of FRENTES_MODELO) {
      frentes.push([k + 1, `${cod}-${String(k + 1).padStart(2, "0")}`, nome]);
    }
  });
  sql(`-- Frente de serviço é centro de custo: é o que responde "quanto a
-- laje do bloco C consumiu".
INSERT INTO frentes(empresa_id, obra_id, codigo, nome) VALUES
${frentes.map(([o, c, n]) => `  ('demo', ${o}, ${A(c)}, ${A(n)})`).join(",\n")};
`);

  sql(`INSERT INTO categorias(empresa_id, nome, icone, ordem) VALUES
${CATEGORIAS.map(([n, i], k) => `  ('demo', ${A(n)}, ${A(i)}, ${k})`).join(",\n")};
`);

  sql(`INSERT INTO fornecedores(empresa_id, nome, contato, telefone) VALUES
${FORNECEDORES.map(([n, c, t]) => `  ('demo', ${A(n)}, ${A(c)}, ${A(t)})`).join(",\n")};
`);

  /* ---------- catálogo ---------- */
  const todos = [];
  ITENS.forEach((i) => todos.push({ ...montarItem(i), tipo: "consumo" }));
  FERRAMENTAS.forEach(([cod, nome, cat, custo, sin, un]) => {
    todos.push({ codigo: cod, nome, categoria: cat, unidade: "un", unidadeCompra: null,
      fator: 1, minimo: 0, maximo: null, local: "Almox · Ferramentaria", custo,
      sinonimos: sin, lote: 0, tipo: "ferramenta", unidades: un });
  });

  function montarItem([codigo, nome, categoria, unidade, unidadeCompra, fator,
                       minimo, maximo, local, custo, sinonimos, lote]) {
    return { codigo, nome, categoria, unidade, unidadeCompra, fator, minimo,
             maximo, local, custo, sinonimos, lote };
  }

  sql(`INSERT INTO itens(empresa_id, codigo, nome, categoria_id, tipo, unidade, unidade_compra,
                    fator_conversao, localizacao, estoque_minimo, estoque_maximo,
                    custo_ultimo, fornecedor_id, controla_lote) VALUES
${todos.map((i) => `  ('demo', ${A(i.codigo)}, ${A(i.nome)}, ${i.categoria}, ${A(i.tipo)}, ${A(i.unidade)}, ${A(i.unidadeCompra)}, ${i.fator}, ${A(i.local)}, ${i.minimo}, ${i.maximo ?? "NULL"}, ${i.custo}, ${inteiro(1, 6)}, ${i.lote})`).join(",\n")};
`);

  // Sinônimos: o engenheiro escreve "vergalhão", o pedreiro fala "ferro",
  // a nota fiscal diz "CA-50". Os três têm que achar o mesmo item.
  const sinLinhas = [];
  todos.forEach((i, k) => {
    for (const t of String(i.sinonimos || "").split(",").map((s) => s.trim()).filter(Boolean)) {
      sinLinhas.push(`  (${k + 1}, ${A(t)})`);
    }
  });
  sql(`INSERT INTO item_sinonimos(item_id, termo) VALUES\n${sinLinhas.join(",\n")};\n`);

  /* ---------- ferramentas: uma linha por unidade física ---------- */
  const ativos = [];
  let nAtivo = 0;
  todos.forEach((i, k) => {
    if (i.tipo !== "ferramenta") return;
    for (let u = 1; u <= i.unidades; u++) {
      nAtivo++;
      const patrimonio = `PAT-${String(nAtivo).padStart(4, "0")}`;
      // Um terço fica na rua, e algumas há tempo demais — é justamente o
      // caso que o sistema veio resolver.
      const naRua = sorte() < 0.42;
      const diasFora = naRua ? inteiro(1, 26) : 0;
      ativos.push({
        item: k + 1, patrimonio, serie: `SN${inteiro(10000, 99999)}`,
        deposito: inteiro(1, 5),
        situacao: naRua ? "em_uso" : (sorte() < 0.12 ? "manutencao" : "disponivel"),
        pessoa: naRua ? umDe(PESSOAS) : null,
        frente: naRua ? inteiro(1, frentes.length) : null,
        desde: naRua ? diaAtras(diasFora, inteiro(7, 10)) : null,
      });
    }
  });

  sql(`-- Ferramenta tem POSSE, não saldo: a pergunta é quem está com ela.
INSERT INTO ativos(empresa_id, item_id, patrimonio, serie, deposito_id, situacao,
                   posse_pessoa, frente_id, posse_desde) VALUES
${ativos.map((a) => `  ('demo', ${a.item}, ${A(a.patrimonio)}, ${A(a.serie)}, ${a.deposito}, ${A(a.situacao)}, ${A(a.pessoa)}, ${a.frente ?? "NULL"}, ${A(a.desde)})`).join(",\n")};
`);

  // O ativo_id é a POSIÇÃO no INSERT de ativos (k+1), não a posição na
  // lista filtrada dos emprestados — filtrar antes de indexar apontaria
  // cada empréstimo para a ferramenta errada.
  const movAtivos = [];
  ativos.forEach((a, k) => {
    if (a.situacao !== "em_uso") return;
    movAtivos.push(`  ('demo', ${k + 1}, 'emprestimo', 3, ${A(a.pessoa)}, ${a.frente}, ${A(a.desde)})`);
  });
  sql(`INSERT INTO ativo_movimentos(empresa_id, ativo_id, tipo, usuario_id, pessoa, frente_id, criado_em) VALUES
${movAtivos.join(",\n")};
`);

  /* ---------- lotes, para o relatório de validade ---------- */
  const lotes = [];
  todos.forEach((i, k) => {
    if (!i.lote) return;
    const quantos = inteiro(1, 2);
    for (let n = 0; n < quantos; n++) {
      // Um punhado vence de propósito nos próximos 60 dias: relatório de
      // vencimento vazio não mostra nada a quem está avaliando.
      const dias = sorte() < 0.35 ? inteiro(-10, 55) : inteiro(120, 700);
      const validade = new Date(HOJE.getTime() + dias * 864e5).toISOString().slice(0, 10);
      lotes.push({ item: k + 1, codigo: `L${inteiro(1000, 9999)}`, validade });
    }
  });
  sql(`INSERT INTO lotes(empresa_id, item_id, codigo, validade, fornecedor_id) VALUES
${lotes.map((l) => `  ('demo', ${l.item}, ${A(l.codigo)}, ${A(l.validade)}, ${inteiro(1, 6)})`).join(",\n")};
`);
  const lotePorItem = new Map();
  lotes.forEach((l, k) => {
    if (!lotePorItem.has(l.item)) lotePorItem.set(l.item, []);
    lotePorItem.get(l.item).push(k + 1);
  });

  /* ------------------------------------------------------------
     MOVIMENTOS — 90 dias de histórico

     Sem isto, "consumo por frente" e "curva ABC" abrem vazios, e um
     relatório vazio na apresentação vale menos que não ter o relatório.

     A construção é em duas fases: primeiro as entradas (a obra é
     abastecida), depois o consumo dia a dia. O saldo de cada item é
     acompanhado aqui dentro para que nenhuma saída deixe o estoque
     negativo — o servidor recusaria, e o seed é gravado direto.
     ------------------------------------------------------------ */
  const movimentos = [];
  const saldo = new Map();               // "item:deposito" -> quantidade
  const chave = (i, d) => `${i}:${d}`;
  const pegar = (i, d) => saldo.get(chave(i, d)) || 0;
  // Arredondado a cada passo: sem isso o acumulado guarda resíduo de ponto
  // flutuante e o saldo "zerado" sai como 4,5e-13.
  const somar = (i, d, q) =>
    saldo.set(chave(i, d), Math.round((pegar(i, d) + q) * 1000) / 1000);

  const consumiveis = todos.map((i, k) => ({ ...i, id: k + 1 }))
    .filter((i) => i.tipo === "consumo");

  // Fase 1 — abastecimento inicial, entre 90 e 70 dias atrás.
  for (const i of consumiveis) {
    for (const dep of [1, inteiro(2, 5)]) {
      const alvo = (i.maximo || i.minimo * 2 || 100) * entre(0.8, 1.6);
      const q = arredondarPara(i.unidade, alvo * (dep === 1 ? 1 : 0.45));
      if (q <= 0) continue;
      const lote = lotePorItem.get(i.id);
      movimentos.push({
        item: i.id, dep, tipo: "entrada", q, custo: i.custo,
        usuario: 3, doc: `NF ${inteiro(10000, 99999)}`,
        lote: lote ? umDe(lote) : null,
        quando: diaAtras(inteiro(70, 90), inteiro(8, 11)),
      });
      somar(i.id, dep, q);
    }
  }

  // Fase 2 — o dia a dia: saídas para as frentes, reposições, uma perda
  // aqui e ali, e ajustes de contagem.
  for (let dia = 88; dia >= 0; dia--) {
    const fimDeSemana = new Date(HOJE.getTime() - dia * 864e5).getUTCDay();
    if (fimDeSemana === 0) continue;                 // domingo o canteiro para
    const quantasSaidas = fimDeSemana === 6 ? inteiro(2, 6) : inteiro(8, 22);

    for (let s = 0; s < quantasSaidas; s++) {
      const i = umDe(consumiveis);
      const dep = sorte() < 0.35 ? 1 : inteiro(2, 5);
      const disponivel = pegar(i.id, dep);
      if (disponivel <= 0) continue;

      const pedido = arredondarPara(i.unidade, Math.min(
        disponivel * entre(0.02, 0.14),
        (i.maximo || 100) * entre(0.02, 0.1)));
      if (pedido <= 0) continue;

      const obraDoDeposito = dep === 1 ? inteiro(1, 4) : dep - 1;
      const frentesDaObra = frentes
        .map((f, k) => ({ id: k + 1, obra: f[0] }))
        .filter((f) => f.obra === obraDoDeposito);

      movimentos.push({
        item: i.id, dep, tipo: "saida", q: -pedido, custo: i.custo, usuario: 3,
        frente: frentesDaObra.length ? umDe(frentesDaObra).id : null,
        pessoa: umDe(PESSOAS),
        quando: diaAtras(dia, inteiro(7, 16)),
      });
      somar(i.id, dep, -pedido);
    }

    // Reposição: o que ficou abaixo do mínimo volta a subir — mas nem
    // sempre, senão nada aparece no relatório de compra.
    if (dia % 7 === 3) {
      for (const i of consumiveis) {
        const atual = pegar(i.id, 1);
        if (atual > i.minimo || sorte() < 0.35) continue;
        const q = arredondarPara(i.unidade, (i.maximo || i.minimo * 2) * entre(0.6, 1.1));
        const lote = lotePorItem.get(i.id);
        movimentos.push({
          item: i.id, dep: 1, tipo: "entrada", q, custo: i.custo * entre(0.97, 1.06),
          usuario: 3, doc: `NF ${inteiro(10000, 99999)}`,
          lote: lote ? umDe(lote) : null,
          quando: diaAtras(dia, inteiro(8, 10)),
        });
        somar(i.id, 1, q);
      }
    }

    // Transferência do central para uma obra.
    if (sorte() < 0.5) {
      const i = umDe(consumiveis);
      const destino = inteiro(2, 5);
      const disp = pegar(i.id, 1);
      if (disp > 0) {
        const q = arredondarPara(i.unidade, disp * entre(0.05, 0.2));
        if (q > 0) {
          const marca = `T${dia}-${i.id}`;
          movimentos.push({ item: i.id, dep: 1, tipo: "transf_saida", q: -q, usuario: 3,
            transferencia: marca, quando: diaAtras(dia, 8) });
          movimentos.push({ item: i.id, dep: destino, tipo: "transf_entrada", q, usuario: 3,
            transferencia: marca, quando: diaAtras(dia, 8) });
          somar(i.id, 1, -q); somar(i.id, destino, q);
        }
      }
    }

    // Perda: quebra, chuva, material vencido. Acontece em obra.
    if (sorte() < 0.14) {
      const i = umDe(consumiveis);
      const dep = inteiro(1, 5);
      const disp = pegar(i.id, dep);
      if (disp > 1) {
        const q = arredondarPara(i.unidade, disp * entre(0.01, 0.05));
        movimentos.push({ item: i.id, dep, tipo: "perda", q: -q, usuario: 3,
          motivo: umDe(["Quebra no transporte", "Molhou na chuva", "Vencido",
                        "Danificado no manuseio"]),
          quando: diaAtras(dia, 15) });
        somar(i.id, dep, -q);
      }
    }
  }

  /* Alguns itens ficam abaixo do mínimo de propósito: a tela de abertura,
     o relatório de compra e o chip "abaixo do mínimo" precisam ter o que
     mostrar — demonstração que abre vazia não mostra nada.

     ⚠️ O mínimo é comparado com o saldo da EMPRESA INTEIRA (view
     `saldo_item`), não com o de um depósito. Esvaziar só o central deixa
     o total acima do mínimo e nada aparece como crítico — foi o que
     aconteceu na primeira geração. Aqui se tira de TODOS os depósitos. */
  const escolhidos = [
    ...consumiveis.slice(0, 7),          // variedade de categorias
    ...consumiveis.slice(20, 24),
    ...consumiveis.slice(41, 44),
  ];
  escolhidos.forEach((i, ordem) => {
    // Dois primeiros zeram de vez: "acabou" é diferente de "está no fim",
    // e as duas situações precisam existir na tela.
    const alvoTotal = ordem < 2 ? 0 : i.minimo * entre(0.2, 0.9);
    let total = 0;
    for (let d = 1; d <= 5; d++) total += pegar(i.id, d);
    let restaTirar = arredondarPara(i.unidade, total - alvoTotal);
    if (restaTirar <= 0) return;

    const frentesDaObra = frentes.map((f, k) => ({ id: k + 1, obra: f[0] }));

    for (let d = 1; d <= 5 && restaTirar > 0; d++) {
      const tem = pegar(i.id, d);
      if (tem <= 0) continue;
      const tirar = arredondarPara(i.unidade, Math.min(tem, restaTirar));
      if (tirar <= 0) continue;
      const obraDoDeposito = d === 1 ? 1 : d - 1;
      const daObra = frentesDaObra.filter((f) => f.obra === obraDoDeposito);
      movimentos.push({
        item: i.id, dep: d, tipo: "saida", q: -tirar, custo: i.custo, usuario: 3,
        frente: daObra.length ? umDe(daObra).id : null,
        pessoa: umDe(PESSOAS), quando: diaAtras(inteiro(1, 6), inteiro(8, 15)),
      });
      somar(i.id, d, -tirar);
      restaTirar = arredondarPara(i.unidade, restaTirar - tirar);
    }
  });

  movimentos.sort((a, b) => a.quando.localeCompare(b.quando));

  // Em blocos: um INSERT com 4 mil VALUES estoura o limite do D1.
  const BLOCO = 400;
  for (let k = 0; k < movimentos.length; k += BLOCO) {
    const fatia = movimentos.slice(k, k + BLOCO);
    sql(`INSERT INTO movimentos(empresa_id, item_id, deposito_id, tipo, quantidade,
                    custo_unitario, frente_id, lote_id, usuario_id, pessoa, documento,
                    motivo, transferencia, criado_em) VALUES
${fatia.map((m) => `  ('demo', ${m.item}, ${m.dep}, ${A(m.tipo)}, ${m.q}, ${m.custo ? Math.round(m.custo * 100) / 100 : "NULL"}, ${m.frente ?? "NULL"}, ${m.lote ?? "NULL"}, ${m.usuario}, ${A(m.pessoa)}, ${A(m.doc)}, ${A(m.motivo)}, ${A(m.transferencia)}, ${A(m.quando)})`).join(",\n")};
`);
  }

  /* ---------- requisições ---------- */
  const reqs = [
    { n: 1, obra: 1, frente: 3, dep: 2, sol: 4, sit: "entregue", urg: "normal", dias: 12 },
    { n: 2, obra: 1, frente: 4, dep: 2, sol: 4, sit: "entregue", urg: "normal", dias: 8 },
    { n: 3, obra: 1, frente: 5, dep: 2, sol: 4, sit: "parcial",  urg: "normal", dias: 4 },
    { n: 4, obra: 1, frente: 2, dep: 2, sol: 4, sit: "aberta",   urg: "urgente", dias: 0 },
    { n: 5, obra: 1, frente: 6, dep: 2, sol: 4, sit: "aberta",   urg: "normal", dias: 0 },
    { n: 6, obra: 1, frente: 3, dep: 1, sol: 4, sit: "separando",urg: "normal", dias: 1 },
  ];
  sql(`INSERT INTO requisicoes(empresa_id, numero, obra_id, frente_id, deposito_id,
                    solicitante_id, situacao, urgencia, observacao, atendido_por,
                    recebido_por, entregue_em, criado_em) VALUES
${reqs.map((r) => {
  const fechada = ["entregue", "parcial"].includes(r.sit);
  return `  ('demo', ${r.n}, ${r.obra}, ${r.frente}, ${r.dep}, ${r.sol}, ${A(r.sit)}, ${A(r.urg)}, ${A(r.urg === "urgente" ? "Concretagem amanhã cedo — precisa hoje" : null)}, ${fechada || r.sit === "separando" ? 3 : "NULL"}, ${fechada ? A(umDe(PESSOAS)) : "NULL"}, ${fechada ? A(diaAtras(r.dias, 11)) : "NULL"}, ${A(diaAtras(r.dias, 7))})`;
}).join(",\n")};
`);

  const reqItens = [];
  reqs.forEach((r) => {
    const quantos = inteiro(2, 5);
    const usados = new Set();
    for (let k = 0; k < quantos; k++) {
      const i = umDe(consumiveis);
      if (usados.has(i.id)) continue;
      usados.add(i.id);
      const pedido = arredondarPara(i.unidade, (i.maximo || 100) * entre(0.02, 0.08));
      const atendido = r.sit === "entregue" ? pedido
        : r.sit === "parcial" ? Math.round(pedido * entre(0.3, 0.8) * 100) / 100 : 0;
      reqItens.push(`  (${r.n}, ${i.id}, ${pedido}, ${atendido})`);
    }
  });
  sql(`INSERT INTO requisicao_itens(requisicao_id, item_id, qtd_pedida, qtd_atendida) VALUES
${reqItens.join(",\n")};
`);

  /* ---------- um inventário fechado, com acuracidade plausível ---------- */
  sql(`-- Uma contagem já fechada: dá ao relatório de acuracidade um ponto de
-- partida, e mostra como a divergência vira ajuste no histórico.
INSERT INTO inventarios(empresa_id, deposito_id, nome, situacao, criado_por, criado_em, fechado_em)
VALUES ('demo', 1, 'Contagem de julho — Central', 'fechado', 3, ${A(diaAtras(28, 8))}, ${A(diaAtras(27, 17))});
`);
  const invItens = consumiveis.slice(0, 26).map((i) => {
    const sistema = Math.round(pegar(i.id, 1) * 100) / 100;
    // ~85% batem certo. Divergência de 100% seria mentira; de 0%, também.
    const contagem = sorte() < 0.85 ? sistema
      : Math.round(sistema * entre(0.93, 1.06) * 100) / 100;
    return `  (1, ${i.id}, ${sistema}, ${contagem}, 3, ${A(diaAtras(27, 14))})`;
  });
  sql(`INSERT INTO inventario_itens(inventario_id, item_id, saldo_sistema, contagem, contado_por, contado_em) VALUES
${invItens.join(",\n")};
`);

  sql(`-- Resumo do que foi gerado:
--   ${todos.length} itens · ${ativos.length} ferramentas · ${movimentos.length} movimentos
--   ${lotes.length} lotes · ${reqs.length} requisições · 4 obras · ${frentes.length} frentes
`);

  process.stdout.write(linhas.join("\n"));
}

gerar();
