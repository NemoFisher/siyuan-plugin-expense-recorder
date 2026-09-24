// AI 识别模块：调用 OpenAI 兼容的 chat/completions 接口，把文字/图片解析为结构化消费记录
import {ExpenseConfig, ExpenseRecord} from "./types";

export function buildSystemPrompt(cfg: ExpenseConfig, today: string): string {
    return [
        "你是严谨的记账信息抽取助手。用户会提供一段笔记内容：可能是文字，也可能是购物小票、支付截图、外卖/打车订单等图片。",
        "请抽取其中全部「支出/消费」记录，并且只输出一个 JSON 对象，不要输出解释文字，也不要输出 Markdown 代码块标记。",
        '输出格式：{"records":[{"date":"YYYY-MM-DD","time":"HH:MM","amount":0,"currency":"CNY","category":"餐饮","location":"地点或平台","merchant":"商家","note":"备注"}]}',
        "规则：",
        `1) date 是消费实际发生的日期（YYYY-MM-DD）。今天是 ${today}。内容中明确出现"今天/昨天/前天/X月X日"等日期信息时据此推算；看不到明确日期时（例如支付账单列表截图只显示时间）严禁编造日期，必须使用今天 ${today}。`,
        "2) time 是 24 小时制 HH:MM；无法判断时用空字符串。",
        "3) amount 是数字，不带货币符号和千分位；支付账单中支出常显示为负数（如 -25.00），此时填正数 25.00；多笔消费无法拆分时填合计金额。",
        "4) currency 使用 ISO 代码，默认 CNY。",
        `5) category 必须优先从以下科目中选择最贴近的一个：${cfg.categories}。确实都不合适时才允许自拟，且不超过 4 个字。`,
        "6) location 填消费发生的地点或平台（如：美团外卖、永辉超市），无法判断用空字符串；账单截图中的商户名（如 星巴克、肯德基）应填入 merchant 而不是 location。",
        "7) merchant 填商家名称（如：肯德基、滴滴出行），无法判断用空字符串。",
        "8) note 用一句话概括买了什么/用途，不超过 20 个字。",
        '9) 如果内容与消费完全无关（纯备忘、聊天记录、日程等），输出 {"records":[]}。',
        "10) 内容中形如【企微 HH:MM】的方括号标记是系统添加的收集渠道时间戳，与消费无关；绝对不要把「企微」或这类标记当作地点、商家、科目或消费内容。",
    ].join("\n");
}

export async function callChatCompletion(cfg: ExpenseConfig, model: string,
                                         messages: Array<{ role: string; content: any }>,
                                         temperature = 0.1): Promise<string> {
    if (!cfg.apiBaseUrl) {
        throw new Error("未配置 AI 接口地址（Base URL）");
    }
    if (!cfg.apiKey) {
        throw new Error("未配置 AI 接口 API Key");
    }
    const base = cfg.apiBaseUrl.trim().replace(/\/+$/, "");
    const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(),
        Math.max(10, cfg.requestTimeoutSec || 120) * 1000);
    try {
        const resp = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${cfg.apiKey}`,
            },
            body: JSON.stringify({model, messages, temperature}),
            signal: controller.signal,
        });
        if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            throw new Error(`AI 接口返回 HTTP ${resp.status}${body ? "：" + body.slice(0, 200) : ""}`);
        }
        const json = await resp.json();
        const content = json?.choices?.[0]?.message?.content;
        if (typeof content !== "string" || !content.trim()) {
            throw new Error("AI 未返回内容");
        }
        return content;
    } catch (e: any) {
        if (e?.name === "AbortError") {
            throw new Error("AI 请求超时，可在设置中调大超时时间");
        }
        throw e;
    } finally {
        window.clearTimeout(timer);
    }
}

/** 从模型输出中容错地提取 JSON（兼容 ```代码块、数组或对象、JSON 后附带说明文字等情况） */
export function extractJson(text: string): any {
    const t = text.trim().replace(/```(?:json)?/gi, "").trim();
    // 先尝试整段；再从最外层 JSON 值的起始符（{ 与 [ 中先出现者）做括号配对截取
    const firstObj = t.indexOf("{");
    const firstArr = t.indexOf("[");
    const candidates: (string | null)[] = [t];
    if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) {
        candidates.push(sliceBalanced(t, "[", "]"), sliceBalanced(t, "{", "}"));
    } else {
        candidates.push(sliceBalanced(t, "{", "}"), sliceBalanced(t, "[", "]"));
    }
    for (const c of candidates) {
        if (!c) {
            continue;
        }
        try {
            return JSON.parse(c);
        } catch {
            // 尝试下一个候选
        }
    }
    throw new Error("AI 未返回可解析的 JSON：" + text.slice(0, 120));
}

/** 截取第一个括号配对完整的子串（忽略字符串字面量内的括号） */
function sliceBalanced(text: string, open: string, close: string): string | null {
    const start = text.indexOf(open);
    if (start === -1) {
        return null;
    }
    let depth = 0, inStr = false, escape = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inStr) {
            if (escape) {
                escape = false;
            } else if (ch === "\\") {
                escape = true;
            } else if (ch === '"') {
                inStr = false;
            }
            continue;
        }
        if (ch === '"') {
            inStr = true;
        } else if (ch === open) {
            depth++;
        } else if (ch === close) {
            depth--;
            if (depth === 0) {
                return text.slice(start, i + 1);
            }
        }
    }
    return null;
}

function normalizeDate(s: string, today: string): string {
    const raw = (s || "").trim();
    const m = raw.match(/^(?:(\d{4})[-/.年])?(\d{1,2})[-/.月](\d{1,2})日?$/);
    if (m) {
        const year = m[1] ? parseInt(m[1], 10) : parseInt(today.slice(0, 4), 10);
        const date = `${year}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
        // 模型偶发编造未来日期，直接归为今天
        return date > today ? today : date;
    }
    return today;
}

function normalizeTime(s: string): string {
    const m = (s || "").trim().match(/^(\d{1,2})[:：点](\d{1,2})?/);
    if (!m) {
        return "";
    }
    const hh = Math.min(23, parseInt(m[1], 10));
    const mm = Math.min(59, m[2] ? parseInt(m[2], 10) : 0);
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** 校验并规整模型返回的记录，过滤无效项 */
export function parseRecords(data: any, _cfg: ExpenseConfig, today: string): ExpenseRecord[] {
    const arr = Array.isArray(data) ? data : Array.isArray(data?.records) ? data.records : [];
    const out: ExpenseRecord[] = [];
    for (const item of arr) {
        if (!item || typeof item !== "object") {
            continue;
        }
        const amountRaw = Number(item.amount);
        // 支付账单的支出常以负数表示（如 -25.00），统一取绝对值
        const amount = Math.abs(amountRaw);
        if (!isFinite(amount) || amount <= 0 || amount > 1e9) {
            continue;
        }
        const merchant = String(item.merchant || "").trim();
        let category = String(item.category || "").trim();
        // 模型偶发把商家名塞进科目字段
        if (!category || category === merchant) {
            category = "其他";
        }
        out.push({
            date: normalizeDate(String(item.date || ""), today),
            time: normalizeTime(String(item.time || "")),
            amount: Math.round(amount * 100) / 100,
            currency: (String(item.currency || "CNY").trim() || "CNY").toUpperCase(),
            category,
            location: String(item.location || "").trim(),
            merchant,
            note: String(item.note || "").trim(),
        });
    }
    return out;
}

/** 识别一个块：有图片时走视觉模型（图片+文字一起给），纯文字走文本模型 */
export async function recognizeBlock(cfg: ExpenseConfig,
                                     content: { text: string; images: string[] },
                                     today: string): Promise<ExpenseRecord[]> {
    const useVision = content.images.length > 0;
    const model = useVision ? (cfg.visionModel || cfg.textModel) : cfg.textModel;
    // 剥离采集渠道添加的时间戳标记，避免模型把它们误认为消费信息
    const text = content.text.replace(/【企微 \d{2}:\d{2}】/g, "").trim();
    const userContent = useVision
        ? [
            ...content.images.map(url => ({type: "image_url", image_url: {url}})),
            {type: "text", text: text || "请识别图片中的消费信息。"},
        ]
        : text;
    const raw = await callChatCompletion(cfg, model, [
        {role: "system", content: buildSystemPrompt(cfg, today)},
        {role: "user", content: userContent},
    ]);
    return parseRecords(extractJson(raw), cfg, today);
}

/** 设置界面「测试连接」：用文本模型发一个极小请求 */
export async function testConnection(cfg: ExpenseConfig): Promise<string> {
    const raw = await callChatCompletion(cfg, cfg.textModel || cfg.visionModel, [
        {role: "user", content: '请原样返回这个 JSON，不要加任何其他内容：{"ok":true}'},
    ], 0);
    return raw.trim().slice(0, 80);
}
