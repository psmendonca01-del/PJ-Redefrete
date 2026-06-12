const el = {
  loginCard: document.querySelector("#loginCard"),
  loginForm: document.querySelector("#loginForm"),
  loginMessage: document.querySelector("#loginMessage"),
  approvalApp: document.querySelector("#approvalApp"),
  approvalList: document.querySelector("#approvalList"),
  userLine: document.querySelector("#userLine"),
  refresh: document.querySelector("#refresh"),
  logout: document.querySelector("#logout"),
  toast: document.querySelector("#toast"),
  detailsDialog: document.querySelector("#detailsDialog"),
  detailsTitle: document.querySelector("#detailsTitle"),
  detailsBody: document.querySelector("#detailsBody"),
};

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
let pendentes = [];
let busyCount = 0;

function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add("show");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => el.toast.classList.remove("show"), 3500);
}

function fmtDate(value) {
  if (!value) return "-";
  const [year, month, day] = String(value).slice(0, 10).split("-");
  return year && month && day ? `${day}/${month}/${year}` : String(value);
}

function fmtDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fmtDate(value);
  return date.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderApprovalHistory(aprovacoes = {}) {
  const aprovadores = aprovacoes.aprovadores || [];
  if (!aprovadores.length) return "";
  return `
    <section class="approval-history" aria-label="Histórico de aprovações">
      ${aprovadores.map((aprovacao) => `
        <article>
          <span>${escapeHtml(aprovacao.etapa || "Aprovação")}</span>
          <strong>${escapeHtml(aprovacao.nome || "-")}</strong>
          <small>${escapeHtml(fmtDateTime(aprovacao.aprovado_em))}</small>
        </article>
      `).join("")}
    </section>
  `;
}

async function api(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const progressTitle = options.progressTitle || (method === "GET" ? "Carregando" : "Processando");
  const progressMessage = options.progressMessage || "Aguarde, o sistema está operando.";
  showBusy(progressTitle, progressMessage);
  const fetchOptions = { ...options };
  delete fetchOptions.progressTitle;
  delete fetchOptions.progressMessage;
  try {
    const response = await fetch(url, {
      headers: { "Content-Type": "application/json", ...(fetchOptions.headers || {}) },
      credentials: "same-origin",
      ...fetchOptions,
    });
    if (response.status === 401) {
      showLogin();
      throw new Error("Faça login para continuar.");
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Não foi possível concluir a operação.");
    return data;
  } finally {
    hideBusy();
  }
}

function showBusy(title = "Processando", message = "Aguarde, o sistema está operando.") {
  busyCount += 1;
  const overlay = document.querySelector("#busyOverlay");
  if (!overlay) return;
  document.querySelector("#busyTitle").textContent = title;
  document.querySelector("#busyMessage").textContent = message;
  overlay.hidden = false;
}

function hideBusy() {
  busyCount = Math.max(0, busyCount - 1);
  if (busyCount > 0) return;
  const overlay = document.querySelector("#busyOverlay");
  if (overlay) overlay.hidden = true;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}

function typeLabel(tipo) {
  return {
    folha: "Folha",
    rescisao: "Rescisão",
    adiantamento: "Adiantamento",
    reembolso_superior: "Reembolso",
    reembolso_financeiro: "Reembolso financeiro",
    reembolso_adiantamento: "Adiantamento reembolso",
  }[tipo] || tipo;
}

function showLogin() {
  el.loginCard.hidden = false;
  el.approvalApp.hidden = true;
}

function showApp() {
  el.loginCard.hidden = true;
  el.approvalApp.hidden = false;
}

function render() {
  const params = new URLSearchParams(location.search);
  const focusTipo = params.get("tipo");
  const focusId = params.get("id");
  const ordered = [...pendentes].sort((a, b) => {
    const aFocus = focusTipo && focusId && a.tipo === focusTipo && String(a.id) === String(focusId) ? 0 : 1;
    const bFocus = focusTipo && focusId && b.tipo === focusTipo && String(b.id) === String(focusId) ? 0 : 1;
    return aFocus - bFocus;
  });

  if (!ordered.length) {
    el.approvalList.innerHTML = `<section class="card empty"><h2>Nenhuma aprovação pendente</h2><p class="meta">Quando houver algo na sua etapa, aparecerá aqui.</p></section>`;
    return;
  }

  el.approvalList.innerHTML = ordered.map((item) => `
    <article class="approval-item" data-key="${escapeHtml(item.tipo)}:${escapeHtml(item.id)}">
      <div class="approval-title">
        <div>
          <span class="type">${escapeHtml(typeLabel(item.tipo))}</span>
          <h2>${escapeHtml(item.titulo)}</h2>
          <small>${escapeHtml(item.subtitulo || "")}</small>
        </div>
        <small>${escapeHtml(item.competencia || item.data || "")}</small>
      </div>
      <div class="value-row">
        <article><span>Valor</span><strong>${brl.format(Number(item.valor || 0))}</strong></article>
        <article><span>Etapa</span><strong>${escapeHtml(item.aprovacoes?.proximo?.nome || "")}</strong></article>
        <article><span>Fluxo</span><strong>${Number(item.aprovacoes?.count || 0)}/${Number(item.aprovacoes?.required || 0)}</strong></article>
      </div>
      ${renderApprovalHistory(item.aprovacoes)}
      <p class="meta">${escapeHtml([
        item.parcelas ? `${item.parcelas} parcela(s)` : "",
        item.nf ? `NF ${item.nf}` : "",
      ].filter(Boolean).join(" | "))}</p>
      <div class="actions">
        ${item.detailUrl ? `<button type="button" data-details="${escapeHtml(item.tipo)}:${escapeHtml(item.id)}">Ver itens e comprovantes</button>` : ""}
        ${item.reportUrl ? `<a class="button-link" href="${escapeHtml(item.reportUrl)}" target="_blank" rel="noopener">Ver relatório</a>` : ""}
        <button class="danger" type="button" data-reject="${escapeHtml(item.tipo)}:${escapeHtml(item.id)}">Reprovar</button>
        <button class="primary" type="button" data-approve="${escapeHtml(item.tipo)}:${escapeHtml(item.id)}">Aprovar</button>
      </div>
    </article>
  `).join("");

  document.querySelectorAll("[data-approve]").forEach((button) => {
    button.addEventListener("click", () => approve(button.dataset.approve).catch((error) => toast(error.message)));
  });
  document.querySelectorAll("[data-reject]").forEach((button) => {
    button.addEventListener("click", () => reject(button.dataset.reject).catch((error) => toast(error.message)));
  });
  document.querySelectorAll("[data-details]").forEach((button) => {
    button.addEventListener("click", () => showDetails(button.dataset.details).catch((error) => toast(error.message)));
  });
}

async function load() {
  const data = await api("/api/aprovacoes-pendentes");
  pendentes = data.pendentes || [];
  el.userLine.textContent = `${data.usuario?.nome || ""} | ${pendentes.length} pendência(s)`;
  showApp();
  render();
}

function showAppError(message) {
  pendentes = [];
  el.userLine.textContent = "";
  showApp();
  el.approvalList.innerHTML = `<section class="card empty"><h2>Não foi possível carregar</h2><p class="meta">${escapeHtml(message)}</p></section>`;
}

function findItem(key) {
  const [tipo, id] = key.split(":");
  return pendentes.find((item) => item.tipo === tipo && String(item.id) === String(id));
}

function comprovantePreview(comprovante) {
  const url = escapeHtml(comprovante.url);
  const name = escapeHtml(comprovante.nome_original || "Comprovante");
  if (/image\//i.test(comprovante.mime_type || "") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(name)) {
    return `<a class="receipt-link" href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${name}"><span>${name}</span></a>`;
  }
  return `<a class="receipt-link pdf" href="${url}" target="_blank" rel="noopener"><strong>Visualizar</strong><span>${name}</span></a>`;
}

async function showDetails(key) {
  const item = findItem(key);
  if (!item?.detailUrl) return;
  el.detailsTitle.textContent = item.titulo;
  el.detailsBody.innerHTML = `<p class="meta">Carregando detalhes...</p>`;
  el.detailsDialog.showModal();
  const data = await api(item.detailUrl);
  const prestacao = data.prestacao || {};
  const resumo = prestacao.resumo_financeiro || {};
  const aprovacoes = data.aprovacoes || {};
  const despesas = data.despesas || [];
  el.detailsBody.innerHTML = `
    <section class="details-summary">
      <article><span>Solicitante</span><strong>${escapeHtml(prestacao.solicitante || item.subtitulo || "")}</strong></article>
      <article><span>Total despesas</span><strong>${brl.format(Number(prestacao.total_despesas || item.valor || 0))}</strong></article>
      <article><span>Adiantamento atual e pendentes</span><strong>${brl.format(Number(resumo.total_adiantamentos || prestacao.valor_adiantado || 0))}</strong></article>
      <article><span>${escapeHtml(resumo.saldo_label || "Saldo a reembolsar")}</span><strong>${brl.format(Number(resumo.saldo_valor ?? prestacao.valor_reembolsar ?? 0))}</strong></article>
      <article><span>Centro de custo</span><strong>${escapeHtml(prestacao.centro_custo || item.nf || "-")}</strong></article>
    </section>
    ${renderApprovalHistory(aprovacoes)}
    <div class="expense-list">
      ${despesas.map((despesa) => `
        <article class="expense-card">
          <div>
            <strong>${escapeHtml(despesa.tipo_despesa || "Despesa")}</strong>
            <span>${fmtDate(despesa.data_despesa)} | ${brl.format(Number(despesa.valor || 0))}</span>
          </div>
          <p>${escapeHtml(despesa.descricao || "")}</p>
          ${(despesa.origem || despesa.destino || Number(despesa.exige_km)) ? `<small>${escapeHtml([despesa.origem, despesa.destino].filter(Boolean).join(" -> "))}${Number(despesa.exige_km) ? ` | ${escapeHtml(despesa.quantidade_km || 0)} km` : ""}</small>` : ""}
          <div class="receipt-list">
            ${(despesa.comprovantes || []).map(comprovantePreview).join("") || `<span class="meta">Sem comprovante anexado</span>`}
          </div>
        </article>
      `).join("") || `<p class="meta">Nenhuma despesa lançada.</p>`}
    </div>
  `;
}

async function approve(key) {
  const item = findItem(key);
  if (!item) return;
  const body = { ...(item.approveBody || {}) };
  if (item.tipo === "reembolso_superior") {
    const justificativa = window.prompt("Mensagem opcional para o proximo aprovador ou financeiro. Deixe em branco para continuar sem mensagem.", "");
    if (justificativa === null) return;
    if (justificativa.trim()) body.justificativa = justificativa.trim();
  }
  await api(item.approveUrl, { method: "POST", body: JSON.stringify(body) });
  toast("Aprovação registrada.");
  await load();
}

async function reject(key) {
  const item = findItem(key);
  if (!item) return;
  const motivo = window.prompt("Informe a justificativa da recusa:");
  if (!motivo || !motivo.trim()) return;
  await api(item.rejectUrl, { method: "POST", body: JSON.stringify({ motivo }) });
  toast("Processo reprovado e devolvido para ajuste.");
  await load();
}

el.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  el.loginMessage.textContent = "";
  const data = Object.fromEntries(new FormData(el.loginForm).entries());
  try {
    await api("/api/auth/login", { method: "POST", body: JSON.stringify(data) });
    showApp();
    await load();
  } catch (error) {
    if (error.message.includes("login")) {
      el.loginMessage.textContent = error.message;
      return;
    }
    showAppError(error.message);
  }
});

el.refresh.addEventListener("click", () => load().catch((error) => toast(error.message)));
el.logout.addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
  } catch {
    // Mesmo se a sessão já expirou, voltamos para o login.
  }
  pendentes = [];
  el.loginForm.reset();
  showLogin();
});

load().catch((error) => {
  if (error.message.includes("login")) showLogin();
  else showAppError(error.message);
});
