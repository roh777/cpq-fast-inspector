chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) {
    return;
  }

  await chrome.tabs.sendMessage(tab.id, { type: "cpq-fast-inspector-toggle" }).catch(() => {
    return chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "open-tab") {
    const url = chrome.runtime.getURL(`records.html?object=${encodeURIComponent(message.object)}&host=${encodeURIComponent(message.host)}${message.recordId ? "&recordId=" + encodeURIComponent(message.recordId) : ""}`);
    chrome.tabs.create({ url });
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "sf-api") {
    handleApi(message, sender).then(sendResponse).catch((err) => {
      console.error("API Error", err);
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
});

async function handleApi(message, sender) {
  const sourceUrl = message.host || (sender.tab ? sender.tab.url : "");
  if (!sourceUrl) {
    throw new Error("Missing host context for Salesforce API.");
  }

  let targetUrl;
  try {
    targetUrl = new URL(sourceUrl);
  } catch (e) {
    targetUrl = new URL(`https://${sourceUrl}`);
  }

  let apiHost = targetUrl.hostname;
  if (apiHost.endsWith(".lightning.force.com")) {
    apiHost = apiHost.replace(".lightning.force.com", ".my.salesforce.com");
  }

  const allCookies = await chrome.cookies.getAll({});

  // 1. Attempt to find sid matching the apiHost exactly
  let sidCookie = allCookies.find(c => c.name === "sid" && apiHost.endsWith(c.domain.replace(/^\./, '')));

  // 2. If no exact match, fallback to the current page hostname
  if (!sidCookie) {
    sidCookie = allCookies.find(c => c.name === "sid" && targetUrl.hostname.endsWith(c.domain.replace(/^\./, '')));
  }

  // 3. Fallback: Just grab the first salesforce sid
  if (!sidCookie) {
    sidCookie = allCookies.find(c => c.name === "sid" && (c.domain.includes("salesforce.com") || c.domain.includes("force.com")));
  }

  // 4. Final fallback: Look for an orgid-session cookie
  if (!sidCookie) {
    sidCookie = allCookies.find(c => c.name.toLowerCase().includes("session") && (c.domain.includes("salesforce.com") || c.domain.includes("force.com")));
  }

  if (!sidCookie) {
    throw new Error("Could not extract 'sid' or 'session' cookie. Ensure you are logged into Salesforce.");
  }

  const sid = sidCookie.value;

  const res = await fetch(`https://${apiHost}${message.path}`, {
    method: message.method || "GET",
    headers: {
      "Authorization": `Bearer ${sid}`,
      "Content-Type": "application/json"
    },
    body: message.body ? JSON.stringify(message.body) : undefined
  });

  if ((message.method === "PATCH" || message.method === "DELETE") && res.status === 204) {
    return { success: true, payload: {} };
  }

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const apiError = Array.isArray(payload) ? payload[0] : payload;
    throw new Error(apiError?.message || `Salesforce request failed (${res.status}) on ${apiHost}.`);
  }

  return { success: true, payload };
}
