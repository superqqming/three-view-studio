// 三視圖產生器的 AI 辨識輸出格式（JSON schema）。這裡是原始檔：
//   - index.html 的「自己的金鑰」用它（tests/sync-ai.mjs 嵌進 index.html）
//   - 課程閘道的 threeview-recognize 用它（Shared_Services/ai-gateway/scripts/sync-assembly.mjs 複製過去）
// 2026-10-13 起從 assembly-unit-simulator/js/ai/threeview-schema.js 搬來（那份留給舊 Worker assembly-unit-ai，不再更新）。
// 與組合單元的格式相同的料塊＋加工步驟模型，另外加上：
//   - profile：在面上用直線＋圓弧畫的封閉輪廓，切穿或切到深度（斜面、圓弧端、溝槽、非矩形缺口）
//   - review：學生手繪圖面的問題，讓學生對照
//   - views_found：在照片上找到哪些視圖、在哪裡
// 限制同組合單元的 schema.js：全部欄位必填、不用聯集、物件 additionalProperties: false。
// 面與邊的名稱：與組合單元模擬器 js/model/frames.js 的 FACES、EDGES 相同（index.html 的建模程式也用這些名稱）
const FACES = ['front', 'back', 'right', 'left', 'top', 'bottom'];
const EDGES = ['front-left', 'front-right', 'back-left', 'back-right', 'top-front', 'top-back', 'top-left', 'top-right', 'bottom-front', 'bottom-back', 'bottom-left', 'bottom-right'];

const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const num = { type: 'number' }, str = { type: 'string' }, bool = { type: 'boolean' };
const arr = (items, minItems) => (minItems ? { type: 'array', items, minItems } : { type: 'array', items });

// ⚠️ Anthropic 會把格式編譯成文法，太複雜就整個退回（「The compiled grammar is too large」，2026-10-13 實測）。
// 物件與陣列最花空間、單一數字或字串欄位很便宜；組合單元的格式（schema.js）本身離上限只差約 7 個數字欄位。
// 所以這裡把小物件改成數字陣列、把「找到的視圖」與「圖面檢查」改成單一字串（一行一項）；
// index.html 讀取時新舊寫法都接受，舊的下載檔也能載入。
// 實測（經閘道 /v1/admin/check-schema）：這份格式再多 6 個數字欄位仍編譯得過、多 9 個就不行。
// 改這個檔之後：cd tests && node probe-schema.mjs --gateway ../ai/threeview-schema.js 確認編譯得過，並留一點餘裕。

// 矩形：[u0, u1, v0, v1]
const RECT = arr(num);

const ISLAND = obj({
  shape: { type: 'string', enum: ['circle', 'rect'] },
  centered: bool,
  u: num, v: num,
  d: num,
  rect: RECT,
});

// 輪廓的一段（數字陣列）：直線 [u, v]；圓弧 [u, v, cu, cv, ccw]（ccw：1 = 正對該面看時逆時針，0 = 順時針）。
// (u, v) 是這一段的終點；起點是上一段的終點（第一段的起點是最後一段的終點）；(cu, cv) 是圓心。
const SEG = arr(num);

const FEATURE = obj({
  type: { type: 'string', enum: ['hole', 'pocket', 'boss', 'fillet', 'chamfer', 'profile'] },
  face: { type: 'string', enum: FACES },
  centered: bool,
  u: num, v: num,
  d: num,
  depth: num,
  through: bool,
  rects: arr(RECT),
  islands: arr(ISLAND),
  edges: arr({ type: 'string', enum: EDGES }),
  size: num,
  mirror: arr({ type: 'string', enum: ['x', 'y', 'z'] }),
  outline: arr(SEG),
});

const STEP = obj({ label: str, note: str, features: arr(FEATURE, 1) });

const UNCERTAIN = obj({
  path: str,
  question: str,
  options: arr(obj({ label: str, value_json: str }), 1),
  chosen: { type: 'integer' },
});

const PART = obj({
  name: str,
  stock: obj({ w: num, h: num, d: num }),
  steps: arr(STEP),
  uncertain: arr(UNCERTAIN),
  assumptions: arr(str),
  review: str,                    // 一行一個問題，開頭是方括號裡的視圖代碼：「[top] 俯視圖缺少圓孔的中心線」
});

export const THREEVIEW_SCHEMA = obj({
  is_part_sketch: bool,
  message: str,
  units_on_sketch: { type: 'string', enum: ['mm', 'cm', 'm', 'none'] },
  transcribed: arr(str),
  views_found: str,               // 「前視圖：左下（粉紅色）；俯視圖：左上」
  parts: arr(PART),
});
