# Almoxarifado — notas para quem for mexer

## O que é
Controle de estoque de obra por QR Code. Cloudflare Worker + D1 + R2, mesmo
esquema dos outros sistemas: **um `worker.js` sem framework**, roteamento na
mão por regex, e o front inteiro em `ui.html` importado como texto. Visão
geral no [README.md](README.md).

O produto é **branco de propósito**: nome, cor e logo saem de `empresas`, não
do código. O primeiro prospect é uma construtora com 22 obras — o sistema
nasceu multi-empresa e multi-obra para que ligar a segunda seja cadastro, e
não reescrita.

## A regra que organiza tudo

**Saldo não é campo, é a soma do livro.** `movimentos` é o livro-razão: cada
linha é um fato, com quem, quando e por quê. Nada nele se edita ou se apaga.
Quem quer saber quanto tem, soma — é para isso que existe a view `saldos`.

Estoque num campo UPDATE-ável mente cedo ou tarde, e mente **sem deixar
rastro** — que é exatamente o defeito da planilha que este sistema veio
substituir. Corrigir estoque é lançar um movimento do tipo `ajuste`, com
motivo obrigatório e responsável. Não existe "arrumar o número".

**Ferramenta é a exceção, e é de propósito.** `ativos.situacao` guarda o
estado atual porque posse é máquina de estados, não aritmética: o risco que
obriga a derivar saldo (soma que desanda em silêncio) não existe aí. Mas o
log continua sendo a verdade — a situação é gravada na MESMA transação do
`ativo_movimentos`, nunca sozinha.

## Regras que não se quebram

- **`empresa_id` em toda consulta**, sempre vindo da sessão, nunca do corpo
  do pedido. Quem manda o pedido não escolhe de qual empresa está falando.
- **Quem vê dinheiro é decidido no servidor** (`semValores()`). Almoxarife e
  encarregado nunca RECEBEM campo de custo na resposta — esconder no CSS
  deixa o dado viajando no JSON, o que é o mesmo que não esconder. Guardado
  por `npm run test:api`, que confere o JSON e o CSV exportado.
- **A trava do estoque negativo mora DENTRO do INSERT**, num
  `... SELECT ... WHERE (SELECT SUM(quantidade) ...) >= ?`. Um `if` lido
  antes de gravar deixa passar duas baixas simultâneas — o almoxarife no
  balcão e o encarregado no celular. Com a trava no INSERT, a segunda
  simplesmente não insere e `meta.changes === 0` é a resposta.
- **Ajuste e perda exigem motivo.** É o que separa correção de rasura.
- **Transferência são dois lançamentos amarrados** pelo mesmo
  `transferencia`, gravados juntos. Um lado sem o outro faria material sumir
  de uma obra sem aparecer na outra.
- **Cadastro não se apaga**, vira `ativo = 0`. Histórico apontando pra ele
  continua válido.
- **Tudo grava em `eventos`** com quem e quando. Indicador sem histórico
  nasce vazio — registra-se desde o primeiro dia, mesmo sem tela que leia.
- **A cor da empresa é cadastro** (`empresas.cor`), aplicada por
  `pintarAcento()`. Pinta identidade: topo, botão principal, aba ativa.
  **Nunca** pinta o semáforo de estoque — verde/âmbar/vermelho que muda de
  cor por cliente não significa mais nada. O texto sobre a cor é escolhido
  por luminância, senão marca clara fica ilegível.

⚠️ **`0` não é zero.** Somar e subtrair as mesmas quantidades deixa saldos
como `4,5e-13`: a tela arredonda para "0" e `<= 0` diz que é positivo. Aí o
chip "Zerado" e o número que a pessoa lê discordam, e ela conclui — com razão
— que o sistema está errado. Use `< 0.001` (a constante `NADA` no worker,
`nivel()` na tela). Já mordeu uma vez.

⚠️ **A ordem dos parâmetros do D1 é a ordem dos `?` no TEXTO do SQL**, e na
busca eles não estão todos no WHERE: o do `MATCH` está no JOIN e o do
depósito numa subconsulta, os dois antes. Uma lista só entregaria a empresa
para o MATCH e o termo buscado para o `empresa_id` — e a busca passa a
devolver zero resultado **sempre, sem erro nenhum**. Por isso são três listas
(`argsJuncao`, `argsSubconsulta`, `argsCond`), concatenadas na ordem da
montagem.

⚠️ **Corpo vazio em POST não é erro.** As rotas de ação — sair, separar,
fechar contagem, devolver ferramenta — são POST sem nada para mandar, e o
navegador manda o `content-type` do mesmo jeito. Chamar `req.json()` direto
estoura nelas, e a tela vira "clico no botão e não acontece nada". Lê-se o
texto primeiro; só texto presente e malformado é erro.

## Busca — é a tela principal, não um recurso

Quem procura material tem ele na mão e precisa achar em três segundos.

- O motor é **FTS5** com `remove_diacritics 2` — "vergalhao" acha
  "Vergalhão". A última palavra vai por prefixo: "eletrod" já traz.
- **`item_sinonimos` alimenta o índice.** O engenheiro escreve "vergalhão",
  o pedreiro fala "ferro", a nota diz "CA-50". Os gatilhos remontam a linha
  inteira do índice a cada mudança **no item E nos sinônimos** — sem os dois,
  sinônimo novo não é achável.
- **Código exato ganha de relevância de texto.** Quem escaneou a etiqueta
  quer AQUELE item, não o mais parecido: a tela abre a ficha direto.
- O termo digitado vai ligado como valor, e o que o FTS5 lê como sintaxe
  (aspas, `*`, `-`) é descartado antes — um `"` solto derruba a consulta.

## A tela é metade do produto

Quem usa está de pé, no galpão, com material numa das mãos e às vezes de
luva. Isso não é enfeite, é requisito:

- **Alvo de dedo mínimo de 56px** (`--toque`). O botão "Dar baixa" é o
  controle mais usado do sistema: usa o `--toque` inteiro e não encolhe.
  Guardado por `npm run test:visual`, que mede a caixa de verdade.
- **Nada de `prompt`, `confirm` ou `alert`.** Cada um tem tela própria:
  `perguntar()`, `escolher()`, `pedirNumero()` (teclado numérico grande, no
  lugar do prompt da quantidade) e `pedirTexto()`.
- **Cor tem significado fixo**: vermelho abaixo do mínimo, âmbar chegando
  perto, verde folgado, cinza parado.
- **Ícone de traço, nunca emoji** — o conjunto está inlinado em `ICONES`.
- **Texto de gente**: `plural(n, "item", "itens")`, nunca "item(ns)".
- **Número sempre tabular** (`.num`, `.qtd`): coluna de estoque com número
  de largura variável é ilegível.
- **Navegação embaixo no celular, no máximo 5 abas.** A sexta faria cada
  alvo cair abaixo de 60px num aparelho de 390px; o resto vai em "Mais".
- **Campo de formulário tem 16px no celular** — não é escolha de estilo: o
  Safari do iOS dá zoom na página sozinho ao focar um campo de fonte menor,
  a tela salta e o teclado cobre o que a pessoa está digitando. Guardado por
  `npm run test:visual`, que mede o valor calculado.
- **Relatório é lista, não tabela.** Cinco colunas num aparelho de 390px
  viram uma tabela que só rola de lado, e ninguém rola de lado para ler
  relatório. Onde a tabela ganha (consumo por frente, com a barra
  proporcional), a coluna menos útil leva `so-computador`.

⚠️ **A lateral SOME no celular, e com ela tudo o que só existe lá.** Sair,
trocar tema e rever o passo a passo moravam só na lateral — no aparelho não
havia como fazer nenhum dos três, e quem entrasse não conseguia sair. Quem
cobre isso é `folhaConta()`, aberta pelo botão da marca no topo (`#bt-conta`).
O **PIN** também mora lá, e não só no Cadastro: quem mais precisa dele é o
encarregado, que não tem aba de Cadastro nenhuma. **Recurso novo que você
pendurar só na lateral não existe para metade dos usuários** — pendure
também na folha de conta.
- **Unidade contável não tem casa decimal.** Ninguém tem 12,54 tubos — é a
  primeira coisa que denuncia dado inventado, e o engenheiro repara.

⚠️ **A montagem da casca tem que ser idempotente.** `comecar()` roda de novo
a cada login na mesma aba. Nada de `outerHTML` em elemento com `id`: a
primeira execução apaga o `id` e a segunda estoura. E o `catch` de
`comecar()` separa duas coisas — **sessão caiu** volta ao login em silêncio;
**erro de tela** aparece como recado. Engolir as duas juntas vira "digito a
senha e não acontece nada".

⚠️ **401 quer dizer duas coisas.** Na tela de login é senha errada; em
qualquer outra rota é sessão vencida. Confundir manda a pessoa "entrar de
novo" bem na hora em que ela está tentando entrar.

⚠️ **Folhas encadeadas não fecham entre si.** `abrir()` TROCA o conteúdo do
`<dialog>` que já está aberto. Fechar e reabrir faz o evento `close` da folha
anterior chegar atrasado e cancelar a seguinte — o fluxo morre no meio, sem
mensagem. Quem responde clicando chama `solta()`; só o ✕, o fundo e o Esc
fecham de verdade.

⚠️ **Um parêntese a menos mata uma tela inteira em silêncio.** O navegador
descarta o bloco `<script>` com um erro no console e segue tocando os
outros: a página abre, o login funciona, e algumas telas simplesmente não
existem. Nenhum teste de API pega isso. **`npm run verificar` roda primeiro,
sempre** — ele parseia cada bloco, confere que não sobrou marcador de
montagem e que nada busca na rede.

## Escanear — duas portas, porque os navegadores são dois

- **Android/Chrome** tem `BarcodeDetector` nativo: lê QR e o código de barras
  do fabricante direto da câmera, sem biblioteca nenhuma.
- **iPhone não tem.** Mas o QR da etiqueta guarda uma URL, então a câmera
  **do próprio iOS** lê e abre `/e/CODIGO` — que entrega esta mesma página, e
  ela resolve o código e abre o item. É até melhor que ler de dentro do app.
- E, nos dois casos, dá para **digitar o código impresso**. Câmera que não
  colabora nunca pode ser o fim do caminho.

`qr.js` é implementação própria (modo byte, nível M, versões 1–10) porque a
etiqueta não pode depender de rede nem de CDN. **Mexeu nele, rode `npm
test`** — compara byte a byte com uma implementação de referência E
decodifica o bitmap de verdade. Veio do `retifica-os`, onde três bugs sutis
já moraram: o polinômio gerador do Reed-Solomon vai do maior grau para o
menor; o separador do finder é branco; a informação de formato é gravada
coluna 8 / linha 8 — invertida, o código fica bonito na tela e ilegível no
leitor.

## Duas empresas, e uma delas é sagrada

`demo` é a obra de mentira, cheia, para mostrar o sistema. A empresa do
cliente nasce **zerada** e **nenhum teste roda nela**.

Os atalhos de "ver como" na tela de login só aparecem na empresa `demo` — é
apoio de apresentação, não porta dos fundos.

## O seed é gerado, não escrito

`ferramentas/gerar-seed.mjs` monta `seed-demo.sql`. Não edite o `.sql` à mão.

Dois motivos: as senhas precisam de hash PBKDF2 com os **mesmos** parâmetros
do worker (100.000 voltas, sal de 16 bytes, base64) — hash digitado à mão é
como o login para de funcionar sem dizer por quê; e relatório vazio não vende
nada, então são 90 dias de movimento coerente, o que dá centenas de linhas.

O sorteio é semeado: rodar de novo dá exatamente o mesmo banco.

⚠️ **O mínimo é comparado com o saldo da EMPRESA INTEIRA** (view
`saldo_item`), não com o de um depósito. Esvaziar só o central deixa o total
acima do mínimo e **nada aparece como crítico** — a tela de abertura e o
relatório de compra abrem vazios.

⚠️ **`DELETE FROM sqlite_sequence;` fecha o bloco de limpeza, e é
obrigatório.** Os ids nos INSERTs são escritos na mão (é o que deixa o
arquivo determinístico), mas `DELETE` não zera o contador do
`AUTOINCREMENT`: na segunda carga as obras nascem com id 5..8 enquanto os
depósitos apontam para a obra 1, e tudo morre com "FOREIGN KEY constraint
failed" sem dizer onde. Sem essa linha o seed só funciona em banco virgem —
e passou despercebido local justamente porque eu recarregava sempre do zero.

## Rodar e publicar

```bash
npm install
npm run banco:local && npm run seed:local
npx wrangler dev
npm run test:tudo        # com o dev rodando
```

⚠️ **`npm run recarregar` com o `wrangler dev` ligado falha em silêncio** — o
processo segura o arquivo SQLite e o `d1 execute` não consegue limpar. Pare o
servidor, recarregue, suba de novo. Já custou meia hora perseguindo um dado
que "não atualizava".

⚠️ **O banco local é indexado pelo `database_id` do `wrangler.toml`.** Trocar
o id faz o dev apontar para um banco novo e vazio, e todo login passa a dar
500 sem mensagem útil. Não é defeito: é rodar esquema e seed de novo.

## Conta Cloudflare

**No ar em https://almoxarifado.ryzecode.workers.dev** (deploy 13/08/2026).

Conta própria da RYZE (`642a4a39…`, e-mail da conta),
subdomínio workers.dev **`ryzecode`**. NÃO é a `ryzecode08` — o subdomínio
de lá é `desbravando-utv` e a URL sairia com o nome de outro cliente na
frente do prospect. Credenciais no cofre DÜ SOL.

⚠️ O OAuth em cache do wrangler nesta máquina é da **outra** conta
(ryzecode08). Sem as três variáveis exportadas juntas ele mira a conta
errada e falha com `7404 database not found`:

```bash
export CLOUDFLARE_EMAIL="<e-mail da conta>"
export CLOUDFLARE_ACCOUNT_ID="642a4a3988033760c46abb97c122e0dd"
export CLOUDFLARE_API_KEY="<Global API Key do cofre DÜ SOL>"
```

A chave é Global API Key no formato novo (`cfk_`), usada com
`X-Auth-Email` + `X-Auth-Key` — **não** funciona como Bearer token.

⚠️ Recém-deployado, o workers.dev responde a página "There is nothing here
yet" por alguns segundos enquanto a rota propaga. Não é falha do deploy —
espere e repita.

O staging ainda está com `database_id = "PREENCHER_APOS_CRIAR"`.

## Convenções

- Escreva em **português** e no estilo do arquivo: single-file, sem
  framework, sem dependência nova sem necessidade real.
- Nos commits deste repo, **NÃO** adicione o trailer `Co-Authored-By`.

## Em aberto

- **Offline de verdade.** Fila local de saída segura queda curta de sinal;
  sincronização completa é projeto à parte e é honesto cobrar por ela.
- **Foto do item** está pronta no código mas depende de R2 — que é opcional
  e hoje não está criado.
- **Escopo comercial não fechado.** O que o cliente pediu foi levantado por
  conversa, não por documento. Antes de acrescentar qualquer coisa, confira
  com quem está negociando.
