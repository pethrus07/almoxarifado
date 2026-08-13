-- ============================================================
--  ALMOXARIFADO — estrutura do banco (D1 / SQLite)
--
--  A regra que organiza tudo: SALDO NÃO É CAMPO, é a soma do livro.
--  `movimentos` é o livro-razão do estoque — cada linha é um fato que
--  aconteceu, com quem, quando e por quê. Nada nele se edita ou se apaga.
--  Quem quiser saber quanto tem, soma. É por isso que existe a view
--  `saldos`. Estoque que mora num campo UPDATE-ável mente cedo ou tarde,
--  e mente sem deixar rastro — que é o defeito clássico do controle em
--  planilha que este sistema veio substituir.
--
--  Correção de estoque também é movimento (tipo 'ajuste'), com motivo e
--  responsável. Não existe "arrumar o número".
-- ============================================================

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------
--  EMPRESA / GENTE / SESSÃO
-- ------------------------------------------------------------

-- O produto é branco: nome, cor e logo saem daqui, não do código.
CREATE TABLE IF NOT EXISTS empresas (
  id           TEXT PRIMARY KEY,          -- slug curto, entra na URL de login
  nome         TEXT NOT NULL,
  cor          TEXT NOT NULL DEFAULT '#b08054',
  logo_texto   TEXT,                      -- sigla exibida quando não há imagem
  documento    TEXT,
  ativo        INTEGER NOT NULL DEFAULT 1,
  criado_em    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Papéis (o servidor decide o que cada um vê — nunca a tela):
--   admin       dono / sócio: tudo, inclusive dinheiro e cadastro
--   engenheiro  gestão da obra: tudo da obra + dinheiro, sem cadastro global
--   almoxarife  movimenta estoque, atende requisição. NÃO vê custo.
--   encarregado pede material e consulta saldo. NÃO vê custo.
CREATE TABLE IF NOT EXISTS usuarios (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id   TEXT NOT NULL REFERENCES empresas(id),
  nome         TEXT NOT NULL,
  login        TEXT NOT NULL,
  senha_hash   TEXT NOT NULL,
  senha_sal    TEXT NOT NULL,
  papel        TEXT NOT NULL CHECK (papel IN ('admin','engenheiro','almoxarife','encarregado')),
  telefone     TEXT,
  obra_id      INTEGER,                   -- obra padrão de quem é de campo
  pin          TEXT,                      -- 4 dígitos: confirma recebimento de material
  ativo        INTEGER NOT NULL DEFAULT 1,
  criado_em    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_login ON usuarios(empresa_id, login);

CREATE TABLE IF NOT EXISTS sessoes (
  token        TEXT PRIMARY KEY,
  usuario_id   INTEGER NOT NULL REFERENCES usuarios(id),
  criado_em    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expira_em    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessoes_usuario ON sessoes(usuario_id);

-- ------------------------------------------------------------
--  ONDE — obra, depósito, frente de serviço
--
--  obra     = a construção (o cliente tem 22)
--  deposito = onde o material fica fisicamente (central + o de cada obra)
--  frente   = centro de custo. É o que responde "quanto a laje do bloco C
--             consumiu" — o relatório que justifica ligar as outras obras.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS obras (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id   TEXT NOT NULL REFERENCES empresas(id),
  codigo       TEXT NOT NULL,
  nome         TEXT NOT NULL,
  endereco     TEXT,
  responsavel  TEXT,
  ativo        INTEGER NOT NULL DEFAULT 1,
  criado_em    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_obras_empresa ON obras(empresa_id, ativo, nome);

CREATE TABLE IF NOT EXISTS depositos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id   TEXT NOT NULL REFERENCES empresas(id),
  obra_id      INTEGER REFERENCES obras(id),   -- nulo = depósito central
  nome         TEXT NOT NULL,
  ativo        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_depositos_empresa ON depositos(empresa_id, ativo);

CREATE TABLE IF NOT EXISTS frentes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id   TEXT NOT NULL REFERENCES empresas(id),
  obra_id      INTEGER NOT NULL REFERENCES obras(id),
  codigo       TEXT NOT NULL,
  nome         TEXT NOT NULL,
  ativo        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_frentes_obra ON frentes(empresa_id, obra_id, ativo);

-- ------------------------------------------------------------
--  O QUE — catálogo
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS categorias (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id   TEXT NOT NULL REFERENCES empresas(id),
  nome         TEXT NOT NULL,
  icone        TEXT,                      -- NOME de um ícone lucide, ex.: "hammer"
  ordem        INTEGER NOT NULL DEFAULT 0,
  ativo        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_categorias_empresa ON categorias(empresa_id, ordem);

CREATE TABLE IF NOT EXISTS fornecedores (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id   TEXT NOT NULL REFERENCES empresas(id),
  nome         TEXT NOT NULL,
  documento    TEXT,
  contato      TEXT,
  telefone     TEXT,
  ativo        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_fornecedores_empresa ON fornecedores(empresa_id, ativo, nome);

-- Um item é um TIPO de coisa, não uma unidade física.
--   tipo='consumo'    → tem saldo. Cimento, cabo, EPI. A etiqueta é da prateleira.
--   tipo='ferramenta' → tem POSSE. Cada unidade vira uma linha em `ativos`,
--                       com etiqueta própria e um responsável por vez.
--
-- Unidade de compra x unidade de uso é o que faz almoxarifado de obra dar
-- errado na planilha: compra-se em saco e consome-se em quilo, compra-se rolo
-- de 100 m e entrega-se 12 m. `fator_conversao` = quantas unidades de uso
-- cabem em uma de compra. O saldo é SEMPRE guardado na unidade de uso.
CREATE TABLE IF NOT EXISTS itens (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id      TEXT NOT NULL REFERENCES empresas(id),
  codigo          TEXT NOT NULL,
  nome            TEXT NOT NULL,
  descricao       TEXT,
  categoria_id    INTEGER REFERENCES categorias(id),
  tipo            TEXT NOT NULL DEFAULT 'consumo' CHECK (tipo IN ('consumo','ferramenta')),
  unidade         TEXT NOT NULL DEFAULT 'un',
  unidade_compra  TEXT,
  fator_conversao REAL NOT NULL DEFAULT 1 CHECK (fator_conversao > 0),
  ean             TEXT,                   -- código de barras do fabricante
  localizacao     TEXT,                   -- prateleira / rua / gaveta
  estoque_minimo  REAL NOT NULL DEFAULT 0,
  estoque_maximo  REAL,
  custo_ultimo    REAL,                   -- alimentado pela última entrada
  fornecedor_id   INTEGER REFERENCES fornecedores(id),
  controla_lote   INTEGER NOT NULL DEFAULT 0,  -- 1 = exige lote/validade na entrada
  foto_chave      TEXT,                   -- objeto no R2
  ativo           INTEGER NOT NULL DEFAULT 1,  -- cadastro não se apaga, inativa
  criado_em       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_itens_codigo ON itens(empresa_id, codigo);
CREATE INDEX IF NOT EXISTS idx_itens_empresa ON itens(empresa_id, ativo, nome);
CREATE INDEX IF NOT EXISTS idx_itens_ean ON itens(empresa_id, ean);
CREATE INDEX IF NOT EXISTS idx_itens_categoria ON itens(empresa_id, categoria_id);

-- O engenheiro escreve "vergalhão", o pedreiro fala "ferro", a nota fiscal
-- diz "barra de aço CA-50 10mm". Os três têm que achar o mesmo item.
CREATE TABLE IF NOT EXISTS item_sinonimos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id      INTEGER NOT NULL REFERENCES itens(id) ON DELETE CASCADE,
  termo        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sinonimos_item ON item_sinonimos(item_id);

-- Índice de texto. `remove_diacritics 2` é o que faz "vergalhao" achar
-- "vergalhão" — a busca não pode cobrar acento de quem digita com luva.
CREATE VIRTUAL TABLE IF NOT EXISTS busca USING fts5(
  item_id UNINDEXED,
  texto,
  tokenize = "unicode61 remove_diacritics 2"
);

-- A linha do índice é remontada inteira a cada mudança — no item e nos
-- sinônimos. Sem os dois gatilhos, sinônimo novo não é achável.
CREATE TRIGGER IF NOT EXISTS busca_item_ai AFTER INSERT ON itens BEGIN
  INSERT INTO busca(item_id, texto) VALUES (
    NEW.id,
    NEW.codigo || ' ' || NEW.nome || ' ' || COALESCE(NEW.descricao,'') || ' ' ||
    COALESCE(NEW.ean,'') || ' ' || COALESCE(NEW.localizacao,'')
  );
END;

CREATE TRIGGER IF NOT EXISTS busca_item_au AFTER UPDATE ON itens BEGIN
  DELETE FROM busca WHERE item_id = NEW.id;
  INSERT INTO busca(item_id, texto) VALUES (
    NEW.id,
    NEW.codigo || ' ' || NEW.nome || ' ' || COALESCE(NEW.descricao,'') || ' ' ||
    COALESCE(NEW.ean,'') || ' ' || COALESCE(NEW.localizacao,'') || ' ' ||
    COALESCE((SELECT group_concat(termo,' ') FROM item_sinonimos WHERE item_id = NEW.id),'')
  );
END;

CREATE TRIGGER IF NOT EXISTS busca_item_ad AFTER DELETE ON itens BEGIN
  DELETE FROM busca WHERE item_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS busca_sin_ai AFTER INSERT ON item_sinonimos BEGIN
  DELETE FROM busca WHERE item_id = NEW.item_id;
  INSERT INTO busca(item_id, texto)
  SELECT i.id,
         i.codigo || ' ' || i.nome || ' ' || COALESCE(i.descricao,'') || ' ' ||
         COALESCE(i.ean,'') || ' ' || COALESCE(i.localizacao,'') || ' ' ||
         COALESCE((SELECT group_concat(termo,' ') FROM item_sinonimos WHERE item_id = i.id),'')
    FROM itens i WHERE i.id = NEW.item_id;
END;

CREATE TRIGGER IF NOT EXISTS busca_sin_ad AFTER DELETE ON item_sinonimos BEGIN
  DELETE FROM busca WHERE item_id = OLD.item_id;
  INSERT INTO busca(item_id, texto)
  SELECT i.id,
         i.codigo || ' ' || i.nome || ' ' || COALESCE(i.descricao,'') || ' ' ||
         COALESCE(i.ean,'') || ' ' || COALESCE(i.localizacao,'') || ' ' ||
         COALESCE((SELECT group_concat(termo,' ') FROM item_sinonimos WHERE item_id = i.id),'')
    FROM itens i WHERE i.id = OLD.item_id;
END;

-- ------------------------------------------------------------
--  LOTE E VALIDADE
--  EPI, cimento, epóxi e silicone vencem. Perder material por vencimento
--  é dinheiro que sai sem ninguém ver — poucos concorrentes tratam isso.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lotes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id    TEXT NOT NULL REFERENCES empresas(id),
  item_id       INTEGER NOT NULL REFERENCES itens(id),
  codigo        TEXT,
  validade      TEXT,                     -- AAAA-MM-DD
  fornecedor_id INTEGER REFERENCES fornecedores(id),
  criado_em     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_lotes_item ON lotes(item_id, validade);

-- ------------------------------------------------------------
--  O LIVRO — movimentos
--
--  `quantidade` é COM SINAL: positivo entra, negativo sai. É o que deixa o
--  saldo ser um SUM() honesto em vez de um CASE sobre o tipo. O tipo fica
--  para explicar o porquê ao humano, não para a conta.
--
--  Nada aqui se edita nem se apaga. Errou? Lança o contrário, com motivo.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS movimentos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id      TEXT NOT NULL REFERENCES empresas(id),
  item_id         INTEGER NOT NULL REFERENCES itens(id),
  deposito_id     INTEGER NOT NULL REFERENCES depositos(id),
  tipo            TEXT NOT NULL CHECK (tipo IN
                    ('entrada','saida','devolucao','ajuste','perda','transf_saida','transf_entrada')),
  quantidade      REAL NOT NULL CHECK (quantidade <> 0),
  custo_unitario  REAL,
  frente_id       INTEGER REFERENCES frentes(id),
  lote_id         INTEGER REFERENCES lotes(id),
  requisicao_id   INTEGER,
  usuario_id      INTEGER NOT NULL REFERENCES usuarios(id),  -- quem REGISTROU
  pessoa          TEXT,                   -- quem retirou/entregou (pode não ter login)
  documento       TEXT,                   -- nota fiscal, romaneio
  motivo          TEXT,                   -- obrigatório em ajuste e perda
  obs             TEXT,
  transferencia   TEXT,                   -- amarra os dois lados de uma transferência
  criado_em       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_mov_saldo    ON movimentos(item_id, deposito_id);
CREATE INDEX IF NOT EXISTS idx_mov_kardex   ON movimentos(empresa_id, item_id, criado_em);
CREATE INDEX IF NOT EXISTS idx_mov_periodo  ON movimentos(empresa_id, criado_em);
CREATE INDEX IF NOT EXISTS idx_mov_frente   ON movimentos(empresa_id, frente_id, criado_em);
CREATE INDEX IF NOT EXISTS idx_mov_deposito ON movimentos(empresa_id, deposito_id, criado_em);

-- Saldo por item e depósito. Toda tela de estoque bebe daqui.
CREATE VIEW IF NOT EXISTS saldos AS
  SELECT item_id, deposito_id, SUM(quantidade) AS quantidade
    FROM movimentos GROUP BY item_id, deposito_id;

-- Saldo consolidado do item na empresa inteira.
CREATE VIEW IF NOT EXISTS saldo_item AS
  SELECT item_id, SUM(quantidade) AS quantidade
    FROM movimentos GROUP BY item_id;

-- Saldo por lote — é o que permite avisar "vence em 20 dias E ainda tem 40".
CREATE VIEW IF NOT EXISTS saldo_lote AS
  SELECT lote_id, item_id, SUM(quantidade) AS quantidade
    FROM movimentos WHERE lote_id IS NOT NULL GROUP BY lote_id, item_id;

-- ------------------------------------------------------------
--  FERRAMENTA — posse, não saldo
--
--  Aqui a pergunta não é "quantas tem", é "quem está com ela desde quando".
--  Essa é a dor onde some dinheiro de verdade na obra.
--
--  A situação atual mora no próprio ativo porque isto é máquina de estados,
--  não aritmética: o risco que obriga a derivar saldo (soma que desanda em
--  silêncio) não existe aqui. Ainda assim o log é a verdade — a situação é
--  gravada na MESMA transação do movimento, nunca sozinha.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ativos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id    TEXT NOT NULL REFERENCES empresas(id),
  item_id       INTEGER NOT NULL REFERENCES itens(id),
  patrimonio    TEXT NOT NULL,            -- o que vai na etiqueta
  serie         TEXT,
  deposito_id   INTEGER REFERENCES depositos(id),
  situacao      TEXT NOT NULL DEFAULT 'disponivel'
                CHECK (situacao IN ('disponivel','em_uso','manutencao','baixado')),
  posse_pessoa  TEXT,                     -- quem está com ela
  posse_usuario INTEGER REFERENCES usuarios(id),
  frente_id     INTEGER REFERENCES frentes(id),
  posse_desde   TEXT,
  prev_devolucao TEXT,
  obs           TEXT,
  criado_em     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ativos_patrimonio ON ativos(empresa_id, patrimonio);
CREATE INDEX IF NOT EXISTS idx_ativos_item ON ativos(empresa_id, item_id, situacao);
CREATE INDEX IF NOT EXISTS idx_ativos_posse ON ativos(empresa_id, situacao, posse_desde);

CREATE TABLE IF NOT EXISTS ativo_movimentos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id  TEXT NOT NULL REFERENCES empresas(id),
  ativo_id    INTEGER NOT NULL REFERENCES ativos(id),
  tipo        TEXT NOT NULL CHECK (tipo IN ('emprestimo','devolucao','manutencao','retorno','baixa','transferencia')),
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id),
  pessoa      TEXT,
  frente_id   INTEGER REFERENCES frentes(id),
  deposito_id INTEGER REFERENCES depositos(id),
  obs         TEXT,
  criado_em   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ativomov ON ativo_movimentos(ativo_id, criado_em);

-- ------------------------------------------------------------
--  REQUISIÇÃO — o encarregado pede, o almoxarife separa e entrega
--
--  A entrega só fecha com confirmação de quem recebeu (PIN). É a prova de
--  entrega: sem ela, "eu nunca peguei esse material" não tem resposta.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS requisicoes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id    TEXT NOT NULL REFERENCES empresas(id),
  numero        INTEGER NOT NULL,
  obra_id       INTEGER NOT NULL REFERENCES obras(id),
  frente_id     INTEGER REFERENCES frentes(id),
  deposito_id   INTEGER NOT NULL REFERENCES depositos(id),
  solicitante_id INTEGER NOT NULL REFERENCES usuarios(id),
  situacao      TEXT NOT NULL DEFAULT 'aberta'
                CHECK (situacao IN ('aberta','separando','entregue','parcial','cancelada')),
  urgencia      TEXT NOT NULL DEFAULT 'normal' CHECK (urgencia IN ('normal','urgente')),
  observacao    TEXT,
  atendido_por  INTEGER REFERENCES usuarios(id),
  recebido_por  TEXT,
  entregue_em   TEXT,
  criado_em     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_req_numero ON requisicoes(empresa_id, numero);
CREATE INDEX IF NOT EXISTS idx_req_fila ON requisicoes(empresa_id, situacao, criado_em);
CREATE INDEX IF NOT EXISTS idx_req_solic ON requisicoes(empresa_id, solicitante_id, criado_em);

CREATE TABLE IF NOT EXISTS requisicao_itens (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  requisicao_id  INTEGER NOT NULL REFERENCES requisicoes(id) ON DELETE CASCADE,
  item_id        INTEGER NOT NULL REFERENCES itens(id),
  qtd_pedida     REAL NOT NULL,
  qtd_atendida   REAL NOT NULL DEFAULT 0,
  obs            TEXT
);
CREATE INDEX IF NOT EXISTS idx_reqitens ON requisicao_itens(requisicao_id);

-- ------------------------------------------------------------
--  INVENTÁRIO — contagem física contra o sistema
--
--  `saldo_sistema` é congelado na hora da contagem: comparar contagem de
--  ontem com saldo de hoje acusaria divergência onde só houve movimento.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS inventarios (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id   TEXT NOT NULL REFERENCES empresas(id),
  deposito_id  INTEGER NOT NULL REFERENCES depositos(id),
  nome         TEXT,
  situacao     TEXT NOT NULL DEFAULT 'aberto' CHECK (situacao IN ('aberto','fechado','cancelado')),
  criado_por   INTEGER NOT NULL REFERENCES usuarios(id),
  criado_em    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  fechado_em   TEXT
);
CREATE INDEX IF NOT EXISTS idx_inv_empresa ON inventarios(empresa_id, situacao);

CREATE TABLE IF NOT EXISTS inventario_itens (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  inventario_id  INTEGER NOT NULL REFERENCES inventarios(id) ON DELETE CASCADE,
  item_id        INTEGER NOT NULL REFERENCES itens(id),
  saldo_sistema  REAL NOT NULL,
  contagem       REAL,
  contado_por    INTEGER REFERENCES usuarios(id),
  contado_em     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invitens ON inventario_itens(inventario_id, item_id);

-- ------------------------------------------------------------
--  AUDITORIA E FOTO
-- ------------------------------------------------------------

-- Indicador sem histórico nasce vazio. Registra-se desde o primeiro dia,
-- mesmo sem tela que leia — o custo é uma linha, e o dado não volta depois.
CREATE TABLE IF NOT EXISTS eventos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id  TEXT NOT NULL REFERENCES empresas(id),
  usuario_id  INTEGER REFERENCES usuarios(id),
  tipo        TEXT NOT NULL,
  alvo        TEXT,
  alvo_id     INTEGER,
  detalhe     TEXT,
  criado_em   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_eventos ON eventos(empresa_id, criado_em);

CREATE TABLE IF NOT EXISTS fotos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id   TEXT NOT NULL REFERENCES empresas(id),
  chave        TEXT NOT NULL,
  item_id      INTEGER REFERENCES itens(id),
  movimento_id INTEGER REFERENCES movimentos(id),
  ativo_id     INTEGER REFERENCES ativos(id),
  legenda      TEXT,
  usuario_id   INTEGER REFERENCES usuarios(id),
  criado_em    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_fotos_item ON fotos(item_id);
