const vscode = acquireVsCodeApi();
// 面板里还有第二个脚本负责「企微对话」那一区，而 acquireVsCodeApi 每个 webview 只能调一次，
// 所以把它挂到 window 上共享，两个脚本各管自己的 DOM。
window.__libiaoCopilotApi = vscode;

const DEFAULT_MIN_DURATION_SECONDS = 600;
const DEFAULT_SESSION_SUMMARY_CHARS = 60;
// 打字过程中不逐字落盘，停下来再存；下拉、勾选这类一次性操作立即存
const AUTO_SAVE_DELAY_MS = 500;

const elements = {
	introSection: document.getElementById("introSection"),
	createHook: document.getElementById("createHook"),
	mainSection: document.getElementById("mainSection"),
	enabled: document.getElementById("enabled"),
	webhook: document.getElementById("webhook"),
	webhookHelp: document.getElementById("webhookHelp"),
	toggleWebhook: document.getElementById("toggleWebhook"),
	minDurationSeconds: document.getElementById("minDurationSeconds"),
	minDurationHuman: document.getElementById("minDurationHuman"),
	sessionSummaryChars: document.getElementById("sessionSummaryChars"),
	configPath: document.getElementById("configPath"),
	configPathHint: document.getElementById("configPathHint"),
	saveHint: document.getElementById("saveHint"),
	openConfigFile: document.getElementById("openConfigFile"),
	testWebhook: document.getElementById("testWebhook"),
	testResultNotice: document.getElementById("testResultNotice"),
	testResultText: document.getElementById("testResultText"),
	powerShellNotice: document.getElementById("powerShellNotice"),
	powerShellText: document.getElementById("powerShellText"),
	installPowerShell: document.getElementById("installPowerShell"),
	scriptNotice: document.getElementById("scriptNotice"),
	scriptVersionText: document.getElementById("scriptVersionText"),
	updateScript: document.getElementById("updateScript"),
};

let autoSaveTimer;
// 最后成功落盘的参数快照：没变就不重复写盘，避免一次编辑触发 N 次保存
let lastSavedSignature = "";
let canModifyNow = false;

function parseInteger(input, fallback) {
	const value = Number.parseInt(input.value, 10);
	return Number.isFinite(value) ? value : fallback;
}

// 自动保存会在输入过程中回推状态，正在编辑的框不覆盖，否则光标会被拽走
function setInputValue(element, value) {
	if (document.activeElement === element) {
		return;
	}
	element.value = value;
}

function collectSettings() {
	return {
		enabled: elements.enabled.checked,
		webhook: elements.webhook.value.trim(),
		minDurationSeconds: parseInteger(elements.minDurationSeconds, DEFAULT_MIN_DURATION_SECONDS),
		sessionSummaryChars: parseInteger(elements.sessionSummaryChars, DEFAULT_SESSION_SUMMARY_CHARS),
	};
}

function showSaveHint(text) {
	elements.saveHint.textContent = text;
	elements.saveHint.classList.toggle("visible", Boolean(text));
}

// 秒数难以直观感受，换算成天/小时/分钟/秒；零头单位省略，全零时保留「0 秒」
function formatDuration(seconds) {
	const total = Math.max(0, Math.trunc(seconds));
	if (total === 0) {
		return "0 秒";
	}
	let rest = total;
	const parts = [];
	for (const [size, label] of [[86400, "天"], [3600, "小时"], [60, "分钟"], [1, "秒"]]) {
		const value = Math.floor(rest / size);
		rest -= value * size;
		if (value > 0) {
			parts.push(value + " " + label);
		}
	}
	return parts.join(" ");
}

function renderMinDurationHint() {
	const seconds = parseInteger(elements.minDurationSeconds, DEFAULT_MIN_DURATION_SECONDS);
	elements.minDurationHuman.textContent = "= " + formatDuration(seconds);
}

// webhook 为空时给获取步骤卡片加流动光效；卡片展开后提示已达成，不再闪
function renderWebhookHelpHint() {
	const empty = elements.webhook.value.trim() === "";
	elements.webhookHelp.classList.toggle("glowing", empty && !elements.webhookHelp.open);
}

function scheduleAutoSave(delay) {
	clearTimeout(autoSaveTimer);
	autoSaveTimer = setTimeout(flushAutoSave, delay);
}

function flushAutoSave() {
	clearTimeout(autoSaveTimer);
	autoSaveTimer = undefined;
	if (!canModifyNow) {
		return;
	}
	const settings = collectSettings();
	const signature = JSON.stringify(settings);
	if (signature === lastSavedSignature) {
		return;
	}
	// 先记下快照：写盘失败时宿主会推回磁盘真实状态，由 applyState 重置快照，重试仍能生效
	lastSavedSignature = signature;
	showSaveHint("保存中…");
	vscode.postMessage({ type: "save", settings });
}

// 只在环境不匹配或脚本待升级时出现；一切正常时除参数外不留状态噪音
function renderIssues(setup) {
	const powerShell = setup.powershell;
	elements.powerShellNotice.hidden = powerShell.ok;
	elements.powerShellText.textContent = powerShell.ok ? "" : powerShell.detail || "未检测到 PowerShell 7";

	const script = setup.script;
	const needsUpdate = script.status === "outdated" || script.status === "unknown";
	elements.scriptNotice.hidden = !needsUpdate;
	elements.scriptVersionText.textContent = needsUpdate ? describeScriptUpdate(script) : "";
}

function describeScriptUpdate(script) {
	if (script.status === "outdated") {
		const localEditNote = script.identical ? "" : "，与模板有差异（含你的修改）";
		return script.installedVersion + " → " + script.templateVersion + " 可更新" + localEditNote;
	}
	return script.installedVersion
		? "模板未声明版本号（本地 " + script.installedVersion + "）"
		: "未检测到版本号，可能是旧版脚本，建议更新";
}

function setNotifySectionDisabled(disabled) {
	elements.mainSection.classList.toggle("locked", disabled);
	for (const element of elements.mainSection.querySelectorAll("input, button")) {
		// 测试连通性只发 HTTP、不写文件，跟 pwsh 是否存在无关，所以不跟着整段锁死
		if (element.hasAttribute("data-keep-enabled")) {
			continue;
		}
		element.disabled = disabled;
	}
}

function renderTestResult(result) {
	elements.testWebhook.disabled = false;
	elements.testWebhook.textContent = "测试连通性";
	elements.testResultNotice.hidden = false;
	elements.testResultNotice.classList.toggle("ok", result.ok);
	elements.testResultNotice.classList.toggle("error", !result.ok);
	elements.testResultText.textContent = result.detail;
}

function applyState(config, setup) {
	elements.introSection.hidden = setup.created;
	elements.mainSection.hidden = !setup.created;

	if (!setup.created) {
		// 未创建时只留介绍与创建按钮，参数与检测结论等创建完成后再渲染
		canModifyNow = false;
		elements.createHook.disabled = false;
		elements.createHook.textContent = "创建企微联动";
		return;
	}

	const settings = config.settings;
	setInputValue(elements.webhook, settings.webhook);
	setInputValue(elements.minDurationSeconds, settings.minDurationSeconds);
	setInputValue(elements.sessionSummaryChars, settings.sessionSummaryChars);
	if (document.activeElement !== elements.enabled) {
		elements.enabled.checked = settings.enabled;
	}
	renderMinDurationHint();
	renderWebhookHelpHint();
	lastSavedSignature = JSON.stringify(settings);

	elements.configPath.textContent = config.configPath || "未打开工作区";
	elements.configPathHint.textContent = config.configPath
		? config.exists
			? ""
			: "（尚未创建，保存后生成）"
		: "（无法定位配置文件）";

	// 没有 pwsh 时整段只读：存了也发不出通知，允许编辑只会制造"配好了"的错觉
	canModifyNow = setup.canModify && Boolean(config.configPath);
	setNotifySectionDisabled(!setup.canModify);
	elements.openConfigFile.disabled = !config.configPath;
}

elements.toggleWebhook.addEventListener("click", () => {
	const showing = elements.webhook.type === "text";
	elements.webhook.type = showing ? "password" : "text";
	elements.toggleWebhook.textContent = showing ? "显示" : "隐藏";
});

elements.openConfigFile.addEventListener("click", () => {
	vscode.postMessage({ type: "openConfigFile" });
});

elements.createHook.addEventListener("click", () => {
	// 创建要写多个文件，先锁按钮避免重复点击；失败时宿主推回真实状态会自动解锁
	elements.createHook.disabled = true;
	elements.createHook.textContent = "创建中…";
	vscode.postMessage({ type: "create" });
});

elements.installPowerShell.addEventListener("click", () => {
	vscode.postMessage({ type: "installPowerShell" });
});

elements.updateScript.addEventListener("click", () => {
	vscode.postMessage({ type: "updateScript" });
});

elements.testWebhook.addEventListener("click", () => {
	elements.testWebhook.disabled = true;
	elements.testWebhook.textContent = "测试中…";
	elements.testResultNotice.hidden = true;
	vscode.postMessage({ type: "testWebhook", webhook: elements.webhook.value.trim() });
});

elements.webhook.addEventListener("input", () => {
	// 地址改过之后，上一次的测试结论就不再对应当前地址，直接收起来
	elements.testResultNotice.hidden = true;
	renderWebhookHelpHint();
	scheduleAutoSave(AUTO_SAVE_DELAY_MS);
});

elements.webhookHelp.addEventListener("toggle", renderWebhookHelpHint);

// 失焦与勾选、数值改动都是离散操作，直接落盘；只有连续打字才走防抖
elements.webhook.addEventListener("change", flushAutoSave);
elements.enabled.addEventListener("change", flushAutoSave);
elements.minDurationSeconds.addEventListener("change", flushAutoSave);
elements.sessionSummaryChars.addEventListener("change", flushAutoSave);

// 数字框打字（含上下键微调）同样自动保存，避免只改一半就关面板丢改动
elements.minDurationSeconds.addEventListener("input", () => {
	renderMinDurationHint();
	scheduleAutoSave(AUTO_SAVE_DELAY_MS);
});
elements.minDurationSeconds.addEventListener("change", renderMinDurationHint);
elements.sessionSummaryChars.addEventListener("input", () => scheduleAutoSave(AUTO_SAVE_DELAY_MS));

window.addEventListener("message", (event) => {
	const message = event.data;
	if (message.type === "testResult") {
		renderTestResult(message.result);
		return;
	}
	if (message.type === "saved") {
		showSaveHint("已保存");
		return;
	}
	if (message.type === "init") {
		applyState(message.config, message.setup);
		renderIssues(message.setup);
		// 推回的状态就是磁盘真实状态：还在“保存中…”说明上一次没成功或被覆盖，先收起来
		showSaveHint("");
	}
});

vscode.postMessage({ type: "requestInit" });
