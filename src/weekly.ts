// 周报模块：每周一生成上周（周一至周日）支出汇总
// - 周消费总额、各科目总额与占比（mermaid 饼图）
// - 每日消费总额分布（自绘 SVG 柱状图，标注最高日）
import {createDocWithMd, putFile, renderAttributeView, sql} from "./api";
import {AvStore} from "./processor";
import type {ExpenseConfig as Cfg} from "./types";

export interface WeekAgg {
    days: string[];
    byCat: Map<string, number>;
    byDay: number[];
    count: number;
    total: number;
}

function pad2(n: number): string {
    return String(n).padStart(2, "0");
}

function fmtDate(d: Date): string {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 上周（周一至周日）的 7 个日期；refDate 为基准日（默认今天） */
export function lastWeekDays(ref?: Date): string[] {
    const now = ref ? new Date(ref) : new Date();
    const day = now.getDay();          // 0=周日
    const diffToMon = (day + 6) % 7;   // 距本周一的天数
    const thisMon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMon);
    const out: string[] = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(thisMon.getFullYear(), thisMon.getMonth(), thisMon.getDate() - 7 + i);
        out.push(fmtDate(d));
    }
    return out;
}

const WEEK_CN = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/** 汇总一周各日表格：科目总额、每日总额、笔数 */
export async function aggregateWeek(cfg: Cfg, avStore: AvStore, days: string[]): Promise<WeekAgg> {
    const agg: WeekAgg = {days, byCat: new Map(), byDay: [], count: 0, total: 0};
    for (const date of days) {
        let dayTotal = 0;
        const avId = avStore[date];
        if (avId) {
            try {
                const r = await renderAttributeView(avId, 1, 1000);
                const view = r?.view || {};
                const columns: any[] = view.columns || [];
                const colId: Record<string, string> = {};
                for (const c of columns) {
                    colId[c.name] = c.id;
                }
                for (const row of (view.rows || [])) {
                    let amt = 0, cat = "其他";
                    for (const cell of (row.cells || [])) {
                        const v = cell.value || {};
                        if (colId["金额"] && v.keyID === colId["金额"] && v.number?.isNotEmpty) {
                            amt = Number(v.number.content) || 0;
                        }
                        if (colId["科目"] && v.keyID === colId["科目"]) {
                            cat = v.mSelect?.[0]?.content || "其他";
                        }
                    }
                    dayTotal += amt;
                    agg.count++;
                    agg.byCat.set(cat, (agg.byCat.get(cat) || 0) + amt);
                }
            } catch {
                // 单日表格读取失败按 0 处理
            }
        }
        agg.byDay.push(Math.round(dayTotal * 100) / 100);
        agg.total += dayTotal;
    }
    agg.total = Math.round(agg.total * 100) / 100;
    return agg;
}

const fmtAmt = (n: number) => String(Math.round(n * 100) / 100);

/** mermaid 饼图（思源原生渲染） */
export function buildPieMermaid(agg: WeekAgg): string {
    const entries = [...agg.byCat.entries()].sort((a, b) => b[1] - a[1]);
    const lines = entries.map(([c, v]) => `    "${c}" : ${fmtAmt(v)}`);
    return ["pie title 上周各科目消费占比", ...lines].join("\n");
}

/** 自绘 SVG 柱状图：每日消费，最高日高亮（思源内置 mermaid 不支持 xychart，故用 SVG 保证兼容） */
export function buildBarSvg(agg: WeekAgg): string {
    const W = 860, H = 430;
    const padL = 70, padR = 30, padT = 50, padB = 70;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const maxVal = Math.max(...agg.byDay, 1);
    const step = Math.pow(10, Math.floor(Math.log10(maxVal)));
    const yMax = Math.ceil(maxVal / step) * step || 1;
    const barW = plotW / 7 * 0.55;
    const gap = plotW / 7;
    const maxIdx = agg.byDay.indexOf(Math.max(...agg.byDay));
    const fmtShort = (n: number) => n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(Math.round(n));

    let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="'Microsoft YaHei',sans-serif">`;
    s += `<rect width="${W}" height="${H}" fill="#ffffff"/>`;
    s += `<text x="${W / 2}" y="30" text-anchor="middle" font-size="18" fill="#333">上周每日消费（元）</text>`;
    // 网格与 y 轴刻度
    for (let i = 0; i <= 4; i++) {
        const y = padT + plotH - (plotH * i / 4);
        const val = yMax * i / 4;
        s += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>`;
        s += `<text x="${padL - 10}" y="${y + 5}" text-anchor="end" font-size="12" fill="#6b7280">${fmtShort(val)}</text>`;
    }
    // 柱子与标签
    agg.byDay.forEach((v, i) => {
        const x = padL + gap * i + (gap - barW) / 2;
        const h = Math.max(2, plotH * (v / yMax));
        const y = padT + plotH - h;
        const isMax = i === maxIdx && v > 0;
        s += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="4" fill="${isMax ? "#ef4444" : "#4f7cff"}" opacity="0.9"/>`;
        if (v > 0) {
            s += `<text x="${x + barW / 2}" y="${y - 8}" text-anchor="middle" font-size="13" font-weight="600" fill="${isMax ? "#ef4444" : "#374151"}">¥${fmtAmt(v)}</text>`;
        }
        const [_, m, d] = agg.days[i].split("-");
        s += `<text x="${x + barW / 2}" y="${padT + plotH + 22}" text-anchor="middle" font-size="13" fill="#374151">${WEEK_CN[i]}</text>`;
        s += `<text x="${x + barW / 2}" y="${padT + plotH + 42}" text-anchor="middle" font-size="11" fill="#9ca3af">${m}-${d}</text>`;
    });
    s += `</svg>`;
    return s;
}

function escSql(s: string): string {
    return s.replace(/'/g, "''");
}

/** 周报文档路径：{登记根目录}/周报/{起日}-{止日} */
export function weeklyDocPath(cfg: Cfg, days: string[]): string {
    const base = (cfg.docPathTemplate || "/支出记录/{date}").replace(/\/\{date\}.*$/, "");
    return `${base}/周报/${days[0].replace(/-/g, "")}-${days[6].replace(/-/g, "")}`;
}

/** 生成上周周报，返回文档 ID；已存在时返回空串 */
export async function generateWeeklyReport(cfg: Cfg, avStore: AvStore, ref?: Date): Promise<string> {
    const days = lastWeekDays(ref);
    const hpath = weeklyDocPath(cfg, days);
    const exists = await sql(
        `SELECT id FROM blocks WHERE box='${escSql(cfg.targetNotebookId)}' AND type='d' AND hpath='${escSql(hpath)}' LIMIT 1`);
    if (exists.length) {
        return "";
    }
    const agg = await aggregateWeek(cfg, avStore, days);
    const catRows = [...agg.byCat.entries()].sort((a, b) => b[1] - a[1])
        .map(([c, v]) => `| ${c} | ¥${fmtAmt(v)} | ${agg.total ? Math.round(v / agg.total * 100) : 0}% |`)
        .join("\n");
    const dayRows = agg.byDay.map((v, i) =>
        `| ${WEEK_CN[i]}（${days[i].slice(5)}） | ${v > 0 ? "¥" + fmtAmt(v) : "—"} |`).join("\n");
    const maxIdx = agg.byDay.indexOf(Math.max(...agg.byDay));
    const maxDay = agg.byDay[maxIdx] > 0
        ? `**消费最高日：${WEEK_CN[maxIdx]}（${days[maxIdx].slice(5)}）¥${fmtAmt(agg.byDay[maxIdx])}**`
        : "本周无消费记录";

    // 柱状图 SVG 先落盘为资产（文档按相对路径引用）
    const svgAsset = `/data/assets/weekly-${days[0].replace(/-/g, "")}-${days[6].replace(/-/g, "")}.svg`;
    await putFile(svgAsset, new Blob([buildBarSvg(agg)], {type: "image/svg+xml"}));
    const svgRef = svgAsset.replace(/^\/data\//, "");

    const md = [
        `# 支出周报 ${days[0]} ~ ${days[6]}`,
        "",
        `**周消费总额：¥${fmtAmt(agg.total)}（共 ${agg.count} 笔）**`,
        "",
        "## 各科目消费占比",
        "",
        "| 科目 | 金额 | 占比 |",
        "| --- | --- | --- |",
        catRows || "| — | — | — |",
        "",
        "```mermaid",
        buildPieMermaid(agg),
        "```",
        "",
        "## 每日消费分布",
        "",
        `![每日消费柱状图](${svgRef})`,
        "",
        "| 日期 | 消费 |",
        "| --- | --- |",
        dayRows,
        "",
        maxDay,
        "",
    ].join("\n");

    // 逐级创建父文档
    const segments = hpath.split("/").filter(Boolean);
    let prefix = "";
    for (let i = 0; i < segments.length - 1; i++) {
        prefix += "/" + segments[i];
        const found = await sql(
            `SELECT id FROM blocks WHERE box='${escSql(cfg.targetNotebookId)}' AND type='d' AND hpath='${escSql(prefix)}' LIMIT 1`);
        if (!found.length) {
            await createDocWithMd(cfg.targetNotebookId, prefix, "");
        }
    }
    const r: any = await createDocWithMd(cfg.targetNotebookId, hpath, md);
    return typeof r === "string" ? r : (r?.id || "");
}

/** 每轮处理后调用：周一时自动补生成上周周报（已生成则跳过） */
export async function maybeRunWeeklyReport(cfg: Cfg, avStore: AvStore): Promise<string> {
    const now = new Date();
    if (now.getDay() !== 1) {
        return "";
    }
    const days = lastWeekDays(now);
    const hpath = weeklyDocPath(cfg, days);
    const exists = await sql(
        `SELECT id FROM blocks WHERE box='${escSql(cfg.targetNotebookId)}' AND type='d' AND hpath='${escSql(hpath)}' LIMIT 1`);
    if (exists.length) {
        return "";
    }
    return generateWeeklyReport(cfg, avStore, now);
}
