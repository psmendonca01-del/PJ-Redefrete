# Redefrete Pagamentos PJ

Sistema local para cadastro de prestadores PJ, controle de adiantamentos parcelados e fechamento mensal de pagamentos.

## Rodar

```bash
npm install
npm start
```

Abra `http://localhost:3000`.

## Banco

As credenciais ficam em `.env`.

```bash
npm run db:migrate
npm run db:import
```

`db:migrate` recria o schema do banco. `db:import` carrega a planilha `PJ_Redefrete.xlsx`, importa os prestadores e cria a folha inicial da competencia da planilha.

## Regras implementadas

- Cadastro de prestadores com validacao de CPF e CNPJ.
- E-mail e telefone no cadastro para follow-up de emissao de NFs.
- Unidade atendida em tabela propria, vinculada ao prestador.
- Funcao, categoria, departamento e projeto em tabelas proprias, vinculadas ao prestador.
- Salario acordado em contrato no cadastro.
- Painel com folha aberta do mes atual e folhas fechadas ordenadas da mais recente para a mais antiga.
- Fechamento mensal por competencia, com bloqueio de alteracao para folhas fechadas sem modo administrador.
- Calculo automatico dos dias do mes e proporcional: salario / dias do mes * dias trabalhados.
- Adicoes, bonus, descontos manuais, numero da NF, valor total a pagar, valor da NF emitida e diferenca.
- Controle de adiantamentos com desconto em uma ou varias parcelas.
- Comparativo por departamento mes a mes com drill.
- Rescisao de contrato PJ com data, calculo proporcional automatico e bloqueio para periodos anteriores ou ja fechados.
- Fechamento bloqueado enquanto houver prestador sem numero de NF ou valor de NF emitida.
- Aviso de emissao de NF por e-mail com valor total a pagar e prazo ate o dia 3 do mes seguinte.
