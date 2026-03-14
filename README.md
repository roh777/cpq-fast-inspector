# CPQ Fast Inspector

Minimal Chrome extension for Salesforce CPQ admins who want a side-hover inspector like Salesforce Inspector, but focused on object exploration, related records, and quick inline edits.

## What it does

- Opens as a side inspector inside the Salesforce page when you click the extension icon.
- Uses a background service worker and Chrome's native Cookies API to proxy REST requests, ensuring bulletproof authentication bypassing Lightning cross-origin limits.
- Checks whether the `SBQQ` managed package is installed.
- Lets you explore core CPQ and product-related objects without writing SOQL.
- Loads up to 1000 records for the selected object.
- Lets you select a record, inspect editable fields, and fetch related records.
- Opens a dedicated full-page tab for the current object when you want more space.
- Shows as a slim sticky launcher on the page edge and slides out on click.

## Included object coverage

The side inspector starts with a practical CPQ set such as:

- `Product2`
- `PricebookEntry`
- `SBQQ__ProductOption__c`
- `SBQQ__ProductFeature__c`
- `SBQQ__ConfigurationAttribute__c`
- `SBQQ__OptionConstraint__c`
- `SBQQ__PriceRule__c`
- `SBQQ__PriceAction__c`
- `SBQQ__DiscountSchedule__c`
- `SBQQ__DiscountTier__c`

It also adds a few more common CPQ objects dynamically when SBQQ is detected.

## Load it in Chrome

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Click **Load unpacked**.
4. Select `/Users/rohityadav/Desktop/cpqconfig`.

## How to use

1. Open a Salesforce org tab in Chrome.
2. Click the extension icon.
3. The inspector appears on the right side of the page.
4. It reads the current tab session and validates SBQQ presence.
5. Choose an object from the dropdown.
6. Select a record to inspect details and related records.
7. Edit fields inline and save.
8. Use `Open Tab` when you want a larger editable workspace.

## Notes

- This is intentionally lean and CPQ-focused, not a full Salesforce Inspector clone.
- Auth proxies directly through Chrome's background worker using the raw `sid` or `session` cookies exactly like the browser itself does, avoiding Lightning vs API domain mismatch issues.
- Related-record coverage is configured object-by-object; `Product2` has the richest related view right now and other CPQ objects can be expanded the same way.
