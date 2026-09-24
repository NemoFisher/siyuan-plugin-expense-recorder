// 消费记录助手：定时扫描收集箱，用 AI 把图片/文字识别为消费记录，按消费日期登记到日记文档
import {Plugin, showMessage} from "siyuan";
import {processInbox} from "./processor";
import {openSettingsDialog} from "./settings";
import {DEFAULT_CONFIG, ExpenseConfig} from "./types";
import {WecomBotClient} from "./wecom";

const CONFIG_FILE = "config.json";

const ICON_SYMBOL = `<symbol id="iconExpenseRecorder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14.5" rx="2.5"/><path d="M2.5 9.5h19"/><path d="M6 15.5h4"/><circle cx="17.2" cy="14.9" r="1.4" fill="currentColor" stroke="none"/></symbol>`;

export default class ExpenseRecorderPlugin extends Plugin {
    config: ExpenseConfig = {...DEFAULT_CONFIG};
    private timerId: number | null = null;
    private running = false;
    private wecomClient: WecomBotClient | null = null;

    async onload() {
        this.addIcons(ICON_SYMBOL);
        await this.loadConfig();

        this.addCommand({
            langKey: "processNow",
            langText: (this.i18n as any)?.processNow || "立即处理收集箱",
            callback: () => this.processNow(false),
        });
        this.addCommand({
            langKey: "openSetting",
            langText: (this.i18n as any)?.openSetting || "打开消费记录助手设置",
            callback: () => this.openSetting(),
        });
        this.addTopBar({
            icon: "iconExpenseRecorder",
            title: (this.i18n as any)?.topBarTitle || "识别收集箱中的消费记录",
            position: "right",
            callback: () => this.processNow(false),
        });
    }

    async onLayoutReady() {
        if (this.config.autoStart) {
            this.startTimer();
            // 启动 10 秒后先跑一轮，之后按定时间隔执行
            window.setTimeout(() => this.processNow(true), 10_000);
        }
        this.restartWecom();
    }

    onunload() {
        this.stopTimer();
        this.stopWecom();
    }

    async loadConfig() {
        let stored: any;
        try {
            stored = await this.loadData(CONFIG_FILE);
        } catch {
            stored = null;
        }
        if (typeof stored === "string") {
            try {
                stored = JSON.parse(stored);
            } catch {
                stored = null;
            }
        }
        this.config = {...DEFAULT_CONFIG, ...(stored || {})};
    }

    async saveConfig(cfg: ExpenseConfig) {
        this.config = cfg;
        await this.saveData(CONFIG_FILE, cfg);
    }

    startTimer() {
        this.stopTimer();
        const minutes = Math.max(1, Number(this.config.intervalMinutes) || 30);
        this.timerId = window.setInterval(() => this.processNow(true), minutes * 60_000);
    }

    stopTimer() {
        if (this.timerId !== null) {
            window.clearInterval(this.timerId);
            this.timerId = null;
        }
    }

    /** 按配置启停企业微信智能机器人长连接 */
    restartWecom() {
        this.stopWecom();
        if (this.config.wecomEnabled && this.config.wecomBotId && this.config.wecomSecret) {
            if (!this.config.inboxNotebookId) {
                showMessage("已启用企微采集，但未配置收集箱笔记本，暂不启动", 5000, "info");
                return;
            }
            this.wecomClient = new WecomBotClient(
                this.config,
                (data) => this.saveData("wecom-last.json", data),
                (msg) => console.log(msg),
            );
            this.wecomClient.start();
        }
    }

    stopWecom() {
        this.wecomClient?.stop();
        this.wecomClient = null;
    }

    /** 手动或定时触发；silent=true 时空跑不弹提示 */
    async processNow(silent: boolean) {
        if (this.running) {
            if (!silent) {
                showMessage("正在处理中，请稍候…", 3000, "info");
            }
            return;
        }
        this.running = true;
        const startedAt = new Date().toISOString();
        try {
            // 日期 → 当日数据库 avID 映射（每日一表架构的核心状态）
            let avStore: Record<string, string> = {};
            try {
                const stored: any = await this.loadData("db-avs.json");
                if (typeof stored === "string") {
                    avStore = JSON.parse(stored);
                } else if (stored && typeof stored === "object") {
                    avStore = stored;
                }
            } catch {
                avStore = {};
            }
            const stat = await processInbox(this.config, avStore);
            this.saveData("db-avs.json", avStore).catch(() => {
            });
            this.saveData("lastrun.json", {
                startedAt, finishedAt: new Date().toISOString(), ok: true, ...stat,
            }).catch(() => {
            });
            if (stat.processed > 0 || stat.failed > 0) {
                let msg = `收集箱处理完成：${stat.processed}/${stat.total} 条内容已处理，登记 ${stat.records} 条消费记录`;
                if (stat.deduped > 0) {
                    msg += `，去重跳过 ${stat.deduped} 条`;
                }
                if (stat.failed > 0) {
                    msg += `，${stat.failed} 条失败（下次定时会重试）`;
                }
                showMessage(msg, stat.failed > 0 ? 8000 : 4000, stat.failed > 0 ? "error" : "info");
                if (stat.errors.length) {
                    console.error("[expense-recorder] 失败详情：", stat.errors);
                }
            } else if (!silent) {
                showMessage("收集箱中没有待处理的内容", 3000, "info");
            }
        } catch (e: any) {
            console.error("[expense-recorder]", e);
            this.saveData("lastrun.json", {
                startedAt, finishedAt: new Date().toISOString(), ok: false,
                error: String(e?.message || e),
            }).catch(() => {
            });
            showMessage(`处理失败：${e?.message || e}`, 8000, "error");
        } finally {
            this.running = false;
        }
    }

    openSetting() {
        openSettingsDialog(this);
    }
}
