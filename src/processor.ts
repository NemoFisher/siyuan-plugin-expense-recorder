// 处理流程：扫描收集箱 → AI 识别 → 按日期登记到日记文档 → 标记已处理
import {
    addAttributeViewKey, appendAttributeViewDetachedBlocksWithValues, appendBlock, blobToImageDataUrl,
    createDocWithMd, deleteBlock, fetchRemoteBlob, getFileBlob, insertBlockDom, removeAttributeViewKey,
    renderAttributeView, setBlockAttrs, sql, updateBlock,
} from "./api";
import {recognizeBlock} from "./recognizer";
import {ExpenseConfig, ExpenseRecord} from "./types";

export interface ProcessStat {
    /** 本次扫描到的待处理块数 */
    total: number;
    processed: number;
    /** 登记的消费记录条数 */
    records: number;
    /** 去重跳过的条数（重叠截图/重发消息） */
    deduped: number;
    failed: number;
    errors: string[];
}

/** 单次最多处理的块数，剩余的等下一轮定时继续，避免触发模型限流 */
const MAX_BLOCKS_PER_RUN = 50;
// Markdown 图片语法：![alt](assets/x.png "title") 或 ![alt](https://...)
const IMAGE_MD_RE = /!\[[^\]]*\]\(\s*([^)\s]+)/g;
// 内联 HTML 图片：<img src="...">
const HTML_IMG_RE = /<img[^>]*\ssrc=["']([^"']+)["']/gi;

const isRemoteUrl = (u: string) => /^https?:\/\//i.test(u);

/** 从块的 markdown 中提取全部图片引用（本地 assets 路径与云端外链均支持） */
export function extractImageRefs(markdown: string): string[] {
    const urls: string[] = [];
    for (const re of [new RegExp(IMAGE_MD_RE.source, "g"), HTML_IMG_RE]) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(markdown || ""))) {
            const u = m[1].trim();
            if (u && !u.startsWith("data:") && !urls.includes(u)) {
                urls.push(u);
            }
        }
    }
    return urls;
}

/** 本地资产路径转内核文件路径：assets/x.png → /data/assets/x.png（编辑器实际存储与服务的位置） */
function localAssetPath(ref: string): string {
    return "/data/" + ref.replace(/^\/+/, "");
}

export function localToday(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function buildDocPath(cfg: ExpenseConfig, compactDate: string): string {
    const tpl = (cfg.docPathTemplate || "{date}").trim();
    const p = tpl.replace(/\{date\}/g, compactDate);
    return p.startsWith("/") ? p : "/" + p;
}

export function buildRecordMarkdown(r: ExpenseRecord, sourceBlockId: string): string {
    const amountStr = (r.currency || "CNY") === "CNY"
        ? `**¥${r.amount.toFixed(2).replace(/\.00$/, "")}**`
        : `**${r.amount.toFixed(2).replace(/\.00$/, "")} ${r.currency}**`;
    const parts = [
        amountStr,
        `科目：${r.category || "其他"}`,
        `时间：${r.date}${r.time ? " " + r.time : ""}`,
    ];
    if (r.location) {
        parts.push(`地点：${r.location}`);
    }
    if (r.merchant) {
        parts.push(`商家：${r.merchant}`);
    }
    if (r.note) {
        parts.push(`备注：${r.note}`);
    }
    parts.push(`[来源](siyuan://blocks/${sourceBlockId})`);
    return `- ${parts.join(" ｜ ")}`;
}

function nid(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
    let suffix = "";
    for (let i = 0; i < 7; i++) {
        suffix += chars[Math.floor(Math.random() * chars.length)];
    }
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${suffix}`;
}

function msToLocalDate(ms: number): string {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dateToMs(date: string): number {
    const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) {
        return Date.now();
    }
    // 取当天 12 点，避免时区偏移导致日期错位
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).getTime();
}

export interface AvColumn {
    id: string;
    type: string;
}

type AvColumnMap = Record<string, AvColumn>;

/** 确保支出数据库包含所需列，返回列名 → 列信息 的映射 */
export async function ensureExpenseColumns(avId: string): Promise<AvColumnMap> {
    const r = await renderAttributeView(avId);
    const view = r?.view || {};
    const cols: any[] = view.columns || [];
    const map: AvColumnMap = {};
    let prev = "";
    let blockColId = "";
    for (const c of cols) {
        map[c.name] = {id: c.id, type: c.type};
        prev = c.id;
        if (c.type === "block") {
            blockColId = c.id;
        }
    }
    const need: Array<[string, string]> = [
        ["金额", "number"], ["科目", "select"], ["日期", "date"], ["时间", "text"],
        ["地点", "text"], ["商家", "text"], ["备注", "text"],
    ];
    for (const [name, type] of need) {
        if (!map[name]) {
            const keyId = nid();
            await addAttributeViewKey(avId, keyId, type, name, prev);
            map[name] = {id: keyId, type};
            prev = keyId;
        }
    }
    if (blockColId) {
        map["__block"] = {id: blockColId, type: "block"};
    }
    return map;
}

/** 日期 → 当日数据库 avID 的映射（由插件持久化在 db-avs.json） */
export type AvStore = Record<string, string>;

/** 确保当日文档里有一张独立数据库表（每日一表：当日记录只进当天表，汇总直接读当天表）
 *  返回 avID；若文档里存在无法识别 avID 的外来数据库块则返回空串（跳过登记） */
export async function ensureDailyAv(cfg: ExpenseConfig, date: string, docId: string,
                                    avStore: AvStore): Promise<string> {
    let avId = avStore[date] || "";
    const existing = await sql(
        `SELECT id FROM blocks WHERE root_id='${escSql(docId)}' AND type='av' LIMIT 1`);
    if (!existing.length) {
        if (!avId) {
            avId = nid();
            const cols = await ensureExpenseColumns(avId);
            // 移除内核默认创建的空「单选」列
            if (cols["单选"]) {
                await removeAttributeViewKey(avId, cols["单选"].id).catch(() => {
                });
            }
            avStore[date] = avId;
        }
        // 锚点：汇总块之后，退而求其次取文档第一个段落
        const summ = await sql(
            `SELECT id FROM blocks WHERE root_id='${escSql(docId)}' AND markdown LIKE '%当日总支出%' LIMIT 1`);
        const anchorRows = summ.length ? summ : await sql(
            `SELECT id FROM blocks WHERE root_id='${escSql(docId)}' AND type='p' ORDER BY sort LIMIT 1`);
        if (anchorRows.length) {
            const dom = `<div data-node-id="${nid()}" data-av-id="${avId}" data-type="NodeAttributeView" data-av-type="table"><div spellcheck="true"></div><div class="protyle-attr" contenteditable="false">\u200b</div></div>`;
            await insertBlockDom(dom, anchorRows[0].id);
        }
    } else if (!avId) {
        // 文档已有数据库块但映射缺失（通常为手动插入），无法反查其 avID
        return "";
    }
    return avId;
}

/** 记录的重复指纹：时间+金额最可靠；时间缺失时降级为 商家/地点/备注+金额（拦截重叠截图、重发消息） */
function recordFingerprint(r: { time: string; amount: number; merchant: string; location: string; note: string }): string {
    if (r.time) {
        return `t|${r.time}|${r.amount}`;
    }
    const who = r.merchant || r.location;
    if (who) {
        return `w|${who}|${r.amount}`;
    }
    if (r.note) {
        return `n|${r.note}|${r.amount}`;
    }
    return `a|${r.amount}`;
}

/** 把记录写入指定数据库（每条一行独立数据行）；写入前按指纹与表内已有行及批内记录去重 */
export async function registerRecordsToDatabase(avId: string,
                                                recs: ExpenseRecord[]): Promise<{ added: number; deduped: number }> {
    if (!recs.length) {
        return {added: 0, deduped: 0};
    }
    const existing = new Set<string>();
    try {
        const r = await renderAttributeView(avId, 1, 1000);
        const view = r?.view || {};
        const colId: Record<string, string> = {};
        for (const c of (view.columns || [])) {
            colId[c.name] = c.id;
        }
        for (const row of (view.rows || [])) {
            let amt = 0, time = "", merchant = "", location = "", note = "";
            for (const cell of (row.cells || [])) {
                const v = cell.value || {};
                if (colId["金额"] && v.keyID === colId["金额"] && v.number?.isNotEmpty) {
                    amt = Number(v.number.content) || 0;
                }
                if (colId["时间"] && v.keyID === colId["时间"]) {
                    time = (v.text?.content || "").trim();
                }
                if (colId["商家"] && v.keyID === colId["商家"]) {
                    merchant = (v.text?.content || "").trim();
                }
                if (colId["地点"] && v.keyID === colId["地点"]) {
                    location = (v.text?.content || "").trim();
                }
                if (colId["备注"] && v.keyID === colId["备注"]) {
                    note = (v.text?.content || "").trim();
                }
            }
            existing.add(recordFingerprint({time, amount: amt, merchant, location, note}));
        }
    } catch {
        // 读不到现有行时跳过去重，直接写入
    }
    const fresh: ExpenseRecord[] = [];
    let deduped = 0;
    for (const r of recs) {
        const fp = recordFingerprint(r);
        if (existing.has(fp)) {
            deduped++;
            continue;
        }
        existing.add(fp);
        fresh.push(r);
    }
    if (!fresh.length) {
        return {added: 0, deduped};
    }
    const cols = await ensureExpenseColumns(avId);
    const blockCol = cols["__block"];
    const rows = fresh.map(r => {
        const row: any[] = [];
        if (blockCol) {
            row.push({keyID: blockCol.id, type: "block", block: {content: `${r.note || r.category} ${r.amount}元`}});
        }
        row.push(
            {keyID: cols["金额"].id, type: "number", number: {content: r.amount, isNotEmpty: true}},
            {keyID: cols["科目"].id, type: "select", mSelect: [{content: r.category}]},
            {keyID: cols["日期"].id, type: "date", date: {content: dateToMs(r.date), isNotEmpty: true, isNotTime: true}},
            {keyID: cols["时间"].id, type: "text", text: {content: r.time}},
            {keyID: cols["地点"].id, type: "text", text: {content: r.location}},
            {keyID: cols["商家"].id, type: "text", text: {content: r.merchant}},
            {keyID: cols["备注"].id, type: "text", text: {content: r.note}},
        );
        return row;
    });
    await appendAttributeViewDetachedBlocksWithValues(avId, rows);
    return {added: fresh.length, deduped};
}

/** 计算单个数据库表的总支出与科目占比，写入/更新每日文档中的汇总块（表内即当日数据，无需按日期过滤） */
export async function writeDailySummary(cfg: ExpenseConfig, docId: string, avId: string): Promise<void> {
    const r = await renderAttributeView(avId, 1, 1000);
    const view = r?.view || {};
    const columns: any[] = view.columns || [];
    const colId: Record<string, string> = {};
    for (const c of columns) {
        colId[c.name] = c.id;
    }
    const amtCol = colId["金额"], catCol = colId["科目"];
    let total = 0, count = 0;
    const byCat = new Map<string, number>();
    for (const row of (view.rows || [])) {
        let amt = 0, cat = "其他";
        for (const cell of (row.cells || [])) {
            const v = cell.value || {};
            if (amtCol && v.keyID === amtCol && v.number?.isNotEmpty) {
                amt = Number(v.number.content) || 0;
            }
            if (catCol && v.keyID === catCol) {
                cat = v.mSelect?.[0]?.content || "其他";
            }
        }
        total += amt;
        count++;
        byCat.set(cat, (byCat.get(cat) || 0) + amt);
    }
    const fmt = (n: number) => "¥" + (Math.round(n * 100) / 100);
    const catParts = [...byCat.entries()].sort((a, b) => b[1] - a[1])
        .map(([c, amt]) => `${c} ${fmt(amt)}（${total ? Math.round((amt / total) * 100) : 0}%）`);
    const md = `**当日总支出：${fmt(total)}**（共 ${count} 笔）\n科目占比：${catParts.join(" · ") || "—"}`;
    // 汇总块以内容标记定位（属性索引可能滞后导致重复追加）；发现多个时只留第一个
    const found = await sql(
        `SELECT id FROM blocks WHERE root_id='${escSql(docId)}' AND markdown LIKE '%当日总支出%' ORDER BY sort`);
    if (found.length) {
        await updateBlock(found[0].id, md);
        for (const extra of found.slice(1)) {
            await deleteBlock(extra.id).catch(() => {
            });
        }
    } else {
        const ids = await appendBlock(docId, md);
        if (ids && ids[0]) {
            await setBlockAttrs(ids[0], {"custom-expense-summary": "1"}).catch(() => {
            });
        }
    }
}

/** 刷新某日的汇总（自愈：文档或表格块被删时自动重建，数据在 av 存储中不丢失） */
export async function updateDailySummary(cfg: ExpenseConfig, date: string,
                                         avStore: AvStore, allowCreateDoc = false): Promise<void> {
    const compact = date.replace(/-/g, "");
    let docId = await queryDocId(cfg.targetNotebookId, buildDocPath(cfg, compact));
    if (!docId) {
        if (!allowCreateDoc || !avStore[date]) {
            return;
        }
        docId = await ensureDailyDoc(cfg, compact);
    }
    const avId = await ensureDailyAv(cfg, date, docId, avStore);
    if (!avId) {
        return;
    }
    await writeDailySummary(cfg, docId, avId);
}

function escSql(s: string): string {
    return s.replace(/'/g, "''");
}

function validateConfig(cfg: ExpenseConfig): void {
    if (!cfg.inboxNotebookId) {
        throw new Error("请先在插件设置中选择收集箱笔记本");
    }
    if (!cfg.targetNotebookId) {
        throw new Error("请先在插件设置中选择登记消费记录的笔记本");
    }
    if (!cfg.apiKey) {
        throw new Error("请先在插件设置中填写 AI 接口 API Key");
    }
}

async function queryDocId(notebookId: string, hpath: string): Promise<string> {
    const rows = await sql(
        `SELECT id FROM blocks WHERE box='${escSql(notebookId)}' AND type='d' AND hpath='${escSql(hpath)}' LIMIT 1`);
    return rows.length ? rows[0].id : "";
}

/** 确保按日期命名的日记文档存在（自动逐级创建父文档），返回文档块 ID */
export async function ensureDailyDoc(cfg: ExpenseConfig, compactDate: string): Promise<string> {
    const hpath = buildDocPath(cfg, compactDate);
    const existing = await queryDocId(cfg.targetNotebookId, hpath);
    if (existing) {
        return existing;
    }
    const segments = hpath.split("/").filter(Boolean);
    let prefix = "";
    for (let i = 0; i < segments.length - 1; i++) {
        prefix += "/" + segments[i];
        if (!(await queryDocId(cfg.targetNotebookId, prefix))) {
            await createDocWithMd(cfg.targetNotebookId, prefix, "");
        }
    }
    const data: any = await createDocWithMd(cfg.targetNotebookId, hpath, "");
    // 创建后 SQL 索引可能短暂滞后，优先使用接口返回的文档 ID
    const newId = typeof data === "string" ? data : (data?.id as string | undefined);
    if (newId) {
        return newId;
    }
    const created = await queryDocId(cfg.targetNotebookId, hpath);
    if (created) {
        return created;
    }
    throw new Error(`无法创建日记文档：${hpath}`);
}

async function markProcessed(blockId: string): Promise<void> {
    await setBlockAttrs(blockId, {"custom-expense-processed": "1"});
}

export async function processInbox(cfg: ExpenseConfig, avStore: AvStore = {}): Promise<ProcessStat> {
    validateConfig(cfg);
    const stat: ProcessStat = {total: 0, processed: 0, records: 0, deduped: 0, failed: 0, errors: []};
    const today = localToday();

    const conds = [
        `box='${escSql(cfg.inboxNotebookId)}'`,
        `type IN ('p','h','t','i','c','html')`,
        `markdown != ''`,
        // 只扫描叶子块：列表项 [i] 与其内嵌段落 [p] 内容相同，若都扫描会重复登记
        `id NOT IN (SELECT parent_id FROM blocks WHERE parent_id != '')`,
        `(ial IS NULL OR ial NOT LIKE '%custom-expense-processed%')`,
    ];
    const inboxDocPath = (cfg.inboxDocPath || "").trim();
    if (inboxDocPath) {
        const p = inboxDocPath.startsWith("/") ? inboxDocPath : "/" + inboxDocPath;
        conds.push(`(hpath='${escSql(p)}' OR hpath LIKE '${escSql(p)}/%')`);
    }
    const blocks = await sql(
        `SELECT id, content, markdown FROM blocks WHERE ${conds.join(" AND ")} LIMIT ${MAX_BLOCKS_PER_RUN}`);
    stat.total = blocks.length;
    const touchedDates = new Set<string>();

    for (const b of blocks) {
        try {
            // 图片引用直接从 markdown 提取：本地 assets 与云端外链（如思源云图床）都支持
            const imageRefs = extractImageRefs(b.markdown || "");
            const text = (b.content || "").trim();
            if (!imageRefs.length && !text) {
                await markProcessed(b.id);
                stat.processed++;
                continue;
            }
            const imageDataUrls: string[] = [];
            for (const ref of imageRefs.slice(0, 4)) {
                const blob = isRemoteUrl(ref)
                    ? await fetchRemoteBlob(ref)
                    : await getFileBlob(localAssetPath(ref));
                imageDataUrls.push(await blobToImageDataUrl(blob));
            }
            const records = await recognizeBlock(cfg, {text, images: imageDataUrls}, today);
            if (records.length) {
                // 同一块的多条记录按日期分组，减少建文档/追加次数
                const byDate = new Map<string, ExpenseRecord[]>();
                for (const r of records) {
                    const list = byDate.get(r.date) || [];
                    list.push(r);
                    byDate.set(r.date, list);
                }
                const useDb = cfg.dbEnabled;
                for (const [date, recs] of byDate) {
                    if (useDb) {
                        const docId = await ensureDailyDoc(cfg, date.replace(/-/g, ""));
                        const avId = await ensureDailyAv(cfg, date, docId, avStore);
                        if (avId) {
                            const {added, deduped} = await registerRecordsToDatabase(avId, recs);
                            stat.records += added;
                            stat.deduped += deduped;
                            if (added > 0) {
                                touchedDates.add(date);
                            }
                        } else {
                            throw new Error(`当日文档存在无法识别的数据库块，已跳过 ${date} 的登记`);
                        }
                    } else {
                        const docId = await ensureDailyDoc(cfg, date.replace(/-/g, ""));
                        const newIds = await appendBlock(docId, recs.map(r => buildRecordMarkdown(r, b.id)).join("\n"));
                        // 登记出的记录块也打上已处理标记，避免日后扩大扫描范围时把已有记录再识别一遍
                        await Promise.all(newIds.map(id => markProcessed(id).catch(() => {
                        })));
                        stat.records += recs.length;
                    }
                }
            }
            if (cfg.processedAction === "mark") {
                await markProcessed(b.id);
            }
            stat.processed++;
        } catch (e: any) {
            // 失败的块不打标记，下一轮会重试
            stat.failed++;
            stat.errors.push(`${b.id}: ${e?.message || e}`);
        }
        await new Promise<void>(resolve => window.setTimeout(resolve, 300));
    }
    // 数据库模式下：刷新有新登记日期的汇总；当日表已存在时也顺带自愈刷新
    if (cfg.dbEnabled) {
        const dates = new Set(touchedDates);
        const todayStr = localToday();
        if (avStore[todayStr]) {
            dates.add(todayStr);
        }
        for (const date of dates) {
            try {
                await updateDailySummary(cfg, date, avStore, touchedDates.has(date));
            } catch (e: any) {
                stat.errors.push(`汇总更新失败 ${date}: ${e?.message || e}`);
            }
        }
    }
    return stat;
}
