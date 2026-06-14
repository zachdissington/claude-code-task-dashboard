/**
 * The dashboard page — inlined HTML/CSS/JS, zero external dependencies.
 *
 * One consolidated command-center view. It is intentionally read-only: all task
 * mutation stays in Claude Code, while this page provides stable, glanceable
 * ambient state on a dedicated monitor.
 *
 * Single-viewport design: each view fits one screen with NO scrolling. Backlog
 * task detail opens in a floating popover so a drill-down never grows the page.
 *
 * A tiny SPA: fetch /snapshot once on load, re-fetch on each SSE `refresh`
 * event, plus a 30s safety poll. All charts are hand-rolled SVG/CSS. DOM is
 * built by string concatenation (not client-side template literals) so this
 * whole TS template literal needs no inner backtick/${} escaping.
 */

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="dashboard-token" content="__DASH_WRITE_TOKEN__">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<!-- PWA / Add-to-Home-Screen (mobile access, Part B). Service worker / offline
     queue is Part C; these tags just make the saved icon open full-screen. -->
<link rel="manifest" href="/manifest.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Command Center">
<meta name="theme-color" content="#070b0a">
<title>Command Center</title>
<style>
/* Quiet Operations palette — subtle Matrix influence per external UX review.
   Single :root for theming; SVG inline colors stay hex (HTML attrs can't use vars). */
:root{
  --bg:#050807;
  --panel:#0b1110;
  --panel-2:#101916;
  --panel-hi:#111c18;
  --line:#1a2a25;
  --line-soft:#13201c;
  --text:#d8e5df;
  --muted:#82948d;
  --muted-2:#53645d;
  --accent:#35d98b;
  --success:#35d98b;
  --warning:#cfa84c;
  --danger:#ff6262;
  --client:#d29b55;
  --internal:#42c783;
  --tooling:#61b8ff;
  --chart-a:#35d98b;
  --chart-b:#7dd3fc;
  --kpi-num:22px;
  --kpi-lbl:10px;
  --panel-title:11px;
  --body:12px;
  --micro:9px;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden}
body{background:var(--bg);color:var(--text);font-family:'Cascadia Mono','SF Mono',Consolas,Monaco,monospace;font-size:var(--body);line-height:1.38;display:flex;flex-direction:column;font-variant-numeric:tabular-nums}

/* Glassy gray scrollbar — Matrix-tinged green tint matching new palette. */
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-track{background:#07110e;border-radius:4px}
::-webkit-scrollbar-thumb{background:#1f8f68;border-radius:999px;border:2px solid #07110e}
::-webkit-scrollbar-thumb:hover{background:#27a679}
::-webkit-scrollbar-corner{background:#07110e}
*{scrollbar-width:thin;scrollbar-color:#1f8f68 #07110e}
header{background:#080d0c;border-bottom:1px solid var(--line);padding:7px 14px;display:flex;align-items:center;gap:10px;flex-shrink:0}
header h1{color:var(--accent);font-size:13px;letter-spacing:2px;text-transform:uppercase}
#status{font-size:10px;padding:2px 7px;border-radius:3px;background:var(--panel-2);border:1px solid var(--line)}
#status.connected{color:var(--accent);border-color:var(--accent)}
#status.disconnected{color:var(--danger);border-color:var(--danger)}
#status.polling{color:var(--muted);border-color:var(--line)}
#generated{color:var(--muted);font-size:10px;margin-left:auto;opacity:.7}

/* single view (no view toggle — consolidated 2026-05-28) */
#view{flex:1;min-height:0;display:flex;flex-direction:column}

/* KPI rail — compressed top instrument strip per external UX review.
   Headline business metrics (MRR / PIPE / A/R / leverage / closed / pace) —
   one tight row, big tabular numerals, small uppercase label. Replaces the
   operational stat band (operational pressure now surfaces inside its panels). */
.statband{display:grid;grid-template-columns:1.1fr repeat(4, minmax(0, 1fr));gap:8px;padding:8px 10px 0;flex-shrink:0}
.statcard{display:flex;align-items:baseline;gap:8px;padding:9px 14px;background:linear-gradient(180deg,var(--panel-hi),var(--panel));border:1px solid var(--line);border-radius:6px;min-width:0}
.statcard .num{font-size:var(--kpi-num);font-weight:bold;color:var(--accent);line-height:1;flex-shrink:0;letter-spacing:0}
.statcard .lbl{font-size:var(--kpi-lbl);letter-spacing:1px;text-transform:uppercase;color:var(--muted);line-height:1.25;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.statcard.warn{border-color:rgba(207,168,76,.42);background:linear-gradient(180deg,#171407,var(--panel))}
.statcard.warn .num{color:var(--warning)}
.statcard.dim .num{color:var(--muted);opacity:.65}
.statcard.danger{border-color:rgba(255,98,98,.42);background:linear-gradient(180deg,#1a0d0d,var(--panel))}
.statcard.danger .num{color:var(--danger)}
.statcard.good{border-color:rgba(53,217,139,.34)}
.statcard.info .num{color:var(--tooling)}
.statcard .delta{font-size:9px;letter-spacing:0;color:var(--muted);margin-left:auto;opacity:.7}
.statcard .delta.up{color:var(--accent)}
.statcard .delta.down{color:var(--danger)}
.statcard .delta.good{color:var(--accent);opacity:1}
.statcard .delta.bad{color:var(--danger);opacity:1}

/* Column-based flex layout (Slice C-iter2 F1/F2/F3/F6/F9) — replaces the 4x4
   CSS Grid. Each column owns its panels stacked vertically. Panels marked
   .grow take remaining vertical space; others size to natural content. When
   .panel.collapsed removes a panel, the flex column closes its gap — no more
   empty corners. F-pattern preserved: col 1 action-pressing, col 4 ambient. */
.grid{flex:1;min-height:0;display:flex;gap:8px;padding:8px 10px;overflow:hidden}
.grid > .col{display:flex;flex-direction:column;gap:8px;min-width:0;min-height:0;overflow:hidden}
.col-1{flex:1.08}
.col-2{flex:1.38}
.col-3{flex:1.28}
.col-4{flex:.98}
.nut-top{display:flex;align-items:baseline;gap:6px}
.nut-avg{font-size:18px;font-variant-numeric:tabular-nums;color:var(--text)}
.nut-sub{font-size:var(--micro);color:var(--muted)}
.nut-svg{width:100%;height:96px;display:block;margin-top:2px}
.nut-input{display:flex;gap:6px;margin-top:4px}
.nut-input input{flex:1;background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:4px;padding:3px 6px;font-size:var(--body)}
.nut-btn{background:var(--accent);color:#062;border:none;border-radius:4px;padding:3px 10px;font-size:var(--body);cursor:pointer}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:8px 10px;display:flex;flex-direction:column;min-height:0;overflow:hidden;flex-shrink:0;box-shadow:0 0 0 1px rgba(0,0,0,.14) inset}
.panel.grow{flex:1;min-height:0}
.workq-panel{flex:1;min-height:200px}
.backlog-panel{flex:1;min-height:0}
.trend-panel{height:270px}
.tokens-panel{height:586px}

/* rate-limit window strip (5h + weekly) at the top of the usage panel */
.rl-strip{display:flex;gap:8px;margin-bottom:9px}
.rl{flex:1;background:var(--panel-2);border:1px solid var(--line);border-radius:5px;padding:7px 9px;min-width:0}
.rl-top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px}
.rl-lbl{font-size:9px;letter-spacing:1px;text-transform:uppercase;color:var(--muted)}
.rl-pct{font-size:16px;font-weight:bold;letter-spacing:0;line-height:1}
.rl-bar{height:5px;background:#121a17;border-radius:999px;overflow:hidden}
.rl-bar i{display:block;height:100%;border-radius:999px;background:var(--accent)}
.rl-bar i.warn{background:var(--warning)}
.rl-bar i.danger{background:var(--danger)}
.rl-reset{font-size:8px;color:var(--muted-2);margin-top:3px;letter-spacing:.5px}
.business-panel{height:250px}
.panel.collapsed,.panel[data-empty="true"]{display:none}

.panel-body{min-height:0;overflow-y:auto;overflow-x:hidden;flex:1}
.panel-title{color:var(--accent);font-size:var(--panel-title);letter-spacing:1.4px;text-transform:uppercase;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:baseline;flex-shrink:0;font-weight:600}
.panel-title .count{color:var(--muted);letter-spacing:0;text-transform:none;font-size:10px}
.panel-title .count.fire{color:var(--danger)}
.panel-title .count.warn{color:var(--warning)}
.panel-foot{color:var(--muted);font-size:var(--micro);margin-top:5px;padding-top:4px;border-top:1px solid var(--line);flex-shrink:0;opacity:.75}
.panel-foot.warn{color:var(--warning)}
.err{color:#ffc1c1;font-size:10px;background:#1c0d0d;border:1px solid #3a1a1a;border-radius:4px;padding:4px 7px;margin-bottom:6px}
.empty{color:var(--muted);font-size:10px;padding:6px 0;opacity:.7}

/* stacked priority bars */
.brow{display:flex;align-items:center;gap:6px;padding:2px 3px;cursor:pointer;border-radius:3px}
.brow:hover{background:var(--panel-2)}
.brow.root .bname{color:#ffab40}
.bname{width:118px;flex-shrink:0;color:#cfd8dc;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.btrack{flex:1;min-width:0}
.pbar{height:11px;display:flex;border-radius:2px;overflow:hidden;background:#141414}
.pseg{min-width:2px}
.bcount{width:20px;text-align:right;color:#e0e0e0;font-size:10px;flex-shrink:0}
.chev{width:8px;color:#4a4a4a;font-size:7px;flex-shrink:0}
.legend{display:flex;gap:11px;margin-top:6px;padding-top:5px;border-top:1px solid #1a1a1a;flex-shrink:0}
.legend span{font-size:8px;color:#888;display:flex;align-items:center;gap:4px}
.swatch{width:8px;height:8px;border-radius:2px;display:inline-block}
/* blocked (waiting-on-client): keep the priority color, overlay a diagonal hatch */
.pseg.blocked{background-image:repeating-linear-gradient(45deg,rgba(0,0,0,.55) 0 2px,rgba(0,0,0,0) 2px 5px)}
.swatch.hatch{background:#5a6a62;background-image:repeating-linear-gradient(45deg,rgba(0,0,0,.6) 0 2px,rgba(0,0,0,0) 2px 4px)}

/* work queue — stacked sections, scrolling body, static legend footer */
.wq-body{overflow-y:auto;flex:1;min-height:0;display:flex;flex-direction:column}
.wq-sec{display:flex;align-items:center;gap:8px;margin:10px 0 3px;color:var(--muted);font-size:8px;letter-spacing:1.2px;text-transform:uppercase;flex-shrink:0}
.wq-sec:first-child{margin-top:2px}
.wq-sec::after{content:"";flex:1;height:1px;background:var(--line)}
.wq-sec .wq-sec-n{color:var(--accent);font-weight:bold;letter-spacing:0;order:-1}
.wq-sec.over .wq-sec-n{color:var(--warning)}
/* Up next: one recommended-next task per project group, with the rank's "why"
   and a click-through to the rest of the group. */
.upnext{margin-bottom:5px}
.upnext-why{color:var(--muted-2);font-size:9px;line-height:1.25;padding:0 3px 0 22px;margin-top:-1px}
.upnext-more{color:var(--muted);font-size:8.5px;padding:1px 3px 0 22px;cursor:pointer;opacity:.75}
.upnext-more:hover{opacity:1;color:var(--accent)}
.wq-pull{margin-left:auto;flex-shrink:0;color:var(--accent);font-size:9px;border:1px solid var(--accent);border-radius:3px;padding:0 4px;cursor:pointer;opacity:.8;white-space:nowrap}
.wq-pull:hover{opacity:1;background:var(--accent);color:var(--bg)}
/* work-queue footer: Workload ledger (category x count x est hours). The
   colored category names double as the chip-color legend. */
.wq-legend{padding-top:6px;margin-top:6px;border-top:1px solid var(--line);flex-shrink:0}
.wl-head{display:flex;justify-content:space-between;align-items:baseline;font-size:8px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin-bottom:4px}
.wl-head .wl-sub{letter-spacing:0;text-transform:none;color:var(--muted-2)}
.wl-row{display:grid;grid-template-columns:62px 22px 30px 1fr;gap:6px;align-items:center;font-size:9px;color:var(--muted);padding:1px 0}
.wl-cat{font-weight:bold;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wl-cat.client{color:var(--client)}
.wl-cat.internal{color:var(--internal)}
.wl-cat.skill{color:var(--tooling)}
.wl-cat.personal{color:#b39ddb}
.wl-cat.root{color:var(--danger)}
.wl-n{text-align:right;color:var(--text)}
.wl-h{text-align:right;color:var(--accent)}
.wl-bar{height:6px;background:#121a17;border-radius:999px;overflow:hidden}
.wl-bar i{display:block;height:100%;border-radius:999px}
.trow.click,.client-head.click{cursor:pointer;border-radius:3px}
.trow.click:hover,.client-head.click:hover{background:var(--panel-2)}
/* work-queue "Waiting on client" collapsed group */
.wq-blocked{margin-top:10px;flex-shrink:0}
.wq-blocked-head{display:flex;align-items:center;gap:8px;cursor:pointer;color:var(--muted);font-size:8px;letter-spacing:1.2px;text-transform:uppercase;padding:2px 3px;border-radius:3px}
.wq-blocked-head:hover{background:var(--panel-2)}
.wq-blocked-head::after{content:"";flex:1;height:1px;background:var(--line);order:50}
.wq-blocked-head .wq-sec-n{color:var(--client);font-weight:bold;letter-spacing:0;order:-1}
.wq-blocked-head .chev{order:99;width:8px;color:var(--muted);font-size:7px;transition:transform .12s}
.wq-blocked:not(.collapsed) .wq-blocked-head .chev{transform:rotate(90deg)}
.wq-blocked.collapsed .wq-blocked-list{display:none}
.wq-blocked-list .trow{opacity:.72}
.wq-blocked-list .trow.stale{opacity:1;box-shadow:inset 2px 0 0 var(--warning)}
.tmeta.wait{color:var(--client)}
.tmeta.wait.stale{color:var(--warning)}

/* task chip — auto width, sized so real display names never clip to "…" */
.tchip{display:inline-block;flex-shrink:0;text-align:center;padding:1px 5px;border-radius:2px;font-size:9px;white-space:nowrap;max-width:110px;overflow:hidden;text-overflow:ellipsis}
.tchip.client  {background:#251a0a;color:var(--client)}
.tchip.internal{background:#0d2218;color:var(--internal)}
.tchip.skill   {background:#0d1a26;color:var(--tooling)}
.tchip.personal{background:#1a1230;color:#b39ddb}
.tchip.root    {background:#2a1313;color:var(--danger)}

/* task row meta cell — right-aligned est + work_block */
.tmeta{color:#5a6a62;font-size:9px;flex-shrink:0;text-align:right;min-width:88px;white-space:nowrap}

/* client tab — client header row + indented tasks under it */
.client-head{display:flex;align-items:center;gap:6px;padding:6px 3px 4px;border-bottom:1px solid #1a1a1a;margin-top:8px}
.client-head:first-child{margin-top:0}
.client-head .client-name{color:#cfd8dc;font-size:11px;font-weight:bold}
.client-head .client-deliv{color:#8a9a92;font-size:9px;margin-left:auto;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.client-head .client-deliv .due-late{color:#ff5d5d}
.trow.under-client{margin-left:12px}

/* backlog overlay sub-project headers (multi-rollup drill-down) */
.ovsub{color:#39d98a;font-size:9px;letter-spacing:1px;text-transform:uppercase;margin:10px 0 4px;padding-bottom:3px;border-bottom:1px solid #1d2b27}
.ovsub:first-child{margin-top:0}

/* line chart */
.trend-delta{font-size:10px}
.trend-delta.up{color:#ff5d5d}
.trend-delta.down{color:#42c783}
.chart svg{width:100%;height:100%;display:block}

/* table */
table.ptable{width:100%;border-collapse:collapse;font-size:10px}
.ptable th{text-align:left;color:#5a6a62;font-size:8px;letter-spacing:.5px;text-transform:uppercase;padding:3px 5px;border-bottom:1px solid #1d2b27}
.ptable td{padding:4px 5px;border-bottom:1px solid #141414;color:#ccc}
.ptable tr:hover td{background:#161616}
.ptable .c-proj{color:#00b894;white-space:nowrap;max-width:84px;overflow:hidden;text-overflow:ellipsis}
.ptable .c-task{max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ptable .c-est{text-align:right;color:#666;white-space:nowrap}
.ptable .c-pri{text-align:center}
.ptable .c-num{text-align:right;color:#e0e0e0;white-space:nowrap}
.more{color:var(--muted);font-size:9px;padding:6px 5px 4px;border-top:1px dashed var(--line);margin-top:4px;opacity:.7;letter-spacing:.5px}

/* priority letters */
.pri{font-size:8px;font-weight:bold;width:13px;text-align:center;border-radius:2px;flex-shrink:0;padding:1px 0;display:inline-block}
.pri-high{background:#2a1313;color:var(--danger)}
.pri-medium{background:#241c0a;color:var(--warning)}
.pri-low{background:#0a1f1a;color:#42c7a0}
.pri-none{background:#171c1b;color:var(--muted)}

/* NEXT hero row — the single next task, emphasised so the eye lands on the
   board's actual answer ("what do I do next") before the ambient panels. */
.nextrow{display:flex;align-items:center;gap:7px;padding:6px 8px;margin-bottom:5px;
  background:linear-gradient(90deg,rgba(53,217,139,.10),rgba(53,217,139,.02));
  border:1px solid rgba(53,217,139,.30);border-left:3px solid var(--accent);border-radius:4px}
.nextrow .nx{font-size:8px;font-weight:bold;letter-spacing:1px;color:var(--accent);flex-shrink:0}
.nextrow .nx-title{flex:1;color:#eaf3ee;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nextrow .nx-meta{color:#8aa99a;font-size:9px;flex-shrink:0;white-space:nowrap}

/* 7am morning auto-plan proposal (T-2026-05-29-001) — replaces the empty-plan
   alarm when a plan is proposed for an uncommitted day. */
.prop{display:flex;flex-direction:column;gap:3px}
.prop-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:3px}
.prop-ttl{font-size:10px;font-weight:bold;letter-spacing:1px;color:var(--accent);text-transform:uppercase}
.prop-acts{display:flex;gap:5px;flex-shrink:0}
.prop-btn{border-radius:4px;padding:2px 11px;font-size:var(--body);cursor:pointer;border:1px solid var(--line);background:var(--panel);color:var(--text)}
.prop-btn.acc{background:var(--accent);color:#062;border-color:var(--accent)}
.prop-btn.rej:hover{border-color:var(--danger);color:var(--danger)}
.prop-foot{font-size:9px;color:var(--muted);margin-top:3px}

/* flat task-list rows */
.trow{display:flex;align-items:center;gap:6px;padding:3px 3px;border-bottom:1px solid #141414}
.trow:last-child{border-bottom:none}
.trow-title{flex:1;color:#ccc;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.trow-proj{color:#00b894;font-size:9px;flex-shrink:0;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.trow-est{color:#5a6a62;font-size:9px;flex-shrink:0;width:30px;text-align:right}


/* generic rows */
.row{padding:4px 3px;border-bottom:1px solid #141414}
.row:last-child{border-bottom:none}
.row-main{color:#ccc;line-height:1.35;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row-sub{color:#8a9a92;font-size:9px;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tag{font-size:8px;padding:1px 4px;border-radius:2px;background:var(--panel-2);color:var(--muted);margin-left:4px}
.tag.green{background:#0d2218;color:var(--internal)}
.tag.amber{background:#241c0a;color:var(--warning)}
.tag.red{background:#2a1313;color:var(--danger)}

/* badges */
.badge{font-size:8px;padding:1px 6px;border-radius:2px;letter-spacing:.5px}
.badge.ok{background:#0d2218;color:#42c783}
.badge.pending{background:#171717;color:#778}
.badge.due{background:#2a2100;color:#d8b24c}
.badge.rest{background:#0a1726;color:#4aa8ff}

/* token panel — flex column so the heatmap fills the leftover height */
#tokens{display:flex;flex-direction:column}
.mini-h{font-size:8px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin:7px 0 3px;flex-shrink:0;opacity:.7}

/* usage heatmap — fills the column width */
#token-heatmap{display:flex;flex-direction:column;gap:4px;margin-top:2px}
.hm-grid{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,15px);grid-auto-columns:15px;gap:3px;justify-content:start}
.hm-cell{border-radius:2px;min-width:0}
.hm-cell.click{cursor:pointer}
.hm-cell.click:hover{outline:1px solid var(--accent)}
.dbar.click{cursor:pointer}
/* chart axis row — HTML labels under inline SVG charts. Kept out of the SVG so
   preserveAspectRatio="none" stretching doesn't mangle the text. */
.chart-axis{display:flex;justify-content:space-between;font-size:8px;letter-spacing:0.5px;color:#5a6a62;margin:2px 1px 0}
/* closures daily bars — HTML flex bars (no SVG stretch, so count labels stay
   crisp). Replaces the cumulative line: day-over-day deltas are the signal. */
.dbar-chart{display:flex;align-items:flex-end;gap:3px;height:62px;margin-top:2px}
.dbar{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%}
.dbar-n{font-size:8px;color:#8aa99a;line-height:1;margin-bottom:2px;flex-shrink:0}
.dbar-fill{width:100%;background:#1fbf63;border-radius:1px;min-height:1px}
.dbar-fill.today{background:#39d98a}
.dbar-fill.zero{background:#16241f}

/* MTD chart legend — swatch + label per stacked layer. Calls out the API band
   that otherwise reads as a sliver at the 3-4% spend ratio. */
.mtd-legend{display:flex;align-items:center;gap:3px;font-size:8px;color:#9aa9a2;margin:3px 0 0;justify-content:flex-end;flex-wrap:wrap}
.mtd-sw{width:8px;height:8px;border-radius:2px;display:inline-block;margin-right:3px;vertical-align:middle}
.mtd-sep{margin:0 6px;color:#5a6a62}
.hm-legend{display:flex;align-items:center;gap:3px;justify-content:flex-end;font-size:7px;color:#5a6a62;flex-shrink:0}
.hm-key{width:9px;height:9px;border-radius:2px;display:inline-block}

/* big stat + exercise tags */
.bigstat{color:var(--accent);font-size:18px;font-weight:bold;margin:3px 0 7px;letter-spacing:0}
.bigstat.muted{color:var(--tooling)}
.exlist{display:flex;flex-wrap:wrap;gap:4px}
.extag{font-size:9px;padding:2px 6px;border-radius:3px;background:var(--panel-2);color:var(--muted);border:1px solid var(--line)}

/* KPI rows (business) */
.kpi{display:flex;justify-content:space-between;align-items:center;padding:3px 3px;border-bottom:1px solid var(--line)}
.kpi:last-child{border-bottom:none}
.kpi-label{color:#9aa;font-size:10px}
.kpi-val{color:#e0e0e0;font-size:13px;font-weight:bold}
.kpi-val.muted{color:#3f4a44;font-weight:normal}

/* dual mini stat */
.duo{display:flex;gap:8px;margin-bottom:7px}
.duo .statcard{flex:1}

/* triple hero stat (Slice C — Tokens 3-card hero row) */
.trio{display:flex;gap:8px;margin-bottom:7px}
.trio .statcard{flex:1}
.trio .statcard{display:block;padding:12px 13px;min-height:88px}
.trio .statcard .num{font-size:25px;margin-bottom:5px}
.trio .statcard .lbl{display:block;white-space:normal;line-height:1.2}
.statcard .sublbl{font-size:9px;color:#5fbf83;margin-top:3px;letter-spacing:0;text-transform:none;line-height:1.25;white-space:normal}

/* popover */
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;z-index:50}
.overlay.hidden{display:none}
.ovcard{background:#191A1B;border:1px solid #1d2b27;border-radius:6px;width:560px;max-width:92vw;max-height:84vh;overflow:auto;padding:14px}
.ovhead{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #1d2b27}
.ovhead .ovt{color:#39d98a;font-size:12px;letter-spacing:1px}
.ovhead .ovx{cursor:pointer;color:#888;font-size:18px;line-height:1}
.ovhead .ovx:hover{color:#fff}
.otask{display:flex;gap:7px;align-items:baseline;padding:4px 3px;border-bottom:1px solid #141414}
.otask:last-child{border-bottom:none}
.otask-num{color:var(--muted);font-size:10px;font-weight:bold;min-width:16px;text-align:right;flex-shrink:0;font-variant-numeric:tabular-nums}
.otask-title{color:#ccc;flex:1;font-size:11px}
.otask-sub{color:var(--muted-2);font-size:8px;letter-spacing:.3px;flex-shrink:0;text-transform:uppercase}
.otask-est{color:#555;font-size:9px;flex-shrink:0}
.otask-id{color:#3a4a42;font-size:8px;flex-shrink:0}
.otask.parked{opacity:.62}
.otask.parked .otask-num{color:#3a4a42}
.otask.parked .otask-est{color:var(--client)}
/* Typed readiness badges (Parked group): ⛓ depends-on chip (blue) vs 👤 client/person
   wait (amber) vs ⏳ condition/event wait (green). */
.dep-badge{color:var(--tooling,#4aa8ff);font-size:8px;flex-shrink:0;white-space:nowrap;letter-spacing:.2px}
.client-badge{color:var(--client,#c98f45);font-size:8px;flex-shrink:0;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wait-badge{color:var(--internal,#42c783);font-size:8px;flex-shrink:0;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ovnote{color:#ffab40;font-size:10px;margin-bottom:6px}
.ovbody{white-space:pre-wrap;color:#cfd8dc;font-size:11px;line-height:1.45;margin-top:9px;padding-top:8px;border-top:1px solid #1d2b27}
/* Write-back affordances — meal/training/task rows are clickable toggles. */
.writeable{cursor:pointer}
.writeable:hover{background:var(--panel-hi)}
.write-err{color:var(--danger);font-size:9px;margin:2px 0 4px;padding:2px 4px;border-left:2px solid var(--danger)}
/* Personal column — TODAY tracker + TOMORROW planner. */
.today-sec{color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.8px;margin:7px 0 2px;font-weight:600}
.today-sec:first-child{margin-top:0}
/* Selected-primary row (meals + training): a check, slot label, the chosen name,
   and a change/swap affordance. The CHOSEN state is unmistakable; placeholders dim. */
.prow{display:flex;gap:6px;align-items:center;padding:3px 4px;border-radius:3px;font-size:11px;cursor:pointer}
.prow:hover{background:var(--panel-hi)}
.prow .pcheck{flex-shrink:0;width:13px;height:13px;border:1px solid var(--line);border-radius:3px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;color:var(--bg);background:transparent}
.prow .pcheck.on{background:var(--accent);border-color:var(--accent)}
.prow .pslot{flex-shrink:0;width:62px;color:var(--muted);font-size:10px}
.prow .pname{flex:1;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prow .pname.ph{color:var(--muted-2);font-style:italic}
.prow.empty .pslot{color:var(--muted-2)}
.prow .pchg{flex-shrink:0;color:var(--accent);font-size:9px;text-transform:uppercase;letter-spacing:.5px;opacity:.85}
.prow .wproj{flex-shrink:0;color:var(--muted-2);font-size:9px;max-width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prow .ppill{flex-shrink:0;font-size:8px;border-radius:2px;padding:0 4px;border:1px solid}
.prow .ppill.green{color:var(--success);border-color:var(--success)}
.prow .ppill.amber{color:var(--warning);border-color:var(--warning)}
.prow .ppill.muted{color:var(--muted-2);border-color:var(--line)}
.prow.expanded{background:var(--panel-2)}
/* Expanded options (reused for meal top-3 + training rotation). */
.tmr-opt{display:flex;gap:6px;align-items:center;padding:3px 6px 3px 22px;border-radius:3px;font-size:11px;cursor:pointer}
.tmr-opt:hover{background:var(--panel-hi)}
.tmr-opt.picked{background:rgba(53,217,139,.16);box-shadow:inset 2px 0 0 var(--accent)}
.tmr-opt .pct{color:var(--muted-2);font-size:9px;flex-shrink:0;width:30px;text-align:right}
.tmr-opt .nm{flex:1;color:var(--text)}
.tmr-opt .thaw{color:var(--warning);font-size:8px;border:1px solid var(--warning);border-radius:2px;padding:0 3px;flex-shrink:0}
.tmr-opt .miss{color:var(--muted-2);font-size:8px}
.tmr-thaw{color:var(--warning);font-size:10px;margin-top:6px;padding-top:4px;border-top:1px solid var(--line-soft)}
/* Evening-review freshness stamp — Tomorrow panel footer. */
.review-stamp{font-size:9px;margin-top:8px;padding-top:5px;border-top:1px solid var(--line)}
.review-stamp.done{color:var(--accent)}
.review-stamp.muted{color:var(--muted-2)}
.review-stamp.nudge{color:var(--warning);font-weight:600}
/* TODAY training exercise list (sets/reps/distances). */
.pexlist{margin:1px 0 4px 22px}
.pex{color:var(--muted);font-size:10px;line-height:1.45}
/* Lift-day structured rows: name · target · [log input] · progression chip. */
.pexrow{display:flex;gap:5px;align-items:center;margin:1px 0 2px 0;font-size:10px}
.pexrow .pex-nm{color:var(--text);min-width:72px;max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pexrow .pex-tgt{color:var(--muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pexrow .pexlog{width:78px;background:var(--panel-2);border:1px solid var(--line);color:var(--text);font-size:10px;border-radius:3px;padding:1px 4px;font-variant-numeric:tabular-nums;box-shadow:inset 0 -1px 0 rgba(57,217,139,.28)}
.pexrow .pexlog:focus{outline:none;border-color:var(--accent);box-shadow:none}
.pexrow .pex-prog{color:var(--accent);font-size:9px;white-space:nowrap}
/* Endurance-day readout — a session of distance/duration/zone steps, set apart
   from the lift input table with a subtle accent rail. */
.pexlist.cardio{border-left:2px solid var(--internal);padding-left:7px;margin-left:22px}
.pexlist.cardio .pex{color:var(--text);opacity:.82}
.pexlist.cardio .pex-cap{font-size:8px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted);opacity:.7;margin-bottom:2px}

/* Short-viewport compress-to-fit. The fixed panel heights below assume a
   ~1080px-tall monitor; on a scaled laptop (1280x800 canvas at 150% Windows
   scaling) the stacked column-3 heights (Tokens 586 + Business 250) overflow
   the ~650px of usable grid height and clip off-screen, while the inelastic
   Trend (270) starves Backlog and .panel{flex-shrink:0} squeezes the right-rail
   Tomorrow panel to zero. Below 900px tall, convert those inelastic panels to
   flex so each column distributes its own height and tall bodies scroll inside
   their panel (panel-body already has overflow-y:auto) — everything stays on one
   screen with no page scroll. The monitor (height>900) keeps the tuned layout
   untouched. */
@media (max-height:900px){
  body:not(.compact) .panel{flex-shrink:1}
  body:not(.compact) .tokens-panel{height:auto;flex:1 1 0;min-height:260px}
  body:not(.compact) .business-panel{height:auto;flex:0 1 auto;max-height:210px}
  body:not(.compact) .trend-panel{height:auto;flex:1 1 0;min-height:150px}
  body:not(.compact) .backlog-panel{flex:2 1 0;min-height:120px}
  body:not(.compact) .workq-panel{min-height:150px}
  body:not(.compact) .panel.grow{min-height:140px}
}

/* Laptop auto-fit. On a screen smaller than the external-monitor design the whole
   board is scaled down by JS (body.style.zoom — see applyFit() near boot) so the
   4-column shape and every panel stay intact, just smaller. The height rule above
   is gated to body:not(.compact) so it never double-compresses against the zoom
   (zoom enlarges the CSS viewport, which would otherwise also fire that rule and
   collapse the fixed panel heights, distorting the shape). These overrides only
   bite when the zoom hits its floor on a very small screen — then let the page
   scroll instead of clipping. On the external monitor body.compact is absent and
   nothing here applies. */
body.compact{overflow-y:auto;overflow-x:hidden}
body.compact #view{overflow:visible}
body.compact .grid{overflow:visible}
</style>
</head>
<body>
<header>
  <h1>COMMAND CENTER</h1>
  <span id="status" class="disconnected">connecting</span>
  <span id="generated"></span>
</header>

<div id="view">
  <div class="statband" id="statband"></div>
  <div class="grid">
    <div class="col col-1">
      <div class="panel" data-cell="today">
        <div class="panel-title"><span>Today's plan</span><span class="count" id="today-pro-count"></span></div>
        <div class="panel-body" id="today-pro"></div>
      </div>
      <div class="panel workq-panel" data-cell="workq">
        <div class="panel-title"><span>Work queue</span><span class="count" id="wq-count"></span></div>
        <div class="panel-body wq-body" id="workqueue"></div>
        <div class="wq-legend" id="wq-legend"></div>
      </div>
      <div class="panel" data-cell="inflight">
        <div class="panel-title"><span>In-flight / bound</span></div>
        <div class="panel-body" id="inflight"></div>
      </div>
    </div>
    <div class="col col-2">
      <div class="panel backlog-panel" data-cell="backlog">
        <div class="panel-title"><span>Backlog by project</span><span class="count" id="backlog-count"></span></div>
        <div class="panel-body" id="backlog"></div>
        <div id="backlog-legend"></div>
      </div>
      <div class="panel" data-cell="velocity">
        <div class="panel-title"><span>Closures &middot; last 14d</span><span class="count" id="velo-count"></span></div>
        <div class="panel-body" id="velocity"></div>
      </div>
      <div class="panel trend-panel" data-cell="trend">
        <div class="panel-title"><span>Backlog-size trend</span><span class="count" id="trend-delta"></span></div>
        <div class="panel-body chart" id="trend"></div>
      </div>
    </div>
    <div class="col col-3">
      <div class="panel tokens-panel" data-cell="tokens">
        <div class="panel-title"><span>Claude Code usage</span></div>
        <div class="panel-body" id="tokens"></div>
      </div>
      <div class="panel business-panel" data-cell="business">
        <div class="panel-title"><span>Business KPIs</span><span class="count" id="biz-updated"></span></div>
        <div class="panel-body" id="business"></div>
      </div>
    </div>
    <div class="col col-4">
      <div class="panel" data-cell="calendar">
        <div class="panel-title"><span>Today's meetings</span><span class="count" id="calendar-count"></span></div>
        <div class="panel-body" id="calendar"></div>
      </div>
      <div class="panel" data-cell="today-personal">
        <div class="panel-title"><span>Today &middot; personal</span><span class="count" id="today-count"></span></div>
        <div class="panel-body" id="today"></div>
      </div>
      <div class="panel" data-cell="nutrition">
        <div class="panel-title"><span>Nutrition</span><span class="count" id="nutrition-count"></span></div>
        <div class="panel-body" id="nutrition"></div>
      </div>
      <div class="panel grow" data-cell="tomorrow">
        <div class="panel-title"><span>Tomorrow</span><span class="count" id="tomorrow-count"></span></div>
        <div class="panel-body" id="tomorrow"></div>
      </div>
    </div>
  </div>
</div>

<div class="overlay hidden" id="overlay">
  <div class="ovcard">
    <div class="ovhead"><span class="ovt" id="ov-title"></span><span class="ovx" id="ov-close">&times;</span></div>
    <div id="ov-body"></div>
  </div>
</div>
<script>
var statusEl=document.getElementById('status');
function $(id){return document.getElementById(id);}

var PRI=[
  {key:'high',color:'#ff5d5d',label:'High'},
  {key:'medium',color:'#d8b24c',label:'Med'},
  {key:'low',color:'#00897b',label:'Low'},
  {key:'none',color:'#37474f',label:'None'}
];
var FIRE_CAP=8,QUICK_CAP=5,PULL_CAP=8,QUICK_MAX=30;
var PRI_RANK={high:0,medium:1,low:2,none:3};

function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function relTime(iso){
  if(!iso)return'';
  var t=new Date(iso).getTime();
  if(isNaN(t))return'';
  var s=Math.floor((Date.now()-t)/1000);
  if(s<0)s=0;
  if(s<60)return s+'s ago';
  if(s<3600)return Math.floor(s/60)+'m ago';
  if(s<86400)return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago';
}
/* Set the "updated Nm ago" indicator AND colour it by age. A render that went
   stale (laptop slept, window occluded, server bounced) can otherwise show a
   wrong NEXT hero silently — so >60s goes amber and >5m red. The page self-heals
   on focus/visibility + the 30s poll; the cue is the at-a-glance "don't trust me yet". */
function setGeneratedCue(iso){
  var el=$('generated');if(!el)return;
  el.textContent='updated '+relTime(iso);
  var age=iso?(Date.now()-new Date(iso).getTime())/1000:0;
  if(isNaN(age))age=0;
  el.style.color=age>300?'var(--danger)':(age>60?'var(--warning)':'');
  el.style.opacity=age>60?'1':'';
}
function priClass(p){p=(p||'').toLowerCase();return p==='high'||p==='medium'||p==='low'?'pri-'+p:'pri-none';}
function priLetter(p){p=(p||'').toLowerCase();return p?p[0].toUpperCase():'-';}
function priKey(p){p=(p||'').toLowerCase();return (p==='high'||p==='medium'||p==='low')?p:'none';}
/* Shared "do-first" ordering — the LLM rank (rank_tasks.py) leads, then
   importance, then quick wins; unranked tasks fall back to importance. Used by
   both the work-queue "Up next" and the rollup overlay's numbered worklist so
   they never disagree on order. */
var _PRANK={high:0,medium:1,low:2,none:3};
function rankKey(t){
  var r=(typeof t.rank==='number')?t.rank:9999;
  return [r,_PRANK[priKey(t.priority)],t.time_estimate>0?0:1,t.time_estimate||0];
}
function rankLex(a,c){var ka=rankKey(a),kc=rankKey(c);for(var i=0;i<ka.length;i++){if(ka[i]!==kc[i])return ka[i]-kc[i];}return 0;}
/* Canonical "top of today" order — mirrors task_helpers.plan_sort_key, the single
   source of truth shared with plan-day.py + next-task.py: client-first, priority,
   then OLDEST-COMMITTED first AT DATE GRANULARITY (scheduled_at truncated to
   YYYY-MM-DD — when it landed on its date — falling back to created), then cluster
   by project and run each project's rank (do-first) order, quick wins, id as the
   final stable tiebreak. The green NEXT hero is sorted[0] under this, so it
   provably equals next-task.py top. Keep in lockstep with plan_sort_key — the age
   key is date-granular so same-day tasks tie and fall through to group + rank,
   letting the rank pass (not an incidental creation-time difference) decide
   same-day order; across days the longest-waiting task still floats up. */
function planCmp(a,b){
  var ac=(a.group_klass==='client')?0:1,bc=(b.group_klass==='client')?0:1;
  if(ac!==bc)return ac-bc;
  var ap=PRI_RANK[priKey(a.priority)],bp=PRI_RANK[priKey(b.priority)];
  if(ap!==bp)return ap-bp;
  var as=(a.scheduled_at||a.created||'').slice(0,10),bs=(b.scheduled_at||b.created||'').slice(0,10);
  if(as!==bs)return as<bs?-1:1;
  var ag=a.group||'',bg=b.group||'';if(ag!==bg)return ag<bg?-1:1;
  var ar=(typeof a.rank==='number')?a.rank:9999,br=(typeof b.rank==='number')?b.rank:9999;
  if(ar!==br)return ar-br;
  var ae=a.time_estimate||9999,be=b.time_estimate||9999;if(ae!==be)return ae-be;
  var ai=a.id||'',bi=b.id||'';return ai<bi?-1:(ai>bi?1:0);
}
function errBlock(e){return e?'<div class="err">'+esc(e)+'</div>':'';}
function priCounts(tasks){
  var c={high:0,medium:0,low:0,none:0};
  for(var i=0;i<tasks.length;i++)c[priKey(tasks[i].priority)]++;
  return c;
}
function shortProj(p){
  p=String(p||'');
  if(p.indexOf('root / unassigned')>=0)return 'unassigned';
  var parts=p.split('/');
  return parts[parts.length-1];
}
/* A task waiting on an external party (blocked_by set by the task store). Blocked
   tasks stay visible but are pulled out of the active work queue and hatched on
   the backlog bars. Recognises the Phase-2 typed readiness fields (waiting_on /
   depends_on) too, so the board treats them as parked once the migration lands. */
function isBlocked(t){return !!(t&&(t.blocked_by||t.waiting_on||(t.depends_on&&t.depends_on.length)));}
/* Typed readiness as a visually distinct badge, matching the three wait kinds the live
   store uses: depends_on (blocked on other tasks) → "⛓ N deps" (ids in the hover title);
   a waiting_on that names a client/person ("client" / "client: <detail>") → "👤 <detail>"
   with the redundant "client:" prefix stripped (full text on hover); any other waiting_on
   → "⏳ <condition>". blocked_by (legacy, no live task uses it) falls through to ⏳ so a
   parked row never renders an empty badge. */
function readinessBadge(t){
  if(t&&t.depends_on&&t.depends_on.length)
    return '<span class="dep-badge" title="depends on: '+esc(t.depends_on.join(', '))+'">\\u26d3 '
      +t.depends_on.length+' dep'+(t.depends_on.length>1?'s':'')+'</span>';
  var w=t&&t.waiting_on;
  if(w){
    var s=String(w), m=s.match(/^client\\b:?\\s*([\\s\\S]*)$/i);
    if(m){var d=(m[1]||'').trim();
      return '<span class="client-badge" title="'+esc(s)+'">\\uD83D\\uDC64 '+esc(d||'client')+'</span>';}
    return '<span class="wait-badge" title="'+esc(s)+'">\\u23f3 '+esc(s)+'</span>';
  }
  var b=t&&t.blocked_by;
  if(b) return '<span class="wait-badge" title="'+esc(String(b))+'">\\u23f3 '+esc(String(b))+'</span>';
  return '';
}
/* Days since a blocked task last saw activity (burndown emits blocked_since =
   newest Notes date stamp / mtime). null when unknown. */
function daysWaiting(t){
  if(!t||!t.blocked_since)return null;
  var then=new Date(t.blocked_since+'T00:00:00').getTime();
  if(isNaN(then))return null;
  var mid=new Date();mid.setHours(0,0,0,0);
  var d=Math.floor((mid.getTime()-then)/86400000);
  return d<0?0:d;
}
var STALE_DAYS=14;
/* Shared staleness gate: days>=threshold -> amber nudge. One helper for both the
   blocked work-queue group and the freshness-stamp panel (T-2026-05-31-003). */
function isStaleDays(days,threshold){return days!=null&&days>=(threshold||STALE_DAYS);}

/* PROJECT_RENAMES (Slice B): regex array mapping raw burndown project keys to
   {display, rollup, class}. Two consumers — renderBacklog groups by rollup,
   Work-queue task chip colors from class. Order matters: first match wins, so
   specific patterns precede the Internal/ + Clients/ catch-alls. */
var PROJECT_RENAMES=[
  [/^Internal\\/task-dashboard/,                        'Task Dashboard', 'task-dashboard','internal'],
  [/^Internal$/,                                        'Other internal', 'internal-other','internal'],
  [/^Internal\\/([^/]+)/,                               null,             'internal-$1',   'internal'],
  [/^Clients\\/([^/]+)/,                                null,             'client-$1',     'client'],
  [/^Content Engine/,                                   'Content Engine', 'content-engine','internal'],
  [/^\\.claude\\/skills\\/?/,                           'Skills',         'skills',        'skill'],
  [/^\\.claude\\//,                                     'Claude tooling', 'claude',        'skill'],
  [/root \\/ unassigned/,                               'Unassigned',     'unassigned',    'root']
];
function classify(raw){
  var s=String(raw||'');
  for(var i=0;i<PROJECT_RENAMES.length;i++){
    var entry=PROJECT_RENAMES[i],m=s.match(entry[0]);
    if(m)return {display:entry[1]||m[1]||s,rollup:String(entry[2]).replace('$1',m[1]||''),klass:entry[3]};
  }
  return {display:s,rollup:s,klass:'internal'};
}
/* Umbrella grouping is now defined once in project_groups.py and emitted per
   task by burndown.py (group / group_display / group_klass). groupInfo reads it
   off a raw burndown group's first task (all tasks in a raw group share a
   workspace_path -> same umbrella), falling back to the JS classify() for any
   source that doesn't carry the fields (e.g. closures). Shape matches classify:
   {rollup, display, klass}. */
function groupInfo(g){
  var t=(g&&g.tasks&&g.tasks[0])||null;
  if(t&&t.group)return {rollup:t.group,display:t.group_display||t.group,klass:t.group_klass||'internal'};
  return classify(g&&g.project);
}
function allTasks(b){
  var out=[];
  for(var g=0;g<b.groups.length;g++)
    for(var t=0;t<b.groups[g].tasks.length;t++)out.push(b.groups[g].tasks[t]);
  return out;
}
function fmtUSD(n){
  if(n==null||isNaN(n))return '--';
  if(n>=1000)return '$'+Math.round(n).toLocaleString();
  if(n>=100)return '$'+Math.round(n);
  if(n>=10)return '$'+n.toFixed(1);
  return '$'+n.toFixed(2);
}
/* round-number axis: returns {lo,hi,step} spanning [min,max] with nice ticks */
function niceAxis(min,max){
  if(!(max>min))max=min+1;
  var range=max-min,pad=Math.max(1,range*0.25);
  var lo0=min-pad,hi0=max+pad,span=hi0-lo0;
  var raw=span/3;
  var mag=Math.pow(10,Math.floor(Math.log(raw)/Math.LN10));
  var norm=raw/mag;
  var step=(norm<=1?1:norm<=2?2:norm<=2.5?2.5:norm<=5?5:10)*mag;
  var lo=Math.floor(lo0/step)*step,hi=Math.ceil(hi0/step)*step;
  if(lo<0)lo=0;
  return {lo:lo,hi:hi,step:step};
}

/* ===================== PROFESSIONAL VIEW ===================== */

/* binding age severity: 0 ok, 1 amber (bound >=2h ago), 2 red (before today). */
function isStaleBinding(boundAt){
  var t=new Date(boundAt).getTime();
  if(isNaN(t))return 0;
  var midnight=new Date();midnight.setHours(0,0,0,0);
  if(t<midnight.getTime())return 2;
  if(Date.now()-t>=2*3600000)return 1;
  return 0;
}
/* actionable (unblocked) high-priority tasks under a Clients/ project — reputation risk. */
function clientHighTasks(b){
  return allTasks(b).filter(function(t){
    return priKey(t.priority)==='high'&&!isBlocked(t)&&String(t.project||'').indexOf('Clients/')===0;
  });
}
function localToday(){return dayKey(new Date());}
/* high-priority client tasks not scheduled for today — feeds the plan alarm. */
function clientUnplannedCount(s){
  var today=localToday();
  return clientHighTasks(s.backlog).filter(function(t){return t.scheduled_date!==today;}).length;
}
/* open-count change vs the trend point nearest 7 days before the latest. */
function backlogDelta(trend){
  var pts=(trend&&trend.points)||[];
  if(pts.length<2)return null;
  var latest=pts[pts.length-1],target=new Date(latest.date).getTime()-7*86400000,ref=pts[0];
  for(var i=0;i<pts.length;i++){
    if(Math.abs(new Date(pts[i].date).getTime()-target)<Math.abs(new Date(ref.date).getTime()-target))ref=pts[i];
  }
  return latest.total-ref.total;
}

/* Compact USD format with k/M suffix for the KPI rail. */
function fmtUsdK(n){
  if(n==null||isNaN(n))return '--';
  if(n>=1000000)return '$'+(n/1000000).toFixed(1)+'M';
  if(n>=10000)return '$'+Math.round(n/1000)+'k';
  if(n>=1000)return '$'+(n/1000).toFixed(1)+'k';
  return '$'+Math.round(n);
}

/* KPI Rail — compact business-outcome instrument strip per external UX review.
   Replaces the operational stat band; operational state (overdue / captures /
   in-flight) is now surfaced inside its own panels. */
/* Overage minutes → compact units (>=60m as hours). Shared by the KPI ribbon
   Plan card + the Today's-plan header so the two surfaces never drift. */
function fmtOver(m){return m>=60?(m/60).toFixed(1)+'h':m+'m';}
function renderStats(s){
  var liveBiz=s.business||{};
  var liveApi=s.apiSpend||{};
  var liveToday=s.todayPlan||{};
  var planned=(liveToday.professional||[]).length;
  // Actionable highs only: priority is importance, blocked_by is readiness. A
  // parked high keeps its priority but must not nag the on-fire count.
  var fire=allTasks(s.backlog).filter(function(t){return priKey(t.priority)==='high'&&!isBlocked(t);});
  var clientFire=clientHighTasks(s.backlog).length;
  var bd=backlogDelta(s.trend);
  function liveCard(num,lbl,cls,delta){
    lbl=String(lbl).replace(/\\u00c2\\u00b7/g,'&middot;');
    return '<div class="statcard '+(cls||'')+'"><div class="num">'+num+'</div>'
      +'<div class="lbl">'+lbl+'</div>'
      +(delta?'<div class="delta '+(delta.dir||'')+'">'+delta.txt+'</div>':'')
      +'</div>';
  }
  // Plan — mirror the Today's-plan panel: committed (good / warn+overage), a
  // pending morning proposal (warn), or no plan (danger). The ribbon reads the
  // same signals the panel does, so it can't contradict it (roast-v2 finding 6).
  var planNum,planLbl,planCls;
  var planAvail=liveToday.availableMinutes||0;
  var planOver=(liveToday.committedMinutesPro||0)-planAvail; // >0 => overcommitted
  if(planned){
    planNum=liveToday.committedMinutesPro?((liveToday.committedMinutesPro/60).toFixed(1)+'h'):planned;
    planLbl=planned+' task'+(planned===1?'':'s')+' today';
    if(planOver>0){planCls='warn';planLbl+=' \\u00b7 over by '+fmtOver(planOver);}
    else planCls='good';
  } else if(liveToday.proposal&&liveToday.proposal.tasks&&liveToday.proposal.tasks.length){
    planNum='PROPOSED';planLbl='proposed \\u00b7 accept to commit';planCls='warn';
  } else {
    planNum='NO PLAN';planLbl='no plan committed';planCls='danger';
  }
  // High (WIP cap 5)
  var over=fire.length>5;
  var highLbl=over?'high \\u00b7 over cap \\u00b7 triage':('high'+(clientFire?(' \\u00b7 '+clientFire+' client'):''));
  // Open
  var openLbl='open tasks'+(bd==null?'':' \\u00b7 '+(bd>0?'+':'')+bd+' 7d');
  // MRR (placeholder until business-metrics.json filled)
  var mrr=liveBiz.mrr;
  // Expenses MTD — live = API spend; bank-sourced expenses fold in later.
  var exp=(liveApi.month!=null)?liveApi.month:null;
  var prev=liveApi.prevMonth;
  var expDelta=null;
  if(exp!=null&&prev!=null&&prev>0){
    var diff=exp-prev;
    if(Math.abs(diff)>=1)
      expDelta={txt:(diff>0?'\\u25b2':'\\u25bc')+' '+fmtUSD(Math.abs(diff))+' vs LM',dir:diff>0?'bad':'good'};
  }
  $('statband').innerHTML=
    liveCard(planNum,planLbl,planCls)
    +liveCard(fire.length,highLbl,over?'warn':(fire.length?'danger':'dim'))
    +liveCard(s.backlog.total||0,openLbl,(bd&&bd>0)?'warn':'')
    +liveCard(mrr==null?'--':fmtUSD(mrr),'MRR',mrr==null?'dim':'good')
    +liveCard(exp==null?'--':fmtUSD(exp),'API spend MTD',exp==null?'dim':'info',expDelta);
}

/* Backlog by Project — rollup grouping (Slice B). Raw burndown groups are
   merged by classify().rollup; sub-projects are shown nested in the overlay. */
function renderBacklog(b){
  var blkAll=allTasks(b).filter(isBlocked).length;
  $('backlog-count').textContent=(b.total-blkAll)+' actionable \\u00b7 '+b.total+' open';
  var h=errBlock(b.error);
  if(!b.groups.length){h+='<div class="empty">No open tasks.</div>';$('backlog').innerHTML=h;$('backlog-legend').innerHTML='';return;}
  var rollups={},order=[];
  for(var i=0;i<b.groups.length;i++){
    var g=b.groups[i],cls=groupInfo(g);
    if(!rollups[cls.rollup]){
      rollups[cls.rollup]={display:cls.display,klass:cls.klass,count:0,minutes:0,tasks:[],subCount:0};
      order.push(cls.rollup);
    }
    var r=rollups[cls.rollup];
    r.count+=g.count;
    r.minutes+=g.minutes||0;
    for(var t=0;t<g.tasks.length;t++)r.tasks.push(g.tasks[t]);
    r.subCount++;
  }
  order.sort(function(a,c){return rollups[c].count-rollups[a].count;});
  var max=1;
  for(var k=0;k<order.length;k++)max=Math.max(max,rollups[order[k]].count);
  for(var x=0;x<order.length;x++){
    var key=order[x],r=rollups[key];
    var isRoot=r.klass==='root';
    // Split each rollup into actionable + blocked: actionable segments render
    // solid (left), blocked segments keep their priority color but get a diagonal
    // hatch (right). A fully-blocked project reads as a fully-hatched bar.
    var actTasks=[],blkTasks=[];
    for(var bt=0;bt<r.tasks.length;bt++)(isBlocked(r.tasks[bt])?blkTasks:actTasks).push(r.tasks[bt]);
    var ca=priCounts(actTasks),cb=priCounts(blkTasks);
    var segs='';
    for(var p=0;p<PRI.length;p++){
      var na=ca[PRI[p].key];
      if(na>0)segs+='<div class="pseg" style="flex-grow:'+na+';background:'+PRI[p].color+'" title="'+na+' '+PRI[p].label+'"></div>';
    }
    for(var p2=0;p2<PRI.length;p2++){
      var nb=cb[PRI[p2].key];
      if(nb>0)segs+='<div class="pseg blocked" style="flex-grow:'+nb+';background-color:'+PRI[p2].color+'" title="'+nb+' '+PRI[p2].label+' \\u00b7 waiting on client"></div>';
    }
    var widthPct=Math.max(6,Math.round(r.count/max*100));
    var subNote=r.subCount>1?' ('+r.subCount+' sub-projects)':'';
    var blkNote=blkTasks.length?' \\u00b7 '+blkTasks.length+' waiting on client':'';
    var ttl=r.count+' task'+(r.count===1?'':'s')+(r.minutes?' ~'+r.minutes+'m':'')+subNote+blkNote+' — click for detail';
    h+='<div class="brow'+(isRoot?' root':'')+'" data-rollup="'+esc(key)+'" title="'+esc(ttl)+'">'
      +'<span class="bname">'+esc(r.display)+'</span>'
      +'<span class="btrack"><span class="pbar" style="width:'+widthPct+'%">'+segs+'</span></span>'
      +'<span class="bcount">'+r.count+'</span>'
      +'<span class="chev">\\u25b8</span></div>';
  }
  $('backlog').innerHTML=h;
  var leg='';
  for(var L=0;L<PRI.length;L++)leg+='<span><i class="swatch" style="background:'+PRI[L].color+'"></i>'+PRI[L].label+'</span>';
  if(blkAll>0)leg+='<span><i class="swatch hatch"></i>waiting on client</span>';
  $('backlog-legend').innerHTML='<div class="legend">'+leg+'</div>';
}

/* Overlay drill-down for a project group: one flat, rank-ordered, numbered
   worklist (1..N) so it reads as a do-this-then-that checklist top to bottom.
   Tasks are pooled across the umbrella's raw sub-projects and sorted by the
   shared rank order; each row keeps a dim sub-project tag for context. Blocked
   (parked) tasks list below, unnumbered, since they're not part of the order. */
function openRollup(rollup){
  if(!lastSnapshot)return;
  var rawGroups=[],gs=lastSnapshot.backlog.groups;
  for(var i=0;i<gs.length;i++)if(groupInfo(gs[i]).rollup===rollup)rawGroups.push(gs[i]);
  if(!rawGroups.length)return;
  var cls=groupInfo(rawGroups[0]),multi=rawGroups.length>1;
  var all=[];
  for(var j=0;j<rawGroups.length;j++)
    for(var t=0;t<rawGroups[j].tasks.length;t++)all.push(rawGroups[j].tasks[t]);
  var active=[],parked=[];
  for(var a=0;a<all.length;a++)(isBlocked(all[a])?parked:active).push(all[a]);
  active.sort(rankLex);
  var totalMinutes=0;for(var m=0;m<all.length;m++)totalMinutes+=all[m].time_estimate||0;
  $('ov-title').textContent=cls.display+'  \\u00b7  '+all.length+' open'+(totalMinutes?'  \\u00b7  ~'+totalMinutes+'m':'');
  var h='';
  if(cls.klass==='root')
    h+='<div class="ovnote">Unassigned &mdash; re-home each to its real project in Claude Code.</div>';
  function subTag(tk){
    if(!multi)return '';
    var sp=classify(tk.project).display;
    return '<span class="otask-sub" title="'+esc(tk.project)+'">'+esc(sp)+'</span>';
  }
  for(var n=0;n<active.length;n++){
    var tk=active[n];
    h+='<div class="otask"><span class="otask-num">'+(n+1)+'</span>'
      +'<span class="pri '+priClass(tk.priority)+'">'+priLetter(tk.priority)+'</span>'
      +'<span class="otask-title">'+esc(tk.title)+'</span>'
      +subTag(tk)
      +(tk.time_estimate?'<span class="otask-est">'+tk.time_estimate+'m</span>':'')
      +'<span class="otask-id">'+esc(tk.id)+'</span></div>';
  }
  if(parked.length){
    h+='<div class="ovsub">Parked &middot; '+parked.length+' &middot; waiting</div>';
    for(var p=0;p<parked.length;p++){
      var pk=parked[p];
      h+='<div class="otask parked"><span class="otask-num">&middot;</span>'
        +'<span class="pri '+priClass(pk.priority)+'">'+priLetter(pk.priority)+'</span>'
        +'<span class="otask-title">'+esc(pk.title)+'</span>'
        +subTag(pk)
        +readinessBadge(pk)
        +'<span class="otask-id">'+esc(pk.id)+'</span></div>';
    }
  }
  $('ov-body').innerHTML=h;
  $('overlay').className='overlay';
}
function closeOverlay(){$('overlay').className='overlay hidden';}

/* Closures drill-downs — reuse the overlay. Closures carry no priority/estimate,
   so render a neutral row: title + project + id. Data is lastSnapshot.closures.all. */
function closuresList(items){
  var s='';
  for(var i=0;i<items.length;i++){var it=items[i];
    s+='<div class="otask"><span class="otask-title">'+esc(it.title)+'</span>'
      +'<span class="otask-est">'+esc(classify(it.project).display)+'</span>'
      +'<span class="otask-id">'+esc(it.id)+'</span></div>';}
  return s||'<div class="empty">No closures.</div>';
}
function openClosuresDay(date){
  if(!lastSnapshot)return; var all=(lastSnapshot.closures&&lastSnapshot.closures.all)||[];
  var items=all.filter(function(c){return c.closedDate===date;});
  $('ov-title').textContent=date+'  \\u00b7  '+items.length+' closed';
  $('ov-body').innerHTML=closuresList(items); $('overlay').className='overlay';
}
function openClosuresProject(project){
  if(!lastSnapshot)return; var all=(lastSnapshot.closures&&lastSnapshot.closures.all)||[];
  var items=all.filter(function(c){return c.project===project;});
  $('ov-title').textContent=classify(project).display+'  \\u00b7  '+items.length+' closed \\u00b7 14d';
  $('ov-body').innerHTML=closuresList(items); $('overlay').className='overlay';
}
function openUsageDay(date){
  if(!lastSnapshot)return; var d=(lastSnapshot.tokens&&lastSnapshot.tokens.daily)||[];
  var hit=null; for(var i=0;i<d.length;i++)if(d[i].date===date){hit=d[i];break;}
  var usd=hit&&hit.costUSD>0?fmtUSD(hit.costUSD):'no usage';
  $('ov-title').textContent=date+'  \\u00b7  list-price usage';
  $('ov-body').innerHTML='<div class="bigstat">'+usd+'</div>'
    +'<div class="mini-h">Claude Code value consumed that day</div>';
  $('overlay').className='overlay';
}

/* Task detail — fetch the .md (frontmatter + Notes body) on row click. */
function openTask(path){
  $('ov-title').textContent='Loading\\u2026';
  $('ov-body').innerHTML='<div class="empty">Loading task\\u2026</div>';
  $('overlay').className='overlay';
  fetch('/task?path='+encodeURIComponent(path)).then(function(r){return r.json();}).then(function(d){
    if(!d||d.error){$('ov-body').innerHTML='<div class="err">'+esc((d&&d.error)||'load failed')+'</div>';return;}
    var fm=d.frontmatter||{};
    $('ov-title').textContent=fm.title||'(task)';
    var rows='';
    function meta(k,v){if(v!=null&&v!=='')rows+='<div class="otask"><span class="otask-id">'+k+'</span><span class="otask-title">'+esc(String(v))+'</span></div>';}
    meta('priority',fm.priority);meta('status',fm.status);
    meta('project',fm.workspace_path||fm.client);meta('scheduled',fm.scheduled_date);
    meta('work block',fm.work_block);if(fm.time_estimate)meta('estimate',fm.time_estimate+'m');
    var body=(d.body||'').trim();
    $('ov-body').innerHTML=rows+'<div class="ovbody">'+(body?esc(body):'<span class="empty">No notes.</span>')+'</div>';
  }).catch(function(){$('ov-body').innerHTML='<div class="err">Failed to load task.</div>';});
}

/* Estimate cell — omitted entirely when 0 so the title noun phrase gets the
   width (long titles previously truncated before the meaningful word). */
function taskEst(t){return t.time_estimate?'<span class="trow-est">'+t.time_estimate+'m</span>':'';}

/* Work Queue — stacked sections (no tabs): High, Quick wins, By client. The
   whole panel scrolls; each task row is click-to-detail (opens the overlay with
   the task's Notes via /task); each client row opens the rollup overlay. A color
   legend sits in the panel footer. */
function renderWorkQueue(s){
  var b=s.backlog;
  var today=localToday();
  // A task committed to today's plan (scheduled_date===today) shows in the
  // Today's plan panel — exclude it from every Work-queue section so it isn't
  // double-documented. Overdue (<today) and unscheduled tasks stay on-deck.
  function onPlan(t){return t.scheduled_date===today;}
  // Blocked tasks are PARKED — readiness, not importance, so they keep their
  // priority but leave the active queue into a collapsed "Parked" group. The
  // active "Up next" only ranks work that can actually move now.
  var parked=allTasks(b).filter(function(t){return !onPlan(t)&&isBlocked(t);});
  var deck=allTasks(b).filter(function(t){return !onPlan(t)&&!isBlocked(t);});
  /* Up next — the folded queue. One row per umbrella group (project_groups.py),
     showing that group's recommended-next ACTIONABLE task. "Do first" order:
     the LLM rank (rank_tasks.py, the synthesized order) leads; unranked groups
     fall back to importance then quick-wins. Importance (high/med/low) and
     quick-win are badges, not their own sections. */
  var umb={},umbOrder=[];
  for(var i=0;i<deck.length;i++){
    var dt=deck[i],gi=groupInfo({project:dt.project,tasks:[dt]});
    var gk=dt.group||gi.rollup;
    if(!umb[gk]){umb[gk]={display:dt.group_display||gi.display,klass:dt.group_klass||gi.klass,group:gk,tasks:[]};umbOrder.push(gk);}
    umb[gk].tasks.push(dt);
  }
  for(var u=0;u<umbOrder.length;u++)
    umb[umbOrder[u]].tasks.sort(rankLex);
  // Order the umbrellas: client first (reputation), then by the recommended-next
  // task's own "do first" key — so the single most-urgent next task floats up
  // while each project still gets its own scannable row.
  umbOrder.sort(function(a,c){
    var ua=umb[a],uc=umb[c],ac=ua.klass==='client'?0:1,cc=uc.klass==='client'?0:1;
    if(ac!==cc)return ac-cc;
    return rankLex(ua.tasks[0],uc.tasks[0]);
  });

  var ttCount=$('wq-count');
  ttCount.textContent=deck.length?(umbOrder.length+' projects \\u00b7 '+deck.length+' ready'):'';
  ttCount.className='count';

  function sec(label,count,cls){
    return '<div class="wq-sec '+(cls||'')+'"><span>'+label+'</span><span class="wq-sec-n">'+count+'</span></div>';
  }
  // Secondary up-next row: a group's 2nd/3rd-ranked task, surfaced inline by the
  // fill pass below. Same chip/meta vocabulary as the main row, no pull/why.
  function secRow(st,g){
    var sm=[];
    if(st.time_estimate>0)sm.push(st.time_estimate+'m');
    if(st.work_block)sm.push(esc(st.work_block));
    var sqw=(st.time_estimate>0&&st.time_estimate<=30);
    return '<div class="trow click upnext-sec" data-path="'+esc(st.fs_path||'')+'">'
      +'<span class="pri '+priClass(st.priority)+'">'+priLetter(st.priority)+'</span>'
      +'<span class="tchip '+g.klass+'" title="'+esc(st.project)+'">'+esc(g.display)+'</span>'
      +'<span class="trow-title" title="'+esc(st.title)+'">'+esc(st.title)+'</span>'
      +(sqw?'<span class="tag green">quick</span>':'')
      +(sm.length?'<span class="tmeta">'+sm.join(' &middot; ')+'</span>':'')
      +'</div>';
  }
  function upnextRow(g,extra){
    var t=g.tasks[0];
    extra=Math.max(0,Math.min(extra||0,g.tasks.length-1));
    var more=g.tasks.length-1-extra;
    var meta=[];
    if(t.time_estimate>0)meta.push(t.time_estimate+'m');
    if(t.work_block)meta.push(esc(t.work_block));
    var qw=(t.time_estimate>0&&t.time_estimate<=30);
    // "+ Today" pull-in: only when this task's estimate fits the budget left
    // today (a null/0-estimate task fits trivially). Gated again server-side.
    var rem=(s.todayPlan&&s.todayPlan.remainingMinutes)||0;
    var fitsToday=t.id&&((t.time_estimate||0)<=rem);
    var pull=fitsToday
      ?'<span class="wq-pull writeable" data-kind="pull-in" data-id="'+esc(t.id)+'" data-ws="'+esc(t.project)+'" title="Commit to today ('+rem+'m free)">+ Today</span>'
      :'';
    var sec2='';
    for(var sxi=1;sxi<=extra;sxi++)sec2+=secRow(g.tasks[sxi],g);
    return '<div class="upnext">'
      +'<div class="trow click" data-path="'+esc(t.fs_path||'')+'">'
        +'<span class="pri '+priClass(t.priority)+'">'+priLetter(t.priority)+'</span>'
        +'<span class="tchip '+g.klass+'" title="'+esc(t.project)+'">'+esc(g.display)+'</span>'
        +'<span class="trow-title" title="'+esc(t.title)+'">'+esc(t.title)+'</span>'
        +(qw?'<span class="tag green">quick</span>':'')
        +(meta.length?'<span class="tmeta">'+meta.join(' &middot; ')+'</span>':'')
        +pull
      +'</div>'
      +(t.rank_reason?'<div class="upnext-why">'+esc(t.rank_reason)+'</div>':'')
      +sec2
      +(more>0?'<div class="upnext-more click" data-rollup="'+esc(g.group)+'">+'+more+' more in '+esc(g.display)+'</div>':'')
      +'</div>';
  }
  function parkedRowHtml(t){
    var gi=groupInfo({project:t.project,tasks:[t]});
    var dsp=t.group_display||gi.display,kl=t.group_klass||gi.klass;
    var dw=daysWaiting(t),stale=isStaleDays(dw,STALE_DAYS);
    var badge=readinessBadge(t);  // typed readiness chip (⛓ deps / ⏳ external wait)
    var wait=dw==null?'':(dw+'d'+(stale?' \\u21bb chase':''));  // staleness age, its own chip
    return '<div class="trow click'+(stale?' stale':'')+'" data-path="'+esc(t.fs_path||'')+'">'
      +'<span class="pri '+priClass(t.priority)+'">'+priLetter(t.priority)+'</span>'
      +'<span class="tchip '+kl+'" title="'+esc(t.project)+'">'+esc(dsp)+'</span>'
      +'<span class="trow-title" title="'+esc(t.title)+'">'+esc(t.title)+'</span>'
      +badge
      +(wait?'<span class="tmeta wait'+(stale?' stale':'')+'">'+wait+'</span>':'')
      +'</div>';
  }
  var body='';
  body+=sec('Up next',umbOrder.length,'');
  if(!umbOrder.length)body+='<div class="empty">Nothing ready &mdash; all parked or on today\\u2019s plan.</div>';
  else {
    // Fill pass (roast-v2 F7): when few projects leave the prime action column
    // short, surface each top group's next-ranked task(s) inline rather than
    // stretching a near-empty panel. Round-robin so the spread stays even; a
    // no-op once there are already >= FILL_TARGET groups (long backlog).
    var FILL_TARGET=12;
    var extra={},budget=Math.max(0,FILL_TARGET-umbOrder.length),guard=0;
    while(budget>0&&guard<500){
      var moved=false;
      for(var ui=0;ui<umbOrder.length&&budget>0;ui++){
        var gk=umbOrder[ui];
        if((extra[gk]||0)<umb[gk].tasks.length-1){extra[gk]=(extra[gk]||0)+1;budget--;moved=true;}
      }
      if(!moved)break;
      guard++;
    }
    for(var u=0;u<umbOrder.length;u++)body+=upnextRow(umb[umbOrder[u]],extra[umbOrder[u]]||0);
  }
  if(parked.length){
    // Newest-waiting first surfaces the stalest; collapsed by default so it
    // doesn't crowd the queue, but always present so nothing falls off the radar.
    parked.sort(function(a,c){var da=daysWaiting(a),dc=daysWaiting(c);return (dc==null?-1:dc)-(da==null?-1:da);});
    var staleN=0;for(var sb=0;sb<parked.length;sb++)if(isStaleDays(daysWaiting(parked[sb]),STALE_DAYS))staleN++;
    var brows='';for(var bi=0;bi<parked.length;bi++)brows+=parkedRowHtml(parked[bi]);
    body+='<div class="wq-blocked collapsed" id="wq-blocked">'
      +'<div class="wq-blocked-head"><span class="wq-sec-n">'+parked.length+'</span>'
      +'<span>Parked'+(staleN?' \\u00b7 '+staleN+' stale':'')+'</span>'
      +'<span class="chev">\\u25b8</span></div>'
      +'<div class="wq-blocked-list">'+brows+'</div></div>';
  }
  $('workqueue').innerHTML=body;
  // Workload ledger — every open task by category: count + est hours + a
  // bar weighted by hours (surfaces client = fewer tasks but heavier load).
  var WL=[{k:'client',l:'client'},{k:'internal',l:'internal'},{k:'skill',l:'tooling'},{k:'personal',l:'personal'},{k:'root',l:'other'}];
  var agg={},totN=0,totMin=0,allt=deck;
  for(var i=0;i<allt.length;i++){
    var kk=classify(allt[i].project).klass;
    if(!agg[kk])agg[kk]={n:0,min:0};
    agg[kk].n++;agg[kk].min+=allt[i].time_estimate||0;
    totN++;totMin+=allt[i].time_estimate||0;
  }
  var wlRows=WL.filter(function(x){return agg[x.k]&&agg[x.k].n>0;});
  wlRows.sort(function(a,c){var am=agg[a.k].min,cm=agg[c.k].min;return cm!==am?cm-am:(agg[c.k].n-agg[a.k].n);});
  var maxMin=1;
  for(var i=0;i<wlRows.length;i++)maxMin=Math.max(maxMin,agg[wlRows[i].k].min);
  function fmtH(m){return m>=60?(Math.round(m/60)+'h'):(m>0?(m+'m'):'\\u2013');}
  var wl='<div class="wl-head"><span>Workload</span><span class="wl-sub">'+totN+' open &middot; '+fmtH(totMin)+' est</span></div>';
  for(var i=0;i<wlRows.length;i++){
    var wk=wlRows[i].k,wa=agg[wk],ww=Math.max(3,Math.round(wa.min/maxMin*100));
    wl+='<div class="wl-row"><span class="wl-cat '+wk+'">'+wlRows[i].l+'</span>'
      +'<span class="wl-n">'+wa.n+'</span><span class="wl-h">'+fmtH(wa.min)+'</span>'
      +'<span class="wl-bar"><i style="width:'+ww+'%;background:'+klassColor(wk)+'"></i></span></div>';
  }
  $('wq-legend').innerHTML=wl;
}

function renderTrend(d){
  var pts=(d.points||[]).slice(-30);
  if(pts.length<2){
    $('trend-delta').textContent='';
    $('trend').innerHTML=(d.error?errBlock(d.error):'')
      +'<div class="empty">Accumulating &mdash; '+pts.length+' day(s) recorded. The line appears after 2+ days.</div>';
    return;
  }
  var latest=pts[pts.length-1];
  var target=new Date(latest.date).getTime()-7*86400000,ref=pts[0];
  for(var i=0;i<pts.length;i++){
    if(Math.abs(new Date(pts[i].date).getTime()-target)<Math.abs(new Date(ref.date).getTime()-target))ref=pts[i];
  }
  var delta=latest.total-ref.total;
  var dEl=$('trend-delta');
  dEl.textContent=(delta>0?'+':'')+delta+' vs '+ref.date;
  dEl.className='count trend-delta '+(delta>0?'up':'down');

  var W=320,H=140,padL=28,padR=10,padT=10,padB=20;
  var plotW=W-padL-padR,plotH=H-padT-padB;
  // Zoomed round-number axis — a backlog living at ~57 needs a tight range so a
  // small day-over-day change reads as a step, not a flat line.
  var lo=pts[0].total,hi=pts[0].total;
  for(var m=0;m<pts.length;m++){lo=Math.min(lo,pts[m].total);hi=Math.max(hi,pts[m].total);}
  var ax=niceAxis(lo,hi);
  var n=pts.length;
  function X(i){return padL+(n===1?0:i/(n-1)*plotW);}
  function Y(v){return padT+(1-(v-ax.lo)/(ax.hi-ax.lo))*plotH;}

  var grid='',labels='';
  for(var gv=ax.lo;gv<=ax.hi+ax.step*0.001;gv+=ax.step){
    var gy=Y(gv);
    grid+='<line x1="'+padL+'" y1="'+gy.toFixed(1)+'" x2="'+(padL+plotW)+'" y2="'+gy.toFixed(1)+'" stroke="#1d2b27" stroke-width="1"></line>';
    labels+='<text x="'+(padL-5)+'" y="'+(gy+3).toFixed(1)+'" text-anchor="end" font-size="8" fill="#556">'+Math.round(gv)+'</text>';
  }
  var line='',area='M'+X(0).toFixed(1)+','+Y(pts[0].total).toFixed(1),dots='';
  for(var k=0;k<n;k++){
    var px=X(k).toFixed(1),py=Y(pts[k].total).toFixed(1);
    line+=(k?' L':'M')+px+','+py;
    area+=' L'+px+','+py;
    dots+='<circle cx="'+px+'" cy="'+py+'" r="2.4" fill="#39d98a"><title>'+esc(pts[k].date+': '+pts[k].total+' open')+'</title></circle>';
  }
  area+=' L'+X(n-1).toFixed(1)+','+(padT+plotH)+' L'+X(0).toFixed(1)+','+(padT+plotH)+' Z';
  var xl='',idx=[0,Math.floor((n-1)/2),n-1];
  for(var x=0;x<idx.length;x++){
    var xi=idx[x];
    xl+='<text x="'+X(xi).toFixed(1)+'" y="'+(H-5)+'" text-anchor="middle" font-size="8" fill="#556">'+esc(pts[xi].date.slice(5))+'</text>';
  }
  $('trend').innerHTML=(d.error?errBlock(d.error):'')
    +'<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="xMidYMid meet">'+grid
    +'<path d="'+area+'" fill="#39d98a" fill-opacity="0.10"></path>'
    +'<path d="'+line+'" fill="none" stroke="#39d98a" stroke-width="2"></path>'
    +dots+labels+xl+'</svg>';
}

function dayKey(d){
  var y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),dd=String(d.getDate()).padStart(2,'0');
  return y+'-'+m+'-'+dd;
}
/* Closures panel (Slice C) — replaces Shipped Velocity. Honest count of
   tasks transitioned to status:complete in the last 14d, sourced from the
   task store (closures-since.py), not from /ship invocations. The /ship
   queue still appears as a secondary "tracked subset" mini-row so we can
   tell when the manual signal is firing without conflating it with reality. */
function klassColor(k){
  return k==='client'?'var(--client)':k==='skill'?'var(--tooling)'
    :k==='personal'?'#b39ddb':k==='root'?'var(--danger)':'var(--internal)';
}
function renderClosures(s){
  var c=s.closures||{windowDays:14,total:0,daily:[],byProject:[]};
  $('velo-count').textContent=c.total?c.total+' closed':'';
  var h=errBlock(c.error);
  h+='<div class="bigstat">'+c.total+' closed</div>';
  h+='<div class="mini-h">last '+c.windowDays+'d &middot; daily</div>';
  var days=c.daily||[];
  if(!days.length){
    h+='<div class="empty">No closure data.</div>';
  } else {
    // Daily bars — day-over-day change is the signal here; the old cumulative
    // line flattened it into invisible slope changes (2026-06-01 finding).
    var maxV=1;
    for(var i=0;i<days.length;i++)if(days[i].count>maxV)maxV=days[i].count;
    var bars='';
    for(var i=0;i<days.length;i++){
      var v=days[i].count;
      // Cap fill at 85% so the count label above the tallest bar stays inside
      // the chart; zero days keep a 2% baseline tick so the day reads as present.
      var hp=v>0?Math.max(Math.round(v/maxV*85),10):2;
      var isToday=(i===days.length-1);
      bars+='<div class="dbar'+(v>0?' click':'')+'"'+(v>0?' data-date="'+esc(days[i].date)+'"':'')
        +' title="'+esc(days[i].date+': '+v+' closed')+'">'
        +'<span class="dbar-n">'+(v>0?v:'')+'</span>'
        +'<span class="dbar-fill'+(isToday?' today':'')+(v>0?'':' zero')+'" style="height:'+hp+'%"></span>'
        +'</div>';
    }
    var MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var p0=days[0].date.split('-');
    h+='<div class="dbar-chart">'+bars+'</div>'
      +'<div class="chart-axis"><span>'+MON[parseInt(p0[1],10)-1]+' '+parseInt(p0[2],10)+'</span><span>today</span></div>';
  }
  h+='<div class="mini-h">Closed by project</div>';
  var bp=c.byProject||[];
  if(!bp.length){
    h+='<div class="empty">\\u2014</div>';
  } else {
    var maxP=bp[0].count||1;
    for(var i=0;i<Math.min(bp.length,6);i++){
      var cls=classify(bp[i].project);
      var w=Math.max(6,Math.round(bp[i].count/maxP*100));
      h+='<div class="brow click" data-project="'+esc(bp[i].project)+'"><span class="bname">'+esc(cls.display)+'</span>'
        +'<span class="btrack"><span class="pbar" style="width:'+w+'%"><span class="pseg" style="flex-grow:1;background:'+(cls.klass==='root'?'var(--internal)':klassColor(cls.klass))+'"></span></span></span>'
        +'<span class="bcount">'+bp[i].count+'</span></div>';
    }
  }
  $('velocity').innerHTML=h;
}

function renderInflight(d){
  var panel=$('inflight').closest('.panel');
  if(!d.items.length){
    if(panel)panel.classList.add('collapsed');
    $('inflight').innerHTML='';
    return;
  }
  if(panel)panel.classList.remove('collapsed');
  var h=errBlock(d.error);
  for(var i=0;i<d.items.length;i++){
    var b=d.items[i],sev=isStaleBinding(b.bound_at);
    h+='<div class="row"><div class="row-main">'+esc(b.task_title)
      +(sev?'<span class="tag '+(sev===2?'red':'amber')+'">'
        +(sev===2?'overnight':'stale')+'</span>':'')
      +'</div>'
      +'<div class="row-sub">'+esc(b.task_fs_id||'')
      +(b.client_id?' &middot; '+esc(b.client_id):'')
      +' &middot; bound '+esc(relTime(b.bound_at))+'</div></div>';
  }
  $('inflight').innerHTML=h;
}
/* renderCaptures + renderClientCommitments deleted in Slice B — their logic
   moved into renderWorkQueue's captures-tab body builder and client-tab body
   builder respectively. The buildClientCommitments data fn in snapshot.ts
   stays unchanged (the By client tab consumes s.clientCommitments.items). */

/* ---- business scoreboard — MRR/clients/renewal derived from contracts ---- */
function renderBusiness(d){
  // Always visible — these are metrics Zach intends to track, so the panel
  // stays in view with dim -- placeholders until business-metrics.json /
  // the bank API fills them (no auto-collapse).
  var panel=$('business').closest('.panel');
  if(panel)panel.classList.remove('collapsed');
  var stale=(d.lastUpdated!=null)&&(d.staleDays!=null&&d.staleDays>30);
  var upd=$('biz-updated');
  upd.textContent=d.lastUpdated?('updated '+d.lastUpdated):'placeholders';
  upd.className='count'+(stale?' warn':'');
  var h=errBlock(d.error);
  h+='<div class="duo">'
    +'<div class="statcard'+(d.mrr==null?' dim':'')+'"><div class="num">'+(d.mrr==null?'--':fmtUSD(d.mrr))+'</div><div class="lbl">MRR</div></div>'
    +'<div class="statcard'+(d.activeClients==null?' dim':'')+'"><div class="num">'+(d.activeClients==null?'--':d.activeClients)+'</div><div class="lbl">Active clients</div></div>'
    +'</div>';
  function kpi(label,val){
    var muted=(val==null);
    return '<div class="kpi"><span class="kpi-label">'+label+'</span>'
      +'<span class="kpi-val'+(muted?' muted':'')+'">'+(muted?'--':val)+'</span></div>';
  }
  h+=kpi('Pipeline value',d.pipelineValue==null?null:fmtUSD(d.pipelineValue));
  h+=kpi('A/R unpaid',d.arUnpaid==null?null:fmtUSD(d.arUnpaid));
  h+=kpi('LTV:CAC',d.ltvCacRatio==null?null:(d.ltvCacRatio+'x'));
  h+=kpi('Next renewal',d.nextRenewal?(esc(d.nextRenewal.client)+' &middot; '+esc(d.nextRenewal.date)):null);
  if(d.contracts&&d.contracts.length){
    h+='<table class="ptable" style="margin-top:6px"><thead><tr><th>Contract</th><th class="c-num">MRR</th><th>Status</th></tr></thead><tbody>';
    for(var i=0;i<d.contracts.length;i++){
      var c=d.contracts[i];
      h+='<tr><td class="c-task">'+esc(c.client)+'</td><td class="c-num">'+fmtUSD(c.monthlyValue)+'</td>'
        +'<td>'+esc(c.status||'')+'</td></tr>';
    }
    h+='</tbody></table>';
  }
  $('business').innerHTML=h;
  if(d.lastUpdated==null){
    $('business').innerHTML+='<div class="panel-foot">Set in data/business-metrics.json</div>';
  }
}

/* ---- Claude Code usage (API-equivalent value, not billed spend) ----
   De-noised: model-zero bars, raw token volume, and priciest-session IDs were
   cut — they did not tell Zach what to do next. 2x3 KPI grid led by Leverage
   (the real insight — the subscription is a great deal); the API-equivalent
   dollar figures are supporting evidence, deliberately de-emphasised because
   nobody would actually meter this workload on an API key. Cards: leverage,
   API-equiv this month, API-equiv today, projected month-end, cache hit rate,
   cache discount — plus the 13-week heatmap. */
/* Tokens panel (Slice C) — 3 hero cards (Leverage / Total spend MTD / Cache
   discount) replacing the 6-card sprawl. Leverage stays Claude-Code-only
   (preserves the "Max subscription is a steal" story). Total spend MTD folds
   in Anthropic API direct-use actual cost (s.apiSpend). The MTD cum chart
   gets a second stacked layer for API actual; the 30-day bars + 13-week
   heatmap stay Claude-Code-only by deliberate choice. */
/* Subscription rate-limit windows (5h + weekly) — utilization % the Claude
   desktop app shows. Used = closer to the cap, so high % colors warn/danger. */
function resetIn(iso){
  if(!iso)return '';
  var t=new Date(iso).getTime();
  if(isNaN(t))return '';
  var ms=t-Date.now();
  if(ms<=0)return 'resetting';
  var h=Math.floor(ms/3600000),m=Math.floor((ms%3600000)/60000);
  return 'resets in '+(h>=24?(Math.floor(h/24)+'d '+(h%24)+'h'):(h>0?(h+'h '+m+'m'):(m+'m')));
}
function renderRateLimits(rl){
  function win(label,w){
    if(!w||typeof w.pct!=='number'){
      return '<div class="rl"><div class="rl-top"><span class="rl-lbl">'+label
        +'</span><span class="rl-pct" style="color:var(--muted-2)">--</span></div>'
        +'<div class="rl-reset">unavailable</div></div>';
    }
    var pct=Math.round(w.pct);
    var cls=pct>=90?'danger':(pct>=70?'warn':'');
    var col=pct>=90?'var(--danger)':(pct>=70?'var(--warning)':'var(--accent)');
    return '<div class="rl"><div class="rl-top"><span class="rl-lbl">'+label
      +'</span><span class="rl-pct" style="color:'+col+'">'+pct+'%</span></div>'
      +'<div class="rl-bar"><i class="'+cls+'" style="width:'+Math.min(100,pct)+'%"></i></div>'
      +'<div class="rl-reset">'+esc(resetIn(w.resetsAt))+'</div></div>';
  }
  return '<div class="rl-strip">'+win('5h window',rl&&rl.fiveHour)
    +win('Weekly',rl&&rl.sevenDay)+'</div>';
}
function renderTokens(d,biz,apiSpend,rl){
  var h=errBlock(d.error);
  // 5h + weekly subscription rate-limit windows at the top — the highest-glance
  // usage signal ("how much runway is left"). Live from /api/oauth/usage.
  h+=renderRateLimits(rl);
  var now=new Date(),day=now.getDate();
  var dim=new Date(now.getFullYear(),now.getMonth()+1,0).getDate();
  var hr=d.cacheHitRate||0;
  var apiToday=(apiSpend&&apiSpend.today)||0;
  var apiMonth=(apiSpend&&apiSpend.month)||0;
  var apiPrev=apiSpend&&apiSpend.prevMonth;
  var apiProjected=day>0?apiMonth/day*dim:apiMonth;
  var apiSrc=apiSpend?apiSpend.source:'unavailable';
  function hero(num,lbl,sub){
    return '<div class="statcard"><div class="num">'+num+'</div>'
      +'<div class="lbl">'+lbl+'</div>'
      +(sub?'<div class="sublbl">'+sub+'</div>':'')+'</div>';
  }
  // API spend is the real out-of-pocket cost — lead with it; MoM delta surfaces a spike.
  var apiSub;
  if(apiSrc==='unavailable'){apiSub='source pending';}
  else {
    apiSub='proj '+fmtUSD(apiProjected)+' &middot; today '+fmtUSD(apiToday);
    if(apiPrev!=null&&apiPrev>0){var dd=apiMonth-apiPrev;apiSub+=' &middot; '+(dd>=0?'\\u25b2':'\\u25bc')+fmtUSD(Math.abs(dd))+' vs LM';}
  }
  h+='<div class="trio">'
    +hero(fmtUSD(apiMonth),'API spend MTD',apiSub)
    +hero(Math.round(hr*100)+'%','Cache hit rate','')
    +'</div>';
  h+='<div class="mini-h">Claude Code usage &middot; last 30 days</div>';
  h+='<div id="token-bars"></div>';
  h+='<div class="mini-h">Usage heatmap &middot; 13 weeks</div>';
  h+='<div id="token-heatmap"></div>';
  $('tokens').innerHTML=h;
  renderBars30(d.daily||[]);
  renderHeatmap(d.daily||[]);
}


/* Last 30 days as daily bars. Same quartile palette as the heatmap so the
   two share a visual language; bars give absolute magnitude (the heatmap is
   only shaded by quartile, so it flattens spikes). */
function renderBars30(daily){
  var el=$('token-bars');
  if(!el)return;
  if(!daily||!daily.length){el.innerHTML='<div class="empty">Accumulating usage history.</div>';return;}
  var last=daily.slice(-30);
  var maxV=0;
  for(var i=0;i<last.length;i++)if(last[i].costUSD>maxV)maxV=last[i].costUSD;
  if(maxV===0)maxV=1;
  var LEVELS=['#161616','#0e3a24','#157f43','#1fbf63','#39d98a'];
  var nz=[];
  for(var i=0;i<last.length;i++)if(last[i].costUSD>0)nz.push(last[i].costUSD);
  nz.sort(function(a,b){return a-b;});
  function q(p){return nz.length?nz[Math.floor(p*(nz.length-1))]:0;}
  var t1=q(0.25),t2=q(0.5),t3=q(0.75);
  function lvl(v){if(v<=0)return 0;if(v<=t1)return 1;if(v<=t2)return 2;if(v<=t3)return 3;return 4;}
  var W=240,H=85,padT=4,padB=4;
  var plotH=H-padT-padB;
  var n=last.length,gap=2;
  var barW=(W-(n-1)*gap)/n;
  var s='<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" style="width:100%;height:85px;display:block">';
  for(var i=0;i<n;i++){
    var v=last[i].costUSD;
    var bh=v>0?Math.max(v/maxV*plotH,1):0;
    var bx=i*(barW+gap);
    var by=padT+plotH-bh;
    s+='<rect x="'+bx.toFixed(2)+'" y="'+by.toFixed(2)+'" width="'+barW.toFixed(2)+'" height="'+bh.toFixed(2)
      +'" fill="'+LEVELS[lvl(v)]+'"><title>'+esc(last[i].date+': '+(v>0?fmtUSD(v):'no usage'))+'</title></rect>';
  }
  s+='</svg>';
  // Format the left axis label as "MMM D" from the first daily entry's ISO date.
  var MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var p=last[0].date.split('-');
  var leftLbl=MON[parseInt(p[1],10)-1]+' '+parseInt(p[2],10);
  el.innerHTML=s+'<div class="chart-axis"><span>'+leftLbl+'</span><span>today</span></div>';
}

/* GitHub-style usage heatmap — trailing 13 weeks. 7 day-rows x week-columns;
   the grid fills the column width, cells stay square (aspect-ratio:1). Cell
   shade = quartile bucket of that day's list-price cost. */
function renderHeatmap(daily){
  var el=$('token-heatmap');
  if(!el)return;
  if(!daily||!daily.length){el.innerHTML='<div class="empty">Accumulating usage history.</div>';return;}
  var LEVELS=['#161616','#0e3a24','#157f43','#1fbf63','#39d98a'];
  var nz=[];
  for(var i=0;i<daily.length;i++)if(daily[i].costUSD>0)nz.push(daily[i].costUSD);
  nz.sort(function(a,b){return a-b;});
  function quart(p){return nz.length?nz[Math.floor(p*(nz.length-1))]:0;}
  var t1=quart(0.25),t2=quart(0.5),t3=quart(0.75);
  function level(v){if(v<=0)return 0;if(v<=t1)return 1;if(v<=t2)return 2;if(v<=t3)return 3;return 4;}
  // Leading blanks so the first day sits on its real weekday row (0=Sun).
  var lead=new Date(daily[0].date+'T00:00:00').getDay();
  var cells='';
  for(var b=0;b<lead;b++)cells+='<div class="hm-cell" style="background:transparent"></div>';
  for(var d=0;d<daily.length;d++){
    var v=daily[d].costUSD;
    cells+='<div class="hm-cell click" data-date="'+esc(daily[d].date)+'" style="background:'+LEVELS[level(v)]+'" title="'
      +esc(daily[d].date+': '+(v>0?fmtUSD(v):'no usage'))+'"></div>';
  }
  var legend='<div class="hm-legend"><span>less</span>';
  for(var L=0;L<LEVELS.length;L++)legend+='<i class="hm-key" style="background:'+LEVELS[L]+'"></i>';
  legend+='<span>more</span></div>';
  el.innerHTML='<div class="hm-grid">'+cells+'</div>'+legend;
}

/* ===================== PERSONAL PANELS (right-rail) =====================
   Training + Meals live in the consolidated view's col 4 (habit tracking
   retired 2026-06-11 — Zach's personal tracking is analog). */

/* Meal/feeding slot ordering (Breakfast→Lunch→Dinner→Snack→Smoothie) + a
   title→recipe helper, shared by the Today's meals panel and the Tomorrow lane. */
var SLOT_RANK={breakfast:0,lunch:1,dinner:2,dessert:3,snack:4};
var SLOT_LABEL={breakfast:'Breakfast',lunch:'Lunch',dinner:'Dinner',dessert:'Dessert',snack:'Snack'};
var SLOTS_ORDER=['breakfast','lunch','dinner','dessert','snack'];
function mealRecipe(title){var m=/[—-]\s+(.+)$/.exec(String(title||''));return m?m[1].trim():String(title||'');}
function slotKey(title){return String(title||'').replace('—','-').split('-')[0].trim().toLowerCase();}
function slotRank(title){var h=slotKey(title);return (h in SLOT_RANK)?SLOT_RANK[h]:9;}
function localDateStr(off){var d=new Date();d.setDate(d.getDate()+off);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
/* Expanded picker options — shared by TODAY + TOMORROW. Options carry data-date so
   writeAction posts to the right day; the inventory-ranked suggestions are date-independent. */
function mealOptsHtml(date,slot,suggestions,pickedRecipe){
  var h='',sug=suggestions||[];
  if(!sug.length)h+='<div class="tmr-opt"><span class="nm" style="color:var(--muted-2)">no in-stock suggestion</span></div>';
  for(var o=0;o<sug.length;o++){var g=sug[o],pk=pickedRecipe===g.name;
    h+='<div class="tmr-opt writeable'+(pk?' picked':'')+'" data-kind="meals-pick" data-date="'+esc(date)+'" data-slot="'+esc(slot)+'" data-name="'+esc(g.name)+'">'
      +'<span class="pct">'+Math.round((g.matchPct||0)*100)+'%</span><span class="nm">'+esc(g.name)+'</span>'
      +(g.needsThaw?'<span class="thaw">THAW</span>':'')+(g.missing&&g.missing.length?'<span class="miss">-'+g.missing.length+'</span>':'')+'</div>';}
  return h;
}
function trainOptsHtml(date,rotation,curSession){
  var h='',rot=rotation||[];
  for(var r=0;r<rot.length;r++){var isC=rot[r]===curSession;
    h+='<div class="tmr-opt writeable'+(isC?' picked':'')+'" data-kind="training-schedule" data-date="'+esc(date)+'" data-session="'+esc(rot[r])+'"><span class="nm">'+esc(rot[r])+'</span></div>';}
  return h;
}

/* A selected-primary row (check + slot + chosen name + optional pill). */
function todayCheckRow(o){
  return '<div class="'+(o.writeable?'prow writeable':'prow')+'"'+(o.attrs||'')+'>'
    +'<span class="pcheck'+(o.checked?' on':'')+'">'+(o.checked?'\\u2713':'')+'</span>'
    +'<span class="pslot">'+esc(o.slot||'')+'</span>'
    +'<span class="pname">'+esc(o.name||'')+'</span>'
    +(o.pill?'<span class="ppill '+o.pill.cls+'">'+esc(o.pill.txt)+'</span>':'')
    +'</div>';
}
/* TODAY — interactive tracker. Each meal/training row: a complete checkbox + a
   change/schedule picker (writes for today's date).
   Suggestions/rotation come from the (date-independent) Tomorrow lane. */
function todayMealRow(slot,picked,suggestions,date,exp){
  var key='today:'+slot,lbl=SLOT_LABEL[slot]||slot,recipe=picked?mealRecipe(picked.title):null,done=picked&&picked.status==='complete';
  if(exp[key])
    return '<div class="prow expanded" data-expand="'+key+'"><span class="pcheck"></span><span class="pslot">'+esc(lbl)+'</span><span class="pname ph">choose\\u2026</span><span class="pchg">close</span></div>'+mealOptsHtml(date,slot,suggestions,recipe);
  var chk=(picked&&picked.id)
    ?'<span class="pcheck writeable'+(done?' on':'')+'" data-kind="task-complete" data-id="'+esc(picked.id)+'" data-ws="'+esc(picked.workspacePath||'Internal/meal-system')+'" data-done="'+(done?'1':'0')+'" title="mark '+(done?'open':'done')+'">'+(done?'\\u2713':'')+'</span>'
    :'<span class="pcheck"></span>';
  return '<div class="prow'+(recipe?'':' empty')+'">'+chk
    +'<span class="pslot">'+esc(lbl)+'</span>'
    +'<span class="pname'+(recipe?'':' ph')+'">'+(recipe?esc(recipe):'\\u2014 schedule \\u2014')+'</span>'
    +'<span class="pchg" data-expand="'+key+'">'+(recipe?'change':'pick')+'</span></div>';
}
/* Meals section: collapse unscheduled slots into ONE pick affordance so an
   unplanned day doesn't render 5 identical "— schedule —" dashes that read as
   broken in peripheral vision. Expanding (today:meals-all) shows the full
   5-slot picker; scheduled slots always render as their own rows. (roast-v2 F8) */
function todayMealsSection(pickedBySlot,sugBySlot,date,exp){
  var scheduled=[],empty=[];
  for(var k=0;k<SLOTS_ORDER.length;k++){
    var slot=SLOTS_ORDER[k];
    (pickedBySlot[slot]?scheduled:empty).push(slot);
  }
  // Fully planned OR user expanded the picker → render every slot row in order.
  if(!empty.length||exp['today:meals-all']){
    var hh='';
    for(var a=0;a<SLOTS_ORDER.length;a++)hh+=todayMealRow(SLOTS_ORDER[a],pickedBySlot[SLOTS_ORDER[a]],sugBySlot[SLOTS_ORDER[a]],date,exp);
    if(empty.length)
      hh+='<div class="prow meals-collapse" data-expand="today:meals-all">'
        +'<span class="pcheck"></span><span class="pslot">Meals</span>'
        +'<span class="pname ph">'+empty.length+' unscheduled</span>'
        +'<span class="pchg">collapse</span></div>';
    return hh;
  }
  // Collapsed: scheduled rows first, then a single affordance for the empties.
  var h='';
  for(var b=0;b<scheduled.length;b++)h+=todayMealRow(scheduled[b],pickedBySlot[scheduled[b]],sugBySlot[scheduled[b]],date,exp);
  h+='<div class="prow meals-collapse'+(scheduled.length?'':' empty')+'" data-expand="today:meals-all">'
    +'<span class="pcheck"></span><span class="pslot">Meals</span>'
    +'<span class="pname ph">'+(scheduled.length?(empty.length+' unscheduled'):'none planned')+'</span>'
    +'<span class="pchg">pick</span></div>';
  return h;
}
/* Workout type (column) + name from a session string — de-dups the old triple
   "Training". "Upper A"->Lift/"Upper A"; "Swim — Technique"->Swim/"Technique". */
function workoutType(session){var s=String(session||'').toLowerCase();
  if(s.indexOf('swim')===0)return 'Swim';if(s.indexOf('run')===0)return 'Run';if(s.indexOf('bike')===0)return 'Bike';
  if(s.indexOf('upper')===0||s.indexOf('lower')===0)return 'Lift';return s?'Workout':'';}
function workoutName(session){var s=String(session||'');var m=/[—–-]\s*(.+)$/.exec(s);return m?m[1].trim():s;}
function todayTrainingRow(tr,rotation,date,exp){
  var key='today:training',scheduled=tr.todayScheduled&&tr.todayTitle,sess=scheduled?mealRecipe(tr.todayTitle):(tr.nextSession||null),done=tr.todayComplete;
  if(exp[key])
    return '<div class="prow expanded" data-expand="'+key+'"><span class="pcheck"></span><span class="pslot">swap</span><span class="pname ph">choose\\u2026</span><span class="pchg">close</span></div>'+trainOptsHtml(date,(rotation&&rotation.length?rotation:(sess?[sess]:[])),sess);
  var chk=(scheduled&&tr.todayId)
    ?'<span class="pcheck writeable'+(done?' on':'')+'" data-kind="task-complete" data-id="'+esc(tr.todayId)+'" data-ws="'+esc(tr.todayWorkspacePath||'Internal/training-system')+'" data-done="'+(done?'1':'0')+'" title="mark '+(done?'open':'done')+'">'+(done?'\\u2713':'')+'</span>'
    :'<span class="pcheck"></span>';
  var typeLbl=scheduled?workoutType(sess):'';
  var nm=scheduled?workoutName(sess):(tr.restRecommended?'Rest day':(sess?sess+' \\u00b7 not scheduled':'No training'));
  var h='<div class="prow'+(scheduled?'':' empty')+'">'+chk
    +'<span class="pslot">'+esc(typeLbl)+'</span>'
    +'<span class="pname'+(scheduled?'':' ph')+'">'+esc(nm)+'</span>'
    +'<span class="pchg" data-expand="'+key+'">'+(scheduled?'swap':'schedule')+'</span></div>';
  if(scheduled&&tr.todaySession&&tr.todaySession.length){
    // Lift day: structured rows with an editable log field + progression hint.
    var prog=tr.progression||{};
    h+='<div class="pexlist">';
    for(var e=0;e<tr.todaySession.length;e++){var ex=tr.todaySession[e];var pg=prog[ex.exercise];
      h+='<div class="pexrow">'
        +'<span class="pex-nm" title="'+esc(ex.exercise)+'">'+esc(ex.exercise)+'</span>'
        +'<span class="pex-tgt">'+esc(ex.target)+'</span>'
        +'<input class="pexlog" type="text" data-id="'+esc(tr.todayId)+'" data-ws="'+esc(tr.todayWorkspacePath||'Internal/training-system')+'" data-exercise="'+esc(ex.exercise)+'" value="'+esc(ex.log)+'" placeholder="'+(ex.last?('last '+esc(ex.last)):'log')+'">'
        +(pg&&pg.suggestion?'<span class="pex-prog">'+esc(pg.suggestion)+'</span>':'')
        +'</div>';
    }
    h+='</div>';
  }else if(scheduled&&tr.todayExercises&&tr.todayExercises.length){
    // Endurance day: concrete distance/duration/zone readout (from program.md),
    // styled distinct from the lift table so a cardio day reads as a cardio day.
    h+='<div class="pexlist cardio"><div class="pex-cap">(readout)</div>';
    for(var e2=0;e2<tr.todayExercises.length;e2++)h+='<div class="pex">'+esc(tr.todayExercises[e2])+'</div>';
    h+='</div>';
  }
  return h;
}
function renderToday(s){
  var tr=s.training||{},mealsD=s.meals||{items:[]},tomorrow=s.tomorrow||{meals:[],training:{}};
  var date=localDateStr(0),exp=window.__expand||(window.__expand={});
  var sugBySlot={};for(var a=0;a<(tomorrow.meals||[]).length;a++)sugBySlot[tomorrow.meals[a].slot]=tomorrow.meals[a].suggestions||[];
  var rotation=(tomorrow.training&&tomorrow.training.rotation)||[];
  var pickedBySlot={},items=mealsD.items||[];
  for(var j=0;j<items.length;j++)pickedBySlot[slotKey(items[j].title)]=items[j];
  var h=errBlock(mealsD.error);
  h+='<div class="today-sec">Training</div>'+todayTrainingRow(tr,rotation,date,exp);
  h+='<div class="today-sec">Meals</div>';
  h+=todayMealsSection(pickedBySlot,sugBySlot,date,exp);
  var md=0;for(var z=0;z<items.length;z++)if(items[z].status==='complete')md++;
  $('today-count').textContent=items.length?'meals '+md+'/'+items.length:'';
  $('today').innerHTML=h;
}

/* TOMORROW — selected-primary planner (meals + training) + a Work block (tasks
   scheduled for tomorrow + proposed pulls). Shares the option helpers + the
   window.__expand state ('tomorrow:'+slot keys) with TODAY. */
/* Evening-review freshness line for the Tomorrow panel footer. Reviewed-today =
   calm done stamp; not-reviewed-today only nudges (amber) after 7pm — a not-yet-
   done review at 9am isn't "stale". Error = "could not verify", never the nudge. */
function reviewStampHtml(rv){
  if(!rv)return '';
  var today=localDateStr(0);
  if(rv.error)return '<div class="review-stamp muted">Review status unavailable</div>';
  if(rv.lastReviewedDate===today){
    var t='';
    if(rv.lastReviewedAt){var dt=new Date(rv.lastReviewedAt);if(!isNaN(dt))t=' '+String(dt.getHours()).padStart(2,'0')+':'+String(dt.getMinutes()).padStart(2,'0');}
    return '<div class="review-stamp done">\\u2713 Reviewed'+t+'</div>';
  }
  if(new Date().getHours()>=19)return '<div class="review-stamp nudge">\\u26a0 Evening review pending \\u00b7 /evening-review</div>';
  var when=rv.lastReviewedDate?(rv.lastReviewedDate===localDateStr(-1)?'yesterday':rv.lastReviewedDate.slice(5)):'never';
  return '<div class="review-stamp muted">Last reviewed: '+esc(when)+'</div>';
}
function renderTomorrow(d,rv){
  d=d||{meals:[],training:{},thaw:[],planned:false,work:{committed:[],proposed:[]}};
  var meals=(d.meals||[]).slice().sort(function(a,b){return (SLOT_RANK[a.slot]||0)-(SLOT_RANK[b.slot]||0);});
  var tr=d.training||{},date=d.date||localDateStr(1);
  $('tomorrow-count').textContent=d.date?d.date.slice(5):'';
  var exp=window.__expand||(window.__expand={});
  var h=errBlock(d.error);
  h+='<div class="today-sec">Meals</div>';
  for(var s=0;s<meals.length;s++){
    var sl=meals[s],recipe=sl.picked?mealRecipe(sl.picked.title):null,lbl=SLOT_LABEL[sl.slot]||sl.slot,key='tomorrow:'+sl.slot;
    if(exp[key]){
      h+='<div class="prow expanded" data-expand="'+esc(key)+'"><span class="pcheck"></span><span class="pslot">'+esc(lbl)+'</span><span class="pname ph">choose\\u2026</span><span class="pchg">close</span></div>'
        +mealOptsHtml(date,sl.slot,sl.suggestions,recipe);
    } else {
      var chosen=!!recipe;
      h+='<div class="prow'+(chosen?'':' empty')+'">'
        +'<span class="pcheck'+(chosen?' on':'')+'">'+(chosen?'\\u2713':'')+'</span>'
        +'<span class="pslot">'+esc(lbl)+'</span>'
        +'<span class="pname'+(chosen?'':' ph')+'">'+(chosen?esc(recipe):'\\u2014 choose \\u2014')+'</span>'
        +'<span class="pchg" data-expand="'+esc(key)+'">'+(chosen?'change':'pick')+'</span></div>';
    }
  }
  // Training — one row + swap.
  h+='<div class="today-sec">Training</div>';
  var curSess=tr.scheduled?mealRecipe(tr.scheduled.title):(tr.restRecommended?null:tr.suggestion);
  if(exp['tomorrow:training']){
    h+='<div class="prow expanded" data-expand="tomorrow:training"><span class="pcheck"></span><span class="pslot">Training</span><span class="pname ph">swap\\u2026</span><span class="pchg">close</span></div>'
      +trainOptsHtml(date,(tr.rotation&&tr.rotation.length?tr.rotation:(tr.suggestion?[tr.suggestion]:[])),curSess);
  } else {
    var hasT=!!tr.scheduled;
    h+='<div class="prow'+(hasT?'':' empty')+'">'
      +'<span class="pcheck'+(hasT?' on':'')+'">'+(hasT?'\\u2713':'')+'</span>'
      +'<span class="pslot">Training</span>'
      +'<span class="pname'+(curSess?'':' ph')+'">'+esc(curSess||(tr.restRecommended?'Rest day':'\\u2014'))+'</span>'
      +'<span class="pchg" data-expand="tomorrow:training">'+(hasT?'swap':'schedule')+'</span></div>';
  }
  if(d.thaw&&d.thaw.length)h+='<div class="tmr-thaw">\\u26a0 Thaw tonight: '+esc(d.thaw.join(', '))+'</div>';
  // Work — committed tomorrow tasks + proposed pulls.
  var work=d.work||{committed:[],proposed:[]};
  h+='<div class="today-sec">Work</div>';
  function workRow(t,action,label){
    var meta=esc(shortProj(t.project))+(t.estMin?' \\u00b7 '+t.estMin+'m':'');
    return '<div class="prow"><span class="pcheck'+(action==='clear'?' on':'')+'"></span>'
      +'<span class="pname" title="'+esc(t.title)+'">'+esc(t.title)+'</span>'
      +'<span class="wproj">'+meta+'</span>'
      +'<span class="pchg writeable" data-kind="schedule-task" data-id="'+esc(t.id)+'" data-ws="'+esc(t.project)+'" data-date="'+esc(action==='clear'?'clear':date)+'">'+label+'</span></div>';
  }
  if(!work.committed.length&&!work.proposed.length){
    h+='<div class="prow"><span class="pcheck"></span><span class="pname ph">no work queued</span></div>';
  }
  for(var w=0;w<work.committed.length;w++)h+=workRow(work.committed[w],'clear','remove');
  for(var p=0;p<work.proposed.length;p++)h+=workRow(work.proposed[p],'commit','commit');
  h+=reviewStampHtml(rv);
  $('tomorrow').innerHTML=h;
}

/* Calendar — today's meetings (fixed blocks) + dimmed 5-day prep horizon.
   PULL-only: the snapshot reads Google Calendar live via calendar-read-window.py.
   Collapses like Meals when the whole window is empty — but NOT on error:
   "could not verify" must stay visible, it is not the same as "no meetings". */
function renderCalendar(d){
  // Pre-deploy localStorage boot-paint snapshots lack the calendar field.
  d=d||{today:[],prepHorizon:[],meetingMinutesToday:0};
  var panel=$('calendar').closest('.panel');
  var total=d.today.length+d.prepHorizon.length;
  if(!total&&!d.error){
    if(panel)panel.classList.add('collapsed');
    $('calendar-count').textContent='';
    $('calendar').innerHTML='';
    return;
  }
  if(panel)panel.classList.remove('collapsed');
  var hrs=d.meetingMinutesToday?(Math.round(d.meetingMinutesToday/6)/10)+'h':'';
  $('calendar-count').textContent=d.today.length?d.today.length+' today'+(hrs?' \\u00b7 '+hrs:''):'';
  var h=errBlock(d.error);
  function tm(s){return s&&s.indexOf('T')>0?s.slice(11,16):'';}
  for(var i=0;i<d.today.length;i++){
    var ev=d.today[i];
    h+='<div class="row"><div class="row-main">'+esc(ev.title)
      +'<span class="tag">'+(ev.allDay?'all day':esc(tm(ev.start))+'\\u2013'+esc(tm(ev.end)))+'</span></div></div>';
  }
  if(!d.today.length&&!d.error)h+='<div class="empty">No meetings today.</div>';
  if(d.prepHorizon.length){
    h+='<div class="row-sub" style="margin-top:6px">Next days</div>';
    for(var j=0;j<d.prepHorizon.length;j++){
      var p=d.prepHorizon[j];
      h+='<div class="row-sub">'+esc(p.date.slice(5))
        +(p.allDay?'':' '+esc(tm(p.start)))+' \\u00b7 '+esc(p.title)+'</div>';
    }
  }
  $('calendar').innerHTML=h;
}

/* ---- Today's plan (committed daily plan, scheduled-for-today tasks) ----
   Captures count is no longer alerted here (Slice B moved it to the Work
   Queue's Captures tab). Overdue alarm + empty-plan alarm stay.
   The movement arg (todayPlan.completedToday / .movedAway from the
   today-manifest) renders tasks that LEFT the plan as struck/dimmed rows
   instead of letting them silently vanish. */
function renderTodayPlan(tasks,overdue,minutes,elId,countId,clientUnplanned,movement){
  var done=(movement&&movement.completedToday)||[];
  var moved=(movement&&movement.movedAway)||[];
  // Capacity meter: committed vs the meeting-adjusted budget, with free/over.
  // movement IS s.todayPlan, so it carries availableMinutes / remainingMinutes.
  var avail=(movement&&movement.availableMinutes)||0;
  var remain=(movement&&movement.remainingMinutes)||0;
  var over=minutes-avail; // >0 ⇒ overcommitted
  var cnt='';
  if(tasks.length){
    cnt=(minutes/60).toFixed(1)+'h / '+(avail/60).toFixed(1)+'h';
    var ovTxt=fmtOver(over);
    cnt+=(over>0?' \\u00b7 over by '+ovTxt:' \\u00b7 '+remain+'m free');
  }
  if(done.length)cnt+=(cnt?' \\u00b7 ':'')+done.length+' done';
  var cEl=$(countId);
  cEl.textContent=cnt;
  cEl.style.color=(tasks.length&&over>0)?'var(--danger)':'';
  var h='';
  if(!tasks.length){
    if(done.length||moved.length){
      // The plan existed and everything on it was handled — completed,
      // rescheduled, or unscheduled tasks all leave Today's plan (Closures +
      // Work queue own them now). Show a single calm state instead of rows.
      if(overdue>0)
        // Overdue still open => the day is NOT complete; show only the triage
        // prompt — overdue must be cleared same-day.
        h+='<div class="err" style="background:#1f1700;border-color:#3a2e00;color:#d8b24c">'
          +overdue+' overdue &middot; triage in Claude Code</div>';
      else
        h+='<div class="empty" style="color:var(--accent)">Complete</div>';
      $(elId).innerHTML=h;return;
    }
    // 7am morning proposal — when a plan was auto-proposed for this uncommitted
    // day, render it (accept / reject) IN PLACE OF the empty alarm. (T-2026-05-29-001)
    var prop=movement&&movement.proposal;
    if(prop&&prop.tasks&&prop.tasks.length){
      var ph='<div class="prop">';
      ph+='<div class="prop-head"><span class="prop-ttl">Proposed plan</span>'
        +'<span class="prop-acts">'
        +'<button class="prop-btn acc" id="plan-accept-btn">Accept</button>'
        +'<button class="prop-btn rej" id="plan-reject-btn">Reject</button></span></div>';
      if(prop.triageNeeded&&prop.overdueCount>0)
        ph+='<div class="err" style="background:#1f1700;border-color:#3a2e00;color:#d8b24c">'
          +prop.overdueCount+' overdue &middot; triage in Claude Code</div>';
      var pmin=0;for(var pk=0;pk<prop.tasks.length;pk++)pmin+=(prop.tasks[pk].estMin||0);
      var p0=prop.tasks[0];
      ph+='<div class="nextrow"><span class="nx">PLAN</span>'
        +'<span class="nx-title" title="'+esc(p0.title)+'">'+esc(p0.title)+'</span>'
        +'<span class="nx-meta">'+(p0.workBlock?esc(p0.workBlock)+' &middot; ':'')
          +esc(shortProj(p0.project))+(p0.estMin?' &middot; '+p0.estMin+'m':'')+'</span></div>';
      for(var pj=1;pj<prop.tasks.length;pj++){
        var pt=prop.tasks[pj];
        ph+='<div class="trow">'
          +'<span class="pri '+priClass(pt.priority)+'">'+priLetter(pt.priority)+'</span>'
          +'<span class="trow-title" title="'+esc(pt.title)+'">'+esc(pt.title)+'</span>'
          +(pt.workBlock?'<span class="tag">'+esc(pt.workBlock)+'</span>':'')
          +'<span class="trow-proj" title="'+esc(pt.project)+'">'+esc(shortProj(pt.project))+'</span>'
          +'<span class="trow-est">'+(pt.estMin?pt.estMin+'m':'-')+'</span></div>';
      }
      ph+='<div class="prop-foot">'+prop.tasks.length+' task'+(prop.tasks.length===1?'':'s')
        +' &middot; '+(pmin/60).toFixed(1)+'h proposed &middot; accept to commit the day</div>';
      ph+='</div>';
      $(elId).innerHTML=ph;return;
    }
    // Empty pro-plan = alarm (clientUnplanned is a number). Combine overdue +
    // no-plan + unplanned into ONE alarm box so the panel doesn't stack two
    // near-identical yellow boxes when both signals fire.
    if(clientUnplanned!=null){
      var lines=['<b>No plan committed</b>'];
      if(overdue>0)lines.push(overdue+' overdue');
      if(clientUnplanned>0)lines.push(clientUnplanned+' high-priority client task'+(clientUnplanned===1?'':'s')+' unplanned');
      lines.push('Run /plan-day');
      h+='<div class="err" style="font-size:11px;line-height:1.4">'+lines.join(' &middot; ')+'</div>';
    } else {
      h+='<div class="empty">Nothing scheduled today.</div>';
    }
    $(elId).innerHTML=h;return;
  }
  // Non-empty case — overdue alert (when present) sits above the task list.
  if(overdue>0)
    h+='<div class="err" style="background:#1f1700;border-color:#3a2e00;color:#d8b24c">'
      +overdue+' overdue &middot; triage in Claude Code</div>';
  var sorted=tasks.slice().sort(planCmp);
  // Hero the single next action (top of the sorted plan) so the board answers
  // "what do I do next" at a glance; the rest follow as the standard list.
  var top=sorted[0];
  h+='<div class="nextrow">'
    +'<span class="nx">NEXT</span>'
    +'<span class="nx-title" title="'+esc(top.title)+'">'+esc(top.title)+'</span>'
    +'<span class="nx-meta">'+(top.work_block?esc(top.work_block)+' &middot; ':'')
      +esc(shortProj(top.project))+(top.time_estimate?' &middot; '+top.time_estimate+'m':'')+'</span>'
    +'</div>';
  for(var i=1;i<sorted.length;i++){
    var t=sorted[i];
    h+='<div class="trow">'
      +'<span class="pri '+priClass(t.priority)+'">'+priLetter(t.priority)+'</span>'
      +'<span class="trow-title" title="'+esc(t.title)+'">'+esc(t.title)+'</span>'
      +(t.work_block?'<span class="tag">'+esc(t.work_block)+'</span>':'')
      +'<span class="trow-proj" title="'+esc(t.project)+'">'+esc(shortProj(t.project))+'</span>'
      +'<span class="trow-est">'+(t.time_estimate?t.time_estimate+'m':'-')+'</span></div>';
  }
  $(elId).innerHTML=h;
}

/* ===================== RENDER + WIRING ===================== */

function render(s){
  setGeneratedCue(s.generated);
  renderStats(s);
  renderTodayPlan(s.todayPlan.professional,s.todayPlan.overduePro,s.todayPlan.committedMinutesPro,'today-pro','today-pro-count',clientUnplannedCount(s),s.todayPlan);
  renderBacklog(s.backlog);
  renderWorkQueue(s);
  renderTrend(s.trend);
  renderClosures(s);
  renderInflight(s.inFlight);
  renderBusiness(s.business);
  renderTokens(s.tokens,s.business,s.apiSpend,s.rateLimits);
  renderCalendar(s.calendar);
  renderToday(s);
  renderNutrition(s.nutrition);
  renderTomorrow(s.tomorrow,s.reviewState);
}
/* Nutrition / weigh-in control loop — a weight line graph (mirrors renderTrend)
   + a compact 7-day-avg label + a color-coded weekly-direction in the header.
   The full prescription lives in /plan-day + /weigh, not here. Log input shows
   only when today isn't logged. */
function nutColor(state){
  if(state==='on_track')return 'var(--accent)';
  if(state==='under')return 'var(--warning)';
  if(state==='over')return 'var(--danger)';
  return 'var(--muted)';
}
function renderNutrition(n){
  n=n||{};
  var cEl=$('nutrition-count');
  if(cEl){
    var dv=n.deltaPerWeekLb;
    cEl.textContent=(dv!=null)?((dv>=0?'+':'')+dv+' lb/wk'):'';
    cEl.style.color=nutColor(n.state);
  }
  var pts=(n.points||[]).slice(-30);
  var h=errBlock(n.error);
  var avg=(n.sevenDayAvg!=null)?n.sevenDayAvg+' lb':'\\u2014';
  h+='<div class="nut-top"><span class="nut-avg">'+esc(avg)+'</span><span class="nut-sub">7-day avg</span></div>';
  if(pts.length<2){
    h+='<div class="empty">Accumulating &mdash; '+pts.length+' day(s). The line appears after 2+ weigh-ins.</div>';
  }else{
    var W=300,H=96,padL=26,padR=8,padT=8,padB=16,plotW=W-padL-padR,plotH=H-padT-padB;
    var lo=pts[0].lb,hi=pts[0].lb;
    for(var m=0;m<pts.length;m++){lo=Math.min(lo,pts[m].lb);hi=Math.max(hi,pts[m].lb);}
    var ax=niceAxis(lo,hi),nn=pts.length;
    function X(i){return padL+(nn===1?0:i/(nn-1)*plotW);}
    function Y(v){return padT+(1-(v-ax.lo)/(ax.hi-ax.lo))*plotH;}
    var grid='',labels='';
    for(var gv=ax.lo;gv<=ax.hi+ax.step*0.001;gv+=ax.step){
      var gy=Y(gv);
      grid+='<line x1="'+padL+'" y1="'+gy.toFixed(1)+'" x2="'+(padL+plotW)+'" y2="'+gy.toFixed(1)+'" stroke="#1d2b27" stroke-width="1"></line>';
      labels+='<text x="'+(padL-4)+'" y="'+(gy+3).toFixed(1)+'" text-anchor="end" font-size="8" fill="#556">'+Math.round(gv)+'</text>';
    }
    var line='',area='M'+X(0).toFixed(1)+','+Y(pts[0].lb).toFixed(1),dots='';
    for(var k=0;k<nn;k++){
      var px=X(k).toFixed(1),py=Y(pts[k].lb).toFixed(1);
      line+=(k?' L':'M')+px+','+py;area+=' L'+px+','+py;
      dots+='<circle cx="'+px+'" cy="'+py+'" r="2.2" fill="#39d98a"><title>'+esc(pts[k].date+': '+pts[k].lb+' lb')+'</title></circle>';
    }
    area+=' L'+X(nn-1).toFixed(1)+','+(padT+plotH)+' L'+X(0).toFixed(1)+','+(padT+plotH)+' Z';
    var xl='',idx=[0,Math.floor((nn-1)/2),nn-1];
    for(var x=0;x<idx.length;x++){var xi=idx[x];xl+='<text x="'+X(xi).toFixed(1)+'" y="'+(H-4)+'" text-anchor="middle" font-size="8" fill="#556">'+esc(pts[xi].date.slice(5))+'</text>';}
    h+='<svg class="nut-svg" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="xMidYMid meet">'+grid
      +'<path d="'+area+'" fill="#39d98a" fill-opacity="0.10"></path>'
      +'<path d="'+line+'" fill="none" stroke="#39d98a" stroke-width="2"></path>'+dots+labels+xl+'</svg>';
  }
  if(!n.todayLogged){
    h+='<div class="nut-input"><input id="wt-input" type="number" step="0.1" min="80" max="400" placeholder="weigh in (lb)"><button id="wt-log" class="nut-btn">Log</button></div>';
  }
  $('nutrition').innerHTML=h;
}

/* backlog rollup -> detail popover (Slice B renamed data-project -> data-rollup) */
$('backlog').addEventListener('click',function(e){
  var row=e.target.closest('.brow');
  if(row)openRollup(row.getAttribute('data-rollup'));
});
/* Closures panel — daily bar opens that day's closures; project row opens that
   project's 14-day closures. Container persists across renders (innerHTML swap). */
$('velocity').addEventListener('click',function(e){
  var bar=e.target.closest('.dbar.click'); if(bar){openClosuresDay(bar.getAttribute('data-date'));return;}
  var row=e.target.closest('.brow.click'); if(row)openClosuresProject(row.getAttribute('data-project'));
});
/* Usage heatmap — click a cell to see that day's list-price $ (hover tooltip stays).
   Delegate off the static #tokens panel body: #token-heatmap is render-created
   (renderTokens injects it), so it doesn't exist at boot when this binds. */
$('tokens').addEventListener('click',function(e){
  var cell=e.target.closest('.hm-cell.click'); if(cell)openUsageDay(cell.getAttribute('data-date'));
});
$('ov-close').addEventListener('click',closeOverlay);
$('overlay').addEventListener('click',function(e){if(e.target===$('overlay'))closeOverlay();});
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeOverlay();});

/* Work-queue clicks — a task row opens its detail (via /task), a client row
   opens the rollup overlay. */
$('workqueue').addEventListener('click',function(e){
  // Pull-in chip ("+ Today") sits inside a .trow — catch it first and stop, so
  // the click commits the task to today instead of opening the task detail.
  var pull=e.target.closest('.writeable');
  if(pull){e.stopPropagation();writeAction(pull,$('workqueue'));return;}
  var bh=e.target.closest('.wq-blocked-head');
  if(bh){var grp=bh.closest('.wq-blocked');if(grp)grp.classList.toggle('collapsed');return;}
  var more=e.target.closest('.upnext-more.click');
  if(more){openRollup(more.getAttribute('data-rollup'));return;}
  var trow=e.target.closest('.trow.click');
  if(trow){var p=trow.getAttribute('data-path');if(p)openTask(p);return;}
});

/* ---- Write-back: meal/training/task rows are clickable toggles ----
   The page authenticates each POST /action with the injected write token. On
   success we re-pull /snapshot (the server already invalidated its cache); on
   failure we revert to the last good snapshot and surface the error inline. A
   per-target guard blocks double-submits while a write is in flight. */
var DASH_TOKEN=(document.querySelector('meta[name=dashboard-token]')||{}).content||'';
/* Debounced last-click-wins writes: intent[key] holds the latest desired payload
   per target; timers[key] is its settle timer. The write fires once, WRITE_SETTLE_MS
   after the last click. Pending intents are re-applied on every refresh (overlay)
   so a background snapshot can't snap the UI back to a stale value mid-flight. */
var intent={},timers={},committedAt={},WRITE_SETTLE_MS=2000,RECONCILE_GRACE_MS=8000;
/* Sticky kinds keep their optimistic overlay until the server snapshot CONFIRMS
   the value (not merely until the write is acked) — a stale in-flight snapshot
   must never revert a checkbox below the user's last action. */
function isSticky(k){return k==='task-complete';}
/* Does the server snapshot already reflect this desired payload? Mirror of
   applyOptimistic — when true, releasing the overlay is a visual no-op. */
function snapshotMatches(s,p){
  if(p.kind==='task-complete'){
    if(s.training&&s.training.todayId===p.id)return s.training.todayComplete===p.done;
    var its=(s.meals&&s.meals.items)||[];
    for(var i=0;i<its.length;i++)if(its[i].id===p.id)return (its[i].status==='complete')===p.done;
    return true; // a completed meal/training can drop out of the snapshot — nothing to revert
  }
  return true;
}
function writeError(container,msg){
  if(!container)return;
  var box=document.createElement('div');box.className='write-err';box.textContent=msg;
  container.insertBefore(box,container.firstChild);
  setTimeout(function(){if(box.parentNode)box.parentNode.removeChild(box);},5000);
}
/* Apply a write's effect to a snapshot locally so the UI reflects it INSTANTLY,
   before the server round-trip. The success refresh reconciles to real ids. */
function applyOptimistic(s,payload){
  if(!s)return;var k=payload.kind;
  if(k==='task-complete'){
    if(s.training&&s.training.todayId===payload.id){s.training.todayComplete=payload.done;return;}
    var its=(s.meals&&s.meals.items)||[];
    for(var i=0;i<its.length;i++)if(its[i].id===payload.id){its[i].status=payload.done?'complete':'open';return;}
  }else if(k==='meals-pick'){
    var slot=null,name=null;for(var q=0;q<SLOTS_ORDER.length;q++)if(payload[SLOTS_ORDER[q]]){slot=SLOTS_ORDER[q];name=payload[SLOTS_ORDER[q]];break;}
    if(!slot)return;var title=(SLOT_LABEL[slot]||slot)+' \\u2014 '+name;
    if(payload.date===localDateStr(0)){
      if(!s.meals)s.meals={items:[]};if(!s.meals.items)s.meals.items=[];
      var items=s.meals.items,found=false;
      for(var m=0;m<items.length;m++)if(slotKey(items[m].title)===slot){items[m]={id:'opt',title:title,status:'open',workspacePath:'Internal/meal-system'};found=true;break;}
      if(!found)items.push({id:'opt',title:title,status:'open',workspacePath:'Internal/meal-system'});
    }else if(s.tomorrow&&s.tomorrow.meals){
      for(var t=0;t<s.tomorrow.meals.length;t++)if(s.tomorrow.meals[t].slot===slot){s.tomorrow.meals[t].picked={id:'opt',title:title,status:'open'};break;}
      s.tomorrow.planned=true;
    }
  }else if(k==='training-schedule'){
    var ttitle='Training \\u2014 '+payload.session;
    if(payload.date===localDateStr(0)){if(s.training){s.training.todayScheduled=true;s.training.todayTitle=ttitle;s.training.todayId='opt';s.training.todayComplete=false;}}
    else if(s.tomorrow&&s.tomorrow.training){s.tomorrow.training.scheduled={id:'opt',title:ttitle,status:'open'};}
  }else if(k==='schedule-task'){
    var w=s.tomorrow&&s.tomorrow.work;if(!w)return;w.committed=w.committed||[];w.proposed=w.proposed||[];
    if(payload.date==='clear'){w.committed=w.committed.filter(function(x){return x.id!==payload.id;});}
    else{var idx=-1;for(var p=0;p<w.proposed.length;p++)if(w.proposed[p].id===payload.id){idx=p;break;}
      if(idx>=0){w.committed.push(w.proposed[idx]);w.proposed.splice(idx,1);}}
  }
}
function writeAction(row,container){
  if(!row)return;
  var kind=row.getAttribute('data-kind'),payload,key,collapse=null;
  if(kind==='task-complete'){
    var id=row.getAttribute('data-id');if(!id)return;
    payload={kind:kind,id:id,workspacePath:row.getAttribute('data-ws'),done:row.getAttribute('data-done')!=='1'};
    key='task:'+id;
  }else if(kind==='meals-pick'){
    var slot=row.getAttribute('data-slot'),name=row.getAttribute('data-name'),mdate=row.getAttribute('data-date');if(!slot||!name||!mdate)return;
    payload={kind:kind,date:mdate,replace:true};payload[slot]=name;
    var mday=(mdate===localDateStr(0)?'today':'tomorrow');
    key='meal:'+mdate+':'+slot;collapse=mday+':'+slot;
  }else if(kind==='training-schedule'){
    var sess=row.getAttribute('data-session'),tdate=row.getAttribute('data-date');if(!sess||!tdate)return;
    payload={kind:kind,date:tdate,session:sess,replace:true};
    var tday=(tdate===localDateStr(0)?'today':'tomorrow');
    key='train:'+tdate;collapse=tday+':training';
  }else if(kind==='schedule-task'){
    var sid=row.getAttribute('data-id'),sws=row.getAttribute('data-ws'),sdate=row.getAttribute('data-date');if(!sid||!sws||!sdate)return;
    payload={kind:kind,id:sid,workspacePath:sws,date:sdate};
    key='sched:'+sid;
  }else if(kind==='pull-in'){
    var lid=row.getAttribute('data-id'),lws=row.getAttribute('data-ws');if(!lid||!lws)return;
    payload={kind:kind,id:lid,workspacePath:lws};
    key='pull:'+lid;
  }else return;
  // OPTIMISTIC + DEBOUNCED: flip instantly, record the latest intent for this
  // target, and (re)start a settle timer. The write fires once, for the final
  // state, a short settle after the last click — so rapid taps/undo land right.
  intent[key]=payload;
  delete committedAt[key]; // a fresh click → pending again, not yet acked
  if(lastSnapshot){
    applyOptimistic(lastSnapshot,payload);
    if(collapse&&window.__expand)window.__expand[collapse]=false;
    render(lastSnapshot);
  }
  clearTimeout(timers[key]);
  timers[key]=setTimeout(function(){commitIntent(key,container);},WRITE_SETTLE_MS);
}
/* Write the final intent for a target. Reference-identity (intent[key]===payload)
   guards against a stale commit clobbering a newer click's intent. */
function commitIntent(key,container){
  var payload=intent[key];if(!payload)return;
  fetch('/action',{method:'POST',headers:{'Content-Type':'application/json','X-Dashboard-Token':DASH_TOKEN},body:JSON.stringify(payload)})
    .then(function(r){return r.json().then(function(j){return {status:r.status,j:j};},function(){return {status:r.status,j:{}};});})
    .then(function(res){
      if(intent[key]!==payload)return; // a newer click superseded — its timer commits
      if(res.status>=200&&res.status<300){
        // Sticky kinds: keep the overlay until a refresh confirms the value (the
        // ack alone doesn't mean the next snapshot reflects it). Create kinds:
        // ack = done, drop now.
        if(isSticky(payload.kind))committedAt[key]=Date.now();
        else delete intent[key];
        refresh();
      }else{
        delete intent[key];delete committedAt[key];refresh();
        writeError(container,(res.j&&res.j.error)||('write failed ('+res.status+')'));
      }
    })
    .catch(function(){
      if(intent[key]!==payload)return;
      delete intent[key];delete committedAt[key];refresh();writeError(container,'network error');
    });
}
/* Personal panels — a .writeable element (checkbox / pick option / commit) acts;
   a [data-expand] element toggles that day+slot's picker open/closed. Shared by
   TODAY + TOMORROW via window.__expand. */
['today','tomorrow'].forEach(function(id){
  var c=$(id);if(!c)return;
  c.addEventListener('click',function(e){
    var opt=e.target.closest('.writeable');
    if(opt&&c.contains(opt)){writeAction(opt,c);return;}
    var row=e.target.closest('[data-expand]');
    if(row&&c.contains(row)){
      var k=row.getAttribute('data-expand');
      var exp=window.__expand||(window.__expand={});
      exp[k]=!exp[k];
      if(lastSnapshot)render(lastSnapshot);
    }
  });
});
/* Nutrition panel — log-weight input. Direct POST (not the debounced toggle
   path): validate 80-400 lb, fire the weight-log action, then refresh. */
(function(){
  var c=$('nutrition');if(!c)return;
  function submitWeight(){
    var inp=$('wt-input');if(!inp)return;
    var v=parseFloat(inp.value);
    if(!(v>=80&&v<=400)){writeError(c,'enter 80-400 lb');return;}
    fetch('/action',{method:'POST',headers:{'Content-Type':'application/json','X-Dashboard-Token':DASH_TOKEN},body:JSON.stringify({kind:'weight-log',weight:v})})
      .then(function(r){return r.json().then(function(j){return {status:r.status,j:j};},function(){return {status:r.status,j:{}};});})
      .then(function(res){if(res.status>=200&&res.status<300){refresh();}else{writeError(c,(res.j&&res.j.error)||('write failed ('+res.status+')'));}})
      .catch(function(){writeError(c,'network error');});
  }
  c.addEventListener('click',function(e){if(e.target.closest('#wt-log'))submitWeight();});
  c.addEventListener('keydown',function(e){if(e.key==='Enter'&&e.target.id==='wt-input')submitWeight();});
})();
/* TODAY training-log inputs — progressive-overload logging. Direct POST on
   Enter/blur (training-log kind), mirroring the weight-log input. T-2026-06-03-002. */
(function(){
  var c=$('today');if(!c)return;
  function submitLog(inp){
    if(!inp||!inp.classList||!inp.classList.contains('pexlog'))return;
    var payload={kind:'training-log',id:inp.getAttribute('data-id'),workspacePath:inp.getAttribute('data-ws'),exercise:inp.getAttribute('data-exercise'),log:(inp.value||'').trim()};
    if(!payload.id||!payload.exercise)return;
    fetch('/action',{method:'POST',headers:{'Content-Type':'application/json','X-Dashboard-Token':DASH_TOKEN},body:JSON.stringify(payload)})
      .then(function(r){return r.json().then(function(j){return {status:r.status,j:j};},function(){return {status:r.status,j:{}};});})
      .then(function(res){if(res.status>=200&&res.status<300){refresh();}else{writeError(c,(res.j&&res.j.error)||('log failed ('+res.status+')'));}})
      .catch(function(){writeError(c,'network error');});
  }
  // Enter commits (blur fires the write); blur (capture, since it doesn't bubble) commits.
  c.addEventListener('keydown',function(e){if(e.key==='Enter'&&e.target.classList&&e.target.classList.contains('pexlog'))e.target.blur();});
  c.addEventListener('blur',function(e){if(e.target.classList&&e.target.classList.contains('pexlog'))submitLog(e.target);},true);
})();
/* Today's plan morning proposal — Accept / Reject. Direct POST (no per-task
   body: the server reads the proposed set from its state file), then refresh.
   Listener on the persistent #today-pro element (innerHTML swaps don't drop it). */
(function(){
  var c=$('today-pro');if(!c)return;
  function planAct(kind){
    fetch('/action',{method:'POST',headers:{'Content-Type':'application/json','X-Dashboard-Token':DASH_TOKEN},body:JSON.stringify({kind:kind})})
      .then(function(r){return r.json().then(function(j){return {status:r.status,j:j};},function(){return {status:r.status,j:{}};});})
      .then(function(res){if(res.status>=200&&res.status<300){refresh();}else{writeError(c,(res.j&&res.j.error)||('write failed ('+res.status+')'));}})
      .catch(function(){writeError(c,'network error');});
  }
  c.addEventListener('click',function(e){
    if(e.target.closest('#plan-accept-btn'))planAct('plan-accept');
    else if(e.target.closest('#plan-reject-btn'))planAct('plan-reject');
  });
})();
/* Service worker (Part C) — shell caching for offline open + transparent
   outbox fallback for failed /action writes. Best-effort; ignore if unsupported. */
if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){});});}

var lastSnapshot=null;
function refresh(){
  fetch('/snapshot').then(function(r){return r.json();}).then(function(s){
    // Overlay every pending/unconfirmed intent so a background refresh never
    // snaps the UI back to a stale value. A sticky intent is released only once
    // it's been acked AND the snapshot confirms the value (release is then a
    // visual no-op) — or after RECONCILE_GRACE_MS as a self-healing backstop.
    for(var key in intent){if(!intent.hasOwnProperty(key))continue;
      var p=intent[key];
      if(isSticky(p.kind)&&committedAt[key]&&(snapshotMatches(s,p)||Date.now()-committedAt[key]>RECONCILE_GRACE_MS)){
        delete intent[key];delete committedAt[key];continue;
      }
      applyOptimistic(s,p);
    }
    lastSnapshot=s;window.__lastSnapshot=s;
    // Don't repaint while the user is typing into a log / weight input — the
    // panel innerHTML swap would wipe the in-progress value (background poll,
    // SSE, focus, and visibilitychange all call refresh()). lastSnapshot stays
    // fresh; the next idle refresh (or a blur) repaints. (roast-v2 F1, P0)
    var _ae=document.activeElement;
    if(_ae&&_ae.classList&&(_ae.classList.contains('pexlog')||_ae.id==='wt-input'))return;
    render(s);
    try{localStorage.setItem('dash_snap',JSON.stringify(s));}catch(e){}
  }).catch(function(){});
}
// Paint last-known snapshot immediately on load so a reload shows populated
// panels instead of empty frames flashing while /snapshot is in flight.
(function(){
  try{
    var cached=localStorage.getItem('dash_snap');
    if(cached){var cs=JSON.parse(cached);lastSnapshot=cs;window.__lastSnapshot=cs;render(cs);}
  }catch(e){}
})();
function connectSSE(){
  var es=new EventSource('/events');
  es.onopen=function(){statusEl.textContent='connected';statusEl.className='connected';};
  es.onerror=function(){
    // Demote to a calm "polling" when the SSE drops but the last snapshot is
    // still fresh (<60s) — a red alarm there is a false peripheral signal,
    // redundant with the data-age cue. Genuine staleness still reads red. (F10)
    var fresh=lastSnapshot&&lastSnapshot.generated&&(Date.now()-new Date(lastSnapshot.generated).getTime()<60000);
    if(fresh){statusEl.textContent='polling';statusEl.className='polling';}
    else{statusEl.textContent='reconnecting';statusEl.className='disconnected';}
  };
  es.addEventListener('refresh',refresh);
}
// === Laptop auto-fit ====================================================
// The board is tuned for a ~1860x1015 external-monitor work area. On a smaller
// screen (the laptop panel) scale the whole thing with the Chromium-native
// zoom property so the 4-column shape and every panel stay intact, just smaller.
// Unlike transform:scale, zoom reflows the layout box with no leftover blank
// space. screen.avail* is the screen work area in CSS px and is zoom-INDEPENDENT
// (window.innerWidth is not — it would feedback-loop), so it's the stable input;
// this assumes the window is maximized, which open-windows.ps1 guarantees.
// Re-runs on resize: unplugging the monitor (Windows re-maxes the --app window
// onto the laptop panel) re-fits live with no reload. Tune FIT_W/FIT_H against
// the laptop's actual screen.availWidth/Height if the breakpoint feels off.
var FIT_W=1860, FIT_H=1015;
function dashZoomMult(){var v=parseFloat(localStorage.getItem('dashZoom'));return (v>=0.4&&v<=1.5)?v:1;}
function applyFit(){
  var f=Math.min(screen.availWidth/FIT_W, screen.availHeight/FIT_H, 1)*dashZoomMult();
  f=Math.max(0.4, Math.min(f, 1.5));
  document.body.style.zoom=(Math.abs(f-1)>0.002)?f:'';
  document.body.classList.toggle('compact', f<0.999);
}
applyFit();
window.addEventListener('resize',applyFit);
// Manual readability nudge (compact text can get small): +/- step 0.05, 0 resets.
// Persisted so it survives reloads. Ignored while typing in an input.
document.addEventListener('keydown',function(e){
  if(e.ctrlKey||e.metaKey||e.altKey)return;
  var t=e.target&&e.target.tagName;if(t==='INPUT'||t==='TEXTAREA')return;
  if(e.key==='+'||e.key==='='){localStorage.setItem('dashZoom',Math.min(1.5,dashZoomMult()+0.05).toFixed(2));applyFit();}
  else if(e.key==='-'||e.key==='_'){localStorage.setItem('dashZoom',Math.max(0.4,dashZoomMult()-0.05).toFixed(2));applyFit();}
  else if(e.key==='0'){localStorage.removeItem('dashZoom');applyFit();}
});
refresh();
connectSSE();
setInterval(refresh,30000);
setInterval(function(){if(lastSnapshot)setGeneratedCue(lastSnapshot.generated);},15000);
// Self-heal the persistent always-open window: when it regains focus or becomes
// visible (laptop wake, tab/desktop switch), pull a fresh snapshot immediately
// instead of waiting up to 30s for the next poll tick — the gap that let a stale
// NEXT hero sit on screen. EventSource already auto-reconnects on its own.
window.addEventListener('focus',refresh);
document.addEventListener('visibilitychange',function(){if(!document.hidden)refresh();});
</script>
</body>
</html>`;
