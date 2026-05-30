const express = require("express");
const mysql = require("mysql2/promise");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");
const multer = require("multer");
const { XMLParser } = require("fast-xml-parser");
const { PDFParse } = require("pdf-parse");
const { readEnv, writeEnv } = require("./env-store");
require("dotenv").config();

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const execFileAsync = promisify(execFile);
const permissionKeys = [
  "view_prestadores",
  "edit_prestadores",
  "view_folhas",
  "close_folhas",
  "reopen_folhas",
  "approve_folhas",
  "generate_reports",
  "integrate_omie",
  "view_values_open",
  "view_values_closed",
  "manage_adiantamentos",
  "manage_rescisoes",
  "manage_cadastros",
  "manage_users",
  "manage_omie_config",
  "manage_smtp",
  "reembolso_acessar",
  "reembolso_solicitar",
  "reembolso_aprovar",
  "reembolso_financeiro",
  "reembolso_admin",
  "reembolso_integrar_omie",
  "reembolso_relatorio",
];

const defaultPermissionsByPerfil = {
  master: Object.fromEntries(permissionKeys.map((key) => [key, true])),
  administrador: Object.fromEntries(permissionKeys.map((key) => [key, true])),
  financeiro: {
    view_prestadores: true,
    view_folhas: true,
    generate_reports: true,
    integrate_omie: true,
    view_values_closed: true,
    reembolso_acessar: true,
    reembolso_financeiro: true,
    reembolso_relatorio: true,
    reembolso_integrar_omie: true,
  },
  operacional: {
    view_prestadores: true,
    edit_prestadores: true,
    view_folhas: true,
    view_values_open: true,
    view_values_closed: true,
    manage_adiantamentos: true,
    manage_rescisoes: true,
    manage_cadastros: true,
    reembolso_acessar: true,
    reembolso_solicitar: true,
  },
  aprovador: {
    view_folhas: true,
    approve_folhas: true,
    view_values_open: true,
    view_values_closed: true,
    reembolso_acessar: true,
    reembolso_aprovar: true,
    reembolso_relatorio: true,
  },
  consulta: {
    view_prestadores: true,
    reembolso_acessar: true,
    reembolso_solicitar: true,
  },
};

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 8,
  queueLimit: 0,
  dateStrings: true,
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const perfis = ["master", "administrador", "financeiro", "operacional", "aprovador", "consulta"];
const folhaApprovalOrder = ["simone", "paulo", "luciano"];
const shortApprovalOrder = ["simone", "paulo"];
const simoneExceptionPrestadorId = 23;
const allowOutOfOrderNfNumbers = false;
const sessionCookieName = "redefrete_session";
const uploadsDir = path.join(__dirname, "uploads", "nfs");
fs.mkdirSync(uploadsDir, { recursive: true });
const defaultNfFolderRoot = path.join(process.env.USERPROFILE || "", "OneDrive - Redefrete", "FOLHA", "NF´s PJ");
const nfUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const safeExt = path.extname(file.originalname || "").toLowerCase().replace(/[^.\w]/g, "") || ".xml";
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${safeExt}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
});

const emailTemplateDefaults = {
  folha_nf: {
    nome: "Solicitação de NF - Folha PJ",
    assunto: "NF pendente - Folha PJ {{competencia}}",
    corpo: [
      "Olá, {{nome}}.",
      "",
      "Identificamos que a NF da competência {{competencia}} ainda está pendente no sistema.",
      "Valor previsto para emissão: {{valor}}.",
      "",
      "Por favor, envie a NF até {{prazo}} para {{email_destino_nf}}.",
      "",
      "Obrigado.",
    ].join("\n"),
  },
  rescisao_nf: {
    nome: "Solicitação de NF - Rescisão PJ",
    assunto: "NF de rescisão PJ - {{razao_social}}",
    corpo: [
      "Olá, {{nome}}.",
      "",
      "A rescisão do contrato PJ foi iniciada no sistema.",
      "Valor previsto para emissão da NF de rescisão: {{valor}}.",
      "",
      "Por favor, envie a NF para {{email_destino_nf}} para que o processo siga para aprovação e finalização.",
      "",
      "Obrigado.",
    ].join("\n"),
  },
  aprovacao: {
    nome: "Solicitação de aprovação",
    assunto: "{{titulo}}",
    corpo: [
      "Olá, {{aprovador_nome}}.",
      "",
      "{{titulo}}",
      "{{detalhe}}",
      "",
      "Acesse o sistema para revisar e aprovar:",
      "{{link}}",
      "",
      "Obrigado.",
    ].join("\n"),
  },
};

function parseCookies(req) {
  return String(req.headers.cookie || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((acc, item) => {
      const index = item.indexOf("=");
      if (index === -1) return acc;
      acc[decodeURIComponent(item.slice(0, index))] = decodeURIComponent(item.slice(index + 1));
      return acc;
    }, {});
}

function sessionCookie(token, maxAge = 60 * 60 * 12) {
  return [
    `${sessionCookieName}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [method, salt, hash] = String(stored || "").split(":");
  if (method !== "scrypt" || !salt || !hash) return false;
  const candidate = crypto.scryptSync(String(password), salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), candidate);
}

function parsePermissions(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function permissionsForUser(user) {
  const defaults = defaultPermissionsByPerfil[user?.perfil] || {};
  const explicit = parsePermissions(user?.permissoes_json);
  const permissions = {};
  for (const key of permissionKeys) {
    permissions[key] = Boolean(explicit[key] ?? defaults[key] ?? false);
  }
  if (["master", "administrador"].includes(user?.perfil)) {
    for (const key of permissionKeys) permissions[key] = true;
  }
  return permissions;
}

function normalizePermissions(input, perfil) {
  const defaults = defaultPermissionsByPerfil[perfil] || {};
  const source = input && typeof input === "object" ? input : defaults;
  const permissions = {};
  for (const key of permissionKeys) {
    permissions[key] = Boolean(source[key] ?? defaults[key] ?? false);
  }
  if (["master", "administrador"].includes(perfil)) {
    for (const key of permissionKeys) permissions[key] = true;
  }
  return permissions;
}

function publicUser(user) {
  if (!user) return null;
  const explicitPermissions = parsePermissions(user.permissoes_json);
  const explicitKeys = Object.entries(explicitPermissions)
    .filter(([, value]) => Boolean(value))
    .map(([key]) => key);
  const isReembolsoOnly = Number(user.prestador_id || user.resolved_prestador_id || 0) > 0
    && String(user.perfil || "").toLowerCase() === "consulta"
    && explicitKeys.some((key) => key.startsWith("reembolso_"))
    && !explicitKeys.some((key) => !key.startsWith("reembolso_"));
  return {
    id: user.id,
    nome: user.nome,
    email: user.email,
    perfil: user.perfil,
    permissoes: permissionsForUser(user),
    access_scope: isReembolsoOnly ? "reembolso" : "geral",
    primeiro_acesso: !user.senha_hash,
    prestador_id: user.prestador_id || null,
    prestador_nome: user.prestador_nome || null,
    prestador_razao_social: user.prestador_razao_social || null,
    prestador_cpf: user.prestador_cpf || null,
    ativo: Boolean(user.ativo),
  };
}

async function ensureAuthSchema() {
  const addColumnIfMissing = async (table, column, ddl) => {
    const [[existing]] = await pool.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
      [table, column],
    );
    if (!existing) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  const dropIndexIfExists = async (table, indexName) => {
    const [[existing]] = await pool.query(
      "SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1",
      [table, indexName],
    );
    if (existing) await pool.query(`ALTER TABLE ${table} DROP INDEX ${indexName}`);
  };
  const addIndexIfMissing = async (table, indexName, ddl) => {
    const [[existing]] = await pool.query(
      "SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1",
      [table, indexName],
    );
    if (!existing) await pool.query(`ALTER TABLE ${table} ADD ${ddl}`);
  };

  const [[prestadoresTable]] = await pool.query(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prestadores'",
  );
  if (prestadoresTable) {
    await addColumnIfMissing("prestadores", "cargo_nivel", "cargo_nivel ENUM('gestao', 'operacao') NOT NULL DEFAULT 'operacao' AFTER projeto_id");
    await addColumnIfMissing("prestadores", "cliente_id", "cliente_id INT NULL AFTER unidade_id");
    await addColumnIfMissing("prestadores", "precificacao_tipo", "precificacao_tipo ENUM('mensal', 'diaria') NOT NULL DEFAULT 'mensal' AFTER cargo_nivel");
    await addColumnIfMissing("prestadores", "valor_dia", "valor_dia DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER precificacao_tipo");
    await addColumnIfMissing("prestadores", "rescisao_multa_percentual", "rescisao_multa_percentual DECIMAL(8,2) NOT NULL DEFAULT 0 AFTER cargo_nivel");
    await addColumnIfMissing("prestadores", "rescisao_multa_empresa_percentual", "rescisao_multa_empresa_percentual DECIMAL(8,2) NOT NULL DEFAULT 0 AFTER rescisao_multa_percentual");
    await addColumnIfMissing("prestadores", "rescisao_multa_prestador_percentual", "rescisao_multa_prestador_percentual DECIMAL(8,2) NOT NULL DEFAULT 0 AFTER rescisao_multa_empresa_percentual");
    await pool.query("UPDATE prestadores SET rescisao_multa_prestador_percentual = rescisao_multa_percentual WHERE rescisao_multa_prestador_percentual = 0 AND rescisao_multa_percentual > 0");
    await addColumnIfMissing("prestadores", "omie_codigo_cliente", "omie_codigo_cliente BIGINT NULL AFTER cargo_nivel");
    await addColumnIfMissing("prestadores", "omie_codigo_integracao", "omie_codigo_integracao VARCHAR(60) NULL AFTER omie_codigo_cliente");
    await pool.query(`
      UPDATE prestadores p
      JOIN projetos pr ON pr.id = p.projeto_id
      SET p.cliente_id = pr.cliente_id
      WHERE p.cliente_id IS NULL
        AND pr.cliente_id IS NOT NULL
    `);
  }

  const [[folhaItensTable]] = await pool.query(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'folha_itens'",
  );
  if (folhaItensTable) {
    await addColumnIfMissing("folha_itens", "lote_id", "lote_id INT NULL AFTER folha_id");
    await addColumnIfMissing("folha_itens", "omie_status", "omie_status ENUM('pendente', 'integrado', 'erro') NOT NULL DEFAULT 'pendente' AFTER observacao");
    await addColumnIfMissing("folha_itens", "omie_codigo_lancamento", "omie_codigo_lancamento BIGINT NULL AFTER omie_status");
    await addColumnIfMissing("folha_itens", "omie_codigo_integracao", "omie_codigo_integracao VARCHAR(60) NULL AFTER omie_codigo_lancamento");
    await addColumnIfMissing("folha_itens", "omie_erro", "omie_erro TEXT NULL AFTER omie_codigo_integracao");
    await addColumnIfMissing("folha_itens", "omie_integrado_em", "omie_integrado_em DATETIME NULL AFTER omie_erro");
    await addColumnIfMissing("folha_itens", "prestador_nome", "prestador_nome VARCHAR(160) NULL AFTER prestador_id");
    await addColumnIfMissing("folha_itens", "prestador_razao_social", "prestador_razao_social VARCHAR(180) NULL AFTER prestador_nome");
    await addColumnIfMissing("folha_itens", "prestador_cpf", "prestador_cpf VARCHAR(14) NULL AFTER prestador_razao_social");
    await addColumnIfMissing("folha_itens", "prestador_cnpj", "prestador_cnpj VARCHAR(18) NULL AFTER prestador_cpf");
    await addColumnIfMissing("folha_itens", "prestador_email", "prestador_email VARCHAR(160) NULL AFTER prestador_cnpj");
    await addColumnIfMissing("folha_itens", "prestador_telefone", "prestador_telefone VARCHAR(40) NULL AFTER prestador_email");
    await addColumnIfMissing("folha_itens", "funcao_snapshot", "funcao_snapshot VARCHAR(120) NULL AFTER prestador_telefone");
    await addColumnIfMissing("folha_itens", "categoria_snapshot", "categoria_snapshot VARCHAR(120) NULL AFTER funcao_snapshot");
    await addColumnIfMissing("folha_itens", "categoria_omie_codigo_snapshot", "categoria_omie_codigo_snapshot VARCHAR(20) NULL AFTER categoria_snapshot");
    await addColumnIfMissing("folha_itens", "departamento_snapshot", "departamento_snapshot VARCHAR(120) NULL AFTER categoria_omie_codigo_snapshot");
    await addColumnIfMissing("folha_itens", "projeto_snapshot", "projeto_snapshot VARCHAR(120) NULL AFTER departamento_snapshot");
    await addColumnIfMissing("folha_itens", "unidade_nome_snapshot", "unidade_nome_snapshot VARCHAR(120) NULL AFTER projeto_snapshot");
    await addColumnIfMissing("folha_itens", "cargo_nivel_snapshot", "cargo_nivel_snapshot VARCHAR(20) NULL AFTER unidade_nome_snapshot");
    await addColumnIfMissing("folha_itens", "precificacao_tipo_snapshot", "precificacao_tipo_snapshot VARCHAR(20) NULL AFTER cargo_nivel_snapshot");
    await addColumnIfMissing("folha_itens", "valor_dia_snapshot", "valor_dia_snapshot DECIMAL(12,2) NULL AFTER precificacao_tipo_snapshot");
    await addColumnIfMissing("folha_itens", "data_admissao_snapshot", "data_admissao_snapshot DATE NULL AFTER valor_dia_snapshot");
    await addColumnIfMissing("folha_itens", "data_rescisao_snapshot", "data_rescisao_snapshot DATE NULL AFTER data_admissao_snapshot");
    await addColumnIfMissing("folha_itens", "banco_snapshot", "banco_snapshot VARCHAR(80) NULL AFTER data_rescisao_snapshot");
    await addColumnIfMissing("folha_itens", "agencia_snapshot", "agencia_snapshot VARCHAR(40) NULL AFTER banco_snapshot");
    await addColumnIfMissing("folha_itens", "conta_snapshot", "conta_snapshot VARCHAR(60) NULL AFTER agencia_snapshot");
    await addColumnIfMissing("folha_itens", "omie_codigo_cliente_snapshot", "omie_codigo_cliente_snapshot BIGINT NULL AFTER conta_snapshot");
    await addColumnIfMissing("folha_itens", "omie_codigo_integracao_snapshot", "omie_codigo_integracao_snapshot VARCHAR(60) NULL AFTER omie_codigo_cliente_snapshot");
    await pool.query(`
      UPDATE folha_itens fi
      JOIN prestadores p ON p.id = fi.prestador_id
      LEFT JOIN unidades u ON u.id = p.unidade_id
      LEFT JOIN clientes cli ON cli.id = p.cliente_id
      LEFT JOIN funcoes fn ON fn.id = p.funcao_id
      LEFT JOIN categorias c ON c.id = p.categoria_id
      LEFT JOIN departamentos d ON d.id = p.departamento_id
      LEFT JOIN projetos pr ON pr.id = p.projeto_id
      SET
        fi.prestador_nome = COALESCE(fi.prestador_nome, p.nome),
        fi.prestador_razao_social = COALESCE(fi.prestador_razao_social, p.razao_social),
        fi.prestador_cpf = COALESCE(fi.prestador_cpf, p.cpf),
        fi.prestador_cnpj = COALESCE(fi.prestador_cnpj, p.cnpj),
        fi.prestador_email = COALESCE(fi.prestador_email, p.email),
        fi.prestador_telefone = COALESCE(fi.prestador_telefone, p.telefone),
        fi.funcao_snapshot = COALESCE(fi.funcao_snapshot, fn.nome),
        fi.categoria_snapshot = COALESCE(fi.categoria_snapshot, c.nome),
        fi.categoria_omie_codigo_snapshot = COALESCE(fi.categoria_omie_codigo_snapshot, c.omie_codigo),
        fi.departamento_snapshot = COALESCE(fi.departamento_snapshot, d.nome),
        fi.projeto_snapshot = COALESCE(fi.projeto_snapshot, pr.nome),
        fi.unidade_nome_snapshot = COALESCE(fi.unidade_nome_snapshot, COALESCE(cli.nome, u.nome)),
        fi.cargo_nivel_snapshot = COALESCE(fi.cargo_nivel_snapshot, p.cargo_nivel),
        fi.precificacao_tipo_snapshot = COALESCE(fi.precificacao_tipo_snapshot, p.precificacao_tipo),
        fi.valor_dia_snapshot = COALESCE(fi.valor_dia_snapshot, p.valor_dia),
        fi.data_admissao_snapshot = COALESCE(fi.data_admissao_snapshot, p.data_admissao),
        fi.data_rescisao_snapshot = COALESCE(fi.data_rescisao_snapshot, p.data_rescisao),
        fi.banco_snapshot = COALESCE(fi.banco_snapshot, p.banco),
        fi.agencia_snapshot = COALESCE(fi.agencia_snapshot, p.agencia),
        fi.conta_snapshot = COALESCE(fi.conta_snapshot, p.conta),
        fi.omie_codigo_cliente_snapshot = COALESCE(fi.omie_codigo_cliente_snapshot, p.omie_codigo_cliente),
        fi.omie_codigo_integracao_snapshot = COALESCE(fi.omie_codigo_integracao_snapshot, p.omie_codigo_integracao)
      WHERE fi.prestador_nome IS NULL
         OR fi.prestador_razao_social IS NULL
         OR fi.prestador_cnpj IS NULL
    `);
  }

  const [[folhasTable]] = await pool.query(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'folhas'",
  );
  if (folhasTable) {
    await pool.query("ALTER TABLE folhas MODIFY status ENUM('aberta', 'em_aprovacao', 'reprovada', 'fechada') NOT NULL DEFAULT 'aberta'");
    await addColumnIfMissing("folhas", "approval_payload_hash", "approval_payload_hash CHAR(64) NULL AFTER status");
    await addColumnIfMissing("folhas", "approval_rejeitado_por", "approval_rejeitado_por INT NULL AFTER approval_payload_hash");
    await addColumnIfMissing("folhas", "approval_rejeitado_em", "approval_rejeitado_em DATETIME NULL AFTER approval_rejeitado_por");
    await addColumnIfMissing("folhas", "approval_rejeicao_motivo", "approval_rejeicao_motivo TEXT NULL AFTER approval_rejeitado_em");
  }

  const [[categoriasTable]] = await pool.query(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'categorias'",
  );
  if (categoriasTable) {
    await addColumnIfMissing("categorias", "omie_codigo", "omie_codigo VARCHAR(20) NULL AFTER nome");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS clientes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nome VARCHAR(120) NOT NULL,
      ativo TINYINT(1) NOT NULL DEFAULT 1,
      criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_clientes_nome (nome)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  for (const nome of ["REDEFRETE", "MAGALU", "AMAZON", "MERCADO LIVRE", "SHOPEE", "BIMBO"]) {
    await pool.query(
      "INSERT INTO clientes (nome, ativo) VALUES (?, 1) ON DUPLICATE KEY UPDATE ativo = 1",
      [nome],
    );
  }
  await addColumnIfMissing("projetos", "cliente_id", "cliente_id INT NULL AFTER nome");
  const operacoesPorCliente = [
    ["REDEFRETE", "REDEFRETE"],
    ["MAGALU", "MAGALU LM"],
    ["AMAZON", "AMAZON EDSP"],
    ["AMAZON", "AMAZON FM"],
    ["MERCADO LIVRE", "MERCADO LIVRE LM"],
    ["SHOPEE", "SHOPEE LM"],
    ["BIMBO", "BIMBO LM"],
  ];
  for (const [clienteNome, projetoNome] of operacoesPorCliente) {
    const [[cliente]] = await pool.query("SELECT id FROM clientes WHERE nome = ? LIMIT 1", [clienteNome]);
    if (!cliente) continue;
    await pool.query(
      `INSERT INTO projetos (nome, cliente_id, ativo) VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE cliente_id = VALUES(cliente_id), ativo = 1`,
      [projetoNome, cliente.id],
    );
  }
  await addColumnIfMissing("departamentos", "cliente_id", "cliente_id INT NULL AFTER nome");
  await addColumnIfMissing("departamentos", "projeto_id", "projeto_id INT NULL AFTER cliente_id");
  await addColumnIfMissing("departamentos", "omie_codigo", "omie_codigo VARCHAR(20) NULL AFTER projeto_id");
  const [[departamentoNomeIndex]] = await pool.query(
    "SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'departamentos' AND INDEX_NAME = 'uq_departamentos_nome' LIMIT 1",
  );
  if (departamentoNomeIndex) {
    await pool.query("ALTER TABLE departamentos DROP INDEX uq_departamentos_nome");
  }
  const [[departamentoContextoIndex]] = await pool.query(
    "SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'departamentos' AND INDEX_NAME = 'uq_departamentos_contexto' LIMIT 1",
  );
  if (!departamentoContextoIndex) {
    await pool.query("ALTER TABLE departamentos ADD UNIQUE KEY uq_departamentos_contexto (nome, cliente_id, projeto_id)");
  }

  const [[rescisoesTable]] = await pool.query(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rescisoes'",
  );
  if (rescisoesTable) {
    await pool.query("ALTER TABLE rescisoes MODIFY status ENUM('aguardando_nf', 'em_aprovacao', 'reprovada', 'finalizada', 'integrada_omie', 'erro_omie') NOT NULL DEFAULT 'aguardando_nf'");
    await addColumnIfMissing("rescisoes", "status", "status ENUM('aguardando_nf', 'em_aprovacao', 'finalizada', 'integrada_omie', 'erro_omie') NOT NULL DEFAULT 'aguardando_nf' AFTER motivo");
    await addColumnIfMissing("rescisoes", "nf_id", "nf_id INT NULL AFTER status");
    await addColumnIfMissing("rescisoes", "nf_status", "nf_status ENUM('pendente', 'validada', 'divergente') NOT NULL DEFAULT 'pendente' AFTER nf_id");
    await addColumnIfMissing("rescisoes", "numero_nf", "numero_nf VARCHAR(60) NULL AFTER nf_status");
    await addColumnIfMissing("rescisoes", "valor_nf_emitida", "valor_nf_emitida DECIMAL(12,2) NULL AFTER numero_nf");
    await addColumnIfMissing("rescisoes", "diferenca_nf", "diferenca_nf DECIMAL(12,2) NULL AFTER valor_nf_emitida");
    await addColumnIfMissing("rescisoes", "omie_status", "omie_status ENUM('pendente', 'integrado', 'erro') NOT NULL DEFAULT 'pendente' AFTER diferenca_nf");
    await addColumnIfMissing("rescisoes", "omie_codigo_lancamento", "omie_codigo_lancamento BIGINT NULL AFTER omie_status");
    await addColumnIfMissing("rescisoes", "omie_codigo_integracao", "omie_codigo_integracao VARCHAR(60) NULL AFTER omie_codigo_lancamento");
    await addColumnIfMissing("rescisoes", "omie_erro", "omie_erro TEXT NULL AFTER omie_codigo_integracao");
    await addColumnIfMissing("rescisoes", "omie_integrado_em", "omie_integrado_em DATETIME NULL AFTER omie_erro");
    await addColumnIfMissing("rescisoes", "finalizada_em", "finalizada_em DATETIME NULL AFTER omie_integrado_em");
    await addColumnIfMissing("rescisoes", "data_aviso", "data_aviso DATE NULL AFTER data_rescisao");
    await addColumnIfMissing("rescisoes", "tipo_rescisao", "tipo_rescisao ENUM('empresa', 'prestador') NOT NULL DEFAULT 'empresa' AFTER data_aviso");
    await addColumnIfMissing("rescisoes", "aviso_dias", "aviso_dias INT NOT NULL DEFAULT 0 AFTER tipo_rescisao");
    await addColumnIfMissing("rescisoes", "aviso_cumprido", "aviso_cumprido TINYINT(1) NOT NULL DEFAULT 0 AFTER aviso_dias");
    await addColumnIfMissing("rescisoes", "multa_percentual", "multa_percentual DECIMAL(8,2) NOT NULL DEFAULT 0 AFTER aviso_cumprido");
    await addColumnIfMissing("rescisoes", "valor_multa", "valor_multa DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER multa_percentual");
    await addColumnIfMissing("rescisoes", "approval_payload_hash", "approval_payload_hash CHAR(64) NULL AFTER status");
    await addColumnIfMissing("rescisoes", "approval_rejeitado_por", "approval_rejeitado_por INT NULL AFTER approval_payload_hash");
    await addColumnIfMissing("rescisoes", "approval_rejeitado_em", "approval_rejeitado_em DATETIME NULL AFTER approval_rejeitado_por");
    await addColumnIfMissing("rescisoes", "approval_rejeicao_motivo", "approval_rejeicao_motivo TEXT NULL AFTER approval_rejeitado_em");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query("ALTER TABLE usuarios MODIFY perfil ENUM('master', 'administrador', 'financeiro', 'operacional', 'aprovador', 'consulta') NOT NULL DEFAULT 'consulta'");
  await pool.query("ALTER TABLE usuarios MODIFY senha_hash VARCHAR(255) NULL");
  await addColumnIfMissing("usuarios", "permissoes_json", "permissoes_json JSON NULL AFTER perfil");
  await addColumnIfMissing("usuarios", "prestador_id", "prestador_id INT NULL AFTER permissoes_json");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessoes (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS folha_aprovacoes (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await addColumnIfMissing("folha_aprovacoes", "codigo_autenticacao", "codigo_autenticacao VARCHAR(24) NULL AFTER payload_hash");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS folha_lotes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      folha_id INT NOT NULL,
      competencia CHAR(7) NOT NULL,
      numero INT NOT NULL,
      status ENUM('em_aprovacao', 'reprovado', 'fechado', 'integrado_omie') NOT NULL DEFAULT 'em_aprovacao',
      payload_hash CHAR(64) NOT NULL,
      itens_json JSON NULL,
      criado_por INT NULL,
      criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      aprovado_em DATETIME NULL,
      fechado_em DATETIME NULL,
      integrado_em DATETIME NULL,
      rejeitado_por INT NULL,
      rejeitado_em DATETIME NULL,
      rejeicao_motivo TEXT NULL,
      CONSTRAINT fk_folha_lotes_folha
        FOREIGN KEY (folha_id) REFERENCES folhas(id)
        ON DELETE CASCADE,
      UNIQUE KEY uq_folha_lotes_numero (competencia, numero),
      KEY idx_folha_lotes_status (competencia, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await addColumnIfMissing("folha_lotes", "itens_json", "itens_json JSON NULL AFTER payload_hash");
  await addColumnIfMissing("folha_aprovacoes", "lote_id", "lote_id INT NULL AFTER competencia");
  await dropIndexIfExists("folha_aprovacoes", "uq_folha_aprovacao_usuario");
  await addIndexIfMissing("folha_aprovacoes", "uq_folha_aprovacao_lote_usuario", "UNIQUE KEY uq_folha_aprovacao_lote_usuario (competencia, lote_id, usuario_id)");
  await addIndexIfMissing("folha_aprovacoes", "idx_folha_aprovacoes_lote_hash", "KEY idx_folha_aprovacoes_lote_hash (lote_id, payload_hash)");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rescisao_aprovacoes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      rescisao_id INT NOT NULL,
      usuario_id INT NOT NULL,
      payload_hash CHAR(64) NOT NULL,
      codigo_autenticacao VARCHAR(24) NULL,
      aprovado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      comentario TEXT NULL,
      CONSTRAINT fk_rescisao_aprovacoes_rescisao
        FOREIGN KEY (rescisao_id) REFERENCES rescisoes(id)
        ON DELETE CASCADE,
      CONSTRAINT fk_rescisao_aprovacoes_usuario
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
        ON DELETE CASCADE,
      UNIQUE KEY uq_rescisao_aprovacao_usuario (rescisao_id, usuario_id),
      KEY idx_rescisao_aprovacoes_hash (rescisao_id, payload_hash)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await addColumnIfMissing("rescisao_aprovacoes", "codigo_autenticacao", "codigo_autenticacao VARCHAR(24) NULL AFTER payload_hash");
  await addColumnIfMissing("rescisao_aprovacoes", "decisao", "decisao ENUM('aprovado', 'reprovado') NOT NULL DEFAULT 'aprovado' AFTER codigo_autenticacao");

  const [[adiantamentosTable]] = await pool.query(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'adiantamentos'",
  );
  if (adiantamentosTable) {
    await addColumnIfMissing("adiantamentos", "status", "status ENUM('aberto', 'em_aprovacao', 'aprovado', 'reprovado') NOT NULL DEFAULT 'aberto' AFTER competencia_inicial");
    await addColumnIfMissing("adiantamentos", "approval_payload_hash", "approval_payload_hash CHAR(64) NULL AFTER status");
    await addColumnIfMissing("adiantamentos", "approval_rejeitado_por", "approval_rejeitado_por INT NULL AFTER approval_payload_hash");
    await addColumnIfMissing("adiantamentos", "approval_rejeitado_em", "approval_rejeitado_em DATETIME NULL AFTER approval_rejeitado_por");
    await addColumnIfMissing("adiantamentos", "approval_rejeicao_motivo", "approval_rejeicao_motivo TEXT NULL AFTER approval_rejeitado_em");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS adiantamento_aprovacoes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      adiantamento_id INT NOT NULL,
      usuario_id INT NOT NULL,
      payload_hash CHAR(64) NOT NULL,
      codigo_autenticacao VARCHAR(24) NULL,
      decisao ENUM('aprovado', 'reprovado') NOT NULL DEFAULT 'aprovado',
      aprovado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      comentario TEXT NULL,
      CONSTRAINT fk_adiantamento_aprovacoes_adiantamento
        FOREIGN KEY (adiantamento_id) REFERENCES adiantamentos(id)
        ON DELETE CASCADE,
      CONSTRAINT fk_adiantamento_aprovacoes_usuario
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
        ON DELETE CASCADE,
      UNIQUE KEY uq_adiantamento_aprovacao_usuario (adiantamento_id, usuario_id),
      KEY idx_adiantamento_aprovacoes_hash (adiantamento_id, payload_hash)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await addColumnIfMissing("folha_aprovacoes", "decisao", "decisao ENUM('aprovado', 'reprovado') NOT NULL DEFAULT 'aprovado' AFTER codigo_autenticacao");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS nf_arquivos (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS nf_followups (
      id INT AUTO_INCREMENT PRIMARY KEY,
      competencia CHAR(7) NOT NULL,
      prestador_id INT NOT NULL,
      enviado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      canal VARCHAR(30) NOT NULL DEFAULT 'email',
      status ENUM('enviado', 'erro') NOT NULL DEFAULT 'enviado',
      erro TEXT NULL,
      KEY idx_nf_followups_dia (competencia, prestador_id, enviado_em),
      CONSTRAINT fk_followup_prestador
        FOREIGN KEY (prestador_id) REFERENCES prestadores(id)
        ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query("ALTER TABLE nf_followups MODIFY canal VARCHAR(30) NOT NULL DEFAULT 'email'");
  await pool.query("ALTER TABLE nf_followups MODIFY status ENUM('enviado', 'erro', 'email_enviado', 'email_erro') NOT NULL DEFAULT 'enviado'");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS folha_rascunhos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      competencia CHAR(7) NOT NULL,
      prestador_id INT NOT NULL,
      dias_trabalhados DECIMAL(8,2) NULL,
      adicoes DECIMAL(12,2) NOT NULL DEFAULT 0,
      bonus DECIMAL(12,2) NOT NULL DEFAULT 0,
      descontos_manual DECIMAL(12,2) NOT NULL DEFAULT 0,
      valor_nf_emitida DECIMAL(12,2) NOT NULL DEFAULT 0,
      numero_nf VARCHAR(60) NULL,
      observacao TEXT NULL,
      usuario_id INT NULL,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_folha_rascunho_item (competencia, prestador_id),
      KEY idx_folha_rascunhos_competencia (competencia)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS nf_email_imports (
      id INT AUTO_INCREMENT PRIMARY KEY,
      message_key VARCHAR(255) NOT NULL,
      graph_message_id TEXT NULL,
      internet_message_id VARCHAR(255) NULL,
      conversation_id VARCHAR(255) NULL,
      subject VARCHAR(500) NULL,
      from_email VARCHAR(255) NULL,
      received_at DATETIME NULL,
      competencia CHAR(7) NULL,
      status ENUM('processado', 'ignorado', 'erro') NOT NULL DEFAULT 'processado',
      resultado TEXT NULL,
      moved_to VARCHAR(120) NULL,
      processed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_nf_email_import_message (message_key),
      KEY idx_nf_email_import_competencia (competencia, processed_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_templates (
      tipo VARCHAR(40) PRIMARY KEY,
      nome VARCHAR(120) NOT NULL,
      assunto VARCHAR(220) NOT NULL,
      corpo TEXT NOT NULL,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  for (const [tipo, template] of Object.entries(emailTemplateDefaults)) {
    await pool.query(
      "INSERT IGNORE INTO email_templates (tipo, nome, assunto, corpo) VALUES (?, ?, ?, ?)",
      [tipo, template.nome, template.assunto, template.corpo],
    );
  }

  const [[admin]] = await pool.query("SELECT id FROM usuarios WHERE perfil = 'administrador' LIMIT 1");
  if (!admin) {
    await pool.query(
      "INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo) VALUES (?, ?, ?, 'administrador', 1)",
      ["Administrador", "admin@redefrete.com.br", hashPassword("Redefrete@2026")],
    );
  }
}

async function createSession(usuarioId) {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  await pool.query(
    "INSERT INTO sessoes (usuario_id, token_hash, expira_em) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 12 HOUR))",
    [usuarioId, tokenHash],
  );
  return token;
}

async function findUsuarioForLogin(login) {
  const cleanLogin = String(login || "").trim();
  const email = cleanLogin.toLowerCase();
  const cpf = onlyDigits(cleanLogin);
  const params = [email];
  let cpfWhere = "";
  if (cpf.length === 11) {
    cpfWhere = " OR p_link.cpf = ? OR p_email.cpf = ?";
    params.push(cpf, cpf);
  }
  const [[usuario]] = await pool.query(
    `SELECT u.*,
            COALESCE(p_link.id, p_email.id) AS resolved_prestador_id,
            COALESCE(p_link.nome, p_email.nome) AS prestador_nome,
            COALESCE(p_link.razao_social, p_email.razao_social) AS prestador_razao_social,
            COALESCE(p_link.cpf, p_email.cpf) AS prestador_cpf
       FROM usuarios u
       LEFT JOIN prestadores p_link ON p_link.id = u.prestador_id AND p_link.ativo = 1
       LEFT JOIN prestadores p_email ON LOWER(p_email.email) = LOWER(u.email) AND p_email.ativo = 1
      WHERE u.ativo = 1
        AND (LOWER(u.email) = ?${cpfWhere})
      ORDER BY CASE WHEN LOWER(u.email) = ? THEN 0 ELSE 1 END, u.id
      LIMIT 1`,
    [...params, email],
  );
  return usuario || null;
}

async function requireAuth(req, res, next) {
  try {
    const token = parseCookies(req)[sessionCookieName];
    if (!token) return res.status(401).json({ error: "Sessao expirada. Faça login novamente." });
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const [[session]] = await pool.query(
      `SELECT s.id AS sessao_id, u.id, u.nome, u.email, u.senha_hash, u.perfil, u.permissoes_json, u.prestador_id, u.ativo,
              p.nome AS prestador_nome, p.razao_social AS prestador_razao_social, p.cpf AS prestador_cpf
       FROM sessoes s
       JOIN usuarios u ON u.id = s.usuario_id
       LEFT JOIN prestadores p ON p.id = u.prestador_id AND p.ativo = 1
       WHERE s.token_hash = ? AND s.expira_em > NOW() AND u.ativo = 1`,
      [tokenHash],
    );
    if (!session) {
      res.setHeader("Set-Cookie", sessionCookie("", 0));
      return res.status(401).json({ error: "Sessao expirada. Faça login novamente." });
    }
    req.user = session;
    req.sessionTokenHash = tokenHash;
    return next();
  } catch {
    return res.status(500).json({ error: "Nao foi possivel validar a sessao." });
  }
}

function hasPerfil(user, allowed) {
  return allowed.includes(user?.perfil);
}

function isFullAccess(user) {
  return ["master", "administrador"].includes(user?.perfil);
}

function canUseSimoneException(user, prestadorId) {
  return isFullAccess(user) && Number(prestadorId || 0) === simoneExceptionPrestadorId;
}

function nfValidatedOrSimoneException(user, item) {
  return item?.nf_status === "validada" || canUseSimoneException(user, item?.prestador_id || item?.id);
}

function hasPermission(user, permission) {
  return Boolean(permissionsForUser(user)[permission]);
}

function canSeeSensitiveValues(user, context = {}) {
  if (isFullAccess(user)) return true;
  if (context.folhaStatus === "fechada") return hasPermission(user, "view_values_closed");
  return hasPermission(user, "view_values_open");
}

function canOperate(user) {
  return hasPermission(user, "edit_prestadores") || hasPermission(user, "manage_adiantamentos") || hasPermission(user, "manage_rescisoes");
}

function canViewFolhas(user) {
  return hasPermission(user, "view_folhas");
}

function canApproveFolha(user) {
  return hasPermission(user, "approve_folhas");
}

function canCloseFolha(user) {
  return hasPermission(user, "close_folhas");
}

function contractVisibilityWhere(user, alias = "p") {
  return "";
}

function sanitizePrestador(prestador, user, context = {}) {
  if (canSeeSensitiveValues(user, context)) return { ...prestador, can_view_values: true };
  return {
    ...prestador,
    salario_contrato: null,
    salario_base: null,
    can_view_values: false,
  };
}

function sanitizeFolhaItem(item, user, context = {}) {
  if (canSeeSensitiveValues(user, context)) return { ...item, can_view_values: true };
  return {
    ...item,
    salario_contrato: null,
    salario_base: null,
    valor_dias: null,
    adicoes: null,
    bonus: null,
    descontos_manual: null,
    desconto_adiantamentos: null,
    valor_nf_previsto: null,
    valor_nf_emitida: null,
    liquido_pagar: null,
    diferenca_nf: null,
    nf_valor: null,
    can_view_values: false,
  };
}

function sanitizeFolhaResumo(row, user) {
  if (canSeeSensitiveValues(user, { folhaStatus: row.status })) return row;
  return {
    ...row,
    nf_previsto_total: null,
    descontos_total: null,
    liquido_total: null,
  };
}

function normalizeApprovalItems(items = []) {
  return [...items]
    .map((item) => ({
      prestador_id: Number(item.prestador_id || item.id || 0),
      dias_trabalhados: Number(item.dias_trabalhados || 0),
      adicoes: money(item.adicoes),
      bonus: money(item.bonus),
      descontos_manual: money(item.descontos_manual),
      valor_nf_emitida: money(item.valor_nf_emitida),
      numero_nf: normalizeNfNumber(item.numero_nf),
    }))
    .filter((item) => item.prestador_id > 0)
    .sort((a, b) => a.prestador_id - b.prestador_id);
}

function approvalPayloadHash(competencia, items = [], loteId = null) {
  const payload = JSON.stringify({ competencia, loteId: loteId ? Number(loteId) : null, itens: normalizeApprovalItems(items) });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function approvalAuthCode(competencia, usuarioId, payloadHash, loteId = null) {
  const seed = `${competencia}:${loteId || "geral"}:${usuarioId}:${payloadHash}:${process.env.OMIE_APP_KEY || "redefrete"}`;
  const code = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 12).toUpperCase();
  return `APR-${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

function isMandatoryApprover(user) {
  return hasPermission(user, "approve_folhas") && !isFullAccess(user);
}

async function getFolhaApprovals(competencia, payloadHash, db = pool, loteId = null) {
  const [rows] = await db.query(
    `SELECT fa.id, fa.competencia, fa.usuario_id, fa.payload_hash, fa.codigo_autenticacao, fa.decisao, fa.aprovado_em, fa.comentario,
      u.nome, u.email, u.perfil
     FROM folha_aprovacoes fa
     JOIN usuarios u ON u.id = fa.usuario_id
     WHERE fa.competencia = ? AND fa.payload_hash = ? AND fa.decisao = 'aprovado'
       AND ${loteId ? "fa.lote_id = ?" : "fa.lote_id IS NULL"}
     ORDER BY fa.aprovado_em ASC`,
    loteId ? [competencia, payloadHash, loteId] : [competencia, payloadHash],
  );
  const mandatoryApprovers = await getMandatoryApprovers(db, "folha");
  const approvedMandatoryIds = new Set(
    rows
      .filter((row) => mandatoryApprovers.some((user) => Number(user.id) === Number(row.usuario_id)))
      .map((row) => Number(row.usuario_id)),
  );
  const pendentes = mandatoryApprovers
    .filter((user) => !approvedMandatoryIds.has(Number(user.id)))
    .map((user) => ({ id: user.id, nome: user.nome, email: user.email, perfil: user.perfil }));

  return {
    required: mandatoryApprovers.length,
    count: approvedMandatoryIds.size,
    totalAprovacoes: rows.length,
    approved: mandatoryApprovers.length > 0 && approvedMandatoryIds.size >= mandatoryApprovers.length,
    payloadHash,
    lote_id: loteId ? Number(loteId) : null,
    pendentes,
    proximo: pendentes[0] || null,
    aprovadores: rows.map((row) => ({
      id: row.usuario_id,
      nome: row.nome,
      email: row.email,
      perfil: row.perfil,
      codigo_autenticacao: row.codigo_autenticacao || approvalAuthCode(competencia, row.usuario_id, payloadHash, loteId),
      aprovado_em: row.aprovado_em,
      comentario: row.comentario,
    })),
  };
}

async function getFolhaApprovalsForItems(competencia, items, db = pool, loteId = null) {
  return getFolhaApprovals(competencia, approvalPayloadHash(competencia, items, loteId), db, loteId);
}

function normalizeRescisaoApprovalItem(rescisao) {
  return {
    rescisao_id: Number(rescisao.id || 0),
    prestador_id: Number(rescisao.prestador_id || 0),
    data_rescisao: String(rescisao.data_rescisao || "").slice(0, 10),
    data_aviso: String(rescisao.data_aviso || "").slice(0, 10),
    tipo_rescisao: String(rescisao.tipo_rescisao || "empresa"),
    aviso_dias: Number(rescisao.aviso_dias || 0),
    aviso_cumprido: Boolean(Number(rescisao.aviso_cumprido || 0)),
    competencia: String(rescisao.competencia || ""),
    dias_trabalhados: Number(rescisao.dias_trabalhados || 0),
    valor_proporcional: money(rescisao.valor_proporcional),
    multa_percentual: money(rescisao.multa_percentual),
    valor_multa: money(rescisao.valor_multa),
    adiantamentos_abertos: money(rescisao.adiantamentos_abertos),
    descontos_manual: money(rescisao.descontos_manual),
    valor_total_pagar: money(rescisao.valor_total_pagar),
    numero_nf: normalizeNfNumber(rescisao.numero_nf),
    valor_nf_emitida: money(rescisao.valor_nf_emitida),
  };
}

function rescisaoApprovalPayloadHash(rescisao) {
  const payload = JSON.stringify({ rescisao: normalizeRescisaoApprovalItem(rescisao) });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function rescisaoApprovalAuthCode(rescisaoId, usuarioId, payloadHash) {
  const seed = `RESCISAO:${rescisaoId}:${usuarioId}:${payloadHash}:${process.env.OMIE_APP_KEY || "redefrete"}`;
  const code = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 12).toUpperCase();
  return `RES-${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

function adiantamentoApprovalPayloadHash(adiantamento) {
  const payload = JSON.stringify({
    id: Number(adiantamento.id || 0),
    prestador_id: Number(adiantamento.prestador_id || 0),
    data_adiantamento: String(adiantamento.data_adiantamento || "").slice(0, 10),
    valor_total: money(adiantamento.valor_total),
    parcelas: Number(adiantamento.parcelas || 0),
    competencia_inicial: String(adiantamento.competencia_inicial || ""),
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function adiantamentoApprovalAuthCode(adiantamentoId, usuarioId, payloadHash) {
  const seed = `ADIANTAMENTO:${adiantamentoId}:${usuarioId}:${payloadHash}:${process.env.OMIE_APP_KEY || "redefrete"}`;
  const code = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 12).toUpperCase();
  return `ADI-${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

function reembolsoAuthCode(prefix) {
  return `${prefix}-${crypto.randomBytes(2).toString("hex").toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

const REEMBOLSO_APPROVAL_FLOW = [
  { email: "simone.oliveira@redefrete.com.br", etapa: "superior_simone", nome: "Simone Oliveira Gonçalves" },
  { email: "paulo.mendonca@redefrete.com.br", etapa: "superior_paulo", nome: "Paulo da Silva Mendonça" },
];

function reembolsoApprovalStepForUser(user) {
  const email = String(user?.email || "").toLowerCase();
  return REEMBOLSO_APPROVAL_FLOW.find((item) => item.email === email) || null;
}

async function reembolsoApprovedFlowSteps(prestacaoId) {
  const [rows] = await pool.query(
    `SELECT etapa, usuario_id
       FROM rd_reembolso_aprovacoes
      WHERE prestacao_id = ?
        AND decisao = 'aprovado'
        AND etapa IN (${REEMBOLSO_APPROVAL_FLOW.map(() => "?").join(",")})`,
    [prestacaoId, ...REEMBOLSO_APPROVAL_FLOW.map((item) => item.etapa)],
  );
  return rows;
}

async function nextReembolsoApprovalStep(prestacaoId) {
  const approved = await reembolsoApprovedFlowSteps(prestacaoId);
  const approvedEtapas = new Set(approved.map((item) => item.etapa));
  return REEMBOLSO_APPROVAL_FLOW.find((item) => !approvedEtapas.has(item.etapa)) || null;
}

async function getReembolsoApprovalState(prestacaoId, { includeFinanceiro = false, proximo = null } = {}) {
  const etapas = includeFinanceiro
    ? [...REEMBOLSO_APPROVAL_FLOW, { etapa: "financeiro", nome: "Financeiro" }]
    : REEMBOLSO_APPROVAL_FLOW;
  const [rows] = await pool.query(
    `SELECT a.etapa, a.decisao, a.autenticacao, a.created_at AS aprovado_em,
            u.id AS id, u.nome, u.email
       FROM rd_reembolso_aprovacoes a
       LEFT JOIN usuarios u ON u.id = a.usuario_id
      WHERE a.prestacao_id = ?
        AND a.decisao = 'aprovado'
        AND a.etapa IN (${etapas.map(() => "?").join(",")})
      ORDER BY a.created_at, a.id`,
    [prestacaoId, ...etapas.map((item) => item.etapa)],
  );
  const approvedEtapas = new Set(rows.map((item) => item.etapa));
  const aprovadores = rows.map((item) => ({
    id: item.id,
    nome: item.nome,
    email: item.email,
    etapa: etapas.find((step) => step.etapa === item.etapa)?.nome || item.etapa,
    etapa_codigo: item.etapa,
    autenticacao: item.autenticacao,
    aprovado_em: item.aprovado_em,
  }));
  const pendentes = etapas
    .filter((item) => !approvedEtapas.has(item.etapa))
    .map((item) => ({
      etapa: item.etapa,
      nome: item.nome,
      email: item.email || null,
    }));
  return {
    required: etapas.length,
    count: approvedEtapas.size,
    approved: approvedEtapas.size >= etapas.length,
    proximo,
    pendentes,
    aprovadores,
  };
}

function parseDateOnly(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  }
  const [year, month, day] = String(value || "").slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function startOfWeekMonday(date) {
  const result = new Date(date);
  const day = result.getUTCDay() || 7;
  result.setUTCDate(result.getUTCDate() - day + 1);
  return result;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function nextBusinessDay(date) {
  const result = new Date(date);
  while ([0, 6].includes(result.getUTCDay())) result.setUTCDate(result.getUTCDate() + 1);
  return result;
}

function calcularDataPagamentoReembolso(criadoEm, aprovadoEm) {
  const criado = parseDateOnly(criadoEm);
  const aprovado = parseDateOnly(aprovadoEm);
  if (!criado || !aprovado) return null;
  const semanaCriacao = startOfWeekMonday(criado);
  const quartaCorte = addDays(semanaCriacao, 2);
  const quintaCorte = addDays(semanaCriacao, 3);
  const sextaPagamento = addDays(semanaCriacao, 4);
  const aprovadoNaSemana = aprovado >= semanaCriacao && aprovado <= quintaCorte;
  const dentroDoCorte = criado <= quartaCorte && aprovadoNaSemana;
  return isoDate(nextBusinessDay(dentroDoCorte ? sextaPagamento : addDays(sextaPagamento, 7)));
}

function fallbackDataPagamentoReembolso() {
  const hoje = parseDateOnly(new Date());
  if (!hoje) return null;
  const semana = startOfWeekMonday(hoje);
  return isoDate(nextBusinessDay(addDays(semana, 11)));
}

async function getAdiantamentoApprovals(adiantamento, db = pool) {
  const payloadHash = adiantamentoApprovalPayloadHash(adiantamento);
  const [rows] = await db.query(
    `SELECT aa.id, aa.adiantamento_id, aa.usuario_id, aa.payload_hash, aa.codigo_autenticacao, aa.decisao, aa.aprovado_em, aa.comentario,
      u.nome, u.email, u.perfil
     FROM adiantamento_aprovacoes aa
     JOIN usuarios u ON u.id = aa.usuario_id
     WHERE aa.adiantamento_id = ? AND aa.payload_hash = ? AND aa.decisao = 'aprovado'
     ORDER BY aa.aprovado_em ASC`,
    [adiantamento.id, payloadHash],
  );
  const mandatoryApprovers = await getMandatoryApprovers(db, "adiantamento");
  const approvedMandatoryIds = new Set(
    rows
      .filter((row) => mandatoryApprovers.some((user) => Number(user.id) === Number(row.usuario_id)))
      .map((row) => Number(row.usuario_id)),
  );
  const pendentes = mandatoryApprovers
    .filter((user) => !approvedMandatoryIds.has(Number(user.id)))
    .map((user) => ({ id: user.id, nome: user.nome, email: user.email, perfil: user.perfil }));
  return {
    required: mandatoryApprovers.length,
    count: approvedMandatoryIds.size,
    approved: mandatoryApprovers.length > 0 && approvedMandatoryIds.size >= mandatoryApprovers.length,
    payloadHash,
    pendentes,
    proximo: pendentes[0] || null,
    aprovadores: rows.map((row) => ({
      id: row.usuario_id,
      nome: row.nome,
      email: row.email,
      perfil: row.perfil,
      codigo_autenticacao: row.codigo_autenticacao || adiantamentoApprovalAuthCode(adiantamento.id, row.usuario_id, payloadHash),
      aprovado_em: row.aprovado_em,
      comentario: row.comentario,
    })),
  };
}

async function getRescisaoApprovals(rescisao, db = pool) {
  const payloadHash = rescisaoApprovalPayloadHash(rescisao);
  const [rows] = await db.query(
    `SELECT ra.id, ra.rescisao_id, ra.usuario_id, ra.payload_hash, ra.codigo_autenticacao, ra.decisao, ra.aprovado_em, ra.comentario,
      u.nome, u.email, u.perfil
     FROM rescisao_aprovacoes ra
     JOIN usuarios u ON u.id = ra.usuario_id
     WHERE ra.rescisao_id = ? AND ra.payload_hash = ? AND ra.decisao = 'aprovado'
     ORDER BY ra.aprovado_em ASC`,
    [rescisao.id, payloadHash],
  );
  const mandatoryApprovers = await getMandatoryApprovers(db, "rescisao");
  const approvedMandatoryIds = new Set(
    rows
      .filter((row) => mandatoryApprovers.some((user) => Number(user.id) === Number(row.usuario_id)))
      .map((row) => Number(row.usuario_id)),
  );
  const pendentes = mandatoryApprovers
    .filter((user) => !approvedMandatoryIds.has(Number(user.id)))
    .map((user) => ({ id: user.id, nome: user.nome, email: user.email, perfil: user.perfil }));

  return {
    required: mandatoryApprovers.length,
    count: approvedMandatoryIds.size,
    totalAprovacoes: rows.length,
    approved: mandatoryApprovers.length > 0 && approvedMandatoryIds.size >= mandatoryApprovers.length,
    payloadHash,
    pendentes,
    proximo: pendentes[0] || null,
    aprovadores: rows.map((row) => ({
      id: row.usuario_id,
      nome: row.nome,
      email: row.email,
      perfil: row.perfil,
      codigo_autenticacao: row.codigo_autenticacao || rescisaoApprovalAuthCode(rescisao.id, row.usuario_id, payloadHash),
      aprovado_em: row.aprovado_em,
      comentario: row.comentario,
    })),
  };
}

function flattenObject(value, acc = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => flattenObject(item, acc));
    return acc;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => {
      acc.push([key, item]);
      flattenObject(item, acc);
    });
  }
  return acc;
}

function findXmlValue(root, names) {
  const wanted = names.map((name) => String(name).toLowerCase());
  const entries = flattenObject(root);
  const found = entries.find(([key, value]) => wanted.includes(String(key).toLowerCase()) && typeof value !== "object" && value !== "");
  return found ? String(found[1]).trim() : "";
}

function findXmlMoney(root, names) {
  const value = findXmlValue(root, names);
  if (!value) return null;
  const raw = String(value).trim();
  const normalized = raw.includes(",")
    ? raw.replace(/\./g, "").replace(",", ".")
    : raw.replace(/[^\d.-]/g, "");
  const number = Number(normalized);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : null;
}

function parseNfXml(filePath) {
  const xml = fs.readFileSync(filePath, "utf8");
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
  const data = parser.parse(xml);
  return {
    numero_nf: normalizeNfNumber(findXmlValue(data, ["nNFSe", "nNF", "NumeroNfse", "NumeroNFS-e", "Numero"])),
    valor_nf: findXmlMoney(data, ["vLiq", "vServ", "vNF", "ValorServicos", "ValorLiquidoNfse", "ValorTotalServicos"]),
    cnpj_emitente: onlyDigits(findXmlValue(data, ["CNPJ"])).slice(0, 14),
  };
}

function normalizePdfText(text) {
  return String(text || "").replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
}

function normalizeSearchText(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function firstRegex(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return String(match[1]).trim();
  }
  return "";
}

function parseBrazilMoney(value) {
  if (!value) return null;
  const clean = String(value).replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
  const number = Number(clean);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : null;
}

function pdfLines(text) {
  return normalizePdfText(text).split("\n").map((line) => line.trim()).filter(Boolean);
}

function pdfLineAfter(lines, labelFragment, valueRegex, maxLines = 12) {
  const index = lines.findIndex((line) => normalizeSearchText(line).includes(labelFragment));
  if (index < 0) return "";
  for (let cursor = index + 1; cursor < Math.min(lines.length, index + 1 + maxLines); cursor += 1) {
    if (valueRegex.test(lines[cursor])) return lines[cursor];
  }
  return "";
}

function parsePdfNumero(text, lines) {
  const byLine = pdfLineAfter(lines, "numero da nfs", /^\d{1,12}$/i, 15)
    || pdfLineAfter(lines, "numero da nota fiscal", /^\d{1,12}$/i, 15)
    || pdfLineAfter(lines, "numero da nota", /^\d{1,12}$/i, 10);
  if (byLine) return normalizeNfNumber(byLine);
  const searchable = normalizeSearchText(text);
  const byLayout = firstRegex(searchable, [
    /serie:\s*e\s*\n\s*(\d{1,12})\s*\n\s*numero da nota fiscal/i,
    /(\d{8,12})\s+\d{2}\/\d{2}\/\d{4}\s+e\s+\d{2}\/\d{4}/i,
  ]);
  if (byLayout) return normalizeNfNumber(byLayout);
  return normalizeNfNumber(firstRegex(text, [
    /N[úu]mero\s+da\s+Nota[\s\S]{0,80}?\n([0-9]{1,12})\n/i,
    /N[úu]mero\s+da\s+NFS-e[\s\S]{0,120}?\n([0-9]{1,12})\n/i,
    /N[úu]mero\s+da\s+Nota\s+Fiscal[\s\S]{0,80}?\n([0-9]{1,12})\n/i,
  ]));
}

function parsePdfCnpjEmitente(lines) {
  const start = Math.max(0, lines.findIndex((line) => /emitente|prestador (?:do|de) servi/i.test(normalizeSearchText(line))));
  let end = lines.findIndex((line, index) => index > start && /tomador/i.test(normalizeSearchText(line)));
  if (end < 0) end = Math.min(lines.length, start + 80);
  const segment = lines.slice(start, end).join("\n");
  const all = [...segment.matchAll(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g)].map((match) => onlyDigits(match[0]));
  if (all.length) return all[0];
  return onlyDigits(firstRegex(segment, [
    /CPF\/CNPJ\s*[:\n ]+([0-9.\-\/]+)/i,
    /CNPJ\s*[:\n ]+([0-9.\-\/]+)/i,
  ])).slice(0, 14);
}

function parsePdfValor(text, lines) {
  const byLine = pdfLineAfter(lines, "valor liquido da nfs", /^R?\$?\s*[0-9.]+,[0-9]{2}$/i, 8)
    || pdfLineAfter(lines, "valor do servico", /^R?\$?\s*[0-9.]+,[0-9]{2}$/i, 8)
    || pdfLineAfter(lines, "valor total da nfs", /^R?\$?\s*[0-9.]+,[0-9]{2}$/i, 8);
  if (byLine) return parseBrazilMoney(byLine);
  const searchable = normalizeSearchText(text);
  const value = firstRegex(searchable, [
    /valor total do servico\s*=\s*r?\$?\s*([0-9.]+,[0-9]{2})/i,
    /valor total da nota\s*r?\$?\s*([0-9.]+,[0-9]{2})/i,
    /([0-9.]+,[0-9]{2})\s*valor total da nota/i,
    /valor liquido da nota\s*r?\$?\s*([0-9.]+,[0-9]{2})/i,
  ]);
  return parseBrazilMoney(value);
}

async function parseNfPdf(filePath) {
  const buffer = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  await parser.destroy();
  const text = normalizePdfText(result.text || "");
  const numero_nf = firstRegex(text, [
    /N[úu]mero\s+da\s+Nota\s*[:\n ]+([0-9.\-\/]+)/i,
    /N[ºo]\s*(?:da\s*)?(?:Nota|NFS-?e)\s*[:\n ]+([0-9.\-\/]+)/i,
    /Nota\s+Fiscal\s*(?:n[ºo])?\s*[:\n ]+([0-9.\-\/]+)/i,
  ]).replace(/\D/g, "");
  const cnpj_emitente = onlyDigits(firstRegex(text, [
    /PRESTADOR\s+DE\s+SERVI[ÇC]OS[\s\S]{0,400}?CPF\/CNPJ\s*[:\n ]+([0-9.\-\/]+)/i,
    /CPF\/CNPJ\s*[:\n ]+([0-9.\-\/]{11,18})/i,
    /CNPJ\s*[:\n ]+([0-9.\-\/]{14,18})/i,
  ])).slice(0, 14);
  const valorText = firstRegex(text, [
    /VALOR\s+TOTAL\s+DO\s+SERVI[ÇC]O\s*=\s*R?\$?\s*([0-9.\,]+)/i,
    /Valor\s+Total\s+(?:dos?\s+)?Servi[çc]os?\s*[:=\n ]+R?\$?\s*([0-9.\,]+)/i,
    /Valor\s+Liquido\s+da\s+NFS?-?e\s*[:=\n ]+R?\$?\s*([0-9.\,]+)/i,
  ]);
  const lines = pdfLines(text);
  const parsed = {
    numero_nf: parsePdfNumero(text, lines),
    valor_nf: parsePdfValor(text, lines),
    cnpj_emitente: parsePdfCnpjEmitente(lines),
  };
  if (!parsed.numero_nf || !parsed.valor_nf || !parsed.cnpj_emitente) {
    const imageData = await parseNfPdfImageFallback(filePath);
    return {
      ...parsed,
      numero_nf: parsed.numero_nf || imageData.numero_nf || "",
      valor_nf: parsed.valor_nf || imageData.valor_nf || null,
      cnpj_emitente: parsed.cnpj_emitente || imageData.cnpj_emitente || "",
      chave_acesso: imageData.chave_acesso || "",
      layout: imageData.layout || "",
      source: imageData.source || "",
    };
  }
  return parsed;
}

async function parseNfPdfImageFallback(filePath) {
  const scriptPath = path.join(__dirname, "scripts", "nfse-image-reader.py");
  if (!fs.existsSync(scriptPath)) return {};
  try {
    const { stdout } = await execFileAsync("python", [scriptPath, filePath], {
      timeout: 45000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(String(stdout || "{}"));
  } catch (error) {
    console.warn("NF image fallback failed:", error.message);
    return {};
  }
}

function compareNfData({ nfData, prestador, expectedValue }) {
  const divergencias = [];
  const valor = Number(nfData.valor_nf || 0);
  const esperado = money(expectedValue);
  if (!nfData.numero_nf) divergencias.push("Numero da NF nao localizado no arquivo.");
  if (!valor) divergencias.push("Valor da NF nao localizado no arquivo.");
  if (valor && Math.abs(valor - esperado) > 0.01) {
    divergencias.push(`Valor da NF (${formatCurrency(valor)}) diferente do valor do sistema (${formatCurrency(esperado)}).`);
  }
  const cnpjPrestador = onlyDigits(prestador.cnpj);
  if (nfData.cnpj_emitente && cnpjPrestador && nfData.cnpj_emitente !== cnpjPrestador) {
    divergencias.push("CNPJ da NF diferente do CNPJ cadastrado do prestador.");
  }
  return divergencias;
}

function nfFolderRoot() {
  if (process.env.NF_FOLDER_ROOT) return process.env.NF_FOLDER_ROOT;
  const correctedRoot = path.join(process.env.USERPROFILE || "", "OneDrive - Redefrete", "FOLHA", "NF\u00b4s PJ");
  return fs.existsSync(defaultNfFolderRoot) ? defaultNfFolderRoot : correctedRoot;
}

function competenciaFolderName(competencia) {
  return String(competencia || "").replace("-", "");
}

function folderNameToCompetencia(folderName) {
  const match = String(folderName || "").match(/^(\d{4})(\d{2})$/);
  if (!match) return "";
  const month = Number(match[2]);
  if (month < 1 || month > 12) return "";
  return `${match[1]}-${match[2]}`;
}

function competenciaFromText(value, referenceDate = null) {
  const raw = normalizeSearchText(value || "");
  const yyyyMm = raw.match(/\b(20\d{2})[-_/ ]?(0[1-9]|1[0-2])\b/);
  if (yyyyMm) return `${yyyyMm[1]}-${yyyyMm[2]}`;
  const mmYyyy = raw.match(/\b(0[1-9]|1[0-2])[-_/ ]?(20\d{2})\b/);
  if (mmYyyy) return `${mmYyyy[2]}-${mmYyyy[1]}`;
  const monthNames = {
    janeiro: "01",
    jan: "01",
    fevereiro: "02",
    fev: "02",
    marco: "03",
    mar: "03",
    abril: "04",
    abr: "04",
    maio: "05",
    mai: "05",
    junho: "06",
    jun: "06",
    julho: "07",
    jul: "07",
    agosto: "08",
    ago: "08",
    setembro: "09",
    set: "09",
    outubro: "10",
    out: "10",
    novembro: "11",
    nov: "11",
    dezembro: "12",
    dez: "12",
  };
  const named = raw.match(/\b(janeiro|jan|fevereiro|fev|marco|mar|abril|abr|maio|mai|junho|jun|julho|jul|agosto|ago|setembro|set|outubro|out|novembro|nov|dezembro|dez)[-_/ ]*(20\d{2})\b/);
  if (named) return `${named[2]}-${monthNames[named[1]]}`;
  const monthOnly = raw.match(/\b(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/);
  const year = referenceDate ? new Date(referenceDate).getUTCFullYear() : null;
  return monthOnly && year ? `${year}-${monthNames[monthOnly[1]]}` : "";
}

function isNfFile(filePath) {
  return [".xml", ".pdf"].includes(path.extname(filePath || "").toLowerCase());
}

function isNfStoredFile(filePath) {
  return [".xml", ".pdf", ".html", ".htm", ".txt"].includes(path.extname(filePath || "").toLowerCase());
}

function storedNfFileName(originalName) {
  const safeExt = path.extname(originalName || "").toLowerCase().replace(/[^.\w]/g, "") || ".pdf";
  return `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${safeExt}`;
}

async function parseNfFile(filePath) {
  const ext = path.extname(filePath || "").toLowerCase();
  return ext === ".xml" ? parseNfXml(filePath) : parseNfPdf(filePath);
}

async function openCompetencias() {
  const [rows] = await pool.query("SELECT competencia FROM folhas WHERE status = 'aberta'");
  return [...new Set([
    currentCompetencia(),
    ...temporaryOpenCompetencias(),
    ...rows.map((row) => row.competencia),
  ])].filter(Boolean).sort((a, b) => String(b).localeCompare(String(a)));
}

async function prestadorByCnpj(cnpj, options = {}) {
  const digits = onlyDigits(cnpj);
  if (!digits) return null;
  const activeFilter = options.includeInactive ? "" : "AND ativo = 1";
  const [[prestador]] = await pool.query(
    `SELECT id, nome, razao_social, cnpj
     FROM prestadores
     WHERE REPLACE(REPLACE(REPLACE(cnpj, '.', ''), '/', ''), '-', '') = ?
       ${activeFilter}
     LIMIT 1`,
    [digits],
  );
  return prestador || null;
}

async function existingNfUpload({ competencia, prestadorId, numeroNf, originalName, fileSize }) {
  const params = [competencia, prestadorId, originalName, fileSize];
  let numeroClause = "";
  const normalizedNumero = normalizeNfNumber(numeroNf);
  if (normalizedNumero) {
    numeroClause = " OR numero_nf = ? OR TRIM(LEADING '0' FROM numero_nf) = ?";
    params.push(normalizedNumero, normalizedNumero);
  }
  const [[existing]] = await pool.query(
    `SELECT id, status
     FROM nf_arquivos
     WHERE competencia = ?
       AND prestador_id = ?
       AND ((original_name = ? AND file_size = ?)${numeroClause})
     ORDER BY criado_em DESC
     LIMIT 1`,
    params,
  );
  return existing || null;
}

async function existingNfUploadByCnpj({ competencia, cnpj, numeroNf, originalName, fileSize }) {
  const digits = onlyDigits(cnpj);
  if (!digits) return null;
  const params = [competencia, digits, originalName, fileSize];
  let numeroClause = "";
  const normalizedNumero = normalizeNfNumber(numeroNf);
  if (normalizedNumero) {
    numeroClause = " OR numero_nf = ? OR TRIM(LEADING '0' FROM numero_nf) = ?";
    params.push(normalizedNumero, normalizedNumero);
  }
  const [[existing]] = await pool.query(
    `SELECT id, status
     FROM nf_arquivos
     WHERE competencia = ?
       AND REPLACE(REPLACE(REPLACE(cnpj_emitente, '.', ''), '/', ''), '-', '') = ?
       AND ((original_name = ? AND file_size = ?)${numeroClause})
     ORDER BY criado_em DESC
     LIMIT 1`,
    params,
  );
  return existing || null;
}

async function nfNumberHistoryByCnpj(cnpj, db = pool) {
  const digits = onlyDigits(cnpj);
  if (!digits) return [];
  const [rows] = await db.query(
    `SELECT 'arquivo' AS origem, n.id, n.numero_nf, n.competencia, n.prestador_id
       FROM nf_arquivos n
       JOIN prestadores p ON p.id = n.prestador_id
      WHERE COALESCE(
              NULLIF(REPLACE(REPLACE(REPLACE(n.cnpj_emitente, '.', ''), '/', ''), '-', ''), ''),
              REPLACE(REPLACE(REPLACE(p.cnpj, '.', ''), '/', ''), '-', '')
            ) = ?
        AND n.numero_nf IS NOT NULL
     UNION ALL
     SELECT 'folha' AS origem, fi.id, fi.numero_nf, f.competencia, fi.prestador_id
       FROM folha_itens fi
       JOIN folhas f ON f.id = fi.folha_id
       JOIN prestadores p ON p.id = fi.prestador_id
      WHERE COALESCE(
              NULLIF(REPLACE(REPLACE(REPLACE(fi.prestador_cnpj, '.', ''), '/', ''), '-', ''), ''),
              REPLACE(REPLACE(REPLACE(p.cnpj, '.', ''), '/', ''), '-', '')
            ) = ?
        AND fi.numero_nf IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM nf_arquivos n2
          WHERE n2.folha_item_id = fi.id
            AND n2.numero_nf IS NOT NULL
        )
     UNION ALL
     SELECT 'rescisao' AS origem, r.id, r.numero_nf, r.competencia, r.prestador_id
       FROM rescisoes r
       JOIN prestadores p ON p.id = r.prestador_id
      WHERE REPLACE(REPLACE(REPLACE(p.cnpj, '.', ''), '/', ''), '-', '') = ?
        AND r.numero_nf IS NOT NULL`,
    [digits, digits, digits],
  );
  return rows
    .map((row) => ({ ...row, numero_normalizado: normalizeNfNumber(row.numero_nf) }))
    .filter((row) => row.numero_normalizado);
}

function ignoreCurrentNfHistory(row, { competencia, prestadorId, ignoreCurrentCompetencia }) {
  return Boolean(
    ignoreCurrentCompetencia
    && competencia
    && String(row.competencia) === String(competencia)
    && Number(row.prestador_id) === Number(prestadorId),
  );
}

async function validateNfNumberRules({ prestador, numeroNf, competencia, db = pool, ignoreCurrentCompetencia = false, skipSequenceCheck = false }) {
  const numeroNormalizado = normalizeNfNumber(numeroNf);
  if (!numeroNormalizado) return [];
  const history = (await nfNumberHistoryByCnpj(prestador.cnpj, db))
    .filter((row) => !ignoreCurrentNfHistory(row, {
      competencia,
      prestadorId: prestador.id,
      ignoreCurrentCompetencia,
    }));
  const duplicate = history.find((row) => row.numero_normalizado === numeroNormalizado);
  if (duplicate) {
    return [`NF ${numeroNormalizado} ja existe para o CNPJ ${prestador.cnpj}.`];
  }
  if (skipSequenceCheck || allowOutOfOrderNfNumbers) return [];
  const numeroAtual = Number(numeroNormalizado);
  const previousNumbers = history
    .map((row) => Number(row.numero_normalizado))
    .filter((number) => Number.isFinite(number));
  const maiorAnterior = previousNumbers.length ? Math.max(...previousNumbers) : 0;
  if (Number.isFinite(numeroAtual) && maiorAnterior > 0 && numeroAtual < maiorAnterior) {
    return [`NF ${numeroNormalizado} menor que a NF anterior ${maiorAnterior} para o CNPJ ${prestador.cnpj}.`];
  }
  return [];
}

async function folhaDataForNfImport(competencia, includeClosed = false) {
  const [[folhaRow]] = await pool.query("SELECT id, status, dias_mes FROM folhas WHERE competencia = ?", [competencia]);
  if (!includeClosed || !folhaRow?.id || folhaRow.status !== "fechada") {
    return buildFolhaAberta(competencia, { perfil: "master" });
  }
  const [itens] = await pool.query(
    `SELECT
       p.id,
       p.id AS prestador_id,
       fi.id AS folha_item_id,
       fi.dias_trabalhados,
       fi.salario_base,
       fi.valor_dias,
       fi.adicoes,
       fi.bonus,
       fi.descontos_manual,
       fi.desconto_adiantamentos,
       fi.valor_nf_previsto,
       fi.valor_nf_emitida,
       fi.numero_nf,
       fi.liquido_pagar,
       p.nome,
       p.razao_social,
       p.cnpj,
       p.cpf
     FROM folha_itens fi
     JOIN prestadores p ON p.id = fi.prestador_id
     WHERE fi.folha_id = ?
     ORDER BY p.nome, p.razao_social`,
    [folhaRow.id],
  );
  return { folha: folhaRow, itens };
}

async function importNfFromFolderFile({ competencia, filePath, folhaData = null, includeClosed = false }) {
  const originalName = path.basename(filePath);
  if (!isNfFile(filePath)) return { status: "ignorada", file: originalName, reason: "Arquivo nao suportado." };
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return { status: "ignorada", file: originalName, reason: "Nao e arquivo." };

  const nfData = await parseNfFile(filePath);
  const prestador = await prestadorByCnpj(nfData.cnpj_emitente, { includeInactive: includeClosed });
  if (!prestador) {
    const duplicate = await existingNfUploadByCnpj({
      competencia,
      cnpj: nfData.cnpj_emitente,
      numeroNf: normalizeNfNumber(nfData.numero_nf),
      originalName,
      fileSize: stat.size,
    });
    if (duplicate) {
      return { status: "duplicada", file: originalName, nf_id: duplicate.id };
    }
    return { status: "erro", file: originalName, reason: "CNPJ da NF nao localizado no cadastro.", nfData };
  }

  const folha = folhaData || await folhaDataForNfImport(competencia, includeClosed);
  const item = folha.itens.find((row) => Number(row.id) === Number(prestador.id));
  if (!item) {
    return { status: "ignorada", file: originalName, prestador_id: prestador.id, reason: "Prestador nao esta na folha." };
  }

  const duplicate = await existingNfUpload({
    competencia,
    prestadorId: prestador.id,
      numeroNf: normalizeNfNumber(nfData.numero_nf),
    originalName,
    fileSize: stat.size,
  });
  if (duplicate) {
    return { status: "duplicada", file: originalName, prestador_id: prestador.id, nf_id: duplicate.id };
  }

  const nfNumberErrors = await validateNfNumberRules({
    prestador,
    numeroNf: nfData.numero_nf,
    competencia,
    ignoreCurrentCompetencia: includeClosed,
    skipSequenceCheck: includeClosed,
  });
  if (nfNumberErrors.length) {
    return { status: "erro", file: originalName, prestador_id: prestador.id, reason: nfNumberErrors.join(" "), nfData };
  }

  const [[folhaRow]] = await pool.query("SELECT id, status FROM folhas WHERE competencia = ?", [competencia]);
  if (folhaRow?.status === "fechada" && !isTemporaryOpenCompetencia(competencia) && !includeClosed) {
    return { status: "ignorada", file: originalName, reason: "Folha fechada." };
  }
  const [[folhaItem]] = folhaRow?.id
    ? await pool.query("SELECT id FROM folha_itens WHERE folha_id = ? AND prestador_id = ?", [folhaRow.id, prestador.id])
    : [[null]];

  const storedName = storedNfFileName(originalName);
  const storedPath = path.join(uploadsDir, storedName);
  fs.copyFileSync(filePath, storedPath);

  const divergencias = compareNfData({ nfData, prestador, expectedValue: item.liquido_pagar });
  if (path.extname(filePath).toLowerCase() === ".pdf" && (!nfData.numero_nf || !nfData.valor_nf)) {
    divergencias.push("PDF salvo, mas nao foi possivel localizar todos os dados automaticamente.");
  }
  const nfStatus = divergencias.length ? "divergente" : "validada";
  const [result] = await pool.query(
    `INSERT INTO nf_arquivos
     (competencia, prestador_id, folha_id, folha_item_id, original_name, stored_name, mime_type,
      file_size, numero_nf, valor_nf, cnpj_emitente, status, divergencias, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      competencia,
      prestador.id,
      folhaRow?.id || null,
      folhaItem?.id || null,
      originalName,
      storedName,
      path.extname(filePath).toLowerCase() === ".xml" ? "application/xml" : "application/pdf",
      stat.size,
      normalizeNfNumber(nfData.numero_nf) || null,
      nfData.valor_nf || null,
      nfData.cnpj_emitente || null,
      nfStatus,
      divergencias.join(" | ") || null,
    ],
  );
  if (folhaItem?.id && nfStatus === "validada") {
    await pool.query(
      "UPDATE folha_itens SET numero_nf = ?, valor_nf_emitida = ? WHERE id = ?",
      [normalizeNfNumber(nfData.numero_nf) || null, nfData.valor_nf || null, folhaItem.id],
    );
  }

  return {
    status: nfStatus,
    file: originalName,
    nf_id: result.insertId,
    prestador_id: prestador.id,
    numero_nf: normalizeNfNumber(nfData.numero_nf) || null,
    valor_nf: nfData.valor_nf || null,
    divergencias,
  };
}

async function importNfFromEmailData({ competencia, nfData, originalName, content, folhaData = null, includeClosed = false, sourceUrl = "" }) {
  const safeOriginalName = originalName || `email-nf-${competencia || currentCompetencia()}.html`;
  const prestador = await prestadorByCnpj(nfData.cnpj_emitente, { includeInactive: includeClosed });
  if (!prestador) {
    const duplicate = await existingNfUploadByCnpj({
      competencia,
      cnpj: nfData.cnpj_emitente,
      numeroNf: normalizeNfNumber(nfData.numero_nf),
      originalName: safeOriginalName,
      fileSize: Buffer.byteLength(content || "", "utf8"),
    });
    if (duplicate) return { status: "duplicada", file: safeOriginalName, nf_id: duplicate.id, sourceUrl };
    return { status: "erro", file: safeOriginalName, reason: "CNPJ da NF nao localizado no cadastro.", nfData, sourceUrl };
  }

  const folha = folhaData || await folhaDataForNfImport(competencia, includeClosed);
  const item = folha.itens.find((row) => Number(row.id) === Number(prestador.id));
  if (!item) return { status: "ignorada", file: safeOriginalName, prestador_id: prestador.id, reason: "Prestador nao esta na folha.", sourceUrl };

  const fileSize = Buffer.byteLength(content || "", "utf8");
  const duplicate = await existingNfUpload({
    competencia,
    prestadorId: prestador.id,
    numeroNf: normalizeNfNumber(nfData.numero_nf),
    originalName: safeOriginalName,
    fileSize,
  });
  if (duplicate) return { status: "duplicada", file: safeOriginalName, prestador_id: prestador.id, nf_id: duplicate.id, sourceUrl };

  const nfNumberErrors = await validateNfNumberRules({
    prestador,
    numeroNf: nfData.numero_nf,
    competencia,
    ignoreCurrentCompetencia: includeClosed,
    skipSequenceCheck: includeClosed,
  });
  if (nfNumberErrors.length) {
    return { status: "erro", file: safeOriginalName, prestador_id: prestador.id, reason: nfNumberErrors.join(" "), nfData, sourceUrl };
  }

  const [[folhaRow]] = await pool.query("SELECT id, status FROM folhas WHERE competencia = ?", [competencia]);
  if (folhaRow?.status === "fechada" && !isTemporaryOpenCompetencia(competencia) && !includeClosed) {
    return { status: "ignorada", file: safeOriginalName, reason: "Folha fechada.", sourceUrl };
  }
  const [[folhaItem]] = folhaRow?.id
    ? await pool.query("SELECT id FROM folha_itens WHERE folha_id = ? AND prestador_id = ?", [folhaRow.id, prestador.id])
    : [[null]];

  const storedName = storedNfFileName(safeOriginalName);
  fs.writeFileSync(path.join(uploadsDir, storedName), content || "", "utf8");
  const divergencias = compareNfData({ nfData, prestador, expectedValue: item.liquido_pagar });
  const nfStatus = divergencias.length ? "divergente" : "validada";
  const [result] = await pool.query(
    `INSERT INTO nf_arquivos
     (competencia, prestador_id, folha_id, folha_item_id, original_name, stored_name, mime_type,
      file_size, numero_nf, valor_nf, cnpj_emitente, status, divergencias, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      competencia,
      prestador.id,
      folhaRow?.id || null,
      folhaItem?.id || null,
      safeOriginalName,
      storedName,
      "text/html",
      fileSize,
      normalizeNfNumber(nfData.numero_nf) || null,
      nfData.valor_nf || null,
      nfData.cnpj_emitente || null,
      nfStatus,
      divergencias.join(" | ") || null,
    ],
  );
  if (folhaItem?.id && nfStatus === "validada") {
    await pool.query(
      "UPDATE folha_itens SET numero_nf = ?, valor_nf_emitida = ? WHERE id = ?",
      [normalizeNfNumber(nfData.numero_nf) || null, nfData.valor_nf || null, folhaItem.id],
    );
  }
  return {
    status: nfStatus,
    file: safeOriginalName,
    nf_id: result.insertId,
    prestador_id: prestador.id,
    numero_nf: normalizeNfNumber(nfData.numero_nf) || null,
    valor_nf: nfData.valor_nf || null,
    divergencias,
    sourceUrl,
  };
}

async function reprocessStoredNfsForCompetencia(competencia, folhaData = null, includeClosed = false) {
  const folha = folhaData || await folhaDataForNfImport(competencia, includeClosed);
  const itemsByPrestador = new Map(folha.itens.map((item) => [Number(item.prestador_id || item.id), item]));
  const [rows] = await pool.query(
    `SELECT n.*, p.cnpj, p.nome, p.razao_social
     FROM nf_arquivos n
     JOIN prestadores p ON p.id = n.prestador_id
     WHERE n.competencia = ?
       AND (n.status <> 'validada' OR n.numero_nf IS NULL OR n.valor_nf IS NULL OR n.cnpj_emitente IS NULL)
     ORDER BY n.id`,
    [competencia],
  );
  const results = [];
  for (const nf of rows) {
    const filePath = path.join(uploadsDir, nf.stored_name);
    if (!fs.existsSync(filePath)) {
      results.push({ status: "erro", action: "reprocessada", file: nf.original_name, nf_id: nf.id, reason: "Arquivo salvo nao encontrado." });
      continue;
    }
    try {
      const nfData = await parseNfFile(filePath);
      const item = itemsByPrestador.get(Number(nf.prestador_id));
      const divergencias = compareNfData({
        nfData,
        prestador: nf,
        expectedValue: item?.liquido_pagar || nf.valor_nf || 0,
      });
      if (path.extname(filePath).toLowerCase() === ".pdf" && (!nfData.numero_nf || !nfData.valor_nf)) {
        divergencias.push("PDF salvo, mas nao foi possivel localizar todos os dados automaticamente.");
      }
      const status = divergencias.length ? "divergente" : "validada";
      await pool.query(
        `UPDATE nf_arquivos
         SET numero_nf = ?, valor_nf = ?, cnpj_emitente = ?, status = ?, divergencias = ?
         WHERE id = ?`,
        [
          normalizeNfNumber(nfData.numero_nf) || null,
          nfData.valor_nf || null,
          nfData.cnpj_emitente || null,
          status,
          divergencias.join(" | ") || null,
          nf.id,
        ],
      );
      if (nf.folha_item_id && status === "validada") {
        await pool.query(
          "UPDATE folha_itens SET numero_nf = ?, valor_nf_emitida = ? WHERE id = ?",
          [normalizeNfNumber(nfData.numero_nf) || null, nfData.valor_nf || null, nf.folha_item_id],
        );
      }
      results.push({
        status,
        action: "reprocessada",
        file: nf.original_name,
        nf_id: nf.id,
        prestador_id: nf.prestador_id,
        numero_nf: normalizeNfNumber(nfData.numero_nf) || null,
        valor_nf: nfData.valor_nf || null,
        divergencias,
      });
    } catch (error) {
      results.push({ status: "erro", action: "reprocessada", file: nf.original_name, nf_id: nf.id, reason: error.message });
    }
  }
  return results;
}

async function scanNfFolderForCompetencia(competencia, options = {}) {
  const includeClosed = Boolean(options.includeClosed);
  const folder = path.join(nfFolderRoot(), competenciaFolderName(competencia));
  if (!fs.existsSync(folder)) return { competencia, folder, exists: false, results: [] };
  const [[folhaRow]] = await pool.query("SELECT status FROM folhas WHERE competencia = ?", [competencia]);
  if (folhaRow?.status === "fechada" && !isTemporaryOpenCompetencia(competencia) && !includeClosed) {
    return { competencia, folder, exists: true, skipped: true, reason: "Folha fechada.", results: [] };
  }
  const folhaData = await folhaDataForNfImport(competencia, includeClosed);
  const entries = fs.readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(folder, entry.name))
    .filter(isNfFile);
  const results = await reprocessStoredNfsForCompetencia(competencia, folhaData, includeClosed);
  for (const filePath of entries) {
    try {
      results.push(await importNfFromFolderFile({ competencia, filePath, folhaData, includeClosed }));
    } catch (error) {
      results.push({ status: "erro", file: path.basename(filePath), reason: error.message });
    }
  }
  return { competencia, folder, exists: true, results };
}

async function scanOpenNfFolders() {
  const competencias = await openCompetencias();
  const results = [];
  for (const competencia of competencias) {
    results.push(await scanNfFolderForCompetencia(competencia));
  }
  return {
    root: nfFolderRoot(),
    competencias,
    results,
  };
}

async function scanAllExistingNfFolders(options = {}) {
  const root = nfFolderRoot();
  const competencias = fs.existsSync(root)
    ? fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => folderNameToCompetencia(entry.name))
      .filter(Boolean)
      .sort((a, b) => String(b).localeCompare(String(a)))
    : [];
  const results = [];
  for (const competencia of competencias) {
    results.push(await scanNfFolderForCompetencia(competencia, options));
  }
  return { root, competencias, results };
}

async function graphGetJson(pathName) {
  const token = await graphAccessToken(["Mail.Read", "Mail.ReadWrite"]);
  const response = await fetch(`https://graph.microsoft.com/v1.0${pathName}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || data?.error || `Microsoft Graph retornou HTTP ${response.status}.`;
    throw new Error(message);
  }
  return data;
}

async function graphSendJson(pathName, payload, requiredRole = "Mail.ReadWrite") {
  const token = await graphAccessToken(requiredRole);
  const response = await fetch(`https://graph.microsoft.com/v1.0${pathName}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload || {}),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data?.error?.message || data?.error || `Microsoft Graph retornou HTTP ${response.status}.`;
    throw new Error(message);
  }
  return data;
}

async function graphMailFolderId(mailbox, displayName) {
  const folders = await graphGetJson(`/users/${encodeURIComponent(mailbox)}/mailFolders?$top=100&$select=id,displayName`);
  const existing = (folders.value || []).find((folder) => String(folder.displayName || "").toLowerCase() === String(displayName).toLowerCase());
  if (existing) return existing.id;
  const created = await graphSendJson(`/users/${encodeURIComponent(mailbox)}/mailFolders`, { displayName });
  return created.id;
}

async function graphMoveMessage(mailbox, messageId, destinationFolderName = "Importados") {
  const destinationId = await graphMailFolderId(mailbox, destinationFolderName);
  return graphSendJson(
    `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/move`,
    { destinationId },
  );
}

function graphMessageKey(message) {
  return String(message?.internetMessageId || message?.id || "").trim();
}

function sqlDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace("T", " ");
}

async function emailImportAlreadyProcessed(message, db = pool) {
  const key = graphMessageKey(message);
  if (!key) return null;
  const [[row]] = await db.query(
    "SELECT id, status, competencia, moved_to FROM nf_email_imports WHERE message_key = ? LIMIT 1",
    [key],
  );
  return row || null;
}

async function recordEmailImport(message, details = {}, db = pool) {
  const key = graphMessageKey(message);
  if (!key) return;
  const resultText = details.resultado ? JSON.stringify(details.resultado).slice(0, 60000) : null;
  await db.query(
    `INSERT INTO nf_email_imports
       (message_key, graph_message_id, internet_message_id, conversation_id, subject, from_email, received_at, competencia, status, resultado, moved_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       graph_message_id = VALUES(graph_message_id),
       internet_message_id = VALUES(internet_message_id),
       conversation_id = VALUES(conversation_id),
       subject = VALUES(subject),
       from_email = VALUES(from_email),
       received_at = VALUES(received_at),
       competencia = VALUES(competencia),
       status = VALUES(status),
       resultado = VALUES(resultado),
       moved_to = VALUES(moved_to),
       processed_at = CURRENT_TIMESTAMP`,
    [
      key,
      message.id || null,
      message.internetMessageId || null,
      message.conversationId || null,
      message.subject || null,
      message.from?.emailAddress?.address || null,
      sqlDateTime(message.receivedDateTime),
      details.competencia || null,
      details.status || "processado",
      resultText,
      details.movedTo || null,
    ],
  );
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function htmlToPlainText(html) {
  return decodeHtmlEntities(String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|table|li|h\d)>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function extractEmailLinks(htmlOrText) {
  const raw = String(htmlOrText || "");
  const links = new Set();
  for (const match of raw.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    links.add(decodeHtmlEntities(match[1]));
  }
  for (const match of raw.matchAll(/\bhttps?:\/\/[^\s<>"')]+/gi)) {
    links.add(decodeHtmlEntities(match[0]));
  }
  return [...links].filter((url) => /^https?:\/\//i.test(url));
}

function isPotentialNfLink(url) {
  const lower = String(url || "").toLowerCase();
  return [
    "nfe",
    "nfse",
    "nota",
    "fiscal",
    "visualizar",
    "download",
    "xml",
    "pdf",
    "autentic",
    "eissnfe",
  ].some((term) => lower.includes(term));
}

function parseEmailNfData(text) {
  const plain = htmlToPlainText(text);
  const cnpj = (plain.match(/CNPJ\s*[:\-]?\s*([0-9.\-/]{14,20})/i)
    || plain.match(/CPF\/CNPJ\s*[:\-]?\s*([0-9.\-/]{11,20})/i)
    || [])[1];
  const numero = (plain.match(/N[uú]mero\s*(?:da\s*)?(?:NF(?:-?e)?|Nota(?:\s*Fiscal)?)\s*[:\-]?\s*0*([0-9]{1,12})/i)
    || plain.match(/Nota\s*Fiscal\s*Eletr[oô]nica[\s\S]{0,80}?No\.?\s*0*([0-9]{1,12})/i)
    || [])[1];
  const valorText = (plain.match(/Valor\s*(?:da\s*)?(?:Nota|NF|NFS-e)?\s*[:\-]?\s*R?\$?\s*([0-9.]+,[0-9]{2})/i)
    || plain.match(/Valor\s*Total[\s\S]{0,40}?R?\$?\s*([0-9.]+,[0-9]{2})/i)
    || [])[1];
  return {
    numero_nf: numero ? normalizeNfNumber(numero) : null,
    valor_nf: valorText ? money(valorText) : null,
    cnpj_emitente: onlyDigits(cnpj),
  };
}

function contentDispositionFileName(value) {
  const header = String(value || "");
  const utf8 = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8) return decodeURIComponent(utf8[1].replace(/"/g, ""));
  const regular = header.match(/filename\s*=\s*"?([^";]+)"?/i);
  return regular ? regular[1] : "";
}

async function downloadNfLinkToFile(url, dir, index = 1) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 Redefrete NF Importer",
        Accept: "application/pdf,application/xml,text/xml,text/html;q=0.9,*/*;q=0.8",
      },
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const dispositionName = contentDispositionFileName(response.headers.get("content-disposition"));
    let ext = path.extname(dispositionName || new URL(response.url).pathname).toLowerCase();
    if (![".pdf", ".xml", ".html", ".htm"].includes(ext)) {
      if (buffer.slice(0, 4).toString() === "%PDF" || contentType.includes("pdf")) ext = ".pdf";
      else if (contentType.includes("html")) ext = ".html";
      else if (contentType.includes("xml")) ext = ".xml";
      else ext = ".html";
    }
    const safeName = path.basename(dispositionName || `link-nf-${index}${ext}`).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
    const filePath = path.join(dir, safeName || `link-nf-${index}${ext}`);
    fs.writeFileSync(filePath, buffer);
    return { filePath, contentType, url: response.url, text: buffer.toString("utf8") };
  } finally {
    clearTimeout(timeout);
  }
}

async function importNfEmailAttachments(options = {}) {
  const mailbox = process.env.GRAPH_FROM || process.env.NF_DESTINATION_EMAIL;
  if (!mailbox) throw new Error("Configure GRAPH_FROM ou NF_DESTINATION_EMAIL para ler a caixa de NFs.");
  const includeClosed = Boolean(options.includeClosed);
  const requestedCompetencia = options.competencia || "";
  const top = Math.min(Math.max(Number(options.top || 50), 1), 100);
  const select = "$select=id,internetMessageId,conversationId,subject,receivedDateTime,hasAttachments,from,body";
  const messages = await graphGetJson(`/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages?$top=${top}&${select}`);
  const grouped = new Map();
  const addResult = (competencia, result) => {
    const key = competencia || "sem_competencia";
    if (!grouped.has(key)) grouped.set(key, { competencia: key, source: "email", results: [] });
    grouped.get(key).results.push(result);
  };

  for (const message of messages.value || []) {
    const processed = await emailImportAlreadyProcessed(message);
    if (processed?.status === "processado") {
      let movedAgain = false;
      try {
        await graphMoveMessage(mailbox, message.id, "Importados");
        movedAgain = true;
      } catch {
        movedAgain = false;
      }
      const result = {
        status: "duplicada",
        source: "email",
        subject: message.subject || "",
        competencia: processed.competencia || requestedCompetencia || "",
        reason: "E-mail ja processado pelo ID da mensagem.",
        movida_importados: Boolean(processed.moved_to || movedAgain),
      };
      addResult(processed.competencia || requestedCompetencia || "email", result);
      continue;
    }
    const attachmentData = await graphGetJson(`/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(message.id)}/attachments`);
    const messageResults = [];
    for (const attachment of attachmentData.value || []) {
      const originalName = attachment.name || "anexo";
      if (attachment.isInline || !isNfFile(originalName)) continue;
      const competencia = requestedCompetencia || competenciaFromText(`${message.subject || ""} ${originalName}`, message.receivedDateTime);
      if (!competencia) {
        const result = {
          status: "ignorada",
          file: originalName,
          subject: message.subject || "",
          competencia: "",
          reason: "Competencia nao identificada no assunto ou no nome do anexo.",
        };
        messageResults.push(result);
        addResult("", result);
        continue;
      }
      const [[folhaRow]] = await pool.query("SELECT status FROM folhas WHERE competencia = ?", [competencia]);
      if (folhaRow?.status === "fechada" && !isTemporaryOpenCompetencia(competencia) && !includeClosed) {
        const result = { status: "ignorada", file: originalName, subject: message.subject || "", competencia, reason: "Folha fechada." };
        messageResults.push(result);
        addResult(competencia, result);
        continue;
      }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nf-email-"));
      const safeName = path.basename(originalName).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_") || "anexo.pdf";
      const filePath = path.join(dir, safeName);
      try {
        fs.writeFileSync(filePath, Buffer.from(attachment.contentBytes || "", "base64"));
        const folhaData = await folhaDataForNfImport(competencia, includeClosed);
        const result = await importNfFromFolderFile({ competencia, filePath, folhaData, includeClosed });
        const enriched = {
          ...result,
          source: "email",
          competencia,
          subject: message.subject || "",
          receivedDateTime: message.receivedDateTime || "",
          from: message.from?.emailAddress?.address || "",
        };
        messageResults.push(enriched);
        addResult(competencia, enriched);
      } catch (error) {
        const result = { status: "erro", file: originalName, subject: message.subject || "", competencia, reason: error.message };
        messageResults.push(result);
        addResult(competencia, result);
      } finally {
        fs.rm(dir, { recursive: true, force: true }, () => {});
      }
    }
    const bodyContent = message.body?.content || "";
    const bodyText = htmlToPlainText(bodyContent);
    const linkUrls = extractEmailLinks(bodyContent || bodyText).filter(isPotentialNfLink).slice(0, 6);
    const alreadyImportedFromAttachment = messageResults.some((result) => ["validada", "divergente", "duplicada"].includes(result.status));
    if (!alreadyImportedFromAttachment && linkUrls.length) {
      let linkIndex = 0;
      for (const url of linkUrls) {
        linkIndex += 1;
        const competencia = requestedCompetencia || competenciaFromText(`${message.subject || ""} ${bodyText} ${url}`, message.receivedDateTime);
        if (!competencia) {
          const result = {
            status: "ignorada",
            source: "email_link",
            subject: message.subject || "",
            url,
            competencia: "",
            reason: "Competencia nao identificada no corpo do e-mail ou no link.",
          };
          messageResults.push(result);
          addResult("", result);
          continue;
        }
        const [[folhaRow]] = await pool.query("SELECT status FROM folhas WHERE competencia = ?", [competencia]);
        if (folhaRow?.status === "fechada" && !isTemporaryOpenCompetencia(competencia) && !includeClosed) {
          const result = { status: "ignorada", source: "email_link", subject: message.subject || "", url, competencia, reason: "Folha fechada." };
          messageResults.push(result);
          addResult(competencia, result);
          continue;
        }
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nf-email-link-"));
        try {
          const downloaded = await downloadNfLinkToFile(url, dir, linkIndex);
          const folhaData = await folhaDataForNfImport(competencia, includeClosed);
          let result;
          if (isNfFile(downloaded.filePath)) {
            result = await importNfFromFolderFile({ competencia, filePath: downloaded.filePath, folhaData, includeClosed });
          } else {
            const nfData = parseEmailNfData(`${downloaded.text || ""}\n${bodyText}`);
            if (!nfData.cnpj_emitente || !nfData.numero_nf || !nfData.valor_nf) {
              result = {
                status: "ignorada",
                file: path.basename(downloaded.filePath),
                source: "email_link",
                subject: message.subject || "",
                url,
                competencia,
                reason: "Link acessado, mas nao retornou PDF/XML nem dados suficientes da NF.",
              };
            } else {
              result = await importNfFromEmailData({
                competencia,
                nfData,
                originalName: `email-nf-${competencia}-${normalizeNfNumber(nfData.numero_nf)}.html`,
                content: bodyContent || downloaded.text || bodyText,
                folhaData,
                includeClosed,
                sourceUrl: url,
              });
            }
          }
          const enriched = {
            ...result,
            source: "email_link",
            subject: message.subject || "",
            receivedDateTime: message.receivedDateTime || "",
            from: message.from?.emailAddress?.address || "",
            url,
            competencia,
          };
          messageResults.push(enriched);
          addResult(competencia, enriched);
          if (["validada", "divergente", "duplicada"].includes(enriched.status)) break;
        } catch (error) {
          const result = { status: "erro", source: "email_link", subject: message.subject || "", url, competencia, reason: error.message };
          messageResults.push(result);
          addResult(competencia, result);
        } finally {
          fs.rm(dir, { recursive: true, force: true }, () => {});
        }
      }
    }
    if (!messageResults.some((result) => ["validada", "divergente", "duplicada"].includes(result.status))) {
      const competencia = requestedCompetencia || competenciaFromText(`${message.subject || ""} ${bodyText}`, message.receivedDateTime);
      const nfData = parseEmailNfData(bodyText);
      if (competencia && nfData.cnpj_emitente && nfData.numero_nf && nfData.valor_nf) {
        try {
          const [[folhaRow]] = await pool.query("SELECT status FROM folhas WHERE competencia = ?", [competencia]);
          if (folhaRow?.status !== "fechada" || isTemporaryOpenCompetencia(competencia) || includeClosed) {
            const folhaData = await folhaDataForNfImport(competencia, includeClosed);
            const result = await importNfFromEmailData({
              competencia,
              nfData,
              originalName: `email-nf-${competencia}-${normalizeNfNumber(nfData.numero_nf)}.html`,
              content: bodyContent || bodyText,
              folhaData,
              includeClosed,
              sourceUrl: "",
            });
            const enriched = {
              ...result,
              source: "email_body",
              subject: message.subject || "",
              receivedDateTime: message.receivedDateTime || "",
              from: message.from?.emailAddress?.address || "",
              competencia,
            };
            messageResults.push(enriched);
            addResult(competencia, enriched);
          }
        } catch (error) {
          const result = { status: "erro", source: "email_body", subject: message.subject || "", competencia, reason: error.message };
          messageResults.push(result);
          addResult(competencia, result);
        }
      }
    }
    const hadAction = messageResults.some((result) => ["validada", "divergente", "duplicada"].includes(result.status));
    const hadError = messageResults.some((result) => result.status === "erro");
    const detectedCompetencia = messageResults.find((result) => result.competencia)?.competencia
      || messageResults.find((result) => result.status !== "ignorada")?.competencia
      || requestedCompetencia
      || null;
    let movedTo = null;
    if (hadAction && !hadError) {
      try {
        await graphMoveMessage(mailbox, message.id, "Importados");
        movedTo = "Importados";
        for (const result of messageResults) result.movida_importados = true;
      } catch (error) {
        addResult("email", { status: "erro", subject: message.subject || "", reason: `NF importada, mas nao foi possivel mover o e-mail: ${error.message}` });
      }
    }
    if (messageResults.length) {
      await recordEmailImport(message, {
        competencia: detectedCompetencia,
        status: hadError ? "erro" : hadAction ? "processado" : "ignorado",
        resultado: messageResults,
        movedTo,
      });
    }
  }
  const results = [...grouped.values()].sort((a, b) => String(b.competencia).localeCompare(String(a.competencia)));
  return { root: mailbox, source: "email", competencias: results.map((item) => item.competencia), results };
}

async function latestNfsByCompetencia(competencia, db = pool) {
  const [rows] = await db.query(
    `SELECT n.*
     FROM nf_arquivos n
     JOIN (
       SELECT prestador_id, MAX(id) AS id
       FROM nf_arquivos
       WHERE competencia = ?
       GROUP BY prestador_id
     ) latest ON latest.id = n.id`,
    [competencia],
  );
  return new Map(rows.map((row) => [Number(row.prestador_id), row]));
}

async function attachNfsToItems(competencia, items, db = pool) {
  const nfs = await latestNfsByCompetencia(competencia, db);
  return items.map((item) => {
    const prestadorId = Number(item.prestador_id || item.id);
    const nf = nfs.get(prestadorId);
    if (!nf) return item;
    return {
      ...item,
      nf_id: nf.id,
      nf_status: nf.status,
      nf_original_name: nf.original_name,
      nf_numero: normalizeNfNumber(nf.numero_nf),
      nf_valor: nf.valor_nf,
      nf_divergencias: nf.divergencias,
      numero_nf: normalizeNfNumber(item.numero_nf || nf.numero_nf),
      valor_nf_emitida: Number(item.valor_nf_emitida || 0) > 0 ? item.valor_nf_emitida : nf.valor_nf,
    };
  });
}

function requirePerfil(...allowed) {
  return (req, res, next) => {
    if (!hasPerfil(req.user, allowed)) {
      return res.status(403).json({ error: "Usuario sem permissao para esta acao." });
    }
    return next();
  };
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!hasPermission(req.user, permission)) {
      return res.status(403).json({ error: "Usuario sem permissao para esta acao." });
    }
    return next();
  };
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function formatContaComDigito(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const withDash = raw.match(/(\d+)\s*-\s*([0-9Xx])$/);
  if (withDash) return `${onlyDigits(withDash[1])}-${String(withDash[2]).toUpperCase()}`;
  const digits = onlyDigits(raw);
  if (digits.length <= 1) return digits;
  return `${digits.slice(0, -1)}-${digits.slice(-1)}`;
}

function normalizeNfNumber(value) {
  const digits = onlyDigits(value);
  if (!digits) return String(value || "").trim();
  return digits.replace(/^0+/, "") || "0";
}

function validateCpf(value) {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;

  const calc = (factor) => {
    let total = 0;
    for (let i = 0; i < factor - 1; i += 1) total += Number(cpf[i]) * (factor - i);
    const digit = (total * 10) % 11;
    return digit === 10 ? 0 : digit;
  };

  return calc(10) === Number(cpf[9]) && calc(11) === Number(cpf[10]);
}

function validateCnpj(value) {
  const cnpj = onlyDigits(value);
  if (cnpj.length !== 14 || /^(\d)\1+$/.test(cnpj)) return false;

  const calc = (size) => {
    const weights = size === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const total = weights.reduce((sum, weight, index) => sum + Number(cnpj[index]) * weight, 0);
    const rest = total % 11;
    return rest < 2 ? 0 : 11 - rest;
  };

  return calc(12) === Number(cnpj[12]) && calc(13) === Number(cnpj[13]);
}

function required(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function money(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function daysInCompetencia(competencia) {
  const [year, month] = String(competencia).split("-").map(Number);
  if (!year || !month || month < 1 || month > 12) throw new Error("Competencia invalida.");
  return new Date(year, month, 0).getDate();
}

function competenciaEndDate(competencia) {
  const days = daysInCompetencia(competencia);
  return `${competencia}-${String(days).padStart(2, "0")}`;
}

function payrollBaseDays() {
  return 30;
}

function currentCompetencia() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function temporaryOpenCompetencias() {
  return String(process.env.TEMP_OPEN_COMPETENCIAS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function temporaryAdiantamentoCompetencias() {
  return String(process.env.TEMP_ADIANTAMENTO_COMPETENCIAS || process.env.TEMP_OPEN_COMPETENCIAS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isTemporaryAdiantamentoCompetencia(competencia) {
  return temporaryAdiantamentoCompetencias().includes(competencia);
}

function isTemporaryOpenCompetencia(competencia) {
  return temporaryOpenCompetencias().includes(competencia);
}

function dateCompetencia(value) {
  return String(value || "").slice(0, 7);
}

function isoDate(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function isAdmin(req) {
  return isFullAccess(req.user);
}

function daysBetweenDates(startDate, endDate) {
  if (!startDate || !endDate) return 0;
  const start = new Date(`${String(startDate).slice(0, 10)}T00:00:00`);
  const end = new Date(`${String(endDate).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  return Math.floor((end - start) / 86400000);
}

function calculateRescisao(prestador, dataRescisao, adiantamentosAbertos = 0, descontosManual = 0, options = {}) {
  const competencia = dateCompetencia(dataRescisao);
  const diasMes = daysInCompetencia(competencia);
  const day = Number(String(dataRescisao).slice(8, 10));
  const diasTrabalhados = Math.min(Math.max(day || 1, 1), diasMes);
  const salarioBase = money(prestador.salario_contrato);
  const valorProporcional = Number(((salarioBase / payrollBaseDays()) * diasTrabalhados).toFixed(2));
  const tipoRescisao = options.tipo_rescisao === "prestador" ? "prestador" : "empresa";
  const multaPercentual = tipoRescisao === "prestador"
    ? money(prestador.rescisao_multa_prestador_percentual || prestador.rescisao_multa_percentual)
    : money(prestador.rescisao_multa_empresa_percentual);
  const diasRestantesPeriodo = Math.max(payrollBaseDays() - diasTrabalhados, 0);
  const valorDiasRestantes = Number(((salarioBase / payrollBaseDays()) * diasRestantesPeriodo).toFixed(2));
  const valorMultaBase = Number(((valorDiasRestantes * multaPercentual) / 100).toFixed(2));
  const valorMulta = tipoRescisao === "prestador" ? -valorMultaBase : valorMultaBase;
  const avisoDias = daysBetweenDates(options.data_aviso, dataRescisao);
  const avisoCumprido = avisoDias >= 15;
  const valorTotalPagar = Number((valorProporcional + valorMulta - money(adiantamentosAbertos) - money(descontosManual)).toFixed(2));
  return {
    competencia,
    dias_mes: diasMes,
    dias_trabalhados: diasTrabalhados,
    salario_base: salarioBase,
    valor_proporcional: valorProporcional,
    data_aviso: options.data_aviso || null,
    tipo_rescisao: tipoRescisao,
    aviso_dias: avisoDias,
    aviso_cumprido: avisoCumprido,
    dias_restantes_periodo: diasRestantesPeriodo,
    valor_dias_restantes: valorDiasRestantes,
    multa_percentual: multaPercentual,
    valor_multa: valorMulta,
    adiantamentos_abertos: money(adiantamentosAbertos),
    descontos_manual: money(descontosManual),
    valor_total_pagar: valorTotalPagar,
  };
}

function workedDaysForCompetencia(prestador, competencia) {
  const realDays = daysInCompetencia(competencia);
  const monthStart = `${competencia}-01`;
  const monthEnd = `${competencia}-${String(realDays).padStart(2, "0")}`;
  const admissao = prestador.data_admissao || monthStart;
  const hasRescisao = Boolean(prestador.data_rescisao);
  const rescisao = prestador.data_rescisao || monthEnd;

  if (admissao > monthEnd || rescisao < monthStart) return 0;

  const admittedThisMonth = admissao.slice(0, 7) === competencia;
  const baseDays = admittedThisMonth || (hasRescisao && rescisao.slice(0, 7) === competencia)
    ? realDays
    : payrollBaseDays();
  const startDay = admittedThisMonth ? Number(admissao.slice(8, 10)) : 1;
  const endDay = hasRescisao && rescisao.slice(0, 7) === competencia
    ? Math.min(Number(rescisao.slice(8, 10)), realDays)
    : baseDays;
  return Math.min(Math.max(endDay - startDay + 1, 0), baseDays);
}

function pricingType(prestador) {
  return prestador?.precificacao_tipo === "diaria" ? "diaria" : "mensal";
}

function dailyPriced(prestador) {
  return pricingType(prestador) === "diaria";
}

function normalizeFolhaDays(value) {
  const days = Number(value || 0);
  return Number.isFinite(days) ? Math.max(0, days) : 0;
}

function folhaDaysForPrestador(prestador, competencia, ajuste = {}) {
  if (dailyPriced(prestador) && ajuste.dias_trabalhados !== undefined && ajuste.dias_trabalhados !== "") {
    return normalizeFolhaDays(ajuste.dias_trabalhados);
  }
  return workedDaysForCompetencia(prestador, competencia);
}

function folhaBaseValue(prestador) {
  return dailyPriced(prestador) ? money(prestador.valor_dia) : money(prestador.salario_contrato);
}

function folhaValorDias(prestador, diasTrabalhados) {
  const base = folhaBaseValue(prestador);
  return Number((dailyPriced(prestador) ? base * diasTrabalhados : (base / payrollBaseDays()) * diasTrabalhados).toFixed(2));
}

async function saveFolhaDraftRows(competencia, items = [], usuarioId = null, db = pool) {
  const normalized = normalizeApprovalItems(items);
  for (const item of normalized) {
    await db.query(
      `INSERT INTO folha_rascunhos
       (competencia, prestador_id, dias_trabalhados, adicoes, bonus, descontos_manual, valor_nf_emitida, numero_nf, usuario_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         dias_trabalhados = VALUES(dias_trabalhados),
         adicoes = VALUES(adicoes),
         bonus = VALUES(bonus),
         descontos_manual = VALUES(descontos_manual),
         valor_nf_emitida = VALUES(valor_nf_emitida),
         numero_nf = VALUES(numero_nf),
         usuario_id = VALUES(usuario_id)`,
      [
        competencia,
        item.prestador_id,
        item.dias_trabalhados,
        item.adicoes,
        item.bonus,
        item.descontos_manual,
        item.valor_nf_emitida,
        item.numero_nf || null,
        usuarioId,
      ],
    );
  }
}

async function applyFolhaDrafts(competencia, itens, db = pool) {
  if (!itens.length) return itens;
  const [rows] = await db.query("SELECT * FROM folha_rascunhos WHERE competencia = ?", [competencia]);
  if (!rows.length) return itens;
  const drafts = new Map(rows.map((row) => [Number(row.prestador_id), row]));
  return itens.map((item) => {
    const draft = drafts.get(Number(item.prestador_id || item.id));
    if (!draft) return item;
    const diasTrabalhados = dailyPriced(item)
      ? normalizeFolhaDays(draft.dias_trabalhados)
      : Number(item.dias_trabalhados || 0);
    const valorDias = folhaValorDias(item, diasTrabalhados);
    const adicoes = money(draft.adicoes);
    const bonus = money(draft.bonus);
    const descontosManual = money(draft.descontos_manual);
    const valorNfPrevisto = Number((valorDias + adicoes + bonus).toFixed(2));
    const liquido = Number((valorNfPrevisto - descontosManual - Number(item.desconto_adiantamentos || 0)).toFixed(2));
    const nfLocked = item.nf_status === "validada";
    const valorNfEmitida = nfLocked ? Number(item.valor_nf_emitida || 0) : money(draft.valor_nf_emitida);
    const numeroNf = nfLocked ? item.numero_nf : normalizeNfNumber(draft.numero_nf);
    return {
      ...item,
      dias_trabalhados: diasTrabalhados,
      valor_dias: valorDias,
      adicoes,
      bonus,
      descontos_manual: descontosManual,
      valor_nf_previsto: valorNfPrevisto,
      valor_nf_emitida: valorNfEmitida,
      numero_nf: numeroNf || null,
      liquido_pagar: liquido,
      diferenca_nf: Number((valorNfEmitida - liquido).toFixed(2)),
    };
  });
}

function shouldUseFolhaSnapshot(folha = {}) {
  return ["em_aprovacao", "fechada"].includes(folha.status) && !folha.temporaryOpen;
}

function folhaItemSnapshot(item, folha = {}) {
  if (!shouldUseFolhaSnapshot(folha)) return item;
  const historicalBase = item.salario_base !== undefined && item.salario_base !== null
    ? item.salario_base
    : item.salario_contrato;
  return {
    ...item,
    nome: item.prestador_nome || item.nome,
    razao_social: item.prestador_razao_social || item.razao_social,
    cpf: item.prestador_cpf || item.cpf,
    cnpj: item.prestador_cnpj || item.cnpj,
    email: item.prestador_email || item.email,
    telefone: item.prestador_telefone || item.telefone,
    funcao: item.funcao_snapshot || item.funcao,
    categoria: item.categoria_snapshot || item.categoria,
    categoria_omie_codigo: item.categoria_omie_codigo_snapshot || item.categoria_omie_codigo,
    departamento: item.departamento_snapshot || item.departamento,
    projeto: item.projeto_snapshot || item.projeto,
    unidade_nome: item.unidade_nome_snapshot || item.unidade_nome,
    cargo_nivel: item.cargo_nivel_snapshot || item.cargo_nivel,
    precificacao_tipo: item.precificacao_tipo_snapshot || item.precificacao_tipo,
    data_admissao: item.data_admissao_snapshot || item.data_admissao,
    data_rescisao: item.data_rescisao_snapshot || item.data_rescisao,
    banco: item.banco_snapshot || item.banco,
    agencia: item.agencia_snapshot || item.agencia,
    conta: item.conta_snapshot || item.conta,
    omie_codigo_cliente: item.omie_codigo_cliente_snapshot || item.omie_codigo_cliente,
    omie_codigo_integracao: item.omie_codigo_integracao_snapshot || item.omie_codigo_integracao,
    salario_contrato: historicalBase,
    valor_dia: dailyPriced(item) ? historicalBase : (item.valor_dia_snapshot || item.valor_dia),
  };
}

function addMonths(competencia, amount) {
  const [year, month] = competencia.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + amount, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function nextMonthDeadline(competencia) {
  const [year, month] = competencia.split("-").map(Number);
  const date = new Date(Date.UTC(year, month, 3));
  return date.toISOString().slice(0, 10);
}

function formatCurrency(value) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(money(value));
}

function graphConfigured() {
  return Boolean(process.env.GRAPH_TENANT_ID && process.env.GRAPH_CLIENT_ID && process.env.GRAPH_CLIENT_SECRET && process.env.GRAPH_FROM);
}

function emailConfigured() {
  return graphConfigured();
}

async function graphAccessToken(requiredRole = "Mail.Send") {
  const tenantId = process.env.GRAPH_TENANT_ID;
  const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GRAPH_CLIENT_ID,
      client_secret: process.env.GRAPH_CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.error || "Nao foi possivel autenticar no Microsoft Graph.");
  const roles = graphTokenRoles(data.access_token);
  const requiredRoles = Array.isArray(requiredRole) ? requiredRole : [requiredRole].filter(Boolean);
  if (requiredRoles.length && !requiredRoles.some((role) => roles.includes(role))) {
    throw new Error(`Microsoft Graph autenticou, mas o aplicativo nao recebeu a permissao Application ${requiredRoles.join(" ou ")} com consentimento de administrador.`);
  }
  return data.access_token;
}

function graphTokenRoles(token) {
  try {
    const payload = token.split(".")[1];
    const decoded = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(decoded).roles || [];
  } catch (_error) {
    return [];
  }
}

async function sendGraphMail({ to, subject, html, text }) {
  const from = process.env.GRAPH_FROM;
  const token = await graphAccessToken();
  const recipients = String(to || "")
    .split(/[;,]/)
    .map((email) => email.trim())
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));
  if (!recipients.length) throw new Error("Informe ao menos um destinatario.");
  const response = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        subject,
        body: {
          contentType: html ? "HTML" : "Text",
          content: html || text || "",
        },
        toRecipients: recipients,
      },
      saveToSentItems: true,
    }),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    const message = detail?.error?.message || detail?.error || `Microsoft Graph retornou HTTP ${response.status}.`;
    throw new Error(message);
  }
  return { messageId: "graph-sendMail", accepted: recipients.map((item) => item.emailAddress.address), rejected: [] };
}

async function sendMailMessage({ to, subject, html, text }) {
  return sendGraphMail({ to, subject, html, text });
}

function localNetworkHost() {
  const interfaces = os.networkInterfaces();
  const addresses = Object.values(interfaces)
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => item.address);
  return addresses.find((address) => address.startsWith("10."))
    || addresses.find((address) => address.startsWith("192.168."))
    || addresses.find((address) => address.startsWith("172."))
    || addresses[0]
    || os.hostname();
}

function publicUrl(url) {
  const host = localNetworkHost();
  return String(url || "")
    .replace(/^https?:\/\/localhost(?::\d+)?/i, (match) => match.replace(/localhost/i, host))
    .replace(/^https?:\/\/127\.0\.0\.1(?::\d+)?/i, (match) => match.replace(/127\.0\.0\.1/i, host))
    .replace(/^https?:\/\/\[::1\](?::\d+)?/i, (match) => match.replace(/\[::1\]/i, host));
}

function appUrl(req, pathName = "/") {
  const requestHost = req.get("host") || `localhost:${port}`;
  const isLocalhost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(requestHost);
  const publicHost = isLocalhost ? `${localNetworkHost()}:${port}` : requestHost;
  const configured = String(process.env.APP_URL || "");
  const configuredIsLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/i.test(configured);
  const base = String(configured && !configuredIsLocalhost ? configured : `${req.protocol}://${publicHost}`).replace(/\/$/, "");
  return `${base}${pathName.startsWith("/") ? pathName : `/${pathName}`}`;
}

function reembolsoAppUrl(req, pathName = "/") {
  const reembolsoPort = Number(process.env.REEMBOLSO_PORT || 3100);
  const requestHost = req.get("host") || `localhost:${port}`;
  const hostname = String(requestHost).replace(/:\d+$/, "");
  const isLocalhost = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(hostname);
  const publicHost = isLocalhost ? localNetworkHost() : hostname;
  const configured = String(process.env.REEMBOLSO_APP_URL || "");
  const configuredIsLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/i.test(configured);
  const base = String(configured && !configuredIsLocalhost ? configured : `${req.protocol}://${publicHost}:${reembolsoPort}`).replace(/\/$/, "");
  return `${base}${pathName.startsWith("/") ? pathName : `/${pathName}`}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderTemplateString(template, vars = {}) {
  return String(template || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key) => {
    const value = vars[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

function plainTemplateToHtml(template, vars = {}) {
  const rendered = renderTemplateString(template, vars);
  return escapeHtml(rendered)
    .split(/\r?\n\r?\n/)
    .map((block) => `<p>${block.replace(/\r?\n/g, "<br>")}</p>`)
    .join("");
}

function approvalEmailHtml(template, vars = {}) {
  const link = publicUrl(vars.link);
  const detalhe = String(vars.detalhe || "").trim();
  const resumoRows = [
    ["Processo", vars.titulo],
    ["Resumo", detalhe],
    ["Link", link],
  ].filter(([, value]) => String(value || "").trim());
  const resumoHtml = resumoRows.length ? `
    <div style="margin:16px 0;padding:14px;border:1px solid #d7dde6;border-radius:6px;background:#f8fafc">
      <strong style="display:block;margin-bottom:10px;color:#0b1726">Resumo para aprovacao</strong>
      <table style="width:100%;border-collapse:collapse;font-family:Segoe UI,Arial,sans-serif;font-size:13px">
        ${resumoRows.map(([label, value]) => `
          <tr>
            <td style="width:110px;padding:7px;border-top:1px solid #e5e7eb;color:#667085;font-weight:700">${escapeHtml(label)}</td>
            <td style="padding:7px;border-top:1px solid #e5e7eb;color:#0b1726">${escapeHtml(value)}</td>
          </tr>
        `).join("")}
      </table>
    </div>
    <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#002b5f;color:#fff;text-decoration:none;padding:10px 14px;border-radius:4px;font-weight:700">Abrir aprovacao</a></p>
  ` : "";
  return `${plainTemplateToHtml(template, { ...vars, link })}${resumoHtml}`;
}

async function getEmailTemplate(tipo) {
  const [[row]] = await pool.query("SELECT * FROM email_templates WHERE tipo = ?", [tipo]);
  return row || { tipo, ...emailTemplateDefaults[tipo] };
}

function approvalOrderFor(tipo = "folha") {
  return tipo === "folha" ? folhaApprovalOrder : shortApprovalOrder;
}

function approvalRank(user, tipo = "folha") {
  const normalized = normalizeLookupText(`${user.nome || ""} ${user.email || ""}`);
  const index = approvalOrderFor(tipo).findIndex((token) => normalized.includes(token));
  return index >= 0 ? index : 999;
}

async function getMandatoryApprovers(db = pool, tipo = "folha") {
  const [users] = await db.query(
    "SELECT id, nome, email, perfil, permissoes_json FROM usuarios WHERE ativo = 1 ORDER BY nome",
  );
  const order = approvalOrderFor(tipo);
  return users
    .filter((user) => isMandatoryApprover(user))
    .filter((user) => approvalRank(user, tipo) < order.length)
    .sort((a, b) => approvalRank(a, tipo) - approvalRank(b, tipo) || String(a.nome).localeCompare(String(b.nome), "pt-BR"));
}

async function sendApprovalRequestEmails(req, { titulo, detalhe, link, approvers = null, tipo = "folha" }) {
  if (!emailConfigured()) return { sent: false, reason: "E-mail nao configurado.", enviados: [], falhas: [] };
  const targetApprovers = approvers || await getMandatoryApprovers(pool, tipo);
  const template = await getEmailTemplate("aprovacao");
  const enviados = [];
  const falhas = [];
  for (const approver of targetApprovers) {
    const email = String(approver.email || "").trim();
    if (!email) {
      falhas.push({ id: approver.id, nome: approver.nome, erro: "Aprovador sem e-mail cadastrado." });
      continue;
    }
    try {
      const vars = {
        aprovador_nome: approver.nome,
        aprovador_email: email,
        titulo,
        detalhe,
        link: publicUrl(link),
      };
      await sendMailMessage({
        to: email,
        subject: renderTemplateString(template.assunto, vars) || titulo,
        html: approvalEmailHtml(template.corpo, vars),
      });
      enviados.push({ id: approver.id, nome: approver.nome, email });
    } catch (error) {
      falhas.push({ id: approver.id, nome: approver.nome, email, erro: error.message });
    }
  }
  return { sent: enviados.length > 0, enviados, falhas, total: targetApprovers.length };
}

async function sendNextApprovalEmail(req, { tipo = "folha", titulo, detalhe, link, aprovacoes }) {
  const next = aprovacoes?.proximo;
  if (!next) return { sent: false, reason: "Fluxo de aprovação completo.", enviados: [], falhas: [], total: 0 };
  return sendApprovalRequestEmails(req, { titulo, detalhe, link, approvers: [next], tipo });
}

function assertSequentialApprover(user, aprovacoes) {
  const next = aprovacoes?.proximo;
  if (!next) throw new Error("Não há aprovação pendente para este processo.");
  if (Number(next.id) !== Number(user.id)) {
    throw new Error(`Aguardando aprovação de ${next.nome}.`);
  }
}

function folhaPaymentBlockReason(item, user = null) {
  const reasons = [];
  if (!nfValidatedOrSimoneException(user, item)) reasons.push(item.nf_status === "divergente" ? "NF divergente" : "NF pendente");
  if (!normalizeNfNumber(item.numero_nf || item.nf_numero)) reasons.push("Numero da NF nao informado");
  if (money(item.valor_nf_emitida || item.nf_valor) <= 0) reasons.push("Valor da NF nao informado");
  if (Math.abs(Number(item.diferenca_nf || 0)) > 0.01) reasons.push("Diferenca de NF");
  if (money(item.liquido_pagar) <= 0) reasons.push("Total a pagar zerado");
  return [...new Set(reasons)];
}

function folhaItemReadyForPayment(item, user = null) {
  return folhaPaymentBlockReason(item, user).length === 0;
}

async function ensureFolhaRow(competencia, db = pool, status = "aberta") {
  await db.query(
    `INSERT INTO folhas (competencia, dias_mes, status)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE dias_mes = VALUES(dias_mes)`,
    [competencia, daysInCompetencia(competencia), status],
  );
  const [[folha]] = await db.query("SELECT * FROM folhas WHERE competencia = ?", [competencia]);
  return folha;
}

async function nextFolhaLoteNumber(competencia, db = pool) {
  const [[row]] = await db.query("SELECT COALESCE(MAX(numero), 0) + 1 AS numero FROM folha_lotes WHERE competencia = ?", [competencia]);
  return Number(row.numero || 1);
}

async function getFolhaLotes(competencia, db = pool) {
  const [lotes] = await db.query(
    `SELECT fl.*, COUNT(fi.id) AS itens, COALESCE(SUM(fi.liquido_pagar), 0) AS total
     FROM folha_lotes fl
     LEFT JOIN folha_itens fi ON fi.lote_id = fl.id
     WHERE fl.competencia = ?
     GROUP BY fl.id
     ORDER BY fl.numero DESC`,
    [competencia],
  );
  return lotes.map((lote) => ({ ...lote, itens: Number(lote.itens || 0), total: Number(lote.total || 0), label: `Lote ${lote.numero}` }));
}

async function createFolhaLote(competencia, itens, userId, db = pool) {
  const folha = await ensureFolhaRow(competencia, db, "aberta");
  const numero = await nextFolhaLoteNumber(competencia, db);
  const initialPayloadHash = approvalPayloadHash(competencia, itens);
  const [result] = await db.query(
    `INSERT INTO folha_lotes (folha_id, competencia, numero, status, payload_hash, itens_json, criado_por)
     VALUES (?, ?, ?, 'em_aprovacao', ?, ?, ?)`,
    [folha.id, competencia, numero, initialPayloadHash, JSON.stringify(normalizeApprovalItems(itens)), userId || null],
  );
  const loteId = result.insertId;
  const payloadHash = approvalPayloadHash(competencia, itens, loteId);
  await db.query("UPDATE folha_lotes SET payload_hash = ? WHERE id = ?", [payloadHash, loteId]);
  await db.query(
    `UPDATE folhas
     SET status = 'em_aprovacao', approval_payload_hash = ?, approval_rejeitado_por = NULL,
       approval_rejeitado_em = NULL, approval_rejeicao_motivo = NULL
     WHERE id = ?`,
    [payloadHash, folha.id],
  );
  return { id: loteId, folha_id: folha.id, competencia, numero, payload_hash: payloadHash };
}

async function autoCloseApprovedFolha(competencia, itens, db = pool, loteId = null) {
  const diasMes = daysInCompetencia(competencia);
  const approvedIds = new Set((itens || []).map((item) => Number(item.prestador_id || item.id)).filter(Boolean));
  if (!approvedIds.size) throw new Error("Nenhum item apto para fechar no lote.");
  await db.query(
    `INSERT INTO folhas (competencia, dias_mes, status, fechado_em)
     VALUES (?, ?, 'aberta', NOW())
     ON DUPLICATE KEY UPDATE dias_mes = VALUES(dias_mes), fechado_em = NOW(), approval_rejeitado_por = NULL, approval_rejeitado_em = NULL, approval_rejeicao_motivo = NULL`,
    [competencia, diasMes],
  );
  const [[folha]] = await db.query("SELECT id FROM folhas WHERE competencia = ?", [competencia]);
  await db.query(
    `UPDATE adiantamento_parcelas ap
     JOIN adiantamentos a ON a.id = ap.adiantamento_id
     SET ap.descontado = 0, ap.folha_id = NULL
     WHERE ap.folha_id = ? AND a.prestador_id IN (?)`,
    [folha.id, [...approvedIds]],
  );
  await db.query("DELETE FROM folha_itens WHERE folha_id = ? AND prestador_id IN (?)", [folha.id, [...approvedIds]]);

  const [prestadores] = await db.query(
    `SELECT p.*, COALESCE(cli.nome, u.nome) AS unidade_nome, fn.nome AS funcao, c.nome AS categoria,
      c.omie_codigo AS categoria_omie_codigo, d.nome AS departamento, pr.nome AS projeto
     FROM prestadores p
     LEFT JOIN unidades u ON u.id = p.unidade_id
     LEFT JOIN clientes cli ON cli.id = p.cliente_id
     LEFT JOIN funcoes fn ON fn.id = p.funcao_id
     LEFT JOIN categorias c ON c.id = p.categoria_id
     LEFT JOIN departamentos d ON d.id = p.departamento_id
     LEFT JOIN projetos pr ON pr.id = p.projeto_id
     WHERE p.ativo = 1 AND p.id IN (?)
     ORDER BY p.nome, p.razao_social`,
    [[...approvedIds]],
  );
  const ajustes = new Map((itens || []).map((item) => [Number(item.prestador_id || item.id), item]));
  for (const prestador of prestadores) {
    const ajuste = ajustes.get(Number(prestador.id)) || {};
    const diasTrabalhados = folhaDaysForPrestador(prestador, competencia, ajuste);
    if (diasTrabalhados <= 0) continue;
    const salarioBase = folhaBaseValue(prestador);
    const valorDias = folhaValorDias(prestador, diasTrabalhados);
    const adicoes = money(ajuste.adicoes);
    const bonus = money(ajuste.bonus);
    const descontosManual = money(ajuste.descontos_manual);
    const [[adiantamento]] = await db.query(
      `SELECT COALESCE(SUM(valor), 0) AS total
       FROM adiantamento_parcelas ap
       JOIN adiantamentos a ON a.id = ap.adiantamento_id
       WHERE a.prestador_id = ? AND ap.competencia = ? AND ap.descontado = 0`,
      [prestador.id, competencia],
    );
    const descontoAdiantamentos = money(adiantamento.total);
    const valorNfPrevisto = Number((valorDias + adicoes + bonus).toFixed(2));
    const valorNfEmitida = ajuste.valor_nf_emitida === "" || ajuste.valor_nf_emitida === undefined ? 0 : money(ajuste.valor_nf_emitida);
    const liquido = Number((valorNfPrevisto - descontosManual - descontoAdiantamentos).toFixed(2));
    await db.query(
      `INSERT INTO folha_itens
       (folha_id, lote_id, prestador_id, prestador_nome, prestador_razao_social, prestador_cpf, prestador_cnpj,
        prestador_email, prestador_telefone, funcao_snapshot, categoria_snapshot, categoria_omie_codigo_snapshot,
        departamento_snapshot, projeto_snapshot, unidade_nome_snapshot, cargo_nivel_snapshot, precificacao_tipo_snapshot,
        valor_dia_snapshot, data_admissao_snapshot, data_rescisao_snapshot, banco_snapshot, agencia_snapshot,
        conta_snapshot, omie_codigo_cliente_snapshot, omie_codigo_integracao_snapshot,
        dias_trabalhados, salario_base, valor_dias, adicoes, bonus,
        descontos_manual, desconto_adiantamentos, valor_nf_previsto, valor_nf_emitida,
        numero_nf, liquido_pagar, observacao)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        folha.id,
        loteId || null,
        prestador.id,
        prestador.nome,
        prestador.razao_social,
        prestador.cpf,
        prestador.cnpj,
        prestador.email,
        prestador.telefone,
        prestador.funcao,
        prestador.categoria,
        prestador.categoria_omie_codigo,
        prestador.departamento,
        prestador.projeto,
        prestador.unidade_nome,
        prestador.cargo_nivel,
        prestador.precificacao_tipo,
        prestador.valor_dia,
        prestador.data_admissao,
        prestador.data_rescisao,
        prestador.banco,
        prestador.agencia,
        prestador.conta,
        prestador.omie_codigo_cliente,
        prestador.omie_codigo_integracao,
        diasTrabalhados,
        salarioBase,
        valorDias,
        adicoes,
        bonus,
        descontosManual,
        descontoAdiantamentos,
        valorNfPrevisto,
        valorNfEmitida,
        normalizeNfNumber(ajuste.numero_nf) || null,
        liquido,
        ajuste.observacao || null,
      ],
    );
    await db.query(
      `UPDATE adiantamento_parcelas ap
       JOIN adiantamentos a ON a.id = ap.adiantamento_id
       SET ap.descontado = 1, ap.folha_id = ?
       WHERE a.prestador_id = ? AND ap.competencia = ? AND ap.descontado = 0`,
      [folha.id, prestador.id, competencia],
    );
  }
  if (loteId) {
    await db.query("UPDATE folha_lotes SET status = 'fechado', aprovado_em = NOW(), fechado_em = NOW() WHERE id = ?", [loteId]);
  }
  await db.query("UPDATE folhas SET status = 'aberta' WHERE id = ?", [folha.id]);
}

function isEndMonthNfReminderWindow(competencia, referenceDate = new Date()) {
  const [year, month] = String(competencia || "").split("-").map(Number);
  if (!year || !month) return false;
  const start = new Date(year, month - 1, daysInCompetencia(competencia) - 2);
  const end = new Date(year, month - 1, daysInCompetencia(competencia), 23, 59, 59, 999);
  return referenceDate >= start && referenceDate <= end;
}

async function sendRescisaoNfEmailReminder(rescisaoId, { force = true } = {}) {
  const destinoNf = process.env.NF_DESTINATION_EMAIL || "paulo.mendonca@redefrete.com.br";
  const [[rescisao]] = await pool.query(
    `SELECT r.*, p.nome, p.razao_social, p.email
     FROM rescisoes r
     JOIN prestadores p ON p.id = r.prestador_id
     WHERE r.id = ?`,
    [rescisaoId],
  );
  if (!rescisao) throw new Error("Rescisao nao encontrada.");
  if (!emailConfigured()) return { sent: false, reason: "E-mail nao configurado.", destinoNf };
  if (!String(rescisao.email || "").trim()) return { sent: false, reason: "Prestador sem e-mail cadastrado.", destinoNf };
  if (!force) {
    const [[sentToday]] = await pool.query(
      "SELECT id FROM nf_followups WHERE competencia = ? AND prestador_id = ? AND DATE(enviado_em) = CURDATE() LIMIT 1",
      [rescisao.competencia, rescisao.prestador_id],
    );
    if (sentToday) return { sent: false, reason: "Follow-up ja enviado hoje.", destinoNf };
  }
  try {
    const template = await getEmailTemplate("rescisao_nf");
    const vars = {
      nome: rescisao.nome,
      razao_social: rescisao.razao_social || rescisao.nome,
      competencia: rescisao.competencia,
      data_rescisao: rescisao.data_rescisao,
      valor: formatCurrency(rescisao.valor_total_pagar),
      email_destino_nf: destinoNf,
    };
    await sendMailMessage({
      to: rescisao.email,
      subject: renderTemplateString(template.assunto, vars),
      html: plainTemplateToHtml(template.corpo, vars),
    });
    await pool.query(
      "INSERT INTO nf_followups (competencia, prestador_id, canal, status) VALUES (?, ?, 'email', 'enviado')",
      [rescisao.competencia, rescisao.prestador_id],
    );
    return { sent: true, to: rescisao.email, destinoNf };
  } catch (error) {
    await pool.query(
      "INSERT INTO nf_followups (competencia, prestador_id, canal, status, erro) VALUES (?, ?, 'email', 'erro', ?)",
      [rescisao.competencia, rescisao.prestador_id, error.message],
    );
    return { sent: false, reason: error.message, destinoNf };
  }
}

async function sendPendingNfEmailReminders(competencia, { force = false } = {}) {
  const prazo = nextMonthDeadline(competencia);
  const destinoNf = process.env.NF_DESTINATION_EMAIL || "paulo.mendonca@redefrete.com.br";
  const hoje = new Date().toISOString().slice(0, 10);
  const template = await getEmailTemplate("folha_nf");
  const enviados = [];
  const falhas = [];
  const semEmail = [];

  if (!force && !isEndMonthNfReminderWindow(competencia)) {
    return { sent: false, reason: "Fora da janela de lembrete.", enviados, falhas, semEmail, prazo, destinoNf };
  }
  if (!emailConfigured()) {
    return { sent: false, reason: "E-mail nao configurado.", enviados, falhas, semEmail, prazo, destinoNf };
  }

  const data = await buildFolhaAberta(competencia, { perfil: "master" });
  const pendentes = data.itens.filter((item) => !nfValidatedOrSimoneException(null, item));

  for (const item of pendentes) {
    const email = String(item.email || "").trim();
    if (!email) {
      semEmail.push({ prestador_id: item.id, nome: item.nome, razao_social: item.razao_social });
      continue;
    }
    if (!force) {
      const [[sentToday]] = await pool.query(
        "SELECT id FROM nf_followups WHERE competencia = ? AND prestador_id = ? AND status = 'email_enviado' AND DATE(enviado_em) = ? LIMIT 1",
        [competencia, item.id, hoje],
      );
      if (sentToday) continue;
    }
    try {
      const vars = {
        nome: item.nome,
        razao_social: item.razao_social || item.nome,
        competencia,
        valor: formatCurrency(item.liquido_pagar),
        prazo,
        email_destino_nf: destinoNf,
      };
      const result = await sendMailMessage({
        to: email,
        subject: renderTemplateString(template.assunto, vars),
        html: plainTemplateToHtml(template.corpo, vars),
      });
      await pool.query(
        "INSERT INTO nf_followups (competencia, prestador_id, status) VALUES (?, ?, 'email_enviado')",
        [competencia, item.id],
      );
      enviados.push({ to: email, prestador_id: item.id, result: result.messageId || "enviado" });
    } catch (error) {
      await pool.query(
        "INSERT INTO nf_followups (competencia, prestador_id, status, erro) VALUES (?, ?, 'email_erro', ?)",
        [competencia, item.id, error.message],
      );
      falhas.push({ to: email, prestador_id: item.id, error: error.message });
    }
  }

  return { sent: falhas.length === 0, enviados, falhas, semEmail, prazo, destinoNf };
}

let lastNfFollowupRun = "";

async function runDailyNfFollowupIfDue() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (lastNfFollowupRun === today || now.getHours() !== 9) return;
  lastNfFollowupRun = today;
  const competencias = await openCompetencias();
  for (const competencia of competencias) {
    await sendPendingNfEmailReminders(competencia).catch((error) => {
      console.error(`Falha no lembrete automatico de NF ${competencia}:`, error.message);
    });
  }
}

function omieConfigured() {
  return Boolean(process.env.OMIE_APP_KEY && process.env.OMIE_APP_SECRET);
}

function omieEndpoint(service) {
  const endpoints = {
    clientes: "https://app.omie.com.br/api/v1/geral/clientes/",
    contaPagar: "https://app.omie.com.br/api/v1/financas/contapagar/",
    contaCorrente: "https://app.omie.com.br/api/v1/geral/contacorrente/",
    categorias: "https://app.omie.com.br/api/v1/geral/categorias/",
    projetos: "https://app.omie.com.br/api/v1/geral/projetos/",
    departamentos: "https://app.omie.com.br/api/v1/geral/departamentos/",
    anexo: "https://app.omie.com.br/api/v1/geral/anexo/",
  };
  return endpoints[service];
}

async function omieCall(service, call, params = {}) {
  if (!omieConfigured()) throw new Error("Omie ainda nao esta configurado.");
  const delayMs = Number(process.env.OMIE_REQUEST_DELAY_MS || 1200);
  if (delayMs > 0) await sleep(delayMs);
  const response = await fetch(omieEndpoint(service), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      call,
      app_key: process.env.OMIE_APP_KEY,
      app_secret: process.env.OMIE_APP_SECRET,
      param: [params],
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.faultstring || data.faultcode) {
    throw new Error(data.faultstring || data.message || `Falha na API Omie (${call}).`);
  }
  return data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isOmieRateLimitError(error) {
  return /bloquead[ao] por consumo indevido|tente novamente em/i.test(String(error?.message || ""));
}

function isOmieStructuralError(error) {
  return /tag \[[^\]]+\] n[aã]o deve ser informada|n[aã]o cadastr|inv[aá]lid|obrigat[oó]ri/i.test(String(error?.message || ""));
}

function parseOmieRetrySeconds(message) {
  const match = String(message || "").match(/(\d+)\s+segundos/i);
  return match ? Number(match[1]) : null;
}

function normalizeLookupText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function formatOmieDate(isoDate) {
  const [year, month, day] = String(isoDate).split("-");
  return `${day}/${month}/${year}`;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function zipSingleFile(fileName, content) {
  const name = Buffer.from(fileName, "utf8");
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const compressed = zlib.deflateRawSync(data);
  const crc = crc32(data);
  const { dosTime, dosDate } = dosDateTime();
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(dosTime, 12);
  central.writeUInt16LE(dosDate, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const centralOffset = local.length + name.length + compressed.length;
  const centralSize = central.length + name.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, compressed, central, name, end]);
}

function sanitizeOmieFileName(fileName, fallback = "arquivo.pdf") {
  const ext = path.extname(fileName || fallback).replace(/[^.\w]/g, "").slice(0, 8) || path.extname(fallback);
  const base = path.basename(fileName || fallback, path.extname(fileName || fallback))
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80) || "arquivo";
  return `${base}${ext}`.slice(0, 100);
}

async function omieIncluirAnexo({ nId, cCodIntAnexo, cNomeArquivo, content }) {
  const fileName = sanitizeOmieFileName(cNomeArquivo);
  const zip = zipSingleFile(fileName, content);
  const encodedZip = zip.toString("base64");
  const payload = {
    cCodIntAnexo: String(cCodIntAnexo).slice(0, 20),
    cTabela: "conta-pagar",
    nId: Number(nId),
    cNomeArquivo: fileName,
    cTipoArquivo: path.extname(fileName).replace(".", "").toUpperCase().slice(0, 10),
    cArquivo: encodedZip,
    cMd5: crypto.createHash("md5").update(encodedZip).digest("hex"),
  };
  const result = await omieCall("anexo", "IncluirAnexo", payload);
  if (/cadastrad|existe|duplic/i.test(String(result?.cDesStatus || result?.message || "")) && result?.nIdAnexo) {
    await omieCall("anexo", "ExcluirAnexo", {
      cCodIntAnexo: payload.cCodIntAnexo,
      cTabela: payload.cTabela,
      nId: payload.nId,
      nIdAnexo: result.nIdAnexo,
      cNomeArquivo: payload.cNomeArquivo,
    });
    return omieCall("anexo", "IncluirAnexo", payload);
  }
  return result;
}

function browserExecutablePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "msedge",
  ].filter(Boolean);
  return candidates.find((candidate) => candidate.includes("\\") ? fs.existsSync(candidate) : candidate) || null;
}

async function htmlToPdfBuffer(html) {
  const browser = browserExecutablePath();
  if (!browser) throw new Error("Chrome/Edge nao encontrado para gerar PDF do relatorio.");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rescisao-pdf-"));
  const htmlPath = path.join(dir, "relatorio.html");
  const pdfPath = path.join(dir, "relatorio.pdf");
  fs.writeFileSync(htmlPath, html, "utf8");
  try {
    await execFileAsync(browser, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--print-to-pdf-no-header",
      `--print-to-pdf=${pdfPath}`,
      `file:///${htmlPath.replace(/\\/g, "/")}`,
    ], { timeout: 60000, windowsHide: true });
    return fs.readFileSync(pdfPath);
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

function formatDateBr(value) {
  if (!value) return "";
  const [year, month, day] = String(value).slice(0, 10).split("-");
  return year && month && day ? `${day}/${month}/${year}` : String(value);
}

function renderFolhaItemReportHtml(item, competencia) {
  const proventos = money(item.valor_dias) + money(item.adicoes) + money(item.bonus);
  const descontos = money(item.descontos_manual) + money(item.desconto_adiantamentos);
  const diferencaNf = money(item.valor_nf_emitida) - money(item.liquido_pagar);
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>
    @page{size:A4;margin:9mm}*{box-sizing:border-box}body{font-family:Segoe UI,Arial,sans-serif;margin:0;color:#061426;background:#fff;font-size:12px}.head{background:#141923;color:#fff;display:grid;grid-template-columns:185px 1fr 170px;gap:18px;align-items:center;padding:18px}.brand{display:flex;align-items:center;gap:10px}.mark{width:38px;height:38px;border:4px solid #fff;display:grid;place-items:center;font-size:24px;font-weight:900}.brand strong{font-size:26px;line-height:1}.brand small,.head small{display:block;color:#dbe4ef;text-transform:uppercase;font-weight:800;letter-spacing:.04em}.head h1{margin:4px 0 0;font-size:24px}.meta{text-align:right}.meta strong{display:block;font-size:18px}.summary{display:grid;grid-template-columns:repeat(5,1fr);border-bottom:1px solid #d7dde6}.summary article{padding:13px;border-right:1px solid #d7dde6}.summary span{display:block;color:#667085;text-transform:uppercase;font-weight:900;font-size:11px}.summary strong{display:block;margin-top:5px;font-size:17px}.section-title{display:flex;justify-content:space-between;align-items:end;padding:16px 8px 8px}.section-title h2{font-size:17px;margin:0}table{width:100%;border-collapse:collapse}th,td{border:1px solid #d7dde6;padding:8px;text-align:left;vertical-align:top}th{background:#f3f6f9;text-transform:uppercase;font-size:11px}.num{text-align:right;white-space:nowrap}.two-col{display:grid;grid-template-columns:1fr 1fr;gap:0;margin-top:14px}.total-row td,.total-row th{font-weight:900;background:#f8fafc}.footer{display:flex;justify-content:space-between;padding:14px 6px;color:#667085;font-size:10px}
  </style></head><body><main>
    <header class="head"><div class="brand"><div class="mark">R</div><div><strong>redefrete</strong><small>Redefrete Logistica</small></div></div><div><small>Demonstrativo individual PJ</small><h1>Detalhamento de pagamento</h1></div><div class="meta"><small>Competencia</small><strong>${escapeHtml(competencia || "")}</strong><span>${escapeHtml(item.omie_codigo_integracao || "")}</span></div></header>
    <section class="summary"><article><span>Dias</span><strong>${escapeHtml(item.dias_trabalhados || 0)}</strong></article><article><span>Proventos</span><strong>${formatCurrency(proventos)}</strong></article><article><span>Descontos</span><strong>${formatCurrency(descontos)}</strong></article><article><span>NF</span><strong>${formatCurrency(item.valor_nf_emitida)}</strong></article><article><span>Total a pagar</span><strong>${formatCurrency(item.liquido_pagar)}</strong></article></section>
    <div class="section-title"><h2>Dados do prestador</h2><span>Gerado em ${escapeHtml(new Date().toLocaleString("pt-BR"))}</span></div>
    <table><tbody><tr><th>Razao social</th><td>${escapeHtml(item.razao_social || "")}</td><th>Prestador</th><td>${escapeHtml(item.nome || "")}</td></tr><tr><th>CPF/CNPJ</th><td>${escapeHtml([item.cpf, item.cnpj].filter(Boolean).join(" / "))}</td><th>Email</th><td>${escapeHtml(item.email || "")}</td></tr><tr><th>Projeto</th><td>${escapeHtml(item.projeto || "")}</td><th>Departamento</th><td>${escapeHtml(item.departamento || "")}</td></tr></tbody></table>
    <div class="two-col"><section><div class="section-title"><h2>Memoria de calculo</h2></div><table><tbody><tr><th>R$ Contrato</th><td class="num">${formatCurrency(item.salario_base || item.salario_contrato)}</td></tr><tr><th>Dias trabalhados</th><td class="num">${escapeHtml(item.dias_trabalhados || 0)}</td></tr><tr><th>Valor dias</th><td class="num">${formatCurrency(item.valor_dias)}</td></tr><tr><th>Adicoes</th><td class="num">${formatCurrency(item.adicoes)}</td></tr><tr><th>Bonus</th><td class="num">${formatCurrency(item.bonus)}</td></tr><tr><th>Descontos manuais</th><td class="num">${formatCurrency(item.descontos_manual)}</td></tr><tr><th>Adiantamentos</th><td class="num">${formatCurrency(item.desconto_adiantamentos)}</td></tr><tr class="total-row"><th>Total a pagar</th><td class="num">${formatCurrency(item.liquido_pagar)}</td></tr></tbody></table></section>
    <section><div class="section-title"><h2>NF e integracao</h2></div><table><tbody><tr><th>Numero NF</th><td>${escapeHtml(item.numero_nf || "")}</td></tr><tr><th>Valor NF</th><td class="num">${formatCurrency(item.valor_nf_emitida)}</td></tr><tr><th>Diferença NF</th><td class="num">${formatCurrency(diferencaNf)}</td></tr><tr><th>Categoria Omie</th><td>${escapeHtml(item.categoria_omie_codigo || item.categoria || "")}</td></tr><tr><th>Documento Omie</th><td>${escapeHtml(omieLancamentoIntegracaoCode(competencia, item))}</td></tr></tbody></table></section></div>
    <footer class="footer"><span>Redefrete Logistica | Folha PJ</span><span>${escapeHtml(omieLancamentoIntegracaoCode(competencia, item))}</span></footer>
  </main></body></html>`;
}

async function buildFolhaItemReportPdf(item, competencia) {
  return htmlToPdfBuffer(renderFolhaItemReportHtml(item, competencia));
}

async function enviarAnexosFolhaItemOmie(item, competencia, contaPagarId) {
  if (!contaPagarId) return [];
  const anexos = [];
  anexos.push(await omieIncluirAnexo({
    nId: contaPagarId,
    cCodIntAnexo: `F${item.folha_item_id}DEM`,
    cNomeArquivo: `demonstrativo-${competencia}-${item.razao_social || item.nome || item.folha_item_id}.pdf`,
    content: await buildFolhaItemReportPdf(item, competencia),
  }));

  const [[nf]] = await pool.query(
    `SELECT original_name, stored_name
       FROM nf_arquivos
      WHERE folha_item_id = ?
      ORDER BY id DESC
      LIMIT 1`,
    [item.folha_item_id],
  );
  if (nf) {
    const filePath = path.join(uploadsDir, nf.stored_name);
    if (fs.existsSync(filePath)) {
      anexos.push(await omieIncluirAnexo({
        nId: contaPagarId,
        cCodIntAnexo: `F${item.folha_item_id}NF`,
        cNomeArquivo: nf.original_name || `nf-${competencia}-${item.folha_item_id}.pdf`,
        content: fs.readFileSync(filePath),
      }));
    }
  }
  return anexos;
}

function renderRescisaoReportHtml(rescisao, aprovacoes) {
  const diasRestantes = Math.max(payrollBaseDays() - Number(rescisao.dias_trabalhados || 0), 0);
  const valorDiasRestantes = Number(((money(rescisao.salario_base) / payrollBaseDays()) * diasRestantes).toFixed(2));
  const proventos = money(rescisao.valor_proporcional) + Math.max(money(rescisao.valor_multa), 0);
  const descontos = money(rescisao.adiantamentos_abertos) + money(rescisao.descontos_manual) + Math.abs(Math.min(money(rescisao.valor_multa), 0));
  const statusText = {
    aguardando_nf: "Aguardando NF",
    em_aprovacao: "Em aprovação",
    finalizada: "Finalizada",
    integrada_omie: "Omie integrada",
    erro_omie: "Erro Omie",
  }[rescisao.status] || rescisao.status || "";
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>
    @page{size:A4;margin:8mm}*{box-sizing:border-box}body{font-family:Segoe UI,Arial,sans-serif;margin:0;color:#061426;background:#fff;font-size:12px}.head{background:#141923;color:#fff;display:grid;grid-template-columns:185px 1fr 170px;gap:18px;align-items:center;padding:18px}.brand{display:flex;align-items:center;gap:10px}.mark{width:38px;height:38px;border:4px solid #fff;display:grid;place-items:center;font-size:24px;font-weight:900}.brand strong{font-size:26px;line-height:1}.brand small,.head small{display:block;color:#dbe4ef;text-transform:uppercase;font-weight:800;letter-spacing:.04em}.head h1{margin:4px 0 0;font-size:25px}.meta{text-align:right}.meta strong{display:block;font-size:18px}.summary{display:grid;grid-template-columns:repeat(5,1fr);border-bottom:1px solid #d7dde6}.summary article{padding:13px;border-right:1px solid #d7dde6}.summary span{display:block;color:#667085;text-transform:uppercase;font-weight:900;font-size:11px}.summary strong{display:block;margin-top:5px;font-size:18px}.section-title{display:flex;justify-content:space-between;align-items:end;padding:16px 8px 8px}.section-title h2{font-size:17px;margin:0}table{width:100%;border-collapse:collapse}th,td{border:1px solid #d7dde6;padding:8px;text-align:left;vertical-align:top}th{background:#f3f6f9;text-transform:uppercase;font-size:11px}.num{text-align:right;white-space:nowrap}.two-col{display:grid;grid-template-columns:1fr 1fr;gap:0;margin-top:14px}.total-row td,.total-row th{font-weight:900;background:#f8fafc}.approval-ok{font-weight:900;color:#065f46}.footer{display:flex;justify-content:space-between;padding:14px 6px;color:#667085;font-size:10px}
  </style></head><body><main>
    <header class="head"><div class="brand"><div class="mark">R</div><div><strong>redefrete</strong><small>Redefrete Logística</small></div></div><div><small>Demonstrativo de rescisão PJ</small><h1>Rescisão de contrato</h1></div><div class="meta"><small>Data da rescisão</small><strong>${escapeHtml(formatDateBr(rescisao.data_rescisao))}</strong><span>${escapeHtml(statusText)}</span></div></header>
    <section class="summary"><article><span>Competência</span><strong>${escapeHtml(rescisao.competencia || "")}</strong></article><article><span>Dias</span><strong>${escapeHtml(`${rescisao.dias_trabalhados || 0}/${rescisao.dias_mes || 0}`)}</strong></article><article><span>Proventos</span><strong>${formatCurrency(proventos)}</strong></article><article><span>Descontos</span><strong>${formatCurrency(descontos)}</strong></article><article><span>Total a pagar</span><strong>${formatCurrency(rescisao.valor_total_pagar)}</strong></article></section>
    <div class="section-title"><h2>Dados do prestador</h2><span>Gerado em ${escapeHtml(new Date().toLocaleString("pt-BR"))}</span></div>
    <table><tbody><tr><th>Razão social</th><td>${escapeHtml(rescisao.razao_social || "")}</td><th>Prestador</th><td>${escapeHtml(rescisao.nome || "")}</td></tr><tr><th>CPF/CNPJ</th><td>${escapeHtml([rescisao.cpf, rescisao.cnpj].filter(Boolean).join(" / "))}</td><th>Motivo</th><td>${escapeHtml(rescisao.motivo || "")}</td></tr><tr><th>Aviso</th><td>${escapeHtml(`${formatDateBr(rescisao.data_aviso)} | ${rescisao.aviso_dias || 0} dias | ${Number(rescisao.aviso_cumprido || 0) ? "cumprido" : "não cumprido"}`)}</td><th>Tipo</th><td>${escapeHtml(rescisao.tipo_rescisao === "prestador" ? "Prestador rescinde" : "Empresa rescinde")}</td></tr></tbody></table>
    <div class="two-col"><section><div class="section-title"><h2>Memória de cálculo</h2></div><table><tbody><tr><th>R$ Contrato</th><td class="num">${formatCurrency(rescisao.salario_base)}</td></tr><tr><th>Dias trabalhados</th><td class="num">${escapeHtml(`${rescisao.dias_trabalhados || 0}/${rescisao.dias_mes || 0}`)}</td></tr><tr><th>Valor proporcional</th><td class="num">${formatCurrency(rescisao.valor_proporcional)}</td></tr><tr><th>Dias faltantes</th><td class="num">${diasRestantes} dias | ${formatCurrency(valorDiasRestantes)}</td></tr><tr><th>Multa rescisão (${Number(rescisao.multa_percentual || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%)</th><td class="num">${formatCurrency(rescisao.valor_multa)}</td></tr><tr><th>Adiantamentos em aberto</th><td class="num">${formatCurrency(rescisao.adiantamentos_abertos)}</td></tr><tr><th>Descontos manuais</th><td class="num">${formatCurrency(rescisao.descontos_manual)}</td></tr><tr class="total-row"><th>Total a pagar</th><td class="num">${formatCurrency(rescisao.valor_total_pagar)}</td></tr></tbody></table></section>
    <section><div class="section-title"><h2>NF e integração</h2></div><table><tbody><tr><th>Status NF</th><td>${escapeHtml(rescisao.nf_status || "pendente")}</td></tr><tr><th>Número NF</th><td>${escapeHtml(rescisao.numero_nf || "")}</td></tr><tr><th>Valor NF</th><td class="num">${formatCurrency(rescisao.valor_nf_emitida)}</td></tr><tr><th>Diferença NF</th><td class="num">${formatCurrency(rescisao.diferenca_nf)}</td></tr><tr><th>Omie</th><td>${escapeHtml(rescisao.omie_status || "pendente")}</td></tr></tbody></table></section></div>
    <div class="section-title"><h2>Aprovações</h2><span>${aprovacoes.approved ? "Fluxo completo" : "Fluxo pendente"}</span></div><table><thead><tr><th>Aprovador</th><th>E-mail</th><th>Data</th><th>Autenticação</th></tr></thead><tbody>${(aprovacoes.aprovadores || []).map((a) => `<tr><td>${escapeHtml(a.nome)}</td><td>${escapeHtml(a.email)}</td><td>${escapeHtml(new Date(a.aprovado_em).toLocaleString("pt-BR"))}</td><td class="approval-ok">${escapeHtml(a.codigo_autenticacao)}</td></tr>`).join("") || `<tr><td colspan="4">Sem aprovações registradas.</td></tr>`}</tbody></table>
    <footer class="footer"><span>Redefrete Logística | Rescisão PJ</span><span>${escapeHtml(omieRescisaoIntegracaoCode(rescisao))}</span></footer>
  </main></body></html>`;
}

async function buildRescisaoReportPdf(rescisao) {
  const aprovacoes = await getRescisaoApprovals(rescisao);
  return htmlToPdfBuffer(renderRescisaoReportHtml(rescisao, aprovacoes));
}

async function enviarAnexoRescisaoOmie(rescisao, contaPagarId) {
  if (!rescisao.nf_id || !contaPagarId) return null;
  const [[nf]] = await pool.query("SELECT original_name, stored_name FROM nf_arquivos WHERE id = ?", [rescisao.nf_id]);
  if (!nf) return null;
  const filePath = path.join(uploadsDir, nf.stored_name);
  if (!fs.existsSync(filePath)) return null;
  return omieIncluirAnexo({
    nId: contaPagarId,
    cCodIntAnexo: `RES${rescisao.id}NF`,
    cNomeArquivo: nf.original_name,
    content: fs.readFileSync(filePath),
  });
}

function omieHolidaySet() {
  return new Set(String(process.env.OMIE_HOLIDAYS || "").split(",").map((item) => item.trim()).filter(Boolean));
}

function nextBusinessDay(isoDate) {
  const holidays = omieHolidaySet();
  let date = isoDate instanceof Date
    ? new Date(isoDate.getTime())
    : new Date(`${String(isoDate).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  while ([0, 6].includes(date.getDay()) || holidays.has(date.toISOString().slice(0, 10))) {
    date.setDate(date.getDate() + 1);
  }
  return date.toISOString().slice(0, 10);
}

function previousBusinessDay(isoDate) {
  const holidays = omieHolidaySet();
  let date = isoDate instanceof Date
    ? new Date(isoDate.getTime())
    : new Date(`${String(isoDate).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  while ([0, 6].includes(date.getDay()) || holidays.has(date.toISOString().slice(0, 10))) {
    date.setDate(date.getDate() - 1);
  }
  return date.toISOString().slice(0, 10);
}

function addCalendarDays(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00`);
  date.setDate(date.getDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function omieDueDateForCompetencia(competencia) {
  const [year, month] = String(competencia).split("-").map(Number);
  const day = Number(process.env.OMIE_DUE_DAY || 5);
  const date = new Date(Date.UTC(year, month, day));
  return nextBusinessDay(date.toISOString().slice(0, 10));
}

function omieDueDateForRescisao(rescisao) {
  return previousBusinessDay(addCalendarDays(rescisao.data_rescisao, 10));
}

function omiePrestadorIntegrationCode(prestador) {
  return prestador.omie_codigo_integracao || `RDF-PREST-${prestador.id}`;
}

function splitPhone(value) {
  const digits = onlyDigits(value);
  if (digits.length < 10) return { ddd: "", numero: digits };
  return { ddd: digits.slice(0, 2), numero: digits.slice(2) };
}

function extractOmieClienteCode(data) {
  return Number(
    data.codigo_cliente_omie
    || data.codigo_cliente
    || data.codigo_cliente_fornecedor
    || data.codigo
    || data.cliente?.codigo_cliente_omie
    || data.clientes_cadastro?.codigo_cliente_omie
    || 0,
  ) || null;
}

class OmiePrestadorPendenteError extends Error {
  constructor(prestador) {
    super(`Prestador sem cadastro no Omie: ${prestador.razao_social || prestador.nome}.`);
    this.code = "OMIE_PRESTADOR_PENDENTE";
    this.prestador = {
      id: prestador.prestador_id || prestador.id,
      nome: prestador.nome || "",
      razao_social: prestador.razao_social || "",
      cnpj: prestador.cnpj || "",
    };
  }
}

async function findOmieClienteByCpfCnpj(cpfCnpj) {
  const data = await omieCall("clientes", "ListarClientes", {
    pagina: 1,
    registros_por_pagina: 20,
    apenas_importado_api: "N",
    clientesFiltro: { cnpj_cpf: cpfCnpj },
  });
  const list = data.clientes_cadastro || data.clientes || data.clientes_cadastro_resumido || [];
  const match = list.find((item) => onlyDigits(item.cnpj_cpf) === onlyDigits(cpfCnpj)) || list[0];
  return extractOmieClienteCode(match || {});
}

function omiePrestadorDadosBancarios(prestador) {
  const banco = onlyDigits(prestador.banco).slice(0, 3);
  const agencia = onlyDigits(prestador.agencia);
  const conta = onlyDigits(prestador.conta);
  const cnpj = onlyDigits(prestador.cnpj);
  const titular = String(prestador.razao_social || "").trim().slice(0, 60);
  if (!banco || !agencia || !conta || !cnpj || !titular) return null;
  return {
    codigo_banco: banco.padStart(3, "0"),
    agencia,
    conta_corrente: conta,
    doc_titular: cnpj,
    nome_titular: titular,
    transf_padrao: "S",
  };
}

async function ensureOmiePrestador(prestador, options = {}) {
  if (prestador.omie_codigo_cliente) return Number(prestador.omie_codigo_cliente);
  const cpfCnpj = prestador.cnpj;
  if (!cpfCnpj) throw new Error("Prestador sem CNPJ para cadastrar na Omie.");
  const existingCode = await findOmieClienteByCpfCnpj(cpfCnpj);
  if (existingCode) {
    await pool.query(
      "UPDATE prestadores SET omie_codigo_cliente = ?, omie_codigo_integracao = COALESCE(omie_codigo_integracao, ?) WHERE id = ?",
      [existingCode, omiePrestadorIntegrationCode(prestador), prestador.id],
    );
    return existingCode;
  }
  if (!options.allowCreate) throw new OmiePrestadorPendenteError(prestador);
  const phone = splitPhone(prestador.telefone);
  const payload = {
    cnpj_cpf: cpfCnpj,
    razao_social: String(prestador.razao_social || "").slice(0, 60),
    nome_fantasia: String(prestador.razao_social || "").slice(0, 100),
    email: prestador.email || "",
    telefone1_ddd: phone.ddd,
    telefone1_numero: phone.numero,
    tags: [{ tag: "Fornecedor" }, { tag: "Redefrete PJ" }],
  };
  const dadosBancarios = omiePrestadorDadosBancarios(prestador);
  if (dadosBancarios) payload.dadosBancarios = dadosBancarios;
  const result = await omieCall("clientes", "UpsertClienteCpfCnpj", payload);
  const codigo = extractOmieClienteCode(result) || await findOmieClienteByCpfCnpj(cpfCnpj);
  if (!codigo) throw new Error("Omie nao retornou o codigo do fornecedor.");
  await pool.query(
    "UPDATE prestadores SET omie_codigo_cliente = ?, omie_codigo_integracao = ? WHERE id = ?",
    [codigo, omiePrestadorIntegrationCode(prestador), prestador.id],
  );
  return codigo;
}

async function resolveOmieContaCorrenteId() {
  if (process.env.OMIE_CONTA_CORRENTE_ID) return Number(process.env.OMIE_CONTA_CORRENTE_ID);
  if (!process.env.OMIE_CONTA_BANCO) return null;
  const data = await omieCall("contaCorrente", "ListarContasCorrentes", {
    pagina: 1,
    registros_por_pagina: 100,
    apenas_importado_api: "N",
  });
  const contas = data.ListarContasCorrentes || data.conta_corrente_lista || data.fin_conta_corrente_cadastro || [];
  const targetAccount = onlyDigits(process.env.OMIE_CONTA_NUMERO);
  const conta = contas.find((item) => (
    String(item.codigo_banco || item.cCodBanco || "").padStart(3, "0") === String(process.env.OMIE_CONTA_BANCO).padStart(3, "0")
    && (!process.env.OMIE_CONTA_AGENCIA || onlyDigits(item.codigo_agencia || item.cAgencia) === onlyDigits(process.env.OMIE_CONTA_AGENCIA))
    && (!targetAccount || onlyDigits(item.numero_conta_corrente || item.cContaCorrente).includes(targetAccount))
  ));
  const id = Number(conta?.nCodCC || conta?.codigo || conta?.id_conta_corrente || 0) || null;
  if (id) {
    writeEnv({ OMIE_CONTA_CORRENTE_ID: String(id) });
    return id;
  }
  return null;
}

function extractOmieCategorias(data) {
  return data.categoria_cadastro
    || data.categorias
    || data.cadastro
    || data.lista_categorias
    || data.ListarCategorias
    || [];
}

function omieCategoriaName(categoria) {
  return categoria.descricao
    || categoria.nome
    || categoria.descr
    || categoria.cDescricao
    || categoria.dsc
    || "";
}

function omieCategoriaCode(categoria) {
  return categoria.codigo
    || categoria.cod
    || categoria.cCod
    || categoria.codigo_categoria
    || "";
}

async function listOmieCategorias() {
  const categorias = [];
  let pagina = 1;
  let totalPaginas = 1;
  do {
    const data = await omieCall("categorias", "ListarCategorias", {
      pagina,
      registros_por_pagina: 100,
    });
    categorias.push(...extractOmieCategorias(data));
    totalPaginas = Number(data.total_de_paginas || data.total_paginas || 1);
    pagina += 1;
  } while (pagina <= totalPaginas);
  return categorias
    .map((categoria) => ({
      codigo: String(omieCategoriaCode(categoria) || "").trim(),
      nome: String(omieCategoriaName(categoria) || "").trim(),
      raw: categoria,
    }))
    .filter((categoria) => categoria.codigo && categoria.nome);
}

async function syncOmieCategorias() {
  if (!omieConfigured()) throw new Error("Omie ainda nao esta configurado.");
  const omieCategorias = await listOmieCategorias();
  const byName = new Map(omieCategorias.map((categoria) => [normalizeLookupText(categoria.nome), categoria]));
  const [localCategorias] = await pool.query("SELECT id, nome, omie_codigo FROM categorias ORDER BY nome");
  const atualizadas = [];
  const naoEncontradas = [];

  for (const local of localCategorias) {
    const match = byName.get(normalizeLookupText(local.nome));
    if (!match) {
      naoEncontradas.push(local.nome);
      continue;
    }
    if (String(local.omie_codigo || "") !== match.codigo) {
      await pool.query("UPDATE categorias SET omie_codigo = ? WHERE id = ?", [match.codigo, local.id]);
      atualizadas.push({ id: local.id, nome: local.nome, omie_codigo: match.codigo });
    }
  }

  return { atualizadas, naoEncontradas, totalOmie: omieCategorias.length };
}

async function resolveOmieCategoriaCodigo(item) {
  let codigo = String(item.categoria_omie_codigo || "").trim();
  if (/^\d+(?:\.\d+)*$/.test(codigo)) return codigo;

  await syncOmieCategorias();
  const [[categoria]] = await pool.query(
    `SELECT c.nome, c.omie_codigo
     FROM prestadores p
     LEFT JOIN categorias c ON c.id = p.categoria_id
     WHERE p.id = ?`,
    [item.prestador_id],
  );
  codigo = String(categoria?.omie_codigo || "").trim();
  if (/^\d+(?:\.\d+)*$/.test(codigo)) return codigo;

  throw new Error(`Categoria sem codigo Omie para ${item.razao_social || item.nome}. Categoria: ${categoria?.nome || item.categoria || "nao informada"}.`);
}

function extractOmieProjetos(data) {
  return data.cadastro || data.projetos || data.lista_projetos || [];
}

function extractOmieDepartamentos(data) {
  return data.departamentos || data.cadastro || data.lista_departamentos || [];
}

async function resolveOmieProjetoPorNome(nome) {
  if (!nome) return null;
  const data = await omieCall("projetos", "ListarProjetos", {
    pagina: 1,
    registros_por_pagina: 500,
  });
  const normalized = normalizeLookupText(nome);
  const match = extractOmieProjetos(data)
    .filter((projeto) => projeto.inativo !== "S")
    .map((projeto) => ({ codigo: projeto.codigo || projeto.nCodProj || projeto.nCodProjeto, nome: projeto.nome || projeto.descricao || "" }))
    .find((projeto) => normalizeLookupText(projeto.nome) === normalized);
  return match?.codigo ? String(match.codigo) : null;
}

async function resolveOmieDepartamentoPorNome(nome) {
  if (!nome) return null;
  const departamentos = [];
  let pagina = 1;
  let totalPaginas = 1;
  do {
    const data = await omieCall("departamentos", "ListarDepartamentos", {
      pagina,
      registros_por_pagina: 100,
    });
    departamentos.push(...extractOmieDepartamentos(data));
    totalPaginas = Number(data.total_de_paginas || data.total_paginas || 1);
    pagina += 1;
  } while (pagina <= totalPaginas);
  const normalized = normalizeLookupText(nome);
  const match = departamentos
    .filter((departamento) => departamento.inativo !== "S")
    .map((departamento) => ({ codigo: departamento.codigo || departamento.cCodDep || departamento.cCodDepartamento, nome: departamento.descricao || departamento.nome || "" }))
    .find((departamento) => normalizeLookupText(departamento.nome) === normalized);
  return match?.codigo ? String(match.codigo) : null;
}

async function listOmieDepartamentos() {
  const departamentos = [];
  let pagina = 1;
  let totalPaginas = 1;
  do {
    const data = await omieCall("departamentos", "ListarDepartamentos", {
      pagina,
      registros_por_pagina: 100,
    });
    departamentos.push(...extractOmieDepartamentos(data));
    totalPaginas = Number(data.total_de_paginas || data.total_paginas || 1);
    pagina += 1;
  } while (pagina <= totalPaginas);
  return departamentos
    .filter((departamento) => departamento.inativo !== "S")
    .map((departamento) => ({
      codigo: String(departamento.codigo || departamento.cCodDep || departamento.cCodDepartamento || "").trim(),
      nome: String(departamento.descricao || departamento.nome || "").trim(),
      raw: departamento,
    }))
    .filter((departamento) => departamento.codigo && departamento.nome);
}

async function syncOmieDepartamentos() {
  if (!omieConfigured()) throw new Error("Omie ainda nao esta configurado.");
  const omieDepartamentos = await listOmieDepartamentos();
  const byName = new Map(omieDepartamentos.map((departamento) => [normalizeLookupText(departamento.nome), departamento]));
  const [localDepartamentos] = await pool.query("SELECT id, nome, omie_codigo FROM departamentos ORDER BY nome");
  const atualizadas = [];
  const naoEncontradas = [];

  for (const local of localDepartamentos) {
    const match = byName.get(normalizeLookupText(local.nome));
    if (!match) {
      naoEncontradas.push(local.nome);
      continue;
    }
    if (String(local.omie_codigo || "") !== match.codigo) {
      await pool.query("UPDATE departamentos SET omie_codigo = ? WHERE id = ?", [match.codigo, local.id]);
      atualizadas.push({ id: local.id, nome: local.nome, omie_codigo: match.codigo });
    }
  }

  return { atualizadas, naoEncontradas, totalOmie: omieDepartamentos.length };
}

function omieTransferInfo(person) {
  const banco = onlyDigits(person.banco).slice(0, 3);
  const agencia = onlyDigits(person.agencia);
  const conta = formatContaComDigito(person.conta);
  const documento = onlyDigits(person.cnpj || person.cpf);
  const nome = String(person.razao_social || person.nome || "").trim().slice(0, 60);
  if (!banco || !agencia || !conta || !documento || !nome) return null;
  return {
    codigo_forma_pagamento: "TRA",
    banco_transferencia: banco.padStart(3, "0"),
    agencia_transferencia: agencia,
    conta_corrente_transferencia: conta,
    finalidade_transferencia: "00010",
    cpf_cnpj_transferencia: documento,
    nome_transferencia: nome,
  };
}

function omieLancamentoIntegracaoCode(competencia, item) {
  return `RDF-FOLHA-${competencia}-${item.folha_item_id}`;
}

function omieRescisaoIntegracaoCode(rescisao) {
  return `RDF-RESCISAO-${rescisao.competencia}-${rescisao.id}`;
}

function omieRescisaoDocumento(rescisao) {
  const year = String(rescisao.data_rescisao || rescisao.competencia || "").slice(0, 4) || new Date().getFullYear();
  return `RES-${year}-${String(rescisao.id || 0).padStart(5, "0")}`.slice(0, 20);
}

function applyOmieAllocations(payload, { codigoProjeto, codigoDepartamento }) {
  if (codigoProjeto) payload.codigo_projeto = Number(codigoProjeto);
  if (codigoDepartamento) payload.distribuicao = [{ cCodDep: String(codigoDepartamento), nPerDep: 100 }];
  return payload;
}

function applyOmieTransfer(payload, person) {
  const transferInfo = omieTransferInfo(person);
  if (transferInfo) payload.cnab_integracao_bancaria = transferInfo;
  return payload;
}

function omieContaPagarPayload({ competencia, item, fornecedorCodigo, contaCorrenteId, vencimento, codigoProjeto, codigoDepartamento }) {
  const extras = [
    item.projeto ? `Projeto: ${item.projeto}` : "",
    item.departamento ? `Departamento: ${item.departamento}` : "",
    item.banco || item.agencia || item.conta ? `Dados bancarios prestador: banco ${item.banco || "-"}, agencia ${item.agencia || "-"}, conta ${item.conta || "-"}` : "",
  ].filter(Boolean).join(" | ");
  const payload = {
    codigo_lancamento_integracao: omieLancamentoIntegracaoCode(competencia, item),
    codigo_cliente_fornecedor: fornecedorCodigo,
    data_vencimento: formatOmieDate(vencimento),
    data_previsao: formatOmieDate(vencimento),
    valor_documento: money(item.liquido_pagar),
    codigo_categoria: String(item.categoria_omie_codigo || item.categoria || "").trim(),
    numero_documento_fiscal: String(item.numero_nf || "").slice(0, 20),
    observacao: [`Folha PJ competencia ${competencia} - ${item.razao_social || item.nome}`, extras].filter(Boolean).join(" | "),
  };
  if (contaCorrenteId) payload.id_conta_corrente = contaCorrenteId;
  applyOmieAllocations(payload, { codigoProjeto, codigoDepartamento });
  applyOmieTransfer(payload, item);
  return payload;
}

function omieRescisaoContaPagarPayload({ rescisao, fornecedorCodigo, contaCorrenteId, vencimento, codigoProjeto, codigoDepartamento }) {
  const extras = [
    rescisao.projeto ? `Projeto: ${rescisao.projeto}` : "",
    rescisao.departamento ? `Departamento: ${rescisao.departamento}` : "",
    rescisao.banco || rescisao.agencia || rescisao.conta ? `Dados bancarios prestador: banco ${rescisao.banco || "-"}, agencia ${rescisao.agencia || "-"}, conta ${rescisao.conta || "-"}` : "",
  ].filter(Boolean).join(" | ");
  const payload = {
    codigo_lancamento_integracao: omieRescisaoIntegracaoCode(rescisao),
    codigo_cliente_fornecedor: fornecedorCodigo,
    data_vencimento: formatOmieDate(vencimento),
    data_previsao: formatOmieDate(vencimento),
    valor_documento: money(rescisao.valor_total_pagar),
    codigo_categoria: String(rescisao.categoria_omie_codigo || rescisao.categoria || "").trim(),
    numero_documento: omieRescisaoDocumento(rescisao),
    numero_documento_fiscal: String(rescisao.numero_nf || "").slice(0, 20),
    observacao: [`Rescisao PJ competencia ${rescisao.competencia} - ${rescisao.razao_social || rescisao.nome}`, extras].filter(Boolean).join(" | "),
  };
  if (contaCorrenteId) payload.id_conta_corrente = contaCorrenteId;
  applyOmieAllocations(payload, { codigoProjeto, codigoDepartamento });
  applyOmieTransfer(payload, rescisao);
  return payload;
}

function validatePrestador(body, user = null, prestadorId = null) {
  const errors = [];
  if (!required(body.nome)) errors.push("Nome e obrigatorio.");
  if (!validateCpf(body.cpf)) errors.push("CPF invalido.");
  if (!validateCnpj(body.cnpj) && !canUseSimoneException(user, prestadorId)) errors.push("CNPJ invalido.");
  if (!required(body.razao_social)) errors.push("Razao social e obrigatoria.");
  if (!["gestao", "operacao"].includes(body.cargo_nivel)) errors.push("Nivel do cargo invalido.");
  if (!["mensal", "diaria", undefined, null, ""].includes(body.precificacao_tipo)) errors.push("Forma de precificacao invalida.");
  const tipoPrecificacao = body.precificacao_tipo === "diaria" ? "diaria" : "mensal";
  if (tipoPrecificacao === "mensal" && money(body.salario_contrato) <= 0) errors.push("R$ Contrato deve ser maior que zero.");
  if (tipoPrecificacao === "diaria" && money(body.valor_dia) <= 0) errors.push("Valor por dia deve ser maior que zero.");
  return errors;
}

function validateUsuario(body, isUpdate = false) {
  const errors = [];
  if (!required(body.nome)) errors.push("Nome e obrigatorio.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email || ""))) errors.push("E-mail invalido.");
  if (!perfis.includes(body.perfil)) errors.push("Perfil invalido.");
  if (body.prestador_id && !Number.isInteger(Number(body.prestador_id))) errors.push("Prestador vinculado invalido.");
  if (!isUpdate && String(body.senha || "").length < 8) errors.push("Senha deve ter pelo menos 8 caracteres.");
  if (isUpdate && body.senha && String(body.senha).length < 8) errors.push("Senha deve ter pelo menos 8 caracteres.");
  return errors;
}

async function getPrestadores(user) {
  const [rows] = await pool.query(
    `SELECT p.*, COALESCE(cli.nome, u.nome) AS unidade_nome, cli.nome AS cliente_nome, f.nome AS funcao, c.nome AS categoria,
      d.nome AS departamento, pr.nome AS projeto
     FROM prestadores p
     LEFT JOIN unidades u ON u.id = p.unidade_id
     LEFT JOIN clientes cli ON cli.id = p.cliente_id
     LEFT JOIN funcoes f ON f.id = p.funcao_id
     LEFT JOIN categorias c ON c.id = p.categoria_id
     LEFT JOIN departamentos d ON d.id = p.departamento_id
     LEFT JOIN projetos pr ON pr.id = p.projeto_id
     WHERE 1 = 1 ${contractVisibilityWhere(user, "p")}
     ORDER BY p.ativo DESC, p.nome ASC, p.razao_social ASC`,
  );
  return rows.map((row) => sanitizePrestador(row, user));
}

function canSeeAnyFinancialValue(user) {
  return isFullAccess(user) || hasPermission(user, "view_values_open") || hasPermission(user, "view_values_closed");
}

function accountMovementAmount(value, canView) {
  return canView ? money(value) : null;
}

function accountMovement({
  data,
  competencia = "",
  tipo,
  descricao,
  documento = "",
  credito = 0,
  debito = 0,
  status = "",
  detalhe = "",
  canView = true,
}) {
  return {
    data: data || (competencia ? `${competencia}-01` : ""),
    competencia,
    tipo,
    descricao,
    documento,
    credito: accountMovementAmount(credito, canView),
    debito: accountMovementAmount(debito, canView),
    status,
    detalhe,
    can_view_values: canView,
  };
}

async function getPrestadorContaCorrente(prestadorId, user) {
  const [[prestador]] = await pool.query(
    `SELECT p.*, COALESCE(cli.nome, u.nome) AS unidade_nome, cli.nome AS cliente_nome, f.nome AS funcao, c.nome AS categoria,
            d.nome AS departamento, pr.nome AS projeto
       FROM prestadores p
       LEFT JOIN unidades u ON u.id = p.unidade_id
       LEFT JOIN clientes cli ON cli.id = p.cliente_id
       LEFT JOIN funcoes f ON f.id = p.funcao_id
       LEFT JOIN categorias c ON c.id = p.categoria_id
       LEFT JOIN departamentos d ON d.id = p.departamento_id
       LEFT JOIN projetos pr ON pr.id = p.projeto_id
      WHERE p.id = ? ${contractVisibilityWhere(user, "p")}
      LIMIT 1`,
    [prestadorId],
  );
  if (!prestador) return null;

  const [folhas] = await pool.query(
    `SELECT fi.*, f.competencia, f.status AS folha_status, f.fechado_em
       FROM folha_itens fi
       JOIN folhas f ON f.id = fi.folha_id
      WHERE fi.prestador_id = ?
      ORDER BY f.competencia DESC`,
    [prestadorId],
  );
  const [adiantamentos] = await pool.query(
    `SELECT * FROM adiantamentos WHERE prestador_id = ? ORDER BY data_adiantamento DESC, id DESC`,
    [prestadorId],
  );
  const [parcelas] = await pool.query(
    `SELECT ap.*, a.data_adiantamento, f.competencia AS folha_competencia
       FROM adiantamento_parcelas ap
       JOIN adiantamentos a ON a.id = ap.adiantamento_id
       LEFT JOIN folhas f ON f.id = ap.folha_id
      WHERE a.prestador_id = ?
      ORDER BY ap.competencia DESC, ap.numero_parcela DESC`,
    [prestadorId],
  );
  const [rescisoes] = await pool.query(
    `SELECT * FROM rescisoes WHERE prestador_id = ? ORDER BY data_rescisao DESC, id DESC`,
    [prestadorId],
  );

  const movements = [];
  for (const folha of folhas) {
    const canView = canSeeSensitiveValues(user, { folhaStatus: folha.folha_status });
    movements.push(accountMovement({
      data: `${folha.competencia}-01`,
      competencia: folha.competencia,
      tipo: "Folha",
      descricao: "Proventos da folha PJ",
      documento: normalizeNfNumber(folha.numero_nf) || "",
      credito: folha.valor_nf_previsto,
      status: folha.folha_status,
      detalhe: canView ? `Valor dias ${formatCurrency(folha.valor_dias)} | Adições ${formatCurrency(folha.adicoes)} | Bônus ${formatCurrency(folha.bonus)}` : "",
      canView,
    }));
    if (money(folha.descontos_manual) > 0) {
      movements.push(accountMovement({
        data: `${folha.competencia}-01`,
        competencia: folha.competencia,
        tipo: "Desconto",
        descricao: "Descontos manuais da folha",
        debito: folha.descontos_manual,
        status: folha.folha_status,
        canView,
      }));
    }
  }

  for (const adiantamento of adiantamentos) {
    const canView = canSeeSensitiveValues(user, { folhaStatus: "aberta" });
    movements.push(accountMovement({
      data: isoDate(adiantamento.data_adiantamento),
      competencia: adiantamento.competencia_inicial,
      tipo: "Adiantamento",
      descricao: `Adiantamento concedido (${adiantamento.parcelas} parcela(s))`,
      credito: adiantamento.valor_total,
      status: "lançado",
      detalhe: adiantamento.observacao || "",
      canView,
    }));
  }

  for (const parcela of parcelas) {
    const canView = canSeeSensitiveValues(user, { folhaStatus: parcela.descontado ? "fechada" : "aberta" });
    movements.push(accountMovement({
      data: `${parcela.competencia}-01`,
      competencia: parcela.competencia,
      tipo: "Parcela",
      descricao: `Parcela ${parcela.numero_parcela} de adiantamento`,
      debito: parcela.valor,
      status: parcela.descontado ? "descontada" : "em aberto",
      detalhe: parcela.folha_competencia ? `Descontada na folha ${parcela.folha_competencia}` : "",
      canView,
    }));
  }

  for (const rescisao of rescisoes) {
    const canView = canSeeAnyFinancialValue(user);
    const proventos = money(rescisao.valor_proporcional) + Math.max(money(rescisao.valor_multa), 0);
    const descontos = money(rescisao.descontos_manual) + money(rescisao.adiantamentos_abertos) + Math.abs(Math.min(money(rescisao.valor_multa), 0));
    if (proventos > 0) {
      movements.push(accountMovement({
        data: isoDate(rescisao.data_rescisao),
        competencia: rescisao.competencia,
        tipo: "Rescisão",
        descricao: "Proventos da rescisão",
        documento: normalizeNfNumber(rescisao.numero_nf) || "",
        credito: proventos,
        status: rescisao.status,
        detalhe: rescisao.motivo || "",
        canView,
      }));
    }
    if (descontos > 0) {
      movements.push(accountMovement({
        data: isoDate(rescisao.data_rescisao),
        competencia: rescisao.competencia,
        tipo: "Rescisão",
        descricao: "Descontos da rescisão",
        debito: descontos,
        status: rescisao.status,
        canView,
      }));
    }
  }

  movements.sort((a, b) => String(b.data).localeCompare(String(a.data)) || String(b.tipo).localeCompare(String(a.tipo)));
  const hasRestricted = movements.some((item) => !item.can_view_values);
  const resumo = hasRestricted ? {
    creditos: null,
    debitos: null,
    saldo: null,
    adiantamentos_abertos: null,
    restrito: true,
  } : movements.reduce((acc, item) => {
    acc.creditos += Number(item.credito || 0);
    acc.debitos += Number(item.debito || 0);
    return acc;
  }, { creditos: 0, debitos: 0, saldo: 0, adiantamentos_abertos: 0, restrito: false });
  if (!hasRestricted) {
    resumo.saldo = Number((resumo.creditos - resumo.debitos).toFixed(2));
    resumo.adiantamentos_abertos = Number(parcelas.filter((parcela) => !parcela.descontado).reduce((sum, parcela) => sum + money(parcela.valor), 0).toFixed(2));
  }

  return {
    prestador: sanitizePrestador(prestador, user),
    resumo,
    movimentos: movements,
  };
}

async function getAdiantamentosCompetencia(connection, competencia) {
  const [rows] = await connection.query(
    `SELECT a.prestador_id, COALESCE(SUM(ap.valor), 0) AS total
     FROM adiantamento_parcelas ap
     JOIN adiantamentos a ON a.id = ap.adiantamento_id
     WHERE ap.competencia = ? AND ap.descontado = 0
     GROUP BY a.prestador_id`,
    [competencia],
  );
  return new Map(rows.map((row) => [Number(row.prestador_id), money(row.total)]));
}

async function buildFolhaAberta(competencia, user = null) {
  const diasMes = daysInCompetencia(competencia);
  const monthEnd = competenciaEndDate(competencia);
  const [prestadores] = await pool.query(
    `SELECT p.*, COALESCE(cli.nome, u.nome) AS unidade_nome, cli.nome AS cliente_nome, f.nome AS funcao, c.nome AS categoria,
      d.nome AS departamento, pr.nome AS projeto
     FROM prestadores p
     LEFT JOIN unidades u ON u.id = p.unidade_id
     LEFT JOIN clientes cli ON cli.id = p.cliente_id
     LEFT JOIN funcoes f ON f.id = p.funcao_id
     LEFT JOIN categorias c ON c.id = p.categoria_id
     LEFT JOIN departamentos d ON d.id = p.departamento_id
     LEFT JOIN projetos pr ON pr.id = p.projeto_id
     WHERE p.ativo = 1
       AND NOT EXISTS (
         SELECT 1 FROM rescisoes r
         WHERE r.prestador_id = p.id
           AND r.status <> 'reprovada'
           AND r.data_rescisao <= ?
       )
       AND NOT EXISTS (
         SELECT 1
         FROM folha_itens fi_lote
         JOIN folhas f_lote ON f_lote.id = fi_lote.folha_id
         LEFT JOIN folha_lotes fl_lote ON fl_lote.id = fi_lote.lote_id
         WHERE f_lote.competencia = ?
           AND fi_lote.prestador_id = p.id
           AND COALESCE(fl_lote.status, 'fechado') <> 'reprovado'
       )
       ${contractVisibilityWhere(user, "p")}
     ORDER BY p.nome, p.razao_social`,
    [monthEnd, competencia],
  );
  const adiantamentos = await getAdiantamentosCompetencia(pool, competencia);
  let itens = prestadores.map((prestador) => {
    const diasTrabalhados = folhaDaysForPrestador(prestador, competencia);
    const salarioBase = folhaBaseValue(prestador);
    const valorDias = folhaValorDias(prestador, diasTrabalhados);
    const descontoAdiantamentos = adiantamentos.get(Number(prestador.id)) || 0;
    const liquido = Number((valorDias - descontoAdiantamentos).toFixed(2));
    return {
      prestador_id: prestador.id,
      dias_trabalhados: diasTrabalhados,
      salario_base: salarioBase,
      valor_dias: valorDias,
      adicoes: 0,
      bonus: 0,
      descontos_manual: 0,
      desconto_adiantamentos: descontoAdiantamentos,
      valor_nf_previsto: valorDias,
      valor_nf_emitida: 0,
      numero_nf: null,
      liquido_pagar: liquido,
      diferenca_nf: Number((0 - liquido).toFixed(2)),
      ...prestador,
    };
  }).filter((item) => item.dias_trabalhados > 0);
  itens = await attachNfsToItems(competencia, itens);
  itens = await applyFolhaDrafts(competencia, itens);

  return {
    folha: {
      id: null,
      competencia,
      dias_mes: diasMes,
      status: "aberta",
      temporaryOpen: isTemporaryOpenCompetencia(competencia),
      fechado_em: null,
      prestadores: itens.length,
      nf_previsto_total: itens.reduce((sum, item) => sum + Number(item.valor_nf_previsto || 0), 0),
      descontos_total: itens.reduce((sum, item) => sum + Number(item.descontos_manual || 0) + Number(item.desconto_adiantamentos || 0), 0),
      liquido_total: itens.reduce((sum, item) => sum + Number(item.liquido_pagar || 0), 0),
    },
    itens: itens.map((item) => sanitizeFolhaItem(item, user)),
  };
}

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false, error: "Nao foi possivel conectar ao banco." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const login = String(req.body.email || "").trim();
  const senha = String(req.body.senha || "");
  if (!login || !senha) return res.status(400).json({ error: "Informe CPF/e-mail e senha." });

  try {
    const usuario = await findUsuarioForLogin(login);
    if (usuario && !usuario.senha_hash) {
      return res.status(409).json({
        code: "FIRST_ACCESS_REQUIRED",
        error: "Senha resetada. Cadastre uma nova senha para continuar.",
        email: usuario.email,
      });
    }
    if (!usuario || !verifyPassword(senha, usuario.senha_hash)) {
      return res.status(401).json({ error: "CPF/e-mail ou senha invalidos." });
    }
    if (!usuario.prestador_id && usuario.resolved_prestador_id && onlyDigits(login).length === 11) {
      await pool.query("UPDATE usuarios SET prestador_id = ? WHERE id = ?", [usuario.resolved_prestador_id, usuario.id]);
      usuario.prestador_id = usuario.resolved_prestador_id;
    }
    const token = await createSession(usuario.id);
    await pool.query("UPDATE usuarios SET ultimo_login = NOW() WHERE id = ?", [usuario.id]);
    res.setHeader("Set-Cookie", sessionCookie(token));
    res.json({ usuario: publicUser(usuario) });
  } catch {
    res.status(500).json({ error: "Nao foi possivel fazer login." });
  }
});

app.use("/api", (req, res, next) => {
  if (req.path === "/health" || req.path === "/auth/login" || req.path === "/auth/primeiro-acesso") return next();
  return requireAuth(req, res, next);
});

app.get("/api/auth/me", (req, res) => {
  res.json({ usuario: publicUser(req.user) });
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    if (req.sessionTokenHash) await pool.query("DELETE FROM sessoes WHERE token_hash = ?", [req.sessionTokenHash]);
    res.setHeader("Set-Cookie", sessionCookie("", 0));
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Nao foi possivel sair." });
  }
});

app.post("/api/auth/primeiro-acesso", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const senha = String(req.body.senha || req.body.nova_senha || "");
  const confirmarSenha = String(req.body.confirmar_senha || req.body.confirmarSenha || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "E-mail invalido." });
  if (senha.length < 8) return res.status(400).json({ error: "A senha deve ter pelo menos 8 caracteres." });
  if (senha !== confirmarSenha) return res.status(400).json({ error: "A confirmacao da senha nao confere." });
  try {
    const [[usuario]] = await pool.query("SELECT id, senha_hash FROM usuarios WHERE LOWER(email) = ? AND ativo = 1 LIMIT 1", [email]);
    if (!usuario) return res.status(404).json({ error: "Usuario nao encontrado." });
    if (usuario.senha_hash) return res.status(409).json({ error: "Este usuario ja possui senha cadastrada." });
    await pool.query("UPDATE usuarios SET senha_hash = ?, ultimo_login = NOW() WHERE id = ?", [hashPassword(senha), usuario.id]);
    const token = await createSession(usuario.id);
    res.setHeader("Set-Cookie", sessionCookie(token));
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Nao foi possivel cadastrar a senha." });
  }
});

app.post("/api/auth/change-password", async (req, res) => {
  const senhaAtual = String(req.body.senha_atual || "");
  const novaSenha = String(req.body.nova_senha || "");
  const confirmarSenha = String(req.body.confirmar_senha || req.body.confirmarSenha || "");
  if (!senhaAtual) return res.status(400).json({ error: "Informe a senha atual." });
  if (novaSenha.length < 8) return res.status(400).json({ error: "A nova senha deve ter pelo menos 8 caracteres." });
  if (novaSenha !== confirmarSenha) return res.status(400).json({ error: "A confirmacao da senha nao confere." });
  try {
    const [[usuario]] = await pool.query("SELECT id, senha_hash FROM usuarios WHERE id = ? AND ativo = 1", [req.user.id]);
    if (!usuario || !verifyPassword(senhaAtual, usuario.senha_hash)) return res.status(401).json({ error: "Senha atual invalida." });
    await pool.query("UPDATE usuarios SET senha_hash = ?, ultimo_login = NOW() WHERE id = ?", [hashPassword(novaSenha), req.user.id]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Nao foi possivel alterar a senha." });
  }
});

app.get("/api/auth/users", requirePermission("manage_users"), async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.nome, u.email, u.senha_hash, u.perfil, u.permissoes_json, u.prestador_id, u.ativo, u.ultimo_login, u.criado_em,
              p.nome AS prestador_nome, p.razao_social AS prestador_razao_social, p.cpf AS prestador_cpf
         FROM usuarios u
         LEFT JOIN prestadores p ON p.id = u.prestador_id
        ORDER BY u.ativo DESC, u.nome ASC`,
    );
    res.json({ usuarios: rows.map(publicUser) });
  } catch {
    res.status(500).json({ error: "Nao foi possivel listar usuarios." });
  }
});

app.post("/api/auth/users", requirePermission("manage_users"), async (req, res) => {
  const errors = validateUsuario(req.body);
  if (errors.length) return res.status(400).json({ errors });

  try {
    const permissoes = normalizePermissions(req.body.permissoes, req.body.perfil);
    const prestadorId = req.body.prestador_id ? Number(req.body.prestador_id) : null;
    const [result] = await pool.query(
      "INSERT INTO usuarios (nome, email, senha_hash, perfil, permissoes_json, prestador_id, ativo) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        String(req.body.nome).trim(),
        String(req.body.email).trim().toLowerCase(),
        hashPassword(req.body.senha),
        req.body.perfil,
        JSON.stringify(permissoes),
        prestadorId,
        req.body.ativo === false ? 0 : 1,
      ],
    );
    res.status(201).json({ id: result.insertId });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Ja existe usuario com esse e-mail." });
    res.status(500).json({ error: "Nao foi possivel criar usuario." });
  }
});

app.put("/api/auth/users/:id", requirePermission("manage_users"), async (req, res) => {
  const errors = validateUsuario(req.body, true);
  if (errors.length) return res.status(400).json({ errors });
  if (Number(req.params.id) === Number(req.user.id) && req.body.ativo === false) {
    return res.status(400).json({ error: "Voce nao pode inativar seu proprio usuario." });
  }

  try {
    const permissoes = normalizePermissions(req.body.permissoes, req.body.perfil);
    const fields = ["nome = ?", "email = ?", "perfil = ?", "permissoes_json = ?", "prestador_id = ?", "ativo = ?"];
    const values = [
      String(req.body.nome).trim(),
      String(req.body.email).trim().toLowerCase(),
      req.body.perfil,
      JSON.stringify(permissoes),
      req.body.prestador_id ? Number(req.body.prestador_id) : null,
      req.body.ativo === false ? 0 : 1,
    ];
    if (req.body.senha) {
      fields.push("senha_hash = ?");
      values.push(hashPassword(req.body.senha));
    }
    values.push(req.params.id);
    const [result] = await pool.query(`UPDATE usuarios SET ${fields.join(", ")} WHERE id = ?`, values);
    if (!result.affectedRows) return res.status(404).json({ error: "Usuario nao encontrado." });
    if (req.body.ativo === false) await pool.query("DELETE FROM sessoes WHERE usuario_id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Ja existe usuario com esse e-mail." });
    res.status(500).json({ error: "Nao foi possivel atualizar usuario." });
  }
});

app.post("/api/auth/users/:id/reset-password", requirePermission("manage_users"), async (req, res) => {
  if (Number(req.params.id) === Number(req.user.id)) {
    return res.status(400).json({ error: "Use Alterar senha para trocar a sua propria senha." });
  }
  try {
    const [result] = await pool.query("UPDATE usuarios SET senha_hash = NULL, ultimo_login = NULL WHERE id = ?", [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: "Usuario nao encontrado." });
    await pool.query("DELETE FROM sessoes WHERE usuario_id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Nao foi possivel resetar a senha." });
  }
});

app.use("/api", (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") {
    if (req.path === "/config/app") return next();
    if (req.path === "/resumo" || req.path === "/departamentos/comparativo") return requirePermission("view_folhas")(req, res, next);
    if (req.path.startsWith("/nfs/")) return requirePermission("view_folhas")(req, res, next);
    if (req.path === "/cadastros" || req.path === "/unidades") {
      if (hasPermission(req.user, "view_prestadores") || hasPermission(req.user, "manage_cadastros")) return next();
      return res.status(403).json({ error: "Usuario sem permissao para esta acao." });
    }
    if (req.path === "/config/smtp") return requirePermission("manage_smtp")(req, res, next);
    if (req.path === "/config/email-templates") return requirePermission("manage_smtp")(req, res, next);
    if (req.path === "/config/omie") return requirePermission("manage_omie_config")(req, res, next);
    if (req.path === "/cadastros-config") return requirePermission("manage_cadastros")(req, res, next);
    if (req.path.startsWith("/folhas")) return requirePermission("view_folhas")(req, res, next);
    if (req.path.startsWith("/adiantamentos") || req.path.startsWith("/rescisoes")) {
      if (req.method === "POST" && /^\/adiantamentos\/[^/]+\/aprovar$/.test(req.path)) return requirePermission("approve_folhas")(req, res, next);
      if (req.method === "POST" && /^\/adiantamentos\/[^/]+\/reprovar$/.test(req.path)) return requirePermission("approve_folhas")(req, res, next);
      if (req.path.startsWith("/adiantamentos")) return requirePermission("manage_adiantamentos")(req, res, next);
      if (hasPermission(req.user, "manage_rescisoes") || hasPermission(req.user, "approve_folhas")) return next();
      return res.status(403).json({ error: "Usuario sem permissao para esta acao." });
    }
    if (req.path.startsWith("/prestadores")) {
      return requirePermission("view_prestadores")(req, res, next);
    }
    return next();
  }

  if (req.path.startsWith("/config/")) {
    if (req.path.startsWith("/config/smtp")) return requirePermission("manage_smtp")(req, res, next);
    if (req.path.startsWith("/config/email-templates")) return requirePermission("manage_smtp")(req, res, next);
    if (req.path.startsWith("/config/omie")) return requirePermission("manage_omie_config")(req, res, next);
    return requirePermission("manage_cadastros")(req, res, next);
  }
  if (req.path.startsWith("/cadastros/") || req.path === "/unidades") {
    return requirePermission("manage_cadastros")(req, res, next);
  }
  if (req.path.startsWith("/folhas")) {
    if (!canViewFolhas(req.user)) return res.status(403).json({ error: "Usuario sem permissao para acessar folhas." });
    if (req.method === "POST" && req.path === "/folhas") return requirePermission("close_folhas")(req, res, next);
    if (req.method === "POST" && /^\/folhas\/[^/]+\/aprovar$/.test(req.path)) return requirePermission("approve_folhas")(req, res, next);
    if (req.method === "POST" && /^\/folhas\/[^/]+\/reprovar$/.test(req.path)) return requirePermission("approve_folhas")(req, res, next);
    if (req.method === "POST" && /^\/folhas\/[^/]+\/integrar-omie$/.test(req.path)) return requirePermission("integrate_omie")(req, res, next);
    if (req.method === "POST" && /^\/folhas\/[^/]+\/reabrir$/.test(req.path)) return requirePermission("reopen_folhas")(req, res, next);
    if (req.method === "POST" && /^\/folhas\/[^/]+\/prestadores\/[^/]+\/nf$/.test(req.path)) return requirePermission("view_folhas")(req, res, next);
    if (req.method !== "GET" && req.method !== "HEAD") return requirePermission("edit_prestadores")(req, res, next);
    return next();
  }
  if (req.path.startsWith("/nfs")) {
    if (req.method === "GET" || req.method === "HEAD") return next();
    return requirePermission("view_folhas")(req, res, next);
  }
  if (/^\/prestadores\/[^/]+\/rescisao/.test(req.path)) {
    return requirePermission("manage_rescisoes")(req, res, next);
  }
  if (req.path.startsWith("/prestadores")) {
    if (req.method !== "GET" && req.method !== "HEAD") return requirePermission("edit_prestadores")(req, res, next);
    return requirePermission("view_prestadores")(req, res, next);
  }
  if (req.path.startsWith("/adiantamentos")) {
    return requirePermission("manage_adiantamentos")(req, res, next);
  }
  if (req.path.startsWith("/rescisoes")) {
    if (req.method === "POST" && /^\/rescisoes\/[^/]+\/aprovar$/.test(req.path)) return requirePermission("approve_folhas")(req, res, next);
    if (req.method === "POST" && /^\/rescisoes\/[^/]+\/reprovar$/.test(req.path)) return requirePermission("approve_folhas")(req, res, next);
    if (req.method === "POST" && /^\/rescisoes\/[^/]+\/integrar-omie$/.test(req.path)) return requirePermission("integrate_omie")(req, res, next);
    return requirePermission("manage_rescisoes")(req, res, next);
  }
  return next();
});

app.get("/api/config/smtp", (_req, res) => {
  const env = readEnv();
  res.json({
    smtp: {
      nfDestinationEmail: env.NF_DESTINATION_EMAIL || process.env.NF_DESTINATION_EMAIL || "paulo.mendonca@redefrete.com.br",
      graphTenantId: env.GRAPH_TENANT_ID || process.env.GRAPH_TENANT_ID || "",
      graphClientId: env.GRAPH_CLIENT_ID || process.env.GRAPH_CLIENT_ID || "",
      graphFrom: env.GRAPH_FROM || process.env.GRAPH_FROM || "",
      graphSecretConfigured: Boolean(env.GRAPH_CLIENT_SECRET || process.env.GRAPH_CLIENT_SECRET),
    },
  });
});

app.get("/api/config/omie", (_req, res) => {
  const env = readEnv();
  res.json({
    omie: {
      appKey: env.OMIE_APP_KEY || process.env.OMIE_APP_KEY || "",
      appSecretConfigured: Boolean(env.OMIE_APP_SECRET || process.env.OMIE_APP_SECRET),
      dueDay: env.OMIE_DUE_DAY || process.env.OMIE_DUE_DAY || "5",
      contaCorrenteId: env.OMIE_CONTA_CORRENTE_ID || process.env.OMIE_CONTA_CORRENTE_ID || "",
      banco: env.OMIE_CONTA_BANCO || process.env.OMIE_CONTA_BANCO || "341",
      agencia: env.OMIE_CONTA_AGENCIA || process.env.OMIE_CONTA_AGENCIA || "1268",
      conta: env.OMIE_CONTA_NUMERO || process.env.OMIE_CONTA_NUMERO || "33981-7",
      holidays: env.OMIE_HOLIDAYS || process.env.OMIE_HOLIDAYS || "",
    },
  });
});

app.get("/api/config/app", (_req, res) => {
  const temps = temporaryOpenCompetencias();
  const adiantamentoTemps = temporaryAdiantamentoCompetencias();
  res.json({
    currentCompetencia: currentCompetencia(),
    temporaryOpenCompetencias: temps,
    temporaryAdiantamentoCompetencias: adiantamentoTemps,
    minEditableCompetencia: temps.length ? [...temps].sort()[0] : currentCompetencia(),
    minAdiantamentoCompetencia: adiantamentoTemps.length ? [...adiantamentoTemps].sort()[0] : currentCompetencia(),
  });
});

app.post("/api/config/omie", (req, res) => {
  const updates = {
    OMIE_APP_KEY: req.body.appKey || "",
    OMIE_DUE_DAY: req.body.dueDay || "5",
    OMIE_CONTA_CORRENTE_ID: req.body.contaCorrenteId || "",
    OMIE_CONTA_BANCO: req.body.banco || "341",
    OMIE_CONTA_AGENCIA: req.body.agencia || "1268",
    OMIE_CONTA_NUMERO: req.body.conta || "33981-7",
    OMIE_HOLIDAYS: req.body.holidays || "",
  };
  if (req.body.appSecret) updates.OMIE_APP_SECRET = req.body.appSecret;
  writeEnv(updates);
  res.json({ ok: true });
});

app.post("/api/config/omie/test", async (_req, res) => {
  try {
    const contaCorrenteId = await resolveOmieContaCorrenteId();
    res.json({ ok: true, contaCorrenteId });
  } catch (error) {
    res.status(500).json({ error: error.message || "Nao foi possivel testar a Omie." });
  }
});

app.post("/api/config/smtp", (req, res) => {
  const updates = {
    NF_DESTINATION_EMAIL: req.body.nfDestinationEmail || "paulo.mendonca@redefrete.com.br",
    GRAPH_TENANT_ID: req.body.graphTenantId || "",
    GRAPH_CLIENT_ID: req.body.graphClientId || "",
    GRAPH_FROM: req.body.graphFrom || "",
  };
  if (req.body.graphClientSecret) updates.GRAPH_CLIENT_SECRET = req.body.graphClientSecret;
  writeEnv(updates);
  res.json({ ok: true });
});

app.post("/api/config/smtp/test", async (req, res) => {
  try {
    if (!emailConfigured()) {
      return res.status(400).json({ error: "E-mail ainda nao esta configurado." });
    }
    const to = req.body.to || process.env.NF_DESTINATION_EMAIL || "paulo.mendonca@redefrete.com.br";
    const result = await sendMailMessage({
      to,
      subject: "Teste de e-mail - Redefrete Pagamentos PJ",
      text: "Este e um teste de envio de e-mail do sistema Redefrete Pagamentos PJ.",
    });
    res.json({ ok: true, provider: "graph", to, messageId: result.messageId, accepted: result.accepted, rejected: result.rejected });
  } catch (error) {
    res.status(500).json({
      error: error.response || error.message || "Nao foi possivel enviar o e-mail de teste.",
      code: error.code || null,
      responseCode: error.responseCode || null,
    });
  }
});

app.get("/api/config/email-templates", async (_req, res) => {
  try {
    const [rows] = await pool.query("SELECT tipo, nome, assunto, corpo, atualizado_em FROM email_templates ORDER BY FIELD(tipo, 'folha_nf', 'rescisao_nf', 'aprovacao'), tipo");
    const byTipo = new Map(rows.map((row) => [row.tipo, row]));
    const templates = Object.entries(emailTemplateDefaults).map(([tipo, defaults]) => byTipo.get(tipo) || { tipo, ...defaults, atualizado_em: null });
    res.json({
      templates,
      variaveis: {
        folha_nf: ["{{nome}}", "{{razao_social}}", "{{competencia}}", "{{valor}}", "{{prazo}}", "{{email_destino_nf}}"],
        rescisao_nf: ["{{nome}}", "{{razao_social}}", "{{competencia}}", "{{data_rescisao}}", "{{valor}}", "{{email_destino_nf}}"],
        aprovacao: ["{{aprovador_nome}}", "{{aprovador_email}}", "{{titulo}}", "{{detalhe}}", "{{link}}"],
      },
    });
  } catch {
    res.status(500).json({ error: "Nao foi possivel carregar os modelos de e-mail." });
  }
});

app.put("/api/config/email-templates/:tipo", async (req, res) => {
  try {
    const tipo = req.params.tipo;
    if (!emailTemplateDefaults[tipo]) return res.status(404).json({ error: "Modelo de e-mail nao encontrado." });
    const assunto = String(req.body.assunto || "").trim();
    const corpo = String(req.body.corpo || "").trim();
    if (!assunto || !corpo) return res.status(400).json({ error: "Informe assunto e corpo do e-mail." });
    await pool.query(
      `INSERT INTO email_templates (tipo, nome, assunto, corpo)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE assunto = VALUES(assunto), corpo = VALUES(corpo)`,
      [tipo, emailTemplateDefaults[tipo].nome, assunto, corpo],
    );
    const template = await getEmailTemplate(tipo);
    res.json({ ok: true, template });
  } catch {
    res.status(500).json({ error: "Nao foi possivel salvar o modelo de e-mail." });
  }
});

app.get("/api/resumo", async (req, res) => {
  try {
    const [[prestadores]] = await pool.query(`SELECT COUNT(*) AS total FROM prestadores p WHERE p.ativo = 1 ${contractVisibilityWhere(req.user, "p")}`);
    const [[adiantamentos]] = await pool.query(
      `SELECT COALESCE(SUM(valor), 0) AS total
       FROM adiantamento_parcelas
       WHERE descontado = 0`,
    );
    const [[folha]] = await pool.query(
      `SELECT competencia, liquido_total, status
       FROM vw_folhas_resumo
       ORDER BY competencia DESC
       LIMIT 1`,
    );
    res.json({
      prestadoresAtivos: Number(prestadores.total || 0),
      adiantamentosEmAberto: canSeeSensitiveValues(req.user) ? Number(adiantamentos.total || 0) : null,
      ultimaFolha: folha ? sanitizeFolhaResumo(folha, req.user) : null,
    });
  } catch (error) {
    res.status(500).json({ error: "Nao foi possivel carregar o resumo." });
  }
});

app.get("/api/unidades", async (_req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM unidades ORDER BY nome");
    res.json({ unidades: rows });
  } catch {
    res.status(500).json({ error: "Nao foi possivel listar unidades." });
  }
});

app.get("/api/cadastros", async (_req, res) => {
  try {
    const [clientes, unidades, funcoes, categorias, departamentos, projetos] = await Promise.all([
      pool.query("SELECT * FROM clientes WHERE ativo = 1 ORDER BY nome").then(([rows]) => rows),
      pool.query("SELECT * FROM unidades WHERE ativo = 1 ORDER BY nome").then(([rows]) => rows),
      pool.query("SELECT * FROM funcoes WHERE ativo = 1 ORDER BY nome").then(([rows]) => rows),
      pool.query(
        `SELECT * FROM categorias
          WHERE ativo = 1
            AND nome COLLATE utf8mb4_unicode_ci IN (?, ?)
          ORDER BY nome`,
        ["Prestadores de Servicos", "Prestadores de Servicos - Dispatchers"],
      ).then(([rows]) => rows),
      pool.query(
        `SELECT d.*, c.nome AS cliente_nome, p.nome AS projeto_nome
           FROM departamentos d
           LEFT JOIN clientes c ON c.id = d.cliente_id
           LEFT JOIN projetos p ON p.id = d.projeto_id
          WHERE d.ativo = 1
          ORDER BY d.nome`,
      ).then(([rows]) => rows),
      pool.query(
        `SELECT p.*, c.nome AS cliente_nome
           FROM projetos p
           LEFT JOIN clientes c ON c.id = p.cliente_id
          WHERE p.ativo = 1
          ORDER BY p.nome`,
      ).then(([rows]) => rows),
    ]);
    res.json({ clientes, unidades, funcoes, categorias, departamentos, projetos });
  } catch {
    res.status(500).json({ error: "Nao foi possivel listar cadastros auxiliares." });
  }
});

const cadastroTables = {
  clientes: { table: "clientes", label: "cliente" },
  unidades: { table: "unidades", label: "unidade" },
  funcoes: { table: "funcoes", label: "funcao" },
  categorias: { table: "categorias", label: "categoria" },
  departamentos: { table: "departamentos", label: "departamento" },
  projetos: { table: "projetos", label: "projeto" },
};

function cadastroConfig(tipo) {
  return cadastroTables[String(tipo || "").toLowerCase()] || null;
}

app.get("/api/cadastros-config", async (_req, res) => {
  try {
    const entries = await Promise.all(Object.entries(cadastroTables).map(async ([tipo, config]) => {
      if (tipo === "projetos") {
        const [rows] = await pool.query(
          `SELECT p.*, c.nome AS cliente_nome
             FROM projetos p
             LEFT JOIN clientes c ON c.id = p.cliente_id
            ORDER BY p.ativo DESC, p.nome ASC`,
        );
        return [tipo, rows];
      }
      if (tipo === "departamentos") {
        const [rows] = await pool.query(
          `SELECT d.*, c.nome AS cliente_nome, p.nome AS projeto_nome
             FROM departamentos d
             LEFT JOIN clientes c ON c.id = d.cliente_id
             LEFT JOIN projetos p ON p.id = d.projeto_id
            ORDER BY d.ativo DESC, d.nome ASC`,
        );
        return [tipo, rows];
      }
      const [rows] = await pool.query(`SELECT * FROM ${config.table} ORDER BY ativo DESC, nome ASC`);
      return [tipo, rows];
    }));
    res.json(Object.fromEntries(entries));
  } catch {
    res.status(500).json({ error: "Nao foi possivel listar cadastros auxiliares." });
  }
});

app.post("/api/cadastros/:tipo", async (req, res) => {
  const config = cadastroConfig(req.params.tipo);
  if (!config) return res.status(404).json({ error: "Cadastro auxiliar nao encontrado." });

  const nome = String(req.body.nome || "").trim();
  if (!nome) return res.status(400).json({ error: `Informe o nome da ${config.label}.` });

  try {
    if (config.table === "categorias") {
      const omieCodigo = String(req.body.omie_codigo || "").trim() || null;
      if (omieCodigo && !/^\d+(?:\.\d+)*$/.test(omieCodigo)) {
        return res.status(400).json({ error: "Informe um codigo Omie valido para a categoria, exemplo 2.04.01." });
      }
      await pool.query(
        `INSERT INTO categorias (nome, omie_codigo, ativo) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE omie_codigo = VALUES(omie_codigo), ativo = VALUES(ativo)`,
        [nome, omieCodigo, req.body.ativo === false ? 0 : 1],
      );
      const [[row]] = await pool.query("SELECT * FROM categorias WHERE nome = ?", [nome]);
      return res.status(201).json({ cadastro: row });
    }
    if (config.table === "projetos") {
      const clienteId = req.body.cliente_id || null;
      await pool.query(
        `INSERT INTO projetos (nome, cliente_id, ativo) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE cliente_id = VALUES(cliente_id), ativo = VALUES(ativo)`,
        [nome, clienteId, req.body.ativo === false ? 0 : 1],
      );
      const [[row]] = await pool.query(
        `SELECT p.*, c.nome AS cliente_nome
           FROM projetos p
           LEFT JOIN clientes c ON c.id = p.cliente_id
          WHERE p.nome = ?`,
        [nome],
      );
      return res.status(201).json({ cadastro: row });
    }
    if (config.table === "departamentos") {
      const clienteId = req.body.cliente_id || null;
      const projetoId = req.body.projeto_id || null;
      let omieCodigo = String(req.body.omie_codigo || "").trim() || null;
      if (!omieCodigo) omieCodigo = await resolveOmieDepartamentoPorNome(nome);
      const [[existingContext]] = await pool.query(
        `SELECT id FROM departamentos
          WHERE nome = ?
            AND ${clienteId ? "cliente_id = ?" : "cliente_id IS NULL"}
            AND ${projetoId ? "projeto_id = ?" : "projeto_id IS NULL"}
          LIMIT 1`,
        [nome, ...(clienteId ? [clienteId] : []), ...(projetoId ? [projetoId] : [])],
      );
      const [[existingGeneric]] = existingContext ? [[]] : await pool.query(
        "SELECT id FROM departamentos WHERE nome = ? AND cliente_id IS NULL AND projeto_id IS NULL LIMIT 1",
        [nome],
      );
      const existingId = existingContext?.id || existingGeneric?.id || null;
      if (existingId) {
        await pool.query(
          "UPDATE departamentos SET nome = ?, cliente_id = ?, projeto_id = ?, omie_codigo = ?, ativo = ? WHERE id = ?",
          [nome, clienteId, projetoId, omieCodigo, req.body.ativo === false ? 0 : 1, existingId],
        );
      } else {
        await pool.query(
          "INSERT INTO departamentos (nome, cliente_id, projeto_id, omie_codigo, ativo) VALUES (?, ?, ?, ?, ?)",
          [nome, clienteId, projetoId, omieCodigo, req.body.ativo === false ? 0 : 1],
        );
      }
      const [[row]] = await pool.query(
        `SELECT d.*, c.nome AS cliente_nome, p.nome AS projeto_nome
           FROM departamentos d
           LEFT JOIN clientes c ON c.id = d.cliente_id
           LEFT JOIN projetos p ON p.id = d.projeto_id
          WHERE d.nome = ? AND ${clienteId ? "d.cliente_id = ?" : "d.cliente_id IS NULL"} AND ${projetoId ? "d.projeto_id = ?" : "d.projeto_id IS NULL"}
          LIMIT 1`,
        [nome, ...(clienteId ? [clienteId] : []), ...(projetoId ? [projetoId] : [])],
      );
      return res.status(201).json({ cadastro: row });
    }
    await pool.query(
      `INSERT INTO ${config.table} (nome, ativo) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE ativo = VALUES(ativo)`,
      [nome, req.body.ativo === false ? 0 : 1],
    );
    const [[row]] = await pool.query(`SELECT * FROM ${config.table} WHERE nome = ?`, [nome]);
    res.status(201).json({ cadastro: row });
  } catch {
    res.status(500).json({ error: `Nao foi possivel salvar ${config.label}.` });
  }
});

app.put("/api/cadastros/:tipo/:id", async (req, res) => {
  const config = cadastroConfig(req.params.tipo);
  if (!config) return res.status(404).json({ error: "Cadastro auxiliar nao encontrado." });

  const nome = String(req.body.nome || "").trim();
  if (!nome) return res.status(400).json({ error: `Informe o nome da ${config.label}.` });

  try {
    if (config.table === "categorias") {
      const omieCodigo = String(req.body.omie_codigo || "").trim() || null;
      if (omieCodigo && !/^\d+(?:\.\d+)*$/.test(omieCodigo)) {
        return res.status(400).json({ error: "Informe um codigo Omie valido para a categoria, exemplo 2.04.01." });
      }
      const [result] = await pool.query(
        "UPDATE categorias SET nome = ?, omie_codigo = ?, ativo = ? WHERE id = ?",
        [nome, omieCodigo, req.body.ativo === false ? 0 : 1, req.params.id],
      );
      if (!result.affectedRows) return res.status(404).json({ error: "Registro nao encontrado." });
      const [[row]] = await pool.query("SELECT * FROM categorias WHERE id = ?", [req.params.id]);
      return res.json({ cadastro: row });
    }
    if (config.table === "projetos") {
      const [result] = await pool.query(
        "UPDATE projetos SET nome = ?, cliente_id = ?, ativo = ? WHERE id = ?",
        [nome, req.body.cliente_id || null, req.body.ativo === false ? 0 : 1, req.params.id],
      );
      if (!result.affectedRows) return res.status(404).json({ error: "Registro nao encontrado." });
      const [[row]] = await pool.query(
        `SELECT p.*, c.nome AS cliente_nome
           FROM projetos p
           LEFT JOIN clientes c ON c.id = p.cliente_id
          WHERE p.id = ?`,
        [req.params.id],
      );
      return res.json({ cadastro: row });
    }
    if (config.table === "departamentos") {
      let omieCodigo = String(req.body.omie_codigo || "").trim() || null;
      if (!omieCodigo) omieCodigo = await resolveOmieDepartamentoPorNome(nome);
      const [result] = await pool.query(
        "UPDATE departamentos SET nome = ?, cliente_id = ?, projeto_id = ?, omie_codigo = ?, ativo = ? WHERE id = ?",
        [nome, req.body.cliente_id || null, req.body.projeto_id || null, omieCodigo, req.body.ativo === false ? 0 : 1, req.params.id],
      );
      if (!result.affectedRows) return res.status(404).json({ error: "Registro nao encontrado." });
      const [[row]] = await pool.query(
        `SELECT d.*, c.nome AS cliente_nome, p.nome AS projeto_nome
           FROM departamentos d
           LEFT JOIN clientes c ON c.id = d.cliente_id
           LEFT JOIN projetos p ON p.id = d.projeto_id
          WHERE d.id = ?`,
        [req.params.id],
      );
      return res.json({ cadastro: row });
    }
    const [result] = await pool.query(
      `UPDATE ${config.table} SET nome = ?, ativo = ? WHERE id = ?`,
      [nome, req.body.ativo === false ? 0 : 1, req.params.id],
    );
    if (!result.affectedRows) return res.status(404).json({ error: "Registro nao encontrado." });
    const [[row]] = await pool.query(`SELECT * FROM ${config.table} WHERE id = ?`, [req.params.id]);
    res.json({ cadastro: row });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "Ja existe um cadastro com esse nome." });
    }
    res.status(500).json({ error: `Nao foi possivel atualizar ${config.label}.` });
  }
});

app.delete("/api/cadastros/:tipo/:id", async (req, res) => {
  const config = cadastroConfig(req.params.tipo);
  if (!config) return res.status(404).json({ error: "Cadastro auxiliar nao encontrado." });
  if (config.table !== "projetos") return res.status(400).json({ error: "Exclusao disponivel apenas para projetos." });

  try {
    const [result] = await pool.query("UPDATE projetos SET ativo = 0 WHERE id = ?", [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: "Registro nao encontrado." });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Nao foi possivel excluir o projeto." });
  }
});

app.post("/api/cadastros/categorias/sincronizar-omie", async (_req, res) => {
  try {
    const result = await syncOmieCategorias();
    res.json({ ok: true, ...result });
  } catch (error) {
    const status = isOmieRateLimitError(error) ? 429 : 500;
    res.status(status).json({
      error: error.message || "Nao foi possivel sincronizar categorias da Omie.",
      retrySeconds: parseOmieRetrySeconds(error.message),
    });
  }
});

app.post("/api/cadastros/departamentos/sincronizar-omie", async (_req, res) => {
  try {
    const result = await syncOmieDepartamentos();
    res.json({ ok: true, ...result });
  } catch (error) {
    const status = isOmieRateLimitError(error) ? 429 : 500;
    res.status(status).json({
      error: error.message || "Nao foi possivel sincronizar departamentos da Omie.",
      retrySeconds: parseOmieRetrySeconds(error.message),
    });
  }
});

app.post("/api/unidades", async (req, res) => {
  const nome = String(req.body.nome || "").trim();
  if (!nome) return res.status(400).json({ error: "Informe o nome da unidade." });

  try {
    await pool.query("INSERT IGNORE INTO unidades (nome) VALUES (?)", [nome]);
    const [[row]] = await pool.query("SELECT * FROM unidades WHERE nome = ?", [nome]);
    res.status(201).json({ unidade: row });
  } catch {
    res.status(500).json({ error: "Nao foi possivel salvar a unidade." });
  }
});

app.get("/api/prestadores", async (req, res) => {
  try {
    res.json({ prestadores: await getPrestadores(req.user) });
  } catch {
    res.status(500).json({ error: "Nao foi possivel listar prestadores." });
  }
});

app.get("/api/prestadores/:id/conta-corrente", async (req, res) => {
  try {
    const conta = await getPrestadorContaCorrente(Number(req.params.id), req.user);
    if (!conta) return res.status(404).json({ error: "Prestador nao encontrado." });
    res.json(conta);
  } catch (error) {
    res.status(500).json({ error: error.message || "Nao foi possivel carregar a conta corrente do prestador." });
  }
});

app.post("/api/prestadores", async (req, res) => {
  const errors = validatePrestador(req.body, req.user);
  if (errors.length) return res.status(400).json({ errors });

  try {
    const [result] = await pool.query(
      `INSERT INTO prestadores
       (unidade_id, cliente_id, funcao_id, categoria_id, departamento_id, projeto_id, cargo_nivel, precificacao_tipo, valor_dia, rescisao_multa_percentual,
        rescisao_multa_empresa_percentual, rescisao_multa_prestador_percentual, nome, cpf, cnpj, razao_social,
        email, telefone, data_admissao,
        salario_contrato, banco, agencia, conta, pix_cpf_cnpj, ativo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        null,
        req.body.cliente_id || null,
        req.body.funcao_id || null,
        req.body.categoria_id || null,
        req.body.departamento_id || null,
        req.body.projeto_id || null,
        req.body.cargo_nivel || "operacao",
        req.body.precificacao_tipo === "diaria" ? "diaria" : "mensal",
        money(req.body.valor_dia),
        money(req.body.rescisao_multa_prestador_percentual),
        money(req.body.rescisao_multa_empresa_percentual),
        money(req.body.rescisao_multa_prestador_percentual),
        req.body.nome,
        onlyDigits(req.body.cpf),
        onlyDigits(req.body.cnpj),
        req.body.razao_social,
        req.body.email || null,
        req.body.telefone || null,
        req.body.data_admissao || null,
        money(req.body.salario_contrato),
        req.body.banco || null,
        req.body.agencia || null,
        req.body.conta || null,
        req.body.pix_cpf_cnpj || null,
        req.body.ativo === false ? 0 : 1,
      ],
    );
    res.status(201).json({ id: result.insertId });
  } catch (error) {
    res.status(500).json({ error: "Nao foi possivel salvar o prestador. Verifique duplicidade de CPF/CNPJ." });
  }
});

app.put("/api/prestadores/:id", async (req, res) => {
  const errors = validatePrestador(req.body, req.user, req.params.id);
  if (errors.length) return res.status(400).json({ errors });

  try {
    await pool.query(
      `UPDATE prestadores SET
       unidade_id = ?, cliente_id = ?, funcao_id = ?, categoria_id = ?, departamento_id = ?, projeto_id = ?, cargo_nivel = ?,
       precificacao_tipo = ?, valor_dia = ?,
       rescisao_multa_percentual = ?, rescisao_multa_empresa_percentual = ?, rescisao_multa_prestador_percentual = ?,
       nome = ?, cpf = ?, cnpj = ?, razao_social = ?, email = ?, telefone = ?,
       data_admissao = ?, data_rescisao = ?, salario_contrato = ?, banco = ?, agencia = ?, conta = ?,
       pix_cpf_cnpj = ?, ativo = ?
       WHERE id = ?`,
      [
        null,
        req.body.cliente_id || null,
        req.body.funcao_id || null,
        req.body.categoria_id || null,
        req.body.departamento_id || null,
        req.body.projeto_id || null,
        req.body.cargo_nivel || "operacao",
        req.body.precificacao_tipo === "diaria" ? "diaria" : "mensal",
        money(req.body.valor_dia),
        money(req.body.rescisao_multa_prestador_percentual),
        money(req.body.rescisao_multa_empresa_percentual),
        money(req.body.rescisao_multa_prestador_percentual),
        req.body.nome,
        onlyDigits(req.body.cpf),
        onlyDigits(req.body.cnpj),
        req.body.razao_social,
        req.body.email || null,
        req.body.telefone || null,
        req.body.data_admissao || null,
        req.body.data_rescisao || null,
        money(req.body.salario_contrato),
        req.body.banco || null,
        req.body.agencia || null,
        req.body.conta || null,
        req.body.pix_cpf_cnpj || null,
        req.body.ativo === false ? 0 : 1,
        req.params.id,
      ],
    );
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Nao foi possivel atualizar o prestador." });
  }
});

app.get("/api/adiantamentos", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, p.nome, p.razao_social,
        SUM(CASE WHEN ap.descontado = 0 THEN ap.valor ELSE 0 END) AS saldo_aberto
       FROM adiantamentos a
       JOIN prestadores p ON p.id = a.prestador_id
       LEFT JOIN adiantamento_parcelas ap ON ap.adiantamento_id = a.id
       GROUP BY a.id
       ORDER BY a.data_adiantamento DESC, a.id DESC`,
    );
    for (const row of rows) {
      row.aprovacoes = await getAdiantamentoApprovals(row);
    }
    res.json({
      adiantamentos: canSeeSensitiveValues(req.user)
        ? rows
        : rows.map((row) => ({ ...row, valor_total: null, saldo_aberto: null })),
    });
  } catch {
    res.status(500).json({ error: "Nao foi possivel listar adiantamentos." });
  }
});

app.post("/api/adiantamentos", async (req, res) => {
  const parcelas = Math.max(Number(req.body.parcelas || 1), 1);
  const valorTotal = money(req.body.valor_total);
  const competenciaInicial = req.body.competencia_inicial;
  const dataAdiantamento = req.body.data_adiantamento || new Date().toISOString().slice(0, 10);
  const competenciaAtual = currentCompetencia();
  if (!req.body.prestador_id || valorTotal <= 0 || !competenciaInicial) {
    return res.status(400).json({ error: "Informe prestador, valor e competencia inicial." });
  }
  if (dateCompetencia(dataAdiantamento) < competenciaAtual && !isTemporaryAdiantamentoCompetencia(dateCompetencia(dataAdiantamento))) {
    return res.status(400).json({ error: "A data do adiantamento nao pode ser menor que o mes em aberto." });
  }
  if (competenciaInicial < competenciaAtual && !isTemporaryAdiantamentoCompetencia(competenciaInicial)) {
    return res.status(400).json({ error: "As parcelas nao podem iniciar antes do mes atual." });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.query(
      `INSERT INTO adiantamentos
       (prestador_id, data_adiantamento, valor_total, parcelas, competencia_inicial, observacao)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        req.body.prestador_id,
        dataAdiantamento,
        valorTotal,
        parcelas,
        competenciaInicial,
        req.body.observacao || null,
      ],
    );

    const base = Math.floor((valorTotal / parcelas) * 100) / 100;
    let acumulado = 0;
    for (let index = 0; index < parcelas; index += 1) {
      const valor = index === parcelas - 1 ? Number((valorTotal - acumulado).toFixed(2)) : base;
      acumulado += valor;
      await connection.query(
        `INSERT INTO adiantamento_parcelas
         (adiantamento_id, competencia, numero_parcela, valor)
         VALUES (?, ?, ?, ?)`,
        [result.insertId, addMonths(competenciaInicial, index), index + 1, valor],
      );
    }

    await connection.commit();
    res.status(201).json({ id: result.insertId });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ error: "Nao foi possivel salvar o adiantamento." });
  } finally {
    connection.release();
  }
});

app.post("/api/adiantamentos/:id/enviar-aprovacao", async (req, res) => {
  try {
    const [[adiantamento]] = await pool.query(
      `SELECT a.*, p.nome, p.razao_social
       FROM adiantamentos a
       JOIN prestadores p ON p.id = a.prestador_id
       WHERE a.id = ?`,
      [req.params.id],
    );
    if (!adiantamento) return res.status(404).json({ error: "Adiantamento nao encontrado." });
    if (!["aberto", "reprovado"].includes(adiantamento.status || "aberto")) {
      return res.status(400).json({ error: "Somente adiantamento aberto ou reprovado pode ser enviado para aprovação." });
    }
    const approvers = await getMandatoryApprovers(pool, "adiantamento");
    if (!approvers.length) return res.status(400).json({ error: "Nao ha aprovadores obrigatorios cadastrados." });
    const payloadHash = adiantamentoApprovalPayloadHash(adiantamento);
    await pool.query(
      `UPDATE adiantamentos
       SET status = 'em_aprovacao', approval_payload_hash = ?, approval_rejeitado_por = NULL,
         approval_rejeitado_em = NULL, approval_rejeicao_motivo = NULL
       WHERE id = ?`,
      [payloadHash, adiantamento.id],
    );
    await pool.query("DELETE FROM adiantamento_aprovacoes WHERE adiantamento_id = ? AND payload_hash <> ?", [adiantamento.id, payloadHash]);
    const result = await sendApprovalRequestEmails(req, {
      tipo: "adiantamento",
      titulo: "Adiantamento PJ pronto para aprovação",
      detalhe: `Adiantamento de ${adiantamento.razao_social || adiantamento.nome}, valor ${formatCurrency(adiantamento.valor_total)}, aguardando análise.`,
      link: appUrl(req, `/aprovacoes.html?tipo=adiantamento&id=${encodeURIComponent(adiantamento.id)}`),
      approvers: [approvers[0]],
    });
    res.json({ ...result, aprovacoes: await getAdiantamentoApprovals(adiantamento) });
  } catch (error) {
    res.status(500).json({ error: error.message || "Nao foi possivel enviar o adiantamento para aprovacao." });
  }
});

app.post("/api/adiantamentos/:id/aprovar", async (req, res) => {
  try {
    const [[adiantamento]] = await pool.query("SELECT * FROM adiantamentos WHERE id = ?", [req.params.id]);
    if (!adiantamento) return res.status(404).json({ error: "Adiantamento nao encontrado." });
    if (adiantamento.status !== "em_aprovacao") return res.status(400).json({ error: "O adiantamento precisa estar em aprovação." });
    const payloadHash = adiantamentoApprovalPayloadHash(adiantamento);
    if (adiantamento.approval_payload_hash && adiantamento.approval_payload_hash !== payloadHash) {
      return res.status(400).json({ error: "O adiantamento mudou. Reenvie para aprovação." });
    }
    const before = await getAdiantamentoApprovals(adiantamento);
    assertSequentialApprover(req.user, before);
    const codigoAutenticacao = adiantamentoApprovalAuthCode(adiantamento.id, req.user.id, payloadHash);
    await pool.query(
      `INSERT INTO adiantamento_aprovacoes (adiantamento_id, usuario_id, payload_hash, codigo_autenticacao, decisao, aprovado_em, comentario)
       VALUES (?, ?, ?, ?, 'aprovado', NOW(), ?)
       ON DUPLICATE KEY UPDATE payload_hash = VALUES(payload_hash), codigo_autenticacao = VALUES(codigo_autenticacao),
         decisao = 'aprovado', aprovado_em = NOW(), comentario = VALUES(comentario)`,
      [adiantamento.id, req.user.id, payloadHash, codigoAutenticacao, req.body.comentario || null],
    );
    const aprovacoes = await getAdiantamentoApprovals(adiantamento);
    let aprovado = false;
    let emailProximo = null;
    if (aprovacoes.approved) {
      await pool.query("UPDATE adiantamentos SET status = 'aprovado' WHERE id = ?", [adiantamento.id]);
      aprovado = true;
    } else {
      emailProximo = await sendNextApprovalEmail(req, {
        tipo: "adiantamento",
        titulo: "Adiantamento PJ aguardando aprovação",
        detalhe: "O adiantamento foi aprovado na etapa anterior e aguarda sua análise.",
        link: appUrl(req, `/aprovacoes.html?tipo=adiantamento&id=${encodeURIComponent(adiantamento.id)}`),
        aprovacoes,
      });
    }
    res.json({ ok: true, aprovacoes, aprovado, emailProximo });
  } catch (error) {
    res.status(500).json({ error: error.message || "Nao foi possivel aprovar o adiantamento." });
  }
});

app.post("/api/adiantamentos/:id/reprovar", async (req, res) => {
  try {
    const motivo = String(req.body.motivo || "").trim();
    if (!motivo) return res.status(400).json({ error: "Informe a justificativa da recusa." });
    const [[adiantamento]] = await pool.query("SELECT * FROM adiantamentos WHERE id = ?", [req.params.id]);
    if (!adiantamento) return res.status(404).json({ error: "Adiantamento nao encontrado." });
    if (adiantamento.status !== "em_aprovacao") return res.status(400).json({ error: "O adiantamento não está em aprovação." });
    const payloadHash = adiantamentoApprovalPayloadHash(adiantamento);
    const aprovacoes = await getAdiantamentoApprovals(adiantamento);
    assertSequentialApprover(req.user, aprovacoes);
    await pool.query(
      `INSERT INTO adiantamento_aprovacoes (adiantamento_id, usuario_id, payload_hash, codigo_autenticacao, decisao, aprovado_em, comentario)
       VALUES (?, ?, ?, NULL, 'reprovado', NOW(), ?)
       ON DUPLICATE KEY UPDATE payload_hash = VALUES(payload_hash), codigo_autenticacao = NULL, decisao = 'reprovado',
         aprovado_em = NOW(), comentario = VALUES(comentario)`,
      [adiantamento.id, req.user.id, payloadHash, motivo],
    );
    await pool.query(
      `UPDATE adiantamentos
       SET status = 'reprovado', approval_rejeitado_por = ?, approval_rejeitado_em = NOW(), approval_rejeicao_motivo = ?
       WHERE id = ?`,
      [req.user.id, motivo, adiantamento.id],
    );
    res.json({ ok: true, status: "reprovado", motivo });
  } catch (error) {
    res.status(500).json({ error: error.message || "Nao foi possivel reprovar o adiantamento." });
  }
});

app.delete("/api/adiantamentos/:id", async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[adiantamento]] = await connection.query("SELECT id, status FROM adiantamentos WHERE id = ? FOR UPDATE", [req.params.id]);
    if (!adiantamento) {
      await connection.rollback();
      return res.status(404).json({ error: "Adiantamento nao encontrado." });
    }
    if (adiantamento.status === "em_aprovacao") {
      await connection.rollback();
      return res.status(423).json({ error: "Adiantamento em aprovação. Nenhuma alteração é permitida." });
    }

    if (adiantamento.status === "aprovado") {
      await connection.rollback();
      return res.status(423).json({ error: "Adiantamento aprovado nao pode ser excluido." });
    }

    const [[bloqueios]] = await connection.query(
      `SELECT
        SUM(CASE WHEN ap.descontado = 1 THEN 1 ELSE 0 END) AS parcelas_pagas,
        SUM(CASE WHEN f.id IS NOT NULL AND f.status = 'fechada' THEN 1 ELSE 0 END) AS competencias_fechadas
       FROM adiantamento_parcelas ap
       LEFT JOIN folhas f ON f.competencia = ap.competencia
       WHERE ap.adiantamento_id = ?`,
      [req.params.id],
    );

    if (Number(bloqueios.parcelas_pagas || 0) > 0) {
      await connection.rollback();
      return res.status(400).json({ error: "Nao e possivel excluir adiantamento com parcela ja paga/descontada." });
    }

    if (Number(bloqueios.competencias_fechadas || 0) > 0) {
      await connection.rollback();
      return res.status(400).json({ error: "Nao e possivel excluir adiantamento com parcela em periodo de folha fechada." });
    }

    await connection.query("DELETE FROM adiantamentos WHERE id = ?", [req.params.id]);
    await connection.commit();
    res.json({ ok: true });
  } catch {
    await connection.rollback();
    res.status(500).json({ error: "Nao foi possivel excluir o adiantamento." });
  } finally {
    connection.release();
  }
});

async function folhaApprovalMobileItem(folha, user) {
  const competencia = folha.competencia;
  const [[lote]] = await pool.query(
    "SELECT * FROM folha_lotes WHERE competencia = ? AND status = 'em_aprovacao' ORDER BY numero DESC LIMIT 1",
    [competencia],
  );
  if (lote) {
    const itens = lote.itens_json ? JSON.parse(lote.itens_json) : [];
    const payloadHash = approvalPayloadHash(competencia, itens, lote.id);
    if (lote.payload_hash && lote.payload_hash !== payloadHash) return null;
    const aprovacoes = await getFolhaApprovals(competencia, payloadHash, pool, lote.id);
    if (Number(aprovacoes.proximo?.id || 0) !== Number(user.id)) return null;
    const total = itens.reduce((sum, item) => sum + Number(item.valor_nf_emitida || 0), 0);
    return {
      tipo: "folha",
      id: competencia,
      titulo: `Folha PJ ${competencia} - Lote ${lote.numero}`,
      subtitulo: `${itens.length} prestador(es)`,
      valor: total,
      status: lote.status,
      competencia,
      aprovacoes,
      approveUrl: `/api/folhas/${encodeURIComponent(competencia)}/aprovar`,
      rejectUrl: `/api/folhas/${encodeURIComponent(competencia)}/reprovar`,
      reportUrl: `/api/folhas/${encodeURIComponent(competencia)}/relatorio`,
      approveBody: { lote_id: lote.id },
    };
  }
  const [storedItems] = await pool.query(
    `SELECT fi.*, p.nome, p.cpf, p.cnpj, p.razao_social, p.email, p.telefone,
      f.nome AS funcao, d.nome AS departamento, pr.nome AS projeto,
      p.salario_contrato, p.precificacao_tipo, p.valor_dia, p.data_admissao, p.data_rescisao, COALESCE(cli.nome, u.nome) AS unidade_nome,
      (fi.valor_nf_emitida - fi.liquido_pagar) AS diferenca_nf
     FROM folha_itens fi
     JOIN prestadores p ON p.id = fi.prestador_id
     LEFT JOIN unidades u ON u.id = p.unidade_id
     LEFT JOIN clientes cli ON cli.id = p.cliente_id
     LEFT JOIN funcoes f ON f.id = p.funcao_id
     LEFT JOIN departamentos d ON d.id = p.departamento_id
     LEFT JOIN projetos pr ON pr.id = p.projeto_id
     WHERE fi.folha_id = ?
     ORDER BY p.nome, p.razao_social`,
    [folha.id],
  );
  let itens = storedItems.map((item) => folhaItemSnapshot(item, folha));
  if (!itens.length) {
    const aberta = await buildFolhaAberta(competencia, { perfil: "master" });
    itens = aberta.itens;
  }
  itens = await attachNfsToItems(competencia, itens);
  const payloadHash = approvalPayloadHash(competencia, itens);
  if (folha.approval_payload_hash && folha.approval_payload_hash !== payloadHash) return null;
  const aprovacoes = await getFolhaApprovals(competencia, payloadHash);
  if (Number(aprovacoes.proximo?.id || 0) !== Number(user.id)) return null;
  const total = itens.reduce((sum, item) => sum + Number(item.liquido_pagar || 0), 0);
  return {
    tipo: "folha",
    id: competencia,
    titulo: `Folha PJ ${competencia}`,
    subtitulo: `${itens.length} prestador(es)`,
    valor: total,
    status: folha.status,
    competencia,
    aprovacoes,
    approveUrl: `/api/folhas/${encodeURIComponent(competencia)}/aprovar`,
    rejectUrl: `/api/folhas/${encodeURIComponent(competencia)}/reprovar`,
    reportUrl: `/api/folhas/${encodeURIComponent(competencia)}/relatorio`,
    approveBody: { itens },
  };
}

async function reembolsoResumoFinanceiro(prestacao) {
  const [adiantamentosUtilizados] = await pool.query(
    `SELECT a.id, a.numero, a.data_adiantamento,
            CASE
              WHEN COALESCE(a.prestacao_id, 0) = ? OR a.id = COALESCE(?, 0)
              THEN a.valor
              ELSE ABS(COALESCE(SUM(m.valor), 0))
            END AS saldo
       FROM rd_reembolso_conta_corrente m
       JOIN rd_reembolso_adiantamentos a ON a.id = m.adiantamento_id
      WHERE m.prestacao_id = ?
        AND m.tipo = 'compensacao_prestacao'
      GROUP BY a.id, a.numero, a.data_adiantamento, a.prestacao_id, a.valor
     HAVING saldo > 0.009
      ORDER BY a.data_adiantamento, a.id`,
    [prestacao.id, prestacao.adiantamento_id || 0, prestacao.id],
  );
  const [saldosPendentes] = await pool.query(
    `SELECT a.id, a.numero, a.data_adiantamento, COALESCE(SUM(m.valor), 0) AS saldo
       FROM rd_reembolso_adiantamentos a
       JOIN rd_reembolso_conta_corrente m ON m.adiantamento_id = a.id
      WHERE a.solicitante_id = ?
        AND a.id <> COALESCE(?, 0)
        AND (
          COALESCE(a.prestacao_id, 0) = 0
          OR a.prestacao_id < ?
        )
      GROUP BY a.id, a.numero, a.data_adiantamento
     HAVING saldo > 0.009
      ORDER BY a.data_adiantamento, a.id`,
    [prestacao.solicitante_id, prestacao.adiantamento_id || 0, prestacao.id],
  );
  const totalDespesas = Number(prestacao.total_despesas || 0);
  const adiantamentoAtual = adiantamentosUtilizados.length
    ? adiantamentosUtilizados.reduce((sum, item) => sum + Number(item.saldo || 0), 0)
    : Number(prestacao.valor_adiantado || 0);
  const saldoPendente = saldosPendentes.reduce((sum, item) => sum + Number(item.saldo || 0), 0);
  const totalAdiantamentos = Math.round((adiantamentoAtual + saldoPendente + Number.EPSILON) * 100) / 100;
  const saldoFinal = Math.round((totalDespesas - totalAdiantamentos + Number.EPSILON) * 100) / 100;
  return {
    total_despesas: totalDespesas,
    adiantamento_atual: adiantamentoAtual,
    saldo_pendente: saldoPendente,
    total_adiantamentos: totalAdiantamentos,
    saldo_final: saldoFinal,
    saldo_label: saldoFinal < 0 ? "Saldo a devolver" : "Saldo a reembolsar",
    saldo_valor: Math.abs(saldoFinal),
    adiantamentos_utilizados: adiantamentosUtilizados,
    saldos_pendentes: saldosPendentes,
  };
}

async function reembolsoApprovalMobileItems(req) {
  const items = [];
  if (hasPermission(req.user, "reembolso_aprovar")) {
    const userStep = reembolsoApprovalStepForUser(req.user);
    const [prestacoes] = userStep ? await pool.query(
      `SELECT p.*, u.nome AS solicitante, u.email AS solicitante_email, d.nome AS centro_custo
         FROM rd_reembolso_prestacoes p
         JOIN usuarios u ON u.id = p.solicitante_id
         LEFT JOIN departamentos d ON d.id = p.centro_custo_id
        WHERE p.status = 'enviada_superior'
          AND NOT EXISTS (
            SELECT 1 FROM rd_reembolso_aprovacoes prior
             WHERE prior.prestacao_id = p.id
               AND prior.decisao = 'aprovado'
               AND prior.etapa IN (${REEMBOLSO_APPROVAL_FLOW.slice(REEMBOLSO_APPROVAL_FLOW.findIndex((item) => item.etapa === userStep.etapa) + 1).map(() => "?").join(",") || "NULL"})
          )
          AND ${REEMBOLSO_APPROVAL_FLOW.slice(0, REEMBOLSO_APPROVAL_FLOW.findIndex((item) => item.etapa === userStep.etapa)).length
            ? `EXISTS (
                SELECT 1 FROM rd_reembolso_aprovacoes prev
                 WHERE prev.prestacao_id = p.id
                   AND prev.decisao = 'aprovado'
                   AND prev.etapa IN (${REEMBOLSO_APPROVAL_FLOW.slice(0, REEMBOLSO_APPROVAL_FLOW.findIndex((item) => item.etapa === userStep.etapa)).map(() => "?").join(",")})
              )`
            : "1=1"}
          AND NOT EXISTS (
            SELECT 1 FROM rd_reembolso_aprovacoes current_step
             WHERE current_step.prestacao_id = p.id
               AND current_step.decisao = 'aprovado'
               AND current_step.etapa = ?
          )
        ORDER BY p.enviado_em, p.id`,
      [
        ...REEMBOLSO_APPROVAL_FLOW.slice(REEMBOLSO_APPROVAL_FLOW.findIndex((item) => item.etapa === userStep.etapa) + 1).map((item) => item.etapa),
        ...REEMBOLSO_APPROVAL_FLOW.slice(0, REEMBOLSO_APPROVAL_FLOW.findIndex((item) => item.etapa === userStep.etapa)).map((item) => item.etapa),
        userStep.etapa,
      ],
    ) : [[]];
    for (const prestacao of prestacoes) {
      const resumo = await reembolsoResumoFinanceiro(prestacao);
      const aprovacoes = await getReembolsoApprovalState(prestacao.id, {
        proximo: { id: req.user.id, nome: req.user.nome, email: req.user.email },
      });
      items.push({
        tipo: "reembolso_superior",
        id: prestacao.id,
        titulo: `Reembolso ${prestacao.numero}`,
        subtitulo: prestacao.solicitante,
        valor: resumo.saldo_final > 0 ? resumo.saldo_valor : 0,
        status: prestacao.status,
        competencia: prestacao.numero,
        data: prestacao.enviado_em || prestacao.created_at,
        nf: prestacao.centro_custo || "",
        aprovacoes,
        approveUrl: `/api/reembolso/prestacoes/${prestacao.id}/aprovar-superior`,
        rejectUrl: `/api/reembolso/prestacoes/${prestacao.id}/reprovar-superior`,
        detailUrl: `/api/aprovacoes/reembolso/prestacoes/${prestacao.id}/detalhes`,
        reportUrl: null,
        approveBody: {},
      });
    }

    const [adiantamentos] = await pool.query(
      `SELECT a.*, u.nome AS solicitante, d.nome AS centro_custo
         FROM rd_reembolso_adiantamentos a
         JOIN usuarios u ON u.id = a.solicitante_id
         LEFT JOIN departamentos d ON d.id = a.centro_custo_id
        WHERE a.status = 'em_aprovacao'
          AND a.superior_id = ?
        ORDER BY a.data_adiantamento, a.id`,
      [req.user.id],
    );
    for (const adiantamento of adiantamentos) {
      items.push({
        tipo: "reembolso_adiantamento",
        id: adiantamento.id,
        titulo: `Adiantamento ${adiantamento.numero}`,
        subtitulo: adiantamento.solicitante,
        valor: adiantamento.valor,
        status: adiantamento.status,
        competencia: adiantamento.numero,
        data: adiantamento.data_adiantamento,
        nf: adiantamento.centro_custo || "",
        aprovacoes: {
          required: 1,
          count: 0,
          approved: false,
          proximo: { id: req.user.id, nome: req.user.nome, email: req.user.email },
          pendentes: [{ id: req.user.id, nome: req.user.nome, email: req.user.email }],
        },
        approveUrl: `/api/reembolso/adiantamentos/${adiantamento.id}/aprovar`,
        rejectUrl: `/api/reembolso/adiantamentos/${adiantamento.id}/reprovar`,
        approveBody: {},
      });
    }
  }

  if (hasPermission(req.user, "reembolso_financeiro")) {
    const [prestacoes] = await pool.query(
      `SELECT p.*, u.nome AS solicitante, d.nome AS centro_custo
         FROM rd_reembolso_prestacoes p
         JOIN usuarios u ON u.id = p.solicitante_id
         LEFT JOIN departamentos d ON d.id = p.centro_custo_id
        WHERE p.status = 'em_validacao_financeira'
          AND NOT EXISTS (
            SELECT 1 FROM rd_reembolso_aprovacoes a
             WHERE a.prestacao_id = p.id AND a.etapa = 'financeiro' AND a.decisao = 'aprovado'
          )
          AND NOT EXISTS (
            SELECT 1 FROM rd_reembolso_aprovacoes a
             WHERE a.prestacao_id = p.id AND a.usuario_id = ? AND a.decisao = 'aprovado'
          )
        ORDER BY p.aprovado_superior_em, p.id`,
      [req.user.id],
    );
    for (const prestacao of prestacoes) {
      const resumo = await reembolsoResumoFinanceiro(prestacao);
      const aprovacoes = await getReembolsoApprovalState(prestacao.id, {
        includeFinanceiro: true,
        proximo: { id: req.user.id, nome: req.user.nome, email: req.user.email },
      });
      items.push({
        tipo: "reembolso_financeiro",
        id: prestacao.id,
        titulo: `Reembolso ${prestacao.numero}`,
        subtitulo: prestacao.solicitante,
        valor: resumo.saldo_final > 0 ? resumo.saldo_valor : 0,
        status: prestacao.status,
        competencia: prestacao.numero,
        data: prestacao.aprovado_superior_em || prestacao.created_at,
        nf: prestacao.centro_custo || "",
        aprovacoes,
        approveUrl: `/api/reembolso/prestacoes/${prestacao.id}/aprovar-financeiro`,
        rejectUrl: `/api/reembolso/prestacoes/${prestacao.id}/reprovar-financeiro`,
        detailUrl: `/api/aprovacoes/reembolso/prestacoes/${prestacao.id}/detalhes`,
        reportUrl: reembolsoAppUrl(req, `/api/prestacoes/${prestacao.id}/relatorio`),
        approveBody: {},
      });
    }
  }

  return items;
}

function requireAnyApprovalPermission(req, res, next) {
  if (
    hasPermission(req.user, "approve_folhas")
    || hasPermission(req.user, "reembolso_aprovar")
    || hasPermission(req.user, "reembolso_financeiro")
  ) return next();
  return res.status(403).json({ error: "Usuario sem permissao para aprovacoes." });
}

app.get("/api/aprovacoes-pendentes", requireAnyApprovalPermission, async (req, res) => {
  try {
    const pendentes = [];

    if (hasPermission(req.user, "approve_folhas")) {
      const [folhas] = await pool.query("SELECT * FROM folhas WHERE status = 'em_aprovacao' ORDER BY competencia DESC");
      for (const folha of folhas) {
        const item = await folhaApprovalMobileItem(folha, req.user);
        if (item) pendentes.push(item);
      }

      const [rescisoes] = await pool.query(
        `SELECT r.*, p.nome, p.razao_social, p.cpf, p.cnpj, n.original_name AS nf_original_name
         FROM rescisoes r
         JOIN prestadores p ON p.id = r.prestador_id
         LEFT JOIN nf_arquivos n ON n.id = r.nf_id
         WHERE r.status = 'em_aprovacao'
         ORDER BY r.data_rescisao DESC, r.id DESC`,
      );
      for (const rescisao of rescisoes) {
        const aprovacoes = await getRescisaoApprovals(rescisao);
        if (Number(aprovacoes.proximo?.id || 0) !== Number(req.user.id)) continue;
        pendentes.push({
          tipo: "rescisao",
          id: rescisao.id,
          titulo: "Rescisão PJ",
          subtitulo: rescisao.razao_social || rescisao.nome,
          valor: rescisao.valor_total_pagar,
          status: rescisao.status,
          competencia: rescisao.competencia,
          data: rescisao.data_rescisao,
          nf: rescisao.numero_nf || rescisao.nf_original_name || "",
          aprovacoes,
          approveUrl: `/api/rescisoes/${rescisao.id}/aprovar`,
          rejectUrl: `/api/rescisoes/${rescisao.id}/reprovar`,
          reportUrl: `/api/rescisoes/${rescisao.id}/relatorio`,
          approveBody: {},
        });
      }

      const [adiantamentos] = await pool.query(
        `SELECT a.*, p.nome, p.razao_social
         FROM adiantamentos a
         JOIN prestadores p ON p.id = a.prestador_id
         WHERE a.status = 'em_aprovacao'
         ORDER BY a.data_adiantamento DESC, a.id DESC`,
      );
      for (const adiantamento of adiantamentos) {
        const aprovacoes = await getAdiantamentoApprovals(adiantamento);
        if (Number(aprovacoes.proximo?.id || 0) !== Number(req.user.id)) continue;
        pendentes.push({
          tipo: "adiantamento",
          id: adiantamento.id,
          titulo: "Adiantamento PJ",
          subtitulo: adiantamento.razao_social || adiantamento.nome,
          valor: adiantamento.valor_total,
          status: adiantamento.status,
          competencia: adiantamento.competencia_inicial,
          data: adiantamento.data_adiantamento,
          parcelas: adiantamento.parcelas,
          aprovacoes,
          approveUrl: `/api/adiantamentos/${adiantamento.id}/aprovar`,
          rejectUrl: `/api/adiantamentos/${adiantamento.id}/reprovar`,
          approveBody: {},
        });
      }
    }

    pendentes.push(...await reembolsoApprovalMobileItems(req));

    res.json({ usuario: publicUser(req.user), pendentes });
  } catch (error) {
    res.status(500).json({ error: error.message || "Nao foi possivel carregar aprovacoes pendentes." });
  }
});

app.get("/api/aprovacoes/reembolso/prestacoes/:id/detalhes", requireAnyApprovalPermission, async (req, res) => {
  try {
    const [[prestacao]] = await pool.query(
      `SELECT p.*, u.nome AS solicitante, u.email AS solicitante_email, d.nome AS centro_custo
         FROM rd_reembolso_prestacoes p
         JOIN usuarios u ON u.id = p.solicitante_id
         LEFT JOIN departamentos d ON d.id = p.centro_custo_id
        WHERE p.id = ?`,
      [req.params.id],
    );
    if (!prestacao) return res.status(404).json({ error: "Prestação não encontrada." });

    const resumo = await reembolsoResumoFinanceiro(prestacao);
    prestacao.resumo_financeiro = resumo;
    prestacao.valor_reembolsar_calculado = resumo.saldo_final > 0 ? resumo.saldo_valor : 0;
    prestacao.saldo_devolver_calculado = resumo.saldo_final < 0 ? resumo.saldo_valor : 0;

    const [despesas] = await pool.query(
      `SELECT d.*, t.nome AS tipo_despesa, t.exige_km
         FROM rd_reembolso_despesas d
         JOIN rd_reembolso_tipos_despesa t ON t.id = d.tipo_despesa_id
        WHERE d.prestacao_id = ?
        ORDER BY d.data_despesa, d.id`,
      [req.params.id],
    );
    const [comprovantes] = await pool.query(
      `SELECT c.id, c.despesa_id, c.nome_original, c.mime_type, c.tamanho_bytes, c.created_at
         FROM rd_reembolso_comprovantes c
         JOIN rd_reembolso_despesas d ON d.id = c.despesa_id
        WHERE d.prestacao_id = ?
        ORDER BY c.created_at, c.id`,
      [req.params.id],
    );
    const comprovantesPorDespesa = new Map();
    for (const comprovante of comprovantes) {
      const key = Number(comprovante.despesa_id);
      if (!comprovantesPorDespesa.has(key)) comprovantesPorDespesa.set(key, []);
      comprovantesPorDespesa.get(key).push({
        id: comprovante.id,
        nome_original: comprovante.nome_original,
        mime_type: comprovante.mime_type,
        tamanho_bytes: comprovante.tamanho_bytes,
        url: `/api/aprovacoes/reembolso/comprovantes/${comprovante.id}/visualizar`,
      });
    }
    for (const despesa of despesas) {
      despesa.comprovantes = comprovantesPorDespesa.get(Number(despesa.id)) || [];
    }
    const aprovacoes = await getReembolsoApprovalState(prestacao.id, {
      includeFinanceiro: prestacao.status !== "enviada_superior",
    });
    res.json({ prestacao, despesas, aprovacoes });
  } catch (error) {
    res.status(500).json({ error: error.message || "Não foi possível carregar os detalhes." });
  }
});

app.get("/api/aprovacoes/reembolso/comprovantes/:id/visualizar", requireAnyApprovalPermission, async (req, res) => {
  try {
    const [[comprovante]] = await pool.query(
      `SELECT c.*, p.id AS prestacao_id
         FROM rd_reembolso_comprovantes c
         JOIN rd_reembolso_despesas d ON d.id = c.despesa_id
         JOIN rd_reembolso_prestacoes p ON p.id = d.prestacao_id
        WHERE c.id = ?`,
      [req.params.id],
    );
    if (!comprovante) return res.status(404).json({ error: "Comprovante não encontrado." });
    const baseDir = path.resolve(__dirname, "reembolso-despesas", "uploads", "comprovantes");
    const filePath = path.resolve(baseDir, comprovante.caminho_arquivo);
    if (!filePath.startsWith(baseDir) || !fs.existsSync(filePath)) return res.status(404).json({ error: "Arquivo não encontrado." });
    const safeName = String(comprovante.nome_original || "comprovante").replace(/[\\"]/g, "");
    res.setHeader("Content-Type", comprovante.mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    res.status(500).json({ error: error.message || "Não foi possível abrir o comprovante." });
  }
});

app.post("/api/reembolso/prestacoes/:id/aprovar-superior", requirePermission("reembolso_aprovar"), async (req, res) => {
  try {
    const [[prestacao]] = await pool.query("SELECT * FROM rd_reembolso_prestacoes WHERE id = ?", [req.params.id]);
    if (!prestacao) return res.status(404).json({ error: "Prestacao nao encontrada." });
    if (prestacao.status !== "enviada_superior") return res.status(400).json({ error: "Prestacao nao esta aguardando aprovacao do superior." });
    const expectedStep = await nextReembolsoApprovalStep(req.params.id);
    if (!expectedStep) return res.status(400).json({ error: "Fluxo de aprovacao ja concluido." });
    const userStep = reembolsoApprovalStepForUser(req.user);
    if (!userStep || userStep.etapa !== expectedStep.etapa) {
      return res.status(403).json({ error: `Esta etapa esta aguardando ${expectedStep.nome}.` });
    }
    const [[existing]] = await pool.query(
      "SELECT id FROM rd_reembolso_aprovacoes WHERE prestacao_id = ? AND usuario_id = ? AND decisao = 'aprovado' LIMIT 1",
      [req.params.id, req.user.id],
    );
    if (existing) return res.status(400).json({ error: "Este aprovador ja aprovou esta prestacao." });
    const codigo = reembolsoAuthCode("APR");
    await pool.query(
      "INSERT INTO rd_reembolso_aprovacoes (prestacao_id, usuario_id, etapa, decisao, justificativa, autenticacao, created_at) VALUES (?, ?, ?, 'aprovado', ?, ?, NOW())",
      [req.params.id, req.user.id, expectedStep.etapa, req.body.justificativa || req.body.comentario || null, codigo],
    );
    const nextStep = await nextReembolsoApprovalStep(req.params.id);
    let dataPagamento = null;
    if (nextStep) {
      await pool.query("UPDATE rd_reembolso_prestacoes SET updated_at = NOW() WHERE id = ?", [req.params.id]);
    } else {
      try {
        dataPagamento = calcularDataPagamentoReembolso(prestacao.created_at, new Date()) || fallbackDataPagamentoReembolso();
      } catch {
        dataPagamento = fallbackDataPagamentoReembolso();
      }
      await pool.query(
        "UPDATE rd_reembolso_prestacoes SET status = 'em_validacao_financeira', aprovado_superior_em = NOW(), data_pagamento_prevista = ?, updated_at = NOW() WHERE id = ?",
        [dataPagamento, req.params.id],
      );
    }
    await pool.query(
      "INSERT INTO rd_reembolso_historico (prestacao_id, usuario_id, acao, descricao, dados_json, created_at) VALUES (?, ?, 'aprovou_superior', 'Superior aprovou a prestacao pela central de aprovacoes.', NULL, NOW())",
      [req.params.id, req.user.id],
    );
    res.json({ ok: true, autenticacao: codigo, data_pagamento_prevista: dataPagamento, proxima_etapa: nextStep?.nome || "Financeiro" });
  } catch (error) {
    console.error("Erro ao aprovar reembolso superior", error);
    res.status(500).json({ error: error.message || "Nao foi possivel aprovar o reembolso." });
  }
});

app.post("/api/reembolso/prestacoes/:id/reprovar-superior", requirePermission("reembolso_aprovar"), async (req, res) => {
  try {
    const motivo = String(req.body.motivo || req.body.justificativa || "").trim();
    if (!motivo) return res.status(400).json({ error: "Informe a justificativa da recusa." });
    const codigo = reembolsoAuthCode("REP");
    await pool.query(
      "UPDATE rd_reembolso_prestacoes SET status = 'reprovada_superior', motivo_reprovacao = ?, updated_at = NOW() WHERE id = ? AND status = 'enviada_superior'",
      [motivo, req.params.id],
    );
    await pool.query(
      "INSERT INTO rd_reembolso_aprovacoes (prestacao_id, usuario_id, etapa, decisao, justificativa, autenticacao, created_at) VALUES (?, ?, 'superior', 'reprovado', ?, ?, NOW())",
      [req.params.id, req.user.id, motivo, codigo],
    );
    await pool.query(
      "INSERT INTO rd_reembolso_historico (prestacao_id, usuario_id, acao, descricao, dados_json, created_at) VALUES (?, ?, 'reprovou_superior', ?, NULL, NOW())",
      [req.params.id, req.user.id, motivo],
    );
    res.json({ ok: true, autenticacao: codigo });
  } catch (error) {
    res.status(500).json({ error: error.message || "Nao foi possivel reprovar o reembolso." });
  }
});

app.post("/api/reembolso/prestacoes/:id/aprovar-financeiro", requirePermission("reembolso_financeiro"), async (req, res) => {
  try {
    const [[prestacao]] = await pool.query("SELECT * FROM rd_reembolso_prestacoes WHERE id = ?", [req.params.id]);
    if (!prestacao) return res.status(404).json({ error: "Prestacao nao encontrada." });
    if (prestacao.status !== "em_validacao_financeira") return res.status(400).json({ error: "Prestacao nao esta em validacao financeira." });
    const superiorApprovals = await reembolsoApprovedFlowSteps(req.params.id);
    if (superiorApprovals.length < REEMBOLSO_APPROVAL_FLOW.length) return res.status(400).json({ error: "A prestacao precisa das aprovacoes da Simone e do Paulo antes do financeiro." });
    if (superiorApprovals.some((approval) => Number(approval.usuario_id) === Number(req.user.id))) {
      return res.status(400).json({ error: "O aprovador financeiro deve ser diferente do aprovador superior." });
    }
    const [[financialApproval]] = await pool.query(
      "SELECT id FROM rd_reembolso_aprovacoes WHERE prestacao_id = ? AND etapa = 'financeiro' AND decisao = 'aprovado' LIMIT 1",
      [req.params.id],
    );
    if (financialApproval) return res.status(400).json({ error: "Esta prestacao ja foi aprovada pelo financeiro." });
    const codigo = reembolsoAuthCode("FIN");
    await pool.query(
      "INSERT INTO rd_reembolso_aprovacoes (prestacao_id, usuario_id, etapa, decisao, justificativa, autenticacao, created_at) VALUES (?, ?, 'financeiro', 'aprovado', ?, ?, NOW())",
      [req.params.id, req.user.id, req.body.justificativa || req.body.comentario || null, codigo],
    );
    await pool.query(
      "INSERT INTO rd_reembolso_historico (prestacao_id, usuario_id, acao, descricao, dados_json, created_at) VALUES (?, ?, 'aprovou_financeiro', 'Financeiro aprovou a prestacao pela central de aprovacoes.', NULL, NOW())",
      [req.params.id, req.user.id],
    );
    res.json({ ok: true, autenticacao: codigo });
  } catch (error) {
    res.status(500).json({ error: error.message || "Nao foi possivel aprovar o reembolso no financeiro." });
  }
});

app.post("/api/reembolso/prestacoes/:id/reprovar-financeiro", requirePermission("reembolso_financeiro"), async (req, res) => {
  try {
    const motivo = String(req.body.motivo || req.body.justificativa || "").trim();
    if (!motivo) return res.status(400).json({ error: "Informe a justificativa da recusa." });
    const codigo = reembolsoAuthCode("REF");
    await pool.query(
      "UPDATE rd_reembolso_prestacoes SET status = 'reprovada_financeiro', motivo_reprovacao = ?, updated_at = NOW() WHERE id = ? AND status = 'em_validacao_financeira'",
      [motivo, req.params.id],
    );
    await pool.query(
      "INSERT INTO rd_reembolso_aprovacoes (prestacao_id, usuario_id, etapa, decisao, justificativa, autenticacao, created_at) VALUES (?, ?, 'financeiro', 'reprovado', ?, ?, NOW())",
      [req.params.id, req.user.id, motivo, codigo],
    );
    await pool.query(
      "INSERT INTO rd_reembolso_historico (prestacao_id, usuario_id, acao, descricao, dados_json, created_at) VALUES (?, ?, 'reprovou_financeiro', ?, NULL, NOW())",
      [req.params.id, req.user.id, motivo],
    );
    res.json({ ok: true, autenticacao: codigo });
  } catch (error) {
    res.status(500).json({ error: error.message || "Nao foi possivel reprovar o reembolso no financeiro." });
  }
});

app.post("/api/reembolso/adiantamentos/:id/aprovar", requirePermission("reembolso_aprovar"), async (req, res) => {
  try {
    const [[adiantamento]] = await pool.query("SELECT * FROM rd_reembolso_adiantamentos WHERE id = ?", [req.params.id]);
    if (!adiantamento) return res.status(404).json({ error: "Adiantamento nao encontrado." });
    if (Number(adiantamento.superior_id || 0) !== Number(req.user.id)) {
      return res.status(403).json({ error: "Este adiantamento esta aguardando aprovacao de outro superior." });
    }
    if (!["em_aprovacao", "rascunho", "reprovado"].includes(adiantamento.status)) {
      return res.status(400).json({ error: "Este adiantamento nao pode ser aprovado neste status." });
    }
    await pool.query(
      "UPDATE rd_reembolso_adiantamentos SET status = 'aprovado', aprovado_por = ?, aprovado_em = NOW(), updated_at = NOW() WHERE id = ?",
      [req.user.id, req.params.id],
    );
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message || "Nao foi possivel aprovar o adiantamento de reembolso." });
  }
});

app.post("/api/reembolso/adiantamentos/:id/reprovar", requirePermission("reembolso_aprovar"), async (req, res) => {
  try {
    const [[adiantamento]] = await pool.query("SELECT * FROM rd_reembolso_adiantamentos WHERE id = ?", [req.params.id]);
    if (!adiantamento) return res.status(404).json({ error: "Adiantamento nao encontrado." });
    if (Number(adiantamento.superior_id || 0) !== Number(req.user.id)) {
      return res.status(403).json({ error: "Este adiantamento esta aguardando aprovacao de outro superior." });
    }
    const motivo = String(req.body.motivo || req.body.justificativa || "").trim();
    if (!motivo) return res.status(400).json({ error: "Informe a justificativa da recusa." });
    await pool.query(
      "UPDATE rd_reembolso_adiantamentos SET status = 'reprovado', motivo_reprovacao = ?, updated_at = NOW() WHERE id = ? AND status = 'em_aprovacao'",
      [motivo, req.params.id],
    );
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message || "Nao foi possivel reprovar o adiantamento de reembolso." });
  }
});

app.get("/api/adiantamentos/:id/extrato", async (req, res) => {
  try {
    const [[adiantamento]] = await pool.query(
      `SELECT a.*, p.nome, p.razao_social
       FROM adiantamentos a
       JOIN prestadores p ON p.id = a.prestador_id
       WHERE a.id = ?`,
      [req.params.id],
    );
    if (!adiantamento) return res.status(404).json({ error: "Adiantamento nao encontrado." });

    const [parcelas] = await pool.query(
      `SELECT ap.*, f.competencia AS folha_competencia
       FROM adiantamento_parcelas ap
       LEFT JOIN folhas f ON f.id = ap.folha_id
       WHERE ap.adiantamento_id = ?
       ORDER BY ap.numero_parcela`,
      [req.params.id],
    );
    if (!canSeeSensitiveValues(req.user)) {
      adiantamento.valor_total = null;
      parcelas.forEach((parcela) => {
        parcela.valor = null;
      });
    }
    res.json({ adiantamento, parcelas });
  } catch {
    res.status(500).json({ error: "Nao foi possivel carregar o extrato." });
  }
});

app.get("/api/folhas", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM vw_folhas_resumo");
    const competenciasVirtuais = [currentCompetencia(), ...temporaryOpenCompetencias()];
    for (const competencia of competenciasVirtuais) {
      const exists = rows.some((row) => row.competencia === competencia);
      if (!exists) {
      rows.push((await buildFolhaAberta(competencia, req.user)).folha);
      }
    }
    for (const row of rows) {
      row.temporaryOpen = isTemporaryOpenCompetencia(row.competencia);
      if (row.status === "aberta") {
        const virtual = await buildFolhaAberta(row.competencia, req.user);
        Object.assign(row, virtual.folha, { id: row.id, status: row.status, temporaryOpen: true });
      }
    }
    rows.sort((a, b) => String(b.competencia).localeCompare(String(a.competencia)));
    res.json({ folhas: rows.map((row) => sanitizeFolhaResumo(row, req.user)) });
  } catch {
    res.status(500).json({ error: "Nao foi possivel listar folhas." });
  }
});

app.post("/api/folhas/importar-nfs-pasta", async (req, res) => {
  try {
    const includeClosed = false;
    const result = req.body?.competencia
      ? {
        root: nfFolderRoot(),
        competencias: [req.body.competencia],
        results: [await scanNfFolderForCompetencia(req.body.competencia, { includeClosed })],
      }
      : await scanOpenNfFolders();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || "Nao foi possivel importar as NFs da pasta." });
  }
});

app.post("/api/folhas/importar-nfs-email", async (req, res) => {
  try {
    const result = await importNfEmailAttachments({
      competencia: req.body?.competencia || "",
      includeClosed: false,
      top: req.body?.top || 50,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || "Nao foi possivel importar NFs do e-mail." });
  }
});

app.post("/api/folhas/:competencia/rascunho", async (req, res) => {
  try {
    const competencia = req.params.competencia;
    const [[folha]] = await pool.query("SELECT status FROM folhas WHERE competencia = ?", [competencia]);
    if (folha && ["fechada", "em_aprovacao"].includes(folha.status) && !isTemporaryOpenCompetencia(competencia)) {
      return res.status(423).json({ error: "Folha bloqueada. O rascunho nao pode ser alterado." });
    }
    await pool.query(
      `INSERT INTO folhas (competencia, dias_mes, status)
       VALUES (?, ?, 'aberta')
       ON DUPLICATE KEY UPDATE dias_mes = VALUES(dias_mes)`,
      [competencia, daysInCompetencia(competencia)],
    );
    await saveFolhaDraftRows(competencia, req.body?.itens || [], req.user?.id || null);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message || "Nao foi possivel salvar o rascunho da folha." });
  }
});

app.get("/api/folhas/:competencia", async (req, res) => {
  try {
    const lotes = await getFolhaLotes(req.params.competencia);
    const [[folha]] = await pool.query("SELECT * FROM folhas WHERE competencia = ?", [req.params.competencia]);
    if (!folha) {
      const aberta = await buildFolhaAberta(req.params.competencia, req.user);
      aberta.aprovacoes = await getFolhaApprovalsForItems(req.params.competencia, aberta.itens);
      aberta.lotes = lotes;
      return res.json(aberta);
    }
    folha.temporaryOpen = isTemporaryOpenCompetencia(req.params.competencia);
    if (folha.status === "aberta") {
      const aberta = await buildFolhaAberta(req.params.competencia, req.user);
      const folhaStatus = { ...aberta.folha, ...folha, status: "aberta", temporaryOpen: folha.temporaryOpen };
      return res.json({
        folha: folhaStatus,
        itens: aberta.itens,
        aprovacoes: await getFolhaApprovalsForItems(req.params.competencia, aberta.itens),
        lotes,
      });
    }
    const hideRescindedOpenItems = folha.status === "aberta" || folha.temporaryOpen;
    const activeRescisaoFilter = hideRescindedOpenItems
      ? `AND NOT EXISTS (
          SELECT 1 FROM rescisoes r
          WHERE r.prestador_id = p.id
            AND r.status <> 'reprovada'
            AND r.data_rescisao <= ?
        )`
      : "";
    const itemParams = hideRescindedOpenItems
      ? [folha.id, competenciaEndDate(req.params.competencia)]
      : [folha.id];

    const [itens] = await pool.query(
      `SELECT fi.*, p.nome, p.cpf, p.cnpj, p.razao_social, p.email, p.telefone,
        f.nome AS funcao, d.nome AS departamento, pr.nome AS projeto,
        p.salario_contrato, p.precificacao_tipo, p.valor_dia, p.data_admissao, p.data_rescisao, COALESCE(cli.nome, u.nome) AS unidade_nome,
        (fi.valor_nf_emitida - fi.liquido_pagar) AS diferenca_nf
       FROM folha_itens fi
       JOIN prestadores p ON p.id = fi.prestador_id
       LEFT JOIN unidades u ON u.id = p.unidade_id
       LEFT JOIN clientes cli ON cli.id = p.cliente_id
       LEFT JOIN funcoes f ON f.id = p.funcao_id
       LEFT JOIN departamentos d ON d.id = p.departamento_id
       LEFT JOIN projetos pr ON pr.id = p.projeto_id
       WHERE fi.folha_id = ? ${activeRescisaoFilter} ${contractVisibilityWhere(req.user, "p")}
       ORDER BY p.nome, p.razao_social`,
      itemParams,
    );
    const snapshotItens = itens.map((item) => folhaItemSnapshot(item, folha));
    if (folha.status === "aberta") {
      const sanitizedOpenItems = snapshotItens.map((item) => sanitizeFolhaItem(item, req.user, { folhaStatus: folha.status }));
      const itensComNf = await attachNfsToItems(req.params.competencia, sanitizedOpenItems);
      return res.json({ folha, itens: itensComNf, aprovacoes: await getFolhaApprovalsForItems(req.params.competencia, itensComNf), lotes });
    }
    if (["em_aprovacao", "reprovada"].includes(folha.status) && !snapshotItens.length) {
      const aberta = await buildFolhaAberta(req.params.competencia, req.user);
      const folhaStatus = { ...aberta.folha, ...folha, status: folha.status, temporaryOpen: folha.temporaryOpen };
      const itensComNf = await attachNfsToItems(req.params.competencia, aberta.itens);
      return res.json({ folha: folhaStatus, itens: itensComNf, aprovacoes: await getFolhaApprovalsForItems(req.params.competencia, itensComNf), lotes });
    }

    const adjustedItens = folha.temporaryOpen
      ? snapshotItens.map((item) => {
        const diasTrabalhados = folhaDaysForPrestador(item, req.params.competencia);
        const valorDias = folhaValorDias(item, diasTrabalhados);
        return {
          ...item,
          dias_trabalhados: diasTrabalhados,
          valor_dias: valorDias,
        };
      }).filter((item) => item.dias_trabalhados > 0).map((item) => sanitizeFolhaItem(item, req.user, { folhaStatus: folha.status }))
      : snapshotItens.map((item) => sanitizeFolhaItem(item, req.user, { folhaStatus: folha.status }));
    const itensComNf = await attachNfsToItems(req.params.competencia, adjustedItens);
    res.json({ folha, itens: itensComNf, aprovacoes: await getFolhaApprovalsForItems(req.params.competencia, itensComNf), lotes });
  } catch {
    res.status(500).json({ error: "Nao foi possivel carregar a folha." });
  }
});

app.get("/api/departamentos/comparativo", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT
        f.competencia,
        COALESCE(fi.departamento_snapshot, d.nome, 'Sem departamento') AS departamento,
        COUNT(DISTINCT fi.prestador_id) AS pessoas,
        COALESCE(SUM(fi.liquido_pagar), 0) AS total
       FROM folhas f
       JOIN folha_itens fi ON fi.folha_id = f.id
       JOIN prestadores p ON p.id = fi.prestador_id
       LEFT JOIN departamentos d ON d.id = p.departamento_id
       GROUP BY f.competencia, COALESCE(fi.departamento_snapshot, d.nome, 'Sem departamento')
       ORDER BY f.competencia DESC, departamento ASC`,
    );
    const competenciaAtual = currentCompetencia();
    if (!rows.some((row) => row.competencia === competenciaAtual)) {
      const [abertos] = await pool.query(
        `SELECT
          ? AS competencia,
          COALESCE(d.nome, 'Sem departamento') AS departamento,
          COUNT(*) AS pessoas,
          COALESCE(SUM(p.salario_contrato), 0) AS total
         FROM prestadores p
         LEFT JOIN departamentos d ON d.id = p.departamento_id
         WHERE p.ativo = 1
         GROUP BY COALESCE(d.nome, 'Sem departamento')`,
        [competenciaAtual],
      );
      rows.push(...abertos);
    }

    rows.sort((a, b) => String(a.competencia).localeCompare(String(b.competencia)) || String(a.departamento).localeCompare(String(b.departamento)));
    const previousByDepartment = new Map();
    const enriched = rows.map((row) => {
      const previous = previousByDepartment.get(row.departamento);
      const pessoas = Number(row.pessoas || 0);
      const variacao = previous === undefined ? 0 : pessoas - previous;
      previousByDepartment.set(row.departamento, pessoas);
      return { ...row, pessoas, variacao, total: Number(row.total || 0) };
    }).sort((a, b) => String(b.competencia).localeCompare(String(a.competencia)) || String(a.departamento).localeCompare(String(b.departamento)));

    res.json({
      comparativo: canSeeSensitiveValues(req.user)
        ? enriched
        : enriched.map((row) => ({ ...row, total: null })),
    });
  } catch {
    res.status(500).json({ error: "Nao foi possivel carregar comparativo por departamento." });
  }
});

app.post("/api/folhas/:competencia/notificar-nfs", async (req, res) => {
  try {
    const result = await sendPendingNfEmailReminders(req.params.competencia, { force: true });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || "Nao foi possivel enviar os avisos de NF por e-mail." });
  }
});

app.post("/api/folhas/:competencia/enviar-aprovacao", async (req, res) => {
  try {
    const competencia = req.params.competencia;
    const [[folha]] = await pool.query("SELECT status, approval_payload_hash FROM folhas WHERE competencia = ?", [competencia]);
    if (folha?.status === "fechada" && !isTemporaryOpenCompetencia(competencia)) {
      return res.status(400).json({ error: "Folha fechada nao pode ser reenviada para aprovacao." });
    }
    const itens = req.body.itens || [];
    if (!itens.length) return res.status(400).json({ error: "Nao ha itens na folha para enviar a aprovacao." });
    await saveFolhaDraftRows(competencia, itens, req.user?.id || null);
    const readyItems = itens.filter((item) => folhaItemReadyForPayment(item, req.user));
    const pendentesNf = itens
      .filter((item) => !folhaItemReadyForPayment(item, req.user))
      .map((item) => item.razao_social || item.nome || `Prestador ${item.prestador_id || item.id}`);
    if (!readyItems.length) {
      return res.status(400).json({
        error: "Nenhum prestador apto para criar lote de pagamento. Valide ao menos uma NF para enviar a aprovacao.",
        pendentesNf,
      });
    }
    const approvers = await getMandatoryApprovers(pool, "folha");
    if (!approvers.length) {
      return res.status(400).json({ error: "Nao ha aprovadores obrigatorios cadastrados. Configure usuarios com perfil/permissao de aprovador." });
    }
    const lote = await createFolhaLote(competencia, readyItems, req.user?.id || null);
    const payloadHash = lote.payload_hash;
    await pool.query("DELETE FROM folha_aprovacoes WHERE lote_id = ? AND payload_hash <> ?", [lote.id, payloadHash]);
    const result = await sendApprovalRequestEmails(req, {
      titulo: `Folha PJ ${competencia} pronta para aprovação`,
      detalhe: `A folha PJ da competência ${competencia} já está pronta para análise dos aprovadores.`,
      link: appUrl(req, `/aprovacoes.html?tipo=folha&id=${encodeURIComponent(competencia)}&lote=${encodeURIComponent(lote.id)}`),
      approvers: [approvers[0]],
      tipo: "folha",
    });
    res.json({ ...result, lote, pendentesNf, aprovacoes: await getFolhaApprovals(competencia, payloadHash, pool, lote.id) });
  } catch (error) {
    res.status(500).json({ error: error.message || "Nao foi possivel enviar a folha para aprovacao." });
  }
});

app.post("/api/folhas/:competencia/aprovar", async (req, res) => {
  try {
    const competencia = req.params.competencia;
    const [[folha]] = await pool.query("SELECT status FROM folhas WHERE competencia = ?", [competencia]);
    if (folha?.status === "fechada" && !isTemporaryOpenCompetencia(competencia)) {
      return res.status(400).json({ error: "Folha fechada nao recebe novas aprovacoes." });
    }
    if (folha?.status !== "em_aprovacao") {
      return res.status(400).json({ error: "A folha precisa estar em aprovação." });
    }
    const [[lote]] = await pool.query(
      "SELECT * FROM folha_lotes WHERE competencia = ? AND status = 'em_aprovacao' AND id = COALESCE(?, id) ORDER BY numero DESC LIMIT 1",
      [competencia, req.body.lote_id || null],
    );
    if (!lote) return res.status(400).json({ error: "Nenhum lote em aprovacao para esta competencia." });
    const loteItens = lote.itens_json ? JSON.parse(lote.itens_json) : [];
    const itens = normalizeApprovalItems((req.body.itens || []).length ? req.body.itens : loteItens);
    if (!itens.length) return res.status(400).json({ error: "Nao ha itens para aprovar." });
    const payloadHash = approvalPayloadHash(competencia, itens, lote.id);
    if (lote.payload_hash && lote.payload_hash !== payloadHash) {
      return res.status(400).json({ error: "A prévia da folha mudou. Reenvie para aprovação." });
    }
    const before = await getFolhaApprovals(competencia, payloadHash, pool, lote.id);
    assertSequentialApprover(req.user, before);
    const codigoAutenticacao = approvalAuthCode(competencia, req.user.id, payloadHash, lote.id);
    await pool.query(
      `INSERT INTO folha_aprovacoes (competencia, lote_id, usuario_id, payload_hash, codigo_autenticacao, decisao, aprovado_em, comentario)
       VALUES (?, ?, ?, ?, ?, 'aprovado', NOW(), ?)
       ON DUPLICATE KEY UPDATE payload_hash = VALUES(payload_hash), codigo_autenticacao = VALUES(codigo_autenticacao),
         decisao = 'aprovado', aprovado_em = NOW(), comentario = VALUES(comentario)`,
      [competencia, lote.id, req.user.id, payloadHash, codigoAutenticacao, req.body.comentario || null],
    );
    const aprovacoes = await getFolhaApprovals(competencia, payloadHash, pool, lote.id);
    let fechamentoAutomatico = false;
    let emailProximo = null;
    if (aprovacoes.approved) {
      await autoCloseApprovedFolha(competencia, itens, pool, lote.id);
      fechamentoAutomatico = true;
    } else {
      emailProximo = await sendNextApprovalEmail(req, {
        tipo: "folha",
        titulo: `Folha PJ ${competencia} aguardando aprovação`,
        detalhe: `A folha PJ da competência ${competencia} foi aprovada na etapa anterior e aguarda sua análise.`,
        link: appUrl(req, `/aprovacoes.html?tipo=folha&id=${encodeURIComponent(competencia)}&lote=${encodeURIComponent(lote.id)}`),
        aprovacoes,
      });
    }
    res.json({ ok: true, aprovacoes, fechamentoAutomatico, emailProximo });
  } catch (error) {
    res.status(500).json({ error: error.message || "Nao foi possivel registrar a aprovacao." });
  }
});

app.post("/api/folhas/:competencia/reprovar", async (req, res) => {
  try {
    const competencia = req.params.competencia;
    const motivo = String(req.body.motivo || "").trim();
    if (!motivo) return res.status(400).json({ error: "Informe a justificativa da recusa." });
    const [[folha]] = await pool.query("SELECT status, approval_payload_hash FROM folhas WHERE competencia = ?", [competencia]);
    if (!folha || folha.status !== "em_aprovacao") return res.status(400).json({ error: "A folha não está em aprovação." });
    const [[lote]] = await pool.query(
      "SELECT * FROM folha_lotes WHERE competencia = ? AND status = 'em_aprovacao' AND id = COALESCE(?, id) ORDER BY numero DESC LIMIT 1",
      [competencia, req.body.lote_id || null],
    );
    if (!lote) return res.status(400).json({ error: "Nenhum lote em aprovacao para esta competencia." });
    const loteItens = lote.itens_json ? JSON.parse(lote.itens_json) : [];
    const itens = normalizeApprovalItems((req.body.itens || []).length ? req.body.itens : loteItens);
    const payloadHash = approvalPayloadHash(competencia, itens, lote.id);
    if (lote.payload_hash && lote.payload_hash !== payloadHash) {
      return res.status(400).json({ error: "A prévia da folha mudou. Reenvie para aprovação." });
    }
    const aprovacoes = await getFolhaApprovals(competencia, payloadHash, pool, lote.id);
    assertSequentialApprover(req.user, aprovacoes);
    await pool.query(
      `INSERT INTO folha_aprovacoes (competencia, lote_id, usuario_id, payload_hash, codigo_autenticacao, decisao, aprovado_em, comentario)
       VALUES (?, ?, ?, ?, NULL, 'reprovado', NOW(), ?)
       ON DUPLICATE KEY UPDATE payload_hash = VALUES(payload_hash), codigo_autenticacao = NULL, decisao = 'reprovado',
         aprovado_em = NOW(), comentario = VALUES(comentario)`,
      [competencia, lote.id, req.user.id, payloadHash, motivo],
    );
    await pool.query(
      `UPDATE folha_lotes
       SET status = 'reprovado', rejeitado_por = ?, rejeitado_em = NOW(), rejeicao_motivo = ?
       WHERE id = ?`,
      [req.user.id, motivo, lote.id],
    );
    await pool.query(
      `UPDATE folhas
       SET status = 'aberta', approval_rejeitado_por = ?, approval_rejeitado_em = NOW(), approval_rejeicao_motivo = ?
       WHERE competencia = ?`,
      [req.user.id, motivo, competencia],
    );
    res.json({ ok: true, status: "reprovada", motivo });
  } catch (error) {
    res.status(500).json({ error: error.message || "Nao foi possivel reprovar a folha." });
  }
});

app.post("/api/folhas/:competencia/prestadores/:prestadorId/nf", nfUpload.single("nf"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Envie um arquivo XML ou PDF da NF." });
    const ext = path.extname(req.file.originalname || "").toLowerCase();
    if (![".xml", ".pdf"].includes(ext)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Arquivo invalido. Envie XML ou PDF." });
    }
    const competencia = req.params.competencia;
    const prestadorId = Number(req.params.prestadorId);
    const [[prestador]] = await pool.query("SELECT id, nome, razao_social, cnpj FROM prestadores WHERE id = ?", [prestadorId]);
    if (!prestador) return res.status(404).json({ error: "Prestador nao encontrado." });
    const [[folha]] = await pool.query("SELECT id, status FROM folhas WHERE competencia = ?", [competencia]);
    if (folha?.status === "em_aprovacao") {
      return res.status(423).json({ error: "Folha em aprovação. Nenhuma alteração é permitida." });
    }
    if (folha?.status === "fechada") {
      return res.status(423).json({ error: "Folha fechada. Reabra a folha antes de alterar NFs." });
    }

    const expectedValue = money(req.body.valor_esperado);
    const nfData = ext === ".xml"
      ? parseNfXml(req.file.path)
      : await parseNfPdf(req.file.path);
    const [[folhaItem]] = folha?.id
      ? await pool.query("SELECT id, numero_nf FROM folha_itens WHERE folha_id = ? AND prestador_id = ?", [folha.id, prestadorId])
      : [[null]];
    const nfNumberErrors = await validateNfNumberRules({
      prestador,
      numeroNf: nfData.numero_nf,
      competencia,
      ignoreCurrentCompetencia: Boolean(folhaItem?.id),
      skipSequenceCheck: false,
    });
    if (nfNumberErrors.length) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: nfNumberErrors.join(" ") });
    }
    const divergencias = compareNfData({ nfData, prestador, expectedValue });
    if (ext === ".pdf" && (!nfData.numero_nf || !nfData.valor_nf)) {
      divergencias.push("PDF salvo, mas nao foi possivel localizar todos os dados automaticamente.");
    }
    const status = divergencias.length ? "divergente" : "validada";

    const [result] = await pool.query(
      `INSERT INTO nf_arquivos
       (competencia, prestador_id, folha_id, folha_item_id, original_name, stored_name, mime_type,
        file_size, numero_nf, valor_nf, cnpj_emitente, status, divergencias, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        competencia,
        prestadorId,
        folha?.id || null,
        folhaItem?.id || null,
        req.file.originalname,
        req.file.filename,
        req.file.mimetype,
        req.file.size,
        normalizeNfNumber(nfData.numero_nf) || null,
        nfData.valor_nf || null,
        nfData.cnpj_emitente || null,
        status,
        divergencias.join(" | ") || null,
        req.user.id,
      ],
    );
    if (folhaItem?.id && status === "validada") {
      await pool.query(
        "UPDATE folha_itens SET numero_nf = ?, valor_nf_emitida = ? WHERE id = ?",
        [normalizeNfNumber(nfData.numero_nf) || null, nfData.valor_nf || null, folhaItem.id],
      );
    }

    res.status(201).json({
      nf: {
        id: result.insertId,
        status,
        numero_nf: normalizeNfNumber(nfData.numero_nf) || null,
        valor_nf: nfData.valor_nf || null,
        cnpj_emitente: nfData.cnpj_emitente || null,
        divergencias,
        original_name: req.file.originalname,
      },
    });
  } catch (error) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message || "Nao foi possivel processar a NF." });
  }
});

async function sendNfFile(req, res, disposition = "attachment") {
  try {
    const [[nf]] = await pool.query(
      `SELECT n.*, p.cargo_nivel
       FROM nf_arquivos n
       JOIN prestadores p ON p.id = n.prestador_id
       WHERE n.id = ?`,
      [req.params.id],
    );
    if (!nf) return res.status(404).json({ error: "NF nao encontrada." });
    const filePath = path.join(uploadsDir, nf.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Arquivo da NF nao encontrado." });
    const safeName = path.basename(nf.original_name || nf.stored_name || "nf");
    res.setHeader("Content-Type", nf.mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `${disposition}; filename="${safeName.replace(/"/g, "")}"`);
    return res.sendFile(filePath);
  } catch {
    return res.status(500).json({ error: "Nao foi possivel acessar a NF." });
  }
}

app.get("/api/nfs/:id/view", async (req, res) => {
  await sendNfFile(req, res, "inline");
});

app.get("/api/nfs/:id/download", async (req, res) => {
  await sendNfFile(req, res, "attachment");
});

app.delete("/api/nfs/:id", async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[nf]] = await connection.query(
      `SELECT n.*, COALESCE(f.status, fc.status) AS folha_status, fi.omie_status
       FROM nf_arquivos n
       LEFT JOIN folhas f ON f.id = n.folha_id
       LEFT JOIN folhas fc ON fc.competencia = n.competencia
       LEFT JOIN folha_itens fi ON fi.id = n.folha_item_id
       WHERE n.id = ?
       FOR UPDATE`,
      [req.params.id],
    );
    if (!nf) {
      await connection.rollback();
      return res.status(404).json({ error: "NF nao encontrada." });
    }
    if (nf.folha_status === "fechada" && !isTemporaryOpenCompetencia(nf.competencia)) {
      await connection.rollback();
      return res.status(400).json({ error: "Nao e possivel excluir NF de folha fechada." });
    }
    if (nf.folha_status === "em_aprovacao") {
      await connection.rollback();
      return res.status(423).json({ error: "Folha em aprovação. Nenhuma alteração é permitida." });
    }
    if (nf.omie_status === "integrado") {
      await connection.rollback();
      return res.status(400).json({ error: "Nao e possivel excluir NF ja integrada na Omie." });
    }
    const [[rescisaoUso]] = await connection.query("SELECT id FROM rescisoes WHERE nf_id = ? LIMIT 1", [nf.id]);
    if (rescisaoUso) {
      await connection.rollback();
      return res.status(400).json({ error: "Esta NF esta vinculada a uma rescisao. Exclua pela rescisao." });
    }
    await connection.query("DELETE FROM nf_arquivos WHERE id = ?", [nf.id]);
    await connection.commit();

    const filePath = path.join(uploadsDir, nf.stored_name);
    fs.unlink(filePath, () => {});
    res.json({ ok: true, id: Number(req.params.id) });
  } catch {
    await connection.rollback();
    res.status(500).json({ error: "Nao foi possivel excluir a NF." });
  } finally {
    connection.release();
  }
});

app.post("/api/folhas/:competencia/integrar-omie", async (req, res) => {
  try {
    if (!omieConfigured()) {
      return res.status(400).json({ error: "Configure App Key e App Secret da Omie antes de integrar." });
    }
    const competencia = req.params.competencia;
    const [[folha]] = await pool.query("SELECT * FROM folhas WHERE competencia = ?", [competencia]);
    if (!folha) return res.status(404).json({ error: "Folha nao encontrada." });
    const [[loteFechado]] = await pool.query(
      "SELECT id FROM folha_lotes WHERE competencia = ? AND status = 'fechado' AND id = COALESCE(?, id) LIMIT 1",
      [competencia, req.body?.lote_id || null],
    );
    if (folha.status !== "fechada" && !loteFechado) return res.status(400).json({ error: "Somente lotes fechados podem ser integrados na Omie." });
    const [approvalItems] = await pool.query(
      `SELECT prestador_id, dias_trabalhados, adicoes, bonus, descontos_manual, valor_nf_emitida, numero_nf
       FROM folha_itens
       WHERE folha_id = ? AND (? IS NULL OR lote_id = ?)
       ORDER BY prestador_id`,
      [folha.id, req.body?.lote_id || null, req.body?.lote_id || null],
    );
    const aprovacoes = await getFolhaApprovalsForItems(competencia, approvalItems, pool, req.body?.lote_id || loteFechado?.id || null);
    if (!aprovacoes.approved) {
      return res.status(400).json({ error: "A folha precisa de 3 aprovacoes validas antes de integrar com a Omie.", aprovacoes });
    }

    let [itens] = await pool.query(
      `SELECT fi.id AS folha_item_id, fi.dias_trabalhados, fi.salario_base, fi.valor_dias, fi.adicoes, fi.bonus,
        fi.descontos_manual, fi.desconto_adiantamentos, fi.valor_nf_previsto, fi.valor_nf_emitida,
        fi.numero_nf, fi.liquido_pagar, fi.omie_status,
        p.id AS prestador_id, p.nome, p.razao_social, p.cpf, p.cnpj, p.email, p.telefone,
        p.banco, p.agencia, p.conta,
        p.omie_codigo_cliente, p.omie_codigo_integracao,
        c.nome AS categoria, c.omie_codigo AS categoria_omie_codigo,
        d.nome AS departamento, pr.nome AS projeto
       FROM folha_itens fi
       JOIN prestadores p ON p.id = fi.prestador_id
       LEFT JOIN categorias c ON c.id = p.categoria_id
       LEFT JOIN departamentos d ON d.id = p.departamento_id
       LEFT JOIN projetos pr ON pr.id = p.projeto_id
       WHERE fi.folha_id = ? AND fi.liquido_pagar > 0 AND fi.omie_status <> 'integrado'
         AND (? IS NULL OR fi.lote_id = ?)
       ORDER BY p.nome, p.razao_social`,
      [folha.id, req.body?.lote_id || null, req.body?.lote_id || null],
    );

    itens = itens.map((item) => folhaItemSnapshot(item, folha));

    if (itens.some((item) => !String(item.categoria_omie_codigo || "").trim())) {
      await syncOmieCategorias();
      [itens] = await pool.query(
        `SELECT fi.id AS folha_item_id, fi.dias_trabalhados, fi.salario_base, fi.valor_dias, fi.adicoes, fi.bonus,
          fi.descontos_manual, fi.desconto_adiantamentos, fi.valor_nf_previsto, fi.valor_nf_emitida,
          fi.numero_nf, fi.liquido_pagar, fi.omie_status,
          p.id AS prestador_id, p.nome, p.razao_social, p.cpf, p.cnpj, p.email, p.telefone,
          p.banco, p.agencia, p.conta,
          p.omie_codigo_cliente, p.omie_codigo_integracao,
          c.nome AS categoria, c.omie_codigo AS categoria_omie_codigo,
          d.nome AS departamento, pr.nome AS projeto
         FROM folha_itens fi
         JOIN prestadores p ON p.id = fi.prestador_id
         LEFT JOIN categorias c ON c.id = p.categoria_id
         LEFT JOIN departamentos d ON d.id = p.departamento_id
         LEFT JOIN projetos pr ON pr.id = p.projeto_id
         WHERE fi.folha_id = ? AND fi.liquido_pagar > 0 AND fi.omie_status <> 'integrado'
           AND (? IS NULL OR fi.lote_id = ?)
         ORDER BY p.nome, p.razao_social`,
        [folha.id, req.body?.lote_id || null, req.body?.lote_id || null],
      );
      itens = itens.map((item) => folhaItemSnapshot(item, folha));
    }

    const invalidCategory = itens.filter((item) => !/^\d+(?:\.\d+)*$/.test(String(item.categoria_omie_codigo || "").trim()));
    if (invalidCategory.length) {
      return res.status(400).json({
        error: "Existem prestadores com Categoria sem codigo Omie. A Categoria deve ser o codigo, por exemplo 2.04.01.",
        prestadores: invalidCategory.map((item) => ({
          prestador: item.razao_social || item.nome,
          categoria: item.categoria || "",
          codigo_omie: item.categoria_omie_codigo || "",
        })),
      });
    }

    const vencimento = omieDueDateForCompetencia(competencia);
    const contaCorrenteId = await resolveOmieContaCorrenteId();
    const integrados = [];
    const erros = [];

    let bloqueioOmie = null;
    let erroEstrutural = null;
    for (const item of itens) {
      try {
        const fornecedorCodigo = await ensureOmiePrestador(item, { allowCreate: req.body?.cadastrar_prestadores_omie === true });
        const [codigoProjeto, codigoDepartamento] = await Promise.all([
          resolveOmieProjetoPorNome(item.projeto),
          resolveOmieDepartamentoPorNome(item.departamento),
        ]);
        const payload = omieContaPagarPayload({
          competencia,
          item,
          fornecedorCodigo,
          contaCorrenteId,
          vencimento,
          codigoProjeto,
          codigoDepartamento,
        });
        const result = await omieCall("contaPagar", "UpsertContaPagar", payload);
        const codigoLancamento = Number(result.codigo_lancamento_omie || result.codigo_lancamento || result.codigo || 0) || null;
        const anexos = await enviarAnexosFolhaItemOmie(
          { ...item, omie_codigo_integracao: payload.codigo_lancamento_integracao },
          competencia,
          codigoLancamento,
        );
        await pool.query(
          `UPDATE folha_itens
           SET omie_status = 'integrado', omie_codigo_lancamento = ?, omie_codigo_integracao = ?,
             omie_erro = NULL, omie_integrado_em = NOW()
           WHERE id = ?`,
          [codigoLancamento, payload.codigo_lancamento_integracao, item.folha_item_id],
        );
        integrados.push({
          prestador: item.razao_social || item.nome,
          codigo_lancamento_integracao: payload.codigo_lancamento_integracao,
          codigo_lancamento_omie: codigoLancamento,
          anexos: anexos.length,
        });
      } catch (error) {
        const message = error.message || "Falha ao integrar lancamento.";
        await pool.query(
          `UPDATE folha_itens
           SET omie_status = 'erro', omie_erro = ?, omie_integrado_em = NULL
           WHERE id = ?`,
          [message, item.folha_item_id],
        );
        erros.push({ prestador: item.razao_social || item.nome, error: message });
        if (error.code === "OMIE_PRESTADOR_PENDENTE") {
          return res.status(409).json({
            code: error.code,
            error: "Existe prestador sem cadastro no Omie. Deseja cadastrá-lo como fornecedor PJ?",
            prestadores: [error.prestador],
            integrados,
            erros,
          });
        }
        if (isOmieRateLimitError(error)) {
          bloqueioOmie = { message, retrySeconds: parseOmieRetrySeconds(message) };
          break;
        }
        if (isOmieStructuralError(error)) {
          erroEstrutural = { message };
          break;
        }
      }
    }

    if (erroEstrutural) {
      return res.status(400).json({
        error: "A Omie recusou um campo da integracao. Corrija a configuracao antes de tentar novamente.",
        competencia,
        vencimento,
        contaCorrenteId,
        integrados,
        erros,
        erroEstrutural,
      });
    }

    if (bloqueioOmie) {
      return res.status(429).json({
        error: "A Omie bloqueou temporariamente a API por excesso de chamadas. Aguarde o tempo indicado e tente novamente.",
        competencia,
        vencimento,
        contaCorrenteId,
        integrados,
        erros,
        bloqueioOmie,
      });
    }

    if (erros.length === 0 && integrados.length) {
      await pool.query(
        `UPDATE folha_lotes fl
         SET fl.status = 'integrado_omie', fl.integrado_em = NOW()
         WHERE fl.competencia = ?
           AND fl.status = 'fechado'
           AND NOT EXISTS (
             SELECT 1 FROM folha_itens fi
             WHERE fi.lote_id = fl.id AND fi.omie_status <> 'integrado'
           )`,
        [competencia],
      );
    }

    res.json({ ok: erros.length === 0, competencia, vencimento, contaCorrenteId, integrados, erros });
  } catch (error) {
    res.status(500).json({ error: error.message || "Nao foi possivel integrar a folha na Omie." });
  }
});

app.post("/api/folhas/:competencia/reabrir", async (req, res) => {
  if (!hasPermission(req.user, "reopen_folhas")) return res.status(403).json({ error: "Usuario sem permissao para reabrir folha." });
  const competencia = req.params.competencia;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[folha]] = await connection.query("SELECT * FROM folhas WHERE competencia = ? FOR UPDATE", [competencia]);
    if (!folha) {
      await connection.rollback();
      return res.status(404).json({ error: "Folha nao encontrada." });
    }
    if (folha.status !== "fechada") {
      await connection.rollback();
      return res.status(400).json({ error: "Esta folha ja esta aberta." });
    }
    const [[integrados]] = await connection.query(
      "SELECT COUNT(*) AS total FROM folha_itens WHERE folha_id = ? AND omie_status = 'integrado'",
      [folha.id],
    );
    if (Number(integrados.total || 0) > 0) {
      await connection.rollback();
      return res.status(400).json({ error: "Nao e possivel reabrir folha com lancamentos ja integrados na Omie." });
    }
    await connection.query(
      "UPDATE adiantamento_parcelas SET descontado = 0, folha_id = NULL WHERE folha_id = ?",
      [folha.id],
    );
    await connection.query("UPDATE folhas SET status = 'aberta', fechado_em = NULL WHERE id = ?", [folha.id]);
    await connection.commit();
    res.json({ ok: true, competencia });
  } catch {
    await connection.rollback();
    res.status(500).json({ error: "Nao foi possivel reabrir a folha." });
  } finally {
    connection.release();
  }
});

app.get("/api/rescisoes", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT r.*, p.nome, p.razao_social, p.cpf, p.cnpj, p.cargo_nivel,
        n.original_name AS nf_original_name, n.divergencias AS nf_divergencias
       FROM rescisoes r
       JOIN prestadores p ON p.id = r.prestador_id
       LEFT JOIN nf_arquivos n ON n.id = r.nf_id
       ORDER BY r.data_rescisao DESC, p.razao_social`,
    );
    for (const row of rows) {
      row.aprovacoes = await getRescisaoApprovals(row);
    }
    if (!canSeeSensitiveValues(req.user)) {
      rows.forEach((row) => {
        row.salario_base = null;
        row.valor_proporcional = null;
        row.adiantamentos_abertos = null;
        row.descontos_manual = null;
        row.valor_total_pagar = null;
      });
    }
    res.json({ rescisoes: rows });
  } catch {
    res.status(500).json({ error: "Nao foi possivel listar rescisoes." });
  }
});

app.post("/api/prestadores/:id/rescisao/calcular", async (req, res) => {
  const dataRescisao = req.body.data_rescisao;
  if (!dataRescisao) return res.status(400).json({ error: "Informe a data da rescisao." });
  if (!req.body.data_aviso) return res.status(400).json({ error: "Informe a data do aviso da rescisao." });
  const competenciaRescisao = dateCompetencia(dataRescisao);
  if (competenciaRescisao < currentCompetencia() && !isTemporaryOpenCompetencia(competenciaRescisao)) {
    return res.status(400).json({ error: "Rescisao nao pode ser registrada em periodo anterior ao mes aberto." });
  }

  try {
    const [[folhaFechada]] = await pool.query(
      "SELECT id FROM folhas WHERE competencia = ? AND status = 'fechada'",
      [competenciaRescisao],
    );
    if (folhaFechada && !isTemporaryOpenCompetencia(competenciaRescisao)) {
      return res.status(400).json({ error: "Rescisao nao pode ser registrada em periodo com folha fechada." });
    }
    const [[prestador]] = await pool.query("SELECT * FROM prestadores WHERE id = ?", [req.params.id]);
    if (!prestador) return res.status(404).json({ error: "Prestador nao encontrado." });

    const [[adiantamentos]] = await pool.query(
      `SELECT COALESCE(SUM(valor), 0) AS total
       FROM adiantamento_parcelas ap
       JOIN adiantamentos a ON a.id = ap.adiantamento_id
       WHERE a.prestador_id = ? AND ap.descontado = 0`,
      [req.params.id],
    );
    res.json({
      prestador,
      calculo: calculateRescisao(prestador, dataRescisao, adiantamentos.total, req.body.descontos_manual, {
        data_aviso: req.body.data_aviso,
        tipo_rescisao: req.body.tipo_rescisao,
      }),
    });
  } catch {
    res.status(500).json({ error: "Nao foi possivel calcular a rescisao." });
  }
});

app.post("/api/prestadores/:id/rescisao", async (req, res) => {
  const dataRescisao = req.body.data_rescisao;
  if (!dataRescisao) return res.status(400).json({ error: "Informe a data da rescisao." });
  if (!req.body.data_aviso) return res.status(400).json({ error: "Informe a data do aviso da rescisao." });
  const competenciaRescisao = dateCompetencia(dataRescisao);
  if (competenciaRescisao < currentCompetencia() && !isTemporaryOpenCompetencia(competenciaRescisao)) {
    return res.status(400).json({ error: "Rescisao nao pode ser registrada em periodo anterior ao mes aberto." });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[folhaFechada]] = await connection.query(
      "SELECT id FROM folhas WHERE competencia = ? AND status = 'fechada'",
      [competenciaRescisao],
    );
    if (folhaFechada && !isTemporaryOpenCompetencia(competenciaRescisao)) {
      await connection.rollback();
      return res.status(400).json({ error: "Rescisao nao pode ser registrada em periodo com folha fechada." });
    }
    const [[prestador]] = await connection.query("SELECT * FROM prestadores WHERE id = ? FOR UPDATE", [req.params.id]);
    if (!prestador) {
      await connection.rollback();
      return res.status(404).json({ error: "Prestador nao encontrado." });
    }

    const [[exists]] = await connection.query("SELECT id FROM rescisoes WHERE prestador_id = ?", [req.params.id]);
    if (exists) {
      await connection.rollback();
      return res.status(409).json({ error: "Este prestador ja possui rescisao registrada." });
    }

    const [[adiantamentos]] = await connection.query(
      `SELECT COALESCE(SUM(valor), 0) AS total
       FROM adiantamento_parcelas ap
       JOIN adiantamentos a ON a.id = ap.adiantamento_id
       WHERE a.prestador_id = ? AND ap.descontado = 0`,
      [req.params.id],
    );
    const calculo = calculateRescisao(prestador, dataRescisao, adiantamentos.total, req.body.descontos_manual, {
      data_aviso: req.body.data_aviso,
      tipo_rescisao: req.body.tipo_rescisao,
    });

    const [insertResult] = await connection.query(
      `INSERT INTO rescisoes
       (prestador_id, data_rescisao, data_aviso, tipo_rescisao, aviso_dias, aviso_cumprido,
        multa_percentual, valor_multa, competencia, dias_mes, dias_trabalhados, salario_base,
        valor_proporcional, adiantamentos_abertos, descontos_manual, valor_total_pagar, motivo, status, nf_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'aguardando_nf', 'pendente')`,
      [
        req.params.id,
        dataRescisao,
        calculo.data_aviso,
        calculo.tipo_rescisao,
        calculo.aviso_dias,
        calculo.aviso_cumprido ? 1 : 0,
        calculo.multa_percentual,
        calculo.valor_multa,
        calculo.competencia,
        calculo.dias_mes,
        calculo.dias_trabalhados,
        calculo.salario_base,
        calculo.valor_proporcional,
        calculo.adiantamentos_abertos,
        calculo.descontos_manual,
        calculo.valor_total_pagar,
        req.body.motivo || null,
      ],
    );

    await connection.commit();
    res.status(201).json({ id: insertResult.insertId, calculo });
  } catch {
    await connection.rollback();
    res.status(500).json({ error: "Nao foi possivel registrar a rescisao." });
  } finally {
    connection.release();
  }
});

app.post("/api/rescisoes/:id/notificar-nf", async (req, res) => {
  try {
    res.json(await sendRescisaoNfEmailReminder(req.params.id, { force: true }));
  } catch (error) {
    res.status(500).json({ error: error.message || "Nao foi possivel enviar o aviso da NF." });
  }
});

app.post("/api/rescisoes/:id/enviar-aprovacao", async (req, res) => {
  try {
    const [[rescisao]] = await pool.query(
      `SELECT r.*, p.nome, p.razao_social
       FROM rescisoes r
       JOIN prestadores p ON p.id = r.prestador_id
       WHERE r.id = ?`,
      [req.params.id],
    );
    if (!rescisao) return res.status(404).json({ error: "Rescisao nao encontrada." });
    if (["finalizada", "integrada_omie"].includes(rescisao.status)) {
      return res.status(400).json({ error: "Rescisao finalizada nao pode ser reenviada para aprovacao." });
    }
    if (!nfValidatedOrSimoneException(req.user, rescisao)) {
      return res.status(400).json({ error: "A rescisao so pode ser enviada para aprovacao apos a NF estar validada." });
    }
    const approvers = await getMandatoryApprovers(pool, "rescisao");
    if (!approvers.length) {
      return res.status(400).json({ error: "Nao ha aprovadores obrigatorios cadastrados. Configure usuarios com perfil/permissao de aprovador." });
    }
    const result = await sendApprovalRequestEmails(req, {
      titulo: `Rescisão PJ pronta para aprovação`,
      detalhe: `A rescisão de ${rescisao.razao_social || rescisao.nome}, competência ${rescisao.competencia}, está pronta para análise dos aprovadores.`,
      link: appUrl(req, `/aprovacoes.html?tipo=rescisao&id=${encodeURIComponent(rescisao.id)}`),
      approvers: [approvers[0]],
      tipo: "rescisao",
    });
    const payloadHash = rescisaoApprovalPayloadHash(rescisao);
    await pool.query(
      `UPDATE rescisoes
       SET status = 'em_aprovacao', approval_payload_hash = ?, approval_rejeitado_por = NULL,
         approval_rejeitado_em = NULL, approval_rejeicao_motivo = NULL
       WHERE id = ?`,
      [payloadHash, rescisao.id],
    );
    await pool.query("DELETE FROM rescisao_aprovacoes WHERE rescisao_id = ? AND payload_hash <> ?", [rescisao.id, payloadHash]);
    res.json({ ...result, aprovacoes: await getRescisaoApprovals({ ...rescisao, approval_payload_hash: payloadHash }) });
  } catch (error) {
    res.status(500).json({ error: error.message || "Nao foi possivel enviar a rescisao para aprovacao." });
  }
});

app.post("/api/rescisoes/:id/aprovar", async (req, res) => {
  try {
    const [[rescisao]] = await pool.query("SELECT * FROM rescisoes WHERE id = ?", [req.params.id]);
    if (!rescisao) return res.status(404).json({ error: "Rescisao nao encontrada." });
    if (["finalizada", "integrada_omie"].includes(rescisao.status)) {
      return res.status(400).json({ error: "Rescisao finalizada nao recebe novas aprovacoes." });
    }
    if (rescisao.status !== "em_aprovacao") return res.status(400).json({ error: "A rescisão precisa estar em aprovação." });
    if (!nfValidatedOrSimoneException(req.user, rescisao)) {
      return res.status(400).json({ error: "A NF precisa estar validada antes da aprovacao." });
    }
    const payloadHash = rescisaoApprovalPayloadHash(rescisao);
    if (rescisao.approval_payload_hash && rescisao.approval_payload_hash !== payloadHash) {
      return res.status(400).json({ error: "A rescisão mudou. Reenvie para aprovação." });
    }
    const before = await getRescisaoApprovals(rescisao);
    assertSequentialApprover(req.user, before);
    const codigoAutenticacao = rescisaoApprovalAuthCode(rescisao.id, req.user.id, payloadHash);
    await pool.query(
      `INSERT INTO rescisao_aprovacoes (rescisao_id, usuario_id, payload_hash, codigo_autenticacao, decisao, aprovado_em, comentario)
       VALUES (?, ?, ?, ?, 'aprovado', NOW(), ?)
       ON DUPLICATE KEY UPDATE payload_hash = VALUES(payload_hash), codigo_autenticacao = VALUES(codigo_autenticacao),
         decisao = 'aprovado', aprovado_em = NOW(), comentario = VALUES(comentario)`,
      [rescisao.id, req.user.id, payloadHash, codigoAutenticacao, req.body.comentario || null],
    );
    const aprovacoes = await getRescisaoApprovals(rescisao);
    let finalizada = false;
    let emailProximo = null;
    if (aprovacoes.approved) {
      await pool.query("UPDATE rescisoes SET status = 'finalizada', finalizada_em = NOW() WHERE id = ?", [rescisao.id]);
      await pool.query(
        "UPDATE prestadores SET ativo = 0, data_rescisao = ?, motivo_rescisao = ? WHERE id = ?",
        [rescisao.data_rescisao, rescisao.motivo || null, rescisao.prestador_id],
      );
      finalizada = true;
    } else {
      emailProximo = await sendNextApprovalEmail(req, {
        tipo: "rescisao",
        titulo: "Rescisão PJ aguardando aprovação",
        detalhe: `A rescisão de ${rescisao.razao_social || rescisao.nome || ""} foi aprovada na etapa anterior e aguarda sua análise.`,
        link: appUrl(req, `/aprovacoes.html?tipo=rescisao&id=${encodeURIComponent(rescisao.id)}`),
        aprovacoes,
      });
    }
    res.json({ ok: true, aprovacoes, finalizada, emailProximo });
  } catch (error) {
    res.status(500).json({ error: error.message || "Nao foi possivel registrar a aprovacao da rescisao." });
  }
});

app.post("/api/rescisoes/:id/reprovar", async (req, res) => {
  try {
    const motivo = String(req.body.motivo || "").trim();
    if (!motivo) return res.status(400).json({ error: "Informe a justificativa da recusa." });
    const [[rescisao]] = await pool.query("SELECT * FROM rescisoes WHERE id = ?", [req.params.id]);
    if (!rescisao) return res.status(404).json({ error: "Rescisao nao encontrada." });
    if (rescisao.status !== "em_aprovacao") return res.status(400).json({ error: "A rescisão não está em aprovação." });
    const payloadHash = rescisaoApprovalPayloadHash(rescisao);
    const aprovacoes = await getRescisaoApprovals(rescisao);
    assertSequentialApprover(req.user, aprovacoes);
    await pool.query(
      `INSERT INTO rescisao_aprovacoes (rescisao_id, usuario_id, payload_hash, codigo_autenticacao, decisao, aprovado_em, comentario)
       VALUES (?, ?, ?, NULL, 'reprovado', NOW(), ?)
       ON DUPLICATE KEY UPDATE payload_hash = VALUES(payload_hash), codigo_autenticacao = NULL, decisao = 'reprovado',
         aprovado_em = NOW(), comentario = VALUES(comentario)`,
      [rescisao.id, req.user.id, payloadHash, motivo],
    );
    await pool.query(
      `UPDATE rescisoes
       SET status = 'reprovada', approval_rejeitado_por = ?, approval_rejeitado_em = NOW(), approval_rejeicao_motivo = ?
       WHERE id = ?`,
      [req.user.id, motivo, rescisao.id],
    );
    res.json({ ok: true, status: "reprovada", motivo });
  } catch (error) {
    res.status(500).json({ error: error.message || "Nao foi possivel reprovar a rescisao." });
  }
});

app.post("/api/rescisoes/:id/nf", nfUpload.single("nf"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Envie um arquivo XML ou PDF da NF." });
    const ext = path.extname(req.file.originalname || "").toLowerCase();
    if (![".xml", ".pdf"].includes(ext)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Arquivo invalido. Envie XML ou PDF." });
    }
    const [[rescisao]] = await pool.query(
      `SELECT r.*, p.nome, p.razao_social, p.cnpj
       FROM rescisoes r
       JOIN prestadores p ON p.id = r.prestador_id
       WHERE r.id = ?`,
      [req.params.id],
    );
    if (!rescisao) return res.status(404).json({ error: "Rescisao nao encontrada." });
    if (["finalizada", "integrada_omie"].includes(rescisao.status)) {
      return res.status(400).json({ error: "Rescisao finalizada nao permite nova NF." });
    }
    if (rescisao.status === "em_aprovacao") {
      return res.status(423).json({ error: "Rescisão em aprovação. Nenhuma alteração é permitida." });
    }
    const nfData = ext === ".xml" ? parseNfXml(req.file.path) : await parseNfPdf(req.file.path);
    const nfNumberErrors = await validateNfNumberRules({
      prestador: rescisao,
      numeroNf: nfData.numero_nf,
      competencia: rescisao.competencia,
    });
    if (nfNumberErrors.length) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: nfNumberErrors.join(" ") });
    }
    const divergencias = compareNfData({ nfData, prestador: rescisao, expectedValue: rescisao.valor_total_pagar });
    if (ext === ".pdf" && (!nfData.numero_nf || !nfData.valor_nf)) {
      divergencias.push("PDF salvo, mas nao foi possivel localizar todos os dados automaticamente.");
    }
    const status = divergencias.length ? "divergente" : "validada";
    const [result] = await pool.query(
      `INSERT INTO nf_arquivos
       (competencia, prestador_id, original_name, stored_name, mime_type, file_size,
        numero_nf, valor_nf, cnpj_emitente, status, divergencias, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rescisao.competencia,
        rescisao.prestador_id,
        req.file.originalname,
        req.file.filename,
        req.file.mimetype,
        req.file.size,
        normalizeNfNumber(nfData.numero_nf) || null,
        nfData.valor_nf || null,
        nfData.cnpj_emitente || null,
        status,
        divergencias.join(" | ") || null,
        req.user.id,
      ],
    );
    await pool.query(
      `UPDATE rescisoes
       SET nf_id = ?, nf_status = ?, numero_nf = ?, valor_nf_emitida = ?, diferenca_nf = ?,
         status = CASE WHEN status = 'reprovada' THEN 'aguardando_nf' ELSE status END
       WHERE id = ?`,
      [
        result.insertId,
        status,
        normalizeNfNumber(nfData.numero_nf) || null,
        nfData.valor_nf || null,
        Number((money(nfData.valor_nf) - money(rescisao.valor_total_pagar)).toFixed(2)),
        rescisao.id,
      ],
    );
    res.status(201).json({
      nf: {
        id: result.insertId,
        status,
        numero_nf: normalizeNfNumber(nfData.numero_nf) || null,
        valor_nf: nfData.valor_nf || null,
        cnpj_emitente: nfData.cnpj_emitente || null,
        divergencias,
        original_name: req.file.originalname,
      },
    });
  } catch (error) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message || "Nao foi possivel processar a NF da rescisao." });
  }
});

app.post("/api/rescisoes/:id/finalizar", async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[rescisao]] = await connection.query("SELECT * FROM rescisoes WHERE id = ? FOR UPDATE", [req.params.id]);
    if (!rescisao) {
      await connection.rollback();
      return res.status(404).json({ error: "Rescisao nao encontrada." });
    }
    if (!nfValidatedOrSimoneException(req.user, rescisao)) {
      await connection.rollback();
      return res.status(400).json({ error: "A rescisao so pode ser finalizada apos NF validada." });
    }
    const aprovacoes = await getRescisaoApprovals(rescisao, connection);
    if (!aprovacoes.approved) {
      await connection.rollback();
      return res.status(400).json({ error: "A rescisao precisa de 3 aprovacoes validas antes da finalizacao.", aprovacoes });
    }
    await connection.query("UPDATE rescisoes SET status = 'finalizada', finalizada_em = NOW() WHERE id = ?", [rescisao.id]);
    await connection.query(
      "UPDATE prestadores SET ativo = 0, data_rescisao = ?, motivo_rescisao = ? WHERE id = ?",
      [rescisao.data_rescisao, rescisao.motivo || null, rescisao.prestador_id],
    );
    await connection.commit();
    res.json({ ok: true, aprovacoes });
  } catch {
    await connection.rollback();
    res.status(500).json({ error: "Nao foi possivel finalizar a rescisao." });
  } finally {
    connection.release();
  }
});

app.post("/api/rescisoes/:id/integrar-omie", async (req, res) => {
  try {
    if (!omieConfigured()) {
      return res.status(400).json({ error: "Configure App Key e App Secret da Omie antes de integrar." });
    }
    const [[rescisao]] = await pool.query(
      `SELECT r.*,
        p.id AS prestador_id, p.nome, p.razao_social, p.cpf, p.cnpj, p.email, p.telefone,
        p.banco, p.agencia, p.conta,
        p.omie_codigo_cliente, p.omie_codigo_integracao,
        c.nome AS categoria, c.omie_codigo AS categoria_omie_codigo,
        d.nome AS departamento, pr.nome AS projeto
       FROM rescisoes r
       JOIN prestadores p ON p.id = r.prestador_id
       LEFT JOIN categorias c ON c.id = p.categoria_id
       LEFT JOIN departamentos d ON d.id = p.departamento_id
       LEFT JOIN projetos pr ON pr.id = p.projeto_id
       WHERE r.id = ?`,
      [req.params.id],
    );
    if (!rescisao) return res.status(404).json({ error: "Rescisao nao encontrada." });
    if (rescisao.status !== "finalizada") return res.status(400).json({ error: "Somente rescisoes finalizadas podem ser integradas na Omie." });
    if (!nfValidatedOrSimoneException(req.user, rescisao)) return res.status(400).json({ error: "A NF precisa estar validada antes da integracao." });
    const aprovacoes = await getRescisaoApprovals(rescisao);
    if (!aprovacoes.approved) {
      return res.status(400).json({ error: "A rescisao precisa de 3 aprovacoes validas antes da Omie.", aprovacoes });
    }
    if (rescisao.omie_status === "integrado") return res.json({ integrados: [{ id: rescisao.id }], erros: [] });
    const fornecedorCodigo = await ensureOmiePrestador(rescisao, { allowCreate: req.body?.cadastrar_prestadores_omie === true });
    const categoriaCodigo = await resolveOmieCategoriaCodigo(rescisao);
    const [codigoProjeto, codigoDepartamento] = await Promise.all([
      resolveOmieProjetoPorNome(rescisao.projeto),
      resolveOmieDepartamentoPorNome(rescisao.departamento),
    ]);
    const contaCorrenteId = await resolveOmieContaCorrenteId();
    const payload = omieRescisaoContaPagarPayload({
      rescisao: { ...rescisao, categoria_omie_codigo: categoriaCodigo },
      fornecedorCodigo,
      contaCorrenteId,
      vencimento: omieDueDateForRescisao(rescisao),
      codigoProjeto,
      codigoDepartamento,
    });
    const retorno = await omieCall("contaPagar", "UpsertContaPagar", payload);
    const contaPagarId = retorno.codigo_lancamento_omie || rescisao.omie_codigo_lancamento || null;
    const anexos = [];
    if (contaPagarId) {
      anexos.push(await omieIncluirAnexo({
        nId: contaPagarId,
        cCodIntAnexo: `RES${rescisao.id}REL`,
        cNomeArquivo: `relatorio-rescisao-${rescisao.id}.pdf`,
        content: await buildRescisaoReportPdf(rescisao),
      }));
      const nfAnexo = await enviarAnexoRescisaoOmie(rescisao, contaPagarId);
      if (nfAnexo) anexos.push(nfAnexo);
    }
    await pool.query(
      `UPDATE rescisoes
       SET omie_status = 'integrado', status = 'integrada_omie', omie_codigo_lancamento = ?,
         omie_codigo_integracao = ?, omie_erro = NULL, omie_integrado_em = NOW()
       WHERE id = ?`,
      [contaPagarId, payload.codigo_lancamento_integracao, rescisao.id],
    );
    await pool.query(
      "UPDATE prestadores SET ativo = 0, data_rescisao = ?, motivo_rescisao = ? WHERE id = ?",
      [rescisao.data_rescisao, rescisao.motivo || null, rescisao.prestador_id],
    );
    res.json({ integrados: [{ id: rescisao.id, retorno, anexos }], erros: [] });
  } catch (error) {
    if (error.code === "OMIE_PRESTADOR_PENDENTE") {
      await pool.query(
        "UPDATE rescisoes SET omie_status = 'erro', omie_erro = ? WHERE id = ?",
        [error.message, req.params.id],
      ).catch(() => null);
      return res.status(409).json({
        code: error.code,
        error: "Prestador sem cadastro no Omie. Deseja cadastrá-lo como fornecedor PJ?",
        prestadores: [error.prestador],
      });
    }
    await pool.query(
      "UPDATE rescisoes SET omie_status = 'erro', status = 'erro_omie', omie_erro = ? WHERE id = ?",
      [error.message, req.params.id],
    ).catch(() => null);
    res.status(500).json({ error: error.message || "Nao foi possivel integrar a rescisao na Omie." });
  }
});

app.post("/api/folhas", async (req, res) => {
  const competencia = req.body.competencia;
  let diasMes;
  try {
    diasMes = daysInCompetencia(competencia);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[existing]] = await connection.query("SELECT * FROM folhas WHERE competencia = ?", [competencia]);
    if (existing?.status === "em_aprovacao") {
      await connection.rollback();
      return res.status(423).json({ error: "Folha em aprovação. Nenhuma alteração é permitida." });
    }
    if (existing?.status === "fechada" && !hasPermission(req.user, "reopen_folhas") && !isTemporaryOpenCompetencia(competencia)) {
      await connection.rollback();
      return res.status(403).json({ error: "Folha fechada. Somente administrador pode alterar." });
    }
    const [folhaResult] = await connection.query(
      `INSERT INTO folhas (competencia, dias_mes, status, fechado_em)
       VALUES (?, ?, 'fechada', NOW())
       ON DUPLICATE KEY UPDATE dias_mes = VALUES(dias_mes), status = 'fechada', fechado_em = NOW()`,
      [competencia, diasMes],
    );
    const [[folha]] = await connection.query("SELECT id FROM folhas WHERE competencia = ?", [competencia]);
    await connection.query(
      "UPDATE adiantamento_parcelas SET descontado = 0, folha_id = NULL WHERE folha_id = ?",
      [folha.id],
    );
    await connection.query("DELETE FROM folha_itens WHERE folha_id = ?", [folha.id]);

    const [prestadores] = await connection.query(
      `SELECT p.*, COALESCE(cli.nome, u.nome) AS unidade_nome, fn.nome AS funcao, c.nome AS categoria,
        c.omie_codigo AS categoria_omie_codigo, d.nome AS departamento, pr.nome AS projeto
       FROM prestadores p
       LEFT JOIN unidades u ON u.id = p.unidade_id
       LEFT JOIN clientes cli ON cli.id = p.cliente_id
       LEFT JOIN funcoes fn ON fn.id = p.funcao_id
       LEFT JOIN categorias c ON c.id = p.categoria_id
       LEFT JOIN departamentos d ON d.id = p.departamento_id
       LEFT JOIN projetos pr ON pr.id = p.projeto_id
       WHERE p.ativo = 1
         AND NOT EXISTS (
           SELECT 1 FROM rescisoes r
           WHERE r.prestador_id = p.id
             AND r.status <> 'reprovada'
             AND r.data_rescisao <= ?
         )
       ORDER BY p.nome, p.razao_social`,
      [competenciaEndDate(competencia)],
    );
    const ajustes = new Map((req.body.itens || []).map((item) => [Number(item.prestador_id), item]));
    const approvalItems = prestadores
      .map((prestador) => {
        const ajuste = ajustes.get(Number(prestador.id)) || {};
        const diasTrabalhados = folhaDaysForPrestador(prestador, competencia, ajuste);
        if (diasTrabalhados <= 0) return null;
        return {
          prestador_id: prestador.id,
          dias_trabalhados: diasTrabalhados,
          adicoes: ajuste.adicoes,
          bonus: ajuste.bonus,
          descontos_manual: ajuste.descontos_manual,
          valor_nf_emitida: ajuste.valor_nf_emitida,
          numero_nf: normalizeNfNumber(ajuste.numero_nf),
        };
      })
      .filter(Boolean);
    const aprovacoes = await getFolhaApprovalsForItems(competencia, approvalItems, connection);
    if (!aprovacoes.approved) {
      await connection.rollback();
      return res.status(400).json({
        error: "A folha precisa de 3 aprovacoes validas antes do fechamento.",
        aprovacoes,
      });
    }
    const pendentesNf = prestadores
      .map((prestador) => ({ prestador, ajuste: ajustes.get(Number(prestador.id)) || {} }))
      .filter(({ prestador, ajuste }) => !canUseSimoneException(req.user, prestador.id) && (!required(ajuste.numero_nf) || money(ajuste.valor_nf_emitida) <= 0))
      .map(({ prestador }) => prestador.razao_social || prestador.nome);

    if (pendentesNf.length) {
      await connection.rollback();
      return res.status(400).json({
        error: "A folha so pode ser fechada apos todos os prestadores enviarem suas NFs.",
        pendentesNf,
      });
    }

    const nfBatchByCnpj = new Map();
    const nfNumberErrors = [];
    for (const prestador of prestadores) {
      const ajuste = ajustes.get(Number(prestador.id)) || {};
      const diasTrabalhados = folhaDaysForPrestador(prestador, competencia, ajuste);
      const numeroNormalizado = normalizeNfNumber(ajuste.numero_nf);
      if (diasTrabalhados <= 0 || !numeroNormalizado) continue;
      const cnpj = onlyDigits(prestador.cnpj);
      const batchKey = `${cnpj}:${numeroNormalizado}`;
      const previousInBatch = nfBatchByCnpj.get(batchKey);
      if (previousInBatch) {
        nfNumberErrors.push(`NF ${numeroNormalizado} duplicada para o CNPJ ${prestador.cnpj} na propria folha (${previousInBatch} e ${prestador.razao_social || prestador.nome}).`);
      } else {
        nfBatchByCnpj.set(batchKey, prestador.razao_social || prestador.nome);
      }
      const errors = await validateNfNumberRules({
        prestador,
        numeroNf: numeroNormalizado,
        competencia,
        db: connection,
        ignoreCurrentCompetencia: true,
      });
      nfNumberErrors.push(...errors.map((message) => `${prestador.razao_social || prestador.nome}: ${message}`));
    }
    if (nfNumberErrors.length) {
      await connection.rollback();
      return res.status(400).json({
        error: "Existem NFs invalidas na folha.",
        nfsInvalidas: nfNumberErrors,
      });
    }

    for (const prestador of prestadores) {
      const ajuste = ajustes.get(Number(prestador.id)) || {};
      const diasTrabalhados = folhaDaysForPrestador(prestador, competencia, ajuste);
      if (diasTrabalhados <= 0) continue;
      const salarioBase = folhaBaseValue(prestador);
      const valorDias = folhaValorDias(prestador, diasTrabalhados);
      const adicoes = money(ajuste.adicoes);
      const bonus = money(ajuste.bonus);
      const descontosManual = money(ajuste.descontos_manual);
      const [[adiantamento]] = await connection.query(
        `SELECT COALESCE(SUM(valor), 0) AS total
         FROM adiantamento_parcelas ap
         JOIN adiantamentos a ON a.id = ap.adiantamento_id
         WHERE a.prestador_id = ? AND ap.competencia = ? AND ap.descontado = 0`,
        [prestador.id, competencia],
      );
      const descontoAdiantamentos = money(adiantamento.total);
      const valorNfPrevisto = Number((valorDias + adicoes + bonus).toFixed(2));
      const valorNfEmitida = ajuste.valor_nf_emitida === "" || ajuste.valor_nf_emitida === undefined
        ? 0
        : money(ajuste.valor_nf_emitida);
      const liquido = Number((valorNfPrevisto - descontosManual - descontoAdiantamentos).toFixed(2));

      await connection.query(
        `INSERT INTO folha_itens
         (folha_id, prestador_id, prestador_nome, prestador_razao_social, prestador_cpf, prestador_cnpj,
          prestador_email, prestador_telefone, funcao_snapshot, categoria_snapshot, categoria_omie_codigo_snapshot,
          departamento_snapshot, projeto_snapshot, unidade_nome_snapshot, cargo_nivel_snapshot, precificacao_tipo_snapshot,
          valor_dia_snapshot, data_admissao_snapshot, data_rescisao_snapshot, banco_snapshot, agencia_snapshot,
          conta_snapshot, omie_codigo_cliente_snapshot, omie_codigo_integracao_snapshot,
          dias_trabalhados, salario_base, valor_dias, adicoes, bonus,
          descontos_manual, desconto_adiantamentos, valor_nf_previsto, valor_nf_emitida,
          numero_nf, liquido_pagar, observacao)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          folha.id,
          prestador.id,
          prestador.nome,
          prestador.razao_social,
          prestador.cpf,
          prestador.cnpj,
          prestador.email,
          prestador.telefone,
          prestador.funcao,
          prestador.categoria,
          prestador.categoria_omie_codigo,
          prestador.departamento,
          prestador.projeto,
          prestador.unidade_nome,
          prestador.cargo_nivel,
          prestador.precificacao_tipo,
          prestador.valor_dia,
          prestador.data_admissao,
          prestador.data_rescisao,
          prestador.banco,
          prestador.agencia,
          prestador.conta,
          prestador.omie_codigo_cliente,
          prestador.omie_codigo_integracao,
          diasTrabalhados,
          salarioBase,
          valorDias,
          adicoes,
          bonus,
          descontosManual,
          descontoAdiantamentos,
          valorNfPrevisto,
          valorNfEmitida,
          normalizeNfNumber(ajuste.numero_nf) || null,
          liquido,
          ajuste.observacao || null,
        ],
      );

      await connection.query(
        `UPDATE adiantamento_parcelas ap
         JOIN adiantamentos a ON a.id = ap.adiantamento_id
         SET ap.descontado = 1, ap.folha_id = ?
         WHERE a.prestador_id = ? AND ap.competencia = ? AND ap.descontado = 0`,
        [folha.id, prestador.id, competencia],
      );
    }

    await connection.commit();
    res.status(folhaResult.insertId ? 201 : 200).json({ competencia });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ error: "Nao foi possivel fechar a folha." });
  } finally {
    connection.release();
  }
});

ensureAuthSchema()
  .then(() => {
    app.listen(port, host, () => {
      console.log(`Sistema Redefrete rodando em http://${host}:${port}`);
    });
    setInterval(() => {
      runDailyNfFollowupIfDue().catch((error) => console.error("Falha no agendamento de follow-up NF:", error.message));
    }, 60 * 60 * 1000);
    runDailyNfFollowupIfDue().catch((error) => console.error("Falha no agendamento de follow-up NF:", error.message));
  })
  .catch((error) => {
    console.error("Nao foi possivel preparar o controle de acesso.", error);
    process.exit(1);
  });
