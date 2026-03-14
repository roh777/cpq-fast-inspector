# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**CPQ Fast Inspector** is a Chrome Extension (Manifest V3) for Salesforce CPQ administrators. It provides a side-panel inspector for exploring and editing Salesforce CPQ objects directly within Salesforce pages.

## Installation & Loading

No build process — load the extension directly:
1. Open `chrome://extensions`
2. Enable Developer Mode
3. Click "Load unpacked" → select this directory

After editing any file, reload the extension from `chrome://extensions`.

## Architecture

Three-component architecture:

```
background.js (Service Worker)
    ↑↓ messages
content.js (Content Script — injected into Salesforce pages)
    → opens →
records.html + records.js (Full-page record explorer)
```

**background.js** — Service worker acting as API proxy. Handles two message types:
- `open-tab`: Opens `records.html` with object context in URL params
- `sf-api`: Proxies all REST/SOQL calls to Salesforce API, extracting the session cookie (`sid`) from Chrome's cookie store and converting Lightning domains (`.lightning.force.com`) to API domains (`.my.salesforce.com`)

**content.js** — Mounts a floating side panel into the Salesforce page DOM. Detects if SBQQ (CPQ package) is installed by querying the org, then renders a static list of core CPQ objects plus dynamic SBQQ-specific objects. All Salesforce API calls go through `background.js`.

**records.js** — Full-page record explorer. On load it reads `?object=` and `?host=` URL params, runs SOQL queries via `background.js`, renders a filterable record list, loads record detail fields, and supports inline editing with dirty-state tracking (yellow highlight). Saves send PATCH requests through background.

## Key Configuration Points

**CPQ_OBJECTS** (`content.js` lines 10–24): Static list of objects shown in the side panel. Add new objects here.

**OBJECT_CONFIG** (`records.js` lines 3–22): Per-object configuration for which fields to show, sort order, record limit, and related record definitions. Objects not in this map fall back to defaults. Currently only `Product2` and `SBQQ__ProductOption__c` have full configs with related records.

**manifest.json**: Host permissions cover `*.salesforce.com`, `*.force.com`, and `*.lightning.force.com`. Add new domains here if supporting additional Salesforce cloud types.

## Auth & Cross-Origin

The extension bypasses Salesforce Lightning's cross-origin restrictions by routing all API calls through `background.js`. The service worker extracts the Salesforce session cookie using Chrome's Cookies API with a multi-step fallback: exact domain → current hostname → any `*.salesforce.com` sid → any session cookie. The extracted `sid` is used as a Bearer token in REST calls.
