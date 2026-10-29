'use strict';

// Live updates, shared by both pages. While the page is visible it holds an
// event stream to the server. That tells the server someone is watching, so
// it collects from Design Hub and Bambu every couple of minutes instead of
// every quarter hour. The server says when new data is in, and the page then
// reloads its view from the server. The page itself never polls.
//
// onUpdate(status) runs after each server collection, and when the page
// comes back into view (or reconnects after the server restarted), since
// updates may have been missed meanwhile. status is the server's collection
// schedule (see Collector#status).
function liveUpdates(onUpdate) {
  let source = null;
  let connections = 0;
  const open = () => {
    if (source || document.visibilityState !== 'visible') return;
    source = new EventSource('/api/events');
    source.addEventListener('hello', (e) => {
      // The first hello is the page's own initial load; later ones follow a
      // gap in which updates may have been missed.
      if (connections++ > 0) onUpdate(JSON.parse(e.data));
    });
    source.addEventListener('update', (e) => onUpdate(JSON.parse(e.data)));
  };
  const close = () => {
    source?.close();
    source = null;
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') open();
    else close();
  });
  window.addEventListener('pagehide', close);
  window.addEventListener('pageshow', open);
  open();
}

// "Checked 7:58 PM", from the time of the server's last collection.
function collectedText(collector) {
  if (!collector?.lastRunAt) return '';
  return `Checked ${new Date(collector.lastRunAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

// Explains the schedule, for a tooltip.
function scheduleText(collector) {
  if (!collector) return '';
  const every = (m) => (m ? `every ${m < 1 ? `${Math.round(m * 60)} s` : `${m} min`}` : 'never');
  const watching = collector.viewers === 1 ? '1 page is open' : `${collector.viewers} pages are open`;
  return `The server checks Design Hub and Bambu ${every(collector.activeMinutes)} while a page is open `
    + `and ${every(collector.idleMinutes)} otherwise (${watching} now).`;
}
