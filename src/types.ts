/** 单条消费记录（AI 识别结果） */
export interface ExpenseRecord {
    /** 消费实际发生日期 YYYY-MM-DD */
    date: string;
    /** 消费时间 HH:MM，可为空 */
    time: string;
    /** 金额（数字） */
    amount: number;
    /** 货币 ISO 代码，默认 CNY */
    currency: string;
    /** 科目（餐饮、交通……） */
    category: string;
    /** 消费地点或平台 */
    location: string;
    /** 商家名称 */
    merchant: string;
    /** 一句话备注 */
    note: string;
}

export type ProcessedAction = "mark" | "none";

export interface ExpenseConfig {
    /** 收集箱笔记本 ID */
    inboxNotebookId: string;
    /** 仅处理该 human path 下的文档（如 /收集箱），留空处理整个笔记本 */
    inboxDocPath: string;
    /** 登记日记所在笔记本 ID */
    targetNotebookId: string;
    /** 日记文档路径模板，{date} 会被替换为 20260901 这样的紧凑日期 */
    docPathTemplate: string;
    /** OpenAI 兼容接口 Base URL（不含 /chat/completions） */
    apiBaseUrl: string;
    /** API Key */
    apiKey: string;
    /** 文本识别模型 */
    textModel: string;
    /** 图片识别（视觉）模型 */
    visionModel: string;
    /** 科目列表，用「、」分隔 */
    categories: string;
    /** 定时处理间隔（分钟） */
    intervalMinutes: number;
    /** 思源启动后自动定时处理 */
    autoStart: boolean;
    /** 处理后动作：mark=给块打已处理属性（推荐）；none=不标记（会重复识别，慎用） */
    processedAction: ProcessedAction;
    /** 单次 AI 请求超时（秒） */
    requestTimeoutSec: number;
    /** 企业微信智能机器人采集（可选）：启用 */
    wecomEnabled: boolean;
    /** 企微智能机器人 Bot ID */
    wecomBotId: string;
    /** 企微智能机器人 Secret */
    wecomSecret: string;
    /** 长连接地址（默认官方；开发测试可指向 mock） */
    wecomWsUrl: string;
    /** 只采集该成员 userid 发送的消息，留空不过滤 */
    wecomUserId: string;
    /** 数据库登记（可选）：每天一张独立数据库表，存于当日文档中 */
    dbEnabled: boolean;
}

export const DEFAULT_CONFIG: ExpenseConfig = {
    inboxNotebookId: "",
    inboxDocPath: "",
    targetNotebookId: "",
    docPathTemplate: "/消费记录/{date}",
    apiBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiKey: "",
    textModel: "glm-4-flash",
    visionModel: "glm-4v-flash",
    categories: ["餐饮", "交通", "购物", "日用品", "住房", "水电网", "通讯", "娱乐", "医疗",
        "教育", "人情往来", "宠物", "旅行", "数字服务", "其他"].join("、"),
    intervalMinutes: 30,
    autoStart: true,
    processedAction: "mark",
    requestTimeoutSec: 120,
    wecomEnabled: false,
    wecomBotId: "",
    wecomSecret: "",
    wecomWsUrl: "wss://openws.work.weixin.qq.com",
    wecomUserId: "",
    dbEnabled: false,
};
