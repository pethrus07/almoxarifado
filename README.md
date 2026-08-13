# Almoxarifado

Controle de estoque de obra por QR Code. Cada material tem etiqueta, cada
ferramenta tem dono, e cada movimento fica no histórico com quem e quando.

Feito para quem está de pé no galpão com o material na mão — não para quem
está sentado numa mesa.

## O que faz

**Busca que acha.** Uma caixa só resolve nome, código, prateleira, código de
barras do fabricante e patrimônio de ferramenta. O engenheiro escreve
"vergalhão", o pedreiro fala "ferro", a nota fiscal diz "CA-50" — os três
acham o mesmo item. Sem acento, com erro de digitação, ou pela metade.

**Etiqueta com QR.** Folha A4 imprimível em papel comum. A câmera do celular
lê e abre o sistema já no item certo. Se a câmera não colaborar, o código vem
escrito ao lado.

**Saldo que não mente.** O estoque é a soma do livro de movimentos, nunca um
campo que alguém atualiza. Saída maior que o saldo é recusada dentro da
transação. Correção é lançamento com motivo e responsável — não existe
"arrumar o número".

**Ferramenta tem dono.** Quem está com a furadeira, desde quando, em qual
frente. Alerta do que está fora há mais de sete dias.

**Requisição com prova de entrega.** O encarregado pede pelo celular, o
almoxarife separa e entrega. Quem recebe confirma com PIN — sem isso, "eu
nunca peguei esse material" não tem resposta.

**Inventário com acuracidade.** Conta a prateleira, compara com o sistema,
mostra a divergência e transforma cada uma em ajuste rastreável. O percentual
de acerto é o número que sobe mês a mês.

**Relatórios que decidem.** O que comprar (agrupado por fornecedor, em
unidade de compra), consumo por frente de serviço, curva ABC, vencimentos e
estoque parado. Tudo exportável para planilha.

**Quatro níveis de acesso.** Dono e engenheiro veem dinheiro; almoxarife e
encarregado não — e isso é decidido no servidor, não escondido na tela.

**Multi-obra desde a primeira linha.** Obras, depósitos e frentes de serviço
são cadastro. Ligar mais uma construção não é reescrita.

## Stack

Cloudflare Worker + D1 (SQLite) + R2, sem framework e sem build. O front
inteiro é `ui.html` importado como texto, com `estilo.css` colado dentro:
uma requisição só, nada de CDN — o galpão tem sinal ruim e às vezes nenhum.

| arquivo | o que é |
|---|---|
| `worker.js` | API e roteamento, escrito na mão |
| `ui.html` | a interface inteira, arquivo único |
| `estilo.css` | tokens de tema, claro e escuro |
| `schema.sql` | estrutura do banco |
| `qr.js` | gerador de QR próprio, sem dependência |
| `ferramentas/gerar-seed.mjs` | monta a obra de demonstração |

## Rodar

```bash
npm install
npm run banco:local          # cria a estrutura
npm run seed:local           # carrega a obra de demonstração
npx wrangler dev             # abre em http://127.0.0.1:8787
```

Entrar com a empresa `demo` e qualquer um destes usuários, senha `demo`:
`dono`, `engenheiro`, `almoxarife`, `encarregado`. Na tela de login da
empresa `demo` há atalhos para entrar direto em cada papel.

## Testes

```bash
npm run verificar     # sintaxe do ui.html — roda primeiro, é o mais barato
npm test              # gerador de QR, contra implementação de referência
npm run test:api      # 92 afirmações pela API, com wrangler dev rodando
npm run test:visual   # dirige a tela e mede o alvo de dedo; prints em test/telas/
npm run test:tudo     # tudo acima, na ordem
```

Os testes de API e visual **mexem no banco de verdade** e rodam sempre na
empresa `demo`. Depois deles, `npm run recarregar` devolve o banco ao estado
gerado — com o `wrangler dev` **parado**, senão o arquivo está travado e a
recarga falha em silêncio.

## Publicar

```bash
npx wrangler d1 create almoxarifado        # cole o id no wrangler.toml
npx wrangler r2 bucket create almoxarifado-fotos   # opcional
npx wrangler d1 execute almoxarifado --remote --file=schema.sql
npx wrangler deploy
```

O R2 é opcional: sem ele tudo funciona, só a foto do item não.

## Licença

Software proprietário. RYZE.
