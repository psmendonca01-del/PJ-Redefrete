const ExcelJS = require("exceljs");
const mysql = require("mysql2/promise");
require("dotenv").config();

const workbookPath = process.argv[2] || "PJ_Redefrete.xlsx";

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function parseMoney(value) {
  const text = String(value || "").trim();
  if (!text || text === "-") return 0;
  return Number(text.replace(/\s/g, "").replace(/,/g, "")) || 0;
}

function excelDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function competencia(value) {
  const date = excelDate(value);
  return date ? date.slice(0, 7) : null;
}

async function main() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(workbookPath);
  const sheet = workbook.worksheets[0];
  const headers = sheet.getRow(1).values.slice(1).map((value) => String(value || "").trim());
  const rows = [];

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const item = {};
    headers.forEach((header, index) => {
      item[header] = row.getCell(index + 1).value || "";
    });
    if (Object.values(item).some((value) => String(value || "").trim() !== "")) rows.push(item);
  });

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  async function findOrCreate(table, nome, fallback) {
    const value = String(nome || fallback).trim() || fallback;
    await connection.query(`INSERT IGNORE INTO ${table} (nome) VALUES (?)`, [value]);
    const [[row]] = await connection.query(`SELECT id FROM ${table} WHERE nome = ?`, [value]);
    return row.id;
  }

  const firstCompetencia = competencia(rows[0]?.inicio_mes) || new Date().toISOString().slice(0, 7);
  const diasMes = Number(rows[0]?.qt_dias_mes || 30);
  await connection.query(
    `INSERT INTO folhas (competencia, dias_mes, status, fechado_em)
     VALUES (?, ?, 'fechada', NOW())`,
    [firstCompetencia, diasMes],
  );
  const [[folha]] = await connection.query("SELECT id FROM folhas WHERE competencia = ?", [firstCompetencia]);

  for (const row of rows) {
    const unidadeId = await findOrCreate("unidades", "REDEFRETE", "REDEFRETE");
    const funcaoId = await findOrCreate("funcoes", row.Funcao, "Nao informado");
    const categoriaId = await findOrCreate("categorias", row.Categoria, "Prestadores de Servicos");
    const departamentoId = await findOrCreate("departamentos", row.Departamento, "Sem departamento");
    const projetoId = await findOrCreate("projetos", row.Projeto, "REDEFRETE");
    const [result] = await connection.query(
      `INSERT INTO prestadores
       (unidade_id, funcao_id, categoria_id, departamento_id, projeto_id, nome, cpf, cnpj, razao_social,
        data_admissao, salario_contrato, banco, agencia, conta, pix_cpf_cnpj)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        unidadeId,
        funcaoId,
        categoriaId,
        departamentoId,
        projetoId,
        row.Nome,
        onlyDigits(row.CPF),
        onlyDigits(row.CNPJ),
        row.Razao_Social || row.Nome,
        excelDate(row.Data_admissao),
        parseMoney(row.Salario),
        row.CodBanco || null,
        row.Agencia || null,
        row.Conta || null,
        row.CPF_CNPJ || null,
      ],
    );

    const salario = parseMoney(row.Salario);
    const valorDias = parseMoney(row.Valor);
    const adicoes = parseMoney(row.Adicoes);
    const bonus = parseMoney(row.Bonus);
    const nfPrevista = parseMoney(row.Valor_NF);
    const descontos = parseMoney(row.Descontos);
    const liquido = parseMoney(row.Liquido_pagar);
    const nfEmitida = parseMoney(row.Valor_NF_Emitida);

    await connection.query(
      `INSERT INTO folha_itens
       (folha_id, prestador_id, dias_trabalhados, salario_base, valor_dias, adicoes, bonus,
        descontos_manual, desconto_adiantamentos, valor_nf_previsto, valor_nf_emitida,
        numero_nf, liquido_pagar)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      [
        folha.id,
        result.insertId,
        Number(row.qt_dias_mes || diasMes),
        salario,
        valorDias,
        adicoes,
        bonus,
        descontos,
        nfPrevista,
        nfEmitida,
        row.N_NF || null,
        liquido,
      ],
    );
  }

  await connection.end();
  console.log(`${rows.length} prestadores importados e folha ${firstCompetencia} criada.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
