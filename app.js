import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, collection, getDoc, setDoc, deleteDoc,
  onSnapshot, query, orderBy, limit } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = v => { const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g,'')); return isFinite(n) ? n : 0; };
const r2 = n => Math.round(n*100)/100;
const money = n => (n < 0 ? '-' : '') + '$' + Math.abs(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const money0 = n => (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n||0)).toLocaleString('en-US');
const pad = n => String(n).padStart(2,'0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const parseYmd = s => { const [y,m,d] = String(s).split('-').map(Number); return new Date(y, (m||1)-1, d||1); };
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

const STATUSES = [['closed','Closed (sold)'],['not_closed','Not closed'],['callback','Callback / warranty']];
const PAYMENTS = [['card','Card'],['zelle','Zelle'],['cash','Cash'],['unpaid','Not paid yet']];
const REVIEWS = [['none','No'],['asked','Asked'],['got','Got a review']];
const FEE_METHODS = ['card'];
const hasFee = p => FEE_METHODS.includes(p);
const label = (list, v) => (list.find(x => x[0] === v) || [v, v])[1];
const WARRANTIES = ['6 months','1 year'].concat(Array.from({length:24}, (_,i) => (i+2) + ' years'));
$('#fWarranty').innerHTML = '<option value="">No warranty</option>' + WARRANTIES.map(w => `<option>${w}</option>`).join('');

/* ---------- state ---------- */
const PREF_DEFAULTS = {commissionPct:0, commissionBase:'profit', cardFeePct:4, weekStart:1};
let prefs = {...PREF_DEFAULTS};
let parts = [], partsLoaded = false;
let jobs = [], jobsPending = false;
let access = null, isOwner = false;
let user = null, fb = null;
let unsubs = [];
let weekAnchor = new Date();
let partFilter = '', partsEdit = [], partsDirty = false, partsFilter = '';
let showMine = false;
try{ showMine = localStorage.getItem('doorlog-mine') === '1'; }catch(e){}
const photoCache = new Map();
let draft = null;

/* ---------- toast / status ---------- */
let toastTimer;
function toast(msg){ const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(()=>{ t.hidden = true; }, 3400); }
function setStatus(s, text){ const el = $('#status'); el.dataset.s = s; el.textContent = text; }
function refreshStatus(){
  if (!user) return;
  if (!navigator.onLine) setStatus('offline', 'No signal: saving on phone');
  else if (jobsPending) setStatus('pending', 'Syncing…');
  else setStatus('ok', 'All saved');
}
window.addEventListener('online', refreshStatus);
window.addEventListener('offline', refreshStatus);
function banner(msg){ $('#banner').hidden = !msg; $('#bannerText').textContent = msg || ''; }

/* ---------- Firebase boot ---------- */
if (!firebaseConfig){
  $('#gateTitle').textContent = 'Setup not finished';
  $('#gateText').textContent = 'The Firebase settings are missing in firebase-config.js.';
  setStatus('error', 'Not set up');
} else {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  let db;
  try{ db = initializeFirestore(app, {localCache: persistentLocalCache({tabManager: persistentMultipleTabManager()})}); }
  catch(e){ db = initializeFirestore(app, {}); }
  fb = {app, auth, db};
  getRedirectResult(auth).catch(e => showGateError(e));
  onAuthStateChanged(auth, u => { user = u; stopListeners(); if (!u) showSignIn(); else checkAccess(); });
}

function gate(title, text, {google=false, claim=false, other=false} = {}){
  $('#app').hidden = true; $('#tabs').hidden = true; $('#gate').hidden = false;
  $('#gateTitle').textContent = title; $('#gateText').textContent = text;
  $('#googleBtn').hidden = !google; $('#claimBtn').hidden = !claim; $('#gateSignOut').hidden = !other;
}
function showSignIn(){ setStatus('connecting', 'Signed out'); gate('Sign in', 'Log your jobs on the spot and get your weekly report. Sign in with the Google account the owner added.', {google:true}); }
function showGateError(e){
  if (!e) return;
  const code = e.code || '';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
  if (code === 'auth/unauthorized-domain') toast('This website address isn’t allowed in Firebase yet (Authorized domains).');
  else toast('Sign-in failed: ' + (code || e.message));
}
$('#googleBtn').addEventListener('click', async () => {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({prompt:'select_account'});
  try{ await signInWithPopup(fb.auth, provider); }
  catch(e){
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
      try{ await signInWithRedirect(fb.auth, provider); }catch(e2){ showGateError(e2); }
    } else showGateError(e);
  }
});
$('#gateSignOut').addEventListener('click', () => signOut(fb.auth));
$('#signOutBtn').addEventListener('click', () => { stopListeners(); signOut(fb.auth); });

async function checkAccess(){
  setStatus('connecting', 'Checking access…');
  let snap;
  try{ snap = await getDoc(doc(fb.db, 'config', 'access')); }
  catch(e){
    if (e.code === 'permission-denied'){
      setStatus('error', 'No access');
      gate('Not on the team yet', `You’re signed in as ${user.email}. Ask the owner to add this email in Parts & pay → Team, then reload.`, {other:true});
    } else {
      setStatus('offline', 'No connection');
      gate('Can’t connect', 'Check your signal and reload the page. The first sign-in on a phone needs internet.', {other:true});
    }
    return;
  }
  if (!snap.exists()){
    setStatus('connecting', 'New setup');
    gate('First-time setup', `No owner yet. If this is your app, tap below to become the owner as ${user.email}. Only do this once.`, {claim:true, other:true});
    return;
  }
  access = snap.data();
  isOwner = access.ownerUid === user.uid;
  startApp();
}
$('#claimBtn').addEventListener('click', async () => {
  $('#claimBtn').disabled = true;
  try{
    await setDoc(doc(fb.db, 'config', 'access'), {ownerUid:user.uid, members:[]});
    await setDoc(doc(fb.db, 'config', 'parts'), {parts:[], updatedAt:new Date().toISOString()});
    toast('You’re the owner. Next: import your parts list.');
    checkAccess();
    location.hash = 'parts';
  }catch(e){ toast('Setup failed: ' + (e.code || e.message)); }
  finally{ $('#claimBtn').disabled = false; }
});

function stopListeners(){ unsubs.forEach(u => { try{ u(); }catch(e){} }); unsubs = []; }

function startApp(){
  $('#gate').hidden = true; $('#app').hidden = false; $('#tabs').hidden = false;
  $('#whoami').textContent = `Signed in as ${user.email}${isOwner ? ' (owner)' : ''}.`;
  $('#teamPanel').hidden = !isOwner;
  draft = loadDraft() || newDraft();
  fillForm(); route(); refreshStatus();
  const db = fb.db, uid = user.uid;

  unsubs.push(onSnapshot(doc(db, 'config', 'parts'), snap => {
    parts = (snap.exists() && Array.isArray(snap.data().parts)) ? snap.data().parts : [];
    partsLoaded = true;
    draft.items.forEach(it => { if (!it.custom){ const p = parts.find(x => x.name === it.name); if (p) it.cost = num(p.cost); } });
    renderPicker(); renderTotals();
    if (!$('#view-parts').hidden) renderPartsEditor();
    banner(isOwner && !parts.length ? 'Your parts list is empty. Go to Parts & pay and import it.' : '');
  }, e => { partsLoaded = true; renderPicker(); }));

  if (isOwner) unsubs.push(onSnapshot(doc(db, 'config', 'access'), snap => { if (snap.exists()){ access = snap.data(); renderTeam(); } }));

  unsubs.push(onSnapshot(doc(db, 'users', uid), snap => {
    prefs = {...PREF_DEFAULTS, ...(snap.exists() ? snap.data() : {})};
    seg($('#fPayment'), PAYMENTS.map(([v]) => [v, payLabel(v)]), draft.payment, v => { draft.payment = v; storeDraft(); renderTotals(); });
    renderTotals(); renderWeek();
    if (!$('#view-parts').hidden) renderPayForm();
  }));

  unsubs.push(onSnapshot(query(collection(db, 'users', uid, 'jobs'), orderBy('date','desc'), limit(1000)), {includeMetadataChanges:true}, snap => {
    jobs = snap.docs.map(d => ({id:d.id, ...d.data()}));
    jobsPending = snap.metadata.hasPendingWrites;
    refreshStatus(); renderWeek();
  }, e => { setStatus('error', 'Sync problem'); toast('Sync problem: ' + (e.code || e.message)); }));
}

/* write without waiting for the server: saved on the phone right away, synced when there is signal */
function bg(promise, failMsg){ promise.catch(e => toast((failMsg || 'Not saved') + ': ' + (e.code === 'permission-denied' ? 'not allowed' : (e.code || e.message)))); }

/* ---------- draft ---------- */
function newDraft(){
  return {id:null, createdAt:null, date:ymd(new Date()), jobNo:'', customer:'', status:'closed', items:[],
          price:0, warranty:'', payment:'card', tip:0, review:'none', notes:'', description:''};
}
const draftKey = () => 'doorlog-draft-' + (user ? user.uid : 'x');
function loadDraft(){ try{ const s = localStorage.getItem(draftKey()); return s ? JSON.parse(s) : null; }catch(e){ return null; } }
let draftTimer;
function storeDraft(){ clearTimeout(draftTimer); draftTimer = setTimeout(()=>{ try{ localStorage.setItem(draftKey(), JSON.stringify(draft)); }catch(e){} }, 400); }
function clearStoredDraft(){ clearTimeout(draftTimer); try{ localStorage.removeItem(draftKey()); }catch(e){} }

function calc(d, p){
  const price = num(d.price);
  const tip = num(d.tip);
  const items = d.items || [];
  const partsCost = d.status === 'not_closed' ? 0 : items.reduce((a,it) => a + num(it.qty) * num(it.cost), 0);
  const cardFee = hasFee(d.payment) ? (price + tip) * num(p.cardFeePct) / 100 : 0;
  const total = price + tip + cardFee;
  const profit = price - partsCost;
  const base = p.commissionBase === 'revenue' ? price : profit;
  const commission = Math.max(0, base) * num(p.commissionPct) / 100;
  return {price:r2(price), partsCost:r2(partsCost), cardFee:r2(cardFee), total:r2(total), tip:r2(tip), profit:r2(profit), commission:r2(commission)};
}

/* ---------- routing ---------- */
const VIEWS = ['new','week','parts'];
function route(){
  if (!user || $('#app').hidden) return;
  const v = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'new';
  VIEWS.forEach(x => { $('#view-'+x).hidden = x !== v; });
  document.querySelectorAll('.tabs a').forEach(a => a.setAttribute('aria-current', a.dataset.v === v ? 'page' : 'false'));
  if (v === 'week') renderWeek();
  if (v === 'parts'){ renderPayForm(); renderPartsEditor(); renderTeam(); }
  window.scrollTo(0,0);
}
window.addEventListener('hashchange', route);

/* ---------- job form ---------- */
function seg(el, opts, val, onPick){
  el.innerHTML = opts.map(([v,l]) => `<button type="button" data-v="${esc(v)}" aria-pressed="${v===val}">${esc(l)}</button>`).join('');
  el.onclick = e => { const b = e.target.closest('button'); if(!b) return; onPick(b.dataset.v); el.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b)); };
}
function payLabel(v){ return hasFee(v) ? `${label(PAYMENTS, v)} (+${num(prefs.cardFeePct)}%)` : label(PAYMENTS, v); }
function fillForm(){
  if (!Array.isArray(draft.items)) draft.items = [];
  if (typeof draft.description !== 'string') draft.description = '';
  $('#formTitle').textContent = draft.id ? ('Edit job' + (draft.jobNo ? ' #' + draft.jobNo : '')) : 'New job';
  $('#fDate').value = draft.date; $('#fJobNo').value = draft.jobNo; $('#fCust').value = draft.customer;
  $('#fPrice').value = draft.price || ''; $('#fTip').value = draft.tip || ''; $('#fWarranty').value = draft.warranty || '';
  $('#fNotes').value = draft.notes; $('#fDesc').value = draft.description;
  seg($('#fStatus'), STATUSES, draft.status, v => { draft.status = v; storeDraft(); renderTotals(); });
  seg($('#fPayment'), PAYMENTS.map(([v]) => [v, payLabel(v)]), draft.payment, v => { draft.payment = v; storeDraft(); renderTotals(); });
  seg($('#fReview'), REVIEWS, draft.review, v => { draft.review = v; storeDraft(); });
  $('#deleteBtn').hidden = !draft.id; resetDelete();
  $('#saveBtn').textContent = draft.id ? 'Save changes' : 'Save job';
  $('#invoiceText').hidden = true;
  renderPicker(); renderLines();
}
[['#fDate','date'],['#fJobNo','jobNo'],['#fCust','customer'],['#fNotes','notes'],['#fDesc','description'],['#fWarranty','warranty']].forEach(([sel,key]) => {
  $(sel).addEventListener('input', e => { draft[key] = e.target.value; storeDraft(); });
});
[['#fPrice','price'],['#fTip','tip']].forEach(([sel,key]) => {
  $(sel).addEventListener('input', e => { draft[key] = num(e.target.value); storeDraft(); renderTotals(); });
});
$('#partSearch').addEventListener('input', e => { partFilter = e.target.value.trim().toLowerCase(); renderPicker(); });

function groupByCat(list){
  const out = []; const idx = {};
  list.forEach(p => { const c = p.cat || 'Other'; if (!(c in idx)){ idx[c] = out.length; out.push([c, []]); } out[idx[c]][1].push(p); });
  return out;
}
function renderPicker(){
  const el = $('#partPicker');
  if (!parts.length){ el.innerHTML = `<p class="empty">${partsLoaded ? 'No parts list yet. Use “Part not on the list” below.' : 'Loading parts list…'}</p>`; return; }
  const list = parts.filter(p => !partFilter || (p.name + ' ' + (p.cat||'')).toLowerCase().includes(partFilter));
  if (!list.length){ el.innerHTML = '<p class="empty">No part matches that search.</p>'; return; }
  const inJob = new Set(draft.items.map(i => i.name));
  el.innerHTML = groupByCat(list).map(([c, ps]) => `<div><div class="cat-h">${esc(c)}</div><div class="chips">${
    ps.map(p => `<button type="button" class="chip" data-name="${esc(p.name)}" data-on="${inJob.has(p.name)}">${esc(p.name)}</button>`).join('')}</div></div>`).join('');
}
$('#partPicker').addEventListener('click', e => {
  const b = e.target.closest('.chip'); if(!b) return;
  const p = parts.find(x => x.name === b.dataset.name); if(!p) return;
  const ex = draft.items.find(it => it.name === p.name);
  if (ex) ex.qty = num(ex.qty) + 1; else draft.items.push({name:p.name, qty:1, cost:num(p.cost)});
  storeDraft(); renderLines(); b.dataset.on = 'true';
});
$('#addCustom').addEventListener('click', () => {
  draft.items.push({name:'', qty:1, cost:0, custom:true}); storeDraft(); renderLines();
  const inp = document.getElementById('ln-name-' + (draft.items.length - 1)); if (inp) inp.focus();
});
function renderLines(){
  const el = $('#lines');
  if (!draft.items.length){ el.innerHTML = '<p class="empty">Tap the parts you used. Tap again to add more of the same.</p>'; renderTotals(); return; }
  el.innerHTML = draft.items.map((it,i) => `<div class="line" data-i="${i}">
      ${it.custom ? `<input class="ln-name" id="ln-name-${i}" value="${esc(it.name)}" placeholder="Part name" aria-label="Part name">` : `<span>${esc(it.name)}</span>`}
      <div class="qty"><button type="button" data-act="dec" aria-label="One less">−</button><span>${esc(it.qty)}</span><button type="button" data-act="inc" aria-label="One more">+</button></div>
      <button type="button" class="x" data-act="rm" aria-label="Remove part">×</button>
    </div>`).join('');
  renderTotals();
}
$('#lines').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]'); if(!b) return;
  const i = +b.closest('.line').dataset.i; const it = draft.items[i]; if(!it) return;
  if (b.dataset.act === 'inc') it.qty = num(it.qty) + 1;
  if (b.dataset.act === 'dec') it.qty = Math.max(1, num(it.qty) - 1);
  if (b.dataset.act === 'rm') draft.items.splice(i,1);
  storeDraft(); renderLines(); renderPicker();
});
$('#lines').addEventListener('input', e => {
  const line = e.target.closest('.line'); if(!line) return;
  const it = draft.items[+line.dataset.i]; if(!it) return;
  it.name = e.target.value; storeDraft();
});

function renderTotals(){
  if (!draft) return;
  const c = calc(draft, prefs);
  let html = `<div class="t-row"><span>${draft.status === 'not_closed' ? 'Charged (service call)' : 'Job price'}</span><span>${money(c.price)}</span></div>`;
  if (c.tip) html += `<div class="t-row"><span>Tip</span><span>${money(c.tip)}</span></div>`;
  if (hasFee(draft.payment)) html += `<div class="t-row"><span>Card fee (${num(prefs.cardFeePct)}%${c.tip ? ' on price + tip' : ''})</span><span>${money(c.cardFee)}</span></div>`;
  html += `<div class="t-row t-big"><span>Total to charge</span><span>${money(c.total)}</span></div>`;
  $('#totals').innerHTML = html;
  $('#mine').hidden = !showMine;
  $('#mineBtn').textContent = showMine ? 'Hide my numbers' : 'Show my numbers';
  if (showMine){
    const missing = draft.items.filter(it => !num(it.cost) && String(it.name).trim()).length;
    $('#mine').innerHTML = `<div class="t-row"><span>Parts cost</span><span>${money(c.partsCost)}</span></div>
      <div class="t-row"><span>Profit</span><span>${money(c.profit)}</span></div>
      <div class="t-row"><span>My pay (${num(prefs.commissionPct)}%)${c.tip ? ' + tip' : ''}</span><span>${money(c.commission + c.tip)}</span></div>
      ${missing ? `<div>${missing} part(s) have no cost, so profit may be high.</div>` : ''}`;
  }
}
$('#mineBtn').addEventListener('click', () => { showMine = !showMine; try{ localStorage.setItem('doorlog-mine', showMine ? '1' : '0'); }catch(e){} renderTotals(); });

/* ---------- invoice / save / delete ---------- */
function fmtDate(s){ const d = parseYmd(s); return `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; }
function invoiceText(){
  const c = calc(draft, prefs);
  const L = [];
  L.push(`Garage door service – ${fmtDate(draft.date)}`);
  if (draft.jobNo) L.push(`Job #${draft.jobNo}`);
  const desc = String(draft.description || '').trim();
  if (desc){ L.push(''); L.push('Work done:'); L.push(desc); }
  const items = draft.items.filter(it => String(it.name).trim());
  if (items.length){ L.push(''); L.push('Parts included:'); items.forEach(it => L.push(`- ${num(it.qty) > 1 ? num(it.qty) + ' x ' : ''}${it.name}`)); }
  L.push(''); L.push(`Warranty: ${draft.warranty || 'None'}`); L.push('');
  L.push(`Price: ${money(c.price)}`);
  if (c.tip) L.push(`Tip: ${money(c.tip)}`);
  if (hasFee(draft.payment)) L.push(`Card processing fee (${num(prefs.cardFeePct)}%): ${money(c.cardFee)}`);
  L.push(`Total: ${money(c.total)}`);
  if (draft.payment && draft.payment !== 'unpaid') L.push(`Paid by: ${label(PAYMENTS, draft.payment)}`);
  return L.join('\n');
}
function copyText(text, pre, okMsg){
  pre.textContent = text; pre.hidden = false;
  const fallback = () => { const r = document.createRange(); r.selectNodeContents(pre); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Text selected below. Copy it from there.'); };
  try{ navigator.clipboard.writeText(text).then(() => toast(okMsg), fallback); }catch(e){ fallback(); }
}
$('#invoiceBtn').addEventListener('click', () => copyText(invoiceText(), $('#invoiceText'), 'Invoice text copied. No part costs in it.'));

$('#saveBtn').addEventListener('click', () => {
  if (!num(draft.price) && draft.status !== 'callback'){ toast('Enter the job price first.'); $('#fPrice').focus(); return; }
  const c = calc(draft, prefs);
  const items = draft.items.filter(it => String(it.name).trim()).map(it => ({name:String(it.name).trim(), qty:num(it.qty), cost:num(it.cost)}));
  const now = new Date().toISOString();
  const data = {date:draft.date || ymd(new Date()), jobNo:String(draft.jobNo).trim(), customer:String(draft.customer).trim(), status:draft.status,
    items, price:c.price, warranty:draft.warranty || '', payment:draft.payment, cardFee:c.cardFee, total:c.total, tip:c.tip,
    partsCost:c.partsCost, profit:c.profit, commission:c.commission, commissionPct:num(prefs.commissionPct),
    review:draft.review, notes:draft.notes, description:String(draft.description || '').trim(), createdAt:draft.createdAt || now, updatedAt:now};
  const jobsCol = collection(fb.db, 'users', user.uid, 'jobs');
  const ref = draft.id ? doc(jobsCol, draft.id) : doc(jobsCol);
  bg(setDoc(ref, data), 'Job not saved');
  toast((draft.id ? 'Changes saved' : 'Job saved') + (navigator.onLine ? '' : ' on phone. It uploads when you have signal.'));
  weekAnchor = parseYmd(data.date);
  draft = newDraft(); clearStoredDraft(); fillForm(); window.scrollTo(0,0);
});
$('#clearBtn').addEventListener('click', () => {
  draft = newDraft(); clearStoredDraft(); fillForm(); toast('Cleared');
});
let delArmed = false, delTimer;
function resetDelete(){ delArmed = false; clearTimeout(delTimer); $('#deleteBtn').textContent = 'Delete job'; }
$('#deleteBtn').addEventListener('click', () => {
  if (!draft.id) return;
  if (!delArmed){ delArmed = true; $('#deleteBtn').textContent = 'Tap again to delete for good'; delTimer = setTimeout(resetDelete, 4000); return; }
  bg(deleteDoc(doc(fb.db, 'users', user.uid, 'jobs', draft.id)), 'Not deleted');
  toast('Job deleted'); draft = newDraft(); clearStoredDraft(); fillForm();
});

/* ---------- weekly report ---------- */
function weekRange(anchor){
  const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  const back = (d.getDay() - num(prefs.weekStart) + 7) % 7;
  const start = new Date(d); start.setDate(d.getDate() - back);
  const end = new Date(start); end.setDate(start.getDate() + 6);
  return {start, end, s:ymd(start), e:ymd(end)};
}
function rangeLabel(w){
  const a = `${MON[w.start.getMonth()]} ${w.start.getDate()}`;
  const b = w.start.getMonth() === w.end.getMonth() ? `${w.end.getDate()}` : `${MON[w.end.getMonth()]} ${w.end.getDate()}`;
  return `${a} – ${b}, ${w.end.getFullYear()}`;
}
function weekStats(){
  const w = weekRange(weekAnchor);
  const list = jobs.filter(j => j.date >= w.s && j.date <= w.e).sort((a,b) => (a.date + (a.createdAt||'')).localeCompare(b.date + (b.createdAt||'')));
  const st = {w, list, n:list.length, closed:0, notClosed:0, callbacks:0, revenue:0, cardFees:0, tips:0, partsCost:0, profit:0, pay:0, closedRevenue:0, reviewsGot:0, reviewsAsked:0, pays:{}, parts:{}};
  list.forEach(j => {
    if (j.status === 'closed'){ st.closed++; st.closedRevenue += num(j.price); }
    else if (j.status === 'not_closed') st.notClosed++; else st.callbacks++;
    st.revenue += num(j.price); st.cardFees += num(j.cardFee); st.tips += num(j.tip);
    st.partsCost += num(j.partsCost); st.profit += num(j.profit); st.pay += num(j.commission);
    if (j.review === 'got'){ st.reviewsGot++; st.reviewsAsked++; } else if (j.review === 'asked') st.reviewsAsked++;
    if (num(j.total) > 0){ const p = st.pays[j.payment] || (st.pays[j.payment] = {n:0, amt:0, tip:0}); p.n++; p.amt += num(j.total); p.tip += num(j.tip); }
    if (j.status !== 'not_closed') (j.items || []).forEach(it => {
      const p = st.parts[it.name] || (st.parts[it.name] = {qty:0, cost:0});
      p.qty += num(it.qty); p.cost += num(it.qty) * num(it.cost);
    });
  });
  st.closeRate = (st.closed + st.notClosed) ? Math.round(100 * st.closed / (st.closed + st.notClosed)) : null;
  st.avgTicket = st.closed ? st.closedRevenue / st.closed : 0;
  return st;
}
function renderWeek(){
  if (!draft || $('#view-week').hidden) return;
  const st = weekStats();
  $('#wkLabel').textContent = rangeLabel(st.w);
  const k = (key, val, sub, hi) => `<div class="kpi${hi ? ' hi' : ''}"><span class="k">${esc(key)}</span><span class="v">${esc(val)}</span><span class="s">${esc(sub)}</span></div>`;
  $('#kpis').innerHTML =
    k('Jobs', String(st.n), `${st.closed} closed · ${st.notClosed} not · ${st.callbacks} callback`) +
    k('Close rate', st.closeRate === null ? '–' : st.closeRate + '%', 'closed ÷ (closed + not closed)') +
    k('Sales', money0(st.revenue), `avg closed job ${money0(st.avgTicket)}`) +
    k('Reviews', String(st.reviewsGot), `${st.reviewsAsked} asked`) +
    k('Parts cost', money0(st.partsCost), `${Object.values(st.parts).reduce((a,p) => a + p.qty, 0)} parts used`) +
    k('Profit', money0(st.profit), 'sales − parts cost') +
    k('My pay + tips', money(st.pay + st.tips), `${money0(st.pay)} pay · ${money0(st.tips)} tips`, true) +
    k('Card fees', money0(st.cardFees), `not paid yet: ${money0((st.pays.unpaid||{amt:0}).amt)}`);
  const payRows = PAYMENTS.filter(([v]) => st.pays[v]).map(([v,l]) => `<tr><td>${esc(l)}</td><td class="num">${st.pays[v].n}</td><td class="num">${money(st.pays[v].amt)}</td><td class="num">${money(st.pays[v].tip)}</td></tr>`).join('');
  $('#payTbl').innerHTML = payRows ? `<table><thead><tr><th>Method</th><th class="num">Jobs</th><th class="num">Charged</th><th class="num">Tips</th></tr></thead><tbody>${payRows}</tbody></table>` : '<p class="empty">No payments logged this week.</p>';
  const ps = Object.entries(st.parts).sort((a,b) => b[1].qty - a[1].qty);
  $('#partsTbl').innerHTML = ps.length ? `<table><thead><tr><th>Part</th><th class="num">Qty</th><th class="num">Cost</th></tr></thead><tbody>${ps.map(([n,p]) => `<tr><td>${esc(n)}</td><td class="num">${p.qty}</td><td class="num">${money(p.cost)}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No parts used this week.</p>';
  $('#jobList').innerHTML = st.list.length ? st.list.map(j => { const d = parseYmd(j.date); return `<button type="button" class="job" data-id="${esc(j.id)}">
      <span class="d">${DOW[d.getDay()]} ${d.getMonth()+1}/${d.getDate()}</span>
      <span class="m"><span><span class="pill p-${esc(j.status)}">${esc(label(STATUSES, j.status).replace(' (sold)',''))}</span>${j.jobNo ? '#' + esc(j.jobNo) : ''} ${esc(j.customer || '')}</span>
      <small>${esc(label(PAYMENTS, j.payment))}${num(j.tip) ? ' · tip ' + esc(money0(j.tip)) : ''}${j.review === 'got' ? ' · ★ review' : j.review === 'asked' ? ' · review asked' : ''}${(j.items||[]).length ? ' · ' + esc((j.items||[]).map(i => (i.qty > 1 ? i.qty + '× ' : '') + i.name).join(', ')) : ''}</small></span>
      <span class="num">${money0(num(j.price))}</span></button>`; }).join('')
    : '<p class="empty">No jobs logged this week. Save a job from the New job tab and it shows up here.</p>';
  $('#reportText').hidden = true;
}
$('#jobList').addEventListener('click', e => {
  const b = e.target.closest('.job'); if(!b) return;
  const j = jobs.find(x => x.id === b.dataset.id); if(!j) return;
  draft = {id:j.id, createdAt:j.createdAt||null, date:j.date, jobNo:j.jobNo||'', customer:j.customer||'', status:j.status||'closed',
    items:(j.items||[]).map(i => ({...i, custom:!parts.some(p => p.name === i.name)})), price:num(j.price), warranty:j.warranty||'',
    payment:j.payment||'card', tip:num(j.tip), review:j.review||'none', notes:j.notes||'', description:j.description||''};
  storeDraft(); fillForm(); location.hash = 'new';
});
$('#prevWk').addEventListener('click', () => { weekAnchor = new Date(weekAnchor.getFullYear(), weekAnchor.getMonth(), weekAnchor.getDate() - 7); renderWeek(); });
$('#nextWk').addEventListener('click', () => { weekAnchor = new Date(weekAnchor.getFullYear(), weekAnchor.getMonth(), weekAnchor.getDate() + 7); renderWeek(); });

function reportText(){
  const st = weekStats(); const L = [];
  L.push(`Weekly report: ${rangeLabel(st.w)}`);
  L.push(`Jobs: ${st.n} | Closed: ${st.closed} | Not closed: ${st.notClosed} | Callbacks: ${st.callbacks} | Close rate: ${st.closeRate === null ? '-' : st.closeRate + '%'}`);
  L.push(`Sales: ${money(st.revenue)} | Parts cost: ${money(st.partsCost)} | Profit: ${money(st.profit)}`);
  L.push(`Avg closed job: ${money(st.avgTicket)} | Card fees: ${money(st.cardFees)}`);
  L.push(`My pay: ${money(st.pay)} | Tips: ${money(st.tips)}`);
  L.push(`Reviews: ${st.reviewsGot} received (${st.reviewsAsked} asked)`);
  const pays = PAYMENTS.filter(([v]) => st.pays[v]).map(([v,l]) => `${l} ${st.pays[v].n} (${money(st.pays[v].amt)})`);
  L.push(`Payments: ${pays.length ? pays.join(' | ') : 'none'}`);
  const ps = Object.entries(st.parts).sort((a,b) => b[1].qty - a[1].qty).map(([n,p]) => `${p.qty}x ${n}`);
  L.push(`Parts used: ${ps.length ? ps.join(', ') : 'none'}`);
  L.push(''); L.push('Jobs:');
  st.list.forEach(j => { const d = parseYmd(j.date);
    L.push(`${DOW[d.getDay()]} ${d.getMonth()+1}/${d.getDate()}  ${j.jobNo ? '#' + j.jobNo + '  ' : ''}${label(STATUSES, j.status)}  ${money(num(j.price))}  ${label(PAYMENTS, j.payment)}${num(j.tip) ? '  tip ' + money(j.tip) : ''}${j.review === 'got' ? '  review' : ''}`); });
  return L.join('\n');
}
$('#copyBtn').addEventListener('click', () => copyText(reportText(), $('#reportText'), 'Report copied. Paste it into a text or email.'));
$('#csvBtn').addEventListener('click', () => {
  const st = weekStats();
  const q = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s; };
  const rows = [['Date','Job #','Customer','Outcome','Parts','Warranty','Job price','Payment','Card fee','Total charged','Tip','Parts cost','Profit','My pay','Review','Job description','Notes']];
  st.list.forEach(j => rows.push([j.date, j.jobNo, j.customer, label(STATUSES, j.status), (j.items||[]).map(i => i.qty + 'x ' + i.name).join('; '),
    j.warranty, j.price, label(PAYMENTS, j.payment), j.cardFee, j.total, j.tip, j.partsCost, j.profit, j.commission, label(REVIEWS, j.review), j.description, j.notes]));
  const blob = new Blob([rows.map(r => r.map(q).join(',')).join('\n')], {type:'text/csv'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `jobs-${st.w.s}.csv`;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
});

/* ---------- pay settings ---------- */
function renderPayForm(){
  $('#sPct').value = prefs.commissionPct || ''; $('#sBase').value = prefs.commissionBase || 'profit';
  $('#sCard').value = prefs.cardFeePct ?? 4; $('#sWeek').value = String(prefs.weekStart ?? 1);
}
$('#savePay').addEventListener('click', () => {
  const next = {commissionPct:num($('#sPct').value), commissionBase:$('#sBase').value, cardFeePct:num($('#sCard').value), weekStart:num($('#sWeek').value), email:user.email};
  bg(setDoc(doc(fb.db, 'users', user.uid), next, {merge:true}), 'Pay settings not saved');
  toast('Pay settings saved');
});

/* ---------- team (owner) ---------- */
function renderTeam(){
  if (!isOwner || !access) return;
  const m = access.members || [];
  $('#teamList').innerHTML = m.length ? m.map(e => `<div class="team-row"><span>${esc(e)}</span><button type="button" class="x" data-email="${esc(e)}" aria-label="Remove ${esc(e)}">×</button></div>`).join('')
    : '<p class="empty">Nobody added yet. Just you.</p>';
}
function saveMembers(list){ bg(setDoc(doc(fb.db, 'config', 'access'), {ownerUid:access.ownerUid, members:list}), 'Team not saved'); }
$('#teamAdd').addEventListener('click', () => {
  const e = $('#teamEmail').value.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)){ toast('Enter a full email address.'); return; }
  const m = access.members || [];
  if (m.includes(e)){ toast('Already on the team.'); return; }
  saveMembers(m.concat(e)); $('#teamEmail').value = ''; toast(e + ' added. Send them the link.');
});
$('#teamList').addEventListener('click', e => {
  const b = e.target.closest('button[data-email]'); if(!b) return;
  saveMembers((access.members || []).filter(x => x !== b.dataset.email)); toast('Removed ' + b.dataset.email);
});

/* ---------- parts list ---------- */
function renderPartsEditor(){
  if (!partsDirty) partsEdit = JSON.parse(JSON.stringify(parts));
  $('#partCount').textContent = partsEdit.length + ' parts';
  $('#addPart').hidden = !isOwner; $('#saveParts').hidden = !isOwner; $('#importBox').hidden = !isOwner;
  $('#partsNote').textContent = isOwner
    ? 'What each part costs you. Used only for profit, never shown to customers. Everyone on your team uses this list.'
    : 'Part costs are set by the owner. Ask them to change a cost.';
  const f = partsFilter;
  const rows = partsEdit.map((p,i) => [p,i]).filter(([p]) => !f || (p.name + ' ' + (p.cat||'')).toLowerCase().includes(f));
  if (!rows.length){ $('#partsEditor').innerHTML = `<p class="empty">${partsEdit.length ? 'No part matches that search.' : 'No parts yet.'}</p>`; return; }
  $('#partsEditor').innerHTML = isOwner
    ? `<div class="part-row part-head"><span>Part</span><span class="cat">Group</span><span>Cost $</span><span></span></div>` +
      rows.map(([p,i]) => `<div class="part-row" data-i="${i}">
        <input data-k="name" value="${esc(p.name)}" placeholder="Part" aria-label="Part name" id="pt-name-${i}">
        <input data-k="cat" class="cat" value="${esc(p.cat||'')}" placeholder="Group" aria-label="Group">
        <input data-k="cost" inputmode="decimal" value="${esc(p.cost)}" aria-label="Cost">
        <button type="button" class="x" data-act="rm" aria-label="Remove part">×</button></div>`).join('')
    : rows.map(([p]) => `<div class="part-ro"><span>${esc(p.name)} <span class="hint">${esc(p.cat||'')}</span></span><span class="num">${money(num(p.cost))}</span></div>`).join('');
}
$('#partsSearch').addEventListener('input', e => { partsFilter = e.target.value.trim().toLowerCase(); renderPartsEditor(); });
$('#partsEditor').addEventListener('input', e => {
  const row = e.target.closest('.part-row'); if(!row || !row.dataset.i) return; const p = partsEdit[+row.dataset.i]; const k = e.target.dataset.k;
  p[k] = k === 'cost' ? num(e.target.value) : e.target.value; partsDirty = true;
});
$('#partsEditor').addEventListener('click', e => {
  const b = e.target.closest('button[data-act="rm"]'); if(!b) return; partsEdit.splice(+b.closest('.part-row').dataset.i, 1); partsDirty = true; renderPartsEditor();
});
$('#addPart').addEventListener('click', () => {
  partsFilter = ''; $('#partsSearch').value = '';
  partsEdit.unshift({name:'', cat:'', cost:0}); partsDirty = true; renderPartsEditor();
  const el = document.getElementById('pt-name-0'); if (el) el.focus();
});
function saveParts(list){
  bg(setDoc(doc(fb.db, 'config', 'parts'), {parts:list, updatedAt:new Date().toISOString()}), 'Parts not saved');
  partsDirty = false;
}
$('#saveParts').addEventListener('click', () => {
  saveParts(partsEdit.filter(p => String(p.name).trim()).map(p => ({name:String(p.name).trim(), cat:String(p.cat||'').trim(), cost:num(p.cost)})));
  toast('Parts list saved');
});
$('#importBtn').addEventListener('click', () => {
  const lines = $('#importText').value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const list = JSON.parse(JSON.stringify(parts)); let added = 0, updated = 0, bad = 0;
  lines.forEach(l => {
    const bits = l.split('|').map(s => s.trim());
    if (bits.length < 3 || !bits[1]){ bad++; return; }
    const [cat, name, cost] = bits; const ex = list.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (ex){ ex.cost = num(cost); ex.cat = cat || ex.cat; updated++; } else { list.push({name, cat, cost:num(cost)}); added++; }
  });
  if (!added && !updated){ toast('Nothing imported. Use: Group | Part name | Cost'); return; }
  saveParts(list); $('#importText').value = '';
  toast(`Imported: ${added} new, ${updated} updated${bad ? `, ${bad} lines skipped` : ''}.`);
});
