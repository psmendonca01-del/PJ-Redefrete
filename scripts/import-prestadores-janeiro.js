const ExcelJS = require("exceljs");
const mysql = require("mysql2/promise");
require("dotenv").config();

const workbookPath = process.argv[2] || "janeiro_2026.xlsx";

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function excelDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
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

  let inserted = 0;
  let updated = 0;

  for (const row of rows) {
    const cpf = onlyDigits(row.CPF);
    const cnpj = onlyDigits(row.CNPJ);
    if (!cpf || !cnpj) continue;

    const unidadeId = await findOrCreate("unidades", "REDEFRETE", "REDEFRETE");
    const funcaoId = await findOrCreate("funcoes", row["Função"], "Nao informado");
    const categoriaId = await findOrCreate("categorias", row.Categoria, "Prestadores de Servicos");
    const departamentoId = await findOrCreate("departamentos", row.Departamento, "Sem departamento");
    const projetoId = await findOrCreate("projetos", row.Projeto, "REDEFRETE");

    const [[existing]] = await connection.query(
      "SELECT id FROM prestadores WHERE cpf = ? OR cnpj = ? LIMIT 1",
      [cpf, cnpj],
    );

    const payload = [
      unidadeId,
      funcaoId,
      categoriaId,
      departamentoId,
      projetoId,
      row.Nome || "",
      cpf,
      cnpj,
      row["RAZÃO SOCIAL"] || row.Nome || "",
      excelDate(row["Data Admissão"]),
      Number(row["Salário"] || 0),
      row.CodBanco || null,
      row["Agência"] || null,
      row.Conta || null,
      row["CPF/CNPJ"] || null,
    ];

    if (existing) {
      await connection.query(
        `UPDATE prestadores SET
          unidade_id = ?, funcao_id = ?, categoria_id = ?, departamento_id = ?, projeto_id = ?,
          nome = ?, cpf = ?, cnpj = ?, razao_social = ?, data_admissao = ?, salario_contrato = ?,
          banco = ?, agencia = ?, conta = ?, pix_cpf_cnpj = ?, ativo = 1
         WHERE id = ?`,
        [...payload, existing.id],
      );
      updated += 1;
    } else {
      await connection.query(
        `INSERT INTO prestadores
         (unidade_id, funcao_id, categoria_id, departamento_id, projeto_id, nome, cpf, cnpj,
          razao_social, data_admissao, salario_contrato, banco, agencia, conta, pix_cpf_cnpj)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        payload,
      );
      inserted += 1;
    }
  }

  await connection.end();
  console.log(`Importacao concluida. Inseridos: ${inserted}. Atualizados: ${updated}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
