'use strict';
const { esc } = require('../http');
const LOGO = require('./logo');

const CSS = `
:root{
  --ground:#ECF1F7; --surface:#FFFFFF; --surface2:#DFE8F2; --line:#C7D5E4;
  --ink:#0B1030; --ink2:#3F506B; --ink3:#6D809B;
  --brass:#13629A; --brassbg:#DCEAF6; --brassline:#9FC6E3;
  --bar:#13629A;   /* the earnings bars — validated against this surface */
  --teal:#12706A; --tealbg:#D5EBE9;
  --green:#1C7548; --greenbg:#D7EDE1;
  --red:#A33E3A; --redbg:#F5DEDC;
  --amber:#8C6110; --amberbg:#F6E9D2;
  --shadow:0 1px 2px rgba(11,16,48,.07),0 10px 26px -14px rgba(11,16,48,.26);
  --radius:10px;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --ground:#070B16; --surface:#0E1524; --surface2:#182134; --line:#25314A;
    --ink:#E6EDF7; --ink2:#9BADC4; --ink3:#6C7E9A;
    --brass:#5BA3DC; --brassbg:#0E2439; --brassline:#28496D;
    --bar:#4E9AD6;   /* stepped down for the dark surface, revalidated */
    --teal:#4FBDB6; --tealbg:#0A2A29;
    --green:#57C08A; --greenbg:#0C2B1F;
    --red:#E2857F; --redbg:#33191A;
    --amber:#D9A441; --amberbg:#2B2213;
    --shadow:0 1px 2px rgba(0,0,0,.5),0 10px 26px -14px rgba(0,0,0,.8);
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-size:15.5px;line-height:1.55;
  font-family:"IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%}
h1,h2,h3{font-family:Archivo,"IBM Plex Sans",sans-serif;font-weight:700;letter-spacing:-.02em;margin:0;text-wrap:balance}
a{color:var(--brass)}
button,input,select,textarea{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--brass);outline-offset:2px;border-radius:5px}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
.mono{font-family:"IBM Plex Mono",ui-monospace,monospace}
.num{font-variant-numeric:tabular-nums}
.muted{color:var(--ink2)} .small{font-size:13.5px} .tiny{font-size:12px}
.eyebrow{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink3);font-weight:600}

.top{position:sticky;top:0;z-index:30;background:var(--surface);border-bottom:1px solid var(--line)}
.topin{max-width:1080px;margin:0 auto;padding:10px 16px;display:flex;align-items:center;gap:11px}
.mark{width:32px;height:32px;flex:none;border-radius:50%;display:block}
.bizname{font-family:Archivo;font-weight:700;font-size:14.5px;letter-spacing:-.02em;line-height:1.15;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bizsub{font-size:11px;color:var(--ink3);letter-spacing:.04em}
.whoami{margin-left:auto;display:flex;align-items:center;gap:8px;flex:none}
.chip{font-size:11px;letter-spacing:.07em;text-transform:uppercase;font-weight:600;padding:4px 8px;
  border-radius:999px;background:var(--surface2);color:var(--ink2);white-space:nowrap}
.tabs{max-width:1080px;margin:0 auto;padding:0 16px;display:flex;gap:2px;overflow-x:auto;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tab{padding:10px 12px 11px;color:var(--ink3);font-weight:600;font-size:13.5px;text-decoration:none;
  border-bottom:2px solid transparent;white-space:nowrap}
.tab[aria-current="page"]{color:var(--ink);border-bottom-color:var(--brass)}
.wrap{max-width:1080px;margin:0 auto;padding:18px 16px 80px}

.banner{border-radius:var(--radius);padding:10px 13px;font-size:13.5px;margin-bottom:14px;border:1px solid}
.banner.ok{background:var(--greenbg);border-color:var(--green)}
.banner.bad{background:var(--redbg);border-color:var(--red)}
.banner.warn{background:var(--amberbg);border-color:var(--amber)}

.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}
.pad{padding:14px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.sec{margin:26px 0 11px;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.sec h2{font-size:17px}
.sec .eyebrow{margin-left:auto}

.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:13px 14px;box-shadow:var(--shadow)}
.tile .v{font-family:Archivo;font-weight:700;font-size:27px;letter-spacing:-.03em;line-height:1.1;margin-top:5px;font-variant-numeric:tabular-nums}
.tile .n{font-size:12px;color:var(--ink3);margin-top:3px}
.tile.hi{border-color:var(--brassline);background:linear-gradient(180deg,var(--brassbg),var(--surface) 70%)}
.tile.hi .v{color:var(--brass)}

.list{display:flex;flex-direction:column}
.item{display:flex;gap:12px;align-items:flex-start;padding:12px 14px;border-top:1px solid var(--line);
  width:100%;text-align:left;text-decoration:none;color:inherit}
.item:first-child{border-top:0}
a.item:hover{background:var(--surface2)}
.item .grow{flex:1;min-width:0}
.item .ttl{font-weight:600;font-size:14.5px}
.item .sub{font-size:12.5px;color:var(--ink3);margin-top:2px}
.amt{font-family:"IBM Plex Mono",ui-monospace,monospace;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap;font-size:14px}
.empty{padding:26px 16px;text-align:center;color:var(--ink3);font-size:13.5px}

.pill{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;letter-spacing:.05em;
  text-transform:uppercase;padding:3px 8px;border-radius:999px;white-space:nowrap}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.st-new{background:var(--amberbg);color:var(--amber)}
.st-contacted{background:var(--surface2);color:var(--ink2)}
.st-booked{background:var(--tealbg);color:var(--teal)}
.st-completed{background:var(--brassbg);color:var(--brass)}
.st-settled{background:var(--greenbg);color:var(--green)}
.st-lost{background:var(--redbg);color:var(--red)}
.st-paid{background:var(--greenbg);color:var(--green)}

label.f{display:block;margin-bottom:11px}
label.f > span{display:block;font-size:12px;font-weight:600;color:var(--ink2);margin-bottom:4px}
input[type=text],input[type=tel],input[type=email],input[type=number],input[type=date],input[type=password],
input[type=file],select,textarea{width:100%;padding:9px 11px;background:var(--ground);border:1px solid var(--line);
  border-radius:8px;color:var(--ink)}
textarea{min-height:72px;resize:vertical}
.hint{font-size:12px;color:var(--ink3);margin-top:4px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 10px}
@media (max-width:520px){.grid2{grid-template-columns:1fr}}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:9px 14px;border-radius:8px;
  border:1px solid var(--line);background:var(--surface);color:var(--ink);font-weight:600;font-size:14px;
  cursor:pointer;text-decoration:none}
.btn:hover{background:var(--surface2)}
.btn.pri{background:var(--brass);border-color:var(--brass);color:#fff}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .btn.pri{color:#08131E}}
.btn.pri:hover{filter:brightness(1.08)}
.btn.ghost{background:none}
.btn.danger{color:var(--red);border-color:var(--red)}
.btn.sm{padding:6px 10px;font-size:13px}
.btn.full{width:100%}
.btn[disabled]{opacity:.5;cursor:not-allowed}
.btnrow{display:flex;gap:8px;flex-wrap:wrap}
form.inline{display:inline}

.tbl{width:100%;border-collapse:collapse;font-size:13.5px}
.tbl th{text-align:left;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--ink3);
  padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
.tbl td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
.tbl tr:last-child td{border-bottom:0}
.tbl.wide{min-width:520px}
.tbl input{min-width:74px}
.scrollx{overflow-x:auto;-webkit-overflow-scrolling:touch}
.rt{text-align:right}

.gate{max-width:420px;margin:6vh auto;padding:0 16px}
.gatehead{text-align:center;margin-bottom:20px}
.gatehead .mark{width:104px;height:104px;margin:0 auto 14px;filter:drop-shadow(0 6px 16px rgba(11,16,48,.20))}
.gatehead h1{font-size:26px}
.gatehead p{color:var(--ink2);font-size:14px;margin:6px 0 0}
.gatehead .tag{font-size:12.5px;color:var(--ink3);margin-top:2px;font-style:italic}
.pick{display:flex;flex-direction:column;gap:9px}
.pickbtn{text-align:left;padding:14px;display:flex;gap:12px;align-items:center;text-decoration:none;color:inherit}
.pickbtn .grow{flex:1}
.pickbtn .ttl{font-family:Archivo;font-weight:700;font-size:15px}
.pickbtn .sub{font-size:12.5px;color:var(--ink3);margin-top:2px;font-weight:400}
.pickbtn.book{border-color:var(--brassline);background:linear-gradient(180deg,var(--brassbg),var(--surface) 75%)}
.pickbtn.book .ttl{font-size:17px}
.chip.gold{background:var(--brass);color:#fff}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .chip.gold{color:#08131E}}
.divider{display:flex;align-items:center;gap:10px;margin:4px 0;color:var(--ink3);font-size:11.5px;
  letter-spacing:.08em;text-transform:uppercase}
.divider::before,.divider::after{content:"";flex:1;height:1px;background:var(--line)}
.trust{display:flex;justify-content:center;gap:8px 16px;flex-wrap:wrap;margin:18px 0 2px;font-size:12px;color:var(--ink3)}
.trust b{color:var(--ink2);font-weight:600}
.social{display:flex;justify-content:center;gap:16px;margin-top:9px;font-size:12.5px;flex-wrap:wrap}
.social a{text-decoration:none;font-weight:600}

.codebox{display:flex;align-items:center;gap:10px;background:var(--ground);border:1px dashed var(--brassline);
  border-radius:var(--radius);padding:12px 14px}
.codeval{font-family:"IBM Plex Mono",ui-monospace,monospace;font-weight:500;font-size:20px;letter-spacing:.08em;color:var(--brass)}
.assetgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px}
.asset{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow)}
.asset img{display:block;width:100%;height:150px;object-fit:cover;background:var(--surface2)}
.asset .meta{padding:10px 11px}
.asset .nm{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.asset .sz{font-size:11.5px;color:var(--ink3);margin:2px 0 8px}
`;

function page(opts) {
  const o = opts || {};
  const title = o.title || 'Prestige Referrals';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="robots" content="noindex">
<link rel="icon" href="${LOGO}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>${CSS}
/* earnings bars — a bar table: every value is directly labelled, so no
   legend (one series) and no tooltip is needed to read it */
.earnrow{display:grid;grid-template-columns:1fr auto;gap:2px 10px;padding:8px 0;
  border-top:1px solid var(--line)}
.earnrow:first-of-type{border-top:0}
.earnrow:hover{background:var(--surface2)}
.earnrow .nm{font-size:13.5px;font-weight:600;color:var(--ink);min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.earnrow .amt{font-size:14px;font-weight:700;color:var(--ink);text-align:right;
  font-variant-numeric:tabular-nums}
.earnrow .track{grid-column:1 / -1;height:8px;background:var(--surface2);border-radius:4px;overflow:hidden}
.earnrow .fill{display:block;height:100%;background:var(--bar);border-radius:4px;min-width:3px}
.earnrow .px{grid-column:1 / -1;font-size:11.5px;color:var(--ink3);margin-top:-1px}
</style>
</head><body>
${o.body || ''}
</body></html>`;
}

function shell(opts) {
  const o = opts;
  const tabs = (o.tabs || []).map(t =>
    `<a class="tab" href="${esc(t[0])}"${o.active === t[0] ? ' aria-current="page"' : ''}>${esc(t[1])}</a>`).join('');
  return page({
    title: o.title,
    body: `<header class="top"><div class="topin">
  <img class="mark" src="${LOGO}" alt="">
  <div style="min-width:0"><div class="bizname">${esc(o.business)}</div><div class="bizsub">Referral Program</div></div>
  <div class="whoami"><span class="chip">${esc(o.who)}</span>
    <form method="post" action="/logout" class="inline"><button class="btn sm ghost">Sign out</button></form>
  </div>
</div><nav class="tabs">${tabs}</nav></header>
<main class="wrap">${o.flash || ''}${o.body}</main>`,
  });
}

function flash(kind, msg) {
  if (!msg) return '';
  return `<div class="banner ${kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : 'bad'}">${esc(msg)}</div>`;
}

function tile(label, val, note, hi) {
  return `<div class="tile${hi ? ' hi' : ''}"><div class="eyebrow">${esc(label)}</div>
    <div class="v">${esc(String(val))}</div><div class="n">${esc(note)}</div></div>`;
}

function pill(status, labels) {
  return `<span class="pill st-${esc(status)}"><span class="dot"></span>${esc((labels && labels[status]) || status)}</span>`;
}

function bytes(n) {
  const k = Number(n) || 0;
  if (k < 1024) return k + ' B';
  if (k < 1024 * 1024) return (k / 1024).toFixed(0) + ' KB';
  return (k / 1024 / 1024).toFixed(1) + ' MB';
}

module.exports = { page, shell, flash, tile, pill, bytes, CSS, LOGO };
