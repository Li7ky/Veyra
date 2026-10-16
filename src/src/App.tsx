import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Building2,
  Cable,
  CalendarClock,
  Check,
  Clock,
  Copy,
  Cpu,
  Database,
  Globe,
  HardDrive,
  Layers3,
  Link2,
  ListTree,
  MapPin,
  Minus,
  Monitor,
  Network,
  PieChart,
  PanelRight,
  Plus,
  Power,
  Route,
  Search,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Terminal,
  X,
  Zap,
  RefreshCw,
  Settings,
  type LucideIcon,
} from "lucide-react";
import {
  NavHomeIcon,
  NavProxiesIcon,
  NavProfilesIcon,
  NavConnectionsIcon,
  NavRulesIcon,
  NavLogsIcon,
  NavTestsIcon,
  NavSettingsIcon,
} from "./NavIcons";
import {
  CardSubIcon,
  CardNodeIcon,
  CardNetIcon,
  CardModeIcon,
  CardTrafficIcon,
  CardIpIcon,
  CardCoreIcon,
  CardSysIcon,
  CardWebIcon,
  WebGoogleIcon,
  WebGithubIcon,
  WebYoutubeIcon,
  WebXIcon,
} from "./NavIcons";
import type { ConnectionItem, ProfileRich, ProxyNode } from "./vite-env";
import SettingsPanel from "./SettingsPanel";
import ConnectionsPage from "./ConnectionsPage";
import RulesPage from "./RulesPage";
import TestsPage from "./TestsPage";
import WaveChart from "./WaveChart";
import { BRAND_PATHS } from "./brandIcons";
import Sparkline from "./Sparkline";
// Monaco 体积占主包的绝大部分（约 4.4MB）；改为懒加载，首屏 JS 解析时间大幅下降，
// 只有用户首次切到「YAML」子标签时才加载编辑器 chunk。
const YamlEditor = lazy(() => import("./YamlEditor"));
import { ProxiesVisualEditor, GroupsVisualEditor } from "./VisualEditors";
import ConnectOrb from "./ConnectOrb";
import ConfirmDialog, { useFocusTrap, type ConfirmRequest } from "./ConfirmDialog";
import { applyTheme, type ThemeMode } from "./theme";
import { getLocale, setLocale, t } from "./i18n";

type Tab = "home" | "proxies" | "profiles" | "connections" | "rules" | "logs" | "tests" | "settings";
type EnhanceKind = "merge" | "script" | "rules" | "proxies" | "groups";

const GROUP_TYPES = new Set([
  "Selector",
  "URLTest",
  "Fallback",
  "LoadBalance",
  "Relay",
  "selector",
  "url-test",
  "fallback",
  "load-balance",
  "relay",
]);

// 代理页节点渲染分批：首批保证页面立即出现，其余每帧补一批
const PX_NODE_FIRST = 30;
const PX_NODE_BATCH = 60;

function formatBytes(n = 0) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(2)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatRate(bps: number) {
  if (bps < 1024) return `${Math.max(0, Math.round(bps))} B/s`;
  if (bps < 1024 ** 2) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1024 ** 2).toFixed(2)} MB/s`;
}

// v12：侧栏窄轨道专用紧凑速率——3 位有效数字 + B/K/M/G 后缀，最长 5 字符
// （"99.9K"/"1023B"），保证 46px 双列布局下永不截断；完整格式见 formatRate（title 提示）。
function formatRateShort(bps: number) {
  const v = Math.max(0, bps);
  if (v < 1024) return `${Math.round(v)}B`;
  if (v < 1024 ** 2) {
    const k = v / 1024;
    return k < 100 ? `${k.toFixed(1)}K` : `${Math.round(k)}K`;
  }
  if (v < 1024 ** 3) {
    const m = v / 1024 ** 2;
    return m < 100 ? `${m.toFixed(1)}M` : `${Math.round(m)}M`;
  }
  const g = v / 1024 ** 3;
  return g < 100 ? `${g.toFixed(1)}G` : `${Math.round(g)}G`;
}

function formatUptime(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

// v12：侧栏窄轨道专用时长——把 8 字符「12:34:56」压到 ≤5 字符
// （<1h 显示 m:ss，≥1h 显示 12h34），保证状态行 98px 内不换行、不截断
function formatUptimeRail(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function relativeTime(ts?: number) {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 60000) return t("time.justNow");
  if (diff < 3600000) return t("time.minutesAgo", "{n} min ago").replace("{n}", String(Math.floor(diff / 60000)));
  if (diff < 86400000) return t("time.hoursAgo", "{n} hr ago").replace("{n}", String(Math.floor(diff / 3600000)));
  return t("time.daysAgo", "{n} days ago").replace("{n}", String(Math.floor(diff / 86400000)));
}

function expiryText(ts?: number) {
  if (!ts || ts <= 0) return null;
  const d = new Date(ts * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function delayClass(d?: number) {
  if (d == null) return "na";
  if (d <= 0) return "bad";
  if (d < 200) return "good";
  if (d < 500) return "mid";
  return "bad";
}

function delayText(d?: number) {
  if (d == null) return "—";
  if (d <= 0) return t("delay.timeout", "Timeout");
  return `${d}`;
}

const COUNTRY_FLAGS: [RegExp, string][] = [
  // ── 亚洲 ──────────────────────────────────────────
  [/日本|jp|japan|tokyo|osaka|nagoya|fukuoka/i, "JP"],
  [/韩国|kr|korea|seoul|busan/i, "KR"],
  [/新加坡|sg|singapore/i, "SG"],
  [/香港|hong.?kong|hk/i, "HK"],
  [/台湾|taiwan|tw|taipei|kaohsiung/i, "TW"],
  [/泰国|thailand|th|bangkok|chiang.?mai/i, "TH"],
  [/越南|vietnam|vn|hanoi|ho.?chi.?minh|saigon|danang/i, "VN"],
  [/菲律宾|philippines|ph|manila|cebu/i, "PH"],
  [/马来西亚|malaysia|my|kuala.?lumpur|penang/i, "MY"],
  [/印度尼西亚|indonesia|id|jakarta|bali|surabaya/i, "ID"],
  [/印度|india|in|mumbai|delhi|bangalore|chennai|kolkata|hyderabad|pune/i, "IN"],
  [/巴基斯坦|pakistan|pk|karachi|lahore/i, "PK"],
  [/孟加拉国|bangladesh|bd|dhaka/i, "BD"],
  [/斯里兰卡|sri.?lanka|lk|colombo/i, "LK"],
  [/缅甸|myanmar|mm|yangon|rangoon/i, "MM"],
  [/柬埔寨|cambodia|kh|phnom.?penh/i, "KH"],
  [/老挝|laos|la|vientiane/i, "LA"],
  [/蒙古|mongolia|mn|ulaanbaatar/i, "MN"],
  [/尼泊尔|nepal|np|kathmandu/i, "NP"],
  [/不丹|bhutan|bt|thimphu/i, "BT"],
  [/马尔代夫|maldives|mv|male/i, "MV"],
  [/文莱|brunei|bn|bandar.?seri.?begawan/i, "BN"],
  [/东帝汶|timor|tl|dili/i, "TL"],
  [/阿富汗|afghanistan|af|kabul/i, "AF"],

  // ── 中东 ──────────────────────────────────────────
  [/阿联酋|uae|united.?arab.?emirates|dubai|abu.?dhabi/i, "AE"],
  [/沙特|saudi|sa|riyadh|jeddah/i, "SA"],
  [/以色列|israel|il|tel.?aviv|jerusalem/i, "IL"],
  [/土耳其|turkey|tr|istanbul|ankara|izmir/i, "TR"],
  [/伊朗|iran|ir|tehran/i, "IR"],
  [/伊拉克|iraq|iq|baghdad/i, "IQ"],
  [/卡塔尔|qa|doha/i, "QA"],
  [/科威特|kw|kuwait/i, "KW"],
  [/巴林|bahrain|bh|manama/i, "BH"],
  [/阿曼|oman|om|muscat/i, "OM"],
  [/约旦|jordan|jo|amman/i, "JO"],
  [/黎巴嫩|lebanon|lb|beirut/i, "LB"],
  [/叙利亚|syria|sy|damascus/i, "SY"],
  [/也门|yemen|ye|sanaa/i, "YE"],
  [/塞浦路斯|cyprus|cy|nicosia/i, "CY"],
  [/格鲁吉亚|georgia(?!\s*C)|ge|tbilisi/i, "GE"],
  [/亚美尼亚|armenia|am|yerevan/i, "AM"],
  [/阿塞拜疆|azerbaijan|az|baku/i, "AZ"],

  // ── 欧洲 ──────────────────────────────────────────
  [/英国|uk|britain|england|london|manchester|edinburgh|birmingham|glasgow|scotland|wales/i, "GB"],
  [/德国|germany|de|berlin|munich|frankfurt|hamburg|cologne|dusseldorf|stuttgart/i, "DE"],
  [/法国|france|fr|paris|lyon|marseille|toulouse|nice|nantes|strasbourg/i, "FR"],
  [/意大利|italy|it|rome|milan|naples|florence|venice|turin|bologna|genoa/i, "IT"],
  [/西班牙|spain|es|madrid|barcelona|valencia|seville|bilbao|malaga/i, "ES"],
  [/葡萄牙|portugal|pt|lisbon|porto|faro/i, "PT"],
  [/荷兰|nl|netherlands|amsterdam|rotterdam|the.?hague|utrecht|eindhoven/i, "NL"],
  [/比利时|belgium|be|brussels|antwerp|ghent|bruges/i, "BE"],
  [/瑞士|switzerland|ch|zurich|geneva|basel|bern|lausanne/i, "CH"],
  [/奥地利|austria|at|vienna|salzburg|graz|innsbruck/i, "AT"],
  [/瑞典|sweden|se|stockholm|gothenburg|malmo|uppsala/i, "SE"],
  [/挪威|norway|no|oslo|bergen|stavanger|trondheim/i, "NO"],
  [/丹麦|denmark|dk|copenhagen|aarhus|odense/i, "DK"],
  [/芬兰|finland|fi|helsinki|espoo|tampere|oulu/i, "FI"],
  [/冰岛|iceland|is|reykjavik/i, "IS"],
  [/爱尔兰|ireland|ie|dublin|cork|galway|limerick/i, "IE"],
  [/波兰|poland|pl|warsaw|krakow|gdansk|wroclaw|poznan/i, "PL"],
  [/捷克|czech|cz|prague|brno|ostrava/i, "CZ"],
  [/斯洛伐克|sk|bratislava|kosice/i, "SK"],
  [/匈牙利|hungary|hu|budapest|debrecen|szeged/i, "HU"],
  [/罗马尼亚|romania|ro|bucharest|cluj|timisoara/i, "RO"],
  [/保加利亚|bulgaria|bg|sofia|plovdiv|varna/i, "BG"],
  [/希腊|greece|gr|athens|thessaloniki|crete|rhodes|patras/i, "GR"],
  [/克罗地亚|croatia|hr|zagreb|split|dubrovnik/i, "HR"],
  [/塞尔维亚|serbia|rs|belgrade|novi.?sad/i, "RS"],
  [/斯洛文尼亚|slovenia|si|ljubljana|maribor/i, "SI"],
  [/波黑|bosnia|ba|sarajevo|mostar/i, "BA"],
  [/黑山|montenegro|me|podgorica/i, "ME"],
  [/北马其顿|macedonia|mk|skopje/i, "MK"],
  [/阿尔巴尼亚|albania|al|tirana|durres/i, "AL"],
  [/卢森堡|luxembourg|lu/i, "LU"],
  [/爱沙尼亚|estonia|ee|tallinn|tartu/i, "EE"],
  [/拉脱维亚|latvia|lv|riga/i, "LV"],
  [/立陶宛|lithuania|lt|vilnius|kaunas/i, "LT"],
  [/白俄罗斯|belarus|by|minsk/i, "BY"],
  [/摩尔多瓦|moldova|md|chisinau/i, "MD"],
  [/乌克兰|ukraine|ua|kyiv|lviv|kharkiv|odesa/i, "UA"],
  [/俄罗斯|russia|ru|russian|moscow|st.?petersburg|novosibirsk/i, "RU"],

  // ── 北美 ──────────────────────────────────────────
  [
    /美国|us|united.?states|america|los.?angeles|new.?york|chicago|seattle|san.?francisco|washington|dallas|houston|miami|boston|atlanta|denver|phoenix/i,
    "US",
  ],
  [/加拿大|canada|ca|toronto|vancouver|montreal|calgary|ottawa|edmonton/i, "CA"],
  [/墨西哥|mexico|mx|guadalajara|monterrey|cancun/i, "MX"],

  // ── 中美 / 加勒比 ─────────────────────────────────
  [/哥斯达黎加|costa.?rica|cr|san.?jose/i, "CR"],
  [/巴拿马|panama|pa/i, "PA"],
  [/古巴|cuba|cu|havana/i, "CU"],
  [/牙买加|jamaica|jm|kingston/i, "JM"],
  [/海地|haiti|ht|port.?au.?prince/i, "HT"],
  [/多米尼加|dominican|dr|santo.?domingo/i, "DR"],
  [/波多黎各|puerto.?rico|pr|san.?juan/i, "PR"],
  [/危地马拉|guatemala|gt/i, "GT"],
  [/洪都拉斯|hn|tegucigalpa/i, "HN"],
  [/萨尔瓦多|el.?salvador|sv|san.?salvador/i, "SV"],
  [/尼加拉瓜|nicaragua|ni|managua/i, "NI"],
  [/伯利兹|belize|bz|belmopan/i, "BZ"],

  // ── 南美 ──────────────────────────────────────────
  [/巴西|brazil|br|rio|brasilia|sao.?paulo|salvador|recife|fortaleza/i, "BR"],
  [/阿根廷|argentina|ar|buenos.?aires|cordoba|rosario|mendoza/i, "AR"],
  [/智利|chile|cl|santiago|valparaiso|concepcion/i, "CL"],
  [/哥伦比亚|colombia|co|bogota|medellin|cali|barranquilla/i, "CO"],
  [/秘鲁|peru|pe|lima|arequipa|cusco|trujillo/i, "PE"],
  [/委内瑞拉|venezuela|ve|caracas|maracaibo|valencia/i, "VE"],
  [/厄瓜多尔|ecuador|ec|quito|guayaquil/i, "EC"],
  [/玻利维亚|bolivia|bo|sucre|la.?paz|cochabamba/i, "BO"],
  [/巴拉圭|paraguay|py|asuncion|ciudad.?del.?este/i, "PY"],
  [/乌拉圭|uruguay|uy|montevideo/i, "UY"],
  [/圭亚那|guyana|gy|georgetown/i, "GY"],

  // ── 非洲 ──────────────────────────────────────────
  [/南非|south.?africa|za|cape.?town|johannesburg|durban/i, "ZA"],
  [/埃及|egypt|eg|cairo|alexandria|giza/i, "EG"],
  [/摩洛哥|morocco|ma|casablanca|rabat|marrakech/i, "MA"],
  [/阿尔及利亚|algeria|dz|algiers/i, "DZ"],
  [/突尼斯|tunisia|tn|tunis/i, "TN"],
  [/利比亚|libya|ly|tripoli/i, "LY"],
  [/肯尼亚|kenya|ke|nairobi|mombasa/i, "KE"],
  [/尼日利亚|nigeria|ng|lagos|abuja/i, "NG"],
  [/加纳|ghana|gh|accra/i, "GH"],
  [/埃塞俄比亚|ethiopia|et|addis.?ababa/i, "ET"],
  [/坦桑尼亚|tanzania|tz|dodoma|dar.?es.?salaam/i, "TZ"],
  [/安哥拉|angola|ao|luanda/i, "AO"],
  [/莫桑比克|mozambique|mz|maputo/i, "MZ"],
  [/马达加斯加|madagascar|mg|antananarivo/i, "MG"],
  [/毛里求斯|mauritius|mu|port.?louis/i, "MU"],
  [/塞舌尔|seychelles|sc|victoria|mahe/i, "SC"],
  [/纳米比亚|namibia|na|windhoek/i, "NA"],
  [/博茨瓦纳|botswana|bw|gaborone/i, "BW"],
  [/赞比亚|zambia|zm|lusaka/i, "ZM"],
  [/津巴布韦|zimbabwe|zw|harare/i, "ZW"],
  [/卢旺达|rwanda|rw|kigali/i, "RW"],
  [/乌干达|uganda|ug|kampala/i, "UG"],
  [/刚果|congo|cd|kinshasa|brazzaville/i, "CG"],
  [/加蓬|gabon|ga|libreville/i, "GA"],
  [/喀麦隆|cameroon|cm|yaounde|douala/i, "CM"],
  [/科特迪瓦|ivory|ci|abidjan/i, "CI"],
  [/塞内加尔|senegal|sn|dakar/i, "SN"],
  [/马里|ml|bamako/i, "ML"],
  [/布基纳法索|burkina|bf|ouagadougou/i, "BF"],
  [/尼日尔|ne|niamey/i, "NE"],
  [/乍得|td|ndjamena/i, "TD"],
  [/苏丹|sd|khartoum|omdurman/i, "SD"],
  [/索马里|somalia|so|mogadishu/i, "SO"],
  [/加纳|ghana|gh|accra/i, "GH"],

  // ── 大洋洲 ────────────────────────────────────────
  [/澳大利亚|australia|au|sydney|melbourne|brisbane|perth|adelaide|canberra|darwin/i, "AU"],
  [/新西兰|new.?zealand|nz|auckland|wellington|christchurch|queenstown/i, "NZ"],
  [/斐济|fiji|suva/i, "FJ"],
  [/巴布亚新几内亚|papua|pg|port.?moresby/i, "PG"],
  [/萨摩亚|samoa|ws|apia/i, "WS"],
  [/汤加|tonga|to|nuku'alofa/i, "TO"],
  [/瓦努阿图|vanuatu|vu|port.?vila/i, "VU"],
  [/所罗门群岛|solomon|sb|honiara/i, "SB"],
  [/密克罗尼西亚|micronesia|fm|palikir/i, "FM"],
  [/帕劳|palau|pw/i, "PW"],
  [/基里巴斯|kiribati|ki|tarawa/i, "KI"],
];
function countryFlagSvg(name: string) {
  for (const [re, code] of COUNTRY_FLAGS) {
    if (re.test(name)) {
      return `https://flagcdn.com/w40/${code.toLowerCase()}.png`;
    }
  }
  return null;
}

function isTestableNode(name: string) {
  return !["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"].includes(name) && !isInfoNode(name);
}

// 机场信息节点：伪装成节点名展示流量/到期时间（如"剩余流量：79.29 GB"、"套餐到期：2026-10-28"）。
// 它们不是真正的代理节点——混在代理页列表里会让人困惑，也不应参与测速与自动选优。
const INFO_NODE_RE = /剩余流量|已用流量|套餐到期|到期时间|距离.*重置|有效期|重置剩余|流量.*(GB|TB|MB)/i;
function isInfoNode(name: string) {
  return INFO_NODE_RE.test(String(name || ""));
}

// 系统出站（DIRECT/REJECT 等）：可以选中，但需要在卡片上标记，避免被当成普通节点
const SYSTEM_OUTBOUNDS = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"]);
function isSystemOutbound(name: string) {
  return SYSTEM_OUTBOUNDS.has(name);
}

function sortNodesByDelay(names: string[], delays: Record<string, number>) {
  return [...names].sort((a, b) => {
    const da = delays[a];
    const db = delays[b];
    const sa = da == null ? 2 : da <= 0 ? 1 : 0;
    const sb = db == null ? 2 : db <= 0 ? 1 : 0;
    if (sa !== sb) return sa - sb;
    if (sa === 0) return da - db;
    return a.localeCompare(b, "zh");
  });
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

const MODE_LABEL: Record<string, string> = {
  rule: t("home.modeRule", "Rule"),
  global: t("home.modeGlobal", "Global"),
  direct: t("home.modeDirect", "Direct"),
};

// 首页信息小卡（区段 5-7 共用）。抽成常量避免三处重复内联样式，
// 也便于统一调整内边距/圆角。
const HOME_TILE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "12px 14px",
  background: "var(--card-solid)",
  borderRadius: 11,
  border: "0.5px solid var(--card-border)",
  boxShadow: "var(--shadow-sm)",
};
const HOME_TILE_LABEL: React.CSSProperties = {
  fontSize: 10,
  color: "var(--text-500)",
  fontWeight: 500,
  letterSpacing: "0.04em",
  marginBottom: 4,
};
const HOME_TILE_VALUE: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: "var(--text-100)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

// 延迟着色：与节点卡徽章共用 delayClass 的阈值判定，避免出现第二套会漂移的分级。
// 之前这里自己判一次且漏了 `d <= 0`，导致超时节点在首页显示绿色、在代理网格显示红色。
const DELAY_COLOR: Record<ReturnType<typeof delayClass>, string> = {
  good: "var(--green-400)",
  mid: "var(--amber-400)",
  bad: "var(--red-400)",
  na: "var(--text-500)",
};
function delayColor(ms?: number | null): string {
  return DELAY_COLOR[delayClass(ms ?? undefined)];
}
// 迷你图柱子同样只依据 delayClass 判定，避免再复制一份 200/500 阈值。
// 超时（<=0）在文字标签里是红色，这里给红色而不是灰色，两者必须一致。
const DELAY_DOT: Record<ReturnType<typeof delayClass>, string> = {
  good: "dot-green",
  mid: "dot-amber",
  bad: "dot-red",
  na: "dot-off",
};
function delayDotClass(ms: number | null | undefined): string {
  return DELAY_DOT[delayClass(ms ?? undefined)];
}

// 右栏「解锁状态」展示项（v17）：全 12 项聚合在此，分 4 组 × 3 项——
// 正好 3 列 × 4 行，组内一行放满：既保留分组语义，又比 6 项版只高约一行（约 330px，
// 与「网络状态」卡合计仍在右栏一屏内，不需要滚动）。
// id 与测试页严格一致，直接复用 unlockMap；名称取短名以适配 3 列宽度。
const RAIL_UNLOCK_GROUPS: { key: string; label: string; ids: [string, string][] }[] = [
  {
    key: "ai",
    label: "AI",
    ids: [
      ["chatgpt", "ChatGPT"],
      ["claude", "Claude"],
      ["gemini", "Gemini"],
    ],
  },
  {
    key: "film",
    label: "影视",
    ids: [
      ["netflix", "Netflix"],
      ["disney", "Disney+"],
      ["prime", "Prime"],
    ],
  },
  {
    key: "media",
    label: "影音",
    ids: [
      ["youtube", "YouTube"],
      ["spotify", "Spotify"],
      ["bahamut", "Bahamut"],
    ],
  },
  {
    key: "social",
    label: "社区",
    ids: [
      ["tiktok", "TikTok"],
      ["bilibili-cn", "B站大陆"],
      ["bilibili-hk", "B站港澳台"],
    ],
  },
];

/* 品牌标识：真实矢量路径见 ./brandIcons.ts（源自 simple-icons，CC0 1.0）。
   外层是品牌色磁贴 + 白色填充；未测试时整块去饱和——颜色本身就是状态信号。 */
function BrandMark({ id }: { id: string }) {
  const d = BRAND_PATHS[id];
  if (!d) return null;
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d={d} fill="#fff" />
    </svg>
  );
}

// 首页卡片信息行：图标点缀 + 标签/值居中 + 明显描边框
function InfoRow({
  icon: Icon,
  label,
  mono,
  children,
}: {
  icon: LucideIcon;
  label: string;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="info-row">
      <span className="info-row-ico">
        <Icon size={15} />
      </span>
      <div className="info-row-main">
        <em>{label}</em>
        <b className={mono ? "mono" : ""}>{children}</b>
      </div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>("home");
  // 右栏（时钟/快捷操作/流量）默认只在首页展开；其余页面主区吃满宽度，
  // 避免连接页表格(min-width 820)与节点页分组标签被裁切。手动切换只在当前页生效。
  const [railOverride, setRailOverride] = useState<boolean | null>(null);
  const showRail = railOverride === null ? tab === "home" : railOverride;
  // 切页时回到「按页自动」策略
  useEffect(() => {
    setRailOverride(null);
  }, [tab]);
  const [pfTab, setPfTab] = useState<"sub" | "enhance" | "nodes" | "yaml">("sub");
  // 订阅页子标签首次访问后才挂载，之后保活：避免每次打开订阅页都重建 Monaco 与可视化编辑器
  const [pfSeen, setPfSeen] = useState<Record<string, boolean>>({ sub: true });
  const [running, setRunning] = useState(false);
  const [coreVersion, setCoreVersion] = useState("");
  // 首屏就绪：数据加载完成后才渲染主体，避免显示一堆"—"占位符让人困惑
  const [bootReady, setBootReady] = useState(false);
  const [coreType, setCoreType] = useState("mihomo");
  const [coreStartTime, setCoreStartTime] = useState<number | null>(null);
  const appStartTime = useRef(Date.now());
  const [ruleCount, setRuleCount] = useState<number | null>(null);
  const [sysProxy, setSysProxy] = useState(false);
  const [mode, setMode] = useState("rule");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [mixedPort, setMixedPort] = useState(17897);
  const [controller, setController] = useState("127.0.0.1:19097");
  const [version, setVersion] = useState("-");
  const [upload, setUpload] = useState(0);
  const [download, setDownload] = useState(0);
  const [coreMemMB, setCoreMemMB] = useState<number | null>(null);
  const [upRate, setUpRate] = useState(0);
  const [downRate, setDownRate] = useState(0);
  const [connections, setConnections] = useState<ConnectionItem[]>([]);
  const [connCount, setConnCount] = useState(0);
  const [groups, setGroups] = useState<ProxyNode[]>([]);
  const [proxyMap, setProxyMap] = useState<Record<string, ProxyNode>>({});
  const [selectedGroup, setSelectedGroup] = useState("PROXY");
  const [delays, setDelays] = useState<Record<string, number>>({});
  const [delayHistory, setDelayHistory] = useState<Record<string, { t: number; ms: number }[]>>(() => {
    try {
      return JSON.parse(localStorage.getItem("veyra-delay-history") || "{}");
    } catch {
      return {};
    }
  });
  const [query, setQuery] = useState("");
  const [profileText, setProfileText] = useState("");
  const [profileName, setProfileName] = useState("subscription.yaml");
  const [subUrl, setSubUrl] = useState("");
  const [profiles, setProfiles] = useState<
    {
      name: string;
      size: number;
      uid?: string;
      type?: string;
      enabled?: boolean;
      global?: boolean;
      url?: string;
    }[]
  >([]);
  const [richProfiles, setRichProfiles] = useState<ProfileRich[]>([]);
  const [subs, setSubs] = useState<
    {
      url: string;
      name: string;
      updatedAt: number;
      nextUpdateAt?: number;
      userinfo?: { upload: number; download: number; total: number; expire: number };
    }[]
  >([]);
  const [nodeSortMode, setNodeSortMode] = useState<"delay" | "name" | "default">("delay");
const [nodeDensity, setNodeDensity] = useState<"comfortable" | "compact" | "list">(
  (localStorage.getItem("veyra-node-density") as "comfortable" | "compact" | "list") || "comfortable"
);
  // 首屏只渲染前 30 个节点，挂载完成后再补全：消除首页→代理切换的卡顿
  const [pxNodeLimit, setPxNodeLimit] = useState(PX_NODE_FIRST);
  const [enhanceLog, setEnhanceLog] = useState<string[]>([]);
  const [editUid, setEditUid] = useState<string | null>(null);
  const [exitIp, setExitIp] = useState<{
    ip: string | null;
    country?: string;
    countryCode?: string;
    city?: string;
    region?: string;
    isp?: string;
    org?: string;
    as?: string;
    timezone?: string;
    lat?: number;
    lon?: number;
  } | null>(null);
  const [exitIpLoading, setExitIpLoading] = useState(false);

  // 右栏「解锁状态」：只放 AI + 主流流媒体的代表项（全量 12 项在测试页）。
  // runUnlockChecks 是串行外网探测，耗时可达数十秒，故仅手动触发，不随 tab 自动跑。
  const [unlockMap, setUnlockMap] = useState<
    Record<string, { ok: boolean; fail?: boolean; region?: string | null; note: string; testedAt?: number }>
  >({});
  const [unlockBusy, setUnlockBusy] = useState<string | null>(null);
  const [nodeUri, setNodeUri] = useState("");
  const [providers, setProviders] = useState<{ proxies: string[]; rules: string[] }>({
    proxies: [],
    rules: [],
  });
  const [editorMode, setEditorMode] = useState<"profile" | "runtime">("profile");
  const [bindTarget, setBindTarget] = useState<string | null>(null);
  // 首页6卡片可见性
  const [homeCards, setHomeCards] = useState({
    subscription: true,
    node: true,
    network: true,
    mode: true,
    traffic: true,
    ip: true,
    core: true,
    system: true,
    webtest: true,
  });
  const [testing, setTesting] = useState(false);
  const [testProgress, setTestProgress] = useState(0);
  const [autoPick, setAutoPick] = useState(true);
  const [subAutoUpdateMin, setSubAutoUpdateMin] = useState(0);
  const [themeMode, setThemeMode] = useState<ThemeMode>("light");
  const [activeCore, setActiveCore] = useState("mihomo");
  const [lastTestAt, setLastTestAt] = useState(0);
  const [testingNode, setTestingNode] = useState<string | null>(null);
  const [rateHistory, setRateHistory] = useState<{ up: number[]; down: number[] }>({
    up: [],
    down: [],
  });
  // 内存显示文本：抽出来避免 JSX 表达式内嵌模板字面量导致解析歧义。
  const memText = typeof coreMemMB === "number" ? coreMemMB + " MB" : "—";
  // 「有真实流量」守卫：零流量时平线与贴底直线在视觉上都等同于「图表故障」。
  // 此前名 railHasTraffic 且只在侧栏版本使用，侧栏改版后成了死变量——
  // 首页流量图因此漏掉守卫，零流量画出贴底绿线。现统一由它兜底。
  const hasTraffic =
    rateHistory.down.some((v) => v > 0) || rateHistory.up.some((v) => v > 0);
  const [banner, setBanner] = useState("");
  const [isMaximized, setIsMaximized] = useState(false);
  const [homeCfgOpen, setHomeCfgOpen] = useState(false);
  const [homeCfgDraft, setHomeCfgDraft] = useState(homeCards);
  // 危险操作（清理日志等）统一走二次确认弹窗
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);
  // 首页系统信息卡的真实数据（此前版本硬编码「未启用 / v1.1 / Windows 10/11」）
  const [appVersion, setAppVersion] = useState("");
  const [platformLabel, setPlatformLabel] = useState("Windows");
  const [startWithWindows, setStartWithWindows] = useState(false);
  const [mihomoChannel, setMihomoChannel] = useState("stable");

  // 首页设置弹窗：关闭时统一走 closeHomeCfg，保证焦点一定回到入口按钮
  const homeCfgTriggerRef = useRef<HTMLButtonElement | null>(null);
  // 焦点圈闭：Tab 不再逃到遮罩后的背景页面（Esc/关闭逻辑见下方 effect）
  const homeCfgBoxRef = useFocusTrap<HTMLDivElement>(homeCfgOpen);
  const closeHomeCfg = useCallback(() => {
    setHomeCfgOpen(false);
    // 关闭后焦点回到入口按钮；延迟一帧，等遮罩真正卸载再 focus
    window.requestAnimationFrame(() => homeCfgTriggerRef.current?.focus());
  }, []);

  const toastTimer = useRef<number | null>(null);
  const lastSeqRef = useRef(0);
  const trafficRef = useRef<{ up: number; down: number; t: number } | null>(null);
  // 速率显示平滑：轮询间隔抖动会让差值速率忽大忽小，用 EMA 压平
  const upRateRef = useRef(0);
  const downRateRef = useRef(0);
  const selectedGroupRef = useRef(selectedGroup);
  const testingRef = useRef(false);
  const delaysRef = useRef(delays);
  const autoPickRef = useRef(autoPick);
  const groupsRef = useRef(groups);
  // 测速中断器：切 tab / 停止内核 / 关闭应用时中止正在进行的测速
  const testAbortRef = useRef<AbortController | null>(null);
  const tabRef = useRef<Tab>(tab);
  // applyStatus 是稳定引用（空依赖），不能直接读 state 里的 running ——
  // 那样闭包会永远捕获初始值 false，把每次状态推送都当成「刚启动」，运行时间被反复清零。
  const runningStateRef = useRef(false);
  const logBufRef = useRef<string[]>([]);
  // 性能：显示值未变化就跳过 setState，避免 1.5s 轮询每次都全应用重渲染（切 tab 卡顿主因）
  const lastUpStrRef = useRef("");
  const lastDownStrRef = useRef("");
  const lastUpTotalRef = useRef("");
  const lastDownTotalRef = useRef("");
  const lastMemRef = useRef<number | null>(null);
  const proxiesFpRef = useRef("");
  const connsFpRef = useRef("");
  selectedGroupRef.current = selectedGroup;
  delaysRef.current = delays;
  autoPickRef.current = autoPick;
  groupsRef.current = groups;
  tabRef.current = tab;

  // 首屏就绪：核心数据到达后渲染主体；或兜底 1.6s 后也要显示主体，避免永远白屏
  useEffect(() => {
    if (groups.length > 0 || coreVersion || version !== "-") {
      const t = window.setTimeout(() => setBootReady(true), 150);
      return () => window.clearTimeout(t);
    }
  }, [groups.length, coreVersion, version]);

  // 弹窗：打开时把焦点移入弹窗；Esc 或按钮关闭后统一把焦点还给入口按钮，
  // 避免焦点掉回 body（键盘用户会「丢失位置」）
  useEffect(() => {
    if (!homeCfgOpen) return;
    homeCfgBoxRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeHomeCfg();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [homeCfgOpen]);

  // 窗口最大化状态：标题栏「最大化/还原」按钮的图标切换
  useEffect(() => {
    if (!window.veyra) return;
    let alive = true;
    void window.veyra
      .isMaximized?.()
      .then((v) => {
        if (alive) setIsMaximized(!!v);
      })
      .catch(() => {});
    const off = window.veyra.onMaximizedChange?.((v) => setIsMaximized(!!v));
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => setBootReady(true), 1600);
    return () => window.clearTimeout(t);
  }, []);

  const showToast = useCallback((msg: string, ms = 2400) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), ms);
  }, []);

  const applyStatus = useCallback(
    (data: { running?: boolean; seq?: number; version?: { version?: string } }) => {
      if (typeof data.seq === "number") {
        if (data.seq < lastSeqRef.current) return;
        lastSeqRef.current = data.seq;
      }
      const r = !!data.running;
      const wasRunning = runningStateRef.current;
      runningStateRef.current = r;
      setRunning(r);
      if (r && !wasRunning) {
        // 内核刚启动，记录启动时间
        setCoreStartTime(Date.now());
      }
      if (!r) {
        setCoreStartTime(null);
        setRuleCount(null);
      }
      if (data.version && typeof data.version === "object" && "version" in data.version) {
        setVersion(String(data.version.version));
      }
      if (!r) {
        window.veyra
          ?.systemProxyStatus()
          .then((s) => setSysProxy(!!s.enabled))
          .catch(() => {});
      }
    },
    []
  );

  const refresh = useCallback(async () => {
    if (!window.veyra) return;
    try {
      const st = await window.veyra.coreStatus();
      applyStatus(st as { running?: boolean; seq?: number; version?: { version?: string } });
      // heavy：首页/代理页需要连接列表与流量历史；另外「首次还没拿到代理组」时也必须拉一次，
      // 否则用户启动后直接切到别的标签页，节点数据永远为空、启动自动测速也就永远不会触发
      const heavy =
        tabRef.current === "home" || tabRef.current === "proxies" || groupsRef.current.length === 0;
      if (!st.running) {
        upRateRef.current = 0;
        downRateRef.current = 0;
        setUpRate(0);
        setDownRate(0);
        setCoreMemMB(null);
        // 与运行分支保持一致：未运行时也持续喂 0，侧栏曲线才会平滑回落到基线而不是断档
        setRateHistory((h) => ({
          up: [...h.up, 0].slice(-48),
          down: [...h.down, 0].slice(-48),
        }));
        if (heavy) {
          setConnections([]);
          setConnCount(0);
        }
        return;
      }
      const ov = await window.veyra.overview();
      if (ov.mixedPort) setMixedPort(ov.mixedPort);
      if (ov.controller) setController(ov.controller);
      setMode(ov.configs?.mode || "rule");

      const up = ov.connections?.uploadTotal || 0;
      const down = ov.connections?.downloadTotal || 0;
      const now = Date.now();
      const prev = trafficRef.current;
      let ur: number | null = null;
      let dr: number | null = null;
      if (prev && now > prev.t) {
        const dt = (now - prev.t) / 1000;
        // 间隔过短时差值不可靠，跳过本次并保留旧基线，避免速率尖峰
        if (dt >= 0.3) {
          ur = Math.max(0, (up - prev.up) / dt);
          dr = Math.max(0, (down - prev.down) / dt);
        }
      }
      if (ur !== null && dr !== null) {
        // EMA：单次采样抖动只部分影响显示，不再一会大一会小
        upRateRef.current = upRateRef.current * 0.6 + ur * 0.4;
        downRateRef.current = downRateRef.current * 0.6 + dr * 0.4;
        trafficRef.current = { up, down, t: now };
      }
      // 显示字符串没变就不 setState：空闲时完全跳过重渲染
      const upStr = formatRate(upRateRef.current);
      if (upStr !== lastUpStrRef.current) {
        lastUpStrRef.current = upStr;
        setUpRate(upRateRef.current);
      }
      const downStr = formatRate(downRateRef.current);
      if (downStr !== lastDownStrRef.current) {
        lastDownStrRef.current = downStr;
        setDownRate(downRateRef.current);
      }
      const upTotal = formatBytes(up);
      if (upTotal !== lastUpTotalRef.current) {
        lastUpTotalRef.current = upTotal;
        setUpload(up);
      }
      const downTotal = formatBytes(down);
      if (downTotal !== lastDownTotalRef.current) {
        lastDownTotalRef.current = downTotal;
        setDownload(down);
      }
      const mem = typeof ov.coreMemoryMB === "number" ? Math.round(ov.coreMemoryMB) : null;
      if (mem !== lastMemRef.current) {
        lastMemRef.current = mem;
        setCoreMemMB(mem);
      }

      // 流量历史：首页波形图与侧栏迷你曲线都要用，故不受 heavy 限制（heavy 只在首页/代理页为真）。
      // 每 1.5s 一次 48 元素数组拷贝，开销可忽略；换来侧栏在任何标签页下曲线都连续。
      setRateHistory((h) => ({
        up: [...h.up, upRateRef.current].slice(-48),
        down: [...h.down, downRateRef.current].slice(-48),
      }));

      if (heavy) {
        const conns = ov.connections?.connections || [];
        const totalCount = typeof ov.connectionsCount === "number" ? ov.connectionsCount : conns.length;
        // 连接列表：空闲（总数与累计流量不变）时跳过，活跃时才刷新
        const cfp = `${totalCount}:${up}:${down}`;
        if (cfp !== connsFpRef.current) {
          connsFpRef.current = cfp;
          setConnections(conns);
          setConnCount(totalCount);
        }
        const px = ov.proxies?.proxies || {};
        const g = Object.values(px).filter((p) => GROUP_TYPES.has(p.type || ""));
        // 节点/分组数据没变（名称与当前选中节点一致）就跳过，proxies 页不再每 1.5s 全量重渲染
        const pfp = `${g.length}|${g.map((x) => `${x.name}:${x.now || ""}`).join(",")}`;
        if (pfp !== proxiesFpRef.current) {
          proxiesFpRef.current = pfp;
          setProxyMap(px);
          setGroups(g);
        }
        if (g.length && !g.find((x) => x.name === selectedGroupRef.current)) {
          setSelectedGroup(g[0].name || "");
        }
      }
      setBanner("");

      window.veyra
        .systemProxyStatus()
        .then((s) => setSysProxy(!!s.enabled))
        .catch(() => {});
    } catch {
      /* transient */
    }
  }, []);

  const goTab = useCallback(
    (id: Tab) => {
      // 切掉代理页时中止正在进行的测速，避免后台继续发请求浪费资源
      if (id !== "proxies" && testAbortRef.current) {
        testAbortRef.current.abort();
        testAbortRef.current = null;
      }
      if (id === "logs" && logBufRef.current.length) {
        const buf = logBufRef.current;
        logBufRef.current = [];
        setLogs((prev) => [...prev, ...buf].slice(-400));
      }
      startTransition(() => setTab(id));
      if (id === "proxies") {
        // 先渲染首批节点让页面立即出现，剩余节点由分批 effect 逐帧补齐，避免单次长任务
        setPxNodeLimit(PX_NODE_FIRST);
      }
      if (id === "home" || id === "proxies") {
        // 首帧绘制后再拉数据，避免与页面挂载争抢主线程
        window.setTimeout(() => {
          void refresh();
        }, 60);
      }
      if (id === "home") {
        // 设置页可能刚改过开机自启/内核通道；切回首页时同步一次，避免显示旧值
        window.veyra
          ?.getSettings()
          .then((s) => {
            setStartWithWindows(!!s.startWithWindows);
            setMihomoChannel(s.mihomoChannel === "alpha" ? "alpha" : "stable");
          })
          .catch(() => {});
      }
    },
    [refresh]
  );

  useEffect(() => {
    if (!window.veyra) return;
    // 启动时检测其他代理软件冲突（完整扫描：含系统代理/DNS）
    window.veyra
      .fullConflictScan?.()
      .then((res) => {
        if (res?.conflicts?.length) {
          setBanner(
            `检测到其他代理软件可能正在运行：${res.conflicts.map((c) => c.label).join("、")}。建议一次只运行一个代理软件，避免端口冲突。`
          );
        }
      })
      .catch(() => {});
    // 订阅运行时冲突事件：其他代理软件在 Veyra-omini 运行期间启动
    let conflictToastTimer: ReturnType<typeof setTimeout> | null = null;
    const offConflict = window.veyra.onConflictDetected?.(({ items }) => {
      if (conflictToastTimer) return; // 节流避免重复通知
      setBanner(
        `⚠ 检测到其他代理软件启动：${items.join("、")}。可能与 Veyra-omini 冲突，建议关闭其中一个。`
      );
      conflictToastTimer = setTimeout(() => { conflictToastTimer = null; }, 12000);
    });
    const offResolved = window.veyra.onConflictResolved?.(() => {
      setBanner((prev) => (prev.includes("检测到其他代理软件启动") ? "" : prev));
    });
    const off1 = window.veyra.onCoreStatus((d) => {
      applyStatus(d as { running?: boolean; seq?: number; version?: { version?: string } });
    });
    const off2 = window.veyra.onCoreLog((line) => {
      if (tabRef.current === "logs") {
        setLogs((prev) => [...prev.slice(-400), line]);
      } else {
        logBufRef.current.push(line);
        if (logBufRef.current.length > 400) {
          logBufRef.current = logBufRef.current.slice(-400);
        }
      }
    });
    const off3 = window.veyra.onCoreError((msg) => {
      setBanner(msg);
      showToast(msg);
    });
    const off4 = window.veyra.onSystemProxyChanged?.((d) => {
      setSysProxy(!!(d as { enabled?: boolean }).enabled);
    });
    const off5 = window.veyra.onCoreProgress?.((d: { phase: string; pct: number; label: string }) => {
      if (d.pct >= 100) {
        setBanner("");
        showToast(d.label, 2000);
      } else {
        setBanner(`${d.label} (${d.pct}%)`);
      }
    });

    refresh();
    window.veyra
      .readActiveProfile()
      .then(setProfileText)
      .catch(() => {});
    const reloadProfiles = () => {
      window.veyra
        ?.listProfiles()
        .then(setProfiles)
        .catch(() => {});
      window.veyra
        ?.listProfilesRich?.()
        .then(setRichProfiles)
        .catch(() => {});
      window.veyra
        ?.listSubscriptions?.()
        .then(setSubs)
        .catch(() => {});
    };
    reloadProfiles();
    window.veyra
      .systemProxyStatus()
      .then((s) => setSysProxy(!!s.enabled))
      .catch(() => {});
    window.veyra
      .ports()
      .then((p) => {
        setMixedPort(p.mixedPort);
        setController(p.controller);
      })
      .catch(() => {});
    window.veyra
      .appInfo?.()
      .then((a) => {
        setAppVersion(a?.version || "");
        const osName = a?.platform === "win32" ? "Windows" : a?.platform === "darwin" ? "macOS" : "Linux";
        setPlatformLabel(`${osName} · ${a?.arch || ""}`.trim());
      })
      .catch(() => {});
    window.veyra
      .getSettings()
      .then((s) => {
        setAutoPick(!!s.autoPick);
        setSubAutoUpdateMin(Math.max(0, s.subAutoUpdateMin || 0));
        setActiveCore(s.core === "singbox" ? "singbox" : "mihomo");
        setStartWithWindows(!!s.startWithWindows);
        setMihomoChannel(s.mihomoChannel === "alpha" ? "alpha" : "stable");
        if (s.homeCards && typeof s.homeCards === "object") {
          setHomeCards((prev) => ({ ...prev, ...s.homeCards }));
        }
        const m = (s.theme as ThemeMode) || "system";
        setThemeMode(m);
        applyTheme(m);
        if (s.locale) setLocale(s.locale);
        if (s.nodeSort === "name" || s.nodeSort === "default" || s.nodeSort === "delay") {
          setNodeSortMode(s.nodeSort);
        }
        if (s.customCss || s.themeColor) {
          let el = document.getElementById("veyra-custom-css") as HTMLStyleElement | null;
          if (!el) {
            el = document.createElement("style");
            el.id = "veyra-custom-css";
            document.head.appendChild(el);
          }
          el.textContent =
            (s.themeColor ? `:root{--accent:${s.themeColor};}` : "") + "\n" + (s.customCss || "");
        }
      })
      .catch(() => {
        applyTheme("system");
      });

    const t = window.setInterval(refresh, 1500);
    const onFocus = () => refresh();
    const onVis = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      off1();
      off2();
      off3();
      off4?.();
      off5?.();
      offConflict?.();
      offResolved?.();
      if (conflictToastTimer) window.clearTimeout(conflictToastTimer);
      window.clearInterval(t);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
  }, [refresh, showToast, applyStatus]);

  // 记录已访问过的订阅子标签，使其挂载后保活（切换子标签不再重建编辑器）
  useEffect(() => {
    setPfSeen((seen) => (seen[pfTab] ? seen : { ...seen, [pfTab]: true }));
  }, [pfTab]);

  const currentGroup = useMemo(() => groups.find((g) => g.name === selectedGroup), [groups, selectedGroup]);

  // 组内可选节点（过滤掉机场信息节点）；代理页列表与首页"节点"下拉共用同一份数据
  const groupNodes = useMemo(() => (currentGroup?.all || []).filter((n) => !isInfoNode(n)), [currentGroup]);

  const nodes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groupNodes;
    return groupNodes.filter((n) => n.toLowerCase().includes(q));
  }, [groupNodes, query]);

  const sortedNodes = useMemo(() => {
    if (nodeSortMode === "name") return [...nodes].sort((a, b) => a.localeCompare(b, "zh"));
    if (nodeSortMode === "default") return nodes;
    return sortNodesByDelay(nodes, delays);
  }, [nodes, delays, nodeSortMode]);

  const bestNode = useMemo(() => {
    let best: { name: string; delay: number } | null = null;
    for (const n of nodes) {
      if (!isTestableNode(n)) continue;
      const d = delays[n];
      if (typeof d === "number" && d > 0 && (!best || d < best.delay)) best = { name: n, delay: d };
    }
    return best;
  }, [nodes, delays]);

  const recentConn = useMemo(() => connections.slice(0, 12), [connections]);

  // 代理页节点分批补齐：每帧只新增一批，避免上百张卡片挤在一次提交里造成长任务卡顿
  useEffect(() => {
    if (tab !== "proxies" || pxNodeLimit >= sortedNodes.length) return;
    let raf = 0;
    const timer = window.setTimeout(() => {
      raf = window.requestAnimationFrame(() => {
        setPxNodeLimit((n) => Math.min(sortedNodes.length, n + PX_NODE_BATCH));
      });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(raf);
    };
  }, [tab, pxNodeLimit, sortedNodes.length]);

  // 切换代理组或筛选条件时回到首批，保证切组立即响应
  useEffect(() => {
    setPxNodeLimit(PX_NODE_FIRST);
  }, [selectedGroup, query, nodeSortMode]);

  const currentNode = useMemo(() => {
    const g = groups.find((x) => x.name === selectedGroup) || groups[0];
    return g?.now || "—";
  }, [groups, selectedGroup]);

  // 当前节点的协议类型 / UDP / 延迟：当前节点卡片展示用
  const currentNodeInfo = useMemo(() => {
    if (!currentNode || currentNode === "—") {
      return { type: "", udp: false, delay: undefined as number | undefined };
    }
    const info = proxyMap[currentNode];
    return { type: info?.type || "", udp: !!info?.udp, delay: delays[currentNode] };
  }, [proxyMap, delays, currentNode]);

  const hasSubscription = groups.length > 0 || profiles.length > 0 || subs.length > 0;
  const totalTraffic = upload + download;
  const statusKey = !running ? "off" : running && sysProxy ? "on" : "idle";
  const statusLabel = !running ? t("home.statusOff", "Stopped") : running && sysProxy ? t("home.statusOn", "Proxy active") : t("home.statusIdle", "Core running");

  const runSpeedTest = useCallback(
    async (opts?: { silent?: boolean; pickBest?: boolean; only?: string[] }) => {
      if (!window.veyra || testingRef.current) return;
      const groupName = selectedGroupRef.current;
      const group = groupsRef.current.find((g) => g.name === groupName);
      const all = group?.all || [];
      // only 用于「快检」：只测指定节点（通常只有当前节点），不必每次全量扫 80 个
      const batch = opts?.only?.length
        ? opts.only.filter(isTestableNode)
        : all.filter(isTestableNode).slice(0, 80);
      const silent = !!opts?.silent;
      // 非静默时必须给出反馈：否则用户点了「一键测速」/自动触发却毫无动静，不知道到底测没测
      if (!batch.length) {
        if (!silent) showToast("暂无可测速节点：请先导入订阅或等待节点加载完成");
        return;
      }

      // 创建新的中断器，中止上一次未完成的测速（如有）
      if (testAbortRef.current) testAbortRef.current.abort();
      const ac = new AbortController();
      testAbortRef.current = ac;
      const isAborted = () => ac.signal.aborted;

      testingRef.current = true;
      // 静默模式不进入「测速中」状态：界面不再常驻转圈，用户只会看到延迟数字悄悄更新
      if (!silent) {
        setTesting(true);
        setTestProgress(0);
        showToast(`开始测速 · 共 ${batch.length} 个节点…`, 2600);
      }

      const next = { ...delaysRef.current };
      let done = 0;
      await mapPool(batch, 8, async (n) => {
        if (isAborted()) return;
        if (!silent) setTestingNode(n);
        try {
          const r = await window.veyra!.testDelay(n);
          if (isAborted()) return;
          const d = r.data?.delay;
          next[n] = typeof d === "number" ? d : 0;
        } catch {
          next[n] = 0;
        }
        done += 1;
        // 静默时不做逐节点 setState：一次全量测速最多 80 次提交会持续占住主线程
        if (!silent && !isAborted()) {
          setTestProgress(Math.round((done / batch.length) * 100));
          setDelays({ ...next });
        }
      });

      if (isAborted()) {
        testingRef.current = false;
        return;
      }

      delaysRef.current = next;
      setDelays(next);
      // 记录延迟历史（每个节点保留最近20次）
      setDelayHistory((prev) => {
        const updated = { ...prev };
        const now = Date.now();
        for (const [name, ms] of Object.entries(next)) {
          if (typeof ms === "number" && ms > 0) {
            const arr = [...(updated[name] || []), { t: now, ms }];
            updated[name] = arr.slice(-20);
          }
        }
        try {
          localStorage.setItem("veyra-delay-history", JSON.stringify(updated));
        } catch {
          /* localStorage 不可用（隐私模式/配额满）时忽略：延迟历史只是锦上添花 */
        }
        return updated;
      });
      setTestingNode(null);
      setTesting(false);
      testingRef.current = false;
      setLastTestAt(Date.now());
      setTestProgress(100);

      const pick = opts?.pickBest ?? autoPickRef.current;
      if (pick && window.veyra && group) {
        let winner: string | null = null;
        let best = Infinity;
        for (const n of batch) {
          const d = next[n];
          if (typeof d === "number" && d > 0 && d < best) {
            best = d;
            winner = n;
          }
        }
        // 迟滞：候选需「快 15% 以上」或「快 40ms 以上」才切换。
        // 放宽到这两个条件是为了让更优节点真的能被切过去；
        // 同时仍能挡住 70ms vs 74ms 这种无意义的来回跳。
        const curName = group.now || "";
        const curRaw = next[curName];
        const curDelay = typeof curRaw === "number" ? curRaw : 0;
        const worthSwitching = curDelay > 0 ? best <= curDelay * 0.85 || curDelay - best >= 40 : true;
        if (winner && curName !== winner && worthSwitching) {
          try {
            await window.veyra.selectProxy(group.name || "", winner);
            // 静默模式（自动保持最优）不弹提示，否则每隔几分钟就冒一个 toast
            if (!silent) showToast(`测速完成 · 已切换到最低延迟 ${winner}（${best} ms）`, 4200);
            await refresh();
          } catch {
            if (!silent) showToast("测速完成，但自动切换节点失败", 4200);
          }
        } else if (winner && !silent) {
          const curD = typeof curRaw === "number" && curRaw > 0 ? curRaw : 0;
          showToast(
            curName === winner
              ? `测速完成 · 当前节点 ${winner} 已是最优（${best} ms）`
              : `测速完成 · 保持 ${curName || "当前节点"}${curD ? `（${curD} ms）` : ""}，最优 ${winner}（${best} ms）`,
            4200
          );
        } else if (!silent) {
          showToast("测速完成 · 没有可用的低延迟节点", 4200);
        }
      } else if (!silent) {
        showToast(`测速完成 · 已更新 ${batch.length} 个节点延迟`, 4200);
      }
    },
    [refresh, showToast]
  );

  // 测速现在是纯手动行为，三处触发点都在用户操作路径上：
  //   「一键测速」按钮、单个节点卡片点击、设置页「测试全部」。
  // 已移除的自动触发逻辑：
  //   1) 打开软件 / 内核启动时的全量测速 effect
  //   2) 后台 20s 快检 + 定时全量复测 + 静默切节点 的定时器
  // 同时删除了配套设置项 autoTest / autoTestIntervalSec（设置面板与代理页工具栏入口一并下线）。
  // autoPick（「选用最低」）保留：它只在用户手动测速完成后决定是否切到最低延迟节点，
  // 自身不会发起任何测速请求，与"自动测速"无关。

  useEffect(() => {
    if (themeMode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [themeMode]);

  const changeTheme = useCallback(async (m: ThemeMode) => {
    setThemeMode(m);
    applyTheme(m);
    await window.veyra?.setSettings({ theme: m });
  }, []);

  // 传给 SettingsPanel 的回调保持稳定引用，否则 memo 失效
  const handlePorts = useCallback((m: number, c: string) => {
    setMixedPort(m);
    setController(c);
  }, []);

  const handlePrefs = useCallback(
    (p: {
      autoPick?: boolean;
      subAutoUpdateMin?: number;
    }) => {
      if (p.autoPick != null) setAutoPick(p.autoPick);
      if (p.subAutoUpdateMin != null) {
        setSubAutoUpdateMin(Math.max(0, p.subAutoUpdateMin));
      }
    },
    []
  );

  // 出口 IP 检测的唯一入口：首屏自动调用一次，右栏卡片刷新按钮也复用它。
  // 加 loading 守卫避免并发重复请求（快速点刷新时）。
  const refreshExitIp = useCallback(async () => {
    const api = window.veyra?.exitIp;
    if (!api) return;
    setExitIpLoading((busy) => {
      if (busy) return busy;
      return true;
    });
    try {
      const r = await api();
      setExitIp(r || { ip: null });
      if (!r?.ip) showToast("IP 检测失败，请点击重试");
    } catch {
      setExitIp({ ip: null });
      showToast("IP 检测失败，请点击重试");
    } finally {
      setExitIpLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    if (!running) return;
    // 服务启动时自动检测出口 IP（真实检测）
    void refreshExitIp();
  }, [running, refreshExitIp]);

  // 右栏解锁状态：全量测试（串行，耗时长）。切换内核后结果即失效，由调用方决定何时重跑。
  const testAllUnlock = useCallback(async () => {
    const api = window.veyra?.streamingUnlock;
    if (!api) {
      showToast("解锁检测接口不可用");
      return;
    }
    setUnlockBusy("__all__");
    try {
      const list = (await api()) || [];
      const next: typeof unlockMap = {};
      for (const it of list) {
        next[it.id] = {
          ok: !!it.ok,
          fail: !!it.fail,
          region: it.region ?? null,
          note: it.note || "",
          testedAt: it.testedAt,
        };
      }
      setUnlockMap(next);
      const okCount = list.filter((x) => x.ok).length;
      showToast(`解锁检测完成：${okCount}/${list.length} 可用`);
    } catch (e) {
      showToast(`解锁检测失败：${(e as Error).message || e}`);
    } finally {
      setUnlockBusy(null);
    }
  }, [showToast]);

  // 单项重测：在右栏点某一项时不跑全量，避免动辄几十秒的等待
  const testOneUnlock = useCallback(
    async (id: string) => {
      const api = window.veyra?.streamingUnlockOne;
      if (!api) {
        showToast("解锁检测接口不可用");
        return;
      }
      setUnlockBusy(id);
      try {
        const r = await api(id);
        setUnlockMap((prev) => ({
          ...prev,
          [id]: {
            ok: !!r.ok,
            fail: !!r.fail,
            region: r.region ?? null,
            note: r.note || "",
            testedAt: r.testedAt,
          },
        }));
      } catch (e) {
        setUnlockMap((prev) => ({
          ...prev,
          [id]: {
            ok: false,
            fail: true,
            region: null,
            note: String((e as Error).message || e),
            testedAt: Date.now(),
          },
        }));
      } finally {
        setUnlockBusy(null);
      }
    },
    [showToast]
  );

  useEffect(() => {
    if (!window.veyra) return;
    // 参考 clash-verge-rev：常驻定时检查，只更新到达 nextUpdateAt 的订阅
    // （nextUpdateAt 优先取机场 profile-update-interval 头，其次取设置里的间隔）
    const tick = async () => {
      try {
        const list = (await window.veyra!.listSubscriptions()) as typeof subs;
        const due = list.filter((s) => !!s.nextUpdateAt && Date.now() >= s.nextUpdateAt);
        if (!due.length) return;
        let ok = 0;
        for (const s of due) {
          try {
            await window.veyra!.importProfileUrl({ url: s.url, name: s.name });
            ok += 1;
          } catch (e) {
            showToast(`订阅自动更新失败：${(e as Error).message || e}`, 5000);
          }
        }
        if (ok) showToast(`订阅已自动更新（${ok}/${due.length}），流量信息已同步`, 5000);
        await reloadProfileLists();
        refresh();
      } catch (e) {
        showToast(`订阅自动更新失败：${(e as Error).message || e}`);
      }
    };
    const timer = window.setInterval(tick, 10 * 60_000);
    return () => window.clearInterval(timer);
  }, [refresh, showToast]);

  // 侧栏电源按钮 = 系统代理开关；内核由软件托管常驻，不在按钮里启停
  async function toggleSysProxy() {
    if (!window.veyra) return;
    if (!running) return showToast("内核未运行，无法开启系统代理");
    setBusy(true);
    try {
      const next = !sysProxy;
      const r = await window.veyra.setSystemProxy(next);
      if (r.ok) {
        setSysProxy(!!r.enabled);
        showToast(next ? `系统代理 → 127.0.0.1:${mixedPort}` : "系统代理已关闭", 3200);
      } else {
        showToast("系统代理设置失败");
      }
    } catch (e) {
      showToast(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }

  async function changeMode(m: string) {
    if (!window.veyra || !running) return;
    await window.veyra.setMode(m);
    setMode(m);
    showToast(`模式：${MODE_LABEL[m] || m}`);
  }

  async function selectNode(name: string) {
    if (!window.veyra || !currentGroup) return;
    await window.veyra.selectProxy(currentGroup.name || "", name);
    showToast(`已切换 → ${name}`);
    refresh();
  }

  async function testAll() {
    await runSpeedTest({ silent: false, pickBest: autoPick });
  }

  async function reloadProfileLists() {
    if (!window.veyra) return;
    setProfiles(await window.veyra.listProfiles());
    setRichProfiles((await window.veyra.listProfilesRich?.()) || []);
    setSubs(await window.veyra.listSubscriptions());
  }

  async function updateSubscriptions() {
    if (!window.veyra || !subs.length) return;
    setBusy(true);
    try {
      let ok = 0;
      for (const s of subs) {
        try {
          await window.veyra.importProfileUrl({ url: s.url, name: s.name });
          ok += 1;
        } catch (e) {
          showToast(`订阅更新失败：${(e as Error).message || e}`, 5000);
        }
      }
      await reloadProfileLists();
      refresh();
      if (ok) showToast(`订阅已更新（${ok}/${subs.length}），流量信息已同步`, 5000);
    } finally {
      setBusy(false);
    }
  }

  async function saveProfile() {
    if (!window.veyra) return;
    if (!profileText.trim()) return showToast("配置内容为空");
    setBusy(true);
    try {
      if (editUid && window.veyra.writeProfile) {
        await window.veyra.writeProfile(editUid, profileText);
        const r = await window.veyra.enhanceApply?.();
        const lines = [...(r?.warnings || []), ...(r?.scriptLogs || [])];
        setEnhanceLog(lines);
        showToast("已保存并重新增强");
      } else {
        const r = await window.veyra.importProfile({ name: profileName, content: profileText });
        if (r.mixedPort) setMixedPort(r.mixedPort);
        if (r.controller) setController(r.controller);
        setEnhanceLog(r.warnings || []);
        showToast("订阅已导入并增强");
      }
      await reloadProfileLists();
      setProfileText(await window.veyra.readActiveProfile());
      setEditUid(null);
      await refresh();
    } catch (e) {
      showToast(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }

  async function importFromUrl(url = subUrl) {
    if (!window.veyra) return;
    const u = url.trim();
    if (!u) return showToast("请粘贴订阅链接");
    setBusy(true);
    try {
      const r = await window.veyra.importProfileUrl({ url: u, name: profileName });
      if (r.mixedPort) setMixedPort(r.mixedPort);
      if (r.controller) setController(r.controller);
      setProfileText(await window.veyra.readActiveProfile());
      await reloadProfileLists();
      setSubUrl(u);
      setEditUid(null);
      setEnhanceLog(r.warnings || []);
      showToast(`链接导入成功（${r.bytes || 0} 字节）`);
      await refresh();
    } catch (e) {
      showToast(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }

  async function createEnhance(kind: EnhanceKind, global = false) {
    if (!window.veyra?.createEnhanceProfile) return;
    setBusy(true);
    try {
      const name = global ? `global-${kind}` : kind;
      const item = await window.veyra.createEnhanceProfile(kind, name, global);
      await reloadProfileLists();
      if (item?.uid && window.veyra.readProfile) {
        setEditUid(item.uid);
        setProfileName(item.name);
        setProfileText(await window.veyra.readProfile(item.uid));
        setEditorMode("profile");
        setPfTab("yaml");
      }
      showToast(`已创建 ${kind}${global ? "（全局）" : ""}`);
    } catch (e) {
      showToast(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }

  async function reloadProviders() {
    try {
      const p = await window.veyra?.listProviders?.();
      setProviders({
        proxies: Object.keys(p?.proxies || {}),
        rules: Object.keys(p?.rules || {}),
      });
    } catch {
      setProviders({ proxies: [], rules: [] });
    }
  }

  async function applyEnhance() {
    if (!window.veyra?.enhanceApply) return;
    setBusy(true);
    try {
      const r = await window.veyra.enhanceApply();
      const lines = [...(r.warnings || []), ...(r.scriptLogs || [])];
      setEnhanceLog(lines);
      setProfileText(await window.veyra.readActiveProfile());
      showToast(lines.length ? `增强完成（${lines.length} 条提示）` : "增强已应用");
      await refresh();
    } catch (e) {
      showToast(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }

  const navItems = [
    ["home", NavHomeIcon, t("nav.home", "首页"), null],
    [
      "proxies",
      NavProxiesIcon,
      t("nav.proxies", "代理"),
      nodes.length || groups.reduce((a, g) => a + (g.all?.length || 0), 0) || null,
    ],
    ["profiles", NavProfilesIcon, t("nav.profiles", "订阅"), subs.length + profiles.length || null],
    ["connections", NavConnectionsIcon, t("nav.connections", "连接"), connCount || null],
    ["rules", NavRulesIcon, t("nav.rules", "规则"), null],
    ["logs", NavLogsIcon, t("nav.logs", "日志"), null],
    ["tests", NavTestsIcon, t("nav.tests", "测试"), null],
    ["settings", NavSettingsIcon, t("nav.settings", "设置"), null],
  ] as const;

  // Before anything renders — show splash while booting
  if (!bootReady) {
    return (
      <div className="app boot-splash">
        <div className="container">
          <header className="header">
            <div className="logo">Veyra-omini</div>
          </header>
          <div className="boot-skeleton">
            <div className="sk sk-bar w30" />
            <div className="sk sk-bar w60" />
            <div className="sk-grid">
              <div className="sk sk-card" />
              <div className="sk sk-card" />
              <div className="sk sk-card" />
              <div className="sk sk-card" />
              <div className="sk sk-card" />
              <div className="sk sk-card" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`app ${busy ? "busy" : ""} ${running ? "is-on" : ""} ${sysProxy ? "proxy-on" : ""}`}>
      <div className="container">
        {/* Header */}
        <header className="header">
          <div className="header-brand">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              width="32"
              height="32"
              style={{ color: "var(--cyan-500)" }}
            >
              <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2" />
              <line x1="12" y1="22" x2="12" y2="15.5" />
              <polyline points="22 8.5 12 15.5 2 8.5" />
              <polyline points="2 15.5 12 8.5 22 15.5" />
              <line x1="12" y1="2" x2="12" y2="8.5" />
            </svg>
            <span className="brand-text">Veyra-omini</span>
            {/* 用真实应用版本；之前硬编码 v1.1.2，升级后会与设置页显示的版本矛盾 */}
            <span className="brand-ver">{appVersion ? `v${appVersion.replace(/^v/, "")}` : "—"}</span>
          </div>
          <div className="header-actions">
            {/* v13：系统时间从右栏卡片收进顶栏——时间属窗口级信息，
                不值得在右栏独占一张卡（那会让右栏超出一屏）。 */}
            <LiveClock compact />
            <div className="header-search">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                width="16"
                height="16"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                placeholder={t("nav.searchPlaceholder", "Search nodes...")}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  if (tabRef.current !== "proxies") goTab("proxies");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") goTab("proxies");
                }}
              />
            </div>
            <div className="header-icons">
              <button
                type="button"
                className={`icon-btn${showRail ? " on" : ""}`}
                title={showRail ? t("nav.collapseRail", "Collapse sidebar") : t("nav.expandRail", "Expand sidebar")}
                aria-pressed={showRail}
                onClick={() => setRailOverride(!showRail)}
              >
                <PanelRight size={17} />
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => window.veyra?.maximize()}
                aria-label={isMaximized ? "还原窗口" : "最大化"}
                title={isMaximized ? "还原窗口" : "最大化"}
              >
                {isMaximized ? <Copy size={17} /> : <Square size={17} />}
              </button>
              <button type="button" className="icon-btn" onClick={() => window.veyra?.minimize()} aria-label={t("nav.minimize", "Minimize")} title={t("nav.minimize", "Minimize")}>
                <Minus size={17} />
              </button>
              <button type="button" className="icon-btn" onClick={() => window.veyra?.close()} aria-label={t("nav.close", "Close")} title={t("nav.close", "Close")}>
                <X size={17} />
              </button>
            </div>
          </div>
        </header>

        {banner ? (
          <div className="app-banner" role="alert">
            <span className="app-banner-msg">{banner}</span>
            <button
              type="button"
              className="app-banner-close"
              onClick={() => setBanner("")}
              aria-label={t("common.close", "关闭")}
            >
              <X size={13} />
              {t("common.close", "关闭")}
            </button>
          </div>
        ) : null}

        {/* 三栏骨架：侧栏 + 主区 + 右栏（可收起） */}
        {/* rail-compact：仅首页使用，调整栅格宽度（156px 侧栏 + 右栏可见）。
            状态面板（rail-status-panel）在所有 Tab 统一为横向单行布局，不依赖此 class。 */}
        <div
          className={`grid-12${showRail ? "" : " no-rail"}${
            showRail && tab === "home" ? " rail-compact" : ""
          }`}
        >
          {/* Left Sidebar */}
          <div className="col-sidebar">
            <div className="card">
              <div className="card-body tight">
                <nav className="nav-list">
                  {navItems.map(([id, Icon, label, badge]) => (
                    <button
                      key={id}
                      type="button"
                      className={`nav-item ${tab === id ? "active" : ""}`}
                      aria-current={tab === id ? "page" : undefined}
                      onClick={() => goTab(id)}
                    >
                      <Icon />
                      <span>{label}</span>
                      {typeof badge === "number" && badge > 0 ? (
                        <span className="badge badge-count" style={{ marginLeft: "auto" }}>
                          {badge > 99 ? "99+" : badge}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </nav>
                <section className="rail-status-panel" aria-label={t("nav.sysStatus", "System status")}>
                  <div className="nav-section-title">{t("nav.sysStatus", "System status")}</div>
                  {/* v8：状态行——绿点 + 状态粗字 + 时长右对齐 */}
                  <div className="rail-state">
                    <span className={`rail-status-dot${running ? " on" : ""}`} aria-hidden="true" />
                    <b>{running ? t("status.heroRunning", "运行中") : t("status.heroStopped", "已停止")}</b>
                    <small>{running && coreStartTime ? formatUptimeRail(Date.now() - coreStartTime) : "—"}</small>
                  </div>
                  {/* P1 去重：速率双卡与趋势图带删除（主区 KPI 卡已有更大更全的速率+曲线），
                      左栏回归「导航附属」——只保留运行状态 + 代理/连接/内存 */}
                  <div className="rail-facts">
                    <div className="rail-fact">
                      <span>{t("nav.proxy", "代理")}</span>
                      <strong className={sysProxy ? "on" : ""}>
                        {sysProxy ? t("nav.on", "开启") : t("nav.off", "关闭")}
                      </strong>
                    </div>
                    <div className="rail-fact">
                      <span>{t("nav.connections", "连接")}</span>
                      <strong className={connCount > 0 ? "on" : ""}>{connCount}</strong>
                    </div>
                    <div className="rail-fact">
                      <span>{t("nav.memory", "内存")}</span>
                      <strong>{memText}</strong>
                    </div>
                    {/* 内核名此前只出现在 hero 的一行小字里；状态卡补上它，
                        让左栏这张卡的信息自成一体（代理/连接/内存/内核） */}
                    <div className="rail-fact">
                      <span>{t("nav.core", "内核")}</span>
                      <strong>{activeCore === "singbox" ? "sing-box" : "Mihomo"}</strong>
                    </div>
                  </div>
                </section>
              </div>
            </div>
          </div>

          {/* Main Content */}
          <div className="col-main">
            <main className="stage">
              <div className="pane home" hidden={tab !== "home"}>
                  {/* HERO · 核心连接球 — 视觉锚点 */}
                  <ConnectOrb
                    running={running}
                    sysProxy={sysProxy}
                    busy={busy}
                    mixedPort={mixedPort}
                    nodeName={currentNode}
                    onToggleProxy={toggleSysProxy}
                    onNodeClick={() => {
                      // P2：一键去代理页切节点，并选中当前节点所在分组
                      setTab("proxies");
                      const g = groups.find((x) => x.all?.includes(currentNode));
                      if (g?.name) setSelectedGroup(g.name);
                    }}
                    meta={
                      running ? (
                        <>
                          <span>{activeCore === "singbox" ? "sing-box" : "Mihomo"}</span>
                          <span className="hero-run-sep">·</span>
                          <LiveUptime since={appStartTime.current} />
                        </>
                      ) : null
                    }
                  />

                  {/* 实时流量面板（v14）
                      合并原「上传速率 / 下载速率 / 活跃连接」三张指标卡 + 独立流量图。
                      理由：四者语义上就是同一件事，拆成四块会让中栏失去视觉焦点，
                      并把最大面积给了最空的内容。速率现在是全页最大的数据。 */}
                  <div className="glass-tile tf-panel" style={{ marginBottom: 14 }}>
                    <div className="tf-head">
                      <div className="tf-head-l">
                        <span className="tf-title">{t("home.realtimeTraffic", "实时流量")}</span>
                        <span className="tf-sub">
                          {MODE_LABEL[mode] || mode} · {nodes.length}{" "}
                          {t("home.nodesAvailable", "节点可用")}
                        </span>
                      </div>
                      {/* 首页卡片配置入口：这个弹窗此前没有任何入口（setHomeCfgOpen(true) 全项目 0 次调用），
                          卡片开关逻辑与持久化都已实现好，只是打不开。 */}
                      <button
                        ref={homeCfgTriggerRef}
                        type="button"
                        className="btn ghost btn-xs home-cfg-open"
                        onClick={() => {
                          setHomeCfgDraft(homeCards);
                          setHomeCfgOpen(true);
                        }}
                        title={t("home.configureCards", "自定义首页卡片")}
                        aria-haspopup="dialog"
                      >
                        <SlidersHorizontal size={13} />
                        {t("home.configureCards", "自定义首页卡片")}
                      </button>
                    </div>

                    {/* 焦点数据：下载速率是全页最大的数字。0 值降为中性灰——彩色 0 会暗示「有数据」 */}
                    <div className="tf-rates">
                      <div className="tf-rate">
                        <span className="tf-rate-k">↓ {t("home.download", "下载")}</span>
                        <span
                          className={`tf-rate-v${downRate > 0 ? " down" : " is-zero"}`}
                        >
                          {formatRate(downRate)}
                        </span>
                      </div>
                      <div className="tf-rate">
                        <span className="tf-rate-k">↑ {t("home.upload", "上传")}</span>
                        <span className={`tf-rate-v sm${upRate > 0 ? " up" : " is-zero"}`}>
                          {formatRate(upRate)}
                        </span>
                      </div>
                      <div className="tf-conn">
                        <span className="tf-conn-k">
                          {t("home.activeConnections", "活跃连接")}
                        </span>
                        <span className={`tf-conn-v${connCount > 0 ? "" : " is-zero"}`}>
                          {connCount}
                        </span>
                      </div>
                    </div>

                    <div className="home-chart-wrap">
                      <span className="tf-window">{t("home.window60s", "最近 60 秒")}</span>
                      {hasTraffic ? (
                        <WaveChart up={rateHistory.up} down={rateHistory.down} />
                      ) : (
                        <>
                          {/* 零流量：只留网格底，不画数据线；给明确引导而非留一片空白 */}
                          <WaveChart up={[]} down={[]} empty />
                          <div className="home-chart-empty">
                            <svg
                              viewBox="0 0 24 24"
                              width="20"
                              height="20"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.6"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M3 12h4l2.5-6 4 12L16 12h5" />
                            </svg>
                            <p>
                              {running
                                ? t("home.noTraffic", "暂无流量数据")
                                : t("nav.serviceNotRunning", "服务未运行")}
                            </p>
                            {/* 空态 = 原因 + 下一步，不能只说「没有」 */}
                            <small>
                              {running
                                ? t("home.noTrafficHint", "有流量经过时会自动记录")
                                : t("home.startHint", "启动内核后开始记录")}
                            </small>
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {/* 区段 3: 订阅状态 */}
                  {homeCards.subscription && subs.length > 0 && (
                    <div style={{ marginBottom: 14 }}>
                      <div
                        style={{ fontSize: 14, fontWeight: 600, color: "var(--text-100)", marginBottom: 8 }}
                      >
                        {t("home.subscriptions", "订阅")}{" "}
                        <span style={{ fontSize: 11, color: "var(--text-500)", fontWeight: 400 }}>
                          {subs.length}
                        </span>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        {subs.slice(0, 3).map((sub, i) => (
                          <div
                            key={i}
                            className="glass-tile"
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                              padding: "8px 12px",
                            }}
                          >
                            <div
                              style={{
                                width: 6,
                                height: 6,
                                borderRadius: 50,
                                background:
                                  sub.userinfo && sub.userinfo.total > 0
                                    ? "var(--green-500)"
                                    : "var(--text-500)",
                                flexShrink: 0,
                              }}
                            />
                            <span
                              style={{
                                fontSize: 12,
                                color: "var(--text-100)",
                                flex: 1,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={sub.name}
                            >
                              {/* 订阅名常是 55 字符的 UUID 文件名：首尾可辨、中段无信息量。
                                  中间省略比尾部省略更能保住识别度（完整值走 title）。 */}
                              {sub.name.length > 34
                                ? `${sub.name.slice(0, 20)}…${sub.name.slice(-11)}`
                                : sub.name}
                            </span>
                            {sub.userinfo ? (
                              <span
                                style={{
                                  fontSize: 10.5,
                                  color: "var(--green-500)",
                                  fontFamily: "var(--font-mono)",
                                }}
                              >
                                {(() => {
                                  const pct =
                                    sub.userinfo.total > 0
                                      ? Math.min(
                                          100,
                                          Math.round(
                                            ((sub.userinfo.upload + sub.userinfo.download) /
                                              sub.userinfo.total) *
                                              100
                                          )
                                        )
                                      : 0;
                                  return pct + "%";
                                })()}
                              </span>
                            ) : (
                              <span style={{ fontSize: 10.5, color: "var(--text-500)" }}>—</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 区段 4: 内核信息——「内核 / 运行时长」两块与右栏 mini 卡完全重复
                     （还差 1 秒显得像 bug），P1 去重后只保留右栏没有的「规则数量」 */}
                  {homeCards.core && (
                    <div style={{ display: "flex", gap: 10 }}>
                      <div
                        className="glass-tile"
                        style={{
                          flex: 1,
                          padding: "12px 14px",
                        }}
                      >
                        <div className="tile-head">
                          <span className="tile-title">{t("home.rules", "规则数量")}</span>
                          <span className={`tile-num${ruleCount != null ? "" : " is-zero"}`}>
                            {ruleCount != null ? ruleCount : 0}
                          </span>
                        </div>
                        {ruleCount != null ? (
                          <div className="tile-hint">{t("home.ruleCount", "条规则")}</div>
                        ) : (
                          /* 空态 = 原因 + 下一步：只说「暂无」用户不知道要做什么 */
                          <div className="tile-empty">
                            <span>{t("home.noRulesHint", "还没有加载规则集，当前为直连模式")}</span>
                            <button
                              type="button"
                              className="link-btn"
                              onClick={() => goTab("rules")}
                            >
                              {t("home.goAddRules", "去添加规则集")} →
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* 区段 5: 当前节点（原 homeCards.node 开关无效，此处补齐） */}
                  {homeCards.node && (
                    <div style={{ marginTop: 14 }}>
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 600,
                          color: "var(--text-100)",
                          marginBottom: 8,
                        }}
                      >
                        {t("home.currentNode", "当前节点")}
                      </div>
                      <div style={{ display: "flex", gap: 10 }}>
                        <div style={HOME_TILE}>
                          <div style={HOME_TILE_LABEL}>{t("home.nodeName", "节点")}</div>
                          {/* currentNode 在无选中时取值是 "—" 而非空串（见 currentNodeInfo 的同一判断），
                              只判真值会让空态分支永远不触发 */}
                          {currentNode && currentNode !== "—" ? (
                            <>
                              <div style={HOME_TILE_VALUE} title={currentNode}>
                                {currentNode}
                              </div>
                              <div
                                style={{ fontSize: 11, color: "var(--text-400)", marginTop: 3 }}
                              >
                                {currentNodeInfo.type || "—"}
                                {currentNodeInfo.udp ? " · UDP" : ""}
                              </div>
                            </>
                          ) : (
                            /* 空态给出口：未选节点时告诉用户去哪里选 */
                            <div className="tile-empty">
                              <span>{t("home.noNode", "还没有选择节点")}</span>
                              <button
                                type="button"
                                className="link-btn"
                                onClick={() => goTab("proxies")}
                              >
                                {t("home.goSelectNode", "去选择节点")} →
                              </button>
                            </div>
                          )}
                        </div>
                        <div style={HOME_TILE}>
                          <div style={HOME_TILE_LABEL}>{t("home.delay", "延迟")}</div>
                          <div
                            style={{
                              ...HOME_TILE_VALUE,
                              color: delayColor(currentNodeInfo.delay),
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            {currentNodeInfo.delay != null ? `${currentNodeInfo.delay} ms` : "—"}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text-400)", marginTop: 3 }}>
                            {t("home.availableNodes")} {nodes.length}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* 区段 6: 网络设置 + 代理模式（原 homeCards.network / mode 开关无效，此处补齐） */}
                  {(homeCards.network || homeCards.mode) && (
                    <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
                      {homeCards.network && (
                        <div style={{ ...HOME_TILE, flex: 1 }}>
                          <div style={HOME_TILE_LABEL}>{t("home.sysProxy", "系统代理")}</div>
                          <div
                            style={{
                              ...HOME_TILE_VALUE,
                              color: sysProxy ? "var(--green-500)" : "var(--text-400)",
                            }}
                          >
                            {sysProxy ? t("home.on", "已开启") : t("home.off", "已关闭")}
                          </div>
                          <button
                            type="button"
                            className="btn ghost btn-xs"
                            style={{ marginTop: 6 }}
                            onClick={toggleSysProxy}
                            disabled={!running}
                          >
                            {sysProxy ? t("home.turnOff", "关闭") : t("home.turnOn", "开启")}
                          </button>
                        </div>
                      )}
                      {homeCards.mode && (
                        <div style={{ ...HOME_TILE, flex: 1 }}>
                          <div style={HOME_TILE_LABEL}>{t("home.mode", "代理模式")}</div>
                          <div style={HOME_TILE_VALUE}>{MODE_LABEL[mode] || mode}</div>
                          <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
                            {(["rule", "global", "direct"] as const).map((m) => (
                              <button
                                key={m}
                                type="button"
                                className={`btn ghost btn-xs${mode === m ? " on" : ""}`}
                                onClick={() => changeMode(m)}
                                disabled={!running}
                              >
                                {MODE_LABEL[m] || m}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* 区段 7: 系统信息（原 homeCards.system 开关无效，此处补齐） */}
                  {homeCards.system && (
                    <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
                      <div style={{ ...HOME_TILE, flex: 1 }}>
                        <div style={HOME_TILE_LABEL}>{t("home.platform", "系统")}</div>
                        <div style={HOME_TILE_VALUE}>{platformLabel || "—"}</div>
                      </div>
                      <div style={{ ...HOME_TILE, flex: 1 }}>
                        <div style={HOME_TILE_LABEL}>{t("home.version", "版本")}</div>
                        <div style={{ ...HOME_TILE_VALUE, fontFamily: "var(--font-mono)" }}>
                          {appVersion ? `v${appVersion.replace(/^v/, "")}` : "—"}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-400)", marginTop: 3 }}>
                          {mihomoChannel}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* 区段 8: 累计流量（原 homeCards.traffic 开关无效，此处补齐） */}
                  {homeCards.traffic && (
                    <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
                      <div style={{ ...HOME_TILE, flex: 1 }}>
                        <div style={HOME_TILE_LABEL}>{t("home.totalDown", "累计下行")}</div>
                        <div style={{ ...HOME_TILE_VALUE, fontFamily: "var(--font-mono)" }}>
                          {formatBytes(download)}
                        </div>
                      </div>
                      <div style={{ ...HOME_TILE, flex: 1 }}>
                        <div style={HOME_TILE_LABEL}>{t("home.totalUp", "累计上行")}</div>
                        <div style={{ ...HOME_TILE_VALUE, fontFamily: "var(--font-mono)" }}>
                          {formatBytes(upload)}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

              <div className="pane px" hidden={tab !== "proxies"}>
                  <div className="px-header-card">
                    <div className="px-tabs">
                      {groups.length ? (
                        groups.map((g) => (
                          <button
                            key={g.name}
                            type="button"
                            className={`px-tab ${g.name === selectedGroup ? "active" : ""}`}
                            onClick={() => setSelectedGroup(g.name || "")}
                            title={g.name || ""}
                          >
                            <span className="gt-ico">
                              <Server size={14} />
                            </span>
                            <span className="gt-txt">
                              <b>{g.name}</b>
                              <small>{g.now || g.type}</small>
                            </span>
                          </button>
                        ))
                      ) : (
                        <div className="empty slim">{t("proxies.noGroups", "No proxy groups — import a profile in the Profiles tab")}</div>
                      )}
                    </div>

                    <div className="px-toolbar">
                      <div className="px-meta">
                        <span className="meta-dot" />
                        {t("proxies.nodeCount", "{n} nodes").replace("{n}", String(nodes.length))}
                        {lastTestAt > 0
                          ? ` · ${t("proxies.lastTest", "Last test")} ${new Date(lastTestAt).toLocaleTimeString()}`
                          : ` · ${t("proxies.manualTest", "Manual test")}`}
                      </div>
                      <div className="px-tools">
                        <label className="proxies-search">
                          <Search size={15} />
                          <input
                            placeholder={t("proxies.searchNode", "Search node")}
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                          />
                        </label>
                        <label className="switch compact">
                          <input
                            type="checkbox"
                            checked={autoPick}
                            onChange={async (e) => {
                              const v = e.target.checked;
                              setAutoPick(v);
                              await window.veyra?.setSettings({ autoPick: v });
                              // 刚打开「选用最低」时立刻测一次并切过去，避免用户以为没生效
                              if (v) void runSpeedTest({ silent: false, pickBest: true });
                            }}
                          />
                          {t("proxies.pickLowest", "Pick lowest")}
                        </label>
                        <button
                          type="button"
                          className="btn primary"
                          onClick={testAll}
                          disabled={!running || testing || !nodes.length}
                        >
                          <Zap size={15} />
                          {testing ? `${testProgress}%` : t("proxies.testAll", "Test all")}
                        </button>

                        {/* 节点密度切换：舒适/紧凑/列表 */}
                        <div
                          className="seg node-density"
                          role="group"
                          aria-label="Node density"
                        >
                          <button
                            type="button"
                            className={nodeDensity === "comfortable" ? "active" : ""}
                            onClick={() => { setNodeDensity("comfortable"); localStorage.setItem("veyra-node-density", "comfortable"); }}
                            title="舒适布局"
                          >
                            <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="0.5" y="0.5" width="5" height="5" rx="1" stroke="currentColor"/><rect x="7.5" y="0.5" width="5" height="5" rx="1" stroke="currentColor"/><rect x="0.5" y="7.5" width="5" height="5" rx="1" stroke="currentColor"/><rect x="7.5" y="7.5" width="5" height="5" rx="1" stroke="currentColor"/></svg>
                            舒适
                          </button>
                          <button
                            type="button"
                            className={nodeDensity === "compact" ? "active" : ""}
                            onClick={() => { setNodeDensity("compact"); localStorage.setItem("veyra-node-density", "compact"); }}
                            title="紧凑布局"
                          >
                            <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="0.5" y="0.5" width="3.5" height="3.5" rx="0.8" stroke="currentColor"/><rect x="5" y="0.5" width="3.5" height="3.5" rx="0.8" stroke="currentColor"/><rect x="9.5" y="0.5" width="3.5" height="3.5" rx="0.8" stroke="currentColor"/><rect x="0.5" y="5" width="3.5" height="3.5" rx="0.8" stroke="currentColor"/><rect x="5" y="5" width="3.5" height="3.5" rx="0.8" stroke="currentColor"/><rect x="9.5" y="5" width="3.5" height="3.5" rx="0.8" stroke="currentColor"/><rect x="0.5" y="9.5" width="3.5" height="3.5" rx="0.8" stroke="currentColor"/><rect x="5" y="9.5" width="3.5" height="3.5" rx="0.8" stroke="currentColor"/><rect x="9.5" y="9.5" width="3.5" height="3.5" rx="0.8" stroke="currentColor"/></svg>
                            紧凑
                          </button>
                          <button
                            type="button"
                            className={nodeDensity === "list" ? "active" : ""}
                            onClick={() => { setNodeDensity("list"); localStorage.setItem("veyra-node-density", "list"); }}
                            title="列表布局"
                          >
                            <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="0.5" y="1" width="12" height="2.5" rx="0.8" stroke="currentColor"/><rect x="0.5" y="5.25" width="12" height="2.5" rx="0.8" stroke="currentColor"/><rect x="0.5" y="9.5" width="12" height="2.5" rx="0.8" stroke="currentColor"/></svg>
                            列表
                          </button>
                        </div>
                      </div>
                    </div>

                    {testing && (
                      <div className="progress-line">
                        <i style={{ width: `${testProgress}%` }} />
                      </div>
                    )}
                  </div>

                  {!sortedNodes.length ? (
                    <div className="empty">{t("proxies.noNodes", "No nodes to display")}</div>
                  ) : (
                    <div className={`px-grid density-${nodeDensity}`}>
                      {sortedNodes.slice(0, pxNodeLimit).map((n) => {
                        const d = delays[n];
                        const cls = delayClass(d);
                        const active = currentGroup?.now === n;
                        const isBest = bestNode?.name === n;
                        const info = proxyMap[n];
                        const ptype =
                          info?.type || (GROUP_TYPES.has(info?.type || "") ? info?.type : "") || "";
                        const isGroup = GROUP_TYPES.has(info?.type || "");
                        const hist = delayHistory[n]?.slice(-15) || [];
                        const maxMs = Math.max(...hist.map((h) => (h.ms > 0 ? h.ms : 0)), 50);
                        const flagSvg = countryFlagSvg(n);
                        return (
                          <button
                            key={n}
                            type="button"
                            className={[
                              "px-card",
                              active ? "active" : "",
                              isBest ? "best" : "",
                              testingNode === n ? "testing" : "",
                            ]
                              .filter(Boolean)
                              .join(" ")}
                            onClick={() => selectNode(n)}
                            title={testingNode === n ? t("proxies.testingNode", "Testing…") : `${t("proxies.switchTo", "Switch to")} ${n}`}
                          >
                            <span className="px-flag">
                              {flagSvg ? (
                                <img
                                  src={flagSvg}
                                  alt=""
                                  style={{
                                    width: 20,
                                    height: 14,
                                    borderRadius: 2,
                                    verticalAlign: "middle",
                                    boxShadow: "var(--shadow-sm)",
                                  }}
                                />
                              ) : (
                                <span style={{ fontSize: 14, opacity: 0.5 }}>🌐</span>
                              )}
                            </span>
                            <span className={`px-dot ${active ? "on" : ""}`} />
                            <span className="px-card-main">
                              <span className="px-card-name" title={n}>
                                {n}
                              </span>
                              <span className="px-card-meta">
                                {ptype ? <em>{ptype}</em> : null}
                                {info?.udp ? <i>UDP</i> : null}
                                {info?.xudp ? <i>XUDP</i> : null}
                                {isGroup ? <i>{t("proxies.groupTag", "Group")}</i> : null}
                                {isSystemOutbound(n) ? <i>{t("proxies.systemTag", "System")}</i> : null}
                              </span>
                              {hist.length > 1 && (
                                <span className="px-sparkline" aria-hidden="true">
                                  {hist.map((h, i) => {
                                    const hgt =
                                      h.ms > 0
                                        ? Math.max(2, Math.min(14, Math.round((h.ms / maxMs) * 14)))
                                        : 1;
                                    return (
                                      <span
                                        key={i}
                                        className={`px-spark-bar ${delayDotClass(h.ms)}`}
                                        style={{ height: `${hgt}px` }}
                                      />
                                    );
                                  })}
                                </span>
                              )}
                            </span>
                            <span
                              className={`px-card-delay ${cls}`}
                              title={(() => {
                                const h = delayHistory[n];
                                if (!h?.length) return t("proxies.noDelayHistory", "No delay history");
                                return h
                                  .slice(-5)
                                  .reverse()
                                  .map(
                                    (r) =>
                                      `${new Date(r.t).toLocaleString(getLocale(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}: ${r.ms}ms`
                                  )
                                  .join("\n");
                              })()}
                            >
                              {testingNode === n ? "…" : delayText(d)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

              <div className="pane pf" hidden={tab !== "profiles"} data-pf={pfTab}>
                  <div className="pf-tabs" role="tablist" aria-label={t("profiles.tabLabel", "Profile functions")}>
                    {([
                      ["sub", t("profiles.tabSub", "Subscriptions")],
                      ["enhance", t("profiles.tabEnhance", "Enhance")],
                      ["nodes", t("profiles.tabNodes", "Node editor")],
                      ["yaml", "YAML"],
                    ] as const).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={pfTab === id}
                        className={pfTab === id ? "active" : ""}
                        onClick={() => setPfTab(id)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {(pfSeen.sub || pfTab === "sub") ? (
                    <div className="pf-pane" hidden={pfTab !== "sub"}>
                      <section className="import-hero">
                        <h3><Globe size={15} /> {t("profiles.importSub", "Import subscription")}</h3>
                        <p>{t("profiles.importDesc", "Paste a Clash/Meta subscription URL, import will auto-enhance and apply.")}</p>
                        <div className="import-bar">
                          <input
                            value={subUrl}
                            onChange={(e) => setSubUrl(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void importFromUrl();
                            }}
                            placeholder="https://example.com/clash subscription"
                            aria-label={t("profiles.subUrlLabel", "Subscription URL")}
                          />
                          <button
                            type="button"
                            className="btn primary btn-sm"
                            disabled={busy}
                            onClick={() => void importFromUrl()}
                          >
                            {t("profiles.importBtn", "Import")}
                          </button>
                        </div>
                      </section>

                      {/* 订阅链接区 — Clash Verge 风格流量卡片 */}
                      <section className="pf-card" style={{ marginBottom: 14 }}>
                    <div className="pf-card-hd">
                      <h2>
                        <Globe size={15} /> {t("profiles.subscriptions", "订阅")}
                      </h2>
                      <span className="hd-count">{subs.length}</span>
                    </div>
                    {!subs.length ? (
                      <div className="empty slim">
                        {t("profiles.noSubs", "暂无订阅 - 从顶部输入链接导入")}
                      </div>
                    ) : (
                      <div className="sub-grid">
                        {subs.map((s) => {
                          const used = (s.userinfo?.upload || 0) + (s.userinfo?.download || 0);
                          const total = s.userinfo?.total || 0;
                          const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
                          const expireDate = expiryText(s.userinfo?.expire);
                          return (
                            <div key={s.url} className="sub-card">
                              <div className="sub-card-dot" />
                              <div className="sub-card-body">
                                <div className="sub-card-name">{s.name}</div>
                                <div className="sub-card-domain">
                                  {s.url.replace(/^https?:\/\//, "").split("/")[0]}
                                </div>
                                <div className="sub-card-meta">
                                  <span>{relativeTime(s.updatedAt)}</span>
                                  <span className="sub-card-sep">·</span>
                                  <span>
                                    {total > 0 ? `${formatBytes(used)} / ${formatBytes(total)}` : ""}
                                  </span>
                                </div>
                                {total > 0 && (
                                  <div className="sub-card-track">
                                    <div className="sub-card-progress" style={{ width: `${pct}%` }} />
                                  </div>
                                )}
                              </div>
                              <div className="sub-card-side">
                                {expireDate && <span className="sub-card-expire">{expireDate}</span>}
                                <button
                                  type="button"
                                  className="sub-card-refresh"
                                  onClick={() => {
                                    setSubUrl(s.url);
                                    importFromUrl(s.url);
                                  }}
                                  title="刷新"
                                >
                                  <RefreshCw size={13} />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>

                  {/* 配置列表区 */}
                  <section className="pf-card">
                    <div className="pf-card-hd">
                      <h2>
                        <Layers3 size={15} /> {t("profiles.configs", "配置文件")}
                      </h2>
                      <span className="hd-count">{richProfiles.length || profiles.length}</span>
                    </div>
                    {!(richProfiles.length || profiles.length) ? (
                      <div className="empty slim">
                        {t("profiles.noConfigs", "暂无配置文件 - 点击上方添加_merge/script/rules")}
                      </div>
                    ) : (
                      <div className="pf-list">
                        {(richProfiles.length
                          ? richProfiles.map((p) => ({
                              key: p.uid,
                              uid: p.uid,
                              name: p.name,
                              sub: `${p.type}${p.global ? " · " + t("profiles.global", "全局") : ""}`,
                              size: p.size,
                              enabled: p.enabled,
                              type: p.type,
                            }))
                          : profiles.map((p) => ({
                              key: p.uid || p.name,
                              uid: p.uid,
                              name: p.name,
                              sub: p.type || "file",
                              size: p.size,
                              enabled: p.enabled !== false,
                              type: (p.type as ProfileRich["type"]) || "local",
                            }))
                        ).map((p) => (
                          <div key={p.key} className="pf-item">
                            <span className="pf-item-ico">
                              <Layers3 size={15} />
                            </span>
                            <div className="pf-item-body">
                              <div className="pf-item-name">{p.name}</div>
                              <div className="pf-item-sub">{p.sub}</div>
                            </div>
                            <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                              {p.uid && (p.type === "remote" || p.type === "local") ? (
                                <button
                                  type="button"
                                  className="btn ghost btn-sm"
                                  onClick={async () => {
                                    await window.veyra?.activateProfile?.(p.uid!);
                                    await applyEnhance();
                                    showToast(t("profiles.activated", "已激活 ") + p.name);
                                  }}
                                >
                                  {t("profiles.activate", "激活")}
                                </button>
                              ) : null}
                              {p.uid ? (
                                <button
                                  type="button"
                                  className="btn btn-sm primary"
                                  onClick={async () => {
                                    const t2 = await window.veyra?.readProfile?.(p.uid!);
                                    if (t2 != null) {
                                      setEditUid(p.uid!);
                                      setProfileName(p.name);
                                      setProfileText(t2);
                                      setEditorMode("profile");
                                      setPfTab("yaml");
                                    }
                                  }}
                                >
                                  {t("profiles.edit", "编辑")}
                                </button>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                    </div>
                  ) : null}

                  {(pfSeen.enhance || pfTab === "enhance") ? (
                    <div className="pf-pane" hidden={pfTab !== "enhance"}>
                      <section className="pf-card pf-enhance-tools">
                        <div className="pf-card-hd">
                          <h2><Layers3 size={15} /> 增强配置</h2>
                          <span className="hd-count">{richProfiles.filter((p) => p.type !== "remote" && p.type !== "local").length}</span>
                        </div>
                        <div className="pf-enhance-actions">
                          {(["merge", "script", "rules", "proxies", "groups"] as const).map((kind) => (
                            <button
                              key={kind}
                              type="button"
                              className="btn ghost btn-sm"
                              disabled={busy}
                              onClick={() => void createEnhance(kind)}
                            >
                              + {kind}
                            </button>
                          ))}
                          <button type="button" className="btn ghost btn-sm" disabled={busy} onClick={() => void createEnhance("merge", true)}>
                            + 全局 Merge
                          </button>
                          <button type="button" className="btn primary btn-sm" disabled={busy} onClick={() => void applyEnhance()}>
                            应用增强
                          </button>
                          <button type="button" className="btn ghost btn-sm" onClick={() => void reloadProviders()}>
                            刷新 Provider
                          </button>
                        </div>
                      </section>
                  {bindTarget ? (
                    <section className="block pf-enhance" style={{ marginTop: 12 }}>
                      <div className="block-hd">
                        <h2>订阅绑定扩展</h2>
                        <span className="pill dim">{bindTarget.slice(0, 8)}</span>
                      </div>
                      <p className="s-muted">
                        为该 Remote/Local 指定专用 Merge / Script / Rules / Proxies / Groups
                      </p>
                      <div className="s-fields">
                        {(["merge", "script", "rules", "proxies", "groups"] as const).map((k) => (
                          <label key={k}>
                            {k}
                            <select
                              className="s-input"
                              defaultValue={richProfiles.find((x) => x.uid === bindTarget)?.binds?.[k] || ""}
                              onChange={async (e) => {
                                const cur = richProfiles.find((x) => x.uid === bindTarget);
                                const binds = { ...(cur?.binds || {}), [k]: e.target.value || null };
                                await window.veyra?.setProfileBinds?.(bindTarget, binds);
                                await reloadProfileLists();
                                showToast(`已绑定 ${k}`);
                              }}
                            >
                              <option value="">（无）</option>
                              {richProfiles
                                .filter((x) => x.type === k || (k === "merge" && x.type === "merge"))
                                .map((x) => (
                                  <option key={x.uid} value={x.uid}>
                                    {x.name}
                                  </option>
                                ))}
                            </select>
                          </label>
                        ))}
                      </div>
                    </section>
                  ) : null}

                  {providers.proxies.length || providers.rules.length ? (
                    <section className="block pf-enhance" style={{ marginTop: 12 }}>
                      <div className="block-hd">
                        <h2>远程配置</h2>
                      </div>
                      <div className="pf-list">
                        {providers.proxies.map((n) => (
                          <div key={`pp-${n}`} className="pf-item">
                            <div className="pf-item-body">
                              <div className="pf-item-name">{n}</div>
                              <div className="pf-item-sub">proxy-provider</div>
                            </div>
                            <button
                              type="button"
                              className="btn ghost btn-sm"
                              onClick={async () => {
                                await window.veyra?.updateProvider?.("proxies", n);
                                showToast(`已更新 ${n}`);
                              }}
                            >
                              更新
                            </button>
                          </div>
                        ))}
                        {providers.rules.map((n) => (
                          <div key={`rp-${n}`} className="pf-item">
                            <div className="pf-item-body">
                              <div className="pf-item-name">{n}</div>
                              <div className="pf-item-sub">rule-provider</div>
                            </div>
                            <button
                              type="button"
                              className="btn ghost btn-sm"
                              onClick={async () => {
                                await window.veyra?.updateProvider?.("rules", n);
                                showToast(`已更新 ${n}`);
                              }}
                            >
                              更新
                            </button>
                          </div>
                        ))}
                      </div>
                    </section>
                  ) : null}

                  {enhanceLog.length ? (
                    <section className="block pf-enhance" style={{ marginTop: 12 }}>
                      <div className="block-hd">
                        <h2>增强日志</h2>
                      </div>
                      <pre className="term-body" style={{ maxHeight: 120 }}>
                        {enhanceLog.join("\n")}
                      </pre>
                    </section>
                  ) : null}
                    </div>
                  ) : null}

                  {pfSeen.nodes ? (
                    <div className="pf-pane" hidden={pfTab !== "nodes"}>
                      <section className="block pf-nodes" style={{ marginTop: 12 }}>
                        <ProxiesVisualEditor onToast={showToast} onBusy={setBusy} />
                      </section>
                      <section className="block pf-nodes" style={{ marginTop: 12 }}>
                        <GroupsVisualEditor onToast={showToast} onBusy={setBusy} />
                      </section>
                    </div>
                  ) : null}

                  {pfSeen.yaml ? (
                    <section className="editor-card pf-yaml" hidden={pfTab !== "yaml"}>
                      <div className="editor-bar">
                        <input
                          value={profileName}
                          onChange={(e) => setProfileName(e.target.value)}
                          placeholder={
                            editorMode === "runtime"
                              ? "runtime.yaml"
                              : editUid
                                ? "正在编辑已有配置"
                                : "文件名"
                          }
                        />
                        <button
                          type="button"
                          className="btn ghost"
                          disabled={busy}
                          onClick={async () => {
                            if (editorMode === "runtime") {
                              setBusy(true);
                              try {
                                await window.veyra?.writeRuntime?.(profileText);
                                showToast("运行时配置已写入并重载");
                                await refresh();
                              } catch (e) {
                                showToast(String((e as Error).message || e));
                              } finally {
                                setBusy(false);
                              }
                            } else {
                              await saveProfile();
                            }
                          }}
                        >
                          {editorMode === "runtime" ? "保存运行时" : editUid ? "保存并增强" : "保存 YAML"}
                        </button>
                      </div>
                      <Suspense
                        fallback={
                          <div className="yaml-editor monaco">
                            <div
                              style={{
                                height: 320,
                                display: "grid",
                                placeItems: "center",
                                color: "var(--text-400)",
                                fontSize: 12,
                              }}
                            >
                              编辑器加载中…
                            </div>
                          </div>
                        }
                      >
                        <YamlEditor
                          value={profileText}
                          onChange={setProfileText}
                          placeholder="粘贴 YAML / Merge / Script…"
                          hint={
                            editorMode === "runtime"
                              ? "运行时配置（增强产物，可直接改）· schema: Clash Meta"
                              : "YAML 编辑器 · 支持 Merge delete-rules 等"
                          }
                        />
                      </Suspense>
                    </section>
                  ) : null}
                </div>

              {/* 保留挂载（hidden 切换）：切页不卸载组件，编辑中的规则草稿/滚动位置不丢 */}
              <div className="pane" hidden={tab !== "rules"}>
                <RulesPage onToast={showToast} onBusy={setBusy} />
              </div>

              <div className="pane conn-wrap" hidden={tab !== "connections"}>
                <ConnectionsPage onToast={showToast} />
              </div>

              <div className="pane term" hidden={tab !== "logs"}>
                  <div className="term-bar">
                    <div className="term-title">
                      <span className="term-dots">
                        <i />
                        <i />
                        <i />
                      </span>
                      <h1>内核日志</h1>
                      <span className="pill dim">{logs.length} 行</span>
                    </div>
                    <div className="s-actions">
                      <button
                        type="button"
                        className="btn ghost btn-sm"
                        onClick={() =>
                          setConfirmReq({
                            title: "清理日志文件",
                            message:
                              "将删除内核日志目录下已归档的日志文件（不影响当前屏幕显示的内容）。此操作不可撤销。",
                            confirmText: "清理",
                            danger: true,
                            onConfirm: async () => {
                              const r = await window.veyra?.clearLogFiles?.();
                              showToast(`已清理文件 ${r?.removed || 0} 个`);
                            },
                          })
                        }
                      >
                        清理日志文件
                      </button>
                      <button type="button" className="btn ghost btn-sm" onClick={() => setLogs([])}>
                        清空屏幕
                      </button>
                    </div>
                  </div>
                  {logs.length ? (
                    <pre className="term-body">{logs.join("")}</pre>
                  ) : (() => {
                    // 空态居中引导块：此前是终端顶部一行小字 + 一大块空板，观感像没加载完
                    const [line1, line2] = t(
                      "logs.empty",
                      "Waiting for proxy output…\nStart the core to see live Mihomo logs here."
                    ).split("\n");
                    return (
                      <div className="term-empty" role="status">
                        <div className="term-empty-ico">
                          <Terminal size={20} />
                        </div>
                        <p>{line1}</p>
                        <small>{line2 || line1}</small>
                      </div>
                    );
                  })()}
                </div>

              {/* 保留挂载（hidden 切换）：测试结果切页不丢 */}
              <div className="pane" hidden={tab !== "tests"}>
                <TestsPage running={running} onToast={showToast} />
              </div>

              <div className="pane" hidden={tab !== "settings"}>
                <SettingsPanel
                    running={running}
                    mixedPort={mixedPort}
                    controller={controller}
                    version={version}
                    autoPick={autoPick}
                    themeMode={themeMode}
                    onThemeChange={changeTheme}
                    onToast={showToast}
                    onBusy={setBusy}
                    onPorts={handlePorts}
                    onPrefs={handlePrefs}
                    onRefresh={refresh}
                    onCoreChange={setActiveCore}
                />
              </div>
            </main>
          </div>

          {/* Right Sidebar */}
          <div className="col-right">
            <div className="grid-stack">
              {/* v13：右栏原先四张卡（系统时间 / 出口 IP / 解锁状态 / 流量）在 860 高度下装不下，
                  滚动后连卡片标题都会被切掉。现收敛为两张：系统时间移到顶栏，
                  运行时长与内核移到 hero，流量并入出口 IP。 */}
              {/* 出口 IP 卡：消费此前「只检测不显示」的 exitIp 数据（见 useEffect @ running）。
                  原「快捷操作」4 个按钮的跳转目标在左侧导航中均已一键可达，属纯重复，故移除。 */}
              <div className="card">
                <div className="card-header no-border">
                  <div className="card-title text-base">网络状态</div>
                  <button
                    type="button"
                    className="btn ghost btn-xs"
                    onClick={refreshExitIp}
                    disabled={!running || exitIpLoading}
                    title="重新检测出口 IP"
                  >
                    {exitIpLoading ? "检测中…" : "刷新"}
                  </button>
                </div>
                <div className="card-body tight">
                  {!running ? (
                    <div className="text-xs text-muted">内核未运行</div>
                  ) : exitIpLoading && !exitIp ? (
                    <div className="text-xs text-muted">正在检测…</div>
                  ) : exitIp?.ip ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {/* 统一成行式（标签左 / 值右），与下方归属、运营商同一套对齐逻辑。
                          此前 IP 左对齐、下面两行右对齐，一张卡里两套对齐规则。 */}
                      <div className="exit-ip-row">
                        <span className="exit-ip-k">当前出口</span>
                        <button
                          type="button"
                          className="exit-ip-v is-ip"
                          onClick={() => {
                            navigator.clipboard?.writeText(exitIp.ip || "");
                            showToast("已复制出口 IP");
                          }}
                          title="点击复制"
                        >
                          {exitIp.ip}
                        </button>
                      </div>
                      {/* 归属 / 运营商改为单列行式（label 左 · 值右）：窄轨道下两列各约 70px，
                          「Japan · Tokyo」与「GSL Networks Pty LTD」断行位置不同，基线永远对不齐。
                          行式与侧栏 facts 的语言一致，值走 ellipsis + title 保留全量。 */}
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <div className="exit-ip-row">
                          <span className="exit-ip-k">归属</span>
                          <span
                            className="exit-ip-v"
                            title={[exitIp.country, exitIp.city].filter(Boolean).join(" · ")}
                          >
                            {[exitIp.country, exitIp.city].filter(Boolean).join(" · ") || "—"}
                          </span>
                        </div>
                        <div className="exit-ip-row">
                          <span className="exit-ip-k">运营商</span>
                          <span className="exit-ip-v" title={exitIp.isp || exitIp.org || ""}>
                            {exitIp.isp || exitIp.org || "—"}
                          </span>
                        </div>
                      </div>
                      {exitIp.as && (
                        <div className="text-xs text-muted" style={{ fontFamily: "var(--font-mono)" }}>
                          {exitIp.as}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <div className="text-xs text-muted">检测失败，请检查网络后重试</div>
                      <button type="button" className="btn ghost btn-xs" onClick={refreshExitIp}>
                        重试
                      </button>
                    </div>
                  )}

                  {/* 实时 + 累计流量：原为独立一张卡，并入后右栏少一张卡的高度 */}
                  <div className="rail-sep" />
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div className="exit-ip-row">
                      <span className="exit-ip-k">下载</span>
                      <span className={`exit-ip-v${downRate > 0 ? " down" : ""}`}>
                        {formatRate(downRate)}
                      </span>
                    </div>
                    <div className="exit-ip-row">
                      <span className="exit-ip-k">上传</span>
                      <span className={`exit-ip-v${upRate > 0 ? " up" : ""}`}>
                        {formatRate(upRate)}
                      </span>
                    </div>
                    <div className="exit-ip-row">
                      <span className="exit-ip-k">累计</span>
                      <span className="exit-ip-v is-total">
                        ↓ {formatBytes(download)} · ↑ {formatBytes(upload)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* 解锁状态：AI + 流媒体各 3 项。点击单项重测，标题栏按钮跑全量。
                  全量检测是串行外网探测，故不自动执行；结果随内核切换失效需手动重跑。 */}
              <div className="card">
                <div className="card-header no-border">
                  <div className="card-title text-base">解锁状态</div>
                  <button
                    type="button"
                    className="btn ghost btn-xs"
                    onClick={testAllUnlock}
                    disabled={!running || !!unlockBusy}
                    title="测试全部 12 项（串行，耗时较长）"
                  >
                    {unlockBusy === "__all__" ? "测试中…" : "全部测试"}
                  </button>
                </div>
                <div className="card-body tight">
                  {!running ? (
                    <div className="text-xs text-muted">内核未运行</div>
                  ) : (
                    /* v16 聚合式：品牌磁贴网格。原来 6 行「未测试」文字换成 6 个品牌图标，
                       未测试时整块去饱和，测出结果恢复品牌色 + 状态角标——一眼扫完。 */
                    <div className="unlock-grid">
                      {RAIL_UNLOCK_GROUPS.map((g) => (
                        <div key={g.key} className="unlock-row">
                          <div className="unlock-row-label">{g.label}</div>
                          <div className="unlock-tiles">
                            {g.ids.map(([id, name]) => {
                              const st = unlockMap[id];
                              const busy = unlockBusy === id || unlockBusy === "__all__";
                              const tested = !!(st && st.testedAt);
                              const ok = tested && st.ok;
                              const fail = tested && !st.ok && !!st.fail;
                              // 三态：已解锁 / 不支持 / 检测失败；未测为去饱和
                              const cls = busy ? "busy" : ok ? "ok" : fail ? "fail" : tested ? "no" : "idle";
                              const note = busy
                                ? "检测中"
                                : !tested
                                  ? "未测试"
                                  : ok
                                    ? st.region || st.note || "支持"
                                    : fail
                                      ? "检测失败"
                                      : st.note || "不支持";
                              return (
                                <button
                                  key={id}
                                  type="button"
                                  className={`unlock-tile ${cls}`}
                                  data-brand={id}
                                  onClick={() => testOneUnlock(id)}
                                  disabled={busy}
                                  title={`${name} · ${note}（点击检测）`}
                                  aria-label={`${name} · ${note}`}
                                >
                                  <span className="unlock-tile-mark">
                                    <BrandMark id={id} />
                                  </span>
                                  <span className="unlock-tile-name">{name}</span>
                                  <i className={`unlock-tile-dot ${cls}`} aria-hidden="true" />
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                      <div className="unlock-foot">
                        {t("unlock.footTip", "点图标单独检测 · 完整 12 项见「测试」页")}
                      </div>
                    </div>
                  )}
                </div>
              </div>

            </div>
          </div>
        </div>
      </div>

      {toast && (
        <div className="toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}

      <ConfirmDialog req={confirmReq} onClose={() => setConfirmReq(null)} />

      {homeCfgOpen && (
        <div className="modal-mask" onClick={closeHomeCfg}>
          <div className="modal-box home-cfg" ref={homeCfgBoxRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("home.configureCards", "自定义首页卡片")} onClick={(e) => e.stopPropagation()}>
            <div className="home-cfg-hd">
              <div>
                <div className="home-cfg-title">首页设置</div>
                <div className="home-cfg-sub">选择要在首页显示的卡片</div>
              </div>
              <button
                type="button"
                className="home-cfg-close"
                onClick={closeHomeCfg}
                aria-label="关闭"
              >
                <X size={16} />
              </button>
            </div>
            <div className="home-cfg-list">
              {[
                ["subscription", "订阅卡", "管理订阅链接"],
                ["node", "当前节点卡", "显示当前使用的节点"],
                ["network", "网络设置卡", "系统代理与端口"],
                ["mode", "代理模式卡", "规则/全局/直连切换"],
                ["traffic", "流量统计卡", "累计上下行流量"],
                ["core", "内核信息卡", "内核版本与运行状态"],
                ["system", "系统信息卡", "操作系统与运行模式"],
              ].map(([key, label, desc]) => {
                const on = !!(homeCfgDraft as any)[key];
                return (
                  <button
                    key={key}
                    type="button"
                    className={`home-cfg-item${on ? " on" : ""}`}
                    onClick={() => setHomeCfgDraft({ ...homeCfgDraft, [key]: !on })}
                  >
                    <span className="home-cfg-check">{on && <Check size={13} />}</span>
                    <span className="home-cfg-text">
                      <span className="home-cfg-label">{label}</span>
                      <span className="home-cfg-desc">{desc}</span>
                    </span>
                    <span className={`mini-switch${on ? " on" : ""}`} />
                  </button>
                );
              })}
            </div>
            <div className="home-cfg-ft">
              <button type="button" className="btn ghost" onClick={closeHomeCfg}>
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={async () => {
                  const next = { ...homeCfgDraft };
                  setHomeCards(next);
                  await window.veyra?.setSettings({ homeCards: next });
                  closeHomeCfg();
                }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 实时时钟：独立组件每秒 tick，避免整棵应用树跟着时间刷新重渲染 */
function LiveClock({ compact = false }: { compact?: boolean }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const time = now.toLocaleTimeString(getLocale(), { hour12: false });
  // 日期跟随应用语言（此前固定 en-US，中文界面里显示 "Oct 15, 2026" 混排）
  const date = now.toLocaleDateString(getLocale(), {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  // v13 紧凑版：右栏不再单开一张「系统时间」卡，时钟收进顶栏（时间本就属窗口级信息）
  if (compact) {
    return (
      <div className="header-clock" title={date}>
        {time}
      </div>
    );
  }
  return (
    <div className="time-display">
      <div className="time-label">系统时间</div>
      <div className="time-value">{time}</div>
      <div className="time-date">{date}</div>
    </div>
  );
}

/** 运行时长实时显示：同样每秒刷新，避免只在其它 state 变化时才更新 */
function LiveUptime({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <div className="text-sm font-mono">{formatUptime(Math.max(0, now - since))}</div>;
}
