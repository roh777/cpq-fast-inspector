const API_VERSION = "v60.0";
const params = new URLSearchParams(window.location.search);
const host = params.get("host") || "";
const objectName = params.get("object") || "Product2";
const initialRecordId = params.get("recordId") || "";

const SKIP_FIELDS = new Set(["CreatedById","LastModifiedById","SystemModstamp","IsDeleted","MasterRecordId"]);
const SKIP_TYPES  = new Set(["address","location","anyType","base64"]);
const SKIP_CHILD  = /Feed$|Share$|History$|ChangeEvent$|OwnerSharingRule$|__Tag$|AttachedContentDocument$|CombinedAttachment$|NoteAndAttachment$|OpenActivity$|ActivityHistory$|ProcessInstance$|ContentDocumentLink$/;

let timeFilter = "";
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

// Grid navigation state — replaces modal
const gridNav = {
  stack: [],        // Array of frame objects
  colState: {},     // { [objectName]: string[] } — active column order per object
  pickerOpen: false,
};

const els = {
  title:    document.getElementById("title"),
  subtitle: document.getElementById("subtitle"),
  status:   document.getElementById("status"),
  filter:   document.getElementById("filter"),
  refresh:  document.getElementById("refresh"),
  save:     document.getElementById("save"),
  del:      document.getElementById("delete"),
  clone:    document.getElementById("clone"),
  openSF:   document.getElementById("openSF"),
  newBtn:   document.getElementById("newRecord"),
  loadMore: document.getElementById("loadMore"),
  listMeta: document.getElementById("listMeta"),
  recordList:     document.getElementById("recordList"),
  recordForm:     document.getElementById("recordForm"),
  relatedRecords: document.getElementById("relatedRecords"),
  recordsView:    document.getElementById("recordsView"),
  gridView:       document.getElementById("gridView"),
  gridCrumb:      document.getElementById("gridCrumb"),
  gridStatus:     document.getElementById("gridStatus"),
  colPickerBtn:   document.getElementById("colPickerBtn"),
  gridSave:       document.getElementById("gridSave"),
  colPickerPanel: document.getElementById("colPickerPanel"),
  colSearch:      document.getElementById("colSearch"),
  loadLayoutBtn:  document.getElementById("loadLayoutBtn"),
  colPickerList:  document.getElementById("colPickerList"),
  gridBody:       document.getElementById("gridBody"),
};

boot();

// ── Boot ─────────────────────────────────────────────────────────────────

async function boot() {
  els.title.textContent = humanize(objectName);
  els.subtitle.textContent = host ? new URL(host).hostname.replace(".my.salesforce.com","") : "";
  if (!host) { setStatus("missing host — reopen from inspector panel", true); return; }

  els.filter.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(loadRecords, 350);
  });
  els.refresh.addEventListener("click", loadRecords);
  els.save.addEventListener("click", saveRecord);
  els.del.addEventListener("click", deleteRecord);
  els.newBtn.addEventListener("click", startNew);
  els.clone.addEventListener("click", cloneRecord);
  els.loadMore.addEventListener("click", loadMore);

  document.querySelectorAll(".tf").forEach(btn =>
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tf").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      timeFilter = btn.dataset.tf;
      loadRecords();
    })
  );

  // Grid view events
  els.colPickerBtn.addEventListener("click", toggleColPicker);
  els.gridSave.addEventListener("click", saveGridChanges);
  els.loadLayoutBtn.addEventListener("click", applyLayoutFields);
  els.colSearch.addEventListener("input", () => {
    const frame = gridNav.stack[gridNav.stack.length - 1];
    if (frame?.type === "TABLE") renderColPicker(frame.objectName, frame.desc);
  });

  setStatus("loading...");
  await loadRecords();
  if (initialRecordId) await loadSelectedRecord(initialRecordId);
}

// ── Record list loading ───────────────────────────────────────────────────

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
  showRecordsView();
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
  showRecordsView();
  renderList(); renderForm(); renderRelated();
}

function cloneRecord() {
  if (!state.selected) return;
  const desc = state.cache[objectName];
  if (!desc) return;
  const cloned = {};
  desc.fields.forEach(f => {
    if (f.updateable && state.selected[f.name] != null) cloned[f.name] = state.selected[f.name];
  });
  state.selected = null; state.inputValues = cloned; state.isNew = true; state.relatedGroups = [];
  showRecordsView();
  renderList(); renderForm(); renderRelated();
  setStatus("cloned — edit and click create");
}

// ── CRUD ──────────────────────────────────────────────────────────────────

async function saveRecord() {
  if (state.isNew) { await createRecord(); return; }
  if (!state.selected?.Id) return;
  const changes = Object.fromEntries(
    Object.entries(state.inputValues).filter(([k,v]) => state.selected[k] !== v)
  );
  if (!Object.keys(changes).length) { setStatus("no changes"); return; }
  datetimeFix(changes, objectName);
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
  datetimeFix(payload, objectName);
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

// ── Describe + config ─────────────────────────────────────────────────────

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
  const editable   = desc.fields.filter(f => f.name !== "Id" && f.updateable && !SKIP_TYPES.has(f.type));
  const readOnly   = desc.fields.filter(f => f.name !== "Id" && !f.updateable && !SKIP_FIELDS.has(f.name) && !SKIP_TYPES.has(f.type));
  const detailFields = ["Id", ...editable.map(f => f.name), ...readOnly.map(f => f.name)];
  return (desc._cfg = { listFields, detailFields });
}

// All editable fields suitable as grid columns
function getTableCols(desc) {
  return desc.fields
    .filter(f => f.updateable && !SKIP_FIELDS.has(f.name) && !SKIP_TYPES.has(f.type) && f.type !== "textarea")
    .map(f => f.name);
}

// ── Related groups ────────────────────────────────────────────────────────

function initRelatedGroups(desc) {
  const all = desc.childRelationships
    .filter(r => r.relationshipName && !SKIP_CHILD.test(r.childSObject));
  all.sort((a, b) => {
    const aS = a.childSObject.startsWith("SBQQ__") ? 0 : 1;
    const bS = b.childSObject.startsWith("SBQQ__") ? 0 : 1;
    if (aS !== bS) return aS - bS;
    return a.relationshipName.localeCompare(b.relationshipName);
  });
  state.relatedGroups = all.map(r => ({ ...r, count: null }));
  renderRelated();
  loadRelatedCounts(state.selected.Id);
}

function loadRelatedCounts(parentId) {
  state.relatedGroups.forEach((g, i) => {
    rawQuery(`SELECT COUNT() FROM ${g.childSObject} WHERE ${g.field} = '${parentId}'`)
      .then(r => {
        if (!state.relatedGroups[i]) return;
        state.relatedGroups[i].count = r.totalSize;
        renderRelated();
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

async function resolveLookupsForRecords(records, desc) {
  const byObj = {};
  desc.fields.filter(f => f.type === "reference").forEach(f => {
    const t = f.referenceTo?.[0];
    if (!t) return;
    records.forEach(r => {
      if (r[f.name] && !state.lookupNames[r[f.name]]) (byObj[t] ||= new Set()).add(r[f.name]);
    });
  });
  await Promise.allSettled(Object.entries(byObj).map(async ([obj, ids]) => {
    const recs = await query(`SELECT Id, Name FROM ${obj} WHERE Id IN (${[...ids].map(id=>`'${id}'`).join(",")})`)
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

function renderFieldSections(fields, desc, rec, inputValues, creating) {
  const editableHtml = [];
  const readOnlyHtml = [];
  fields.forEach(field => {
    const meta  = desc.fieldMap[field];
    const orig  = rec?.[field] ?? null;
    const cur   = inputValues[field] ?? null;
    const dirty = !creating && orig !== cur;
    const html  = `<div class="field${dirty ? " field-dirty" : ""}">${renderInput(field, cur, meta)}</div>`;
    if (field === "Id" || !meta?.updateable) readOnlyHtml.push(html);
    else editableHtml.push(html);
  });
  const divider = readOnlyHtml.length
    ? `<div class="fields-ro-divider">Read-only fields</div>`
    : "";
  return editableHtml.join("") + divider + readOnlyHtml.join("");
}

function renderForm() {
  const creating = state.isNew;
  const rec = state.selected;
  els.save.textContent = creating ? "create" : "save";
  els.del.disabled = !rec || creating;
  els.del.style.display = creating ? "none" : "";
  if (rec && !creating && host) {
    els.openSF.href = `${host}/lightning/r/${objectName}/${rec.Id}/view`;
    els.openSF.style.display = "";
    els.clone.style.display = "";
  } else {
    els.openSF.style.display = "none";
    els.clone.style.display = "none";
  }

  if (!rec && !creating) {
    els.recordForm.innerHTML = "<div class=\"meta\" style=\"padding:10px\">select a record or click + New</div>";
    return;
  }
  const desc = state.cache[objectName];
  if (!desc) { els.recordForm.innerHTML = "<div class=\"meta\" style=\"padding:10px\">loading...</div>"; return; }

  const cfg = deriveConfig(desc);
  const fields = creating
    ? cfg.detailFields.filter(f => f !== "Id")
    : cfg.detailFields.filter(f => f in rec);

  els.recordForm.innerHTML = renderFieldSections(fields, desc, rec, state.inputValues, creating);
  wireFormEvents(els.recordForm, desc, state.inputValues, rec);
}

function renderRelated() {
  if (!state.selected || state.isNew) { els.relatedRecords.innerHTML = "<div class=\"meta\" style=\"padding:10px\">—</div>"; return; }
  if (!state.relatedGroups.length)    { els.relatedRecords.innerHTML = "<div class=\"meta\" style=\"padding:10px\">none</div>"; return; }

  const cpq = [], std = [];
  state.relatedGroups.forEach((g, i) =>
    (g.childSObject.startsWith("SBQQ__") ? cpq : std).push({ g, i })
  );

  const sortBucket = arr => [...arr].sort((a, b) => {
    const rank = x => x.g.count > 0 ? 0 : x.g.count === 0 ? 1 : 2;
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (a.g.count !== null && b.g.count !== null && a.g.count !== b.g.count)
      return b.g.count - a.g.count;
    return a.g.relationshipName.localeCompare(b.g.relationshipName);
  });

  const pillHtml = ({ g, i }) => {
    const hasRecs = g.count > 0;
    const pending = g.count === null;
    return `<div class="rel-group${hasRecs ? " rel-has-records" : ""}${pending ? " rel-pending" : ""}">
      <div class="rel-head" data-idx="${i}">
        <span class="rel-name">${escapeHtml(g.relationshipName)}</span>
        <span class="rel-badge">${pending ? "…" : g.count}</span>
      </div>
    </div>`;
  };

  let html = "";
  if (cpq.length) {
    html += `<div class="rel-group-header">CPQ</div>`;
    html += sortBucket(cpq).map(pillHtml).join("");
  }
  if (std.length) {
    if (cpq.length) html += `<div class="rel-group-header">Standard</div>`;
    html += sortBucket(std).map(pillHtml).join("");
  }

  els.relatedRecords.innerHTML = html;
  els.relatedRecords.querySelectorAll("[data-idx]").forEach(h =>
    h.addEventListener("click", () => openGridView(+h.dataset.idx))
  );
}

// ── Field rendering ───────────────────────────────────────────────────────

function renderInput(field, value, meta) {
  const ro = field === "Id" || !meta?.updateable;
  const a = `data-field="${escapeHtml(field)}"`;
  const v = value ?? "";
  const type = meta?.type;
  const lbl = `<label>${escapeHtml(meta?.label || field)}</label>`;

  if (ro) {
    const display = (type === "reference" && state.lookupNames[v]) ? state.lookupNames[v] : String(v);
    return `${lbl}<input ${a} value="${escapeAttribute(display)}" readonly class="field-ro">`;
  }
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

// Compact cell input for the grid table (no label)
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
  if (type === "reference") {
    const name = state.lookupNames[v] || "";
    return `<div class="lookup-wrap"><input ${a} value="${escapeAttribute(String(v))}" placeholder="${escapeAttribute(meta?.referenceTo?.[0] || "ID")}">${name ? `<span class="lookup-name">${escapeHtml(name)}</span>` : ""}</div>`;
  }
  return `<input ${a} value="${escapeAttribute(String(v))}">`;
}

function wireFormEvents(container, desc, inputValues, originalRecord) {
  container.querySelectorAll("[data-field]").forEach(el => {
    const field = el.dataset.field;
    const meta  = desc.fieldMap[field];
    if (el.readOnly || el.disabled || field === "Id") return;
    const ev = el.type === "checkbox" ? "change" : "input";
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

// ══════════════════════════════════════════════════════════════════════════
// GRID VIEW — full-panel spreadsheet navigation
// ══════════════════════════════════════════════════════════════════════════

function showGridView() {
  els.recordsView.style.display = "none";
  els.gridView.style.display = "flex";
}

function showRecordsView() {
  gridNav.stack = [];
  gridNav.pickerOpen = false;
  els.recordsView.style.display = "";
  els.gridView.style.display = "none";
  els.colPickerPanel.style.display = "none";
  els.colPickerBtn.classList.remove("active");
}

async function openGridView(groupIdx) {
  const g = state.relatedGroups[groupIdx];
  if (!g || !state.selected) return;
  gridNav.stack = [];
  const parentLabel = state.selected.Name || state.selected.Id;
  await pushGridTableFrame(g.childSObject, g.field, g.relationshipName, state.selected.Id, parentLabel);
  showGridView();
}

async function pushGridTableFrame(childObj, parentField, relationName, parentId, parentLabel) {
  els.gridStatus.textContent = "loading…";
  els.colPickerBtn.style.display = "none";
  els.gridSave.style.display = "none";

  try {
    const desc = await describe(childObj);
    const allCols = getTableCols(desc);

    // Determine active columns: use saved state, or load from page layout, or fallback to first 8
    if (!gridNav.colState[childObj]) {
      const layoutFields = await loadLayoutFields(childObj);
      if (layoutFields?.length) {
        const editableSet = new Set(allCols);
        const layoutCols = layoutFields.filter(f => editableSet.has(f));
        gridNav.colState[childObj] = layoutCols.length ? layoutCols.slice(0, 12) : allCols.slice(0, 8);
      } else {
        gridNav.colState[childObj] = allCols.slice(0, 8);
      }
    }

    const activeCols = gridNav.colState[childObj];
    const nameField = desc.fields.find(f => f.nameField)?.name || "Name";
    const queryFields = ["Id", ...(desc.fieldMap[nameField] ? [nameField] : []), ...activeCols.filter(c => c !== nameField)];
    const recs = await query(
      `SELECT ${[...new Set(queryFields)].join(",")} FROM ${childObj} WHERE ${parentField} = '${parentId}' ORDER BY LastModifiedDate DESC LIMIT 200`
    );
    await resolveLookupsForRecords(recs, desc);

    gridNav.stack.push({
      type: "TABLE",
      label: relationName,
      parentLabel,
      objectName: childObj,
      parentField,
      parentId,
      nameField,
      records: recs,
      desc,
      inputValues: Object.fromEntries(recs.map(r => [r.Id, { ...r }])),
    });
    renderGridView();
    els.gridStatus.textContent = `${recs.length} record${recs.length !== 1 ? "s" : ""}`;
  } catch(e) {
    els.gridStatus.textContent = e.message;
  }
}

async function pushGridDetailFrame(objName, recordId, recordLabel) {
  els.gridStatus.textContent = "loading…";
  els.colPickerBtn.style.display = "none";

  try {
    const desc = await describe(objName);
    const cfg  = deriveConfig(desc);
    const [record] = await query(
      `SELECT ${cfg.detailFields.join(",")} FROM ${objName} WHERE Id = '${recordId}' LIMIT 1`
    );
    if (!record) { els.gridStatus.textContent = "record not found"; return; }

    const relatedGroups = desc.childRelationships
      .filter(r => r.relationshipName && !SKIP_CHILD.test(r.childSObject))
      .slice(0, 24)
      .map(r => ({ ...r, count: null }));

    gridNav.stack.push({ type:"DETAIL", label:recordLabel, objectName:objName, record, desc, inputValues:{...record}, relatedGroups });
    renderGridView();
    els.gridStatus.textContent = "";

    // Load related counts async
    relatedGroups.forEach((g, i) => {
      rawQuery(`SELECT COUNT() FROM ${g.childSObject} WHERE ${g.field} = '${recordId}'`)
        .then(r => {
          relatedGroups[i].count = r.totalSize;
          const badge = els.gridBody.querySelector(`[data-rel-badge="${i}"]`);
          if (badge) badge.textContent = r.totalSize;
          const pill = badge?.closest(".rel-group");
          if (pill) {
            pill.classList.toggle("rel-has-records", r.totalSize > 0);
            pill.classList.remove("rel-pending");
          }
        }).catch(() => {});
    });

    // Resolve lookups
    resolveLookups(record, desc).then(() => {
      desc.fields.filter(f => f.type === "reference" && record[f.name]).forEach(f => {
        const name = state.lookupNames[record[f.name]];
        if (!name) return;
        const inp = els.gridBody.querySelector(`[data-field="${f.name}"]`);
        if (!inp) return;
        const wrap = inp.closest(".lookup-wrap");
        if (!wrap) return;
        let span = wrap.querySelector(".lookup-name");
        if (!span) { span = document.createElement("span"); span.className = "lookup-name"; wrap.appendChild(span); }
        span.textContent = name;
      });
    });
  } catch(e) {
    els.gridStatus.textContent = e.message;
  }
}

function renderGridView() {
  const frame = gridNav.stack[gridNav.stack.length - 1];
  if (!frame) { showRecordsView(); return; }

  // Build breadcrumb
  els.gridCrumb.innerHTML = "";

  // Root crumb: parent record name → clicking returns to records view
  const rootLabel = state.selected?.Name || state.selected?.Id || objectName;
  const rootEl = document.createElement("span");
  rootEl.className = "crumb";
  rootEl.textContent = rootLabel;
  rootEl.title = "Back to record";
  rootEl.addEventListener("click", showRecordsView);
  els.gridCrumb.appendChild(rootEl);

  gridNav.stack.forEach((f, i) => {
    const sep = document.createElement("span");
    sep.className = "crumb-sep";
    sep.textContent = "›";
    els.gridCrumb.appendChild(sep);

    const el = document.createElement("span");
    const isLast = i === gridNav.stack.length - 1;
    el.className = `crumb${isLast ? " crumb-active" : ""}`;
    el.textContent = f.label;
    if (!isLast) {
      el.addEventListener("click", () => {
        gridNav.stack.splice(i + 1);
        // Close picker if switching frames
        if (gridNav.pickerOpen) toggleColPicker();
        renderGridView();
      });
    }
    els.gridCrumb.appendChild(el);
  });

  if (frame.type === "TABLE") {
    renderGridTable(frame);
  } else {
    renderGridDetail(frame);
  }
}

function renderGridTable(frame) {
  const { records, desc, inputValues, objectName: childObj, nameField } = frame;
  const activeCols = gridNav.colState[childObj] || getTableCols(desc).slice(0, 8);

  els.colPickerBtn.style.display = "";
  els.gridSave.style.display = "";

  if (!records.length) {
    els.gridBody.innerHTML = `<div class="grid-empty">No records in this relationship.</div>`;
    els.colPickerBtn.style.display = "none";
    els.gridSave.style.display = "none";
    return;
  }

  const thead = `<tr class="grid-thead-row">
    <th class="col-th-name">${escapeHtml(desc.fieldMap[nameField]?.label || "Name")}</th>
    ${activeCols.map(c =>
      `<th class="col-th" title="${escapeHtml(c)}">${escapeHtml(desc.fieldMap[c]?.label || humanize(c))}</th>`
    ).join("")}
    <th class="col-th"></th>
  </tr>`;

  const tbody = records.map(r => {
    const vals = inputValues[r.Id];
    const rowDirty = activeCols.some(c => vals[c] !== r[c]);
    const cells = activeCols.map(c => {
      const dirty = vals[c] !== r[c];
      return `<td class="grid-cell${dirty ? " cell-dirty" : ""}">${renderCellInput(r.Id, c, vals[c], desc.fieldMap[c])}</td>`;
    });
    const sfHref = host ? `${host}/lightning/r/${escapeHtml(childObj)}/${escapeHtml(r.Id)}/view` : "#";
    return `<tr class="grid-row${rowDirty ? " row-dirty" : ""}" data-row-id="${escapeHtml(r.Id)}">
      <td class="grid-name-cell" title="${escapeHtml(r[nameField] || r.Id)}">${escapeHtml(r[nameField] || r.Id)}</td>
      ${cells.join("")}
      <td class="grid-action-cell">
        ${host ? `<a class="sf-link" href="${sfHref}" target="_blank" title="Open in Salesforce">↗</a>` : ""}
        <button class="drill-btn" data-id="${escapeHtml(r.Id)}" data-name="${escapeHtml(r[nameField]||r.Id)}" data-obj="${escapeHtml(childObj)}" title="View record detail">→</button>
      </td>
    </tr>`;
  }).join("");

  els.gridBody.innerHTML = `<div class="grid-table-wrap"><table class="grid-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`;

  // Wire cell change events
  els.gridBody.querySelectorAll("[data-record]").forEach(input => {
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
      input.closest("td")?.classList.toggle("cell-dirty", orig !== val);
      const row = input.closest("tr[data-row-id]");
      if (row) {
        const cols = gridNav.colState[frame.objectName] || [];
        const rec  = frame.records.find(r => r.Id === rid);
        row.classList.toggle("row-dirty", cols.some(c => frame.inputValues[rid]?.[c] !== rec?.[c]));
      }
    });
  });

  // Drill-in buttons
  els.gridBody.querySelectorAll(".drill-btn").forEach(btn =>
    btn.addEventListener("click", () =>
      pushGridDetailFrame(btn.dataset.obj, btn.dataset.id, btn.dataset.name)
    )
  );

  // Re-render col picker if it's open
  if (gridNav.pickerOpen) renderColPicker(childObj, desc);
}

function renderGridDetail(frame) {
  const { record, desc, inputValues, relatedGroups, objectName: obj } = frame;
  const cfg    = deriveConfig(desc);
  const fields = cfg.detailFields.filter(f => f in record);

  els.colPickerBtn.style.display = "none";
  els.gridSave.style.display = "";

  const sfHref = host ? `${host}/lightning/r/${escapeHtml(obj)}/${escapeHtml(record.Id)}/view` : null;
  const sfLink = sfHref ? `<a href="${sfHref}" target="_blank" class="sf-link" style="display:inline-flex;align-items:center;padding:3px 8px;font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);border:1px solid var(--border);border-radius:4px;text-decoration:none;margin-left:auto">↗ SF</a>` : "";

  const cpq = [], std = [];
  relatedGroups.forEach((g, i) =>
    (g.childSObject.startsWith("SBQQ__") ? cpq : std).push({ g, i })
  );
  const sortBucket = arr => [...arr].sort((a, b) => {
    const rank = x => x.g.count > 0 ? 0 : x.g.count === 0 ? 1 : 2;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return a.g.relationshipName.localeCompare(b.g.relationshipName);
  });
  const pillHtml = ({ g, i }) =>
    `<div class="rel-group${g.count > 0 ? " rel-has-records" : ""}${g.count === null ? " rel-pending" : ""}">
      <div class="rel-head" data-detail-rel="${i}">
        <span class="rel-name">${escapeHtml(g.relationshipName)}</span>
        <span class="rel-badge" data-rel-badge="${i}">${g.count === null ? "…" : g.count}</span>
      </div>
    </div>`;

  let relHtml = "";
  if (relatedGroups.length) {
    const cpqHtml = cpq.length ? `<div class="rel-group-header">CPQ</div>${sortBucket(cpq).map(pillHtml).join("")}` : "";
    const stdHtml = std.length ? `${cpq.length ? '<div class="rel-group-header">Standard</div>' : ""}${sortBucket(std).map(pillHtml).join("")}` : "";
    relHtml = `<div class="grid-section-head">Related Records</div>
      <div class="grid-detail-pills">${cpqHtml}${stdHtml}</div>`;
  }

  els.gridBody.innerHTML = `
    <div class="grid-detail-wrap">
      <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--border);background:#f8fafc;flex-shrink:0">
        <span style="font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)">${escapeHtml(obj.replace(/SBQQ__|__c/g,""))}</span>
        ${sfLink}
      </div>
      <div class="grid-detail-form">${renderFieldSections(fields, desc, record, inputValues, false)}</div>
      <div class="grid-detail-related">${relHtml}</div>
    </div>`;

  wireFormEvents(els.gridBody, desc, inputValues, record);

  els.gridBody.querySelectorAll("[data-detail-rel]").forEach(h =>
    h.addEventListener("click", () => {
      const g = frame.relatedGroups[+h.dataset.detailRel];
      if (g) pushGridTableFrame(g.childSObject, g.field, g.relationshipName, record.Id, frame.label);
    })
  );
}

// ── Save grid changes ─────────────────────────────────────────────────────

async function saveGridChanges() {
  const frame = gridNav.stack[gridNav.stack.length - 1];
  if (!frame) return;
  setBusy(els.gridSave, "saving…");
  let saved = 0, errors = 0;

  if (frame.type === "TABLE") {
    const activeCols = gridNav.colState[frame.objectName] || [];
    const dirty = frame.records.map(r => {
      const changes = Object.fromEntries(
        activeCols
          .filter(c => frame.inputValues[r.Id]?.[c] !== r[c])
          .map(c => [c, frame.inputValues[r.Id][c]])
      );
      return Object.keys(changes).length ? { id: r.Id, changes } : null;
    }).filter(Boolean);

    await Promise.allSettled(dirty.map(async ({ id, changes }) => {
      try {
        datetimeFix(changes, frame.objectName);
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
      datetimeFix(changes, frame.objectName);
      try {
        await rest(`/services/data/${API_VERSION}/sobjects/${frame.objectName}/${frame.record.Id}`, { method:"PATCH", body:changes });
        Object.assign(frame.record, changes);
        saved++;
      } catch { errors++; }
    }
  }

  const msg = errors ? `${saved} saved, ${errors} failed` : `${saved} saved`;
  els.gridStatus.textContent = msg;
  resetBtn(els.gridSave, "Save Changes");
  renderGridView();
}

// ── Column picker ─────────────────────────────────────────────────────────

function toggleColPicker() {
  gridNav.pickerOpen = !gridNav.pickerOpen;
  els.colPickerBtn.classList.toggle("active", gridNav.pickerOpen);
  if (gridNav.pickerOpen) {
    const frame = gridNav.stack[gridNav.stack.length - 1];
    if (frame?.type === "TABLE") {
      renderColPicker(frame.objectName, frame.desc);
      els.colPickerPanel.style.display = "";
    }
  } else {
    els.colPickerPanel.style.display = "none";
    els.colSearch.value = "";
  }
}

function renderColPicker(objName, desc) {
  const allCols   = getTableCols(desc);
  const activeCols = new Set(gridNav.colState[objName] || []);
  const search    = els.colSearch.value.trim().toLowerCase();

  const filtered = search
    ? allCols.filter(c => {
        const label = (desc.fieldMap[c]?.label || c).toLowerCase();
        return label.includes(search) || c.toLowerCase().includes(search);
      })
    : allCols;

  els.colPickerList.innerHTML = filtered.map(c => {
    const label   = desc.fieldMap[c]?.label || humanize(c);
    const active  = activeCols.has(c);
    return `<label class="col-pick-row${active ? " active-col" : ""}">
      <input type="checkbox" data-col="${escapeHtml(c)}"${active ? " checked" : ""}>
      <span class="col-pick-label">${escapeHtml(label)}</span>
      <span class="col-pick-name">${escapeHtml(c)}</span>
    </label>`;
  }).join("");

  els.colPickerList.querySelectorAll("[data-col]").forEach(cb => {
    cb.addEventListener("change", () => {
      const col    = cb.dataset.col;
      const active = new Set(gridNav.colState[objName] || []);
      if (cb.checked) active.add(col);
      else active.delete(col);
      // Preserve original order from allCols
      gridNav.colState[objName] = allCols.filter(c => active.has(c));
      cb.closest(".col-pick-row")?.classList.toggle("active-col", cb.checked);

      const frame = gridNav.stack[gridNav.stack.length - 1];
      if (frame?.type === "TABLE") {
        // If new column isn't in existing records data, re-query
        const needsRequery = cb.checked && frame.records.length > 0 && !(col in frame.records[0]);
        if (needsRequery) {
          reQueryGridTable(frame);
        } else {
          const prevStatus = els.gridStatus.textContent;
          renderGridTable(frame);
          els.gridStatus.textContent = prevStatus;
          if (gridNav.pickerOpen) renderColPicker(objName, desc);
        }
      }
    });
  });
}

async function reQueryGridTable(frame) {
  const { objectName: childObj, parentField, parentId, desc, nameField } = frame;
  const activeCols  = gridNav.colState[childObj] || [];
  const queryFields = ["Id", ...(desc.fieldMap[nameField] ? [nameField] : []), ...activeCols.filter(c => c !== nameField)];

  els.gridStatus.textContent = "loading…";
  try {
    const recs = await query(
      `SELECT ${[...new Set(queryFields)].join(",")} FROM ${childObj} WHERE ${parentField} = '${parentId}' ORDER BY LastModifiedDate DESC LIMIT 200`
    );
    await resolveLookupsForRecords(recs, desc);
    // Merge: preserve dirty input values for fields that were already loaded
    recs.forEach(r => {
      const existing = frame.inputValues[r.Id];
      frame.inputValues[r.Id] = existing ? { ...r, ...existing } : { ...r };
    });
    frame.records = recs;
    renderGridTable(frame);
    els.gridStatus.textContent = `${recs.length} record${recs.length !== 1 ? "s" : ""}`;
    if (gridNav.pickerOpen) renderColPicker(childObj, desc);
  } catch(e) {
    els.gridStatus.textContent = e.message;
  }
}

// ── Page layout field loading ─────────────────────────────────────────────

async function loadLayoutFields(objName) {
  try {
    const res = await rest(`/services/data/${API_VERSION}/sobjects/${objName}/describe/layouts/`);
    const layouts = res.layouts || [];
    const layout  = layouts.find(l => l.layoutType === "Full") || layouts[0];
    if (!layout) return null;
    const fields = [];
    const extractSection = sec => {
      for (const row of sec.layoutRows || []) {
        for (const item of row.layoutItems || []) {
          for (const comp of item.layoutComponents || []) {
            if (comp.type === "Field" && comp.value && comp.value !== "EmptySpace") fields.push(comp.value);
          }
        }
      }
    };
    for (const sec of layout.detailLayoutSections || []) extractSection(sec);
    return [...new Set(fields)];
  } catch { return null; }
}

async function applyLayoutFields() {
  const frame = gridNav.stack[gridNav.stack.length - 1];
  if (frame?.type !== "TABLE") return;
  const { objectName: childObj, desc } = frame;

  setBusy(els.loadLayoutBtn, "loading…");
  try {
    const layoutFields = await loadLayoutFields(childObj);
    if (!layoutFields?.length) {
      els.gridStatus.textContent = "no layout found";
      return;
    }
    const allCols    = new Set(getTableCols(desc));
    const layoutCols = layoutFields.filter(f => allCols.has(f));
    if (!layoutCols.length) {
      els.gridStatus.textContent = "no editable layout fields";
      return;
    }
    gridNav.colState[childObj] = layoutCols.slice(0, 14);
    els.gridStatus.textContent = `layout: ${layoutCols.length} fields`;
    await reQueryGridTable(frame);
  } catch(e) {
    els.gridStatus.textContent = e.message;
  } finally {
    resetBtn(els.loadLayoutBtn, "⊡ Reset to Layout");
  }
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

function datetimeFix(obj, objName = objectName) {
  const desc = state.cache[objName];
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
