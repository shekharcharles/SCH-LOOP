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
   rather than assigned as markup, so nothing on this page has an innerHTML sink at all. */
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

let S=null,MODE="home",PID=null,DIRTY=false;

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

/* ── project ─────────────────────────────────────────────────────────── */
function renderProject(){
  const P=S.project,pr=S.progress;
  $("#where").textContent=P.root;
  const v=$("#view");v.replaceChildren();
  v.append(el("h1",{},P.name));
  const goal=pr&&pr.goal?pr.goal.replace(/^#\s*Goal\s*/i,"").trim().split(/\r?\n/).filter(Boolean)[0]:null;
  v.append(el("p",{class:"lede"},goal||"No goal set for this project yet."));

  if(pr){
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

    v.append(el("h2",{},["Specification",el("span",{class:"n"},dur(t.specMs))]));
    v.append(el("section",{class:"panel"},el("div",{class:"pbody"},pr.stages.map(x=>
      el("div",{class:"st-row"},[
        el("span",{class:"mk",style:"color:var(--"+(x.complete?"live":"rest")+")"},
          svg(MARK[x.complete?"done":"rest"])),
        el("span",{},x.id),
        el("span",{class:"mt"},(x.written!=null?x.written+" tickets":x.complete?(x.chars||0).toLocaleString()+" chars":x.why)+"   "+dur(x.ms)),
      ])))));

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

  v.append(el("h2",{},["Seats",el("span",{class:"n"},"inherited seats are read-only until you customise them")]));
  const own=S.own||{};
  const customise=k=>()=>{S.own={...own,[k]:JSON.parse(JSON.stringify(S.roles[k]))};S.source[k]="project";DIRTY=true;render();};
  const inherit=k=>()=>{const n={...S.own};delete n[k];S.own=n;DIRTY=true;load({keepDirty:true});};
  v.append(seatPanel("executor",S.roles.executor,"Executor","writes code",S.source.executor,customise("executor"),inherit("executor")));
  v.append(seatPanel("reviewer",S.roles.reviewer,"Reviewer","read-only",S.source.reviewer,customise("reviewer"),inherit("reviewer")));
  v.append(seatPanel("judge",S.roles.judge,"Judge","read-only",S.source.judge,customise("judge"),inherit("judge")));

  v.append(el("h2",{},["Council",el("span",{class:"n"},S.source.council==="global"?"inherited":"this project")]));
  v.append(councilPanel(S.roles,S.source.council==="project"));

  if(S.log&&S.log.length){
    v.append(el("h2",{},["Log",el("span",{class:"n"},"last "+S.log.length)]));
    v.append(el("section",{class:"panel"},el("div",{class:"pbody log"},
      S.log.slice().reverse().map(e=>el("div",{class:"ev"},[
        el("time",{},clock(e.at)),
        el("span",{},[el("b",{},e.type),"  ",[e.id,e.stage,e.status,e.decision].filter(Boolean).join("  ")]),
      ])))));
  }
}

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

function render(){MODE==="home"?renderHome():MODE==="settings"?renderSettings():renderProject();}

function skeleton(){
  const v=$("#view");v.replaceChildren();
  v.append(el("h1",{}," "),el("p",{class:"lede"}," "));
  v.append(el("div",{class:"band"},[1,2,3,4,5].map(()=>el("div",{},el("span",{class:"sk"})))));
  v.append(el("div",{class:"rows"},[1,2,3].map(()=>el("div",{class:"row"},
    [el("span",{class:"sk"}),el("span",{class:"sk"}),el("span",{class:"sk"}),el("span",{class:"sk"}),el("span",{class:"sk"})]))));
}

async function load({keepDirty=false}={}){
  const p=location.pathname;
  MODE=p==="/settings"?"settings":p.startsWith("/p/")?"project":"home";
  PID=MODE==="project"?decodeURIComponent(p.slice(3)):null;
  $("#nav-home").toggleAttribute("aria-current",MODE!=="settings");
  $("#nav-set").toggleAttribute("aria-current",MODE==="settings");
  $("#bar").hidden=MODE==="home";
  if(!keepDirty)DIRTY=false;
  $("#msg").className="msg";$("#msg").textContent="";
  skeleton();
  try{
    const url=MODE==="settings"?"/api/settings":MODE==="project"?"/api/project/"+encodeURIComponent(PID):"/api/home";
    const r=await fetch(url);const j=await r.json();
    if(!r.ok||j.error)throw new Error(j.error||("HTTP "+r.status));
    S=j;render();
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
