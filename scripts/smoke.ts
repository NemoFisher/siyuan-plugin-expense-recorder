// 冒烟测试：验证纯函数（JSON 解析、记录规整、登记格式、路径模板），不依赖思源环境
import {buildSystemPrompt, extractJson, parseRecords} from "../src/recognizer";
import {buildDocPath, buildRecordMarkdown, extractImageRefs, localToday} from "../src/processor";
import {DEFAULT_CONFIG} from "../src/types";

const cfg = {...DEFAULT_CONFIG, apiKey: "test"};
const today = localToday();

// --- extractJson：兼容数组输出、```围栏、JSON 后附带说明文字 ---
const arrOutput = extractJson("```json\n[{\"amount\": 5}, {\"amount\": 6}]\n```\n以上是识别结果。");
if (!Array.isArray(arrOutput) || arrOutput.length !== 2) {
    throw new Error("extractJson 无法解析数组输出");
}
const objOutput = extractJson('垃圾输出 {"records":[{"amount":7}]}，请查收');
if (objOutput.records.length !== 1) {
    throw new Error("extractJson 无法解析对象输出");
}

// --- parseRecords：数组形状、编造的未来日期、缺年份、科目=商家 ---
const records = parseRecords([
    {date: "2026-09-01", time: "12:30", amount: "38.5", currency: "cny", category: "餐饮",
     location: "美团外卖", merchant: "肯德基", note: "午餐"},
    {date: "2099-01-01", time: "9:5", amount: 16.05, currency: "CNY", category: "统一超商(上海)便利",
     location: "", merchant: "统一超商(上海)便利", note: ""},
    {date: "9/23", time: "8点02", amount: 32, currency: "CNY", category: "", location: "", merchant: "嘀嘀香", note: ""},
], cfg, "2026-09-23");
console.log(JSON.stringify(records, null, 2));
if (records.length !== 3) {
    throw new Error(`应解析出 3 条有效记录，实际 ${records.length}`);
}
if (records[1].date !== "2026-09-23") {
    throw new Error("未来日期未归为今天");
}
if (records[1].category !== "其他") {
    throw new Error("科目=商家时未回落为其他");
}
if (records[2].date !== "2026-09-23" || records[2].time !== "08:02" || records[2].category !== "其他") {
    throw new Error("缺年份日期/中文时间/空科目处理错误");
}

// --- extractImageRefs：本地 assets、云端外链、img 标签 ---
const md = `开头
![截图](assets/20260923-a.png "title"){: style="width:100px"}
![cloud](https://assets.b3logfile.com/siyuan/1/assets/wechat-chat-img1.jpg)
<img src="https://example.com/x.jpg" alt="x">`;
const refs = extractImageRefs(md);
console.log(refs);
if (refs.length !== 3 || !refs[0].startsWith("assets/") || !refs[1].startsWith("https://")
    || refs[2] !== "https://example.com/x.jpg") {
    throw new Error("图片引用提取错误");
}

const md2 = buildRecordMarkdown(records[0], "20260901120000-abcdefg");
console.log(md2);
for (const keyword of ["¥38.5", "科目：餐饮", "2026-09-01 12:30", "地点：美团外卖", "siyuan://blocks/20260901120000-abcdefg"]) {
    if (!md2.includes(keyword)) {
        throw new Error(`登记文本缺少 ${keyword}`);
    }
}

if (buildDocPath(cfg, "20260901") !== "/消费记录/20260901") {
    throw new Error("路径模板替换错误");
}
const prompt = buildSystemPrompt(cfg, today);
if (!prompt.includes(today) || !prompt.includes("严禁编造日期")) {
    throw new Error("系统提示词缺少今天日期或防编造日期规则");
}
console.log("SMOKE OK");
