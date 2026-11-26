/* Privacy-conscious site visitor count. One browser token, deduplicated server-side. */
(async function () {
  'use strict';
  try {
    // Log a returning browser once per India calendar day, not once per browser tab.
    const istDay = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const dayKey = 'samratSiteVisitRecordedISTDayV2';
    if (localStorage.getItem(dayKey) === istDay) return;
    if (!window.crypto || typeof window.crypto.randomUUID !== 'function') return;
    let browserId = localStorage.getItem('samratSiteVisitorIdV1');
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuid.test(browserId || '')) {
      browserId = window.crypto.randomUUID();
      localStorage.setItem('samratSiteVisitorIdV1', browserId);
    }
    const response = await fetch('https://sgp.cloud.appwrite.io/v1/functions/6ae1bcc500208a5a7efb/executions', {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        'X-Appwrite-Project': '6a7f2add0011a7bfc21a'
      },
      body: JSON.stringify({
        async: false,
        body: JSON.stringify({ action: 'track_site_visit', browserId })
      })
    });
    if (!response.ok) return;
    const execution = await response.json();
    let result = {};
    try { result = JSON.parse(execution.responseBody || '{}'); } catch {}
    if (execution.responseStatusCode === 200 && result.ok === true) {
      localStorage.setItem(dayKey, istDay);
    }
  } catch {
    // Analytics must never interrupt signup or game play.
  }
})();
