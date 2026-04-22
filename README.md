# CPQ Fast Inspector

A lightweight Chrome extension for Salesforce CPQ admins. Browse objects, inspect records, edit fields inline, and drill into related records — without leaving the page or writing SOQL.

Works on any Salesforce org. CPQ-specific objects appear automatically when the `SBQQ` managed package is detected.

---

## Installation

**No build step.** Load the source folder directly into Chrome.

1. [Download or clone this repo](https://github.com/roh777/cpq-fast-inspector) to your machine
2. Open **`chrome://extensions`** in Chrome
3. Enable **Developer Mode** using the toggle in the top-right corner
4. Click **Load unpacked**
5. Select the `cpq-fast-inspector` folder
6. The extension icon will appear in your Chrome toolbar

> **After any code change** — go back to `chrome://extensions` and click the **↺** reload icon next to CPQ Fast Inspector.

---

## Getting started

1. Navigate to any **Salesforce Lightning** page in Chrome
2. Click the CPQ Fast Inspector icon in the toolbar, or look for the slim tab on the right edge of the page
3. The inspector panel slides open and reads your active Salesforce session automatically — no login or OAuth needed

---

## How to use

### Switching objects

Use the **object switcher** in the header bar to jump between any Salesforce object — Accounts, Products, CPQ Quotes, Price Rules, and more. Selecting a different object reloads the explorer for that object immediately.

If you open the explorer on an object not in the built-in list (e.g. a custom object from the side panel), it appears at the top of the switcher automatically.

### Searching and browsing records

The left panel shows the most recently modified records for the selected object. The search box filters by the object's name field in real time — so searching on Accounts filters by Account Name, on Products by Product Name, and so on.

Use the time filters to narrow results:
- **All** — most recently modified first
- **Oldest** — oldest modifications first
- **7d** — modified in the last 7 days

Click **load more** to page through large result sets.

### Inspecting and editing a record

Click any record in the list to open its detail view. Fields are arranged in a compact grid:

- **Editable fields** appear at the top — click any field to edit it
- **Read-only fields** appear below a divider, shown in muted text
- **Changed fields** highlight in amber so you can track your edits at a glance
- **Lookup fields** show the referenced record's name, not a raw ID — click to search and pick a different record with typeahead

When you're done editing, click **Save** — only the fields you actually changed are sent to Salesforce (PATCH, not full update).

Other actions in the toolbar:
| Action | What it does |
|---|---|
| **+ New** | Create a new record from scratch |
| **Clone** | Copy all editable fields from the current record into a new draft |
| **↗ SF** | Open the record directly in Salesforce Lightning |
| **Delete** | Permanently delete the record (asks for confirmation) |

### Related records

The **Related Records** panel shows all child relationships for the selected record with live counts. Relationships that have records are highlighted. Click any pill to open the **grid view** for that relationship.

Related list labels show the Salesforce object label (e.g. "Product Options") rather than the API or relationship name.

### Grid view

Opens related records as a dense, spreadsheet-style table. Everything is editable inline.

| Feature | How |
|---|---|
| **Sort** | Click any column header label — click again to reverse, third click clears sort |
| **Freeze a column** | Click **◇** on the column header — it becomes the first sticky column |
| **Reorder columns** | Drag any column header left or right |
| **Add / remove columns** | Click **⊞ Columns** to open the column picker |
| **Reset columns to page layout** | Click **⊡ Reset to Layout** inside the column picker |
| **Edit a cell** | Click directly — text, numbers, dates, picklists, and checkboxes all work inline |
| **Edit a lookup cell** | Click the name chip to open a search input with typeahead |
| **Drill into a record** | Click **→** on any row to open a full detail view for that record |
| **Save all changes** | Click **Save Changes** — only changed cells are PATCHed |
| **Open in Salesforce** | Click **↗** on any row |

Unsaved cells highlight in amber. Unsaved rows show an amber left border.

---

## Objects included

The object switcher includes the following out of the box:

**Standard**
- Accounts, Opportunities, Contacts
- Products (`Product2`), Pricebook Entries

**Salesforce CPQ (SBQQ)**
- Quotes, Quote Lines
- Product Options, Product Features, Config Attributes, Option Constraints
- Price Rules, Price Actions, Lookup Queries, Summary Variables
- Discount Schedules, Discount Tiers
- Quote Templates, Custom Actions, Quote Terms, Quote Process

Any object opened from the side panel (including custom objects not in this list) is automatically added to the switcher for that session.

---

## Architecture

```
background.js        Service Worker — API proxy
content.js           Content Script — side panel injected into Salesforce pages
records.html/.js     Full-page record explorer (opened in a new tab)
```

**background.js** extracts the Salesforce session cookie (`sid`) from Chrome's cookie store and proxies all REST and SOQL requests to the `.my.salesforce.com` API domain. This bypasses Lightning's cross-origin restrictions with no OAuth flow.

**content.js** mounts a floating side panel into the page DOM, detects SBQQ package presence, and renders the object list.

**records.js** drives the full-page explorer — describes objects, runs SOQL, renders the editable form, manages the grid view with per-object column state, sort, pin, and dirty tracking.

---

## Notes

- **No build step** — plain JS, HTML, and CSS. Edit a file, reload the extension, done.
- **Auth is automatic** — the session cookie (`sid`) is used as a Bearer token, the same way your browser authenticates. No passwords or tokens to manage.
- **Nothing leaves your machine** — all API calls go directly from your browser to your Salesforce org.
- **Safe by default** — the extension never writes to Salesforce unless you explicitly click Save, Create, or Delete.
