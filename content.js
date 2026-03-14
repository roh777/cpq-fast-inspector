(function initCpqFastInspector() {
  if (window.__CPQ_FAST_INSPECTOR_LOADED__) { toggleInspector(); return; }
  window.__CPQ_FAST_INSPECTOR_LOADED__ = true;

  const API_VERSION = "v60.0";
  const ROOT_ID = "cpq-fast-inspector-root";
  const CPQ_OBJECTS = [
    { apiName: "Product2", label: "Products" },
    { apiName: "PricebookEntry", label: "Price Entries" },
    { apiName: "SBQQ__ProductOption__c", label: "Product Options" },
    { apiName: "SBQQ__ConfigurationAttribute__c", label: "Config Attributes" },
    { apiName: "SBQQ__OptionConstraint__c", label: "Option Constraints" },
    { apiName: "SBQQ__ProductRule__c", label: "Product Rules" },
    { apiName: "SBQQ__ErrorCondition__c", label: "Error Conditions" },
    { apiName: "SBQQ__QuoteTemplate__c", label: "Quote Templates" },
    { apiName: "SBQQ__TemplateSection__c", label: "Template Sections" },
    { apiName: "SBQQ__PriceRule__c", label: "Price Rules" },
    { apiName: "SBQQ__PriceAction__c", label: "Price Actions" },
    { apiName: "SBQQ__LookupQuery__c", label: "Lookup Queries" },
    { apiName: "SBQQ__SummaryVariable__c", label: "Summary Variables" },
    { apiName: "SBQQ__DiscountSchedule__c", label: "Discount Schedules" },
    { apiName: "SBQQ__DiscountTier__c", label: "Discount Tiers" },
    { apiName: "SBQQ__ProductFeature__c", label: "Product Features" },
    { apiName: "SBQQ__CustomAction__c", label: "Custom Actions" },
    { apiName: "SBQQ__QuoteTerm__c", label: "Quote Terms" },
    { apiName: "SBQQ__LineColumn__c", label: "Line Columns" },
    { apiName: "SBQQ__QuoteProcess__c", label: "Quote Process" },
  ];

  const state = {
    shell: null, rail: null, statusEl: null, packageEl: null, listEl: null, searchEl: null,
    packageInstalled: null, searchTimer: null,
  };

  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === "cpq-fast-inspector-toggle") toggleInspector();
  });

  mount();

  async function mount() {
    const existing = document.getElementById(ROOT_ID);
    if (existing) { state.shell = existing.querySelector(".cpqfi-shell"); return; }
    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.innerHTML = buildShell();
    document.documentElement.appendChild(root);
    state.shell = root.querySelector(".cpqfi-shell");
    state.rail = root.querySelector(".cpqfi-rail");
    state.statusEl = root.querySelector("[data-role='status']");
    state.packageEl = root.querySelector("[data-role='package']");
    state.listEl = root.querySelector("[data-role='object-list']");
    state.searchEl = root.querySelector("[data-role='search']");
    bindUi(root);
    renderLinks(CPQ_OBJECTS);
    connect();
  }

  function bindUi(root) {
    state.rail.addEventListener("click", () => toggleInspector());
    root.querySelector("[data-role='close']").addEventListener("click", () => toggleInspector(false));
    state.searchEl.addEventListener("input", () => {
      clearTimeout(state.searchTimer);
      const term = state.searchEl.value.trim();
      state.searchTimer = setTimeout(() => handleSearch(term), 300);
    });
  }

  async function connect() {
    setStatus("connecting...");
    try {
      await query("SELECT Id FROM SBQQ__ProductOption__c LIMIT 0");
      state.packageInstalled = true;
      setStatus("sbqq installed");
    } catch {
      state.packageInstalled = false;
      setStatus("connected");
    }
    paintPackage();
  }

  async function handleSearch(term) {
    if (!term) { renderLinks(CPQ_OBJECTS); setStatus(state.packageInstalled != null ? (state.packageInstalled ? "sbqq installed" : "connected") : "connecting..."); return; }
    setStatus("searching...");
    try {
      const safe = term.replace(/'/g, "\\'").replace(/%/g, "\\%").replace(/_/g, "\\_");
      const recs = await query(`SELECT QualifiedApiName, Label FROM EntityDefinition WHERE IsQueryable = true AND Label LIKE '%${safe}%' ORDER BY Label LIMIT 15`);
      renderLinks(recs.map(r => ({ apiName: r.QualifiedApiName, label: r.Label })));
      setStatus(`${recs.length} result${recs.length !== 1 ? "s" : ""}`);
    } catch { setStatus("search failed"); renderLinks(CPQ_OBJECTS); }
  }

  function renderLinks(objects) {
    if (!state.listEl) return;
    state.listEl.innerHTML = objects.map(obj =>
      `<button class="cpqfi-obj-link" data-obj="${escapeHtml(obj.apiName)}">
        <span class="cpqfi-obj-label">${escapeHtml(obj.label)}</span>
      </button>`
    ).join("");
    state.listEl.querySelectorAll(".cpqfi-obj-link").forEach(btn =>
      btn.addEventListener("click", () => {
        if (!contextAlive()) { teardown(); return; }
        try {
          chrome.runtime.sendMessage({ type: "open-tab", object: btn.dataset.obj, host: window.location.origin });
        } catch { teardown(); return; }
        toggleInspector(false);
      })
    );
  }

  function paintPackage() {
    if (!state.packageEl) return;
    const map = { null: ["sbqq?", "neutral"], true: ["sbqq ✓", "success"], false: ["sbqq ✗", "error"] };
    const [text, cls] = map[String(state.packageInstalled)];
    state.packageEl.textContent = text;
    state.packageEl.className = `cpqfi-badge cpqfi-badge-${cls}`;
  }

  async function query(soql) {
    const r = await rest(`/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`);
    return r.records || [];
  }

  function contextAlive() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  function teardown() {
    document.getElementById(ROOT_ID)?.remove();
    window.__CPQ_FAST_INSPECTOR_LOADED__ = false;
  }

  async function rest(path) {
    if (!contextAlive()) { teardown(); throw new Error("extension reloaded — refresh the page"); }
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(
          { type: "sf-api", path, host: window.location.href },
          r => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (!r?.success) return reject(new Error(r?.error || "no response"));
            resolve(r.payload);
          }
        );
      } catch(e) {
        teardown();
        reject(e);
      }
    });
  }

  function setStatus(msg) { if (state.statusEl) state.statusEl.textContent = msg.toLowerCase(); }

  function toggleInspector(forceState) {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    const show = typeof forceState === "boolean" ? forceState : state.shell.classList.contains("cpqfi-hidden");
    state.shell.classList.toggle("cpqfi-hidden", !show);
    state.rail.classList.toggle("cpqfi-hidden", show);
  }

  function buildShell() {
    return `
      <div class="cpqfi-rail cpqfi-hidden" data-role="rail">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 10l-4 6 4-6"/></svg>
      </div>
      <aside class="cpqfi-shell cpqfi-hidden">
        <header class="cpqfi-header">
          <div class="cpqfi-header-top">
            <h1 class="cpqfi-title">sf inspector</h1>
            <button class="cpqfi-icon-btn" data-role="close">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          </div>
          <div class="cpqfi-status-bar">
            <span class="cpqfi-status" data-role="status">loading...</span>
            <span data-role="package" class="cpqfi-badge cpqfi-badge-neutral">sbqq</span>
          </div>
          <input class="cpqfi-search" data-role="search" type="text" placeholder="search all objects...">
        </header>
        <div class="cpqfi-scroll-area">
          <div class="cpqfi-object-list" data-role="object-list"></div>
        </div>
      </aside>`;
  }

  function escapeHtml(v) {
    return String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  }
})();
