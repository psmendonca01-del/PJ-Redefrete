const state = {
  prestadores: [],
  clientes: [],
  unidades: [],
  funcoes: [],
  categorias: [],
  departamentos: [],
  projetos: [],
  adiantamentos: [],
  rescisoes: [],
  usuarios: [],
  folhas: [],
  folhaPreview: [],
  folhaLotes: [],
  comparativo: [],
  folhaAtual: null,
  folhaDraftDirty: false,
  folhaDraftSaving: null,
  folhaDraftTimer: null,
  adiantamentoFilter: "todos",
  folhaFilters: {
    search: "",
    categoria: "",
    nf: "",
    omie: "",
    diff: "",
  },
  usuarioAccessFilter: "todos",
  cadastroTipoAtivo: "categorias",
  authUser: null,
  cadastroConfig: {
    clientes: [],
    unidades: [],
    funcoes: [],
    categorias: [],
    departamentos: [],
    projetos: [],
  },
  appConfig: {
    minEditableCompetencia: currentCompetencia(),
  },
  emailTemplates: [],
  emailTemplateVars: {},
  emailTemplateAtivo: "folha_nf",
  prestadorStatusFilter: "todos",
};

const el = {
  loginScreen: document.querySelector("#loginScreen"),
  loginForm: document.querySelector("#loginForm"),
  loginFirstAccess: document.querySelector("#loginFirstAccess"),
  loginFirstAccessBtn: document.querySelector("#loginFirstAccessBtn"),
  loginMessage: document.querySelector("#loginMessage"),
  status: document.querySelector("#status"),
  statusDot: document.querySelector("#statusDot"),
  pageTitle: document.querySelector("#pageTitle"),
  refresh: document.querySelector("#refresh"),
  toast: document.querySelector("#toast"),
  busyOverlay: document.querySelector("#busyOverlay"),
  busyTitle: document.querySelector("#busyTitle"),
  busyMessage: document.querySelector("#busyMessage"),
  currentUserName: document.querySelector("#currentUserName"),
  currentUserPerfil: document.querySelector("#currentUserPerfil"),
  changePassword: document.querySelector("#changePassword"),
  changePasswordDialog: document.querySelector("#changePasswordDialog"),
  changePasswordForm: document.querySelector("#changePasswordForm"),
  closeChangePassword: document.querySelector("#closeChangePassword"),
  cancelChangePassword: document.querySelector("#cancelChangePassword"),
  logout: document.querySelector("#logout"),
  metrics: {
    prestadores: document.querySelector("#metricPrestadores"),
    adiantamentos: document.querySelector("#metricAdiantamentos"),
    folha: document.querySelector("#metricFolha"),
  },
  prestadorForm: document.querySelector("#prestadorForm"),
  prestadorModalTitle: document.querySelector("#prestadorModalTitle"),
  prestadorBackdrop: document.querySelector("#prestadorBackdrop"),
  newPrestador: document.querySelector("#newPrestador"),
  clearPrestador: document.querySelector("#clearPrestador"),
  closePrestadorModal: document.querySelector("#closePrestadorModal"),
  adiantamentoForm: document.querySelector("#adiantamentoForm"),
  adiantamentoBackdrop: document.querySelector("#adiantamentoBackdrop"),
  newAdiantamento: document.querySelector("#newAdiantamento"),
  closeAdiantamentoModal: document.querySelector("#closeAdiantamentoModal"),
  rescisaoForm: document.querySelector("#rescisaoForm"),
  rescisaoModal: document.querySelector("#rescisaoModal"),
  rescisaoBackdrop: document.querySelector("#rescisaoBackdrop"),
  newRescisao: document.querySelector("#newRescisao"),
  closeRescisaoModal: document.querySelector("#closeRescisaoModal"),
  folhaForm: document.querySelector("#folhaForm"),
  prestadoresTable: document.querySelector("#prestadoresTable"),
  adiantamentosTable: document.querySelector("#adiantamentosTable"),
  adiantamentoFilters: document.querySelectorAll("[data-adiantamento-filter]"),
  extratoTable: document.querySelector("#extratoTable"),
  extratoTitulo: document.querySelector("#extratoTitulo"),
  rescisoesTable: document.querySelector("#rescisoesTable"),
  rescisaoPreview: document.querySelector("#rescisaoPreview"),
  calcularRescisao: document.querySelector("#calcularRescisao"),
  folhaReport: document.querySelector("#folhaReport"),
  integrarOmie: document.querySelector("#integrarOmie"),
  reabrirFolha: document.querySelector("#reabrirFolha"),
  importarNfsFechadas: document.querySelector("#importarNfsFechadas"),
  aprovarFolha: document.querySelector("#aprovarFolha"),
  reprovarFolha: document.querySelector("#reprovarFolha"),
  solicitarNfs: document.querySelector("#solicitarNfs"),
  enviarAprovacaoFolha: document.querySelector("#enviarAprovacaoFolha"),
  approvalStatus: document.querySelector("#approvalStatus"),
  smtpForm: document.querySelector("#smtpForm"),
  smtpStatus: document.querySelector("#smtpStatus"),
  testSmtp: document.querySelector("#testSmtp"),
  emailTemplateForm: document.querySelector("#emailTemplateForm"),
  emailTemplateNav: document.querySelector("#emailTemplateNav"),
  emailTemplateVars: document.querySelector("#emailTemplateVars"),
  emailTemplateStatus: document.querySelector("#emailTemplateStatus"),
  omieForm: document.querySelector("#omieForm"),
  omieStatus: document.querySelector("#omieStatus"),
  testOmie: document.querySelector("#testOmie"),
  cadastrosConfig: document.querySelector("#cadastrosConfig"),
  usuarioForm: document.querySelector("#usuarioForm"),
  usuariosTable: document.querySelector("#usuariosTable"),
  usuarioModal: document.querySelector("#usuarioModal"),
  usuarioModalTitle: document.querySelector("#usuarioModalTitle"),
  newUsuario: document.querySelector("#newUsuario"),
  closeUsuarioModal: document.querySelector("#closeUsuarioModal"),
  clearUsuario: document.querySelector("#clearUsuario"),
  folhasTable: document.querySelector("#folhasTable"),
  folhaPreview: document.querySelector("#folhaPreview"),
  folhaHint: document.querySelector("#folhaHint"),
  folhaTotals: document.querySelector("#folhaTotals"),
  folhaLotes: document.querySelector("#folhaLotes"),
  folhaSearch: document.querySelector("#folhaSearch"),
  folhaCategoriaFilter: document.querySelector("#folhaCategoriaFilter"),
  folhaNfFilter: document.querySelector("#folhaNfFilter"),
  folhaOmieFilter: document.querySelector("#folhaOmieFilter"),
  folhaDiffFilter: document.querySelector("#folhaDiffFilter"),
  competenciaAtual: document.querySelector("#competenciaAtual"),
  folhaStatus: document.querySelector("#folhaStatus"),
  diasMesAuto: document.querySelector("#diasMesAuto"),
  deptCards: document.querySelector("#deptCards"),
  deptDrill: document.querySelector("#deptDrill"),
  searchPrestador: document.querySelector("#searchPrestador"),
  prestadorStatusFilter: document.querySelector("#prestadorStatusFilter"),
  configHub: document.querySelector("#configHub"),
  configBackdrop: document.querySelector("#configBackdrop"),
  compositionModal: document.querySelector("#compositionModal"),
  compositionTitle: document.querySelector("#compositionTitle"),
  compositionBody: document.querySelector("#compositionBody"),
  compositionBackdrop: document.querySelector("#compositionBackdrop"),
  closeCompositionModal: document.querySelector("#closeCompositionModal"),
};

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const permissionLabels = [
  ["view_prestadores", "Consultar prestadores"],
  ["edit_prestadores", "Cadastrar/alterar prestadores"],
  ["view_folhas", "Acessar folhas"],
  ["close_folhas", "Fechar folha"],
  ["reopen_folhas", "Reabrir folha"],
  ["approve_folhas", "Aprovar folha"],
  ["generate_reports", "Gerar relatorio"],
  ["integrate_omie", "Integrar Omie"],
  ["view_values_open", "Ver valores em aberto"],
  ["view_values_closed", "Ver valores fechados"],
  ["manage_adiantamentos", "Gerenciar adiantamentos"],
  ["manage_rescisoes", "Gerenciar rescisoes"],
  ["manage_cadastros", "Configurar tabelas"],
  ["manage_users", "Gerenciar usuarios"],
  ["manage_omie_config", "Configurar Omie"],
  ["manage_smtp", "Configurar e-mail"],
  ["reembolso_acessar", "Reembolso: acessar"],
  ["reembolso_solicitar", "Reembolso: solicitar"],
  ["reembolso_aprovar", "Reembolso: aprovar"],
  ["reembolso_financeiro", "Reembolso: financeiro"],
  ["reembolso_admin", "Reembolso: administrar"],
  ["reembolso_integrar_omie", "Reembolso: integrar Omie"],
  ["reembolso_relatorio", "Reembolso: relatórios"],
];
const permissionKeys = permissionLabels.map(([key]) => key);
const permissionLabelMap = Object.fromEntries(permissionLabels);
const simoneExceptionPrestadorId = 23;
const permissionGroups = [
  {
    title: "PJ-Redefrete",
    detail: "Folha PJ, prestadores, rescisões, adiantamentos e operação mensal.",
    keys: [
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
    ],
  },
  {
    title: "Reembolso de Despesas",
    detail: "Solicitações, aprovações, financeiro, relatórios e integração Omie do reembolso.",
    keys: [
      "reembolso_acessar",
      "reembolso_solicitar",
      "reembolso_aprovar",
      "reembolso_financeiro",
      "reembolso_admin",
      "reembolso_integrar_omie",
      "reembolso_relatorio",
    ],
  },
  {
    title: "Configurações",
    detail: "Tabelas auxiliares, usuários, Omie e configuração de e-mail.",
    keys: [
      "manage_cadastros",
      "manage_users",
      "manage_omie_config",
      "manage_smtp",
    ],
  },
];
const allPermissions = Object.fromEntries(permissionKeys.map((key) => [key, true]));
const defaultPermissionsByPerfil = {
  master: allPermissions,
  administrador: allPermissions,
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

function money(value) {
  return brl.format(Number(value || 0));
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function decimalValue(value) {
  return Number(value || 0).toFixed(2);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function daysInCompetencia(competencia) {
  const [year, month] = String(competencia).split("-").map(Number);
  if (!year || !month) return 30;
  return new Date(year, month, 0).getDate();
}

function payrollBaseDays() {
  return 30;
}

function pricingType(item) {
  return item?.precificacao_tipo === "diaria" ? "diaria" : "mensal";
}

function isDailyPriced(item) {
  return pricingType(item) === "diaria";
}

function folhaBaseValue(item) {
  return isDailyPriced(item) ? Number(item.valor_dia || 0) : Number(item.salario_contrato || item.salario_base || 0);
}

function folhaValorDias(item, dias) {
  const base = folhaBaseValue(item);
  return Number((isDailyPriced(item) ? base * Number(dias || 0) : (base / payrollBaseDays()) * Number(dias || 0)).toFixed(2));
}

function workedDaysForItem(item, competencia) {
  const realDays = daysInCompetencia(competencia);
  const monthStart = `${competencia}-01`;
  const monthEnd = `${competencia}-${String(realDays).padStart(2, "0")}`;
  const admissao = item.data_admissao || monthStart;
  const hasRescisao = Boolean(item.data_rescisao);
  const rescisao = item.data_rescisao || monthEnd;

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

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function currentCompetencia() {
  return todayIso().slice(0, 7);
}

function temporaryMinCompetencia() {
  return state.appConfig.minEditableCompetencia || currentCompetencia();
}

function temporaryMinAdiantamentoCompetencia() {
  return state.appConfig.minAdiantamentoCompetencia || temporaryMinCompetencia();
}

function monthFromDate(value) {
  return String(value || "").slice(0, 7);
}

function syncAdiantamentoCompetenciaFromDate(force = false) {
  const dateInput = el.adiantamentoForm?.elements?.data_adiantamento;
  const competenciaInput = el.adiantamentoForm?.elements?.competencia_inicial;
  if (!dateInput || !competenciaInput) return;
  const dataCompetencia = monthFromDate(dateInput.value);
  const minCompetencia = temporaryMinAdiantamentoCompetencia();
  if (!dataCompetencia || dataCompetencia < minCompetencia) return;
  if (force || !competenciaInput.value || competenciaInput.value > dataCompetencia) {
    competenciaInput.value = dataCompetencia;
  }
}

function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add("show");
  window.setTimeout(() => el.toast.classList.remove("show"), 3600);
}

let busyDepth = 0;

function showBusy(title = "Integrando com Omie", message = "Aguarde, estamos processando as informações.") {
  if (!el.busyOverlay) return;
  busyDepth += 1;
  if (el.busyTitle) el.busyTitle.textContent = title;
  if (el.busyMessage) el.busyMessage.textContent = message;
  el.busyOverlay.hidden = false;
}

function hideBusy() {
  busyDepth = Math.max(0, busyDepth - 1);
  if (busyDepth > 0) return;
  if (el.busyOverlay) el.busyOverlay.hidden = true;
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const method = String(options.method || "GET").toUpperCase();
  const shouldShowBusy = options.busy !== false && ["POST", "PUT", "PATCH", "DELETE"].includes(method) && busyDepth === 0;
  if (shouldShowBusy) showBusy(options.busyTitle || "Processando", options.busyMessage || "Aguarde, o sistema está operando.");
  try {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) showLogin();
      const error = new Error(data.error || (data.errors || []).join(" ") || "Falha na requisicao.");
      Object.assign(error, data, { status: response.status });
      throw error;
    }
    return data;
  } finally {
    if (shouldShowBusy) hideBusy();
  }
}

function canManage() {
  return hasPermission("edit_prestadores") || hasPermission("manage_adiantamentos") || hasPermission("manage_rescisoes");
}

function hasPermission(permission) {
  return Boolean(state.authUser?.permissoes?.[permission]);
}

function isAdminUser() {
  return hasPermission("manage_users");
}

function canUseSimoneException(item) {
  return isAdminUser() && Number(item?.prestador_id || item?.id || 0) === simoneExceptionPrestadorId;
}

function nfValidatedOrSimoneException(item) {
  return item?.nf_status === "validada" || canUseSimoneException(item);
}

function canCloseFolha() {
  return hasPermission("close_folhas");
}

function canApproveFolha() {
  return hasPermission("approve_folhas");
}

function canGenerateReport() {
  return hasPermission("generate_reports");
}

function canIntegrateOmie() {
  return hasPermission("integrate_omie");
}

function canAccessSettings() {
  return hasPermission("manage_users")
    || hasPermission("manage_omie_config")
    || hasPermission("manage_smtp")
    || hasPermission("manage_cadastros");
}

function canUseOperationalModules() {
  return hasPermission("manage_adiantamentos") || hasPermission("manage_rescisoes");
}

function canViewFolhas() {
  return hasPermission("view_folhas");
}

function canViewRescisoes() {
  return hasPermission("manage_rescisoes") || hasPermission("approve_folhas");
}

function canViewPrestadores() {
  return hasPermission("view_prestadores");
}

function canSeeSensitiveValues(context = {}) {
  if (context.folhaStatus === "fechada") return hasPermission("view_values_closed");
  return hasPermission("view_values_open");
}

function sensitiveMoney(value, context = {}) {
  return canSeeSensitiveValues(context) ? money(value) : "Restrito";
}

function defaultViewForUser() {
  if (canViewFolhas()) return "dashboard";
  if (canViewPrestadores()) return "prestadores";
  return "dashboard";
}

function showLogin(message = "") {
  el.loginScreen.classList.add("active");
  document.body.classList.add("auth-locked");
  if (el.loginFirstAccess) el.loginFirstAccess.hidden = true;
  el.loginMessage.textContent = message;
}

function hideLogin() {
  el.loginScreen.classList.remove("active");
  document.body.classList.remove("auth-locked");
  if (el.loginFirstAccess) el.loginFirstAccess.hidden = true;
  el.loginMessage.textContent = "";
}

function applyAuthUi() {
  el.currentUserName.textContent = state.authUser?.nome || "-";
  el.currentUserPerfil.textContent = state.authUser?.perfil || "-";
  document.querySelector(".settings-button").hidden = !canAccessSettings();
  el.newPrestador.hidden = !hasPermission("edit_prestadores");
  el.newAdiantamento.hidden = !hasPermission("manage_adiantamentos");
  el.newRescisao.hidden = !hasPermission("manage_rescisoes");
  document.querySelector('.nav-item[data-view="dashboard"]').hidden = !canViewFolhas();
  document.querySelector('.nav-item[data-view="prestadores"]').hidden = !canViewPrestadores();
  document.querySelector('.nav-item[data-view="adiantamentos"]').hidden = !hasPermission("manage_adiantamentos");
  document.querySelector('.nav-item[data-view="rescisoes"]').hidden = !canViewRescisoes();
  document.querySelector("#usuarioPanel").hidden = !hasPermission("manage_users");
  document.querySelector("#omiePanel").hidden = !hasPermission("manage_omie_config");
  const smtpPanel = document.querySelector("#smtpPanel");
  if (smtpPanel) smtpPanel.hidden = !hasPermission("manage_smtp");
  document.querySelectorAll("[data-admin-only]").forEach((item) => {
    item.hidden = !hasPermission("manage_users");
  });
  renderConfigHub();
}

function renderConfigHub() {
  if (!el.configHub) return;
  const sections = [
    {
      id: "usuarioPanel",
      permission: "manage_users",
      title: "Usuários e permissões",
      detail: `${state.usuarios.length || 0} usuário(s) cadastrados`,
    },
    {
      id: "smtpPanel",
      permission: "manage_smtp",
      title: "E-mail Microsoft Graph",
      detail: "Envio de cobranças de NF",
    },
    {
      id: "emailTemplatesPanel",
      permission: "manage_smtp",
      title: "Textos dos e-mails",
      detail: "Assuntos e mensagens de NF e aprovação",
    },
    {
      id: "omiePanel",
      permission: "manage_omie_config",
      title: "Omie",
      detail: "Integração com Contas a Pagar",
    },
    {
      id: "cadastrosPanel",
      permission: "manage_cadastros",
      title: "Cadastros auxiliares",
      detail: "Clientes, categorias, departamentos, funções e projetos",
    },
  ].filter((section) => hasPermission(section.permission));

  el.configHub.innerHTML = sections.length ? sections.map((section) => `
    <button type="button" class="config-card" data-open-config="${section.id}">
      <span class="config-card-icon">${section.title.slice(0, 1)}</span>
      <span class="config-card-copy">
        <strong>${section.title}</strong>
        <small>${section.detail}</small>
      </span>
    </button>
  `).join("") : `<p class="empty-state">Nenhuma configuração disponível para este usuário.</p>`;

  el.configHub.querySelectorAll("[data-open-config]").forEach((button) => {
    button.addEventListener("click", () => openConfigModal(button.dataset.openConfig));
  });
}

function openConfigModal(panelId) {
  document.querySelectorAll(".config-panel").forEach((panel) => panel.classList.remove("active"));
  const panel = document.querySelector(`#${panelId}`);
  if (!panel) return;
  panel.classList.add("active");
  el.configBackdrop.classList.add("active");
  document.body.classList.add("modal-open");
}

function closeConfigModal() {
  document.querySelectorAll(".config-panel").forEach((panel) => panel.classList.remove("active"));
  el.configBackdrop.classList.remove("active");
  document.body.classList.remove("modal-open");
}

function formData(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  form.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    data[input.name] = input.checked;
  });
  return data;
}

function setView(view) {
  document.body.dataset.view = view;
  document.querySelectorAll(".view").forEach((section) => section.classList.toggle("active", section.id === view));
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  const navItem = document.querySelector(`.nav-item[data-view="${view}"]`);
  const titles = { folha: "Fechamento", configuracoes: "Configurações" };
  el.pageTitle.textContent = navItem?.textContent || titles[view] || "Painel";
}

function openFolha(competencia) {
  setView("folha");
  el.folhaForm.elements.competencia.value = competencia;
  loadFolha(competencia);
}

function openPrestadorModal(title = "Cadastro do prestador") {
  el.prestadorModalTitle.textContent = title;
  el.prestadorForm.classList.add("active");
  el.prestadorForm.setAttribute("aria-hidden", "false");
  el.prestadorBackdrop.classList.add("active");
  el.prestadorBackdrop.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function closePrestadorModal() {
  el.prestadorForm.classList.remove("active");
  el.prestadorForm.setAttribute("aria-hidden", "true");
  el.prestadorBackdrop.classList.remove("active");
  el.prestadorBackdrop.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

function openAdiantamentoModal() {
  el.adiantamentoForm.classList.add("active");
  el.adiantamentoForm.setAttribute("aria-hidden", "false");
  el.adiantamentoBackdrop.classList.add("active");
  el.adiantamentoBackdrop.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function closeAdiantamentoModal() {
  el.adiantamentoForm.classList.remove("active");
  el.adiantamentoForm.setAttribute("aria-hidden", "true");
  el.adiantamentoBackdrop.classList.remove("active");
  el.adiantamentoBackdrop.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

function openRescisaoModal() {
  el.rescisaoModal.classList.add("active");
  el.rescisaoModal.setAttribute("aria-hidden", "false");
  el.rescisaoBackdrop.classList.add("active");
  el.rescisaoBackdrop.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function closeRescisaoModal() {
  el.rescisaoModal.classList.remove("active");
  el.rescisaoModal.setAttribute("aria-hidden", "true");
  el.rescisaoBackdrop.classList.remove("active");
  el.rescisaoBackdrop.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

function openCompositionModal(title, html) {
  el.compositionTitle.textContent = title;
  el.compositionBody.innerHTML = html;
  el.compositionModal.classList.add("active");
  el.compositionModal.setAttribute("aria-hidden", "false");
  el.compositionBackdrop.classList.add("active");
  el.compositionBackdrop.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function closeCompositionModal() {
  el.compositionModal.classList.remove("active");
  el.compositionModal.setAttribute("aria-hidden", "true");
  el.compositionBackdrop.classList.remove("active");
  el.compositionBackdrop.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

function resetAdiantamentoForm() {
  el.adiantamentoForm.reset();
  el.adiantamentoForm.elements.data_adiantamento.value = todayIso();
  syncAdiantamentoCompetenciaFromDate(true);
  clearPrestadorPicker("adiantamento");
}

function resetRescisaoForm() {
  el.rescisaoForm.reset();
  el.rescisaoForm.elements.data_rescisao.value = todayIso();
  el.rescisaoForm.elements.data_aviso.value = todayIso();
  el.rescisaoForm.elements.tipo_rescisao.value = "empresa";
  el.rescisaoForm.elements.descontos_manual.value = 0;
  clearPrestadorPicker("rescisao");
  el.rescisaoPreview.textContent = "Informe prestador e data para calcular.";
}

function resetPrestadorForm() {
  el.prestadorForm.reset();
  el.prestadorForm.elements.id.value = "";
  el.prestadorForm.elements.ativo.checked = true;
  el.prestadorForm.elements.cargo_nivel.value = "operacao";
  el.prestadorForm.elements.precificacao_tipo.value = "mensal";
  el.prestadorForm.elements.valor_dia.value = 0;
  el.prestadorForm.elements.rescisao_multa_empresa_percentual.value = 0;
  el.prestadorForm.elements.rescisao_multa_prestador_percentual.value = 0;
  renderPrestadorProjetoDepartamentoSelects();
  if (el.clearPrestador) el.clearPrestador.hidden = false;
  updatePrestadorPricingFields();
}

function renderRows(table, columns, rows, empty = "Sem registros.") {
  if (!rows.length) {
    table.innerHTML = `<tbody><tr><td>${empty}</td></tr></tbody>`;
    return;
  }
  table.innerHTML = `
    <thead><tr>${columns.map((col) => `<th>${col.label}</th>`).join("")}</tr></thead>
    <tbody>
      ${rows.map((row) => `
        <tr>${columns.map((col) => `<td>${col.render ? col.render(row) : row[col.key] || ""}</td>`).join("")}</tr>
      `).join("")}
    </tbody>
  `;
}

function renderPrestadores() {
  const term = el.searchPrestador.value.toLowerCase();
  const statusFilter = el.prestadorStatusFilter?.value || state.prestadorStatusFilter || "todos";
  const rows = state.prestadores
    .filter((p) => {
      if (statusFilter === "ativos" && !p.ativo) return false;
      if (statusFilter === "inativos" && p.ativo) return false;
      return [p.nome, p.razao_social, p.funcao, p.unidade_nome, p.departamento, p.projeto, p.cargo_nivel].some((value) => String(value || "").toLowerCase().includes(term));
    })
    .sort((a, b) => String(a.nome || a.razao_social || "").localeCompare(String(b.nome || b.razao_social || ""), "pt-BR", { sensitivity: "base" }));

  renderRows(el.prestadoresTable, [
    { label: "Prestador", render: (p) => hasPermission("edit_prestadores")
      ? `<button type="button" class="link-cell" data-edit="${p.id}"><strong>${escapeHtml(p.nome || p.razao_social || "")}</strong><small>${escapeHtml(p.razao_social || "")}</small></button>`
      : `<strong>${escapeHtml(p.nome || p.razao_social || "")}</strong><br><small>${escapeHtml(p.razao_social || "")}</small>` },
    { label: "Projeto | Cliente", render: (p) => `${p.projeto || ""} | ${p.cliente_nome || p.unidade_nome || ""}<br><small>${p.departamento || ""} | ${p.funcao || ""}</small>` },
    { label: "Nível", render: (p) => p.cargo_nivel === "gestao" ? "Gestão" : "Operação" },
    { label: "Precificação", render: (p) => isDailyPriced(p) ? `R$/dia<br><small>${sensitiveMoney(p.valor_dia)}</small>` : "R$/mês" },
    { label: "Admissão", render: (p) => formatDate(p.data_admissao) },
    { label: "Categoria", render: (p) => p.categoria || "-" },
    { label: "CPF", render: (p) => p.cpf },
    { label: "CNPJ", render: (p) => p.cnpj },
    { label: "R$ Contrato", render: (p) => `<span class="money">${sensitiveMoney(p.salario_contrato)}</span>` },
    { label: "Status", render: (p) => p.ativo ? "Ativo" : "Inativo" },
    { label: "Conta", render: (p) => `<button type="button" class="doc-icon-button account-button" data-conta-prestador="${p.id}" title="Conta corrente">${iconSvg("ledger")}</button>` },
  ], rows);

  el.prestadoresTable.querySelectorAll("[data-edit]").forEach((button) => {
    button.addEventListener("click", () => editPrestador(Number(button.dataset.edit)));
  });
  el.prestadoresTable.querySelectorAll("[data-conta-prestador]").forEach((button) => {
    button.addEventListener("click", () => openPrestadorAccount(button.dataset.contaPrestador).catch((error) => toast(error.message)));
  });
}

function renderSelects() {
  renderPrestadorPicker("adiantamento");
  renderPrestadorPicker("rescisao");

  el.prestadorForm.elements.cliente_id.innerHTML = state.clientes
    .map((item) => `<option value="${item.id}">${item.nome}</option>`)
    .join("");
  el.prestadorForm.elements.funcao_id.innerHTML = state.funcoes
    .map((item) => `<option value="${item.id}">${item.nome}</option>`)
    .join("");
  el.prestadorForm.elements.categoria_id.innerHTML = state.categorias
    .map((item) => `<option value="${item.id}">${item.nome}</option>`)
    .join("");
  renderPrestadorProjetoDepartamentoSelects();
}

function renderPrestadorProjetoDepartamentoSelects() {
  const form = el.prestadorForm;
  if (!form?.elements.cliente_id || !form?.elements.projeto_id || !form?.elements.departamento_id) return;
  const clienteId = form.elements.cliente_id.value;
  const projetoAtual = form.elements.projeto_id.value;
  const departamentoAtual = form.elements.departamento_id.value;
  const projetos = state.projetos.filter((item) => !clienteId || String(item.cliente_id) === String(clienteId));
  form.elements.projeto_id.innerHTML = projetos.map((item) => `<option value="${item.id}">${item.nome}</option>`).join("");
  if (projetos.some((item) => String(item.id) === String(projetoAtual))) form.elements.projeto_id.value = projetoAtual;

  const projetoId = form.elements.projeto_id.value;
  const departamentos = state.departamentos.filter((item) => (
    (!clienteId || String(item.cliente_id) === String(clienteId))
    && (!projetoId || String(item.projeto_id) === String(projetoId))
  ));
  form.elements.departamento_id.innerHTML = departamentos.map((item) => `<option value="${item.id}">${item.nome}</option>`).join("");
  if (departamentos.some((item) => String(item.id) === String(departamentoAtual))) form.elements.departamento_id.value = departamentoAtual;
}

const cadastroLabels = {
  clientes: "Clientes",
  categorias: "Categorias",
  departamentos: "Departamentos",
  funcoes: "Funções",
  projetos: "Projetos",
  unidades: "Unidades",
};

function renderCadastrosConfig() {
  const tipos = ["clientes", "categorias", "departamentos", "funcoes", "projetos"];
  const activeTipo = tipos.includes(state.cadastroTipoAtivo) ? state.cadastroTipoAtivo : "categorias";
  const rows = state.cadastroConfig[activeTipo] || [];
  el.cadastrosConfig.innerHTML = `
    <div class="aux-layout">
      <aside class="aux-nav">
        ${tipos.map((tipo) => {
          const tipoRows = state.cadastroConfig[tipo] || [];
          return `
            <button type="button" class="${tipo === activeTipo ? "active" : ""}" data-cadastro-tab="${tipo}">
              <strong>${cadastroLabels[tipo]}</strong>
              <span>${tipoRows.filter((row) => row.ativo).length} ativos</span>
            </button>
          `;
        }).join("")}
      </aside>
      <section class="aux-editor" data-cadastro="${activeTipo}">
        <div class="aux-editor-head entity-command-bar">
          <div>
            <h3>${cadastroLabels[activeTipo]}</h3>
            <span>${rows.length} registro(s)</span>
          </div>
          <div class="list-actions">
            <input class="cadastro-search search" data-cadastro-search="${activeTipo}" type="search" placeholder="Filtrar ${cadastroLabels[activeTipo].toLowerCase()}">
            ${activeTipo === "categorias" ? `<button type="button" data-sync-categorias-omie>Sincronizar Omie</button>` : ""}
            ${activeTipo === "departamentos" ? `<button type="button" data-sync-departamentos-omie>Sincronizar Omie</button>` : ""}
            <button type="button" data-clear-cadastro="${activeTipo}" class="primary">Novo</button>
          </div>
        </div>
        <form class="cadastro-form aux-form" data-cadastro-form="${activeTipo}">
          <input type="hidden" name="id" />
          <label>Nome<input name="nome" placeholder="Nome do cadastro" required /></label>
          ${activeTipo === "categorias" || activeTipo === "departamentos" ? `<label>Código Omie<input name="omie_codigo" placeholder="Consulta automática se vazio" /></label>` : ""}
          ${activeTipo === "departamentos" ? `<label>Cliente<select name="cliente_id"><option value="">Sem cliente</option>${(state.cadastroConfig.clientes || []).filter((cliente) => cliente.ativo).map((cliente) => `<option value="${cliente.id}">${cliente.nome}</option>`).join("")}</select></label>` : ""}
          ${activeTipo === "departamentos" ? `<label>Projeto / Operação<select name="projeto_id"><option value="">Sem projeto</option>${(state.cadastroConfig.projetos || []).filter((projeto) => projeto.ativo).map((projeto) => `<option value="${projeto.id}">${projeto.nome}${projeto.cliente_nome ? ` | ${projeto.cliente_nome}` : ""}</option>`).join("")}</select></label>` : ""}
          ${activeTipo === "projetos" ? `<label>Cliente<select name="cliente_id"><option value="">Sem cliente</option>${(state.cadastroConfig.clientes || []).filter((cliente) => cliente.ativo).map((cliente) => `<option value="${cliente.id}">${cliente.nome}</option>`).join("")}</select></label>` : ""}
          <label class="check"><input name="ativo" type="checkbox" checked /> Ativo</label>
          <button type="submit" class="primary">Salvar</button>
        </form>
        <div class="table-wrap compact-table aux-table">
          <table>
            <thead><tr><th>Nome</th>${activeTipo === "categorias" || activeTipo === "departamentos" ? "<th>Código Omie</th>" : ""}${activeTipo === "departamentos" ? "<th>Cliente</th><th>Projeto / Operação</th>" : ""}${activeTipo === "projetos" ? "<th>Cliente</th>" : ""}<th>Status</th><th></th></tr></thead>
            <tbody>
              ${rows.length ? rows.map((row) => `
                <tr>
                  <td><strong>${row.nome}</strong></td>
                  ${activeTipo === "categorias" || activeTipo === "departamentos" ? `<td>${row.omie_codigo || "-"}</td>` : ""}
                  ${activeTipo === "departamentos" ? `<td>${row.cliente_nome || "-"}</td><td>${row.projeto_nome || "-"}</td>` : ""}
                  ${activeTipo === "projetos" ? `<td>${row.cliente_nome || "-"}</td>` : ""}
                  <td>${row.ativo ? "Ativo" : "Inativo"}</td>
                  <td>
                    <div class="row-actions">
                      <button type="button" data-edit-cadastro="${activeTipo}" data-id="${row.id}">Editar</button>
                      ${activeTipo === "projetos" && row.ativo ? `<button type="button" class="danger" data-delete-cadastro="${activeTipo}" data-id="${row.id}">Excluir</button>` : ""}
                    </div>
                  </td>
                </tr>
              `).join("") : `<tr><td colspan="${activeTipo === "departamentos" ? 6 : (activeTipo === "categorias" || activeTipo === "projetos" ? 4 : 3)}">Sem registros.</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `;

  el.cadastrosConfig.querySelectorAll("[data-cadastro-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.cadastroTipoAtivo = button.dataset.cadastroTab;
      renderCadastrosConfig();
    });
  });
  el.cadastrosConfig.querySelectorAll("[data-cadastro-form]").forEach((form) => {
    form.addEventListener("submit", (event) => saveCadastroConfig(event).catch((error) => toast(error.message)));
  });
  el.cadastrosConfig.querySelectorAll("[data-clear-cadastro]").forEach((button) => {
    button.addEventListener("click", () => clearCadastroForm(button.dataset.clearCadastro));
  });
  el.cadastrosConfig.querySelectorAll("[data-edit-cadastro]").forEach((button) => {
    button.addEventListener("click", () => editCadastroConfig(button.dataset.editCadastro, Number(button.dataset.id)));
  });
  el.cadastrosConfig.querySelectorAll("[data-delete-cadastro]").forEach((button) => {
    button.addEventListener("click", () => deleteCadastroConfig(button.dataset.deleteCadastro, Number(button.dataset.id)).catch((error) => toast(error.message)));
  });
  el.cadastrosConfig.querySelectorAll("[data-sync-categorias-omie]").forEach((button) => {
    button.addEventListener("click", () => syncCategoriasOmie().catch((error) => toast(error.message)));
  });
  el.cadastrosConfig.querySelectorAll("[data-sync-departamentos-omie]").forEach((button) => {
    button.addEventListener("click", () => syncDepartamentosOmie().catch((error) => toast(error.message)));
  });
  el.cadastrosConfig.querySelectorAll("[data-cadastro-search]").forEach((input) => {
    input.addEventListener("input", () => filterCadastroRows(input));
  });
}

function prestadorPickerText(prestador) {
  return [
    prestador.razao_social,
    prestador.nome,
    prestador.cpf,
    prestador.cnpj,
    prestador.projeto,
    prestador.unidade_nome,
  ].filter(Boolean).join(" ");
}

function prestadorPickerLabel(prestador) {
  return `${prestador.razao_social || prestador.nome || ""} | ${prestador.nome || prestador.razao_social || ""}`;
}

function clearPrestadorPicker(kind) {
  const form = kind === "adiantamento" ? el.adiantamentoForm : el.rescisaoForm;
  const search = document.querySelector(`[data-prestador-search="${kind}"]`);
  const results = document.querySelector(`[data-prestador-results="${kind}"]`);
  form.elements.prestador_id.value = "";
  if (search) search.value = "";
  if (results) results.hidden = false;
  renderPrestadorPicker(kind);
}

function selectPrestador(kind, id) {
  const form = kind === "adiantamento" ? el.adiantamentoForm : el.rescisaoForm;
  const search = document.querySelector(`[data-prestador-search="${kind}"]`);
  const prestador = state.prestadores.find((item) => Number(item.id) === Number(id));
  if (!prestador) return;
  form.elements.prestador_id.value = prestador.id;
  if (search) search.value = prestadorPickerLabel(prestador);
  const results = document.querySelector(`[data-prestador-results="${kind}"]`);
  if (results) {
    results.innerHTML = "";
    results.hidden = true;
  }
}

function renderPrestadorPicker(kind) {
  const form = kind === "adiantamento" ? el.adiantamentoForm : el.rescisaoForm;
  const search = document.querySelector(`[data-prestador-search="${kind}"]`);
  const results = document.querySelector(`[data-prestador-results="${kind}"]`);
  if (!form || !search || !results) return;
  results.hidden = false;
  const selectedId = Number(form.elements.prestador_id.value || 0);
  const term = normalizeText(search.value);
  const selected = state.prestadores.find((prestador) => Number(prestador.id) === selectedId);
  if (selected && term === normalizeText(prestadorPickerLabel(selected))) {
    results.innerHTML = "";
    results.hidden = true;
    return;
  }
  const matches = state.prestadores
    .filter((prestador) => prestador.ativo || Number(prestador.id) === selectedId)
    .filter((prestador) => !term || normalizeText(prestadorPickerText(prestador)).includes(term))
    .sort((a, b) => String(a.nome || a.razao_social || "").localeCompare(String(b.nome || b.razao_social || ""), "pt-BR", { sensitivity: "base" }));
  results.innerHTML = matches.length
    ? matches.map((prestador) => `
      <button type="button" class="prestador-picker-option ${Number(prestador.id) === selectedId ? "active" : ""}" data-select-prestador="${kind}" data-id="${prestador.id}">
        <strong>${prestador.razao_social || prestador.nome}</strong>
        <small>${prestador.nome || ""}${prestador.cpf || prestador.cnpj ? ` | ${prestador.cpf || prestador.cnpj}` : ""}</small>
      </button>
    `).join("")
    : `<div class="prestador-picker-option"><strong>Nenhum prestador encontrado</strong><small>Tente outro nome, CPF ou CNPJ.</small></div>`;

  results.querySelectorAll("[data-select-prestador]").forEach((button) => {
    button.addEventListener("click", () => selectPrestador(kind, button.dataset.id));
  });
}

function filterCadastroRows(input) {
  const block = input.closest("[data-cadastro]");
  const search = normalizeText(input.value);
  block.querySelectorAll("tbody tr").forEach((row) => {
    row.hidden = search && !normalizeText(row.textContent).includes(search);
  });
}

function clearCadastroForm(tipo) {
  const form = el.cadastrosConfig.querySelector(`[data-cadastro-form="${tipo}"]`);
  form.reset();
  form.elements.id.value = "";
  if (form.elements.omie_codigo) form.elements.omie_codigo.value = "";
  if (form.elements.cliente_id) form.elements.cliente_id.value = "";
  if (form.elements.projeto_id) form.elements.projeto_id.value = "";
  form.elements.ativo.checked = true;
}

function editCadastroConfig(tipo, id) {
  const item = (state.cadastroConfig[tipo] || []).find((row) => Number(row.id) === id);
  if (!item) return;
  const form = el.cadastrosConfig.querySelector(`[data-cadastro-form="${tipo}"]`);
  form.elements.id.value = item.id;
  form.elements.nome.value = item.nome;
  if (form.elements.omie_codigo) form.elements.omie_codigo.value = item.omie_codigo || "";
  if (form.elements.cliente_id) form.elements.cliente_id.value = item.cliente_id || "";
  if (form.elements.projeto_id) form.elements.projeto_id.value = item.projeto_id || "";
  form.elements.ativo.checked = Boolean(item.ativo);
}

async function loadCadastrosConfig() {
  state.cadastroConfig = await api("/api/cadastros-config");
  renderCadastrosConfig();
}

async function saveCadastroConfig(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const tipo = form.dataset.cadastroForm;
  const data = formData(form);
  data.ativo = form.elements.ativo.checked;
  const id = data.id;
  delete data.id;
  showBusy(id ? "Atualizando cadastro" : "Criando cadastro", "Salvando configuração e atualizando listas.");
  try {
    await api(id ? `/api/cadastros/${tipo}/${id}` : `/api/cadastros/${tipo}`, {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(data),
    });
    clearCadastroForm(tipo);
    toast("Cadastro salvo.");
    await loadAll();
    if (document.querySelector("#configuracoes").classList.contains("active")) await loadCadastrosConfig();
  } finally {
    hideBusy();
  }
}

async function deleteCadastroConfig(tipo, id) {
  const item = (state.cadastroConfig[tipo] || []).find((row) => Number(row.id) === Number(id));
  if (!item) return;
  if (!confirm(`Excluir o projeto "${item.nome}"? Ele ficará inativo para preservar históricos.`)) return;
  showBusy("Excluindo cadastro", "Atualizando o status e recarregando listas.");
  try {
    await api(`/api/cadastros/${tipo}/${id}`, { method: "DELETE" });
    toast("Projeto excluido.");
    clearCadastroForm(tipo);
    await loadAll();
    if (document.querySelector("#configuracoes").classList.contains("active")) await loadCadastrosConfig();
  } finally {
    hideBusy();
  }
}

async function syncCategoriasOmie() {
  showBusy("Sincronizando categorias", "Consultando as categorias cadastradas na Omie.");
  try {
    const result = await api("/api/cadastros/categorias/sincronizar-omie", { method: "POST", body: "{}" });
    const naoEncontradas = result.naoEncontradas?.length || 0;
    toast(`Categorias Omie: ${result.atualizadas.length} atualizada(s), ${naoEncontradas} nao encontrada(s).`);
    await loadAll();
    if (document.querySelector("#configuracoes").classList.contains("active")) await loadCadastrosConfig();
  } finally {
    hideBusy();
  }
}

async function syncDepartamentosOmie() {
  showBusy("Sincronizando departamentos", "Consultando os departamentos cadastrados na Omie.");
  try {
    const result = await api("/api/cadastros/departamentos/sincronizar-omie", { method: "POST", body: "{}" });
    const naoEncontradas = result.naoEncontradas?.length || 0;
    toast(`Departamentos sincronizados: ${result.atualizadas?.length || 0} atualizados, ${naoEncontradas} sem correspondencia.`);
    await loadAll();
    if (document.querySelector("#configuracoes").classList.contains("active")) await loadCadastrosConfig();
  } finally {
    hideBusy();
  }
}

function renderUsuarios() {
  if (!isAdminUser()) return;
  const select = el.usuarioForm.elements.prestador_id;
  if (select) {
    select.innerHTML = `<option value="">Sem vínculo PJ</option>${state.prestadores.map((prestador) => `
      <option value="${prestador.id}">${prestador.razao_social || prestador.nome} | ${prestador.nome || ""} | ${prestador.cpf || prestador.cnpj || ""}</option>
    `).join("")}`;
  }
  document.querySelectorAll("[data-user-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.userFilter === state.usuarioAccessFilter);
  });
  const rows = state.usuarios.filter((usuario) => {
    const scope = usuarioAccessScope(usuario);
    if (state.usuarioAccessFilter === "geral") return scope === "geral";
    if (state.usuarioAccessFilter === "reembolso") return scope === "reembolso";
    return true;
  });
  renderRows(el.usuariosTable, [
    { label: "Nome", render: (u) => `<button type="button" class="link-cell" data-edit-usuario="${u.id}"><strong>${u.nome}</strong><small>${u.email}</small></button>` },
    { label: "Prestador PJ", render: (u) => u.prestador_id ? `<strong>${u.prestador_razao_social || u.prestador_nome || ""}</strong>` : `<span class="muted">Sem vínculo</span>` },
    { label: "Acesso", render: (u) => usuarioAccessScope(u) === "reembolso" ? "Somente Reembolso" : "Acesso geral" },
    { label: "Perfil", key: "perfil" },
    { label: "Permissões", render: (u) => `${Object.values(u.permissoes || {}).filter(Boolean).length} acesso(s)` },
    { label: "Status", render: (u) => u.primeiro_acesso ? "Primeiro acesso" : (u.ativo ? "Ativo" : "Inativo") },
    { label: "Ultimo login", render: (u) => u.ultimo_login || "" },
    {
      label: "Ações",
      render: (u) => `<button type="button" class="small" data-reset-senha="${u.id}" ${Number(u.id) === Number(state.authUser?.id) ? "disabled" : ""}>Resetar senha</button>`
    },
  ], rows);

  el.usuariosTable.querySelectorAll("[data-edit-usuario]").forEach((button) => {
    button.addEventListener("click", () => editUsuario(Number(button.dataset.editUsuario)));
  });
  el.usuariosTable.querySelectorAll("[data-reset-senha]").forEach((button) => {
    button.addEventListener("click", () => resetUsuarioSenha(Number(button.dataset.resetSenha)));
  });
}

function usuarioAccessScope(usuario) {
  if (usuario?.access_scope === "reembolso") return "reembolso";
  const permissoes = usuario?.permissoes || {};
  const enabled = Object.entries(permissoes).filter(([, value]) => Boolean(value)).map(([key]) => key);
  const hasReembolso = enabled.some((key) => key.startsWith("reembolso_"));
  const hasGeneral = enabled.some((key) => !key.startsWith("reembolso_"));
  return hasReembolso && !hasGeneral ? "reembolso" : "geral";
}

function openUsuarioModal(mode = "new") {
  if (mode === "new") clearUsuarioForm(false);
  el.usuarioModalTitle.textContent = mode === "edit" ? "Editar usuário" : "Novo usuário";
  el.usuarioModal.classList.add("active");
  el.configBackdrop.classList.add("active");
  document.body.classList.add("modal-open");
}

function closeUsuarioModal() {
  el.usuarioModal.classList.remove("active");
  if (!document.querySelector(".config-panel.active")) {
    el.configBackdrop.classList.remove("active");
    document.body.classList.remove("modal-open");
  }
}

function clearUsuarioForm() {
  el.usuarioForm.reset();
  el.usuarioForm.elements.id.value = "";
  el.usuarioForm.elements.ativo.checked = true;
  el.usuarioForm.elements.perfil.value = "consulta";
  if (el.usuarioForm.elements.prestador_id) el.usuarioForm.elements.prestador_id.value = "";
  renderUsuarioPermissoes(defaultPermissionsByPerfil.consulta);
}

function editUsuario(id) {
  const usuario = state.usuarios.find((item) => Number(item.id) === id);
  if (!usuario) return;
  el.usuarioForm.elements.id.value = usuario.id;
  el.usuarioForm.elements.nome.value = usuario.nome || "";
  el.usuarioForm.elements.email.value = usuario.email || "";
  if (el.usuarioForm.elements.prestador_id) el.usuarioForm.elements.prestador_id.value = usuario.prestador_id || "";
  el.usuarioForm.elements.perfil.value = usuario.perfil || "consulta";
  el.usuarioForm.elements.senha.value = "";
  el.usuarioForm.elements.ativo.checked = Boolean(usuario.ativo);
  renderUsuarioPermissoes(usuario.permissoes || {});
  openUsuarioModal("edit");
}

function renderUsuarioPermissoes(permissoes = {}) {
  const container = document.querySelector("#usuarioPermissoes");
  if (!container) return;
  container.innerHTML = permissionGroups.map((group) => `
    <section class="permission-group">
      <header>
        <h4>${group.title}</h4>
        <p>${group.detail}</p>
      </header>
      <div class="permission-grid">
        ${group.keys.map((key) => `
          <label class="check permission-check">
            <input name="perm_${key}" type="checkbox" ${permissoes[key] ? "checked" : ""}>
            ${permissionLabelMap[key] || key}
          </label>
        `).join("")}
      </div>
    </section>
  `).join("");
}

async function resetUsuarioSenha(id) {
  const usuario = state.usuarios.find((item) => Number(item.id) === Number(id));
  if (!usuario) return;
  if (!confirm(`Resetar a senha de ${usuario.nome}? No proximo login ele devera cadastrar uma nova senha.`)) return;
  showBusy("Resetando senha", "Atualizando o acesso do usuário.");
  try {
    await api(`/api/auth/users/${id}/reset-password`, { method: "POST", body: "{}" });
    toast("Senha resetada para primeiro acesso.");
    await loadUsuarios();
  } finally {
    hideBusy();
  }
}

function applyDefaultUsuarioPermissoes() {
  const perfil = el.usuarioForm.elements.perfil.value || "consulta";
  renderUsuarioPermissoes(defaultPermissionsByPerfil[perfil] || {});
}

function collectUsuarioPermissoes(data) {
  const permissoes = {};
  for (const [key] of permissionLabels) {
    permissoes[key] = Boolean(data[`perm_${key}`]);
    delete data[`perm_${key}`];
  }
  data.permissoes = permissoes;
  return data;
}

async function loadUsuarios() {
  if (!isAdminUser()) return;
  const data = await api("/api/auth/users");
  state.usuarios = data.usuarios;
  renderUsuarios();
}

function renderAdiantamentos() {
  const rows = state.adiantamentos.filter((adiantamento) => {
    const saldoAberto = Number(adiantamento.saldo_aberto || 0);
    if (state.adiantamentoFilter === "saldo") return saldoAberto > 0;
    if (state.adiantamentoFilter === "quitados") return saldoAberto <= 0;
    return true;
  });

  el.adiantamentoFilters.forEach((button) => {
    button.classList.toggle("active", button.dataset.adiantamentoFilter === state.adiantamentoFilter);
  });

  renderRows(el.adiantamentosTable, [
    { label: "Prestador", render: (a) => `<strong>${a.razao_social}</strong><br><small>${a.nome}</small>` },
    { label: "Data", key: "data_adiantamento" },
    { label: "Valor", render: (a) => sensitiveMoney(a.valor_total) },
    { label: "Parcelas", key: "parcelas" },
    { label: "Inicio", key: "competencia_inicial" },
    { label: "Status", render: (a) => ({ aberto: "Aberto", em_aprovacao: "Em aprovação", aprovado: "Aprovado", reprovado: "Reprovado" })[a.status || "aberto"] || a.status },
    { label: "Aprovações", render: (a) => renderApprovalMini(a.aprovacoes) },
    { label: "Saldo aberto", render: (a) => `<span class="money">${sensitiveMoney(a.saldo_aberto)}</span>` },
    { label: "", render: (a) => `
      <div class="row-actions">
        <button class="icon-button" data-extrato="${a.id}" title="Ver extrato">...</button>
        ${hasPermission("manage_adiantamentos") && ["aberto", "reprovado"].includes(a.status || "aberto") ? `<button data-adiantamento-request-approval="${a.id}">Enviar aprovação</button>` : ""}
        ${canApproveFolha() && a.status === "em_aprovacao" && !a.aprovacoes?.approved ? `<button data-adiantamento-approve="${a.id}">Aprovar</button><button data-adiantamento-reject="${a.id}">Reprovar</button>` : ""}
        ${hasPermission("manage_adiantamentos") && ["aberto", "reprovado"].includes(a.status || "aberto") ? `<button class="icon-button danger-button" data-delete-adiantamento="${a.id}" title="Excluir adiantamento">&times;</button>` : ""}
      </div>
    ` },
  ], rows);

  el.adiantamentosTable.querySelectorAll("[data-extrato]").forEach((button) => {
    button.addEventListener("click", () => loadExtrato(button.dataset.extrato));
  });
  el.adiantamentosTable.querySelectorAll("[data-delete-adiantamento]").forEach((button) => {
    button.addEventListener("click", () => deleteAdiantamento(button.dataset.deleteAdiantamento).catch((error) => toast(error.message)));
  });
  el.adiantamentosTable.querySelectorAll("[data-adiantamento-request-approval]").forEach((button) => {
    button.addEventListener("click", () => enviarAdiantamentoAprovacao(button.dataset.adiantamentoRequestApproval).catch((error) => toast(error.message)));
  });
  el.adiantamentosTable.querySelectorAll("[data-adiantamento-approve]").forEach((button) => {
    button.addEventListener("click", () => aprovarAdiantamento(button.dataset.adiantamentoApprove).catch((error) => toast(error.message)));
  });
  el.adiantamentosTable.querySelectorAll("[data-adiantamento-reject]").forEach((button) => {
    button.addEventListener("click", () => reprovarAdiantamento(button.dataset.adiantamentoReject).catch((error) => toast(error.message)));
  });
}

async function enviarAdiantamentoAprovacao(id) {
  const result = await api(`/api/adiantamentos/${id}/enviar-aprovacao`, { method: "POST", body: "{}" });
  const enviados = result.enviados?.length || 0;
  toast(`Adiantamento enviado para aprovação: ${enviados} e-mail(s).`);
  await loadAll();
}

async function aprovarAdiantamento(id) {
  const result = await api(`/api/adiantamentos/${id}/aprovar`, { method: "POST", body: "{}" });
  toast(result.aprovado ? "Adiantamento aprovado." : `Aprovação registrada: ${result.aprovacoes.count}/${result.aprovacoes.required}.`);
  await loadAll();
}

async function reprovarAdiantamento(id) {
  const motivo = window.prompt("Informe a justificativa da recusa:");
  if (!motivo || !motivo.trim()) return;
  await api(`/api/adiantamentos/${id}/reprovar`, { method: "POST", body: JSON.stringify({ motivo }) });
  toast("Adiantamento reprovado e liberado para ajuste.");
  await loadAll();
}

async function deleteAdiantamento(id) {
  const item = state.adiantamentos.find((adiantamento) => Number(adiantamento.id) === Number(id));
  const nome = item?.razao_social || item?.nome || "este adiantamento";
  if (!window.confirm(`Excluir o adiantamento de ${nome}?`)) return;
  showBusy("Excluindo adiantamento", "Removendo o registro e atualizando a tela.");
  try {
    await api(`/api/adiantamentos/${id}`, { method: "DELETE" });
    toast("Adiantamento excluido.");
    el.extratoTitulo.textContent = "Selecione um adiantamento";
    renderRows(el.extratoTable, [], []);
    await loadAll();
  } finally {
    hideBusy();
  }
}

function renderRescisoes() {
  renderRows(el.rescisoesTable, [
    { label: "Prestador", render: (r) => `<button type="button" class="link-button row-main-action" data-compose-rescisao="${r.id}"><strong>${r.razao_social}</strong><small>${r.nome}</small></button>` },
    { label: "Data", key: "data_rescisao" },
    { label: "Status", render: (r) => renderRescisaoStatus(r) },
    { label: "NF", render: (r) => renderRescisaoNf(r) },
    { label: "Aprovações", render: (r) => renderApprovalMini(r.aprovacoes) },
    { label: "Próxima etapa", render: (r) => renderRescisaoNextStep(r) },
    { label: "Dias", render: (r) => `${r.dias_trabalhados}/${r.dias_mes}` },
    { label: "Aviso", render: (r) => `${r.aviso_dias || 0} dias<br><small>${Number(r.aviso_cumprido || 0) ? "Cumprido" : "Não cumprido"}</small>` },
    { label: "Proporcional", render: (r) => sensitiveMoney(r.valor_proporcional) },
    { label: "Multa", render: (r) => sensitiveMoney(r.valor_multa) },
    { label: "Adiantamentos", render: (r) => sensitiveMoney(r.adiantamentos_abertos) },
    { label: "Total a pagar", render: (r) => `<span class="money">${sensitiveMoney(r.valor_total_pagar)}</span>` },
    { label: "", render: (r) => renderRescisaoActions(r) },
  ], state.rescisoes);

  el.rescisoesTable.querySelectorAll("[data-compose-rescisao]").forEach((button) => {
    button.addEventListener("click", () => showRescisaoComposition(button.dataset.composeRescisao));
  });
  el.rescisoesTable.querySelectorAll("[data-rescisao-nf]").forEach((input) => {
    input.addEventListener("change", () => uploadRescisaoNf(input).catch((error) => toast(error.message)));
  });
  el.rescisoesTable.querySelectorAll("[data-view-rescisao-nf]").forEach((button) => {
    button.addEventListener("click", () => openNfViewer(button.dataset.viewRescisaoNf, button.dataset.name || "NF"));
  });
  el.rescisoesTable.querySelectorAll("[data-rescisao-approve]").forEach((button) => {
    button.addEventListener("click", () => aprovarRescisao(button.dataset.rescisaoApprove).catch((error) => toast(error.message)));
  });
  el.rescisoesTable.querySelectorAll("[data-rescisao-reject]").forEach((button) => {
    button.addEventListener("click", () => reprovarRescisao(button.dataset.rescisaoReject).catch((error) => toast(error.message)));
  });
  el.rescisoesTable.querySelectorAll("[data-rescisao-finalize]").forEach((button) => {
    button.addEventListener("click", () => finalizarRescisao(button.dataset.rescisaoFinalize).catch((error) => toast(error.message)));
  });
  el.rescisoesTable.querySelectorAll("[data-rescisao-omie]").forEach((button) => {
    button.addEventListener("click", () => integrarRescisaoOmie(button.dataset.rescisaoOmie).catch((error) => toast(error.message)));
  });
  el.rescisoesTable.querySelectorAll("[data-rescisao-request-approval]").forEach((button) => {
    button.addEventListener("click", () => enviarRescisaoAprovacao(button.dataset.rescisaoRequestApproval).catch((error) => toast(error.message)));
  });
  el.rescisoesTable.querySelectorAll("[data-rescisao-report]").forEach((button) => {
    button.addEventListener("click", () => openRescisaoReport(button.dataset.rescisaoReport));
  });
}

function renderRescisaoStatus(rescisao) {
  const label = renderTextStatusRescisao(rescisao.status);
  const kind = ["finalizada", "integrada_omie"].includes(rescisao.status) ? "ok" : "warn";
  return `<span class="status-pill ${kind}">${label}</span>`;
}

function renderTextStatusRescisao(status) {
  const labels = {
    aguardando_nf: "Aguardando NF",
    em_aprovacao: "Em aprovação",
    reprovada: "Reprovada",
    finalizada: "Finalizada",
    integrada_omie: "Omie integrada",
    erro_omie: "Erro Omie",
  };
  return labels[status] || status || "Aguardando NF";
}

function renderRescisaoNf(rescisao) {
  const status = rescisao.nf_status || "pendente";
  const label = status === "validada" ? "Validada" : status === "divergente" ? "Divergente" : "Pendente";
  const className = status === "validada" ? "ok" : "warn";
  const name = escapeHtml(rescisao.numero_nf || rescisao.nf_original_name || "NF");
  const statusPill = rescisao.nf_id
    ? `<button type="button" class="status-pill ${className} nf-status-button" data-view-rescisao-nf="${rescisao.nf_id}" data-name="${name}" title="Visualizar NF">${label}</button>`
    : `<span class="status-pill ${className}">${label}</span>`;
  if (status === "validada") return statusPill;
  const download = rescisao.nf_id ? `<br><a href="/api/nfs/${rescisao.nf_id}/download" target="_blank">${rescisao.numero_nf || "Baixar NF"}</a>` : "";
  const diff = rescisao.diferenca_nf ? `<br><small>Dif. ${money(rescisao.diferenca_nf)}</small>` : "";
  return `${statusPill}${download}${diff}`;
}

function renderApprovalMini(aprovacoes = {}) {
  const count = aprovacoes.count || 0;
  const required = aprovacoes.required || 0;
  const missing = (aprovacoes.pendentes || []).map((item) => item.nome);
  const next = aprovacoes.proximo?.nome;
  return aprovacoes.approved
    ? `<span class="approval-pill ok">Aprovada ${count}/${required}</span>`
    : `<span class="approval-pill">Aprovações ${count}/${required}</span>${next ? `<br><small>Agora: ${escapeHtml(next)}</small>` : missing.length ? `<br><small>${missing.length} pendente(s)</small>` : ""}`;
}

function renderRescisaoNextStep(rescisao) {
  if (rescisao.status === "integrada_omie") return "Concluída no Omie";
  if (rescisao.status === "finalizada") return canIntegrateOmie() ? "Enviar ao Omie" : "Aguardando Omie";
  if (rescisao.status === "reprovada") return "Ajustar e reenviar";
  if (!nfValidatedOrSimoneException(rescisao)) return "Aguardando NF validada";
  if (rescisao.status !== "em_aprovacao" && !rescisao.aprovacoes?.approved) return "Enviar para aprovação";
  if (!rescisao.aprovacoes?.approved) {
    const missing = (rescisao.aprovacoes?.pendentes || []).map((item) => item.nome).join(", ");
    return missing ? `Falta aprovar: ${missing}` : "Aguardando aprovações";
  }
  return "Finalizar rescisão";
}

function renderRescisaoActions(rescisao) {
  const canUpload = hasPermission("manage_rescisoes") && !["em_aprovacao", "finalizada", "integrada_omie"].includes(rescisao.status);
  const nfOk = nfValidatedOrSimoneException(rescisao);
  const canApprove = canApproveFolha() && rescisao.status === "em_aprovacao" && nfOk && !rescisao.aprovacoes?.approved;
  const canReject = canApprove;
  const canRequestApproval = hasPermission("manage_rescisoes") && nfOk && rescisao.status !== "em_aprovacao" && !rescisao.aprovacoes?.approved && !["finalizada", "integrada_omie"].includes(rescisao.status);
  const canFinalize = hasPermission("manage_rescisoes") && nfOk && rescisao.aprovacoes?.approved && !["finalizada", "integrada_omie"].includes(rescisao.status);
  const canOmie = canIntegrateOmie() && rescisao.status === "finalizada" && nfOk && rescisao.aprovacoes?.approved;
  return `
    <div class="row-actions">
      ${canUpload ? `<label class="file-icon-input" title="Anexar NF">NF<input data-rescisao-nf="${rescisao.id}" type="file" accept=".pdf,.xml" /></label>` : ""}
      ${canRequestApproval ? `<button data-rescisao-request-approval="${rescisao.id}">Enviar aprovação</button>` : ""}
      ${canApprove ? `<button data-rescisao-approve="${rescisao.id}" title="Aprovar rescisão">Aprovar</button>` : ""}
      ${canReject ? `<button data-rescisao-reject="${rescisao.id}" title="Reprovar rescisão">Reprovar</button>` : ""}
      ${canFinalize ? `<button data-rescisao-finalize="${rescisao.id}">Finalizar</button>` : ""}
      ${canOmie ? `<button data-rescisao-omie="${rescisao.id}">Omie</button>` : ""}
      ${canGenerateReport() ? `<button type="button" class="doc-icon-button" data-rescisao-report="${rescisao.id}" title="Relatório">${iconSvg("report")}</button>` : ""}
    </div>
  `;
}

function compositionRows(rows, context = {}) {
  return `
    <table class="composition-table">
      <tbody>
        ${rows.map((row) => `
          <tr class="${row.total ? "total-row" : ""}">
            <th>${escapeHtml(row.label)}</th>
            <td class="${row.negative ? "danger" : ""}">${row.money ? sensitiveMoney(row.value, context) : escapeHtml(row.value ?? "")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function compositionSummary(items, context = {}) {
  return `
    <section class="composition-summary">
      ${items.map((item) => `
        <article>
          <span>${escapeHtml(item.label)}</span>
          <strong class="${item.negative ? "danger" : ""}">${item.money ? sensitiveMoney(item.value, context) : escapeHtml(item.value ?? "")}</strong>
        </article>
      `).join("")}
    </section>
  `;
}

function compositionSection(title, rows, context = {}) {
  return `
    <section class="composition-section">
      <div class="composition-section-title"><h3>${escapeHtml(title)}</h3></div>
      ${compositionRows(rows, context)}
    </section>
  `;
}

function compositionInfoTable(rows) {
  return `
    <table class="composition-info-table">
      <tbody>
        ${rows.map((pair) => `
          <tr>
            <th>${escapeHtml(pair[0]?.label || "")}</th>
            <td>${escapeHtml(pair[0]?.value || "")}</td>
            <th>${escapeHtml(pair[1]?.label || "")}</th>
            <td>${escapeHtml(pair[1]?.value || "")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function compositionApprovals(aprovacoes = {}) {
  const aprovadores = aprovacoes.aprovadores || [];
  return `
    <section class="composition-approvals">
      <div class="composition-section-title">
        <h3>Aprovações</h3>
        <span>${escapeHtml(aprovacoes.approved ? "Fluxo completo" : "Fluxo pendente")}</span>
      </div>
      <table class="composition-info-table">
        <thead>
          <tr>
            <th>Aprovador</th>
            <th>E-mail</th>
            <th>Data</th>
            <th>Autenticação</th>
          </tr>
        </thead>
        <tbody>
          ${aprovadores.length ? aprovadores.map((item) => `
            <tr>
              <td>${escapeHtml(item.nome)}</td>
              <td>${escapeHtml(item.email)}</td>
              <td>${escapeHtml(formatDateTime(item.aprovado_em))}</td>
              <td><strong>${escapeHtml(item.codigo_autenticacao || "")}</strong></td>
            </tr>
          `).join("") : `<tr><td colspan="4">Sem aprovações registradas.</td></tr>`}
        </tbody>
      </table>
    </section>
  `;
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(value ? new Date(value) : new Date());
}

function formatDate(value) {
  if (!value) return "-";
  const date = String(value).includes("T") ? new Date(value) : new Date(`${value}T12:00:00`);
  return new Intl.DateTimeFormat("pt-BR").format(date);
}

function showFolhaComposition(id) {
  const item = state.folhaPreview.find((row) => Number(row.prestador_id || row.id) === Number(id));
  if (!item) return;
  const context = { folhaStatus: state.folhaAtual?.status };
  const proventos = Number(item.valor_dias || 0) + Number(item.adicoes || 0) + Number(item.bonus || 0);
  const descontos = Number(item.descontos_manual || 0) + Number(item.desconto_adiantamentos || 0);
  openCompositionModal("Composição do pagamento", `
    <article class="composition-report">
      <header class="composition-report-head">
        <div class="composition-brand">
          <img src="/assets/logo-redefrete-branco.png" alt="Redefrete" />
          <small>Demonstrativo PJ</small>
        </div>
        <div>
          <small>Composição do pagamento</small>
          <h3>${escapeHtml(item.razao_social || item.nome)}</h3>
          <span>${escapeHtml(item.nome || "")}</span>
        </div>
        <div class="composition-report-meta">
          <small>Competência</small>
          <strong>${escapeHtml(state.folhaAtual?.competencia || "")}</strong>
          <span>${escapeHtml(state.folhaAtual?.status || "")}</span>
        </div>
      </header>
      ${compositionSummary([
        { label: "Dias", value: item.dias_trabalhados },
        { label: "Proventos", value: proventos, money: true },
        { label: "Descontos", value: descontos, money: true, negative: true },
        { label: "Total a pagar", value: item.liquido_pagar, money: true },
        { label: "Dif. NF", value: item.diferenca_nf, money: true, negative: Number(item.diferenca_nf || 0) < 0 },
      ], context)}
      <div class="composition-section-title">
        <h3>Dados do prestador</h3>
        <span>Gerado em ${escapeHtml(formatDateTime())}</span>
      </div>
      ${compositionInfoTable([
        [
          { label: "Razão social", value: item.razao_social || "" },
          { label: "Prestador", value: item.nome || "" },
        ],
        [
          { label: "CPF/CNPJ", value: [item.cpf, item.cnpj].filter(Boolean).join(" / ") },
          { label: "Lotação", value: `${item.unidade_nome || ""} | ${item.departamento || ""}${item.projeto ? ` | ${item.projeto}` : ""}` },
        ],
      ])}
      <div class="composition-two-col">
        ${compositionSection("Memória de cálculo", [
          { label: "R$ Contrato", value: item.salario_contrato || item.salario_base, money: true },
          { label: "Dias trabalhados", value: item.dias_trabalhados },
          { label: "Valor dias", value: item.valor_dias, money: true },
          { label: "Adições", value: item.adicoes, money: true },
          { label: "Bônus", value: item.bonus, money: true },
          { label: "Total proventos", value: proventos, money: true, total: true },
        ], context)}
        ${compositionSection("Descontos e NF", [
          { label: "Descontos manuais", value: item.descontos_manual, money: true, negative: true },
          { label: "Adiantamentos", value: item.desconto_adiantamentos, money: true, negative: true },
          { label: "Total descontos", value: descontos, money: true, total: true, negative: true },
          { label: "Valor NF emitida", value: item.valor_nf_emitida, money: true },
          { label: "Número NF", value: item.numero_nf || "-" },
          { label: "Status NF", value: item.nf_status || "pendente" },
          { label: "Total a pagar", value: item.liquido_pagar, money: true, total: true },
        ], context)}
      </div>
      ${compositionApprovals(state.folhaAtual?.aprovacoes || {})}
    </article>
  `);
}

function showRescisaoComposition(id) {
  const rescisao = state.rescisoes.find((row) => Number(row.id) === Number(id));
  if (!rescisao) return;
  const proventos = Number(rescisao.valor_proporcional || 0) + Math.max(Number(rescisao.valor_multa || 0), 0);
  const descontos = Number(rescisao.adiantamentos_abertos || 0) + Number(rescisao.descontos_manual || 0) + Math.abs(Math.min(Number(rescisao.valor_multa || 0), 0));
  openCompositionModal("Composição da rescisão", `
    <article class="composition-report">
      <header class="composition-report-head">
        <div class="composition-brand">
          <img src="/assets/logo-redefrete-branco.png" alt="Redefrete" />
          <small>Demonstrativo PJ</small>
        </div>
        <div>
          <small>Composição da rescisão</small>
          <h3>${escapeHtml(rescisao.razao_social || rescisao.nome)}</h3>
          <span>${escapeHtml(rescisao.nome || "")}</span>
        </div>
        <div class="composition-report-meta">
          <small>Data da rescisão</small>
          <strong>${escapeHtml(rescisao.data_rescisao || "")}</strong>
          <span>${escapeHtml(renderTextStatusRescisao(rescisao.status))}</span>
        </div>
      </header>
      ${compositionSummary([
        { label: "Competência", value: rescisao.competencia || "" },
        { label: "Dias", value: `${rescisao.dias_trabalhados || 0}/${rescisao.dias_mes || 0}` },
        { label: "Proventos", value: proventos, money: true },
        { label: "Descontos", value: descontos, money: true, negative: true },
        { label: "Total a pagar", value: rescisao.valor_total_pagar, money: true },
      ])}
      <div class="composition-section-title">
        <h3>Dados do prestador</h3>
        <span>Gerado em ${escapeHtml(formatDateTime())}</span>
      </div>
      ${compositionInfoTable([
        [
          { label: "Razão social", value: rescisao.razao_social || "" },
          { label: "Prestador", value: rescisao.nome || "" },
        ],
        [
          { label: "CPF/CNPJ", value: [rescisao.cpf, rescisao.cnpj].filter(Boolean).join(" / ") },
          { label: "Motivo", value: rescisao.motivo || "" },
        ],
        [
          { label: "Aviso", value: `${rescisao.data_aviso || ""} | ${rescisao.aviso_dias || 0} dias | ${Number(rescisao.aviso_cumprido || 0) ? "cumprido" : "não cumprido"}` },
          { label: "Tipo", value: rescisao.tipo_rescisao === "prestador" ? "Prestador rescinde" : "Empresa rescinde" },
        ],
      ])}
      <div class="composition-two-col">
        ${compositionSection("Memória de cálculo", [
          { label: "R$ Contrato", value: rescisao.salario_base, money: true },
          { label: "Dias trabalhados", value: `${rescisao.dias_trabalhados || 0}/${rescisao.dias_mes || 0}` },
          { label: "Valor proporcional", value: rescisao.valor_proporcional, money: true },
          { label: `Multa rescisão (${rescisao.multa_percentual || 0}%)`, value: rescisao.valor_multa, money: true, negative: Number(rescisao.valor_multa || 0) < 0 },
          { label: "Adiantamentos em aberto", value: rescisao.adiantamentos_abertos, money: true, negative: true },
          { label: "Descontos manuais", value: rescisao.descontos_manual, money: true, negative: true },
          { label: "Total a pagar", value: rescisao.valor_total_pagar, money: true, total: true },
        ])}
        ${compositionSection("NF e fluxo", [
          { label: "Status NF", value: rescisao.nf_status || "pendente" },
          { label: "Número NF", value: rescisao.numero_nf || "-" },
          { label: "Valor NF", value: rescisao.valor_nf_emitida, money: true },
          { label: "Diferença NF", value: rescisao.diferenca_nf, money: true, negative: Number(rescisao.diferenca_nf || 0) < 0 },
          { label: "Aprovações", value: `${rescisao.aprovacoes?.count || 0}/${rescisao.aprovacoes?.required || 0}` },
          { label: "Omie", value: rescisao.omie_status || "pendente" },
        ])}
      </div>
      ${compositionApprovals(rescisao.aprovacoes || {})}
    </article>
  `);
}

async function loadExtrato(id) {
  const data = await api(`/api/adiantamentos/${id}/extrato`);
  el.extratoTitulo.textContent = `${data.adiantamento.razao_social} | ${sensitiveMoney(data.adiantamento.valor_total)}`;
  renderRows(el.extratoTable, [
    { label: "Parcela", render: (p) => `${p.numero_parcela}` },
    { label: "Competencia", key: "competencia" },
    { label: "Valor", render: (p) => sensitiveMoney(p.valor) },
    { label: "Status", render: (p) => p.descontado ? "Descontada" : "Em aberto" },
    { label: "Folha", render: (p) => p.folha_competencia || "" },
  ], data.parcelas);
}

function renderRescisaoPreview(data) {
  const c = data.calculo;
  el.rescisaoPreview.innerHTML = `
    <dl>
      <div><dt>Competencia</dt><dd>${c.competencia}</dd></div>
      <div><dt>Dias trabalhados</dt><dd>${c.dias_trabalhados}/${c.dias_mes}</dd></div>
      <div><dt>R$ Contrato</dt><dd>${sensitiveMoney(c.salario_base)}</dd></div>
      <div><dt>Valor proporcional</dt><dd>${sensitiveMoney(c.valor_proporcional)}</dd></div>
      <div><dt>Aviso</dt><dd>${c.aviso_dias} dias - ${c.aviso_cumprido ? "cumprido" : "não cumprido"}</dd></div>
      <div><dt>Dias faltantes</dt><dd>${c.dias_restantes_periodo} dias (${sensitiveMoney(c.valor_dias_restantes)})</dd></div>
      <div><dt>Multa (${c.multa_percentual}%)</dt><dd>${sensitiveMoney(c.valor_multa)}</dd></div>
      <div><dt>Adiantamentos em aberto</dt><dd>${sensitiveMoney(c.adiantamentos_abertos)}</dd></div>
      <div><dt>Descontos manuais</dt><dd>${sensitiveMoney(c.descontos_manual)}</dd></div>
      <div><dt>Total a pagar</dt><dd class="money">${sensitiveMoney(c.valor_total_pagar)}</dd></div>
    </dl>
  `;
}

async function calcularRescisao() {
  const data = formData(el.rescisaoForm);
  if (!data.prestador_id || !data.data_rescisao || !data.data_aviso) {
    toast("Informe prestador, data do aviso e data da rescisao.");
    return null;
  }
  const result = await api(`/api/prestadores/${data.prestador_id}/rescisao/calcular`, {
    method: "POST",
    body: JSON.stringify(data),
  });
  renderRescisaoPreview(result);
  return result;
}

async function loadSmtpConfig() {
  const data = await api("/api/config/smtp");
  const smtp = data.smtp;
  el.smtpForm.elements.graphTenantId.value = smtp.graphTenantId || "";
  el.smtpForm.elements.graphClientId.value = smtp.graphClientId || "";
  el.smtpForm.elements.graphFrom.value = smtp.graphFrom || "";
  el.smtpForm.elements.graphClientSecret.value = "";
  el.smtpForm.elements.nfDestinationEmail.value = smtp.nfDestinationEmail || "paulo.mendonca@redefrete.com.br";
  el.smtpForm.elements.testEmail.value = smtp.nfDestinationEmail || "paulo.mendonca@redefrete.com.br";
  el.smtpStatus.textContent = smtp.graphSecretConfigured ? "Microsoft Graph configurado." : "Microsoft Graph sem secret.";
}

function renderEmailTemplates() {
  if (!el.emailTemplateNav || !state.emailTemplates.length) return;
  const active = state.emailTemplates.find((item) => item.tipo === state.emailTemplateAtivo) || state.emailTemplates[0];
  state.emailTemplateAtivo = active.tipo;
  el.emailTemplateNav.innerHTML = state.emailTemplates.map((template) => `
    <button type="button" class="${template.tipo === active.tipo ? "active" : ""}" data-email-template="${template.tipo}">
      <strong>${template.nome}</strong>
      <span>${template.tipo}</span>
    </button>
  `).join("");
  el.emailTemplateForm.elements.tipo.value = active.tipo;
  el.emailTemplateForm.elements.assunto.value = active.assunto || "";
  el.emailTemplateForm.elements.corpo.value = active.corpo || "";
  el.emailTemplateVars.textContent = (state.emailTemplateVars[active.tipo] || []).join("  ");
  el.emailTemplateStatus.textContent = active.atualizado_em ? `Última atualização: ${active.atualizado_em}` : "";
  el.emailTemplateNav.querySelectorAll("[data-email-template]").forEach((button) => {
    button.addEventListener("click", () => {
      state.emailTemplateAtivo = button.dataset.emailTemplate;
      renderEmailTemplates();
    });
  });
}

async function loadEmailTemplates() {
  const data = await api("/api/config/email-templates");
  state.emailTemplates = data.templates || [];
  state.emailTemplateVars = data.variaveis || {};
  renderEmailTemplates();
}

async function saveEmailTemplate() {
  const tipo = el.emailTemplateForm.elements.tipo.value;
  const assunto = el.emailTemplateForm.elements.assunto.value;
  const corpo = el.emailTemplateForm.elements.corpo.value;
  const data = await api(`/api/config/email-templates/${encodeURIComponent(tipo)}`, {
    method: "PUT",
    body: JSON.stringify({ assunto, corpo }),
  });
  state.emailTemplates = state.emailTemplates.map((template) => template.tipo === tipo ? data.template : template);
  el.emailTemplateStatus.textContent = "Texto salvo.";
  toast("Texto do e-mail salvo.");
  renderEmailTemplates();
}

async function saveSmtpConfig() {
  const data = formData(el.smtpForm);
  await api("/api/config/smtp", {
    method: "POST",
    body: JSON.stringify(data),
  });
  el.smtpForm.elements.graphClientSecret.value = "";
  el.smtpStatus.textContent = "Configuração de e-mail salva.";
  toast("E-mail salvo.");
}

async function loadOmieConfig() {
  const data = await api("/api/config/omie");
  const omie = data.omie;
  el.omieForm.elements.appKey.value = omie.appKey || "";
  el.omieForm.elements.appSecret.value = "";
  el.omieForm.elements.dueDay.value = omie.dueDay || "5";
  el.omieForm.elements.contaCorrenteId.value = omie.contaCorrenteId || "";
  el.omieForm.elements.banco.value = omie.banco || "341";
  el.omieForm.elements.agencia.value = omie.agencia || "1268";
  el.omieForm.elements.conta.value = omie.conta || "33981-7";
  el.omieForm.elements.holidays.value = omie.holidays || "";
  el.omieStatus.textContent = omie.appSecretConfigured ? "Secret Omie configurado." : "Secret Omie ainda nao configurado.";
}

async function saveOmieConfig() {
  const data = formData(el.omieForm);
  await api("/api/config/omie", {
    method: "POST",
    body: JSON.stringify(data),
  });
  el.omieForm.elements.appSecret.value = "";
  el.omieStatus.textContent = "Configuração Omie salva.";
  toast("Omie salva.");
}

function applyDateLimits() {
  el.adiantamentoForm.elements.data_adiantamento.min = `${temporaryMinAdiantamentoCompetencia()}-01`;
  el.adiantamentoForm.elements.competencia_inicial.min = temporaryMinAdiantamentoCompetencia();
  syncAdiantamentoCompetenciaFromDate();
  el.rescisaoForm.elements.data_rescisao.min = `${temporaryMinCompetencia()}-01`;
  el.rescisaoForm.elements.data_aviso.min = `${temporaryMinCompetencia()}-01`;
}

function renderFolhas() {
  renderRows(el.folhasTable, [
    { label: "Competencia", key: "competencia" },
    { label: "Status", render: (f) => `<span class="status-pill ${f.status}">${f.status === "aberta" ? "Aberto" : "Fechado"}</span>` },
    { label: "Prestadores", key: "prestadores" },
    { label: "Valor total a pagar", render: (f) => sensitiveMoney(f.liquido_total, { folhaStatus: f.status }) },
    { label: "Descontos", render: (f) => sensitiveMoney(f.descontos_total, { folhaStatus: f.status }) },
    { label: "", render: (f) => `<button class="icon-button" data-open-folha="${f.competencia}" title="Abrir folha">...</button>` },
  ], state.folhas);

  el.folhasTable.querySelectorAll("[data-open-folha]").forEach((button) => {
    button.addEventListener("click", () => openFolha(button.dataset.openFolha));
  });
}

function renderComparativo() {
  const latest = state.comparativo[0]?.competencia;
  const rows = state.comparativo.filter((row) => row.competencia === latest);
  el.deptCards.innerHTML = rows.map((row) => {
    const sign = row.variacao > 0 ? "+" : "";
    return `
      <button class="dept-card" data-dept="${row.departamento}">
        <span>${row.departamento}</span>
        <strong>${row.pessoas}</strong>
        <small class="${row.variacao < 0 ? "danger" : ""}">${sign}${row.variacao} vs mes anterior</small>
      </button>
    `;
  }).join("") || "<p>Nenhum comparativo disponivel.</p>";

  el.deptCards.querySelectorAll("[data-dept]").forEach((button) => {
    button.addEventListener("click", () => renderDepartamentoDrill(button.dataset.dept));
  });

  if (rows[0]) renderDepartamentoDrill(rows[0].departamento);
}

function renderDepartamentoDrill(departamento) {
  const rows = state.comparativo.filter((row) => row.departamento === departamento);
  el.deptDrill.innerHTML = `
    <h3>${departamento}</h3>
    <div class="table-wrap compact-table">
      <table>
        <thead><tr><th>Mes</th><th>Pessoas</th><th>Variacao</th><th>Total</th></tr></thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td>${row.competencia}</td>
              <td>${row.pessoas}</td>
              <td class="${row.variacao < 0 ? "danger" : ""}">${row.variacao > 0 ? "+" : ""}${row.variacao}</td>
      <td>${sensitiveMoney(row.total, { folhaStatus: row.status })}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderPreview() {
  const locked = state.folhaAtual?.status === "em_aprovacao"
    || (state.folhaAtual?.status === "fechada" && !state.folhaAtual?.temporaryOpen);
  const readOnly = locked || !canManage();
  const folhaContext = { folhaStatus: state.folhaAtual?.status };
  const rows = filteredFolhaPreview();
  renderRows(el.folhaPreview, [
    { label: "Prestador", render: (p) => `
      <div class="row-title-actions">
        <button type="button" class="link-button row-main-action" data-compose-folha="${p.prestador_id || p.id}"><strong>${p.razao_social}</strong><small>${p.nome}</small></button>
      </div>
    ` },
    { label: "Categoria", render: (p) => p.categoria || "-" },
    { label: "Dias", render: (p) => isDailyPriced(p) ? payrollEditInput(p, "dias_trabalhados", p.dias_trabalhados || 0, readOnly, "number", "days") : p.dias_trabalhados },
    { label: "Base", render: (p) => isDailyPriced(p) ? `${sensitiveMoney(p.valor_dia, folhaContext)}<br><small>por dia</small>` : sensitiveMoney(p.salario_contrato, folhaContext) },
    { label: "Valor dias", render: (p) => sensitiveMoney(p.valor_dias, folhaContext) },
    { label: "Adicoes", render: (p) => payrollEditInput(p, "adicoes", decimalValue(p.adicoes), readOnly, "number") },
    { label: "Bonus", render: (p) => payrollEditInput(p, "bonus", decimalValue(p.bonus), readOnly, "number") },
    { label: "Desc.", render: (p) => payrollEditInput(p, "descontos_manual", decimalValue(p.descontos_manual), readOnly, "number") },
    { label: "Adiant.", render: (p) => sensitiveMoney(p.desconto_adiantamentos, folhaContext) },
    { label: "Valor total a pagar", render: (p) => `<span class="money">${sensitiveMoney(p.liquido_pagar, folhaContext)}</span>` },
    { label: "R$ NF emitida", render: (p) => {
      const nfLocked = readOnly || p.nf_status === "validada";
      return nfLocked
        ? `<span class="money">${sensitiveMoney(p.valor_nf_emitida, folhaContext)}</span>`
        : payrollEditInput(p, "valor_nf_emitida", decimalValue(p.valor_nf_emitida), false, "number", "money");
    } },
    { label: "Dif. NF", render: (p) => sensitiveMoney(p.diferenca_nf, folhaContext) },
    { label: "N NF", render: (p) => payrollEditInput(p, "numero_nf", p.numero_nf || "", readOnly || p.nf_status === "validada") },
    {
      label: "NF",
      render: (p) => {
        const id = p.prestador_id || p.id;
        const canDeleteNf = p.nf_id && !readOnly && state.folhaAtual?.status !== "fechada" && p.omie_status !== "integrado";
        const nfTooltip = nfStatusTooltip(p);
        return `
          <div class="nf-actions">
          <span class="nf-status-dot ${nfStatusClass(p.nf_status)}" title="${escapeHtml(nfTooltip)}" aria-label="${escapeHtml(nfTooltip)}">
            ${iconSvg(nfStatusIcon(p.nf_status))}
          </span>
          <label class="nf-upload-button doc-icon-button" title="Anexar NF">
            ${iconSvg("upload")}
            <input class="nf-file-input" ${readOnly ? "disabled" : ""} data-nf-upload="${id}" type="file" accept=".xml,.pdf">
          </label>
          ${p.nf_id ? `<button type="button" class="doc-icon-button" data-view-nf="${p.nf_id}" data-name="${escapeHtml(p.nf_original_name || p.numero_nf || "NF")}" title="Visualizar NF">${iconSvg("eye")}</button>` : ""}
          ${p.nf_id ? `<a class="doc-icon-button" href="/api/nfs/${p.nf_id}/download" target="_blank" title="Baixar NF">${iconSvg("download")}</a>` : ""}
          ${canDeleteNf ? `<button type="button" class="icon-button danger-button" data-delete-nf="${p.nf_id}" data-id="${id}" title="Excluir NF">&times;</button>` : ""}
          </div>
        `;
      },
    },
    { label: "Omie", render: (p) => renderOmieStatus(p.omie_status) },
  ], rows);

  el.folhaPreview.querySelectorAll("input").forEach((input) => {
    if (input.type === "file") return;
    input.addEventListener("change", () => {
      const item = state.folhaPreview.find((row) => Number(row.prestador_id || row.id) === Number(input.dataset.id));
      item[input.dataset.field] = input.type === "number" ? Number(input.value || 0) : input.value;
      if (input.type === "number") input.value = decimalValue(input.value);
      calculatePreview();
      scheduleFolhaDraftSave();
    });
  });
  el.folhaPreview.querySelectorAll("[data-nf-upload]").forEach((input) => {
    input.addEventListener("change", () => uploadNf(input).catch((error) => toast(error.message)));
  });
  el.folhaPreview.querySelectorAll("[data-delete-nf]").forEach((button) => {
    button.addEventListener("click", () => deleteNf(button.dataset.deleteNf, button.dataset.id).catch((error) => toast(error.message)));
  });
  el.folhaPreview.querySelectorAll("[data-view-nf]").forEach((button) => {
    button.addEventListener("click", () => openNfViewer(button.dataset.viewNf, button.dataset.name));
  });
  el.folhaPreview.querySelectorAll("[data-compose-folha]").forEach((button) => {
    button.addEventListener("click", () => showFolhaComposition(button.dataset.composeFolha));
  });
  renderTotals();
  renderFolhaLotes();
}

function payrollEditInput(item, field, value, disabled = false, type = "text", variant = "") {
  if (disabled) {
    const display = type === "number"
      ? variant === "days"
        ? String(Number(value || 0))
        : Number(value || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : value || "-";
    return `<span class="payroll-readonly ${variant || ""}">${escapeHtml(display)}</span>`;
  }
  const id = item.prestador_id || item.id;
  const numberAttrs = type === "number" ? `type="number" inputmode="${variant === "days" ? "numeric" : "decimal"}" step="${variant === "days" ? "1" : "0.01"}" min="0"` : `type="text"`;
  const className = type === "number"
    ? `payroll-edit-input ${variant === "days" ? "days-input" : "money-input"} ${variant}`.trim()
    : "payroll-edit-input nf-input";
  const title = disabled ? "Campo bloqueado" : "Campo editável";
  const input = `<input class="${className}" ${disabled ? "disabled" : ""} data-field="${field}" data-id="${id}" ${numberAttrs} value="${escapeHtml(value)}" title="${title}">`;
  return variant === "money" ? `<span class="currency-edit"><span>R$</span>${input}</span>` : input;
}

function iconSvg(name) {
  const icons = {
    upload: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V5M7 10l5-5 5 5M5 19h14"/></svg>`,
    download: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v11M7 11l5 5 5-5M5 19h14"/></svg>`,
    eye: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><path d="M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/></svg>`,
    check: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`,
    warn: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 22 20H2L12 3z"/><path d="M12 9v5M12 17h.01"/></svg>`,
    error: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
    clock: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v6l4 2"/><path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/></svg>`,
    ledger: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16M4 12h16M4 19h16"/><path d="M8 3v18M16 3v18"/></svg>`,
    report: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h5M9 13h6M9 17h6M9 9h2"/></svg>`,
  };
  return icons[name] || icons.clock;
}

function accountMoney(value, canView = true) {
  return canView && value !== null && value !== undefined ? money(value) : "Restrito";
}

async function openPrestadorAccount(prestadorId) {
  const data = await api(`/api/prestadores/${prestadorId}/conta-corrente`);
  const prestador = data.prestador || {};
  const resumo = data.resumo || {};
  const movimentos = data.movimentos || [];
  openCompositionModal("Conta corrente do prestador", `
    <article class="account-report">
      <header class="account-head">
        <div>
          <small>Conta corrente PJ</small>
          <h3>${escapeHtml(prestador.razao_social || prestador.nome || "")}</h3>
          <span>${escapeHtml([prestador.nome, prestador.cnpj].filter(Boolean).join(" | "))}</span>
        </div>
        <div>
          <small>Lotação</small>
          <strong>${escapeHtml([prestador.projeto, prestador.departamento, prestador.unidade_nome].filter(Boolean).join(" | ") || "-")}</strong>
        </div>
      </header>
      <section class="account-summary">
        <article><span>Créditos</span><strong>${accountMoney(resumo.creditos, !resumo.restrito)}</strong></article>
        <article><span>Débitos</span><strong>${accountMoney(resumo.debitos, !resumo.restrito)}</strong></article>
        <article><span>Saldo</span><strong>${accountMoney(resumo.saldo, !resumo.restrito)}</strong></article>
        <article><span>Adiant. aberto</span><strong>${accountMoney(resumo.adiantamentos_abertos, !resumo.restrito)}</strong></article>
      </section>
      <div class="account-table-wrap">
        <table class="account-table">
          <thead>
            <tr><th>Data</th><th>Competência</th><th>Tipo</th><th>Movimento</th><th>Documento</th><th>Crédito</th><th>Débito</th><th>Status</th></tr>
          </thead>
          <tbody>
            ${movimentos.length ? movimentos.map((item) => `
              <tr>
                <td>${escapeHtml(formatDate(item.data))}</td>
                <td>${escapeHtml(item.competencia || "")}</td>
                <td>${escapeHtml(item.tipo || "")}</td>
                <td><strong>${escapeHtml(item.descricao || "")}</strong>${item.detalhe ? `<small>${escapeHtml(item.detalhe)}</small>` : ""}</td>
                <td>${escapeHtml(item.documento || "")}</td>
                <td class="num credit">${accountMoney(item.credito, item.can_view_values)}</td>
                <td class="num debit">${accountMoney(item.debito, item.can_view_values)}</td>
                <td>${escapeHtml(item.status || "")}</td>
              </tr>
            `).join("") : `<tr><td colspan="8">Sem movimentação registrada.</td></tr>`}
          </tbody>
        </table>
      </div>
    </article>
  `);
}

function nfStatusLabel(status) {
  const labels = {
    validada: "NF validada",
    divergente: "NF divergente",
    erro: "Erro na NF",
    pendente: "NF pendente",
  };
  return labels[status || "pendente"] || status || "NF pendente";
}

function nfStatusTooltip(item) {
  const label = nfStatusLabel(item.nf_status);
  const details = String(item.nf_divergencias || item.nf_erro || item.nf_error || "")
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  return details.length ? `${label}\n${details.join("\n")}` : label;
}

function nfStatusClass(status) {
  if (status === "validada") return "ok";
  if (status === "divergente") return "warn";
  if (status === "erro") return "error";
  return "pending";
}

function nfStatusIcon(status) {
  if (status === "validada") return "check";
  if (status === "divergente") return "warn";
  if (status === "erro") return "error";
  return "clock";
}

function renderOmieStatus(status) {
  const value = status || "pendente";
  const config = value === "integrado"
    ? { className: "ok", icon: "check", label: "OK" }
    : value === "erro"
      ? { className: "error", icon: "error", label: "Erro" }
      : { className: "pending", icon: "clock", label: "Pendente" };
  return `<span class="omie-status-dot ${config.className}" title="Omie: ${config.label}">${iconSvg(config.icon)}<small>${config.label}</small></span>`;
}

function openNfViewer(nfId, name = "NF") {
  openCompositionModal(`Visualizar NF - ${name}`, `
    <div class="nf-viewer">
      <iframe src="/api/nfs/${encodeURIComponent(nfId)}/view" title="Visualização da NF"></iframe>
    </div>
  `);
}

function filteredFolhaPreview() {
  const search = normalizeText(state.folhaFilters.search);
  return state.folhaPreview.filter((item) => {
    if (search) {
      const haystack = normalizeText([
        item.razao_social,
        item.nome,
        item.cnpj,
        item.cpf,
        item.categoria,
        item.unidade_nome,
        item.departamento,
        item.numero_nf,
        item.nf_numero,
      ].join(" "));
      if (!haystack.includes(search)) return false;
    }
    if (state.folhaFilters.categoria && normalizeText(item.categoria || "") !== state.folhaFilters.categoria) return false;
    if (state.folhaFilters.nf) {
      const nfStatus = item.nf_status || "pendente";
      if (nfStatus !== state.folhaFilters.nf) return false;
    }
    if (state.folhaFilters.omie) {
      const omieStatus = item.omie_status || "pendente";
      if (omieStatus !== state.folhaFilters.omie) return false;
    }
    if (state.folhaFilters.diff === "com_diferenca" && Math.abs(Number(item.diferenca_nf || 0)) <= 0.01) return false;
    if (state.folhaFilters.diff === "sem_diferenca" && Math.abs(Number(item.diferenca_nf || 0)) > 0.01) return false;
    return true;
  }).sort((a, b) => String(a.nome || a.razao_social || "").localeCompare(String(b.nome || b.razao_social || ""), "pt-BR", { sensitivity: "base" }));
}

function calculatePreview() {
  const competencia = el.folhaForm.elements.competencia.value;
  const diasMes = daysInCompetencia(competencia);
  el.diasMesAuto.textContent = diasMes;
  const isSnapshotLocked = ["em_aprovacao", "fechada"].includes(state.folhaAtual?.status) && !state.folhaAtual?.temporaryOpen;
  if (isSnapshotLocked) {
    renderPreview();
    return;
  }
  state.folhaPreview = state.folhaPreview.map((p) => {
    const dias = isDailyPriced(p) ? Number(p.dias_trabalhados || 0) : workedDaysForItem(p, competencia);
    if (!canSeeSensitiveValues({ folhaStatus: state.folhaAtual?.status })) {
      return { ...p, dias_trabalhados: dias };
    }
    const salario = Number(p.salario_contrato || p.salario_base || 0);
    const valorDias = folhaValorDias(p, dias);
    const previsto = Number((valorDias + Number(p.adicoes || 0) + Number(p.bonus || 0)).toFixed(2));
    const liquido = Number((previsto - Number(p.descontos_manual || 0) - Number(p.desconto_adiantamentos || 0)).toFixed(2));
    const nfEmitida = Number(p.valor_nf_emitida || 0);
    return {
      ...p,
      salario_contrato: salario,
      dias_trabalhados: dias,
      valor_dias: valorDias,
      valor_nf_previsto: previsto,
      liquido_pagar: liquido,
      diferenca_nf: Number((nfEmitida - liquido).toFixed(2)),
    };
  });
  renderPreview();
}

function renderTotals() {
  if (!canSeeSensitiveValues({ folhaStatus: state.folhaAtual?.status })) {
    el.folhaTotals.innerHTML = `<article><span>Valores</span><strong>Restrito</strong></article>`;
    return;
  }
  const rows = filteredFolhaPreview();
  const totals = rows.reduce((acc, item) => {
    acc.valorDias += Number(item.valor_dias || 0);
    acc.adicoes += Number(item.adicoes || 0);
    acc.bonus += Number(item.bonus || 0);
    acc.descontos += Number(item.descontos_manual || 0);
    acc.adiantamentos += Number(item.desconto_adiantamentos || 0);
    acc.totalPagar += Number(item.liquido_pagar || 0);
    acc.diferenca += Number(item.diferenca_nf || 0);
    return acc;
  }, { valorDias: 0, adicoes: 0, bonus: 0, descontos: 0, adiantamentos: 0, totalPagar: 0, diferenca: 0 });

  el.folhaTotals.innerHTML = `
    <article><span>Itens filtrados</span><strong>${rows.length}/${state.folhaPreview.length}</strong></article>
    <article><span>Valor dias</span><strong>${money(totals.valorDias)}</strong></article>
    <article><span>Adições</span><strong>${money(totals.adicoes)}</strong></article>
    <article><span>Bônus</span><strong>${money(totals.bonus)}</strong></article>
    <article><span>Descontos</span><strong>${money(totals.descontos)}</strong></article>
    <article><span>Adiantamentos</span><strong>${money(totals.adiantamentos)}</strong></article>
    <article><span>Total a pagar</span><strong>${money(totals.totalPagar)}</strong></article>
    <article><span>Dif. NF</span><strong>${money(totals.diferenca)}</strong></article>
  `;
}

function renderFolhaLotes() {
  if (!el.folhaLotes) return;
  const lotes = state.folhaLotes || [];
  if (!lotes.length) {
    el.folhaLotes.innerHTML = "";
    return;
  }
  el.folhaLotes.innerHTML = lotes.map((lote) => {
    const statusLabel = {
      em_aprovacao: "Em aprovação",
      reprovado: "Reprovado",
      fechado: "Fechado",
      integrado_omie: "Integrado Omie",
    }[lote.status] || lote.status;
    return `
      <article class="lote-chip">
        <span>${escapeHtml(lote.label || `Lote ${lote.numero}`)}</span>
        <strong>${money(lote.total)}</strong>
        <small>${escapeHtml(statusLabel)} | ${Number(lote.itens || 0)} item(ns)</small>
      </article>
    `;
  }).join("");
}

async function loadFolha(competencia = el.folhaForm.elements.competencia.value) {
  const data = await api(`/api/folhas/${competencia}`);
  state.folhaAtual = data.folha;
  state.folhaAtual.aprovacoes = data.aprovacoes;
  state.folhaPreview = data.itens;
  state.folhaLotes = data.lotes || [];
  state.folhaDraftDirty = false;
  renderFolhaCategoriaFilter();
  const folhaFechada = data.folha.status === "fechada" && !data.folha.temporaryOpen;
  const folhaIntegradaOmie = folhaFechada
    && state.folhaPreview.length > 0
    && state.folhaPreview.every((item) => item.omie_status === "integrado");
  const loteFechadoPendenteOmie = state.folhaLotes.some((lote) => lote.status === "fechado");
  const usuarioOperacional = state.authUser?.perfil === "operacional";
  el.competenciaAtual.textContent = data.folha.competencia;
  el.diasMesAuto.textContent = data.folha.dias_mes;
  el.folhaStatus.textContent = ({ aberta: "Aberto", em_aprovacao: "Em aprovação", reprovada: "Reprovada", fechada: "Fechado" })[data.folha.status] || data.folha.status;
  el.folhaHint.textContent = "";
  document.querySelector('button[form="folhaForm"]').hidden = data.folha.status !== "aberta" && !(data.folha.status === "reprovada") && !data.folha.temporaryOpen;
  document.querySelector('button[form="folhaForm"]').textContent = "Fechar folha";
  document.querySelector('button[form="folhaForm"]').disabled = !canCloseFolha() || !data.aprovacoes?.approved;
  el.reabrirFolha.hidden = !(data.folha.status === "fechada" && !data.folha.temporaryOpen && hasPermission("reopen_folhas"));
  el.aprovarFolha.hidden = usuarioOperacional || folhaIntegradaOmie || data.folha.status !== "em_aprovacao";
  el.reprovarFolha.hidden = el.aprovarFolha.hidden;
  el.solicitarNfs.hidden = folhaIntegradaOmie || data.folha.status === "em_aprovacao";
  el.enviarAprovacaoFolha.hidden = folhaIntegradaOmie || data.folha.status === "em_aprovacao";
  el.integrarOmie.hidden = folhaIntegradaOmie || (!folhaFechada && !loteFechadoPendenteOmie);
  el.aprovarFolha.disabled = !canApproveFolha() || data.folha.status !== "em_aprovacao";
  el.reprovarFolha.disabled = el.aprovarFolha.disabled;
  el.solicitarNfs.disabled = ["fechada", "em_aprovacao"].includes(data.folha.status) || !hasPermission("view_folhas");
  el.enviarAprovacaoFolha.disabled = ["fechada", "em_aprovacao"].includes(data.folha.status) || !canManage() || !folhaReadyForApproval();
  el.folhaReport.disabled = !canGenerateReport();
  el.integrarOmie.disabled = !canIntegrateOmie() || (!folhaFechada && !loteFechadoPendenteOmie);
  renderApprovalStatus(data.aprovacoes);
  calculatePreview();
}

function renderApprovalStatus(aprovacoes = {}) {
  const count = aprovacoes.count || 0;
  const required = aprovacoes.required || 0;
  const names = (aprovacoes.aprovadores || []).map((item) => `${item.nome}${item.codigo_autenticacao ? ` (${item.codigo_autenticacao})` : ""}`);
  const missing = (aprovacoes.pendentes || []).map((item) => item.nome);
  const next = aprovacoes.proximo?.nome;
  el.approvalStatus.innerHTML = aprovacoes.approved
    ? `<span class="approval-pill ok">Aprovada ${count}/${required}</span>${names.length ? `<details><summary>Ver aprovações</summary><span>${names.join(", ")}</span></details>` : ""}`
    : `<span class="approval-pill">Aprovações ${count}/${required}</span>${next ? `<details><summary>Agora: ${escapeHtml(next)}</summary><span>${missing.join(", ")}</span></details>` : missing.length ? `<details><summary>${missing.length} pendente(s)</summary><span>${missing.join(", ")}</span></details>` : ""}`;
}

function renderFolhaCategoriaFilter() {
  if (!el.folhaCategoriaFilter) return;
  const current = state.folhaFilters.categoria || "";
  const categorias = [...new Set(state.folhaPreview.map((item) => item.categoria).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b), "pt-BR", { sensitivity: "base" }));
  el.folhaCategoriaFilter.innerHTML = `
    <option value="">Todas</option>
    ${categorias.map((categoria) => `<option value="${escapeHtml(normalizeText(categoria))}">${escapeHtml(categoria)}</option>`).join("")}
  `;
  el.folhaCategoriaFilter.value = categorias.some((categoria) => normalizeText(categoria) === current) ? current : "";
  state.folhaFilters.categoria = el.folhaCategoriaFilter.value;
}

function folhaReadyForApproval() {
  return state.folhaPreview.length > 0 && state.folhaPreview.some((item) => nfValidatedOrSimoneException(item) && Math.abs(Number(item.diferenca_nf || 0)) <= 0.01 && Number(item.liquido_pagar || 0) > 0);
}

function openFolhaReport() {
  const competencia = el.folhaForm.elements.competencia.value;
  if (!competencia || !state.folhaAtual) {
    toast("Abra uma folha antes de gerar o relatorio.");
    return;
  }
  const reportKey = `folha-report-${competencia}-${Date.now()}`;
  sessionStorage.setItem(reportKey, JSON.stringify({
    folha: state.folhaAtual,
    itens: state.folhaPreview,
    aprovacoes: state.folhaAtual?.aprovacoes || null,
    lotes: state.folhaLotes || [],
    geradoEm: new Date().toISOString(),
  }));
  window.open(`/folha-relatorio.html?competencia=${encodeURIComponent(competencia)}&key=${encodeURIComponent(reportKey)}`, "_blank");
}

async function integrarOmie() {
  const competencia = el.folhaForm.elements.competencia.value;
  if (!competencia || !state.folhaAtual) {
    toast("Abra uma folha fechada antes de integrar.");
    return;
  }
  const loteFechadoPendenteOmie = state.folhaLotes.some((lote) => lote.status === "fechado");
  if (state.folhaAtual.status !== "fechada" && !loteFechadoPendenteOmie) {
    toast("A Omie recebe somente folhas ou lotes fechados.");
    return;
  }
  el.integrarOmie.disabled = true;
  el.integrarOmie.textContent = "Integrando...";
  showBusy("Integrando folha", `Enviando lançamentos da competência ${competencia} para a Omie.`);
  try {
    const result = await api(`/api/folhas/${competencia}/integrar-omie`, { method: "POST", body: "{}" });
    const falhas = result.erros?.length || 0;
    toast(falhas ? `Omie integrada com ${falhas} erro(s).` : `Omie integrada: ${result.integrados.length} lancamento(s).`);
    await loadFolha(competencia);
  } catch (error) {
    if (await confirmOmiePrestadorCadastro(error)) {
      const result = await api(`/api/folhas/${competencia}/integrar-omie`, {
        method: "POST",
        body: JSON.stringify({ cadastrar_prestadores_omie: true }),
      });
      const falhas = result.erros?.length || 0;
      toast(falhas ? `Omie integrada com ${falhas} erro(s).` : `Omie integrada: ${result.integrados.length} lancamento(s).`);
      await loadFolha(competencia);
      return;
    }
    toast(error.message);
    await loadFolha(competencia);
  } finally {
    hideBusy();
    el.integrarOmie.disabled = false;
    el.integrarOmie.textContent = "Integrar Omie";
  }
}

async function confirmOmiePrestadorCadastro(error) {
  if (error.code !== "OMIE_PRESTADOR_PENDENTE") return false;
  const prestadores = error.prestadores || [];
  const lista = prestadores
    .map((prestador) => `- ${prestador.razao_social || prestador.nome || "Prestador"}${prestador.cnpj ? ` (${prestador.cnpj})` : ""}`)
    .join("\n");
  return window.confirm(`${error.message}\n\n${lista}\n\nDeseja cadastrar este prestador como fornecedor PJ no Omie e continuar?`);
}

async function aprovarFolha() {
  const competencia = el.folhaForm.elements.competencia.value;
  if (!competencia || !state.folhaAtual) {
    toast("Abra uma folha antes de aprovar.");
    return;
  }
  showBusy("Aprovando folha", "Registrando aprovação e atualizando o fluxo.");
  try {
    const result = await api(`/api/folhas/${competencia}/aprovar`, {
      method: "POST",
      body: JSON.stringify({ itens: state.folhaPreview }),
    });
    renderApprovalStatus(result.aprovacoes);
    await loadFolha(competencia);
    toast(result.fechamentoAutomatico ? "Aprovação concluída. Folha fechada automaticamente." : `Aprovacao registrada: ${result.aprovacoes.count}/${result.aprovacoes.required}.`);
  } finally {
    hideBusy();
  }
}

async function reprovarFolha() {
  const competencia = el.folhaForm.elements.competencia.value;
  if (!competencia || !state.folhaAtual) {
    toast("Abra uma folha antes de reprovar.");
    return;
  }
  const motivo = window.prompt("Informe a justificativa da recusa:");
  if (!motivo || !motivo.trim()) return;
  showBusy("Reprovando folha", "Registrando justificativa e atualizando o fluxo.");
  try {
    await api(`/api/folhas/${competencia}/reprovar`, {
      method: "POST",
      body: JSON.stringify({ itens: state.folhaPreview, motivo }),
    });
    await loadFolha(competencia);
    toast("Folha reprovada e liberada para ajuste.");
  } finally {
    hideBusy();
  }
}

async function enviarFolhaAprovacao() {
  const competencia = el.folhaForm.elements.competencia.value;
  if (!competencia || !state.folhaAtual) {
    toast("Abra uma folha antes de enviar para aprovação.");
    return;
  }
  const aptos = state.folhaPreview.filter((item) => nfValidatedOrSimoneException(item) && Math.abs(Number(item.diferenca_nf || 0)) <= 0.01 && Number(item.liquido_pagar || 0) > 0).length;
  const fora = state.folhaPreview.length - aptos;
  if (!window.confirm(`Enviar a competência ${competencia} para aprovação?\n\nSerá criado um lote com ${aptos} prestador(es) apto(s). ${fora} ficarão fora deste lote por pendências ou divergências.`)) return;
  el.enviarAprovacaoFolha.disabled = true;
  el.enviarAprovacaoFolha.textContent = "Enviando...";
  showBusy("Enviando aprovação", "Enviando a folha para o fluxo de aprovação.");
  try {
    await saveFolhaDraftNow();
    const result = await api(`/api/folhas/${competencia}/enviar-aprovacao`, {
      method: "POST",
      body: JSON.stringify({ itens: state.folhaPreview }),
    });
    const enviados = result.enviados?.length || 0;
    const falhas = result.falhas?.length || 0;
    toast(`Enviado para aprovação: ${enviados} e-mail(s), ${falhas} falha(s).`);
  } finally {
    hideBusy();
    el.enviarAprovacaoFolha.textContent = "Enviar aprovação";
    el.enviarAprovacaoFolha.disabled = !folhaReadyForApproval();
  }
}

async function reabrirFolha() {
  const competencia = el.folhaForm.elements.competencia.value;
  if (!competencia) {
    toast("Abra uma folha antes de reabrir.");
    return;
  }
  showBusy("Reabrindo folha", "Liberando a folha para ajustes e recarregando os dados.");
  try {
    await api(`/api/folhas/${competencia}/reabrir`, { method: "POST", body: "{}" });
    toast("Folha reaberta.");
    await loadAll();
    await loadFolha(competencia);
  } finally {
    hideBusy();
  }
}

async function solicitarNfs() {
  const competencia = el.folhaForm.elements.competencia.value;
  if (!competencia || !state.folhaAtual) {
    toast("Abra uma folha antes de solicitar NFs.");
    return;
  }
  const pendentes = state.folhaPreview.filter((item) => !nfValidatedOrSimoneException(item)).length;
  if (!window.confirm(`Solicitar NFs da competência ${competencia}?\n\nO sistema enviará e-mail somente para os ${pendentes} prestador(es) com NF pendente ou divergente.`)) return;
  el.solicitarNfs.disabled = true;
  el.solicitarNfs.textContent = "Enviando...";
  showBusy("Solicitando NFs", "Enviando os avisos aos prestadores.");
  try {
    await saveFolhaDraftNow();
    const result = await api(`/api/folhas/${competencia}/notificar-nfs`, { method: "POST", body: "{}" });
    const enviados = result.enviados?.length || 0;
    const falhas = result.falhas?.length || 0;
    const semEmail = result.semEmail?.length || 0;
    toast(`Solicitação enviada: ${enviados} e-mail(s), ${falhas} falha(s), ${semEmail} sem e-mail.`);
  } finally {
    hideBusy();
    el.solicitarNfs.disabled = false;
    el.solicitarNfs.textContent = "Solicitar NFs";
  }
}

async function uploadNf(input) {
  const prestadorId = Number(input.dataset.nfUpload);
  const item = state.folhaPreview.find((row) => Number(row.prestador_id || row.id) === prestadorId);
  if (!item || !input.files?.[0]) return;
  const competencia = el.folhaForm.elements.competencia.value;
  const form = new FormData();
  form.append("nf", input.files[0]);
  form.append("valor_esperado", item.liquido_pagar || 0);
  showBusy("Enviando NF", "Anexando e validando a nota fiscal.");
  try {
    const response = await fetch(`/api/folhas/${competencia}/prestadores/${prestadorId}/nf`, {
      method: "POST",
      credentials: "same-origin",
      body: form,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Nao foi possivel enviar a NF.");
    item.nf_id = data.nf.id;
    item.nf_status = data.nf.status;
    item.nf_original_name = data.nf.original_name;
    item.nf_divergencias = (data.nf.divergencias || []).join(" | ");
    if (data.nf.numero_nf) item.numero_nf = data.nf.numero_nf;
    if (data.nf.valor_nf) item.valor_nf_emitida = Number(data.nf.valor_nf);
    calculatePreview();
    scheduleFolhaDraftSave();
    el.enviarAprovacaoFolha.disabled = state.folhaAtual?.status === "fechada" || !canManage() || !folhaReadyForApproval();
    toast(data.nf.status === "validada" ? "NF validada e preenchida." : `NF enviada: ${data.nf.status}.`);
  } finally {
    hideBusy();
  }
}

async function deleteNf(nfId, prestadorId) {
  const item = state.folhaPreview.find((row) => Number(row.prestador_id || row.id) === Number(prestadorId));
  const nome = item?.razao_social || item?.nome || "esta NF";
  if (!window.confirm(`Excluir a NF de ${nome}?`)) return;
  showBusy("Excluindo NF", "Removendo o anexo e atualizando a folha.");
  try {
    await api(`/api/nfs/${nfId}`, { method: "DELETE" });
    if (item) {
      item.nf_id = null;
      item.nf_status = "pendente";
      item.nf_original_name = "";
      item.nf_divergencias = "";
      item.nf_numero = "";
      item.nf_valor = 0;
      item.numero_nf = "";
      item.valor_nf_emitida = 0;
    }
    calculatePreview();
    scheduleFolhaDraftSave();
    toast("NF excluida.");
  } finally {
    hideBusy();
  }
}

async function uploadRescisaoNf(input) {
  const id = input.dataset.rescisaoNf;
  if (!id || !input.files?.[0]) return;
  const form = new FormData();
  form.append("nf", input.files[0]);
  showBusy("Enviando NF", "Anexando e validando a nota fiscal da rescisão.");
  try {
    const response = await fetch(`/api/rescisoes/${id}/nf`, {
      method: "POST",
      credentials: "same-origin",
      body: form,
    });
    const data = await response.json().catch(() => ({}));
    input.value = "";
    if (!response.ok) throw new Error(data.error || "Nao foi possivel enviar a NF da rescisao.");
    toast(data.nf.status === "validada" ? "NF da rescisao validada." : `NF enviada: ${data.nf.status}.`);
    await loadAll();
  } finally {
    hideBusy();
  }
}

async function aprovarRescisao(id) {
  showBusy("Aprovando rescisão", "Registrando aprovação e atualizando a lista.");
  try {
    const result = await api(`/api/rescisoes/${id}/aprovar`, { method: "POST", body: "{}" });
    toast(result.finalizada ? "Aprovação concluída. Rescisão finalizada automaticamente." : `Aprovacao da rescisao registrada: ${result.aprovacoes.count}/${result.aprovacoes.required}.`);
    await loadAll();
  } finally {
    hideBusy();
  }
}

async function reprovarRescisao(id) {
  const motivo = window.prompt("Informe a justificativa da recusa:");
  if (!motivo || !motivo.trim()) return;
  showBusy("Reprovando rescisão", "Registrando justificativa e atualizando a lista.");
  try {
    await api(`/api/rescisoes/${id}/reprovar`, {
      method: "POST",
      body: JSON.stringify({ motivo }),
    });
    toast("Rescisão reprovada e liberada para ajuste.");
    await loadAll();
  } finally {
    hideBusy();
  }
}

async function finalizarRescisao(id) {
  showBusy("Finalizando rescisão", "Baixando o prestador e atualizando os registros.");
  try {
    await api(`/api/rescisoes/${id}/finalizar`, { method: "POST", body: "{}" });
    toast("Rescisao finalizada.");
    await loadAll();
  } finally {
    hideBusy();
  }
}

async function integrarRescisaoOmie(id) {
  showBusy("Integrando rescisão", "Criando o lançamento, enviando anexos e atualizando o status Omie.");
  try {
    await api(`/api/rescisoes/${id}/integrar-omie`, { method: "POST", body: "{}" });
    toast("Rescisao integrada na Omie.");
    await loadAll();
  } catch (error) {
    if (await confirmOmiePrestadorCadastro(error)) {
      await api(`/api/rescisoes/${id}/integrar-omie`, {
        method: "POST",
        body: JSON.stringify({ cadastrar_prestadores_omie: true }),
      });
      toast("Rescisao integrada na Omie.");
      await loadAll();
      return;
    }
    toast(error.message);
    await loadAll();
  } finally {
    hideBusy();
  }
}

function openRescisaoReport(id) {
  const rescisao = state.rescisoes.find((row) => Number(row.id) === Number(id));
  if (!rescisao) return;
  const reportKey = `rescisao-report-${id}-${Date.now()}`;
  sessionStorage.setItem(reportKey, JSON.stringify({
    rescisao,
    geradoEm: new Date().toISOString(),
  }));
  window.open(`/rescisao-relatorio.html?id=${encodeURIComponent(id)}&key=${encodeURIComponent(reportKey)}`, "_blank");
}

async function notificarRescisaoNf(id) {
  showBusy("Solicitando NF", "Enviando aviso da NF de rescisão.");
  try {
    const result = await api(`/api/rescisoes/${id}/notificar-nf`, { method: "POST", body: "{}" });
    toast(result.sent ? "E-mail de NF da rescisao enviado." : `Aviso nao enviado: ${result.reason || "verifique Microsoft Graph"}.`);
  } finally {
    hideBusy();
  }
}

async function enviarRescisaoAprovacao(id) {
  showBusy("Enviando aprovação", "Enviando a rescisão para o fluxo de aprovação.");
  try {
    const result = await api(`/api/rescisoes/${id}/enviar-aprovacao`, { method: "POST", body: "{}" });
    const enviados = result.enviados?.length || 0;
    const falhas = result.falhas?.length || 0;
    toast(`Rescisao enviada para aprovação: ${enviados} e-mail(s), ${falhas} falha(s).`);
    await loadAll();
  } finally {
    hideBusy();
  }
}

function editPrestador(id) {
  const prestador = state.prestadores.find((item) => item.id === id);
  Object.entries(prestador).forEach(([key, value]) => {
    const field = el.prestadorForm.elements[key];
    if (!field) return;
    if (field.type === "checkbox") field.checked = Boolean(value);
    else field.value = value || "";
  });
  el.prestadorForm.elements.cliente_id.value = prestador.cliente_id || "";
  renderPrestadorProjetoDepartamentoSelects();
  el.prestadorForm.elements.projeto_id.value = prestador.projeto_id || "";
  renderPrestadorProjetoDepartamentoSelects();
  el.prestadorForm.elements.departamento_id.value = prestador.departamento_id || "";
  if (el.clearPrestador) el.clearPrestador.hidden = true;
  updatePrestadorPricingFields();
  openPrestadorModal("Editar prestador");
}

function updatePrestadorPricingFields() {
  const tipo = el.prestadorForm.elements.precificacao_tipo?.value || "mensal";
  const salarioField = el.prestadorForm.elements.salario_contrato;
  const valorDiaField = el.prestadorForm.elements.valor_dia;
  if (!salarioField || !valorDiaField) return;
  salarioField.required = tipo !== "diaria";
  valorDiaField.required = tipo === "diaria";
  salarioField.closest("label").classList.toggle("muted-field", tipo === "diaria");
  valorDiaField.closest("label").classList.toggle("muted-field", tipo !== "diaria");
}

async function loadAll() {
  const adiantamentoAccess = hasPermission("manage_adiantamentos");
  const rescisaoAccess = canViewRescisoes();
  const operationalAccess = adiantamentoAccess || rescisaoAccess;
  const folhaAccess = canViewFolhas();
  const prestadorAccess = canViewPrestadores();
  const [health, appConfig, resumo, prestadores, cadastros, adiantamentos, rescisoes, folhas, comparativo] = await Promise.all([
    api("/api/health").catch(() => ({ ok: false })),
    api("/api/config/app"),
    folhaAccess ? api("/api/resumo") : Promise.resolve({ prestadoresAtivos: 0, adiantamentosEmAberto: null, ultimaFolha: null }),
    prestadorAccess ? api("/api/prestadores") : Promise.resolve({ prestadores: [] }),
    prestadorAccess || operationalAccess ? api("/api/cadastros") : Promise.resolve({ clientes: [], unidades: [], funcoes: [], categorias: [], departamentos: [], projetos: [] }),
    adiantamentoAccess ? api("/api/adiantamentos") : Promise.resolve({ adiantamentos: [] }),
    rescisaoAccess ? api("/api/rescisoes") : Promise.resolve({ rescisoes: [] }),
    folhaAccess ? api("/api/folhas") : Promise.resolve({ folhas: [] }),
    folhaAccess ? api("/api/departamentos/comparativo") : Promise.resolve({ comparativo: [] }),
  ]);

  el.status.textContent = health.ok ? "Conectado" : "Sem conexao";
  el.statusDot.classList.toggle("online", Boolean(health.ok));
  state.appConfig = appConfig;
  applyDateLimits();
  state.prestadores = prestadores.prestadores;
  state.clientes = cadastros.clientes || [];
  state.unidades = cadastros.unidades;
  state.funcoes = cadastros.funcoes;
  state.categorias = cadastros.categorias;
  state.departamentos = cadastros.departamentos;
  state.projetos = cadastros.projetos;
  state.adiantamentos = adiantamentos.adiantamentos;
  state.rescisoes = rescisoes.rescisoes;
  state.folhas = folhas.folhas;
  state.comparativo = comparativo.comparativo;

  el.metrics.prestadores.textContent = resumo.prestadoresAtivos;
  el.metrics.adiantamentos.textContent = canSeeSensitiveValues() ? money(resumo.adiantamentosEmAberto) : "Restrito";
  el.metrics.folha.textContent = resumo.ultimaFolha
    ? `${resumo.ultimaFolha.competencia} - ${canSeeSensitiveValues({ folhaStatus: resumo.ultimaFolha.status }) ? money(resumo.ultimaFolha.liquido_total) : "Restrito"}`
    : "Sem fechamento";

  renderPrestadores();
  renderSelects();
  if (adiantamentoAccess) {
    renderAdiantamentos();
  }
  if (rescisaoAccess) {
    renderRescisoes();
  }
  if (folhaAccess) {
    renderFolhas();
    renderComparativo();
  }
  applyAuthUi();
  if (document.querySelector("#folha").classList.contains("active") && folhaAccess) await loadFolha();
  if (document.querySelector("#configuracoes").classList.contains("active")) {
    if (hasPermission("manage_cadastros")) await loadCadastrosConfig();
    if (hasPermission("manage_users")) await loadUsuarios();
    if (hasPermission("manage_smtp")) await loadSmtpConfig();
    if (hasPermission("manage_smtp")) await loadEmailTemplates();
    if (hasPermission("manage_omie_config")) await loadOmieConfig();
  }
}

function summarizeNfFolderImport(result) {
  const flat = (result?.results || []).flatMap((competencia) => competencia.results || []);
  const processed = flat.filter((item) => ["validada", "divergente"].includes(item.status)).length;
  const reprocessed = flat.filter((item) => item.action === "reprocessada").length;
  const duplicated = flat.filter((item) => item.status === "duplicada").length;
  const errorItems = flat.filter((item) => item.status === "erro");
  return { processed, reprocessed, duplicated, errors: errorItems.length, errorItems };
}

function totalNfFolderImportFiles(result) {
  return (result?.results || []).reduce((sum, competencia) => sum + (competencia.results || []).length, 0);
}

function canSaveFolhaDraft() {
  return Boolean(
    state.folhaAtual
    && !["fechada", "em_aprovacao"].includes(state.folhaAtual.status)
    && canManage()
    && canSeeSensitiveValues({ folhaStatus: state.folhaAtual.status }),
  );
}

async function saveFolhaDraftNow() {
  if (!state.folhaDraftDirty || !canSaveFolhaDraft()) return null;
  if (state.folhaDraftTimer) {
    clearTimeout(state.folhaDraftTimer);
    state.folhaDraftTimer = null;
  }
  const competencia = el.folhaForm.elements.competencia.value;
  if (!competencia) return null;
  state.folhaDraftDirty = false;
  state.folhaDraftSaving = api(`/api/folhas/${competencia}/rascunho`, {
    method: "POST",
    body: JSON.stringify({ itens: state.folhaPreview }),
    busy: false,
  }).catch((error) => {
    state.folhaDraftDirty = true;
    throw error;
  }).finally(() => {
    state.folhaDraftSaving = null;
  });
  return state.folhaDraftSaving;
}

function scheduleFolhaDraftSave() {
  if (!canSaveFolhaDraft()) return;
  state.folhaDraftDirty = true;
  if (state.folhaDraftTimer) clearTimeout(state.folhaDraftTimer);
  state.folhaDraftTimer = setTimeout(() => {
    saveFolhaDraftNow().catch((error) => toast(error.message));
  }, 700);
}

async function scanNfsBeforeRefresh() {
  if (!canViewFolhas()) return null;
  await saveFolhaDraftNow();
  const folhaActive = document.querySelector("#folha")?.classList.contains("active");
  const competencia = folhaActive ? el.folhaForm.elements.competencia.value : "";
  const body = competencia ? JSON.stringify({ competencia }) : "{}";
  return api("/api/folhas/importar-nfs-email", { method: "POST", body });
}

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    setView(button.dataset.view);
    if (button.dataset.view === "folha") loadFolha().catch((error) => toast(error.message));
  });
});

document.querySelector(".settings-button").addEventListener("click", () => {
  if (!canAccessSettings()) {
    toast("Usuario sem permissao para configuracoes.");
    return;
  }
  setView("configuracoes");
  if (hasPermission("manage_smtp")) loadSmtpConfig().catch((error) => toast(error.message));
  if (hasPermission("manage_smtp")) loadEmailTemplates().catch((error) => toast(error.message));
  if (hasPermission("manage_omie_config")) loadOmieConfig().catch((error) => toast(error.message));
  if (hasPermission("manage_cadastros")) loadCadastrosConfig().catch((error) => toast(error.message));
  if (hasPermission("manage_users")) loadUsuarios().catch((error) => toast(error.message));
});

el.refresh.addEventListener("click", async () => {
  showBusy("Atualizando dados", "Sincronizando informações e verificando novas NFs.");
  try {
    const scan = await scanNfsBeforeRefresh();
    await loadAll();
    if (scan) {
      const summary = summarizeNfFolderImport(scan);
      const parts = [`Dados atualizados`];
      if (summary.processed) parts.push(`${summary.processed} NF(s) lida(s)`);
      if (summary.reprocessed) parts.push(`${summary.reprocessed} NF(s) relida(s)`);
      if (summary.errors) {
        const firstError = summary.errorItems?.[0];
        parts.push(`${summary.errors} erro(s) na leitura${firstError?.file ? `: ${firstError.file}` : ""}`);
      }
      toast(`${parts.join(". ")}.`);
    } else {
      toast("Dados atualizados.");
    }
  } catch (error) {
    toast(error.message);
  } finally {
    hideBusy();
  }
});
el.configBackdrop.addEventListener("click", closeConfigModal);
document.querySelectorAll("[data-close-config-modal]").forEach((button) => {
  button.addEventListener("click", closeConfigModal);
});
el.folhaSearch.addEventListener("input", () => {
  state.folhaFilters.search = el.folhaSearch.value;
  renderPreview();
});
el.folhaCategoriaFilter.addEventListener("change", () => {
  state.folhaFilters.categoria = el.folhaCategoriaFilter.value;
  renderPreview();
});
el.folhaNfFilter.addEventListener("change", () => {
  state.folhaFilters.nf = el.folhaNfFilter.value;
  renderPreview();
});
el.folhaOmieFilter.addEventListener("change", () => {
  state.folhaFilters.omie = el.folhaOmieFilter.value;
  renderPreview();
});
el.folhaDiffFilter.addEventListener("change", () => {
  state.folhaFilters.diff = el.folhaDiffFilter.value;
  renderPreview();
});
el.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  el.loginMessage.textContent = "";
  try {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(formData(el.loginForm)),
    });
    state.authUser = data.usuario;
    hideLogin();
    applyAuthUi();
    setView(defaultViewForUser());
    await loadAll();
  } catch (error) {
    if (error.code === "FIRST_ACCESS_REQUIRED") {
      el.loginFirstAccess.hidden = false;
      el.loginMessage.textContent = error.message;
      el.loginForm.elements.senha_primeiro_acesso.focus();
      return;
    }
    showLogin(error.message);
  }
});
el.loginFirstAccessBtn.addEventListener("click", async () => {
  el.loginMessage.textContent = "";
  const body = formData(el.loginForm);
  body.senha = body.senha_primeiro_acesso;
  try {
    await api("/api/auth/primeiro-acesso", {
      method: "POST",
      body: JSON.stringify(body),
    });
    el.loginFirstAccess.hidden = true;
    const data = await api("/api/auth/me");
    state.authUser = data.usuario;
    hideLogin();
    applyAuthUi();
    setView(defaultViewForUser());
    await loadAll();
  } catch (error) {
    el.loginMessage.textContent = error.message;
  }
});
el.logout.addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => null);
  state.authUser = null;
  showLogin();
});
el.searchPrestador.addEventListener("input", renderPrestadores);
el.prestadorStatusFilter.addEventListener("change", () => {
  state.prestadorStatusFilter = el.prestadorStatusFilter.value;
  renderPrestadores();
});
el.adiantamentoFilters.forEach((button) => {
  button.addEventListener("click", () => {
    state.adiantamentoFilter = button.dataset.adiantamentoFilter;
    renderAdiantamentos();
  });
});
el.adiantamentoForm.elements.data_adiantamento.addEventListener("change", () => {
  syncAdiantamentoCompetenciaFromDate(true);
});
document.querySelectorAll("[data-prestador-search]").forEach((input) => {
  input.addEventListener("input", () => {
    const kind = input.dataset.prestadorSearch;
    const form = kind === "adiantamento" ? el.adiantamentoForm : el.rescisaoForm;
    form.elements.prestador_id.value = "";
    renderPrestadorPicker(kind);
  });
  input.addEventListener("focus", () => renderPrestadorPicker(input.dataset.prestadorSearch));
});
el.newPrestador.addEventListener("click", () => {
  resetPrestadorForm();
  openPrestadorModal("Novo prestador");
});
el.closePrestadorModal.addEventListener("click", closePrestadorModal);
el.prestadorBackdrop.addEventListener("click", closePrestadorModal);
el.newAdiantamento.addEventListener("click", () => {
  resetAdiantamentoForm();
  openAdiantamentoModal();
});
el.closeAdiantamentoModal.addEventListener("click", closeAdiantamentoModal);
el.adiantamentoBackdrop.addEventListener("click", closeAdiantamentoModal);
el.newRescisao.addEventListener("click", () => {
  resetRescisaoForm();
  openRescisaoModal();
});
el.closeRescisaoModal.addEventListener("click", closeRescisaoModal);
el.rescisaoBackdrop.addEventListener("click", closeRescisaoModal);
el.closeCompositionModal.addEventListener("click", closeCompositionModal);
el.compositionBackdrop.addEventListener("click", closeCompositionModal);
el.newUsuario.addEventListener("click", () => openUsuarioModal("new"));
el.closeUsuarioModal.addEventListener("click", closeUsuarioModal);
document.querySelectorAll("[data-user-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    state.usuarioAccessFilter = button.dataset.userFilter || "todos";
    renderUsuarios();
  });
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && el.prestadorForm.classList.contains("active")) closePrestadorModal();
  if (event.key === "Escape" && el.adiantamentoForm.classList.contains("active")) closeAdiantamentoModal();
  if (event.key === "Escape" && el.rescisaoModal.classList.contains("active")) closeRescisaoModal();
  if (event.key === "Escape" && el.compositionModal.classList.contains("active")) closeCompositionModal();
  if (event.key === "Escape" && el.configBackdrop.classList.contains("active")) closeConfigModal();
});
el.clearPrestador.addEventListener("click", resetPrestadorForm);
el.prestadorForm.elements.precificacao_tipo.addEventListener("change", updatePrestadorPricingFields);
el.prestadorForm.elements.cliente_id.addEventListener("change", () => {
  renderPrestadorProjetoDepartamentoSelects();
});
el.prestadorForm.elements.projeto_id.addEventListener("change", () => {
  renderPrestadorProjetoDepartamentoSelects();
});
el.clearUsuario.addEventListener("click", closeUsuarioModal);
el.usuarioForm.elements.perfil.addEventListener("change", applyDefaultUsuarioPermissoes);
el.changePassword?.addEventListener("click", () => {
  el.changePasswordForm.reset();
  if (el.changePasswordDialog.parentElement !== document.body) {
    document.body.appendChild(el.changePasswordDialog);
  }
  if (!el.changePasswordDialog.open) el.changePasswordDialog.showModal();
});
el.closeChangePassword?.addEventListener("click", () => el.changePasswordDialog.close());
el.cancelChangePassword?.addEventListener("click", () => el.changePasswordDialog.close());

el.changePasswordForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  showBusy("Alterando senha", "Salvando a nova senha.");
  try {
    await api("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify(formData(el.changePasswordForm)),
    });
    el.changePasswordForm.reset();
    el.changePasswordDialog.close();
    toast("Senha alterada.");
  } finally {
    hideBusy();
  }
});

el.usuarioForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = collectUsuarioPermissoes(formData(el.usuarioForm));
  const id = data.id;
  delete data.id;
  showBusy(id ? "Atualizando usuário" : "Criando usuário", "Salvando cadastro e permissões.");
  try {
    await api(id ? `/api/auth/users/${id}` : "/api/auth/users", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(data),
    });
    toast("Usuario salvo.");
    closeUsuarioModal();
    clearUsuarioForm();
    await loadUsuarios();
  } finally {
    hideBusy();
  }
});

el.prestadorForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = formData(el.prestadorForm);
  const id = data.id;
  delete data.id;
  showBusy(id ? "Atualizando prestador" : "Criando prestador", "Salvando cadastro e atualizando a tela.");
  try {
    await api(id ? `/api/prestadores/${id}` : "/api/prestadores", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(data),
    });
    toast("Prestador salvo.");
    closePrestadorModal();
    await loadAll();
  } catch (error) {
    toast(error.message);
  } finally {
    hideBusy();
  }
});

el.adiantamentoForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!el.adiantamentoForm.elements.prestador_id.value) {
    toast("Selecione um prestador.");
    return;
  }
  showBusy("Lançando adiantamento", "Salvando o adiantamento e atualizando a tela.");
  try {
    await api("/api/adiantamentos", {
      method: "POST",
      body: JSON.stringify(formData(el.adiantamentoForm)),
    });
    el.adiantamentoForm.reset();
    closeAdiantamentoModal();
    toast("Adiantamento lancado.");
    await loadAll();
  } catch (error) {
    toast(error.message);
  } finally {
    hideBusy();
  }
});

el.calcularRescisao.addEventListener("click", () => calcularRescisao().catch((error) => toast(error.message)));
el.folhaReport.addEventListener("click", openFolhaReport);
el.integrarOmie.addEventListener("click", () => integrarOmie().catch((error) => toast(error.message)));
if (el.importarNfsFechadas) el.importarNfsFechadas.remove();
el.reabrirFolha.addEventListener("click", () => reabrirFolha().catch((error) => toast(error.message)));
el.aprovarFolha.addEventListener("click", () => aprovarFolha().catch((error) => toast(error.message)));
el.reprovarFolha.addEventListener("click", () => reprovarFolha().catch((error) => toast(error.message)));
el.solicitarNfs.addEventListener("click", () => solicitarNfs().catch((error) => toast(error.message)));
el.enviarAprovacaoFolha.addEventListener("click", () => enviarFolhaAprovacao().catch((error) => toast(error.message)));
el.smtpForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveSmtpConfig();
});
el.omieForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveOmieConfig();
});
el.emailTemplateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveEmailTemplate();
});
el.testOmie.addEventListener("click", async () => {
  showBusy("Testando Omie", "Validando credenciais e conta corrente configurada.");
  try {
    await saveOmieConfig();
    const result = await api("/api/config/omie/test", { method: "POST", body: "{}" });
    el.omieStatus.textContent = result.contaCorrenteId
      ? `Omie conectada. Conta corrente ${result.contaCorrenteId}.`
      : "Omie conectada. Conta corrente nao localizada; sera usado o padrao do fornecedor.";
    toast("Teste Omie concluido.");
  } finally {
    hideBusy();
  }
});
el.testSmtp.addEventListener("click", async () => {
  await saveSmtpConfig();
  const result = await api("/api/config/smtp/test", {
    method: "POST",
    body: JSON.stringify({ to: el.smtpForm.elements.testEmail.value }),
  });
  toast(`E-mail de teste enviado para ${result.to}.`);
});
el.rescisaoForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = formData(el.rescisaoForm);
  if (!data.prestador_id) {
    toast("Selecione um prestador.");
    return;
  }
  showBusy("Criando rescisão", "Calculando, salvando e atualizando a tela.");
  try {
    await api(`/api/prestadores/${data.prestador_id}/rescisao`, {
      method: "POST",
      body: JSON.stringify(data),
    });
    resetRescisaoForm();
    closeRescisaoModal();
    toast("Rescisao iniciada e aguardando NF.");
    await loadAll();
  } finally {
    hideBusy();
  }
});

el.folhaForm.elements.competencia.addEventListener("change", () => loadFolha().catch((error) => toast(error.message)));
el.folhaForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = formData(el.folhaForm);
  data.itens = state.folhaPreview.map((item) => ({
    prestador_id: item.prestador_id || item.id,
    dias_trabalhados: item.dias_trabalhados,
    adicoes: item.adicoes,
    bonus: item.bonus,
    descontos_manual: item.descontos_manual,
    valor_nf_emitida: item.valor_nf_emitida,
    numero_nf: item.numero_nf,
  }));
  showBusy("Fechando folha", "Validando aprovações, NFs e salvando o fechamento.");
  try {
    await api("/api/folhas", { method: "POST", body: JSON.stringify(data) });
    toast("Folha fechada com sucesso.");
    await loadAll();
    setView("dashboard");
  } finally {
    hideBusy();
  }
});

const today = new Date();
el.adiantamentoForm.elements.data_adiantamento.value = todayIso();
el.adiantamentoForm.elements.competencia_inicial.value = temporaryMinAdiantamentoCompetencia();
el.rescisaoForm.elements.data_rescisao.value = todayIso();
el.rescisaoForm.elements.data_aviso.value = todayIso();
applyDateLimits();
el.folhaForm.elements.competencia.value = currentCompetencia();
el.diasMesAuto.textContent = daysInCompetencia(el.folhaForm.elements.competencia.value);
renderUsuarioPermissoes(defaultPermissionsByPerfil.consulta);

async function applyInitialRoute() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  if (view === "folha" && canViewFolhas()) {
    setView("folha");
    const competencia = params.get("competencia") || currentCompetencia();
    el.folhaForm.elements.competencia.value = competencia;
    await loadFolha(competencia);
    return;
  }
  if (view === "rescisoes" && canViewRescisoes()) {
    setView("rescisoes");
  }
}

async function init() {
  try {
    const data = await api("/api/auth/me");
    state.authUser = data.usuario;
    hideLogin();
    applyAuthUi();
    setView(defaultViewForUser());
    await loadAll();
    await applyInitialRoute();
  } catch {
    showLogin();
  }
}

init();
