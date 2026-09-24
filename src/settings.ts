// 设置界面：收集箱、登记位置、AI 接口、定时等配置
import {Dialog, showMessage} from "siyuan";
import {lsNotebooks} from "./api";
import {testConnection} from "./recognizer";
import {DEFAULT_CONFIG, ExpenseConfig} from "./types";
import type ExpenseRecorderPlugin from "./index";

function escapeHtml(s: string): string {
    return String(s ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function row(label: string, control: string, hint = ""): string {
    return `<div style="margin-bottom:16px;">
  <div style="padding-bottom:6px;font-size:13px;" class="ft__on-surface">${label}</div>
  ${control}
  ${hint ? `<div class="b3-label__text" style="padding-top:4px;">${hint}</div>` : ""}
</div>`;
}

function notebookOptions(notebooks: { id: string; name: string }[], selected: string): string {
    return `<option value="">请选择笔记本…</option>` +
        notebooks.map(n =>
            `<option value="${n.id}" ${n.id === selected ? "selected" : ""}>${escapeHtml(n.name)}</option>`).join("");
}

function buildFormHtml(cfg: ExpenseConfig, notebooks: { id: string; name: string }[]): string {
    return `
${row("收集箱笔记本", `<select id="cfg-inbox" class="b3-select" style="width:100%">${notebookOptions(notebooks, cfg.inboxNotebookId)}</select>`,
        "插件会定时扫描该笔记本中的图片和文字。")}
${row("仅处理该路径下的文档（可选）", `<input id="cfg-inbox-doc" class="b3-text-field" style="width:100%" placeholder="如 /收集箱，留空则处理整个笔记本" value="${escapeHtml(cfg.inboxDocPath)}">`)}
${row("登记消费记录的笔记本", `<select id="cfg-target" class="b3-select" style="width:100%">${notebookOptions(notebooks, cfg.targetNotebookId)}</select>`)}
${row("日记文档路径模板", `<input id="cfg-path" class="b3-text-field" style="width:100%" value="${escapeHtml(cfg.docPathTemplate)}">`,
        "其中 <code>{date}</code> 会被替换为消费日期（如 20260901）。示例：<code>/消费记录/{date}</code>。")}
<hr style="border:none;border-top:1px solid var(--b3-border-color);margin:8px 0 16px;">
${row("AI 接口地址（OpenAI 兼容 Base URL）", `<input id="cfg-baseurl" class="b3-text-field" style="width:100%" value="${escapeHtml(cfg.apiBaseUrl)}">`,
        "默认为智谱开放平台，其 glm-4-flash / glm-4v-flash 为免费模型，可在 <a href=\"https://open.bigmodel.cn\" target=\"_blank\">open.bigmodel.cn</a> 申请 Key。也可改为 OpenAI、SiliconFlow 等任何 OpenAI 兼容接口。")}
${row("API Key", `<input id="cfg-apikey" type="password" class="b3-text-field" style="width:100%" value="${escapeHtml(cfg.apiKey)}">`)}
${row("文本识别模型", `<input id="cfg-text-model" class="b3-text-field" style="width:100%" value="${escapeHtml(cfg.textModel)}">`, "用于识别纯文字内容（转账备注、消费清单等）。")}
${row("图片识别模型（视觉）", `<input id="cfg-vision-model" class="b3-text-field" style="width:100%" value="${escapeHtml(cfg.visionModel)}">`, "用于识别小票、支付截图等图片，需要支持视觉的模型。")}
${row("科目列表（用「、」分隔）", `<textarea id="cfg-categories" rows="2" class="b3-text-field" style="width:100%">${escapeHtml(cfg.categories)}</textarea>`, "AI 会优先从这些科目中为每笔消费归类。")}
<hr style="border:none;border-top:1px solid var(--b3-border-color);margin:8px 0 16px;">
${row("定时处理间隔（分钟）", `<input id="cfg-interval" type="number" min="1" step="1" class="b3-text-field" style="width:120px" value="${cfg.intervalMinutes}">`)}
${row("启动后自动定时处理", `<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;"><input id="cfg-autostart" type="checkbox" ${cfg.autoStart ? "checked" : ""}> 启动思源后自动开始定时处理</label>`)}
${row("处理后的动作", `<select id="cfg-action" class="b3-select" style="width:100%">
  <option value="mark" ${cfg.processedAction === "mark" ? "selected" : ""}>给块添加「已处理」属性（推荐，避免重复登记）</option>
  <option value="none" ${cfg.processedAction === "none" ? "selected" : ""}>不标记（每次都会重新识别，慎选）</option>
</select>`)}
<hr style="border:none;border-top:1px solid var(--b3-border-color);margin:8px 0 16px;">
${row("启用企业微信智能机器人采集（可选）", `<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;"><input id="cfg-wecom-enabled" type="checkbox" ${cfg.wecomEnabled ? "checked" : ""}> 通过长连接接收机器人收到的消息</label>`,
        "在企业微信管理后台创建「智能机器人」（连接方式选长连接），把它拉进内部群或在单聊中给它发消息，内容会自动收集到收集箱目录下的「企微-日期」文档。注意：思源未运行期间的消息不会补收。")}
${row("Bot ID", `<input id="cfg-wecom-botid" class="b3-text-field" style="width:100%" value="${escapeHtml(cfg.wecomBotId)}">`)}
${row("Secret", `<input id="cfg-wecom-secret" type="password" class="b3-text-field" style="width:100%" value="${escapeHtml(cfg.wecomSecret)}">`)}
${row("只采集该成员 userid 发送的消息", `<input id="cfg-wecom-userid" class="b3-text-field" style="width:100%" placeholder="留空不过滤；填写后仅收集该成员发的内容" value="${escapeHtml(cfg.wecomUserId)}">`)}
<hr style="border:none;border-top:1px solid var(--b3-border-color);margin:8px 0 16px;">
${row("启用数据库表格登记（可选）", `<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;"><input id="cfg-db-enabled" type="checkbox" ${cfg.dbEnabled ? "checked" : ""}> 记录写入思源数据库表格，并生成当日汇总</label>`)}
${row("说明", `<div class="b3-label__text" style="line-height:1.7">启用后每天在当日文档（如 支出记录/20260924）中自动创建一张独立的数据库表格，记录直接写入当天表格，并生成「当日总支出 + 科目占比」汇总。列（金额/科目/日期/时间/地点/商家/备注）自动创建，无需任何手工配置。</div>`)}`;
}

function readForm(dialog: Dialog): ExpenseConfig {
    const $ = (id: string) => dialog.element.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`#${id}`);
    const num = (id: string, fallback: number) => {
        const v = parseFloat($(id)?.value || "");
        return isFinite(v) && v > 0 ? v : fallback;
    };
    const actionEl = $("cfg-action") as HTMLSelectElement | null;
    return {
        ...DEFAULT_CONFIG,
        inboxNotebookId: $("cfg-inbox")?.value || "",
        inboxDocPath: ($("cfg-inbox-doc")?.value || "").trim(),
        targetNotebookId: $("cfg-target")?.value || "",
        docPathTemplate: ($("cfg-path")?.value || DEFAULT_CONFIG.docPathTemplate).trim(),
        apiBaseUrl: ($("cfg-baseurl")?.value || "").trim(),
        apiKey: ($("cfg-apikey")?.value || "").trim(),
        textModel: ($("cfg-text-model")?.value || DEFAULT_CONFIG.textModel).trim(),
        visionModel: ($("cfg-vision-model")?.value || DEFAULT_CONFIG.visionModel).trim(),
        categories: ($("cfg-categories")?.value || DEFAULT_CONFIG.categories).trim(),
        intervalMinutes: Math.max(1, Math.round(num("cfg-interval", DEFAULT_CONFIG.intervalMinutes))),
        autoStart: ($("cfg-autostart") as HTMLInputElement | null)?.checked ?? DEFAULT_CONFIG.autoStart,
        processedAction: actionEl?.value === "none" ? "none" : "mark",
        requestTimeoutSec: DEFAULT_CONFIG.requestTimeoutSec,
        wecomEnabled: ($("cfg-wecom-enabled") as HTMLInputElement | null)?.checked ?? false,
        wecomBotId: ($("cfg-wecom-botid")?.value || "").trim(),
        wecomSecret: ($("cfg-wecom-secret")?.value || "").trim(),
        wecomWsUrl: DEFAULT_CONFIG.wecomWsUrl,
        wecomUserId: ($("cfg-wecom-userid")?.value || "").trim(),
        dbEnabled: ($("cfg-db-enabled") as HTMLInputElement | null)?.checked ?? false,
    };
}

export async function openSettingsDialog(plugin: ExpenseRecorderPlugin): Promise<void> {
    let notebooks: { id: string; name: string }[] = [];
    try {
        notebooks = await lsNotebooks();
    } catch (e: any) {
        showMessage(`加载笔记本列表失败：${e?.message || e}`, 6000, "error");
    }

    const dialog = new Dialog({
        title: "消费记录助手 · 设置",
        content: `<div style="padding:16px 20px;max-height:72vh;overflow:auto;">
${buildFormHtml(plugin.config, notebooks)}
</div>
<div class="fn__flex" style="padding:12px 20px;gap:8px;align-items:center;border-top:1px solid var(--b3-border-color);">
  <button id="cfg-test" class="b3-button b3-button--outline">测试 AI 连接</button>
  <span class="fn__flex-1"></span>
  <button id="cfg-run" class="b3-button b3-button--outline">立即处理收集箱</button>
  <button id="cfg-cancel" class="b3-button b3-button--cancel">取消</button>
  <button id="cfg-save" class="b3-button b3-button--text">保存</button>
</div>`,
        width: "680px",
        height: "auto",
    });

    dialog.element.querySelector("#cfg-cancel")?.addEventListener("click", () => dialog.destroy());
    dialog.element.querySelector("#cfg-save")?.addEventListener("click", async () => {
        const cfg = readForm(dialog);
        if (!cfg.inboxNotebookId) {
            showMessage("请选择收集箱笔记本", 4000, "error");
            return;
        }
        if (!cfg.targetNotebookId) {
            showMessage("请选择登记消费记录的笔记本", 4000, "error");
            return;
        }
        await plugin.saveConfig(cfg);
        if (cfg.autoStart) {
            plugin.startTimer();
        } else {
            plugin.stopTimer();
        }
        plugin.restartWecom();
        showMessage("设置已保存", 3000, "info");
        dialog.destroy();
    });
    dialog.element.querySelector("#cfg-test")?.addEventListener("click", () => {
        const cfg = readForm(dialog);
        showMessage("正在测试 AI 接口…", 2000, "info");
        testConnection(cfg)
            .then(reply => showMessage(`连接成功，模型回复：${reply}`, 6000, "info"))
            .catch(e => showMessage(`连接失败：${e?.message || e}。若提示 Failed to fetch / CORS，说明该平台不允许浏览器直接调用，请更换接口或自建中转。`, 9000, "error"));
    });
    dialog.element.querySelector("#cfg-run")?.addEventListener("click", () => {
        dialog.destroy();
        plugin.processNow(false);
    });
}
