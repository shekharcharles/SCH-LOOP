// The dashboard, as one served string. Kept apart from the server so the page can be read as a page.
//
// Operate mode: the visitor is completing a task, so scanability and consistency outrank expression.
// The world is the SCH-LOOP console — near-black ground, red as structure, terminal green for live —
// and it now has a paper counterpart, because this gets read at a desk in daylight as often as at night.
//
// Three rules the old page broke:
//   · type is a fixed rem scale, not clamp(). A fluid heading in a product UI is worse at both ends.
//   · status is never colour alone. Every state carries a drawn mark, a word, and a colour.
//   · icons are authored SVG at one stroke weight, not unicode glyphs borrowed from a font.
export const PAGE = String.raw`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>SCH·LOOP</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=JetBrains+Mono:wght@400;500;700&display=swap">
<style>
/* ── tokens ─────────────────────────────────────────────────────────────────
   Two grounds, one vocabulary. Red is structure and never severity; the state
   ramp is separate and is always paired with a drawn mark and a word.        */
:root{
  color-scheme:dark;
  --ground:#0a0a0a; --panel:#121212; --sunk:#171717; --rule:#282828; --rule-soft:#1e1e1e;
  --ink:#eaeaea; --ink-dim:#8b8b8b; --ink-faint:#5c5c5c;
  --brand:#ff2a2a;
  --live:#4af626; --work:#e3b341; --info:#58a6ff; --stop:#ff4d4d; --rest:#6e6e6e;
  --on-live:#07210a; --on-brand:#fff;
  --scan:rgba(255,255,255,.015);

  --f-mono:"JetBrains Mono",ui-monospace,"Cascadia Code",Consolas,monospace;
  --f-mark:"Archivo Black",system-ui,sans-serif;

  /* fixed scale, ratio ~1.15 — product UI is read at a consistent DPI */
  --t-micro:.6875rem; --t-meta:.75rem; --t-dense:.8125rem; --t-body:.875rem;
  --t-lead:1rem; --t-h3:1.125rem; --t-h2:1.5rem; --t-h1:2.25rem; --t-mark:2.75rem;

  --r:3px; --gut:16px;
  --dur:180ms; --ease:cubic-bezier(.2,.7,.3,1);
}
:root[data-theme="light"]{
  color-scheme:light;
  --ground:#f4f3f1; --panel:#fbfaf9; --sunk:#eceae7; --rule:#d8d4cf; --rule-soft:#e6e3df;
  --ink:#16150f; --ink-dim:#5f5b54; --ink-faint:#8a857d;
  --brand:#d40000;
  --live:#1c7a12; --work:#8a5a00; --info:#0b5fb8; --stop:#c20000; --rest:#8a857d;
  --on-live:#fff; --on-brand:#fff;
  --scan:rgba(0,0,0,.012);
}
@media (prefers-color-scheme:light){
  :root:not([data-theme="dark"]){
    color-scheme:light;
    --ground:#f4f3f1; --panel:#fbfaf9; --sunk:#eceae7; --rule:#d8d4cf; --rule-soft:#e6e3df;
    --ink:#16150f; --ink-dim:#5f5b54; --ink-faint:#8a857d;
    --brand:#d40000;
    --live:#1c7a12; --work:#8a5a00; --info:#0b5fb8; --stop:#c20000; --rest:#8a857d;
    --on-live:#fff; --on-brand:#fff;
    --scan:rgba(0,0,0,.012);
  }
}

*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--ground);color:var(--ink);
  font:var(--t-body)/1.5 var(--f-mono);
  font-variant-numeric:tabular-nums;
  -webkit-font-smoothing:antialiased;
  padding:0 var(--gut) 88px;
}
body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:9;
  background:repeating-linear-gradient(0deg,transparent 0 2px,var(--scan) 2px 3px)}
.wrap{max-width:1320px;margin-inline:auto;position:relative;z-index:1}
a{color:inherit;text-decoration:none}
:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
svg{display:block;flex:none}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-track{background:var(--sunk)}
::-webkit-scrollbar-thumb{background:var(--rule)}

/* ── chrome ─────────────────────────────────────────────────────────────── */
.top{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:18px;
  padding:12px 0 10px;background:var(--ground);border-bottom:2px solid var(--brand);margin-bottom:26px}
.mark{display:flex;align-items:center;gap:9px;font-family:var(--f-mark);font-size:var(--t-lead);
  letter-spacing:-.02em;text-transform:uppercase}
.mark svg{color:var(--brand)}
nav{display:flex;gap:4px;margin-left:8px}
nav a{font-size:var(--t-meta);letter-spacing:.09em;text-transform:uppercase;color:var(--ink-dim);
  padding:6px 10px;border:1px solid transparent;transition:color var(--dur) var(--ease),border-color var(--dur) var(--ease)}
nav a:hover{color:var(--ink);border-color:var(--rule)}
nav a[aria-current]{color:var(--ink);border-color:var(--rule);background:var(--panel)}
.top .sp{margin-left:auto}
.where{font-size:var(--t-micro);color:var(--ink-faint);letter-spacing:.06em;
  max-width:36ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.icobtn{display:grid;place-items:center;width:30px;height:30px;color:var(--ink-dim);
  background:transparent;border:1px solid var(--rule);cursor:pointer;
  transition:color var(--dur) var(--ease),border-color var(--dur) var(--ease)}
.icobtn:hover{color:var(--ink);border-color:var(--ink-dim)}
@media (max-width:720px){.where{display:none}.top{gap:10px}nav{margin-left:0}}

h1{font-family:var(--f-mark);font-size:var(--t-h1);line-height:1.02;letter-spacing:-.03em;
  text-transform:uppercase;margin:0 0 6px}
.lede{color:var(--ink-dim);font-size:var(--t-dense);margin:0 0 24px;max-width:78ch}
h2{display:flex;align-items:baseline;gap:10px;margin:30px 0 10px;padding-top:9px;
  border-top:1px solid var(--rule);font-size:var(--t-micro);font-weight:700;
  letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim)}
h2::before{content:"[";color:var(--ink-faint)}
h2 .n{margin-left:auto;color:var(--ink-faint);font-weight:400}
h2::after{content:"]";color:var(--ink-faint)}

/* ── state: a mark, a word, a colour. Never colour alone. ───────────────── */
.state{display:inline-flex;align-items:center;gap:6px;font-size:var(--t-micro);font-weight:700;
  letter-spacing:.08em;text-transform:uppercase;padding:3px 7px;border:1px solid currentColor;white-space:nowrap}
.state svg{width:9px;height:9px}
.s-live{color:var(--live)} .s-work{color:var(--work)} .s-stop{color:var(--stop)}
.s-info{color:var(--info)} .s-rest{color:var(--rest);border-color:var(--rule)}
@media (prefers-reduced-motion:no-preference){ .s-live .pulse{animation:pulse 1.7s steps(1,end) infinite} }
@keyframes pulse{50%{opacity:.25}}

/* ── the band: what is wrong, first ─────────────────────────────────────── */
.band{display:flex;flex-wrap:wrap;gap:1px;background:var(--rule);border:1px solid var(--rule);margin-bottom:6px}
.band>div{flex:1 1 128px;background:var(--panel);padding:11px 13px;min-width:0}
.band .v{display:block;font-size:var(--t-h2);font-weight:700;line-height:1.05;letter-spacing:-.02em}
.band .k{display:block;margin-top:3px;font-size:var(--t-micro);letter-spacing:.09em;
  text-transform:uppercase;color:var(--ink-dim)}
.band .attn .v{color:var(--stop)} .band .go .v{color:var(--live)} .band .wait .v{color:var(--work)}

/* ── project rows ───────────────────────────────────────────────────────── */
.rows{border:1px solid var(--rule);background:var(--panel)}
.row{display:grid;grid-template-columns:104px minmax(220px,2.4fr) 160px minmax(130px,1fr) 88px;
  gap:14px;align-items:center;padding:12px 14px;border-top:1px solid var(--rule-soft);
  transition:background var(--dur) var(--ease)}
.row:first-child{border-top:0}
.row:hover{background:var(--sunk)}
.row .name{font-weight:700;letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .goal{display:block;font-weight:400;color:var(--ink-dim);font-size:var(--t-meta);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}
.row .path{font-size:var(--t-meta);color:var(--ink-faint);overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.row .when{font-size:var(--t-meta);color:var(--ink-dim);text-align:right}
.meter{display:flex;align-items:center;gap:9px}
.meter .track{flex:1;height:3px;background:var(--rule)}
/* scaled, not resized: a width transition relayouts the row on every poll. */
.meter .fill{display:block;height:100%;width:100%;background:var(--live);
  transform-origin:left center;transition:transform var(--dur) var(--ease)}
.meter .pct{font-size:var(--t-meta);color:var(--ink-dim);min-width:4ch;text-align:right}
@media (max-width:900px){
  .row{grid-template-columns:1fr auto;gap:8px 12px}
  .row .st{grid-row:1;grid-column:2;justify-self:end}
  .row .who{grid-row:1;grid-column:1;min-width:0}
  .row .meter{grid-row:2;grid-column:1/-1}
  .row .path{grid-row:3;grid-column:1/-1;direction:ltr}
  .row .when{grid-row:3;grid-column:2;text-align:right}
}

/* ── panels ─────────────────────────────────────────────────────────────── */
.panel{border:1px solid var(--rule);background:var(--panel)}
.panel+.panel{margin-top:-1px}
.phead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px;
  background:var(--sunk);border-bottom:1px solid var(--rule)}
.phead b{font-family:var(--f-mark);font-size:var(--t-dense);text-transform:uppercase;letter-spacing:.01em}
.phead .sp{margin-left:auto;display:flex;gap:8px;align-items:center}
.pbody{padding:13px 14px}

/* running now */
.now{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;align-items:baseline}
.now dt{font-size:var(--t-micro);letter-spacing:.09em;text-transform:uppercase;color:var(--ink-dim)}
.now dd{margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis}
.now .tid{color:var(--brand);font-weight:700}

/* ticket lines */
.tk{display:grid;grid-template-columns:16px 62px 68px minmax(0,1fr) auto;gap:12px;align-items:baseline;
  padding:6px 0;border-top:1px solid var(--rule-soft);font-size:var(--t-dense)}
.tk:first-child{border-top:0}
.st-row{display:grid;grid-template-columns:16px minmax(0,1fr) auto;gap:12px;align-items:baseline;
  padding:6px 0;border-top:1px solid var(--rule-soft);font-size:var(--t-dense)}
.st-row:first-child{border-top:0}
.st-row .mk{justify-self:center;align-self:center}
.st-row .mt{color:var(--ink-dim);font-size:var(--t-meta);white-space:nowrap}
/* a stage row that opens its document is still a row, not a button that looks like one */
button.st-row{width:100%;font:var(--t-dense)/1.5 var(--f-mono);letter-spacing:0;text-transform:none;
  color:inherit;background:transparent;border-radius:0;text-align:left;cursor:pointer}
button.st-row:hover{background:var(--sunk);filter:none}
button.st-row:disabled{opacity:1;color:var(--ink-faint);cursor:default}
button.st-row:active{transform:none}
.tk .mk{justify-self:center;align-self:center}
.tk .tid{color:var(--brand)}
.tk .ty{color:var(--ink-faint);font-size:var(--t-meta)}
.tk .ti{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tk .mt{color:var(--ink-dim);font-size:var(--t-meta);white-space:nowrap}
.tk.is-run{background:color-mix(in oklab,var(--work) 9%,transparent)}
.tk.is-stop{background:color-mix(in oklab,var(--stop) 9%,transparent)}
@media (max-width:720px){
  .tk{grid-template-columns:16px 62px minmax(0,1fr);gap:6px 10px}
  .tk .ty{grid-column:2;grid-row:2;}
  .tk .ti{grid-column:3;grid-row:1}
  .tk .mt{grid-column:3;grid-row:2;white-space:normal}
}

/* seats */
.seat{border-top:1px solid var(--rule)}
.seat:first-child{border-top:0}
.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-bottom:12px}
.f{display:flex;flex-direction:column;gap:5px;min-width:0}
.f>label{font-size:var(--t-micro);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-dim)}
.f.wide{grid-column:1/-1}
select,input[type=text]{font:var(--t-dense)/1.4 var(--f-mono);padding:8px 10px;width:100%;
  background:var(--ground);color:var(--ink);border:1px solid var(--rule);border-radius:0;
  transition:border-color var(--dur) var(--ease)}
select:hover,input[type=text]:hover{border-color:var(--ink-faint)}
select:focus,input:focus{outline:none;border-color:var(--brand)}
select:disabled,input:disabled{color:var(--ink-faint);cursor:not-allowed;background:var(--sunk)}
.flags{display:flex;gap:6px;flex-wrap:wrap}
.flag{display:inline-flex;align-items:center;gap:7px;font-size:var(--t-micro);letter-spacing:.06em;
  text-transform:uppercase;color:var(--ink-dim);border:1px solid var(--rule);background:var(--ground);
  padding:6px 9px;cursor:pointer;user-select:none;transition:color var(--dur) var(--ease),border-color var(--dur) var(--ease)}
.flag:hover{color:var(--ink);border-color:var(--ink-faint)}
.flag input{appearance:none;width:8px;height:8px;margin:0;border:1px solid var(--ink-faint);background:transparent}
.flag input:checked{background:var(--live);border-color:var(--live)}
.flag:has(input:checked){color:var(--live);border-color:var(--live)}
.flag:has(input:disabled){opacity:.5;cursor:not-allowed}
.argv{margin-top:12px;padding:9px 11px;background:var(--ground);border:1px solid var(--rule);
  font-size:var(--t-meta);color:var(--ink-dim);white-space:pre-wrap;word-break:break-all}
.argv.bad{color:var(--stop);border-color:var(--stop)}

/* council */
.cn{display:grid;grid-template-columns:auto 96px 1fr 1fr;gap:10px;align-items:center;
  padding:10px 14px;border-top:1px solid var(--rule-soft)}
.cn:first-child{border-top:0}
.cn b{font-size:var(--t-meta);letter-spacing:.08em;text-transform:uppercase}
.cn .argv{grid-column:1/-1;margin-top:2px}
.cn.off{color:var(--ink-faint)}
@media (max-width:720px){.cn{grid-template-columns:auto 1fr}.cn b{grid-column:2}}

/* log */
.log{max-height:380px;overflow:auto}
.ev{display:grid;grid-template-columns:54px 1fr;gap:10px;padding:5px 0;
  border-top:1px solid var(--rule-soft);font-size:var(--t-meta);color:var(--ink-dim)}
.ev:first-child{border-top:0}
.ev time{color:var(--ink-faint)}
.ev b{color:var(--ink);font-weight:500}

/* action bar, empty and loading states */
.bar[hidden]{display:none}
.bar{position:fixed;left:0;right:0;bottom:0;z-index:20;display:flex;gap:10px;align-items:center;
  padding:11px var(--gut);background:var(--ground);border-top:2px solid var(--brand)}
.bar .in{max-width:1320px;margin-inline:auto;width:100%;display:flex;gap:10px;align-items:center}
button{font:700 var(--t-micro)/1 var(--f-mono);letter-spacing:.1em;text-transform:uppercase;
  padding:10px 16px;border:1px solid transparent;cursor:pointer;
  transition:filter var(--dur) var(--ease),border-color var(--dur) var(--ease)}
button:hover{filter:brightness(1.12)}
button:active{transform:translateY(1px)}
button:disabled{opacity:.45;cursor:not-allowed}
.b-go{background:var(--live);color:var(--on-live)}
.b-ghost{background:transparent;color:var(--ink);border-color:var(--rule)}
.b-ghost:hover{border-color:var(--ink-dim)}
.b-mini{padding:5px 9px;background:transparent;color:var(--ink-dim);border-color:var(--rule)}
.b-mini:hover{color:var(--ink);border-color:var(--ink-dim)}
.msg{font-size:var(--t-micro);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-dim)}
.msg.bad{color:var(--stop)} .msg.good{color:var(--live)}

.empty{border:1px dashed var(--rule);padding:22px 16px;text-align:center;color:var(--ink-dim)}
.empty b{display:block;color:var(--ink);font-size:var(--t-lead);margin-bottom:6px}
.empty code{color:var(--ink);background:var(--sunk);padding:2px 6px}
.sk{display:block;background:linear-gradient(90deg,var(--sunk) 0%,var(--rule) 50%,var(--sunk) 100%);
  background-size:200% 100%;height:11px}
@media (prefers-reduced-motion:no-preference){.sk{animation:sweep 1.3s var(--ease) infinite}}
@keyframes sweep{to{background-position:-200% 0}}
/* ── tabs: a project has four faces, and only one of them is settings ───── */
.tabs{display:flex;gap:2px;margin:0 0 22px;border-bottom:1px solid var(--rule)}
.tabs button{background:transparent;color:var(--ink-dim);border:1px solid transparent;border-bottom:0;
  padding:9px 14px;margin-bottom:-1px}
.tabs button:hover{color:var(--ink)}
.tabs button[aria-selected="true"]{color:var(--ink);background:var(--panel);
  border-color:var(--rule);border-top:2px solid var(--brand)}
.tabs .n{margin-left:7px;color:var(--ink-faint);font-weight:400}

/* ── files: a tree you can scan and a viewer that reads like the file ───── */
.files{display:grid;grid-template-columns:288px minmax(0,1fr);border:1px solid var(--rule);background:var(--panel)}
.tree{border-right:1px solid var(--rule);background:var(--sunk);min-width:0;
  max-height:calc(100vh - 230px);overflow:auto;padding-bottom:10px}
.tree .find{position:sticky;top:0;z-index:2;padding:10px;background:var(--sunk);border-bottom:1px solid var(--rule)}
.tree .grp{padding:11px 12px 5px;font-size:var(--t-micro);letter-spacing:.12em;text-transform:uppercase;
  color:var(--ink-faint)}
.node{display:flex;align-items:center;gap:7px;width:100%;text-align:left;padding:4px 10px;
  font:var(--t-meta)/1.5 var(--f-mono);letter-spacing:0;text-transform:none;color:var(--ink-dim);
  background:transparent;border:0;cursor:pointer;min-width:0}
.node:hover{color:var(--ink);background:var(--panel)}
.node[aria-current]{color:var(--ink);background:var(--panel);box-shadow:inset 2px 0 0 var(--brand)}
.node.dir{color:var(--ink)}
.node .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.node .sz{margin-left:auto;color:var(--ink-faint);font-size:var(--t-micro);flex:none}
.node svg{color:var(--ink-faint)}
.node.dir svg{color:var(--brand)}

.viewer{min-width:0;display:flex;flex-direction:column}
.vhead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px;
  background:var(--sunk);border-bottom:1px solid var(--rule);position:sticky;top:0;z-index:1}
.vhead .fp{font-size:var(--t-meta);color:var(--ink-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vhead .fp b{color:var(--ink);font-weight:700}
.vhead .sp{margin-left:auto;display:flex;gap:8px;align-items:center}
.vbody{padding:0;overflow:auto;max-height:calc(100vh - 230px)}
@media (max-width:900px){
  .files{grid-template-columns:1fr}
  .tree{border-right:0;border-bottom:1px solid var(--rule);max-height:300px}
  .vbody{max-height:none}
}

/* code, with a number on every line and colour that means the same thing everywhere */
.code{margin:0;padding:12px 0;counter-reset:l;font-size:var(--t-dense);line-height:1.55;overflow-x:auto}
.cl{counter-increment:l;display:block;white-space:pre;padding:0 14px 0 0;min-height:1.55em}
.cl::before{content:counter(l);display:inline-block;width:4.5ch;margin-right:14px;padding-right:9px;
  text-align:right;color:var(--ink-faint);border-right:1px solid var(--rule-soft);user-select:none}
.cl:hover{background:var(--sunk)}
.t-com{color:var(--rest);font-style:italic}
.t-str{color:var(--live)}
.t-num{color:var(--work)}
.t-key{color:var(--brand)}
.t-fn{color:var(--info)}
.t-atr{color:var(--info)}

/* markdown, read as prose rather than as a file */
.md{padding:24px 26px;max-width:84ch}
.md>*:first-child{margin-top:0}
.md h1,.md h2,.md h3,.md h4{font-family:var(--f-mark);letter-spacing:-.02em;line-height:1.15;
  margin:28px 0 10px;text-transform:none;border:0;padding:0;display:block;color:var(--ink)}
.md h1{font-size:var(--t-h2)} .md h2{font-size:var(--t-h3)} .md h3{font-size:var(--t-lead)}
.md h4{font-size:var(--t-body)}
.md h1::before,.md h2::before,.md h1::after,.md h2::after{content:none}
.md h2{padding-top:14px;border-top:1px solid var(--rule-soft)}
.md p,.md li{font-size:var(--t-body);line-height:1.68}
.md p{margin:0 0 14px}
.md ul,.md ol{margin:0 0 14px;padding-left:22px}
.md li{margin:4px 0}
.md li::marker{color:var(--brand)}
.md a{color:var(--info);text-decoration:underline;text-underline-offset:2px}
.md code{background:var(--sunk);border:1px solid var(--rule-soft);padding:1px 5px;font-size:.92em}
.md pre{background:var(--sunk);border:1px solid var(--rule);padding:12px 14px;overflow-x:auto;margin:0 0 16px}
.md pre code{background:none;border:0;padding:0}
.md blockquote{margin:0 0 16px;padding:2px 0 2px 14px;border-left:2px solid var(--brand);color:var(--ink-dim)}
.md hr{border:0;border-top:1px solid var(--rule);margin:22px 0}
.md table{border-collapse:collapse;width:100%;margin:0 0 16px;font-size:var(--t-dense)}
.md th,.md td{border:1px solid var(--rule);padding:7px 10px;text-align:left;vertical-align:top}
.md th{background:var(--sunk);font-size:var(--t-micro);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-dim)}
.md strong{color:var(--ink)}
.plain{padding:14px;white-space:pre-wrap;word-break:break-word;font-size:var(--t-dense);line-height:1.6}
</style></head><body>

<div class="wrap">
  <header class="top">
    <span class="mark">
      <svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
        <path d="M8.5 1.6 15 5.1v6.8L8.5 15.4 2 11.9V5.1Z"/><path d="M8.5 6.1 11.4 7.7v3.2L8.5 12.5 5.6 10.9V7.7Z"/>
      </svg>SCH·LOOP</span>
    <nav>
      <a href="/" id="nav-home">Projects</a>
      <a href="/settings" id="nav-set">Settings</a>
    </nav>
    <span class="sp"></span>
    <span class="where" id="where"></span>
    <button class="icobtn" id="theme" type="button" aria-label="Switch between light and dark">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <circle cx="8" cy="8" r="5.4"/><path d="M8 2.6a5.4 5.4 0 0 1 0 10.8Z" fill="currentColor" stroke="none"/>
      </svg>
    </button>
  </header>
  <main id="view" aria-live="polite"></main>
</div>

<div class="bar" id="bar" hidden><div class="in">
  <button class="b-go" id="save">Save</button>
  <button class="b-ghost" id="reload">Reload</button>
  <span class="msg" id="msg"></span>
</div></div>

<script>
const $=s=>document.querySelector(s);
const el=(t,a={},k=[])=>{const n=document.createElement(t);
  for(const[p,v]of Object.entries(a)){if(v==null||v===false)continue;
    if(p==="class")n.className=v;else if(p.startsWith("on"))n.addEventListener(p.slice(2),v);
    else n.setAttribute(p,v===true?"":v);}
  for(const c of[].concat(k))if(c!=null)n.append(c);return n;};
/* Icons are authored paths from MARK below — module constants, never data. Built as real SVG nodes
   rather than assigned as markup: no string on this page ever becomes an element. A test enforces
   that, so the word for the sink cannot be written here either. */
const NS="http://www.w3.org/2000/svg";
const svg=(parts,w=9)=>{const n=document.createElementNS(NS,"svg");
  n.setAttribute("viewBox","0 0 10 10");n.setAttribute("width",w);n.setAttribute("height",w);
  n.setAttribute("aria-hidden","true");
  for(const[tag,attrs]of parts){const c=document.createElementNS(NS,tag);
    for(const[k,v]of Object.entries(attrs))c.setAttribute(k,v);n.append(c);}
  return n;};

/* One drawn mark per state. Shape carries the meaning when colour cannot. */
const MARK={
  live:[["circle",{class:"pulse",cx:5,cy:5,r:3.4,fill:"currentColor"}]],
  work:[["path",{d:"M5 .9 9.3 8.6H.7Z",fill:"currentColor"}]],
  stop:[["path",{d:"M3.2.8h3.6L9.2 3.2v3.6L6.8 9.2H3.2L.8 6.8V3.2Z",fill:"currentColor"}]],
  done:[["path",{d:"M1.3 5.2 3.9 7.8 8.8 2.2",fill:"none",stroke:"currentColor","stroke-width":1.7}]],
  wait:[["path",{d:"M5 .9 9.3 8.6H.7Z",fill:"none",stroke:"currentColor","stroke-width":1.3}]],
  rest:[["circle",{cx:5,cy:5,r:2.4,fill:"none",stroke:"currentColor","stroke-width":1.3}]]
};
const state=(kind,word)=>el("span",{class:"state s-"+(kind==="done"?"live":kind)},[svg(MARK[kind]),word]);

const dur=ms=>{if(ms==null)return"—";
  if(ms<90e3)return Math.round(ms/1e3)+"s";
  if(ms<36e5)return Math.round(ms/6e4)+"m";
  const m=Math.round(ms/6e4);            /* round to the minute FIRST, or 5h59m30s prints 5h60 */
  return Math.floor(m/60)+"h"+String(m%60).padStart(2,"0");};
const clock=a=>a?new Date(a).toTimeString().slice(0,5):"—";
const ago=a=>{if(!a)return"never";const d=Date.now()-new Date(a).getTime();
  return d<6e4?"just now":d<36e5?Math.round(d/6e4)+"m ago":d<864e5?Math.round(d/36e5)+"h ago":Math.round(d/864e5)+"d ago";};
const money=n=>"$"+(n||0).toFixed(2);

let S=null,MODE="home",PID=null,TAB="overview",DIRTY=false;

/* The tab and the open file live in the URL. Reloading the page you are looking at should give you
   the page you were looking at, and a link to a document should open that document. */
function setUrl(){
  const q=new URLSearchParams();
  if(TAB!=="overview")q.set("tab",TAB);
  if(TAB==="files"&&FILE&&FILE.path)q.set("file",FILE.path);
  const next=location.pathname+(q.toString()?"?"+q:"");
  if(next!==location.pathname+location.search)history.pushState(null,"",next);
}

/* theme: system by default, explicit choice remembered */
const setTheme=t=>{if(t)document.documentElement.setAttribute("data-theme",t);
  else document.documentElement.removeAttribute("data-theme");
  try{t?localStorage.setItem("sch-theme",t):localStorage.removeItem("sch-theme")}catch{}};
try{const t=localStorage.getItem("sch-theme");if(t)setTheme(t)}catch{}
$("#theme").addEventListener("click",()=>{
  const now=document.documentElement.getAttribute("data-theme")
    ||(matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light");
  setTheme(now==="dark"?"light":"dark");});

const installed=()=>(S.seats||[]).filter(s=>s.available).map(s=>s.provider);
function providerOptions(cur){
  const names=[...new Set([...installed(),cur].filter(Boolean))];
  return names.map(p=>el("option",{value:p,selected:p===cur||null},
    p+(installed().includes(p)?"":" — not installed")));
}
const presetsFor=p=>Object.keys((S.presets||{})[p]||{}).filter(k=>k!=="base"&&k!=="model_arg");
const hasPreset=(sp,fr)=>{const j=sp.join(" ");return fr.every(f=>j.includes(f));};
function togglePreset(seat,name,on){
  const fr=(S.presets[seat.provider]||{})[name]||[];if(!fr.length)return;
  if(on){if(!hasPreset(seat.spawn,fr))seat.spawn=[...seat.spawn,...fr];}
  else{const j=seat.spawn.join(" ");seat.spawn=j.split(fr.join(" ")).join("").split(" ").filter(Boolean);}
  DIRTY=true;
}

function seatPanel(key,seat,title,note,origin,onCustom,onInherit){
  if(!seat)return el("section",{class:"panel seat"},
    el("div",{class:"phead"},[el("b",{},title),state("stop","not configured")]));
  const models=(S.seats.find(s=>s.provider===seat.provider)||{}).models||[];
  const argv=S.resolved[key]||"";
  const inherited=origin==="global",lock=key!=="executor";
  const head=[el("b",{},title),el("span",{class:"state s-"+(lock?"stop":"rest")},[svg(MARK[lock?"stop":"rest"]),note])];
  if(origin)head.push(el("span",{class:"state s-"+(inherited?"info":"live")},
    [svg(MARK[inherited?"rest":"done"]),inherited?"inherited":"this project"]));
  const acts=[];
  if(onCustom&&inherited)acts.push(el("button",{class:"b-mini",onclick:onCustom},"Customise here"));
  if(onInherit&&!inherited)acts.push(el("button",{class:"b-mini",onclick:onInherit},"Use global"));
  if(acts.length)head.push(el("span",{class:"sp"},acts));

  const dis=inherited||null;
  return el("section",{class:"panel seat"},[
    el("div",{class:"phead"},head),
    el("div",{class:"pbody"},[
      el("div",{class:"fields"},[
        el("div",{class:"f"},[el("label",{},"CLI"),
          el("select",{disabled:dis,onchange:e=>{seat.provider=e.target.value;
            seat.spawn=[...((S.presets[seat.provider]||{}).base||[seat.provider])];seat.model=null;DIRTY=true;render();}},
            providerOptions(seat.provider))]),
        el("div",{class:"f"},[el("label",{},"Model"),
          el("select",{disabled:dis,onchange:e=>{seat.model=e.target.value||null;DIRTY=true;render();}},
            [el("option",{value:"",selected:!seat.model||null},"provider default"),
             ...models.map(m=>el("option",{value:m,selected:m===seat.model||null},m))])]),
        el("div",{class:"f wide"},[el("label",{},"Spawn argv"),
          el("input",{type:"text",disabled:dis,value:seat.spawn.join(" "),
            onchange:e=>{seat.spawn=e.target.value.trim().split(/\s+/).filter(Boolean);DIRTY=true;render();}})]),
      ]),
      el("div",{class:"flags"},presetsFor(seat.provider).map(name=>{
        const on=hasPreset(seat.spawn,S.presets[seat.provider][name]);
        const cb=el("input",{type:"checkbox",checked:on||null,disabled:dis});
        cb.addEventListener("change",e=>{togglePreset(seat,name,e.target.checked);render();});
        return el("label",{class:"flag"},[cb,name.replace(/_/g," ")]);
      })),
      el("div",{class:"argv"+(/^(unresolvable|not configured)/.test(argv)?" bad":"")},argv),
    ]),
  ]);
}

function councilPanel(roles,editable){
  const seats=roles.council||[];
  if(!seats.length)return el("div",{class:"empty"},[el("b",{},"No council seats"),
    "A council needs two CLIs it can reach. Install a second one and run setup again."]);
  return el("section",{class:"panel"},seats.map((c,i)=>{
    const on=el("input",{type:"checkbox",checked:c.enabled!==false||null,disabled:editable?null:true});
    on.addEventListener("change",e=>{c.enabled=e.target.checked;DIRTY=true;render();});
    const models=(S.seats.find(s=>s.provider===c.provider)||{}).models||[];
    return el("div",{class:"cn"+(c.enabled===false?" off":"")},[
      el("label",{class:"flag"},[on,"seat"]),
      el("b",{},c.role),
      el("select",{disabled:editable?null:true,onchange:e=>{c.provider=e.target.value;
        c.spawn=[...((S.presets[c.provider]||{}).base||[c.provider])];c.model=null;DIRTY=true;render();}},
        providerOptions(c.provider)),
      el("select",{disabled:editable?null:true,onchange:e=>{c.model=e.target.value||null;DIRTY=true;render();}},
        [el("option",{value:""},"default"),...models.map(m=>el("option",{value:m,selected:m===c.model||null},m))]),
      el("div",{class:"argv"},S.resolved["council."+i]||""),
    ]);
  }));
}

/* ── reading files ───────────────────────────────────────────────────────
   A backtick cannot appear in this file: the whole page is one template
   literal. BT is the character, written as an escape the browser resolves
   and this module never contains.                                        */
const BT="\u0060";
const RX=(...p)=>new RegExp(p.join(""),"g");
const size=n=>n<1024?n+" B":n<1048576?(n/1024).toFixed(n<10240?1:0)+" KB":(n/1048576).toFixed(1)+" MB";

/* A link out of a document is the one place file content becomes page behaviour. Only http(s) and
   in-page anchors survive; javascript: and data: do not get to be clickable. */
const safeHref=u=>/^(https?:\/\/|#|\.?\/)/i.test(u.trim())?u.trim():"#";

const ICON={
  dir:[["path",{d:"M.9 2.4h3l1 1.2h4.2v5.9H.9Z",fill:"none",stroke:"currentColor","stroke-width":1.1}]],
  file:[["path",{d:"M2.2.9h3.9l2 2v6.2H2.2Z",fill:"none",stroke:"currentColor","stroke-width":1.1}]],
};

/* ── markdown ────────────────────────────────────────────────────────────
   Enough of it to read what the loop writes: headings, lists, fences,
   tables, quotes, rules and the inline four. Built as nodes, never markup,
   so a document can say anything it likes without the page obeying it.  */
function inline(s){
  const out=[];
  const re=RX(BT,"([^",BT,"]+)",BT,"|\\*\\*([^*]+)\\*\\*|\\*([^*\\n]+)\\*|\\[([^\\]]*)\\]\\(([^)\\s]+)[^)]*\\)|(https?://[^\\s)<]+)");
  let last=0,m;
  while((m=re.exec(s))){
    if(m.index>last)out.push(s.slice(last,m.index));
    if(m[1]!=null)out.push(el("code",{},m[1]));
    /* the inner text is markdown too: a bold bullet that contains code used to print its own
       backticks, because the bold branch swallowed the span and never looked inside it. */
    else if(m[2]!=null)out.push(el("strong",{},inline(m[2])));
    else if(m[3]!=null)out.push(el("em",{},inline(m[3])));
    else if(m[4]!=null)out.push(el("a",{href:safeHref(m[5]),target:"_blank",rel:"noreferrer noopener"},m[4]?inline(m[4]):m[5]));
    else out.push(el("a",{href:safeHref(m[6]),target:"_blank",rel:"noreferrer noopener"},m[6]));
    last=m.index+m[0].length;
  }
  if(last<s.length)out.push(s.slice(last));
  return out;
}

const cells=row=>row.replace(/^\||\|$/g,"").split("|").map(c=>c.trim());

function markdown(text){
  const root=el("div",{class:"md"});
  const lines=text.split("\n");
  const FENCE=BT+BT+BT;
  let i=0,para=[],list=null;
  const flushPara=()=>{if(para.length){root.append(el("p",{},inline(para.join(" "))));para=[];}};
  const flushList=()=>{if(list){root.append(list.node);list=null;}};
  const flush=()=>{flushPara();flushList();};

  while(i<lines.length){
    const line=lines[i];
    if(line.startsWith(FENCE)){
      flush();
      const lang=line.slice(3).trim().toLowerCase();
      const buf=[];i++;
      while(i<lines.length&&!lines[i].startsWith(FENCE)){buf.push(lines[i]);i++;}
      i++;
      const code=el("code",{});
      highlight(buf.join("\n"),lang).forEach((ln,n)=>{if(n)code.append("\n");for(const node of ln)code.append(node);});
      root.append(el("pre",{},code));
      continue;
    }
    const h=/^(#{1,6})\s+(.*)$/.exec(line);
    if(h){flush();root.append(el("h"+Math.min(h[1].length,4),{},inline(h[2])));i++;continue;}
    if(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)){flush();root.append(el("hr"));i++;continue;}
    if(/^\s*>\s?/.test(line)){
      flush();const buf=[];
      while(i<lines.length&&/^\s*>\s?/.test(lines[i])){buf.push(lines[i].replace(/^\s*>\s?/,""));i++;}
      root.append(el("blockquote",{},inline(buf.join(" "))));
      continue;
    }
    if(/^\s*\|.*\|\s*$/.test(line)&&i+1<lines.length&&/^\s*\|[\s:|-]+\|\s*$/.test(lines[i+1])){
      flush();
      const head=cells(line.trim());i+=2;
      const rows=[];
      while(i<lines.length&&/^\s*\|.*\|\s*$/.test(lines[i])){rows.push(cells(lines[i].trim()));i++;}
      root.append(el("table",{},[
        el("thead",{},el("tr",{},head.map(c=>el("th",{},inline(c))))),
        el("tbody",{},rows.map(r=>el("tr",{},r.map(c=>el("td",{},inline(c)))))),
      ]));
      continue;
    }
    const li=/^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if(li){
      flushPara();
      const ordered=/\d/.test(li[2]);
      if(!list||list.ordered!==ordered){flushList();list={ordered,node:el(ordered?"ol":"ul",{})};}
      list.node.append(el("li",{},inline(li[3])));
      i++;continue;
    }
    if(!line.trim()){flush();i++;continue;}
    flushList();
    para.push(line.trim());i++;
  }
  flush();
  return root;
}

/* ── code ────────────────────────────────────────────────────────────────
   One tokenizer, a keyword list per family and the right comment mark.
   Not a parser: a reader wants comments, strings, numbers and keywords to
   separate, and this separates them in every language the tree can hold. */
const KW={
  javascript:"const let var function return if else for while do class new await async import export from as typeof instanceof try catch finally throw switch case break continue default delete void yield extends static get set of in null true false undefined this super",
  typescript:"const let var function return if else for while do class new await async import export from as typeof instanceof try catch finally throw switch case break continue default delete void yield extends implements interface type enum public private protected readonly static get set of in null true false undefined this super",
  python:"def class return if elif else for while import from as pass break continue with try except finally raise lambda yield global nonlocal assert del not and or is in None True False self async await match case",
  shell:"if then else elif fi for while do done case esac function return export local source echo set unset trap exit read shift",
  powershell:"function param begin process end if else elseif switch foreach while do until return try catch finally throw class",
  go:"package import func return if else for range var const type struct interface map chan go defer select switch case break continue nil true false",
  rust:"fn let mut const struct enum impl trait use pub mod match if else for while loop return self Self where as dyn move ref Some None Ok Err true false",
  java:"public private protected class interface extends implements new return if else for while do switch case break continue final static void int long double float boolean char String null true false try catch finally throw throws import package this super",
  csharp:"public private protected internal class interface struct new return if else for foreach while do switch case break continue static void var int long double bool string null true false try catch finally throw using namespace this base async await",
  c:"if else for while do return struct union enum typedef static const void int char long short float double unsigned signed sizeof switch case break continue goto include define",
  cpp:"if else for while do return class struct namespace template typename public private protected new delete const static void int char bool auto try catch throw using nullptr true false include define",
  ruby:"def class module end if elsif else unless while until for in do return yield begin rescue ensure raise require attr_accessor self nil true false",
  php:"function class public private protected return if else elseif foreach while do switch case break continue new echo require include use namespace null true false try catch finally throw",
  sql:"select from where group by order having join left right inner outer on as insert into values update set delete create table alter drop index primary key foreign references not null distinct limit offset union all case when then else end",
  css:"import media supports keyframes from to",
  json:"true false null",
  yaml:"true false null yes no on off",
  toml:"true false",
  ini:"true false",
  lua:"function local end if then else elseif for while do return nil true false and or not repeat until",
};
const COMMENT={python:"#",shell:"#",yaml:"#",toml:"#",ini:"#",ruby:"#",r:"#",perl:"#",powershell:"#",
  sql:"--",lua:"--"};
const FAMILY={markdown:null,text:null,binary:null,html:"css",xml:"css",md:"markdown",
  js:"javascript",mjs:"javascript",ts:"typescript",py:"python",sh:"shell",bash:"shell",rb:"ruby",yml:"yaml"};

function tokenizer(lang){
  const mark=COMMENT[lang];
  const com=mark==="#"?"#[^\\n]*":mark==="--"?"--[^\\n]*"
    :"\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*";
  const kw=(KW[lang]||"").trim().split(/\s+/).filter(Boolean).join("|");
  const parts=[
    "("+com+")",
    "("+BT+"(?:[^"+BT+"\\\\]|\\\\.)*"+BT+"|\"\"\"[\\s\\S]*?\"\"\"|\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*')",
    kw?"\\b("+kw+")\\b":"(\\b\\x00\\b)",
    "\\b(\\d[\\w.]*)\\b",
    "([A-Za-z_$][\\w$]*)(?=\\s*\\()",
  ];
  return RX(parts.join("|"));
}
const CLASS=["t-com","t-str","t-key","t-num","t-fn"];

/* Lines, not one blob: a line number belongs to a line, and a token that spans lines still has to land
   in each of them. Splitting the token text is what makes a Python docstring number correctly. */
function highlight(text,lang){
  const fam=lang in FAMILY?FAMILY[lang]:lang;
  const lines=[[]];
  const put=(cls,str)=>{
    const parts=str.split("\n");
    for(let i=0;i<parts.length;i++){
      if(i)lines.push([]);
      if(parts[i])lines[lines.length-1].push(cls?el("span",{class:cls},parts[i]):document.createTextNode(parts[i]));
    }
  };
  if(!fam||!(KW[fam]||COMMENT[fam])){put("",text);return lines;}
  const re=tokenizer(fam);
  let last=0,m;
  while((m=re.exec(text))){
    if(m.index>last)put("",text.slice(last,m.index));
    const g=[1,2,3,4,5].find(n=>m[n]!=null&&m[n]!=="");
    put(g?CLASS[g-1]:"",m[0]);
    last=m.index+m[0].length;
  }
  if(last<text.length)put("",text.slice(last));
  return lines;
}

function codeBlock(text,lang){
  const pre=el("pre",{class:"code"});
  for(const ln of highlight(text,lang))pre.append(el("span",{class:"cl"},ln.length?ln:"\u200b"));
  return pre;
}

/* ── the tree ───────────────────────────────────────────────────────── */
let TREE=null,FILE=null,OPEN=new Set(),FIND="";

const baseOf=p=>p.slice(p.lastIndexOf("/")+1);
const dirOf=p=>p.includes("/")?p.slice(0,p.lastIndexOf("/")):"";
const shown=p=>{let d=dirOf(p);while(d){if(!OPEN.has(d))return false;d=dirOf(d);}return true;};

function openFile(rel){
  FILE={path:rel,loading:true};
  let d=dirOf(rel);while(d){OPEN.add(d);d=dirOf(d);}
  setUrl();render();
  fetch("/api/file/"+encodeURIComponent(PID)+"?path="+encodeURIComponent(rel))
    .then(r=>r.json().then(j=>r.ok&&!j.error?j:Promise.reject(new Error(j.error||("HTTP "+r.status)))))
    .then(f=>{if(FILE&&FILE.path===rel){FILE=f;render();}})
    .catch(e=>{if(FILE&&FILE.path===rel){FILE={path:rel,error:e.message};render();}});
}

function fileButton(e,label){
  const b=el("button",{class:"node",title:e.path,"aria-current":(FILE&&FILE.path===e.path)||null},
    [svg(ICON.file,11),el("span",{class:"nm"},label),el("span",{class:"sz"},size(e.size||0))]);
  b.addEventListener("click",()=>openFile(e.path));
  return b;
}

function nodeButton(e){
  if(!e.dir)return fileButton(e,baseOf(e.path));
  const depth=e.path.split("/").length-1;
  const b=el("button",{class:"node dir",style:"padding-left:"+(10+depth*13)+"px",title:e.path},
    [svg(ICON.dir,11),el("span",{class:"nm"},baseOf(e.path)+"/")]);
  b.addEventListener("click",()=>{OPEN.has(e.path)?OPEN.delete(e.path):OPEN.add(e.path);render();});
  return b;
}

function renderTree(){
  const box=el("div",{class:"tree"});
  const find=el("input",{type:"text",value:FIND,placeholder:"find a file"});
  find.addEventListener("input",ev=>{
    FIND=ev.target.value;
    const next=renderTree();
    $(".files").replaceChild(next,$(".tree"));
    const i=next.querySelector("input");i.focus();i.setSelectionRange(FIND.length,FIND.length);
  });
  box.append(el("div",{class:"find"},find));

  if(FIND.trim()){
    const q=FIND.trim().toLowerCase();
    const hits=TREE.entries.filter(e=>!e.dir&&e.path.toLowerCase().includes(q)).slice(0,200);
    box.append(el("div",{class:"grp"},hits.length?hits.length+" matching":"nothing with that in its path"));
    for(const e of hits)box.append(fileButton(e,e.path));
    return box;
  }

  if(TREE.docs&&TREE.docs.length){
    box.append(el("div",{class:"grp"},"What the loop wrote"));
    for(const d of TREE.docs)box.append(fileButton(TREE.entries.find(x=>x.path===d)||{path:d,size:0},baseOf(d)));
    box.append(el("div",{class:"grp"},"The project"));
  }
  for(const e of TREE.entries)if(shown(e.path)){
    const n=nodeButton(e);
    if(!e.dir)n.style.paddingLeft=(10+(e.path.split("/").length-1)*13)+"px";
    box.append(n);
  }
  if(TREE.truncated)box.append(el("div",{class:"grp"},"the list stops here — too many files"));
  return box;
}

function renderViewer(){
  const v=el("div",{class:"viewer"});
  if(!FILE){
    v.append(el("div",{class:"empty"},[el("b",{},"Pick a file"),
      "What the loop wrote is at the top of the list. Everything below it is your project."]));
    return v;
  }
  const head=[el("span",{class:"fp"},[dirOf(FILE.path)?dirOf(FILE.path)+"/":"",el("b",{},baseOf(FILE.path))])];
  const tail=[];
  if(FILE.lang)tail.push(el("span",{class:"state s-rest"},[svg(MARK.rest),FILE.lang]));
  if(FILE.bytes!=null)tail.push(el("span",{class:"msg"},size(FILE.bytes)));
  if(tail.length)head.push(el("span",{class:"sp"},tail));
  v.append(el("div",{class:"vhead"},head));

  if(FILE.loading){
    v.append(el("div",{class:"pbody"},[1,2,3,4,5,6].map(()=>el("span",{class:"sk",style:"margin:7px 0"}))));
    return v;
  }
  if(FILE.error){v.append(el("div",{class:"empty"},[el("b",{},"Cannot read that"),FILE.error]));return v;}
  if(FILE.truncated){v.append(el("div",{class:"empty"},[el("b",{},"Not shown"),FILE.why]));return v;}
  v.append(el("div",{class:"vbody"},
    FILE.lang==="markdown"?markdown(FILE.text)
    :FILE.lang==="text"?el("div",{class:"plain"},FILE.text)
    :codeBlock(FILE.text,FILE.lang)));
  return v;
}

function renderFiles(){
  if(!TREE)return el("div",{class:"empty"},[el("b",{},"Reading the project"),"One moment."]);
  if(TREE.error)return el("div",{class:"empty"},[el("b",{},"Cannot list the files"),TREE.error]);
  return el("div",{class:"files"},[renderTree(),renderViewer()]);
}

function needTree(){
  if(TREE||TREE===false)return;
  TREE=false;
  fetch("/api/files/"+encodeURIComponent(PID))
    .then(r=>r.json())
    .then(t=>{TREE=t.error?{error:t.error,entries:[]}:t;if(TAB==="files")render();})
    .catch(e=>{TREE={error:e.message,entries:[]};if(TAB==="files")render();});
}

/* ── home ────────────────────────────────────────────────────────────────
   Ordered by what needs a person: blocked, then waiting, then running.   */
function rankOf(p){return p.blocked?0:p.needsHuman?1:p.running?2:3;}
function renderHome(){
  $("#where").textContent=S.home;
  const v=$("#view");v.replaceChildren();
  const ps=[...S.projects].sort((a,b)=>rankOf(a)-rankOf(b)
    ||new Date(b.lastActivityAt||0)-new Date(a.lastActivityAt||0));
  const n={run:ps.filter(p=>p.running).length,stop:ps.filter(p=>p.blocked).length,
           wait:ps.filter(p=>p.needsHuman).length,rest:ps.filter(p=>!p.running&&!p.blocked&&!p.needsHuman).length};
  const spent=ps.reduce((s,p)=>s+(p.cost||0),0);

  v.append(el("h1",{},"Projects"));
  v.append(el("p",{class:"lede"},
    n.stop||n.wait ? (n.stop?n.stop+" blocked":"")+(n.stop&&n.wait?", ":"")+(n.wait?n.wait+" waiting on you":"")+" — deal with these first."
    : n.run ? n.run+" running. Nothing needs you."
    : "Nothing is running."));

  v.append(el("div",{class:"band"},[
    el("div",{class:n.stop?"attn":""},[el("span",{class:"v"},n.stop),el("span",{class:"k"},"Blocked")]),
    el("div",{class:n.wait?"wait":""},[el("span",{class:"v"},n.wait),el("span",{class:"k"},"Waiting on you")]),
    el("div",{class:n.run?"go":""},[el("span",{class:"v"},n.run),el("span",{class:"k"},"Running")]),
    el("div",{},[el("span",{class:"v"},n.rest),el("span",{class:"k"},"Idle")]),
    el("div",{},[el("span",{class:"v"},money(spent)),el("span",{class:"k"},"Spent")]),
  ]));

  v.append(el("h2",{},["Projects",el("span",{class:"n"},ps.length+" registered")]));
  if(!ps.length){
    v.append(el("div",{class:"empty"},[el("b",{},"No projects yet"),
      el("p",{},["Open a terminal in the project you want to build and run ",
        el("code",{},"cli.mjs setup"),". It appears here the moment it does."])]));
    return;
  }
  v.append(el("div",{class:"rows"},ps.map(p=>{
    const pct=p.tickets?Math.round(p.done/p.tickets*100):0;
    const st=p.blocked?["stop",p.blocked+" blocked"]:p.needsHuman?["wait","needs you"]
      :p.running?["live",p.current?p.current.id:"running"]:["rest","idle"];
    return el("a",{class:"row",href:"/p/"+p.id},[
      el("span",{class:"st"},state(st[0],st[1])),
      el("span",{class:"who"},[el("span",{class:"name"},p.name),
        p.goal?el("span",{class:"goal"},p.goal):null]),
      el("span",{class:"meter"},[el("span",{class:"track"},el("span",{class:"fill",style:"transform:scaleX("+(pct/100)+")"})),
        el("span",{class:"pct"},pct+"%")]),
      el("span",{class:"path",title:p.root},p.root),
      el("span",{class:"when"},ago(p.lastActivityAt)),
    ]);
  })));
}

/* ── project ─────────────────────────────────────────────────────────
   Four faces, because they are four different jobs: reading progress,
   reading the work, changing who does it, and watching what happened.
   They used to be one scroll, where a blocked ticket, a spawn argv and
   an event line all looked equally important.                          */
const TABS=[["overview","Overview"],["files","Files"],["seats","Seats"],["log","Log"]];

function tabsRow(){
  const row=el("div",{class:"tabs",role:"tablist"});
  for(const [id,label] of TABS){
    const b=el("button",{role:"tab","aria-selected":TAB===id?"true":"false"},label);
    if(id==="log"&&S.log&&S.log.length)b.append(el("span",{class:"n"},S.log.length));
    if(id==="files"&&TREE&&TREE.entries)b.append(el("span",{class:"n"},TREE.entries.filter(e=>!e.dir).length));
    b.addEventListener("click",()=>{TAB=id;setUrl();render();if(id==="files")needTree();});
    row.append(b);
  }
  return row;
}

function overview(v){
  const pr=S.progress;
  if(!pr){
    v.append(el("div",{class:"empty"},[el("b",{},"Nothing recorded yet"),
      el("p",{},["Set a goal and run the first stage: ",el("code",{},"cli.mjs stage brainstorm"),"."])]));
    return;
  }
  const t=pr.totals;
  v.append(el("div",{class:"band"},[
    el("div",{class:t.blocked?"attn":""},[el("span",{class:"v"},t.blocked),el("span",{class:"k"},"Blocked")]),
    el("div",{class:t.needsHuman?"wait":""},[el("span",{class:"v"},t.needsHuman),el("span",{class:"k"},"Waiting on you")]),
    el("div",{class:"go"},[el("span",{class:"v"},t.done+"/"+t.tickets),el("span",{class:"k"},"Tickets")]),
    el("div",{},[el("span",{class:"v"},dur(t.specMs)),el("span",{class:"k"},"Spec")]),
    el("div",{},[el("span",{class:"v"},dur(t.buildMs)),el("span",{class:"k"},"Build")]),
    el("div",{},[el("span",{class:"v"},money(t.costUsd)),el("span",{class:"k"},"Cost")]),
  ]));

  v.append(el("h2",{},["Now",el("span",{class:"n"},pr.live.running?"running":"idle")]));
  if(pr.current){
    const c=pr.current;
    v.append(el("section",{class:"panel"},[
      el("div",{class:"phead"},[el("b",{},"Building"),state("work",dur(c.ms))]),
      el("div",{class:"pbody"},el("dl",{class:"now"},[
        el("dt",{},"Phase"),el("dd",{},c.phase+" — "+c.phaseName),
        el("dt",{},"Ticket"),el("dd",{},[el("span",{class:"tid"},c.id)," ",c.title]),
        el("dt",{},"Since"),el("dd",{},clock(c.startedAt)+(c.dispatches>1?"  ·  dispatch "+c.dispatches:"")),
      ])),
    ]));
  } else {
    v.append(el("div",{class:"empty"},[el("b",{},"Nothing building"),
      t.needsHuman?"A ticket is waiting on a decision from you.":
      t.done===t.tickets&&t.tickets?"Every ticket is done.":
      el("span",{},["Start it with ",el("code",{},"cli.mjs run"),"."])]));
  }

  /* A stage is a document. Saying it is 15,694 characters long and then not letting anyone read it
     is the whole reason the Files tab exists — so each row opens the file it is talking about. */
  v.append(el("h2",{},["Specification",el("span",{class:"n"},dur(t.specMs))]));
  v.append(el("section",{class:"panel"},el("div",{class:"pbody"},pr.stages.map(x=>{
    const doc=DOC_OF[x.id];
    const row=el(doc?"button":"div",{class:"st-row"+(doc?" opens":""),title:doc||null},[
      el("span",{class:"mk",style:"color:var(--"+(x.complete?"live":"rest")+")"},
        svg(MARK[x.complete?"done":"rest"])),
      el("span",{},x.id),
      el("span",{class:"mt"},(x.written!=null?x.written+" tickets":x.complete?(x.chars||0).toLocaleString()+" chars":x.why)+"   "+dur(x.ms)),
    ]);
    if(doc&&x.complete)row.addEventListener("click",()=>{TAB="files";needTree();openFile(doc);});
    else if(doc)row.disabled=true;
    return row;
  }))));

  for(const ph of pr.phases){
    const wall=ph.wallMs!=null&&ph.wallMs>ph.buildMs*1.5?"  ·  "+dur(ph.wallMs)+" wall":"";
    v.append(el("h2",{},["Phase "+ph.id+" — "+ph.name,
      el("span",{class:"n"},ph.done+"/"+ph.total+"  ·  "+dur(ph.buildMs)+wall+(ph.cost?"  ·  "+money(ph.cost):""))]));
    v.append(el("section",{class:"panel"},el("div",{class:"pbody"},ph.tickets.map(tk=>{
      const kind=tk.status==="x"?"done":tk.running?"work":(tk.status==="!"?"stop":tk.status==="?"?"wait":"rest");
      const col=kind==="done"?"live":kind==="work"?"work":kind==="stop"?"stop":kind==="wait"?"work":"rest";
      const bits=[];
      if(tk.startedAt)bits.push(clock(tk.startedAt)+"→"+(tk.endedAt?clock(tk.endedAt):"…"));
      if(tk.ms!=null)bits.push(dur(tk.ms));
      if(tk.attempts)bits.push(tk.attempts+" att");
      if(tk.files)bits.push(tk.files+"f");
      if(tk.review)bits.push(tk.review);
      if(tk.council)bits.push("council");
      if(tk.cost)bits.push(money(tk.cost));
      if(!tk.startedAt&&tk.gate)bits.push("waits for you");
      return el("div",{class:"tk"+(tk.running?" is-run":"")+(tk.status==="!"?" is-stop":"")},[
        el("span",{class:"mk",style:"color:var(--"+col+")"},svg(MARK[kind])),
        el("span",{class:"tid"},tk.id),el("span",{class:"ty"},tk.type),
        el("span",{class:"ti",title:tk.title},tk.title),
        el("span",{class:"mt"},bits.join("  ")),
      ]);
    }))));
  }
}

const DOC_OF={brainstorm:".sch-loop/BRAINSTORM.md",prd:".sch-loop/PRD.md",
  architecture:".sch-loop/ARCHITECTURE.md",plan:".sch-loop/PLAN.md",tickets:"task.md"};

function seatsTab(v){
  v.append(el("h2",{},["Seats",el("span",{class:"n"},"inherited seats are read-only until you customise them")]));
  const own=S.own||{};
  const customise=k=>()=>{S.own={...own,[k]:JSON.parse(JSON.stringify(S.roles[k]))};S.source[k]="project";DIRTY=true;render();};
  const inherit=k=>()=>{const n={...S.own};delete n[k];S.own=n;DIRTY=true;load({keepDirty:true});};
  v.append(seatPanel("executor",S.roles.executor,"Executor","writes code",S.source.executor,customise("executor"),inherit("executor")));
  v.append(seatPanel("reviewer",S.roles.reviewer,"Reviewer","read-only",S.source.reviewer,customise("reviewer"),inherit("reviewer")));
  v.append(seatPanel("judge",S.roles.judge,"Judge","read-only",S.source.judge,customise("judge"),inherit("judge")));
  v.append(el("h2",{},["Council",el("span",{class:"n"},S.source.council==="global"?"inherited":"this project")]));
  v.append(councilPanel(S.roles,S.source.council==="project"));
}

function logTab(v){
  if(!S.log||!S.log.length){
    v.append(el("div",{class:"empty"},[el("b",{},"No events yet"),"The loop writes one line here for everything it does."]));
    return;
  }
  v.append(el("h2",{},["Log",el("span",{class:"n"},"last "+S.log.length)]));
  v.append(el("section",{class:"panel"},el("div",{class:"pbody"},
    S.log.slice().reverse().map(e=>el("div",{class:"ev"},[
      el("time",{},clock(e.at)),
      el("span",{},[el("b",{},e.type),"  ",[e.id,e.stage,e.status,e.decision].filter(Boolean).join("  ")]),
    ])))));
}

function renderProject(){
  const P=S.project,pr=S.progress;
  $("#where").textContent=P.root;
  const v=$("#view");v.replaceChildren();
  v.append(el("h1",{},P.name));
  const goal=pr&&pr.goal?pr.goal.replace(/^#\s*Goal\s*/i,"").trim().split(/\r?\n/).filter(Boolean)[0]:null;
  v.append(el("p",{class:"lede"},goal||"No goal set for this project yet."));
  v.append(tabsRow());
  if(TAB==="files")return renderFilesTab(v);
  if(TAB==="seats")return seatsTab(v);
  if(TAB==="log")return logTab(v);
  overview(v);
}

function renderFilesTab(v){needTree();v.append(renderFiles());}

/* ── settings ────────────────────────────────────────────────────────── */
function renderSettings(){
  $("#where").textContent=S.file;
  const v=$("#view");v.replaceChildren();
  v.append(el("h1",{},"Settings"));
  v.append(el("p",{class:"lede"},"Seat defaults every project inherits until it chooses its own."));
  if(!S.roles){
    v.append(el("div",{class:"empty"},[el("b",{},"No defaults yet"),
      el("p",{},["Run ",el("code",{},"cli.mjs setup")," in any project. The first one seeds these."])]));
    return;
  }
  v.append(el("h2",{},["Installed",el("span",{class:"n"},installed().length+" of "+S.seats.length)]));
  v.append(el("section",{class:"panel"},el("div",{class:"pbody flags"},
    S.seats.map(s=>el("span",{class:"state s-"+(s.available?"live":"rest")},
      [svg(MARK[s.available?"done":"rest"]),s.provider])))));
  v.append(el("h2",{},["Seats",el("span",{class:"n"},"machine-wide")]));
  v.append(seatPanel("executor",S.roles.executor,"Executor","writes code"));
  v.append(seatPanel("reviewer",S.roles.reviewer,"Reviewer","read-only"));
  v.append(seatPanel("judge",S.roles.judge,"Judge","read-only"));
  v.append(el("h2",{},["Council",el("span",{class:"n"},"convened on a red ticket")]));
  v.append(councilPanel(S.roles,true));
}

function render(){
  $("#bar").hidden=!(MODE==="settings"||(MODE==="project"&&TAB==="seats")||DIRTY);
  MODE==="home"?renderHome():MODE==="settings"?renderSettings():renderProject();
}

function skeleton(){
  const v=$("#view");v.replaceChildren();
  v.append(el("h1",{}," "),el("p",{class:"lede"}," "));
  v.append(el("div",{class:"band"},[1,2,3,4,5].map(()=>el("div",{},el("span",{class:"sk"})))));
  v.append(el("div",{class:"rows"},[1,2,3].map(()=>el("div",{class:"row"},
    [el("span",{class:"sk"}),el("span",{class:"sk"}),el("span",{class:"sk"}),el("span",{class:"sk"}),el("span",{class:"sk"})]))));
}

async function load({keepDirty=false}={}){
  const p=location.pathname,q=new URLSearchParams(location.search);
  const wasPid=PID;
  MODE=p==="/settings"?"settings":p.startsWith("/p/")?"project":"home";
  PID=MODE==="project"?decodeURIComponent(p.slice(3)):null;
  TAB=MODE==="project"&&TABS.some(t=>t[0]===q.get("tab"))?q.get("tab"):"overview";
  if(PID!==wasPid){TREE=null;FILE=null;OPEN=new Set();FIND="";}
  const want=q.get("file");
  $("#nav-home").toggleAttribute("aria-current",MODE!=="settings");
  $("#nav-set").toggleAttribute("aria-current",MODE==="settings");
  $("#bar").hidden=!(MODE==="settings"||(MODE==="project"&&TAB==="seats"));
  if(!keepDirty)DIRTY=false;
  $("#msg").className="msg";$("#msg").textContent="";
  skeleton();
  try{
    const url=MODE==="settings"?"/api/settings":MODE==="project"?"/api/project/"+encodeURIComponent(PID):"/api/home";
    const r=await fetch(url);const j=await r.json();
    if(!r.ok||j.error)throw new Error(j.error||("HTTP "+r.status));
    S=j;render();
    if(TAB==="files"&&want&&(!FILE||FILE.path!==want))openFile(want);
  }catch(e){
    $("#view").replaceChildren(el("div",{class:"empty"},[el("b",{},"Could not load"),e.message]));
    $("#msg").className="msg bad";$("#msg").textContent=e.message;
  }
}

$("#reload").addEventListener("click",()=>load());
$("#save").addEventListener("click",async()=>{
  const btn=$("#save"),m=$("#msg");
  btn.disabled=true;m.className="msg";m.textContent="saving…";
  try{
    const url=MODE==="settings"?"/api/settings":"/api/project/"+encodeURIComponent(PID);
    const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify(MODE==="settings"?S.roles:(S.own||{}))});
    const j=await r.json();
    if(!r.ok){m.className="msg bad";m.textContent=j.error;return;}
    S=j;DIRTY=false;render();m.className="msg good";m.textContent="saved";
  }catch(e){m.className="msg bad";m.textContent=e.message;}
  finally{btn.disabled=false;}
});
addEventListener("beforeunload",e=>{if(DIRTY){e.preventDefault();e.returnValue="";}});
addEventListener("popstate",()=>load());
load();
</script></body></html>`;
