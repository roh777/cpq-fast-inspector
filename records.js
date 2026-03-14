const API_VERSION = "v60.0";
const params = new URLSearchParams(window.location.search);
const host = params.get("host") || "";
const objectName = params.get("object") || "Product2";
const initialRecordId = params.get("recordId") || "";

const SKIP_FIELDS = new Set(["CreatedById","LastModifiedById","SystemModstamp","IsDeleted","MasterRecordId"]);
const SKIP_TYPES  = new Set(["address","location","anyType","base64"]);
const SKIP_CHILD  = /Feed$|Share$|History$|ChangeEvent$|OwnerSharingRule$|__Tag$|AttachedContentDocument$|CombinedAttachment$|NoteAndAttachment$|OpenActivity$|ActivityHistory$|ProcessInstance$|ContentDocumentLink$/;

let timeFilter = ""; // "" | "1h" | "12h" | "7d"
let searchDebounce = null;

const state = {
  cache: {},
  lookupNames: {},
  records: [],
  nextUrl: null,
  selected: null,
  inputValues: {},
  relatedGroups: [],
  isNew: false,
};

// Modal state
const modal = { stack: [] };

const els = {
  title:    document.getElementById("title"),
  subtitle: document.getElementById("subtitle"),
  status:   document.getElementById("status"),
  filter:   document.getElementById("filter"),
  refresh:  document.getElementById("refresh"),
  save:     document.getElementById("save"),
  del:      document.getElementById("delete"),
  newBtn:   document.getElementById("newRecord"),
  loadMore: document.getElementById("loadMore"),
  listMeta: document.getElementById("listMeta"),
  recordList:     document.getElementById("recordList"),
  recordForm:     document.getElementById("recordForm"),
  relatedRecords: document.getElementById("relatedRecords"),
  modalOverlay:   document.getElementById("modal"),
  modalBody:      document.getElementById("modalBody"),
  modalCrumb:     document.getElementById("modalCrumb"),
  modalStatus:    document.getElementById("modalStatus"),
  modalSave:      document.getElementById("modalSave"),
  modalClose:     document.getElementById("modalClose"),
};

boot();

// ── Boot ───────────────────────────────────────────────────────────────────

async function boot() {
  els.title.textContent = humanize(objectName);
  els.subtitle.textContent = host ? new URL(host).hostname.replace(".my.salesforce.com","") : "";
  if (!host) { setStatus("missing host — reopen from inspector panel", true); return; }

  // Main record list events
  els.filter.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(loadRecords, 350);
  });
  els.refresh.addEventListener("click", loadRecords);
  els.save.addEventListener("click", saveRecord);
  els.del.addEventListener("click", deleteRecord);
  els.newBtn.addEventListener("click", startNew);
  els.loadMore.addEventListener("click", loadMore);

  // Time filter buttons
  document.querySelectorAll(".tf").forEach(btn =>
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tf").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      timeFilter = btn.dataset.tf;
      loadRecords();
    })
  );

  // Modal events
  els.modalClose.addEventListener("click", closeModal);
  els.modalSave.addEventListener("click", saveModalChanges);
  els.modalOverlay.addEventListener("click", e => { if (e.target === els.modalOverlay) closeModal(); });

  setStatus("loading...");
  await loadRecords();
  if (initialRecordId) await loadSelectedRecord(initialRecordId);
}

// ── Record list loading ────────────────────────────────────────────────────

function buildQuery() {
  const parts = [];
  const term = els.filter.value.trim();
  if (term) parts.push(`Name LIKE '%${term.replace(/'/g,"\\'")}%'`);
  if (timeFilter === "7d") parts.push("LastModifiedDate = LAST_N_DAYS:7");
  const where = parts.length ? `WHERE ${parts.join(" AND ")}` : "";
  const order = timeFilter === "oldest" ? "LastModifiedDate ASC" : "LastModifiedDate DESC";
  return { where, order };
}

async function loadRecords() {
  setStatus("loading...");
  try {
    const desc = await describe();
    const cfg  = deriveConfig(desc);
    const { where, order } = buildQuery();
    const resp = await rawQuery(
      `SELECT ${cfg.listFields.join(",")} FROM ${objectName} ${where} ORDER BY ${order} LIMIT 100`
    );
    state.records = resp.records || [];
    state.nextUrl = resp.nextRecordsUrl || null;
    state.selected = null; state.inputValues = {}; state.isNew = false;
    renderList(); renderForm(); renderRelated();
    setStatus(`${state.records.length}${state.nextUrl ? "+" : ""} records`);
  } catch(e) { setStatus(e.message, true); }
}

async function loadMore() {
  if (!state.nextUrl) return;
  setBusy(els.loadMore, "loading...");
  try {
    const resp = await rest(state.nextUrl);
    state.records = state.records.concat(resp.records || []);
    state.nextUrl = resp.nextRecordsUrl || null;
    renderList();
    setStatus(`${state.records.length}${state.nextUrl ? "+" : ""} records`);
  } catch(e) { setStatus(e.message, true); }
  finally { resetBtn(els.loadMore, "load more"); }
}

async function loadSelectedRecord(id) {
  const desc = await describe();
  const cfg  = deriveConfig(desc);
  try {
    const [rec] = await query(
      `SELECT ${cfg.detailFields.join(",")} FROM ${objectName} WHERE Id = '${id}' LIMIT 1`
    );
    if (!rec) { setStatus("record not found", true); return; }
    state.selected = rec; state.inputValues = { ...rec }; state.isNew = false;
    renderList(); renderForm();
    initRelatedGroups(desc);
    resolveLookups(rec, desc).then(() => { if (state.selected?.Id === rec.Id) patchLookupNames(desc); });
  } catch(e) { setStatus(e.message, true); }
}

function startNew() {
  state.selected = null; state.inputValues = {}; state.isNew = true; state.relatedGroups = [];
  renderList(); renderForm(); renderRelated();
}

// ── CRUD ──────────────────────────────────────────────────────────────────

async function saveRecord() {
  if (state.isNew) { await createRecord(); return; }
  if (!state.selected?.Id) return;
  const changes = Object.fromEntries(
    Object.entries(state.inputValues).filter(([k,v]) => state.selected[k] !== v)
  );
  if (!Object.keys(changes).length) { setStatus("no changes"); return; }
  datetimeFix(changes);
  setBusy(els.save, "saving");
  try {
    await rest(`/services/data/${API_VERSION}/sobjects/${objectName}/${state.selected.Id}`, { method:"PATCH", body:changes });
    Object.assign(state.selected, changes);
    state.inputValues = { ...state.selected };
    renderForm(); setStatus("saved");
  } catch(e) { setStatus(e.message, true); }
  finally { resetBtn(els.save, "save"); }
}

async function createRecord() {
  const payload = Object.fromEntries(Object.entries(state.inputValues).filter(([,v]) => v != null && v !== ""));
  datetimeFix(payload);
  setBusy(els.save, "creating");
  try {
    const result = await rest(`/services/data/${API_VERSION}/sobjects/${objectName}`, { method:"POST", body:payload });
    state.isNew = false;
    await loadSelectedRecord(result.id);
    state.records.unshift(state.selected);
    renderList(); setStatus("created");
  } catch(e) { setStatus(e.message, true); }
  finally { resetBtn(els.save, "save"); }
}

async function deleteRecord() {
  if (!state.selected?.Id || !confirm("Delete this record?")) return;
  setBusy(els.del, "deleting");
  try {
    await rest(`/services/data/${API_VERSION}/sobjects/${objectName}/${state.selected.Id}`, { method:"DELETE" });
    state.records = state.records.filter(r => r.Id !== state.selected.Id);
    state.selected = null; state.inputValues = {};
    renderList(); renderForm(); renderRelated(); setStatus("deleted");
  } catch(e) { setStatus(e.message, true); }
  finally { resetBtn(els.del, "delete"); }
}

// ── Describe + config ──────────────────────────────────────────────────────

async function describe(obj = objectName) {
  if (state.cache[obj]) return state.cache[obj];
  const p = await rest(`/services/data/${API_VERSION}/sobjects/${obj}/describe`);
  const fields = p.fields || [];
  state.cache[obj] = {
    fields,
    fieldMap: Object.fromEntries(fields.map(f => [f.name, f])),
    childRelationships: p.childRelationships || [],
  };
  return state.cache[obj];
}

function deriveConfig(desc) {
  if (desc._cfg) return desc._cfg;
  const listFields = ["Id", ...desc.fields
    .filter(f => f.name !== "Id" && !SKIP_FIELDS.has(f.name) && !SKIP_TYPES.has(f.type) && f.type !== "textarea")
    .slice(0, 5).map(f => f.name)];
  const detailFields = ["Id", ...desc.fields
    .filter(f => (f.updateable || f.name === "Name") && !SKIP_TYPES.has(f.type))
    .map(f => f.name)];
  return (desc._cfg = { listFields, detailFields });
}

function getTableCols(desc) {
  return desc.fields
    .filter(f => f.updateable && !SKIP_FIELDS.has(f.name) && !SKIP_TYPES.has(f.type) && f.type !== "textarea")
    .slice(0, 6).map(f => f.name);
}

// ── Related groups ────────────────────────────────────────────────────────

function initRelatedGroups(desc) {
  state.relatedGroups = desc.childRelationships
    .filter(r => r.relationshipName && !SKIP_CHILD.test(r.childSObject))
    .slice(0, 30)
    .map(r => ({ ...r, count: null }));
  renderRelated();
  loadRelatedCounts(state.selected.Id);
}

function loadRelatedCounts(parentId) {
  state.relatedGroups.forEach((g, i) => {
    rawQuery(`SELECT COUNT() FROM ${g.childSObject} WHERE ${g.field} = '${parentId}'`)
      .then(r => {
        if (!state.relatedGroups[i]) return;
        state.relatedGroups[i].count = r.totalSize;
        const badge = els.relatedRecords.querySelector(`[data-rel-badge="${i}"]`);
        if (badge) badge.textContent = r.totalSize;
      }).catch(() => {});
  });
}

// ── Lookup resolution ─────────────────────────────────────────────────────

async function resolveLookups(record, desc) {
  const byObj = {};
  desc.fields
    .filter(f => f.type === "reference" && record[f.name] && !state.lookupNames[record[f.name]])
    .forEach(f => { const t = f.referenceTo?.[0]; if (t) (byObj[t] ||= []).push(record[f.name]); });
  await Promise.allSettled(Object.entries(byObj).map(async ([obj, ids]) => {
    const recs = await query(`SELECT Id, Name FROM ${obj} WHERE Id IN (${ids.map(id=>`'${id}'`).join(",")})`)
      .catch(() => []);
    recs.forEach(r => { state.lookupNames[r.Id] = r.Name || r.Id; });
  }));
}

function patchLookupNames(desc) {
  desc.fields
    .filter(f => f.type === "reference" && state.selected?.[f.name])
    .forEach(f => {
      const name = state.lookupNames[state.selected[f.name]];
      if (!name) return;
      const input = els.recordForm.querySelector(`[data-field="${f.name}"]`);
      if (!input) return;
      const wrap = input.closest(".lookup-wrap");
      if (!wrap) return;
      let span = wrap.querySelector(".lookup-name");
      if (!span) { span = document.createElement("span"); span.className = "lookup-name"; wrap.appendChild(span); }
      span.textContent = name;
    });
}

// ── Rendering ─────────────────────────────────────────────────────────────

function renderList() {
  els.listMeta.textContent = `${state.records.length}${state.nextUrl ? "+" : ""} records`;
  els.recordList.innerHTML = state.records.map(r =>
    `<button class="record-card${r.Id === state.selected?.Id ? " active" : ""}" data-id="${escapeHtml(r.Id)}">
      <strong>${escapeHtml(r.Name || r.Id)}</strong>
    </button>`
  ).join("");
  els.recordList.querySelectorAll("[data-id]").forEach(b =>
    b.addEventListener("click", () => loadSelectedRecord(b.dataset.id))
  );
  els.loadMore.style.display = state.nextUrl ? "block" : "none";
}

function renderForm() {
  const creating = state.isNew;
  const rec = state.selected;
  els.save.textContent = creating ? "create" : "save";
  els.del.disabled = !rec || creating;
  els.del.style.display = creating ? "none" : "";

  if (!rec && !creating) {
    els.recordForm.innerHTML = "<div class=\"meta\">select a record or click + New</div>";
    return;
  }
  const desc = state.cache[objectName];
  if (!desc) { els.recordForm.innerHTML = "<div class=\"meta\">loading...</div>"; return; }

  const cfg = deriveConfig(desc);
  const fields = creating
    ? cfg.detailFields.filter(f => f !== "Id")
    : cfg.detailFields.filter(f => f in rec);

  els.recordForm.innerHTML = fields.map(field => {
    const meta  = desc.fieldMap[field];
    const orig  = rec?.[field] ?? null;
    const cur   = state.inputValues[field] ?? null;
    const dirty = !creating && orig !== cur;
    return `<div class="field${dirty ? " field-dirty" : ""}">${renderInput(field, cur, meta)}</div>`;
  }).join("");

  wireFormEvents(els.recordForm, desc, state.inputValues, rec);
}

function renderRelated() {
  if (!state.selected || state.isNew) { els.relatedRecords.innerHTML = "<div class=\"meta\">—</div>"; return; }
  if (!state.relatedGroups.length)    { els.relatedRecords.innerHTML = "<div class=\"meta\">none</div>"; return; }

  els.relatedRecords.innerHTML = state.relatedGroups.map((g, i) =>
    `<div class="rel-group">
      <div class="rel-head" data-idx="${i}">
        <span class="rel-name">${escapeHtml(g.relationshipName)}</span>
        <span class="rel-badge" data-rel-badge="${i}">${g.count === null ? "…" : g.count}</span>
      </div>
    </div>`
  ).join("");

  els.relatedRecords.querySelectorAll("[data-idx]").forEach(h =>
    h.addEventListener("click", () => openModal(+h.dataset.idx))
  );
}

// ── Field rendering ───────────────────────────────────────────────────────

function renderInput(field, value, meta) {
  const a = `data-field="${escapeHtml(field)}"`;
  const v = value ?? "";
  const type = meta?.type;
  const lbl = `<label>${escapeHtml(meta?.label || field)}</label>`;

  if (field === "Id")
    return `${lbl}<input ${a} value="${escapeAttribute(String(v))}" readonly>`;
  if (type === "boolean")
    return `${lbl}<label class="cb-wrap"><input type="checkbox" ${a}${value ? " checked" : ""}><span>${value ? "true" : "false"}</span></label>`;
  if (type === "picklist") {
    const opts = (meta.picklistValues||[]).filter(p => p.active || p.value === v)
      .map(p => `<option value="${escapeAttribute(p.value)}"${p.value===v?" selected":""}>${escapeHtml(p.label)}</option>`).join("");
    return `${lbl}<select ${a}>${opts}</select>`;
  }
  if (type === "multipicklist") {
    const sel = new Set(String(v).split(";").filter(Boolean));
    const opts = (meta.picklistValues||[]).filter(p => p.active || sel.has(p.value))
      .map(p => `<option value="${escapeAttribute(p.value)}"${sel.has(p.value)?" selected":""}>${escapeHtml(p.label)}</option>`).join("");
    return `${lbl}<select ${a} multiple size="3">${opts}</select>`;
  }
  if (type === "textarea")
    return `${lbl}<textarea ${a}>${escapeHtml(String(v))}</textarea>`;
  if (type === "date")
    return `${lbl}<input type="date" ${a} value="${escapeAttribute(String(v))}">`;
  if (type === "datetime")
    return `${lbl}<input type="datetime-local" ${a} value="${escapeAttribute(toDatetimeLocal(v))}">`;
  if (["int","double","currency","percent"].includes(type))
    return `${lbl}<input type="number" ${a} value="${escapeAttribute(String(v))}">`;
  if (type === "reference") {
    const name = state.lookupNames[v] || "";
    return `${lbl}<div class="lookup-wrap"><input ${a} value="${escapeAttribute(String(v))}" placeholder="${escapeAttribute(name || meta?.referenceTo?.[0] || "ID")}">${name ? `<span class="lookup-name">${escapeHtml(name)}</span>` : ""}</div>`;
  }
  return `${lbl}<input ${a} value="${escapeAttribute(String(v))}">`;
}

// Render a compact cell input for the modal table (no label, uses data-record + data-field)
function renderCellInput(recordId, field, value, meta) {
  const a = `data-record="${escapeHtml(recordId)}" data-field="${escapeHtml(field)}"`;
  const v = value ?? "";
  const type = meta?.type;
  if (type === "boolean")
    return `<label class="cb-wrap"><input type="checkbox" ${a}${value ? " checked" : ""}><span>${value ? "t" : "f"}</span></label>`;
  if (type === "picklist") {
    const opts = (meta.picklistValues||[]).filter(p => p.active || p.value === v)
      .map(p => `<option value="${escapeAttribute(p.value)}"${p.value===v?" selected":""}>${escapeHtml(p.label)}</option>`).join("");
    return `<select ${a}>${opts}</select>`;
  }
  if (type === "date")
    return `<input type="date" ${a} value="${escapeAttribute(String(v))}">`;
  if (type === "datetime")
    return `<input type="datetime-local" ${a} value="${escapeAttribute(toDatetimeLocal(v))}">`;
  if (["int","double","currency","percent"].includes(type))
    return `<input type="number" ${a} value="${escapeAttribute(String(v))}">`;
  return `<input ${a} value="${escapeAttribute(String(v))}">`;
}

// Shared event wiring for main form
function wireFormEvents(container, desc, inputValues, originalRecord) {
  container.querySelectorAll("[data-field]").forEach(el => {
    const field = el.dataset.field;
    const meta  = desc.fieldMap[field];
    const ev    = el.type === "checkbox" ? "change" : "input";
    el.addEventListener(ev, () => {
      let val;
      if (el.type === "checkbox") {
        val = el.checked;
        const sp = el.nextElementSibling;
        if (sp?.tagName === "SPAN") sp.textContent = val ? "true" : "false";
      } else if (el.tagName === "SELECT" && el.multiple) {
        val = Array.from(el.selectedOptions).map(o => o.value).join(";") || null;
      } else {
        val = coerceValue(el.value);
      }
      inputValues[field] = val;
      el.closest(".field")?.classList.toggle("field-dirty", !state.isNew && originalRecord?.[field] !== val);
    });
    if (meta?.type === "reference" && el.tagName === "INPUT") attachLookup(el, meta.referenceTo);
  });
}

// ── Modal ─────────────────────────────────────────────────────────────────

async function openModal(groupIdx) {
  const g = state.relatedGroups[groupIdx];
  if (!g || !state.selected) return;
  modal.stack = [];
  await pushTableFrame(g.childSObject, g.field, g.relationshipName,
    state.selected.Id, state.selected.Name || state.selected.Id);
  els.modalOverlay.style.display = "flex";
}

async function pushTableFrame(childObj, parentField, relationName, parentId, parentLabel) {
  if (modal.stack.length >= 5) return;
  els.modalStatus.textContent = "loading...";
  try {
    const desc  = await describe(childObj);
    const cols  = getTableCols(desc);
    // Include name field
    const nameField = desc.fields.find(f => f.nameField)?.name || "Name";
    const queryFields = ["Id", ...(desc.fieldMap[nameField] ? [nameField] : []), ...cols.filter(c => c !== nameField)];
    const recs  = await query(
      `SELECT ${[...new Set(queryFields)].join(",")} FROM ${childObj} WHERE ${parentField} = '${parentId}' ORDER BY LastModifiedDate DESC LIMIT 200`
    );
    modal.stack.push({
      type: "TABLE",
      label: relationName,
      parentLabel,
      objectName: childObj,
      parentField,
      parentId,
      nameField,
      records: recs,
      desc,
      cols,
      inputValues: Object.fromEntries(recs.map(r => [r.Id, { ...r }])),
    });
    renderModal();
  } catch(e) { els.modalStatus.textContent = e.message; }
}

async function pushDetailFrame(objectName, recordId, recordLabel) {
  if (modal.stack.length >= 5) return;
  els.modalStatus.textContent = "loading...";
  try {
    const desc = await describe(objectName);
    const cfg  = deriveConfig(desc);
    const [record] = await query(
      `SELECT ${cfg.detailFields.join(",")} FROM ${objectName} WHERE Id = '${recordId}' LIMIT 1`
    );
    if (!record) { els.modalStatus.textContent = "not found"; return; }
    const relatedGroups = desc.childRelationships
      .filter(r => r.relationshipName && !SKIP_CHILD.test(r.childSObject))
      .slice(0, 20)
      .map(r => ({ ...r, count: null }));
    modal.stack.push({ type:"DETAIL", label:recordLabel, objectName, record, desc, inputValues:{...record}, relatedGroups });
    renderModal();
    // Lazy counts for this detail frame's related groups
    relatedGroups.forEach((g, i) => {
      rawQuery(`SELECT COUNT() FROM ${g.childSObject} WHERE ${g.field} = '${recordId}'`)
        .then(r => {
          relatedGroups[i].count = r.totalSize;
          const badge = els.modalBody.querySelector(`[data-modal-badge="${i}"]`);
          if (badge) badge.textContent = r.totalSize;
        }).catch(() => {});
    });
    // Resolve lookups for this record
    resolveLookups(record, desc).then(() => {
      desc.fields.filter(f => f.type === "reference" && record[f.name]).forEach(f => {
        const name = state.lookupNames[record[f.name]];
        if (!name) return;
        const inp = els.modalBody.querySelector(`[data-field="${f.name}"]`);
        if (!inp) return;
        const wrap = inp.closest(".lookup-wrap");
        if (!wrap) return;
        let span = wrap.querySelector(".lookup-name");
        if (!span) { span = document.createElement("span"); span.className = "lookup-name"; wrap.appendChild(span); }
        span.textContent = name;
      });
    });
  } catch(e) { els.modalStatus.textContent = e.message; }
}

function renderModal() {
  const frame = modal.stack[modal.stack.length - 1];
  if (!frame) { closeModal(); return; }
  els.modalStatus.textContent = "";

  // Breadcrumb
  const depth = modal.stack.length;
  els.modalCrumb.innerHTML = modal.stack.map((f, i) => {
    const isLast = i === depth - 1;
    const crumb = `<span class="crumb${isLast ? " crumb-active" : ""}" ${!isLast ? `data-depth="${i}"` : ""}>${escapeHtml(f.label)}</span>`;
    return i < depth - 1 ? crumb + `<span class="crumb-sep">›</span>` : crumb;
  }).join("");
  els.modalCrumb.querySelectorAll("[data-depth]").forEach(c =>
    c.addEventListener("click", () => { modal.stack.splice(+c.dataset.depth + 1); renderModal(); })
  );

  if (depth >= 5) {
    const depthEl = els.modalCrumb.querySelector(".depth-warn") || Object.assign(document.createElement("span"), { className:"depth-warn" });
    depthEl.textContent = " (max depth)";
    els.modalCrumb.appendChild(depthEl);
  }

  frame.type === "TABLE" ? renderTableFrame(frame) : renderDetailFrame(frame);
}

function renderTableFrame(frame) {
  const { records, desc, cols, inputValues, objectName, nameField } = frame;
  els.modalSave.style.display = "";

  if (!records.length) {
    els.modalBody.innerHTML = "<div class=\"modal-empty\">No records.</div>";
    els.modalSave.style.display = "none";
    return;
  }

  const thead = `<tr class="modal-thead">
    <th class="col-sticky">${escapeHtml(desc.fieldMap[nameField]?.label || "Name")}</th>
    ${cols.map(c => `<th title="${escapeHtml(c)}">${escapeHtml(desc.fieldMap[c]?.label || c)}</th>`).join("")}
    <th></th>
  </tr>`;

  const tbody = records.map(r => {
    const vals = inputValues[r.Id];
    const rowDirty = cols.some(c => vals[c] !== r[c]);
    const cells = cols.map(c => {
      const dirty = vals[c] !== r[c];
      return `<td class="${dirty ? "td-dirty" : ""}">${renderCellInput(r.Id, c, vals[c], desc.fieldMap[c])}</td>`;
    });
    return `<tr class="${rowDirty ? "row-dirty" : ""}">
      <td class="col-sticky col-name">${escapeHtml(r[nameField] || r.Id)}</td>
      ${cells.join("")}
      <td class="col-drill"><button class="drill-btn" data-id="${escapeHtml(r.Id)}" data-name="${escapeHtml(r[nameField]||r.Id)}" data-obj="${escapeHtml(objectName)}">→</button></td>
    </tr>`;
  }).join("");

  els.modalBody.innerHTML = `<div class="modal-table-wrap"><table class="modal-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`;

  // Wire cell events
  els.modalBody.querySelectorAll("[data-record]").forEach(input => {
    const rid   = input.dataset.record;
    const field = input.dataset.field;
    const ev    = input.type === "checkbox" ? "change" : "input";
    input.addEventListener(ev, () => {
      const orig = frame.records.find(r => r.Id === rid)?.[field] ?? null;
      let val = input.type === "checkbox" ? input.checked : coerceValue(input.value);
      if (input.type === "checkbox") {
        const sp = input.nextElementSibling;
        if (sp?.tagName === "SPAN") sp.textContent = val ? "t" : "f";
      }
      frame.inputValues[rid][field] = val;
      input.closest("td")?.classList.toggle("td-dirty", orig !== val);
      input.closest("tr")?.classList.toggle("row-dirty",
        frame.cols.some(c => frame.inputValues[rid][c] !== frame.records.find(r => r.Id === rid)?.[c])
      );
    });
  });

  // Drill buttons
  els.modalBody.querySelectorAll(".drill-btn").forEach(btn =>
    btn.addEventListener("click", () =>
      pushDetailFrame(btn.dataset.obj, btn.dataset.id, btn.dataset.name)
    )
  );
}

function renderDetailFrame(frame) {
  const { record, desc, inputValues, relatedGroups, objectName } = frame;
  const cfg    = deriveConfig(desc);
  const fields = cfg.detailFields.filter(f => f in record);
  els.modalSave.style.display = "";

  const formHtml = `<div class="modal-detail-form">${
    fields.map(field => {
      const meta  = desc.fieldMap[field];
      const cur   = inputValues[field] ?? null;
      const dirty = record[field] !== cur;
      return `<div class="field${dirty ? " field-dirty" : ""}">${renderInput(field, cur, meta)}</div>`;
    }).join("")
  }</div>`;

  const relHtml = relatedGroups.length ? `<div class="modal-related-list">
    <div class="modal-section-head">Related</div>
    ${relatedGroups.map((g, i) =>
      `<div class="rel-group">
        <div class="rel-head modal-rel-drill" data-rel="${i}">
          ▸ <span class="rel-name">${escapeHtml(g.relationshipName)}</span>
          <span class="rel-badge" data-modal-badge="${i}">${g.count === null ? "…" : g.count}</span>
        </div>
      </div>`
    ).join("")}
  </div>` : "";

  els.modalBody.innerHTML = formHtml + relHtml;

  // Wire form events
  wireFormEvents(els.modalBody, desc, inputValues, record);

  // Drill into related
  els.modalBody.querySelectorAll("[data-rel]").forEach(h =>
    h.addEventListener("click", () => {
      const g = frame.relatedGroups[+h.dataset.rel];
      pushTableFrame(g.childSObject, g.field, g.relationshipName, record.Id, frame.label);
    })
  );
}

async function saveModalChanges() {
  const frame = modal.stack[modal.stack.length - 1];
  if (!frame) return;
  setBusy(els.modalSave, "saving...");
  let saved = 0, errors = 0;

  if (frame.type === "TABLE") {
    const dirty = frame.records.map(r => {
      const changes = Object.fromEntries(
        frame.cols.filter(c => frame.inputValues[r.Id][c] !== r[c])
          .map(c => [c, frame.inputValues[r.Id][c]])
      );
      return Object.keys(changes).length ? { id: r.Id, changes } : null;
    }).filter(Boolean);

    await Promise.allSettled(dirty.map(async ({ id, changes }) => {
      try {
        await rest(`/services/data/${API_VERSION}/sobjects/${frame.objectName}/${id}`, { method:"PATCH", body:changes });
        const rec = frame.records.find(r => r.Id === id);
        if (rec) Object.assign(rec, changes);
        saved++;
      } catch { errors++; }
    }));
  } else {
    const changes = Object.fromEntries(
      Object.entries(frame.inputValues).filter(([k,v]) => frame.record[k] !== v)
    );
    if (Object.keys(changes).length) {
      datetimeFix(changes);
      try {
        await rest(`/services/data/${API_VERSION}/sobjects/${frame.objectName}/${frame.record.Id}`, { method:"PATCH", body:changes });
        Object.assign(frame.record, changes);
        saved++;
      } catch { errors++; }
    }
  }

  els.modalStatus.textContent = errors ? `${saved} saved, ${errors} failed` : `${saved} saved`;
  resetBtn(els.modalSave, "Save Changes");
  // Re-render to clear dirty markers
  renderModal();
}

function closeModal() {
  modal.stack = [];
  els.modalOverlay.style.display = "none";
}

// ── Lookup typeahead ──────────────────────────────────────────────────────

let _dd = null, _ddTimer = null;

function attachLookup(input, referenceTo) {
  if (!referenceTo?.length) return;
  const target = referenceTo[0];
  input.addEventListener("input", () => {
    clearTimeout(_ddTimer);
    const term = input.value.trim();
    if (term.length < 2 || /^[a-zA-Z0-9]{15,18}$/.test(term)) { hideLookup(); return; }
    _ddTimer = setTimeout(() => fetchLookup(input, target, term), 300);
  });
  input.addEventListener("blur", () => setTimeout(hideLookup, 200));
}

async function fetchLookup(input, target, term) {
  try {
    const safe = term.replace(/'/g, "\\'");
    const recs = await query(`SELECT Id, Name FROM ${target} WHERE Name LIKE '%${safe}%' LIMIT 8`);
    if (!recs.length) { hideLookup(); return; }
    hideLookup();
    const dd = document.createElement("div");
    dd.className = "lookup-dd";
    recs.forEach(r => {
      const opt = document.createElement("div");
      opt.className = "lookup-opt";
      opt.textContent = r.Name;
      opt.addEventListener("mousedown", e => {
        e.preventDefault();
        const field = input.dataset.field;
        state.inputValues[field] = r.Id;
        state.lookupNames[r.Id] = r.Name;
        input.value = r.Id;
        input.placeholder = r.Name;
        input.closest(".field")?.classList.add("field-dirty");
        const wrap = input.closest(".lookup-wrap");
        if (wrap) {
          let span = wrap.querySelector(".lookup-name");
          if (!span) { span = document.createElement("span"); span.className = "lookup-name"; wrap.appendChild(span); }
          span.textContent = r.Name;
        }
        hideLookup();
      });
      dd.appendChild(opt);
    });
    const wrap = input.closest(".lookup-wrap") || input.parentElement;
    wrap.style.position = "relative";
    wrap.appendChild(dd);
    _dd = dd;
  } catch { hideLookup(); }
}

function hideLookup() { _dd?.remove(); _dd = null; }

// ── Utilities ─────────────────────────────────────────────────────────────

function toDatetimeLocal(v) {
  if (!v) return "";
  return String(v).replace(/(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})$/, "").slice(0, 19);
}

function datetimeFix(obj) {
  const desc = state.cache[objectName];
  if (!desc) return;
  Object.keys(obj).forEach(k => {
    if (desc.fieldMap[k]?.type === "datetime" && obj[k] && !String(obj[k]).endsWith("Z")) obj[k] += "Z";
  });
}

function setBusy(btn, text)  { btn.disabled = true;  btn.textContent = text; }
function resetBtn(btn, text) { btn.disabled = false; btn.textContent = text; }
function humanize(s) { return s.replace(/SBQQ__|__c/g,"").replace(/([A-Z])/g," $1").trim(); }

function setStatus(msg, isError = false) {
  els.status.textContent = msg.toLowerCase();
  els.status.classList.toggle("error", isError);
}

async function rawQuery(soql) {
  return rest(`/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`);
}
async function query(soql) { return (await rawQuery(soql)).records || []; }

async function rest(path, options = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type:"sf-api", path, method:options.method, body:options.body, host:host||"https://login.salesforce.com" },
      r => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!r) return reject(new Error("no response from background"));
        if (!r.success) return reject(new Error(r.error));
        resolve(r.payload);
      }
    );
  });
}

function escapeHtml(v) {
  return String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function escapeAttribute(v) { return escapeHtml(v).replace(/`/g,"&#96;"); }
function coerceValue(v) {
  if (v === "") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v) && !isNaN(Number(v))) return Number(v);
  return v;
}
