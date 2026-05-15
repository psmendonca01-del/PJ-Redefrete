const express = require("express");
const mysql = require("mysql2/promise");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { XMLParser } = require("fast-xml-parser");
const { PDFParse } = require("pdf-parse");
const { readEnv, writeEnv } = require("./env-store");
require("dotenv").config();

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
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
  },
  aprovador: {
    view_folhas: true,
    approve_folhas: true,
    view_values_open: true,
    view_values_closed: true,
  },
  consulta: {
    view_prestadores: true,
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
  return {
    id: user.id,
    nome: user.nome,
    email: user.email,
    perfil: user.perfil,
    permissoes: permissionsForUser(user),
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

  const [[prestadoresTable]] = await pool.query(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prestadores'",
  );
  if (prestadoresTable) {
    await addColumnIfMissing("prestadores", "cargo_nivel", "cargo_nivel ENUM('gestao', 'operacao') NOT NULL DEFAULT 'operacao' AFTER projeto_id");
    await addColumnIfMissing("prestadores", "omie_codigo_cliente", "omie_codigo_cliente BIGINT NULL AFTER cargo_nivel");
    await addColumnIfMissing("prestadores", "omie_codigo_integracao", "omie_codigo_integracao VARCHAR(60) NULL AFTER omie_codigo_cliente");
  }

  const [[folhaItensTable]] = await pool.query(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'folha_itens'",
  );
  if (folhaItensTable) {
    await addColumnIfMissing("folha_itens", "omie_status", "omie_status ENUM('pendente', 'integrado', 'erro') NOT NULL DEFAULT 'pendente' AFTER observacao");
    await addColumnIfMissing("folha_itens", "omie_codigo_lancamento", "omie_codigo_lancamento BIGINT NULL AFTER omie_status");
    await addColumnIfMissing("folha_itens", "omie_codigo_integracao", "omie_codigo_integracao VARCHAR(60) NULL AFTER omie_codigo_lancamento");
    await addColumnIfMissing("folha_itens", "omie_erro", "omie_erro TEXT NULL AFTER omie_codigo_integracao");
    await addColumnIfMissing("folha_itens", "omie_integrado_em", "omie_integrado_em DATETIME NULL AFTER omie_erro");
  }

  const [[categoriasTable]] = await pool.query(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'categorias'",
  );
  if (categoriasTable) {
    await addColumnIfMissing("categorias", "omie_codigo", "omie_codigo VARCHAR(20) NULL AFTER nome");
  }

  const [[rescisoesTable]] = await pool.query(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rescisoes'",
  );
  if (rescisoesTable) {
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
  await addColumnIfMissing("usuarios", "permissoes_json", "permissoes_json JSON NULL AFTER perfil");
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

async function requireAuth(req, res, next) {
  try {
    const token = parseCookies(req)[sessionCookieName];
    if (!token) return res.status(401).json({ error: "Sessao expirada. Faça login novamente." });
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const [[session]] = await pool.query(
      `SELECT s.id AS sessao_id, u.id, u.nome, u.email, u.perfil, u.permissoes_json, u.ativo
       FROM sessoes s
       JOIN usuarios u ON u.id = s.usuario_id
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
      numero_nf: String(item.numero_nf || "").trim(),
    }))
    .filter((item) => item.prestador_id > 0)
    .sort((a, b) => a.prestador_id - b.prestador_id);
}

function approvalPayloadHash(competencia, items = []) {
  const payload = JSON.stringify({ competencia, itens: normalizeApprovalItems(items) });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function approvalAuthCode(competencia, usuarioId, payloadHash) {
  const seed = `${competencia}:${usuarioId}:${payloadHash}:${process.env.OMIE_APP_KEY || "redefrete"}`;
  const code = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 12).toUpperCase();
  return `APR-${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

function isMandatoryApprover(user) {
  return hasPermission(user, "approve_folhas") && !isFullAccess(user);
}

async function getFolhaApprovals(competencia, payloadHash, db = pool) {
  const [rows] = await db.query(
    `SELECT fa.id, fa.competencia, fa.usuario_id, fa.payload_hash, fa.codigo_autenticacao, fa.aprovado_em, fa.comentario,
      u.nome, u.email, u.perfil
     FROM folha_aprovacoes fa
     JOIN usuarios u ON u.id = fa.usuario_id
     WHERE fa.competencia = ? AND fa.payload_hash = ?
     ORDER BY fa.aprovado_em ASC`,
    [competencia, payloadHash],
  );
  const [activeApprovers] = await db.query(
    "SELECT id, nome, email, perfil, permissoes_json FROM usuarios WHERE ativo = 1 ORDER BY nome",
  );
  const mandatoryApprovers = activeApprovers.filter((user) => isMandatoryApprover(user));
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
    aprovadores: rows.map((row) => ({
      id: row.usuario_id,
      nome: row.nome,
      email: row.email,
      perfil: row.perfil,
      codigo_autenticacao: row.codigo_autenticacao || approvalAuthCode(competencia, row.usuario_id, payloadHash),
      aprovado_em: row.aprovado_em,
      comentario: row.comentario,
    })),
  };
}

async function getFolhaApprovalsForItems(competencia, items, db = pool) {
  return getFolhaApprovals(competencia, approvalPayloadHash(competencia, items), db);
}

function normalizeRescisaoApprovalItem(rescisao) {
  return {
    rescisao_id: Number(rescisao.id || 0),
    prestador_id: Number(rescisao.prestador_id || 0),
    data_rescisao: String(rescisao.data_rescisao || "").slice(0, 10),
    competencia: String(rescisao.competencia || ""),
    dias_trabalhados: Number(rescisao.dias_trabalhados || 0),
    valor_proporcional: money(rescisao.valor_proporcional),
    adiantamentos_abertos: money(rescisao.adiantamentos_abertos),
    descontos_manual: money(rescisao.descontos_manual),
    valor_total_pagar: money(rescisao.valor_total_pagar),
    numero_nf: String(rescisao.numero_nf || "").trim(),
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

async function getRescisaoApprovals(rescisao, db = pool) {
  const payloadHash = rescisaoApprovalPayloadHash(rescisao);
  const [rows] = await db.query(
    `SELECT ra.id, ra.rescisao_id, ra.usuario_id, ra.payload_hash, ra.codigo_autenticacao, ra.aprovado_em, ra.comentario,
      u.nome, u.email, u.perfil
     FROM rescisao_aprovacoes ra
     JOIN usuarios u ON u.id = ra.usuario_id
     WHERE ra.rescisao_id = ? AND ra.payload_hash = ?
     ORDER BY ra.aprovado_em ASC`,
    [rescisao.id, payloadHash],
  );
  const [activeApprovers] = await db.query(
    "SELECT id, nome, email, perfil, permissoes_json FROM usuarios WHERE ativo = 1 ORDER BY nome",
  );
  const mandatoryApprovers = activeApprovers.filter((user) => isMandatoryApprover(user));
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
  const normalized = String(value).replace(/\./g, "").replace(",", ".");
  const number = Number(normalized);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : null;
}

function parseNfXml(filePath) {
  const xml = fs.readFileSync(filePath, "utf8");
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
  const data = parser.parse(xml);
  return {
    numero_nf: findXmlValue(data, ["nNF", "NumeroNfse", "NumeroNFS-e", "Numero"]),
    valor_nf: findXmlMoney(data, ["vNF", "ValorServicos", "ValorLiquidoNfse", "ValorTotalServicos"]),
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
  if (byLine) return onlyDigits(byLine);
  const searchable = normalizeSearchText(text);
  const byLayout = firstRegex(searchable, [
    /serie:\s*e\s*\n\s*(\d{1,12})\s*\n\s*numero da nota fiscal/i,
    /(\d{8,12})\s+\d{2}\/\d{2}\/\d{4}\s+e\s+\d{2}\/\d{4}/i,
  ]);
  if (byLayout) return onlyDigits(byLayout);
  return onlyDigits(firstRegex(text, [
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
  return {
    numero_nf: parsePdfNumero(text, lines),
    valor_nf: parsePdfValor(text, lines),
    cnpj_emitente: parsePdfCnpjEmitente(lines),
  };
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
  return process.env.NF_FOLDER_ROOT || defaultNfFolderRoot;
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

function isNfFile(filePath) {
  return [".xml", ".pdf"].includes(path.extname(filePath || "").toLowerCase());
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

async function prestadorByCnpj(cnpj) {
  const digits = onlyDigits(cnpj);
  if (!digits) return null;
  const [[prestador]] = await pool.query(
    `SELECT id, nome, razao_social, cnpj
     FROM prestadores
     WHERE ativo = 1
       AND REPLACE(REPLACE(REPLACE(cnpj, '.', ''), '/', ''), '-', '') = ?
     LIMIT 1`,
    [digits],
  );
  return prestador || null;
}

async function existingNfUpload({ competencia, prestadorId, numeroNf, originalName, fileSize }) {
  const params = [competencia, prestadorId, originalName, fileSize];
  let numeroClause = "";
  if (numeroNf) {
    numeroClause = " OR numero_nf = ?";
    params.push(numeroNf);
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

async function importNfFromFolderFile({ competencia, filePath, folhaData = null }) {
  const originalName = path.basename(filePath);
  if (!isNfFile(filePath)) return { status: "ignorada", file: originalName, reason: "Arquivo nao suportado." };
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return { status: "ignorada", file: originalName, reason: "Nao e arquivo." };

  const nfData = await parseNfFile(filePath);
  const prestador = await prestadorByCnpj(nfData.cnpj_emitente);
  if (!prestador) {
    return { status: "erro", file: originalName, reason: "CNPJ da NF nao localizado no cadastro.", nfData };
  }

  const folha = folhaData || await buildFolhaAberta(competencia, { perfil: "master" });
  const item = folha.itens.find((row) => Number(row.id) === Number(prestador.id));
  if (!item) {
    return { status: "ignorada", file: originalName, prestador_id: prestador.id, reason: "Prestador nao esta na folha aberta." };
  }

  const duplicate = await existingNfUpload({
    competencia,
    prestadorId: prestador.id,
    numeroNf: nfData.numero_nf || "",
    originalName,
    fileSize: stat.size,
  });
  if (duplicate) {
    return { status: "duplicada", file: originalName, prestador_id: prestador.id, nf_id: duplicate.id };
  }

  const [[folhaRow]] = await pool.query("SELECT id, status FROM folhas WHERE competencia = ?", [competencia]);
  if (folhaRow?.status === "fechada" && !isTemporaryOpenCompetencia(competencia)) {
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
      nfData.numero_nf || null,
      nfData.valor_nf || null,
      nfData.cnpj_emitente || null,
      nfStatus,
      divergencias.join(" | ") || null,
    ],
  );

  return {
    status: nfStatus,
    file: originalName,
    nf_id: result.insertId,
    prestador_id: prestador.id,
    numero_nf: nfData.numero_nf || null,
    valor_nf: nfData.valor_nf || null,
    divergencias,
  };
}

async function scanNfFolderForCompetencia(competencia) {
  const folder = path.join(nfFolderRoot(), competenciaFolderName(competencia));
  if (!fs.existsSync(folder)) return { competencia, folder, exists: false, results: [] };
  const [[folhaRow]] = await pool.query("SELECT status FROM folhas WHERE competencia = ?", [competencia]);
  if (folhaRow?.status === "fechada" && !isTemporaryOpenCompetencia(competencia)) {
    return { competencia, folder, exists: true, skipped: true, reason: "Folha fechada.", results: [] };
  }
  const folhaData = await buildFolhaAberta(competencia, { perfil: "master" });
  const entries = fs.readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(folder, entry.name))
    .filter(isNfFile);
  const results = [];
  for (const filePath of entries) {
    try {
      results.push(await importNfFromFolderFile({ competencia, filePath, folhaData }));
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
      nf_numero: nf.numero_nf,
      nf_valor: nf.valor_nf,
      nf_divergencias: nf.divergencias,
      numero_nf: item.numero_nf || nf.numero_nf,
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

function isAdmin(req) {
  return isFullAccess(req.user);
}

function calculateRescisao(prestador, dataRescisao, adiantamentosAbertos = 0, descontosManual = 0) {
  const competencia = dateCompetencia(dataRescisao);
  const diasMes = daysInCompetencia(competencia);
  const day = Number(String(dataRescisao).slice(8, 10));
  const diasTrabalhados = Math.min(Math.max(day || 1, 1), diasMes);
  const salarioBase = money(prestador.salario_contrato);
  const valorProporcional = Number(((salarioBase / payrollBaseDays()) * diasTrabalhados).toFixed(2));
  const valorTotalPagar = Number((valorProporcional - money(adiantamentosAbertos) - money(descontosManual)).toFixed(2));
  return {
    competencia,
    dias_mes: diasMes,
    dias_trabalhados: diasTrabalhados,
    salario_base: salarioBase,
    valor_proporcional: valorProporcional,
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

async function graphAccessToken() {
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
  if (!roles.includes("Mail.Send")) {
    throw new Error("Microsoft Graph autenticou, mas o aplicativo nao recebeu a permissao Application Mail.Send com consentimento de administrador.");
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

function appUrl(req, pathName = "/") {
  const base = String(process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
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

async function getEmailTemplate(tipo) {
  const [[row]] = await pool.query("SELECT * FROM email_templates WHERE tipo = ?", [tipo]);
  return row || { tipo, ...emailTemplateDefaults[tipo] };
}

async function getMandatoryApprovers(db = pool) {
  const [users] = await db.query(
    "SELECT id, nome, email, perfil, permissoes_json FROM usuarios WHERE ativo = 1 ORDER BY nome",
  );
  return users.filter((user) => isMandatoryApprover(user));
}

async function sendApprovalRequestEmails(req, { titulo, detalhe, link }) {
  if (!emailConfigured()) return { sent: false, reason: "E-mail nao configurado.", enviados: [], falhas: [] };
  const approvers = await getMandatoryApprovers();
  const template = await getEmailTemplate("aprovacao");
  const enviados = [];
  const falhas = [];
  for (const approver of approvers) {
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
        link,
      };
      await sendMailMessage({
        to: email,
        subject: renderTemplateString(template.assunto, vars) || titulo,
        html: plainTemplateToHtml(template.corpo, vars),
      });
      enviados.push({ id: approver.id, nome: approver.nome, email });
    } catch (error) {
      falhas.push({ id: approver.id, nome: approver.nome, email, erro: error.message });
    }
  }
  return { sent: enviados.length > 0, enviados, falhas, total: approvers.length };
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
  const pendentes = data.itens.filter((item) => item.nf_status !== "validada");

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
let lastNfFolderScanRun = "";

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

async function runNfFolderScanIfDue() {
  const now = new Date();
  const hourKey = `${now.toISOString().slice(0, 13)}`;
  if (lastNfFolderScanRun === hourKey) return;
  lastNfFolderScanRun = hourKey;
  await scanOpenNfFolders();
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

function omieHolidaySet() {
  return new Set(String(process.env.OMIE_HOLIDAYS || "").split(",").map((item) => item.trim()).filter(Boolean));
}

function nextBusinessDay(isoDate) {
  const holidays = omieHolidaySet();
  let date = new Date(`${isoDate}T12:00:00`);
  while ([0, 6].includes(date.getDay()) || holidays.has(date.toISOString().slice(0, 10))) {
    date.setDate(date.getDate() + 1);
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
  return addCalendarDays(rescisao.data_rescisao, 10);
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

async function ensureOmiePrestador(prestador) {
  if (prestador.omie_codigo_cliente) return Number(prestador.omie_codigo_cliente);
  const cpfCnpj = prestador.cnpj || prestador.cpf;
  if (!cpfCnpj) throw new Error("Prestador sem CPF/CNPJ para cadastrar na Omie.");
  const existingCode = await findOmieClienteByCpfCnpj(cpfCnpj);
  if (existingCode) {
    await pool.query(
      "UPDATE prestadores SET omie_codigo_cliente = ?, omie_codigo_integracao = COALESCE(omie_codigo_integracao, ?) WHERE id = ?",
      [existingCode, omiePrestadorIntegrationCode(prestador), prestador.id],
    );
    return existingCode;
  }
  const phone = splitPhone(prestador.telefone);
  const payload = {
    cnpj_cpf: cpfCnpj,
    razao_social: String(prestador.razao_social || prestador.nome).slice(0, 60),
    nome_fantasia: String(prestador.nome || prestador.razao_social).slice(0, 100),
    email: prestador.email || "",
    telefone1_ddd: phone.ddd,
    telefone1_numero: phone.numero,
    tags: [{ tag: "Fornecedor" }, { tag: "Redefrete PJ" }],
  };
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

function omieLancamentoIntegracaoCode(competencia, item) {
  return `RDF-FOLHA-${competencia}-${item.folha_item_id}`;
}

function omieRescisaoIntegracaoCode(rescisao) {
  return `RDF-RESCISAO-${rescisao.competencia}-${rescisao.id}`;
}

function omieContaPagarPayload({ competencia, item, fornecedorCodigo, contaCorrenteId, vencimento }) {
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
  return payload;
}

function omieRescisaoContaPagarPayload({ rescisao, fornecedorCodigo, contaCorrenteId, vencimento }) {
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
    numero_documento_fiscal: String(rescisao.numero_nf || "").slice(0, 20),
    observacao: [`Rescisao PJ competencia ${rescisao.competencia} - ${rescisao.razao_social || rescisao.nome}`, extras].filter(Boolean).join(" | "),
  };
  if (contaCorrenteId) payload.id_conta_corrente = contaCorrenteId;
  return payload;
}

function validatePrestador(body) {
  const errors = [];
  if (!required(body.nome)) errors.push("Nome e obrigatorio.");
  if (!validateCpf(body.cpf)) errors.push("CPF invalido.");
  if (!validateCnpj(body.cnpj)) errors.push("CNPJ invalido.");
  if (!required(body.razao_social)) errors.push("Razao social e obrigatoria.");
  if (!["gestao", "operacao"].includes(body.cargo_nivel)) errors.push("Nivel do cargo invalido.");
  if (money(body.salario_contrato) <= 0) errors.push("Salario deve ser maior que zero.");
  return errors;
}

function validateUsuario(body, isUpdate = false) {
  const errors = [];
  if (!required(body.nome)) errors.push("Nome e obrigatorio.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email || ""))) errors.push("E-mail invalido.");
  if (!perfis.includes(body.perfil)) errors.push("Perfil invalido.");
  if (!isUpdate && String(body.senha || "").length < 8) errors.push("Senha deve ter pelo menos 8 caracteres.");
  if (isUpdate && body.senha && String(body.senha).length < 8) errors.push("Senha deve ter pelo menos 8 caracteres.");
  return errors;
}

async function getPrestadores(user) {
  const [rows] = await pool.query(
    `SELECT p.*, u.nome AS unidade_nome, f.nome AS funcao, c.nome AS categoria,
      d.nome AS departamento, pr.nome AS projeto
     FROM prestadores p
     LEFT JOIN unidades u ON u.id = p.unidade_id
     LEFT JOIN funcoes f ON f.id = p.funcao_id
     LEFT JOIN categorias c ON c.id = p.categoria_id
     LEFT JOIN departamentos d ON d.id = p.departamento_id
     LEFT JOIN projetos pr ON pr.id = p.projeto_id
     WHERE 1 = 1 ${contractVisibilityWhere(user, "p")}
     ORDER BY p.ativo DESC, p.razao_social ASC, p.nome ASC`,
  );
  return rows.map((row) => sanitizePrestador(row, user));
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
  const [prestadores] = await pool.query(
    `SELECT p.*, u.nome AS unidade_nome, f.nome AS funcao, c.nome AS categoria,
      d.nome AS departamento, pr.nome AS projeto
     FROM prestadores p
     LEFT JOIN unidades u ON u.id = p.unidade_id
     LEFT JOIN funcoes f ON f.id = p.funcao_id
     LEFT JOIN categorias c ON c.id = p.categoria_id
     LEFT JOIN departamentos d ON d.id = p.departamento_id
     LEFT JOIN projetos pr ON pr.id = p.projeto_id
     WHERE p.ativo = 1 ${contractVisibilityWhere(user, "p")}
     ORDER BY p.razao_social, p.nome`,
  );
  const adiantamentos = await getAdiantamentosCompetencia(pool, competencia);
  let itens = prestadores.map((prestador) => {
    const diasTrabalhados = workedDaysForCompetencia(prestador, competencia);
    const salarioBase = money(prestador.salario_contrato);
    const valorDias = Number(((salarioBase / payrollBaseDays()) * diasTrabalhados).toFixed(2));
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
  const email = String(req.body.email || "").trim().toLowerCase();
  const senha = String(req.body.senha || "");
  if (!email || !senha) return res.status(400).json({ error: "Informe e-mail e senha." });

  try {
    const [[usuario]] = await pool.query("SELECT * FROM usuarios WHERE email = ? AND ativo = 1", [email]);
    if (!usuario || !verifyPassword(senha, usuario.senha_hash)) {
      return res.status(401).json({ error: "E-mail ou senha invalidos." });
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
  if (req.path === "/health" || req.path === "/auth/login") return next();
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

app.get("/api/auth/users", requirePermission("manage_users"), async (_req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, nome, email, perfil, permissoes_json, ativo, ultimo_login, criado_em FROM usuarios ORDER BY ativo DESC, nome ASC",
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
    const [result] = await pool.query(
      "INSERT INTO usuarios (nome, email, senha_hash, perfil, permissoes_json, ativo) VALUES (?, ?, ?, ?, ?, ?)",
      [
        String(req.body.nome).trim(),
        String(req.body.email).trim().toLowerCase(),
        hashPassword(req.body.senha),
        req.body.perfil,
        JSON.stringify(permissoes),
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
    const fields = ["nome = ?", "email = ?", "perfil = ?", "permissoes_json = ?", "ativo = ?"];
    const values = [
      String(req.body.nome).trim(),
      String(req.body.email).trim().toLowerCase(),
      req.body.perfil,
      JSON.stringify(permissoes),
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
    const [unidades, funcoes, categorias, departamentos, projetos] = await Promise.all([
      pool.query("SELECT * FROM unidades WHERE ativo = 1 ORDER BY nome").then(([rows]) => rows),
      pool.query("SELECT * FROM funcoes WHERE ativo = 1 ORDER BY nome").then(([rows]) => rows),
      pool.query("SELECT * FROM categorias WHERE ativo = 1 ORDER BY nome").then(([rows]) => rows),
      pool.query("SELECT * FROM departamentos WHERE ativo = 1 ORDER BY nome").then(([rows]) => rows),
      pool.query("SELECT * FROM projetos WHERE ativo = 1 ORDER BY nome").then(([rows]) => rows),
    ]);
    res.json({ unidades, funcoes, categorias, departamentos, projetos });
  } catch {
    res.status(500).json({ error: "Nao foi possivel listar cadastros auxiliares." });
  }
});

const cadastroTables = {
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

app.post("/api/prestadores", async (req, res) => {
  const errors = validatePrestador(req.body);
  if (errors.length) return res.status(400).json({ errors });

  try {
    const [result] = await pool.query(
      `INSERT INTO prestadores
       (unidade_id, funcao_id, categoria_id, departamento_id, projeto_id, cargo_nivel, nome, cpf, cnpj, razao_social,
        email, telefone, data_admissao,
        salario_contrato, banco, agencia, conta, pix_cpf_cnpj, ativo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.body.unidade_id || null,
        req.body.funcao_id || null,
        req.body.categoria_id || null,
        req.body.departamento_id || null,
        req.body.projeto_id || null,
        req.body.cargo_nivel || "operacao",
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
  const errors = validatePrestador(req.body);
  if (errors.length) return res.status(400).json({ errors });

  try {
    await pool.query(
      `UPDATE prestadores SET
       unidade_id = ?, funcao_id = ?, categoria_id = ?, departamento_id = ?, projeto_id = ?, cargo_nivel = ?,
       nome = ?, cpf = ?, cnpj = ?, razao_social = ?, email = ?, telefone = ?,
       data_admissao = ?, data_rescisao = ?, salario_contrato = ?, banco = ?, agencia = ?, conta = ?,
       pix_cpf_cnpj = ?, ativo = ?
       WHERE id = ?`,
      [
        req.body.unidade_id || null,
        req.body.funcao_id || null,
        req.body.categoria_id || null,
        req.body.departamento_id || null,
        req.body.projeto_id || null,
        req.body.cargo_nivel || "operacao",
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

app.delete("/api/adiantamentos/:id", async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[adiantamento]] = await connection.query("SELECT id FROM adiantamentos WHERE id = ? FOR UPDATE", [req.params.id]);
    if (!adiantamento) {
      await connection.rollback();
      return res.status(404).json({ error: "Adiantamento nao encontrado." });
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
      if (row.temporaryOpen && row.status === "aberta") {
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
    const result = req.body?.competencia
      ? { root: nfFolderRoot(), competencias: [req.body.competencia], results: [await scanNfFolderForCompetencia(req.body.competencia)] }
      : await scanOpenNfFolders();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || "Nao foi possivel importar as NFs da pasta." });
  }
});

app.get("/api/folhas/:competencia", async (req, res) => {
  try {
    const [[folha]] = await pool.query("SELECT * FROM folhas WHERE competencia = ?", [req.params.competencia]);
    if (!folha) {
      const aberta = await buildFolhaAberta(req.params.competencia, req.user);
      aberta.aprovacoes = await getFolhaApprovalsForItems(req.params.competencia, aberta.itens);
      return res.json(aberta);
    }
    folha.temporaryOpen = isTemporaryOpenCompetencia(req.params.competencia);

    const [itens] = await pool.query(
      `SELECT fi.*, p.nome, p.cpf, p.cnpj, p.razao_social, p.email, p.telefone,
        f.nome AS funcao, d.nome AS departamento, pr.nome AS projeto,
        p.salario_contrato, p.data_admissao, p.data_rescisao, u.nome AS unidade_nome,
        (fi.valor_nf_emitida - fi.liquido_pagar) AS diferenca_nf
       FROM folha_itens fi
       JOIN prestadores p ON p.id = fi.prestador_id
       LEFT JOIN unidades u ON u.id = p.unidade_id
       LEFT JOIN funcoes f ON f.id = p.funcao_id
       LEFT JOIN departamentos d ON d.id = p.departamento_id
       LEFT JOIN projetos pr ON pr.id = p.projeto_id
       WHERE fi.folha_id = ? ${contractVisibilityWhere(req.user, "p")}
       ORDER BY p.razao_social, p.nome`,
      [folha.id],
    );
    if (folha.status === "aberta") {
      const sanitizedOpenItems = itens.map((item) => sanitizeFolhaItem(item, req.user, { folhaStatus: folha.status }));
      const itensComNf = await attachNfsToItems(req.params.competencia, sanitizedOpenItems);
      return res.json({ folha, itens: itensComNf, aprovacoes: await getFolhaApprovalsForItems(req.params.competencia, itensComNf) });
    }

    const adjustedItens = folha.temporaryOpen
      ? itens.map((item) => {
        const diasTrabalhados = workedDaysForCompetencia(item, req.params.competencia);
        const salarioBase = money(item.salario_contrato || item.salario_base);
        const valorDias = Number(((salarioBase / payrollBaseDays()) * diasTrabalhados).toFixed(2));
        return {
          ...item,
          dias_trabalhados: diasTrabalhados,
          valor_dias: valorDias,
        };
      }).filter((item) => item.dias_trabalhados > 0).map((item) => sanitizeFolhaItem(item, req.user, { folhaStatus: folha.status }))
      : itens.map((item) => sanitizeFolhaItem(item, req.user, { folhaStatus: folha.status }));
    const itensComNf = await attachNfsToItems(req.params.competencia, adjustedItens);
    res.json({ folha, itens: itensComNf, aprovacoes: await getFolhaApprovalsForItems(req.params.competencia, itensComNf) });
  } catch {
    res.status(500).json({ error: "Nao foi possivel carregar a folha." });
  }
});

app.get("/api/departamentos/comparativo", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT
        f.competencia,
        COALESCE(d.nome, 'Sem departamento') AS departamento,
        COUNT(DISTINCT fi.prestador_id) AS pessoas,
        COALESCE(SUM(fi.liquido_pagar), 0) AS total
       FROM folhas f
       JOIN folha_itens fi ON fi.folha_id = f.id
       JOIN prestadores p ON p.id = fi.prestador_id
       LEFT JOIN departamentos d ON d.id = p.departamento_id
       GROUP BY f.competencia, COALESCE(d.nome, 'Sem departamento')
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
    const [[folha]] = await pool.query("SELECT status FROM folhas WHERE competencia = ?", [competencia]);
    if (folha?.status === "fechada" && !isTemporaryOpenCompetencia(competencia)) {
      return res.status(400).json({ error: "Folha fechada nao pode ser reenviada para aprovacao." });
    }
    const itens = req.body.itens || [];
    if (!itens.length) return res.status(400).json({ error: "Nao ha itens na folha para enviar a aprovacao." });
    const pendentesNf = itens
      .filter((item) => item.nf_status !== "validada")
      .map((item) => item.razao_social || item.nome || `Prestador ${item.prestador_id || item.id}`);
    if (pendentesNf.length) {
      return res.status(400).json({
        error: "A folha so pode ser enviada para aprovacao apos todas as NFs estarem validadas.",
        pendentesNf,
      });
    }
    const approvers = await getMandatoryApprovers();
    if (!approvers.length) {
      return res.status(400).json({ error: "Nao ha aprovadores obrigatorios cadastrados. Configure usuarios com perfil/permissao de aprovador." });
    }
    const result = await sendApprovalRequestEmails(req, {
      titulo: `Folha PJ ${competencia} pronta para aprovação`,
      detalhe: `A folha PJ da competência ${competencia} já está pronta para análise dos aprovadores.`,
      link: appUrl(req, `/?view=folha&competencia=${encodeURIComponent(competencia)}`),
    });
    res.json(result);
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
    const itens = normalizeApprovalItems(req.body.itens || []);
    if (!itens.length) return res.status(400).json({ error: "Nao ha itens para aprovar." });
    const payloadHash = approvalPayloadHash(competencia, itens);
    const codigoAutenticacao = approvalAuthCode(competencia, req.user.id, payloadHash);
    await pool.query(
      `INSERT INTO folha_aprovacoes (competencia, usuario_id, payload_hash, codigo_autenticacao, aprovado_em, comentario)
       VALUES (?, ?, ?, ?, NOW(), ?)
       ON DUPLICATE KEY UPDATE payload_hash = VALUES(payload_hash), codigo_autenticacao = VALUES(codigo_autenticacao),
         aprovado_em = NOW(), comentario = VALUES(comentario)`,
      [competencia, req.user.id, payloadHash, codigoAutenticacao, req.body.comentario || null],
    );
    res.json({ ok: true, aprovacoes: await getFolhaApprovals(competencia, payloadHash) });
  } catch {
    res.status(500).json({ error: "Nao foi possivel registrar a aprovacao." });
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
    if (folha?.status === "fechada" && !hasPermission(req.user, "reopen_folhas")) {
      return res.status(403).json({ error: "Folha fechada. Somente administrador pode anexar nova NF." });
    }

    const expectedValue = money(req.body.valor_esperado);
    const nfData = ext === ".xml"
      ? parseNfXml(req.file.path)
      : await parseNfPdf(req.file.path);
    const divergencias = compareNfData({ nfData, prestador, expectedValue });
    if (ext === ".pdf" && (!nfData.numero_nf || !nfData.valor_nf)) {
      divergencias.push("PDF salvo, mas nao foi possivel localizar todos os dados automaticamente.");
    }
    const status = divergencias.length ? "divergente" : "validada";

    const [[folhaItem]] = folha?.id
      ? await pool.query("SELECT id FROM folha_itens WHERE folha_id = ? AND prestador_id = ?", [folha.id, prestadorId])
      : [[null]];
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
        nfData.numero_nf || null,
        nfData.valor_nf || null,
        nfData.cnpj_emitente || null,
        status,
        divergencias.join(" | ") || null,
        req.user.id,
      ],
    );

    res.status(201).json({
      nf: {
        id: result.insertId,
        status,
        numero_nf: nfData.numero_nf || null,
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

app.get("/api/nfs/:id/download", async (req, res) => {
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
    res.download(filePath, nf.original_name);
  } catch {
    res.status(500).json({ error: "Nao foi possivel baixar a NF." });
  }
});

app.delete("/api/nfs/:id", async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[nf]] = await connection.query(
      `SELECT n.*, f.status AS folha_status, fi.omie_status
       FROM nf_arquivos n
       LEFT JOIN folhas f ON f.id = n.folha_id
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
    if (folha.status !== "fechada") return res.status(400).json({ error: "Somente folhas fechadas podem ser integradas na Omie." });
    const [approvalItems] = await pool.query(
      `SELECT prestador_id, dias_trabalhados, adicoes, bonus, descontos_manual, valor_nf_emitida, numero_nf
       FROM folha_itens
       WHERE folha_id = ?
       ORDER BY prestador_id`,
      [folha.id],
    );
    const aprovacoes = await getFolhaApprovalsForItems(competencia, approvalItems);
    if (!aprovacoes.approved) {
      return res.status(400).json({ error: "A folha precisa de 3 aprovacoes validas antes de integrar com a Omie.", aprovacoes });
    }

    let [itens] = await pool.query(
      `SELECT fi.id AS folha_item_id, fi.numero_nf, fi.liquido_pagar, fi.omie_status,
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
       WHERE fi.folha_id = ? AND fi.liquido_pagar > 0
       ORDER BY p.razao_social, p.nome`,
      [folha.id],
    );

    if (itens.some((item) => !String(item.categoria_omie_codigo || "").trim())) {
      await syncOmieCategorias();
      [itens] = await pool.query(
        `SELECT fi.id AS folha_item_id, fi.numero_nf, fi.liquido_pagar, fi.omie_status,
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
         WHERE fi.folha_id = ? AND fi.liquido_pagar > 0
         ORDER BY p.razao_social, p.nome`,
        [folha.id],
      );
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
        const fornecedorCodigo = await ensureOmiePrestador(item);
        const payload = omieContaPagarPayload({ competencia, item, fornecedorCodigo, contaCorrenteId, vencimento });
        const result = await omieCall("contaPagar", "UpsertContaPagar", payload);
        const codigoLancamento = Number(result.codigo_lancamento_omie || result.codigo_lancamento || result.codigo || 0) || null;
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
      calculo: calculateRescisao(prestador, dataRescisao, adiantamentos.total, req.body.descontos_manual),
    });
  } catch {
    res.status(500).json({ error: "Nao foi possivel calcular a rescisao." });
  }
});

app.post("/api/prestadores/:id/rescisao", async (req, res) => {
  const dataRescisao = req.body.data_rescisao;
  if (!dataRescisao) return res.status(400).json({ error: "Informe a data da rescisao." });
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
    const calculo = calculateRescisao(prestador, dataRescisao, adiantamentos.total, req.body.descontos_manual);

    const [insertResult] = await connection.query(
      `INSERT INTO rescisoes
       (prestador_id, data_rescisao, competencia, dias_mes, dias_trabalhados, salario_base,
        valor_proporcional, adiantamentos_abertos, descontos_manual, valor_total_pagar, motivo, status, nf_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'aguardando_nf', 'pendente')`,
      [
        req.params.id,
        dataRescisao,
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
    const followup = await sendRescisaoNfEmailReminder(insertResult.insertId, { force: true }).catch((error) => ({ sent: false, reason: error.message }));
    res.status(201).json({ id: insertResult.insertId, calculo, followup });
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
    if (rescisao.nf_status !== "validada") {
      return res.status(400).json({ error: "A rescisao so pode ser enviada para aprovacao apos a NF estar validada." });
    }
    const approvers = await getMandatoryApprovers();
    if (!approvers.length) {
      return res.status(400).json({ error: "Nao ha aprovadores obrigatorios cadastrados. Configure usuarios com perfil/permissao de aprovador." });
    }
    const result = await sendApprovalRequestEmails(req, {
      titulo: `Rescisão PJ pronta para aprovação`,
      detalhe: `A rescisão de ${rescisao.razao_social || rescisao.nome}, competência ${rescisao.competencia}, está pronta para análise dos aprovadores.`,
      link: appUrl(req, `/?view=rescisoes&rescisao=${encodeURIComponent(rescisao.id)}`),
    });
    await pool.query("UPDATE rescisoes SET status = 'em_aprovacao' WHERE id = ?", [rescisao.id]);
    res.json(result);
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
    if (rescisao.nf_status !== "validada") {
      return res.status(400).json({ error: "A NF precisa estar validada antes da aprovacao." });
    }
    const payloadHash = rescisaoApprovalPayloadHash(rescisao);
    const codigoAutenticacao = rescisaoApprovalAuthCode(rescisao.id, req.user.id, payloadHash);
    await pool.query(
      `INSERT INTO rescisao_aprovacoes (rescisao_id, usuario_id, payload_hash, codigo_autenticacao, aprovado_em, comentario)
       VALUES (?, ?, ?, ?, NOW(), ?)
       ON DUPLICATE KEY UPDATE payload_hash = VALUES(payload_hash), codigo_autenticacao = VALUES(codigo_autenticacao),
         aprovado_em = NOW(), comentario = VALUES(comentario)`,
      [rescisao.id, req.user.id, payloadHash, codigoAutenticacao, req.body.comentario || null],
    );
    const aprovacoes = await getRescisaoApprovals(rescisao);
    if (aprovacoes.approved && rescisao.status === "aguardando_nf") {
      await pool.query("UPDATE rescisoes SET status = 'em_aprovacao' WHERE id = ?", [rescisao.id]);
    }
    res.json({ ok: true, aprovacoes });
  } catch {
    res.status(500).json({ error: "Nao foi possivel registrar a aprovacao da rescisao." });
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
    const nfData = ext === ".xml" ? parseNfXml(req.file.path) : await parseNfPdf(req.file.path);
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
        nfData.numero_nf || null,
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
         status = CASE WHEN ? = 'validada' THEN 'em_aprovacao' ELSE status END
       WHERE id = ?`,
      [
        result.insertId,
        status,
        nfData.numero_nf || null,
        nfData.valor_nf || null,
        Number((money(nfData.valor_nf) - money(rescisao.valor_total_pagar)).toFixed(2)),
        status,
        rescisao.id,
      ],
    );
    res.status(201).json({
      nf: {
        id: result.insertId,
        status,
        numero_nf: nfData.numero_nf || null,
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
    if (rescisao.nf_status !== "validada") {
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
    if (rescisao.nf_status !== "validada") return res.status(400).json({ error: "A NF precisa estar validada antes da integracao." });
    const aprovacoes = await getRescisaoApprovals(rescisao);
    if (!aprovacoes.approved) {
      return res.status(400).json({ error: "A rescisao precisa de 3 aprovacoes validas antes da Omie.", aprovacoes });
    }
    if (rescisao.omie_status === "integrado") return res.json({ integrados: [{ id: rescisao.id }], erros: [] });
    const fornecedorCodigo = await ensureOmiePrestador(rescisao);
    const categoriaCodigo = await resolveOmieCategoriaCodigo(rescisao);
    const contaCorrenteId = await resolveOmieContaCorrenteId();
    const payload = omieRescisaoContaPagarPayload({
      rescisao: { ...rescisao, categoria_omie_codigo: categoriaCodigo },
      fornecedorCodigo,
      contaCorrenteId,
      vencimento: omieDueDateForRescisao(rescisao),
    });
    const retorno = await omieCall("contaPagar", "UpsertContaPagar", payload);
    await pool.query(
      `UPDATE rescisoes
       SET omie_status = 'integrado', status = 'integrada_omie', omie_codigo_lancamento = ?,
         omie_codigo_integracao = ?, omie_erro = NULL, omie_integrado_em = NOW()
       WHERE id = ?`,
      [retorno.codigo_lancamento_omie || null, payload.codigo_lancamento_integracao, rescisao.id],
    );
    res.json({ integrados: [{ id: rescisao.id, retorno }], erros: [] });
  } catch (error) {
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

    const [prestadores] = await connection.query("SELECT * FROM prestadores WHERE ativo = 1 ORDER BY razao_social, nome");
    const ajustes = new Map((req.body.itens || []).map((item) => [Number(item.prestador_id), item]));
    const approvalItems = prestadores
      .map((prestador) => {
        const ajuste = ajustes.get(Number(prestador.id)) || {};
        const diasTrabalhados = workedDaysForCompetencia(prestador, competencia);
        if (diasTrabalhados <= 0) return null;
        return {
          prestador_id: prestador.id,
          dias_trabalhados: diasTrabalhados,
          adicoes: ajuste.adicoes,
          bonus: ajuste.bonus,
          descontos_manual: ajuste.descontos_manual,
          valor_nf_emitida: ajuste.valor_nf_emitida,
          numero_nf: ajuste.numero_nf,
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
      .filter(({ ajuste }) => !required(ajuste.numero_nf) || money(ajuste.valor_nf_emitida) <= 0)
      .map(({ prestador }) => prestador.razao_social || prestador.nome);

    if (pendentesNf.length) {
      await connection.rollback();
      return res.status(400).json({
        error: "A folha so pode ser fechada apos todos os prestadores enviarem suas NFs.",
        pendentesNf,
      });
    }

    for (const prestador of prestadores) {
      const ajuste = ajustes.get(Number(prestador.id)) || {};
      const diasTrabalhados = workedDaysForCompetencia(prestador, competencia);
      if (diasTrabalhados <= 0) continue;
      const salarioBase = money(prestador.salario_contrato);
      const valorDias = Number(((salarioBase / payrollBaseDays()) * diasTrabalhados).toFixed(2));
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
         (folha_id, prestador_id, dias_trabalhados, salario_base, valor_dias, adicoes, bonus,
          descontos_manual, desconto_adiantamentos, valor_nf_previsto, valor_nf_emitida,
          numero_nf, liquido_pagar, observacao)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          folha.id,
          prestador.id,
          diasTrabalhados,
          salarioBase,
          valorDias,
          adicoes,
          bonus,
          descontosManual,
          descontoAdiantamentos,
          valorNfPrevisto,
          valorNfEmitida,
          ajuste.numero_nf || null,
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
      runNfFolderScanIfDue().catch((error) => console.error("Falha na varredura automatica de NFs:", error.message));
    }, 60 * 60 * 1000);
    runDailyNfFollowupIfDue().catch((error) => console.error("Falha no agendamento de follow-up NF:", error.message));
    runNfFolderScanIfDue().catch((error) => console.error("Falha na varredura automatica de NFs:", error.message));
  })
  .catch((error) => {
    console.error("Nao foi possivel preparar o controle de acesso.", error);
    process.exit(1);
  });
