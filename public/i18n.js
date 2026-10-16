// UI translation. The app is written in English; this layer translates visible text and tooltips live,
// so dynamic views (Creation Mode, toasts, progress) are covered too. Song titles, artists and user-written
// playlist names are marked data-notr and never translated.
const LANGS = {
  en: { label: 'English', load: null },
  zh: { label: '简体中文', load: () => import('/i18n/zh.js') },
  ja: { label: '日本語', load: () => import('/i18n/ja.js') },
};
export const LANGUAGES = Object.entries(LANGS).map(([code, v]) => ({ code, label: v.label }));

let lang = 'en', dict = null, patterns = [], observer = null;
const ATTRS = ['title', 'placeholder', 'aria-label'];
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CANVAS', 'SVG', 'svg']);

export function detectLanguage() {
  try { const saved = localStorage.getItem('mixtape.lang'); if (saved && LANGS[saved]) return saved; } catch {}
  const n = (navigator.language || 'en').toLowerCase();
  return n.startsWith('zh') ? 'zh' : n.startsWith('ja') ? 'ja' : 'en';
}
export const currentLanguage = () => lang;

/** Translate one string (exact match, then with emoji/punctuation stripped, then patterns). */
export function t(s) {
  if (!dict || !s) return s;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
  const core = m[2];
  if (!core || !/[A-Za-z]/.test(core)) return s;
  const hit = translateCore(core);
  return hit == null ? s : m[1] + hit + m[3];
}
function translateCore(core) {
  if (dict[core] != null) return dict[core];
  const p = /^([^\p{L}\p{N}]*)([\s\S]*?)([^\p{L}\p{N})]*)$/u.exec(core);
  if (p && p[2] && (p[1] || p[3])) {
    for (const [mid, suf] of [[p[2], p[3]], [p[2] + p[3], ''], [p[2] + p[3].replace(/^\s+/, ''), '']]) {
      if (dict[mid] != null) return p[1] + dict[mid] + suf;
    }
  }
  const viaPattern = (str) => {
    for (const [re, rep] of patterns) {
      if (re.test(str)) return str.replace(re, (...g) => (typeof rep === 'function' ? rep(...g) : rep.replace(/\$(\d)/g, (_, i) => t(g[Number(i)]) ?? '')));
    }
    return null;
  };
  const whole = viaPattern(core);
  if (whole != null) return whole;
  if (p && p[2] && p[1]) { const mid = viaPattern(p[2] + p[3]); if (mid != null) return p[1] + mid; } // e.g. "🔑 A minor"
  return null;
}

function skip(node) {
  const el = node.nodeType === 1 ? node : node.parentElement;
  return !el || SKIP.has(el.nodeName) || !!el.closest('[data-notr]');
}

function translateText(node) {
  if (skip(node)) return;
  const v = node.nodeValue;
  if (node.__tr === v) return;          // already ours
  const en = node.__tr != null && node.__en != null && v === node.__en ? v : v;
  const tr = t(en);
  if (tr !== en) { node.__en = en; node.__tr = tr; node.nodeValue = tr; }
  else { node.__en = null; node.__tr = null; }
}
function translateAttrs(el) {
  if (!el.isConnected || el.closest('[data-notr]')) return; // placeholders of inputs/textareas are translated too
  el.__enAttr ??= {};
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v == null) continue;
    if (el.__enAttr[a]?.tr === v) continue;
    const tr = t(v);
    if (tr !== v) { el.__enAttr[a] = { en: v, tr }; el.setAttribute(a, tr); }
  }
}
function walk(root) {
  if (root.nodeType === 3) return translateText(root);
  if (root.nodeType !== 1 || SKIP.has(root.nodeName)) return;
  translateAttrs(root);
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (n.nodeType === 3) translateText(n); else translateAttrs(n);
  }
}
/** Put English back everywhere (when switching language). */
function restore(root) {
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = tw.currentNode; n; n = tw.nextNode()) {
    if (n.nodeType === 3 && n.__tr != null && n.nodeValue === n.__tr) { n.nodeValue = n.__en; n.__tr = n.__en = null; }
    else if (n.nodeType === 1 && n.__enAttr) { for (const [a, v] of Object.entries(n.__enAttr)) if (n.getAttribute(a) === v.tr) n.setAttribute(a, v.en); n.__enAttr = {}; }
  }
}

export async function setLanguage(code) {
  if (!LANGS[code]) code = 'en';
  try { localStorage.setItem('mixtape.lang', code); } catch {}
  // stop live translation, put English back, then apply the new language
  observer?.disconnect(); observer = null;
  if (dict) restore(document.body);
  dict = null; patterns = [];
  lang = code;
  document.documentElement.lang = code === 'zh' ? 'zh-CN' : code;
  if (code === 'en') return;
  const mod = await LANGS[code].load();
  if (lang !== code) return; // another switch happened meanwhile
  dict = mod.dict; patterns = mod.patterns || [];
  walk(document.body);
  document.title = t(document.title);
  observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') translateText(m.target);
      else if (m.type === 'attributes') translateAttrs(m.target);
      else m.addedNodes.forEach(walk);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
