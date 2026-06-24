// 章节标题归一化：跨源章节锚点的兜底键。
// 设计为纯函数 + 表驱动；不针对任何源。所有源都用同一套规则。
//
// 流程（顺序敏感）：
//   1. 繁体 → 简体（常见汉字表）
//   2. 全角字符 → 半角
//   3. 中文数字 → 阿拉伯（"一百二十三话" → "123话"）
//   4. 罗马数字 → 阿拉伯（Ⅰ-Ⅹ）
//   5. lower case
//   6. 去空白 + 去标点（保留汉字 / 数字 / 字母）
//
// 设计取舍：
//   - 繁简表是有限子集，覆盖漫画标题常见字（不打算做 OpenCC 全量表）；漏字会让标题归一退化但不出错。
//   - 数字解析最大支持十万级（"九万九千九百九十九"），漫画章节够用。
//   - 不做拼音化 / 同义词归一，避免误命中。

// 繁→简：成对字符串运行时 build 成 Map。
// 设计为 string 而非对象字面量：避免 TS 字面量 dup-key 报错；后续补字直接接尾。
// 漏字会让"飛機杯" → "飛機杯"（保持原字），归一后两边都没简化，匹配仍能 fall back 到 number 锚点。
const T2S_RAW =
  '飛飞機机連连線线話话學学園园戀恋愛爱龍龙鳳凤鬥斗戰战國国漢汉紅红綠绿藍蓝黃黄' +
  '雲云風风際际過过進进為为個个來来從从會会說说時时間间問问題题無无聲声夢梦' +
  '裡里裏里麵面麼么這这誰谁當当對对兒儿幾几寫写讀读聽听見见門门開开關关頭头' +
  '臉脸體体腳脚聞闻響响畫画圖图書书師师專专業业東东節节陽阳陰阴萬万億亿們们' +
  '還还給给龜龟麗丽驚惊義义興兴區区醫医衛卫燈灯製制級级結结緊紧緒绪經经紀纪' +
  '統统練练細细約约紛纷紙纸純纯絕绝紗纱紋纹績绩網网緣缘編编縱纵總总縮缩緩缓' +
  '縣县繞绕織织繪绘頻频額额顏颜類类顯显預预頂顶項项須须順顺頌颂領领頗颇頸颈' +
  '頰颊顆颗魚鱼鳥鸟雞鸡鴨鸭鵝鹅鸚鹦鵑鹃鴻鸿鷹鹰雛雏雙双雜杂離离難难電电' +
  '霧雾靈灵靜静韻韵韓韩陳陈張张楊杨錢钱鄭郑馮冯蘇苏盧卢蔣蒋蕭萧謝谢葉叶' +
  '銀银銅铜鐵铁錶表長长島岛車车艦舰馬马驢驴鯨鲸鴿鸽駕驾駐驻驅驱騎骑驕骄' +
  '驍骁驟骤髒脏髮发鬚须鬧闹鬱郁魯鲁鳴鸣麥麦齊齐齒齿齡龄齲龋處处備备優优' +
  '惡恶儀仪習习農农產产請请夠够舊旧極极盡尽剛刚錯错隊队陸陆階阶殺杀體体' +
  '隻只雖虽碼码隨随隱隐覺觉懷怀識识證证變变讓让認认顧顾鄉乡鎮镇縱纵帶带' +
  '財财買买賣卖貴贵賤贱賓宾賦赋資资賺赚賢贤質质賴赖購购贊赞贏赢趙赵趕赶' +
  '車车軌轨軍军軒轩較较輕轻載载輸输轉转辭辞農农達达邊边鄰邻鄉乡釋释鈴铃' +
  '銀银鋼钢錯错鎮镇鏡镜鐘钟鑑鉴針针釣钓鈕钮銘铭錄录鍵键閃闪閉闭閑闲間间' +
  '閒闲閣阁閱阅闊阔闖闯關关闡阐阻阻陽阳陰阴隔隔際际雕雕電电雷雷霸霸面面' +
  '韆千順顺頓顿項项須须預预頭头頰颊頸颈題题顏颜額额風风飛飞驚惊體体'

function buildT2S(raw: string): Map<string, string> {
  const m = new Map<string, string>()
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const t = raw[i]
    const s = raw[i + 1]
    if (!m.has(t)) m.set(t, s)
  }
  return m
}
const T2S = buildT2S(T2S_RAW)

// 中文数字（包括大写）
const CN_DIGIT: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  壹: 1,
  二: 2,
  貳: 2,
  贰: 2,
  兩: 2,
  两: 2,
  三: 3,
  參: 3,
  叁: 3,
  四: 4,
  肆: 4,
  五: 5,
  伍: 5,
  六: 6,
  陸: 6,
  陆: 6,
  七: 7,
  柒: 7,
  八: 8,
  捌: 8,
  九: 9,
  玖: 9
}

const CN_UNIT: Record<string, number> = {
  十: 10,
  拾: 10,
  百: 100,
  佰: 100,
  千: 1000,
  仟: 1000,
  万: 10000,
  萬: 10000
}

const ROMAN: Record<string, string> = {
  Ⅰ: '1',
  Ⅱ: '2',
  Ⅲ: '3',
  Ⅳ: '4',
  Ⅴ: '5',
  Ⅵ: '6',
  Ⅶ: '7',
  Ⅷ: '8',
  Ⅸ: '9',
  Ⅹ: '10',
  Ⅺ: '11',
  Ⅻ: '12',
  ⅰ: '1',
  ⅱ: '2',
  ⅲ: '3',
  ⅳ: '4',
  ⅴ: '5',
  ⅵ: '6',
  ⅶ: '7',
  ⅷ: '8',
  ⅸ: '9',
  ⅹ: '10'
}

function isCnDigit(ch: string): boolean {
  return ch in CN_DIGIT
}
function isCnUnit(ch: string): boolean {
  return ch in CN_UNIT
}

// 解析单段中文数字（如 "一百二十三"）。算法：每遇到单位（十/百/千）将累加的位值翻倍上去。
// "万" 触发节段乘（10000），将当前累计推到节内并重置；超过 99,999 罕见，没必要做亿位。
function cnRunToNumber(run: string): number | null {
  let total = 0
  let section = 0
  let current = 0
  for (const ch of run) {
    if (isCnDigit(ch)) {
      current = CN_DIGIT[ch]
    } else if (isCnUnit(ch)) {
      const u = CN_UNIT[ch]
      if (u === 10000) {
        // 节内累计 + 当前位为「万」的乘数。守卫：仅裸「万」(累计为 0) 视为 1，
        // 否则 current=0（如「二十万」section=20）不能被 `||1` 误加一万 → 210000。
        const head = section + current
        section = (head === 0 ? 1 : head) * 10000
        total += section
        section = 0
        current = 0
      } else {
        section += (current || 1) * u
        current = 0
      }
    } else {
      return null
    }
  }
  total += section + current
  return total > 0 ? total : null
}

// 全角 → 半角：ASCII 范围内的全角字符（U+FF01..U+FF5E）减去 0xFEE0 即半角。
function toHalfWidth(ch: string): string {
  const code = ch.charCodeAt(0)
  if (code >= 0xff01 && code <= 0xff5e) {
    return String.fromCharCode(code - 0xfee0)
  }
  if (code === 0x3000) return ' '
  return ch
}

// 主入口。
export function normalizeTitle(input: string): string {
  if (!input) return ''
  // 1. 繁简
  let s = ''
  for (const ch of input) {
    s += T2S.get(ch) ?? ch
  }
  // 2. 全角 → 半角
  let half = ''
  for (const ch of s) {
    half += toHalfWidth(ch)
  }
  s = half

  // 3. 中文数字 → 阿拉伯（按"连续中文数字 + 单位"片段扫描）
  let out = ''
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (isCnDigit(ch) || isCnUnit(ch)) {
      let j = i
      while (j < s.length && (isCnDigit(s[j]) || isCnUnit(s[j]))) j++
      const run = s.slice(i, j)
      const n = cnRunToNumber(run)
      if (n !== null) {
        out += String(n)
      } else {
        out += run
      }
      i = j
    } else {
      out += ch
      i += 1
    }
  }
  s = out

  // 4. 罗马数字 → 阿拉伯
  let rom = ''
  for (const ch of s) {
    rom += ROMAN[ch] ?? ch
  }
  s = rom

  // 5. lower case
  s = s.toLowerCase()

  // 6. 去空白 + 去标点（保留 \p{Letter}+\p{Number}）。
  // Scripting JS runtime 不一定支持 \p{} —— 用显式过滤：保留 ASCII 字母数字 + 大于 0x4E00 的汉字。
  let kept = ''
  for (const ch of s) {
    const code = ch.charCodeAt(0)
    const isAscii = (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x7a)
    const isCjk = code >= 0x4e00 && code <= 0x9fff
    if (isAscii || isCjk) kept += ch
  }
  return kept
}
