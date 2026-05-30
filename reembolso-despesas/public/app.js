const state = {
  usuario: null,
  usuarios: [],
  tipos: [],
  centros: [],
  adiantamentos: [],
  prestacoes: [],
  contaCorrente: { saldo: 0, movimentos: [] },
  config: {},
  prestacaoStatusFilter: "todos",
  adiantamentoListFilter: "todos"
};
state.editingAdiantamentoId = null;
state.editingDespesaId = null;
state.editingDespesaOriginalValor = null;
state.currentPrestacaoId = null;
state.despesaDocumentoValidacao = null;

document.body.classList.add("auth-pending");

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const roundMoney = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const fmtMoney = (value) => brl.format(Number(value || 0));
const fmtDate = (value) => {
  if (!value) return "-";
  const [year, month, day] = String(value).slice(0, 10).split("-");
  return year && month && day ? `${day}/${month}/${year}` : String(value);
};
const byId = (id) => document.getElementById(id);
const PRESTACAO_ABERTA_STATUSES = new Set([
  "rascunho",
  "enviada_superior",
  "em_validacao_financeira",
  "a_pagar",
  "a_devolver",
  "reprovada_superior",
  "reprovada_financeiro"
]);
const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");
const userInitials = (name = "") => {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "--";
  return `${parts[0][0] || ""}${parts.length > 1 ? parts[parts.length - 1][0] || "" : ""}`.toUpperCase();
};
const firstName = (name = "") => String(name || "").trim().split(/\s+/).filter(Boolean)[0] || "Usuario";
let busyCount = 0;
let qrScannerStream = null;
let qrScannerTimer = null;
let qrScannerBusy = false;
let qrHtml5Scanner = null;

async function api(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const showProgress = options.progress !== false;
  const progressTitle = options.progressTitle || (method === "GET" ? "Carregando" : "Processando");
  const progressMessage = options.progressMessage || "Aguarde, o sistema está operando.";
  if (showProgress) showBusy(progressTitle, progressMessage);
  const fetchOptions = { ...options };
  delete fetchOptions.progress;
  delete fetchOptions.progressTitle;
  delete fetchOptions.progressMessage;
  try {
    const response = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(fetchOptions.headers || {}) },
      ...fetchOptions
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || "Falha na operação.");
      Object.assign(error, data, { status: response.status });
      throw error;
    }
    return data;
  } finally {
    if (showProgress) hideBusy();
  }
}

function fullAccess() {
  return Boolean(state.usuario?.full_access);
}

function hasPerm(permission) {
  return Boolean(state.usuario?.permissoes?.[permission]);
}

function canUseFinanceiro() {
  return hasPerm("reembolso_admin") || hasPerm("reembolso_financeiro");
}

function canUseCadastros() {
  return hasPerm("reembolso_admin") || canUseFinanceiro();
}

function canAccessView(name) {
  if (name === "financeiro") return canUseFinanceiro();
  if (name === "cadastros") return canUseCadastros();
  return true;
}

function confirmOmiePrestadorCadastro(error) {
  if (error.code !== "OMIE_PRESTADOR_PENDENTE") return false;
  const prestadores = error.prestadores || [];
  const lista = prestadores
    .map((prestador) => `- ${prestador.razao_social || prestador.nome || "Prestador"}${prestador.cnpj ? ` (${prestador.cnpj})` : ""}`)
    .join("\n");
  return confirm(`${error.message}\n\n${lista}\n\nDeseja cadastrar este prestador como fornecedor PJ no Omie e continuar?`);
}
function showStatus(message, error = false) {
  const el = byId("status");
  el.textContent = message;
  el.className = error ? "status error" : "status";
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 4500);
}

function showBusy(title = "Integrando com Omie", message = "Aguarde, estamos processando as informações.") {
  busyCount += 1;
  const overlay = byId("busyOverlay");
  if (!overlay) return;
  byId("busyTitle").textContent = title;
  byId("busyMessage").textContent = message;
  overlay.hidden = false;
}

function hideBusy() {
  busyCount = Math.max(0, busyCount - 1);
  if (busyCount > 0) return;
  const overlay = byId("busyOverlay");
  if (overlay) overlay.hidden = true;
}

function openPrestacaoCreateDialog() {
  const aberta = prestacaoAbertaDoSolicitante(state.usuario?.id);
  if (aberta && !fullAccess()) {
    showStatus(`Existe uma prestação aberta (${aberta.numero}). Finalize ou cancele antes de abrir uma nova.`, true);
    return;
  }
  const form = byId("prestacaoForm");
  form.reset();
  form.solicitante_id.value = state.usuario.id;
  renderAdiantamentoSelect();
  byId("prestacaoCreateDialog").showModal();
}

function optionList(items, placeholder = "Selecione") {
  return [`<option value="">${placeholder}</option>`]
    .concat(items.map((item) => `<option value="${item.id}">${item.nome}</option>`))
    .join("");
}

function statusPill(status) {
  const labels = {
    rascunho: "rascunho",
    em_aprovacao: "em aprovação",
    aprovado: "aprovado",
    prestado: "prestado",
    reprovado: "reprovado",
    cancelado: "cancelado",
    a_pagar: "a pagar",
    a_devolver: "a devolver",
    pago: "pago",
    finalizada: "finalizada",
    reprovada_superior: "reprovada",
    reprovada_financeiro: "reprovada financeiro",
    em_validacao_financeira: "em validação financeira",
    enviada_superior: "enviada ao superior",
    omie_integrada: "Omie integrada"
  };
  return `<span class="pill ${status}">${labels[status] || String(status || "").replaceAll("_", " ")}</span>`;
}

function canChangeAdiantamento(status) {
  return ["rascunho", "em_aprovacao", "reprovado", "cancelado"].includes(status);
}

function canChangePrestacao(status) {
  return ["rascunho", "enviada_superior", "reprovada_superior", "reprovada_financeiro", "cancelada"].includes(status);
}

function canFinanceiroEditPrestacao(prestacao) {
  return canUseFinanceiro()
    && prestacao?.status === "em_validacao_financeira"
    && !["integrado", "pago"].includes(prestacao?.omie_status);
}

function isPrestacaoLocked(prestacao) {
  return ["a_pagar", "a_devolver", "finalizada", "integrada_omie", "pago"].includes(prestacao?.status) || ["integrado", "pago"].includes(prestacao?.omie_status);
}

function canAdminManagePrestacao(prestacao) {
  return hasPerm("reembolso_admin") && !isPrestacaoLocked(prestacao);
}

function renderComprovantes(despesa, locked) {
  const comprovantes = despesa.comprovantes_lista || [];
  const uploadContext = [
    fmtDate(despesa.data_despesa),
    despesa.tipo_despesa,
    despesa.descricao,
    fmtMoney(despesa.valor)
  ].filter(Boolean).join(" | ");
  if (comprovantes.length) {
    return `<div class="comprovantes-actions">
      ${comprovantes.map((comprovante, index) => `
        <span class="comprovante-chip">
          <button class="small" type="button" data-comprovante="${comprovante.id}" data-comprovante-name="${escapeHtml(comprovante.nome_original || `Comprovante ${index + 1}`)}">
            Visualizar
          </button>
          ${!locked ? `<button class="small danger" type="button" data-comprovante-excluir="${comprovante.id}">Excluir</button>` : ""}
        </span>
      `).join("")}
    </div>`;
  }
  if (locked) return "Bloqueado";
  return `
    <form class="upload-form" data-upload="${despesa.id}" data-prestacao="${state.currentPrestacaoId || ""}" data-upload-context="${escapeHtml(uploadContext)}">
      <input type="hidden" name="prestacao_id" value="${state.currentPrestacaoId || ""}">
      <input type="file" name="arquivo" required>
      <button class="small" type="submit">Anexar</button>
    </form>
  `;
}

function openComprovante(id, name) {
  const title = name || "Comprovante";
  const url = `/api/comprovantes/${encodeURIComponent(id)}/visualizar`;
  const isImage = /\.(png|jpe?g|webp|gif|bmp)$/i.test(title);
  byId("comprovanteTitle").textContent = title;
  byId("comprovanteViewer").innerHTML = isImage
    ? `<img src="${url}" alt="${escapeHtml(title)}">`
    : `<iframe src="${url}" title="${escapeHtml(title)}"></iframe>`;
  byId("comprovanteDialog").showModal();
}

function setView(name) {
  if (!canAccessView(name)) name = "dashboard";
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === name));
  document.querySelector(".connection")?.classList.remove("open");
  byId("accountMenuBtn")?.setAttribute("aria-expanded", "false");
  const titles = {
    dashboard: "Painel de reembolsos",
    adiantamentos: "Adiantamentos de despesas",
    prestacoes: "Prestação de contas",
    financeiro: "Painel financeiro",
    cadastros: "Cadastros auxiliares"
  };
  byId("pageTitle").textContent = titles[name] || "Reembolso de Despesas";
  const newPrestacao = byId("newPrestacaoBtn");
  if (newPrestacao) newPrestacao.hidden = name !== "prestacoes" || !hasPerm("reembolso_solicitar");
}

function clearListFilters() {
  state.prestacaoStatusFilter = "todos";
  state.adiantamentoListFilter = "todos";
  const search = byId("prestacaoSearch");
  if (search) search.value = "";
  const status = byId("prestacaoStatusSelect");
  if (status) status.value = "todos";
}

function applyDashboardFilter(filter) {
  clearListFilters();
  if (filter === "adiantamentos_abertos") {
    state.adiantamentoListFilter = "saldo";
    setView("adiantamentos");
    renderAdiantamentos();
    return;
  }
  if (filter === "aprovacao") {
    state.prestacaoStatusFilter = "aprovacao";
    setView("prestacoes");
    renderPrestacoes();
    return;
  }
  if (filter === "financeiro") {
    if (canUseFinanceiro()) {
      setView("financeiro");
      renderFinanceiro();
    } else {
      state.prestacaoStatusFilter = "financeiro";
      setView("prestacoes");
      renderPrestacoes();
    }
    return;
  }
  if (filter === "finalizadas") {
    state.prestacaoStatusFilter = "finalizadas";
    setView("prestacoes");
    renderPrestacoes();
  }
}

async function loadBootstrap() {
  const data = await api("/api/bootstrap", { progressTitle: "Carregando dados" });
  state.usuario = data.usuario;
  state.usuarios = data.usuarios || [];
  state.tipos = data.tipos || [];
  state.centros = data.centros || [];
  state.config = data.config || {};

  const solicitantes = fullAccess() ? state.usuarios : [state.usuario];
  document.querySelectorAll("select[name='solicitante_id']").forEach((select) => {
    select.innerHTML = optionList(solicitantes);
    select.value = state.usuario.id;
    select.disabled = !fullAccess();
  });
  const contaFiltro = byId("contaPrestadorFiltro");
  if (contaFiltro) {
    contaFiltro.innerHTML = `<option value="">Todos os prestadores com movimentacao</option>`;
  }
  document.querySelectorAll("select[name='superior_id']").forEach((select) => {
    select.innerHTML = optionList(data.aprovadores?.length ? data.aprovadores : state.usuarios);
  });
  document.querySelectorAll("select[name='centro_custo_id']").forEach((select) => {
    select.innerHTML = optionList(state.centros);
  });
  byId("tiposList").innerHTML = state.tipos.map((tipo) => `<span class="tag">${tipo.nome}</span>`).join("");
  byId("centrosList").innerHTML = state.centros.map((centro) => `<span class="tag">${centro.nome}${centro.unidade ? ` | ${centro.unidade}` : ""}</span>`).join("");
  byId("currentUserLabel").textContent = `${state.usuario.nome} | ${state.usuario.perfil}`;
  if (byId("accountFirstName")) byId("accountFirstName").textContent = firstName(state.usuario.nome);
  const canIntegrate = canUseFinanceiro() && hasPerm("reembolso_integrar_omie");
  byId("syncOmieBtn").hidden = !canIntegrate;
  byId("selectFinanceiroOmieBtn").hidden = !canIntegrate;
  byId("integrarSelecionadosBtn").hidden = !canIntegrate;
  document.querySelector('.nav-item[data-view="financeiro"]').hidden = !canUseFinanceiro();
  document.querySelector('.nav-item[data-view="cadastros"]').hidden = !canUseCadastros();
  byId("newPrestacaoBtn").hidden = !hasPerm("reembolso_solicitar");
  document.body.classList.remove("auth-pending");
  setView(document.querySelector(".nav-item.active")?.dataset.view || "dashboard");
}

async function loadAll() {
  const [dashboard, adiantamentos, prestacoes, contaCorrente] = await Promise.all([
    api("/api/dashboard"),
    api("/api/adiantamentos"),
    api("/api/prestacoes"),
    api("/api/conta-corrente-adiantamentos")
  ]);
  state.adiantamentos = adiantamentos;
  state.prestacoes = prestacoes;
  state.contaCorrente = contaCorrente;
  renderDashboard(dashboard);
  renderAdiantamentos();
  renderPrestacoes();
  renderFinanceiro();
  renderAdiantamentoSelect();
  renderDevolucaoSelects();
  renderContaCorrente();
}

function renderDashboard(dashboard) {
  const status = Object.fromEntries((dashboard.status || []).map((row) => [row.status, row]));
  const saldoAdiantamentos = state.contaCorrente?.saldo || dashboard.adiantamentos_abertos?.valor || 0;
  const adiantamentosComSaldo = new Set((state.contaCorrente?.movimentos || []).filter((row) => Number(row.adiantamento_id) && saldoAdiantamento(row.adiantamento_id) > 0).map((row) => Number(row.adiantamento_id)));
  byId("metricAdiantamentos").textContent = dashboard.adiantamentos_abertos?.total || adiantamentosComSaldo.size || 0;
  byId("metricAdiantamentosValor").textContent = fmtMoney(saldoAdiantamentos);
  byId("metricAprovacao").textContent = status.enviada_superior?.total || 0;
  const prestacoesFinanceiro = state.prestacoes.filter((row) => ["em_validacao_financeira", "a_pagar", "a_devolver"].includes(row.status));
  const totalAReembolsar = prestacoesFinanceiro.reduce((sum, row) => {
    const resumo = resumoFinanceiroPrestacao(row);
    return sum + (resumo.saldoFinal > 0 ? resumo.saldoValor : 0);
  }, 0);
  const totalADevolver = prestacoesFinanceiro.reduce((sum, row) => {
    const resumo = resumoFinanceiroPrestacao(row);
    return sum + (resumo.saldoFinal < 0 ? resumo.saldoValor : 0);
  }, 0);
  byId("metricFinanceiro").textContent = prestacoesFinanceiro.length;
  byId("metricFinanceiroValor").textContent = `${fmtMoney(totalAReembolsar)} a reembolsar | ${fmtMoney(totalADevolver)} a devolver`;
  byId("metricFinalizadas").textContent = Number(status.finalizada?.total || 0) + Number(status.pago?.total || 0);

  byId("recentPrestacoes").innerHTML = state.prestacoes.slice(0, 8).map((row) => `
    <tr>
      <td><strong>${row.numero}</strong></td>
      <td>${row.solicitante}</td>
      <td>${row.data_inicio} a ${row.data_fim}</td>
      <td>${statusPill(row.status)}</td>
      <td>${fmtMoney(row.total_despesas)}</td>
      <td class="money-detail">${renderAdiantamentosResumo(row)}</td>
      <td class="money-detail result">${renderResultadoPrestacao(row)}</td>
    </tr>
  `).join("") || `<tr><td colspan="7" class="muted">Nenhuma prestação cadastrada.</td></tr>`;
}

function renderAdiantamentoSelect() {
  const solicitanteId = Number(document.querySelector("#prestacaoForm select[name='solicitante_id']")?.value || state.usuario?.id || 0);
  const open = state.adiantamentos.filter((item) => item.status === "aprovado" && Number(item.solicitante_id) === solicitanteId);
  const openIds = new Set(open.map((item) => Number(item.id)));
  const total = open.reduce((sum, item) => sum + Math.max(saldoAdiantamento(item.id), Number(item.valor || 0)), 0);
  const saldosPendentes = (state.adiantamentos || [])
    .filter((item) => Number(item.solicitante_id) === solicitanteId && !openIds.has(Number(item.id)))
    .map((item) => ({ ...item, saldo: saldoAdiantamento(item.id) }))
    .filter((item) => item.saldo > 0.009);
  const el = byId("advanceSummary");
  if (!el) return;
  const lines = [];
  const prestacaoAberta = prestacaoAbertaDoSolicitante(solicitanteId);
  if (prestacaoAberta) {
    lines.push(`<span class="pending-balance">Este prestador ja possui a prestação aberta <strong>${escapeHtml(prestacaoAberta.numero)}</strong>. Finalize ou cancele antes de abrir uma nova.</span>`);
  }
  if (open.length) {
    lines.push(`Adiantamentos aprovados em aberto: <strong>${fmtMoney(total)}</strong><br><small>${open.map((item) => `${item.numero} (${fmtMoney(Math.max(saldoAdiantamento(item.id), Number(item.valor || 0)))})`).join(" | ")}</small>`);
  } else {
    lines.push("Sem adiantamentos aprovados em aberto.");
  }
  lines.push(...saldosPendentes.map((item) => `<span class="pending-balance">Saldo pendente de <strong>${fmtMoney(item.saldo)}</strong> referente ao Adiantamento Nº ${escapeHtml(item.numero || "-")} de ${fmtDate(item.data_adiantamento)}</span>`));
  el.innerHTML = lines.join("<br>");
}

function renderAdiantamentos() {
  const rows = state.adiantamentos.filter((row) => state.adiantamentoListFilter !== "saldo" || saldoAdiantamento(row.id) > 0);
  byId("adiantamentosRows").innerHTML = rows.map((row) => `
    <tr>
      <td data-label="Número"><strong>${row.numero}</strong></td>
      <td data-label="Solicitante">${row.solicitante}</td>
      <td data-label="Data">${row.data_adiantamento}</td>
      <td data-label="Valor">${fmtMoney(row.valor)}</td>
      <td data-label="Saldo"><strong>${fmtMoney(saldoAdiantamento(row.id))}</strong></td>
      <td data-label="Status">${statusPill(row.status)} ${row.omie_status === "integrado" ? statusPill("omie_integrada") : ""}</td>
      <td data-label="Ação">
        <button class="small" data-vinculos-adiantamento="${row.id}">Vínculos</button>
        ${canChangeAdiantamento(row.status) ? `
          <div class="row-actions">
            ${row.status !== "cancelado" ? `<button class="small" data-adiantamento-cancelar="${row.id}">Cancelar</button>` : ""}
            ${row.status !== "aprovado" ? `<button class="small" data-adiantamento-editar="${row.id}">Editar</button>` : ""}
            ${row.status !== "aprovado" ? `<button class="small" data-adiantamento-enviar="${row.id}">Enviar aprovação</button>` : ""}
            ${hasPerm("reembolso_aprovar") && row.status === "em_aprovacao" ? `<button class="small" data-adiantamento-aprovar="${row.id}">Aprovar</button>` : ""}
            <button class="small danger" data-adiantamento-excluir="${row.id}">Excluir</button>
          </div>
        ` : ""}
        ${hasPerm("reembolso_integrar_omie") && ["aprovado", "prestado"].includes(row.status) && row.omie_status !== "integrado" ? `<button class="small primary" data-adiantamento-integrar="${row.id}">Integrar Omie</button>` : ""}
      </td>
    </tr>
  `).join("") || `<tr><td colspan="7" class="muted">Nenhum adiantamento cadastrado.</td></tr>`;
}

function openAdiantamentoDialog(item = null) {
  const form = byId("adiantamentoForm");
  form.reset();
  state.editingAdiantamentoId = item?.id || null;
  byId("adiantamentoDialogTitle").textContent = item ? `Editar ${item.numero}` : "Novo adiantamento";
  form.querySelector("button[type='submit']").textContent = item ? "Salvar alterações" : "Salvar adiantamento";
  if (item) {
    form.solicitante_id.value = item.solicitante_id || state.usuario.id;
    form.superior_id.value = item.superior_id || "";
    form.data_adiantamento.value = String(item.data_adiantamento || "").slice(0, 10);
    form.valor.value = item.valor || "";
    form.centro_custo_id.value = item.centro_custo_id || "";
    form.finalidade.value = item.finalidade || "";
    form.descritivo.value = item.descritivo || "";
  } else {
    form.solicitante_id.value = state.usuario.id;
    form.data_adiantamento.value = new Date().toISOString().slice(0, 10);
  }
  byId("adiantamentoDialog").showModal();
}

function renderDevolucaoSelects() {
  const form = byId("devolucaoForm");
  if (!form) return;
  const solicitanteId = Number(form.solicitante_id.value || state.usuario?.id || 0);
  const adiantamentos = state.adiantamentos.filter((item) => Number(item.solicitante_id) === solicitanteId && saldoAdiantamento(item.id) > 0);
  form.adiantamento_id.innerHTML = [`<option value="">Selecione</option>`]
    .concat(adiantamentos.map((item) => `<option value="${item.id}">${item.numero} - saldo ${fmtMoney(saldoAdiantamento(item.id))}</option>`))
    .join("");
  renderDevolucaoResumo();
}

function saldoAdiantamento(adiantamentoId) {
  return (state.contaCorrente?.movimentos || [])
    .filter((item) => Number(item.adiantamento_id) === Number(adiantamentoId))
    .reduce((sum, item) => sum + Number(item.valor || 0), 0);
}

function saldosPendentesPrestacao(prestacao) {
  const prestacaoId = Number(prestacao.id || 0);
  return (state.adiantamentos || [])
    .filter((item) => {
      if (Number(item.solicitante_id) !== Number(prestacao.solicitante_id)) return false;
      const origemPrestacaoId = Number(item.prestacao_id || 0);
      if (!origemPrestacaoId) return true;
      return origemPrestacaoId < prestacaoId;
    })
    .map((item) => ({ ...item, saldo: saldoAdiantamento(item.id) }))
    .filter((item) => item.saldo > 0.009);
}

function adiantamentosUsadosPrestacao(prestacao) {
  const movimentos = (state.contaCorrente?.movimentos || [])
    .filter((item) => Number(item.prestacao_id) === Number(prestacao.id) && item.tipo === "compensacao_prestacao");
  const byAdiantamento = new Map();
  for (const mov of movimentos) {
    const key = Number(mov.adiantamento_id || 0) || mov.adiantamento_numero || "adiantamento";
    const current = byAdiantamento.get(key) || {
      id: Number(mov.adiantamento_id || 0) || null,
      numero: mov.adiantamento_numero || mov.numero_documento || "Adiantamento",
      saldo: 0
    };
    current.saldo = roundMoney(current.saldo + Math.abs(Number(mov.valor || 0)));
    byAdiantamento.set(key, current);
  }
  return [...byAdiantamento.values()].filter((item) => item.saldo > 0.009);
}

function resumoFinanceiroPrestacao(prestacao) {
  const totalDespesas = Number(prestacao.total_despesas || 0);
  const adiantamentosUsados = adiantamentosUsadosPrestacao(prestacao);
  const adiantado = adiantamentosUsados.length
    ? adiantamentosUsados.reduce((sum, item) => {
        const adiantamento = state.adiantamentos.find((row) => Number(row.id) === Number(item.id) || row.numero === item.numero);
        const isAdiantamentoDaPrestacao = adiantamento
          && (Number(adiantamento.prestacao_id || 0) === Number(prestacao.id) || Number(adiantamento.id || 0) === Number(prestacao.adiantamento_id || 0));
        return sum + Number(isAdiantamentoDaPrestacao ? adiantamento.valor : item.saldo || 0);
      }, 0)
    : Number(prestacao.valor_adiantado || 0);
  const saldosPendentes = adiantamentosUsados.length ? [] : saldosPendentesPrestacao(prestacao);
  const saldoPendente = saldosPendentes.reduce((sum, item) => sum + Number(item.saldo || 0), 0);
  const creditoEmpresa = adiantado + saldoPendente;
  const saldoFinal = roundMoney(totalDespesas - creditoEmpresa);
  return {
    totalDespesas,
    adiantado,
    adiantamentosUsados,
    saldosPendentes,
    saldoPendente,
    creditoEmpresa,
    saldoFinal,
    saldoLabel: saldoFinal < 0 ? "Saldo a devolver" : "Saldo a reembolsar",
    saldoValor: Math.abs(saldoFinal)
  };
}

function renderAdiantamentosResumo(prestacao) {
  const resumo = resumoFinanceiroPrestacao(prestacao);
  const detalhes = [
    ...resumo.adiantamentosUsados.map((item) => `${item.numero}: ${fmtMoney(item.saldo)}`),
    ...resumo.saldosPendentes.map((item) => `${item.numero}: ${fmtMoney(item.saldo)}`)
  ];
  return `
    <strong>${fmtMoney(resumo.creditoEmpresa)}</strong>
    ${detalhes.length ? `<small>${escapeHtml(detalhes.join(" | "))}</small>` : `<small>Sem abatimento</small>`}
  `;
}

function renderResultadoPrestacao(prestacao) {
  const resumo = resumoFinanceiroPrestacao(prestacao);
  return `
    <strong>${fmtMoney(resumo.saldoValor)}</strong>
    <small>${escapeHtml(resumo.saldoLabel)}</small>
  `;
}

function renderSituacaoFinanceira(row) {
  const erro = row.omie_erro || row.omie_anexos_erro || row.omie_compensacao_erro || "";
  return `
    ${statusPill(row.status)}
    ${erro ? `<small class="error-text">${escapeHtml(erro)}</small>` : ""}
  `;
}

function renderDevolucaoResumo() {
  const form = byId("devolucaoForm");
  if (!form) return;
  const adiantamento = state.adiantamentos.find((item) => Number(item.id) === Number(form.adiantamento_id.value));
  const resumo = byId("devolucaoResumo");
  const descricao = byId("devolucaoDescricao");
  if (!adiantamento) {
    if (resumo) resumo.textContent = "Selecione um adiantamento.";
    if (descricao) descricao.textContent = "A descrição será gerada automaticamente.";
    return;
  }
  const saldo = saldoAdiantamento(adiantamento.id);
  if (resumo) resumo.innerHTML = `<strong>${escapeHtml(adiantamento.numero)}</strong><br>Data: ${fmtDate(adiantamento.data_adiantamento)} | Saldo: <strong>${fmtMoney(saldo)}</strong>`;
  if (descricao) descricao.textContent = `Devolução saldo do adiantamento nº ${adiantamento.numero}, de ${fmtDate(adiantamento.data_adiantamento)}.`;
  if (!form.valor.value) form.valor.value = saldo.toFixed(2);
}

function renderContaPrestadorFiltro() {
  const select = byId("contaPrestadorFiltro");
  if (!select) return;
  const current = select.value;
  const prestadoresComMovimento = new Map();
  for (const row of state.contaCorrente?.movimentos || []) {
    if (!Number(row.solicitante_id)) continue;
    prestadoresComMovimento.set(Number(row.solicitante_id), row.solicitante || `Prestador ${row.solicitante_id}`);
  }
  const options = [...prestadoresComMovimento.entries()]
    .sort((a, b) => a[1].localeCompare(b[1], "pt-BR"))
    .map(([id, nome]) => `<option value="${id}">${escapeHtml(nome)}</option>`);
  select.innerHTML = [`<option value="">Todos os prestadores com movimentacao</option>`].concat(options).join("");
  if ([...prestadoresComMovimento.keys()].some((id) => String(id) === String(current))) select.value = current;
}

function renderContaCorrente() {
  if (!byId("contaCorrenteRows")) return;
  renderContaPrestadorFiltro();
  const filtro = Number(byId("contaPrestadorFiltro")?.value || 0);
  const allMovimentos = state.contaCorrente?.movimentos || [];
  const movimentos = filtro ? allMovimentos.filter((row) => Number(row.solicitante_id) === filtro) : allMovimentos;
  byId("saldoAdiantamentos").textContent = fmtMoney(movimentos.reduce((sum, row) => sum + Number(row.valor || 0), 0));
  const labels = {
    adiantamento: "Adiantamento",
    compensacao_prestacao: "Compensação",
    devolucao: "Devolução"
  };
  const documentoMovimento = (row) => {
    if (row.tipo === "compensacao_prestacao" && row.prestacao_numero && row.adiantamento_numero) {
      return `${row.prestacao_numero} compensado no ${row.adiantamento_numero}`;
    }
    if (row.tipo === "compensacao_prestacao" && row.adiantamento_numero) {
      return `${row.numero_documento || "Prestação"} compensado no ${row.adiantamento_numero}`;
    }
    return row.numero_documento || row.prestacao_numero || row.adiantamento_numero || "";
  };
  byId("contaCorrenteRows").innerHTML = movimentos.map((row) => `
    <tr>
      <td>${fmtDate(row.data_movimento)}</td>
      <td>${escapeHtml(row.solicitante || "")}</td>
      <td>${escapeHtml(documentoMovimento(row))}</td>
      <td>${labels[row.tipo] || row.tipo}</td>
      <td><strong>${fmtMoney(row.valor)}</strong></td>
    </tr>
  `).join("") || `<tr><td colspan="5" class="muted">Nenhum movimento de adiantamento.</td></tr>`;
}

function renderPrestacoes() {
  const term = byId("prestacaoSearch").value.toLowerCase().trim();
  const statusSelect = byId("prestacaoStatusSelect");
  if (statusSelect && statusSelect.value !== state.prestacaoStatusFilter && !["aprovacao", "financeiro", "finalizadas"].includes(state.prestacaoStatusFilter)) {
    state.prestacaoStatusFilter = statusSelect.value || "todos";
  }
  const rows = state.prestacoes.filter((row) => {
    const haystack = `${row.numero} ${row.solicitante} ${row.status}`.toLowerCase();
    const matchesTerm = !term || haystack.includes(term);
    const status = String(row.status || "");
    const matchesStatus = state.prestacaoStatusFilter === "todos"
      || (state.prestacaoStatusFilter === "aprovacao" && status === "enviada_superior")
      || (state.prestacaoStatusFilter === "financeiro" && ["em_validacao_financeira", "aprovada_superior", "a_pagar", "a_devolver"].includes(status))
      || (state.prestacaoStatusFilter === "finalizadas" && ["finalizada", "pago"].includes(status))
      || state.prestacaoStatusFilter === status;
    return matchesTerm && matchesStatus;
  });
  byId("prestacoesRows").innerHTML = rows.map((row) => `
    <tr>
      <td data-label="Número"><strong>${row.numero}</strong></td>
      <td data-label="Solicitante">${row.solicitante}</td>
      <td data-label="Período">${row.data_inicio} a ${row.data_fim}</td>
      <td data-label="Status">${statusPill(row.status)}</td>
      <td data-label="Total">${fmtMoney(row.total_despesas)}</td>
      <td data-label="Adiantamentos" class="money-detail">${renderAdiantamentosResumo(row)}</td>
      <td data-label="Resultado" class="money-detail result">${renderResultadoPrestacao(row)}</td>
      <td data-label="Ação">
        <div class="row-actions">
          <button class="small" data-detail="${row.id}">Abrir</button>
          <button class="small" data-vinculos-prestacao="${row.id}">Vínculos</button>
          ${(canChangePrestacao(row.status) || canAdminManagePrestacao(row)) ? `
            ${row.status !== "cancelada" ? `<button class="small" data-prestacao-cancelar="${row.id}">Cancelar</button>` : ""}
            <button class="small danger" data-prestacao-excluir="${row.id}">Excluir</button>
          ` : ""}
        </div>
      </td>
    </tr>
  `).join("") || `<tr><td colspan="8" class="muted">Nenhuma prestação cadastrada.</td></tr>`;
}

function prestacaoAbertaDoSolicitante(solicitanteId) {
  return state.prestacoes.find((row) =>
    Number(row.solicitante_id) === Number(solicitanteId)
    && PRESTACAO_ABERTA_STATUSES.has(String(row.status || ""))
  );
}

function renderVinculos(kind, id) {
  const movimentos = state.contaCorrente?.movimentos || [];
  const rows = movimentos.filter((row) => kind === "adiantamento"
    ? Number(row.adiantamento_id) === Number(id)
    : Number(row.prestacao_id) === Number(id));
  const source = kind === "adiantamento"
    ? state.adiantamentos.find((item) => Number(item.id) === Number(id))
    : state.prestacoes.find((item) => Number(item.id) === Number(id));
  const title = kind === "adiantamento"
    ? `Vínculos do ${source?.numero || "adiantamento"}`
    : `Vínculos da ${source?.numero || "prestação"}`;
  byId("vinculosTitle").textContent = title;
  byId("vinculosBody").innerHTML = rows.length ? `
    <table>
      <thead>
        <tr>
          <th>Data</th>
          <th>Documento</th>
          <th>Movimento</th>
          <th>Valor</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => `
          <tr>
            <td data-label="Data">${fmtDate(row.data_movimento)}</td>
            <td data-label="Documento">${escapeHtml(row.prestacao_numero || row.adiantamento_numero || row.numero_documento || "")}</td>
            <td data-label="Movimento">${escapeHtml(row.descricao || row.tipo || "")}</td>
            <td data-label="Valor"><strong>${fmtMoney(row.valor)}</strong></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  ` : `<p class="muted">Nenhum abatimento, prestação ou devolução vinculada até o momento.</p>`;
  byId("vinculosDialog").showModal();
}

function renderFinanceiro() {
  if (!canUseFinanceiro()) {
    byId("financeiroRows").innerHTML = `<tr><td colspan="9" class="muted">Acesso financeiro restrito.</td></tr>`;
    return;
  }
  const rows = state.prestacoes.filter((row) => ["em_validacao_financeira", "aprovada_superior", "a_pagar", "a_devolver", "finalizada", "pago"].includes(row.status));
  byId("financeiroRows").innerHTML = rows.map((row) => {
    const resumo = resumoFinanceiroPrestacao(row);
    const aReembolsar = resumo.saldoFinal > 0 ? resumo.saldoValor : 0;
    const aDevolver = resumo.saldoFinal < 0 ? resumo.saldoValor : 0;
    return `
      <tr>
        <td>
          ${canIntegrarOmieFinanceiro(row) ? `<input type="checkbox" class="financeiro-omie-check" value="${row.id}" aria-label="Selecionar ${escapeHtml(row.numero)}">` : ""}
        </td>
        <td><button class="link-button" type="button" data-detail="${row.id}">${escapeHtml(row.numero)}</button></td>
        <td>${row.solicitante}</td>
        <td class="money-detail"><strong>${fmtMoney(row.total_despesas)}</strong><small>Total comprovado</small></td>
        <td class="money-detail">${renderAdiantamentosResumo(row)}</td>
        <td class="money-detail result">
          <strong>${fmtMoney(aReembolsar || aDevolver)}</strong>
          <small>${aReembolsar > 0 ? "Pagar ao prestador" : (aDevolver > 0 ? "Prestador devolve para empresa" : "Sem saldo")}</small>
        </td>
        <td>${fmtDate(row.data_pagamento_prevista)}</td>
        <td class="money-detail">${renderSituacaoFinanceira(row)}</td>
        <td>
          <div class="row-actions">
            ${canIntegrarOmieFinanceiro(row) ? `<button class="small primary" data-financeiro-integrar="${row.id}">Integrar Omie</button>` : ""}
            ${row.omie_codigo_lancamento && row.omie_anexos_status === "erro" ? `<button class="small" data-financeiro-anexos="${row.id}">Reenviar anexos</button>` : ""}
          </div>
        </td>
      </tr>
    `;
  }).join("") || `<tr><td colspan="9" class="muted">Nenhuma prestação aguardando financeiro.</td></tr>`;
}

function canAprovarFinanceiro(row) {
  return false;
}

function canIntegrarOmieFinanceiro(row) {
  return canUseFinanceiro()
    && hasPerm("reembolso_integrar_omie")
    && row.status === "em_validacao_financeira"
    && row.omie_status !== "integrado";
}

function canFinalizarFinanceiro(row) {
  return false;
}

function formDataJson(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function updateDespesaKmFields() {
  const tipoSelect = byId("despesaTipo");
  const form = byId("despesaForm");
  if (!tipoSelect || !form) return;
  const tipo = state.tipos.find((item) => Number(item.id) === Number(tipoSelect.value));
  const isKm = Boolean(tipo?.exige_km);
  document.querySelectorAll("#despesaForm .km-field").forEach((field) => {
    field.style.display = isKm ? "grid" : "none";
    const input = field.querySelector("input");
    if (input) input.disabled = !isKm;
  });
  const valorInput = form.elements.valor;
  const kmInput = form.elements.quantidade_km;
  if (valorInput) {
    valorInput.readOnly = isKm;
    valorInput.required = !isKm;
    if (isKm) {
      const valorKm = Number(state.config.valor_km || "0.65");
      valorInput.value = ((Number(kmInput?.value || 0) || 0) * valorKm).toFixed(2);
    }
  }
  const sugestoes = await api(`/api/descricoes?tipo_despesa_id=${encodeURIComponent(tipoSelect.value || "")}`, { progress: false }).catch(() => []);
  byId("descricaoSugestoes").innerHTML = sugestoes.map((item) => `<option value="${escapeHtml(item.descricao)}"></option>`).join("");
}

function setDespesaManualFields(enabled) {
  const form = byId("despesaForm");
  if (!form) return;
  form.elements.data_despesa.disabled = false;
  form.elements.valor.disabled = false;
  form.elements.data_despesa.readOnly = !enabled;
  form.elements.valor.readOnly = !enabled;
}

function resetDespesaDocumentoState() {
  const form = byId("despesaForm");
  state.despesaDocumentoValidacao = null;
  if (form?.elements.comprovante_token) form.elements.comprovante_token.value = "";
  if (byId("despesaDocumentoFallback")) byId("despesaDocumentoFallback").hidden = false;
  if (form?.elements.documento) form.elements.documento.required = !state.editingDespesaId;
  if (form?.elements.qr_documento) form.elements.qr_documento.required = !state.editingDespesaId;
  if (byId("despesaDocumentoStatus")) byId("despesaDocumentoStatus").textContent = "Informe os dados da despesa e anexe o comprovante correspondente.";
  setDespesaManualFields(true);
}

function showDocumentoFiscalFallback(message = "Anexe o documento fiscal para continuar com preenchimento manual.") {
  const form = byId("despesaForm");
  if (byId("despesaDocumentoFallback")) byId("despesaDocumentoFallback").hidden = false;
  if (form?.elements.documento) form.elements.documento.required = !state.editingDespesaId;
  if (form?.elements.qr_documento) form.elements.qr_documento.required = false;
  byId("despesaDocumentoStatus").textContent = message;
  setDespesaManualFields(true);
}

function usarFotoQrComoFallback() {
  closeQrScanner();
  byId("despesaDocumentoStatus").textContent = "A câmera do navegador não abriu o enquadramento. Tire uma foto próxima e nítida do QR Code; o sistema tentará ler automaticamente.";
  setDespesaManualFields(false);
  window.setTimeout(() => byId("despesaQrDocumento")?.click(), 150);
}

function cameraDoNavegadorPermitida() {
  const host = window.location.hostname;
  return window.isSecureContext
    || window.location.protocol === "https:"
    || host === "localhost"
    || host === "127.0.0.1"
    || host === "::1";
}

function html5QrcodeCtor() {
  return window.Html5Qrcode
    || window.__Html5QrcodeLibrary__?.Html5Qrcode
    || (typeof Html5Qrcode !== "undefined" ? Html5Qrcode : null);
}

async function lerQrDoArquivo(file) {
  if (window.jsQR && file?.type?.startsWith("image/")) {
    const image = new Image();
    image.decoding = "async";
    const url = URL.createObjectURL(file);
    try {
      const loaded = new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
      });
      image.src = url;
      await loaded;
      const maxSide = 1800;
      const scale = Math.min(1, maxSide / Math.max(image.naturalWidth || 1, image.naturalHeight || 1));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round((image.naturalWidth || 1) * scale));
      canvas.height = Math.max(1, Math.round((image.naturalHeight || 1) * scale));
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const result = window.jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "attemptBoth" });
      if (result?.data) return result.data;
    } catch {
      // Continua para o leitor alternativo abaixo.
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const Html5QrcodeCtor = html5QrcodeCtor();
  if (!Html5QrcodeCtor || !file?.type?.startsWith("image/")) return "";
  const id = `qr-file-reader-${Date.now()}`;
  const host = document.createElement("div");
  host.id = id;
  host.hidden = true;
  document.body.appendChild(host);
  const scanner = new Html5QrcodeCtor(id);
  try {
    const result = await scanner.scanFile(file, true);
    return typeof result === "string" ? result : (result?.decodedText || "");
  } catch {
    return "";
  } finally {
    try { await scanner.clear(); } catch {}
    host.remove();
  }
}

function closeQrScanner() {
  if (qrScannerTimer) window.clearInterval(qrScannerTimer);
  qrScannerTimer = null;
  qrScannerBusy = false;
  if (qrHtml5Scanner) {
    const scanner = qrHtml5Scanner;
    qrHtml5Scanner = null;
    scanner.stop()
      .catch(() => {})
      .finally(() => {
        try { scanner.clear(); } catch {}
        if (byId("qrScannerReader")) byId("qrScannerReader").innerHTML = "";
      });
  }
  if (qrScannerStream) {
    qrScannerStream.getTracks().forEach((track) => track.stop());
  }
  qrScannerStream = null;
  const video = byId("qrScannerVideo");
  if (video) video.srcObject = null;
  byId("qrScannerDialog")?.close();
}

async function captureQrScannerFrame(decodedText = "") {
  if (qrScannerBusy && !decodedText) return;
  const video = byId("qrScannerReader")?.querySelector("video") || byId("qrScannerVideo");
  if (!video?.videoWidth) {
    usarFotoQrComoFallback();
    return;
  }
  qrScannerBusy = true;
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  closeQrScanner();
  if (!blob) {
    showDocumentoFiscalFallback("Não foi possível capturar a imagem. Anexe o documento fiscal.");
    return;
  }
  const file = new File([blob], `qr-nf-${Date.now()}.jpg`, { type: "image/jpeg" });
  await validarDocumentoDespesa(file, decodedText);
}

async function openQrScanner() {
  if (!cameraDoNavegadorPermitida()) {
    showStatus("Neste endereço sem HTTPS, o iPhone não libera a câmera dentro do app. Use uma foto do QR Code.", true);
    usarFotoQrComoFallback();
    return;
  }
  const Html5QrcodeCtor = html5QrcodeCtor();
  if (Html5QrcodeCtor) {
    try {
      byId("qrScannerDialog")?.showModal();
      byId("despesaDocumentoStatus").textContent = "Aponte a câmera para o QR Code.";
      byId("qrScannerReader").innerHTML = "";
      qrScannerBusy = false;
      qrHtml5Scanner = new Html5QrcodeCtor("qrScannerReader");
      const startPromise = qrHtml5Scanner.start(
        { facingMode: "environment" },
        {
          fps: 10,
          qrbox: (viewfinderWidth, viewfinderHeight) => {
            const size = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.68);
            return { width: size, height: size };
          }
        },
        async (decodedText) => {
          if (qrScannerBusy) return;
          byId("despesaDocumentoStatus").textContent = "QR Code lido. Validando documento fiscal.";
          await captureQrScannerFrame(decodedText);
        },
        () => {}
      );
      await Promise.race([
        startPromise,
        new Promise((_, reject) => window.setTimeout(() => reject(new Error("Tempo excedido ao abrir a câmera.")), 5000))
      ]);
      return;
    } catch (error) {
      closeQrScanner();
      showStatus("Não foi possível abrir a câmera do navegador. Use uma foto do QR Code.", true);
      usarFotoQrComoFallback();
      return;
    }
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    usarFotoQrComoFallback();
    return;
  }
  try {
    const video = byId("qrScannerVideo");
    qrScannerStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false
    });
    video.srcObject = qrScannerStream;
    byId("qrScannerDialog")?.showModal();
    await video.play();
    if ("BarcodeDetector" in window) {
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      qrScannerTimer = window.setInterval(async () => {
        if (qrScannerBusy || !video.videoWidth) return;
        try {
          const codes = await detector.detect(video);
          if (codes.length) await captureQrScannerFrame();
        } catch {
          window.clearInterval(qrScannerTimer);
          qrScannerTimer = null;
        }
      }, 700);
    }
  } catch (error) {
    closeQrScanner();
    showStatus("Não foi possível abrir a câmera do navegador. Use uma foto do QR Code.", true);
    usarFotoQrComoFallback();
  }
}

async function validarDocumentoDespesa(file, qrText = "") {
  const prestacaoId = Number(state.currentPrestacaoId || 0);
  if (!prestacaoId || !file) return;
  const form = byId("despesaForm");
  const payload = new FormData();
  payload.append("arquivo", file);
  if (qrText) payload.append("qr_text", qrText);
  showBusy("Lendo documento", "Verificando QR Code, consulta SEFAZ e duplicidade da NF.");
  try {
    const response = await fetch(`/api/prestacoes/${prestacaoId}/documento-despesa`, {
      method: "POST",
      body: payload
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Nao foi possivel validar o documento.");
    state.despesaDocumentoValidacao = data.validacao;
    form.elements.comprovante_token.value = data.token;
    const v = data.validacao || {};
    const divergencias = v.divergencias || [];
    if (v.status === "validada") {
      form.elements.data_despesa.value = v.data_emissao || "";
      form.elements.valor.value = Number(v.valor || 0).toFixed(2);
      if (form.elements.qr_documento) form.elements.qr_documento.required = false;
      if (form.elements.documento) form.elements.documento.required = false;
      setDespesaManualFields(false);
      byId("despesaDocumentoStatus").textContent = `NF validada${v.numero_nf ? ` nº ${v.numero_nf}` : ""}. Data e valor preenchidos automaticamente.`;
    } else {
      setDespesaManualFields(true);
      if (v.is_nf) {
        byId("despesaDocumentoStatus").textContent = `Documento fiscal com divergencia. ${divergencias.join(" ")} Preencha data e valor manualmente.`;
      } else if (v.qr_lido) {
        showDocumentoFiscalFallback(`${divergencias.join(" ") || "QR Code lido, mas nao parece ser um documento fiscal."} Anexe o documento fiscal para continuar com preenchimento manual.`);
      } else {
        showDocumentoFiscalFallback("QR Code não identificado. Anexe o documento fiscal para continuar com preenchimento manual.");
      }
    }
  } catch (error) {
    resetDespesaDocumentoState();
    setDespesaManualFields(true);
    byId("despesaDocumentoStatus").textContent = error.message;
    showStatus(error.message, true);
  } finally {
    hideBusy();
  }
}

async function openDespesaDialog(prestacaoId, despesa = null) {
  const form = byId("despesaForm");
  state.currentPrestacaoId = Number(prestacaoId);
  state.editingDespesaId = despesa ? Number(despesa.id) : null;
  state.editingDespesaOriginalValor = despesa ? Number(despesa.valor || 0) : null;
  form.reset();
  resetDespesaDocumentoState();
  byId("despesaTipo").innerHTML = optionList(state.tipos);
  byId("despesaDialogTitle").textContent = despesa ? "Editar despesa" : "Nova despesa";
  byId("despesaSubmitBtn").textContent = despesa ? "Salvar despesa" : "Adicionar despesa";
  if (despesa) {
    setDespesaManualFields(true);
    form.elements.documento.required = false;
    if (form.elements.qr_documento) form.elements.qr_documento.required = false;
    form.data_despesa.value = despesa.data_despesa || "";
    form.tipo_despesa_id.value = despesa.tipo_despesa_id || "";
    form.valor.value = despesa.valor || "";
    form.quantidade_km.value = despesa.quantidade_km || "";
    form.descricao.value = despesa.descricao || "";
  }
  await updateDespesaKmFields();
  byId("despesaDialog").showModal();
  form.documento.focus();
}

function closeDespesaDialog() {
  closeQrScanner();
  state.editingDespesaId = null;
  state.editingDespesaOriginalValor = null;
  state.despesaDocumentoValidacao = null;
  byId("despesaForm")?.reset();
  byId("despesaDialog")?.close();
}

async function openPrestacao(id) {
  const data = await api(`/api/prestacoes/${id}`);
  const { prestacao, despesas, aprovacoes } = data;
  state.currentPrestacaoId = Number(id);
  const locked = isPrestacaoLocked(prestacao);
  const financeEditable = canFinanceiroEditPrestacao(prestacao);
  const adminManageable = canAdminManagePrestacao(prestacao);
  const editable = (canChangePrestacao(prestacao.status) || financeEditable) && !locked;
  const canCancelOrDeletePrestacao = (editable || adminManageable) && !locked;
  const canDeleteDespesa = prestacao.status === "rascunho" && editable;
  const resumo = resumoFinanceiroPrestacao(prestacao);
  byId("dialogTitle").textContent = `${prestacao.numero} - ${prestacao.solicitante}`;
  byId("prestacaoDetail").innerHTML = `
    <div class="detail-grid">
      <div class="detail-cell"><span>Total despesas</span><strong>${fmtMoney(prestacao.total_despesas)}</strong></div>
      <div class="detail-cell"><span>Adiantamento atual e pendentes</span><strong>${fmtMoney(resumo.creditoEmpresa)}</strong>${resumo.saldosPendentes.length ? `<small>${resumo.saldosPendentes.map((item) => `${escapeHtml(item.numero || "-")} de ${fmtDate(item.data_adiantamento)}`).join(" | ")}</small>` : ""}</div>
      <div class="detail-cell"><span>${resumo.saldoLabel}</span><strong>${fmtMoney(resumo.saldoValor)}</strong></div>
    </div>
    ${locked ? `<div class="advance-summary">Prestação finalizada. Edição, inclusão de despesas e anexos estão bloqueados.</div>` : ""}
    ${financeEditable ? `<div class="advance-summary">Financeiro pode ajustar valores antes da integração com Omie. Alterações de valor exigem justificativa.</div>` : ""}
    <div class="panel" style="margin-top:14px">
      <div class="panel-head">
        <h2>Despesas</h2>
        ${editable ? `<button class="primary" type="button" data-despesa-nova="${prestacao.id}">Nova despesa</button>` : ""}
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Data</th>
              <th>Tipo</th>
              <th>Descrição</th>
              <th>Valor</th>
              <th>Comprovante</th>
              <th>Ação</th>
            </tr>
          </thead>
          <tbody>
            ${despesas.map((despesa, index) => `
              <tr>
                <td data-label="Item"><strong>${index + 1}</strong><small>${despesa.data_despesa}</small></td>
                <td data-label="Tipo">${despesa.tipo_despesa}</td>
                <td data-label="Descrição">${despesa.descricao}</td>
                <td data-label="Valor">${fmtMoney(despesa.valor)}</td>
                <td data-label="Comprovante">
                  ${renderComprovantes(despesa, locked)}
                </td>
                <td data-label="Ação">
                  ${editable ? `<button class="small" data-despesa-editar="${despesa.id}">Editar</button>` : ""}
                  ${canDeleteDespesa ? `<button class="small danger" data-despesa-excluir="${despesa.id}">Excluir</button>` : ""}
                </td>
              </tr>
            `).join("") || `<tr><td colspan="6" class="muted">Nenhuma despesa lançada.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
    <div class="toolbar" style="margin-top:14px">
      ${hasPerm("reembolso_solicitar") && editable ? `<button class="primary" data-action="enviar" data-id="${prestacao.id}">Enviar para aprovação</button>` : ""}
      ${hasPerm("reembolso_aprovar") && prestacao.status === "enviada_superior" ? `<button data-action="aprovar" data-id="${prestacao.id}">Aprovar superior</button>` : ""}
      ${canCancelOrDeletePrestacao ? `
        ${prestacao.status !== "cancelada" ? `<button data-prestacao-cancelar="${prestacao.id}">Cancelar</button>` : ""}
        <button class="danger" data-prestacao-excluir="${prestacao.id}">Excluir</button>
      ` : ""}
      ${hasPerm("reembolso_relatorio") && ["a_pagar", "finalizada", "em_validacao_financeira", "pago"].includes(prestacao.status) ? `<button data-relatorio="${prestacao.id}">Relatório</button>` : ""}
    </div>
    <div class="panel" style="margin-top:14px">
      <h2>Aprovações</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Etapa / Aprovador</th><th>Decisão</th><th>Autenticação</th><th>Data</th></tr></thead>
          <tbody>
            ${aprovacoes.map((ap) => `<tr><td><strong>${ap.etapa}</strong><small>${ap.usuario || ""}</small></td><td>${ap.decisao}</td><td><strong>${ap.autenticacao}</strong></td><td>${ap.created_at}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">Sem aprovações.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;
  if (!byId("prestacaoDialog").open) byId("prestacaoDialog").showModal();

  document.querySelectorAll(".upload-form").forEach((form) => {
    form.querySelector("input[type='file']")?.addEventListener("change", () => {
      const input = form.querySelector("input[type='file']");
      if (!input.files.length) return;
      const filename = input.files[0]?.name || "arquivo";
      const context = form.dataset.uploadContext || "esta despesa";
      if (!confirm(`Anexar \"${filename}\" nesta despesa?\n\n${context}`)) {
        input.value = "";
        return;
      }
      form.requestSubmit();
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const uploadForm = event.currentTarget;
      if (uploadForm.dataset.submitting === "1") return;
      uploadForm.dataset.submitting = "1";
      uploadForm.querySelectorAll("input, button").forEach((field) => { field.disabled = true; });
      const formData = new FormData(uploadForm);
      showBusy("Enviando comprovante", "Aguarde, o arquivo está sendo anexado.");
      try {
        const response = await fetch(`/api/despesas/${uploadForm.dataset.upload}/comprovantes`, {
          method: "POST",
          body: formData
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Falha ao anexar comprovante.");
        showStatus("Comprovante anexado.");
        await loadAll();
        await openPrestacao(id);
      } catch (error) {
        showStatus(error.message, true);
      } finally {
        uploadForm.dataset.submitting = "0";
        hideBusy();
      }
    });
  });
}

async function integrarPrestacaoOmie(id, { manageBusy = true } = {}) {
  if (manageBusy) {
    const row = state.prestacoes.find((item) => Number(item.id) === Number(id));
    showBusy("Integrando prestação", `${row?.numero || "Prestação"}: criando lançamento, compensando adiantamento e anexando relatório.`);
  }
  try {
    await api(`/api/prestacoes/${id}/integrar-omie`, { method: "POST", progress: false });
    return { ok: true };
  } catch (err) {
    if (confirmOmiePrestadorCadastro(err)) {
      byId("busyTitle").textContent = "Cadastrando prestador e integrando";
      byId("busyMessage").textContent = "Aguarde, o sistema está criando o fornecedor no Omie e reenviando a prestação.";
      await api(`/api/prestacoes/${id}/integrar-omie`, {
        method: "POST",
        progress: false,
        body: JSON.stringify({ cadastrar_prestadores_omie: true })
      });
      return { ok: true };
    }
    throw err;
  } finally {
    if (manageBusy) hideBusy();
  }
}

async function integrarPrestacoesSelecionadas(ids) {
  const uniqueIds = [...new Set(ids.map(Number).filter(Boolean))];
  if (!uniqueIds.length) {
    showStatus("Selecione pelo menos uma prestação elegível para integrar.", true);
    return;
  }
  if (!confirm(`Integrar ${uniqueIds.length} prestação(ões) com a Omie?`)) return;
  let ok = 0;
  const erros = [];
  showBusy("Integrando com Omie", `Preparando ${uniqueIds.length} prestação(ões).`);
  try {
    for (const id of uniqueIds) {
      try {
        await integrarPrestacaoOmie(id, { manageBusy: false });
        ok += 1;
      } catch (err) {
        const row = state.prestacoes.find((item) => Number(item.id) === Number(id));
        erros.push(`${row?.numero || id}: ${err.message}`);
      }
    }
  } finally {
    hideBusy();
  }
  await loadAll();
  if (erros.length) {
    showStatus(`${ok} integrada(s). Erro(s): ${erros.join(" | ")}`, true);
  } else {
    showStatus(`${ok} prestação(ões) integrada(s) com a Omie.`);
  }
}

document.addEventListener("click", async (event) => {
  const nav = event.target.closest("[data-view], [data-view-link]");
  if (nav) {
    clearListFilters();
    setView(nav.dataset.view || nav.dataset.viewLink);
    renderAdiantamentos();
    renderPrestacoes();
  }

  const dashboardFilter = event.target.closest("[data-dashboard-filter]");
  if (dashboardFilter) applyDashboardFilter(dashboardFilter.dataset.dashboardFilter);

  const detail = event.target.closest("[data-detail]");
  if (detail) openPrestacao(detail.dataset.detail).catch((err) => showStatus(err.message, true));

  const vinculosAdiantamento = event.target.closest("[data-vinculos-adiantamento]");
  if (vinculosAdiantamento) renderVinculos("adiantamento", vinculosAdiantamento.dataset.vinculosAdiantamento);

  const vinculosPrestacao = event.target.closest("[data-vinculos-prestacao]");
  if (vinculosPrestacao) renderVinculos("prestacao", vinculosPrestacao.dataset.vinculosPrestacao);

  const comprovante = event.target.closest("[data-comprovante]");
  if (comprovante) {
    openComprovante(comprovante.dataset.comprovante, comprovante.dataset.comprovanteName);
  }

  const comprovanteExcluir = event.target.closest("[data-comprovante-excluir]");
  if (comprovanteExcluir) {
    if (!confirm("Excluir este comprovante?")) return;
    try {
      const detailId = Number(byId("prestacaoDetail").querySelector("[data-action]")?.dataset.id || 0);
      await api(`/api/comprovantes/${comprovanteExcluir.dataset.comprovanteExcluir}`, { method: "DELETE" });
      showStatus("Comprovante excluido.");
      await loadAll();
      if (detailId) await openPrestacao(detailId);
    } catch (err) {
      showStatus(err.message, true);
    }
  }

  const adiantamentoCancelar = event.target.closest("[data-adiantamento-cancelar]");
  if (adiantamentoCancelar) {
    if (!confirm("Cancelar este adiantamento?")) return;
    try {
      await api(`/api/adiantamentos/${adiantamentoCancelar.dataset.adiantamentoCancelar}/cancelar`, { method: "POST" });
      showStatus("Adiantamento cancelado.");
      await loadAll();
    } catch (err) {
      showStatus(err.message, true);
    }
  }

  const adiantamentoEditar = event.target.closest("[data-adiantamento-editar]");
  if (adiantamentoEditar) {
    const item = state.adiantamentos.find((row) => Number(row.id) === Number(adiantamentoEditar.dataset.adiantamentoEditar));
    if (item) {
      setView("adiantamentos");
      openAdiantamentoDialog(item);
    }
  }

  const adiantamentoEnviar = event.target.closest("[data-adiantamento-enviar]");
  if (adiantamentoEnviar) {
    try {
      await api(`/api/adiantamentos/${adiantamentoEnviar.dataset.adiantamentoEnviar}/enviar-aprovacao`, { method: "POST" });
      showStatus("Adiantamento enviado para aprovação.");
      await loadAll();
    } catch (err) {
      showStatus(err.message, true);
    }
  }

  const adiantamentoAprovar = event.target.closest("[data-adiantamento-aprovar]");
  if (adiantamentoAprovar) {
    try {
      await api(`/api/adiantamentos/${adiantamentoAprovar.dataset.adiantamentoAprovar}/aprovar`, { method: "POST" });
      showStatus("Adiantamento aprovado.");
      await loadAll();
    } catch (err) {
      showStatus(err.message, true);
    }
  }

  const adiantamentoIntegrar = event.target.closest("[data-adiantamento-integrar]");
  if (adiantamentoIntegrar) {
    if (!confirm("Integrar este adiantamento como transferência entre contas no Omie?")) return;
    try {
      const row = state.adiantamentos.find((item) => Number(item.id) === Number(adiantamentoIntegrar.dataset.adiantamentoIntegrar));
      showBusy("Integrando adiantamento", `${row?.numero || "Adiantamento"}: transferindo entre contas e anexando relatório.`);
      await api(`/api/adiantamentos/${adiantamentoIntegrar.dataset.adiantamentoIntegrar}/integrar-omie`, { method: "POST", progress: false });
      showStatus("Adiantamento integrado com o Omie.");
      await loadAll();
    } catch (err) {
      showStatus(err.message, true);
    } finally {
      hideBusy();
    }
  }

  const adiantamentoExcluir = event.target.closest("[data-adiantamento-excluir]");
  if (adiantamentoExcluir) {
    if (!confirm("Excluir definitivamente este adiantamento?")) return;
    try {
      await api(`/api/adiantamentos/${adiantamentoExcluir.dataset.adiantamentoExcluir}`, { method: "DELETE" });
      showStatus("Adiantamento excluido.");
      await loadAll();
    } catch (err) {
      showStatus(err.message, true);
    }
  }

  const prestacaoCancelar = event.target.closest("[data-prestacao-cancelar]");
  if (prestacaoCancelar) {
    if (!confirm("Cancelar esta prestação de contas?")) return;
    try {
      await api(`/api/prestacoes/${prestacaoCancelar.dataset.prestacaoCancelar}/cancelar`, { method: "POST", body: JSON.stringify({ usuario_id: state.usuarios[0]?.id }) });
      showStatus("Prestacao cancelada.");
      if (byId("prestacaoDialog").open) byId("prestacaoDialog").close();
      await loadAll();
    } catch (err) {
      showStatus(err.message, true);
    }
  }

  const prestacaoExcluir = event.target.closest("[data-prestacao-excluir]");
  if (prestacaoExcluir) {
    if (!confirm("Excluir definitivamente esta prestação e suas despesas/comprovantes?")) return;
    try {
      await api(`/api/prestacoes/${prestacaoExcluir.dataset.prestacaoExcluir}`, { method: "DELETE" });
      showStatus("Prestacao excluida.");
      if (byId("prestacaoDialog").open) byId("prestacaoDialog").close();
      await loadAll();
    } catch (err) {
      showStatus(err.message, true);
    }
  }

  const despesaNova = event.target.closest("[data-despesa-nova]");
  if (despesaNova) {
    openDespesaDialog(despesaNova.dataset.despesaNova).catch((err) => showStatus(err.message, true));
  }

  const despesaEditar = event.target.closest("[data-despesa-editar]");
  if (despesaEditar) {
    const despesaId = Number(despesaEditar.dataset.despesaEditar || 0);
    const detailId = Number(state.currentPrestacaoId || 0);
    const data = await api(`/api/prestacoes/${detailId}`).catch(() => null);
    const despesa = data?.despesas?.find((item) => Number(item.id) === despesaId);
    if (despesa) {
      await openDespesaDialog(detailId, despesa);
    }
  }

  const despesaExcluir = event.target.closest("[data-despesa-excluir]");
  if (despesaExcluir) {
    if (!confirm("Excluir este item de despesa?")) return;
    const detailId = Number(state.currentPrestacaoId || 0);
    try {
      await api(`/api/despesas/${despesaExcluir.dataset.despesaExcluir}`, {
        method: "DELETE",
        progressTitle: "Excluindo despesa",
        progressMessage: "Aguarde, o item e seus comprovantes estão sendo removidos."
      });
      showStatus("Despesa excluida.");
      await loadAll();
      if (detailId) await openPrestacao(detailId);
    } catch (err) {
      showStatus(err.message, true);
    }
  }

  const relatorio = event.target.closest("[data-relatorio]");
  if (relatorio) {
    window.open(`/api/prestacoes/${relatorio.dataset.relatorio}/relatorio`, "_blank");
  }

  const financeiroIntegrar = event.target.closest("[data-financeiro-integrar]");
  if (financeiroIntegrar) {
    await integrarPrestacoesSelecionadas([financeiroIntegrar.dataset.financeiroIntegrar]);
  }

  const financeiroAnexos = event.target.closest("[data-financeiro-anexos]");
  if (financeiroAnexos) {
    try {
      showBusy("Reenviando anexos", "Gerando PDFs e enviando para o lançamento no Omie.");
      await api(`/api/prestacoes/${financeiroAnexos.dataset.financeiroAnexos}/enviar-anexos-omie`, { method: "POST", progress: false });
      showStatus("Anexos reenviados para o Omie.");
      await loadAll();
    } catch (err) {
      showStatus(err.message, true);
    } finally {
      hideBusy();
    }
  }

  const financeiroFinalizar = event.target.closest("[data-financeiro-finalizar]");
  if (financeiroFinalizar) {
    try {
      await api(`/api/prestacoes/${financeiroFinalizar.dataset.financeiroFinalizar}/finalizar-financeiro`, { method: "POST", body: JSON.stringify({}) });
      showStatus("Prestação finalizada.");
      await loadAll();
    } catch (err) {
      showStatus(err.message, true);
    }
  }

  const action = event.target.closest("[data-action]");
  if (action) {
    try {
      const id = action.dataset.id;
      const usuario = state.usuarios[0]?.id;
      if (action.dataset.action === "enviar") await api(`/api/prestacoes/${id}/enviar`, { method: "POST", body: JSON.stringify({ usuario_id: usuario }) });
      if (action.dataset.action === "aprovar") await api(`/api/prestacoes/${id}/aprovar-superior`, { method: "POST", body: JSON.stringify({}) });
      if (action.dataset.action === "finalizar") await api(`/api/prestacoes/${id}/finalizar-financeiro`, { method: "POST", body: JSON.stringify({}) });
      showStatus("Status atualizado.");
      byId("prestacaoDialog").close();
      await loadAll();
    } catch (err) {
      showStatus(err.message, true);
    }
  }
});

document.addEventListener("keydown", (event) => {
  const dashboardFilter = event.target.closest?.("[data-dashboard-filter]");
  if (!dashboardFilter || !["Enter", " "].includes(event.key)) return;
  event.preventDefault();
  applyDashboardFilter(dashboardFilter.dataset.dashboardFilter);
});

byId("refreshBtn").addEventListener("click", () => loadAll().then(() => showStatus("Dados atualizados.")).catch((err) => showStatus(err.message, true)));
byId("selectFinanceiroOmieBtn").addEventListener("click", () => {
  document.querySelectorAll(".financeiro-omie-check").forEach((checkbox) => {
    checkbox.checked = true;
  });
});
byId("integrarSelecionadosBtn").addEventListener("click", async () => {
  const ids = [...document.querySelectorAll(".financeiro-omie-check:checked")].map((checkbox) => checkbox.value);
  await integrarPrestacoesSelecionadas(ids);
});
byId("syncOmieBtn").addEventListener("click", async () => {
  try {
    showBusy("Sincronizando pagamentos", "Consultando o status dos títulos no Omie.");
    const data = await api("/api/omie/sincronizar-pagamentos", { method: "POST", progress: false });
    showStatus(`Omie sincronizado. ${data.pagos || 0} pagamento(s) confirmado(s).`);
    await loadAll();
  } catch (err) {
    showStatus(err.message, true);
  } finally {
    hideBusy();
  }
});
byId("newPrestacaoBtn").addEventListener("click", openPrestacaoCreateDialog);
byId("novaPrestacaoListaBtn")?.addEventListener("click", openPrestacaoCreateDialog);
byId("prestacaoSearch").addEventListener("input", renderPrestacoes);
byId("prestacaoStatusSelect")?.addEventListener("change", (event) => {
  state.prestacaoStatusFilter = event.target.value || "todos";
  renderPrestacoes();
});
document.querySelector("#prestacaoForm select[name='solicitante_id']").addEventListener("change", renderAdiantamentoSelect);
byId("novoAdiantamentoBtn")?.addEventListener("click", () => openAdiantamentoDialog());
byId("devolucaoForm")?.solicitante_id?.addEventListener("change", renderDevolucaoSelects);
byId("devolucaoForm")?.adiantamento_id?.addEventListener("change", renderDevolucaoResumo);
byId("contaPrestadorFiltro")?.addEventListener("change", renderContaCorrente);
byId("novaDevolucaoBtn")?.addEventListener("click", () => {
  if (!canUseFinanceiro()) {
    showStatus("Somente financeiro ou administrador pode registrar devolução.", true);
    return;
  }
  const form = byId("devolucaoForm");
  form.reset();
  form.data_devolucao.value = new Date().toISOString().slice(0, 10);
  if (!fullAccess()) form.solicitante_id.value = state.usuario.id;
  renderDevolucaoSelects();
  byId("devolucaoDialog").showModal();
});

byId("adiantamentoForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const body = formDataJson(form);
    const editingId = state.editingAdiantamentoId;
    const previous = state.adiantamentos.find((item) => Number(item.id) === Number(editingId));
    const superiorName = form.superior_id.selectedOptions?.[0]?.textContent?.trim() || "superior";
    let savedId = editingId;
    if (state.editingAdiantamentoId) {
      await api(`/api/adiantamentos/${state.editingAdiantamentoId}`, { method: "PUT", body: JSON.stringify(body) });
      state.editingAdiantamentoId = null;
    } else {
      const created = await api("/api/adiantamentos", { method: "POST", body: JSON.stringify(body) });
      savedId = created.id;
    }
    form.reset();
    byId("adiantamentoDialog")?.close();
    form.querySelector("button[type='submit']").textContent = "Salvar adiantamento";
    const canAskApproval = savedId
      && body.superior_id
      && !["em_aprovacao", "aprovado", "prestado"].includes(previous?.status || "");
    if (canAskApproval && confirm(`Gostaria de enviar para aprovação de ${superiorName}?`)) {
      await api(`/api/adiantamentos/${savedId}/enviar-aprovacao`, { method: "POST" });
      showStatus(`Adiantamento salvo e enviado para aprovação de ${superiorName}.`);
    } else {
      showStatus("Adiantamento salvo.");
    }
    await loadAll();
  } catch (err) {
    alert(err.message);
  }
});

byId("prestacaoForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const body = formDataJson(form);
    const aberta = prestacaoAbertaDoSolicitante(body.solicitante_id || state.usuario?.id);
    if (aberta) {
      showStatus(`Este prestador ja possui a prestação aberta ${aberta.numero}.`, true);
      return;
    }
    await api("/api/prestacoes", { method: "POST", body: JSON.stringify(body) });
    form.reset();
    byId("prestacaoCreateDialog")?.close();
    showStatus("Prestação criada.");
    await loadAll();
  } catch (err) {
    alert(err.message);
  }
});

byId("devolucaoForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    showBusy("Registrando devolução", "Lançando a transferência de devolução no Omie.");
    await api("/api/adiantamentos/devolucoes", { method: "POST", progress: false, body: JSON.stringify(formDataJson(form)) });
    form.reset();
    byId("devolucaoDialog")?.close();
    showStatus("Devolução registrada e integrada no Omie.");
    await loadAll();
  } catch (err) {
    showStatus(err.message, true);
  } finally {
    hideBusy();
  }
});

function resetLoginFlow({ keepEmail = false } = {}) {
  const form = byId("loginForm");
  const email = form.email.value;
  byId("accessCheckBox").hidden = false;
  byId("passwordBox").hidden = true;
  byId("firstAccessBox").hidden = true;
  byId("loginSubmitBtn").hidden = true;
  byId("changeEmailBtn").hidden = true;
  form.senha.value = "";
  form.senha_primeiro_acesso.value = "";
  form.confirmar_senha.value = "";
  form.email.readOnly = false;
  delete byId("firstAccessBox").dataset.email;
  if (!keepEmail) form.email.value = "";
  if (keepEmail) form.email.value = email;
  form.email.focus();
}

async function checkLoginEmail() {
  const form = byId("loginForm");
  const email = String(form.email.value || "").trim();
  if (!email) {
    form.email.focus();
    return;
  }
  try {
    const result = await api("/api/auth/verificar-acesso", {
      method: "POST",
      body: JSON.stringify({ email })
    });
    form.email.value = result.email || email;
    form.email.readOnly = true;
    byId("accessCheckBox").hidden = true;
    byId("changeEmailBtn").hidden = false;
    if (result.status === "primeiro_acesso") {
      const firstAccessBox = byId("firstAccessBox");
      firstAccessBox.hidden = false;
      firstAccessBox.dataset.email = result.email || email;
      byId("passwordBox").hidden = true;
      byId("loginSubmitBtn").hidden = true;
      const message = byId("firstAccessMessage");
      if (message) message.textContent = result.message || "E-mail localizado no cadastro PJ. Cadastre sua senha para acessar somente o Reembolso de Despesas.";
      form.senha_primeiro_acesso.focus();
      return;
    }
    byId("firstAccessBox").hidden = true;
    byId("passwordBox").hidden = false;
    byId("loginSubmitBtn").hidden = false;
    const passwordMessage = byId("passwordMessage");
    if (passwordMessage) passwordMessage.textContent = result.message || "E-mail localizado. Informe sua senha para entrar.";
    form.senha.focus();
  } catch (err) {
    alert(err.message);
    resetLoginFlow({ keepEmail: true });
  }
}

byId("checkAccessBtn").addEventListener("click", checkLoginEmail);

byId("changeEmailBtn").addEventListener("click", () => resetLoginFlow());

byId("changePasswordBtn")?.addEventListener("click", () => {
  const form = byId("changePasswordForm");
  form?.reset();
  document.querySelector(".connection")?.classList.remove("open");
  byId("accountMenuBtn")?.setAttribute("aria-expanded", "false");
  byId("changePasswordDialog")?.showModal();
});

byId("accountMenuBtn")?.addEventListener("click", (event) => {
  event.stopPropagation();
  const connection = document.querySelector(".connection");
  const opened = connection?.classList.toggle("open");
  byId("accountMenuBtn")?.setAttribute("aria-expanded", opened ? "true" : "false");
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".connection")) {
    document.querySelector(".connection")?.classList.remove("open");
    byId("accountMenuBtn")?.setAttribute("aria-expanded", "false");
  }
});

byId("closeChangePasswordBtn")?.addEventListener("click", () => byId("changePasswordDialog")?.close());
byId("cancelChangePasswordBtn")?.addEventListener("click", () => byId("changePasswordDialog")?.close());
byId("closeVinculosBtn")?.addEventListener("click", () => byId("vinculosDialog")?.close());
byId("closeDespesaBtn")?.addEventListener("click", closeDespesaDialog);
byId("cancelDespesaBtn")?.addEventListener("click", closeDespesaDialog);
byId("despesaDocumento")?.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  byId("despesaDocumentoStatus").textContent = `Documento selecionado: ${file.name}`;
});
byId("despesaTipo")?.addEventListener("change", () => updateDespesaKmFields());
byId("despesaForm")?.elements.quantidade_km?.addEventListener("input", () => {
  const form = byId("despesaForm");
  const tipo = state.tipos.find((item) => Number(item.id) === Number(form?.elements.tipo_despesa_id.value));
  if (!tipo?.exige_km) return;
  const valorKm = Number(state.config.valor_km || "0.65");
  form.elements.valor.value = ((Number(form.elements.quantidade_km.value || 0) || 0) * valorKm).toFixed(2);
});

byId("despesaForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const prestacaoId = Number(state.currentPrestacaoId || 0);
  if (!prestacaoId) return showStatus("Prestação não identificada para incluir a despesa.", true);
  const documento = form.elements.documento?.files?.[0] || null;
  const body = formDataJson(form);
  delete body.documento;
  delete body.qr_documento;
  body.valor_km = state.config.valor_km || "0.65";
  if (!state.editingDespesaId && !documento) {
    showStatus("Anexe a NF ou comprovante antes de adicionar a despesa.", true);
    return;
  }
  const prestacao = state.prestacoes.find((item) => Number(item.id) === prestacaoId);
  const financeEditable = canFinanceiroEditPrestacao(prestacao);
  const valorAtual = Number(body.quantidade_km && body.valor_km ? Number(body.quantidade_km) * Number(body.valor_km) : body.valor || 0);
  const valorAnterior = state.editingDespesaId ? Number(state.editingDespesaOriginalValor || 0) : 0;
  const valorMudou = Math.round((valorAtual - valorAnterior) * 100) !== 0;
  if (financeEditable && valorMudou) {
    const justificativa = prompt("Informe a justificativa da alteração de valor:");
    if (!justificativa || !justificativa.trim()) {
      showStatus("Justificativa obrigatória para alteração de valor pelo financeiro.", true);
      return;
    }
    body.justificativa_ajuste_financeiro = justificativa.trim();
  }
  let createdDespesaId = null;
  try {
    if (state.editingDespesaId) {
      await api(`/api/despesas/${state.editingDespesaId}`, { method: "PUT", body: JSON.stringify(body) });
      showStatus("Despesa atualizada.");
    } else {
      const created = await api(`/api/prestacoes/${prestacaoId}/despesas`, { method: "POST", body: JSON.stringify(body) });
      createdDespesaId = created.id;
      if (documento) {
        const uploadData = new FormData();
        uploadData.append("arquivo", documento);
        uploadData.append("prestacao_id", String(prestacaoId));
        const response = await fetch(`/api/despesas/${createdDespesaId}/comprovantes`, {
          method: "POST",
          body: uploadData
        });
        const uploadResult = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(uploadResult.error || "Despesa criada, mas falhou ao anexar o comprovante.");
      }
      showStatus("Despesa adicionada.");
    }
    closeDespesaDialog();
    await loadAll();
    await openPrestacao(prestacaoId);
  } catch (err) {
    showStatus(err.message, true);
  }
});

byId("changePasswordForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api("/api/auth/change-password", { method: "POST", body: JSON.stringify(formDataJson(form)) });
    form.reset();
    byId("changePasswordDialog")?.close();
    showStatus("Senha alterada.");
  } catch (err) {
    showStatus(err.message, true);
  }
});

byId("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (byId("passwordBox").hidden) {
    await checkLoginEmail();
    return;
  }
  try {
    await api("/api/auth/login", { method: "POST", body: JSON.stringify(formDataJson(form)) });
    resetLoginFlow();
    form.reset();
    await loadBootstrap();
    await loadAll();
  } catch (err) {
    alert(err.message);
  }
});

byId("createAccessBtn").addEventListener("click", async () => {
  const form = byId("loginForm");
  const firstAccessBox = byId("firstAccessBox");
  const body = formDataJson(form);
  body.email = firstAccessBox.dataset.email || body.email;
  body.senha = body.senha_primeiro_acesso;
  try {
    await api("/api/auth/primeiro-acesso", { method: "POST", body: JSON.stringify(body) });
    resetLoginFlow();
    form.reset();
    await loadBootstrap();
    await loadAll();
  } catch (err) {
    alert(err.message);
  }
});

byId("logoutBtn").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => null);
  state.usuario = null;
  document.querySelector(".connection")?.classList.remove("open");
  document.body.classList.add("auth-pending");
  resetLoginFlow();
});

loadBootstrap()
  .then(loadAll)
  .catch(() => {
    document.body.classList.add("auth-pending");
  });

