// Mock 企业微信智能机器人（长连接模式）：用于端到端测试插件采集链路
// 用法：node scripts/mock-wecom-bot.mjs [port] [图片路径]
// 行为：订阅成功后依次推送 文本 / 语音 / 图片(AES-256-CBC 加密) / 文件 四条消息
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import {WebSocketServer} from "ws";

const PORT = Number(process.argv[2] || 18765);
const IMG_PATH = process.argv[3] || "icon.png";
const plain = fs.readFileSync(IMG_PATH);

// 官方加密规则：AES-256-CBC，key=base64 解码后的 32 字节，IV=key 前 16 字节，PKCS#7 按 32 字节块填充
function encryptForWecom(plaintext) {
    const key = crypto.randomBytes(32);
    const iv = key.subarray(0, 16);
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    cipher.setAutoPadding(false);
    const padLen = 32 - (plaintext.length % 32);
    const padded = Buffer.concat([plaintext, Buffer.alloc(padLen, padLen)]);
    const body = Buffer.concat([cipher.update(padded), cipher.final()]);
    return {body, aeskey: key.toString("base64")};
}

const mediaStore = new Map();
function addMedia(buf) {
    const id = crypto.randomBytes(6).toString("hex");
    mediaStore.set(id, buf);
    return `http://127.0.0.1:${PORT}/media/${id}`;
}

const encImg = encryptForWecom(plain);
const encFile = encryptForWecom(fs.readFileSync(process.argv[4] || Buffer.from("%PDF-1.4 mock expense pdf")));
const imgMediaUrl = addMedia(encImg.body);
const fileMediaUrl = addMedia(encFile.body);

const SID = crypto.randomBytes(3).toString("hex");
const nowSec = () => Math.floor(Date.now() / 1000);

const MESSAGES = [
    {
        msgid: `mock-text-1-${SID}`, chattype: "single", from: {userid: "mock-user"},
        msgtype: "text", text: {content: "【模拟测试】中午和客户吃饭花了 358 元"}, create_time: nowSec(),
    },
    {
        msgid: `mock-voice-1-${SID}`, chattype: "single", from: {userid: "mock-user"},
        msgtype: "voice", voice: {content: "【模拟测试】打车花了二十三块五"}, create_time: nowSec(),
    },
    {
        msgid: `mock-image-1-${SID}`, chattype: "single", from: {userid: "mock-user"},
        msgtype: "image", image: {url: imgMediaUrl, aeskey: encImg.aeskey}, create_time: nowSec(),
    },
    {
        msgid: `mock-file-1-${SID}`, chattype: "single", from: {userid: "mock-user"},
        msgtype: "file", file: {url: fileMediaUrl, aeskey: encFile.aeskey, file_name: "模拟测试报销单.pdf"}, create_time: nowSec(),
    },
];

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const id = url.pathname.replace("/media/", "");
    if (mediaStore.has(id)) {
        res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Access-Control-Allow-Origin": "*",
        });
        res.end(mediaStore.get(id));
        return;
    }
    res.writeHead(404, {"Access-Control-Allow-Origin": "*"});
    res.end("not found");
});

const wss = new WebSocketServer({server});
let subscribed = false;

wss.on("connection", (socket) => {
    console.log("[mock] client connected");
    socket.on("message", (raw) => {
        let frame;
        try {
            frame = JSON.parse(raw.toString());
        } catch {
            return;
        }
        const reqId = frame.headers?.req_id || "";
        console.log("[mock] <-", frame.cmd || "(no cmd)", reqId);
        if (frame.cmd === "aibot_subscribe") {
            socket.send(JSON.stringify({headers: {req_id: reqId}, errcode: 0, errmsg: "ok"}));
            // 每次新连接都重新推送一轮，便于重连场景测试
            MESSAGES.forEach((msg, i) => {
                setTimeout(() => {
                    if (socket.readyState === socket.OPEN) {
                        socket.send(JSON.stringify({
                            cmd: "aibot_msg_callback",
                            headers: {req_id: `push-${Date.now()}-${i}`},
                            body: msg,
                        }));
                        console.log("[mock] -> pushed", msg.msgtype, msg.msgid);
                    }
                }, 2000 + i * 2000);
            });
            return;
        }
        if (frame.cmd === "ping") {
            socket.send(JSON.stringify({headers: {req_id: reqId}, errcode: 0, errmsg: "ok"}));
        }
    });
});

server.listen(PORT, () => {
    console.log(`[mock] WeCom bot mock listening on ws://127.0.0.1:${PORT}`);
});
