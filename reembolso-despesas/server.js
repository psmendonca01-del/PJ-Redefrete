const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const zlib = require("zlib");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");
let sharp = null;
try {
  sharp = require("sharp");
} catch {
  sharp = null;
}
const express = require("express");
const multer = require("multer");
const mysql = require("mysql2/promise");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, ".env") });
dotenv.config({ path: path.join(__dirname, "..", ".env"), override: false });

const app = express();
const port = Number(process.env.REEMBOLSO_PORT || 3100);
const host = process.env.HOST || "0.0.0.0";
const uploadDir = path.join(__dirname, "uploads", "comprovantes");
const execFileAsync = promisify(execFile);

fs.mkdirSync(uploadDir, { recursive: true });

app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/vendor/html5-qrcode", express.static(path.join(__dirname, "node_modules", "html5-qrcode")));
app.use("/vendor/jsqr", express.static(path.join(__dirname, "node_modules", "jsqr", "dist")));
app.use(express.static(path.join(__dirname, "public")));

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 8,
  decimalNumbers: true,
  dateStrings: true
});

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });
const sessionCookieName = "redefrete_session";

function parseCookies(req) {
  return String(req.headers.cookie || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((acc, item) => {
      const index = item.indexOf("=");
      if (index !== -1) acc[decodeURIComponent(item.slice(0, index))] = decodeURIComponent(item.slice(index + 1));
      return acc;
    }, {});
}

function sessionCookie(token, maxAge = 60 * 60 * 12) {
  return [
    `${sessionCookieName}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`
  ].join("; ");
}

function verifyPassword(password, stored) {
  const [method, salt, hash] = String(stored || "").split(":");
  if (method !== "scrypt" || !salt || !hash) return false;
  const candidate = crypto.scryptSync(String(password), salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), candidate);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function authCode(prefix) {
  return `${prefix}-${crypto.randomBytes(2).toString("hex").toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

const pendingComprovantes = new Map();

function cleanupPendingComprovantes(maxAgeMs = 60 * 60 * 1000) {
  const now = Date.now();
  for (const [token, item] of pendingComprovantes.entries()) {
    if (now - Number(item.created_at || 0) <= maxAgeMs) continue;
    if (item.filename) fs.rm(path.join(uploadDir, item.filename), { force: true }, () => {});
    pendingComprovantes.delete(token);
  }
}

const PRESTACAO_EDITABLE_STATUSES = new Set([
  "rascunho",
  "enviada_superior",
  "reprovada_superior",
  "reprovada_financeiro",
  "cancelada"
]);
const PRESTACAO_OMIE_SYNC_STATUSES = new Set(["a_pagar", "a_devolver", "pago", "finalizada"]);
const PRESTACAO_ABERTA_STATUSES = new Set([
  "rascunho",
  "enviada_superior",
  "em_validacao_financeira",
  "a_pagar",
  "a_devolver",
  "reprovada_superior",
  "reprovada_financeiro"
]);

const ADIANTAMENTO_EDITABLE_STATUSES = new Set(["rascunho", "em_aprovacao", "reprovado", "cancelado"]);
const REEMBOLSO_APPROVAL_FLOW = [
  { email: "simone.oliveira@redefrete.com.br", etapa: "superior_simone", nome: "Simone Oliveira Goncalves" },
  { email: "paulo.mendonca@redefrete.com.br", etapa: "superior_paulo", nome: "Paulo da Silva Mendonca" }
];
const reembolsoPermissionKeys = [
  "reembolso_acessar",
  "reembolso_solicitar",
  "reembolso_aprovar",
  "reembolso_financeiro",
  "reembolso_admin",
  "reembolso_integrar_omie",
  "reembolso_relatorio"
];

const defaultReembolsoPermissionsByPerfil = {
  master: Object.fromEntries(reembolsoPermissionKeys.map((key) => [key, true])),
  administrador: Object.fromEntries(reembolsoPermissionKeys.map((key) => [key, true])),
  financeiro: {
    reembolso_acessar: true,
    reembolso_financeiro: true,
    reembolso_integrar_omie: true,
    reembolso_relatorio: true
  },
  aprovador: {
    reembolso_acessar: true,
    reembolso_aprovar: true,
    reembolso_relatorio: true
  },
  operacional: {
    reembolso_acessar: true,
    reembolso_solicitar: true
  },
  consulta: {
    reembolso_acessar: true,
    reembolso_solicitar: true
  }
};

function toMoney(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : 0;
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

function normalizeLookupText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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
  const defaults = defaultReembolsoPermissionsByPerfil[user?.perfil] || {};
  const explicit = parsePermissions(user?.permissoes_json);
  const permissions = {};
  for (const key of reembolsoPermissionKeys) {
    permissions[key] = Boolean(explicit[key] ?? defaults[key] ?? false);
  }
  if (["master", "administrador"].includes(user?.perfil)) {
    for (const key of reembolsoPermissionKeys) permissions[key] = true;
  }
  return permissions;
}

function hasPermission(user, permission) {
  return Boolean(permissionsForUser(user)[permission]);
}

function isFullAccess(user) {
  return hasPermission(user, "reembolso_admin")
    || hasPermission(user, "reembolso_financeiro");
}

function canOperateFinanceiro(user) {
  return hasPermission(user, "reembolso_admin")
    || hasPermission(user, "reembolso_financeiro");
}

function emailConfigured() {
  return Boolean(process.env.GRAPH_TENANT_ID && process.env.GRAPH_CLIENT_ID && process.env.GRAPH_CLIENT_SECRET && process.env.GRAPH_FROM);
}

function omieConfigured() {
  return Boolean(process.env.OMIE_APP_KEY && process.env.OMIE_APP_SECRET);
}

async function omieCall(serviceUrl, call, params = {}) {
  if (!omieConfigured()) throw new Error("Omie ainda nao esta configurado.");
  const response = await fetch(serviceUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      call,
      app_key: process.env.OMIE_APP_KEY,
      app_secret: process.env.OMIE_APP_SECRET,
      param: [params]
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.faultstring || data.faultcode) {
    throw new Error(data.faultstring || data.message || `Falha na API Omie (${call}).`);
  }
  return data;
}

function extractOmieClienteCode(data) {
  return Number(
    data?.codigo_cliente_omie
    || data?.codigo_cliente
    || data?.codigo_cliente_fornecedor
    || data?.codigo
    || data?.cliente?.codigo_cliente_omie
    || data?.clientes_cadastro?.codigo_cliente_omie
    || 0
  ) || null;
}

function omiePrestadorIntegrationCode(prestador) {
  return prestador.prestador_omie_codigo_integracao || prestador.omie_codigo_integracao || `RDF-PREST-${prestador.prestador_id || prestador.id}`;
}

function splitPhone(value) {
  const digits = onlyDigits(value);
  if (digits.length < 10) return { ddd: "", numero: digits };
  return { ddd: digits.slice(0, 2), numero: digits.slice(2) };
}

async function findOmieClienteByCpfCnpj(cpfCnpj) {
  const data = await omieCall("https://app.omie.com.br/api/v1/geral/clientes/", "ListarClientes", {
    pagina: 1,
    registros_por_pagina: 20,
    apenas_importado_api: "N",
    clientesFiltro: { cnpj_cpf: cpfCnpj }
  });
  const list = data.clientes_cadastro || data.clientes || data.clientes_cadastro_resumido || [];
  const match = list.find((item) => onlyDigits(item.cnpj_cpf) === onlyDigits(cpfCnpj)) || list[0];
  return extractOmieClienteCode(match || {});
}

class OmiePrestadorPendenteError extends Error {
  constructor(prestador) {
    super(`Prestador sem cadastro no Omie: ${prestador.razao_social || prestador.prestador_nome || prestador.solicitante}.`);
    this.code = "OMIE_PRESTADOR_PENDENTE";
    this.prestador = {
      id: prestador.prestador_id,
      nome: prestador.prestador_nome || prestador.solicitante || "",
      razao_social: prestador.razao_social || "",
      cnpj: prestador.cnpj || "",
    };
  }
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
  return categoria.descricao || categoria.nome || categoria.cDescricao || "";
}

function omieCategoriaCode(categoria) {
  return categoria.codigo || categoria.codigo_categoria || categoria.cCod || "";
}

async function listOmieCategorias() {
  const categorias = [];
  let pagina = 1;
  let totalPaginas = 1;
  do {
    const data = await omieCall("https://app.omie.com.br/api/v1/geral/categorias/", "ListarCategorias", {
      pagina,
      registros_por_pagina: 100
    });
    categorias.push(...extractOmieCategorias(data));
    totalPaginas = Number(data.total_de_paginas || data.total_paginas || 1);
    pagina += 1;
  } while (pagina <= totalPaginas);
  return categorias
    .map((categoria) => ({
      codigo: String(omieCategoriaCode(categoria) || "").trim(),
      nome: String(omieCategoriaName(categoria) || "").trim()
    }))
    .filter((categoria) => categoria.codigo && categoria.nome);
}

async function resolveOmieCategoriaPorNome(nome) {
  const categorias = await listOmieCategorias();
  const normalized = normalizeLookupText(nome);
  const exactos = categorias.filter((categoria) => normalizeLookupText(categoria.nome) === normalized);
  const candidatos = exactos.length
    ? exactos
    : categorias.filter((categoria) => normalizeLookupText(categoria.nome).includes(normalized));
  const match = candidatos.find((categoria) => String(categoria.codigo).startsWith("2."))
    || candidatos[0];
  if (!match) throw new Error(`Categoria Omie nao encontrada: ${nome}.`);
  return match.codigo;
}

function extractOmieProjetos(data) {
  return data.cadastro || data.projetos || data.lista_projetos || [];
}

function extractOmieDepartamentos(data) {
  return data.departamentos || data.cadastro || data.lista_departamentos || [];
}

async function resolveOmieProjetoPorNome(nome) {
  if (!nome) return null;
  const data = await omieCall("https://app.omie.com.br/api/v1/geral/projetos/", "ListarProjetos", {
    pagina: 1,
    registros_por_pagina: 500
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
    const data = await omieCall("https://app.omie.com.br/api/v1/geral/departamentos/", "ListarDepartamentos", {
      pagina,
      registros_por_pagina: 100
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

function omieTransferInfo(person) {
  const banco = onlyDigits(person.banco).slice(0, 3);
  const agencia = onlyDigits(person.agencia);
  const conta = formatContaComDigito(person.conta);
  const documento = onlyDigits(person.cnpj || person.cpf);
  const nome = String(person.razao_social || person.prestador_nome || person.solicitante || "").trim().slice(0, 60);
  if (!banco || !agencia || !conta || !documento || !nome) return null;
  return {
    codigo_forma_pagamento: "TRA",
    banco_transferencia: banco.padStart(3, "0"),
    agencia_transferencia: agencia,
    conta_corrente_transferencia: conta,
    finalidade_transferencia: "00010",
    cpf_cnpj_transferencia: documento,
    nome_transferencia: nome
  };
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

function resolveConfiguredOmieContaCorrenteId() {
  const id = Number(process.env.OMIE_CONTA_CORRENTE_ID || 0);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function resolveConfiguredOmieAdiantamentoContaId() {
  const id = Number(process.env.OMIE_CONTA_ADIANTAMENTO_ID || 0);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function resolveConfiguredOmieTransferenciaCategoria() {
  return String(process.env.OMIE_CATEGORIA_TRANSFERENCIA || "0.01").trim();
}

function sqlDate(value, fallback = new Date()) {
  if (!value) return new Date(fallback).toISOString().slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  return new Date(text).toISOString().slice(0, 10);
}

async function ensureOmiePrestador(prestador, options = {}) {
  if (prestador.omie_codigo_cliente) return Number(prestador.omie_codigo_cliente);
  if (!prestador.prestador_id) throw new Error("Usuario sem prestador PJ vinculado.");
  const cpfCnpj = prestador.cnpj;
  if (!cpfCnpj) throw new Error("Prestador sem CNPJ cadastrado para a Omie.");

  const existingCode = await findOmieClienteByCpfCnpj(cpfCnpj);
  if (existingCode) {
    await execute(
      "UPDATE prestadores SET omie_codigo_cliente = ?, omie_codigo_integracao = COALESCE(omie_codigo_integracao, ?) WHERE id = ?",
      [existingCode, omiePrestadorIntegrationCode(prestador), prestador.prestador_id]
    );
    return existingCode;
  }
  if (!options.allowCreate) throw new OmiePrestadorPendenteError(prestador);

  const phone = splitPhone(prestador.telefone);
  const payload = {
    cnpj_cpf: cpfCnpj,
    razao_social: String(prestador.razao_social || "").slice(0, 60),
    nome_fantasia: String(prestador.razao_social || "").slice(0, 100),
    email: prestador.prestador_email || prestador.email || "",
    telefone1_ddd: phone.ddd,
    telefone1_numero: phone.numero,
    tags: [{ tag: "Fornecedor" }, { tag: "Redefrete PJ" }, { tag: "Reembolso" }]
  };
  const dadosBancarios = omiePrestadorDadosBancarios(prestador);
  if (dadosBancarios) payload.dadosBancarios = dadosBancarios;
  const result = await omieCall("https://app.omie.com.br/api/v1/geral/clientes/", "UpsertClienteCpfCnpj", payload);
  const codigo = extractOmieClienteCode(result) || await findOmieClienteByCpfCnpj(cpfCnpj);
  if (!codigo) throw new Error("Omie nao retornou o codigo do fornecedor.");
  await execute(
    "UPDATE prestadores SET omie_codigo_cliente = ?, omie_codigo_integracao = ? WHERE id = ?",
    [codigo, omiePrestadorIntegrationCode(prestador), prestador.prestador_id]
  );
  return codigo;
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
  const compressed = zlib.deflateRawSync(content);
  const checksum = crc32(content);
  const { dosTime, dosDate } = dosDateTime();
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(dosTime, 12);
  central.writeUInt16LE(dosDate, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);

  const centralOffset = local.length + name.length + compressed.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
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

function reportHtmlForPdf(html) {
  return html.replace("</style>", `
    @page { size: A4; margin: 8mm; }
    html, body { width: 210mm; min-height: 297mm; background: #fff !important; }
    .page { width: 100% !important; margin: 0 !important; box-shadow: none !important; }
    .hero { grid-template-columns: 34mm 1fr 34mm !important; gap: 8mm !important; padding: 8mm 7mm !important; }
    .logo strong { font-size: 17px !important; }
    .mark { width: 10mm !important; height: 10mm !important; font-size: 16px !important; }
    .hero h1 { font-size: 16px !important; line-height: 1.15 !important; }
    .hero h2 { font-size: 10px !important; }
    .hero-meta strong { font-size: 11px !important; }
    .summary div { padding: 4mm !important; }
    .value { font-size: 13px !important; }
    .section { padding: 5mm 4mm !important; }
    h3 { font-size: 14px !important; }
    table { font-size: 9px !important; }
    th, td { padding: 2.5mm 2mm !important; }
    .meta-grid { grid-template-columns: 28mm 1fr 28mm 1fr !important; font-size: 9px !important; }
    .meta-grid div { min-height: 8mm !important; padding: 2.4mm !important; }
    .two-col { gap: 4mm !important; }
    .footer { padding: 4mm !important; }
  </style>`);
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
    "msedge"
  ].filter(Boolean);
  return candidates.find((candidate) => candidate.includes("\\") ? fs.existsSync(candidate) : candidate) || null;
}

async function htmlToPdfBuffer(html) {
  const browser = browserExecutablePath();
  if (!browser) throw new Error("Chrome/Edge nao encontrado para gerar PDF do relatorio.");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reembolso-pdf-"));
  const htmlPath = path.join(dir, "relatorio.html");
  const pdfPath = path.join(dir, "relatorio.pdf");
  fs.writeFileSync(htmlPath, reportHtmlForPdf(html), "utf8");
  try {
    await execFileAsync(browser, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
      "--print-to-pdf-no-header",
      `--print-to-pdf=${pdfPath}`,
      `file:///${htmlPath.replace(/\\/g, "/")}`
    ], { timeout: 180000, windowsHide: true });
    return fs.readFileSync(pdfPath);
  } catch (error) {
    if (fs.existsSync(pdfPath)) {
      return fs.readFileSync(pdfPath);
    }
    throw error;
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

async function comprovantesReembolso(prestacaoId) {
  const rows = await query(`
    SELECT c.id, c.nome_original, c.caminho_arquivo, c.mime_type, c.tamanho_bytes,
           d.data_despesa, d.descricao, d.valor, t.nome AS tipo
      FROM rd_reembolso_comprovantes c
      JOIN rd_reembolso_despesas d ON d.id = c.despesa_id
      JOIN rd_reembolso_tipos_despesa t ON t.id = d.tipo_despesa_id
     WHERE d.prestacao_id = ?
     ORDER BY d.data_despesa, d.id, c.id
  `, [prestacaoId]);
  const baseDir = path.resolve(uploadDir);
  const items = [];
  for (const item of rows) {
    const filePath = path.resolve(baseDir, item.caminho_arquivo);
    const exists = filePath.startsWith(`${baseDir}${path.sep}`) && fs.existsSync(filePath);
    const normalized = { ...item, filePath: exists ? filePath : null };
    normalized.reportDataUrl = exists ? await comprovanteDataUrlForReport(normalized) : null;
    items.push(normalized);
  }
  return items;
}

async function comprovanteDataUrlForReport(comprovante) {
  if (!comprovante.filePath || !/^image\//i.test(comprovante.mime_type || "")) return null;
  try {
    if (!sharp) {
      const raw = fs.readFileSync(comprovante.filePath);
      return `data:${comprovante.mime_type};base64,${raw.toString("base64")}`;
    }
    const buffer = await sharp(comprovante.filePath)
      .rotate()
      .resize({ width: 820, height: 1100, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 52, mozjpeg: true })
      .toBuffer();
    return `data:image/jpeg;base64,${buffer.toString("base64")}`;
  } catch {
    const raw = fs.readFileSync(comprovante.filePath);
    return `data:${comprovante.mime_type};base64,${raw.toString("base64")}`;
  }
}

async function lerDocumentoFiscal(filePath) {
  const scriptPath = path.join(__dirname, "scripts", "document-reader.py");
  if (!fs.existsSync(scriptPath)) return {};
  try {
    const { stdout } = await execFileAsync("python", [scriptPath, filePath], {
      timeout: 45000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    return JSON.parse(String(stdout || "{}"));
  } catch (error) {
    return { source: "erro", erro: error.message };
  }
}

function extractAccessKeyFromQrText(text) {
  const match = String(text || "").match(/\b(\d{44})\b/);
  return match ? match[1] : "";
}

function normalizeQrText(text) {
  return String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/[\u200B-\u200D\u2060]/g, "")
    .trim();
}

function extractFiscalQrUrl(text) {
  const clean = normalizeQrText(text);
  const match = clean.match(/https?:\/\/\S+/i);
  return match ? match[0] : "";
}

async function validarDocumentoDespesa({ prestacao, file }) {
  const fiscal = await lerDocumentoFiscal(file.path);
  const qrText = normalizeQrText(file.qr_text || fiscal.qr_text || "");
  const qrUrl = fiscal.qr_url || extractFiscalQrUrl(qrText);
  const consulta = qrUrl ? await consultarDocumentoFiscal(qrUrl) : { skipped: true };
  const chave = fiscal.chave_acesso || extractAccessKeyFromQrText(qrText);
  const numero = fiscal.numero_nf || "";
  const data = consulta.data_emissao || null;
  const valor = consulta.valor || null;
  const divergencias = [];
  let duplicada = null;

  if (chave) {
    const rows = await query(
      `SELECT c.id, d.prestacao_id, p.numero AS prestacao_numero
         FROM rd_reembolso_comprovantes c
         JOIN rd_reembolso_despesas d ON d.id = c.despesa_id
         JOIN rd_reembolso_prestacoes p ON p.id = d.prestacao_id
        WHERE c.nf_chave_acesso = ?
        LIMIT 1`,
      [chave]
    );
    duplicada = rows[0] || null;
    if (duplicada) divergencias.push(`NF ja anexada na prestacao ${duplicada.prestacao_numero}.`);
  }
  if (data && (data < String(prestacao.data_inicio).slice(0, 10) || data > String(prestacao.data_fim).slice(0, 10))) {
    divergencias.push(`Data da NF (${formatDate(data)}) fora do periodo da prestacao (${formatDate(prestacao.data_inicio)} a ${formatDate(prestacao.data_fim)}).`);
  }
  if (qrUrl && (!data || !valor)) {
    divergencias.push("QR Code localizado, mas a consulta nao retornou data e valor com seguranca.");
  }
  if (qrText && !qrUrl && !chave) {
    divergencias.push("QR Code lido, mas nao parece ser um documento fiscal.");
  }
  const isNf = Boolean(chave || qrUrl);
  return {
    is_nf: isNf,
    status: isNf && !divergencias.length && data && valor ? "validada" : "manual",
    chave_acesso: chave || null,
    numero_nf: numero || null,
    data_emissao: data,
    valor,
    qr_url: qrUrl || null,
    qr_lido: qrText || null,
    consulta_status: consulta.status || (consulta.skipped ? "sem_qr" : null),
    consulta_erro: consulta.erro || fiscal.erro || null,
    divergencias,
    duplicada
  };
}

async function buildReembolsoReportPdf(prestacaoId) {
  const rows = await query(`
    SELECT p.*, u.nome AS solicitante, u.email, d.nome AS departamento,
           pr.razao_social, pr.nome AS prestador_nome, pr.cnpj, pr.cpf,
           pr.banco, pr.agencia, pr.conta
      FROM rd_reembolso_prestacoes p
      JOIN usuarios u ON u.id = p.solicitante_id
      LEFT JOIN departamentos d ON d.id = p.centro_custo_id
      ${prestadorJoinByUserSql("u", "pr")}
     WHERE p.id = ?
  `, [prestacaoId]);
  const prestacao = rows[0];
  const despesas = await query(`
    SELECT d.*, t.nome AS tipo, t.exige_km
      FROM rd_reembolso_despesas d
      JOIN rd_reembolso_tipos_despesa t ON t.id = d.tipo_despesa_id
     WHERE d.prestacao_id = ?
     ORDER BY d.data_despesa, d.id
  `, [prestacaoId]);
  const aprovacoes = await query(`
    SELECT a.*, u.nome AS usuario, u.email
      FROM rd_reembolso_aprovacoes a
      JOIN usuarios u ON u.id = a.usuario_id
     WHERE a.prestacao_id = ?
     ORDER BY a.created_at
  `, [prestacaoId]);
  const comprovantes = await comprovantesReembolso(prestacaoId);
  const resumoFinanceiro = await resumoFinanceiroReembolso(prestacao);
  const historico = await query(`
    SELECT h.*, u.nome AS usuario
      FROM rd_reembolso_historico h
      LEFT JOIN usuarios u ON u.id = h.usuario_id
     WHERE h.prestacao_id = ?
     ORDER BY h.created_at
  `, [prestacaoId]);
  return htmlToPdfBuffer(renderReembolsoReport({ prestacao, despesas, aprovacoes, comprovantes, resumoFinanceiro, historico }));
}

async function buildReembolsoComprovantesPdf(prestacaoId) {
  const rows = await query(`
    SELECT p.numero, u.nome AS solicitante
      FROM rd_reembolso_prestacoes p
      JOIN usuarios u ON u.id = p.solicitante_id
     WHERE p.id = ?
  `, [prestacaoId]);
  const prestacao = rows[0];
  const comprovantes = await comprovantesReembolso(prestacaoId);
  const items = comprovantes.map((comprovante) => {
    const image = comprovante.reportDataUrl
      ? `<img src="${comprovante.reportDataUrl}" alt="${escapeHtml(comprovante.nome_original)}">`
      : `<div class="file-box">${escapeHtml(comprovante.nome_original || "Comprovante")}</div>`;
    return `
      <section class="receipt-page">
        <div class="receipt-meta">
          <strong>${escapeHtml(comprovante.tipo || "Despesa")}</strong>
          <span>${formatDate(comprovante.data_despesa)} | ${formatMoney(comprovante.valor)}</span>
          <span>${escapeHtml(comprovante.descricao || "")}</span>
          <small>${escapeHtml(comprovante.nome_original || "")}</small>
        </div>
        ${image}
      </section>`;
  }).join("");
  const html = `
    <style>
      .receipt-header{background:#141923;color:#fff;padding:10mm 8mm;margin:-6mm -6mm 6mm}
      .receipt-header h1{margin:0;font-size:18px}.receipt-header p{margin:2mm 0 0}
      .receipt-page{page-break-inside:avoid;margin-bottom:8mm;border:1px solid #d9dfe7}
      .receipt-meta{display:grid;gap:1mm;background:#f4f7fb;padding:4mm;font-size:11px}
      .receipt-page img{display:block;width:100%;max-height:210mm;object-fit:contain;background:#fff}
      .file-box{padding:16mm;text-align:center;font-size:13px}
    </style>
    <div class="receipt-header">
      <h1>Comprovantes - ${escapeHtml(prestacao?.numero || "")}</h1>
      <p>${escapeHtml(prestacao?.solicitante || "")}</p>
    </div>
    ${items || "<p>Nenhum comprovante anexado.</p>"}`;
  return htmlToPdfBuffer(html);
}

function renderAdiantamentoReport({ adiantamento, prestacao = null, movimentos = [] }) {
  const geradoEm = new Date().toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  const valorAdiantado = toMoney(adiantamento.valor);
  const totalDespesas = toMoney(prestacao?.total_despesas || 0);
  const abatimento = toMoney(Math.min(valorAdiantado, totalDespesas));
  const valorPagamento = toMoney(Math.max(totalDespesas - valorAdiantado, 0));
  const saldoDevolver = toMoney(Math.max(valorAdiantado - totalDespesas, 0));
  const etapas = [
    { etapa: "Solicitação", responsavel: adiantamento.solicitante, data: adiantamento.created_at, status: "Criada" },
    { etapa: "Envio para aprovação", responsavel: adiantamento.solicitante, data: adiantamento.updated_at, status: ["em_aprovacao", "aprovado", "prestado"].includes(adiantamento.status) ? "Enviada" : "Rascunho" },
    { etapa: "Aprovação", responsavel: adiantamento.aprovador || "-", data: adiantamento.aprovado_em, status: adiantamento.aprovado_em ? "Aprovada" : "Pendente" }
  ];
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(adiantamento.numero)} | Demonstrativo de Adiantamento</title>
  <style>
    :root{--nav:#141923;--brand:#002b5f;--line:#d7dde6;--muted:#657184;--text:#0b1726}
    *{box-sizing:border-box} body{margin:0;background:#eef2f6;color:var(--text);font-family:"Segoe UI",Arial,sans-serif}
    .page{width:min(1120px,calc(100% - 32px));margin:22px auto;background:#fff;box-shadow:0 18px 55px rgba(15,23,42,.12)}
    .hero{background:var(--nav);color:#fff;padding:26px 30px;display:grid;grid-template-columns:240px 1fr 210px;gap:24px;align-items:center}
    .logo{display:flex;align-items:center;gap:12px}.mark{width:48px;height:48px;border:4px solid #fff;display:grid;place-items:center;font-size:28px;font-weight:900}
    .logo strong{display:block;font-size:30px;line-height:1}.logo span,.hero small{color:#dbe4ef;font-size:12px;text-transform:uppercase;letter-spacing:.06em;font-weight:700}
    .hero h1{margin:4px 0 0;font-size:28px;line-height:1.08}.hero h2{margin:6px 0 0;font-size:17px;font-weight:500;color:#e7eef7}
    .hero-meta{text-align:right;display:grid;gap:10px}.hero-meta strong{display:block;font-size:20px}
    .status{display:inline-flex;justify-self:end;border:1px solid rgba(255,255,255,.25);padding:6px 10px;border-radius:999px;text-transform:uppercase;font-size:12px;font-weight:800}
    .summary{display:grid;grid-template-columns:repeat(4,1fr);border-bottom:1px solid var(--line)}
    .summary div{padding:16px 18px;border-right:1px solid var(--line)}.summary div:last-child{border-right:0}
    .label{display:block;color:var(--muted);text-transform:uppercase;font-size:12px;font-weight:900;letter-spacing:.04em}.value{display:block;margin-top:6px;font-size:21px;font-weight:900}
    .section{padding:20px 26px;border-bottom:1px solid var(--line)}.section-head{display:flex;justify-content:space-between;align-items:end;gap:20px;margin-bottom:12px}
    h3{margin:0;font-size:20px}.meta-grid{display:grid;grid-template-columns:160px 1fr 160px 1fr;border:1px solid var(--line)}
    .meta-grid div{padding:10px 12px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);min-height:42px}.meta-grid div:nth-child(4n){border-right:0}.meta-grid div:nth-last-child(-n+4){border-bottom:0}
    .meta-label{background:#f3f6f9;font-weight:900;text-transform:uppercase;font-size:12px}
    table{width:100%;border-collapse:collapse;font-size:14px}th{background:#f3f6f9;color:#344054;text-transform:uppercase;font-size:12px;letter-spacing:.03em}
    th,td{border:1px solid var(--line);padding:10px 11px;text-align:left;vertical-align:top}td.money,th.money{text-align:right;white-space:nowrap}
    .two-col{display:grid;grid-template-columns:1fr 1fr;gap:18px}.ok{font-weight:900;color:#065f46}.footer{padding:16px 26px 24px;display:flex;justify-content:space-between;color:var(--muted);font-size:12px}
    @media print{body{background:#fff}.page{width:100%;margin:0;box-shadow:none}}
  </style>
</head>
<body>
  <main class="page">
    <header class="hero">
      <div class="logo"><div class="mark">R</div><div><strong>redefrete</strong><span>Reembolso de despesas</span></div></div>
      <div><small>Demonstrativo de adiantamento</small><h1>${escapeHtml(adiantamento.numero)} - ${escapeHtml(adiantamento.solicitante)}</h1><h2>${escapeHtml(adiantamento.finalidade || "Solicitação de adiantamento")}</h2></div>
      <div class="hero-meta"><div><small>Data do adiantamento</small><strong>${formatDate(adiantamento.data_adiantamento)}</strong></div><span class="status">${escapeHtml(String(adiantamento.status || "").replaceAll("_", " "))}</span></div>
    </header>
    <section class="summary">
      <div><span class="label">Adiantamento</span><span class="value">${formatMoney(valorAdiantado)}</span></div>
      <div><span class="label">Despesas vinculadas</span><span class="value">${formatMoney(totalDespesas)}</span></div>
      <div><span class="label">Para pagamento</span><span class="value">${formatMoney(valorPagamento)}</span></div>
      <div><span class="label">Saldo a devolver</span><span class="value">${formatMoney(saldoDevolver)}</span></div>
    </section>
    <section class="section">
      <div class="section-head"><h3>Dados da solicitação</h3><span class="label">Gerado em ${escapeHtml(geradoEm)}</span></div>
      <div class="meta-grid">
        <div class="meta-label">Solicitante</div><div>${escapeHtml(adiantamento.solicitante)}</div>
        <div class="meta-label">E-mail</div><div>${escapeHtml(adiantamento.email || "")}</div>
        <div class="meta-label">Centro de custo</div><div>${escapeHtml(adiantamento.centro_custo || "")}</div>
        <div class="meta-label">Aprovador</div><div>${escapeHtml(adiantamento.aprovador || "")}</div>
        <div class="meta-label">Finalidade</div><div>${escapeHtml(adiantamento.finalidade || "")}</div>
        <div class="meta-label">Descritivo</div><div>${escapeHtml(adiantamento.descritivo || "")}</div>
      </div>
    </section>
    <section class="section two-col">
      <div>
        <div class="section-head"><h3>Composição do lançamento</h3></div>
        <table><tbody>
          <tr><td>Valor para adiantamento</td><td class="money"><strong>${formatMoney(valorAdiantado)}</strong></td></tr>
          <tr><td>Valor compensado na prestação</td><td class="money">${formatMoney(abatimento)}</td></tr>
          <tr><td>Valor para pagamento ao prestador</td><td class="money">${formatMoney(valorPagamento)}</td></tr>
          <tr><td>Saldo pendente/devolução</td><td class="money">${formatMoney(saldoDevolver)}</td></tr>
        </tbody></table>
      </div>
      <div>
        <div class="section-head"><h3>Vínculo com prestação</h3></div>
        <table><tbody>
          <tr><td>Nº prestação</td><td><strong>${escapeHtml(prestacao?.numero || "-")}</strong></td></tr>
          <tr><td>Total de despesas</td><td class="money">${formatMoney(totalDespesas)}</td></tr>
          <tr><td>A reembolsar</td><td class="money">${formatMoney(prestacao?.valor_reembolsar || 0)}</td></tr>
          <tr><td>A devolver</td><td class="money">${formatMoney(prestacao?.saldo_devolver || 0)}</td></tr>
        </tbody></table>
      </div>
    </section>
    <section class="section">
      <div class="section-head"><h3>Histórico e aprovações</h3><span class="label">Fluxo registrado</span></div>
      <table><thead><tr><th>Etapa</th><th>Responsável</th><th>Status</th><th>Data</th></tr></thead><tbody>
        ${etapas.map((item) => `<tr><td>${escapeHtml(item.etapa)}</td><td>${escapeHtml(item.responsavel || "")}</td><td class="${item.status === "Aprovada" ? "ok" : ""}">${escapeHtml(item.status)}</td><td>${formatDateTime(item.data)}</td></tr>`).join("")}
      </tbody></table>
    </section>
    <section class="section">
      <div class="section-head"><h3>Conta corrente interna</h3><span class="label">${movimentos.length} movimento(s)</span></div>
      <table><thead><tr><th>Data</th><th>Documento</th><th>Movimento</th><th>Descrição</th><th class="money">Valor</th></tr></thead><tbody>
        ${movimentos.map((m) => `<tr><td>${formatDate(m.data_movimento)}</td><td>${escapeHtml(m.numero_documento || "")}</td><td>${escapeHtml(String(m.tipo || "").replaceAll("_", " "))}</td><td>${escapeHtml(m.descricao || "")}</td><td class="money">${formatMoney(m.valor)}</td></tr>`).join("") || `<tr><td colspan="5">Nenhum movimento registrado.</td></tr>`}
      </tbody></table>
    </section>
    <footer class="footer"><span>Redefrete Logística | Reembolso de Despesas</span><span>${escapeHtml(adiantamento.numero)}</span></footer>
  </main>
</body>
</html>`;
}

async function buildAdiantamentoReportPdf(adiantamentoId) {
  const rows = await query(`
    SELECT a.*, u.nome AS solicitante, u.email, c.nome AS centro_custo,
           ap.nome AS aprovador, ap.email AS aprovador_email,
           p.numero AS prestacao_numero, p.total_despesas, p.valor_reembolsar, p.saldo_devolver
      FROM rd_reembolso_adiantamentos a
      JOIN usuarios u ON u.id = a.solicitante_id
      LEFT JOIN usuarios ap ON ap.id = a.aprovado_por
      LEFT JOIN departamentos c ON c.id = a.centro_custo_id
      LEFT JOIN rd_reembolso_prestacoes p ON p.id = a.prestacao_id
     WHERE a.id = ?
     LIMIT 1
  `, [adiantamentoId]);
  const adiantamento = rows[0];
  if (!adiantamento) throw new Error("Adiantamento nao encontrado para gerar relatorio.");
  const prestacao = adiantamento.prestacao_id ? {
    numero: adiantamento.prestacao_numero,
    total_despesas: adiantamento.total_despesas,
    valor_reembolsar: adiantamento.valor_reembolsar,
    saldo_devolver: adiantamento.saldo_devolver
  } : null;
  const movimentos = await query(
    `SELECT * FROM rd_reembolso_conta_corrente
      WHERE adiantamento_id = ?
         OR (prestacao_id = ? AND tipo = 'compensacao_prestacao')
      ORDER BY data_movimento, id`,
    [adiantamentoId, adiantamento.prestacao_id || 0]
  );
  return htmlToPdfBuffer(renderAdiantamentoReport({ adiantamento, prestacao, movimentos }));
}

async function omieIncluirAnexo({ nId, cCodIntAnexo, cNomeArquivo, content, cTabela = "conta-pagar" }) {
  const fileName = sanitizeOmieFileName(cNomeArquivo);
  const zip = zipSingleFile(fileName, content);
  const encodedZip = zip.toString("base64");
  const payload = {
    cCodIntAnexo: String(cCodIntAnexo).slice(0, 20),
    cTabela,
    nId: Number(nId),
    cNomeArquivo: fileName,
    cTipoArquivo: path.extname(fileName).replace(".", "").toUpperCase().slice(0, 10),
    cArquivo: encodedZip,
    cMd5: crypto.createHash("md5").update(encodedZip).digest("hex")
  };
  const assertAnexoOk = (result) => {
    const status = String(result?.cCodStatus ?? "").trim();
    const message = String(result?.cDesStatus || result?.message || "");
    const ok = Boolean(result?.nIdAnexo) || status === "0" || /cadastrad|inclu[ií]d|sucesso|existe|duplic/i.test(message);
    if (!ok) throw new Error(message || `Omie nao confirmou o anexo ${fileName}.`);
    return result;
  };
  try {
    const result = await omieCall("https://app.omie.com.br/api/v1/geral/anexo/", "IncluirAnexo", payload);
    if (/cadastrad|existe|duplic/i.test(String(result?.cDesStatus || result?.message || ""))) {
      if (!result?.nIdAnexo) return assertAnexoOk(result);
      await omieCall("https://app.omie.com.br/api/v1/geral/anexo/", "ExcluirAnexo", {
        cCodIntAnexo: payload.cCodIntAnexo,
        cTabela: payload.cTabela,
        nId: payload.nId,
        nIdAnexo: result.nIdAnexo,
        cNomeArquivo: payload.cNomeArquivo
      });
      return assertAnexoOk(await omieCall("https://app.omie.com.br/api/v1/geral/anexo/", "IncluirAnexo", payload));
    }
    return assertAnexoOk(result);
  } catch (error) {
    throw error;
  }
}

async function enviarAnexosReembolsoOmie(prestacao, contaPagarId) {
  if (!contaPagarId) throw new Error("Codigo do lancamento Omie nao retornado para anexar o relatorio.");
  const batch = Date.now().toString(36).toUpperCase().slice(-6);
  const anexos = [{
    codigo: `RR${prestacao.id}D${batch}`,
    nome: `demonstrativo-completo-${prestacao.numero}.pdf`,
    content: await buildReembolsoReportPdf(prestacao.id)
  }];
  const enviados = [];
  for (const anexo of anexos) {
    const retorno = await omieIncluirAnexo({
      nId: contaPagarId,
      cCodIntAnexo: anexo.codigo,
      cNomeArquivo: anexo.nome,
      content: anexo.content
    });
    enviados.push({ nome: anexo.nome, retorno });
  }
  return enviados;
}

async function enviarAnexoAdiantamentoOmie(adiantamento, lancamentoId) {
  if (!lancamentoId) throw new Error("Codigo do lancamento Omie nao retornado para anexar o demonstrativo do adiantamento.");
  const anexo = {
    codigo: `AD${adiantamento.id}REL`,
    nome: `adiantamento-${adiantamento.numero}.pdf`,
    content: await buildAdiantamentoReportPdf(adiantamento.id)
  };
  const retorno = await omieIncluirAnexo({
    nId: lancamentoId,
    cTabela: "conta-corrente-lancamento",
    cCodIntAnexo: anexo.codigo,
    cNomeArquivo: anexo.nome,
    content: anexo.content
  });
  return [{ nome: anexo.nome, retorno }];
}

function omieContaPagarId(retorno, fallback = null) {
  const candidates = [
    retorno?.codigo_lancamento_omie,
    retorno?.nCodLanc,
    retorno?.nCodTitulo,
    retorno?.codigo_lancamento,
    retorno?.codigo,
    retorno?.conta_pagar?.codigo_lancamento_omie,
    fallback
  ];
  for (const value of candidates) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return null;
}

function reembolsoOmieIntegrationCode(prestacao) {
  return `RDF-REEMB-V2-${prestacao.id}-${prestacao.numero}`.slice(0, 60);
}

function extractOmiePaymentDate(conta) {
  const pagamento = conta?.pagamento || {};
  const candidates = [
    pagamento.data,
    pagamento.data_pagamento,
    pagamento.data_baixa,
    conta?.data_pagamento,
    conta?.data_baixa,
    conta?.data_credito
  ];
  return candidates.map(parseOmieDate).find(Boolean) || null;
}

function isOmieContaPaga(conta) {
  const status = normalizeLookupText(conta?.status_titulo || conta?.status || "");
  const valorPago = toMoney(conta?.valor_pag || conta?.valor_pago || conta?.pagamento?.valor || 0);
  const valorDocumento = toMoney(conta?.valor_documento || 0);
  const statusPago = ["pago", "liquidado", "baixado"].some((token) => status.includes(token));
  const temBaixa = Boolean(extractOmiePaymentDate(conta) || conta?.pagamento);
  return statusPago
    || (valorDocumento > 0 && valorPago >= valorDocumento)
    || (statusPago && (valorPago > 0 || temBaixa || valorDocumento > 0));
}

async function consultarOmieContaPagar(prestacao) {
  const chave = {};
  if (prestacao.omie_codigo_lancamento) chave.codigo_lancamento_omie = Number(prestacao.omie_codigo_lancamento);
  if (prestacao.omie_codigo_integracao) chave.codigo_lancamento_integracao = prestacao.omie_codigo_integracao;
  if (!chave.codigo_lancamento_omie && !chave.codigo_lancamento_integracao) return null;
  return omieCall("https://app.omie.com.br/api/v1/financas/contapagar/", "ConsultarContaPagar", chave);
}

async function syncOmiePagamentoPrestacao(prestacao) {
  if (!PRESTACAO_OMIE_SYNC_STATUSES.has(prestacao.status)) {
    return { id: prestacao.id, numero: prestacao.numero, skipped: true, reason: "Prestacao fora do fluxo financeiro." };
  }
  const conta = await consultarOmieContaPagar(prestacao);
  if (!conta) return { id: prestacao.id, skipped: true };
  const statusTitulo = conta.status_titulo || conta.status || null;
  const valorPago = toMoney(conta.valor_pag || conta.valor_pago || conta.pagamento?.valor || 0);
  const valorDocumento = toMoney(conta.valor_documento || 0);
  const pago = isOmieContaPaga(conta);
  const pagoEm = pago ? (extractOmiePaymentDate(conta) || parseOmieDate(conta.info?.dAlt) || new Date().toISOString().slice(0, 10)) : null;
  const valorPagoFinal = pago && valorPago <= 0 ? valorDocumento : valorPago;
  const stamp = nowSql();
  if (pago) {
    await execute(
      `UPDATE rd_reembolso_prestacoes
          SET status = CASE WHEN status <> 'cancelada' THEN 'pago' ELSE status END,
              omie_status = 'pago',
              omie_status_titulo = ?,
              omie_valor_pago = ?,
              omie_pago_em = COALESCE(omie_pago_em, ?),
              omie_sincronizado_em = ?,
              updated_at = ?
        WHERE id = ?`,
      [statusTitulo, valorPagoFinal, pagoEm, stamp, stamp, prestacao.id]
    );
    if (prestacao.omie_status !== "pago") {
      await addHistory(prestacao.id, null, "omie_pagamento_confirmado", `Pagamento confirmado no Omie (${statusTitulo || "pago"}).`);
    }
  } else {
    await execute(
      `UPDATE rd_reembolso_prestacoes
          SET status = CASE WHEN status NOT IN ('cancelada', 'a_devolver') THEN 'a_pagar' ELSE status END,
              omie_status = CASE WHEN omie_status = 'pago' THEN 'integrado' ELSE omie_status END,
              omie_status_titulo = ?,
              omie_valor_pago = ?,
              omie_pago_em = NULL,
              omie_sincronizado_em = ?,
              updated_at = ?
        WHERE id = ?`,
      [statusTitulo, valorPago, stamp, stamp, prestacao.id]
    );
  }
  return { id: prestacao.id, numero: prestacao.numero, status_titulo: statusTitulo, valor_pago: valorPagoFinal, pago };
}

async function syncOmiePagamentos({ prestacaoId = null, limit = 50 } = {}) {
  const params = [];
  let where = "WHERE omie_codigo_lancamento IS NOT NULL AND omie_status IN ('integrado', 'pago') AND status IN ('a_pagar', 'a_devolver', 'pago', 'finalizada')";
  if (prestacaoId) {
    where += " AND id = ?";
    params.push(prestacaoId);
  } else {
    where += " AND (omie_pago_em IS NULL OR omie_sincronizado_em IS NULL OR omie_sincronizado_em < DATE_SUB(NOW(), INTERVAL 30 MINUTE))";
  }
  params.push(Number(limit));
  const prestacoes = await query(
    `SELECT id, numero, omie_status, omie_codigo_lancamento, omie_codigo_integracao
       FROM rd_reembolso_prestacoes
      ${where}
      ORDER BY COALESCE(omie_sincronizado_em, '2000-01-01'), id
      LIMIT ?`,
    params
  );
  const resultados = [];
  for (const prestacao of prestacoes) {
    resultados.push(await syncOmiePagamentoPrestacao(prestacao));
  }
  return resultados;
}

function formatOmieDate(isoDate) {
  const [year, month, day] = String(isoDate).split("-");
  return `${day}/${month}/${year}`;
}

function parseOmieDate(value) {
  const [day, month, year] = String(value || "").slice(0, 10).split("/");
  return day && month && year ? `${year}-${month}-${day}` : null;
}

function parseBrazilDate(value) {
  const match = String(value || "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

function parseBrazilMoney(value) {
  if (!value) return null;
  const clean = String(value).replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
  const number = Number(clean);
  return Number.isFinite(number) ? toMoney(number) : null;
}

function htmlToPlainText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseFiscalPage(text) {
  const plain = htmlToPlainText(text);
  const data_emissao = parseBrazilDate(
    plain.match(/(?:Emiss[aã]o|Emitida em|Data de Emiss[aã]o|Data e Hora da emiss[aã]o)[^\d]{0,40}(\d{2}\/\d{2}\/\d{4})/i)?.[1]
    || plain.match(/\b(\d{2}\/\d{2}\/\d{4})\s+\d{2}:\d{2}/)?.[1]
  );
  const valor = parseBrazilMoney(
    plain.match(/(?:Valor Total|Valor a pagar|Valor da NF-e|Valor da NFC-e)[^\d]{0,40}(?:R\$)?\s*([0-9.]+,[0-9]{2})/i)?.[1]
    || plain.match(/(?:TOTAL R\$|VALOR TOTAL R\$)\s*([0-9.]+,[0-9]{2})/i)?.[1]
  );
  return { data_emissao, valor };
}

async function consultarDocumentoFiscal(qrUrl) {
  if (!qrUrl) return { skipped: true };
  try {
    const response = await fetch(qrUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 Redefrete-Reembolso/1.0",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
    const text = await response.text();
    if (!response.ok) return { status: "erro", erro: `SEFAZ retornou HTTP ${response.status}.` };
    return { status: "consultada", ...parseFiscalPage(text) };
  } catch (error) {
    return { status: "erro", erro: error.message };
  }
}

function formatMoney(value) {
  return toMoney(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDate(value) {
  if (!value) return "";
  const [year, month, day] = String(value).slice(0, 10).split("-");
  if (!year || !month || !day) return String(value);
  return `${day}/${month}/${year}`;
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(String(value).replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
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

function approvalCentralUrl() {
  const configured = String(process.env.APPROVAL_APP_URL || process.env.APP_URL || "");
  const configuredIsLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/i.test(configured);
  const base = String(configured && !configuredIsLocalhost ? configured : `http://${localNetworkHost()}:3000`).replace(/\/$/, "");
  return `${base}/aprovacoes.html`;
}

function publicUrl(url) {
  const host = localNetworkHost();
  return String(url || "")
    .replace(/^https?:\/\/localhost(?::\d+)?/i, (match) => match.replace(/localhost/i, host))
    .replace(/^https?:\/\/127\.0\.0\.1(?::\d+)?/i, (match) => match.replace(/127\.0\.0\.1/i, host))
    .replace(/^https?:\/\/\[::1\](?::\d+)?/i, (match) => match.replace(/\[::1\]/i, host));
}

function reembolsoPublicBaseUrl() {
  const configured = String(process.env.REEMBOLSO_APP_URL || process.env.APP_REEMBOLSO_URL || "");
  const configuredIsLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/i.test(configured);
  return String(configured && !configuredIsLocalhost ? configured : `http://${localNetworkHost()}:${port}`).replace(/\/$/, "");
}

function emailActionSecret() {
  return String(process.env.EMAIL_ACTION_SECRET || process.env.SESSION_SECRET || process.env.GRAPH_CLIENT_SECRET || process.env.DB_PASSWORD || "redefrete-email-action");
}

function emailActionToken(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", emailActionSecret()).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyEmailActionToken(token) {
  const [body, signature] = String(token || "").split(".");
  if (!body || !signature) return null;
  const expected = crypto.createHmac("sha256", emailActionSecret()).update(body).digest("base64url");
  if (Buffer.byteLength(signature) !== Buffer.byteLength(expected)) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (payload.exp && Number(payload.exp) < Date.now()) return null;
  return payload;
}

function emailActionUrl(payload) {
  const token = emailActionToken({
    ...payload,
    exp: payload.exp || Date.now() + (1000 * 60 * 60 * 24 * 7)
  });
  return `${reembolsoPublicBaseUrl()}/email-action/reembolso?token=${encodeURIComponent(token)}`;
}

function comprovanteEmailUrl({ comprovanteId, prestacaoId, email }) {
  const token = emailActionToken({
    kind: "reembolso_comprovante",
    comprovanteId,
    prestacaoId,
    email,
    exp: Date.now() + (1000 * 60 * 60 * 24 * 7)
  });
  return `${reembolsoPublicBaseUrl()}/email-action/comprovante?token=${encodeURIComponent(token)}`;
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

function dateOnly(value) {
  return String(value || "").slice(0, 10);
}

function documentoDivergenciasComDespesa(validacao = {}, despesa = {}) {
  const divergencias = [];
  if (validacao.data_emissao && dateOnly(validacao.data_emissao) !== dateOnly(despesa.data_despesa)) {
    divergencias.push(`Data do comprovante (${formatDate(validacao.data_emissao)}) diferente da despesa (${formatDate(despesa.data_despesa)}).`);
  }
  if (validacao.valor != null && Math.abs(toMoney(validacao.valor) - toMoney(despesa.valor)) > 0.02) {
    divergencias.push(`Valor do comprovante (${formatMoney(validacao.valor)}) diferente da despesa (${formatMoney(despesa.valor)}).`);
  }
  return divergencias;
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
  if (Number.isNaN(result.getTime())) return null;
  while ([0, 6].includes(result.getUTCDay())) {
    result.setUTCDate(result.getUTCDate() + 1);
  }
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderComprovanteReportItem(comprovante) {
  const preview = comprovante.reportDataUrl
    ? `<img src="${comprovante.reportDataUrl}" alt="${escapeHtml(comprovante.nome_original)}">`
    : `<div class="receipt-file">${escapeHtml(comprovante.nome_original || "Comprovante")}</div>`;
  return `
    <article class="receipt-card">
      <div class="receipt-info">
        <strong>${escapeHtml(comprovante.tipo || "Despesa")}</strong>
        <span>${formatDate(comprovante.data_despesa)} | ${formatMoney(comprovante.valor)}</span>
        <span>${escapeHtml(comprovante.descricao || "")}</span>
        <small>${escapeHtml(comprovante.nome_original || "")}</small>
      </div>
      ${preview}
    </article>`;
}

async function resumoFinanceiroReembolso(prestacao) {
  const adiantamentosUtilizados = await query(
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
    [prestacao.id, prestacao.adiantamento_id || 0, prestacao.id]
  );
  const adiantamentosAtuais = await query(
    `SELECT a.id, a.numero, a.data_adiantamento, COALESCE(SUM(m.valor), 0) AS saldo
       FROM rd_reembolso_adiantamentos a
       LEFT JOIN rd_reembolso_conta_corrente m ON m.adiantamento_id = a.id
      WHERE a.solicitante_id = ?
        AND (
          COALESCE(a.prestacao_id, 0) = ?
          OR a.id = COALESCE(?, 0)
        )
      GROUP BY a.id, a.numero, a.data_adiantamento
     HAVING saldo > 0.009
      ORDER BY a.data_adiantamento, a.id`,
    [prestacao.solicitante_id, prestacao.id, prestacao.adiantamento_id || 0]
  );
  const saldosPendentes = await query(
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
    [prestacao.solicitante_id, prestacao.adiantamento_id || 0, prestacao.id]
  );
  const totalDespesas = toMoney(prestacao.total_despesas);
  const totalUtilizado = toMoney(adiantamentosUtilizados.reduce((sum, item) => sum + Number(item.saldo || 0), 0));
  const adiantamentoAtual = toMoney(totalUtilizado || adiantamentosAtuais.reduce((sum, item) => sum + Number(item.saldo || 0), 0) || prestacao.valor_adiantado);
  const saldoPendente = toMoney(saldosPendentes.reduce((sum, item) => sum + Number(item.saldo || 0), 0));
  const totalAdiantamentos = toMoney(adiantamentoAtual + saldoPendente);
  const saldoFinal = toMoney(totalDespesas - totalAdiantamentos);
  return {
    totalDespesas,
    adiantamentoAtual,
    adiantamentosAtuais: adiantamentosUtilizados.length ? adiantamentosUtilizados : adiantamentosAtuais,
    adiantamentosUtilizados,
    saldoPendente,
    totalAdiantamentos,
    saldoFinal,
    saldoLabel: saldoFinal < 0 ? "Saldo a devolver" : "Saldo a reembolsar",
    saldoValor: Math.abs(saldoFinal),
    saldosPendentes
  };
}

function renderReembolsoReport({ prestacao, despesas, aprovacoes, comprovantes = [], resumoFinanceiro = null, historico = [] }) {
  const totalPorTipo = new Map();
  for (const despesa of despesas) {
    const tipo = despesa.tipo || "Outros";
    totalPorTipo.set(tipo, toMoney((totalPorTipo.get(tipo) || 0) + toMoney(despesa.valor)));
  }
  const geradoEm = new Date().toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  const statusLabel = String(prestacao.status || "").replaceAll("_", " ");
  const favorecidoNome = prestacao.razao_social || prestacao.prestador_nome || prestacao.solicitante;
  const favorecidoDoc = prestacao.cnpj || prestacao.cpf || "";
  const resumo = resumoFinanceiro || {
    totalDespesas: toMoney(prestacao.total_despesas),
    totalAdiantamentos: toMoney(prestacao.valor_adiantado),
    saldoLabel: "Saldo a reembolsar",
    saldoValor: toMoney(prestacao.valor_reembolsar),
    adiantamentosAtuais: [],
    saldosPendentes: []
  };
  const ajustesFinanceiros = historico.filter((item) => item.acao === "ajuste_valor_financeiro");
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(prestacao.numero)} | Relatório de Reembolso</title>
  <style>
    :root { --nav:#141923; --brand:#002b5f; --line:#d7dde6; --muted:#657184; --text:#0b1726; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #eef2f6; color: var(--text); font-family: "Segoe UI", Arial, sans-serif; }
    .page { width: min(1180px, calc(100% - 32px)); margin: 22px auto; background: #fff; box-shadow: 0 18px 55px rgba(15,23,42,.12); }
    .hero { background: var(--nav); color: #fff; padding: 26px 30px; display: grid; grid-template-columns: 240px 1fr 210px; gap: 24px; align-items: center; }
    .logo { display: flex; align-items: center; gap: 12px; }
    .mark { width: 48px; height: 48px; border: 4px solid #fff; display: grid; place-items: center; font-size: 28px; font-weight: 900; }
    .logo strong { display: block; font-size: 30px; line-height: 1; }
    .logo span, .hero small { color: #dbe4ef; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; font-weight: 700; }
    .hero h1 { margin: 4px 0 0; font-size: 28px; line-height: 1.08; }
    .hero h2 { margin: 6px 0 0; font-size: 17px; font-weight: 500; color: #e7eef7; }
    .hero-meta { text-align: right; display: grid; gap: 10px; }
    .hero-meta strong { display: block; font-size: 20px; }
    .status { display: inline-flex; justify-self: end; border: 1px solid rgba(255,255,255,.25); padding: 6px 10px; border-radius: 999px; text-transform: uppercase; font-size: 12px; font-weight: 800; }
    .summary { display: grid; grid-template-columns: repeat(3, 1fr); border-bottom: 1px solid var(--line); }
    .summary div { padding: 16px 18px; border-right: 1px solid var(--line); }
    .summary div:last-child { border-right: 0; }
    .label { display: block; color: var(--muted); text-transform: uppercase; font-size: 12px; font-weight: 900; letter-spacing: .04em; }
    .value { display: block; margin-top: 6px; font-size: 21px; font-weight: 900; }
    .section { padding: 20px 26px; border-bottom: 1px solid var(--line); }
    .section-head { display: flex; justify-content: space-between; align-items: end; gap: 20px; margin-bottom: 12px; }
    h3 { margin: 0; font-size: 20px; }
    .meta-grid { display: grid; grid-template-columns: 160px 1fr 160px 1fr; border: 1px solid var(--line); }
    .meta-grid div { padding: 10px 12px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); min-height: 42px; }
    .meta-grid div:nth-child(4n) { border-right: 0; }
    .meta-grid div:nth-last-child(-n+4) { border-bottom: 0; }
    .meta-label { background: #f3f6f9; font-weight: 900; text-transform: uppercase; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { background: #f3f6f9; color: #344054; text-transform: uppercase; font-size: 12px; letter-spacing: .03em; }
    th, td { border: 1px solid var(--line); padding: 10px 11px; text-align: left; vertical-align: top; }
    td.money, th.money { text-align: right; white-space: nowrap; }
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    .totals-table td:last-child { text-align: right; font-weight: 800; }
    .approval-ok { font-weight: 900; color: #065f46; }
    .receipt-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .receipt-card { border: 1px solid var(--line); break-inside: avoid; background: #fff; }
    .receipt-info { display: grid; gap: 3px; padding: 10px 12px; background: #f3f6f9; border-bottom: 1px solid var(--line); }
    .receipt-info span, .receipt-info small { color: var(--muted); }
    .receipt-card img { display: block; width: 100%; max-height: 520px; object-fit: contain; background: #fff; }
    .receipt-file { padding: 28px; text-align: center; color: var(--muted); }
    .footer { padding: 16px 26px 24px; display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; }
    @media print { body { background: #fff; } .page { width: 100%; margin: 0; box-shadow: none; } }
  </style>
</head>
<body>
  <main class="page">
    <header class="hero">
      <div class="logo"><div class="mark">R</div><div><strong>redefrete</strong><span>Reembolso de despesas</span></div></div>
      <div><small>Relatório corporativo</small><h1>${escapeHtml(prestacao.numero)} - ${escapeHtml(favorecidoNome)}</h1><h2>${escapeHtml(prestacao.finalidade || "Prestação de contas")}</h2></div>
      <div class="hero-meta"><div><small>Período</small><strong>${formatDate(prestacao.data_inicio)} a ${formatDate(prestacao.data_fim)}</strong></div><span class="status">${escapeHtml(statusLabel)}</span></div>
    </header>
    <section class="summary">
      <div><span class="label">Despesas</span><span class="value">${formatMoney(prestacao.total_despesas)}</span></div>
      <div><span class="label">Adiantamento atual e pendentes</span><span class="value">${formatMoney(resumo.totalAdiantamentos)}</span></div>
      <div><span class="label">${escapeHtml(resumo.saldoLabel)}</span><span class="value">${formatMoney(resumo.saldoValor)}</span></div>
    </section>
    <section class="section">
      <div class="section-head"><h3>Dados da prestação</h3><span class="label">Gerado em ${escapeHtml(geradoEm)}</span></div>
      <div class="meta-grid">
        <div class="meta-label">Solicitante</div><div>${escapeHtml(prestacao.solicitante)}</div>
        <div class="meta-label">E-mail</div><div>${escapeHtml(prestacao.email)}</div>
        <div class="meta-label">Banco</div><div>${escapeHtml(prestacao.banco || "")}</div>
        <div class="meta-label">Agência / Conta</div><div>${escapeHtml([prestacao.agencia, prestacao.conta].filter(Boolean).join(" / "))}</div>
        <div class="meta-label">Departamento</div><div>${escapeHtml(prestacao.departamento || "")}</div>
        <div class="meta-label">Status do processo</div><div>${escapeHtml(statusLabel)}</div>
        <div class="meta-label">Pagamento previsto</div><div>${formatDate(prestacao.data_pagamento_prevista)}</div>
      </div>
    </section>
    <section class="section two-col">
      <div><div class="section-head"><h3>Resumo por tipo</h3></div><table class="totals-table"><tbody>
        ${[...totalPorTipo.entries()].map(([tipo, total]) => `<tr><td>${escapeHtml(tipo)}</td><td>${formatMoney(total)}</td></tr>`).join("") || `<tr><td colspan="2">Sem despesas lançadas</td></tr>`}
        <tr><td><strong>Total</strong></td><td><strong>${formatMoney(prestacao.total_despesas)}</strong></td></tr>
      </tbody></table></div>
      <div><div class="section-head"><h3>Resultado financeiro</h3></div><table class="totals-table"><tbody>
        ${resumo.adiantamentosAtuais?.length
          ? resumo.adiantamentosAtuais.map((item) => `<tr><td>Adiantamento ${escapeHtml(item.numero || "")} de ${formatDate(item.data_adiantamento)}</td><td>${formatMoney(item.saldo)}</td></tr>`).join("")
          : `<tr><td>Adiantamento atual</td><td>${formatMoney(resumo.adiantamentoAtual || 0)}</td></tr>`}
        ${resumo.saldosPendentes?.map((item) => `<tr><td>Saldo pendente ${escapeHtml(item.numero || "")} de ${formatDate(item.data_adiantamento)}</td><td>${formatMoney(item.saldo)}</td></tr>`).join("") || ""}
        <tr><td>Adiantamento atual e pendentes</td><td>${formatMoney(resumo.totalAdiantamentos)}</td></tr>
        <tr><td>Total comprovado</td><td>${formatMoney(prestacao.total_despesas)}</td></tr>
        <tr><td>${escapeHtml(resumo.saldoLabel)}</td><td>${formatMoney(resumo.saldoValor)}</td></tr>
      </tbody></table></div>
    </section>
    ${ajustesFinanceiros.length ? `<section class="section">
      <div class="section-head"><h3>Ajustes financeiros</h3><span class="label">Alterações após aprovação</span></div>
      <table><thead><tr><th>Data</th><th>Responsável</th><th>Justificativa</th></tr></thead><tbody>
        ${ajustesFinanceiros.map((item) => `<tr><td>${formatDateTime(item.created_at)}</td><td>${escapeHtml(item.usuario || "")}</td><td>${escapeHtml(item.descricao || "")}</td></tr>`).join("")}
      </tbody></table>
    </section>` : ""}
    <section class="section">
      <div class="section-head"><h3>Despesas</h3><span class="label">${despesas.length} item(ns)</span></div>
      <table><thead><tr><th>Data</th><th>Tipo</th><th>Descrição</th><th>Rota/KM</th><th class="money">Valor</th></tr></thead><tbody>
        ${despesas.map((d) => `<tr><td>${formatDate(d.data_despesa)}</td><td>${escapeHtml(d.tipo)}</td><td>${escapeHtml(d.descricao)}</td><td>${escapeHtml([d.origem, d.destino].filter(Boolean).join(" -> "))}${Number(d.exige_km) ? `<br><small>${escapeHtml(d.quantidade_km || 0)} km</small>` : ""}</td><td class="money">${formatMoney(d.valor)}</td></tr>`).join("") || `<tr><td colspan="5">Nenhuma despesa lançada.</td></tr>`}
      </tbody></table>
    </section>
    <section class="section">
      <div class="section-head"><h3>Comprovantes</h3><span class="label">${comprovantes.length} anexo(s)</span></div>
      <div class="receipt-grid">
        ${comprovantes.map(renderComprovanteReportItem).join("") || `<div class="receipt-file">Nenhum comprovante anexado.</div>`}
      </div>
    </section>
    <section class="section">
      <div class="section-head"><h3>Aprovações</h3><span class="label">${aprovacoes.length ? "Fluxo registrado" : "Sem aprovações"}</span></div>
      <table><thead><tr><th>Etapa</th><th>Aprovador</th><th>E-mail</th><th>Data</th><th>Autenticação</th></tr></thead><tbody>
        ${aprovacoes.map((a) => `<tr><td>${escapeHtml(a.etapa)}</td><td>${escapeHtml(a.usuario)}</td><td>${escapeHtml(a.email)}</td><td>${formatDateTime(a.created_at)}</td><td class="approval-ok">${escapeHtml(a.autenticacao)}</td></tr>`).join("") || `<tr><td colspan="5">Aguardando aprovações.</td></tr>`}
      </tbody></table>
    </section>
    <footer class="footer"><span>Redefrete Logística | Reembolso de Despesas</span><span>${escapeHtml(prestacao.numero)}</span></footer>
  </main>
</body>
</html>`;
}

async function graphAccessToken() {
  const url = `https://login.microsoftonline.com/${process.env.GRAPH_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: process.env.GRAPH_CLIENT_ID,
    client_secret: process.env.GRAPH_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials"
  });
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.error || "Nao foi possivel autenticar no Microsoft Graph.");
  return data.access_token;
}

async function sendGraphMail({ to, subject, html }) {
  if (!emailConfigured()) return { skipped: true, reason: "E-mail nao configurado." };
  const token = await graphAccessToken();
  const recipients = String(to || "").split(/[;,]/).map((item) => item.trim()).filter(Boolean);
  if (!recipients.length) return { skipped: true, reason: "Sem destinatarios." };
  const response = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(process.env.GRAPH_FROM)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "HTML", content: html },
        toRecipients: recipients.map((address) => ({ emailAddress: { address } }))
      },
      saveToSentItems: true
    })
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail?.error?.message || `Microsoft Graph retornou HTTP ${response.status}.`);
  }
  return { sent: true, to: recipients };
}

async function sendReembolsoApprovalEmails({ titulo, detalhe, link, emails, prestacaoId }) {
  return sendReembolsoApprovalEmailsTo({ titulo, detalhe, link, emails: emails || REEMBOLSO_APPROVAL_FLOW.map((item) => item.email), prestacaoId });
}

async function sendReembolsoApprovalEmailsTo({ titulo, detalhe, link, emails, prestacaoId }) {
  const normalizedEmails = (emails || []).map((email) => String(email || "").toLowerCase()).filter(Boolean);
  if (!normalizedEmails.length) return [];
  const aprovadores = await query(
    `SELECT MIN(nome) AS nome, LOWER(email) AS email
       FROM usuarios
      WHERE ativo = 1
        AND LOWER(email) IN (${normalizedEmails.map(() => "?").join(",")})
      GROUP BY LOWER(email)`,
    normalizedEmails
  );
  const results = [];
  for (const aprovador of aprovadores) {
    try {
      const safeLink = publicUrl(link);
      const demonstrativo = prestacaoId ? await reembolsoPrestacaoEmailDemonstrativo(prestacaoId, aprovador.email) : "";
      const approveLink = prestacaoId ? emailActionUrl({ kind: "reembolso_prestacao", action: "aprovar", id: Number(prestacaoId), email: aprovador.email }) : "";
      const rejectLinks = prestacaoId ? [
        ["Comprovante divergente", "Comprovante divergente"],
        ["Valor divergente", "Valor divergente"],
        ["Despesa fora da política", "Despesa fora da politica"]
      ].map(([label, reason]) => {
        const url = emailActionUrl({ kind: "reembolso_prestacao", action: "reprovar", id: Number(prestacaoId), email: aprovador.email, reason });
        return `<a href="${escapeHtml(url)}" style="display:inline-block;margin:0 8px 8px 0;background:#fff4f4;color:#991b1b;border:1px solid #f3b4b4;text-decoration:none;padding:10px 12px;border-radius:4px;font-weight:700">${escapeHtml(label)}</a>`;
      }).join("") : "";
      const html = `
        <p>Ola, ${escapeHtml(aprovador.nome)}.</p>
        <p>${escapeHtml(detalhe)}</p>
        ${prestacaoId ? `
          <div style="margin:16px 0">
            <a href="${escapeHtml(approveLink)}" style="display:inline-block;margin:0 8px 8px 0;background:#057a55;color:#fff;text-decoration:none;padding:12px 16px;border-radius:4px;font-weight:800">Aprovar</a>
            ${rejectLinks}
          </div>
          <p style="font-size:12px;color:#667085;margin-top:-6px">Ao clicar, o sistema registra sua decisão e gera a autenticação da aprovação ou recusa.</p>
        ` : ""}
        <div style="margin:16px 0;padding:14px;border:1px solid #d7dde6;border-radius:6px;background:#f8fafc">
          <strong style="display:block;margin-bottom:10px;color:#0b1726">Resumo para aprovacao</strong>
          <table style="width:100%;border-collapse:collapse;font-family:Segoe UI,Arial,sans-serif;font-size:13px">
            <tr><td style="width:110px;padding:7px;border-top:1px solid #e5e7eb;color:#667085;font-weight:700">Processo</td><td style="padding:7px;border-top:1px solid #e5e7eb;color:#0b1726">${escapeHtml(titulo)}</td></tr>
            <tr><td style="width:110px;padding:7px;border-top:1px solid #e5e7eb;color:#667085;font-weight:700">Detalhe</td><td style="padding:7px;border-top:1px solid #e5e7eb;color:#0b1726">${escapeHtml(detalhe)}</td></tr>
            <tr><td style="width:110px;padding:7px;border-top:1px solid #e5e7eb;color:#667085;font-weight:700">Link</td><td style="padding:7px;border-top:1px solid #e5e7eb;color:#0b1726">${escapeHtml(safeLink)}</td></tr>
          </table>
        </div>
        ${demonstrativo}
        <p><a href="${escapeHtml(safeLink)}" style="display:inline-block;background:#002b5f;color:#fff;text-decoration:none;padding:10px 14px;border-radius:4px;font-weight:700">${escapeHtml(titulo)}</a></p>
      `;
      results.push(await sendGraphMail({ to: aprovador.email, subject: titulo, html }));
    } catch (error) {
      results.push({ to: aprovador.email, error: error.message });
    }
  }
  return results;
}

async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function execute(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return result;
}

async function ensureSchema() {
  await execute(`
    CREATE TABLE IF NOT EXISTS rd_reembolso_usuarios (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      nome VARCHAR(160) NOT NULL,
      email VARCHAR(180) NOT NULL UNIQUE,
      perfil VARCHAR(40) NOT NULL DEFAULT 'solicitante',
      superior_id BIGINT NULL,
      ativo TINYINT NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS rd_reembolso_tipos_despesa (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      nome VARCHAR(120) NOT NULL,
      codigo VARCHAR(60) NULL,
      exige_comprovante TINYINT NOT NULL DEFAULT 1,
      exige_km TINYINT NOT NULL DEFAULT 0,
      ativo TINYINT NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS rd_reembolso_centros_custo (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      nome VARCHAR(160) NOT NULL,
      codigo VARCHAR(60) NULL,
      unidade VARCHAR(120) NULL,
      ativo TINYINT NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS rd_reembolso_adiantamentos (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      numero VARCHAR(40) NOT NULL UNIQUE,
      solicitante_id BIGINT NOT NULL,
      superior_id BIGINT NULL,
      data_adiantamento DATE NOT NULL,
      valor DECIMAL(15,2) NOT NULL DEFAULT 0,
      descritivo TEXT NULL,
      finalidade TEXT NULL,
      centro_custo_id BIGINT NULL,
      status VARCHAR(40) NOT NULL DEFAULT 'aberto',
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      INDEX idx_rr_ad_solicitante (solicitante_id),
      INDEX idx_rr_ad_status (status),
      INDEX idx_rr_ad_data (data_adiantamento)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS rd_reembolso_prestacoes (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      numero VARCHAR(40) NOT NULL UNIQUE,
      adiantamento_id BIGINT NULL,
      solicitante_id BIGINT NOT NULL,
      superior_id BIGINT NULL,
      financeiro_id BIGINT NULL,
      centro_custo_id BIGINT NULL,
      finalidade TEXT NULL,
      data_inicio DATE NOT NULL,
      data_fim DATE NOT NULL,
      valor_adiantado DECIMAL(15,2) NOT NULL DEFAULT 0,
      total_despesas DECIMAL(15,2) NOT NULL DEFAULT 0,
      saldo_devolver DECIMAL(15,2) NOT NULL DEFAULT 0,
      valor_reembolsar DECIMAL(15,2) NOT NULL DEFAULT 0,
      status VARCHAR(40) NOT NULL DEFAULT 'rascunho',
      motivo_reprovacao TEXT NULL,
      enviado_em DATETIME NULL,
      aprovado_superior_em DATETIME NULL,
      data_pagamento_prevista DATE NULL,
      finalizado_em DATETIME NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      INDEX idx_rr_pr_numero (numero),
      INDEX idx_rr_pr_solicitante (solicitante_id),
      INDEX idx_rr_pr_superior (superior_id),
      INDEX idx_rr_pr_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS rd_reembolso_despesas (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      prestacao_id BIGINT NOT NULL,
      tipo_despesa_id BIGINT NOT NULL,
      data_despesa DATE NOT NULL,
      descricao TEXT NOT NULL,
      valor DECIMAL(15,2) NOT NULL DEFAULT 0,
      origem VARCHAR(220) NULL,
      destino VARCHAR(220) NULL,
      quantidade_km DECIMAL(10,2) NOT NULL DEFAULT 0,
      valor_km DECIMAL(10,2) NOT NULL DEFAULT 0,
      status_comprovante VARCHAR(40) NOT NULL DEFAULT 'pendente',
      observacao TEXT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      INDEX idx_rr_de_prestacao (prestacao_id),
      INDEX idx_rr_de_tipo (tipo_despesa_id),
      INDEX idx_rr_de_data (data_despesa)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS rd_reembolso_comprovantes (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      despesa_id BIGINT NOT NULL,
      nome_original VARCHAR(255) NOT NULL,
      caminho_arquivo VARCHAR(500) NOT NULL,
      mime_type VARCHAR(120) NULL,
      tamanho_bytes BIGINT NOT NULL DEFAULT 0,
      ocr_status VARCHAR(40) NOT NULL DEFAULT 'pendente',
      ocr_texto LONGTEXT NULL,
      ocr_cnpj VARCHAR(20) NULL,
      ocr_data DATE NULL,
      ocr_valor DECIMAL(15,2) NULL,
      ocr_numero_documento VARCHAR(100) NULL,
      created_at DATETIME NOT NULL,
      INDEX idx_rr_co_despesa (despesa_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS rd_reembolso_aprovacoes (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      prestacao_id BIGINT NOT NULL,
      usuario_id BIGINT NOT NULL,
      etapa VARCHAR(40) NOT NULL,
      decisao VARCHAR(40) NOT NULL,
      justificativa TEXT NULL,
      autenticacao VARCHAR(60) NOT NULL,
      created_at DATETIME NOT NULL,
      INDEX idx_rr_ap_prestacao (prestacao_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS rd_reembolso_historico (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      prestacao_id BIGINT NULL,
      usuario_id BIGINT NULL,
      acao VARCHAR(100) NOT NULL,
      descricao TEXT NULL,
      dados_json JSON NULL,
      created_at DATETIME NOT NULL,
      INDEX idx_rr_hi_prestacao (prestacao_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS rd_reembolso_conta_corrente (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      solicitante_id BIGINT NOT NULL,
      prestacao_id BIGINT NULL,
      adiantamento_id BIGINT NULL,
      tipo VARCHAR(40) NOT NULL,
      data_movimento DATE NOT NULL,
      valor DECIMAL(15,2) NOT NULL DEFAULT 0,
      numero_documento VARCHAR(80) NULL,
      descricao TEXT NULL,
      omie_codigo_lancamento BIGINT NULL,
      omie_codigo_integracao VARCHAR(80) NULL,
      omie_status VARCHAR(40) NOT NULL DEFAULT 'interno',
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      INDEX idx_rr_cc_solicitante (solicitante_id),
      INDEX idx_rr_cc_data (data_movimento),
      INDEX idx_rr_cc_prestacao (prestacao_id),
      INDEX idx_rr_cc_adiantamento (adiantamento_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS rd_reembolso_configuracoes (
      chave VARCHAR(100) PRIMARY KEY,
      valor TEXT NULL,
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS rd_reembolso_descricoes_despesa (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      tipo_despesa_id BIGINT NULL,
      descricao VARCHAR(180) NOT NULL,
      contexto VARCHAR(180) NOT NULL,
      vezes_usada INT NOT NULL DEFAULT 1,
      ultimo_uso DATETIME NOT NULL,
      created_at DATETIME NOT NULL,
      UNIQUE KEY uq_rr_desc_contexto (tipo_despesa_id, contexto),
      KEY idx_rr_desc_contexto (contexto)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS sessoes (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      usuario_id INT NOT NULL,
      token_hash CHAR(64) NOT NULL,
      expira_em DATETIME NOT NULL,
      criada_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_sessoes_token (token_hash),
      KEY idx_sessoes_expira (expira_em)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await addColumnIfMissing("rd_reembolso_adiantamentos", "aprovado_por", "aprovado_por BIGINT NULL AFTER status");
  await addColumnIfMissing("rd_reembolso_adiantamentos", "aprovado_em", "aprovado_em DATETIME NULL AFTER aprovado_por");
  await addColumnIfMissing("rd_reembolso_adiantamentos", "motivo_reprovacao", "motivo_reprovacao TEXT NULL AFTER aprovado_em");
  await addColumnIfMissing("rd_reembolso_adiantamentos", "omie_status", "omie_status VARCHAR(40) NOT NULL DEFAULT 'pendente' AFTER motivo_reprovacao");
  await addColumnIfMissing("rd_reembolso_adiantamentos", "prestacao_id", "prestacao_id BIGINT NULL AFTER omie_status");
  await addColumnIfMissing("rd_reembolso_adiantamentos", "omie_codigo_lancamento", "omie_codigo_lancamento BIGINT NULL AFTER omie_status");
  await addColumnIfMissing("rd_reembolso_adiantamentos", "omie_codigo_integracao", "omie_codigo_integracao VARCHAR(80) NULL AFTER omie_codigo_lancamento");
  await addColumnIfMissing("rd_reembolso_adiantamentos", "omie_erro", "omie_erro TEXT NULL AFTER omie_codigo_integracao");
  await addColumnIfMissing("rd_reembolso_adiantamentos", "omie_anexos_status", "omie_anexos_status VARCHAR(40) NOT NULL DEFAULT 'pendente' AFTER omie_erro");
  await addColumnIfMissing("rd_reembolso_adiantamentos", "omie_anexos_erro", "omie_anexos_erro TEXT NULL AFTER omie_anexos_status");
  await addColumnIfMissing("rd_reembolso_adiantamentos", "omie_anexos_em", "omie_anexos_em DATETIME NULL AFTER omie_anexos_erro");
  await addColumnIfMissing("rd_reembolso_prestacoes", "omie_status", "omie_status VARCHAR(40) NOT NULL DEFAULT 'pendente' AFTER status");
  await addColumnIfMissing("rd_reembolso_prestacoes", "omie_codigo_lancamento", "omie_codigo_lancamento BIGINT NULL AFTER omie_status");
  await addColumnIfMissing("rd_reembolso_prestacoes", "omie_codigo_integracao", "omie_codigo_integracao VARCHAR(80) NULL AFTER omie_codigo_lancamento");
  await addColumnIfMissing("rd_reembolso_prestacoes", "omie_erro", "omie_erro TEXT NULL AFTER omie_codigo_integracao");
  await addColumnIfMissing("rd_reembolso_prestacoes", "omie_compensacao_status", "omie_compensacao_status VARCHAR(40) NOT NULL DEFAULT 'pendente' AFTER omie_erro");
  await addColumnIfMissing("rd_reembolso_prestacoes", "omie_compensacao_erro", "omie_compensacao_erro TEXT NULL AFTER omie_compensacao_status");
  await addColumnIfMissing("rd_reembolso_prestacoes", "omie_compensacao_valor", "omie_compensacao_valor DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER omie_compensacao_erro");
  await addColumnIfMissing("rd_reembolso_prestacoes", "omie_anexos_status", "omie_anexos_status VARCHAR(40) NOT NULL DEFAULT 'pendente' AFTER omie_erro");
  await addColumnIfMissing("rd_reembolso_prestacoes", "omie_anexos_erro", "omie_anexos_erro TEXT NULL AFTER omie_anexos_status");
  await addColumnIfMissing("rd_reembolso_prestacoes", "omie_anexos_em", "omie_anexos_em DATETIME NULL AFTER omie_anexos_erro");
  await addColumnIfMissing("rd_reembolso_prestacoes", "omie_status_titulo", "omie_status_titulo VARCHAR(80) NULL AFTER omie_anexos_em");
  await addColumnIfMissing("rd_reembolso_prestacoes", "omie_valor_pago", "omie_valor_pago DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER omie_status_titulo");
  await addColumnIfMissing("rd_reembolso_prestacoes", "omie_pago_em", "omie_pago_em DATE NULL AFTER omie_valor_pago");
  await addColumnIfMissing("rd_reembolso_prestacoes", "omie_sincronizado_em", "omie_sincronizado_em DATETIME NULL AFTER omie_pago_em");
  await addColumnIfMissing("rd_reembolso_prestacoes", "data_pagamento_prevista", "data_pagamento_prevista DATE NULL AFTER aprovado_superior_em");
  await addColumnIfMissing("rd_reembolso_prestacoes", "ajuste_financeiro_justificativa", "ajuste_financeiro_justificativa TEXT NULL AFTER motivo_reprovacao");
  await addColumnIfMissing("rd_reembolso_prestacoes", "ajuste_financeiro_em", "ajuste_financeiro_em DATETIME NULL AFTER ajuste_financeiro_justificativa");
  await addColumnIfMissing("rd_reembolso_prestacoes", "ajuste_financeiro_por", "ajuste_financeiro_por BIGINT NULL AFTER ajuste_financeiro_em");
  await addColumnIfMissing("rd_reembolso_comprovantes", "nf_chave_acesso", "nf_chave_acesso VARCHAR(60) NULL AFTER tamanho_bytes");
  await addColumnIfMissing("rd_reembolso_comprovantes", "nf_numero", "nf_numero VARCHAR(30) NULL AFTER nf_chave_acesso");
  await addColumnIfMissing("rd_reembolso_comprovantes", "nf_data_emissao", "nf_data_emissao DATE NULL AFTER nf_numero");
  await addColumnIfMissing("rd_reembolso_comprovantes", "nf_valor", "nf_valor DECIMAL(15,2) NULL AFTER nf_data_emissao");
  await addColumnIfMissing("rd_reembolso_comprovantes", "nf_qr_url", "nf_qr_url TEXT NULL AFTER nf_valor");
  await addColumnIfMissing("rd_reembolso_comprovantes", "nf_consulta_status", "nf_consulta_status VARCHAR(40) NULL AFTER nf_qr_url");
  await addColumnIfMissing("rd_reembolso_comprovantes", "nf_divergencias", "nf_divergencias TEXT NULL AFTER nf_consulta_status");
  await addColumnIfMissing("usuarios", "prestador_id", "prestador_id INT NULL AFTER permissoes_json");
  await execute("ALTER TABLE usuarios MODIFY senha_hash VARCHAR(255) NULL");

  await seedDefaults();
}

async function addColumnIfMissing(table, column, ddl) {
  const rows = await query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
    [table, column]
  );
  if (!rows.length) await execute(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

async function seedDefaults() {
  const stamp = nowSql();
  const users = await query("SELECT COUNT(*) AS total FROM rd_reembolso_usuarios");
  if (!users[0].total) {
    await execute(
      "INSERT INTO rd_reembolso_usuarios (nome, email, perfil, created_at, updated_at) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)",
      [
        "Thiago Addono Roza", "thiago.addono@redefrete.com.br", "solicitante", stamp, stamp,
        "Gestor Demonstracao", "gestor@redefrete.com.br", "gestor", stamp, stamp,
        "Financeiro Redefrete", "financeiro@redefrete.com.br", "financeiro", stamp, stamp
      ]
    );
  }

  const tipos = await query("SELECT COUNT(*) AS total FROM rd_reembolso_tipos_despesa");
  const defaultTiposDespesa = [
    ["Alimentacao", "ALIM", 1, 0],
    ["Conducao", "COND", 1, 0],
    ["Pedagio", "PED", 1, 0],
    ["Estacionamento", "EST", 1, 0],
    ["Hospedagem", "HOSP", 1, 0],
    ["Combustivel", "COMB", 1, 0],
    ["Quilometragem", "KM", 1, 1],
    ["Outros", "OUT", 1, 0]
  ];
  if (!tipos[0].total) {
    for (const item of defaultTiposDespesa) {
      await execute(
        "INSERT INTO rd_reembolso_tipos_despesa (nome, codigo, exige_comprovante, exige_km, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [...item, stamp, stamp]
      );
    }
  }

  await execute(
    "UPDATE rd_reembolso_tipos_despesa SET nome = ?, codigo = ?, updated_at = ? WHERE nome COLLATE utf8mb4_unicode_ci = ?",
    ["Alimentacao", "ALIM", stamp, "Refeicao"]
  );
  await execute(
    "UPDATE rd_reembolso_tipos_despesa SET nome = ?, codigo = ?, updated_at = ? WHERE nome COLLATE utf8mb4_unicode_ci = ?",
    ["Conducao", "COND", stamp, "Transporte"]
  );

  for (const item of defaultTiposDespesa) {
    const exists = await query("SELECT id FROM rd_reembolso_tipos_despesa WHERE nome COLLATE utf8mb4_unicode_ci = ? LIMIT 1", [item[0]]);
    if (!exists.length) {
      await execute(
        "INSERT INTO rd_reembolso_tipos_despesa (nome, codigo, exige_comprovante, exige_km, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [...item, stamp, stamp]
      );
    }
  }
  await execute(
    `UPDATE rd_reembolso_tipos_despesa
        SET ativo = 0, updated_at = ?
      WHERE nome COLLATE utf8mb4_unicode_ci IN (?, ?)`,
    [stamp, "Reembolso de Despesas", "Reembolso de Despesas Hub"]
  );

  const centros = await query("SELECT COUNT(*) AS total FROM rd_reembolso_centros_custo");
  if (!centros[0].total) {
    await execute(
      "INSERT INTO rd_reembolso_centros_custo (nome, codigo, unidade, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["Administrativo", "ADM", "Redefrete", stamp, stamp]
    );
  }

  await execute(
    "INSERT IGNORE INTO rd_reembolso_configuracoes (chave, valor, updated_at) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)",
    ["valor_km", "0.65", stamp, "prazo_prestacao_dias", "5", stamp, "exigir_comprovante_todos", "1", stamp]
  );
}

async function nextNumber(prefix, table) {
  const year = new Date().getFullYear();
  const rows = await query(`SELECT COUNT(*) AS total FROM ${table} WHERE numero LIKE ?`, [`${prefix}-${year}-%`]);
  return `${prefix}-${year}-${String(Number(rows[0].total || 0) + 1).padStart(5, "0")}`;
}

async function recalcPrestacao(id) {
  const rows = await query("SELECT COALESCE(SUM(valor), 0) AS total FROM rd_reembolso_despesas WHERE prestacao_id = ?", [id]);
  const prestacoes = await query("SELECT valor_adiantado FROM rd_reembolso_prestacoes WHERE id = ?", [id]);
  if (!prestacoes.length) return null;
  const total = toMoney(rows[0].total);
  const adiantado = toMoney(prestacoes[0].valor_adiantado);
  const saldo = toMoney(Math.max(adiantado - total, 0));
  const reembolso = toMoney(Math.max(total - adiantado, 0));
  await execute(
    "UPDATE rd_reembolso_prestacoes SET total_despesas = ?, saldo_devolver = ?, valor_reembolsar = ?, updated_at = ? WHERE id = ?",
    [total, saldo, reembolso, nowSql(), id]
  );
  return { total_despesas: total, saldo_devolver: saldo, valor_reembolsar: reembolso };
}

async function upsertContaCorrenteMovimento({ solicitanteId, prestacaoId = null, adiantamentoId = null, tipo, dataMovimento, valor, numeroDocumento, descricao, omieCodigoLancamento = null, omieCodigoIntegracao = null, omieStatus = "interno" }) {
  const existing = tipo === "devolucao" ? [] : await query(
      `SELECT id FROM rd_reembolso_conta_corrente
        WHERE tipo = ?
          AND COALESCE(prestacao_id, 0) = COALESCE(?, 0)
          AND COALESCE(adiantamento_id, 0) = COALESCE(?, 0)
        LIMIT 1`,
      [tipo, prestacaoId, adiantamentoId]
    );
  const stamp = nowSql();
  const signedValue = toMoney(valor);
  if (existing.length) {
    await execute(
      `UPDATE rd_reembolso_conta_corrente
          SET solicitante_id = ?, data_movimento = ?, valor = ?, numero_documento = ?, descricao = ?,
              omie_codigo_lancamento = COALESCE(?, omie_codigo_lancamento),
              omie_codigo_integracao = COALESCE(?, omie_codigo_integracao),
              omie_status = ?, updated_at = ?
        WHERE id = ?`,
      [solicitanteId, dataMovimento, signedValue, numeroDocumento || null, descricao || null, omieCodigoLancamento, omieCodigoIntegracao, omieStatus, stamp, existing[0].id]
    );
    return existing[0].id;
  }
  const result = await execute(
    `INSERT INTO rd_reembolso_conta_corrente
     (solicitante_id, prestacao_id, adiantamento_id, tipo, data_movimento, valor, numero_documento, descricao,
      omie_codigo_lancamento, omie_codigo_integracao, omie_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [solicitanteId, prestacaoId, adiantamentoId, tipo, dataMovimento, signedValue, numeroDocumento || null, descricao || null, omieCodigoLancamento, omieCodigoIntegracao, omieStatus, stamp, stamp]
  );
  return result.insertId;
}

async function saldoAdiantamentoSolicitante(solicitanteId) {
  const rows = await query(
    `SELECT COALESCE(SUM(valor), 0) AS saldo
       FROM rd_reembolso_conta_corrente
      WHERE solicitante_id = ?`,
    [solicitanteId]
  );
  return toMoney(rows[0]?.saldo || 0);
}

async function saldoAdiantamentoPorId(adiantamentoId) {
  const rows = await query(
    `SELECT COALESCE(SUM(valor), 0) AS saldo
       FROM rd_reembolso_conta_corrente
      WHERE adiantamento_id = ?`,
    [adiantamentoId]
  );
  return toMoney(rows[0]?.saldo || 0);
}

async function movimentosAdiantamentoResumo(solicitanteId = null) {
  const params = [];
  const where = solicitanteId ? "WHERE m.solicitante_id = ?" : "";
  if (solicitanteId) params.push(solicitanteId);
  return query(
    `SELECT m.*, u.nome AS solicitante,
            a.numero AS adiantamento_numero,
            a.data_adiantamento,
            p.numero AS prestacao_numero
       FROM rd_reembolso_conta_corrente m
       JOIN usuarios u ON u.id = m.solicitante_id
       LEFT JOIN rd_reembolso_adiantamentos a ON a.id = m.adiantamento_id
       LEFT JOIN rd_reembolso_prestacoes p ON p.id = m.prestacao_id
      ${where}
      ORDER BY m.data_movimento DESC, m.id DESC
      LIMIT 500`,
    params
  );
}

function omieTransferenciaAdiantamentoCode(adiantamento) {
  return `RAD${adiantamento.id}`.slice(0, 20);
}

function omieBaixaAdiantamentoCode(prestacao) {
  return `RBC${prestacao.id}`.slice(0, 20);
}

function omieBaixaAdiantamentoCodeFor(prestacao, adiantamento) {
  return `RBC${prestacao.id}A${adiantamento?.id || 0}`.slice(0, 20);
}

async function integrarOmieTransferenciaAdiantamento(adiantamento) {
  const contaOrigemId = resolveConfiguredOmieContaCorrenteId();
  const contaDestinoId = resolveConfiguredOmieAdiantamentoContaId();
  if (!contaOrigemId || !contaDestinoId) {
    throw new Error("Configure OMIE_CONTA_CORRENTE_ID e OMIE_CONTA_ADIANTAMENTO_ID para integrar adiantamentos.");
  }
  const codigoCategoria = resolveConfiguredOmieTransferenciaCategoria();
  const codigoIntegracao = adiantamento.omie_codigo_integracao || omieTransferenciaAdiantamentoCode(adiantamento);
  const payload = {
    cCodIntLanc: codigoIntegracao,
    cabecalho: {
      nCodCC: contaOrigemId,
      dDtLanc: formatOmieDate(sqlDate(adiantamento.data_adiantamento)),
      nValorLanc: toMoney(adiantamento.valor)
    },
    detalhes: {
      cTipo: "TRA",
      cCodCateg: codigoCategoria,
      cNumDoc: String(adiantamento.numero || "").slice(0, 20),
      cObs: `Adiantamento de despesas ${adiantamento.numero}`
    },
    transferencia: {
      nCodCCDestino: contaDestinoId
    }
  };
  const retorno = await omieCall("https://app.omie.com.br/api/v1/financas/contacorrentelancamentos/", "IncluirLancCC", payload);
  const codigoLancamento = omieContaPagarId({ ...retorno, codigo_lancamento_omie: retorno?.nCodLanc }, adiantamento.omie_codigo_lancamento);
  await execute(
    "UPDATE rd_reembolso_adiantamentos SET omie_status = 'integrado', omie_codigo_lancamento = ?, omie_codigo_integracao = ?, omie_erro = NULL, updated_at = ? WHERE id = ?",
    [codigoLancamento, codigoIntegracao, nowSql(), adiantamento.id]
  );
  await upsertContaCorrenteMovimento({
    solicitanteId: adiantamento.solicitante_id,
    adiantamentoId: adiantamento.id,
    tipo: "adiantamento",
    dataMovimento: sqlDate(adiantamento.data_adiantamento),
    valor: toMoney(adiantamento.valor),
    numeroDocumento: adiantamento.numero,
    descricao: `Adiantamento de despesas ${adiantamento.numero}`,
    omieCodigoLancamento: codigoLancamento,
    omieCodigoIntegracao: codigoIntegracao,
    omieStatus: "integrado"
  });
  let anexos = [];
  if (codigoLancamento) {
    try {
      anexos = await enviarAnexoAdiantamentoOmie(adiantamento, codigoLancamento);
      await execute("UPDATE rd_reembolso_adiantamentos SET omie_anexos_status = 'integrado', omie_anexos_erro = NULL, omie_anexos_em = ? WHERE id = ?", [nowSql(), adiantamento.id]);
    } catch (error) {
      await execute("UPDATE rd_reembolso_adiantamentos SET omie_anexos_status = 'erro', omie_anexos_erro = ?, updated_at = ? WHERE id = ?", [error.message, nowSql(), adiantamento.id]);
      throw new Error(`Transferencia integrada, mas falhou ao enviar anexo: ${error.message}`);
    }
  }
  return { retorno, codigo_lancamento: codigoLancamento, codigo_integracao: codigoIntegracao, anexos };
}

async function compensarPrestacaoComAdiantamento(prestacao, contaPagarId, adiantamentoInformado = null) {
  const totalDespesas = toMoney(prestacao.total_despesas || 0);
  if (!totalDespesas || totalDespesas <= 0) return { valor: 0, skipped: true };
  const contaAdiantamentoId = resolveConfiguredOmieAdiantamentoContaId();
  if (!contaAdiantamentoId) throw new Error("Configure OMIE_CONTA_ADIANTAMENTO_ID para compensar adiantamentos no Omie.");
  const dataCompensacao = sqlDate(prestacao.created_at);
  const adiantamentos = [];
  const adiantamentoVinculado = adiantamentoInformado || (prestacao.adiantamento_id ? await getAdiantamento(prestacao.adiantamento_id) : null);
  const valorVinculado = toMoney(prestacao.valor_adiantado || 0);
  if (adiantamentoVinculado && valorVinculado > 0) {
    adiantamentos.push({ ...adiantamentoVinculado, saldo_compensar: valorVinculado });
  }
  const saldosPendentes = await query(
    `SELECT a.*, COALESCE(SUM(m.valor), 0) AS saldo_compensar
       FROM rd_reembolso_adiantamentos a
       JOIN rd_reembolso_conta_corrente m ON m.adiantamento_id = a.id
      WHERE a.solicitante_id = ?
        AND a.id <> COALESCE(?, 0)
        AND (
          COALESCE(a.prestacao_id, 0) = 0
          OR a.prestacao_id < ?
        )
      GROUP BY a.id
     HAVING saldo_compensar > 0.009
      ORDER BY a.data_adiantamento, a.id`,
    [prestacao.solicitante_id, prestacao.adiantamento_id || 0, prestacao.id]
  );
  adiantamentos.push(...saldosPendentes);
  let restante = totalDespesas;
  let totalCompensado = 0;
  const baixas = [];
  for (const adiantamento of adiantamentos) {
    const valorCompensar = toMoney(Math.min(restante, Number(adiantamento.saldo_compensar || 0)));
    if (!valorCompensar || valorCompensar <= 0) continue;
    const codigoBaixa = omieBaixaAdiantamentoCodeFor(prestacao, adiantamento);
    const adiantamentoNumero = adiantamento?.numero || "";
    const payload = {
      codigo_lancamento: Number(contaPagarId),
      codigo_baixa_integracao: codigoBaixa,
      codigo_conta_corrente: String(contaAdiantamentoId),
      valor: valorCompensar,
      desconto: 0,
      juros: 0,
      multa: 0,
      data: formatOmieDate(dataCompensacao),
      observacao: `Compensacao da prestacao ${prestacao.numero}${adiantamentoNumero ? ` no adiantamento ${adiantamentoNumero}` : ""}`
    };
    const retorno = await omieCall("https://app.omie.com.br/api/v1/financas/contapagar/", "LancarPagamento", payload);
    await upsertContaCorrenteMovimento({
      solicitanteId: prestacao.solicitante_id,
      prestacaoId: prestacao.id,
      adiantamentoId: adiantamento?.id || null,
      tipo: "compensacao_prestacao",
      dataMovimento: dataCompensacao,
      valor: -valorCompensar,
      numeroDocumento: adiantamentoNumero || prestacao.numero,
      descricao: `Compensacao de despesas ${prestacao.numero}${adiantamentoNumero ? ` no ${adiantamentoNumero}` : ""}`,
      omieCodigoLancamento: contaPagarId,
      omieCodigoIntegracao: codigoBaixa,
      omieStatus: "integrado"
    });
    totalCompensado = toMoney(totalCompensado + valorCompensar);
    restante = toMoney(restante - valorCompensar);
    baixas.push({ adiantamento_id: adiantamento.id, numero: adiantamentoNumero, valor: valorCompensar, retorno });
    if (restante <= 0) break;
  }
  await execute(
    "UPDATE rd_reembolso_prestacoes SET omie_compensacao_status = 'integrado', omie_compensacao_valor = ?, omie_compensacao_erro = NULL WHERE id = ?",
    [totalCompensado, prestacao.id]
  );
  return { valor: totalCompensado, baixas, skipped: totalCompensado <= 0 };
}

async function integrarOmieDevolucaoAdiantamento({ solicitanteId, adiantamentoId = null, valor, dataDevolucao, numeroDocumento, descricao }) {
  const contaOrigemId = resolveConfiguredOmieAdiantamentoContaId();
  const contaDestinoId = resolveConfiguredOmieContaCorrenteId();
  if (!contaOrigemId || !contaDestinoId) {
    throw new Error("Configure OMIE_CONTA_ADIANTAMENTO_ID e OMIE_CONTA_CORRENTE_ID para registrar devolucoes.");
  }
  const codigoCategoria = resolveConfiguredOmieTransferenciaCategoria();
  const doc = String(numeroDocumento || "").trim().slice(0, 20);
  const codigoIntegracao = `RDV${Date.now().toString().slice(-10)}`.slice(0, 20);
  const payload = {
    cCodIntLanc: codigoIntegracao,
    cabecalho: {
      nCodCC: contaOrigemId,
      dDtLanc: formatOmieDate(sqlDate(dataDevolucao)),
      nValorLanc: toMoney(valor)
    },
    detalhes: {
      cTipo: "TRA",
      cCodCateg: codigoCategoria,
      cNumDoc: doc,
      cObs: descricao || `Devolucao de saldo de adiantamento ${doc}`
    },
    transferencia: {
      nCodCCDestino: contaDestinoId
    }
  };
  const retorno = await omieCall("https://app.omie.com.br/api/v1/financas/contacorrentelancamentos/", "IncluirLancCC", payload);
  const codigoLancamento = omieContaPagarId({ ...retorno, codigo_lancamento_omie: retorno?.nCodLanc });
  await upsertContaCorrenteMovimento({
    solicitanteId,
    adiantamentoId,
    tipo: "devolucao",
    dataMovimento: sqlDate(dataDevolucao),
    valor: -toMoney(valor),
    numeroDocumento: doc,
    descricao: descricao || `Devolucao de saldo de adiantamento ${doc}`,
    omieCodigoLancamento: codigoLancamento,
    omieCodigoIntegracao: codigoIntegracao,
    omieStatus: "integrado"
  });
  return { retorno, codigo_lancamento: codigoLancamento, codigo_integracao: codigoIntegracao };
}

async function addHistory(prestacaoId, usuarioId, acao, descricao, data = null) {
  await execute(
    "INSERT INTO rd_reembolso_historico (prestacao_id, usuario_id, acao, descricao, dados_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [prestacaoId || null, usuarioId || null, acao, descricao || null, data ? JSON.stringify(data) : null, nowSql()]
  );
}

async function learnDescricao(tipoDespesaId, descricao) {
  const clean = String(descricao || "").replace(/\s+/g, " ").trim();
  if (!clean) return;
  const contexto = normalizeLookupText(clean);
  if (!contexto) return;
  await execute(
    `INSERT INTO rd_reembolso_descricoes_despesa (tipo_despesa_id, descricao, contexto, vezes_usada, ultimo_uso, created_at)
     VALUES (?, ?, ?, 1, ?, ?)
     ON DUPLICATE KEY UPDATE vezes_usada = vezes_usada + 1, ultimo_uso = VALUES(ultimo_uso)`,
    [tipoDespesaId || null, clean, contexto, nowSql(), nowSql()]
  );
}

function reembolsoApprovalStepForUser(user) {
  const email = String(user?.email || "").toLowerCase();
  return REEMBOLSO_APPROVAL_FLOW.find((item) => item.email === email) || null;
}

async function reembolsoApprovedFlowSteps(prestacaoId) {
  return query(
    `SELECT etapa, usuario_id
       FROM rd_reembolso_aprovacoes
      WHERE prestacao_id = ?
        AND decisao = 'aprovado'
        AND etapa IN (${REEMBOLSO_APPROVAL_FLOW.map(() => "?").join(",")})`,
    [prestacaoId, ...REEMBOLSO_APPROVAL_FLOW.map((item) => item.etapa)]
  );
}

async function nextReembolsoApprovalStep(prestacaoId) {
  const approved = await reembolsoApprovedFlowSteps(prestacaoId);
  const approvedEtapas = new Set(approved.map((item) => item.etapa));
  return REEMBOLSO_APPROVAL_FLOW.find((item) => !approvedEtapas.has(item.etapa)) || null;
}

async function aprovarPrestacaoReembolso(prestacaoId, user, justificativa = null) {
  const prestacao = await getPrestacao(prestacaoId);
  if (!prestacao) {
    const error = new Error("Prestacao nao encontrada.");
    error.statusCode = 404;
    throw error;
  }
  if (prestacao.status !== "enviada_superior") {
    const error = new Error("Prestacao nao esta aguardando aprovacao.");
    error.statusCode = 400;
    throw error;
  }
  const expectedStep = await nextReembolsoApprovalStep(prestacaoId);
  if (!expectedStep) {
    const error = new Error("Fluxo de aprovacao ja concluido.");
    error.statusCode = 400;
    throw error;
  }
  const userStep = reembolsoApprovalStepForUser(user);
  if (!userStep || userStep.etapa !== expectedStep.etapa) {
    const error = new Error(`Esta etapa esta aguardando ${expectedStep.nome}.`);
    error.statusCode = 403;
    throw error;
  }
  const existing = await query(
    "SELECT id FROM rd_reembolso_aprovacoes WHERE prestacao_id = ? AND usuario_id = ? AND decisao = 'aprovado' LIMIT 1",
    [prestacaoId, user.id]
  );
  if (existing.length) {
    const error = new Error("Este aprovador ja aprovou esta prestacao.");
    error.statusCode = 400;
    throw error;
  }
  const codigo = authCode("APR");
  const aprovadoEm = nowSql();
  await execute(
    "INSERT INTO rd_reembolso_aprovacoes (prestacao_id, usuario_id, etapa, decisao, justificativa, autenticacao, created_at) VALUES (?, ?, ?, 'aprovado', ?, ?, ?)",
    [prestacaoId, user.id, expectedStep.etapa, justificativa || null, codigo, aprovadoEm]
  );
  const nextStep = await nextReembolsoApprovalStep(prestacaoId);
  let dataPagamento = null;
  if (nextStep) {
    await execute("UPDATE rd_reembolso_prestacoes SET updated_at = ? WHERE id = ?", [aprovadoEm, prestacaoId]);
    const detalhe = await reembolsoPrestacaoEmailResumo(prestacaoId, "Uma prestacao de contas de reembolso avancou para sua etapa de aprovacao.");
    await sendReembolsoApprovalEmailsTo({
      titulo: `Prestação ${prestacao.numero || prestacaoId} aguardando aprovação`,
      detalhe,
      link: `${approvalCentralUrl()}?tipo=reembolso_superior&id=${encodeURIComponent(prestacaoId)}`,
      emails: [nextStep.email],
      prestacaoId
    });
  } else {
    try {
      dataPagamento = calcularDataPagamentoReembolso(prestacao.created_at, aprovadoEm) || fallbackDataPagamentoReembolso();
    } catch {
      dataPagamento = fallbackDataPagamentoReembolso();
    }
    await execute(
      "UPDATE rd_reembolso_prestacoes SET status = 'em_validacao_financeira', aprovado_superior_em = ?, data_pagamento_prevista = ?, updated_at = ? WHERE id = ?",
      [aprovadoEm, dataPagamento, aprovadoEm, prestacaoId]
    );
  }
  await addHistory(prestacaoId, user.id, "aprovou_superior", `${expectedStep.nome} aprovou a prestacao.`);
  return { ok: true, autenticacao: codigo, data_pagamento_prevista: dataPagamento, proxima_etapa: nextStep?.nome || "Financeiro" };
}

async function reprovarPrestacaoReembolso(prestacaoId, user, justificativa = null) {
  const prestacao = await getPrestacao(prestacaoId);
  if (!prestacao) {
    const error = new Error("Prestacao nao encontrada.");
    error.statusCode = 404;
    throw error;
  }
  if (prestacao.status !== "enviada_superior") {
    const error = new Error("Prestacao nao esta aguardando aprovacao.");
    error.statusCode = 400;
    throw error;
  }
  const expectedStep = await nextReembolsoApprovalStep(prestacaoId);
  const userStep = reembolsoApprovalStepForUser(user);
  if (!expectedStep || !userStep || userStep.etapa !== expectedStep.etapa) {
    const error = new Error(`Esta etapa esta aguardando ${expectedStep?.nome || "outro aprovador"}.`);
    error.statusCode = 403;
    throw error;
  }
  const codigo = authCode("REP");
  const motivo = justificativa || "Reprovado pelo e-mail.";
  const stamp = nowSql();
  await execute("UPDATE rd_reembolso_prestacoes SET status = 'reprovada_superior', motivo_reprovacao = ?, updated_at = ? WHERE id = ?", [motivo, stamp, prestacaoId]);
  await execute(
    "INSERT INTO rd_reembolso_aprovacoes (prestacao_id, usuario_id, etapa, decisao, justificativa, autenticacao, created_at) VALUES (?, ?, ?, 'reprovado', ?, ?, ?)",
    [prestacaoId, user.id, expectedStep.etapa, motivo, codigo, stamp]
  );
  await addHistory(prestacaoId, user.id, "reprovou_superior", motivo);
  return { ok: true, autenticacao: codigo };
}

async function createSession(usuarioId) {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  await execute(
    "INSERT INTO sessoes (usuario_id, token_hash, expira_em) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 12 HOUR))",
    [usuarioId, tokenHash]
  );
  return token;
}

function prestadorJoinByUserSql(alias = "u", prestadorAlias = "p") {
  return `LEFT JOIN prestadores ${prestadorAlias}
            ON ${prestadorAlias}.id = ${alias}.prestador_id
           AND ${prestadorAlias}.ativo = 1`;
}

async function findUsuarioForLogin(login) {
  const cleanLogin = String(login || "").trim();
  const email = cleanLogin.toLowerCase();
  const rows = await query(
    `SELECT u.*,
            COALESCE(p_link.id, p_email.id) AS resolved_prestador_id,
            COALESCE(p_link.departamento_id, p_email.departamento_id) AS departamento_id
       FROM usuarios u
      LEFT JOIN prestadores p_link ON p_link.id = u.prestador_id AND p_link.ativo = 1
      LEFT JOIN prestadores p_email ON LOWER(p_email.email) = LOWER(u.email) AND p_email.ativo = 1
     WHERE u.ativo = 1
        AND LOWER(u.email) = ?
      ORDER BY CASE WHEN LOWER(u.email) = ? THEN 0 ELSE 1 END, u.id
      LIMIT 1`,
    [email, email]
  );
  return rows[0] || null;
}

async function findActivePrestadoresByEmail(email) {
  const cleanEmail = String(email || "").trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes("@")) return [];
  return query(
    `SELECT id, nome, razao_social, email, departamento_id
       FROM prestadores
      WHERE ativo = 1
        AND LOWER(email) = ?
      ORDER BY nome, id`,
    [cleanEmail]
  );
}

async function findActiveUsuarioByPrestadorId(prestadorId) {
  const rows = await query(
    `SELECT id, nome, email, perfil, permissoes_json, ativo, prestador_id, senha_hash, ultimo_login
       FROM usuarios
      WHERE ativo = 1
        AND prestador_id = ?
      LIMIT 1`,
    [prestadorId]
  );
  return rows[0] || null;
}

function isFirstAccessUser(usuario) {
  if (!usuario) return false;
  if (!Number(usuario.resolved_prestador_id || usuario.prestador_id || 0)) return false;
  if (!usuario.senha_hash) return true;
  if (usuario.ultimo_login) return false;
  const perfil = String(usuario.perfil || "").toLowerCase();
  if (["master", "administrador", "financeiro", "aprovador"].includes(perfil)) return false;
  const permissions = permissionsForUser(usuario);
  return Boolean(permissions.reembolso_acessar || permissions.reembolso_solicitar || perfil === "consulta");
}

async function requireAuth(req, res, next) {
  try {
    const token = parseCookies(req)[sessionCookieName];
    if (!token) return res.status(401).json({ error: "Sessao expirada. Faca login novamente." });
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const rows = await query(
      `SELECT s.id AS sessao_id, u.id, u.nome, u.email, u.perfil, u.permissoes_json, u.ativo,
              p.id AS prestador_id, p.departamento_id
         FROM sessoes s
         JOIN usuarios u ON u.id = s.usuario_id
         ${prestadorJoinByUserSql("u", "p")}
        WHERE s.token_hash = ? AND s.expira_em > NOW() AND u.ativo = 1
        LIMIT 1`,
      [tokenHash]
    );
    if (!rows.length) {
      res.setHeader("Set-Cookie", sessionCookie("", 0));
      return res.status(401).json({ error: "Sessao expirada. Faca login novamente." });
    }
    req.user = rows[0];
    req.sessionTokenHash = tokenHash;
    next();
  } catch (error) {
    next(error);
  }
}

function requireProfile(profiles) {
  return (req, res, next) => {
    if (profiles.includes(req.user?.perfil)) return next();
    return res.status(403).json({ error: "Acesso nao permitido para este perfil." });
  };
}

function requireReembolsoPermission(permission) {
  return (req, res, next) => {
    if (hasPermission(req.user, permission)) return next();
    return res.status(403).json({ error: "Acesso nao permitido para este modulo do Reembolso." });
  };
}

function requireAnyReembolsoPermission(...permissions) {
  return (req, res, next) => {
    if (permissions.some((permission) => hasPermission(req.user, permission))) return next();
    return res.status(403).json({ error: "Acesso nao permitido para este modulo do Reembolso." });
  };
}

function publicUser(user) {
  return {
    id: user.id,
    nome: user.nome,
    email: user.email,
    perfil: user.perfil,
    permissoes: permissionsForUser(user),
    prestador_id: user.prestador_id || null,
    departamento_id: user.departamento_id || null,
    full_access: isFullAccess(user)
  };
}

async function getAdiantamento(id) {
  const rows = await query("SELECT * FROM rd_reembolso_adiantamentos WHERE id = ?", [id]);
  return rows[0] || null;
}

async function getPrestacao(id) {
  const rows = await query("SELECT * FROM rd_reembolso_prestacoes WHERE id = ?", [id]);
  return rows[0] || null;
}

async function reembolsoPrestacaoEmailResumo(id, fallback = "") {
  const rows = await query(
    `SELECT p.numero, p.total_despesas, p.valor_reembolsar, p.saldo_devolver, p.data_inicio, p.data_fim,
            u.nome AS solicitante, c.nome AS centro_custo
       FROM rd_reembolso_prestacoes p
       JOIN usuarios u ON u.id = p.solicitante_id
       LEFT JOIN departamentos c ON c.id = p.centro_custo_id
      WHERE p.id = ?
      LIMIT 1`,
    [id]
  );
  const row = rows[0];
  if (!row) return fallback;
  return [
    `Prestacao ${row.numero || id}`,
    `Solicitante: ${row.solicitante || "-"}`,
    `Centro de custo: ${row.centro_custo || "-"}`,
    `Periodo: ${formatDate(row.data_inicio)} a ${formatDate(row.data_fim)}`,
    `Total de despesas: ${formatMoney(row.total_despesas)}`,
    `A reembolsar: ${formatMoney(row.valor_reembolsar)}`,
    `A devolver: ${formatMoney(row.saldo_devolver)}`
  ].join(" | ");
}

async function reembolsoPrestacaoEmailDemonstrativo(id, aprovadorEmail) {
  const rows = await query(
    `SELECT p.*, u.nome AS solicitante, u.email,
            c.nome AS centro_custo,
            COALESCE(pr.razao_social, u.nome) AS razao_social,
            COALESCE(pr.cnpj, pr.cpf, '') AS documento
       FROM rd_reembolso_prestacoes p
       JOIN usuarios u ON u.id = p.solicitante_id
       LEFT JOIN departamentos c ON c.id = p.centro_custo_id
       ${prestadorJoinByUserSql("u", "pr")}
      WHERE p.id = ?
      LIMIT 1`,
    [id]
  );
  const prestacao = rows[0];
  if (!prestacao) return "";
  const despesas = await query(
    `SELECT d.id, d.data_despesa, d.descricao, d.valor, d.quantidade_km, d.origem, d.destino,
            t.nome AS tipo
       FROM rd_reembolso_despesas d
       LEFT JOIN rd_reembolso_tipos_despesa t ON t.id = d.tipo_despesa_id
      WHERE d.prestacao_id = ?
      ORDER BY d.data_despesa, d.id`,
    [id]
  );
  const comprovantes = await query(
    `SELECT c.id, c.despesa_id, c.nome_original
       FROM rd_reembolso_comprovantes c
       JOIN rd_reembolso_despesas d ON d.id = c.despesa_id
      WHERE d.prestacao_id = ?
      ORDER BY c.id`,
    [id]
  );
  const comprovantesPorDespesa = new Map();
  for (const comprovante of comprovantes) {
    const key = Number(comprovante.despesa_id);
    if (!comprovantesPorDespesa.has(key)) comprovantesPorDespesa.set(key, []);
    comprovantesPorDespesa.get(key).push(comprovante);
  }
  const despesaRows = despesas.map((despesa) => {
    const anexos = (comprovantesPorDespesa.get(Number(despesa.id)) || [])
      .map((comprovante, index) => {
        const url = comprovanteEmailUrl({ comprovanteId: comprovante.id, prestacaoId: id, email: aprovadorEmail });
        return `<a href="${escapeHtml(url)}" style="color:#002b5f;font-weight:700;text-decoration:none">Comprovante ${index + 1}</a>`;
      }).join(" &nbsp; ");
    const rota = [despesa.origem, despesa.destino].filter(Boolean).join(" -> ");
    return `
      <tr>
        <td style="padding:8px;border-top:1px solid #e5e7eb">${escapeHtml(formatDate(despesa.data_despesa))}</td>
        <td style="padding:8px;border-top:1px solid #e5e7eb">${escapeHtml(despesa.tipo || "-")}</td>
        <td style="padding:8px;border-top:1px solid #e5e7eb">${escapeHtml(despesa.descricao || rota || "-")}</td>
        <td style="padding:8px;border-top:1px solid #e5e7eb;text-align:right;font-weight:700">${escapeHtml(formatMoney(despesa.valor))}</td>
        <td style="padding:8px;border-top:1px solid #e5e7eb">${anexos || "Sem anexo"}</td>
      </tr>`;
  }).join("");
  return `
    <div style="margin:18px 0;border:1px solid #d7dde6;border-radius:8px;overflow:hidden;font-family:Segoe UI,Arial,sans-serif;color:#0b1726">
      <div style="background:#101722;color:#fff;padding:18px 20px">
        <div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;font-weight:700">Demonstrativo de reembolso</div>
        <div style="font-size:22px;font-weight:800;margin-top:4px">${escapeHtml(prestacao.numero || `PC-${id}`)} - ${escapeHtml(prestacao.razao_social || prestacao.solicitante || "")}</div>
        <div style="font-size:13px;margin-top:6px">${escapeHtml(prestacao.centro_custo || "-")} | ${escapeHtml(formatDate(prestacao.data_inicio))} a ${escapeHtml(formatDate(prestacao.data_fim))}</div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr>
          <td style="padding:12px;border-right:1px solid #e5e7eb"><strong>Despesas</strong><br><span style="font-size:18px;font-weight:800">${escapeHtml(formatMoney(prestacao.total_despesas))}</span></td>
          <td style="padding:12px;border-right:1px solid #e5e7eb"><strong>Adiantamento</strong><br><span style="font-size:18px;font-weight:800">${escapeHtml(formatMoney(prestacao.valor_adiantado))}</span></td>
          <td style="padding:12px;border-right:1px solid #e5e7eb"><strong>A reembolsar</strong><br><span style="font-size:18px;font-weight:800">${escapeHtml(formatMoney(prestacao.valor_reembolsar))}</span></td>
          <td style="padding:12px"><strong>A devolver</strong><br><span style="font-size:18px;font-weight:800">${escapeHtml(formatMoney(prestacao.saldo_devolver))}</span></td>
        </tr>
      </table>
      <div style="padding:14px 16px;border-top:1px solid #e5e7eb">
        <strong>Dados do solicitante</strong>
        <table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:13px">
          <tr><td style="padding:7px;background:#f5f7fa;width:130px;font-weight:700">Solicitante</td><td style="padding:7px">${escapeHtml(prestacao.solicitante || "")}</td><td style="padding:7px;background:#f5f7fa;width:130px;font-weight:700">CPF/CNPJ</td><td style="padding:7px">${escapeHtml(prestacao.documento || "")}</td></tr>
          <tr><td style="padding:7px;background:#f5f7fa;font-weight:700">E-mail</td><td style="padding:7px">${escapeHtml(prestacao.email || "")}</td><td style="padding:7px;background:#f5f7fa;font-weight:700">Status</td><td style="padding:7px">${escapeHtml(prestacao.status || "")}</td></tr>
        </table>
      </div>
      <div style="padding:14px 16px;border-top:1px solid #e5e7eb">
        <strong>Despesas e comprovantes</strong>
        <table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:13px">
          <thead><tr>
            <th align="left" style="padding:8px;background:#f5f7fa">Data</th>
            <th align="left" style="padding:8px;background:#f5f7fa">Tipo</th>
            <th align="left" style="padding:8px;background:#f5f7fa">Descrição</th>
            <th align="right" style="padding:8px;background:#f5f7fa">Valor</th>
            <th align="left" style="padding:8px;background:#f5f7fa">Comprovantes</th>
          </tr></thead>
          <tbody>${despesaRows || `<tr><td colspan="5" style="padding:10px;border-top:1px solid #e5e7eb">Nenhuma despesa cadastrada.</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
}

async function reembolsoAdiantamentoEmailResumo(id, fallback = "") {
  const rows = await query(
    `SELECT a.numero, a.valor, a.data_adiantamento, a.finalidade,
            u.nome AS solicitante, c.nome AS centro_custo
       FROM rd_reembolso_adiantamentos a
       JOIN usuarios u ON u.id = a.solicitante_id
       LEFT JOIN departamentos c ON c.id = a.centro_custo_id
      WHERE a.id = ?
      LIMIT 1`,
    [id]
  );
  const row = rows[0];
  if (!row) return fallback;
  return [
    `Adiantamento ${row.numero || id}`,
    `Solicitante: ${row.solicitante || "-"}`,
    `Centro de custo: ${row.centro_custo || "-"}`,
    `Data: ${formatDate(row.data_adiantamento)}`,
    `Valor: ${formatMoney(row.valor)}`,
    `Finalidade: ${row.finalidade || "-"}`
  ].join(" | ");
}

async function getAvailableAdiantamentos(solicitanteId) {
  return query(
    `SELECT a.*
       FROM rd_reembolso_adiantamentos a
      WHERE a.solicitante_id = ?
        AND a.status = 'aprovado'
        AND a.prestacao_id IS NULL
      ORDER BY a.data_adiantamento, a.id`,
    [solicitanteId]
  );
}

function assertAdiantamentoEditable(adiantamento) {
  if (!adiantamento) {
    const error = new Error("Adiantamento nao encontrado.");
    error.statusCode = 404;
    throw error;
  }
  if (!ADIANTAMENTO_EDITABLE_STATUSES.has(adiantamento.status)) {
    const error = new Error("Este adiantamento nao pode mais ser alterado.");
    error.statusCode = 400;
    throw error;
  }
}

function isPrestacaoEncerrada(prestacao) {
  return ["finalizada", "integrada_omie", "pago"].includes(prestacao?.status)
    || ["integrado", "pago"].includes(prestacao?.omie_status);
}

function canAdminManagePrestacao(user, prestacao) {
  return hasPermission(user, "reembolso_admin") && !isPrestacaoEncerrada(prestacao);
}

function assertPrestacaoEditable(prestacao, user = null) {
  if (!prestacao) {
    const error = new Error("Prestacao nao encontrada.");
    error.statusCode = 404;
    throw error;
  }
  if (!PRESTACAO_EDITABLE_STATUSES.has(prestacao.status) && !canAdminManagePrestacao(user, prestacao)) {
    const error = new Error("Esta prestacao ja foi aprovada/finalizada e nao pode mais ser cancelada ou excluida.");
    error.statusCode = 400;
    throw error;
  }
}

function assertPrestacaoNotFinalizada(prestacao) {
  if (isPrestacaoEncerrada(prestacao)) {
    const error = new Error("Prestacao finalizada/integrada nao pode ser alterada.");
    error.statusCode = 400;
    throw error;
  }
}

function canFinanceiroAlterarValores(user, prestacao) {
  return canOperateFinanceiro(user)
    && ["em_validacao_financeira"].includes(prestacao?.status)
    && !["integrado", "pago"].includes(prestacao?.omie_status);
}

function assertDespesaEditableByUser(user, prestacao, { valorMudou = false, justificativa = "" } = {}) {
  assertPrestacaoNotFinalizada(prestacao);
  if (PRESTACAO_EDITABLE_STATUSES.has(prestacao.status)) {
    if (!isFullAccess(user) && Number(prestacao.solicitante_id) !== Number(user.id)) {
      const error = new Error("Voce so pode alterar suas proprias prestacoes.");
      error.statusCode = 403;
      throw error;
    }
    return "solicitante";
  }
  if (canFinanceiroAlterarValores(user, prestacao)) {
    if (valorMudou && !String(justificativa || "").trim()) {
      const error = new Error("Informe a justificativa para alteração de valor após a aprovação.");
      error.statusCode = 400;
      throw error;
    }
    return "financeiro";
  }
  const error = new Error("Esta prestacao ja foi aprovada/finalizada e nao pode ser alterada.");
  error.statusCode = 400;
  throw error;
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.get("/api/health", asyncRoute(async (_req, res) => {
  await query("SELECT 1 AS ok");
  res.json({ ok: true, app: "reembolso-despesas" });
}));

app.post("/api/auth/verificar-acesso", asyncRoute(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Informe um e-mail valido." });

  const usuario = await findUsuarioForLogin(email);
  if (usuario) {
    if (isFirstAccessUser(usuario)) {
      return res.json({
        status: "primeiro_acesso",
        email,
        nome: usuario.nome,
        message: "E-mail localizado. Cadastre sua senha para entrar no Reembolso."
      });
    }
    return res.json({
      status: "login",
      email,
      nome: usuario.nome,
      message: "E-mail localizado. Informe sua senha para entrar."
    });
  }

  const prestadores = await findActivePrestadoresByEmail(email);
  if (prestadores.length === 1 && !(await findActiveUsuarioByPrestadorId(prestadores[0].id))) {
    return res.json({
      status: "primeiro_acesso",
      email,
      nome: prestadores[0].nome || prestadores[0].razao_social,
      message: "E-mail localizado no cadastro PJ. Cadastre sua senha para entrar no Reembolso."
    });
  }
  if (prestadores.length > 1) {
    return res.status(409).json({
      code: "DUPLICATE_PRESTADOR_EMAIL",
      error: "Este e-mail esta vinculado a mais de um prestador ativo. Corrija o e-mail no cadastro antes do primeiro acesso."
    });
  }
  return res.status(404).json({ error: "E-mail nao encontrado em prestadores ativos ou usuarios do sistema." });
}));

app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const login = String(req.body.email || "").trim();
  const senha = String(req.body.senha || "");
  if (!login || !senha) return res.status(400).json({ error: "Informe e-mail e senha." });

  const usuario = await findUsuarioForLogin(login);
  if (!usuario || !verifyPassword(senha, usuario.senha_hash)) {
    if (usuario && isFirstAccessUser(usuario)) {
      return res.status(409).json({
        code: "FIRST_ACCESS_REQUIRED",
        error: "Primeiro acesso: cadastre sua senha para entrar no Reembolso."
      });
    }
    if (!usuario && String(login).includes("@")) {
      const prestadores = await findActivePrestadoresByEmail(login);
      if (prestadores.length === 1 && !(await findActiveUsuarioByPrestadorId(prestadores[0].id))) {
        return res.status(409).json({
          code: "FIRST_ACCESS_REQUIRED",
          error: "Primeiro acesso: cadastre sua senha para entrar no Reembolso."
        });
      }
      if (prestadores.length > 1) {
        return res.status(409).json({
          code: "DUPLICATE_PRESTADOR_EMAIL",
          error: "Este e-mail esta vinculado a mais de um prestador ativo. Corrija o e-mail no cadastro antes do primeiro acesso."
        });
      }
    }
    return res.status(401).json({ error: "E-mail ou senha invalidos." });
  }

  const token = await createSession(usuario.id);
  await execute("UPDATE usuarios SET ultimo_login = NOW() WHERE id = ?", [usuario.id]);
  const current = (await query(
    `SELECT u.id, u.nome, u.email, u.perfil, u.permissoes_json, u.ativo,
            p.id AS prestador_id, p.departamento_id
       FROM usuarios u
       ${prestadorJoinByUserSql("u", "p")}
      WHERE u.id = ?`,
    [usuario.id]
  ))[0];
  res.setHeader("Set-Cookie", sessionCookie(token));
  res.json({ usuario: publicUser(current) });
}));

app.post("/api/auth/primeiro-acesso", asyncRoute(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const senha = String(req.body.senha || "");
  const confirmarSenha = String(req.body.confirmar_senha || req.body.confirmarSenha || senha);

  if (!email || !email.includes("@")) return res.status(400).json({ error: "Informe um e-mail valido." });
  if (senha.length < 6) return res.status(400).json({ error: "A senha deve ter pelo menos 6 caracteres." });
  if (senha !== confirmarSenha) return res.status(400).json({ error: "A confirmacao da senha nao confere." });

  const prestadores = await findActivePrestadoresByEmail(email);
  if (!prestadores.length) {
    return res.status(404).json({ error: "E-mail nao encontrado em prestadores ativos." });
  }
  if (prestadores.length > 1) {
    return res.status(409).json({ error: "Este e-mail esta vinculado a mais de um prestador ativo. Corrija o e-mail no cadastro antes do primeiro acesso." });
  }
  const prestador = prestadores[0];

  const existing = await findActiveUsuarioByPrestadorId(prestador.id);
  const existingByEmail = await findUsuarioForLogin(email);
  const existingUser = existing || existingByEmail;
  if (existingUser && !isFirstAccessUser({ ...existingUser, resolved_prestador_id: prestador.id })) {
    return res.status(409).json({ error: "Este prestador ja possui acesso cadastrado. Use e-mail e senha para entrar." });
  }

  const permissoes = {
    reembolso_acessar: true,
    reembolso_solicitar: true
  };
  let usuarioId = existingUser?.id;
  if (usuarioId) {
    await execute(
      `UPDATE usuarios
          SET nome = COALESCE(NULLIF(nome, ''), ?),
              email = ?,
              senha_hash = ?,
              perfil = 'consulta',
              permissoes_json = CAST(? AS JSON),
              prestador_id = ?,
              ativo = 1
        WHERE id = ?`,
      [
        prestador.nome || prestador.razao_social,
        email,
        hashPassword(senha),
        JSON.stringify(permissoes),
        prestador.id,
        usuarioId
      ]
    );
  } else {
    const result = await execute(
      `INSERT INTO usuarios (nome, email, senha_hash, perfil, permissoes_json, prestador_id, ativo)
       VALUES (?, ?, ?, 'consulta', CAST(? AS JSON), ?, 1)`,
      [
        prestador.nome || prestador.razao_social,
        email,
        hashPassword(senha),
        JSON.stringify(permissoes),
        prestador.id
      ]
    );
    usuarioId = result.insertId;
  }

  const token = await createSession(usuarioId);
  await execute("UPDATE usuarios SET ultimo_login = NOW() WHERE id = ?", [usuarioId]);
  const current = (await query(
    `SELECT u.id, u.nome, u.email, u.perfil, u.permissoes_json, u.ativo,
            p.id AS prestador_id, p.departamento_id
       FROM usuarios u
       ${prestadorJoinByUserSql("u", "p")}
      WHERE u.id = ?`,
    [usuarioId]
  ))[0];
  res.setHeader("Set-Cookie", sessionCookie(token));
  res.status(201).json({ usuario: publicUser(current) });
}));

app.get("/email-action/reembolso", asyncRoute(async (req, res) => {
  const payload = verifyEmailActionToken(req.query.token);
  if (!payload || payload.kind !== "reembolso_prestacao" || !payload.id || !payload.email) {
    return res.status(400).send("Link de aprovacao invalido ou expirado.");
  }
  const user = await findUsuarioForLogin(payload.email);
  if (!user || !user.ativo) return res.status(403).send("Aprovador nao localizado ou inativo.");
  let result;
  if (payload.action === "aprovar") {
    result = await aprovarPrestacaoReembolso(payload.id, user, "Aprovado pelo e-mail.");
  } else if (payload.action === "reprovar") {
    result = await reprovarPrestacaoReembolso(payload.id, user, payload.reason || "Reprovado pelo e-mail.");
  } else {
    return res.status(400).send("Acao nao reconhecida.");
  }
  const actionLabel = payload.action === "aprovar" ? "Aprovacao registrada" : "Reprovacao registrada";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.send(`<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(actionLabel)}</title></head>
<body style="margin:0;font-family:Segoe UI,Arial,sans-serif;background:#f3f6fb;color:#0b1726">
  <main style="max-width:560px;margin:48px auto;background:#fff;border:1px solid #d7dde6;border-radius:10px;padding:28px">
    <h1 style="margin:0 0 10px">${escapeHtml(actionLabel)}</h1>
    <p>Processo ${escapeHtml(String(payload.id))} atualizado com sucesso.</p>
    <p><strong>Autenticacao:</strong> ${escapeHtml(result.autenticacao || "")}</p>
    <p style="color:#667085">Voce ja pode fechar esta janela.</p>
  </main>
</body>
</html>`);
}));

app.get("/email-action/comprovante", asyncRoute(async (req, res) => {
  const payload = verifyEmailActionToken(req.query.token);
  if (!payload || payload.kind !== "reembolso_comprovante" || !payload.comprovanteId || !payload.email) {
    return res.status(400).send("Link de comprovante invalido ou expirado.");
  }
  const user = await findUsuarioForLogin(payload.email);
  if (!user || !user.ativo || !reembolsoApprovalStepForUser(user)) return res.status(403).send("Acesso negado.");
  const rows = await query(`
    SELECT c.*, d.prestacao_id
      FROM rd_reembolso_comprovantes c
      JOIN rd_reembolso_despesas d ON d.id = c.despesa_id
     WHERE c.id = ?
     LIMIT 1
  `, [payload.comprovanteId]);
  if (!rows.length || Number(rows[0].prestacao_id) !== Number(payload.prestacaoId)) return res.status(404).send("Comprovante nao encontrado.");
  const filePath = path.resolve(uploadDir, rows[0].caminho_arquivo);
  const baseDir = path.resolve(uploadDir);
  if (!filePath.startsWith(`${baseDir}${path.sep}`) || !fs.existsSync(filePath)) return res.status(404).send("Arquivo nao encontrado.");
  const safeName = String(rows[0].nome_original || "comprovante").replace(/[\\"]/g, "");
  res.setHeader("Content-Type", rows[0].mime_type || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);
  return res.sendFile(filePath);
}));

app.use("/api", (req, res, next) => {
  if (req.path === "/health" || req.path === "/auth/login" || req.path === "/auth/verificar-acesso" || req.path === "/auth/primeiro-acesso") return next();
  return requireAuth(req, res, (error) => {
    if (error) return next(error);
    if (!hasPermission(req.user, "reembolso_acessar")) {
      return res.status(403).json({ error: "Seu usuario nao tem acesso ao sistema de Reembolso." });
    }
    return next();
  });
});

app.get("/api/auth/me", (req, res) => {
  res.json({ usuario: publicUser(req.user) });
});

app.post("/api/auth/logout", asyncRoute(async (req, res) => {
  if (req.sessionTokenHash) await execute("DELETE FROM sessoes WHERE token_hash = ?", [req.sessionTokenHash]);
  res.setHeader("Set-Cookie", sessionCookie("", 0));
  res.json({ ok: true });
}));

app.post("/api/auth/change-password", asyncRoute(async (req, res) => {
  const senhaAtual = String(req.body.senha_atual || "");
  const novaSenha = String(req.body.nova_senha || "");
  const confirmarSenha = String(req.body.confirmar_senha || req.body.confirmarSenha || "");
  if (!senhaAtual) return res.status(400).json({ error: "Informe a senha atual." });
  if (novaSenha.length < 6) return res.status(400).json({ error: "A nova senha deve ter pelo menos 6 caracteres." });
  if (novaSenha !== confirmarSenha) return res.status(400).json({ error: "A confirmacao da senha nao confere." });
  const usuario = (await query("SELECT id, senha_hash FROM usuarios WHERE id = ? AND ativo = 1", [req.user.id]))[0];
  if (!usuario || !verifyPassword(senhaAtual, usuario.senha_hash)) return res.status(401).json({ error: "Senha atual invalida." });
  await execute("UPDATE usuarios SET senha_hash = ?, ultimo_login = NOW() WHERE id = ?", [hashPassword(novaSenha), req.user.id]);
  res.json({ ok: true });
}));

app.get("/api/bootstrap", asyncRoute(async (req, res) => {
  const [usuarios, tipos, centros, config] = await Promise.all([
    query(`
      SELECT u.id, u.nome, u.email, u.perfil, p.id AS prestador_id, p.departamento_id
        FROM usuarios u
        ${prestadorJoinByUserSql("u", "p")}
       WHERE u.ativo = 1
       ORDER BY u.nome
    `),
    query(
      `SELECT * FROM rd_reembolso_tipos_despesa
        WHERE ativo = 1
          AND nome COLLATE utf8mb4_unicode_ci NOT IN (?, ?)
        ORDER BY nome`,
      ["Reembolso de Despesas", "Reembolso de Despesas Hub"]
    ),
    query("SELECT id, nome, nome AS unidade, ativo FROM departamentos WHERE ativo = 1 ORDER BY nome"),
    query("SELECT chave, valor FROM rd_reembolso_configuracoes ORDER BY chave")
  ]);
  const aprovadoresMap = new Map();
  usuarios
    .filter((user) => ["simone.oliveira@redefrete.com.br", "paulo.mendonca@redefrete.com.br"].includes(String(user.email || "").toLowerCase()))
    .forEach((user) => aprovadoresMap.set(String(user.email).toLowerCase(), user));
  const aprovadores = [...aprovadoresMap.values()];
  res.json({ usuario: publicUser(req.user), usuarios, tipos, centros, aprovadores, config: Object.fromEntries(config.map((row) => [row.chave, row.valor])) });
}));

app.get("/api/descricoes", asyncRoute(async (req, res) => {
  const tipo = req.query.tipo_despesa_id || null;
  const term = normalizeLookupText(req.query.q || "");
  const params = [];
  let where = "WHERE 1=1";
  if (tipo) {
    where += " AND (tipo_despesa_id = ? OR tipo_despesa_id IS NULL)";
    params.push(tipo);
  }
  if (term) {
    where += " AND contexto LIKE ?";
    params.push(`%${term}%`);
  }
  const rows = await query(
    `SELECT id, descricao, vezes_usada FROM rd_reembolso_descricoes_despesa ${where} ORDER BY vezes_usada DESC, ultimo_uso DESC LIMIT 30`,
    params
  );
  res.json(rows);
}));

app.get("/api/dashboard", asyncRoute(async (req, res) => {
  const where = isFullAccess(req.user) ? "" : "WHERE solicitante_id = ?";
  const params = isFullAccess(req.user) ? [] : [req.user.id];
  const status = await query(`SELECT status, COUNT(*) AS total, COALESCE(SUM(total_despesas), 0) AS valor FROM rd_reembolso_prestacoes ${where} GROUP BY status`, params);
  const aberto = await query(
    `SELECT COUNT(*) AS total, COALESCE(SUM(saldo), 0) AS valor
       FROM (
         SELECT adiantamento_id, COALESCE(SUM(valor), 0) AS saldo
           FROM rd_reembolso_conta_corrente
          WHERE adiantamento_id IS NOT NULL
          ${isFullAccess(req.user) ? "" : "AND solicitante_id = ?"}
          GROUP BY adiantamento_id
         HAVING saldo > 0.009
       ) saldos`,
    params
  );
  const financeiro = await query(`SELECT COUNT(*) AS total, COALESCE(SUM(valor_reembolsar), 0) AS reembolsar, COALESCE(SUM(saldo_devolver), 0) AS devolver FROM rd_reembolso_prestacoes ${where ? `${where} AND status IN ('aprovada_superior', 'em_validacao_financeira')` : "WHERE status IN ('aprovada_superior', 'em_validacao_financeira')"}`, params);
  res.json({ status, adiantamentos_abertos: aberto[0], financeiro: financeiro[0] });
}));

const contaCorrenteAdiantamentosRoute = asyncRoute(async (req, res) => {
  const solicitanteId = isFullAccess(req.user) && req.query.solicitante_id ? Number(req.query.solicitante_id) : Number(req.user.id);
  const movimentos = await movimentosAdiantamentoResumo(isFullAccess(req.user) ? (req.query.solicitante_id ? solicitanteId : null) : solicitanteId);
  const saldo = isFullAccess(req.user) && !req.query.solicitante_id
    ? toMoney(movimentos.reduce((sum, item) => sum + Number(item.valor || 0), 0))
    : await saldoAdiantamentoSolicitante(solicitanteId);
  res.json({ saldo, movimentos });
});
app.get("/api/conta-corrente-adiantamentos", contaCorrenteAdiantamentosRoute);
app.get("/api/adiantamentos/conta-corrente", contaCorrenteAdiantamentosRoute);

app.post("/api/adiantamentos/devolucoes", requireReembolsoPermission("reembolso_integrar_omie"), asyncRoute(async (req, res) => {
  if (!canOperateFinanceiro(req.user)) {
    return res.status(403).json({ error: "Somente financeiro ou administrador pode registrar devolucao de adiantamento." });
  }
  const adiantamento = req.body.adiantamento_id ? await getAdiantamento(req.body.adiantamento_id) : null;
  if (!adiantamento) return res.status(400).json({ error: "Selecione o adiantamento para registrar a devolucao." });
  const solicitanteId = Number(adiantamento.solicitante_id || req.body.solicitante_id || 0);
  const valor = toMoney(req.body.valor);
  if (!solicitanteId) return res.status(400).json({ error: "Informe o solicitante da devolucao." });
  if (!valor || valor <= 0) return res.status(400).json({ error: "Informe o valor da devolucao." });
  const saldo = await saldoAdiantamentoPorId(adiantamento.id);
  if (valor > saldo) return res.status(400).json({ error: `Valor da devolucao maior que o saldo em aberto (${formatMoney(saldo)}).` });
  const dataAdiantamento = formatDate(adiantamento.data_adiantamento);
  const numeroDocumento = adiantamento.numero;
  const descricao = `Devolucao saldo do adiantamento nº ${adiantamento.numero}, de ${dataAdiantamento}.`;
  const resultado = await integrarOmieDevolucaoAdiantamento({
    solicitanteId,
    adiantamentoId: adiantamento.id,
    valor,
    dataDevolucao: req.body.data_devolucao || new Date(),
    numeroDocumento,
    descricao
  });
  res.json({ ok: true, saldo_anterior: saldo, saldo_atual: await saldoAdiantamentoPorId(adiantamento.id), descricao, ...resultado });
}));

app.get("/api/adiantamentos", asyncRoute(async (req, res) => {
  const where = isFullAccess(req.user) ? "" : "WHERE a.solicitante_id = ?";
  const params = isFullAccess(req.user) ? [] : [req.user.id];
  const rows = await query(`
    SELECT a.*, u.nome AS solicitante, s.nome AS superior, c.nome AS centro_custo
      FROM rd_reembolso_adiantamentos a
      JOIN usuarios u ON u.id = a.solicitante_id
      LEFT JOIN usuarios s ON s.id = a.superior_id
      LEFT JOIN departamentos c ON c.id = a.centro_custo_id
     ${where}
     ORDER BY a.data_adiantamento DESC, a.id DESC
  `, params);
  res.json(rows);
}));

app.post("/api/adiantamentos", requireReembolsoPermission("reembolso_solicitar"), asyncRoute(async (req, res) => {
  const stamp = nowSql();
  const numero = await nextNumber("AD", "rd_reembolso_adiantamentos");
  const solicitanteId = isFullAccess(req.user) && req.body.solicitante_id ? req.body.solicitante_id : req.user.id;
  const result = await execute(
    `INSERT INTO rd_reembolso_adiantamentos
     (numero, solicitante_id, superior_id, data_adiantamento, valor, descritivo, finalidade, centro_custo_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'rascunho', ?, ?)`,
    [
      numero,
      solicitanteId,
      req.body.superior_id || null,
      req.body.data_adiantamento,
      toMoney(req.body.valor),
      req.body.descritivo || null,
      req.body.finalidade || null,
      req.body.centro_custo_id || null,
      stamp,
      stamp
    ]
  );
  res.status(201).json({ id: result.insertId, numero });
}));

app.put("/api/adiantamentos/:id", asyncRoute(async (req, res) => {
  const adiantamento = await getAdiantamento(req.params.id);
  assertAdiantamentoEditable(adiantamento);
  if (!isFullAccess(req.user) && Number(adiantamento.solicitante_id) !== Number(req.user.id)) {
    return res.status(403).json({ error: "Voce so pode alterar seus proprios adiantamentos." });
  }
  await execute(
    `UPDATE rd_reembolso_adiantamentos
        SET superior_id = ?, data_adiantamento = ?, valor = ?, descritivo = ?, finalidade = ?, centro_custo_id = ?, updated_at = ?
      WHERE id = ?`,
    [
      req.body.superior_id || adiantamento.superior_id || null,
      req.body.data_adiantamento || adiantamento.data_adiantamento,
      toMoney(req.body.valor ?? adiantamento.valor),
      req.body.descritivo ?? adiantamento.descritivo,
      req.body.finalidade ?? adiantamento.finalidade,
      req.body.centro_custo_id || adiantamento.centro_custo_id || null,
      nowSql(),
      req.params.id
    ]
  );
  res.json({ ok: true });
}));

app.post("/api/adiantamentos/:id/enviar-aprovacao", asyncRoute(async (req, res) => {
  const adiantamento = await getAdiantamento(req.params.id);
  assertAdiantamentoEditable(adiantamento);
  if (!isFullAccess(req.user) && Number(adiantamento.solicitante_id) !== Number(req.user.id)) {
    return res.status(403).json({ error: "Voce so pode enviar seus proprios adiantamentos." });
  }
  if (!adiantamento.superior_id) {
    return res.status(400).json({ error: "Selecione o superior antes de enviar para aprovacao." });
  }
  const superiores = await query(
    "SELECT id, nome, email FROM usuarios WHERE id = ? AND ativo = 1 LIMIT 1",
    [adiantamento.superior_id]
  );
  const superior = superiores[0];
  if (!superior?.email) {
    return res.status(400).json({ error: "Superior selecionado nao possui e-mail cadastrado." });
  }
  await execute("UPDATE rd_reembolso_adiantamentos SET status = 'em_aprovacao', updated_at = ? WHERE id = ?", [nowSql(), req.params.id]);
  const detalhe = await reembolsoAdiantamentoEmailResumo(
    adiantamento.id,
    `Solicitacao de adiantamento no valor de ${formatMoney(adiantamento.valor)}.`
  );
  await sendReembolsoApprovalEmails({
    titulo: `Adiantamento ${adiantamento.numero} aguardando aprovação`,
    detalhe,
    link: `${approvalCentralUrl()}?tipo=reembolso_adiantamento&id=${encodeURIComponent(adiantamento.id)}`,
    emails: [superior.email]
  });
  res.json({ ok: true, superior });
}));

app.post("/api/adiantamentos/:id/aprovar", requireReembolsoPermission("reembolso_aprovar"), asyncRoute(async (req, res) => {
  const adiantamento = await getAdiantamento(req.params.id);
  if (!adiantamento) return res.status(404).json({ error: "Adiantamento nao encontrado." });
  if (!["em_aprovacao", "rascunho", "reprovado"].includes(adiantamento.status)) {
    return res.status(400).json({ error: "Este adiantamento nao pode ser aprovado neste status." });
  }
  await execute("UPDATE rd_reembolso_adiantamentos SET status = 'aprovado', aprovado_por = ?, aprovado_em = ?, updated_at = ? WHERE id = ?", [req.user.id, nowSql(), nowSql(), req.params.id]);
  await upsertContaCorrenteMovimento({
    solicitanteId: adiantamento.solicitante_id,
    adiantamentoId: adiantamento.id,
    tipo: "adiantamento",
    dataMovimento: sqlDate(adiantamento.data_adiantamento),
    valor: toMoney(adiantamento.valor),
    numeroDocumento: adiantamento.numero,
    descricao: `Adiantamento aprovado ${adiantamento.numero}`,
    omieStatus: "pendente"
  });
  res.json({ ok: true });
}));

app.post("/api/adiantamentos/:id/integrar-omie", requireReembolsoPermission("reembolso_integrar_omie"), asyncRoute(async (req, res) => {
  const adiantamento = await getAdiantamento(req.params.id);
  if (!adiantamento) return res.status(404).json({ error: "Adiantamento nao encontrado." });
  if (!["aprovado", "prestado"].includes(adiantamento.status)) {
    return res.status(400).json({ error: "Somente adiantamento aprovado pode ser integrado com Omie." });
  }
  if (adiantamento.omie_status === "integrado") return res.json({ ok: true, ja_integrado: true });
  try {
    const resultado = await integrarOmieTransferenciaAdiantamento(adiantamento);
    res.json({ ok: true, ...resultado });
  } catch (error) {
    const integrated = /^Transferencia integrada, mas falhou/i.test(error.message);
    await execute(
      "UPDATE rd_reembolso_adiantamentos SET omie_status = CASE WHEN ? THEN 'integrado' ELSE 'erro' END, omie_erro = ?, updated_at = ? WHERE id = ?",
      [integrated ? 1 : 0, error.message, nowSql(), req.params.id]
    );
    res.status(500).json({ error: error.message });
  }
}));

app.post("/api/adiantamentos/:id/cancelar", asyncRoute(async (req, res) => {
  const adiantamento = await getAdiantamento(req.params.id);
  assertAdiantamentoEditable(adiantamento);
  if (adiantamento.status === "cancelado") return res.json({ ok: true });

  const vinculadas = await query(
    "SELECT COUNT(*) AS total FROM rd_reembolso_prestacoes WHERE adiantamento_id = ? AND status NOT IN ('cancelada')",
    [req.params.id]
  );
  if (Number(vinculadas[0].total || 0) > 0) {
    return res.status(400).json({ error: "Existe prestacao vinculada a este adiantamento. Cancele ou exclua a prestacao primeiro." });
  }

  await execute("UPDATE rd_reembolso_adiantamentos SET status = 'cancelado', updated_at = ? WHERE id = ?", [nowSql(), req.params.id]);
  res.json({ ok: true });
}));

app.delete("/api/adiantamentos/:id", asyncRoute(async (req, res) => {
  const adiantamento = await getAdiantamento(req.params.id);
  assertAdiantamentoEditable(adiantamento);

  const vinculadas = await query(
    "SELECT COUNT(*) AS total FROM rd_reembolso_prestacoes WHERE adiantamento_id = ? AND status NOT IN ('cancelada')",
    [req.params.id]
  );
  if (Number(vinculadas[0].total || 0) > 0) {
    return res.status(400).json({ error: "Existe prestacao vinculada a este adiantamento. Cancele ou exclua a prestacao primeiro." });
  }

  await execute("DELETE FROM rd_reembolso_adiantamentos WHERE id = ?", [req.params.id]);
  res.json({ ok: true });
}));

app.get("/api/prestacoes", asyncRoute(async (req, res) => {
  const where = isFullAccess(req.user) ? "" : "WHERE p.solicitante_id = ?";
  const params = isFullAccess(req.user) ? [] : [req.user.id];
  const rows = await query(`
    SELECT p.*, u.nome AS solicitante, s.nome AS superior, c.nome AS centro_custo,
           EXISTS (
             SELECT 1 FROM rd_reembolso_aprovacoes a
              WHERE a.prestacao_id = p.id AND a.etapa = 'financeiro' AND a.decisao = 'aprovado'
           ) AS aprovado_financeiro
      FROM rd_reembolso_prestacoes p
      JOIN usuarios u ON u.id = p.solicitante_id
      LEFT JOIN usuarios s ON s.id = p.superior_id
      LEFT JOIN departamentos c ON c.id = p.centro_custo_id
     ${where}
     ORDER BY p.id DESC
  `, params);
  res.json(rows);
}));

app.post("/api/prestacoes", requireReembolsoPermission("reembolso_solicitar"), asyncRoute(async (req, res) => {
  const stamp = nowSql();
  const numero = await nextNumber("PC", "rd_reembolso_prestacoes");
  const solicitanteId = isFullAccess(req.user) && req.body.solicitante_id ? req.body.solicitante_id : req.user.id;
  const abertas = await query(
    `SELECT numero, status
       FROM rd_reembolso_prestacoes
      WHERE solicitante_id = ?
        AND status IN (${[...PRESTACAO_ABERTA_STATUSES].map(() => "?").join(",")})
      ORDER BY id DESC
      LIMIT 1`,
    [solicitanteId, ...PRESTACAO_ABERTA_STATUSES]
  );
  if (abertas.length) {
    return res.status(400).json({ error: `Este prestador ja possui a prestacao aberta ${abertas[0].numero}. Finalize ou cancele antes de abrir uma nova.` });
  }
  const adiantamentos = await getAvailableAdiantamentos(solicitanteId);
  const valorAdiantado = toMoney(adiantamentos.reduce((sum, item) => sum + Number(item.valor || 0), 0));
  const adiantamentoId = adiantamentos[0]?.id || null;

  const result = await execute(
    `INSERT INTO rd_reembolso_prestacoes
     (numero, adiantamento_id, solicitante_id, superior_id, centro_custo_id, finalidade, data_inicio, data_fim, valor_adiantado, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'rascunho', ?, ?)`,
    [
      numero,
      adiantamentoId,
      solicitanteId,
      req.body.superior_id || null,
      req.body.centro_custo_id || null,
      req.body.finalidade || null,
      req.body.data_inicio,
      req.body.data_fim,
      valorAdiantado,
      stamp,
      stamp
    ]
  );
  await addHistory(result.insertId, solicitanteId, "criou_prestacao", `Prestacao ${numero} criada.`);
  if (adiantamentos.length) {
    await execute(
      `UPDATE rd_reembolso_adiantamentos
          SET status = 'prestado', prestacao_id = ?, updated_at = ?
        WHERE id IN (${adiantamentos.map(() => "?").join(",")})`,
      [result.insertId, nowSql(), ...adiantamentos.map((item) => item.id)]
    );
  }
  res.status(201).json({ id: result.insertId, numero });
}));

app.get("/api/prestacoes/:id", asyncRoute(async (req, res) => {
  const rows = await query(`
    SELECT p.*, u.nome AS solicitante, u.email AS solicitante_email, s.nome AS superior, c.nome AS centro_custo, c.nome AS unidade
      FROM rd_reembolso_prestacoes p
      JOIN usuarios u ON u.id = p.solicitante_id
      LEFT JOIN usuarios s ON s.id = p.superior_id
      LEFT JOIN departamentos c ON c.id = p.centro_custo_id
     WHERE p.id = ?
  `, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Prestacao nao encontrada." });
  if (!isFullAccess(req.user) && Number(rows[0].solicitante_id) !== Number(req.user.id)) {
    return res.status(403).json({ error: "Voce so pode consultar suas proprias prestacoes." });
  }

  const despesas = await query(`
    SELECT d.*, t.nome AS tipo_despesa, t.exige_km,
           (SELECT COUNT(*) FROM rd_reembolso_comprovantes c WHERE c.despesa_id = d.id) AS comprovantes
      FROM rd_reembolso_despesas d
      JOIN rd_reembolso_tipos_despesa t ON t.id = d.tipo_despesa_id
     WHERE d.prestacao_id = ?
     ORDER BY d.data_despesa, d.id
  `, [req.params.id]);
  const comprovantes = await query(`
    SELECT c.id, c.despesa_id, c.nome_original, c.mime_type, c.tamanho_bytes, c.created_at
      FROM rd_reembolso_comprovantes c
      JOIN rd_reembolso_despesas d ON d.id = c.despesa_id
     WHERE d.prestacao_id = ?
     ORDER BY c.created_at, c.id
  `, [req.params.id]);
  const comprovantesPorDespesa = new Map();
  for (const comprovante of comprovantes) {
    const key = Number(comprovante.despesa_id);
    if (!comprovantesPorDespesa.has(key)) comprovantesPorDespesa.set(key, []);
    comprovantesPorDespesa.get(key).push(comprovante);
  }
  for (const despesa of despesas) {
    despesa.comprovantes_lista = comprovantesPorDespesa.get(Number(despesa.id)) || [];
    despesa.comprovantes = despesa.comprovantes_lista.length;
  }
  const aprovacoes = await query(`
    SELECT a.*, u.nome AS usuario, u.email
      FROM rd_reembolso_aprovacoes a
      JOIN usuarios u ON u.id = a.usuario_id
     WHERE a.prestacao_id = ?
     ORDER BY a.created_at
  `, [req.params.id]);
  const historico = await query("SELECT * FROM rd_reembolso_historico WHERE prestacao_id = ? ORDER BY created_at DESC", [req.params.id]);
  res.json({ prestacao: rows[0], despesas, aprovacoes, historico });
}));

app.post("/api/prestacoes/:id/despesas", requireAnyReembolsoPermission("reembolso_solicitar", "reembolso_financeiro"), asyncRoute(async (req, res) => {
  const prestacao = await getPrestacao(req.params.id);
  const mode = assertDespesaEditableByUser(req.user, prestacao, {
    valorMudou: true,
    justificativa: req.body.justificativa_ajuste_financeiro
  });
  const stamp = nowSql();
  const valor = req.body.quantidade_km && req.body.valor_km
    ? toMoney(Number(req.body.quantidade_km) * Number(req.body.valor_km))
    : toMoney(req.body.valor);
  const pendingToken = String(req.body.comprovante_token || "");
  const pending = pendingToken ? pendingComprovantes.get(pendingToken) : null;
  const pendingFileExists = pending && Number(pending.prestacao_id) === Number(req.params.id) && fs.existsSync(path.join(uploadDir, pending.filename));
  if (pendingFileExists) {
    const divergenciasDocumento = documentoDivergenciasComDespesa(pending.validacao, {
      data_despesa: req.body.data_despesa,
      valor
    });
    if (divergenciasDocumento.length) {
      const error = new Error(`Documento nao confere com a despesa: ${divergenciasDocumento.join(" ")}`);
      error.statusCode = 409;
      throw error;
    }
  }
  const result = await execute(
    `INSERT INTO rd_reembolso_despesas
     (prestacao_id, tipo_despesa_id, data_despesa, descricao, valor, origem, destino, quantidade_km, valor_km, status_comprovante, observacao, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?, ?, ?)`,
    [
      req.params.id,
      req.body.tipo_despesa_id,
      req.body.data_despesa,
      req.body.descricao,
      valor,
      req.body.origem || null,
      req.body.destino || null,
      toMoney(req.body.quantidade_km),
      toMoney(req.body.valor_km),
      req.body.observacao || null,
      stamp,
      stamp
    ]
  );
  if (pendingFileExists) {
    await execute(
      `INSERT INTO rd_reembolso_comprovantes
       (despesa_id, nome_original, caminho_arquivo, mime_type, tamanho_bytes,
        nf_chave_acesso, nf_numero, nf_data_emissao, nf_valor, nf_qr_url, nf_consulta_status, nf_divergencias, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        result.insertId,
        pending.originalname,
        pending.filename,
        pending.mimetype,
        pending.size,
        pending.validacao?.chave_acesso || null,
        pending.validacao?.numero_nf || null,
        pending.validacao?.data_emissao || null,
        pending.validacao?.valor || null,
        pending.validacao?.qr_url || null,
        pending.validacao?.consulta_status || null,
        (pending.validacao?.divergencias || []).join(" | ") || null,
        stamp
      ]
    );
    await execute("UPDATE rd_reembolso_despesas SET status_comprovante = 'anexado', updated_at = ? WHERE id = ?", [stamp, result.insertId]);
    pendingComprovantes.delete(pendingToken);
  }
  await learnDescricao(req.body.tipo_despesa_id, req.body.descricao);
  await recalcPrestacao(req.params.id);
  if (mode === "financeiro") {
    const justificativa = String(req.body.justificativa_ajuste_financeiro || "").trim();
    await execute(
      "UPDATE rd_reembolso_prestacoes SET ajuste_financeiro_justificativa = ?, ajuste_financeiro_em = ?, ajuste_financeiro_por = ?, updated_at = ? WHERE id = ?",
      [justificativa, stamp, req.user.id, stamp, req.params.id]
    );
    await addHistory(req.params.id, req.user.id, "ajuste_valor_financeiro", justificativa, {
      despesa_id: result.insertId,
      valor_anterior: 0,
      valor_novo: valor
    });
  }
  res.status(201).json({ id: result.insertId });
}));

app.put("/api/despesas/:id", requireAnyReembolsoPermission("reembolso_solicitar", "reembolso_financeiro"), asyncRoute(async (req, res) => {
  const rows = await query("SELECT d.*, p.status, p.omie_status, p.solicitante_id FROM rd_reembolso_despesas d JOIN rd_reembolso_prestacoes p ON p.id = d.prestacao_id WHERE d.id = ?", [req.params.id]);
  const despesa = rows[0];
  if (!despesa) return res.status(404).json({ error: "Despesa nao encontrada." });
  const valor = req.body.quantidade_km && req.body.valor_km
    ? toMoney(Number(req.body.quantidade_km) * Number(req.body.valor_km))
    : toMoney(req.body.valor);
  const valorAnterior = toMoney(despesa.valor);
  const valorMudou = valor !== valorAnterior;
  const mode = assertDespesaEditableByUser(req.user, despesa, {
    valorMudou,
    justificativa: req.body.justificativa_ajuste_financeiro
  });
  await execute(
    `UPDATE rd_reembolso_despesas
        SET tipo_despesa_id = ?, data_despesa = ?, descricao = ?, valor = ?, origem = ?, destino = ?,
            quantidade_km = ?, valor_km = ?, observacao = ?, updated_at = ?
      WHERE id = ?`,
    [
      req.body.tipo_despesa_id,
      req.body.data_despesa,
      req.body.descricao,
      valor,
      req.body.origem || null,
      req.body.destino || null,
      toMoney(req.body.quantidade_km),
      toMoney(req.body.valor_km),
      req.body.observacao || null,
      nowSql(),
      req.params.id
    ]
  );
  await learnDescricao(req.body.tipo_despesa_id, req.body.descricao);
  await recalcPrestacao(despesa.prestacao_id);
  if (mode === "financeiro" && valorMudou) {
    const stamp = nowSql();
    const justificativa = String(req.body.justificativa_ajuste_financeiro || "").trim();
    await execute(
      "UPDATE rd_reembolso_prestacoes SET ajuste_financeiro_justificativa = ?, ajuste_financeiro_em = ?, ajuste_financeiro_por = ?, updated_at = ? WHERE id = ?",
      [justificativa, stamp, req.user.id, stamp, despesa.prestacao_id]
    );
    await addHistory(despesa.prestacao_id, req.user.id, "ajuste_valor_financeiro", justificativa, {
      despesa_id: req.params.id,
      valor_anterior: valorAnterior,
      valor_novo: valor
    });
  }
  res.json({ ok: true });
}));

app.delete("/api/despesas/:id", requireAnyReembolsoPermission("reembolso_solicitar", "reembolso_financeiro"), asyncRoute(async (req, res) => {
  const rows = await query(`
    SELECT d.*, p.status, p.omie_status, p.solicitante_id
      FROM rd_reembolso_despesas d
      JOIN rd_reembolso_prestacoes p ON p.id = d.prestacao_id
     WHERE d.id = ?
     LIMIT 1
  `, [req.params.id]);
  const despesa = rows[0];
  if (!despesa) return res.status(404).json({ error: "Despesa nao encontrada." });
  assertPrestacaoNotFinalizada(despesa);
  if (despesa.status !== "rascunho") {
    return res.status(400).json({ error: "Despesas so podem ser excluidas enquanto a prestacao estiver em rascunho." });
  }
  if (!isFullAccess(req.user) && Number(despesa.solicitante_id) !== Number(req.user.id)) {
    return res.status(403).json({ error: "Voce so pode excluir despesas das suas proprias prestacoes." });
  }

  const comprovantes = await query("SELECT caminho_arquivo FROM rd_reembolso_comprovantes WHERE despesa_id = ?", [req.params.id]);
  await execute("DELETE FROM rd_reembolso_comprovantes WHERE despesa_id = ?", [req.params.id]);
  await execute("DELETE FROM rd_reembolso_despesas WHERE id = ?", [req.params.id]);
  await recalcPrestacao(despesa.prestacao_id);
  await addHistory(despesa.prestacao_id, req.user.id, "excluiu_despesa", `Despesa excluida: ${despesa.descricao || despesa.id}.`, {
    despesa_id: Number(req.params.id),
    valor: Number(despesa.valor || 0)
  });

  for (const item of comprovantes) {
    if (!item.caminho_arquivo) continue;
    const baseDir = path.resolve(uploadDir);
    const filePath = path.resolve(uploadDir, item.caminho_arquivo);
    if (filePath.startsWith(`${baseDir}${path.sep}`)) fs.rm(filePath, { force: true }, () => {});
  }
  res.json({ ok: true });
}));

app.post("/api/prestacoes/:id/cancelar", asyncRoute(async (req, res) => {
  const prestacao = await getPrestacao(req.params.id);
  assertPrestacaoEditable(prestacao, req.user);
  if (prestacao.status === "cancelada") return res.json({ ok: true });

  await execute("UPDATE rd_reembolso_prestacoes SET status = 'cancelada', updated_at = ? WHERE id = ?", [nowSql(), req.params.id]);
  await execute("DELETE FROM rd_reembolso_aprovacoes WHERE prestacao_id = ?", [req.params.id]);
  await execute("UPDATE rd_reembolso_adiantamentos SET status = 'aprovado', prestacao_id = NULL, updated_at = ? WHERE prestacao_id = ?", [nowSql(), req.params.id]);
  await addHistory(req.params.id, req.user.id, "cancelou_prestacao", req.body.justificativa || "Prestacao cancelada e aprovacoes removidas.");
  res.json({ ok: true });
}));

app.delete("/api/prestacoes/:id", asyncRoute(async (req, res) => {
  const prestacao = await getPrestacao(req.params.id);
  assertPrestacaoEditable(prestacao, req.user);

  const comprovantes = await query(`
    SELECT c.caminho_arquivo
      FROM rd_reembolso_comprovantes c
      JOIN rd_reembolso_despesas d ON d.id = c.despesa_id
     WHERE d.prestacao_id = ?
  `, [req.params.id]);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute("DELETE c FROM rd_reembolso_comprovantes c JOIN rd_reembolso_despesas d ON d.id = c.despesa_id WHERE d.prestacao_id = ?", [req.params.id]);
    await conn.execute("DELETE FROM rd_reembolso_despesas WHERE prestacao_id = ?", [req.params.id]);
    await conn.execute("DELETE FROM rd_reembolso_aprovacoes WHERE prestacao_id = ?", [req.params.id]);
    await conn.execute("DELETE FROM rd_reembolso_historico WHERE prestacao_id = ?", [req.params.id]);
    await conn.execute("DELETE FROM rd_reembolso_conta_corrente WHERE prestacao_id = ?", [req.params.id]);
    await conn.execute("UPDATE rd_reembolso_adiantamentos SET status = 'aprovado', prestacao_id = NULL, updated_at = ? WHERE prestacao_id = ?", [nowSql(), req.params.id]);
    await conn.execute("DELETE FROM rd_reembolso_prestacoes WHERE id = ?", [req.params.id]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  for (const item of comprovantes) {
    if (!item.caminho_arquivo) continue;
    const filePath = path.join(uploadDir, item.caminho_arquivo);
    fs.rm(filePath, { force: true }, () => {});
  }

  res.json({ ok: true });
}));

app.post("/api/prestacoes/:id/documento-despesa", requireAnyReembolsoPermission("reembolso_solicitar", "reembolso_financeiro"), upload.single("arquivo"), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Arquivo nao enviado." });
  const prestacao = await getPrestacao(req.params.id);
  try {
    assertPrestacaoNotFinalizada(prestacao);
    assertPrestacaoEditable(prestacao);
    req.file.qr_text = req.body.qr_text || "";
    const validacao = await validarDocumentoDespesa({ prestacao, file: req.file });
    if (validacao.duplicada) {
      fs.rm(req.file.path, { force: true }, () => {});
      return res.status(409).json({ error: validacao.divergencias[0], validacao });
    }
    const token = crypto.randomBytes(18).toString("hex");
    pendingComprovantes.set(token, {
      prestacao_id: Number(req.params.id),
      filename: req.file.filename,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      validacao,
      created_at: Date.now()
    });
    res.status(201).json({ token, validacao });
  } catch (error) {
    fs.rm(req.file.path, { force: true }, () => {});
    throw error;
  }
}));

app.post("/api/despesas/:id/comprovantes", upload.single("arquivo"), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Arquivo nao enviado." });
  const rows = await query(`
    SELECT d.id AS despesa_id, d.prestacao_id, d.data_despesa, d.descricao, d.valor,
           p.status, p.omie_status, p.solicitante_id, p.data_inicio, p.data_fim
      FROM rd_reembolso_despesas d
      JOIN rd_reembolso_prestacoes p ON p.id = d.prestacao_id
     WHERE d.id = ?
  `, [req.params.id]);
  const despesa = rows[0];
  if (!despesa) {
    fs.rm(req.file.path, { force: true }, () => {});
    return res.status(404).json({ error: "Despesa nao encontrada para anexar o comprovante." });
  }
  if (req.body.prestacao_id && Number(req.body.prestacao_id) !== Number(despesa.prestacao_id)) {
    fs.rm(req.file.path, { force: true }, () => {});
    return res.status(409).json({ error: "A tela esta desatualizada. Reabra a prestacao antes de anexar o comprovante." });
  }
  assertPrestacaoNotFinalizada(despesa);
  assertPrestacaoEditable(despesa, req.user);
  const result = await execute(
    `INSERT INTO rd_reembolso_comprovantes
     (despesa_id, nome_original, caminho_arquivo, mime_type, tamanho_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      req.params.id,
      req.file.originalname,
      req.file.filename,
      req.file.mimetype,
      req.file.size,
      nowSql()
    ]
  );
  await execute("UPDATE rd_reembolso_despesas SET status_comprovante = 'anexado', updated_at = ? WHERE id = ?", [nowSql(), req.params.id]);
  await addHistory(despesa.prestacao_id, req.user.id, "anexou_comprovante", `Comprovante anexado na despesa ${despesa.descricao || despesa.despesa_id}.`, {
    despesa_id: Number(req.params.id),
    comprovante_id: result.insertId,
    arquivo: req.file.originalname,
    valor_despesa: Number(despesa.valor || 0)
  });
  res.status(201).json({ id: result.insertId, arquivo: req.file.filename, despesa_id: Number(req.params.id) });
}));

app.delete("/api/comprovantes/:id", asyncRoute(async (req, res) => {
  const rows = await query(`
    SELECT c.*, d.id AS despesa_id, p.status, p.omie_status, p.solicitante_id
      FROM rd_reembolso_comprovantes c
      JOIN rd_reembolso_despesas d ON d.id = c.despesa_id
      JOIN rd_reembolso_prestacoes p ON p.id = d.prestacao_id
     WHERE c.id = ?
     LIMIT 1
  `, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Comprovante nao encontrado." });
  const comprovante = rows[0];
  assertPrestacaoNotFinalizada(comprovante);
  assertPrestacaoEditable(comprovante);
  if (!isFullAccess(req.user) && Number(comprovante.solicitante_id) !== Number(req.user.id)) {
    return res.status(403).json({ error: "Voce so pode excluir comprovantes das suas proprias prestacoes." });
  }

  await execute("DELETE FROM rd_reembolso_comprovantes WHERE id = ?", [req.params.id]);
  const remaining = await query("SELECT COUNT(*) AS total FROM rd_reembolso_comprovantes WHERE despesa_id = ?", [comprovante.despesa_id]);
  if (!Number(remaining[0].total || 0)) {
    await execute("UPDATE rd_reembolso_despesas SET status_comprovante = 'pendente', updated_at = ? WHERE id = ?", [nowSql(), comprovante.despesa_id]);
  }
  if (comprovante.caminho_arquivo) {
    const baseDir = path.resolve(uploadDir);
    const filePath = path.resolve(uploadDir, comprovante.caminho_arquivo);
    if (filePath.startsWith(`${baseDir}${path.sep}`)) fs.rm(filePath, { force: true }, () => {});
  }
  res.json({ ok: true });
}));

app.get("/api/comprovantes/:id/visualizar", asyncRoute(async (req, res) => {
  const rows = await query(`
    SELECT c.*, p.solicitante_id
      FROM rd_reembolso_comprovantes c
      JOIN rd_reembolso_despesas d ON d.id = c.despesa_id
      JOIN rd_reembolso_prestacoes p ON p.id = d.prestacao_id
     WHERE c.id = ?
     LIMIT 1
  `, [req.params.id]);
  if (!rows.length) return res.status(404).send("Comprovante nao encontrado.");
  const comprovante = rows[0];
  if (!isFullAccess(req.user) && Number(comprovante.solicitante_id) !== Number(req.user.id)) {
    return res.status(403).send("Acesso negado.");
  }

  const baseDir = path.resolve(uploadDir);
  const filePath = path.resolve(uploadDir, comprovante.caminho_arquivo);
  if (!filePath.startsWith(`${baseDir}${path.sep}`) || !fs.existsSync(filePath)) {
    return res.status(404).send("Arquivo nao encontrado.");
  }
  const safeName = String(comprovante.nome_original || "comprovante").replace(/[\\"]/g, "");
  res.setHeader("Content-Type", comprovante.mime_type || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);
  res.sendFile(filePath);
}));

app.post("/api/prestacoes/:id/enviar", requireReembolsoPermission("reembolso_solicitar"), asyncRoute(async (req, res) => {
  const detalhes = await query(`
    SELECT COUNT(*) AS despesas,
           SUM(CASE WHEN status_comprovante = 'pendente' THEN 1 ELSE 0 END) AS pendentes
      FROM rd_reembolso_despesas
     WHERE prestacao_id = ?
  `, [req.params.id]);
  if (!detalhes[0].despesas) return res.status(400).json({ error: "Inclua pelo menos uma despesa antes de enviar." });
  if (Number(detalhes[0].pendentes || 0) > 0) return res.status(400).json({ error: "Existem despesas com comprovante pendente." });

  await execute("UPDATE rd_reembolso_prestacoes SET status = 'enviada_superior', enviado_em = ?, updated_at = ? WHERE id = ? AND status IN ('rascunho', 'reprovada_superior', 'reprovada_financeiro')", [nowSql(), nowSql(), req.params.id]);
  await addHistory(req.params.id, req.body.usuario_id || null, "enviou_aprovacao", "Prestacao enviada para aprovacao do superior.");
  const detalhe = await reembolsoPrestacaoEmailResumo(req.params.id, "Uma prestacao de contas de reembolso foi enviada para aprovacao.");
  const prestacao = await getPrestacao(req.params.id);
  await sendReembolsoApprovalEmails({
    titulo: `Prestação ${prestacao?.numero || req.params.id} aguardando aprovação`,
    detalhe,
    link: `${approvalCentralUrl()}?tipo=reembolso_superior&id=${encodeURIComponent(req.params.id)}`,
    emails: [REEMBOLSO_APPROVAL_FLOW[0].email],
    prestacaoId: Number(req.params.id)
  });
  res.json({ ok: true });
}));

app.post("/api/prestacoes/:id/aprovar-superior", requireReembolsoPermission("reembolso_aprovar"), asyncRoute(async (req, res) => {
  res.json(await aprovarPrestacaoReembolso(req.params.id, req.user, req.body.justificativa || null));
}));

app.post("/api/prestacoes/:id/reprovar-superior", requireReembolsoPermission("reembolso_aprovar"), asyncRoute(async (req, res) => {
  res.json(await reprovarPrestacaoReembolso(req.params.id, req.user, req.body.justificativa || null));
}));

app.post("/api/prestacoes/:id/aprovar-financeiro", requireReembolsoPermission("reembolso_financeiro"), asyncRoute(async (_req, res) => {
  res.status(410).json({ error: "A aprovacao financeira foi removida. O financeiro deve integrar a prestacao diretamente na Omie." });
}));

app.post("/api/prestacoes/:id/finalizar-financeiro", requireReembolsoPermission("reembolso_financeiro"), asyncRoute(async (req, res) => {
  const prestacao = await getPrestacao(req.params.id);
  if (prestacao.status === "finalizada") return res.status(400).json({ error: "Prestacao ja finalizada." });
  if (!["em_validacao_financeira", "a_pagar", "a_devolver"].includes(prestacao.status)) return res.status(400).json({ error: "Somente prestacao aprovada/integrada pode ser finalizada." });
  if (prestacao.omie_status !== "integrado") return res.status(400).json({ error: "Integre a prestacao com a Omie antes da finalizacao financeira." });
  await execute("UPDATE rd_reembolso_prestacoes SET status = 'a_pagar', financeiro_id = ?, finalizado_em = ?, updated_at = ? WHERE id = ?", [req.user.id, nowSql(), nowSql(), req.params.id]);
  await addHistory(req.params.id, req.user.id, "finalizou_financeiro", "Financeiro finalizou a prestacao.");
  res.json({ ok: true });
}));

app.get("/api/prestacoes/:id/relatorio", requireReembolsoPermission("reembolso_relatorio"), asyncRoute(async (req, res) => {
  const rows = await query(`
    SELECT p.*, u.nome AS solicitante, u.email, d.nome AS departamento,
           pr.razao_social, pr.nome AS prestador_nome, pr.cnpj, pr.cpf, pr.banco, pr.agencia, pr.conta, pr.omie_codigo_cliente
      FROM rd_reembolso_prestacoes p
      JOIN usuarios u ON u.id = p.solicitante_id
      LEFT JOIN departamentos d ON d.id = p.centro_custo_id
      ${prestadorJoinByUserSql("u", "pr")}
     WHERE p.id = ?
  `, [req.params.id]);
  const prestacao = rows[0];
  if (!prestacao) return res.status(404).send("Prestacao nao encontrada.");
  if (!isFullAccess(req.user) && Number(prestacao.solicitante_id) !== Number(req.user.id)) return res.status(403).send("Acesso negado.");
  if (!["finalizada", "em_validacao_financeira", "a_pagar", "a_devolver", "pago"].includes(prestacao.status)) return res.status(400).send("Relatorio disponivel somente apos aprovacao.");
  const despesas = await query(`
    SELECT d.*, t.nome AS tipo, t.exige_km
      FROM rd_reembolso_despesas d
      JOIN rd_reembolso_tipos_despesa t ON t.id = d.tipo_despesa_id
     WHERE d.prestacao_id = ?
     ORDER BY d.data_despesa, d.id
  `, [req.params.id]);
  const aprovacoes = await query(`
    SELECT a.*, u.nome AS usuario, u.email
      FROM rd_reembolso_aprovacoes a
      JOIN usuarios u ON u.id = a.usuario_id
     WHERE a.prestacao_id = ?
     ORDER BY a.created_at
  `, [req.params.id]);
  const comprovantes = await comprovantesReembolso(req.params.id);
  const resumoFinanceiro = await resumoFinanceiroReembolso(prestacao);
  const historico = await query(`
    SELECT h.*, u.nome AS usuario
      FROM rd_reembolso_historico h
      LEFT JOIN usuarios u ON u.id = h.usuario_id
     WHERE h.prestacao_id = ?
     ORDER BY h.created_at
  `, [req.params.id]);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.send(renderReembolsoReport({ prestacao, despesas, aprovacoes, comprovantes, resumoFinanceiro, historico }));
}));

app.post("/api/prestacoes/:id/integrar-omie", requireReembolsoPermission("reembolso_integrar_omie"), asyncRoute(async (req, res) => {
  const rows = await query(`
    SELECT p.*, u.nome AS solicitante, u.email,
           pr.id AS prestador_id, pr.omie_codigo_cliente, pr.omie_codigo_integracao AS prestador_omie_codigo_integracao,
           pr.razao_social, pr.nome AS prestador_nome, pr.cnpj, pr.cpf,
           pr.email AS prestador_email, pr.telefone, pr.banco, pr.agencia, pr.conta,
           d.nome AS departamento, proj.nome AS projeto
      FROM rd_reembolso_prestacoes p
      JOIN usuarios u ON u.id = p.solicitante_id
      ${prestadorJoinByUserSql("u", "pr")}
      LEFT JOIN departamentos d ON d.id = pr.departamento_id
      LEFT JOIN projetos proj ON proj.id = pr.projeto_id
     WHERE p.id = ?
  `, [req.params.id]);
  const prestacao = rows[0];
  if (!prestacao) return res.status(404).json({ error: "Prestacao nao encontrada." });
  if (!["em_validacao_financeira", "a_pagar"].includes(prestacao.status)) return res.status(400).json({ error: "Somente prestacao aprovada pelos aprovadores pode ser integrada." });
  if (prestacao.omie_status === "integrado") return res.json({ ok: true, ja_integrado: true });
  const superiorApproval = await reembolsoApprovedFlowSteps(req.params.id);
  if (superiorApproval.length < REEMBOLSO_APPROVAL_FLOW.length) return res.status(400).json({ error: "A prestacao precisa das aprovacoes da Simone e do Paulo antes da integracao Omie." });
  if (!String(prestacao.cnpj || prestacao.cpf || "").trim()) return res.status(400).json({ error: "Prestador sem CPF/CNPJ cadastrado para integração Omie." });

  try {
    const dataVencimento = prestacao.data_pagamento_prevista || calcularDataPagamentoReembolso(prestacao.created_at, prestacao.aprovado_superior_em) || new Date().toISOString().slice(0, 10);
    const codigoClienteFornecedor = await ensureOmiePrestador(prestacao, { allowCreate: req.body?.cadastrar_prestadores_omie === true });
    const codigoCategoria = await resolveOmieCategoriaPorNome("Reembolso de Despesas");
    const codigoProjeto = await resolveOmieProjetoPorNome(prestacao.projeto);
    const codigoDepartamento = await resolveOmieDepartamentoPorNome(prestacao.departamento);
    const favorecido = prestacao.razao_social || prestacao.prestador_nome || prestacao.solicitante;
    const documento = prestacao.cnpj || prestacao.cpf;
    const codigoIntegracao = reembolsoOmieIntegrationCode(prestacao);
    const resumoFinanceiro = await resumoFinanceiroReembolso(prestacao);
    const primeiroAdiantamento = [...(resumoFinanceiro.adiantamentosAtuais || []), ...(resumoFinanceiro.saldosPendentes || [])]
      .find((item) => item?.numero);
    const valorAbatimentoPrevisto = toMoney(Math.min(Number(prestacao.valor_adiantado || 0), Number(prestacao.total_despesas || 0)));
    const adiantamentoVinculado = valorAbatimentoPrevisto > 0 && prestacao.adiantamento_id ? await getAdiantamento(prestacao.adiantamento_id) : null;
    const payload = {
      codigo_lancamento_integracao: codigoIntegracao,
      codigo_cliente_fornecedor: Number(codigoClienteFornecedor),
      data_vencimento: formatOmieDate(dataVencimento),
      data_previsao: formatOmieDate(dataVencimento),
      valor_documento: toMoney(prestacao.total_despesas),
      codigo_categoria: codigoCategoria,
      numero_documento_fiscal: prestacao.numero,
      observacao: [
        `Reembolso de despesas ${prestacao.numero}`,
        `Prestador: ${favorecido}`,
        `CPF/CNPJ: ${documento}`,
        prestacao.projeto ? `Projeto: ${prestacao.projeto}` : "",
        prestacao.departamento ? `Departamento: ${prestacao.departamento}` : "",
        `Banco: ${prestacao.banco || ""}`,
        `Agencia/Conta: ${[prestacao.agencia, prestacao.conta].filter(Boolean).join(" / ")}`,
        `E-mail: ${prestacao.email}`
      ].filter(Boolean).join(" | ")
    };
    if (primeiroAdiantamento?.numero || adiantamentoVinculado?.numero) {
      payload.numero_documento = String(primeiroAdiantamento?.numero || adiantamentoVinculado.numero).slice(0, 20);
    }
    if (codigoProjeto) payload.codigo_projeto = Number(codigoProjeto);
    if (codigoDepartamento) payload.distribuicao = [{ cCodDep: String(codigoDepartamento), nPerDep: 100 }];
    const transferInfo = omieTransferInfo(prestacao);
    const contaCorrenteId = resolveConfiguredOmieContaCorrenteId();
    if (transferInfo) {
      if (!contaCorrenteId) {
        return res.status(400).json({ error: "Configure o ID da conta corrente Omie antes de integrar pagamentos por transferencia bancaria." });
      }
      payload.id_conta_corrente = contaCorrenteId;
      payload.cnab_integracao_bancaria = transferInfo;
    }
    const retorno = await omieCall("https://app.omie.com.br/api/v1/financas/contapagar/", "UpsertContaPagar", payload);
    const contaPagarId = omieContaPagarId(retorno, prestacao.omie_codigo_lancamento);
    let compensacao = { valor: 0, skipped: true };
    if (contaPagarId) {
      try {
        compensacao = await compensarPrestacaoComAdiantamento(prestacao, contaPagarId, adiantamentoVinculado);
      } catch (compError) {
        await execute("UPDATE rd_reembolso_prestacoes SET omie_compensacao_status = 'erro', omie_compensacao_erro = ?, omie_status = 'erro', omie_erro = ? WHERE id = ?", [compError.message, compError.message, req.params.id]);
        return res.status(500).json({ error: `Conta a pagar integrada, mas falhou ao compensar adiantamento: ${compError.message}`, retorno });
      }
    }
    const valorLiquidoReembolsar = toMoney(Math.max(Number(prestacao.total_despesas || 0) - Number(compensacao.valor || 0), 0));
    const saldoLiquidoDevolver = toMoney(Math.max(Number(compensacao.valor || 0) - Number(prestacao.total_despesas || 0), 0));
    const nextStatus = valorLiquidoReembolsar > 0 ? "a_pagar" : (saldoLiquidoDevolver > 0 ? "a_devolver" : "pago");
    await execute("UPDATE rd_reembolso_prestacoes SET status = ?, omie_status = 'integrado', omie_codigo_lancamento = ?, omie_codigo_integracao = ?, omie_erro = NULL WHERE id = ?", [nextStatus, contaPagarId, payload.codigo_lancamento_integracao, req.params.id]);
    let anexos = [];
    if (contaPagarId) {
      try {
        anexos = await enviarAnexosReembolsoOmie({ ...prestacao, id: Number(req.params.id) }, contaPagarId);
        await execute("UPDATE rd_reembolso_prestacoes SET omie_anexos_status = 'integrado', omie_anexos_erro = NULL, omie_anexos_em = ? WHERE id = ?", [nowSql(), req.params.id]);
      } catch (anexoError) {
        await execute("UPDATE rd_reembolso_prestacoes SET omie_anexos_status = 'erro', omie_anexos_erro = ? WHERE id = ?", [anexoError.message, req.params.id]);
        return res.status(500).json({ error: `Conta a pagar integrada, mas falhou ao enviar anexos: ${anexoError.message}`, retorno });
      }
    }
    res.json({ ok: true, retorno, anexos, compensacao });
  } catch (error) {
    await execute("UPDATE rd_reembolso_prestacoes SET omie_status = 'erro', omie_erro = ? WHERE id = ?", [error.message, req.params.id]);
    if (error.code === "OMIE_PRESTADOR_PENDENTE") {
      return res.status(409).json({
        code: error.code,
        error: "Prestador sem cadastro no Omie. Deseja cadastrá-lo como fornecedor PJ?",
        prestadores: [error.prestador],
      });
    }
    res.status(500).json({ error: error.message });
  }
}));

app.post("/api/prestacoes/:id/enviar-anexos-omie", requireReembolsoPermission("reembolso_integrar_omie"), asyncRoute(async (req, res) => {
  const prestacao = await getPrestacao(req.params.id);
  if (!prestacao) return res.status(404).json({ error: "Prestacao nao encontrada." });
  if (!prestacao.omie_codigo_lancamento) return res.status(400).json({ error: "Prestacao ainda nao possui lancamento Omie para anexar arquivos." });
  try {
    const anexos = await enviarAnexosReembolsoOmie(prestacao, prestacao.omie_codigo_lancamento);
    await execute("UPDATE rd_reembolso_prestacoes SET omie_anexos_status = 'integrado', omie_anexos_erro = NULL, omie_anexos_em = ? WHERE id = ?", [nowSql(), req.params.id]);
    res.json({ ok: true, anexos });
  } catch (error) {
    await execute("UPDATE rd_reembolso_prestacoes SET omie_anexos_status = 'erro', omie_anexos_erro = ? WHERE id = ?", [error.message, req.params.id]);
    res.status(500).json({ error: error.message });
  }
}));

app.post("/api/prestacoes/:id/sincronizar-omie-pagamento", requireReembolsoPermission("reembolso_integrar_omie"), asyncRoute(async (req, res) => {
  const prestacao = await getPrestacao(req.params.id);
  if (!prestacao) return res.status(404).json({ error: "Prestacao nao encontrada." });
  if (!prestacao.omie_codigo_lancamento) return res.status(400).json({ error: "Prestacao ainda nao possui lancamento Omie." });
  const resultado = await syncOmiePagamentoPrestacao(prestacao);
  res.json({ ok: true, resultado });
}));

app.post("/api/omie/sincronizar-pagamentos", requireReembolsoPermission("reembolso_integrar_omie"), asyncRoute(async (_req, res) => {
  const resultados = await syncOmiePagamentos({ limit: 80 });
  res.json({ ok: true, total: resultados.length, pagos: resultados.filter((item) => item.pago).length, resultados });
}));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.statusCode || 500).json({ error: err.message || "Erro interno." });
});

let syncingOmiePagamentos = false;
async function runOmiePaymentSync() {
  if (syncingOmiePagamentos || !omieConfigured()) return;
  syncingOmiePagamentos = true;
  try {
    await syncOmiePagamentos({ limit: 80 });
  } catch (error) {
    console.error("Falha ao sincronizar pagamentos Omie:", error.message);
  } finally {
    syncingOmiePagamentos = false;
  }
}

ensureSchema()
  .then(() => {
    app.listen(port, host, () => {
      console.log(`Reembolso de Despesas em http://${host}:${port}`);
      setTimeout(runOmiePaymentSync, 15000);
      setInterval(runOmiePaymentSync, 30 * 60 * 1000);
      setInterval(cleanupPendingComprovantes, 15 * 60 * 1000);
    });
  })
  .catch((err) => {
    console.error("Falha ao iniciar schema do Reembolso de Despesas:", err);
    process.exit(1);
  });

