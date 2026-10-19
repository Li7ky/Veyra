import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
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
  CalendarClock,
  Check,
  Clock,
  Copy,
  Database,
  Globe,
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
  Terminal,
  Trash2,
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
import Sparkline from "./Sparkline";
// Monaco 体积占主包的绝大部分（约 4.4MB）；改为懒加载，首屏 JS 解析时间大幅下降，
// 只有用户首次切到「YAML」子标签时才加载编辑器 chunk。
const YamlEditor = lazy(() => import("./YamlEditor"));
import { ProxiesVisualEditor, GroupsVisualEditor } from "./VisualEditors";
import { ipcErrorText } from "./errors";
import { stripFlagEmoji } from "./nodeName";
import ConnectOrb from "./ConnectOrb";
import HomePulse from "./HomePulse";
import ConfirmDialog, { useFocusTrap, type ConfirmRequest } from "./ConfirmDialog";
import { applyTheme, type ThemeMode } from "./theme";
import { getLocale, setLocale, t } from "./i18n";

type Tab = "home" | "proxies" | "profiles" | "connections" | "rules" | "logs" | "tests" | "settings";
type EnhanceKind = "merge" | "script" | "rules" | "proxies" | "groups";
type ExitIpInfo = {
  ip: string | null;
  /** true = 经系统代理检测，false = 直连检测（主进程按实际系统代理状态决定） */
  viaProxy?: boolean;
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
};

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

// 国家码规范化：只接受两位字母，其它一律返回空（不渲染徽标）
// 注意：不要用 flag emoji —— Windows 的 Segoe UI Emoji 不含国旗字形，
// 区域指示符会退回成两个字母方块，看起来就是乱码。
function countryBadge(code?: string) {
  const c = (code || "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : "";
}

function formatBytes(n = 0) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(2)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** 更新下载阶段 → 提示文案（代理/系统代理/直连/回退/校验） */
function updatePhaseText(phase: string): string {
  if (phase === "proxy") return t("update.phaseProxy", "正在通过本地代理下载…");
  if (phase === "sysproxy") return t("update.phaseSysProxy", "正在通过系统代理下载…");
  if (phase === "direct") return t("update.phaseDirect", "正在直连下载…");
  if (phase === "fallback") return t("update.phaseFallback", "代理不可用，正在改用直连…");
  if (phase === "done") return t("update.phaseDone", "下载完成，正在校验…");
  return "";
}

/** 订阅页顶部概览：所有订阅的剩余流量之和（没有流量信息的订阅跳过） */
function subsRemainingBytes(
  subs: { userinfo?: { upload: number; download: number; total: number } }[]
) {
  return subs.reduce((acc, s) => {
    const total = s.userinfo?.total || 0;
    if (!total) return acc;
    const used = (s.userinfo?.upload || 0) + (s.userinfo?.download || 0);
    return acc + Math.max(0, total - used);
  }, 0);
}

// 订阅卡片右侧的用量环（r=18）
const SUB_RING_R = 18;
const SUB_RING_C = 2 * Math.PI * SUB_RING_R;

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

function RailUptime({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const text =
    h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
      : `${m}:${String(sec).padStart(2, "0")}`;
  return (
    <span className="rail-uptime" title="已运行时长">
      <Clock size={11} aria-hidden="true" />
      <span className="rail-uptime-num">{text}</span>
    </span>
  );
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

/** 未来时间（订阅的下次更新时间），和 relativeTime 的方向相反 */
function untilText(ts?: number) {
  if (!ts) return "";
  const diff = ts - Date.now();
  if (diff <= 0) return t("time.dueNow", "即将");
  const min = Math.round(diff / 60000);
  if (min < 60) return t("time.inMinutes", "{n} 分钟后").replace("{n}", String(min));
  const h = Math.round(diff / 3600000);
  if (h < 24) return t("time.inHours", "{n} 小时后").replace("{n}", String(h));
  return t("time.inDays", "{n} 天后").replace("{n}", String(Math.round(h / 24)));
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
  // 只有数字没有单位会被误读成序号/跳数
  return `${Math.round(d)} ms`;
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

/** 节点旗帜：加载失败（离线/被墙）时回退成国家码，不显示破图 */
function NodeFlag({ name }: { name: string }) {
  const [failed, setFailed] = useState(false);
  const src = countryFlagSvg(name);
  if (!src || failed) {
    const code = COUNTRY_FLAGS.find(([re]) => re.test(name))?.[1] || "🌐";
    return <span className="px-flag-code">{code}</span>;
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      style={{
        width: 20,
        height: 14,
        borderRadius: 2,
        verticalAlign: "middle",
        boxShadow: "var(--shadow-sm)",
      }}
    />
  );
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

// 模式标签在调用时求值（而非模块加载时固化）：i18n 的 locale 是启动后
// 异步从设置回填的，模块级常量会在默认语言下被永久固化。
const MODE_LABEL = (m: string) =>
  m === "rule"
    ? t("home.modeRule", "Rule")
    : m === "global"
      ? t("home.modeGlobal", "Global")
      : m === "direct"
        ? t("home.modeDirect", "Direct")
        : m;

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

const TAB_IDS: Tab[] = ["home", "proxies", "profiles", "connections", "rules", "logs", "tests", "settings"];

export default function App() {
  const [tab, setTab] = useState<Tab>(() => {
    // 纯浏览器预览时允许 ?tab=proxies 直达某一页，方便逐页截图与调样式；正式构建无此入口。
    if (!import.meta.env.DEV) return "home";
    const q = new URLSearchParams(location.search).get("tab");
    return TAB_IDS.includes(q as Tab) ? (q as Tab) : "home";
  });
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
  // 首屏就绪：启动进度走完后再进主界面。时长固定，进度条和剩余时间才能对上。
  const [bootReady, setBootReady] = useState(false);
  const BOOT_MS = 1600;
  const bootAtRef = useRef(Date.now());
  const [bootLeft, setBootLeft] = useState(BOOT_MS);
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
  // 记住上次粘贴的订阅链接：重启后输入框不再是空的
  const [subUrl, setSubUrl] = useState(() => {
    try {
      return localStorage.getItem("veyra:lastSubUrl") || "";
    } catch {
      return "";
    }
  });
  const subUrlInputRef = useRef<HTMLInputElement | null>(null);
  // 无边框窗口拖动：部分 Windows 环境下 -webkit-app-region: drag 会失效，这里自己做一份
  const winDragRef = useRef(false);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!winDragRef.current) return;
      window.veyra?.windowDragMove?.(e.screenX, e.screenY);
    };
    const up = () => {
      if (!winDragRef.current) return;
      winDragRef.current = false;
      window.veyra?.windowDragEnd?.();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  /** 顶栏按下即开始拖窗；按钮 / 输入框 / 搜索区不参与 */
  const onHeaderMouseDown = (e: React.MouseEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const el = e.target as HTMLElement;
    if (el.closest("button, input, a, select, textarea, [contenteditable='true'], .header-search, .header-icons")) {
      return;
    }
    winDragRef.current = true;
    window.veyra?.windowDragStart?.(e.screenX, e.screenY);
  };
  // 订阅导入的进度（下载 / 解析），只在订阅页的导入条下方显示，不占全局横幅
  const [subProgress, setSubProgress] = useState<{ pct: number; label: string } | null>(null);
  // 「配置文件」列表默认收起，避免和订阅卡片重复占屏
  // 订阅卡片右键菜单
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; url: string; name: string } | null>(null);
  // 版本更新后弹一次的「本次更新内容」
  const [updateNotes, setUpdateNotes] = useState<{
    version: string;
    date?: string;
    title?: string;
    channel?: string;
    items: string[];
  } | null>(null);
  // 启动后主进程自动查到新版本 → 弹提醒；下载进度也在这里
  const [autoUpdate, setAutoUpdate] = useState<{
    latest: string;
    current?: string;
    assetSize?: number;
    htmlUrl?: string;
  } | null>(null);
  const [updPct, setUpdPct] = useState(-1);
  const [updBusy, setUpdBusy] = useState(false);
  // 安装包已下载、等待用户选择安装方式（覆盖 / 卸载重装）
  const [updReady, setUpdReady] = useState(false);
  // proxy | direct | fallback | done：让用户知道当前走的是哪条通道
  const [updPhase, setUpdPhase] = useState("");
  const [updMsg, setUpdMsg] = useState("");
  useEffect(() => {
    let alive = true;
    window.veyra
      ?.updateNotes?.()
      .then((r) => {
        if (!alive) return;
        if (r?.isNew && r.entry) {
          setUpdateNotes({
            version: r.entry.version,
            date: r.entry.date,
            title: r.entry.title,
            channel: r.entry.channel,
            items: r.entry.items || [],
          });
        } else if (r) {
          window.veyra?.markVersionSeen?.().catch(() => {});
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const closeUpdateNotes = () => {
    setUpdateNotes(null);
    window.veyra?.markVersionSeen?.().catch(() => {});
  };
  // 两个更新弹窗的 Esc 支持。自动更新弹窗在下载中被 updBusy 锁住，
  // 与点遮罩/关闭按钮的行为保持一致，避免中途取消掉正在进行的安装包下载。
  useEffect(() => {
    if (!autoUpdate && !updateNotes) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (updateNotes) {
        closeUpdateNotes();
        return;
      }
      if (autoUpdate && !updBusy) setAutoUpdate(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [autoUpdate, updateNotes, updBusy]);
  // 主进程启动 6s 后静默检查更新：有新版本就弹提醒；下载进度实时回填
  useEffect(() => {
    const offAvailable = window.veyra?.onUpdateAvailable?.((info) => {
      if (!info?.hasUpdate) return;
      setAutoUpdate({
        latest: info.latest,
        current: info.current,
        assetSize: info.assetSize,
        htmlUrl: info.htmlUrl,
      });
      setUpdPct(-1);
      setUpdBusy(false);
      setUpdMsg("");
    });
    const offProgress = window.veyra?.onUpdateProgress?.((p) => {
      if (!p) return;
      if (typeof p.pct === "number") setUpdPct(p.pct);
      if (typeof p.phase === "string") setUpdPhase(p.phase);
    });
    return () => {
      offAvailable?.();
      offProgress?.();
    };
  }, []);
  const startAppUpdate = async () => {
    setUpdBusy(true);
    setUpdMsg("");
    setUpdPct(-1);
    setUpdPhase("");
    setUpdReady(false);
    try {
      const r = await window.veyra!.downloadAppUpdate();
      if (r?.cancelled) {
        setUpdMsg(t("update.cancelled", "已取消下载"));
        setUpdPct(-1);
      } else if (r?.downloaded) {
        // 下载完成，交给用户选安装方式
        setUpdReady(true);
      } else if (r?.started) {
        setUpdMsg(t("update.started", "安装程序已启动，请按提示完成升级"));
      } else {
        setUpdMsg(t("update.latest", "已是最新版本"));
      }
    } catch (e) {
      setUpdMsg(
        t("update.failed", "下载失败：{msg}").replace("{msg}", ipcErrorText(e))
      );
    } finally {
      setUpdBusy(false);
      setUpdPhase("");
    }
  };
  const applyAppUpdate = async (mode: "overwrite" | "clean") => {
    try {
      await window.veyra!.installAppUpdate(mode);
      setUpdMsg(
        mode === "clean"
          ? t("update.reinstalling", "正在卸载并重新安装，请稍候…")
          : t("update.launching", "安装程序已启动，请按提示完成升级")
      );
      setUpdReady(false);
    } catch (e) {
      setUpdMsg(
        t("update.installFailed", "安装失败：{msg}").replace("{msg}", ipcErrorText(e))
      );
    }
  };
  useEffect(() => {
    if (!ctxMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ctxMenu]);
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
  const [exitIp, setExitIp] = useState<ExitIpInfo | null>(null);
  const [exitIpLoading, setExitIpLoading] = useState(false);
  // 最近一次成功检测的时间：卡片底部显示「更新于 HH:MM」，让读数有新鲜度
  const [exitIpAt, setExitIpAt] = useState(0);

  const [nodeUri, setNodeUri] = useState("");
  const [providers, setProviders] = useState<{ proxies: string[]; rules: string[] }>({
    proxies: [],
    rules: [],
  });
  const [editorMode, setEditorMode] = useState<"profile" | "runtime">("profile");
  const [bindTarget, setBindTarget] = useState<string | null>(null);
  // 首页卡片可见性（仅列出实际渲染并有配置弹窗开关的卡；
  // 主进程存储里的旧 homeCards 可能带多余键，spread 合并后无 UI 消费即无害）
  const [homeCards, setHomeCards] = useState({
    subscription: true,
    node: true,
    network: true,
    mode: true,
    traffic: true,
    core: true,
    system: true,
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
  // 规则数量：内核运行时从 /rules 取真实条数（之前只会在断开时置 null，从来没赋过值，
  // 所以首页永远显示 0）。切换订阅后 activeProfileUid 变化也会重新统计。
  const activeProfileUid = useMemo(
    () => richProfiles.find((p) => p.active)?.uid || "",
    [richProfiles]
  );
  useEffect(() => {
    if (!running) {
      setRuleCount(null);
      return;
    }
    let alive = true;
    window.veyra
      ?.listRules?.()
      .then((r) => {
        if (!alive) return;
        setRuleCount(Array.isArray(r?.rules) ? r.rules.length : 0);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [running, activeProfileUid]);

  // 订阅总用量：把每条订阅的 (上行+下行)/总量 汇总。
  // 首页订阅卡要把「已用」和「剩余」分开显示，所以这里同时给出三个数。
  const subUsage = (() => {
    let used = 0;
    let total = 0;
    for (const s of subs) {
      const u = s.userinfo;
      if (u && u.total > 0) {
        used += u.upload + u.download;
        total += u.total;
      }
    }
    return { used, total, left: Math.max(0, total - used) };
  })();
  const subUsagePct =
    subUsage.total > 0 ? Math.min(100, Math.round((subUsage.used / subUsage.total) * 100)) : null;
  // 「有真实流量」守卫：零流量时平线与贴底直线在视觉上都等同于「图表故障」。
  // 此前名 railHasTraffic 且只在侧栏版本使用，侧栏改版后成了死变量——
  // 首页流量图因此漏掉守卫，零流量画出贴底绿线。现统一由它兜底。
  const hasTraffic =
    rateHistory.down.some((v) => v > 0) || rateHistory.up.some((v) => v > 0);
  const [banner, setBanner] = useState("");
  const [homeCfgOpen, setHomeCfgOpen] = useState(false);
  const [homeCfgDraft, setHomeCfgDraft] = useState(homeCards);
  // 启动冲突模态对话框
  const [blockStartupOpen, setBlockStartupOpen] = useState(false);
  const [blockStartupData, setBlockStartupData] = useState<{
    conflicts: string[];
    severity: string;
    rawConflicts: Array<{ type: string; proc?: string; label: string; pids?: number[]; port?: number }>;
  } | null>(null);
  const [blockStartupKilling, setBlockStartupKilling] = useState(false);
  const [blockStartupMessage, setBlockStartupMessage] = useState("");
  // 危险操作（清理日志等）统一走二次确认弹窗
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);

  /**
   * 关闭外部系统代理并退出其它代理软件。
   * 破坏性操作：会杀掉用户正在用的 Clash Verge 等，必须经 ConfirmDialog 二次确认。
   */
  async function runResolveExternal() {
    setBlockStartupKilling(true);
    setBlockStartupMessage(t("conflict.blockStartupKilling", "正在停止外部系统代理并退出代理软件…"));
    try {
      const result = window.veyra?.resolveExternalProxy ? await window.veyra.resolveExternalProxy() : null;
      if (result?.ok) {
        const started = window.veyra?.retryStartAfterConflict
          ? await window.veyra.retryStartAfterConflict()
          : null;
        if (started?.ok) {
          setBlockStartupMessage(t("conflict.blockStartupSuccess", "系统代理已恢复正常，正在启动…"));
          setTimeout(() => setBlockStartupOpen(false), 1000);
        } else {
          setBlockStartupMessage(
            t("conflict.blockStartupCoreFailed", "系统代理已恢复，但 Veyra 内核启动失败，请重试")
          );
        }
      } else if (result?.conflicts && result.conflicts.length > 0) {
        setBlockStartupMessage(
          t("conflict.blockStartupStillConflict", "系统代理仍未恢复正常，请关闭外部代理的系统代理后重试")
        );
        setBlockStartupData((prev) => (prev ? { ...prev, conflicts: result.conflicts! } : prev));
      } else {
        setBlockStartupMessage(
          t("conflict.blockStartupKillFailed", "无法自动恢复系统代理，请手动关闭外部代理的系统代理后重试")
        );
      }
    } catch {
      setBlockStartupMessage(
        t("conflict.blockStartupKillFailed", "无法自动恢复系统代理，请手动关闭外部代理的系统代理后重试")
      );
    } finally {
      setBlockStartupKilling(false);
    }
  }
  // 首页系统信息卡的真实数据（此前版本硬编码「未启用 / v1.1 / Windows 10/11」）
  const [appVersion, setAppVersion] = useState("");
  const [platformLabel, setPlatformLabel] = useState("Windows");
  const [systemMem, setSystemMem] = useState(0);
  const [electronVersion, setElectronVersion] = useState("");
  const [startWithWindows, setStartWithWindows] = useState(false);
  const [mihomoChannel, setMihomoChannel] = useState("stable");

  // 首页设置弹窗：关闭时统一走 closeHomeCfg，保证焦点一定回到入口按钮
  const homeCfgTriggerRef = useRef<HTMLButtonElement | null>(null);
  // 焦点圈闭：Tab 不再逃到遮罩后的背景页面（Esc/关闭逻辑见下方 effect）
  const homeCfgBoxRef = useFocusTrap<HTMLDivElement>(homeCfgOpen);
  // 自动更新弹窗 / 更新日志弹窗同样带 role="dialog" aria-modal="true"，
  // 但原先既没有焦点圈闭也没有 Esc 关闭，键盘用户 Tab 会跑到遮罩后的页面上。
  // 与项目「模态框统一 useFocusTrap + Esc + 焦点回归」的约定保持一致。
  const autoUpdateBoxRef = useFocusTrap<HTMLDivElement>(!!autoUpdate);
  const updateNotesBoxRef = useFocusTrap<HTMLDivElement>(!!updateNotes);
  const closeHomeCfg = useCallback(() => {
    setHomeCfgOpen(false);
    // 关闭后焦点回到入口按钮；延迟一帧，等遮罩真正卸载再 focus
    window.requestAnimationFrame(() => homeCfgTriggerRef.current?.focus());
  }, []);

  const toastTimer = useRef<number | null>(null);
  const lastSeqRef = useRef(0);
  // 侧栏状态区：与首页信息表最后一行对齐（见 useLayoutEffect）
  const railStatusRef = useRef<HTMLElement | null>(null);
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

  // 启动页固定停留 BOOT_MS，进度和「还需几秒」按同一时钟走。
  useEffect(() => {
    const started = bootAtRef.current;
    const tick = () => {
      const left = Math.max(0, BOOT_MS - (Date.now() - started));
      setBootLeft(left);
      if (left <= 0) setBootReady(true);
    };
    tick();
    const id = window.setInterval(tick, 50);
    return () => window.clearInterval(id);
  }, []);

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

  // 窗口尺寸固定，不再需要「最大化状态」订阅（标题栏已无最大化按钮）

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
      // 已在目标页时直接返回：防止顶栏搜索逐字符触发重复 goTab
      // 叠加多个 setTimeout(refresh) 与多余 IPC
      if (tabRef.current === id) return;
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
    window.veyra.fullConflictScan?.().catch(() => {});
    let conflictToastTimer: ReturnType<typeof setTimeout> | null = null;
    // 冲突状态跟踪：根据严重度分级处理
    let lastSeverity: "none" | "medium" | "high" | "critical" = "none";
    const offConflict = window.veyra.onConflictDetected?.(({ items, severity }) => {
      if (severity === "medium") {
        // 仅进程层面无端口冲突——轻量提示，不打扰
        showToast(`检测到 ${items.join("、")} 正在运行，端口未冲突，可和平共处`, 4000);
        lastSeverity = "medium";
        return;
      }
      // high / critical —— toast 提示 + 横幅
      if (conflictToastTimer) return; // 节流避免重复通知
      const msg = severity === "critical"
        ? `检测到端口冲突：${items.join("、")}。Veyra 已暂停代理，冲突解除后将自动恢复。`
        : `检测到代理冲突：${items.join("、")}，建议只保留一个代理软件`;
      showToast(msg, severity === "critical" ? 10000 : 7000);
      lastSeverity = severity;
      conflictToastTimer = setTimeout(() => { conflictToastTimer = null; }, 15000);
      if (severity === "critical") {
        setBanner(`检测到端口冲突：${items.join("、")}。Veyra 已暂停代理，冲突解除后将自动恢复。`);
      }
    });
    const offResolved = window.veyra.onConflictResolved?.(({ autoRecover }) => {
      // 清理所有冲突类横幅
      setBanner((prev) => {
        if (prev.includes("检测到端口冲突") || prev.includes("检测到代理冲突") ||
            prev.includes("检测到其他代理软件") || prev.includes("系统代理被占用")) return "";
        return prev;
      });
      if (autoRecover && lastSeverity === "critical") {
        showToast("冲突已解除，Veyra 正在恢复代理...", 4000);
      } else if (lastSeverity !== "none") {
        showToast("代理冲突已消失", 3000);
      }
      lastSeverity = "none";
    });
    // 启动冲突拦截：显示模态对话框阻止启动
    const offBlockStartup = window.veyra.onConflictBlockStartup?.((data) => {
      setBlockStartupData(data);
      setBlockStartupOpen(true);
      setBlockStartupMessage("");
    });
    // 轻量提示（medium 级别进程检测、其他非关键提醒）
    const offNotice = window.veyra.onNotice?.(({ message }) => {
      showToast(message, 5000);
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
      // 订阅下载/解析单独走「导入条下方的细进度」，不再占用顶部的红色告警横幅
      // （红色横幅是给冲突/错误用的，正常导入时挂一条红条既吵又像出错）
      if (d.phase === "sub:download") {
        setSubProgress(d.pct >= 100 ? null : { pct: d.pct, label: d.label });
        return;
      }
      if (d.pct >= 100) {
        // 100% 是收尾事件：label 为空表示「只清横幅，别弹空 toast」（失败路径会自己弹错误 toast）
        setBanner("");
        if (d.label) showToast(d.label, 2000);
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
    // 存量订阅补流量：早期版本读不到响应头，老数据的 userinfo 是空的；
    // 启动时静默补一次，用户打开订阅页就能看到流量/到期，不用手动点刷新。
    window.veyra
      ?.refreshMissingSubInfo?.()
      .then((list) => {
        if (Array.isArray(list) && list.length) setSubs(list);
      })
      .catch(() => {});
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
        setElectronVersion(a?.electron || "");
        setSystemMem(a?.totalMem || 0);
        const rel = String(a?.osRelease || "");
        const build = Number(rel.split(".").pop()) || 0;
        const osName =
          a?.platform === "win32"
            ? build >= 22000
              ? "Windows 11"
              : "Windows 10"
            : a?.platform === "darwin"
              ? "macOS"
              : "Linux";
        const buildTag = a?.platform === "win32" && build ? ` ${build}` : "";
        setPlatformLabel(`${osName}${buildTag} · ${a?.arch || ""}`.trim());
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
      offBlockStartup?.();
      offNotice?.();
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

  // 侧栏状态区与首页信息表最后一行（运行环境 / 代理内核 / 实时流量）对齐。
  // 约束：
  //  1) 与上方导航至少留 24px 间距，不能贴在一起；
  //  2) 必须在开屏遮罩结束（bootReady）后再算——遮罩期间主界面还没挂载；
  //  3) 用「清空 margin → 测量 → 设定」的绝对值算法，再做一次残差修正，
  //     避免「当前 margin + delta」在重排后累积漂移。
  useLayoutEffect(() => {
    if (!bootReady || tab !== "home") return;
    const status = railStatusRef.current;
    if (!status) return;

    let raf = 0;
    const MIN_GAP = 24;
    const measure = () => {
      const table = document.querySelector<HTMLElement>(".home-sysinfo");
      const lastRow = status.querySelector<HTMLElement>(".rail-metrics li:last-child");
      if (!table || !lastRow) return null;
      const cells = table.querySelectorAll<HTMLElement>(".sysinfo-item");
      const lastCell = cells[cells.length - 1];
      if (!lastCell) return null;
      const a = lastRow.getBoundingClientRect();
      const b = lastCell.getBoundingClientRect();
      if (a.height < 1 || b.height < 1) return null;
      return { rowCenter: a.top + a.height / 2, cellCenter: b.top + b.height / 2 };
    };

    const align = () => {
      raf = 0;
      // 没有信息表：回到 CSS 的 24px 间距
      if (!document.querySelector(".home-sysinfo")) {
        status.style.marginTop = "";
        return;
      }
      // 先从基线量一次，得到基准位置
      status.style.marginTop = "";
      const base = parseFloat(getComputedStyle(status).marginTop) || MIN_GAP;
      let margin = base;
      // 多轮收敛：设完 margin 后布局可能有几像素反馈（卡片变高会带动整行重排），
      // 每轮用残差修正，最多 4 轮；正常 2 轮内就 < 1px。
      for (let i = 0; i < 4; i++) {
        const m = measure();
        if (!m) {
          status.style.marginTop = `${MIN_GAP}px`;
          return;
        }
        const resid = m.cellCenter - m.rowCenter;
        if (Math.abs(resid) < 1) break;
        margin = Math.max(MIN_GAP, Math.round(margin + resid));
        status.style.marginTop = `${margin}px`;
      }
      // 兜底：任何情况下不允许贴住导航
      if ((parseFloat(status.style.marginTop) || 0) < MIN_GAP) {
        status.style.marginTop = `${MIN_GAP}px`;
      }
    };

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(align);
    };
    align();
    window.addEventListener("resize", schedule);
    // 首帧之后字体/数据还可能把信息表往下推几像素（表格自身尺寸不变、只是位移），
    // ResizeObserver 捕捉不到，这里补两次延时重算；算法是绝对定位，重复执行无副作用。
    const t1 = window.setTimeout(schedule, 250);
    const t2 = window.setTimeout(schedule, 900);

    const ro = new ResizeObserver(schedule);
    ro.observe(status);
    const table = document.querySelector<HTMLElement>(".home-sysinfo");
    if (table) {
      ro.observe(table);
      const mo = new MutationObserver(schedule);
      mo.observe(table, { childList: true, subtree: true });
      return () => {
        window.removeEventListener("resize", schedule);
        clearTimeout(t1);
        clearTimeout(t2);
        ro.disconnect();
        mo.disconnect();
        if (raf) cancelAnimationFrame(raf);
      };
    }
    return () => {
      window.removeEventListener("resize", schedule);
      clearTimeout(t1);
      clearTimeout(t2);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [
    bootReady,
    tab,
    homeCards,
    platformLabel,
    systemMem,
    appVersion,
    electronVersion,
    mihomoChannel,
    running,
  ]);

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
        testAbortRef.current = null;
        setTesting(false);
        setTestingNode(null);
        setTestProgress(0);
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
  // 启动瞬间内核 / url-test 组还没选出可用节点，第一次探测经常失败，
  // 所以自动检测带重试；手动刷新单次失败就如实提示。
  // 用「代号」而不是 busy 锁：切系统代理时要立即用新网络重测，
  // 旧请求的结果直接作废，避免旧网络的结果覆盖新结果。
  const exitIpGenRef = useRef(0);
  const refreshExitIp = useCallback(
    async (opts: { retries?: number; silent?: boolean; reset?: boolean } = {}) => {
      const api = window.veyra?.exitIp;
      if (!api) return;
      const gen = ++exitIpGenRef.current;
      const retries = Math.max(0, opts.retries ?? 0);
      setExitIpLoading(true);
      // 路径变化时先清空旧值：渲染层会显示「正在检测…」而不是上一张网络的 IP
      if (opts.reset) setExitIp(null);
      let result: ExitIpInfo = { ip: null };
      try {
        for (let attempt = 0; attempt <= retries; attempt++) {
          if (attempt > 0) {
            // 2.5s 后第一次重试，之后每 4s 一次：覆盖机场 url-test 组启动测速的窗口
            await new Promise((r) => window.setTimeout(r, attempt === 1 ? 2500 : 4000));
          }
          if (gen !== exitIpGenRef.current) return;
          try {
            const r = await api();
            if (r?.ip) {
              result = r;
              break;
            }
            if (r) result = r;
          } catch {
            /* 单次失败交给下一轮 */
          }
        }
        if (gen !== exitIpGenRef.current) return;
        setExitIp(result);
        if (result.ip) setExitIpAt(Date.now());
        if (!result.ip && !opts.silent) showToast("IP 检测失败，请点击重试");
      } finally {
        if (gen === exitIpGenRef.current) setExitIpLoading(false);
      }
    },
    [showToast]
  );

  useEffect(() => {
    if (!running) return;
    // 等内核把配置/节点加载完再探；失败由 refreshExitIp 内部重试兜底
    const timer = window.setTimeout(() => {
      void refreshExitIp({ retries: 2, silent: true, reset: true });
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [running, refreshExitIp]);

  // 系统代理开/关会改变「当前网络」：切换后静默重测，避免卡片一直显示切换前的出口。
  const lastSysProxyRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (lastSysProxyRef.current === null) {
      lastSysProxyRef.current = sysProxy;
      return;
    }
    if (lastSysProxyRef.current === sysProxy) return;
    lastSysProxyRef.current = sysProxy;
    if (!running) return;
    void refreshExitIp({ silent: true, reset: true });
  }, [sysProxy, running, refreshExitIp]);

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
    showToast(`模式：${MODE_LABEL(m)}`);
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
    setSubProgress({ pct: 3, label: "正在连接订阅地址…" });
    try {
      const r = await window.veyra.importProfileUrl({ url: u, name: profileName });
      if (r.mixedPort) setMixedPort(r.mixedPort);
      if (r.controller) setController(r.controller);
      setProfileText(await window.veyra.readActiveProfile());
      await reloadProfileLists();
      setSubUrl(u);
      try {
        localStorage.setItem("veyra:lastSubUrl", u);
      } catch {
        // The imported subscription remains usable when browser storage is unavailable.
      }
      setEditUid(null);
      setEnhanceLog(r.warnings || []);
      showToast(`已导入「${r.name || "订阅"}」（${formatBytes(r.bytes || 0)}）`);
      await refresh();
    } catch (e) {
      showToast(String((e as Error).message || e));
    } finally {
      setBusy(false);
      setSubProgress(null);
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
    ["profiles", NavProfilesIcon, t("nav.profiles", "订阅"), subs.length || null],
    ["connections", NavConnectionsIcon, t("nav.connections", "连接"), connCount || null],
    ["rules", NavRulesIcon, t("nav.rules", "规则"), null],
    ["logs", NavLogsIcon, t("nav.logs", "日志"), null],
    ["tests", NavTestsIcon, t("nav.tests", "测试"), null],
    ["settings", NavSettingsIcon, t("nav.settings", "设置"), null],
  ] as const;

  // 侧栏导航项渲染：图标 / 文字 / 计数徽标三段式。
  // 文字用 .nav-label 吃 flex 余量（min-width:0 + ellipsis），徽标 flex:none 定宽，
  // 这样窄栏下宁可截断文字也不会把两个字拆成上下两行。
  const renderNavItem = ([id, Icon, label, badge]: (typeof navItems)[number]) => (
    <button
      key={id}
      type="button"
      className={`nav-item${tab === id ? " active" : ""}`}
      aria-current={tab === id ? "page" : undefined}
      onClick={() => goTab(id)}
    >
      <Icon />
      <span className="nav-label">{label}</span>
      {typeof badge === "number" && badge > 0 ? (
        <span className="badge badge-count">{badge > 99 ? "99+" : badge}</span>
      ) : null}
    </button>
  );

  // Before anything renders — show splash while booting
  if (!bootReady) {
    return (
      <div className="app boot-splash" onMouseDown={onHeaderMouseDown}>
        <div className="boot-stage">
          <div className="boot-mark">
            <span className="boot-glow" aria-hidden="true" />
            <svg
              viewBox="0 0 24 24"
              className="boot-logo"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon pathLength="1" points="12 2 21.5 8 21.5 16 12 22 2.5 16 2.5 8" />
              <polyline pathLength="1" points="7.6 10 12 14.6 16.4 10" />
              <circle cx="7.6" cy="10" r="1.9" fill="currentColor" stroke="none" />
              <circle cx="16.4" cy="10" r="1.9" fill="currentColor" stroke="none" />
              <circle cx="12" cy="14.6" r="1.9" fill="currentColor" stroke="none" />
            </svg>
          </div>
          <div className="boot-name">Veyra-omini</div>
          <div
            className="boot-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(((BOOT_MS - bootLeft) / BOOT_MS) * 100)}
            aria-label="启动进度"
          >
            <i className="boot-fill" style={{ width: `${((BOOT_MS - bootLeft) / BOOT_MS) * 100}%` }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`app ${busy ? "busy" : ""} ${running ? "is-on" : ""} ${sysProxy ? "proxy-on" : ""}`}>
      <div className="container">
        {/* Header */}
        <header className="header" onMouseDown={onHeaderMouseDown}>
          <div className="header-brand">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              width="30"
              height="30"
              style={{ color: "var(--cyan-500)" }}
            >
              <polygon points="12 2 21.5 8 21.5 16 12 22 2.5 16 2.5 8" />
              <polyline points="7.6 10 12 14.6 16.4 10" strokeWidth="1.5" />
              <circle cx="7.6" cy="10" r="1.9" fill="currentColor" stroke="none" />
              <circle cx="16.4" cy="10" r="1.9" fill="currentColor" stroke="none" />
              <circle cx="12" cy="14.6" r="1.9" fill="currentColor" stroke="none" />
            </svg>
            <span className="brand-text">Veyra-omini</span>
            {/* 用真实应用版本；之前硬编码 v1.1.2，升级后会与设置页显示的版本矛盾 */}
            <span className="brand-ver">{appVersion ? `v${appVersion.replace(/^v/, "")}` : "—"}</span>
            <span className="brand-beta">测试版</span>
          </div>
          <div className="header-actions">
            {/* v13：系统时间从右栏卡片收进顶栏——时间属窗口级信息，
                不值得在右栏独占一张卡（那会让右栏超出一屏）。 */}
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
              {/* 窗口尺寸固定：不再提供最大化/还原按钮 */}
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
            {/* 一张连续的侧栏面板：上部导航、下部状态页脚，中间一条通栏 hairline。
                两张卡叠在一起会读成「两个通用组件」；合成一张后它才像一条侧栏。 */}
            <div className="card side-nav">
              <div className="card-body tight">
                {/* 主功能 4 项 + 工具 4 项，中间一条细线分组。
                    156px 窄栏下「代理」曾被两位数字徽标挤成「代/理」两行。 */}
                <nav className="nav-list">
                  {navItems.slice(0, 4).map(renderNavItem)}
                  <div className="nav-sep" aria-hidden="true" />
                  {navItems.slice(4).map(renderNavItem)}
                </nav>

                {/* 状态页脚：点 + 状态字 + 右对齐运行时长。卡片里就这一件「实时」的事，
                    不再要「系统状态」这种冗余标题。 */}
                <section
                  ref={railStatusRef}
                  className={`rail-status${running ? " is-on" : ""}`}
                  aria-label={t("nav.sysStatus", "System status")}
                >
                  <div className="rail-status-head">
                    <i className="rail-status-dot" aria-hidden="true" />
                    <b>{running ? t("status.heroRunning", "运行中") : t("status.heroStopped", "已停止")}</b>
                    {running && coreStartTime ? <RailUptime startedAt={coreStartTime} /> : null}
                  </div>
                  <ul className="rail-metrics">
                    <li>
                      <span>{t("nav.proxy", "代理")}</span>
                      <i className="rail-leader" aria-hidden="true" />
                      <strong className={sysProxy ? "on" : ""}>
                        {sysProxy ? t("nav.on", "开启") : t("nav.off", "关闭")}
                      </strong>
                    </li>
                    <li>
                      <span>{t("nav.connections", "连接")}</span>
                      <i className="rail-leader" aria-hidden="true" />
                      <strong className={connCount > 0 ? "on" : ""}>{connCount}</strong>
                    </li>
                    <li>
                      <span>{t("nav.memory", "内存")}</span>
                      <i className="rail-leader" aria-hidden="true" />
                      <strong>{memText}</strong>
                    </li>
                    <li>
                      <span>{t("nav.core", "内核")}</span>
                      <i className="rail-leader" aria-hidden="true" />
                      <strong>{activeCore === "singbox" ? "sing-box" : "Mihomo"}</strong>
                    </li>
                  </ul>
                </section>
              </div>
            </div>
          </div>

          {/* Main Content */}
          <div className="col-main">
            <main className="stage">
              <div className="pane v-home" hidden={tab !== "home"}>
                  {/* 首屏常驻状态条：状态 / 速率 / 节点 / 延迟 / 连接 / 体检入口 */}
                  <HomePulse
                    running={running}
                    sysProxy={sysProxy}
                    downRate={downRate}
                    upRate={upRate}
                    connCount={connCount}
                    nodeName={currentNode}
                    delay={currentNodeInfo.delay}
                    nodeCount={nodes.length}
                    startedAt={coreStartTime}
                  />
                  {/* HERO · 连接状态 */}
                  <ConnectOrb
                    running={running}
                    sysProxy={sysProxy}
                    busy={busy}
                    mixedPort={mixedPort}
                    nodeName={currentNode}
                    onToggleProxy={toggleSysProxy}
                    onNodeClick={() => {
                      // 一键去代理页切节点，并选中当前节点所在分组
                      setTab("proxies");
                      const g = groups.find((x) => x.all?.includes(currentNode));
                      if (g?.name) setSelectedGroup(g.name);
                    }}
                    showNodeBlock={homeCards.node}
                    delay={currentNodeInfo.delay}
                    nodeCount={nodes.length}
                    nodeType={currentNodeInfo.type}
                    meta={
                      running ? (
                        <span>{activeCore === "singbox" ? "sing-box" : "Mihomo"}</span>
                      ) : null
                    }
                  />

                  {/* 实时流量 */}
                  <section className="v-traffic">
                    <header className="v-traffic-hd">
                      <div className="v-traffic-title">
                        <h3>{t("home.realtimeTraffic", "实时流量")}</h3>
                        <span>
                          {MODE_LABEL(mode)} · {nodes.length}{" "}
                          {t("home.nodesAvailable", "节点可用")}
                        </span>
                      </div>
                      <button
                        ref={homeCfgTriggerRef}
                        type="button"
                        className="btn ghost btn-xs"
                        onClick={() => {
                          setHomeCfgDraft(homeCards);
                          setHomeCfgOpen(true);
                        }}
                        title={t("home.configureCards", "自定义首页卡片")}
                        aria-haspopup="dialog"
                      >
                        <SlidersHorizontal size={12} />
                        {t("home.configureCards", "自定义首页卡片")}
                      </button>
                    </header>

                    <div className="v-traffic-rates">
                      <div className="v-rate">
                        <span className="v-rate-k">
                          <i className="v-arrow down" aria-hidden="true" />{" "}
                          {t("home.download", "下载")}
                        </span>
                        <span className={`v-rate-v down${downRate > 0 ? "" : " is-zero"}`}>
                          {formatRate(downRate)}
                        </span>
                      </div>
                      <div className="v-rate">
                        <span className="v-rate-k">
                          <i className="v-arrow up" aria-hidden="true" />{" "}
                          {t("home.upload", "上传")}
                        </span>
                        <span className={`v-rate-v up${upRate > 0 ? "" : " is-zero"}`}>
                          {formatRate(upRate)}
                        </span>
                      </div>
                      <div className="v-rate v-rate-conn">
                        <span className="v-rate-k">{t("home.activeConnections", "活跃连接")}</span>
                        <span className={`v-rate-v${connCount > 0 ? "" : " is-zero"}`}>
                          {connCount}
                        </span>
                      </div>
                    </div>

                    <div className="v-chart">
                      <WaveChart
                        up={hasTraffic ? rateHistory.up : []}
                        down={hasTraffic ? rateHistory.down : []}
                        empty={!hasTraffic}
                      />
                      {!hasTraffic ? (
                        <span className={`v-chart-live${running ? " on" : ""}`}>
                          <i aria-hidden="true" />
                          {running
                            ? t("home.listening", "监听中 · 暂无流量")
                            : t("nav.serviceNotRunning", "服务未运行")}
                        </span>
                      ) : null}
                      <div className="v-chart-axis" aria-hidden="true">
                        <span>60s</span>
                        <span>45s</span>
                        <span>30s</span>
                        <span>15s</span>
                        <span>{t("home.now", "现在")}</span>
                      </div>
                    </div>
                  </section>

                  {/* 规则 / 模式 / 订阅 */}
                  {(homeCards.core || homeCards.mode || homeCards.subscription) && (
                    <div className="v-tiles">
                      {homeCards.core && (
                        <section className="v-tile">
                          <header className="v-tile-hd">
                            <span>{t("home.rules", "规则数量")}</span>
                            <button
                              type="button"
                              className="link-btn"
                              onClick={() => goTab("rules")}
                            >
                              {ruleCount != null ? t("home.view", "查看") : t("home.goAdd", "去添加")} →
                            </button>
                          </header>
                          <div className={`v-tile-v${ruleCount != null ? "" : " is-zero"}`}>
                            {ruleCount != null ? ruleCount : 0}
                          </div>
                          <footer className="v-tile-sub">
                            {ruleCount != null
                              ? t("home.ruleCount", "条规则（来自当前订阅）")
                              : t("home.noRulesHint", "未连接内核，暂无法统计")}
                          </footer>
                        </section>
                      )}

                      {homeCards.mode && (
                        <section className="v-tile">
                          <header className="v-tile-hd">
                            <span>{t("home.mode", "代理模式")}</span>
                          </header>
                          <div className="v-tile-v">{MODE_LABEL(mode)}</div>
                          <div className="v-seg">
                            {(["rule", "global", "direct"] as const).map((m) => (
                              <button
                                key={m}
                                type="button"
                                className={`v-seg-btn${mode === m ? " on" : ""}`}
                                onClick={() => changeMode(m)}
                                disabled={!running}
                              >
                                {MODE_LABEL(m)}
                              </button>
                            ))}
                          </div>
                        </section>
                      )}

                      {homeCards.subscription && (
                        <section className="v-tile">
                          <header className="v-tile-hd">
                            <span>{t("home.subscriptions", "订阅")}</span>
                            <button
                              type="button"
                              className="link-btn"
                              onClick={() => goTab("profiles")}
                            >
                              {t("home.manage", "管理")} →
                            </button>
                          </header>
                          <div className={`v-tile-v${subs.length ? "" : " is-zero"}`}>
                            {subs.length}
                            <em className="v-tile-unit">{t("home.subsUnit", "个订阅")}</em>
                          </div>
                          {subUsage.total > 0 ? (
                            <div className="v-quota">
                              <div className="v-quota-split">
                                <span>
                                  <i>{t("home.usedLabel", "已用")}</i>
                                  {formatBytes(subUsage.used)}
                                </span>
                                <span>
                                  <i>{t("home.leftLabel", "剩余")}</i>
                                  {formatBytes(subUsage.left)}
                                </span>
                              </div>
                              <div className="v-quota-bar" aria-hidden="true">
                                <i style={{ width: `${subUsagePct}%` }} />
                              </div>
                            </div>
                          ) : (
                            <footer className="v-tile-sub">
                              {subs.length
                                ? t("home.noQuota", "未返回流量信息")
                                : t("home.noSubs", "还没有订阅")}
                            </footer>
                          )}
                        </section>
                      )}
                    </div>
                  )}

                  {/* 运行环境 */}
                  {(homeCards.system || homeCards.traffic) && (
                    <div className="v-sysinfo">
                      {homeCards.system && platformLabel ? (
                        <div className="v-si">
                          <span>{t("home.sysOs", "系统")}</span>
                          <b title={platformLabel}>{platformLabel}</b>
                        </div>
                      ) : null}
                      {homeCards.system && systemMem > 0 ? (
                        <div className="v-si">
                          <span>{t("home.sysMem", "内存")}</span>
                          <b>{formatBytes(systemMem)}</b>
                        </div>
                      ) : null}
                      {homeCards.system && appVersion ? (
                        <div className="v-si">
                          <span>{t("home.sysApp", "Veyra")}</span>
                          <b title={`v${appVersion.replace(/^v/, "")}`}>
                            v{appVersion.replace(/^v/, "")}
                            {appVersion.includes("beta") ? (
                              <em className="v-si-tag">{t("home.betaTag", "测试版")}</em>
                            ) : null}
                          </b>
                        </div>
                      ) : null}
                      {homeCards.system && electronVersion ? (
                        <div className="v-si">
                          <span>{t("home.sysRuntime", "运行环境")}</span>
                          <b>Tauri {electronVersion.replace(/^Tauri\s*/i, "")}</b>
                        </div>
                      ) : null}
                      {homeCards.system && mihomoChannel ? (
                        <div className="v-si">
                          <span>{t("home.sysCore", "代理内核")}</span>
                          <b>
                            Mihomo
                            {running ? t("home.sysCoreOn", " · 运行中") : t("home.sysCoreOff", " · 已停止")}
                          </b>
                        </div>
                      ) : null}
                      {homeCards.traffic ? (
                        <div className="v-si">
                          <span>{t("home.sysTraffic", "实时流量")}</span>
                          <b>
                            ↓ {formatBytes(download)} · ↑ {formatBytes(upload)}
                          </b>
                        </div>
                      ) : null}
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
                              <small>
                                {g.now && !isInfoNode(g.now) ? stripFlagEmoji(g.now) : g.type}
                              </small>
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
                    // 没有代理组时上面已经给了「导入配置」的唯一空态，不再叠加第二句
                    groups.length ? <div className="empty">{t("proxies.noNodes", "No nodes to display")}</div> : null
                  ) : (
                    <div className={`px-grid density-${nodeDensity}`}>
                      {sortedNodes.slice(0, pxNodeLimit).map((n) => {
                        // 优先用本次会话的测速结果；没有则回落到内核 history（重启后不必重新测一遍才有数字）
                        const histDelay = proxyMap[n]?.history?.slice(-1)[0]?.delay;
                        const d = typeof delays[n] === "number" ? delays[n] : histDelay;
                        const cls = delayClass(d);
                        const active = currentGroup?.now === n;
                        const isBest = bestNode?.name === n;
                        const info = proxyMap[n];
                        const ptype =
                          info?.type || (GROUP_TYPES.has(info?.type || "") ? info?.type : "") || "";
                        const isGroup = GROUP_TYPES.has(info?.type || "");
                        const hist = delayHistory[n]?.slice(-15) || [];
                        const maxMs = Math.max(...hist.map((h) => (h.ms > 0 ? h.ms : 0)), 50);
                        const displayName = stripFlagEmoji(n);
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
                              <NodeFlag name={n} />
                            </span>
                            <span className={`px-dot ${active ? "on" : ""}`} />
                            <span className="px-card-main">
                              <span className="px-card-name" title={n}>
                                {displayName}
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
                                if (h?.length) {
                                  return h
                                    .slice(-5)
                                    .reverse()
                                    .map(
                                      (r) =>
                                        `${new Date(r.t).toLocaleString(getLocale(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}: ${r.ms}ms`
                                    )
                                    .join("\n");
                                }
                                // 本次会话还没测过：显示内核缓存的上次结果，而不是「暂无」
                                if (typeof histDelay === "number") {
                                  return `${t("proxies.lastDelay", "上次延迟")}: ${histDelay > 0 ? `${histDelay}ms` : t("delay.timeout", "超时")}`;
                                }
                                return t("proxies.noDelayHistory", "No delay history");
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
                      <div className="subs-page">
                      {/* ── 顶部 Hero：概览 + 导入 ─────────────────────── */}
                      <section className="subs-hero">
                        <span className="subs-hero-orb subs-hero-orb-a" aria-hidden="true" />
                        <span className="subs-hero-orb subs-hero-orb-b" aria-hidden="true" />
                        <div className="subs-hero-body">
                          <div className="subs-hero-copy">
                            <h2>{t("profiles.heroTitle", "订阅")}</h2>
                            <p>{t("profiles.importDesc", "粘贴 Clash / Meta 订阅链接，导入后自动增强并应用。")}</p>
                          </div>
                          <div className="subs-hero-stats">
                            <div className="subs-stat">
                              <b>{subs.length}</b>
                              <span>{t("profiles.subCountUnit", "个订阅")}</span>
                            </div>
                            <span className="subs-stat-div" aria-hidden="true" />
                            <div className="subs-stat">
                              <b>{subsRemainingBytes(subs) > 0 ? formatBytes(subsRemainingBytes(subs)) : "—"}</b>
                              <span>{t("profiles.totalLeft", "剩余流量")}</span>
                            </div>
                          </div>
                        </div>
                        <div className="subs-importbar">
                          <Link2 size={15} className="subs-importbar-ico" />
                          <input
                            ref={subUrlInputRef}
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
                            className="btn primary"
                            disabled={busy}
                            onClick={() => void importFromUrl()}
                          >
                            {busy ? t("profiles.importing", "导入中…") : t("profiles.importBtn", "导入")}
                          </button>
                        </div>
                        {subProgress && (
                          <div className="subs-progress" role="status" aria-live="polite">
                            <span className="subs-progress-dot" aria-hidden="true" />
                            <span className="subs-progress-label">{subProgress.label}</span>
                            <span className="subs-progress-track">
                              <i style={{ width: `${Math.max(6, subProgress.pct)}%` }} />
                            </span>
                            <b className="subs-progress-pct">{subProgress.pct}%</b>
                          </div>
                        )}
                      </section>

                      {/* ── 订阅列表 ───────────────────────────────────── */}
                      <section className="subs-section">
                        <div className="subs-section-hd">
                          <h2>
                            {t("profiles.subscriptions", "订阅")}
                            <span className="subs-section-count">{subs.length}</span>
                          </h2>
                          <button
                            type="button"
                            className="btn ghost btn-sm"
                            disabled={!subs.length || busy}
                            onClick={() => void updateSubscriptions()}
                          >
                            <RefreshCw size={13} />
                            {t("profiles.updateAll", "全部更新")}
                          </button>
                        </div>
                        {!subs.length ? (
                          <div className="subs-empty">
                            <Globe size={22} />
                            <p>{t("profiles.noSubs", "暂无订阅 · 在上面粘贴链接导入")}</p>
                          </div>
                        ) : (
                          <div className="subs-grid">
                            {subs.map((s) => {
                              const upload = s.userinfo?.upload || 0;
                              const download = s.userinfo?.download || 0;
                              const used = upload + download;
                              const total = s.userinfo?.total || 0;
                              const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
                              const left = Math.max(0, total - used);
                              const expireTs = s.userinfo?.expire || 0;
                              const expireDate = expiryText(expireTs);
                              const daysLeft =
                                expireTs > 0
                                  ? Math.max(0, Math.ceil((expireTs * 1000 - Date.now()) / 86400000))
                                  : null;
                              const tone = pct >= 90 ? " is-danger" : pct >= 70 ? " is-warn" : "";
                              const host = s.url.replace(/^https?:\/\//, "").split("/")[0];
                              const initial = (s.name || host || "S").trim().charAt(0).toUpperCase();
                              // 关联到档案：拿 uid / 是否当前激活，用于卡片上直接切换
                              const prof = richProfiles.find(
                                (p) => p.type === "remote" && p.url === s.url
                              );
                              const isActive = !!prof?.active;
                              return (
                                <article
                                  key={s.url}
                                  className={`sub-card-x${tone}`}
                                  onContextMenu={(e) => {
                                    e.preventDefault();
                                    const x = Math.min(e.clientX, window.innerWidth - 224);
                                    const y = Math.min(e.clientY, window.innerHeight - 272);
                                    setCtxMenu({ x, y, url: s.url, name: s.name });
                                  }}
                                >
                                  <div className="sub-card-x-top">
                                    <span className="sub-card-x-avatar" aria-hidden="true">
                                      {initial}
                                    </span>
                                    <div className="sub-card-x-id">
                                      <h3 title={s.url}>{s.name}</h3>
                                      <span title={s.url}>{s.url.replace(/^https?:\/\//, "")}</span>
                                    </div>
                                    <div className="sub-card-x-tools">
                                      {isActive ? (
                                        <span className="sub-card-x-active" title="当前正在使用的订阅">
                                          <Check size={11} />
                                          {t("profiles.inUse", "当前使用")}
                                        </span>
                                      ) : prof?.uid ? (
                                        <button
                                          type="button"
                                          className="sub-card-x-switch"
                                          title="切换到这个订阅"
                                          onClick={async () => {
                                            try {
                                              await window.veyra?.activateProfile?.(prof.uid!);
                                              await reloadProfileLists();
                                              await refresh();
                                              showToast(
                                                `${t("profiles.switchedTo", "已切换到")}「${s.name}」`
                                              );
                                            } catch (e) {
                                              showToast(String((e as Error).message || e));
                                            }
                                          }}
                                        >
                                          {t("profiles.switchTo", "切换")}
                                        </button>
                                      ) : null}
                                      <button
                                        type="button"
                                        className="sub-card-x-icon"
                                        title={t("profiles.refreshSub", "更新此订阅")}
                                        aria-label={t("profiles.refreshSub", "更新此订阅")}
                                        onClick={() => {
                                          setSubUrl(s.url);
                                          void importFromUrl(s.url);
                                        }}
                                      >
                                        <RefreshCw size={14} />
                                      </button>
                                      <button
                                        type="button"
                                        className="sub-card-x-icon is-danger"
                                        title={t("profiles.deleteSub", "删除订阅")}
                                        aria-label={t("profiles.deleteSub", "删除订阅")}
                                        onClick={() =>
                                          setConfirmReq({
                                            title: t("profiles.deleteSub", "删除订阅"),
                                            message: `将删除「${s.name}」及其配置文件，此操作不可撤销。`,
                                            confirmText: "删除",
                                            danger: true,
                                            onConfirm: async () => {
                                              await window.veyra?.removeSubscription?.(s.url);
                                              // 删掉的正好是输入框里那条 → 一起清掉，别留个失效链接
                                              if (subUrl.trim() === s.url) {
                                                setSubUrl("");
                                                try {
                                                  localStorage.removeItem("veyra:lastSubUrl");
                                                } catch {
                                                  // The subscription has already been removed from the app.
                                                }
                                              }
                                              await reloadProfileLists();
                                              await refresh();
                                              showToast(`已删除「${s.name}」`);
                                            },
                                          })
                                        }
                                      >
                                        <Trash2 size={14} />
                                      </button>
                                    </div>
                                  </div>

                                  <div className="sub-card-x-metrics">
                                    <div className="sub-card-x-used">
                                      {total > 0 ? formatBytes(used) : "—"}
                                      <span>/ {total > 0 ? formatBytes(total) : "—"}</span>
                                    </div>
                                    <span className={`sub-card-x-pct${tone}`}>
                                      {total > 0 ? Math.round(pct) : "—"}
                                      <i>%</i>
                                    </span>
                                  </div>

                                  <div className={`sub-card-x-rail${total > 0 ? "" : " is-empty"}`}>
                                    <i style={{ width: `${pct}%` }} />
                                  </div>

                                  <div className="sub-card-x-stats">
                                    {total > 0 ? (
                                      <>
                                        <span title={t("profiles.upload", "上传")}>
                                          <ArrowUp size={11} />
                                          {formatBytes(upload)}
                                        </span>
                                        <span title={t("profiles.download", "下载")}>
                                          <ArrowDown size={11} />
                                          {formatBytes(download)}
                                        </span>
                                        <span className="sub-card-x-gap" />
                                        <span>
                                          {t("profiles.remaining", "剩余")} {formatBytes(left)}
                                        </span>
                                      </>
                                    ) : (
                                      <span className="is-muted">
                                        {t("profiles.noTraffic", "未提供流量信息")}
                                      </span>
                                    )}
                                  </div>

                                  <div className="sub-card-x-foot">
                                    <span>
                                      {t("profiles.updatedAt", "更新于")} {relativeTime(s.updatedAt)}
                                    </span>
                                    {s.nextUpdateAt ? (
                                      <span>
                                        {t("profiles.nextUpdate", "下次")} {untilText(s.nextUpdateAt)}
                                      </span>
                                    ) : null}
                                    {expireDate ? (
                                      <span
                                        className={`sub-card-x-expire${
                                          daysLeft !== null && daysLeft <= 7 ? " is-soon" : ""
                                        }`}
                                      >
                                        {t("profiles.expires", "到期")} {expireDate}
                                        {daysLeft !== null
                                          ? ` · ${t("profiles.daysLeft", "剩 {n} 天").replace("{n}", String(daysLeft))}`
                                          : ""}
                                      </span>
                                    ) : null}
                                  </div>
                                </article>
                              );
                            })}
                          </div>
                        )}
                      </section>

                      </div>
                    </div>
                  ) : null}

                  {(pfSeen.enhance || pfTab === "enhance") ? (
                    <div className="pf-pane" hidden={pfTab !== "enhance"}>
                      <section className="pf-sec">
                        <div className="pf-sec-hd">
                          <h2>
                            <Layers3 size={15} />
                            增强配置
                            <span className="pf-sec-count">
                              {richProfiles.filter((p) => p.type !== "remote" && p.type !== "local").length}
                            </span>
                          </h2>
                          <div className="pf-sec-actions">
                            <button
                              type="button"
                              className="btn primary btn-sm"
                              disabled={busy}
                              onClick={() => void applyEnhance()}
                            >
                              应用增强
                            </button>
                            <button type="button" className="btn ghost btn-sm" onClick={() => void reloadProviders()}>
                              刷新 Provider
                            </button>
                          </div>
                        </div>
                        <div className="pf-sec-body">
                          <p className="pf-sec-desc">
                            增强文件在内核启动或「应用增强」时叠加到当前订阅：merge 合并字段、script 脚本改写、
                            rules 追加规则、proxies / groups 追加节点与分组。
                          </p>
                          <div className="pf-create">
                            <span className="pf-create-label">新建</span>
                            {(["merge", "script", "rules", "proxies", "groups"] as const).map((kind) => (
                              <button
                                key={kind}
                                type="button"
                                className="pf-chip-btn"
                                disabled={busy}
                                onClick={() => void createEnhance(kind)}
                              >
                                <Plus size={12} />
                                {kind}
                              </button>
                            ))}
                            <button
                              type="button"
                              className="pf-chip-btn"
                              disabled={busy}
                              onClick={() => void createEnhance("merge", true)}
                            >
                              <Plus size={12} />
                              全局 Merge
                            </button>
                          </div>

                          {richProfiles.filter((p) => p.type !== "remote" && p.type !== "local").length ? (
                            <div className="pf-rows">
                              {richProfiles
                                .filter((p) => p.type !== "remote" && p.type !== "local")
                                .map((p) => (
                                  <div className="pf-row" key={p.uid}>
                                    <span className={`pf-row-badge is-${p.type}`}>{p.type}</span>
                                    <div className="pf-row-main">
                                      <b>{p.name}</b>
                                      <span>
                                        {p.global ? "全局 · " : ""}
                                        {p.enabled === false ? "已停用" : "启用中"}
                                      </span>
                                    </div>
                                    <div className="pf-row-actions">
                                      <button
                                        type="button"
                                        className="btn ghost btn-sm"
                                        onClick={async () => {
                                          const txt = await window.veyra?.readProfile?.(p.uid);
                                          if (txt == null) return;
                                          setEditUid(p.uid);
                                          setProfileName(p.name);
                                          setProfileText(txt);
                                          setEditorMode("profile");
                                          setPfTab("yaml");
                                        }}
                                      >
                                        编辑
                                      </button>
                                      <button
                                        type="button"
                                        className="pf-row-icon"
                                        title="删除"
                                        aria-label="删除"
                                        onClick={() =>
                                          setConfirmReq({
                                            title: "删除增强文件",
                                            message: `将删除「${p.name}」，该文件不再参与增强。此操作不可撤销。`,
                                            confirmText: "删除",
                                            danger: true,
                                            onConfirm: async () => {
                                              await window.veyra?.deleteProfile?.(p.uid);
                                              await reloadProfileLists();
                                              // 正在编辑的正是这个文件时，清掉编辑器状态，
                                              // 否则「保存」会往已删除的 uid 里写
                                              if (editUid === p.uid) {
                                                setEditUid(null);
                                                setProfileName("subscription.yaml");
                                                setProfileText("");
                                              }
                                              showToast(`已删除 ${p.name}`);
                                            },
                                          })
                                        }
                                      >
                                        <Trash2 size={13} />
                                      </button>
                                    </div>
                                  </div>
                                ))}
                            </div>
                          ) : (
                            <div className="pf-empty">
                              <Layers3 size={18} />
                              <p>还没有增强文件 · 用上面的按钮创建 merge / script / rules 等</p>
                            </div>
                          )}
                        </div>
                      </section>
                  {bindTarget ? (
                    <section className="pf-sec">
                      <div className="pf-sec-hd">
                        <h2>订阅绑定扩展</h2>
                        <span className="pf-sec-tag">{bindTarget.slice(0, 8)}</span>
                      </div>
                      <div className="pf-sec-body">
                        <p className="pf-sec-desc">
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
                      </div>
                    </section>
                  ) : null}

                  {providers.proxies.length || providers.rules.length ? (
                    <section className="pf-sec">
                      <div className="pf-sec-hd">
                        <h2>远程配置</h2>
                        <span className="pf-sec-count">{providers.proxies.length + providers.rules.length}</span>
                      </div>
                      <div className="pf-sec-body">
                        <div className="pf-rows">
                          {providers.proxies.map((n) => (
                            <div key={`pp-${n}`} className="pf-row">
                              <span className="pf-row-badge is-proxies">proxy</span>
                              <div className="pf-row-main">
                                <b>{n}</b>
                                <span>proxy-provider</span>
                              </div>
                              <div className="pf-row-actions">
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
                            </div>
                          ))}
                          {providers.rules.map((n) => (
                            <div key={`rp-${n}`} className="pf-row">
                              <span className="pf-row-badge is-rules">rule</span>
                              <div className="pf-row-main">
                                <b>{n}</b>
                                <span>rule-provider</span>
                              </div>
                              <div className="pf-row-actions">
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
                            </div>
                          ))}
                        </div>
                      </div>
                    </section>
                  ) : null}

                  {enhanceLog.length ? (
                    <section className="pf-sec">
                      <div className="pf-sec-hd">
                        <h2>增强日志</h2>
                        <span className="pf-sec-count">{enhanceLog.length}</span>
                      </div>
                      <div className="pf-sec-body">
                        <pre className="term-body" style={{ maxHeight: 160 }}>
                          {enhanceLog.join("\n")}
                        </pre>
                      </div>
                    </section>
                  ) : null}

                  {/* 本地配置（type=local）不是订阅，订阅页不再列「配置文件」，
                      挪到这里保留入口：激活 / 编辑 YAML */}
                  {richProfiles.some((p) => p.type === "local") ? (
                    <section className="pf-sec">
                      <div className="pf-sec-hd">
                        <h2>
                          <Layers3 size={15} />
                          本地配置
                          <span className="pf-sec-count">
                            {richProfiles.filter((p) => p.type === "local").length}
                          </span>
                        </h2>
                      </div>
                      <div className="pf-sec-body">
                        <div className="pf-rows">
                          {richProfiles
                            .filter((p) => p.type === "local")
                            .map((p) => (
                              <div className="pf-row" key={p.uid}>
                                <span className="pf-row-badge is-local">local</span>
                                <div className="pf-row-main">
                                  <b>{p.name}</b>
                                  <span>{p.active ? "当前使用" : "本地 YAML 配置"}</span>
                                </div>
                                <div className="pf-row-actions">
                                  {!p.active ? (
                                    <button
                                      type="button"
                                      className="btn ghost btn-sm"
                                      onClick={async () => {
                                        await window.veyra?.activateProfile?.(p.uid);
                                        await applyEnhance();
                                        await reloadProfileLists();
                                        showToast(`已激活「${p.name}」`);
                                      }}
                                    >
                                      激活
                                    </button>
                                  ) : null}
                                  <button
                                    type="button"
                                    className="btn ghost btn-sm"
                                    onClick={async () => {
                                      const txt = await window.veyra?.readProfile?.(p.uid);
                                      if (txt == null) return;
                                      setEditUid(p.uid);
                                      setProfileName(p.name);
                                      setProfileText(txt);
                                      setEditorMode("profile");
                                      setPfTab("yaml");
                                    }}
                                  >
                                    编辑
                                  </button>
                                </div>
                              </div>
                            ))}
                        </div>
                      </div>
                    </section>
                  ) : null}
                    </div>
                  ) : null}

                  {pfSeen.nodes ? (
                    <div className="pf-pane" hidden={pfTab !== "nodes"}>
                      <ProxiesVisualEditor onToast={showToast} onBusy={setBusy} />
                      <GroupsVisualEditor onToast={showToast} onBusy={setBusy} />
                    </div>
                  ) : null}

                  {pfSeen.yaml ? (
                    <section className="pf-sec pf-yaml-card" hidden={pfTab !== "yaml"}>
                      <div className="pf-sec-hd">
                        <h2>
                          <Terminal size={15} />
                          YAML 编辑器
                          <span className="pf-sec-count">
                            {editorMode === "runtime" ? "runtime" : editUid ? "编辑中" : "新建"}
                          </span>
                        </h2>
                        <div className="yaml-bar">
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
                            className="btn primary btn-sm"
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
                      </div>
                      <div className="pf-yaml-body">
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
                      </div>
                    </section>
                  ) : null}
                </div>

              {/* 保留挂载（hidden 切换）：切页不卸载组件，编辑中的规则草稿/滚动位置不丢 */}
              <div className="pane" hidden={tab !== "rules"}>
                <RulesPage onToast={showToast} onBusy={setBusy} />
              </div>

              <div className="pane conn-wrap" hidden={tab !== "connections"}>
                <ConnectionsPage onToast={showToast} active={tab === "connections"} running={running} />
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
                    onUpdateFound={(info) => {
                      setAutoUpdate(info);
                      setUpdPct(-1);
                      setUpdBusy(false);
                      setUpdMsg("");
                    }}
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
              <div className="card net-card">
                <div className="card-header no-border net-hd">
                  <div className="card-title text-base">{t("exit.network", "网络状态")}</div>
                  {/* 走哪条网络放在标题行：位置行因此能占满整宽，不会把「China · Henan · Xinyang」截断 */}
                  <span
                    className={`net-via${(exitIp?.viaProxy ?? sysProxy) ? " on" : ""}`}
                    title={
                      (exitIp?.viaProxy ?? sysProxy)
                        ? t("exit.viaProxyHint", "经系统代理检测（当前出口为代理节点）")
                        : t("exit.viaDirectHint", "系统代理未开启，当前显示直连出口")
                    }
                  >
                    <i
                      className={`net-dot${(exitIp?.viaProxy ?? sysProxy) ? " on" : ""}`}
                      aria-hidden="true"
                    />
                    {(exitIp?.viaProxy ?? sysProxy)
                      ? t("exit.viaProxy", "系统代理")
                      : t("exit.viaDirect", "直连")}
                  </span>
                  <button
                    type="button"
                    className="net-refresh"
                    onClick={() => void refreshExitIp()}
                    disabled={!running || exitIpLoading}
                    title={t("exit.refreshing", "重新检测出口 IP")}
                    aria-label={t("exit.refreshing", "重新检测出口 IP")}
                  >
                    <RefreshCw
                      size={13}
                      className={exitIpLoading ? "animate-spin" : ""}
                      aria-hidden="true"
                    />
                  </button>
                </div>
                <div className="card-body tight net-body">
                  {!running ? (
                    <div className="net-empty">{t("exit.coreDown", "内核未运行")}</div>
                  ) : exitIpLoading && !exitIp ? (
                    <div className="net-empty">{t("exit.detecting", "正在检测…")}</div>
                  ) : exitIp?.ip ? (
                    <div className="net">
                      {/* 出口位置：国家 · 省/州 · 城市（去重后拼接，长名字交给 ellipsis） */}
                      <div className="net-route">
                        {countryBadge(exitIp.countryCode) ? (
                          <span className="net-cc">{countryBadge(exitIp.countryCode)}</span>
                        ) : null}
                        <span
                          className="net-loc"
                          title={[...new Set([exitIp.country, exitIp.region, exitIp.city].filter(Boolean))].join(" · ")}
                        >
                          {[...new Set([exitIp.country, exitIp.region, exitIp.city].filter(Boolean))].join(" · ") ||
                            "—"}
                        </span>
                      </div>

                      {/* 出口 IP：等宽大字 + 复制；v6 地址带标记 */}
                      <div className="net-ipbox">
                        <div className="net-ip-hd">
                          <span className="net-ip-k">
                            {t("exit.ip", "出口 IP")}
                            {exitIp.ip.includes(":") ? <em className="net-tag">IPv6</em> : null}
                          </span>
                          <button
                            type="button"
                            className="net-copy"
                            onClick={() => {
                              navigator.clipboard?.writeText(exitIp.ip || "");
                              showToast(t("exit.copied", "已复制出口 IP"));
                            }}
                            title={t("exit.copy", "复制出口 IP")}
                          >
                            <Copy size={11} aria-hidden="true" />
                            {t("exit.copy", "复制")}
                          </button>
                        </div>
                        <div className="net-ip" title={exitIp.ip}>{exitIp.ip}</div>
                      </div>

                      {/* 归属明细：运营商的 ASN / 组织、时区 */}
                      <div className="net-meta">
                        {exitIp.isp ? (
                          <div className="net-row">
                            <span>{t("exit.isp", "运营商")}</span>
                            <b title={exitIp.isp}>{exitIp.isp}</b>
                          </div>
                        ) : null}
                        {exitIp.as || exitIp.org ? (
                          <div className="net-row">
                            <span>{t("exit.asn", "网络")}</span>
                            {/* 只显示 AS 号，组织名放 title：ISP 已经在上一条，重复展开会把值挤成省略号 */}
                            <b title={[exitIp.as, exitIp.org].filter(Boolean).join(" · ")}>
                              {exitIp.as || exitIp.org}
                            </b>
                          </div>
                        ) : null}
                        {exitIp.timezone ? (
                          <div className="net-row">
                            <span>{t("exit.timezone", "时区")}</span>
                            <b>{exitIp.timezone}</b>
                          </div>
                        ) : null}
                      </div>

                      <div className="net-sep" aria-hidden="true" />

                      {/* 实时速率 + 连接数三栏，累计单独一行贴底 */}
                      <div className="net-rates">
                        <div className="net-rate">
                          <span className="net-rate-k">↓ {t("home.download", "下载")}</span>
                          <span className={`net-rate-v down${downRate > 0 ? "" : " is-zero"}`}>
                            {formatRate(downRate)}
                          </span>
                        </div>
                        <div className="net-rate">
                          <span className="net-rate-k">↑ {t("home.upload", "上传")}</span>
                          <span className={`net-rate-v up${upRate > 0 ? "" : " is-zero"}`}>
                            {formatRate(upRate)}
                          </span>
                        </div>
                        <div className="net-rate net-rate-conn">
                          <span className="net-rate-k">{t("nav.connections", "连接")}</span>
                          <span className={`net-rate-v${connCount > 0 ? " on" : " is-zero"}`}>
                            {connCount}
                          </span>
                        </div>
                      </div>
                      <div className="net-totals">
                        <span>{t("exit.total", "累计")}</span>
                        <b>↓ {formatBytes(download)}</b>
                        <b>↑ {formatBytes(upload)}</b>
                        {exitIpAt ? (
                          <span className="net-updated">
                            {t("exit.updated", "更新于")}{" "}
                            {new Date(exitIpAt).toLocaleTimeString(getLocale(), {
                              hour12: false,
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ) : (
                    <div className="exit-state-fail">
                      <div className="text-xs text-muted">{t("exit.failed", "检测失败，请检查网络后重试")}</div>
                      <button type="button" className="btn ghost btn-xs" onClick={() => void refreshExitIp()}>
                        {t("exit.retry", "重试")}
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* 核心信息：端口 / 控制端口 / 内核 / 运行模式，把右栏剩余高度用起来 */}
              <div className="card v-rail-card">
                <div className="card-header no-border net-hd">
                  <div className="card-title text-base">{t("nav.coreInfo", "核心信息")}</div>
                  <span className={`v-rail-state${running ? " on" : ""}`}>
                    {running ? t("status.heroRunning", "运行中") : t("status.heroStopped", "已停止")}
                  </span>
                </div>
                <div className="card-body tight v-rail-body">
                  <div className="v-rail-row">
                    <span>{t("settings.mixedPort", "代理端口")}</span>
                    <b className="mono">{mixedPort}</b>
                  </div>
                  <div className="v-rail-row">
                    <span>{t("settings.controller", "控制端口")}</span>
                    <b className="mono">{controller}</b>
                  </div>
                  <div className="v-rail-row">
                    <span>{t("settings.coreEngine", "内核")}</span>
                    <b>
                      {activeCore === "singbox" ? "sing-box" : "Mihomo"}
                      {coreVersion ? ` ${coreVersion}` : ""}
                    </b>
                  </div>
                  <div className="v-rail-row">
                    <span>{t("home.mode", "代理模式")}</span>
                    <b>{MODE_LABEL(mode)}</b>
                  </div>
                  <div className="v-rail-row">
                    <span>{t("nav.uptime", "运行时长")}</span>
                    <b className="mono">
                      {running && coreStartTime ? <RailUptime startedAt={coreStartTime} /> : "—"}
                    </b>
                  </div>
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

      {autoUpdate && (
        <div
          className="modal-mask"
          onClick={() => {
            if (!updBusy) setAutoUpdate(null);
          }}
        >
          <div
            className="modal-box upd-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t("update.available", "发现新版本")}
            ref={autoUpdateBoxRef}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="upd-hd">
              <div className="upd-mark" aria-hidden="true">
                <ArrowUp size={16} />
              </div>
              <div className="upd-hd-txt">
                <div className="upd-title">
                  {t("update.available", "发现新版本")} <b>v{autoUpdate.latest}</b>
                </div>
                <div className="upd-sub">
                  {t("update.current", "当前")} v{autoUpdate.current || version}
                  {autoUpdate.assetSize ? ` · ${formatBytes(autoUpdate.assetSize)}` : ""}
                </div>
              </div>
              <button
                type="button"
                className="home-cfg-close"
                onClick={() => {
                  if (!updBusy) setAutoUpdate(null);
                }}
                disabled={updBusy}
                aria-label={t("common.cancel", "取消")}
              >
                <X size={16} />
              </button>
            </div>
            <div className="upd-body">
              <p className="upd-desc">
                {updReady
                  ? t(
                      "update.choiceDesc",
                      "安装包已下载并通过校验。请选择安装方式：覆盖安装会保留当前配置与数据；卸载后重装会先卸载当前版本再安装。"
                    )
                  : t("update.desc", "新版本已发布。下载完成后会自动打开安装程序，按提示完成升级即可。")}
              </p>
              {updBusy && (
                <>
                  <div className="upd-progress">
                    <div className="upd-bar">
                      <i style={{ width: `${updPct < 0 ? 4 : Math.max(4, updPct)}%` }} />
                    </div>
                    <span className="upd-pct">{updPct < 0 ? t("update.preparing", "准备中…") : `${updPct}%`}</span>
                  </div>
                  {updPhase ? <div className="upd-phase">{updatePhaseText(updPhase)}</div> : null}
                </>
              )}
              {updMsg ? <div className="upd-msg">{updMsg}</div> : null}
            </div>
            <div className="upd-actions">
              {updBusy ? (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => {
                    // 只发起取消并进入「正在取消…」；真正的结果等 downloadAppUpdate 返回，
                    // 避免出现「已取消」之后安装程序又弹出来的自相矛盾。
                    setUpdMsg(t("update.cancelling", "正在取消…"));
                    window.veyra?.cancelAppUpdate?.().catch(() => {});
                  }}
                >
                  {t("update.cancel", "取消下载")}
                </button>
              ) : updReady ? (
                <>
                  <button type="button" className="btn ghost" onClick={() => setAutoUpdate(null)}>
                    {t("update.later", "稍后")}
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => void applyAppUpdate("clean")}
                  >
                    {t("update.cleanInstall", "卸载后重装")}
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => void applyAppUpdate("overwrite")}
                  >
                    {t("update.overwrite", "覆盖安装")}
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="btn ghost" onClick={() => setAutoUpdate(null)}>
                    {t("update.later", "稍后")}
                  </button>
                  <button type="button" className="btn primary" onClick={() => void startAppUpdate()}>
                    {t("update.install", "下载并安装")}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {updateNotes && (
        <div className="modal-mask" onClick={closeUpdateNotes}>
          <div
            className="modal-box update-modal"
            role="dialog"
            aria-modal="true"
            aria-label="本次更新"
            ref={updateNotesBoxRef}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="update-hd">
              <div>
                <div className="update-title">本次更新</div>
                <div className="update-sub">
                  v{updateNotes.version}
                  {updateNotes.date ? ` · ${updateNotes.date}` : ""}
                </div>
              </div>
              <button type="button" className="home-cfg-close" onClick={closeUpdateNotes} aria-label="关闭">
                <X size={16} />
              </button>
            </div>
            {updateNotes.title ? <div className="update-name">{updateNotes.title}</div> : null}
            <ol className="update-list">
              {updateNotes.items.map((it, i) => (
                <li key={i}>{it}</li>
              ))}
            </ol>
            <div className="update-actions">
              <button type="button" className="btn primary" onClick={closeUpdateNotes}>
                知道了
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog req={confirmReq} onClose={() => setConfirmReq(null)} />

      {ctxMenu &&
        (() => {
          const prof = richProfiles.find((p) => p.type === "remote" && p.url === ctxMenu.url);
          const isActive = !!prof?.active;
          return (
            <div
              className="ctx-backdrop"
              onClick={() => setCtxMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtxMenu(null);
              }}
            >
              <div
                className="ctx-menu"
                style={{ left: ctxMenu.x, top: ctxMenu.y }}
                role="menu"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="ctx-menu-title">{ctxMenu.name}</div>
                {!isActive && prof?.uid ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={async () => {
                      const uid = prof.uid!;
                      setCtxMenu(null);
                      try {
                        await window.veyra?.activateProfile?.(uid);
                        await reloadProfileLists();
                        await refresh();
                        showToast(`已切换到「${ctxMenu.name}」`);
                      } catch (e) {
                        showToast(String((e as Error).message || e));
                      }
                    }}
                  >
                    <Check size={13} />
                    {t("profiles.switchTo", "切换到此订阅")}
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const url = ctxMenu.url;
                    setCtxMenu(null);
                    setSubUrl(url);
                    void importFromUrl(url);
                  }}
                >
                  <RefreshCw size={13} />
                  {t("profiles.refreshSub", "更新订阅")}
                </button>
                {prof?.uid ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={async () => {
                      const uid = prof.uid!;
                      const name = prof.name;
                      setCtxMenu(null);
                      const txt = await window.veyra?.readProfile?.(uid);
                      if (txt == null) return;
                      setEditUid(uid);
                      setProfileName(name);
                      setProfileText(txt);
                      setEditorMode("profile");
                      setPfTab("yaml");
                    }}
                  >
                    <Terminal size={13} />
                    {t("profiles.editYaml", "编辑 YAML")}
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(ctxMenu.url);
                      showToast(t("profiles.copiedUrl", "订阅链接已复制"));
                    } catch (e) {
                      showToast(String((e as Error).message || "复制订阅链接失败"));
                    }
                    setCtxMenu(null);
                  }}
                >
                  <Copy size={13} />
                  {t("profiles.copyUrl", "复制订阅链接")}
                </button>
                <div className="ctx-menu-sep" />
                <button
                  type="button"
                  role="menuitem"
                  className="is-danger"
                  onClick={() => {
                    const { url, name } = ctxMenu;
                    setCtxMenu(null);
                    setConfirmReq({
                      title: t("profiles.deleteSub", "删除订阅"),
                      message: `将删除「${name}」及其配置文件，此操作不可撤销。`,
                      confirmText: "删除",
                      danger: true,
                      onConfirm: async () => {
                        await window.veyra?.removeSubscription?.(url);
                        if (subUrl.trim() === url) {
                          setSubUrl("");
                          try {
                            localStorage.removeItem("veyra:lastSubUrl");
                          } catch {
                            // The subscription has already been removed from the app.
                          }
                        }
                        await reloadProfileLists();
                        await refresh();
                        showToast(`已删除「${name}」`);
                      },
                    });
                  }}
                >
                  <Trash2 size={13} />
                  {t("profiles.deleteSub", "删除订阅")}
                </button>
              </div>
            </div>
          );
        })()}

      {blockStartupOpen && blockStartupData && (
        <div className="modal-mask" onClick={() => {}}>
          <div className="modal-box" role="dialog" aria-modal="true" aria-label={t("conflict.blockStartupTitle", "检测到其他软件已启用系统代理")}>
            <div className="home-cfg-hd">
              <div>
                <div className="home-cfg-title">{t("conflict.blockStartupTitle", "检测到其他软件已启用系统代理")}</div>
                <div className="home-cfg-sub">{t("conflict.blockStartupDesc", "请在其他代理软件中关闭系统代理；仅打开软件但未启用系统代理不会影响 Veyra。")}</div>
              </div>
              <button
                type="button"
                className="home-cfg-close"
                onClick={() => setBlockStartupOpen(false)}
                aria-label="关闭"
              >
                <X size={16} />
              </button>
            </div>
            <div className="conflict-block-list">
              {blockStartupData.rawConflicts.map((c, i) => (
                <div key={i} className="conflict-block-item">
                  <span className="conflict-block-label">{c.label}</span>
                  {c.type === "process" && c.pids && c.pids.length > 0 && (
                    <span className="conflict-block-pids">PID: {c.pids.join(", ")}</span>
                  )}
                </div>
              ))}
            </div>
            {blockStartupMessage && (
              <div className="conflict-block-message">{blockStartupMessage}</div>
            )}
            <p className="conflict-block-hint">
              {t(
                "conflict.blockStartupKillHint",
                "「关闭并接管」会退出 Clash Verge 等正在占用系统代理的软件，可能中断你当前的上网代理。"
              )}
            </p>
            <div className="conflict-block-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={blockStartupKilling}
                onClick={async () => {
                  setBlockStartupMessage("");
                  try {
                    const result = window.veyra?.retryStartAfterConflict
                      ? await window.veyra.retryStartAfterConflict()
                      : null;
                    if (result?.ok) {
                      setBlockStartupMessage(t("conflict.blockStartupSuccess", "冲突已解决，正在启动…"));
                      setTimeout(() => setBlockStartupOpen(false), 1000);
                    } else if (result && result.conflicts && result.conflicts.length > 0) {
                      setBlockStartupData((prev) =>
                        prev ? { ...prev, conflicts: result.conflicts!, rawConflicts: prev.rawConflicts } : prev
                      );
                    }
                  } catch {
                    // 忽略
                  }
                }}
              >
                {t("conflict.blockStartupRetry", "重新检测")}
              </button>
              <button
                type="button"
                className="btn danger"
                disabled={blockStartupKilling}
                title={t(
                  "conflict.blockStartupKillHint",
                  "会退出 Clash Verge 等正在占用系统代理的软件，可能中断你当前的上网代理"
                )}
                onClick={() =>
                  setConfirmReq({
                    title: t("conflict.blockStartupKill", "关闭其他代理软件并接管"),
                    message: t(
                      "conflict.blockStartupKillHint",
                      "会退出 Clash Verge 等正在占用系统代理的软件，可能中断你当前的上网代理"
                    ),
                    confirmText: t("conflict.blockStartupKillConfirm", "关闭并接管"),
                    danger: true,
                    onConfirm: () => void runResolveExternal(),
                  })
                }
              >
                {t("conflict.blockStartupKill", "关闭其他代理软件并接管")}
              </button>
            </div>
          </div>
        </div>
      )}

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
                ["subscription", "订阅", "订阅数量与总用量"],
                ["node", "当前节点", "状态条右侧显示节点、延迟与可用数"],
                ["mode", "代理模式", "规则 / 全局 / 直连切换"],
                ["core", "规则数量", "规则条数与添加入口"],
                ["traffic", "流量统计", "累计上下行（页脚小字）"],
                ["system", "系统信息", "系统与版本（页脚小字）"],
              ].map(([key, label, desc]) => {
                const on = !!(homeCfgDraft as any)[key];
                return (
                  <button
                    key={key}
                    type="button"
                    className={`home-cfg-item${on ? " on" : ""}`}
                    onClick={() => setHomeCfgDraft({ ...homeCfgDraft, [key]: !on })}
                    aria-pressed={on}
                  >
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
