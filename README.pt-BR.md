Português | [English](README.md)

# Almoxarifado

> **Arquivado (2026-11).** Fora de produção. O Worker foi apagado em 07/09/2026. O código roda localmente com dados de demonstração.

Controle de estoque de obra por QR Code. Cada material tem etiqueta, cada ferramenta tem dono, e cada movimento fica no histórico com quem e quando. Feito para quem está de pé no galpão com o material na mão.

## O que foi

Um MVP feito em agosto de 2026 para apresentar a uma construtora (um prospect, não um cliente). Ficou no ar no Cloudflare Workers por cerca de um mês e a negociação não andou.

O que ele faz:

- **Busca que acha.** Uma caixa só resolve nome, código, prateleira, código de barras do fabricante e patrimônio de ferramenta, sem acento, com erro de digitação ou pela metade. Sinônimos fazem "vergalhão", "ferro" e "CA-50" acharem o mesmo item (FTS5 do SQLite).
- **Etiqueta com QR.** Folha A4 em papel comum. A câmera do celular abre o sistema no item certo. Gerador de QR escrito do zero (`qr.js`), testado contra uma implementação de referência.
- **Saldo que não mente.** O estoque é a soma do livro de movimentos, nunca um campo que alguém edita. Saída maior que o saldo é recusada dentro da transação. Correção é lançamento com motivo e responsável.
- **Ferramenta tem dono.** Quem está com a furadeira, desde quando, em qual frente. Alerta do que está fora há mais de sete dias.
- **Requisição com prova de entrega.** O encarregado pede pelo celular, o almoxarife entrega e quem recebe confirma com PIN.
- **Inventário** transforma cada divergência em ajuste rastreável, com percentual de acerto.
- **Relatórios:** o que comprar (por fornecedor), consumo por frente, curva ABC, vencimentos, estoque parado. Exportáveis para planilha.
- **Quatro níveis de acesso** decididos no servidor, não escondidos na tela. Multi-empresa e multi-obra desde a primeira tabela.

## Stack

Cloudflare Worker + D1 (SQLite) + R2, sem framework e sem build. O front inteiro é `ui.html` importado como texto, com `estilo.css` colado dentro: uma requisição só, sem CDN, porque o galpão tem sinal ruim.

| arquivo | o que é |
|---|---|
| `worker.js` | API e roteamento, escrito na mão |
| `ui.html` | a interface inteira, arquivo único |
| `estilo.css` | tokens de tema, claro e escuro |
| `schema.sql` | estrutura do banco |
| `qr.js` | gerador de QR próprio, sem dependência |
| `ferramentas/gerar-seed.mjs` | monta a obra de demonstração (`seed-demo.sql`) |
| `test/` | testes de sintaxe, QR, API e visual |
| `docs/NOTAS-TECNICAS.md` | decisões de projeto e armadilhas |

## Rodar localmente

```bash
npm install
npm run recarregar                         # schema + demonstração no D1 local
npx wrangler dev --port 8788               # http://127.0.0.1:8788
```

Entrar com a empresa `demo` e o usuário `diretoria`, `engenheiro`, `almoxarife` ou `encarregado`, senha `demo`. Todo dado de demonstração é fictício.

## Testes

```bash
npm run verificar     # todo <script> do ui.html parseia
npm test              # gerador de QR contra implementação de referência (jsqr)
npm run test:api      # 92 afirmações pela API (precisa do wrangler dev na 8788)
npm run test:visual   # dirige a tela com Playwright e mede alvo de toque; prints em test/telas/
npm run test:tudo     # tudo acima, na ordem
```

Última rodada em 01/11/2026: sintaxe ok, QR ok, API 92 de 92, visual 42 de 42.

Os testes de API e visual mexem de propósito no banco local de demonstração. Pare o `wrangler dev` e rode `npm run recarregar` depois.

## O que ficou de aprendizado

- **Saldo derivado ganha de campo editável.** Estoque como soma de um livro que só recebe lançamento acabou com uma classe inteira de erro e deu trilha de auditoria de graça. Ferramenta é a exceção: posse é máquina de estados, gravada na mesma transação do seu log.
- **Permissão mora no servidor.** Esconder coluna de dinheiro na tela não é controle de acesso.
- **Teste de sintaxe do script embutido se paga.** Um parêntese a menos fez o navegador descartar um bloco `<script>` inteiro com a página abrindo normalmente; só a checagem de parse pegou.
- **Tela se mede, não se olha.** O teste visual confere o tamanho do alvo de toque num celular de 390 px e num computador de 1440 px.
- **Busca precisa de sinônimo, não só de tolerância a erro.** Peão, engenheiro e nota fiscal chamam o mesmo item por nomes diferentes.

## Licença

Todos os direitos reservados. RYZE.
