// 企业微信智能机器人长连接采集（可选功能）
// 协议：wss 握手后发送 {cmd:"aibot_subscribe", body:{bot_id, secret}}，每 30s 发 ping 心跳；
// 服务端推送 {cmd:"aibot_msg_callback", body:{msgid, chattype, from, msgtype, text/image/file/...}}。
// 图片/文件消息带加密下载 URL（5 分钟有效）与每链接唯一的 base64 aeskey，
// 内容为 AES-256-CBC（IV=key 前 16 字节，PKCS#7 按 32 字节块填充）加密，需下载后解密。
import {appendBlock, createDocWithMd, fetchRemoteBlob, putFile, sniffImageMime, sql} from "./api";
import {ExpenseConfig} from "./types";

const DEFAULT_WS_URL = "wss://openws.work.weixin.qq.com";
const HEARTBEAT_MS = 30_000;
const SEEN_MAX = 500;

interface WsFrame {
    cmd?: string;
    headers?: { req_id?: string };
    body?: any;
    errcode?: number;
    errmsg?: string;
}

export interface WecomStatus {
    enabled: boolean;
    connected: boolean;
    lastConnectedAt?: string;
    lastError?: string;
    received: number;
    collected: number;
    failed: number;
}

interface MediaRef {
    url: string;
    aeskey?: string;
}

function nodeRequire(): any | null {
    try {
        const req = (window as any).require;
        return typeof req === "function" ? req : null;
    } catch {
        return null;
    }
}

function nodeMd5(data: Uint8Array): string | null {
    const req = nodeRequire();
    if (!req) {
        return null;
    }
    try {
        const BufferC = req("buffer").Buffer;
        return req("crypto").createHash("md5").update(BufferC.from(data)).digest("hex");
    } catch {
        return null;
    }
}

/** 按官方 SDK 规则解密企微媒体：AES-256-CBC，IV=key 前 16 字节，手动去除 32 字节块 PKCS#7 填充 */
export function decryptAesMedia(encrypted: Uint8Array, aesKeyB64: string): Uint8Array {
    const req = nodeRequire();
    if (!req) {
        throw new Error("当前环境缺少 Node 模块，无法解密企微媒体");
    }
    const crypto = req("crypto");
    const BufferC = req("buffer").Buffer;
    const key = BufferC.from(aesKeyB64, "base64");
    if (key.length !== 32) {
        throw new Error(`aesKey 解码长度异常：${key.length}`);
    }
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
    decipher.setAutoPadding(false);
    const dec = BufferC.concat([decipher.update(BufferC.from(encrypted)), decipher.final()]);
    const padLen = dec[dec.length - 1];
    if (padLen < 1 || padLen > 32 || padLen > dec.length) {
        throw new Error("解密失败：PKCS#7 填充非法");
    }
    for (let i = dec.length - padLen; i < dec.length; i++) {
        if (dec[i] !== padLen) {
            throw new Error("解密失败：PKCS#7 填充不匹配");
        }
    }
    return new Uint8Array(dec.subarray(0, dec.length - padLen));
}

function sniffFileExt(b: Uint8Array): string {
    if (b.length < 12) {
        return "bin";
    }
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) {
        return "png";
    }
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) {
        return "jpg";
    }
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
        return "gif";
    }
    if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
        return "webp";
    }
    if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) {
        return "pdf";
    }
    if (b[0] === 0x50 && b[1] === 0x4B) {
        return "docx";
    }
    return "bin";
}

function pad2(n: number): string {
    return String(n).padStart(2, "0");
}

function fmtTime(sec?: number): string {
    const d = sec ? new Date(sec * 1000) : new Date();
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function compactStamp(d = new Date()): string {
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function randId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function escSql(s: string): string {
    return s.replace(/'/g, "''");
}

/** 已收集媒体的 MD5（用于拦截服务端重试推送的重复文件） */
const seenMediaMd5 = new Map<string, number>();

/** 企微消息落入收集箱目录下按天命名的文档：{收集箱路径}/企微-20260923 */
async function ensureWecomDoc(cfg: ExpenseConfig, compactDate: string): Promise<string> {
    const base = (cfg.inboxDocPath || "").trim();
    const hpath = (base ? (base.startsWith("/") ? base : "/" + base) : "") + `/企微-${compactDate}`;
    const box = escSql(cfg.inboxNotebookId);
    const find = async (): Promise<string> => {
        const rows = await sql(
            `SELECT id FROM blocks WHERE box='${box}' AND type='d' AND hpath='${escSql(hpath)}' LIMIT 1`);
        return rows.length ? rows[0].id : "";
    };
    const found = await find();
    if (found) {
        return found;
    }
    const segments = hpath.split("/").filter(Boolean);
    let prefix = "";
    for (let i = 0; i < segments.length - 1; i++) {
        prefix += "/" + segments[i];
        const rows = await sql(
            `SELECT id FROM blocks WHERE box='${box}' AND type='d' AND hpath='${escSql(prefix)}' LIMIT 1`);
        if (!rows.length) {
            await createDocWithMd(cfg.inboxNotebookId, prefix, "");
        }
    }
    const data: any = await createDocWithMd(cfg.inboxNotebookId, hpath, "");
    // 创建后 SQL 索引可能短暂滞后，优先使用接口返回的文档 ID
    const newId = typeof data === "string" ? data : (data?.id as string | undefined);
    if (newId) {
        return newId;
    }
    const created = await find();
    if (!created) {
        throw new Error("无法创建企微收集文档：" + hpath);
    }
    return created;
}

/** 把一条消息写入收集箱文档，返回登记的记录数（0/1） */
async function collectMessage(cfg: ExpenseConfig, body: any,
                              ctx: { logDebug: (m: string) => void }): Promise<number> {
    const msgType = String(body.msgtype || "");
    const time = fmtTime(Number(body.create_time) || undefined);
    const parts: string[] = [];

    const pushText = (t: string) => {
        const s = (t || "").trim();
        if (s) {
            parts.push(s);
        }
    };
    const saveMedia = async (ref: MediaRef, nameHint: string, isImage: boolean): Promise<string | null> => {
        const url = String(ref?.url || "");
        if (!url) {
            throw new Error("媒体消息缺少下载 URL");
        }
        const blob = await fetchRemoteBlob(url);
        let data: any = new Uint8Array(await blob.arrayBuffer());
        if (ref.aeskey) {
            data = decryptAesMedia(data, ref.aeskey);
        }
        // 服务端重试推送时同一文件会再次到达，按解密后内容 MD5 拦截重复
        const md5 = nodeMd5(data);
        if (md5) {
            if (seenMediaMd5.has(md5)) {
                ctx.logDebug("[wecom] 跳过重复媒体（MD5 相同）");
                return null;
            }
            seenMediaMd5.set(md5, Date.now());
            if (seenMediaMd5.size > 500) {
                seenMediaMd5.clear();
            }
        }
        const ext = isImage ? (sniffImageMime(data) || "png").replace("image/", "") : sniffFileExt(data);
        // 资产文件名必须 ASCII（中文文件名无法通过内核访问）；必须写入 /data/assets/ 才能被编辑器加载
        const assetPath = `/data/assets/wecom-${compactStamp()}-${randId()}.${ext}`;
        await putFile(assetPath, new Blob([data as BlobPart]));
        const refPath = assetPath.replace(/^\/data\//, "");
        if (isImage) {
            parts.push(`![](${refPath})`);
        } else {
            parts.push(`[📎 ${nameHint || "企微文件"}](${refPath})`);
        }
        return assetPath;
    };

    switch (msgType) {
        case "text":
            pushText(String(body.text?.content || ""));
            break;
        case "voice":
            pushText(`（语音）${String(body.voice?.content || "")}`);
            break;
        case "image":
            await saveMedia(body.image, "企微图片", true);
            break;
        case "file": {
            const name = String(body.file?.file_name || body.file_name || "");
            await saveMedia(body.file, name, false);
            break;
        }
        case "mixed":
            for (const item of (body.mixed?.msg_item || [])) {
                if (String(item?.msgtype) === "text") {
                    pushText(String(item?.text?.content || ""));
                } else if (String(item?.msgtype) === "image") {
                    await saveMedia(item?.image, "企微图片", true);
                }
            }
            break;
        default:
            pushText(`（暂不支持的消息类型：${msgType}）`);
            break;
    }
    const quote = body.quote;
    if (quote && quote.text?.content) {
        pushText(`（引用：${String(quote.text.content).slice(0, 50)}）`);
    }
    if (!parts.length) {
        return 0;
    }
    const md = `- 【企微 ${time}】${parts.join(" ")}`;
    const docId = await ensureWecomDoc(cfg, compactStamp().slice(0, 8));
    await appendBlock(docId, md);
    return 1;
}

export class WecomBotClient {
    private ws: WebSocket | null = null;
    private heartbeatTimer: number | null = null;
    private reconnectTimer: number | null = null;
    private closed = false;
    private reconnectDelayMs = 1000;
    private subscribeReqId = "";
    private seen = new Set<string>();
    /** 内容指纹 → 首次见到的时间，用于拦截服务端的短窗口重复投递 */
    private dupKeys = new Map<string, number>();
    private status: WecomStatus;

    constructor(private cfg: ExpenseConfig,
                private saveLog: (data: any) => Promise<void>,
                private logDebug: (msg: string) => void = () => {
                }) {
        this.status = {enabled: true, connected: false, received: 0, collected: 0, failed: 0};
    }

    start() {
        this.closed = false;
        this.status = {...this.status, enabled: true};
        this.connect();
    }

    stop() {
        this.closed = true;
        this.status.connected = false;
        this.stopHeartbeat();
        if (this.reconnectTimer !== null) {
            window.clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            try {
                this.ws.close();
            } catch {
                // 忽略
            }
            this.ws = null;
        }
        this.persistStatus();
    }

    private connect() {
        if (this.closed) {
            return;
        }
        const url = (this.cfg.wecomWsUrl || DEFAULT_WS_URL).trim();
        this.logDebug(`[wecom] 连接 ${url}…`);
        // 先彻底脱钩并关闭旧连接，避免新旧连接竞态导致丢消息
        if (this.ws) {
            const old = this.ws;
            this.ws = null;
            old.onopen = null;
            old.onmessage = null;
            old.onerror = null;
            old.onclose = null;
            try {
                old.close();
            } catch {
                // 忽略
            }
        }
        let ws: WebSocket;
        try {
            ws = new WebSocket(url);
        } catch (e: any) {
            this.scheduleReconnect("创建连接失败：" + (e?.message || e));
            return;
        }
        this.ws = ws;
        ws.onopen = () => {
            this.reconnectDelayMs = 1000;
            this.subscribeReqId = randId();
            this.send({
                cmd: "aibot_subscribe",
                headers: {req_id: this.subscribeReqId},
                body: {bot_id: this.cfg.wecomBotId, secret: this.cfg.wecomSecret},
            });
        };
        ws.onmessage = (ev) => {
            void this.handleFrame(ev.data);
        };
        ws.onerror = () => {
            // onclose 随后触发，统一在 onclose 处理重连
        };
        ws.onclose = (ev) => {
            this.status.connected = false;
            this.ws = null;
            this.stopHeartbeat();
            if (!this.closed) {
                this.scheduleReconnect(`连接断开（code=${ev.code}）`);
            }
        };
    }

    private scheduleReconnect(reason: string) {
        this.status.lastError = reason;
        this.logDebug(`[wecom] ${reason}，${this.reconnectDelayMs}ms 后重连`);
        this.persistStatus();
        if (this.reconnectTimer !== null || this.closed) {
            return;
        }
        this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = null;
            this.reconnectDelayMs = Math.min(30_000, this.reconnectDelayMs * 2);
            this.connect();
        }, this.reconnectDelayMs);
    }

    private startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = window.setInterval(() => {
            this.send({cmd: "ping", headers: {req_id: randId()}});
        }, HEARTBEAT_MS);
    }

    private stopHeartbeat() {
        if (this.heartbeatTimer !== null) {
            window.clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    private send(frame: WsFrame) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(frame));
        }
    }

    private async handleFrame(raw: any) {
        let frame: WsFrame;
        try {
            frame = JSON.parse(typeof raw === "string" ? raw : String(raw));
        } catch {
            return;
        }
        const cmd = String(frame.cmd || "");
        if (cmd === "aibot_msg_callback") {
            await this.handleMessage(frame);
            return;
        }
        if (cmd) {
            // 其他服务端推送（事件等）暂不处理
            return;
        }
        // 无 cmd 的帧：订阅响应 / 心跳响应 / 回执，按 req_id 匹配
        if (frame.errcode === 0 && frame.headers?.req_id === this.subscribeReqId) {
            this.status.connected = true;
            this.status.lastError = undefined;
            this.status.lastConnectedAt = new Date().toISOString();
            this.logDebug("[wecom] 订阅成功，开始接收消息");
            this.startHeartbeat();
            this.persistStatus();
            return;
        }
        if (frame.errcode !== undefined && frame.errcode !== 0) {
            const msg = `服务端错误 ${frame.errcode}：${frame.errmsg || ""}`;
            this.status.lastError = msg;
            if (frame.headers?.req_id === this.subscribeReqId) {
                // 认证失败，重连无意义，停止并保留错误信息
                this.closed = true;
                this.status.connected = false;
                this.stopHeartbeat();
                try {
                    this.ws?.close();
                } catch {
                    // 忽略
                }
                this.logDebug(`[wecom] ${msg}（订阅失败已停止，请检查 Bot ID / Secret）`);
            } else {
                this.logDebug(`[wecom] ${msg}`);
            }
            this.persistStatus();
        }
    }

    private async handleMessage(frame: WsFrame) {
        const body = frame.body || {};
        const msgId = String(body.msgid || "");
        if (msgId && this.seen.has(msgId)) {
            return;
        }
        if (msgId) {
            this.seen.add(msgId);
            if (this.seen.size > SEEN_MAX) {
                const iter = this.seen.values();
                for (let i = 0; i < SEEN_MAX / 2; i++) {
                    const v = iter.next().value;
                    if (v !== undefined) {
                        this.seen.delete(v);
                    }
                }
            }
        }
        this.status.received++;
        const userId = String(body.from?.userid || "");
        if (this.cfg.wecomUserId && userId !== this.cfg.wecomUserId) {
            this.logDebug(`[wecom] 忽略非目标成员 ${userId} 的消息`);
            this.persistStatus();
            return;
        }
        // 文字类消息按规范化内容做短窗口去重（服务端重试推送时 msgid 会变）
        const msgType = String(body.msgtype || "");
        if (msgType === "text" || msgType === "voice") {
            const norm = String(body.text?.content || body.voice?.content || "").replace(/\s+/g, "");
            if (norm && this.isRecentDup(`t|${userId}|${norm}`, 120_000)) {
                this.logDebug("[wecom] 跳过 120 秒内重复投递的文字消息");
                this.persistStatus();
                return;
            }
        }
        try {
            const n = await collectMessage(this.cfg, body, {logDebug: (m) => this.logDebug(m)});
            this.status.collected += n;
            this.logDebug(`[wecom] 已收集 ${n} 条消息（msgtype=${body.msgtype}）`);
        } catch (e: any) {
            this.status.failed++;
            this.status.lastError = String(e?.message || e);
            this.logDebug(`[wecom] 消息落库失败：${e?.message || e}`);
        }
        // 回执：告知服务端消息已处理，避免其重试推送造成重复
        if (frame.headers?.req_id) {
            this.send({
                cmd: "aibot_msg_callback",
                headers: {req_id: frame.headers.req_id},
                errcode: 0,
                errmsg: "ok",
            });
        }
        this.persistStatus();
    }

    private isRecentDup(key: string, windowMs: number): boolean {
        const now = Date.now();
        for (const [k, t] of this.dupKeys) {
            if (now - t > windowMs) {
                this.dupKeys.delete(k);
            }
        }
        if (this.dupKeys.has(key)) {
            return true;
        }
        this.dupKeys.set(key, now);
        return false;
    }

    private persistStatus() {
        this.saveLog({...this.status, updatedAt: new Date().toISOString()}).catch(() => {
        });
    }
}
