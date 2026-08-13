/* ============================================================
   ALMOXARIFADO — worker

   Um arquivo, sem framework, roteamento na mão. O front inteiro vem de
   `ui.html` importado como texto, com `estilo.css` colado dentro: uma
   requisição só, nada de CDN. O galpão tem sinal ruim.

   Duas regras que atravessam tudo aqui:

   1. `empresa_id` SEMPRE sai da sessão, NUNCA do corpo do pedido.
      Quem manda o pedido não escolhe de qual empresa está falando.

   2. Quem vê dinheiro é decidido AQUI, não na tela. `semValores()` arranca
      os campos de custo da resposta para almoxarife e encarregado. Esconder
      no CSS deixa o dado viajando no JSON — que é o mesmo que não esconder.
   ============================================================ */

import UI from "./ui.html";
import ESTILO from "./estilo.css";
import { gerarSvg } from "./qr.js";

const agora = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

/* ---------- respostas ---------- */

const json = (dados, status = 200) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const erro = (mensagem, status = 400) => json({ erro: mensagem }, status);

/* ---------- senha ----------
   PBKDF2-SHA256, 100.000 voltas, sal de 16 bytes, tudo base64. Se estes
   parâmetros mudarem, todo login existente para de funcionar sem dizer
   por quê — a ferramenta que gera senha de produção importa daqui. */

const PBKDF2_VOLTAS = 100000;

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const deB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derivar(senha, salBytes) {
  const chave = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(senha), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salBytes, iterations: PBKDF2_VOLTAS },
    chave, 256
  );
  return b64(bits);
}

export async function criarSenha(senha) {
  const sal = crypto.getRandomValues(new Uint8Array(16));
  return { hash: await derivar(senha, sal), sal: b64(sal) };
}

async function conferirSenha(senha, hash, sal) {
  const calculado = await derivar(senha, deB64(sal));
  // Comparação de tempo constante — string == vaza o tamanho do prefixo certo.
  if (calculado.length !== hash.length) return false;
  let diferenca = 0;
  for (let i = 0; i < hash.length; i++) diferenca |= calculado.charCodeAt(i) ^ hash.charCodeAt(i);
  return diferenca === 0;
}

/* ---------- sessão ---------- */

const DURACAO_SESSAO_H = 12;

async function abrirSessao(env, usuarioId) {
  const token = b64(crypto.getRandomValues(new Uint8Array(24))).replace(/[+/=]/g, "");
  const expira = new Date(Date.now() + DURACAO_SESSAO_H * 3600e3).toISOString();
  await env.DB.prepare("INSERT INTO sessoes(token, usuario_id, expira_em) VALUES(?,?,?)")
    .bind(token, usuarioId, expira).run();
  return token;
}

async function lerSessao(env, req) {
  const cabecalho = req.headers.get("authorization") || "";
  const token = cabecalho.startsWith("Bearer ") ? cabecalho.slice(7) : null;
  if (!token) return null;
  const linha = await env.DB.prepare(`
    SELECT u.id, u.nome, u.papel, u.empresa_id, u.obra_id, u.login,
           e.nome AS empresa_nome, e.cor AS empresa_cor, e.logo_texto
      FROM sessoes s
      JOIN usuarios u ON u.id = s.usuario_id
      JOIN empresas e ON e.id = u.empresa_id
     WHERE s.token = ? AND s.expira_em > ? AND u.ativo = 1
  `).bind(token, agora()).first();
  return linha || null;
}

/* ---------- permissão ----------
   Um lugar só decide quem pode o quê. Espalhar `if (papel === ...)` pelas
   rotas é como se descobre, seis meses depois, que uma delas ficou aberta. */

const VE_DINHEIRO = new Set(["admin", "engenheiro"]);
const MOVIMENTA   = new Set(["admin", "engenheiro", "almoxarife"]);
const CADASTRA    = new Set(["admin", "engenheiro"]);
const SO_ADMIN    = new Set(["admin"]);

const podeVerDinheiro = (u) => VE_DINHEIRO.has(u.papel);

/* Arranca custo e valor da resposta para quem não pode ver. Recursivo de
   propósito: o campo aparece dentro de item, de movimento e de relatório. */
const CAMPOS_DINHEIRO = new Set([
  "custo_unitario", "custo_ultimo", "custo_medio", "valor", "valor_total",
  "valor_estoque", "valor_consumido", "valor_imobilizado",
]);

function semValores(dados, usuario) {
  if (podeVerDinheiro(usuario)) return dados;
  const limpar = (v) => {
    if (Array.isArray(v)) return v.map(limpar);
    if (v && typeof v === "object") {
      const saida = {};
      for (const [k, valor] of Object.entries(v)) {
        if (CAMPOS_DINHEIRO.has(k)) continue;
        saida[k] = limpar(valor);
      }
      return saida;
    }
    return v;
  };
  return limpar(dados);
}

/* ---------- auditoria ----------
   Indicador sem histórico nasce vazio. Grava-se desde o primeiro dia. */

const registrar = (env, u, tipo, alvo, alvoId, detalhe) =>
  env.DB.prepare(
    "INSERT INTO eventos(empresa_id, usuario_id, tipo, alvo, alvo_id, detalhe) VALUES(?,?,?,?,?,?)"
  ).bind(u.empresa_id, u.id, tipo, alvo || null, alvoId || null,
         detalhe ? JSON.stringify(detalhe) : null);

/* ---------- busca ----------
   O termo digitado é do usuário: vai para o FTS5 como valor ligado, e os
   caracteres que o FTS5 lê como sintaxe (aspas, `*`, `NEAR`, `-`) são
   descartados antes. Sem isso, um `"` solto derruba a consulta inteira. */

function consultaFts(termo) {
  const palavras = String(termo || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s.\-/]/gu, " ")
    .split(/\s+/)
    .filter((p) => p.length > 0)
    .slice(0, 8);
  if (!palavras.length) return null;
  // Última palavra por prefixo: quem digita "eletrod" já quer ver o resultado.
  return palavras
    .map((p, i) => (i === palavras.length - 1 ? `"${p}"*` : `"${p}"`))
    .join(" AND ");
}

/* ---------- roteador ---------- */

class Rotas {
  constructor() { this.lista = []; }
  add(metodo, padrao, fn, opcoes = {}) {
    this.lista.push({ metodo, padrao, fn, ...opcoes });
    return this;
  }
  get(p, fn, o)  { return this.add("GET", p, fn, o) }
  post(p, fn, o) { return this.add("POST", p, fn, o) }
  patch(p, fn, o){ return this.add("PATCH", p, fn, o) }
  del(p, fn, o)  { return this.add("DELETE", p, fn, o) }
  achar(metodo, caminho) {
    for (const r of this.lista) {
      if (r.metodo !== metodo) continue;
      const m = caminho.match(r.padrao);
      if (m) return { rota: r, params: m.slice(1) };
    }
    return null;
  }
}

const R = new Rotas();

/* ============================================================
   ENTRADA
   ============================================================ */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const caminho = url.pathname.replace(/\/+$/, "") || "/";

    // A página. `/e/CODIGO` é o destino do QR da etiqueta — entrega a mesma
    // SPA, que lê o código do próprio endereço e abre o item direto.
    if (req.method === "GET" && (caminho === "/" || /^\/e\/[^/]+$/.test(caminho))) {
      return new Response(UI.replace("/*ESTILO*/", ESTILO), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (caminho === "/manifest.json") return json(MANIFESTO);
    if (caminho === "/api/saude") return json({ ok: true, agora: agora() });

    const achado = R.achar(req.method, caminho);
    if (!achado) return erro("rota não encontrada", 404);

    const { rota, params } = achado;

    let usuario = null;
    if (!rota.aberta) {
      usuario = await lerSessao(env, req);
      if (!usuario) return erro("sessão vencida", 401);
      if (rota.papeis && !rota.papeis.has(usuario.papel)) {
        return erro("seu acesso não permite esta ação", 403);
      }
    }

    let corpo = {};
    if (["POST", "PATCH", "PUT"].includes(req.method)) {
      const tipo = req.headers.get("content-type") || "";
      if (tipo.includes("application/json")) {
        /* Corpo VAZIO é normal e não é erro: as rotas de ação — sair,
           separar, fechar contagem, devolver ferramenta — são POST sem
           nada para mandar, e o navegador manda o content-type do mesmo
           jeito. Chamar req.json() direto estoura nelas e a tela vira
           "clico no botão e não acontece nada". Só texto presente e
           malformado é erro de verdade. */
        const texto = await req.text();
        if (texto.trim()) {
          try { corpo = JSON.parse(texto) } catch { return erro("corpo inválido") }
        }
      }
    }

    try {
      return await rota.fn({ env, req, url, params, corpo, usuario });
    } catch (e) {
      console.error(caminho, e);
      return erro("erro interno: " + (e?.message || e), 500);
    }
  },
};

const MANIFESTO = {
  name: "Almoxarifado",
  short_name: "Almox",
  start_url: "/",
  display: "standalone",
  background_color: "#12100e",
  theme_color: "#12100e",
  icons: [],
};

/* ============================================================
   LOGIN
   ============================================================ */

R.post(/^\/api\/login$/, async ({ env, corpo }) => {
  const { empresa, login, senha } = corpo;
  if (!empresa || !login || !senha) return erro("preencha empresa, usuário e senha");

  const u = await env.DB.prepare(`
    SELECT u.*, e.nome AS empresa_nome, e.cor AS empresa_cor, e.logo_texto
      FROM usuarios u JOIN empresas e ON e.id = u.empresa_id
     WHERE u.empresa_id = ? AND lower(u.login) = lower(?) AND u.ativo = 1 AND e.ativo = 1
  `).bind(String(empresa).toLowerCase(), login).first();

  // Mensagem única de propósito: dizer "usuário não existe" entrega a
  // lista de quem trabalha na obra para quem estiver tentando.
  if (!u || !(await conferirSenha(senha, u.senha_hash, u.senha_sal))) {
    return erro("usuário ou senha incorretos", 401);
  }

  const token = await abrirSessao(env, u.id);
  await registrar(env, u, "login").run();

  return json({
    token,
    eu: {
      id: u.id, nome: u.nome, papel: u.papel, login: u.login,
      obra_id: u.obra_id, ve_dinheiro: podeVerDinheiro(u),
      empresa: { id: u.empresa_id, nome: u.empresa_nome, cor: u.empresa_cor, logo: u.logo_texto },
    },
  });
}, { aberta: true });

R.post(/^\/api\/sair$/, async ({ env, req }) => {
  const cab = req.headers.get("authorization") || "";
  if (cab.startsWith("Bearer ")) {
    await env.DB.prepare("DELETE FROM sessoes WHERE token = ?").bind(cab.slice(7)).run();
  }
  return json({ ok: true });
});

R.get(/^\/api\/eu$/, async ({ usuario }) => json({
  id: usuario.id, nome: usuario.nome, papel: usuario.papel, login: usuario.login,
  obra_id: usuario.obra_id, ve_dinheiro: podeVerDinheiro(usuario),
  empresa: {
    id: usuario.empresa_id, nome: usuario.empresa_nome,
    cor: usuario.empresa_cor, logo: usuario.logo_texto,
  },
}));

/* ============================================================
   PAINEL — cada papel abre numa tela diferente, porque cada um
   chega com uma pergunta diferente na cabeça.
   ============================================================ */

R.get(/^\/api\/inicio$/, async ({ env, usuario, url }) => {
  const emp = usuario.empresa_id;
  const obraId = url.searchParams.get("obra") || null;
  const filtroObra = obraId ? " AND d.obra_id = ?" : "";
  const arg = obraId ? [obraId] : [];

  const [criticos, requisicoes, ferramentas, validade, movimentoHoje, valor] = await env.DB.batch([
    // Abaixo do mínimo e zerados — a pergunta do almoxarife e do engenheiro.
    env.DB.prepare(`
      SELECT COUNT(*) AS n,
             SUM(CASE WHEN COALESCE(s.quantidade,0) < 0.001 THEN 1 ELSE 0 END) AS zerados
        FROM itens i
        LEFT JOIN saldo_item s ON s.item_id = i.id
       WHERE i.empresa_id = ? AND i.ativo = 1 AND i.tipo = 'consumo'
         AND i.estoque_minimo > 0 AND COALESCE(s.quantidade,0) <= i.estoque_minimo
    `).bind(emp),

    env.DB.prepare(`
      SELECT SUM(CASE WHEN situacao = 'aberta' THEN 1 ELSE 0 END) AS abertas,
             SUM(CASE WHEN situacao = 'separando' THEN 1 ELSE 0 END) AS separando,
             SUM(CASE WHEN situacao = 'aberta' AND urgencia = 'urgente' THEN 1 ELSE 0 END) AS urgentes
        FROM requisicoes WHERE empresa_id = ?
    `).bind(emp),

    // Ferramenta fora há mais de 7 dias. É onde some dinheiro na obra.
    env.DB.prepare(`
      SELECT SUM(CASE WHEN situacao = 'em_uso' THEN 1 ELSE 0 END) AS em_uso,
             SUM(CASE WHEN situacao = 'em_uso' AND posse_desde < datetime('now','-7 day')
                      THEN 1 ELSE 0 END) AS atrasadas,
             SUM(CASE WHEN situacao = 'manutencao' THEN 1 ELSE 0 END) AS manutencao
        FROM ativos WHERE empresa_id = ? AND situacao != 'baixado'
    `).bind(emp),

    env.DB.prepare(`
      SELECT COUNT(*) AS n FROM lotes l
        JOIN saldo_lote sl ON sl.lote_id = l.id
       WHERE l.empresa_id = ? AND l.validade IS NOT NULL
         AND sl.quantidade > 0 AND l.validade <= date('now','+30 day')
    `).bind(emp),

    env.DB.prepare(`
      SELECT SUM(CASE WHEN quantidade > 0 THEN 1 ELSE 0 END) AS entradas,
             SUM(CASE WHEN quantidade < 0 THEN 1 ELSE 0 END) AS saidas
        FROM movimentos WHERE empresa_id = ? AND criado_em >= date('now')
    `).bind(emp),

    env.DB.prepare(`
      SELECT SUM(s.quantidade * COALESCE(i.custo_ultimo,0)) AS valor_imobilizado
        FROM saldo_item s JOIN itens i ON i.id = s.item_id
       WHERE i.empresa_id = ? AND s.quantidade > 0
    `).bind(emp),
  ]);

  // Os cinco mais críticos, para a tela já mostrar o que fazer.
  const lista = await env.DB.prepare(`
    SELECT i.id, i.codigo, i.nome, i.unidade, i.estoque_minimo, i.localizacao,
           COALESCE(s.quantidade, 0) AS saldo
      FROM itens i LEFT JOIN saldo_item s ON s.item_id = i.id
     WHERE i.empresa_id = ? AND i.ativo = 1 AND i.tipo = 'consumo'
       AND i.estoque_minimo > 0 AND COALESCE(s.quantidade,0) <= i.estoque_minimo
     ORDER BY (COALESCE(s.quantidade,0) / NULLIF(i.estoque_minimo,0)) ASC
     LIMIT 6
  `).bind(emp).all();

  const resposta = {
    criticos: criticos.results[0] || { n: 0, zerados: 0 },
    requisicoes: requisicoes.results[0] || {},
    ferramentas: ferramentas.results[0] || {},
    vencendo: validade.results[0]?.n || 0,
    hoje: movimentoHoje.results[0] || {},
    valor_imobilizado: valor.results[0]?.valor_imobilizado || 0,
    lista_critica: lista.results,
  };
  return json(semValores(resposta, usuario));
});

/* ============================================================
   BUSCA — a tela principal

   Uma caixa só resolve: código, nome, sinônimo, prateleira, EAN do
   fabricante e patrimônio de ferramenta. Quem procura material não
   deveria ter que escolher "onde" procurar antes de procurar.
   ============================================================ */

R.get(/^\/api\/busca$/, async ({ env, usuario, url }) => {
  const emp = usuario.empresa_id;
  const p = url.searchParams;
  const termo = (p.get("q") || "").trim();
  const filtros = (p.get("filtros") || "").split(",").filter(Boolean);
  const categoria = p.get("categoria");
  const deposito = p.get("deposito");
  const limite = Math.min(parseInt(p.get("limite") || "40", 10), 200);

  /* ⚠️ O D1 liga os parâmetros pela ORDEM em que os `?` aparecem no texto
     do SQL, e aqui eles não aparecem todos no WHERE: o do `MATCH` está no
     JOIN e o do depósito está numa subconsulta, os dois ANTES do WHERE.
     Uma lista só, montada na ordem lógica, entrega a empresa para o MATCH
     e o termo buscado para o `empresa_id` — a busca passa a devolver zero
     resultado sempre, sem erro nenhum. Por isso são três listas separadas,
     concatenadas na mesma ordem em que o SQL é montado abaixo. */
  const argsJuncao = [];      // 1º — JOIN busca ... MATCH ?
  const argsSubconsulta = []; // 2º — subconsulta do saldo por depósito
  const argsCond = [emp];     // 3º — WHERE
  const cond = ["i.empresa_id = ?", "i.ativo = 1"];

  // Um código exato ganha de qualquer relevância de texto. Quem escaneou a
  // etiqueta ou digitou o código quer AQUELE item, não o mais parecido.
  let exato = null;
  if (termo) {
    exato = await env.DB.prepare(`
      SELECT id FROM itens WHERE empresa_id = ? AND ativo = 1
         AND (upper(codigo) = upper(?) OR ean = ?) LIMIT 1
    `).bind(emp, termo, termo).first();
  }

  let juncaoFts = "";
  let ordem = "i.nome COLLATE NOCASE ASC";
  if (termo && !exato) {
    const consulta = consultaFts(termo);
    if (consulta) {
      juncaoFts = "JOIN busca b ON b.item_id = i.id AND busca MATCH ?";
      argsJuncao.push(consulta);
      ordem = "bm25(busca) ASC, i.nome COLLATE NOCASE ASC";
    } else {
      return json({ itens: [], ferramentas: [], total: 0 });
    }
  } else if (exato) {
    cond.push("i.id = ?");
    argsCond.push(exato.id);
  }

  if (categoria) { cond.push("i.categoria_id = ?"); argsCond.push(categoria) }

  // Filtros que se combinam. Cada um é como o engenheiro pensa, não como
  // o banco está organizado.
  if (filtros.includes("critico"))    cond.push("COALESCE(sal.quantidade,0) <= i.estoque_minimo AND i.estoque_minimo > 0");
  if (filtros.includes("zerado"))     cond.push("COALESCE(sal.quantidade,0) < 0.001");
  if (filtros.includes("ferramenta")) cond.push("i.tipo = 'ferramenta'");
  if (filtros.includes("consumo"))    cond.push("i.tipo = 'consumo'");
  if (filtros.includes("parado"))     cond.push(`NOT EXISTS (
        SELECT 1 FROM movimentos m WHERE m.item_id = i.id
           AND m.criado_em >= date('now','-90 day'))`);
  if (filtros.includes("sem_minimo")) cond.push("i.estoque_minimo <= 0");

  let filtroDeposito = "";
  if (deposito) { filtroDeposito = " AND m.deposito_id = ?"; argsSubconsulta.push(deposito) }

  const sql = `
    SELECT i.id, i.codigo, i.nome, i.unidade, i.tipo, i.localizacao,
           i.estoque_minimo, i.estoque_maximo, i.foto_chave, i.custo_ultimo,
           c.nome AS categoria,
           COALESCE(sal.quantidade, 0) AS saldo
      FROM itens i
      ${juncaoFts}
      LEFT JOIN categorias c ON c.id = i.categoria_id
      LEFT JOIN (SELECT m.item_id, SUM(m.quantidade) AS quantidade
                   FROM movimentos m WHERE 1=1${filtroDeposito}
                  GROUP BY m.item_id) sal ON sal.item_id = i.id
     WHERE ${cond.join(" AND ")}
     ORDER BY ${ordem}
     LIMIT ?`;

  // Mesma ordem em que os `?` aparecem no texto acima: JOIN, subconsulta,
  // WHERE, LIMIT.
  const itens = await env.DB.prepare(sql)
    .bind(...argsJuncao, ...argsSubconsulta, ...argsCond, limite).all();

  // Ferramenta também entra pela mesma caixa: por patrimônio, por série ou
  // pelo nome de quem está com ela.
  let ferramentas = { results: [] };
  if (termo) {
    ferramentas = await env.DB.prepare(`
      SELECT a.id, a.patrimonio, a.serie, a.situacao, a.posse_pessoa, a.posse_desde,
             i.nome AS item_nome, i.id AS item_id, d.nome AS deposito
        FROM ativos a
        JOIN itens i ON i.id = a.item_id
        LEFT JOIN depositos d ON d.id = a.deposito_id
       WHERE a.empresa_id = ? AND a.situacao != 'baixado'
         AND (upper(a.patrimonio) LIKE upper(?) OR upper(a.serie) LIKE upper(?)
              OR upper(a.posse_pessoa) LIKE upper(?) OR upper(i.nome) LIKE upper(?))
       LIMIT 12
    `).bind(emp, `%${termo}%`, `%${termo}%`, `%${termo}%`, `%${termo}%`).all();
  }

  return json(semValores({
    itens: itens.results,
    ferramentas: ferramentas.results,
    total: itens.results.length,
    exato: !!exato,
  }, usuario));
});

/* Contadores das facetas — cada chip mostra quantos são antes de clicar. */
R.get(/^\/api\/busca\/facetas$/, async ({ env, usuario }) => {
  const emp = usuario.empresa_id;
  const r = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN i.estoque_minimo > 0 AND COALESCE(s.quantidade,0) <= i.estoque_minimo
               THEN 1 ELSE 0 END) AS critico,
      SUM(CASE WHEN COALESCE(s.quantidade,0) < 0.001 THEN 1 ELSE 0 END) AS zerado,
      SUM(CASE WHEN i.tipo = 'ferramenta' THEN 1 ELSE 0 END) AS ferramenta,
      SUM(CASE WHEN i.tipo = 'consumo' THEN 1 ELSE 0 END) AS consumo,
      SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM movimentos m WHERE m.item_id = i.id
                AND m.criado_em >= date('now','-90 day')) THEN 1 ELSE 0 END) AS parado,
      COUNT(*) AS total
    FROM itens i LEFT JOIN saldo_item s ON s.item_id = i.id
   WHERE i.empresa_id = ? AND i.ativo = 1
  `).bind(emp).first();

  const cats = await env.DB.prepare(`
    SELECT c.id, c.nome, c.icone, COUNT(i.id) AS n
      FROM categorias c LEFT JOIN itens i ON i.categoria_id = c.id AND i.ativo = 1
     WHERE c.empresa_id = ? AND c.ativo = 1
     GROUP BY c.id ORDER BY c.ordem, c.nome
  `).bind(emp).all();

  return json({ contagem: r, categorias: cats.results });
});

/* Resolve o que veio da câmera. QR da etiqueta, EAN do fabricante ou
   patrimônio: tudo entra pela mesma porta e sai como "abra esta tela". */
R.get(/^\/api\/resolver$/, async ({ env, usuario, url }) => {
  let codigo = (url.searchParams.get("codigo") || "").trim();
  if (!codigo) return erro("código vazio");

  // O QR da etiqueta guarda a URL inteira; aceita-se também só o código,
  // porque leitor de código de barras de mesa devolve o número cru.
  const m = codigo.match(/\/e\/([^/?#]+)/);
  if (m) codigo = decodeURIComponent(m[1]);

  const item = await env.DB.prepare(`
    SELECT id FROM itens WHERE empresa_id = ? AND ativo = 1
       AND (upper(codigo) = upper(?) OR ean = ?) LIMIT 1
  `).bind(usuario.empresa_id, codigo, codigo).first();
  if (item) return json({ tipo: "item", id: item.id });

  const ativo = await env.DB.prepare(`
    SELECT id, item_id FROM ativos WHERE empresa_id = ? AND upper(patrimonio) = upper(?) LIMIT 1
  `).bind(usuario.empresa_id, codigo).first();
  if (ativo) return json({ tipo: "ferramenta", id: ativo.id, item_id: ativo.item_id });

  return json({ tipo: "nada", codigo }, 404);
});

/* ============================================================
   ITEM
   ============================================================ */

R.get(/^\/api\/itens\/(\d+)$/, async ({ env, usuario, params }) => {
  const emp = usuario.empresa_id;
  const item = await env.DB.prepare(`
    SELECT i.*, c.nome AS categoria, f.nome AS fornecedor
      FROM itens i
      LEFT JOIN categorias c ON c.id = i.categoria_id
      LEFT JOIN fornecedores f ON f.id = i.fornecedor_id
     WHERE i.id = ? AND i.empresa_id = ?
  `).bind(params[0], emp).first();
  if (!item) return erro("item não encontrado", 404);

  const [saldos, kardex, sinonimos, lotes, ativos] = await env.DB.batch([
    env.DB.prepare(`
      SELECT d.id AS deposito_id, d.nome AS deposito, o.nome AS obra,
             COALESCE(s.quantidade,0) AS quantidade
        FROM depositos d
        LEFT JOIN obras o ON o.id = d.obra_id
        LEFT JOIN saldos s ON s.deposito_id = d.id AND s.item_id = ?
       WHERE d.empresa_id = ? AND d.ativo = 1
       ORDER BY o.nome IS NULL DESC, o.nome, d.nome
    `).bind(item.id, emp),

    env.DB.prepare(`
      SELECT m.id, m.tipo, m.quantidade, m.custo_unitario, m.pessoa, m.motivo,
             m.documento, m.obs, m.criado_em,
             u.nome AS registrou, d.nome AS deposito, fr.nome AS frente
        FROM movimentos m
        JOIN usuarios u ON u.id = m.usuario_id
        JOIN depositos d ON d.id = m.deposito_id
        LEFT JOIN frentes fr ON fr.id = m.frente_id
       WHERE m.item_id = ? ORDER BY m.criado_em DESC, m.id DESC LIMIT 60
    `).bind(item.id),

    env.DB.prepare("SELECT id, termo FROM item_sinonimos WHERE item_id = ?").bind(item.id),

    env.DB.prepare(`
      SELECT l.id, l.codigo, l.validade, COALESCE(sl.quantidade,0) AS quantidade
        FROM lotes l LEFT JOIN saldo_lote sl ON sl.lote_id = l.id
       WHERE l.item_id = ? AND COALESCE(sl.quantidade,0) > 0
       ORDER BY l.validade IS NULL, l.validade
    `).bind(item.id),

    env.DB.prepare(`
      SELECT a.id, a.patrimonio, a.serie, a.situacao, a.posse_pessoa, a.posse_desde,
             a.prev_devolucao, d.nome AS deposito, fr.nome AS frente
        FROM ativos a
        LEFT JOIN depositos d ON d.id = a.deposito_id
        LEFT JOIN frentes fr ON fr.id = a.frente_id
       WHERE a.item_id = ? AND a.situacao != 'baixado' ORDER BY a.patrimonio
    `).bind(item.id),
  ]);

  // Saldo corrente de trás para frente: o kardex mostra "como ficou" em cada
  // linha, que é o que o auditor procura.
  const total = saldos.results.reduce((s, l) => s + l.quantidade, 0);
  let corrente = total;
  const historico = kardex.results.map((mv) => {
    const linha = { ...mv, saldo_apos: Number(corrente.toFixed(4)) };
    corrente -= mv.quantidade;
    return linha;
  });

  return json(semValores({
    item, saldo: total,
    saldos: saldos.results,
    kardex: historico,
    sinonimos: sinonimos.results,
    lotes: lotes.results,
    ativos: ativos.results,
  }, usuario));
});

R.post(/^\/api\/itens$/, async ({ env, usuario, corpo }) => {
  const { codigo, nome } = corpo;
  if (!codigo || !nome) return erro("código e nome são obrigatórios");

  const existe = await env.DB.prepare(
    "SELECT id FROM itens WHERE empresa_id = ? AND upper(codigo) = upper(?)"
  ).bind(usuario.empresa_id, codigo).first();
  if (existe) return erro("já existe item com este código", 409);

  const r = await env.DB.prepare(`
    INSERT INTO itens(empresa_id, codigo, nome, descricao, categoria_id, tipo, unidade,
                      unidade_compra, fator_conversao, ean, localizacao, estoque_minimo,
                      estoque_maximo, fornecedor_id, controla_lote)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    usuario.empresa_id, codigo, nome, corpo.descricao || null, corpo.categoria_id || null,
    corpo.tipo || "consumo", corpo.unidade || "un", corpo.unidade_compra || null,
    corpo.fator_conversao || 1, corpo.ean || null, corpo.localizacao || null,
    corpo.estoque_minimo || 0, corpo.estoque_maximo || null,
    corpo.fornecedor_id || null, corpo.controla_lote ? 1 : 0
  ).run();

  const id = r.meta.last_row_id;
  if (Array.isArray(corpo.sinonimos)) {
    for (const t of corpo.sinonimos.filter(Boolean)) {
      await env.DB.prepare("INSERT INTO item_sinonimos(item_id, termo) VALUES(?,?)")
        .bind(id, t).run();
    }
  }
  await registrar(env, usuario, "item.criado", "item", id, { codigo, nome }).run();
  return json({ id }, 201);
}, { papeis: CADASTRA });

R.patch(/^\/api\/itens\/(\d+)$/, async ({ env, usuario, params, corpo }) => {
  const campos = [
    "nome", "descricao", "categoria_id", "unidade", "unidade_compra", "fator_conversao",
    "ean", "localizacao", "estoque_minimo", "estoque_maximo", "fornecedor_id",
    "controla_lote", "ativo", "foto_chave",
  ];
  const sets = [], args = [];
  for (const c of campos) {
    if (c in corpo) { sets.push(`${c} = ?`); args.push(corpo[c]) }
  }
  if (!sets.length) return erro("nada para alterar");
  args.push(params[0], usuario.empresa_id);

  const r = await env.DB.prepare(
    `UPDATE itens SET ${sets.join(", ")} WHERE id = ? AND empresa_id = ?`
  ).bind(...args).run();
  if (!r.meta.changes) return erro("item não encontrado", 404);

  await registrar(env, usuario, "item.alterado", "item", params[0], corpo).run();
  return json({ ok: true });
}, { papeis: CADASTRA });

R.post(/^\/api\/itens\/(\d+)\/sinonimos$/, async ({ env, usuario, params, corpo }) => {
  const termo = String(corpo.termo || "").trim();
  if (!termo) return erro("termo vazio");
  const dono = await env.DB.prepare("SELECT id FROM itens WHERE id = ? AND empresa_id = ?")
    .bind(params[0], usuario.empresa_id).first();
  if (!dono) return erro("item não encontrado", 404);
  const r = await env.DB.prepare("INSERT INTO item_sinonimos(item_id, termo) VALUES(?,?)")
    .bind(params[0], termo).run();
  return json({ id: r.meta.last_row_id }, 201);
}, { papeis: CADASTRA });

R.del(/^\/api\/sinonimos\/(\d+)$/, async ({ env, usuario, params }) => {
  await env.DB.prepare(`
    DELETE FROM item_sinonimos WHERE id = ? AND item_id IN
      (SELECT id FROM itens WHERE empresa_id = ?)
  `).bind(params[0], usuario.empresa_id).run();
  return json({ ok: true });
}, { papeis: CADASTRA });

/* ============================================================
   MOVIMENTO — o coração

   O saldo não pode ficar negativo, e essa conferência é feita DENTRO do
   INSERT, não antes dele. Duas baixas do mesmo item ao mesmo tempo — o
   almoxarife no balcão e o encarregado no celular — passariam as duas por
   um `if` lido antes de gravar. Aqui, a segunda simplesmente não insere
   nenhuma linha, e `meta.changes === 0` é a resposta.
   ============================================================ */

const TIPOS_SAIDA = new Set(["saida", "perda", "transf_saida"]);

/* Menor quantidade que significa alguma coisa num almoxarifado. Serve de
   margem contra resíduo de ponto flutuante: somar e subtrair as mesmas
   quantidades deixa saldos como 4,5e-13, que a tela arredonda para "0" mas
   `<= 0` considera positivo. Aí o chip "Zerado" e o número que a pessoa lê
   discordam — e ela conclui, com razão, que o sistema está errado. */
const NADA = 0.001;

R.post(/^\/api\/movimentos$/, async ({ env, usuario, corpo }) => {
  const emp = usuario.empresa_id;
  const { item_id, deposito_id, tipo } = corpo;
  const quantidadeBruta = Number(corpo.quantidade);

  if (!item_id || !deposito_id) return erro("informe o item e o depósito");
  if (!Number.isFinite(quantidadeBruta) || quantidadeBruta === 0) return erro("quantidade inválida");
  if (!["entrada", "saida", "devolucao", "ajuste", "perda"].includes(tipo)) {
    return erro("tipo de movimento inválido");
  }
  if ((tipo === "ajuste" || tipo === "perda") && !String(corpo.motivo || "").trim()) {
    return erro("ajuste e perda exigem motivo — é o que separa correção de rasura");
  }

  const item = await env.DB.prepare(
    "SELECT id, nome, unidade, tipo, controla_lote FROM itens WHERE id = ? AND empresa_id = ? AND ativo = 1"
  ).bind(item_id, emp).first();
  if (!item) return erro("item não encontrado", 404);
  if (item.tipo === "ferramenta") {
    return erro("ferramenta se empresta e se devolve, não se dá baixa por quantidade");
  }

  const deposito = await env.DB.prepare(
    "SELECT id FROM depositos WHERE id = ? AND empresa_id = ? AND ativo = 1"
  ).bind(deposito_id, emp).first();
  if (!deposito) return erro("depósito não encontrado", 404);

  // Quem informa em unidade de compra (saco, caixa, rolo) converte aqui.
  // O livro guarda SEMPRE na unidade de uso — misturar as duas é como o
  // estoque de obra desanda na planilha.
  let quantidade = Math.abs(quantidadeBruta);
  if (corpo.em_unidade_compra) {
    const f = await env.DB.prepare("SELECT fator_conversao FROM itens WHERE id = ?")
      .bind(item_id).first();
    quantidade = quantidade * (f?.fator_conversao || 1);
  }

  // O sinal vem do tipo, nunca do que o cliente mandou. Ajuste é o único
  // que pode ir para os dois lados — e aí o sinal do número é intencional.
  let assinada;
  if (tipo === "ajuste") assinada = quantidadeBruta;
  else assinada = TIPOS_SAIDA.has(tipo) ? -quantidade : quantidade;

  let loteId = corpo.lote_id || null;
  if (tipo === "entrada" && item.controla_lote && !loteId && corpo.validade) {
    const l = await env.DB.prepare(
      "INSERT INTO lotes(empresa_id, item_id, codigo, validade, fornecedor_id) VALUES(?,?,?,?,?)"
    ).bind(emp, item_id, corpo.lote || null, corpo.validade, corpo.fornecedor_id || null).run();
    loteId = l.meta.last_row_id;
  }

  const sai = assinada < 0;
  const insercao = sai
    ? env.DB.prepare(`
        INSERT INTO movimentos(empresa_id, item_id, deposito_id, tipo, quantidade,
                               custo_unitario, frente_id, lote_id, usuario_id, pessoa,
                               documento, motivo, obs)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?
         WHERE (SELECT COALESCE(SUM(quantidade),0) FROM movimentos
                 WHERE item_id = ? AND deposito_id = ?) >= ?
      `).bind(
        emp, item_id, deposito_id, tipo, assinada,
        corpo.custo_unitario || null, corpo.frente_id || null, loteId, usuario.id,
        corpo.pessoa || null, corpo.documento || null, corpo.motivo || null, corpo.obs || null,
        item_id, deposito_id, Math.abs(assinada)
      )
    : env.DB.prepare(`
        INSERT INTO movimentos(empresa_id, item_id, deposito_id, tipo, quantidade,
                               custo_unitario, frente_id, lote_id, usuario_id, pessoa,
                               documento, motivo, obs)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        emp, item_id, deposito_id, tipo, assinada,
        corpo.custo_unitario || null, corpo.frente_id || null, loteId, usuario.id,
        corpo.pessoa || null, corpo.documento || null, corpo.motivo || null, corpo.obs || null
      );

  const r = await insercao.run();

  if (!r.meta.changes) {
    const s = await env.DB.prepare(
      "SELECT COALESCE(SUM(quantidade),0) AS q FROM movimentos WHERE item_id = ? AND deposito_id = ?"
    ).bind(item_id, deposito_id).first();
    return erro(
      `saldo insuficiente: tem ${s.q} ${item.unidade}, tentou tirar ${Math.abs(assinada)}`, 409
    );
  }

  // A última entrada alimenta o custo do item — é o que o relatório de
  // valor imobilizado e a curva ABC usam.
  const extras = [registrar(env, usuario, "movimento", "item", item_id,
    { tipo, quantidade: assinada })];
  if (tipo === "entrada" && corpo.custo_unitario) {
    extras.push(env.DB.prepare("UPDATE itens SET custo_ultimo = ? WHERE id = ? AND empresa_id = ?")
      .bind(corpo.custo_unitario, item_id, emp));
  }
  await env.DB.batch(extras);

  const saldo = await env.DB.prepare(
    "SELECT COALESCE(SUM(quantidade),0) AS q FROM movimentos WHERE item_id = ?"
  ).bind(item_id).first();

  return json({ id: r.meta.last_row_id, saldo: saldo.q, item: item.nome, unidade: item.unidade }, 201);
}, { papeis: MOVIMENTA });

/* Transferência entre depósitos: dois lançamentos amarrados pelo mesmo
   identificador, na mesma transação. Um lado sem o outro faria material
   sumir de uma obra sem aparecer na outra. */
R.post(/^\/api\/transferencias$/, async ({ env, usuario, corpo }) => {
  const emp = usuario.empresa_id;
  const { item_id, origem_id, destino_id } = corpo;
  const quantidade = Math.abs(Number(corpo.quantidade));
  if (!item_id || !origem_id || !destino_id) return erro("informe item, origem e destino");
  if (origem_id === destino_id) return erro("origem e destino são o mesmo depósito");
  if (!Number.isFinite(quantidade) || quantidade <= 0) return erro("quantidade inválida");

  const marca = crypto.randomUUID();

  const saida = await env.DB.prepare(`
    INSERT INTO movimentos(empresa_id, item_id, deposito_id, tipo, quantidade,
                           usuario_id, obs, transferencia)
    SELECT ?,?,?,'transf_saida',?,?,?,?
     WHERE (SELECT COALESCE(SUM(quantidade),0) FROM movimentos
             WHERE item_id = ? AND deposito_id = ?) >= ?
       AND EXISTS (SELECT 1 FROM depositos WHERE id = ? AND empresa_id = ? AND ativo = 1)
       AND EXISTS (SELECT 1 FROM depositos WHERE id = ? AND empresa_id = ? AND ativo = 1)
  `).bind(emp, item_id, origem_id, -quantidade, usuario.id, corpo.obs || null, marca,
          item_id, origem_id, quantidade, origem_id, emp, destino_id, emp).run();

  if (!saida.meta.changes) return erro("saldo insuficiente na origem, ou depósito inválido", 409);

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO movimentos(empresa_id, item_id, deposito_id, tipo, quantidade,
                             usuario_id, obs, transferencia)
      VALUES(?,?,?,'transf_entrada',?,?,?,?)
    `).bind(emp, item_id, destino_id, quantidade, usuario.id, corpo.obs || null, marca),
    registrar(env, usuario, "transferencia", "item", item_id,
      { quantidade, origem_id, destino_id }),
  ]);

  return json({ ok: true, transferencia: marca }, 201);
}, { papeis: MOVIMENTA });

/* Kardex geral, com filtros. É a tela que responde "o que saiu essa semana". */
R.get(/^\/api\/movimentos$/, async ({ env, usuario, url }) => {
  const p = url.searchParams;
  const cond = ["m.empresa_id = ?"], args = [usuario.empresa_id];

  if (p.get("item"))     { cond.push("m.item_id = ?");     args.push(p.get("item")) }
  if (p.get("deposito")) { cond.push("m.deposito_id = ?"); args.push(p.get("deposito")) }
  if (p.get("frente"))   { cond.push("m.frente_id = ?");   args.push(p.get("frente")) }
  if (p.get("tipo"))     { cond.push("m.tipo = ?");        args.push(p.get("tipo")) }
  if (p.get("de"))       { cond.push("m.criado_em >= ?");  args.push(p.get("de")) }
  if (p.get("ate"))      { cond.push("m.criado_em <= ?");  args.push(p.get("ate") + "T23:59:59Z") }
  if (p.get("pessoa"))   { cond.push("upper(m.pessoa) LIKE upper(?)"); args.push(`%${p.get("pessoa")}%`) }

  const limite = Math.min(parseInt(p.get("limite") || "100", 10), 500);
  const r = await env.DB.prepare(`
    SELECT m.id, m.tipo, m.quantidade, m.custo_unitario, m.pessoa, m.motivo,
           m.documento, m.criado_em,
           i.nome AS item, i.codigo, i.unidade, i.id AS item_id,
           u.nome AS registrou, d.nome AS deposito, fr.nome AS frente, o.nome AS obra
      FROM movimentos m
      JOIN itens i ON i.id = m.item_id
      JOIN usuarios u ON u.id = m.usuario_id
      JOIN depositos d ON d.id = m.deposito_id
      LEFT JOIN obras o ON o.id = d.obra_id
      LEFT JOIN frentes fr ON fr.id = m.frente_id
     WHERE ${cond.join(" AND ")}
     ORDER BY m.criado_em DESC, m.id DESC LIMIT ?
  `).bind(...args, limite).all();

  return json(semValores({ movimentos: r.results }, usuario));
});

/* ============================================================
   REQUISIÇÃO — o encarregado pede, o almoxarife entrega

   A entrega só fecha com o PIN de quem recebeu. Sem prova de entrega,
   "eu nunca peguei esse material" não tem resposta — e essa discussão
   acontece em toda obra.
   ============================================================ */

R.get(/^\/api\/requisicoes$/, async ({ env, usuario, url }) => {
  const cond = ["r.empresa_id = ?"], args = [usuario.empresa_id];
  const situacao = url.searchParams.get("situacao");
  if (situacao) { cond.push("r.situacao = ?"); args.push(situacao) }
  // Encarregado só enxerga o que ele mesmo pediu.
  if (usuario.papel === "encarregado") { cond.push("r.solicitante_id = ?"); args.push(usuario.id) }

  const r = await env.DB.prepare(`
    SELECT r.*, u.nome AS solicitante, o.nome AS obra, fr.nome AS frente, d.nome AS deposito,
           (SELECT COUNT(*) FROM requisicao_itens ri WHERE ri.requisicao_id = r.id) AS itens
      FROM requisicoes r
      JOIN usuarios u ON u.id = r.solicitante_id
      JOIN obras o ON o.id = r.obra_id
      JOIN depositos d ON d.id = r.deposito_id
      LEFT JOIN frentes fr ON fr.id = r.frente_id
     WHERE ${cond.join(" AND ")}
     ORDER BY CASE r.situacao WHEN 'aberta' THEN 0 WHEN 'separando' THEN 1 ELSE 2 END,
              CASE r.urgencia WHEN 'urgente' THEN 0 ELSE 1 END,
              r.criado_em DESC
     LIMIT 120
  `).bind(...args).all();
  return json({ requisicoes: r.results });
});

R.get(/^\/api\/requisicoes\/(\d+)$/, async ({ env, usuario, params }) => {
  const r = await env.DB.prepare(`
    SELECT r.*, u.nome AS solicitante, o.nome AS obra, fr.nome AS frente, d.nome AS deposito
      FROM requisicoes r
      JOIN usuarios u ON u.id = r.solicitante_id
      JOIN obras o ON o.id = r.obra_id
      JOIN depositos d ON d.id = r.deposito_id
      LEFT JOIN frentes fr ON fr.id = r.frente_id
     WHERE r.id = ? AND r.empresa_id = ?
  `).bind(params[0], usuario.empresa_id).first();
  if (!r) return erro("requisição não encontrada", 404);
  if (usuario.papel === "encarregado" && r.solicitante_id !== usuario.id) {
    return erro("esta requisição não é sua", 403);
  }

  const itens = await env.DB.prepare(`
    SELECT ri.*, i.nome, i.codigo, i.unidade, i.localizacao,
           COALESCE(s.quantidade,0) AS saldo
      FROM requisicao_itens ri
      JOIN itens i ON i.id = ri.item_id
      LEFT JOIN saldos s ON s.item_id = i.id AND s.deposito_id = ?
     WHERE ri.requisicao_id = ?
  `).bind(r.deposito_id, r.id).all();

  return json({ requisicao: r, itens: itens.results });
});

R.post(/^\/api\/requisicoes$/, async ({ env, usuario, corpo }) => {
  const emp = usuario.empresa_id;
  const itens = (corpo.itens || []).filter((i) => i.item_id && Number(i.qtd_pedida) > 0);
  if (!itens.length) return erro("a requisição precisa de pelo menos um item");
  if (!corpo.obra_id || !corpo.deposito_id) return erro("informe a obra e o depósito");

  const ultimo = await env.DB.prepare(
    "SELECT COALESCE(MAX(numero),0) AS n FROM requisicoes WHERE empresa_id = ?"
  ).bind(emp).first();

  const r = await env.DB.prepare(`
    INSERT INTO requisicoes(empresa_id, numero, obra_id, frente_id, deposito_id,
                            solicitante_id, urgencia, observacao)
    VALUES(?,?,?,?,?,?,?,?)
  `).bind(emp, ultimo.n + 1, corpo.obra_id, corpo.frente_id || null, corpo.deposito_id,
          usuario.id, corpo.urgencia === "urgente" ? "urgente" : "normal",
          corpo.observacao || null).run();

  const id = r.meta.last_row_id;
  await env.DB.batch([
    ...itens.map((i) => env.DB.prepare(
      "INSERT INTO requisicao_itens(requisicao_id, item_id, qtd_pedida, obs) VALUES(?,?,?,?)"
    ).bind(id, i.item_id, Number(i.qtd_pedida), i.obs || null)),
    registrar(env, usuario, "requisicao.aberta", "requisicao", id, { itens: itens.length }),
  ]);

  return json({ id, numero: ultimo.n + 1 }, 201);
});

R.post(/^\/api\/requisicoes\/(\d+)\/separar$/, async ({ env, usuario, params }) => {
  const r = await env.DB.prepare(`
    UPDATE requisicoes SET situacao = 'separando', atendido_por = ?
     WHERE id = ? AND empresa_id = ? AND situacao = 'aberta'
  `).bind(usuario.id, params[0], usuario.empresa_id).run();
  if (!r.meta.changes) return erro("esta requisição não está aberta", 409);
  return json({ ok: true });
}, { papeis: MOVIMENTA });

/* Entregar = dar baixa de verdade no estoque, item por item, com a mesma
   trava de saldo do movimento avulso. O PIN de quem recebe é a assinatura. */
R.post(/^\/api\/requisicoes\/(\d+)\/entregar$/, async ({ env, usuario, params, corpo }) => {
  const emp = usuario.empresa_id;
  const req = await env.DB.prepare(
    "SELECT * FROM requisicoes WHERE id = ? AND empresa_id = ? AND situacao IN ('aberta','separando')"
  ).bind(params[0], emp).first();
  if (!req) return erro("requisição não encontrada ou já fechada", 404);

  // Confirmação de quem recebe. Aceita o PIN de qualquer usuário da empresa
  // — quem retira nem sempre é quem pediu.
  const pin = String(corpo.pin || "").trim();
  if (!pin) return erro("peça o PIN de quem está recebendo o material");
  const recebedor = await env.DB.prepare(
    "SELECT id, nome FROM usuarios WHERE empresa_id = ? AND pin = ? AND ativo = 1"
  ).bind(emp, pin).first();
  if (!recebedor) return erro("PIN não confere", 403);

  const linhas = (corpo.itens || []).filter((i) => Number(i.qtd_atendida) > 0);
  if (!linhas.length) return erro("nenhuma quantidade informada");

  const entregues = [], faltaram = [];
  for (const linha of linhas) {
    const qtd = Math.abs(Number(linha.qtd_atendida));
    const mov = await env.DB.prepare(`
      INSERT INTO movimentos(empresa_id, item_id, deposito_id, tipo, quantidade,
                             frente_id, requisicao_id, usuario_id, pessoa, obs)
      SELECT ?,?,?,'saida',?,?,?,?,?,?
       WHERE (SELECT COALESCE(SUM(quantidade),0) FROM movimentos
               WHERE item_id = ? AND deposito_id = ?) >= ?
    `).bind(emp, linha.item_id, req.deposito_id, -qtd, req.frente_id, req.id,
            usuario.id, recebedor.nome, `Requisição #${req.numero}`,
            linha.item_id, req.deposito_id, qtd).run();

    if (mov.meta.changes) {
      entregues.push(linha.item_id);
      await env.DB.prepare(
        "UPDATE requisicao_itens SET qtd_atendida = ? WHERE requisicao_id = ? AND item_id = ?"
      ).bind(qtd, req.id, linha.item_id).run();
    } else {
      faltaram.push(linha.item_id);
    }
  }

  // Atendeu tudo que foi pedido? Só então a requisição fecha como entregue.
  const pendentes = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM requisicao_itens WHERE requisicao_id = ? AND qtd_atendida < qtd_pedida"
  ).bind(req.id).first();
  const situacao = pendentes.n > 0 ? "parcial" : "entregue";

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE requisicoes SET situacao = ?, atendido_por = ?, recebido_por = ?, entregue_em = ?
       WHERE id = ?
    `).bind(situacao, usuario.id, recebedor.nome, agora(), req.id),
    registrar(env, usuario, "requisicao.entregue", "requisicao", req.id,
      { situacao, recebido_por: recebedor.nome, entregues: entregues.length }),
  ]);

  return json({
    ok: true, situacao, recebido_por: recebedor.nome,
    entregues: entregues.length,
    faltaram: faltaram.length,
    aviso: faltaram.length ? "alguns itens não tinham saldo e ficaram pendentes" : null,
  });
}, { papeis: MOVIMENTA });

R.post(/^\/api\/requisicoes\/(\d+)\/cancelar$/, async ({ env, usuario, params, corpo }) => {
  const r = await env.DB.prepare(`
    UPDATE requisicoes SET situacao = 'cancelada', observacao = COALESCE(observacao,'') || ?
     WHERE id = ? AND empresa_id = ? AND situacao IN ('aberta','separando')
  `).bind(`\n[cancelada] ${corpo.motivo || ""}`, params[0], usuario.empresa_id).run();
  if (!r.meta.changes) return erro("não é possível cancelar esta requisição", 409);
  await registrar(env, usuario, "requisicao.cancelada", "requisicao", params[0], corpo).run();
  return json({ ok: true });
});

/* ============================================================
   FERRAMENTA — posse, não saldo

   "Quem está com a furadeira, desde quando." Uma tela. É a dor onde some
   dinheiro de verdade na obra — mais até do que material de consumo.
   ============================================================ */

R.get(/^\/api\/ferramentas$/, async ({ env, usuario, url }) => {
  const cond = ["a.empresa_id = ?", "a.situacao != 'baixado'"], args = [usuario.empresa_id];
  const situacao = url.searchParams.get("situacao");
  if (situacao === "atrasadas") {
    cond.push("a.situacao = 'em_uso' AND a.posse_desde < datetime('now','-7 day')");
  } else if (situacao) { cond.push("a.situacao = ?"); args.push(situacao) }

  const r = await env.DB.prepare(`
    SELECT a.*, i.nome AS item, i.codigo AS item_codigo, i.foto_chave,
           d.nome AS deposito, fr.nome AS frente, o.nome AS obra,
           CAST(julianday('now') - julianday(a.posse_desde) AS INTEGER) AS dias_fora
      FROM ativos a
      JOIN itens i ON i.id = a.item_id
      LEFT JOIN depositos d ON d.id = a.deposito_id
      LEFT JOIN frentes fr ON fr.id = a.frente_id
      LEFT JOIN obras o ON o.id = fr.obra_id
     WHERE ${cond.join(" AND ")}
     ORDER BY CASE a.situacao WHEN 'em_uso' THEN 0 WHEN 'manutencao' THEN 1 ELSE 2 END,
              a.posse_desde ASC, i.nome
     LIMIT 200
  `).bind(...args).all();
  return json({ ferramentas: r.results });
});

R.post(/^\/api\/ferramentas\/(\d+)\/emprestar$/, async ({ env, usuario, params, corpo }) => {
  const emp = usuario.empresa_id;
  const pessoa = String(corpo.pessoa || "").trim();
  if (!pessoa) return erro("informe quem está levando a ferramenta");

  // A condição vai no próprio UPDATE: emprestar o que já está com alguém
  // apagaria em silêncio o registro de quem estava com ela.
  const r = await env.DB.prepare(`
    UPDATE ativos SET situacao = 'em_uso', posse_pessoa = ?, posse_usuario = ?,
                      frente_id = ?, posse_desde = ?, prev_devolucao = ?
     WHERE id = ? AND empresa_id = ? AND situacao = 'disponivel'
  `).bind(pessoa, corpo.posse_usuario || null, corpo.frente_id || null, agora(),
          corpo.prev_devolucao || null, params[0], emp).run();

  if (!r.meta.changes) {
    const a = await env.DB.prepare("SELECT situacao, posse_pessoa FROM ativos WHERE id = ? AND empresa_id = ?")
      .bind(params[0], emp).first();
    if (!a) return erro("ferramenta não encontrada", 404);
    return erro(
      a.situacao === "em_uso"
        ? `esta ferramenta já está com ${a.posse_pessoa} — registre a devolução primeiro`
        : `ferramenta em ${a.situacao}`, 409
    );
  }

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO ativo_movimentos(empresa_id, ativo_id, tipo, usuario_id, pessoa, frente_id, obs)
      VALUES(?,?,'emprestimo',?,?,?,?)
    `).bind(emp, params[0], usuario.id, pessoa, corpo.frente_id || null, corpo.obs || null),
    registrar(env, usuario, "ferramenta.emprestada", "ativo", params[0], { pessoa }),
  ]);
  return json({ ok: true, pessoa });
}, { papeis: MOVIMENTA });

R.post(/^\/api\/ferramentas\/(\d+)\/devolver$/, async ({ env, usuario, params, corpo }) => {
  const emp = usuario.empresa_id;
  const destino = corpo.manutencao ? "manutencao" : "disponivel";

  const r = await env.DB.prepare(`
    UPDATE ativos SET situacao = ?, posse_pessoa = NULL, posse_usuario = NULL,
                      frente_id = NULL, posse_desde = NULL, prev_devolucao = NULL,
                      deposito_id = COALESCE(?, deposito_id)
     WHERE id = ? AND empresa_id = ? AND situacao IN ('em_uso','manutencao')
  `).bind(destino, corpo.deposito_id || null, params[0], emp).run();
  if (!r.meta.changes) return erro("esta ferramenta não está emprestada", 409);

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO ativo_movimentos(empresa_id, ativo_id, tipo, usuario_id, deposito_id, obs)
      VALUES(?,?,?,?,?,?)
    `).bind(emp, params[0], corpo.manutencao ? "manutencao" : "devolucao", usuario.id,
            corpo.deposito_id || null, corpo.obs || null),
    registrar(env, usuario, "ferramenta.devolvida", "ativo", params[0], { destino }),
  ]);
  return json({ ok: true, situacao: destino });
}, { papeis: MOVIMENTA });

R.get(/^\/api\/ferramentas\/(\d+)$/, async ({ env, usuario, params }) => {
  const a = await env.DB.prepare(`
    SELECT a.*, i.nome AS item, i.codigo AS item_codigo, d.nome AS deposito, fr.nome AS frente
      FROM ativos a JOIN itens i ON i.id = a.item_id
      LEFT JOIN depositos d ON d.id = a.deposito_id
      LEFT JOIN frentes fr ON fr.id = a.frente_id
     WHERE a.id = ? AND a.empresa_id = ?
  `).bind(params[0], usuario.empresa_id).first();
  if (!a) return erro("ferramenta não encontrada", 404);

  const h = await env.DB.prepare(`
    SELECT am.*, u.nome AS registrou, fr.nome AS frente
      FROM ativo_movimentos am
      JOIN usuarios u ON u.id = am.usuario_id
      LEFT JOIN frentes fr ON fr.id = am.frente_id
     WHERE am.ativo_id = ? ORDER BY am.criado_em DESC LIMIT 40
  `).bind(params[0]).all();
  return json({ ferramenta: a, historico: h.results });
});

R.post(/^\/api\/ferramentas$/, async ({ env, usuario, corpo }) => {
  if (!corpo.item_id || !corpo.patrimonio) return erro("informe o item e o patrimônio");
  const existe = await env.DB.prepare(
    "SELECT id FROM ativos WHERE empresa_id = ? AND upper(patrimonio) = upper(?)"
  ).bind(usuario.empresa_id, corpo.patrimonio).first();
  if (existe) return erro("já existe ferramenta com este patrimônio", 409);

  const r = await env.DB.prepare(`
    INSERT INTO ativos(empresa_id, item_id, patrimonio, serie, deposito_id, obs)
    VALUES(?,?,?,?,?,?)
  `).bind(usuario.empresa_id, corpo.item_id, corpo.patrimonio, corpo.serie || null,
          corpo.deposito_id || null, corpo.obs || null).run();
  return json({ id: r.meta.last_row_id }, 201);
}, { papeis: CADASTRA });

/* ============================================================
   INVENTÁRIO — contagem física contra o sistema

   `saldo_sistema` é congelado na abertura. Comparar a contagem de ontem
   com o saldo de hoje acusaria divergência onde só houve movimento — e
   é assim que inventário perde a credibilidade na primeira rodada.
   ============================================================ */

R.post(/^\/api\/inventarios$/, async ({ env, usuario, corpo }) => {
  const emp = usuario.empresa_id;
  if (!corpo.deposito_id) return erro("informe o depósito");

  const aberto = await env.DB.prepare(
    "SELECT id FROM inventarios WHERE empresa_id = ? AND deposito_id = ? AND situacao = 'aberto'"
  ).bind(emp, corpo.deposito_id).first();
  if (aberto) return erro("já existe inventário aberto neste depósito", 409);

  const r = await env.DB.prepare(`
    INSERT INTO inventarios(empresa_id, deposito_id, nome, criado_por) VALUES(?,?,?,?)
  `).bind(emp, corpo.deposito_id, corpo.nome || null, usuario.id).run();
  const id = r.meta.last_row_id;

  // Congela o saldo de todo item que tem movimento neste depósito.
  await env.DB.prepare(`
    INSERT INTO inventario_itens(inventario_id, item_id, saldo_sistema)
    SELECT ?, i.id, COALESCE(s.quantidade, 0)
      FROM itens i
      LEFT JOIN saldos s ON s.item_id = i.id AND s.deposito_id = ?
     WHERE i.empresa_id = ? AND i.ativo = 1 AND i.tipo = 'consumo'
       AND (${corpo.categoria_id ? "i.categoria_id = ? AND" : ""} COALESCE(s.quantidade,0) <> 0
            OR i.estoque_minimo > 0)
  `).bind(...(corpo.categoria_id
      ? [id, corpo.deposito_id, emp, corpo.categoria_id]
      : [id, corpo.deposito_id, emp])).run();

  await registrar(env, usuario, "inventario.aberto", "inventario", id, corpo).run();
  return json({ id }, 201);
}, { papeis: MOVIMENTA });

R.get(/^\/api\/inventarios$/, async ({ env, usuario }) => {
  const r = await env.DB.prepare(`
    SELECT inv.*, d.nome AS deposito, u.nome AS criador,
           (SELECT COUNT(*) FROM inventario_itens ii WHERE ii.inventario_id = inv.id) AS itens,
           (SELECT COUNT(*) FROM inventario_itens ii WHERE ii.inventario_id = inv.id
              AND ii.contagem IS NOT NULL) AS contados
      FROM inventarios inv
      JOIN depositos d ON d.id = inv.deposito_id
      JOIN usuarios u ON u.id = inv.criado_por
     WHERE inv.empresa_id = ? ORDER BY inv.criado_em DESC LIMIT 40
  `).bind(usuario.empresa_id).all();
  return json({ inventarios: r.results });
});

R.get(/^\/api\/inventarios\/(\d+)$/, async ({ env, usuario, params }) => {
  const inv = await env.DB.prepare(`
    SELECT inv.*, d.nome AS deposito FROM inventarios inv
      JOIN depositos d ON d.id = inv.deposito_id
     WHERE inv.id = ? AND inv.empresa_id = ?
  `).bind(params[0], usuario.empresa_id).first();
  if (!inv) return erro("inventário não encontrado", 404);

  const itens = await env.DB.prepare(`
    SELECT ii.*, i.codigo, i.nome, i.unidade, i.localizacao,
           (ii.contagem - ii.saldo_sistema) AS diferenca
      FROM inventario_itens ii JOIN itens i ON i.id = ii.item_id
     WHERE ii.inventario_id = ?
     ORDER BY ii.contagem IS NOT NULL, i.localizacao, i.nome
  `).bind(params[0]).all();

  const contados = itens.results.filter((i) => i.contagem !== null);
  const certos = contados.filter((i) => Math.abs(i.diferenca) < 0.001).length;

  return json({
    inventario: inv,
    itens: itens.results,
    resumo: {
      total: itens.results.length,
      contados: contados.length,
      divergentes: contados.length - certos,
      // Acuracidade: o número que o dono quer ver subir mês a mês.
      acuracidade: contados.length ? Math.round((certos / contados.length) * 100) : null,
    },
  });
});

R.post(/^\/api\/inventarios\/(\d+)\/contar$/, async ({ env, usuario, params, corpo }) => {
  const contagem = Number(corpo.contagem);
  if (!Number.isFinite(contagem) || contagem < 0) return erro("contagem inválida");
  const r = await env.DB.prepare(`
    UPDATE inventario_itens SET contagem = ?, contado_por = ?, contado_em = ?
     WHERE inventario_id = ? AND item_id = ?
       AND inventario_id IN (SELECT id FROM inventarios WHERE empresa_id = ? AND situacao = 'aberto')
  `).bind(contagem, usuario.id, agora(), params[0], corpo.item_id, usuario.empresa_id).run();
  if (!r.meta.changes) return erro("item não está neste inventário, ou ele já foi fechado", 409);
  return json({ ok: true });
}, { papeis: MOVIMENTA });

/* Fechar o inventário gera um movimento de ajuste para cada divergência.
   O estoque não é "corrigido": a diferença vira um lançamento com motivo,
   autor e data, igual a qualquer outro fato do livro. */
R.post(/^\/api\/inventarios\/(\d+)\/fechar$/, async ({ env, usuario, params }) => {
  const emp = usuario.empresa_id;
  const inv = await env.DB.prepare(
    "SELECT * FROM inventarios WHERE id = ? AND empresa_id = ? AND situacao = 'aberto'"
  ).bind(params[0], emp).first();
  if (!inv) return erro("inventário não encontrado ou já fechado", 404);

  const divergentes = await env.DB.prepare(`
    SELECT item_id, saldo_sistema, contagem, (contagem - saldo_sistema) AS diferenca
      FROM inventario_itens
     WHERE inventario_id = ? AND contagem IS NOT NULL
       AND ABS(contagem - saldo_sistema) > 0.001
  `).bind(inv.id).all();

  const lancamentos = divergentes.results.map((d) =>
    env.DB.prepare(`
      INSERT INTO movimentos(empresa_id, item_id, deposito_id, tipo, quantidade,
                             usuario_id, motivo, obs)
      VALUES(?,?,?,'ajuste',?,?,?,?)
    `).bind(emp, d.item_id, inv.deposito_id, d.diferenca, usuario.id,
            `Inventário #${inv.id}`,
            `Sistema ${d.saldo_sistema} → contado ${d.contagem}`)
  );

  await env.DB.batch([
    ...lancamentos,
    env.DB.prepare("UPDATE inventarios SET situacao = 'fechado', fechado_em = ? WHERE id = ?")
      .bind(agora(), inv.id),
    registrar(env, usuario, "inventario.fechado", "inventario", inv.id,
      { ajustes: divergentes.results.length }),
  ]);

  return json({ ok: true, ajustes: divergentes.results.length });
}, { papeis: MOVIMENTA });

/* ============================================================
   RELATÓRIOS
   ============================================================ */

/* Consumo por frente de obra. É o relatório que responde "quanto a laje do
   bloco C custou" — e é ele que justifica ligar as outras obras. */
R.get(/^\/api\/relatorios\/consumo$/, async ({ env, usuario, url }) => {
  const p = url.searchParams;
  const de = p.get("de") || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const ate = (p.get("ate") || agora().slice(0, 10)) + "T23:59:59Z";
  const por = p.get("por") === "categoria" ? "categoria" : "frente";

  const sql = por === "categoria" ? `
    SELECT COALESCE(c.nome, 'Sem categoria') AS rotulo,
           SUM(-m.quantidade) AS quantidade,
           SUM(-m.quantidade * COALESCE(m.custo_unitario, i.custo_ultimo, 0)) AS valor_total,
           COUNT(DISTINCT m.item_id) AS itens
      FROM movimentos m
      JOIN itens i ON i.id = m.item_id
      LEFT JOIN categorias c ON c.id = i.categoria_id
     WHERE m.empresa_id = ? AND m.tipo = 'saida' AND m.criado_em BETWEEN ? AND ?
     GROUP BY c.id ORDER BY valor_total DESC` : `
    SELECT COALESCE(fr.nome, 'Sem frente') AS rotulo,
           COALESCE(o.nome, '—') AS obra,
           SUM(-m.quantidade) AS quantidade,
           SUM(-m.quantidade * COALESCE(m.custo_unitario, i.custo_ultimo, 0)) AS valor_total,
           COUNT(DISTINCT m.item_id) AS itens
      FROM movimentos m
      JOIN itens i ON i.id = m.item_id
      LEFT JOIN frentes fr ON fr.id = m.frente_id
      LEFT JOIN obras o ON o.id = fr.obra_id
     WHERE m.empresa_id = ? AND m.tipo = 'saida' AND m.criado_em BETWEEN ? AND ?
     GROUP BY fr.id ORDER BY valor_total DESC`;

  const r = await env.DB.prepare(sql).bind(usuario.empresa_id, de, ate).all();
  return json(semValores({ periodo: { de, ate }, por, linhas: r.results }, usuario));
});

/* Curva ABC: os poucos itens que são quase todo o dinheiro parado.
   A classe sai do acumulado, calculado aqui e não no banco — SQLite sem
   função de janela faria disso uma consulta ilegível. */
R.get(/^\/api\/relatorios\/abc$/, async ({ env, usuario }) => {
  const r = await env.DB.prepare(`
    SELECT i.id, i.codigo, i.nome, i.unidade, s.quantidade,
           (s.quantidade * COALESCE(i.custo_ultimo,0)) AS valor_total
      FROM saldo_item s JOIN itens i ON i.id = s.item_id
     WHERE i.empresa_id = ? AND s.quantidade > 0 AND COALESCE(i.custo_ultimo,0) > 0
     ORDER BY valor_total DESC LIMIT 200
  `).bind(usuario.empresa_id).all();

  const total = r.results.reduce((s, l) => s + l.valor_total, 0);
  let acumulado = 0;
  const linhas = r.results.map((l) => {
    acumulado += l.valor_total;
    const fatia = total ? (acumulado / total) * 100 : 0;
    return {
      ...l,
      participacao: total ? (l.valor_total / total) * 100 : 0,
      acumulado: fatia,
      classe: fatia <= 80 ? "A" : fatia <= 95 ? "B" : "C",
    };
  });
  return json(semValores({ total, linhas }, usuario));
});

/* Sugestão de compra: sai de "controle de estoque" e vira "me diz o que
   comprar". Agrupado por fornecedor porque é assim que se faz o pedido. */
R.get(/^\/api\/relatorios\/reposicao$/, async ({ env, usuario }) => {
  const r = await env.DB.prepare(`
    SELECT i.id, i.codigo, i.nome, i.unidade, i.unidade_compra, i.fator_conversao,
           i.estoque_minimo, i.estoque_maximo, i.custo_ultimo, i.localizacao,
           COALESCE(s.quantidade,0) AS saldo,
           COALESCE(f.nome,'Sem fornecedor') AS fornecedor, f.id AS fornecedor_id,
           (SELECT SUM(-m.quantidade) FROM movimentos m
             WHERE m.item_id = i.id AND m.tipo = 'saida'
               AND m.criado_em >= date('now','-30 day')) AS consumo_30d
      FROM itens i
      LEFT JOIN saldo_item s ON s.item_id = i.id
      LEFT JOIN fornecedores f ON f.id = i.fornecedor_id
     WHERE i.empresa_id = ? AND i.ativo = 1 AND i.tipo = 'consumo'
       AND i.estoque_minimo > 0 AND COALESCE(s.quantidade,0) <= i.estoque_minimo
     ORDER BY f.nome, i.nome
  `).bind(usuario.empresa_id).all();

  const linhas = r.results.map((l) => {
    const alvo = l.estoque_maximo || l.estoque_minimo * 2;
    const comprar = Math.max(alvo - l.saldo, 0);
    return {
      ...l,
      comprar: Number(comprar.toFixed(2)),
      // Em unidade de COMPRA, arredondado para cima: ninguém compra 2,3 sacos.
      comprar_embalagem: l.unidade_compra
        ? Math.ceil(comprar / (l.fator_conversao || 1)) : null,
      valor: comprar * (l.custo_ultimo || 0),
      // Dias de cobertura pelo consumo do último mês. É o que diz se é
      // urgente ou se dá para esperar o pedido do mês.
      dias_cobertura: l.consumo_30d > 0
        ? Math.round((l.saldo / (l.consumo_30d / 30)) * 10) / 10 : null,
    };
  });
  return json(semValores({ linhas, total: linhas.reduce((s, l) => s + l.valor, 0) }, usuario));
});

/* Validade: EPI, cimento, epóxi e silicone vencem. Material perdido por
   vencimento é dinheiro que sai sem ninguém ver acontecer. */
R.get(/^\/api\/relatorios\/validade$/, async ({ env, usuario, url }) => {
  const dias = parseInt(url.searchParams.get("dias") || "60", 10);
  const r = await env.DB.prepare(`
    SELECT l.id, l.codigo AS lote, l.validade, sl.quantidade,
           i.id AS item_id, i.nome, i.codigo, i.unidade, i.custo_ultimo,
           CAST(julianday(l.validade) - julianday('now') AS INTEGER) AS dias_restantes
      FROM lotes l
      JOIN saldo_lote sl ON sl.lote_id = l.id
      JOIN itens i ON i.id = l.item_id
     WHERE l.empresa_id = ? AND l.validade IS NOT NULL AND sl.quantidade > 0
       AND l.validade <= date('now', '+' || ? || ' day')
     ORDER BY l.validade
  `).bind(usuario.empresa_id, dias).all();
  return json(semValores({ linhas: r.results }, usuario));
});

/* Parados: o que não se move há 90 dias. Dinheiro dormindo na prateleira. */
R.get(/^\/api\/relatorios\/parados$/, async ({ env, usuario }) => {
  const r = await env.DB.prepare(`
    SELECT i.id, i.codigo, i.nome, i.unidade, i.custo_ultimo, i.localizacao,
           COALESCE(s.quantidade,0) AS saldo,
           (COALESCE(s.quantidade,0) * COALESCE(i.custo_ultimo,0)) AS valor_total,
           (SELECT MAX(m.criado_em) FROM movimentos m WHERE m.item_id = i.id) AS ultimo_movimento
      FROM itens i LEFT JOIN saldo_item s ON s.item_id = i.id
     WHERE i.empresa_id = ? AND i.ativo = 1 AND COALESCE(s.quantidade,0) > 0
       AND NOT EXISTS (SELECT 1 FROM movimentos m WHERE m.item_id = i.id
                        AND m.criado_em >= date('now','-90 day'))
     ORDER BY valor_total DESC LIMIT 100
  `).bind(usuario.empresa_id).all();
  return json(semValores({ linhas: r.results }, usuario));
});

/* ============================================================
   EXPORTAR — não brigar com o Excel

   Quem tem medo de sistema novo se acalma sabendo que pode levar tudo
   embora numa planilha. Recusar exportação não protege ninguém: só faz o
   sistema parecer uma jaula.
   ============================================================ */

function paraCsv(linhas) {
  if (!linhas.length) return "";
  const colunas = Object.keys(linhas[0]);
  const escapar = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  /* Ponto e vírgula e BOM: é o que o Excel em português abre sem perguntar
     nada. Vírgula abre tudo numa coluna só e a culpa cai no sistema.
     O BOM entra como \uFEFF escrito por extenso — o caractere digitado
     direto é invisível no editor e some no primeiro copiar e colar. */
  return "\uFEFF" + [
    colunas.join(";"),
    ...linhas.map((l) => colunas.map((c) => escapar(l[c])).join(";")),
  ].join("\r\n");
}

R.get(/^\/api\/exportar\/([a-z]+)$/, async ({ env, usuario, params, url }) => {
  const emp = usuario.empresa_id;
  let linhas = [], nome = params[0];

  if (nome === "estoque") {
    const r = await env.DB.prepare(`
      SELECT i.codigo AS "Código", i.nome AS "Item", c.nome AS "Categoria",
             i.unidade AS "Unidade", COALESCE(s.quantidade,0) AS "Saldo",
             i.estoque_minimo AS "Mínimo", i.localizacao AS "Local",
             i.custo_ultimo AS "Custo unitário",
             (COALESCE(s.quantidade,0) * COALESCE(i.custo_ultimo,0)) AS "Valor total"
        FROM itens i LEFT JOIN saldo_item s ON s.item_id = i.id
        LEFT JOIN categorias c ON c.id = i.categoria_id
       WHERE i.empresa_id = ? AND i.ativo = 1 ORDER BY i.nome
    `).bind(emp).all();
    linhas = r.results;
  } else if (nome === "movimentos") {
    const de = url.searchParams.get("de") || "1900-01-01";
    const r = await env.DB.prepare(`
      SELECT m.criado_em AS "Quando", m.tipo AS "Tipo", i.codigo AS "Código",
             i.nome AS "Item", m.quantidade AS "Quantidade", i.unidade AS "Unidade",
             d.nome AS "Depósito", fr.nome AS "Frente", m.pessoa AS "Pessoa",
             u.nome AS "Registrou", m.documento AS "Documento", m.motivo AS "Motivo",
             m.custo_unitario AS "Custo unitário"
        FROM movimentos m
        JOIN itens i ON i.id = m.item_id
        JOIN usuarios u ON u.id = m.usuario_id
        JOIN depositos d ON d.id = m.deposito_id
        LEFT JOIN frentes fr ON fr.id = m.frente_id
       WHERE m.empresa_id = ? AND m.criado_em >= ?
       ORDER BY m.criado_em DESC LIMIT 5000
    `).bind(emp, de).all();
    linhas = r.results;
  } else if (nome === "ferramentas") {
    const r = await env.DB.prepare(`
      SELECT a.patrimonio AS "Patrimônio", i.nome AS "Ferramenta", a.serie AS "Série",
             a.situacao AS "Situação", a.posse_pessoa AS "Com quem",
             a.posse_desde AS "Desde", d.nome AS "Depósito"
        FROM ativos a JOIN itens i ON i.id = a.item_id
        LEFT JOIN depositos d ON d.id = a.deposito_id
       WHERE a.empresa_id = ? AND a.situacao != 'baixado' ORDER BY i.nome, a.patrimonio
    `).bind(emp).all();
    linhas = r.results;
  } else {
    return erro("não sei exportar isso", 404);
  }

  if (!podeVerDinheiro(usuario)) {
    linhas = linhas.map((l) => {
      const c = { ...l };
      delete c["Custo unitário"]; delete c["Valor total"];
      return c;
    });
  }

  return new Response(paraCsv(linhas), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${nome}-${agora().slice(0, 10)}.csv"`,
    },
  });
});

/* ============================================================
   ETIQUETAS — folha A4 pronta para imprimir

   Papel comum e tesoura resolvem no primeiro dia. Impressora térmica é
   melhor, mas exigir uma para começar é o tipo de barreira que faz o
   sistema não sair do papel.
   ============================================================ */

R.get(/^\/api\/etiquetas$/, async ({ env, usuario, url }) => {
  const ids = (url.searchParams.get("itens") || "").split(",").filter(Boolean);
  const ferramentas = (url.searchParams.get("ferramentas") || "").split(",").filter(Boolean);
  const base = url.origin;
  const cartoes = [];

  if (ids.length) {
    const r = await env.DB.prepare(`
      SELECT id, codigo, nome, unidade, localizacao FROM itens
       WHERE empresa_id = ? AND id IN (${ids.map(() => "?").join(",")})
    `).bind(usuario.empresa_id, ...ids).all();
    for (const i of r.results) {
      cartoes.push({
        qr: `${base}/e/${encodeURIComponent(i.codigo)}`,
        nome: i.nome, codigo: i.codigo,
        rodape: [i.localizacao, i.unidade].filter(Boolean).join(" · "),
      });
    }
  }

  if (ferramentas.length) {
    const r = await env.DB.prepare(`
      SELECT a.patrimonio, a.serie, i.nome FROM ativos a JOIN itens i ON i.id = a.item_id
       WHERE a.empresa_id = ? AND a.id IN (${ferramentas.map(() => "?").join(",")})
    `).bind(usuario.empresa_id, ...ferramentas).all();
    for (const a of r.results) {
      cartoes.push({
        qr: `${base}/e/${encodeURIComponent(a.patrimonio)}`,
        nome: a.nome, codigo: a.patrimonio,
        rodape: a.serie ? `Série ${a.serie}` : "Patrimônio",
      });
    }
  }

  if (!cartoes.length) return erro("nenhum item informado");

  const escapar = (s) => String(s).replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Etiquetas — ${escapar(usuario.empresa_nome)}</title>
<style>
  @page { size: A4; margin: 0 }
  body { margin: 0; font: 12px ui-sans-serif, system-ui, sans-serif; background: #fff; color: #000 }
  .folha { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm; padding: 8mm }
  .et { border: 1px dashed #ccc; border-radius: 3mm; padding: 3mm;
        display: flex; gap: 3mm; align-items: center; break-inside: avoid; min-height: 26mm }
  .et svg { width: 20mm; height: 20mm; flex: none }
  .c { min-width: 0; flex: 1 }
  .n { font-weight: 700; font-size: 8.5pt; line-height: 1.2;
       display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden }
  .k { font-family: ui-monospace, Consolas, monospace; font-size: 8pt; margin-top: 1mm }
  .r { font-size: 7pt; color: #555; margin-top: .5mm }
  .barra { padding: 8mm 8mm 0; display: flex; gap: 8px; align-items: center }
  @media print { .barra { display: none } }
</style></head><body>
<div class="barra">
  <strong>${escapar(usuario.empresa_nome)}</strong> — ${cartoes.length} etiqueta(s)
  <button onclick="print()">Imprimir</button>
</div>
<div class="folha">
${cartoes.map((c) => `  <div class="et">
    ${gerarSvg(c.qr, 76, 2)}
    <div class="c">
      <div class="n">${escapar(c.nome)}</div>
      <div class="k">${escapar(c.codigo)}</div>
      <div class="r">${escapar(c.rodape || "")}</div>
    </div>
  </div>`).join("\n")}
</div></body></html>`;

  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
});

/* ============================================================
   CADASTRO E FOTO
   ============================================================ */

R.get(/^\/api\/cadastro$/, async ({ env, usuario }) => {
  const emp = usuario.empresa_id;
  const [obras, depositos, frentes, categorias, fornecedores, usuarios] = await env.DB.batch([
    env.DB.prepare("SELECT id, codigo, nome, endereco, responsavel FROM obras WHERE empresa_id = ? AND ativo = 1 ORDER BY nome").bind(emp),
    env.DB.prepare("SELECT id, obra_id, nome FROM depositos WHERE empresa_id = ? AND ativo = 1 ORDER BY obra_id IS NULL DESC, nome").bind(emp),
    env.DB.prepare("SELECT id, obra_id, codigo, nome FROM frentes WHERE empresa_id = ? AND ativo = 1 ORDER BY nome").bind(emp),
    env.DB.prepare("SELECT id, nome, icone FROM categorias WHERE empresa_id = ? AND ativo = 1 ORDER BY ordem, nome").bind(emp),
    env.DB.prepare("SELECT id, nome, contato, telefone FROM fornecedores WHERE empresa_id = ? AND ativo = 1 ORDER BY nome").bind(emp),
    env.DB.prepare("SELECT id, nome, papel, login FROM usuarios WHERE empresa_id = ? AND ativo = 1 ORDER BY nome").bind(emp),
  ]);
  return json({
    obras: obras.results, depositos: depositos.results, frentes: frentes.results,
    categorias: categorias.results, fornecedores: fornecedores.results,
    usuarios: usuario.papel === "encarregado" ? [] : usuarios.results,
  });
});

const TABELAS_CADASTRO = {
  obras:        ["codigo", "nome", "endereco", "responsavel"],
  depositos:    ["obra_id", "nome"],
  frentes:      ["obra_id", "codigo", "nome"],
  categorias:   ["nome", "icone", "ordem"],
  fornecedores: ["nome", "documento", "contato", "telefone"],
};

R.post(/^\/api\/cadastro\/([a-z]+)$/, async ({ env, usuario, params, corpo }) => {
  const tabela = params[0];
  const campos = TABELAS_CADASTRO[tabela];
  if (!campos) return erro("não sei cadastrar isso", 404);
  if (!corpo.nome) return erro("o nome é obrigatório");

  const usados = campos.filter((c) => c in corpo);
  const r = await env.DB.prepare(`
    INSERT INTO ${tabela}(empresa_id${usados.length ? ", " + usados.join(", ") : ""})
    VALUES(?${usados.map(() => ",?").join("")})
  `).bind(usuario.empresa_id, ...usados.map((c) => corpo[c])).run();

  await registrar(env, usuario, `${tabela}.criado`, tabela, r.meta.last_row_id, corpo).run();
  return json({ id: r.meta.last_row_id }, 201);
}, { papeis: CADASTRA });

/* A foto chega já encolhida pelo navegador (~300 KB em vez de ~3 MB). É o
   que segura o R2 no plano grátis — e o upload no 4G da obra. */
R.post(/^\/api\/fotos$/, async ({ env, req, usuario, url }) => {
  /* O R2 é OPCIONAL. Sem ele o sistema inteiro funciona, só a foto do item
     não — e é melhor publicar sem foto do que não publicar. Sem esta
     conferência o worker estoura com "cannot read property put of
     undefined", que não diz nada a quem está usando. */
  if (!env.FOTOS) return erro("o armazenamento de fotos não está ligado nesta instalação", 501);
  const tipo = req.headers.get("content-type") || "";
  if (!tipo.startsWith("image/")) return erro("envie uma imagem");
  const dados = await req.arrayBuffer();
  if (dados.byteLength > 2_000_000) return erro("imagem grande demais — encolha antes de enviar", 413);

  const chave = `${usuario.empresa_id}/${crypto.randomUUID()}.jpg`;
  await env.FOTOS.put(chave, dados, { httpMetadata: { contentType: "image/jpeg" } });

  const itemId = url.searchParams.get("item") || null;
  await env.DB.prepare(
    "INSERT INTO fotos(empresa_id, chave, item_id, usuario_id) VALUES(?,?,?,?)"
  ).bind(usuario.empresa_id, chave, itemId, usuario.id).run();
  if (itemId) {
    await env.DB.prepare("UPDATE itens SET foto_chave = ? WHERE id = ? AND empresa_id = ?")
      .bind(chave, itemId, usuario.empresa_id).run();
  }
  return json({ chave }, 201);
}, { papeis: MOVIMENTA });

R.get(/^\/api\/foto\/(.+)$/, async ({ env, usuario, params }) => {
  const chave = decodeURIComponent(params[0]);
  // A chave começa com o id da empresa: sem esta conferência, trocar a URL
  // na barra do navegador mostraria foto de outro cliente.
  if (!chave.startsWith(usuario.empresa_id + "/")) return erro("não encontrada", 404);
  if (!env.FOTOS) return erro("não encontrada", 404);
  const obj = await env.FOTOS.get(chave);
  if (!obj) return erro("não encontrada", 404);
  return new Response(obj.body, {
    headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" },
  });
});

/* PIN de quem recebe material. Cada um muda o seu; admin muda o de todos. */
R.post(/^\/api\/usuarios\/(\d+)\/pin$/, async ({ env, usuario, params, corpo }) => {
  const alvo = Number(params[0]);
  if (alvo !== usuario.id && !SO_ADMIN.has(usuario.papel)) {
    return erro("só o dono do PIN ou um administrador pode trocá-lo", 403);
  }
  const pin = String(corpo.pin || "").trim();
  if (!/^\d{4}$/.test(pin)) return erro("o PIN tem 4 dígitos");
  const existe = await env.DB.prepare(
    "SELECT id FROM usuarios WHERE empresa_id = ? AND pin = ? AND id <> ?"
  ).bind(usuario.empresa_id, pin, alvo).first();
  if (existe) return erro("este PIN já é de outra pessoa — escolha outro", 409);

  await env.DB.prepare("UPDATE usuarios SET pin = ? WHERE id = ? AND empresa_id = ?")
    .bind(pin, alvo, usuario.empresa_id).run();
  return json({ ok: true });
});
