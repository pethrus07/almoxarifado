/* ============================================================
   Dirige a tela de verdade e tira print de cada passo.

   Existe porque "está bonito" e "o botão cabe no dedo" não se conferem
   lendo CSS. Roda nos dois tamanhos que importam: o celular do almoxarife
   e o computador do engenheiro.

   Uso:  npx wrangler dev --port 8788   (noutro terminal)
         node test/visual.mjs
   Os prints saem em test/telas/.
   ============================================================ */

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.ALMOX_URL || "http://127.0.0.1:8788";
const SAIDA = new URL("./telas/", import.meta.url).pathname.replace(/^\//, "");

const CELULAR = { width: 390, height: 844 };       // iPhone 14
const COMPUTADOR = { width: 1440, height: 900 };

let falhas = 0, passos = 0;
const problemas = [];

function conferir(ok, descricao, detalhe) {
  passos++;
  if (ok) console.log(`  ok   ${descricao}`);
  else {
    falhas++; problemas.push(descricao);
    console.log(`  FALHA ${descricao}${detalhe ? `\n         ${detalhe}` : ""}`);
  }
}

mkdirSync(SAIDA, { recursive: true });

const navegador = await chromium.launch();

async function entrar(pagina, login) {
  await pagina.goto(BASE, { waitUntil: "networkidle" });
  await pagina.fill("#cx-empresa", "demo");
  await pagina.fill("#cx-login", login);
  await pagina.fill("#cx-senha", "demo");
  await pagina.click("#bt-entrar");
  await pagina.waitForSelector("#app:not([hidden])", { timeout: 10000 });
  /* O tour cobre a tela com um overlay que captura clique. Ele é agendado
     para 700ms depois do login, então dispensar antes disso não adianta:
     espera-se o disparo e só então se limpa a sobra. */
  await pagina.waitForTimeout(1100);
  await pagina.evaluate(() => {
    if (window.terminarTour) window.terminarTour();
    document.querySelectorAll(".tour-fundo,.tour-alvo,.tour-balao").forEach((e) => e.remove());
  });
  // O primeiro passo do tour LEVA para a tela de busca. Dispensá-lo deixa
  // a pessoa lá, então volta-se ao início para medir a tela certa.
  await pagina.evaluate(() => { if (window.irPara) window.irPara("inicio") });
  await pagina.waitForTimeout(500);
}

const print = (pagina, nome) =>
  pagina.screenshot({ path: `${SAIDA}${nome}.png`, fullPage: false });

/* A aba existe DUAS vezes no DOM: na lateral e na barra de baixo. Uma
   delas está sempre escondida por media query, e `[data-tela=x]` cru casa
   com as duas — o Playwright escolhe a primeira e fica esperando para
   sempre um elemento invisível. Clica-se na que estiver visível. */
async function irAba(pagina, tela) {
  const visivel = pagina.locator(`[data-tela="${tela}"]:visible`).first();
  await visivel.click({ timeout: 10000 });
  await pagina.waitForTimeout(150);
}

/* ============================================================ */

console.log(`Dirigindo ${BASE}\n${"=".repeat(52)}`);

/* ---------- CELULAR · almoxarife ---------- */
console.log("\nCelular · almoxarife");
{
  const ctx = await navegador.newContext({ viewport: CELULAR, deviceScaleFactor: 2,
    locale: "pt-BR", isMobile: true, hasTouch: true });
  const p = await ctx.newPage();

  const erros = [];
  p.on("pageerror", (e) => erros.push(e.message));
  p.on("console", (m) => { if (m.type() === "error") erros.push(m.text()) });

  await p.goto(BASE, { waitUntil: "networkidle" });
  await print(p, "01-celular-login");
  conferir(await p.isVisible("#atalhos-demo"),
    "os atalhos da demonstração aparecem na empresa `demo`");

  await entrar(p, "almoxarife");
  await print(p, "02-celular-inicio");

  conferir(await p.isVisible(".barra-baixo"), "a barra de navegação fica embaixo no celular");
  const abas = await p.locator(".barra-baixo button").count();
  conferir(abas <= 5, `a barra de baixo tem no máximo 5 abas (tem ${abas})`);

  /* O alvo de dedo é REQUISITO, não estilo: quem usa está de pé, no
     galpão, às vezes de luva. Mede-se a caixa de verdade, porque o token
     pode estar certo no CSS e o botão encolher por causa do flex. */
  const alvos = await p.evaluate(() => {
    const medir = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { largura: Math.round(r.width), altura: Math.round(r.height) };
    };
    return {
      baixa: medir("#ac-baixa"),
      escanear: medir("#ac-escanear"),
      aba: medir(".barra-baixo button"),
    };
  });
  conferir(alvos.baixa && alvos.baixa.altura >= 56,
    `"Dar baixa" tem 56px de altura (tem ${alvos.baixa?.altura})`);
  conferir(alvos.escanear && alvos.escanear.altura >= 56,
    `"Escanear" tem 56px de altura (tem ${alvos.escanear?.altura})`);
  conferir(alvos.aba && alvos.aba.largura >= 60,
    `cada aba de baixo tem 60px de largura (tem ${alvos.aba?.largura})`);

  // Nada de rolagem lateral: a tela não pode "vazar" para o lado.
  const vazou = await p.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  conferir(!vazou, "a página não rola para o lado no celular");

  /* Busca ao vivo com sinônimo — o argumento de venda mais direto. */
  await irAba(p, "busca");
  await p.waitForSelector("#cx-busca");
  await p.fill("#cx-busca", "ferro");
  await p.waitForTimeout(600);
  await print(p, "03-celular-busca-sinonimo");
  const achouVergalhao = await p.locator(".linha-nome", { hasText: /Vergalh/i }).count();
  conferir(achouVergalhao > 0, "buscar 'ferro' no celular traz vergalhão");

  await p.fill("#cx-busca", "vergalhao");
  await p.waitForTimeout(600);
  const semAcento = await p.locator(".linha-nome", { hasText: /Vergalh/i }).count();
  conferir(semAcento > 0, "buscar sem acento funciona");

  // Ficha do item, com kardex.
  await p.locator("button.linha").first().click();
  await p.waitForSelector("dialog[open]");
  await p.waitForTimeout(400);
  await print(p, "04-celular-item");
  conferir(await p.locator("dialog .kardex-linha").count() > 0,
    "a ficha do item mostra a movimentação");

  await p.keyboard.press("Escape");
  await p.waitForTimeout(300);

  // Fila de requisições.
  await irAba(p, "requisicoes");
  await p.waitForTimeout(700);
  await print(p, "05-celular-requisicoes");
  conferir(await p.locator(".selo", { hasText: "urgente" }).count() > 0,
    "a requisição urgente aparece marcada na fila");

  // Ferramentas: quem está com o quê.
  await irAba(p, "ferramentas");
  await p.waitForTimeout(700);
  await print(p, "06-celular-ferramentas");
  const comQuem = await p.locator(".linha-meta", { hasText: /com / }).count();
  conferir(comQuem > 0, "a lista de ferramentas diz com quem cada uma está");

  // Teclado numérico grande — o substituto do prompt() do navegador.
  await irAba(p, "inicio");
  await p.waitForTimeout(500);
  await p.click("#ac-baixa");
  await p.waitForSelector("dialog[open]");
  await p.waitForTimeout(400);
  await p.locator("dialog button.linha").first().click();
  await p.waitForTimeout(500);
  await p.locator("dialog button", { hasText: "toque para digitar" }).click();
  await p.waitForTimeout(400);
  await print(p, "07-celular-teclado");
  const tecla = await p.evaluate(() => {
    const b = document.querySelector(".teclado button");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return Math.round(r.height);
  });
  conferir(tecla >= 56, `as teclas do teclado numérico têm 56px (têm ${tecla})`);

  await p.keyboard.press("Escape");
  await p.waitForTimeout(200);

  conferir(erros.length === 0, "nenhum erro de javascript no celular",
    erros.slice(0, 3).join(" | "));
  await ctx.close();
}

/* ---------- COMPUTADOR · engenheiro ---------- */
console.log("\nComputador · engenheiro");
{
  const ctx = await navegador.newContext({ viewport: COMPUTADOR, deviceScaleFactor: 2,
    locale: "pt-BR" });
  const p = await ctx.newPage();
  const erros = [];
  p.on("pageerror", (e) => erros.push(e.message));
  p.on("console", (m) => { if (m.type() === "error") erros.push(m.text()) });

  await entrar(p, "engenheiro");
  await print(p, "10-computador-inicio");

  conferir(await p.isVisible(".lateral"), "a navegação vira lateral no computador");
  conferir(await p.locator(".indicador-valor").count() >= 4, "o painel abre com 4 indicadores");

  const temValor = await p.locator("text=/R\\$/").count();
  conferir(temValor > 0, "o engenheiro vê valor em reais no painel");

  // Atalho de teclado: `/` foca a busca. É o detalhe que quem usa
  // computador percebe.
  await p.keyboard.press("/");
  await p.waitForTimeout(500);
  const focouBusca = await p.evaluate(() => document.activeElement?.id === "cx-busca");
  conferir(focouBusca, "a tecla / leva direto para a busca");

  await p.fill("#cx-busca", "");
  await p.waitForTimeout(500);
  await p.locator(".chip", { hasText: "Abaixo do mínimo" }).click();
  await p.waitForTimeout(700);
  await print(p, "11-computador-busca-filtro");
  conferir(await p.locator("button.linha.critico").count() > 0,
    "o filtro 'abaixo do mínimo' pinta as linhas de vermelho");

  // Relatórios — o que fecha a venda com o engenheiro e o dono.
  await irAba(p, "relatorios");
  await p.waitForTimeout(600);
  await print(p, "12-computador-relatorios");

  await p.locator(".cartao", { hasText: "O que comprar" }).click();
  await p.waitForTimeout(900);
  await print(p, "13-computador-reposicao");
  conferir(await p.locator("button.linha").count() > 0, "o relatório de compra tem linhas");

  await irAba(p, "relatorios");
  await p.waitForTimeout(500);
  await p.locator(".cartao", { hasText: "Consumo por frente" }).click();
  await p.waitForTimeout(900);
  await print(p, "14-computador-consumo");
  conferir(await p.locator(".barra-dado").count() > 0,
    "o consumo por frente sai com barra proporcional");

  await irAba(p, "relatorios");
  await p.waitForTimeout(500);
  await p.locator(".cartao", { hasText: "Curva ABC" }).click();
  await p.waitForTimeout(900);
  await print(p, "15-computador-abc");
  conferir(await p.locator("table.dados tbody tr").count() > 0, "a curva ABC sai em tabela");

  // Tema claro — o galpão às vezes é claro, e o escritório sempre é.
  await p.click("#bt-tema");
  await p.waitForTimeout(400);
  await irAba(p, "inicio");
  await p.waitForTimeout(700);
  await print(p, "16-computador-tema-claro");
  const fundoClaro = await p.evaluate(() =>
    getComputedStyle(document.body).backgroundColor);
  conferir(fundoClaro !== "rgba(0, 0, 0, 0)" && !/rgb\(1[0-9], 1[0-9]/.test(fundoClaro),
    `o tema claro pinta o fundo (${fundoClaro})`);
  await p.click("#bt-tema");
  await p.waitForTimeout(300);

  conferir(erros.length === 0, "nenhum erro de javascript no computador",
    erros.slice(0, 3).join(" | "));
  await ctx.close();
}

/* ---------- o que o almoxarife NÃO pode ver ---------- */
console.log("\nCelular · almoxarife não vê dinheiro");
{
  const ctx = await navegador.newContext({ viewport: CELULAR, locale: "pt-BR", isMobile: true });
  const p = await ctx.newPage();
  await entrar(p, "almoxarife");
  await p.waitForTimeout(600);
  const texto = await p.locator("#conteudo").innerText();
  conferir(!/R\$/.test(texto), "não aparece valor em reais na tela do almoxarife",
    texto.slice(0, 120).replace(/\n/g, " "));

  const abas = await p.locator(".barra-baixo button, .nav-item[data-tela]").allInnerTexts();
  conferir(!abas.join(" ").includes("Relatórios"), "o almoxarife não tem aba de Relatórios");
  conferir(!abas.join(" ").includes("Cadastro"), "o almoxarife não tem aba de Cadastro");
  await ctx.close();
}

/* ---------- encarregado ---------- */
console.log("\nCelular · encarregado");
{
  const ctx = await navegador.newContext({ viewport: CELULAR, locale: "pt-BR", isMobile: true });
  const p = await ctx.newPage();
  await entrar(p, "encarregado");
  await p.waitForTimeout(600);
  await print(p, "20-celular-encarregado");
  const acoes = await p.locator("#conteudo .btn").allInnerTexts();
  conferir(acoes.join(" ").includes("Pedir material"),
    "o encarregado abre direto no botão de pedir material", acoes.join(" | "));
  await ctx.close();
}

/* ---------- etiquetas ---------- */
console.log("\nFolha de etiquetas");
{
  const ctx = await navegador.newContext({ viewport: COMPUTADOR, locale: "pt-BR" });
  const p = await ctx.newPage();
  await entrar(p, "engenheiro");

  const token = await p.evaluate(() => localStorage.getItem("almox.token"));
  const resposta = await p.request.get(`${BASE}/api/etiquetas?itens=1,2,3,4,5,6`, {
    headers: { authorization: "Bearer " + token },
  });
  await p.setContent(await resposta.text());
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${SAIDA}30-etiquetas.png`, fullPage: true });
  conferir(await p.locator(".et svg").count() === 6, "a folha sai com um QR por item");
  await ctx.close();
}

await navegador.close();

console.log(`\n${"=".repeat(52)}`);
console.log(`${passos - falhas} passaram · ${falhas} falharam`);
console.log(`Prints em ${SAIDA}`);
if (falhas) {
  console.log("\nFalhas:");
  problemas.forEach((f) => console.log("  · " + f));
  process.exit(1);
}
