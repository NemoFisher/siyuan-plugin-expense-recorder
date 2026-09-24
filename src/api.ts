// 思源内核 API 封装（运行于渲染进程，同源调用无需额外鉴权，带 token 更稳妥）

declare global {
    interface Window {
        siyuan?: {
            config?: {
                api?: { token: string };
            };
        };
    }
}

function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {"Content-Type": "application/json"};
    const token = window.siyuan?.config?.api?.token;
    if (token) {
        headers["Authorization"] = `Token ${token}`;
    }
    return headers;
}

async function request<T = any>(url: string, data?: unknown): Promise<T> {
    const resp = await fetch(url, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(data ?? {}),
    });
    if (!resp.ok) {
        throw new Error(`请求 ${url} 失败：HTTP ${resp.status}`);
    }
    const json = await resp.json();
    if (json.code !== 0) {
        throw new Error(json.msg || `请求 ${url} 失败：code=${json.code}`);
    }
    return json.data as T;
}

export interface Notebook {
    id: string;
    name: string;
    icon: string;
    closed: boolean;
}

export function lsNotebooks(): Promise<Notebook[]> {
    return request<{ notebooks: Notebook[] }>("/api/notebook/lsNotebooks")
        .then(d => (d.notebooks || []).filter(n => !n.closed));
}

export interface BlockRow {
    id: string;
    parent_id: string;
    root_id: string;
    type: string;
    content: string;
    markdown: string;
    hpath: string;
    /** assets 表字段 */
    block_id: string;
    path: string;
}

export async function sql(stmt: string): Promise<BlockRow[]> {
    const data = await request<any[]>("/api/query/sql", {stmt});
    return Array.isArray(data) ? data : [];
}

/** 读取工作区文件（path 形如 /data/assets/xxx.png），返回原始 Blob */
export async function getFileBlob(path: string): Promise<Blob> {
    const resp = await fetch("/api/file/getFile", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({path}),
    });
    if (!resp.ok) {
        throw new Error(`读取文件失败：${path}（HTTP ${resp.status}）`);
    }
    return resp.blob();
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("图片转 base64 失败"));
        reader.readAsDataURL(blob);
    });
}

export function setBlockAttrs(id: string, attrs: Record<string, string>): Promise<unknown> {
    return request("/api/attr/setBlockAttrs", {id, attrs});
}

/** 追加 markdown 块，返回新建块的 ID 列表 */
export async function appendBlock(parentID: string, data: string): Promise<string[]> {
    const result = await request<any>("/api/block/appendBlock", {dataType: "markdown", data, parentID});
    const ops = result?.[0]?.doOperations || [];
    const ids: string[] = [];
    for (const op of ops) {
        if (typeof op?.id === "string" && op.id && !ids.includes(op.id)) {
            ids.push(op.id);
        }
    }
    return ids;
}

export function createDocWithMd(notebook: string, path: string, markdown: string): Promise<unknown> {
    return request("/api/filetree/createDocWithMd", {notebook, path, markdown});
}

export function renderAttributeView(avId: string, page?: number, pageSize?: number): Promise<any> {
    const payload: any = {id: avId};
    if (page !== undefined) {
        payload.page = page;
    }
    if (pageSize !== undefined) {
        payload.pageSize = pageSize;
    }
    return request("/api/av/renderAttributeView", payload);
}

export function addAttributeViewKey(avId: string, keyId: string, keyType: string,
                                    keyName: string, previousKeyID: string): Promise<unknown> {
    return request("/api/av/addAttributeViewKey", {
        avID: avId, keyID: keyId, keyType, keyName, keyIcon: "", name: keyName, icon: "", previousKeyID,
    });
}

export function removeAttributeViewKey(avId: string, keyId: string): Promise<unknown> {
    return request("/api/av/removeAttributeViewKey", {avID: avId, keyID: keyId});
}

/** rows: 每行为 av.Value 数组（含 keyID 与类型化字段），详见内核 appendAttributeViewDetachedBlocksWithValues */
export function appendAttributeViewDetachedBlocksWithValues(avId: string, rows: any[][]): Promise<unknown> {
    return request("/api/av/appendAttributeViewDetachedBlocksWithValues", {avID: avId, blocksValues: rows});
}

export function updateBlock(id: string, markdown: string): Promise<unknown> {
    return request("/api/block/updateBlock", {id, dataType: "markdown", data: markdown});
}

/** 以 DOM 形式插入块（用于向文档嵌入数据库镜像块） */
export function insertBlockDom(data: string, previousID: string): Promise<unknown> {
    return request("/api/block/insertBlock", {dataType: "dom", data, previousID});
}

export function deleteBlock(id: string): Promise<unknown> {
    return request("/api/block/deleteBlock", {id});
}

/** 上传文件到工作区 assets 目录（path 形如 assets/xxx.png） */
export async function putFile(path: string, blob: Blob): Promise<void> {
    const form = new FormData();
    form.append("path", path);
    form.append("file", blob, path.split("/").pop() || "file");
    const headers: Record<string, string> = {};
    const token = window.siyuan?.config?.api?.token;
    if (token) {
        headers["Authorization"] = `Token ${token}`;
    }
    const resp = await fetch("/api/file/putFile", {method: "POST", headers, body: form});
    if (!resp.ok) {
        throw new Error(`上传资产失败：HTTP ${resp.status}`);
    }
    const json = await resp.json();
    if (json.code !== 0) {
        throw new Error("上传资产失败：" + (json.msg || json.code));
    }
}

/** 下载远端资源：优先渲染进程 fetch，受 CORS 限制时回退 Node http(s) */
export async function fetchRemoteBlob(url: string): Promise<Blob> {
    try {
        const resp = await fetch(url);
        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
        }
        return await resp.blob();
    } catch (e) {
        const nodeHttp = (window as any).require?.(url.toLowerCase().startsWith("https") ? "https" : "http");
        if (!nodeHttp?.get) {
            throw e;
        }
        return new Promise<Blob>((resolve, reject) => {
            const get = (u: string, redirects: number) => {
                if (redirects > 5) {
                    reject(new Error("下载重定向次数过多"));
                    return;
                }
                nodeHttp.get(u, (res: any) => {
                    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers?.location) {
                        res.resume();
                        get(new URL(res.headers.location, u).toString(), redirects + 1);
                        return;
                    }
                    if (res.statusCode !== 200) {
                        res.resume();
                        reject(new Error(`下载失败：HTTP ${res.statusCode}`));
                        return;
                    }
                    const chunks: Buffer[] = [];
                    res.on("data", (c: Buffer) => chunks.push(c));
                    res.on("end", () => resolve(new Blob([Buffer.concat(chunks)])));
                }).on("error", (err: any) => reject(err));
            };
            get(url, 0);
        });
    }
}

/** 通过文件头嗅探图片 MIME（本地资产经 getFile 返回的 MIME 常为 octet-stream） */
export function sniffImageMime(b: Uint8Array): string | null {
    if (b.length < 12) {
        return null;
    }
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) {
        return "image/png";
    }
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) {
        return "image/jpeg";
    }
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
        return "image/gif";
    }
    if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
        return "image/webp";
    }
    return null;
}

/** 转 data URL；MIME 不明时按文件头嗅探，保证视觉模型能识别本地资产图片 */
export async function blobToImageDataUrl(blob: Blob): Promise<string> {
    if (blob.type && blob.type.startsWith("image/")) {
        return blobToDataUrl(blob);
    }
    const buf = new Uint8Array(await blob.arrayBuffer());
    const mime = sniffImageMime(buf);
    if (!mime) {
        return blobToDataUrl(blob);
    }
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < buf.length; i += chunk) {
        binary += String.fromCharCode(...buf.subarray(i, i + chunk));
    }
    return `data:${mime};base64,${btoa(binary)}`;
}
