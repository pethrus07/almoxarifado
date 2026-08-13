/* ============================================================
   Teste ponta a ponta pela API.

   Roda contra a empresa `demo` — NUNCA contra empresa de cliente. Sujou?
   `npm run recarregar` devolve o banco ao estado gerado.

   Uso:  npx wrangler dev --port 8788   (noutro terminal)
         node test/api.mjs
   ============================================================ */

const BASE = process.env.ALMOX_URL || "http://127.0.0.1:8788";
const EMPRESA = "demo";

let passou = 0, falhou = 0;
const falhas = [];

function conferir(condicao, descricao, detalhe) {
  if (condicao) { passou++; console.log(`  ok   ${descricao}`) }
  else {
    falhou++; falhas.push(descricao);
    console.log(`  FALHA ${descricao}${detalhe ? `\n         ${detalhe}` : ""}`);
  }
}
const secao = (t) => console.log(`\n${t}`);

async function chamar(rota, { token, metodo, corpo } = {}) {
  const r = await fetch(BASE + "/api" + rota, {
    method: metodo || (corpo ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const tipo = r.headers.get("content-type") || "";
  const dados = tipo.includes("json") ? await r.json() : await r.text();
  return { status: r.status, dados };
}

const entrar = async (login) => {
  const r = await chamar("/login", { corpo: { empresa: EMPRESA, login, senha: "demo" } });
  if (r.status !== 200) throw new Error(`login ${login} falhou: ${JSON.stringify(r.dados)}`);
  return r.dados;
};

async function rodar() {
  console.log(`Testando ${BASE}\n${"=".repeat(52)}`);

  /* ---------- login e papéis ---------- */
  secao("Login e papéis");

  const ruim = await chamar("/login", { corpo: { empresa: EMPRESA, login: "diretoria", senha: "errada" } });
  conferir(ruim.status === 401, "senha errada é recusada com 401");
  conferir(!/não existe|not found/i.test(JSON.stringify(ruim.dados)),
    "a recusa não revela se o usuário existe");

  const diretoria = await entrar("diretoria");
  const engenheiro = await entrar("engenheiro");
  const almoxarife = await entrar("almoxarife");
  const encarregado = await entrar("encarregado");

  conferir(diretoria.eu.ve_dinheiro === true, "diretoria vê valores");
  conferir(engenheiro.eu.ve_dinheiro === true, "engenheiro vê valores");
  conferir(almoxarife.eu.ve_dinheiro === false, "almoxarife NÃO vê valores");
  conferir(encarregado.eu.ve_dinheiro === false, "encarregado NÃO vê valores");

  const semToken = await chamar("/inicio");
  conferir(semToken.status === 401, "rota protegida sem token responde 401");

  /* ---------- o custo não pode viajar no JSON ----------
     Esconder na tela deixa o dado saindo do servidor, o que é o mesmo que
     não esconder: basta abrir o painel do navegador. */
  secao("Quem vê dinheiro é decidido no servidor");

  const buscaAlmox = await chamar("/busca?q=cimento", { token: almoxarife.token });
  const textoAlmox = JSON.stringify(buscaAlmox.dados);
  conferir(!textoAlmox.includes("custo_ultimo"),
    "resposta ao almoxarife não traz custo_ultimo", textoAlmox.slice(0, 160));

  const buscaDiretoria = await chamar("/busca?q=cimento", { token: diretoria.token });
  conferir(JSON.stringify(buscaDiretoria.dados).includes("custo_ultimo"),
    "resposta à diretoria traz custo_ultimo");

  const inicioAlmox = await chamar("/inicio", { token: almoxarife.token });
  conferir(!JSON.stringify(inicioAlmox.dados).includes("valor_imobilizado"),
    "painel do almoxarife não traz valor imobilizado");

  const cadastroNegado = await chamar("/itens", {
    token: almoxarife.token, corpo: { codigo: "XX-999", nome: "Teste" },
  });
  conferir(cadastroNegado.status === 403, "almoxarife não pode cadastrar item");

  /* ---------- busca ---------- */
  secao("Busca");

  const porSinonimo = await chamar("/busca?q=ferro", { token: almoxarife.token });
  conferir(porSinonimo.dados.itens.some((i) => /vergalh/i.test(i.nome)),
    "sinônimo: 'ferro' acha vergalhão",
    porSinonimo.dados.itens.map((i) => i.nome).join(", ").slice(0, 120));

  const semAcento = await chamar("/busca?q=vergalhao", { token: almoxarife.token });
  conferir(semAcento.dados.itens.length > 0, "sem acento: 'vergalhao' acha 'Vergalhão'");

  const prefixo = await chamar("/busca?q=eletrod", { token: almoxarife.token });
  conferir(prefixo.dados.itens.length > 0, "prefixo: 'eletrod' já traz resultado");

  const porLocal = await chamar("/busca?q=prateleira", { token: almoxarife.token });
  conferir(porLocal.dados.itens.length > 0, "acha pela localização na prateleira");

  const porCodigo = await chamar("/busca?q=CIM-001", { token: almoxarife.token });
  conferir(porCodigo.dados.exato === true && porCodigo.dados.itens.length === 1,
    "código exato devolve UM item marcado como exato");

  const aspas = await chamar('/busca?q=cimento" OR 1=1 --', { token: almoxarife.token });
  conferir(aspas.status === 200, "aspas no termo não derrubam a consulta FTS5");

  const criticos = await chamar("/busca?filtros=critico", { token: engenheiro.token });
  conferir(criticos.dados.itens.length > 0, "filtro 'abaixo do mínimo' traz itens");
  conferir(criticos.dados.itens.every((i) => i.saldo <= i.estoque_minimo),
    "todo item do filtro está mesmo abaixo do mínimo");

  const facetas = await chamar("/busca/facetas", { token: engenheiro.token });
  conferir(facetas.dados.contagem.critico > 0, "faceta 'crítico' tem contagem");
  conferir(facetas.dados.categorias.length > 0, "facetas trazem as categorias");

  /* ---------- movimento e a trava de saldo ---------- */
  secao("Movimento — o livro");

  const alvo = (await chamar("/busca?q=eletroduto", { token: almoxarife.token }))
    .dados.itens.find((i) => i.tipo === "consumo");
  const antes = (await chamar(`/itens/${alvo.id}`, { token: almoxarife.token })).dados;
  const saldoAntes = antes.saldo;
  const deposito = antes.saldos.find((s) => s.quantidade > 10) || antes.saldos[0];

  const entrada = await chamar("/movimentos", { token: almoxarife.token, corpo: {
    item_id: alvo.id, deposito_id: deposito.deposito_id, tipo: "entrada", quantidade: 12,
  }});
  conferir(entrada.status === 201, "entrada é aceita", JSON.stringify(entrada.dados));
  conferir(Math.abs(entrada.dados.saldo - (saldoAntes + 12)) < 0.01,
    `saldo somou 12 (${saldoAntes} → ${entrada.dados.saldo})`);

  const saida = await chamar("/movimentos", { token: almoxarife.token, corpo: {
    item_id: alvo.id, deposito_id: deposito.deposito_id, tipo: "saida", quantidade: 5,
    pessoa: "Teste automático",
  }});
  conferir(Math.abs(saida.dados.saldo - (saldoAntes + 7)) < 0.01,
    `saldo subtraiu 5 (${entrada.dados.saldo} → ${saida.dados.saldo})`);

  // A trava do estoque negativo é a regra mais importante do sistema.
  const demais = await chamar("/movimentos", { token: almoxarife.token, corpo: {
    item_id: alvo.id, deposito_id: deposito.deposito_id, tipo: "saida", quantidade: 9999999,
  }});
  conferir(demais.status === 409, "saída maior que o saldo é recusada com 409");
  conferir(/insuficiente/i.test(demais.dados.erro || ""),
    "a recusa diz que o saldo é insuficiente", demais.dados.erro);

  const depoisDaRecusa = (await chamar(`/itens/${alvo.id}`, { token: almoxarife.token })).dados;
  conferir(Math.abs(depoisDaRecusa.saldo - saida.dados.saldo) < 0.01,
    "a saída recusada NÃO gravou nada no livro");

  const semMotivo = await chamar("/movimentos", { token: almoxarife.token, corpo: {
    item_id: alvo.id, deposito_id: deposito.deposito_id, tipo: "ajuste", quantidade: -1,
  }});
  conferir(semMotivo.status === 400, "ajuste sem motivo é recusado");

  const comMotivo = await chamar("/movimentos", { token: almoxarife.token, corpo: {
    item_id: alvo.id, deposito_id: deposito.deposito_id, tipo: "ajuste", quantidade: -2,
    motivo: "Teste automático",
  }});
  conferir(comMotivo.status === 201, "ajuste com motivo é aceito");

  const ficha = (await chamar(`/itens/${alvo.id}`, { token: almoxarife.token })).dados;
  conferir(ficha.kardex.length >= 3, "os três movimentos aparecem no kardex");
  conferir(ficha.kardex[0].saldo_apos !== undefined,
    "o kardex mostra como o saldo FICOU em cada linha");
  conferir(Math.abs(ficha.kardex[0].saldo_apos - ficha.saldo) < 0.01,
    "o saldo_apos da linha mais recente bate com o saldo atual");

  // Conversão de embalagem: quem recebe 3 sacos digita 3, não 150.
  const cimento = (await chamar("/busca?q=CIM-001", { token: almoxarife.token })).dados.itens[0];
  const cimentoAntes = (await chamar(`/itens/${cimento.id}`, { token: almoxarife.token })).dados;
  const emSacos = await chamar("/movimentos", { token: almoxarife.token, corpo: {
    item_id: cimento.id, deposito_id: cimentoAntes.saldos[0].deposito_id,
    tipo: "entrada", quantidade: 3, em_unidade_compra: true,
  }});
  conferir(Math.abs(emSacos.dados.saldo - (cimentoAntes.saldo + 150)) < 0.01,
    `3 sacos viraram 150 kg no livro (${cimentoAntes.saldo} → ${emSacos.dados.saldo})`);

  /* ---------- transferência ---------- */
  secao("Transferência entre depósitos");

  const t = (await chamar(`/itens/${alvo.id}`, { token: almoxarife.token })).dados;
  const origem = t.saldos.find((s) => s.quantidade > 5);
  const destino = t.saldos.find((s) => s.deposito_id !== origem.deposito_id);
  const totalAntes = t.saldo;

  const transf = await chamar("/transferencias", { token: almoxarife.token, corpo: {
    item_id: alvo.id, origem_id: origem.deposito_id, destino_id: destino.deposito_id,
    quantidade: 4,
  }});
  conferir(transf.status === 201, "transferência é aceita", JSON.stringify(transf.dados));

  const t2 = (await chamar(`/itens/${alvo.id}`, { token: almoxarife.token })).dados;
  conferir(Math.abs(t2.saldo - totalAntes) < 0.01,
    "o total da empresa NÃO muda numa transferência (só troca de lugar)");
  const novoOrigem = t2.saldos.find((s) => s.deposito_id === origem.deposito_id);
  conferir(Math.abs(novoOrigem.quantidade - (origem.quantidade - 4)) < 0.01,
    "a origem perdeu 4");

  const transfDemais = await chamar("/transferencias", { token: almoxarife.token, corpo: {
    item_id: alvo.id, origem_id: origem.deposito_id, destino_id: destino.deposito_id,
    quantidade: 9999999,
  }});
  conferir(transfDemais.status === 409, "transferência sem saldo na origem é recusada");
  const t3 = (await chamar(`/itens/${alvo.id}`, { token: almoxarife.token })).dados;
  conferir(Math.abs(t3.saldo - totalAntes) < 0.01,
    "a transferência recusada não deixou meia perna gravada");

  /* ---------- requisição ---------- */
  secao("Requisição e prova de entrega");

  const cadastro = (await chamar("/cadastro", { token: encarregado.token })).dados;
  const itemReq = (await chamar("/busca?q=parafuso", { token: encarregado.token }))
    .dados.itens.find((i) => i.tipo === "consumo" && i.saldo > 20);

  const nova = await chamar("/requisicoes", { token: encarregado.token, corpo: {
    obra_id: cadastro.obras[0].id,
    deposito_id: cadastro.depositos[0].id,
    frente_id: cadastro.frentes[0].id,
    itens: [{ item_id: itemReq.id, qtd_pedida: 10 }],
  }});
  conferir(nova.status === 201, "encarregado abre requisição", JSON.stringify(nova.dados));

  const semPin = await chamar(`/requisicoes/${nova.dados.id}/entregar`, {
    token: almoxarife.token, corpo: { itens: [{ item_id: itemReq.id, qtd_atendida: 10 }] },
  });
  conferir(semPin.status === 400, "entrega sem PIN é recusada");

  const pinErrado = await chamar(`/requisicoes/${nova.dados.id}/entregar`, {
    token: almoxarife.token,
    corpo: { pin: "9999", itens: [{ item_id: itemReq.id, qtd_atendida: 10 }] },
  });
  conferir(pinErrado.status === 403, "PIN que não confere é recusado");

  const saldoReqAntes = (await chamar(`/itens/${itemReq.id}`, { token: almoxarife.token })).dados.saldo;
  const entregue = await chamar(`/requisicoes/${nova.dados.id}/entregar`, {
    token: almoxarife.token,
    corpo: { pin: "1004", itens: [{ item_id: itemReq.id, qtd_atendida: 10 }] },
  });
  conferir(entregue.status === 200 && entregue.dados.situacao === "entregue",
    "entrega com PIN certo fecha a requisição", JSON.stringify(entregue.dados));
  conferir(entregue.dados.recebido_por === "João Paulo Medeiros",
    "a entrega registra o NOME de quem recebeu, não só o PIN");

  const saldoReqDepois = (await chamar(`/itens/${itemReq.id}`, { token: almoxarife.token })).dados.saldo;
  conferir(Math.abs(saldoReqDepois - (saldoReqAntes - 10)) < 0.01,
    "a entrega deu baixa de verdade no estoque");

  // Encarregado só enxerga o que ele mesmo pediu.
  const listaEnc = await chamar("/requisicoes", { token: encarregado.token });
  conferir(listaEnc.dados.requisicoes.every((r) => r.solicitante === "João Paulo Medeiros"),
    "encarregado só vê as próprias requisições");

  /* ---------- ferramenta ---------- */
  secao("Ferramenta — posse");

  const livres = (await chamar("/ferramentas?situacao=disponivel", { token: almoxarife.token }))
    .dados.ferramentas;
  conferir(livres.length > 0, "há ferramenta disponível na demonstração");
  const fer = livres[0];

  const emprestimo = await chamar(`/ferramentas/${fer.id}/emprestar`, {
    token: almoxarife.token, corpo: { pessoa: "Fulano do Teste" },
  });
  conferir(emprestimo.status === 200, "empréstimo é registrado");

  const duplo = await chamar(`/ferramentas/${fer.id}/emprestar`, {
    token: almoxarife.token, corpo: { pessoa: "Outro Qualquer" },
  });
  conferir(duplo.status === 409, "emprestar de novo o que já está na rua é recusado");
  conferir(/Fulano do Teste/.test(duplo.dados.erro || ""),
    "a recusa diz COM QUEM a ferramenta está", duplo.dados.erro);

  const fichaFer = (await chamar(`/ferramentas/${fer.id}`, { token: almoxarife.token })).dados;
  conferir(fichaFer.ferramenta.posse_pessoa === "Fulano do Teste",
    "a ficha mostra quem está com ela");
  conferir(fichaFer.historico.length > 0, "o empréstimo entrou no histórico");

  const devolucao = await chamar(`/ferramentas/${fer.id}/devolver`, {
    token: almoxarife.token, corpo: {},
  });
  conferir(devolucao.dados.situacao === "disponivel", "devolução libera a ferramenta");

  const semMovimento = await chamar("/movimentos", { token: almoxarife.token, corpo: {
    item_id: fer.item_id || (await chamar(`/ferramentas/${fer.id}`, { token: almoxarife.token }))
      .dados.ferramenta.item_id,
    deposito_id: cadastro.depositos[0].id, tipo: "saida", quantidade: 1,
  }});
  conferir(semMovimento.status === 400,
    "ferramenta não aceita baixa por quantidade", JSON.stringify(semMovimento.dados));

  /* ---------- inventário ---------- */
  secao("Inventário");

  // O teste tem que poder rodar duas vezes seguidas sem recarregar o
  // banco: contagem aberta que sobrou da rodada anterior é fechada antes.
  const jaAbertos = (await chamar("/inventarios", { token: almoxarife.token }))
    .dados.inventarios.filter((i) => i.situacao === "aberto");
  for (const velho of jaAbertos) {
    await chamar(`/inventarios/${velho.id}/fechar`, { token: almoxarife.token, metodo: "POST" });
  }

  const inv = await chamar("/inventarios", { token: almoxarife.token, corpo: {
    deposito_id: cadastro.depositos[1].id, nome: "Contagem do teste",
  }});
  conferir(inv.status === 201, "abre inventário", JSON.stringify(inv.dados));

  const duplicado = await chamar("/inventarios", { token: almoxarife.token, corpo: {
    deposito_id: cadastro.depositos[1].id,
  }});
  conferir(duplicado.status === 409, "não deixa abrir dois inventários no mesmo depósito");

  const detalhe = (await chamar(`/inventarios/${inv.dados.id}`, { token: almoxarife.token })).dados;
  conferir(detalhe.itens.length > 0, "o inventário congelou o saldo dos itens");
  const primeiro = detalhe.itens[0];
  const saldoCongelado = primeiro.saldo_sistema;

  await chamar(`/inventarios/${inv.dados.id}/contar`, { token: almoxarife.token, corpo: {
    item_id: primeiro.item_id, contagem: saldoCongelado + 3,
  }});
  const comContagem = (await chamar(`/inventarios/${inv.dados.id}`, { token: almoxarife.token })).dados;
  conferir(comContagem.resumo.contados === 1, "a contagem foi registrada");
  conferir(comContagem.resumo.divergentes === 1, "a divergência foi detectada");
  conferir(comContagem.resumo.acuracidade === 0, "acuracidade de 0% com 1 contado e 1 errado");

  const saldoItemAntes = (await chamar(`/itens/${primeiro.item_id}`, { token: almoxarife.token })).dados.saldo;
  const fechado = await chamar(`/inventarios/${inv.dados.id}/fechar`, {
    token: almoxarife.token, metodo: "POST",
  });
  conferir(fechado.dados.ajustes === 1, "fechar gerou 1 ajuste");
  const saldoItemDepois = (await chamar(`/itens/${primeiro.item_id}`, { token: almoxarife.token })).dados.saldo;
  conferir(Math.abs(saldoItemDepois - (saldoItemAntes + 3)) < 0.01,
    "o ajuste do inventário mexeu no saldo de verdade");

  const kardexAjuste = (await chamar(`/itens/${primeiro.item_id}`, { token: almoxarife.token }))
    .dados.kardex[0];
  conferir(kardexAjuste.tipo === "ajuste" && /Invent/i.test(kardexAjuste.motivo || ""),
    "o ajuste entrou no histórico dizendo que veio do inventário", kardexAjuste.motivo);

  /* ---------- relatórios ---------- */
  secao("Relatórios");

  for (const nome of ["reposicao", "consumo", "abc", "validade", "parados"]) {
    const r = await chamar("/relatorios/" + nome, { token: diretoria.token });
    conferir(r.status === 200 && Array.isArray(r.dados.linhas),
      `relatório '${nome}' responde com linhas`, JSON.stringify(r.dados).slice(0, 120));
  }

  const reposicao = await chamar("/relatorios/reposicao", { token: diretoria.token });
  conferir(reposicao.dados.linhas.length > 0, "há o que comprar na demonstração");
  conferir(reposicao.dados.linhas.every((l) => l.comprar > 0),
    "toda linha do relatório de compra tem quantidade a comprar");
  const comEmbalagem = reposicao.dados.linhas.find((l) => l.unidade_compra);
  conferir(!comEmbalagem || Number.isInteger(comEmbalagem.comprar_embalagem),
    "a quantidade em embalagem é inteira — ninguém compra 2,3 sacos");

  const reposicaoAlmox = await chamar("/relatorios/reposicao", { token: almoxarife.token });
  conferir(!JSON.stringify(reposicaoAlmox.dados).includes('"valor"'),
    "relatório de compra sem valores para o almoxarife");

  const abc = await chamar("/relatorios/abc", { token: diretoria.token });
  conferir(abc.dados.linhas.length > 0 && abc.dados.linhas[0].classe === "A",
    "a curva ABC começa pela classe A");
  const ultimaA = [...abc.dados.linhas].reverse().find((l) => l.classe === "A");
  conferir(!ultimaA || ultimaA.acumulado <= 80.001, "a classe A para nos 80% acumulados");

  const consumo = await chamar("/relatorios/consumo", { token: diretoria.token });
  conferir(consumo.dados.linhas.length > 0, "há consumo por frente no período");

  /* ---------- etiqueta ---------- */
  secao("Etiqueta");

  const etiqueta = await fetch(`${BASE}/api/etiquetas?itens=${alvo.id},${cimento.id}`, {
    headers: { authorization: "Bearer " + almoxarife.token },
  });
  const html = await etiqueta.text();
  conferir(etiqueta.status === 200, "a folha de etiquetas é gerada");
  conferir((html.match(/<svg/g) || []).length === 2, "sai um QR por item pedido");

  /* O conteúdo do QR NÃO aparece como texto no HTML — vira um desenho de
     retângulos. Quem garante que o desenho corresponde à URL certa é
     `npm test`, que decodifica o bitmap de verdade. Aqui confere-se o que
     é conferível na página: o código impresso ao lado do QR, que é o
     caminho de fuga quando a câmera não colabora. */
  conferir(html.includes("CIM-001"), "o código vem escrito ao lado do QR, para digitar");
  conferir(html.includes("Cimento CP-II"), "o nome do item aparece na etiqueta");

  // Nada de rede: sem <script>, sem <link>, sem src externo. O `xmlns` do
  // SVG é declaração de namespace, não busca — por isso não conta.
  const semNamespace = html.replace(/xmlns="[^"]*"/g, "");
  conferir(!/<script|<link|src=|@import/i.test(semNamespace),
    "a etiqueta não busca nada na rede");

  /* ---------- rota da etiqueta e resolução de código ---------- */
  secao("Escanear");

  const resolvido = await chamar(`/resolver?codigo=${BASE}/e/CIM-001`,
    { token: almoxarife.token });
  conferir(resolvido.dados.tipo === "item", "a URL inteira do QR resolve para o item");

  const soCodigo = await chamar("/resolver?codigo=CIM-001", { token: almoxarife.token });
  conferir(soCodigo.dados.tipo === "item", "o código cru também resolve");

  const patrimonio = await chamar("/resolver?codigo=PAT-0001", { token: almoxarife.token });
  conferir(patrimonio.dados.tipo === "ferramenta", "o patrimônio resolve para a ferramenta");

  const inexistente = await chamar("/resolver?codigo=NAO-EXISTE", { token: almoxarife.token });
  conferir(inexistente.status === 404, "código desconhecido responde 404");

  const paginaEtiqueta = await fetch(`${BASE}/e/CIM-001`);
  conferir(paginaEtiqueta.status === 200 &&
    (await paginaEtiqueta.text()).includes("<!doctype html"),
    "a rota /e/CODIGO entrega a página, para a câmera do celular abrir direto");

  /* ---------- exportação ---------- */
  secao("Exportar para planilha");

  const csvDiretoria = await fetch(`${BASE}/api/exportar/estoque`, {
    headers: { authorization: "Bearer " + diretoria.token },
  });
  /* Tem que ser lido em BYTES: `Response.text()` remove o BOM inicial por
     especificação, então a leitura como texto diria que ele não está lá
     mesmo quando está. */
  const bytesCsv = new Uint8Array(await csvDiretoria.clone().arrayBuffer());
  const textoCsv = await csvDiretoria.text();
  conferir(csvDiretoria.status === 200, "exporta o estoque");
  conferir(bytesCsv[0] === 0xEF && bytesCsv[1] === 0xBB && bytesCsv[2] === 0xBF,
    "o CSV começa com BOM — o Excel abre sem perguntar",
    `primeiros bytes: ${[...bytesCsv.slice(0, 4)].map((b) => b.toString(16)).join(" ")}`);
  conferir(textoCsv.split("\r\n")[0].includes(";"), "as colunas são separadas por ponto e vírgula");
  conferir(textoCsv.includes("Valor total"), "a diretoria recebe as colunas de dinheiro");

  const csvAlmox = await fetch(`${BASE}/api/exportar/estoque`, {
    headers: { authorization: "Bearer " + almoxarife.token },
  });
  const textoAlmoxCsv = await csvAlmox.text();
  conferir(!textoAlmoxCsv.includes("Valor total") && !textoAlmoxCsv.includes("Custo unitário"),
    "o almoxarife recebe o MESMO arquivo sem as colunas de dinheiro");

  /* ---------- isolamento entre empresas ---------- */
  secao("Isolamento");

  const foto = await fetch(`${BASE}/api/foto/outra-empresa/qualquer.jpg`, {
    headers: { authorization: "Bearer " + diretoria.token },
  });
  conferir(foto.status === 404, "não dá para pegar foto de outra empresa trocando a URL");

  const sessao = await chamar("/sair", { token: almoxarife.token, metodo: "POST" });
  conferir(sessao.status === 200, "sair encerra a sessão");
  const depoisDeSair = await chamar("/inicio", { token: almoxarife.token });
  conferir(depoisDeSair.status === 401, "o token não vale mais depois de sair");

  /* ---------- fim ---------- */
  console.log(`\n${"=".repeat(52)}`);
  console.log(`${passou} passaram · ${falhou} falharam`);
  if (falhou) {
    console.log("\nFalhas:");
    falhas.forEach((f) => console.log("  · " + f));
    process.exit(1);
  }
  console.log("\nO banco da demonstração ficou sujo (é de propósito, o teste");
  console.log("mexe de verdade). Rode `npm run recarregar` antes de mostrar.");
}

rodar().catch((e) => { console.error("\nquebrou:", e); process.exit(1) });
