/* ============================================================
   Confere que todo <script> do ui.html realmente parseia.

   Existe por causa de um parêntese a menos no fechamento de uma tabela.
   O navegador descarta o bloco inteiro com um "missing ) after argument
   list" no console e segue tocando os outros — então a página ABRE, o
   login FUNCIONA, e só algumas telas simplesmente não existem. Nenhum
   teste de API pega isso, e numa apresentação parece que o sistema
   "travou" sem motivo.

   Roda antes de qualquer coisa: `npm run verificar`.
   ============================================================ */

import { readFileSync } from "node:fs";

const arquivo = new URL("../ui.html", import.meta.url);
const html = readFileSync(arquivo, "utf8");
const blocos = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];

if (!blocos.length) {
  console.error("nenhum bloco <script> encontrado em ui.html — isso está errado");
  process.exit(1);
}

let falhas = 0;

for (const [k, bloco] of blocos.entries()) {
  const linhaInicial = html.slice(0, bloco.index).split("\n").length;
  try {
    // new Function parseia sem executar. O corpo roda em modo não-estrito
    // por padrão, mas os blocos declaram "use strict" na primeira linha.
    new Function(bloco[1]);
    console.log(`  ok   bloco ${k + 1} (ui.html linha ${linhaInicial}) parseia`);
  } catch (e) {
    falhas++;
    console.log(`  FALHA bloco ${k + 1} (ui.html linha ${linhaInicial}): ${e.message}`);
  }
}

// A montagem por marcador (<!--@PARTE2-->) já mordeu uma vez: um marcador
// que sobra vira comentário HTML mudo e a metade do app some sem aviso.
const marcadores = html.match(/<!--@PARTE\d+-->/g);
if (marcadores) {
  falhas++;
  console.log(`  FALHA sobrou marcador de montagem no ui.html: ${marcadores.join(", ")}`);
} else {
  console.log("  ok   nenhum marcador de montagem sobrando");
}

// A página não pode buscar nada na rede: o galpão tem sinal ruim e às
// vezes nenhum. `xmlns` é declaração de namespace, não busca.
const externo = html.replace(/xmlns="[^"]*"/g, "")
  .match(/(?:src|href)="(https?:)?\/\/[^"]*"/g);
if (externo) {
  falhas++;
  console.log(`  FALHA ui.html busca coisa na rede: ${externo.join(", ")}`);
} else {
  console.log("  ok   ui.html não busca nada na rede");
}

// O CSS é colado por replace no worker. Sem o marcador, a página sai sem
// estilo nenhum — e ninguém percebe até abrir no navegador.
if (!html.includes("/*ESTILO*/")) {
  falhas++;
  console.log("  FALHA o marcador /*ESTILO*/ sumiu do ui.html — a página sairia sem CSS");
} else {
  console.log("  ok   o marcador /*ESTILO*/ está no lugar");
}

console.log(falhas === 0 ? "\ntudo certo" : `\n${falhas} falha(s)`);
process.exit(falhas ? 1 : 0);
