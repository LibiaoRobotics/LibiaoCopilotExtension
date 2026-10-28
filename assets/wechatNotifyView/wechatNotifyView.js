const vscode = acquireVsCodeApi();

const DEFAULT_MIN_DURATION_SECONDS = 30;
const DEFAULT_SESSION_SUMMARY_CHARS = 60;

const elements = {
	enabled: document.getElementById("enabled"),
	webhook: document.getElementById("webhook"),
	toggleWebhook: document.getElementById("toggleWebhook"),
	minDurationSeconds: document.getElementById("minDurationSeconds"),
	sessionSummaryChars: document.getElementById("sessionSummaryChars"),
	configPath: document.getElementById("configPath"),
	configPathHint: document.getElementById("configPathHint"),
	save: document.getElementById("save"),
	openConfigFile: document.getElementById("openConfigFile"),
	testWebhook: document.getElementById("testWebhook"),
	testResultNotice: document.getElementById("testResultNotice"),
	testResultText: document.getElementById("testResultText"),
	notifySection: document.getElementById("notifySection"),
	readinessList: document.getElementById("readinessList"),
	readinessMessage: document.getElementById("readinessMessage"),
	powerShellText: document.getElementById("powerShellText"),
	installPowerShell: document.getElementById("installPowerShell"),
	hookDirPath: document.getElementById("hookDirPath"),
	createHook: document.getElementById("createHook"),
	recheckPowerShell: document.getElementById("recheckPowerShell"),
	scriptVersionNotice: document.getElementById("scriptVersionNotice"),
	scriptVersionText: document.getElementById("scriptVersionText"),
	updateScript: document.getElementById("updateScript"),
};

function parseInteger(input, fallback) {
	const value = Number.parseInt(input.value, 10);
	return Number.isFinite(value) ? value : fallback;
}

function collectSettings() {
	return {
		enabled: elements.enabled.checked,
		webhook: elements.webhook.value.trim(),
		minDurationSeconds: parseInteger(elements.minDurationSeconds, DEFAULT_MIN_DURATION_SECONDS),
		sessionSummaryChars: parseInteger(elements.sessionSummaryChars, DEFAULT_SESSION_SUMMARY_CHARS),
	};
}

function renderReadiness(setup) {
	elements.readinessList.textContent = "";
	for (const item of setup.items) {
		const li = document.createElement("li");
		li.className = "readiness-item";

		const icon = document.createElement("span");
		icon.className = "readiness-icon " + (item.exists ? "ok" : "missing");
		icon.textContent = item.exists ? "\u2713" : "\u2717";

		const name = document.createElement("code");
		name.textContent = item.fileName;

		const desc = document.createElement("span");
		desc.className = "muted";
		desc.textContent = item.description;

		li.append(icon, name, desc);
		elements.readinessList.append(li);
	}

	elements.readinessMessage.textContent = setup.message || "";
	elements.readinessMessage.hidden = !setup.message;
	elements.readinessMessage.classList.toggle("warn", !setup.canModify);

	const powerShell = setup.powershell;
	if (powerShell.ok) {
		elements.powerShellText.textContent = powerShell.executablePath
			? powerShell.version + "（" + powerShell.executablePath + "）"
			: powerShell.version;
	} else {
		elements.powerShellText.textContent = powerShell.detail || "未检测到 PowerShell 7";
	}
	elements.installPowerShell.hidden = powerShell.ok;

	elements.hookDirPath.textContent = setup.hookDirPath || "未打开工作区";
	elements.createHook.disabled = !setup.canModify;
}

function renderScriptInfo(script) {
	elements.scriptVersionNotice.hidden = script.status === "missing";
	elements.updateScript.hidden = script.status !== "outdated" && script.status !== "unknown";
	elements.scriptVersionNotice.classList.toggle("warn", script.status === "outdated");

	const localEditNote = script.identical ? "" : "，与模板有差异（含你的修改）";
	if (script.status === "missing") {
		elements.scriptVersionText.textContent = "";
	} else if (script.status === "unknown") {
		elements.scriptVersionText.textContent = script.installedVersion
			? "模板未声明版本号（本地 " + script.installedVersion + "）"
			: "未检测到版本号，可能是旧版脚本，建议更新";
	} else if (script.status === "outdated") {
		elements.scriptVersionText.textContent =
			script.installedVersion + " → " + script.templateVersion + " 可更新" + localEditNote;
	} else {
		elements.scriptVersionText.textContent =
			script.installedVersion + (script.identical ? "（与模板一致）" : "（已是最新，含本地修改）");
	}
}

function setNotifySectionDisabled(disabled) {
	elements.notifySection.classList.toggle("locked", disabled);
	for (const element of elements.notifySection.querySelectorAll("input, button")) {
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
	const settings = config.settings;
	elements.enabled.checked = settings.enabled;
	elements.webhook.value = settings.webhook;
	elements.minDurationSeconds.value = settings.minDurationSeconds;
	elements.sessionSummaryChars.value = settings.sessionSummaryChars;

	elements.configPath.textContent = config.configPath || "未打开工作区";
	elements.configPathHint.textContent = config.configPath
		? config.exists
			? ""
			: "（尚未创建，保存后生成）"
		: "（无法定位配置文件）";

	// 没有 pwsh 时整段只读：存了也发不出通知，允许编辑只会制造"配好了"的错觉
	setNotifySectionDisabled(!setup.canModify);
	elements.save.disabled = !setup.canModify || !config.configPath;
	elements.openConfigFile.disabled = !config.configPath;
}

elements.toggleWebhook.addEventListener("click", () => {
	const showing = elements.webhook.type === "text";
	elements.webhook.type = showing ? "password" : "text";
	elements.toggleWebhook.textContent = showing ? "显示" : "隐藏";
});

elements.save.addEventListener("click", () => {
	vscode.postMessage({ type: "save", settings: collectSettings() });
});

elements.openConfigFile.addEventListener("click", () => {
	vscode.postMessage({ type: "openConfigFile" });
});

elements.createHook.addEventListener("click", () => {
	vscode.postMessage({ type: "create", settings: collectSettings() });
});

elements.recheckPowerShell.addEventListener("click", () => {
	vscode.postMessage({ type: "recheckPowerShell" });
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
});

window.addEventListener("message", (event) => {
	const message = event.data;
	if (message.type === "testResult") {
		renderTestResult(message.result);
		return;
	}
	if (message.type === "init") {
		renderReadiness(message.setup);
		renderScriptInfo(message.setup.script);
		applyState(message.config, message.setup);
	}
});

vscode.postMessage({ type: "requestInit" });
