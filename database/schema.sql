SET FOREIGN_KEY_CHECKS = 0;

DROP VIEW IF EXISTS vw_folhas_resumo;
DROP TABLE IF EXISTS folha_itens;
DROP TABLE IF EXISTS adiantamento_parcelas;
DROP TABLE IF EXISTS adiantamentos;
DROP TABLE IF EXISTS rescisoes;
DROP TABLE IF EXISTS nf_arquivos;
DROP TABLE IF EXISTS folhas;
DROP TABLE IF EXISTS prestadores;
DROP TABLE IF EXISTS folha_aprovacoes;
DROP TABLE IF EXISTS nf_followups;
DROP TABLE IF EXISTS sessoes;
DROP TABLE IF EXISTS usuarios;
DROP TABLE IF EXISTS projetos;
DROP TABLE IF EXISTS departamentos;
DROP TABLE IF EXISTS categorias;
DROP TABLE IF EXISTS funcoes;
DROP TABLE IF EXISTS unidades;

SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE unidades (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(120) NOT NULL,
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_unidades_nome (nome)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE funcoes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(120) NOT NULL,
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_funcoes_nome (nome)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE categorias (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(120) NOT NULL,
  omie_codigo VARCHAR(20) NULL,
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_categorias_nome (nome)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE departamentos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(120) NOT NULL,
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_departamentos_nome (nome)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE projetos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(120) NOT NULL,
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_projetos_nome (nome)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE usuarios (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(120) NOT NULL,
  email VARCHAR(160) NOT NULL,
  senha_hash VARCHAR(255) NOT NULL,
  perfil ENUM('master', 'administrador', 'financeiro', 'operacional', 'aprovador', 'consulta') NOT NULL DEFAULT 'consulta',
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  ultimo_login DATETIME NULL,
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_usuarios_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE folha_aprovacoes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  competencia CHAR(7) NOT NULL,
  usuario_id INT NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  codigo_autenticacao VARCHAR(24) NULL,
  aprovado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  comentario TEXT NULL,
  CONSTRAINT fk_folha_aprovacoes_usuario
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    ON DELETE CASCADE,
  UNIQUE KEY uq_folha_aprovacao_usuario (competencia, usuario_id),
  KEY idx_folha_aprovacoes_hash (competencia, payload_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE nf_arquivos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  competencia CHAR(7) NOT NULL,
  prestador_id INT NOT NULL,
  folha_id INT NULL,
  folha_item_id INT NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(120),
  file_size INT NOT NULL DEFAULT 0,
  numero_nf VARCHAR(60),
  valor_nf DECIMAL(12,2),
  cnpj_emitente VARCHAR(14),
  status ENUM('validada', 'divergente', 'pendente') NOT NULL DEFAULT 'pendente',
  divergencias TEXT NULL,
  uploaded_by INT NULL,
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_nf_prestador
    FOREIGN KEY (prestador_id) REFERENCES prestadores(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_nf_folha
    FOREIGN KEY (folha_id) REFERENCES folhas(id)
    ON DELETE SET NULL,
  CONSTRAINT fk_nf_item
    FOREIGN KEY (folha_item_id) REFERENCES folha_itens(id)
    ON DELETE SET NULL,
  CONSTRAINT fk_nf_usuario
    FOREIGN KEY (uploaded_by) REFERENCES usuarios(id)
    ON DELETE SET NULL,
  KEY idx_nf_competencia_prestador (competencia, prestador_id, criado_em)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE nf_followups (
  id INT AUTO_INCREMENT PRIMARY KEY,
  competencia CHAR(7) NOT NULL,
  prestador_id INT NOT NULL,
  enviado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  canal VARCHAR(30) NOT NULL DEFAULT 'whatsapp',
  status ENUM('enviado', 'erro') NOT NULL DEFAULT 'enviado',
  erro TEXT NULL,
  KEY idx_nf_followups_dia (competencia, prestador_id, enviado_em),
  CONSTRAINT fk_followup_prestador
    FOREIGN KEY (prestador_id) REFERENCES prestadores(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sessoes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  usuario_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expira_em DATETIME NOT NULL,
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sessoes_usuario
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    ON DELETE CASCADE,
  UNIQUE KEY uq_sessoes_token (token_hash),
  KEY idx_sessoes_expira (expira_em)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE prestadores (
  id INT AUTO_INCREMENT PRIMARY KEY,
  unidade_id INT NULL,
  funcao_id INT NULL,
  categoria_id INT NULL,
  departamento_id INT NULL,
  projeto_id INT NULL,
  cargo_nivel ENUM('gestao', 'operacao') NOT NULL DEFAULT 'operacao',
  omie_codigo_cliente BIGINT NULL,
  omie_codigo_integracao VARCHAR(60) NULL,
  nome VARCHAR(160) NOT NULL,
  cpf CHAR(11) NOT NULL,
  cnpj CHAR(14) NOT NULL,
  razao_social VARCHAR(180) NOT NULL,
  email VARCHAR(160),
  telefone VARCHAR(40),
  data_admissao DATE,
  salario_contrato DECIMAL(12,2) NOT NULL DEFAULT 0,
  banco VARCHAR(120),
  agencia VARCHAR(30),
  conta VARCHAR(40),
  pix_cpf_cnpj VARCHAR(32),
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  data_rescisao DATE NULL,
  motivo_rescisao TEXT,
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_prestadores_unidade
    FOREIGN KEY (unidade_id) REFERENCES unidades(id)
    ON DELETE SET NULL,
  CONSTRAINT fk_prestadores_funcao
    FOREIGN KEY (funcao_id) REFERENCES funcoes(id)
    ON DELETE SET NULL,
  CONSTRAINT fk_prestadores_categoria
    FOREIGN KEY (categoria_id) REFERENCES categorias(id)
    ON DELETE SET NULL,
  CONSTRAINT fk_prestadores_departamento
    FOREIGN KEY (departamento_id) REFERENCES departamentos(id)
    ON DELETE SET NULL,
  CONSTRAINT fk_prestadores_projeto
    FOREIGN KEY (projeto_id) REFERENCES projetos(id)
    ON DELETE SET NULL,
  UNIQUE KEY uq_prestadores_cpf (cpf),
  UNIQUE KEY uq_prestadores_cnpj (cnpj)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE folhas (
  id INT AUTO_INCREMENT PRIMARY KEY,
  competencia CHAR(7) NOT NULL,
  dias_mes INT NOT NULL,
  status ENUM('aberta', 'fechada') NOT NULL DEFAULT 'fechada',
  fechado_em DATETIME,
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_folhas_competencia (competencia)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE rescisoes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  prestador_id INT NOT NULL,
  data_rescisao DATE NOT NULL,
  competencia CHAR(7) NOT NULL,
  dias_mes INT NOT NULL,
  dias_trabalhados INT NOT NULL,
  salario_base DECIMAL(12,2) NOT NULL,
  valor_proporcional DECIMAL(12,2) NOT NULL,
  adiantamentos_abertos DECIMAL(12,2) NOT NULL DEFAULT 0,
  descontos_manual DECIMAL(12,2) NOT NULL DEFAULT 0,
  valor_total_pagar DECIMAL(12,2) NOT NULL,
  motivo TEXT,
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_rescisoes_prestador
    FOREIGN KEY (prestador_id) REFERENCES prestadores(id)
    ON DELETE CASCADE,
  UNIQUE KEY uq_rescisao_prestador (prestador_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE adiantamentos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  prestador_id INT NOT NULL,
  data_adiantamento DATE NOT NULL,
  valor_total DECIMAL(12,2) NOT NULL,
  parcelas INT NOT NULL DEFAULT 1,
  competencia_inicial CHAR(7) NOT NULL,
  observacao TEXT,
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_adiantamentos_prestador
    FOREIGN KEY (prestador_id) REFERENCES prestadores(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE adiantamento_parcelas (
  id INT AUTO_INCREMENT PRIMARY KEY,
  adiantamento_id INT NOT NULL,
  competencia CHAR(7) NOT NULL,
  numero_parcela INT NOT NULL,
  valor DECIMAL(12,2) NOT NULL,
  descontado TINYINT(1) NOT NULL DEFAULT 0,
  folha_id INT NULL,
  CONSTRAINT fk_parcelas_adiantamento
    FOREIGN KEY (adiantamento_id) REFERENCES adiantamentos(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_parcelas_folha
    FOREIGN KEY (folha_id) REFERENCES folhas(id)
    ON DELETE SET NULL,
  KEY idx_parcelas_competencia (competencia, descontado)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE folha_itens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  folha_id INT NOT NULL,
  prestador_id INT NOT NULL,
  dias_trabalhados INT NOT NULL,
  salario_base DECIMAL(12,2) NOT NULL,
  valor_dias DECIMAL(12,2) NOT NULL,
  adicoes DECIMAL(12,2) NOT NULL DEFAULT 0,
  bonus DECIMAL(12,2) NOT NULL DEFAULT 0,
  descontos_manual DECIMAL(12,2) NOT NULL DEFAULT 0,
  desconto_adiantamentos DECIMAL(12,2) NOT NULL DEFAULT 0,
  valor_nf_previsto DECIMAL(12,2) NOT NULL DEFAULT 0,
  valor_nf_emitida DECIMAL(12,2) NOT NULL DEFAULT 0,
  numero_nf VARCHAR(40),
  liquido_pagar DECIMAL(12,2) NOT NULL DEFAULT 0,
  observacao TEXT,
  omie_status ENUM('pendente', 'integrado', 'erro') NOT NULL DEFAULT 'pendente',
  omie_codigo_lancamento BIGINT NULL,
  omie_codigo_integracao VARCHAR(60) NULL,
  omie_erro TEXT NULL,
  omie_integrado_em DATETIME NULL,
  CONSTRAINT fk_folha_itens_folha
    FOREIGN KEY (folha_id) REFERENCES folhas(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_folha_itens_prestador
    FOREIGN KEY (prestador_id) REFERENCES prestadores(id)
    ON DELETE CASCADE,
  UNIQUE KEY uq_item_folha_prestador (folha_id, prestador_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE VIEW vw_folhas_resumo AS
SELECT
  f.id,
  f.competencia,
  f.dias_mes,
  f.status,
  f.fechado_em,
  COUNT(fi.id) AS prestadores,
  COALESCE(SUM(fi.valor_nf_previsto), 0) AS nf_previsto_total,
  COALESCE(SUM(fi.desconto_adiantamentos + fi.descontos_manual), 0) AS descontos_total,
  COALESCE(SUM(fi.liquido_pagar), 0) AS liquido_total
FROM folhas f
LEFT JOIN folha_itens fi ON fi.folha_id = f.id
GROUP BY f.id;
