// 介面語言：繁體中文（原文）、English、Tiếng Việt、Bahasa Indonesia
// 沿用組合單元工作室的 js/i18n/i18n.js（2026-10-13），改成三視圖用的儲存鍵；由 tests/sync-ai.mjs 嵌進 index.html。
//
// 用法（像 gettext：中文原文就是 key，找不到翻譯時顯示中文）
//   t('開始辨識')                                 一般文字
//   t('已隱藏 {n} 個尺寸', { n })                 有變數：用 {名稱}，不要用 ${}
//   t('面|上')                                    同一個字在不同地方意思不同：前面加「情境|」，中文顯示 | 後面的字
//   N('孔')                                       放在載入時就建立的表格裡：只做標記、不翻譯，用的地方再寫 t(表格[k])
// 只翻介面：圖面上的字（標題欄、視圖名稱、尺寸、孔的標註）維持中文，不要用 t()。
import { EN } from './en.js';
import { VI } from './vi.js';
import { ID } from './id.js';

export const LANGS = [['zh-TW', '繁體中文'], ['en', 'English'], ['vi', 'Tiếng Việt'], ['id', 'Bahasa Indonesia']];
export const LANG_KEY = 'three-view-studio:lang';
const DICTS = { en: EN, vi: VI, id: ID };
let lang = 'zh-TW';

export const getLang = () => lang;
export function setLang(l) {
  lang = LANGS.some(x => x[0] === l) ? l : 'zh-TW';
  if (typeof document !== 'undefined') document.documentElement.lang = lang === 'zh-TW' ? 'zh-Hant' : lang;
  return lang;
}
// 第一次打開：跟著瀏覽器的語言（中文 → 繁中，越南文、印尼文、英文各自；其他語言 → 英文）
export function detectLang(saved) {
  if (saved && LANGS.some(x => x[0] === saved)) return saved;
  const list = typeof navigator !== 'undefined' ? [...(navigator.languages || []), navigator.language || ''] : [];
  for (const raw of list) {
    const l = String(raw).toLowerCase();
    if (l.startsWith('zh')) return 'zh-TW';
    if (l.startsWith('vi')) return 'vi';
    if (l.startsWith('id') || l.startsWith('in')) return 'id';
    if (l.startsWith('en')) return 'en';
  }
  return list.length ? 'en' : 'zh-TW';
}

const strip = s => { const i = s.indexOf('|'); return i >= 0 ? s.slice(i + 1) : s; };
export function t(s, vars) {
  const d = DICTS[lang];
  let out = (d && d[s]) || strip(s);
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return out;
}
export const N = s => s;

// index.html 裡固定的字：data-i18n（內文）、data-i18n-title、data-i18n-placeholder、data-i18n-aria-label；原文記在 data-i18n-src
export function applyStatic(root = typeof document !== 'undefined' ? document : null) {
  if (!root) return;
  for (const el of root.querySelectorAll('[data-i18n]')) {
    if (!el.dataset.i18nSrc) el.dataset.i18nSrc = el.textContent.trim();
    el.textContent = t(el.dataset.i18nSrc);
  }
  for (const [attr, key] of [['title', 'i18nTitle'], ['placeholder', 'i18nPlaceholder'], ['aria-label', 'i18nAriaLabel']]) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) {
      const src = el.dataset[key] || el.getAttribute(attr) || '';
      el.dataset[key] = src;
      el.setAttribute(attr, t(src));
    }
  }
}
